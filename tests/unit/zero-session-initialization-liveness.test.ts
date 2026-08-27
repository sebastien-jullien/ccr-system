/**
 * V2.1-REPAIR — vivacité d'une initialisation zéro-session.
 *
 * Découvert pendant le preflight de câblage legacy V2.2. Un run dont le
 * **premier** agent échoue — le cas nominal — ne porte aucune session. Le
 * planner et le service le tenaient pour récupérable ; la vivacité exigeait
 * « exactement une session présente » et le classait `NONE`.
 *
 * Le run était donc simultanément :
 *
 * ```text
 * liste            attention INITIALIZATION
 * détail           needs_human_attention = false
 * panneau reprise  « Aucune capacité de reprise proposée. »
 * serveur          POST continue-initialization accepté et exécuté
 * ```
 *
 * `PARTIAL_INITIALIZATION` devient un statut de vivacité — initialisation
 * incomplète et récupérable — et cesse d'être un compte littéral de sessions.
 * Le nom est conservé : distinguer 0/2 de 1/2 par un statut de plus élargirait
 * la surface V2.1 sans rien dire de neuf.
 *
 * Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import { CcrError } from '../../src/core/errors.ts';
import { NO_EVIDENCE, classifyRunLiveness, needsHumanAttention } from '../../src/core/run-liveness.ts';
import { MANIFEST_SCHEMA_VERSION, STATE_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { PendingOperation, RunManifest, RunStateDocument } from '../../src/core/run.ts';
import { getRecoveryView, getRunView, listCockpitRuns } from '../../src/services/cockpit-read-model.ts';
import { applyCanonicalRecovery } from '../../src/services/recovery-application-service.ts';
import { isLongRunningRecovery, planCanonicalRecovery } from '../../src/services/recovery-planner.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import { recoverRun, startRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { DEFAULT_MAX_TRANSFER_BYTES } from '../../src/services/transfer.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { readManifest, readState } from '../../src/store/state-store.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const SETTINGS = { maxTransferBytes: DEFAULT_MAX_TRANSFER_BYTES };
const WORKSPACE = 'E:/prog/exemple';
const T = '2026-08-08T00:00:00.000Z';

// --------------------------------------------------------------------------
// Faits purs — classification
// --------------------------------------------------------------------------

function manifestOf(claude: string | null, codex: string | null): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: 'CCR-20260402-001',
    title: 'T',
    created_at: T,
    workspace: { cwd: WORKSPACE },
    agents: {
      claude: { session_id: claude, role: 'challenger' },
      codex: { session_id: codex, role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
  };
}

function stateOf(
  state: RunStateDocument['state'],
  over: Partial<RunStateDocument> = {},
): RunStateDocument {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: 'CCR-20260402-001',
    state,
    control: 'AUTOMATION',
    round: 0,
    active_agent: null,
    last_event_id: null,
    updated_at: T,
    pending_operation: null,
    uncertainty: null,
    ...over,
  };
}

const PENDING: PendingOperation = {
  kind: 'step',
  agent: 'claude',
  round: 1,
  prompt_event_id: 'evt_000004',
  source_event_id: 'evt_000003',
  session_id: 'claude-1',
  return_state: 'READY',
  return_control: 'AUTOMATION',
  started_at: T,
};

// --------------------------------------------------------------------------
// Harnais d'un run réel
// --------------------------------------------------------------------------

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  providerCalls(): number;
  startCalls(): number;
  cleanup(): Promise<void>;
}

/**
 * Run zéro-session, produit par le chemin d'échec réel de V2.1.
 *
 * `claude` est le premier agent de la boucle : son échec laisse le run sans
 * aucune session, `pending` effacé, contrôle rendu à l'humain.
 */
