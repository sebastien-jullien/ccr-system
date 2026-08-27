/**
 * V2.1-REPAIR — véracité de `FINALIZE_WITHOUT_AGENT_CALL` (moteur historique).
 *
 * Défaut découvert pendant le preflight de câblage legacy V2.2. Une opération
 * d'initialisation finalisée revient en `FAILED_INITIALIZATION` — l'état où vit
 * aussi la boucle de création des sessions manquantes. Les deux gestes se
 * rejoignaient donc, et une capacité annoncée
 *
 * ```text
 * effect                 FINALIZE_WITHOUT_AGENT_CALL
 * long_running           false
 * requires_confirmation  false
 * ```
 *
 * lançait réellement `adapter.start` sur le partenaire manquant.
 *
 * Arbitrage humain : les deux gestes sont séparés. Finaliser réconcilie ce qui
 * est déjà acquis, puis rend la main. Rappeler un fournisseur porte un autre
 * nom, se confirme, et se demande.
 *
 * L'image de crash n'est pas fabriquée à la main : elle est **capturée** à
 * l'instant précis où le processus mourrait, puis restaurée. Aucun fournisseur
 * réel — les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import type { AgentKind, CcrEvent } from '../../src/core/run.ts';
import { getRecoveryView } from '../../src/services/cockpit-read-model.ts';
import { applyCanonicalRecovery } from '../../src/services/recovery-application-service.ts';
import {
  isLongRunningRecovery,
  planCanonicalRecovery,
  pendingResponseJournaled,
} from '../../src/services/recovery-planner.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import { recoverRun, startRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { runCli } from '../../src/cli/main.ts';
import { listRunIds, runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { readManifest, readState } from '../../src/store/state-store.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { DEFAULT_MAX_TRANSFER_BYTES } from '../../src/services/transfer.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

/** Réglages d'exécution par défaut : la lecture n'en dépend pas ici. */
const SETTINGS = { maxTransferBytes: DEFAULT_MAX_TRANSFER_BYTES };

const WORKSPACE = 'E:/prog/exemple';
const PROMPT = 'contexte initial';

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  readonly claude: FakeAdapter;
  readonly codex: FakeAdapter;
  /** Appels fournisseur, toutes phases confondues. */
  providerCalls(): number;
  startCalls(): number;
  resumeCalls(): number;
  cleanup(): Promise<void>;
}

/** Image disque du run à l'instant où le processus mourrait. */
interface CrashImage {
  state: string;
  manifest: string;
}

async function harness(): Promise<{ h: Harness; crash: CrashImage }> {
  const runsDir = await makeTempDir('ccr-finalize-repair-');
  const crash: CrashImage = { state: '', manifest: '' };

  /**
   * Capture au moment du `start` de claude.
   *
   * `startRun` a déjà créé le répertoire, mais l'appelant ne connaît pas encore
   * son identifiant : le data root n'héberge qu'un run, et c'est lui.
   */
  const capture = async (phase: 'start' | 'resume'): Promise<void> => {
    if (phase !== 'start' || crash.state.length > 0) return;
    const ids = await listRunIds(runsDir);
    const only = ids[0];
    if (only === undefined) return;
    const paths = runPaths(runsDir, only);
    crash.state = await readFile(paths.state, 'utf8');
    crash.manifest = await readFile(paths.manifest, 'utf8');
  };

  const claude = createFakeAdapter({ kind: 'claude', sessionId: 'claude-uuid-1', onCall: capture });
  const codex = createFakeAdapter({ kind: 'codex', sessionId: 'codex-thread-1', onCall: capture });
  const adapters: AgentAdapters = { claude, codex };

  const phaseCount = (phase: 'start' | 'resume'): number =>
    claude.calls.filter((call) => call.phase === phase).length +
    codex.calls.filter((call) => call.phase === phase).length;

  return {
    crash,
    h: {
      runsDir,
      claude,
      codex,
      providerCalls: () => claude.calls.length + codex.calls.length,
      startCalls: () => phaseCount('start'),
      resumeCalls: () => phaseCount('resume'),
      deps: { runsDir, now: () => new Date(), createAdapters: () => adapters },
      cleanup: () => removeTempDir(runsDir),
    },
  };
}

