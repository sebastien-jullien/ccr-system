/**
 * Tests unitaires de la reprise après crash (lot V1.8, §22, §30, §32).
 *
 * Méthode : les crashs ne sont pas simulés en manipulant l'état « à la main »
 * mais en **capturant l'image réellement persistée** à l'instant précis où le
 * processus mourrait, puis en la restaurant. Ce que lit la reprise est donc
 * exactement ce qu'un crash aurait laissé.
 *
 * Propriété centrale vérifiée : la reprise ne produit jamais une certitude
 * supérieure à ce que les données permettent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { RunStateDocument } from '../../src/core/run.ts';
import { lockFilePath, readRunLock } from '../../src/lock/run-lock.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { persistStateUpdate, readManifest, readState } from '../../src/store/state-store.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import {
  getRunStatus,
  handoffRun,
  pauseRun,
  recoverRun,
  sendMessage,
  startRun,
  stepRun,
  stopRun,
} from '../../src/services/run-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import type { FakeAdapter, FakeAdapterOptions } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const WORKSPACE = 'E:/prog/exemple';
const DEAD_PID = 0x7fff_fffe;

interface Harness {
  readonly deps: RunServiceDeps;
  readonly runsDir: string;
  readonly claude: FakeAdapter;
  readonly codex: FakeAdapter;
  cleanup(): Promise<void>;
}

async function harness(
  claudeOptions: Partial<FakeAdapterOptions> = {},
  codexOptions: Partial<FakeAdapterOptions> = {},
): Promise<Harness> {
  const runsDir = await makeTempDir('ccr-recovery-');
  const claude = createFakeAdapter({ kind: 'claude', sessionId: 'claude-uuid-1', ...claudeOptions });
  const codex = createFakeAdapter({ kind: 'codex', sessionId: 'codex-thread-1', ...codexOptions });
  const adapters: AgentAdapters = { claude, codex };

  return {
    runsDir,
    claude,
    codex,
    deps: { runsDir, now: () => new Date(), createAdapters: () => adapters },
    cleanup: () => removeTempDir(runsDir),
  };
}

async function expectCcrError(promise: Promise<unknown>, code: CcrErrorCode): Promise<CcrError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isCcrError(error), `attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`attendu une CcrError ${code}, aucune erreur levée`);
}

/** Image disque d'un run à un instant donné : ce qu'un crash laisserait. */
interface CrashImage {
  readonly state: string;
  readonly events: string;
}

async function captureImage(paths: RunPaths): Promise<CrashImage> {
  return {
    state: await readFile(paths.state, 'utf8'),
    events: await readFile(paths.events, 'utf8'),
  };
}

async function restoreImage(paths: RunPaths, image: CrashImage, keepEvents = false): Promise<void> {
  await writeFile(paths.state, image.state, 'utf8');
  if (!keepEvents) await writeFile(paths.events, image.events, 'utf8');
}

/**
 * Tronque le journal juste après le dernier événement d'un type donné.
 *
 * Permet de reproduire une frontière de crash intermédiaire : la réponse est
 * durablement journalisée, mais la clôture du round ne l'est pas encore.
 */
async function truncateJournalAfterLast(paths: RunPaths, type: string): Promise<void> {
  const lines = (await readFile(paths.events, 'utf8')).split('\n').filter((line) => line.trim().length > 0);
  const index = lines.map((line) => (JSON.parse(line) as { type: string }).type).lastIndexOf(type);
  assert.ok(index >= 0, `aucun événement ${type} dans le journal`);
  await writeFile(paths.events, `${lines.slice(0, index + 1).join('\n')}\n`, 'utf8');
}

async function writeStaleLock(paths: RunPaths, command: string): Promise<void> {
  await writeFile(
    lockFilePath(paths),
    JSON.stringify({
      lock_id: 'lock-du-processus-mort',
      pid: DEAD_PID,
      hostname: hostname(),
      started_at: new Date(0).toISOString(),
      command,
    }),
    'utf8',
  );
}

async function state(runsDir: string, runId: string): Promise<RunStateDocument> {
  return readState(runPaths(runsDir, runId));
}

