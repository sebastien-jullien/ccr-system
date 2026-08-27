/**
 * Tests unitaires des services de run (lot V1.5).
 *
 * Ils portent sur les invariants d'orchestration, en particulier :
 *
 *  - `WAITING_AGENT` persisté AVANT l'appel agent et quitté APRÈS
 *    journalisation de la réponse (§32) ;
 *  - `ccr send` ne rend jamais le contrôle à l'automatisation (§24.1) ;
 *  - `FAILED` réservé aux invariants brisés (§18.4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { AgentKind, RunStateDocument } from '../../src/core/run.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { persistStateUpdate, readState } from '../../src/store/state-store.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { getRunStatus, resolveRunId, sendMessage, startRun } from '../../src/services/run-service.ts';
import { listAnyRuns } from '../../src/cli/native-dispatch.ts';
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
  const runsDir = await makeTempDir('ccr-service-');
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

// --------------------------------------------------------------------------
// start_run
// --------------------------------------------------------------------------

test('startRun crée le run, les deux sessions natives et revient à READY', async () => {
  const h = await harness();
  try {
    const result = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Assainissement', cwd: WORKSPACE, prompt: 'contexte initial' });

    assert.ok(/^CCR-\d{8}-\d{3}$/.test(result.runId));
    assert.equal(result.state.state, 'READY');
    assert.equal(result.state.control, 'AUTOMATION');
    assert.equal(result.state.round, 0);
    assert.equal(result.manifest.agents.claude.session_id, 'claude-uuid-1');
    assert.equal(result.manifest.agents.codex.session_id, 'codex-thread-1');
    assert.equal(result.manifest.workspace.cwd, WORKSPACE);
    assert.equal(result.failure, undefined);

    assert.deepEqual(h.claude.calls, [{ phase: 'start', sessionId: undefined, prompt: 'contexte initial' }]);
    assert.deepEqual(h.codex.calls, [{ phase: 'start', sessionId: undefined, prompt: 'contexte initial' }]);
  } finally {
    await h.cleanup();
  }
});

test('startRun journalise la création dans un ordre exploitable', async () => {
  const h = await harness();
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
    const paths = runPaths(h.runsDir, runId);
    const events = await (await openEventStore(paths, runId)).readAll();

    assert.deepEqual(
      events.map((event) => event.type),
      [
        'run_created',
        'prompt_sent',
        'assistant_response',
        'session_created',
        'prompt_sent',
        'assistant_response',
        'session_created',
      ],
    );
    assert.equal(events[2]?.actor, 'claude');
    assert.equal(events[2]?.session_id, 'claude-uuid-1');
    assert.deepEqual(events[2]?.based_on, ['evt_000002']);
    assert.equal(events[5]?.actor, 'codex');
  } finally {
    await h.cleanup();
  }
});

test("startRun conserve la session déjà créée quand la seconde échoue (§30)", async () => {
  const h = await harness({}, { failStart: () => new CcrError('AGENT_EXIT_NONZERO', 'codex indisponible') });
  try {
    const result = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });

    assert.equal(result.state.state, 'FAILED_INITIALIZATION');
    assert.equal(result.failure?.agent, 'codex');
    assert.equal(result.manifest.agents.claude.session_id, 'claude-uuid-1', 'la session Claude est préservée');
    assert.equal(result.manifest.agents.codex.session_id, null);

    // L'état est relisible depuis le disque : rien n'a été détruit.
    const persisted = await readPersistedState(h.runsDir, result.runId);
    assert.equal(persisted.state, 'FAILED_INITIALIZATION');
    assert.equal(persisted.active_agent, null);

    const events = await (await openEventStore(runPaths(h.runsDir, result.runId), result.runId)).readAll();
    assert.ok(events.some((event) => event.type === 'process_failed' && event.target === 'codex'));
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Invariant WAITING_AGENT
// --------------------------------------------------------------------------

test('WAITING_AGENT est persisté AVANT l\'appel agent et quitté APRÈS la réponse', async () => {
  const observed: Array<{ state: string; activeAgent: AgentKind | null; lastEventId: string | null }> = [];
  const runsDirBox: { value?: string } = {};

  const h = await harness({
    onCall: async () => {
      // Observation depuis « l'intérieur » de l'appel agent : ce que verrait
      // un processus qui redémarrerait à cet instant précis.
      const runsDir = runsDirBox.value;
      assert.ok(runsDir);
      const runId = (await listAnyRuns(runsDir))[0]?.runId;
      assert.ok(runId);
      const state = await readPersistedState(runsDir, runId);
      observed.push({ state: state.state, activeAgent: state.active_agent, lastEventId: state.last_event_id });
    },
  });
  runsDirBox.value = h.runsDir;

  try {
    const result = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });

    assert.equal(observed.length, 1, "l'appel Claude doit avoir été observé");
    assert.equal(observed[0]?.state, 'WAITING_AGENT', "l'état doit être persisté avant l'appel");
    assert.equal(observed[0]?.activeAgent, 'claude');
    assert.equal(observed[0]?.lastEventId, 'evt_000002', 'le prompt est déjà journalisé');

    // Après le tour, l'état pointe sur la réponse journalisée.
    const after = await readPersistedState(h.runsDir, result.runId);
    assert.notEqual(after.state, 'WAITING_AGENT');
    assert.equal(after.active_agent, null);
  } finally {
    await h.cleanup();
  }
});

test('un WAITING_AGENT persisté interdit tout nouvel envoi et impose la reprise', async () => {
  const h = await harness();
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
    await forceState(h.runsDir, runId, { state: 'RUNNING' });
    await forceState(h.runsDir, runId, { state: 'WAITING_AGENT', activeAgent: 'codex' });

    const error = await expectCcrError(
      sendMessage(h.deps, { runId, agent: 'claude', message: 'bonjour' }),
      'RECOVERY_REQUIRED',
    );
    assert.equal(error.details['activeAgent'], 'codex');

    const status = await getRunStatus(h.deps, runId);
    assert.equal(status.requiresRecovery, true);
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// send_message — action humaine, jamais une reprise (§24.1)
// --------------------------------------------------------------------------

test('un envoi depuis PAUSED laisse le run PAUSED et le contrôle HUMAIN', async () => {
  const h = await harness();
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
    await forceState(h.runsDir, runId, { state: 'PAUSED', control: 'HUMAN' });

    const result = await sendMessage(h.deps, { runId, agent: 'claude', message: 'précision humaine' });

    assert.equal(result.state.state, 'PAUSED', 'envoyer un message n\'équivaut pas à ccr resume');
    assert.equal(result.state.control, 'HUMAN', 'le contrôle reste humain');
    assert.equal(result.response, 'claude:précision humaine');
    assert.deepEqual(h.claude.calls[1], {
      phase: 'resume',
      sessionId: 'claude-uuid-1',
      prompt: 'précision humaine',
    });

    const persisted = await readPersistedState(h.runsDir, runId);
    assert.equal(persisted.state, 'PAUSED');
    assert.equal(persisted.control, 'HUMAN');
  } finally {
    await h.cleanup();
  }
});

test('un envoi depuis WAITING_HUMAN laisse le run WAITING_HUMAN', async () => {
  const h = await harness();
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
    await forceState(h.runsDir, runId, { state: 'WAITING_HUMAN', control: 'HUMAN' });

    const result = await sendMessage(h.deps, { runId, agent: 'codex', message: 'réponse humaine' });

    assert.equal(result.state.state, 'WAITING_HUMAN');
    assert.equal(result.state.control, 'HUMAN');
  } finally {
    await h.cleanup();
  }
});

test('un envoi depuis READY revient à READY sous contrôle AUTOMATION', async () => {
  const h = await harness();
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });

    const result = await sendMessage(h.deps, { runId, agent: 'codex', message: 'suite' });

    assert.equal(result.state.state, 'READY');
    assert.equal(result.state.control, 'AUTOMATION');
  } finally {
    await h.cleanup();
  }
});

test('un envoi humain produit human_message puis assistant_response', async () => {
  const h = await harness();
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
    await forceState(h.runsDir, runId, { state: 'PAUSED', control: 'HUMAN' });
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'question' });

    const events = await (await openEventStore(runPaths(h.runsDir, runId), runId)).readAll();
    const tail = events.slice(-2);

    assert.equal(tail[0]?.type, 'human_message');
    assert.equal(tail[0]?.actor, 'human');
    assert.equal(tail[0]?.target, 'claude');
    assert.equal(tail[0]?.content, 'question');
    assert.equal(tail[1]?.type, 'assistant_response');
    assert.equal(tail[1]?.actor, 'claude');
    assert.deepEqual(tail[1]?.based_on, [tail[0]?.event_id]);
  } finally {
    await h.cleanup();
  }
});

test('un envoi vers un agent sans session est refusé explicitement', async () => {
  const h = await harness({}, { failStart: () => new CcrError('AGENT_EXIT_NONZERO', 'indisponible') });
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });

    const error = await expectCcrError(
      sendMessage(h.deps, { runId, agent: 'codex', message: 'bonjour' }),
      'SESSION_MISSING',
    );
    assert.equal(error.details['agent'], 'codex');
  } finally {
    await h.cleanup();
  }
});

test('un envoi sur un run clos est refusé par la machine d\'état', async () => {
  const h = await harness();
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
    await forceState(h.runsDir, runId, { state: 'CLOSED' });

    await expectCcrError(
      sendMessage(h.deps, { runId, agent: 'claude', message: 'x' }),
      'ILLEGAL_STATE_TRANSITION',
    );
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Classement des échecs (§18.4, amendement A-6)
// --------------------------------------------------------------------------

test('un timeout laisse le run PAUSED et reprenable, jamais FAILED', async () => {
  const h = await harness({ failResume: () => new CcrError('AGENT_TIMEOUT', 'délai dépassé') });
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });

    await expectCcrError(sendMessage(h.deps, { runId, agent: 'claude', message: 'x' }), 'AGENT_TIMEOUT');

    const persisted = await readPersistedState(h.runsDir, runId);
    assert.equal(persisted.state, 'PAUSED', 'un timeout est un incident opérationnel');
    assert.notEqual(persisted.state, 'FAILED');
    assert.equal(persisted.control, 'HUMAN');
    assert.equal(persisted.active_agent, null);
  } finally {
    await h.cleanup();
  }
});

test('un code de sortie non nul laisse également le run reprenable', async () => {
  const h = await harness({ failResume: () => new CcrError('AGENT_EXIT_NONZERO', 'exit 1') });
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
    await expectCcrError(sendMessage(h.deps, { runId, agent: 'claude', message: 'x' }), 'AGENT_EXIT_NONZERO');

    assert.equal((await readPersistedState(h.runsDir, runId)).state, 'PAUSED');
  } finally {
    await h.cleanup();
  }
});

test('une session native répondant sous un autre identifiant est un invariant brisé', async () => {
  const h = await harness({ resumeSessionId: 'claude-uuid-AUTRE' });
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });

    // L'adapter réel lève AGENT_SESSION_MISMATCH ; on le reproduit ici pour
    // vérifier le classement effectué par le service.
    const mismatchHarness = await harness({
      failResume: () => new CcrError('AGENT_SESSION_MISMATCH', 'session dérivée'),
    });
    try {
      const run = await startRun(mismatchHarness.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
      await expectCcrError(
        sendMessage(mismatchHarness.deps, { runId: run.runId, agent: 'claude', message: 'x' }),
        'AGENT_SESSION_MISMATCH',
      );

      const persisted = await readPersistedState(mismatchHarness.runsDir, run.runId);
      assert.equal(persisted.state, 'FAILED', 'poursuivre écrirait dans une autre conversation');
    } finally {
      await mismatchHarness.cleanup();
    }

    assert.ok(runId);
  } finally {
    await h.cleanup();
  }
});

test("aucune réponse n'est inventée lorsqu'un tour échoue", async () => {
  const h = await harness({ failResume: () => new CcrError('AGENT_OUTPUT_UNPARSABLE', 'JSON illisible') });
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
    await expectCcrError(sendMessage(h.deps, { runId, agent: 'claude', message: 'x' }), 'AGENT_OUTPUT_UNPARSABLE');

    const events = await (await openEventStore(runPaths(h.runsDir, runId), runId)).readAll();
    const responses = events.filter((event) => event.type === 'assistant_response');
    assert.equal(responses.length, 2, 'seules les réponses des créations de session existent');
    assert.ok(events.some((event) => event.type === 'process_failed'));
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// list / status / résolution du run
// --------------------------------------------------------------------------

test('listAnyRuns décrit chaque run sans en masquer aucun', async () => {
  const h = await harness();
  try {
    const first = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Premier', cwd: WORKSPACE, prompt: 'p' });
    const second = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Second', cwd: WORKSPACE, prompt: 'p' });

    const summaries = await listAnyRuns(h.runsDir);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0]?.runId, first.runId);
    assert.equal(summaries[0]?.title, 'Premier');
    assert.equal(summaries[1]?.title, 'Second');
    assert.equal(summaries[1]?.state, 'READY');
  } finally {
    await h.cleanup();
  }
});

test('getRunStatus expose le dernier événement et le compteur', async () => {
  const h = await harness();
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'p' });
    const status = await getRunStatus(h.deps, runId);

    assert.equal(status.manifest.run_id, runId);
    assert.equal(status.eventCount, 7);
    assert.equal(status.lastEvent?.type, 'session_created');
    assert.equal(status.state.last_event_id, status.lastEvent?.event_id);
    assert.equal(status.requiresRecovery, false);
  } finally {
    await h.cleanup();
  }
});

test('le run implicite est le plus récent non CLOSED', async () => {
  const h = await harness();
  try {
    const first = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Premier', cwd: WORKSPACE, prompt: 'p' });
    const second = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Second', cwd: WORKSPACE, prompt: 'p' });

    assert.equal(await resolveRunId(h.deps), second.runId);

    await forceState(h.runsDir, second.runId, { state: 'CLOSED' });
    assert.equal(await resolveRunId(h.deps), first.runId);

    await forceState(h.runsDir, first.runId, { state: 'CLOSED' });
    await expectCcrError(resolveRunId(h.deps), 'NO_ACTIVE_RUN');
  } finally {
    await h.cleanup();
  }
});

test('les artefacts du run restent lisibles sur disque', async () => {
  const h = await harness();
  try {
    const { runId } = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Titre', cwd: WORKSPACE, prompt: 'p' });
    const paths = runPaths(h.runsDir, runId);

    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as Record<string, unknown>;
    assert.equal(manifest['run_id'], runId);

    const journal = await readFile(paths.events, 'utf8');
    assert.equal(journal.trimEnd().split('\n').length, 7);
    assert.ok(path.isAbsolute(paths.root));
  } finally {
    await h.cleanup();
  }
});