/** Tronque le journal juste après la **première** occurrence d'un type. */
async function truncateAfterFirst(paths: RunPaths, type: string): Promise<void> {
  const lines = (await readFile(paths.events, 'utf8')).split('\n').filter((line) => line.trim().length > 0);
  const index = lines.map((line) => (JSON.parse(line) as { type: string }).type).indexOf(type);
  assert.ok(index >= 0, `aucun événement ${type} dans le journal`);
  await writeFile(paths.events, `${lines.slice(0, index + 1).join('\n')}\n`, 'utf8');
}

/**
 * Le cas exact démontré par le preflight.
 *
 * ```text
 * state     WAITING_AGENT
 * pending   kind = initialization · agent = claude
 * journal   assistant_response claude déjà durable
 * manifest  claude.session_id = null · codex.session_id = null
 * ```
 */
async function crashedAfterFirstResponse(h: Harness, crash: CrashImage): Promise<string> {
  const run = await startRun(h.deps, {
    runtimeConfig: TEST_RUNTIME_CONFIG,
    title: 'Reprise',
    cwd: WORKSPACE,
    prompt: PROMPT,
  });
  const paths = runPaths(h.runsDir, run.runId);

  // Restauration de l'image capturée : ni l'état, ni le manifest n'ont avancé.
  await writeFile(paths.state, crash.state, 'utf8');
  await writeFile(paths.manifest, crash.manifest, 'utf8');
  await truncateAfterFirst(paths, 'assistant_response');

  const state = await readState(paths);
  assert.equal(state.state, 'WAITING_AGENT', 'précondition : un tour était en vol');
  assert.equal(state.pending_operation?.kind, 'initialization');
  assert.equal(state.pending_operation?.agent, 'claude');
  const manifest = await readManifest(paths);
  assert.equal(manifest.agents.claude.session_id, null);
  assert.equal(manifest.agents.codex.session_id, null);

  return run.runId;
}

async function journal(runsDir: string, runId: string): Promise<readonly CcrEvent[]> {
  const paths = runPaths(runsDir, runId);
  return (await openEventStore(paths, runId)).readAll();
}

async function sessionsOf(runsDir: string, runId: string): Promise<Record<AgentKind, string | null>> {
  const manifest = await readManifest(runPaths(runsDir, runId));
  return { claude: manifest.agents.claude.session_id, codex: manifest.agents.codex.session_id };
}

/** Ce que `planCanonicalRecovery` produit sur les faits actuels du run. */
async function plannedCapability(runsDir: string, runId: string): Promise<string | null> {
  const snapshot = await readStableRunSnapshot(runsDir, runId);
  return planCanonicalRecovery({
    manifest: snapshot.manifest,
    state: snapshot.state,
    pendingResponseJournaled: pendingResponseJournaled(snapshot),
  });
}

// ==========================================================================
// A. Le cas démontré, et ce que la capacité promet
// ==========================================================================