async function newRun(h: Harness): Promise<string> {
  const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Reprise', cwd: WORKSPACE, prompt: 'contexte initial' });
  return run.runId;
}

/**
 * Capteur d'image de crash.
 *
 * Il n'observe que les tours de **reprise** de session (`resume`) : la
 * création initiale n'a pas encore de `run_id` exploitable, et n'est pas le
 * sujet de ces tests.
 */
interface CrashProbe {
  runId: string;
  image: CrashImage | undefined;
  readonly hook: (phase: 'start' | 'resume', prompt: string) => Promise<void>;
  readonly interactiveHook: () => Promise<void>;
}

function createCrashProbe(runsDirOf: () => string): CrashProbe {
  const probe: CrashProbe = {
    runId: '',
    image: undefined,
    hook: async (phase) => {
      if (phase !== 'resume' || probe.runId.length === 0) return;
      probe.image = await captureImage(runPaths(runsDirOf(), probe.runId));
    },
    interactiveHook: async () => {
      if (probe.runId.length === 0) return;
      probe.image = await captureImage(runPaths(runsDirOf(), probe.runId));
    },
  };
  return probe;
}

// --------------------------------------------------------------------------
// Verrou et commandes concurrentes
// --------------------------------------------------------------------------

test('un verrou vivant interdit toute mutation concurrente du run', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);
    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const lock = await acquireRunLock(paths, 'step');

    await expectCcrError(sendMessage(h.deps, { runId, agent: 'claude', message: 'x' }), 'RUN_ALREADY_LOCKED');
    await expectCcrError(stepRun(h.deps, { runId }), 'RUN_ALREADY_LOCKED');
    await expectCcrError(pauseRun(h.deps, { runId }), 'RUN_ALREADY_LOCKED');
    await expectCcrError(stopRun(h.deps, { runId }), 'RUN_ALREADY_LOCKED');

    await lock.release();
  } finally {
    await h.cleanup();
  }
});

test('status reste lisible pendant qu\'un verrou est détenu', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);
    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const lock = await acquireRunLock(paths, 'send');

    const status = await getRunStatus(h.deps, runId);
    assert.equal(status.state.state, 'READY');
    assert.equal(status.lock?.pid, process.pid);
    assert.equal(status.lockLiveness, 'ALIVE');
    assert.notEqual(await readRunLock(paths), undefined, 'status ne prend pas le verrou');

    await lock.release();
  } finally {
    await h.cleanup();
  }
});

test("une commande métier ne supprime jamais un verrou périmé", async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);
    await writeStaleLock(paths, 'send');

    await expectCcrError(sendMessage(h.deps, { runId, agent: 'claude', message: 'x' }), 'STALE_LOCK');
    assert.notEqual(await readRunLock(paths), undefined, 'le verrou périmé subsiste');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Reprise sans ambiguïté
// --------------------------------------------------------------------------

test('verrou périmé + READY : nettoyage du verrou, run inchangé', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);
    await writeStaleLock(paths, 'send');

    const result = await recoverRun(h.deps, { runId });

    assert.equal(result.staleLock?.pid, DEAD_PID);
    assert.equal(await readRunLock(paths), undefined);
    assert.equal(result.state.state, 'READY');
    assert.equal(result.ambiguity, undefined);
    assert.ok(result.actions.some((action) => action.includes('Verrou périmé supprimé')));
  } finally {
    await h.cleanup();
  }
});

test('verrou périmé + RUNNING sans opération engagée : aucun agent n\'avait été appelé', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);
    // Un crash pendant une commande n'ayant pas atteint WAITING_AGENT.
    await persistStateUpdate(paths, await readState(paths), { state: 'RUNNING' });
    await writeStaleLock(paths, 'step');

    const claudeBefore = h.claude.calls.length;
    const result = await recoverRun(h.deps, { runId });

    assert.equal(result.state.state, 'READY');
    assert.equal(result.state.control, 'AUTOMATION');
    assert.equal(result.ambiguity, undefined);
    assert.equal(h.claude.calls.length, claudeBefore, 'aucun appel agent pendant la reprise');

    const events = await (await openEventStore(paths, runId)).readAll();
    assert.equal(events.at(-1)?.details?.['reason'], 'RECOVERY_RUNNING_WITHOUT_PENDING_OPERATION');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Cas B — aucune réponse journalisée : ambiguïté irréductible