async function crashedFirstAgent(): Promise<{ h: Harness; runId: string }> {
  const runsDir = await makeTempDir('ccr-zero-session-');
  let failures = 1;

  const build = (kind: 'claude' | 'codex', fail: boolean): FakeAdapter =>
    createFakeAdapter({
      kind,
      sessionId: `${kind}-1`,
      ...(fail
        ? {
            failStart: () => {
              if (failures <= 0) return undefined;
              failures -= 1;
              return new CcrError('AGENT_TIMEOUT', 'délai (fixture)');
            },
          }
        : {}),
    });

  const claude = build('claude', true);
  const codex = build('codex', false);
  const adapters: AgentAdapters = { claude, codex };

  const h: Harness = {
    runsDir,
    providerCalls: () => claude.calls.length + codex.calls.length,
    startCalls: () =>
      claude.calls.filter((call) => call.phase === 'start').length +
      codex.calls.filter((call) => call.phase === 'start').length,
    deps: { runsDir, now: () => new Date(), createAdapters: () => adapters },
    cleanup: () => removeTempDir(runsDir),
  };

  const run = await startRun(h.deps, {
    runtimeConfig: TEST_RUNTIME_CONFIG,
    title: 'Initialisation interrompue',
    cwd: WORKSPACE,
    prompt: 'contexte initial',
  });
  assert.notEqual(run.failure, undefined, 'le premier agent devait échouer');

  const paths = runPaths(runsDir, run.runId);
  const state = await readState(paths);
  const manifest = await readManifest(paths);
  assert.equal(state.state, 'FAILED_INITIALIZATION');
  assert.equal(state.control, 'HUMAN');
  assert.equal(state.pending_operation, null);
  assert.equal(manifest.agents.claude.session_id, null);
  assert.equal(manifest.agents.codex.session_id, null);

  const events = await (await openEventStore(paths, run.runId)).readAll();
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_created', 'prompt_sent', 'process_failed'],
  );

  return { h, runId: run.runId };
}

// ==========================================================================
// A. Classification
// ==========================================================================

test('1 · zéro session manquante des deux côtés → PARTIAL_INITIALIZATION', () => {
  const manifest = manifestOf(null, null);
  assert.equal(manifest.agents.claude.session_id, null);
  assert.equal(manifest.agents.codex.session_id, null);

  const verdict = classifyRunLiveness(
    { manifest, state: stateOf('FAILED_INITIALIZATION', { control: 'HUMAN' }), pendingResponseJournaled: false },
    NO_EVIDENCE,
  );
  assert.equal(verdict.liveness, 'PARTIAL_INITIALIZATION');
  assert.equal(verdict.basis, 'PARTIAL_SESSIONS');
  assert.equal(verdict.pendingOperation, null);
  // 2 · la vivacité répond enfin à sa propre question.
  assert.equal(needsHumanAttention(verdict.liveness), true);
});

test('5 · une session présente : classification historique inchangée', () => {
  for (const manifest of [manifestOf('claude-1', null), manifestOf(null, 'codex-1')]) {
    const verdict = classifyRunLiveness(
      { manifest, state: stateOf('FAILED_INITIALIZATION'), pendingResponseJournaled: false },
      NO_EVIDENCE,
    );
    assert.equal(verdict.liveness, 'PARTIAL_INITIALIZATION');
    assert.equal(verdict.basis, 'PARTIAL_SESSIONS');
    assert.equal(needsHumanAttention(verdict.liveness), true);
  }
});

test('7 · rien d’incomplet, et rien n’est requalifié en initialisation', () => {
  // Les deux sessions existent : plus rien ne manque.
  const complete = classifyRunLiveness(
    {
      manifest: manifestOf('claude-1', 'codex-1'),
      state: stateOf('FAILED_INITIALIZATION'),
      pendingResponseJournaled: false,
    },
    NO_EVIDENCE,
  );
  assert.equal(complete.liveness, 'NONE');
  assert.equal(complete.basis, 'NO_PENDING_WORK');

  // Un run sain dont une session manquerait n'est pas concerné : l'élargissement
  // reste borné à `FAILED_INITIALIZATION`.
  for (const state of ['READY', 'PAUSED', 'WAITING_HUMAN', 'CLOSED'] as const) {
    const verdict = classifyRunLiveness(
      { manifest: manifestOf(null, null), state: stateOf(state, { control: 'HUMAN' }), pendingResponseJournaled: false },
      NO_EVIDENCE,
    );
    assert.notEqual(verdict.liveness, 'PARTIAL_INITIALIZATION', state);
  }
});