test('1–4 · la capacité planifiée est locale, et la finalisation locale a bien lieu', async () => {
  const { h, crash } = await harness();
  try {
    const runId = await crashedAfterFirstResponse(h, crash);

    // 1 · exactement la capacité que le preflight a nommée.
    assert.equal(await plannedCapability(h.runsDir, runId), 'RECOVERY_FINALIZE_JOURNALED_RESPONSE');
    const view = await getRecoveryView({ runsDir: h.runsDir, settings: SETTINGS }, runId);
    const finalize = view.capabilities.find((entry) => entry.id === 'RECOVERY_FINALIZE_JOURNALED_RESPONSE');
    assert.ok(finalize, 'la vue propose la finalisation');
    assert.equal(finalize.effect, 'FINALIZE_WITHOUT_AGENT_CALL');
    assert.equal(finalize.long_running, false);
    assert.equal(finalize.requires_confirmation, false);

    const before = h.providerCalls();
    const result = await recoverRun(h.deps, { runId });

    // 2 · la finalisation aboutit, sans ambiguïté matérialisée.
    assert.equal(result.ambiguity, undefined);
    assert.ok(
      result.actions.some((line) => line.includes('finalisation sans nouvel appel agent')),
      'la finalisation locale est rapportée',
    );

    // 3 · la session durablement obtenue est liée, et journalisée.
    const sessions = await sessionsOf(h.runsDir, runId);
    assert.equal(sessions.claude, 'claude-uuid-1');
    const events = await journal(h.runsDir, runId);
    assert.equal(
      events.filter((event) => event.type === 'session_created' && event.target === 'claude').length,
      1,
    );

    // 4 · le pending est finalisé selon V2.1 : événement, état, nettoyage.
    const finalized = events.filter(
      (event) => event.type === 'state_changed' && event.details?.['reason'] === 'RECOVERY_FINALIZED',
    );
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0]?.details?.['operation'], 'initialization');
    const state = await readState(runPaths(h.runsDir, runId));
    assert.equal(state.pending_operation, null);
    assert.equal(state.state, 'FAILED_INITIALIZATION');
    assert.equal(state.control, 'AUTOMATION');
    assert.equal(state.active_agent, null);

    // Aucun fournisseur n'a été joint par ce geste.
    assert.equal(h.providerCalls() - before, 0);
  } finally {
    await h.cleanup();
  }
});