// --------------------------------------------------------------------------

test('crash après WAITING_AGENT mais avant réponse → RECOVERY_REQUIRED, sans retry', async () => {
  const runsDirBox = { value: '' };
  const probe = createCrashProbe(() => runsDirBox.value);
  const h = await harness({ onCall: probe.hook });
  runsDirBox.value = h.runsDir;

  try {
    // Instant précis où le processus mourrait : le prompt est journalisé,
    // WAITING_AGENT est persisté, la réponse n'existe pas encore.
    const runId = await newRun(h);
    probe.runId = runId;
    const paths = runPaths(h.runsDir, runId);
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'question' });

    assert.ok(probe.image, "l'image de crash doit avoir été capturée");
    await restoreImage(paths, probe.image);
    await writeStaleLock(paths, 'send');

    const callsBefore = h.claude.calls.length;
    const result = await recoverRun(h.deps, { runId });

    assert.equal(result.state.state, 'RECOVERY_REQUIRED');
    assert.equal(result.state.control, 'HUMAN');
    assert.ok(result.ambiguity !== undefined);
    assert.equal(result.ambiguity?.operation?.kind, 'send');
    assert.equal(result.ambiguity?.operation?.agent, 'claude');
    assert.ok(result.ambiguity?.reason.includes('sans qu\'aucune réponse ne soit journalisée'));
    assert.equal(h.claude.calls.length, callsBefore, 'aucun rejeu automatique du tour');
  } finally {
    await h.cleanup();
  }
});

test('un run en RECOVERY_REQUIRED refuse toute reprise ordinaire', async () => {
  const runsDirBox = { value: '' };
  const probe = createCrashProbe(() => runsDirBox.value);
  const h = await harness({ onCall: probe.hook });
  runsDirBox.value = h.runsDir;

  try {
    const runId = await newRun(h);
    probe.runId = runId;
    const paths = runPaths(h.runsDir, runId);
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'question' });
    assert.ok(probe.image);
    await restoreImage(paths, probe.image);

    await expectCcrError(sendMessage(h.deps, { runId, agent: 'claude', message: 'x' }), 'RECOVERY_REQUIRED');
    await expectCcrError(stepRun(h.deps, { runId }), 'RECOVERY_REQUIRED');
    await expectCcrError(pauseRun(h.deps, { runId }), 'RECOVERY_REQUIRED');
  } finally {
    await h.cleanup();
  }
});