test('8–9 · aucune classe prioritaire n’est masquée', () => {
  const empty = manifestOf(null, null);

  // 8 · une ambiguïté déjà matérialisée passe avant, même sans session.
  const materialized = classifyRunLiveness(
    { manifest: empty, state: stateOf('RECOVERY_REQUIRED', { control: 'HUMAN' }), pendingResponseJournaled: false },
    NO_EVIDENCE,
  );
  assert.equal(materialized.liveness, 'AMBIGUOUS');
  assert.equal(materialized.basis, 'RECOVERY_MATERIALIZED');

  // 9 · un travail engagé reste jugé sur l'évidence, jamais sur le compte de
  //     sessions — la nouvelle branche n'est atteinte que par
  //     `FAILED_INITIALIZATION`.
  const pending = stateOf('WAITING_AGENT', { pending_operation: PENDING, active_agent: 'claude' });

  const abandoned = classifyRunLiveness(
    { manifest: empty, state: pending, pendingResponseJournaled: true },
    { lock: 'ABSENT', hostOperation: 'NONE', pendingCoveredByLock: 'NO' },
  );
  assert.equal(abandoned.liveness, 'ABANDONED_OPERATION');

  const ambiguous = classifyRunLiveness(
    { manifest: empty, state: pending, pendingResponseJournaled: false },
    { lock: 'ABSENT', hostOperation: 'NONE', pendingCoveredByLock: 'NO' },
  );
  assert.equal(ambiguous.liveness, 'AMBIGUOUS');

  const inFlight = classifyRunLiveness(
    { manifest: empty, state: pending, pendingResponseJournaled: false },
    { lock: 'ALIVE_OTHER_PROCESS', hostOperation: 'UNKNOWN', pendingCoveredByLock: 'YES' },
  );
  assert.equal(inFlight.liveness, 'OPERATION_IN_FLIGHT');

  const orphan = classifyRunLiveness(
    { manifest: empty, state: pending, pendingResponseJournaled: false },
    { lock: 'STALE', hostOperation: 'NONE', pendingCoveredByLock: 'UNKNOWN' },
  );
  assert.equal(orphan.liveness, 'ORPHAN_LOCK');

  // Et une initialisation incomplète PORTANT un pending reste jugée sur ce
  // pending : la branche 2 la capte, mais elle transmet l'opération observée.
  const withPending = classifyRunLiveness(
    { manifest: empty, state: stateOf('FAILED_INITIALIZATION', { pending_operation: PENDING }), pendingResponseJournaled: false },
    NO_EVIDENCE,
  );
  assert.equal(withPending.pendingOperation, PENDING, 'l’opération observée reste rapportée');
});

// ==========================================================================
// B. Read model, sur un run réellement produit par l'échec
// ==========================================================================

test('2–4 · le détail et le panneau de reprise disent enfin la même chose', async () => {
  const { h, runId } = await crashedFirstAgent();
  try {
    const calls = h.providerCalls();

    // Le planner canonique n'a pas bougé : il disait déjà vrai.
    const snapshot = await readStableRunSnapshot(h.runsDir, runId);
    assert.equal(
      planCanonicalRecovery({
        manifest: snapshot.manifest,
        state: snapshot.state,
        pendingResponseJournaled: false,
      }),
      'RECOVERY_CONTINUE_INITIALIZATION',
    );

    const view = await getRunView({ runsDir: h.runsDir, settings: SETTINGS }, runId);
    assert.equal(view.state.state, 'FAILED_INITIALIZATION');
    assert.equal(view.state.control, 'HUMAN');
    assert.deepEqual(view.sessions, { claude: null, codex: null });
    assert.equal(view.liveness.liveness, 'PARTIAL_INITIALIZATION');
    // 2 · plus de contradiction avec la liste.
    assert.equal(view.liveness.needs_human_attention, true);

    const summary = (await listCockpitRuns({ runsDir: h.runsDir, settings: SETTINGS })).find(
      (entry) => entry.run_id === runId,
    );
    assert.equal(summary?.attention, 'INITIALIZATION');

    // 3 · 4 · 10 · la capacité est découverte normalement.
    const recovery = await getRecoveryView({ runsDir: h.runsDir, settings: SETTINGS }, runId);
    assert.deepEqual(
      recovery.capabilities.map((entry) => entry.id),
      ['RECOVERY_CONTINUE_INITIALIZATION'],
    );
    assert.deepEqual(recovery.sessions, { claude: 'ABSENT', codex: 'ABSENT' });
    assert.equal(recovery.liveness.liveness, 'PARTIAL_INITIALIZATION');
    assert.equal(recovery.liveness.needs_human_attention, true);
    assert.deepEqual(recovery.missing_primitives, []);

    // 12 · le contrat de la capacité est inchangé.
    const capability = recovery.capabilities[0];
    assert.equal(capability?.effect, 'CREATE_MISSING_NATIVE_SESSION');
    assert.equal(capability?.long_running, true);
    assert.equal(capability?.requires_confirmation, true);
    assert.equal(capability?.allowed, true);
    assert.equal(isLongRunningRecovery('RECOVERY_CONTINUE_INITIALIZATION'), true);

    // 14 · lire n'appelle personne.
    assert.equal(h.providerCalls() - calls, 0);
  } finally {
    await h.cleanup();
  }
});