test('5–6 · aucun appel fournisseur, ni création ni reprise', async () => {
  const { h, crash } = await harness();
  try {
    const runId = await crashedAfterFirstResponse(h, crash);
    const starts = h.startCalls();
    const resumes = h.resumeCalls();

    await recoverRun(h.deps, { runId });

    // 5 · aucune session n'est créée par une action déclarée sans agent.
    assert.equal(h.startCalls() - starts, 0);
    // 6 · et aucune conversation n'est reprise non plus.
    assert.equal(h.resumeCalls() - resumes, 0);

    // La panne n'est pas déguisée en échec d'expert.
    const events = await journal(h.runsDir, runId);
    assert.equal(events.filter((event) => event.type === 'process_failed').length, 0);
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// B. Après la finalisation : deux gestes, pas un
// ==========================================================================

test('7–10 · le slot réconcilié est acquis, l’autre reste manquant et attend une demande', async () => {
  const { h, crash } = await harness();
  try {
    const runId = await crashedAfterFirstResponse(h, crash);
    await recoverRun(h.deps, { runId });

    // 7 · acquis.
    const sessions = await sessionsOf(h.runsDir, runId);
    assert.equal(sessions.claude, 'claude-uuid-1');

    // 8 · toujours manquant — la finalisation ne l'a ni créé ni prétendu.
    assert.equal(sessions.codex, null);

    const view = await getRecoveryView({ runsDir: h.runsDir, settings: SETTINGS }, runId);
    assert.deepEqual(view.sessions, { claude: 'PRESENT', codex: 'ABSENT' });

    // 9 · l'action canonique permettant de continuer est exposée, et elle
    //     annonce ce qu'elle fait vraiment.
    assert.equal(await plannedCapability(h.runsDir, runId), 'RECOVERY_CONTINUE_INITIALIZATION');
    const ids = view.capabilities.map((entry) => entry.id);
    assert.deepEqual(ids, ['RECOVERY_CONTINUE_INITIALIZATION']);
    const cont = view.capabilities[0];
    assert.equal(cont?.effect, 'CREATE_MISSING_NATIVE_SESSION');
    assert.equal(cont?.long_running, true);
    assert.equal(cont?.requires_confirmation, true);
    assert.equal(view.liveness.liveness, 'PARTIAL_INITIALIZATION');

    // 10 · rien n'a été enchaîné : aucun prompt neuf, aucune session codex.
    const events = await journal(h.runsDir, runId);
    assert.equal(
      events.filter((event) => event.type === 'prompt_sent' && event.target === 'codex').length,
      0,
      'aucune seconde intention n’a été formée à la place de l’humain',
    );
    assert.equal(
      events.filter((event) => event.type === 'session_created' && event.target === 'codex').length,
      0,
    );
  } finally {
    await h.cleanup();
  }
});

test('12 · deux agents manquants après finalisation : la règle ne change pas', async () => {
  const { h, crash } = await harness();
  try {
    const runId = await crashedAfterFirstResponse(h, crash);
    const paths = runPaths(h.runsDir, runId);

    // La réponse journalisée ne porte aucune session : rien n'est liable, et
    // les deux agents restent donc manquants après la finalisation.
    const lines = (await readFile(paths.events, 'utf8')).split('\n').filter((line) => line.trim().length > 0);
    const last = lines.length - 1;
    const response = JSON.parse(String(lines[last])) as Record<string, unknown>;
    assert.equal(response['type'], 'assistant_response');
    delete response['session_id'];
    lines[last] = JSON.stringify(response);
    await writeFile(paths.events, `${lines.join('\n')}\n`, 'utf8');

    const starts = h.startCalls();
    const result = await recoverRun(h.deps, { runId });

    assert.equal(h.startCalls() - starts, 0, 'deux manquants n’autorisent pas davantage');
    assert.deepEqual(await sessionsOf(h.runsDir, runId), { claude: null, codex: null });
    assert.equal((await readState(paths)).pending_operation, null, 'la finalisation locale a bien eu lieu');
    assert.ok(result.actions.some((line) => line.includes('finalisation sans nouvel appel agent')));
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// C. Surfaces
// ==========================================================================

test('11–12 · voie applicative : aucune admission longue, aucun fournisseur', async () => {
  const { h, crash } = await harness();
  try {
    const runId = await crashedAfterFirstResponse(h, crash);
    const before = await readStableRunSnapshot(h.runsDir, runId);

    // La classification que le transport utilise pour décider s'il faut un
    // créneau et un `202`. Le repair la rend vraie de l'exécution.
    assert.equal(isLongRunningRecovery('RECOVERY_FINALIZE_JOURNALED_RESPONSE'), false);

    const manager = createLongOperationManager();
    const calls = h.providerCalls();

    const outcome = await applyCanonicalRecovery(h.deps, {
      runId,
      expectedRevision: before.revision,
      capability: 'RECOVERY_FINALIZE_JOURNALED_RESPONSE',
    }, {
      // Exactement la condition de la route : le créneau n'est demandé que pour
      // la capacité déclarée longue.
      onReadyForEffect: (id) => {
        if (isLongRunningRecovery(id)) manager.admit('op_finalize');
      },
    });

    // 11 · aucun créneau n'a même été demandé.
    assert.equal(manager.admitAttempts(), 0);
    assert.equal(manager.activeCount(), 0);
    // 12 · et aucun fournisseur n'a été joint.
    assert.equal(h.providerCalls() - calls, 0);

    assert.notEqual(outcome.revisionAfter, outcome.revisionBefore, 'l’effet local est bien advenu');
    assert.equal(outcome.result.sessionsCreated.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('13 · CLI : `ccr recover` ne joint aucun fournisseur sur cette capacité', async () => {
  const { h, crash } = await harness();
  try {
    const runId = await crashedAfterFirstResponse(h, crash);
    const calls = h.providerCalls();
    const lines: string[] = [];

    const code = await runCli(['recover', '--run', runId], {
      deps: h.deps,
      io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
    });

    assert.equal(code, 0);
    assert.equal(h.providerCalls() - calls, 0);
    assert.equal((await sessionsOf(h.runsDir, runId)).codex, null);
    // La CLI n'enchaîne pas : elle dit ce qui reste à demander.
    assert.ok(
      lines.some((line) => line.includes('nouvelle tentative')),
      `la sortie invite à une action explicite : ${lines.join(' | ')}`,
    );
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// D. Non-régression du geste voisin
// ==========================================================================

test('14 · CONTINUE explicite reste capable de joindre un fournisseur', async () => {
  const { h, crash } = await harness();
  try {
    const runId = await crashedAfterFirstResponse(h, crash);
    await recoverRun(h.deps, { runId });

    const starts = h.startCalls();
    const snapshot = await readStableRunSnapshot(h.runsDir, runId);
    const manager = createLongOperationManager();
    const admitted: string[] = [];

    const outcome = await applyCanonicalRecovery(h.deps, {
      runId,
      expectedRevision: snapshot.revision,
      capability: 'RECOVERY_CONTINUE_INITIALIZATION',
    }, {
      onReadyForEffect: (id) => {
        if (isLongRunningRecovery(id)) {
          manager.admit('op_continue');
          admitted.push(id);
        }
      },
    });

    // Le geste explicite appelle bien, une fois, pour le seul slot manquant.
    assert.equal(h.startCalls() - starts, 1);
    assert.deepEqual(outcome.result.sessionsCreated, ['codex']);
    assert.deepEqual(admitted, ['RECOVERY_CONTINUE_INITIALIZATION']);
    assert.equal(manager.activeCount(), 1, 'le créneau reste tenu par cette opération');

    const sessions = await sessionsOf(h.runsDir, runId);
    assert.equal(sessions.codex, 'codex-thread-1');
    assert.equal(sessions.claude, 'claude-uuid-1', 'le partenaire déjà valide n’est pas recréé');
    assert.equal((await readState(runPaths(h.runsDir, runId))).state, 'READY');
  } finally {
    await h.cleanup();
  }
});

test('15 · la finalisation complète reste locale quand plus rien ne manque', async () => {
  const { h, crash } = await harness();
  try {
    // Crash symétrique : claude acquis, puis la réponse de codex journalisée
    // sans que l'état ne l'ait enregistrée. La finalisation lie le dernier slot
    // — et le run est alors réellement initialisé.
    const run = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'Reprise',
      cwd: WORKSPACE,
      prompt: PROMPT,
    });
    const paths = runPaths(h.runsDir, run.runId);
    const events = (await readFile(paths.events, 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const index = events
      .map((line) => (JSON.parse(line) as { type: string }).type)
      .lastIndexOf('assistant_response');
    await writeFile(paths.events, `${events.slice(0, index + 1).join('\n')}\n`, 'utf8');

    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      agents: Record<string, { session_id: string | null }>;
    };
    const codexAgent = manifest.agents['codex'];
    assert.ok(codexAgent);
    codexAgent.session_id = null;
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const state = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>;
    state['state'] = 'WAITING_AGENT';
    state['active_agent'] = 'codex';
    state['pending_operation'] = {
      kind: 'initialization',
      agent: 'codex',
      round: 0,
      prompt_event_id: String(
        (JSON.parse(String(events[index - 1])) as { event_id: string }).event_id,
      ),
      source_event_id: null,
      session_id: null,
      return_state: 'FAILED_INITIALIZATION',
      return_control: 'AUTOMATION',
      started_at: new Date().toISOString(),
    };
    await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    assert.equal(
      await plannedCapability(h.runsDir, run.runId),
      'RECOVERY_FINALIZE_JOURNALED_RESPONSE',
    );

    const starts = h.startCalls();
    const result = await recoverRun(h.deps, { runId: run.runId });

    // Aucun fournisseur, et pourtant le run est rendu exécutable : la
    // complétion sans slot manquant est purement locale et reste offerte.
    assert.equal(h.startCalls() - starts, 0);
    assert.equal((await readState(paths)).state, 'READY');
    assert.ok(result.actions.some((line) => line.includes('Les deux sessions natives existent')));
    assert.equal(await plannedCapability(h.runsDir, run.runId), null);
  } finally {
    await h.cleanup();
  }
});