test('l\'acquittement humain ramène en PAUSED sans rien affirmer sur le tour', async () => {
  const runsDirBox = { value: '' };
  const probe = createCrashProbe(() => runsDirBox.value);
  const h = await harness({ onCall: probe.hook });
  runsDirBox.value = h.runsDir;

  try {
    const runId = await newRun(h);
    probe.runId = runId;
    const paths = runPaths(h.runsDir, runId);
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'question' });
    assert.ok(probe.image);
    await restoreImage(paths, probe.image);
    await recoverRun(h.deps, { runId });

    // Sans acquittement : l'ambiguïté demeure.
    const still = await recoverRun(h.deps, { runId });
    assert.equal(still.state.state, 'RECOVERY_REQUIRED');
    assert.ok(still.ambiguity !== undefined);

    const callsBefore = h.claude.calls.length;
    const acknowledged = await recoverRun(h.deps, {
      runId,
      acknowledge: "J'ai inspecté la session Claude : le tour n'apparaît pas.",
    });

    assert.equal(acknowledged.state.state, 'PAUSED');
    assert.equal(acknowledged.state.control, 'HUMAN');
    assert.equal(h.claude.calls.length, callsBefore, 'aucun agent appelé par l\'acquittement');

    const events = await (await openEventStore(paths, runId)).readAll();
    const last = events.at(-1);
    assert.equal(last?.actor, 'human');
    assert.equal(last?.details?.['reason'], 'RECOVERY_ACKNOWLEDGED');
    assert.ok(String(last?.content).includes('inspecté'));
    assert.ok(String(last?.details?.['note']).includes('ni que le tour a eu lieu'));
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Cas A — réponse déjà journalisée : finalisation déterministe
// --------------------------------------------------------------------------

test('crash après réponse journalisée mais avant restauration → finalisation sans nouvel appel', async () => {
  const runsDirBox = { value: '' };
  const probe = createCrashProbe(() => runsDirBox.value);
  const h = await harness({ onCall: probe.hook });
  runsDirBox.value = h.runsDir;

  try {
    const runId = await newRun(h);
    probe.runId = runId;
    const paths = runPaths(h.runsDir, runId);
    await pauseRun(h.deps, { runId });
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'question humaine' });

    // Image de crash à la frontière suivante : state.json d'avant l'appel,
    // events.jsonl d'après — la réponse EST durablement journalisée.
    assert.ok(probe.image);
    await restoreImage(paths, probe.image, true);
    await writeStaleLock(paths, 'send');

    const callsBefore = h.claude.calls.length;
    const result = await recoverRun(h.deps, { runId });

    assert.equal(h.claude.calls.length, callsBefore, "l'agent n'est jamais rappelé");
    assert.equal(result.ambiguity, undefined, 'le contenu externe n\'est plus ambigu');
    assert.equal(result.state.state, 'PAUSED', "l'état de retour PAUSED est restauré");
    assert.equal(result.state.control, 'HUMAN');
    assert.equal(result.state.pending_operation, null);

    const events = await (await openEventStore(paths, runId)).readAll();
    assert.equal(events.at(-1)?.details?.['reason'], 'RECOVERY_FINALIZED');
  } finally {
    await h.cleanup();
  }
});

test("l'état de retour WAITING_HUMAN est également restauré", async () => {
  const runsDirBox = { value: '' };
  const probe = createCrashProbe(() => runsDirBox.value);
  const h = await harness({}, { onCall: probe.hook });
  runsDirBox.value = h.runsDir;

  try {
    const runId = await newRun(h);
    probe.runId = runId;
    const paths = runPaths(h.runsDir, runId);
    await persistStateUpdate(paths, await readState(paths), { state: 'WAITING_HUMAN', control: 'HUMAN' });
    await sendMessage(h.deps, { runId, agent: 'codex', message: 'arbitrage' });

    assert.ok(probe.image);
    await restoreImage(paths, probe.image, true);

    const result = await recoverRun(h.deps, { runId });

    assert.equal(result.state.state, 'WAITING_HUMAN');
    assert.equal(result.state.control, 'HUMAN');
  } finally {
    await h.cleanup();
  }
});

test('un step interrompu après réponse est clôturé sans rappeler l\'agent', async () => {
  const runsDirBox = { value: '' };
  const probe = createCrashProbe(() => runsDirBox.value);
  const h = await harness({ onCall: probe.hook });
  runsDirBox.value = h.runsDir;

  try {
    const runId = await newRun(h);
    probe.runId = runId;
    const paths = runPaths(h.runsDir, runId);
    // La dernière réponse vient de Codex : le step vise Claude.
    await stepRun(h.deps, { runId });

    assert.ok(probe.image);
    // Frontière visée : la réponse est journalisée, la clôture du round non.
    await truncateJournalAfterLast(paths, 'assistant_response');
    await restoreImage(paths, probe.image, true);
    await writeStaleLock(paths, 'step');

    const callsBefore = h.claude.calls.length;
    const result = await recoverRun(h.deps, { runId });

    assert.equal(h.claude.calls.length, callsBefore);
    assert.equal(result.state.state, 'READY');
    assert.equal(result.state.control, 'AUTOMATION');

    const events = await (await openEventStore(paths, runId)).readAll();
    const completed = events.filter((event) => event.type === 'round_completed');
    assert.equal(completed.length, 1, 'le round est clôturé exactement une fois');
    assert.equal(completed[0]?.details?.['recovered'], true);

    // Le run reste utilisable : la source consommée n'est pas rejouable.
    const next = await stepRun(h.deps, { runId });
    assert.equal(next.targetAgent, 'codex');
  } finally {
    await h.cleanup();
  }
});

