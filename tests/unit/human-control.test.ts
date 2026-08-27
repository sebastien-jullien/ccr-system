/**
 * Tests unitaires du contrôle humain (lot V1.7).
 *
 * Propriétés vérifiées : idempotence de `pause`/`resume`, refus depuis les
 * états à mécanisme propre, absence totale d'appel agent par `resume`,
 * conservation de l'état et du contrôle par `handoff`, et séparation stricte
 * entre une décision canonique et un message conversationnel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { RunState } from '../../src/core/state.ts';
import type { RunStateDocument } from '../../src/core/run.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { persistStateUpdate, readState } from '../../src/store/state-store.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import {
  handoffRun,
  listDecisions,
  pauseRun,
  recordDecision,
  resumeRun,
  sendMessage,
  startRun,
} from '../../src/services/run-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import type { FakeAdapter, FakeAdapterOptions } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const WORKSPACE = 'E:/prog/exemple';

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
  const runsDir = await makeTempDir('ccr-control-');
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

async function readPersistedState(runsDir: string, runId: string): Promise<RunStateDocument> {
  return readState(runPaths(runsDir, runId));
}

async function forceState(
  runsDir: string,
  runId: string,
  update: Parameters<typeof persistStateUpdate>[2],
): Promise<void> {
  const paths = runPaths(runsDir, runId);
  await persistStateUpdate(paths, await readState(paths), update);
}

async function eventTypes(runsDir: string, runId: string): Promise<string[]> {
  const events = await (await openEventStore(runPaths(runsDir, runId), runId)).readAll();
  return events.map((event) => event.type);
}

async function newRun(h: Harness): Promise<string> {
  const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Contrôle', cwd: WORKSPACE, prompt: 'contexte' });
  return run.runId;
}

// --------------------------------------------------------------------------
// pause
// --------------------------------------------------------------------------

test('pause fait passer le run sous contrôle humain', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const result = await pauseRun(h.deps, { runId });

    assert.equal(result.changed, true);
    assert.equal(result.state.state, 'PAUSED');
    assert.equal(result.state.control, 'HUMAN');
    assert.equal((await readPersistedState(h.runsDir, runId)).state, 'PAUSED');
    assert.ok((await eventTypes(h.runsDir, runId)).includes('run_paused'));
  } finally {
    await h.cleanup();
  }
});

test('pause est idempotente et ne réécrit pas un événement identique', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await pauseRun(h.deps, { runId });
    const journalAfterFirst = await readFile(runPaths(h.runsDir, runId).events, 'utf8');

    const second = await pauseRun(h.deps, { runId });
    const third = await pauseRun(h.deps, { runId });

    assert.equal(second.changed, false);
    assert.equal(third.changed, false);
    assert.equal(second.state.state, 'PAUSED');
    assert.equal(
      await readFile(runPaths(h.runsDir, runId).events, 'utf8'),
      journalAfterFirst,
      'aucun événement supplémentaire',
    );
  } finally {
    await h.cleanup();
  }
});

test('pause ne requalifie jamais WAITING_HUMAN en PAUSED', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await forceState(h.runsDir, runId, { state: 'WAITING_HUMAN', control: 'HUMAN' });

    const result = await pauseRun(h.deps, { runId });

    assert.equal(result.changed, false);
    assert.equal(result.state.state, 'WAITING_HUMAN', "le motif de l'attente est préservé");
    assert.equal(result.state.control, 'HUMAN');
  } finally {
    await h.cleanup();
  }
});

test('pause refuse un run dont un tour est potentiellement en vol', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await forceState(h.runsDir, runId, { state: 'RUNNING' });
    await forceState(h.runsDir, runId, { state: 'WAITING_AGENT', activeAgent: 'codex' });

    await expectCcrError(pauseRun(h.deps, { runId }), 'RECOVERY_REQUIRED');
    assert.equal((await readPersistedState(h.runsDir, runId)).state, 'WAITING_AGENT');
  } finally {
    await h.cleanup();
  }
});

test('pause ne transforme pas les états à mécanisme propre', async () => {
  const cases: ReadonlyArray<readonly [RunState, () => Parameters<typeof persistStateUpdate>[2][]]> = [];
  void cases;

  for (const target of ['RECOVERY_REQUIRED', 'FAILED', 'CLOSED'] as const) {
    const h = await harness();
    try {
      const runId = await newRun(h);
      if (target === 'RECOVERY_REQUIRED') {
        await forceState(h.runsDir, runId, { state: 'RUNNING' });
        await forceState(h.runsDir, runId, { state: 'WAITING_AGENT' });
        await forceState(h.runsDir, runId, { state: 'RECOVERY_REQUIRED' });
      } else {
        await forceState(h.runsDir, runId, { state: target });
      }

      await expectCcrError(pauseRun(h.deps, { runId }), 'RUN_NOT_PAUSABLE');
      assert.equal((await readPersistedState(h.runsDir, runId)).state, target);
    } finally {
      await h.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// resume
// --------------------------------------------------------------------------

test('resume rend le run à l\'automatisation sans appeler aucun agent', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await pauseRun(h.deps, { runId });

    const claudeBefore = h.claude.calls.length;
    const codexBefore = h.codex.calls.length;
    const result = await resumeRun(h.deps, { runId });

    assert.equal(result.changed, true);
    assert.equal(result.state.state, 'READY');
    assert.equal(result.state.control, 'AUTOMATION');
    assert.equal(h.claude.calls.length, claudeBefore, 'resume ne lance aucun agent');
    assert.equal(h.codex.calls.length, codexBefore, 'resume ne fait pas de step implicite');
    assert.ok((await eventTypes(h.runsDir, runId)).includes('run_resumed'));
  } finally {
    await h.cleanup();
  }
});

test('resume sort aussi de WAITING_HUMAN', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await forceState(h.runsDir, runId, { state: 'WAITING_HUMAN', control: 'HUMAN' });

    const result = await resumeRun(h.deps, { runId });

    assert.equal(result.state.state, 'READY');
    assert.equal(result.state.control, 'AUTOMATION');
  } finally {
    await h.cleanup();
  }
});

test('resume est idempotent sur un run déjà automatisable', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const journalBefore = await readFile(runPaths(h.runsDir, runId).events, 'utf8');

    const first = await resumeRun(h.deps, { runId });
    const second = await resumeRun(h.deps, { runId });

    assert.equal(first.changed, false);
    assert.equal(second.changed, false);
    assert.equal(await readFile(runPaths(h.runsDir, runId).events, 'utf8'), journalBefore);
  } finally {
    await h.cleanup();
  }
});

test('resume ne permet pas de sortir des états à mécanisme propre', async () => {
  for (const target of ['RECOVERY_REQUIRED', 'FAILED', 'FAILED_INITIALIZATION', 'CLOSED'] as const) {
    const h = await harness();
    try {
      const runId = await newRun(h);
      if (target === 'RECOVERY_REQUIRED') {
        await forceState(h.runsDir, runId, { state: 'RUNNING' });
        await forceState(h.runsDir, runId, { state: 'WAITING_AGENT' });
        await forceState(h.runsDir, runId, { state: 'RECOVERY_REQUIRED' });
      } else if (target === 'FAILED_INITIALIZATION') {
        await forceState(h.runsDir, runId, { state: 'RUNNING' });
        await forceState(h.runsDir, runId, { state: 'FAILED_INITIALIZATION' });
      } else {
        await forceState(h.runsDir, runId, { state: target });
      }

      await expectCcrError(resumeRun(h.deps, { runId }), 'RUN_NOT_RESUMABLE');
      assert.equal((await readPersistedState(h.runsDir, runId)).state, target);
    } finally {
      await h.cleanup();
    }
  }
});

test('resume refuse un run dont un tour est potentiellement en vol', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await forceState(h.runsDir, runId, { state: 'RUNNING' });
    await forceState(h.runsDir, runId, { state: 'WAITING_AGENT', activeAgent: 'claude' });

    await expectCcrError(resumeRun(h.deps, { runId }), 'RECOVERY_REQUIRED');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// send sous contrôle humain
// --------------------------------------------------------------------------

test('un cycle pause → send → send conserve PAUSED et le contrôle humain', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await pauseRun(h.deps, { runId });

    const first = await sendMessage(h.deps, { runId, agent: 'claude', message: 'première question' });
    const second = await sendMessage(h.deps, { runId, agent: 'codex', message: 'seconde question' });

    for (const result of [first, second]) {
      assert.equal(result.state.state, 'PAUSED');
      assert.equal(result.state.control, 'HUMAN');
    }

    const types = await eventTypes(h.runsDir, runId);
    assert.equal(types.filter((type) => type === 'human_message').length, 2);
    assert.equal((await readPersistedState(h.runsDir, runId)).state, 'PAUSED');
  } finally {
    await h.cleanup();
  }
});

test('un send depuis WAITING_HUMAN y revient sans devenir RUNNING', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await forceState(h.runsDir, runId, { state: 'WAITING_HUMAN', control: 'HUMAN' });

    const result = await sendMessage(h.deps, { runId, agent: 'codex', message: 'arbitrage' });

    assert.equal(result.state.state, 'WAITING_HUMAN');
    assert.equal(result.state.control, 'HUMAN');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// handoff
// --------------------------------------------------------------------------

test('handoff ouvre la session native existante et conserve état et contrôle', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await pauseRun(h.deps, { runId });

    const result = await handoffRun(h.deps, { runId, agent: 'claude' });

    assert.deepEqual(h.claude.interactiveCalls, ['claude-uuid-1'], "l'ID natif exact est repris");
    assert.equal(result.sessionId, 'claude-uuid-1');
    assert.equal(result.exitCode, 0);
    assert.equal(result.state.state, 'PAUSED', "fermer l'interface ne relance pas l'automatisation");
    assert.equal(result.state.control, 'HUMAN');

    const types = await eventTypes(h.runsDir, runId);
    assert.ok(types.includes('human_handoff_started'));
    assert.ok(types.includes('human_handoff_finished'));

    const events = await (await openEventStore(runPaths(h.runsDir, runId), runId)).readAll();
    const finished = events.find((event) => event.type === 'human_handoff_finished');
    assert.equal(finished?.target, 'claude');
    assert.equal(finished?.session_id, 'claude-uuid-1');
    assert.ok(String(finished?.details?.['note']).includes('native externe'));
  } finally {
    await h.cleanup();
  }
});

test('handoff fonctionne également depuis WAITING_HUMAN', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await forceState(h.runsDir, runId, { state: 'WAITING_HUMAN', control: 'HUMAN' });

    const result = await handoffRun(h.deps, { runId, agent: 'codex' });

    assert.equal(result.state.state, 'WAITING_HUMAN');
    assert.equal(result.state.control, 'HUMAN');
    assert.deepEqual(h.codex.interactiveCalls, ['codex-thread-1']);
  } finally {
    await h.cleanup();
  }
});

test("handoff est refusé tant que l'automatisation détient le contrôle", async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);

    const error = await expectCcrError(handoffRun(h.deps, { runId, agent: 'claude' }), 'HANDOFF_NOT_ALLOWED');

    assert.equal(error.details['control'], 'AUTOMATION');
    assert.deepEqual(h.claude.interactiveCalls, []);
  } finally {
    await h.cleanup();
  }
});

test("handoff ne crée jamais de session lorsqu'elle est absente", async () => {
  const h = await harness({}, { failStart: () => new CcrError('AGENT_EXIT_NONZERO', 'codex indisponible') });
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    await forceState(h.runsDir, run.runId, { state: 'READY', control: 'AUTOMATION' });
    await pauseRun(h.deps, { runId: run.runId });

    const error = await expectCcrError(handoffRun(h.deps, { runId: run.runId, agent: 'codex' }), 'SESSION_MISSING');

    assert.equal(error.details['agent'], 'codex');
    assert.deepEqual(h.codex.interactiveCalls, []);
    const { readManifest } = await import('../../src/store/state-store.ts');
    assert.equal((await readManifest(runPaths(h.runsDir, run.runId))).agents.codex.session_id, null);
  } finally {
    await h.cleanup();
  }
});

test("un échec de lancement interactif n'est pas destructif", async () => {
  const h = await harness({ failInteractive: () => new CcrError('EXECUTABLE_NOT_FOUND', 'claude introuvable') });
  try {
    const runId = await newRun(h);
    await pauseRun(h.deps, { runId });

    await expectCcrError(handoffRun(h.deps, { runId, agent: 'claude' }), 'EXECUTABLE_NOT_FOUND');

    const state = await readPersistedState(h.runsDir, runId);
    assert.equal(state.state, 'PAUSED', 'pas de bascule en FAILED pour un incident de lancement');
    assert.equal(state.control, 'HUMAN');

    const { readManifest } = await import('../../src/store/state-store.ts');
    const manifest = await readManifest(runPaths(h.runsDir, runId));
    assert.equal(manifest.agents.claude.session_id, 'claude-uuid-1', "l'ID natif est intact");

    const types = await eventTypes(h.runsDir, runId);
    assert.ok(types.includes('human_handoff_started'));
    assert.ok(types.includes('process_failed'));
    assert.ok(!types.includes('human_handoff_finished'));
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// decide
// --------------------------------------------------------------------------

test('decide enregistre une décision sans toucher aux agents ni au run', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const stateBefore = await readPersistedState(h.runsDir, runId);
    const claudeBefore = h.claude.calls.length;
    const codexBefore = h.codex.calls.length;

    const result = await recordDecision(h.deps, {
      runId,
      content: 'Les seeds ne constituent pas une source de doctrine produit.',
    });

    assert.equal(result.decision.decision_id, 'DEC-0001');
    assert.equal(result.decision.status, 'ACTIVE');
    assert.equal(result.decision.author, 'human');
    assert.equal(result.decision.run_id, runId);

    assert.equal(h.claude.calls.length, claudeBefore, 'aucune diffusion implicite vers Claude');
    assert.equal(h.codex.calls.length, codexBefore, 'aucune diffusion implicite vers Codex');

    const stateAfter = await readPersistedState(h.runsDir, runId);
    assert.equal(stateAfter.state, stateBefore.state, "l'état ne change pas");
    assert.equal(stateAfter.control, stateBefore.control, 'le contrôle ne change pas');
    assert.equal(stateAfter.round, stateBefore.round);
  } finally {
    await h.cleanup();
  }
});

test('une décision produit un événement distinct d\'un message humain', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await pauseRun(h.deps, { runId });
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'Peux-tu vérifier ce chemin ?' });
    await recordDecision(h.deps, { runId, content: 'Une BF peut porter son propre canevas.' });

    const events = await (await openEventStore(runPaths(h.runsDir, runId), runId)).readAll();
    const message = events.find((event) => event.type === 'human_message');
    const decision = events.find((event) => event.type === 'decision_recorded');

    assert.ok(message !== undefined, 'le message conversationnel existe');
    assert.ok(decision !== undefined, "l'enregistrement normatif existe");
    assert.notEqual(message?.type, decision?.type, 'human_message ≠ decision_recorded');
    assert.equal(decision?.details?.['decision_id'], 'DEC-0001');
    assert.equal(decision?.target, undefined, "une décision ne vise aucun agent");
  } finally {
    await h.cleanup();
  }
});

test('les décisions sont append-only et numérotées', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await recordDecision(h.deps, { runId, content: 'Première décision.' });
    const journalAfterFirst = await readFile(runPaths(h.runsDir, runId).decisions, 'utf8');

    // Une correction crée une nouvelle décision : rien n'est édité ni supprimé.
    await recordDecision(h.deps, { runId, content: 'Correction de la première décision.' });

    const journalAfterSecond = await readFile(runPaths(h.runsDir, runId).decisions, 'utf8');
    assert.ok(journalAfterSecond.startsWith(journalAfterFirst), "l'historique n'est pas réécrit");

    const decisions = await listDecisions(h.deps, runId);
    assert.deepEqual(
      decisions.map((decision) => decision.decision_id),
      ['DEC-0001', 'DEC-0002'],
    );
    assert.equal(decisions[0]?.content, 'Première décision.');
  } finally {
    await h.cleanup();
  }
});

test('une décision vide est refusée', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await expectCcrError(recordDecision(h.deps, { runId, content: '   \n  ' }), 'INVALID_ARGUMENT');

    const decisions = await listDecisions(h.deps, runId);
    assert.equal(decisions.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('decide reste possible sous contrôle humain', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await pauseRun(h.deps, { runId });

    const result = await recordDecision(h.deps, { runId, content: 'Décision prise pendant la pause.' });

    assert.equal(result.state.state, 'PAUSED');
    assert.equal(result.state.control, 'HUMAN');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Scénario complet de la Definition of Done (partie humaine)
// --------------------------------------------------------------------------

test('automatisation → pause → intervention → resume conserve les sessions natives', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);

    await pauseRun(h.deps, { runId });
    await handoffRun(h.deps, { runId, agent: 'claude' });
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'contexte humain complémentaire' });
    await recordDecision(h.deps, { runId, content: 'Arbitrage normatif du DG.' });

    const paused = await readPersistedState(h.runsDir, runId);
    assert.equal(paused.state, 'PAUSED', "l'automatisation n'a jamais repris d'elle-même");
    assert.equal(paused.control, 'HUMAN');

    const resumed = await resumeRun(h.deps, { runId });
    assert.equal(resumed.state.state, 'READY');
    assert.equal(resumed.state.control, 'AUTOMATION');

    const { readManifest } = await import('../../src/store/state-store.ts');
    const manifest = await readManifest(runPaths(h.runsDir, runId));
    assert.equal(manifest.agents.claude.session_id, 'claude-uuid-1');
    assert.equal(manifest.agents.codex.session_id, 'codex-thread-1');

    const types = await eventTypes(h.runsDir, runId);
    assert.deepEqual(types.slice(-7), [
      'run_paused',
      'human_handoff_started',
      'human_handoff_finished',
      'human_message',
      'assistant_response',
      'decision_recorded',
      'run_resumed',
    ]);
  } finally {
    await h.cleanup();
  }
});