test('6 · une session présente : la capacité reste exposée comme avant', async () => {
  const { h, runId } = await crashedFirstAgent();
  try {
    // Le run avance d'une session : c'est le cas historique déjà reconnu.
    await recoverRun(h.deps, { runId });
    const paths = runPaths(h.runsDir, runId);

    // Puis l'image d'un run resté à une seule session : celle que V2.1
    // reconnaissait déjà avant ce repair.
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      agents: Record<string, { session_id: string | null }>;
    };
    const codex = manifest.agents['codex'];
    assert.ok(codex);
    codex.session_id = null;
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const state = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>;
    state['state'] = 'FAILED_INITIALIZATION';
    await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const recovery = await getRecoveryView({ runsDir: h.runsDir, settings: SETTINGS }, runId);
    assert.equal(recovery.liveness.liveness, 'PARTIAL_INITIALIZATION');
    assert.deepEqual(
      recovery.capabilities.map((entry) => entry.id),
      ['RECOVERY_CONTINUE_INITIALIZATION'],
    );
    assert.deepEqual(recovery.sessions, { claude: 'PRESENT', codex: 'ABSENT' });
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// C. Exécution — inchangée
// ==========================================================================

test('11–12 · la voie applicative accepte la même capacité, et l’admet comme longue', async () => {
  const { h, runId } = await crashedFirstAgent();
  try {
    const snapshot = await readStableRunSnapshot(h.runsDir, runId);
    const manager = createLongOperationManager();
    const admitted: string[] = [];
    const starts = h.startCalls();

    const outcome = await applyCanonicalRecovery(h.deps, {
      runId,
      expectedRevision: snapshot.revision,
      capability: 'RECOVERY_CONTINUE_INITIALIZATION',
    }, {
      onReadyForEffect: (id) => {
        if (isLongRunningRecovery(id)) {
          manager.admit('op_zero');
          admitted.push(id);
        }
      },
    });

    // La validation serveur est celle qui existait : capacité demandée ==
    // capacité canonique courante. Elle acceptait déjà ; elle accepte toujours.
    assert.deepEqual(admitted, ['RECOVERY_CONTINUE_INITIALIZATION']);
    assert.equal(manager.activeCount(), 1, 'un créneau pour toute l’opération');
    assert.deepEqual([...outcome.result.sessionsCreated], ['claude', 'codex']);
    assert.equal(h.startCalls() - starts, 2, 'deux agents, séquentiellement');
    assert.equal((await readState(runPaths(h.runsDir, runId))).state, 'READY');
  } finally {
    await h.cleanup();
  }
});

test('13 · le service initialise toujours les deux agents manquants', async () => {
  const { h, runId } = await crashedFirstAgent();
  try {
    const starts = h.startCalls();
    const result = await recoverRun(h.deps, { runId });

    assert.equal(h.startCalls() - starts, 2);
    assert.deepEqual([...result.sessionsCreated], ['claude', 'codex']);

    const manifest = await readManifest(runPaths(h.runsDir, runId));
    assert.equal(manifest.agents.claude.session_id, 'claude-1');
    assert.equal(manifest.agents.codex.session_id, 'codex-1');

    const state = await readState(runPaths(h.runsDir, runId));
    assert.equal(state.state, 'READY');
    assert.equal(state.control, 'AUTOMATION');

    // Le run réparé quitte la classe : plus rien n'est incomplet.
    const view = await getRecoveryView({ runsDir: h.runsDir, settings: SETTINGS }, runId);
    assert.equal(view.liveness.liveness, 'NONE');
    assert.deepEqual(view.capabilities, []);
  } finally {
    await h.cleanup();
  }
});