test("un WAITING_AGENT en schéma 1 reste ambigu malgré l'absence de contexte", async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);

    // `state.json` tel qu'une version antérieure l'aurait écrit : le schéma 1
    // ne pouvait pas porter de `pending_operation`.
    const legacy = {
      schema_version: 1,
      run_id: runId,
      state: 'WAITING_AGENT',
      control: 'AUTOMATION',
      round: 1,
      active_agent: 'codex',
      last_event_id: 'evt_000007',
      uncertainty: null,
      updated_at: new Date(0).toISOString(),
    };
    await writeFile(paths.state, JSON.stringify(legacy, null, 2), 'utf8');
    await writeStaleLock(paths, 'step');

    const loaded = await readState(paths);
    assert.equal(loaded.pending_operation, null, 'aucun contexte disponible dans ce schéma');

    const callsBefore = h.codex.calls.length;
    const result = await recoverRun(h.deps, { runId });

    assert.equal(result.state.state, 'RECOVERY_REQUIRED', "l'absence de contexte n'autorise aucune conclusion");
    assert.equal(result.state.control, 'HUMAN');
    assert.ok(result.ambiguity !== undefined);
    assert.ok(result.ambiguity?.reason.includes('schéma antérieur'));
    assert.ok(result.ambiguity?.reason.includes("n'autorise donc aucune conclusion"));
    assert.equal(h.codex.calls.length, callsBefore, 'aucun rejeu');
  } finally {
    await h.cleanup();
  }
});

test("l'acquittement conserve dans le journal tout ce que state.json abandonne", async () => {
  const runsDirBox = { value: '' };
  const probe = createCrashProbe(() => runsDirBox.value);
  const h = await harness({ onCall: probe.hook });
  runsDirBox.value = h.runsDir;

  try {
    const runId = await newRun(h);
    probe.runId = runId;
    const paths = runPaths(h.runsDir, runId);
    await pauseRun(h.deps, { runId });
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'question' });

    assert.ok(probe.image);
    await restoreImage(paths, probe.image);
    const abandoned = (await readState(paths)).pending_operation;
    assert.ok(abandoned);

    await recoverRun(h.deps, { runId });
    const acknowledged = await recoverRun(h.deps, { runId, acknowledge: 'Rien trouvé côté Claude.' });

    // `state.json` est propre…
    assert.equal(acknowledged.state.pending_operation, null);
    assert.equal(acknowledged.state.uncertainty, null);

    // … mais l'historique conserve intégralement ce qui a été abandonné.
    const events = await (await openEventStore(paths, runId)).readAll();
    const record = events.find((event) => event.details?.['reason'] === 'RECOVERY_ACKNOWLEDGED');
    assert.ok(record !== undefined);
    assert.equal(record?.details?.['operation'], abandoned.kind);
    assert.equal(record?.details?.['operation_agent'], abandoned.agent);
    assert.equal(record?.details?.['operation_round'], abandoned.round);
    assert.equal(record?.details?.['operation_prompt_event_id'], abandoned.prompt_event_id);
    assert.equal(record?.details?.['operation_source_event_id'], abandoned.source_event_id);
    assert.equal(record?.details?.['operation_return_state'], abandoned.return_state);
    assert.equal(record?.details?.['operation_return_control'], abandoned.return_control);
    assert.ok(String(record?.details?.['ambiguity_reason']).length > 0);
    assert.equal(record?.content, 'Rien trouvé côté Claude.');
    assert.ok(String(record?.details?.['conclusion']).startsWith('Aucune'));

    const marker = events.find((event) => event.details?.['reason'] === 'RECOVERY_REQUIRED');
    assert.equal(marker?.details?.['operation_agent'], abandoned.agent);
  } finally {
    await h.cleanup();
  }
});

test('un RUNNING sans session native ne devient pas READY', async () => {
  const h = await harness({}, { failStart: () => new CcrError('AGENT_EXIT_NONZERO', 'codex indisponible') });
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Partielle', cwd: WORKSPACE, prompt: 'contexte initial' });
    const paths = runPaths(h.runsDir, run.runId);

    // Crash juste après le passage en RUNNING de l'initialisation.
    await persistStateUpdate(paths, await readState(paths), {
      state: 'RUNNING',
      control: 'AUTOMATION',
      pendingOperation: null,
    });
    await writeStaleLock(paths, 'start');

    const result = await recoverRun(h.deps, { runId: run.runId });

    // La reprise ne prétend pas que le run est utilisable : elle constate
    // l'initialisation incomplète, puis la complète.
    assert.ok(result.actions.some((action) => action.includes('Sessions natives manquantes')));
    assert.deepEqual([...result.sessionsCreated], []);
    assert.equal(result.state.state, 'FAILED_INITIALIZATION');
  } finally {
    await h.cleanup();
  }
});

test('un round ouvert dont la réponse est journalisée est clôturé, pas oublié', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);
    await stepRun(h.deps, { runId });

    // Crash entre la sortie de WAITING_AGENT et la clôture du round : le
    // contexte d'opération est déjà libéré, la réponse est journalisée.
    await truncateJournalAfterLast(paths, 'assistant_response');
    await persistStateUpdate(paths, await readState(paths), { state: 'RUNNING' });
    await writeStaleLock(paths, 'step');

    const callsBefore = h.claude.calls.length;
    const result = await recoverRun(h.deps, { runId });

    assert.equal(h.claude.calls.length, callsBefore, 'aucun agent rappelé');
    assert.equal(result.state.state, 'READY');

    const events = await (await openEventStore(paths, runId)).readAll();
    const completed = events.filter((event) => event.type === 'round_completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.details?.['recovered'], true);
  } finally {
    await h.cleanup();
  }
});

test('un round ouvert sans réponse reste incomplet et ne se voit attribuer aucun tour', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);
    await stepRun(h.deps, { runId });
    await truncateJournalAfterLast(paths, 'round_started');
    await persistStateUpdate(paths, await readState(paths), { state: 'RUNNING' });

    const result = await recoverRun(h.deps, { runId });

    assert.equal(result.state.state, 'READY');
    assert.ok(result.actions.some((action) => action.includes('laissé incomplet')));

    const events = await (await openEventStore(paths, runId)).readAll();
    assert.equal(events.filter((event) => event.type === 'round_completed').length, 0);
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Handoff interrompu
// --------------------------------------------------------------------------

test('un handoff commencé sans fin est une ambiguïté, pas un simple verrou', async () => {
  const runsDirBox = { value: '' };
  const probe = createCrashProbe(() => runsDirBox.value);
  const h = await harness({ onInteractive: probe.interactiveHook });
  runsDirBox.value = h.runsDir;

  try {
    const runId = await newRun(h);
    probe.runId = runId;
    const paths = runPaths(h.runsDir, runId);
    await pauseRun(h.deps, { runId });
    await handoffRun(h.deps, { runId, agent: 'claude' });

    assert.ok(probe.image, "l'image pendant le handoff doit avoir été capturée");
    await restoreImage(paths, probe.image);
    await writeStaleLock(paths, 'handoff');

    // L'état persisté reste PAUSED : sans contexte d'opération, rien ne
    // signalerait l'interruption.
    const persisted = await state(h.runsDir, runId);
    assert.equal(persisted.state, 'PAUSED');
    assert.equal(persisted.pending_operation?.kind, 'handoff');

    const result = await recoverRun(h.deps, { runId });

    assert.equal(result.state.state, 'RECOVERY_REQUIRED');
    assert.equal(result.state.control, 'HUMAN');
    assert.equal(result.ambiguity?.operation?.kind, 'handoff');
    assert.ok(result.ambiguity?.reason.includes('peut encore être ouverte'));
    assert.deepEqual(h.claude.calls, [{ phase: 'start', sessionId: undefined, prompt: 'contexte initial' }]);
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Initialisation partielle
// --------------------------------------------------------------------------

test('la reprise ne recrée jamais une session déjà valide', async () => {
  let codexShouldFail = true;
  const h = await harness(
    {},
    { failStart: () => (codexShouldFail ? new CcrError('AGENT_EXIT_NONZERO', 'codex indisponible') : undefined) },
  );

  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Partielle', cwd: WORKSPACE, prompt: 'contexte initial' });
    assert.equal(run.state.state, 'FAILED_INITIALIZATION');
    assert.equal(run.manifest.agents.claude.session_id, 'claude-uuid-1');
    assert.equal(run.manifest.agents.codex.session_id, null);

    const claudeCallsBefore = h.claude.calls.length;
    codexShouldFail = false;
    const result = await recoverRun(h.deps, { runId: run.runId });

    assert.equal(h.claude.calls.length, claudeCallsBefore, 'la session Claude valide n\'est pas recréée');
    assert.deepEqual([...result.sessionsCreated], ['codex']);
    assert.equal(result.state.state, 'READY');
    assert.equal(result.state.control, 'AUTOMATION');

    const manifest = await readManifest(runPaths(h.runsDir, run.runId));
    assert.equal(manifest.agents.claude.session_id, 'claude-uuid-1', "l'identifiant natif est préservé");
    assert.equal(manifest.agents.codex.session_id, 'codex-thread-1');
  } finally {
    await h.cleanup();
  }
});

test("une initialisation qui échoue encore reste FAILED_INITIALIZATION", async () => {
  const h = await harness({}, { failStart: () => new CcrError('AGENT_EXIT_NONZERO', 'toujours indisponible') });
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Partielle', cwd: WORKSPACE, prompt: 'contexte initial' });

    const result = await recoverRun(h.deps, { runId: run.runId });

    assert.equal(result.state.state, 'FAILED_INITIALIZATION');
    assert.deepEqual([...result.sessionsCreated], []);
    assert.ok(result.actions.some((action) => action.includes('Échec de création')));

    const manifest = await readManifest(runPaths(h.runsDir, run.runId));
    assert.equal(manifest.agents.claude.session_id, 'claude-uuid-1', 'la session valide survit');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// États terminaux
// --------------------------------------------------------------------------

test('FAILED et CLOSED sont diagnostiqués, jamais réactivés', async () => {
  for (const target of ['FAILED', 'CLOSED'] as const) {
    const h = await harness();
    try {
      const runId = await newRun(h);
      const paths = runPaths(h.runsDir, runId);
      await persistStateUpdate(paths, await readState(paths), { state: target });
      await writeStaleLock(paths, 'send');

      const result = await recoverRun(h.deps, { runId });

      assert.equal(result.state.state, target, `${target} ne doit pas être transformé`);
      assert.ok(result.actions.some((action) => action.includes('terminal en V1')));
      assert.equal(await readRunLock(paths), undefined, 'le verrou périmé est tout de même nettoyé');
    } finally {
      await h.cleanup();
    }
  }
});

test('stop clôt le run et reste idempotent', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);

    const first = await stopRun(h.deps, { runId });
    assert.equal(first.changed, true);
    assert.equal(first.state.state, 'CLOSED');

    const second = await stopRun(h.deps, { runId });
    assert.equal(second.changed, false);

    const manifest = await readManifest(runPaths(h.runsDir, runId));
    assert.equal(manifest.agents.claude.session_id, 'claude-uuid-1', 'les sessions natives survivent');
    assert.equal(manifest.agents.codex.session_id, 'codex-thread-1');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Fichiers temporaires
// --------------------------------------------------------------------------

test("un fichier temporaire abandonné ne devient jamais l'état canonique", async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);
    const canonical = await readFile(paths.state, 'utf8');

    // Écriture interrompue : un `.tmp` plus récent traîne dans le répertoire.
    await writeFile(`${paths.state}.99999.1.tmp`, '{"schema_version":2,"state":"CLOSED"}', 'utf8');
    await writeStaleLock(paths, 'send');

    const result = await recoverRun(h.deps, { runId });

    assert.equal(result.state.state, 'READY', 'le fichier canonique valide gagne');
    assert.equal(await readFile(paths.state, 'utf8'), canonical);
  } finally {
    await h.cleanup();
  }
});
