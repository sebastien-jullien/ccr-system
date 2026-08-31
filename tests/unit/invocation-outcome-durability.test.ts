/**
 * Durabilité de l'issue négative — chemins natifs et modèle de lecture.
 *
 * Ce qui est éprouvé :
 *
 * ```text
 * B  échec d'acquisition du verrou AVANT la mutation pré-fournisseur
 *    → aucun prompt_sent, aucun WAITING_AGENT, aucun engagement
 *    → aucun appel fournisseur, aucune mutation de nettoyage
 * C  échec de persistance DANS la mutation pré-fournisseur
 *    → nettoyage cohérent, aucun appel fournisseur sans engagement durable
 * D  issue négative native durable AVANT l'exposition du résultat
 * N  charge utile native : détail typé conservé, sac d'adaptateur exclu
 * E  reprise : aucun verrou imbriqué, issue écrite sous le verrou détenu
 * F  SEND : le transcript natif demeure, et l'issue lui est corrélée
 * L  fait négatif + preuve de succès  →  INCONSISTENT, sans vainqueur
 * M  run ancien sans document d'issues : lisible, aucun backfill
 * ```
 *
 * Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { InvocationDispatchRecord } from '../../src/core/usage-governance.ts';
import type { InvocationOutcomeRecord } from '../../src/core/invocation-outcome.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeStartHooks } from '../../src/services/native-start-service.ts';
import { continueNativeInitialization } from '../../src/services/native-recovery-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import { expertSlotTarget } from '../../src/services/native-target-resolver.ts';
import { projectInvocationOutcomes } from '../../src/services/invocation-outcome-read-model.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { readInvocationOutcomes } from '../../src/store/invocation-outcome-store.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import { acquireRunLock } from '../../src/lock/run-lock.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-31T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

interface HarnessOptions {
  readonly failStart?: () => unknown;
  readonly failResume?: () => unknown;
  readonly onStart?: () => Promise<void> | void;
  /** Deux `start()` rendant le même identifiant : la collision de session. */
  readonly collidingSessionId?: string;
  /** Identifiant réellement rendu à la reprise : la dérive de session. */
  readonly resumeSessionId?: string;
}

interface Harness {
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  startCalls(): number;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds:
        options.collidingSessionId === undefined
          ? [`${kind}-1`, `${kind}-2`]
          : [options.collidingSessionId, options.collidingSessionId],
      ...(options.failStart === undefined ? {} : { failStart: options.failStart }),
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
      ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
      onCall: async (phase) => {
        if (phase === 'start') await options.onStart?.();
      },
    });

  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
    adapters,
    startCalls: () =>
      adapters.claude.calls.filter((call) => call.phase === 'start').length +
      adapters.codex.calls.filter((call) => call.phase === 'start').length,
    deps: {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => adapters,
    },
  };
}

function nativeRuntime(): NativeRunRuntimeConfig {
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: AT,
    claude: { required: true, probe_status: 'OBSERVED', cli_version: '2.1.224', auth_preflight: 'AUTHENTICATED' },
    codex: {
      required: true,
      probe_status: 'OBSERVED',
      cli_version: '0.146.0',
      auth_preflight: 'AUTHENTICATED',
      skip_git_repo_check: false,
      source_at_capture: 'default',
    },
  };
}

function start(
  h: Harness,
  dir: string,
  hooks: NativeStartHooks = {},
  bindings?: { author: ProviderKind; challenger: ProviderKind },
): ReturnType<typeof startNativeRun> {
  return startNativeRun(
    h.deps,
    {
      title: 'T',
      cwd: dir,
      prompt: MISSION,
      runtimeConfig: nativeRuntime(),
      ...(bindings === undefined ? {} : { bindings }),
    },
    hooks,
  );
}

async function journal(runsDir: string, runId: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

// --------------------------------------------------------------------------
// B — le verrou pré-fournisseur ne peut pas être acquis
// --------------------------------------------------------------------------

test("B — verrou indisponible : aucun fait de la tentative, aucun appel fournisseur", async () => {
  const dir = await makeTempDir('ccr-outcome-lockfail-');
  const h = harness(dir);
  try {
    // Le run est alloué, puis le verrou est pris par un tiers **avant** que le
    // premier slot n'entre dans sa mutation courte.
    let held: Awaited<ReturnType<typeof acquireRunLock>> | undefined;
    const hooks: NativeStartHooks = {
      onAllocated: async (runId) => {
        held = await acquireRunLock(runPaths(dir, runId), 'tiers-concurrent');
      },
    };

    const result = await start(h, dir, hooks);
    await held?.release();

    // L'initialisation s'arrête sur le premier slot.
    assert.notEqual(result.failure, undefined);
    assert.equal(result.positions.length, 0);

    // Aucun appel fournisseur : la mutation n'a jamais été ouverte.
    assert.equal(h.startCalls(), 0);

    const events = await journal(dir, result.runId);
    // Aucun fait de la tentative — ni intention, ni contexte de reprise.
    assert.equal(events.filter((event) => event.type === 'prompt_sent').length, 0);
    assert.equal(events.filter((event) => event.type === 'process_failed').length, 0);

    // Aucun engagement.
    const paths = runPaths(dir, result.runId);
    const invocations = await (await openInvocationLedger(paths, result.runId)).readAll();
    assert.equal(invocations.length, 0);

    // Aucune mutation de nettoyage hors verrou : l'état reste celui d'avant la
    // tentative, jamais FAILED_INITIALIZATION.
    const state = await readPersistedState(paths);
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
    assert.notEqual(state.document.state, 'WAITING_AGENT');
    assert.notEqual(state.document.state, 'FAILED_INITIALIZATION');

    // Aucune issue : rien n'a été engagé, il n'y a rien à quoi la rattacher.
    assert.equal((await readInvocationOutcomes(paths)).outcomes.length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// C — l'engagement échoue DANS la mutation pré-fournisseur
// --------------------------------------------------------------------------

test("C — engagement impossible : nettoyage cohérent, et aucun appel fournisseur", async () => {
  const dir = await makeTempDir('ccr-outcome-ledgerfail-');
  const h = harness(dir);
  try {
    const hooks: NativeStartHooks = {
      openInvocationLedger: async (paths, runId, options) => {
        const real = await openInvocationLedger(paths, runId, options);
        return {
          ...real,
          // Une panne de stockage n'est pas nécessairement typée par CCR.
          append: () => Promise.reject(new Error('disque plein')),
        };
      },
    };

    const result = await start(h, dir, hooks);

    assert.equal(h.startCalls(), 0, 'aucun fournisseur sans engagement durable');
    assert.equal(result.positions.length, 0);
    assert.ok(isCcrError(result.failure?.error));
    assert.equal((result.failure?.error as CcrError).code, 'INVOCATION_LEDGER_WRITE_FAILED');

    const paths = runPaths(dir, result.runId);
    const events = await journal(dir, result.runId);
    // Le nettoyage n'invente aucun `process_failed` : la panne est celle de CCR.
    assert.equal(events.filter((event) => event.type === 'process_failed').length, 0);

    const state = await readPersistedState(paths);
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
    // Le contexte est libéré, sous la même sérialisation que les faits ouverts.
    assert.equal(state.document.pending_operation ?? null, null);

    assert.equal((await readInvocationOutcomes(paths)).outcomes.length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// D — issue négative native durable avant exposition
// --------------------------------------------------------------------------

test("D — échec fournisseur natif : l'issue est durable avant que l'erreur ne remonte", async () => {
  const dir = await makeTempDir('ccr-outcome-native-');
  const h = harness(dir, { failStart: () => new CcrError('AGENT_TIMEOUT', 'délai dépassé') });
  try {
    const result = await start(h, dir);

    assert.notEqual(result.failure, undefined);
    const paths = runPaths(dir, result.runId);

    // Un engagement existe.
    const invocations = await (await openInvocationLedger(paths, result.runId)).readAll();
    assert.equal(invocations.length, 1);
    const invocationId = invocations[0]?.invocation_id as string;

    // L'issue est durable, rattachée à cet engagement, avec son code natif.
    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 1);
    assert.equal(document.outcomes[0]?.invocation_id, invocationId);
    assert.deepEqual(document.outcomes[0]?.terminal_negative_outcome, {
      kind: 'NATIVE_PROCESS_FAILED',
      error_code: 'AGENT_TIMEOUT',
    });

    // Le transcript natif demeure : deux autorités distinctes, jamais l'une
    // remplacée par l'autre.
    const events = await journal(dir, result.runId);
    assert.equal(events.filter((event) => event.type === 'process_failed').length, 1);
  } finally {
    await removeTempDir(dir);
  }
});

test("D — une cause non typée ne fabrique aucun code natif", async () => {
  const dir = await makeTempDir('ccr-outcome-unknown-');
  const h = harness(dir, { failStart: () => new Error('panne quelconque') });
  try {
    const result = await start(h, dir);
    assert.notEqual(result.failure, undefined);

    const paths = runPaths(dir, result.runId);
    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 1);
    assert.deepEqual(document.outcomes[0]?.terminal_negative_outcome, { kind: 'NATIVE_PROCESS_FAILED' });
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// N — charge utile native : le détail typé que CCR construit lui-même
// --------------------------------------------------------------------------
//
// `process_failed.details` vaut `{ code, ...error.details }` : il porte donc
// les champs typés de l'erreur. Réduire l'issue durable à son seul
// `error_code` perdrait ce que CCR sait réellement de l'échec — quel slot,
// quel moteur, quelle session. Ces tests éprouvent la conservation, et sa
// borne : les sacs de diagnostic des adaptateurs n'entrent pas.

test('N — SESSION_ID_COLLISION : slot, moteur et session sont conservés', async () => {
  const dir = await makeTempDir('ccr-outcome-collision-');
  // Un seul moteur pour les deux slots, rendant deux fois la même session.
  const h = harness(dir, { collidingSessionId: 'claude-partagee' });
  try {
    const started = await start(h, dir, {}, { author: 'claude', challenger: 'claude' });

    assert.equal(started.failure?.slot, 'challenger');
    assert.ok(isCcrError(started.failure?.error));
    assert.equal((started.failure?.error as CcrError).code, 'SESSION_ID_COLLISION');

    const paths = runPaths(dir, started.runId);
    const invocations = await (await openInvocationLedger(paths, started.runId)).readAll();
    const collided = invocations[1];

    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 1);
    assert.equal(document.outcomes[0]?.invocation_id, collided?.invocation_id);

    // Le fait durable, champ pour champ. `deepEqual` vaut ici garde de fermeture :
    // un sac générique qui se serait glissé dans la charge utile le ferait échouer.
    assert.deepEqual(document.outcomes[0]?.terminal_negative_outcome, {
      kind: 'NATIVE_PROCESS_FAILED',
      error_code: 'SESSION_ID_COLLISION',
      native_detail: {
        code: 'SESSION_ID_COLLISION',
        expert_slot: 'challenger',
        provider: 'claude',
        session_id: 'claude-partagee',
      },
    });

    // Le transcript natif est inchangé : il porte toujours les mêmes champs
    // typés, sous leurs noms d'origine. La nouvelle source ne le remplace pas.
    const events = await journal(dir, started.runId);
    const failed = events.filter((event) => event.type === 'process_failed');
    assert.equal(failed.length, 1);
    const only = failed[0];
    assert.ok(only !== undefined && 'details' in only);
    assert.deepEqual(only.details, {
      code: 'SESSION_ID_COLLISION',
      slot: 'challenger',
      provider: 'claude',
      session_id: 'claude-partagee',
    });
  } finally {
    await removeTempDir(dir);
  }
});

test('N — AGENT_SESSION_MISMATCH : les deux sessions sont conservées', async () => {
  const dir = await makeTempDir('ccr-outcome-drift-');
  try {
    const healthy = harness(dir);
    const started = await start(healthy, dir);
    assert.equal(started.failure, undefined);

    // La reprise répond sous une autre session que celle qui était reprise.
    const drifting = harness(dir, { resumeSessionId: 'claude-derivee' });
    await assert.rejects(
      () => sendNativeMessage(drifting.deps, started.runId, expertSlotTarget('author'), 'Précisez.'),
      (error: unknown) => isCcrError(error) && error.code === 'AGENT_SESSION_MISMATCH',
    );

    const paths = runPaths(dir, started.runId);
    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 1);
    assert.deepEqual(document.outcomes[0]?.terminal_negative_outcome, {
      kind: 'NATIVE_PROCESS_FAILED',
      error_code: 'AGENT_SESSION_MISMATCH',
      native_detail: {
        code: 'AGENT_SESSION_MISMATCH',
        expert_slot: 'author',
        provider: 'claude',
        expected_session_id: 'claude-1',
        found_session_id: 'claude-derivee',
      },
    });
  } finally {
    await removeTempDir(dir);
  }
});

test("N — un échec d'adaptateur ne reçoit aucun détail : son sac reste au transcript", async () => {
  const dir = await makeTempDir('ccr-outcome-adapter-');
  // L'adaptateur lève avec un sac de diagnostic propre au fournisseur.
  const h = harness(dir, {
    failStart: () =>
      new CcrError('AGENT_EXIT_NONZERO', 'Claude est sorti avec le code 1.', {
        details: { agent: 'claude', command: 'claude -p …', exitCode: 1, stderrTail: 'panic' },
      }),
  });
  try {
    const started = await start(h, dir);

    const paths = runPaths(dir, started.runId);
    const document = await readInvocationOutcomes(paths);
    // Le code, et rien d'autre : CCR n'a pas écrit cette structure et ne la
    // connaît pas. Aucun `native_detail`, aucun sac recopié.
    assert.deepEqual(document.outcomes[0]?.terminal_negative_outcome, {
      kind: 'NATIVE_PROCESS_FAILED',
      error_code: 'AGENT_EXIT_NONZERO',
    });

    // Le sac de diagnostic n'est pas perdu pour autant : il demeure exactement
    // où il appartient, dans l'événement natif.
    const events = await journal(dir, started.runId);
    const only = events.filter((event) => event.type === 'process_failed')[0];
    assert.ok(only !== undefined && 'details' in only);
    assert.deepEqual(only.details, {
      code: 'AGENT_EXIT_NONZERO',
      agent: 'claude',
      command: 'claude -p …',
      exitCode: 1,
      stderrTail: 'panic',
    });
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// E — reprise : le verrou est déjà détenu
// --------------------------------------------------------------------------
//
// `RECOVERY_CONTINUE` partage `initializeNativeSlot` avec `START`, mais son
// corps s'exécute déjà sous `withNativeRunLock`. Le verrou de run n'est pas
// réentrant : une acquisition inconditionnelle rendrait `RUN_ALREADY_LOCKED`,
// et toute reprise deviendrait impossible. Ces deux tests l'éprouvent par le
// comportement — succès **et** échec — plutôt que par la forme du code.

test("E — la reprise n'acquiert aucun verrou imbriqué : elle aboutit", async () => {
  const dir = await makeTempDir('ccr-outcome-recover-ok-');
  try {
    // START échoue sur le premier slot ; la reprise dispose de fournisseurs sains.
    const failing = harness(dir, { failStart: () => new CcrError('AGENT_TIMEOUT', 'délai dépassé') });
    const healthy = harness(dir);

    const started = await start(failing, dir);
    assert.notEqual(started.failure, undefined);

    const recovered = await continueNativeInitialization(healthy.deps, started.runId);
    assert.equal(recovered.failure, undefined, 'aucun RUN_ALREADY_LOCKED : le verrou détenu suffit');
    assert.equal(recovered.positions.length, 2);

    const paths = runPaths(dir, started.runId);
    // Trois engagements : la tentative START échouée, puis les deux slots repris.
    const invocations = await (await openInvocationLedger(paths, started.runId)).readAll();
    assert.deepEqual(
      invocations.map((entry: InvocationDispatchRecord) => entry.trigger_kind),
      ['START', 'RECOVERY_CONTINUE', 'RECOVERY_CONTINUE'],
    );

    // Une seule issue négative : celle de la tentative qui a réellement échoué.
    // Une reprise réussie n'en efface aucune, et n'en fabrique aucune.
    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 1);
    assert.equal(document.outcomes[0]?.invocation_id, invocations[0]?.invocation_id);
  } finally {
    await removeTempDir(dir);
  }
});

test("E — une reprise qui échoue écrit son issue sous le verrou déjà détenu", async () => {
  const dir = await makeTempDir('ccr-outcome-recover-ko-');
  const h = harness(dir, { failStart: () => new CcrError('AGENT_TIMEOUT', 'délai dépassé') });
  try {
    const started = await start(h, dir);
    const recovered = await continueNativeInitialization(h.deps, started.runId);

    // L'échec rendu est celui du fournisseur — jamais un refus de verrou.
    assert.ok(isCcrError(recovered.failure?.error));
    assert.equal((recovered.failure?.error as CcrError).code, 'AGENT_TIMEOUT');

    const paths = runPaths(dir, started.runId);
    const invocations = await (await openInvocationLedger(paths, started.runId)).readAll();
    assert.equal(invocations.length, 2);

    // Deux tentatives, deux issues : la reprise engage une invocation nouvelle,
    // et ne réécrit jamais celle de la tentative précédente (V2.2-IMP-05).
    const document = await readInvocationOutcomes(paths);
    assert.deepEqual(
      document.outcomes.map((record) => record.invocation_id),
      invocations.map((entry: InvocationDispatchRecord) => entry.invocation_id),
    );
    assert.deepEqual(document.outcomes[1]?.terminal_negative_outcome, {
      kind: 'NATIVE_PROCESS_FAILED',
      error_code: 'AGENT_TIMEOUT',
    });
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// F — SEND : deux autorités distinctes
// --------------------------------------------------------------------------

test("F — échec d'un SEND : le `process_failed` demeure, et l'issue lui est corrélée", async () => {
  const dir = await makeTempDir('ccr-outcome-send-');
  try {
    const healthy = harness(dir);
    const started = await start(healthy, dir);
    assert.equal(started.failure, undefined);

    // Le tour humain échoue à la reprise de session.
    const broken = harness(dir, { failResume: () => new CcrError('AGENT_EXIT_NONZERO', 'code 1') });

    await assert.rejects(
      () => sendNativeMessage(broken.deps, started.runId, expertSlotTarget('author'), 'Précisez.'),
      (error: unknown) => isCcrError(error) && error.code === 'AGENT_EXIT_NONZERO',
    );

    const paths = runPaths(dir, started.runId);
    const invocations = await (await openInvocationLedger(paths, started.runId)).readAll();
    const sendDispatch = invocations.find(
      (entry: InvocationDispatchRecord) => entry.trigger_kind === 'SEND',
    );
    assert.notEqual(sendDispatch, undefined);

    // Le transcript natif conserve sa propre représentation de l'échec : la
    // nouvelle source ne la remplace pas.
    const events = await journal(dir, started.runId);
    const failed = events.filter((event) => event.type === 'process_failed');
    assert.equal(failed.length, 1);
    const only = failed[0];
    assert.ok(only !== undefined && 'target_expert_slot_id' in only);
    assert.equal(only.target_expert_slot_id, 'author');

    // Et l'issue durable est rattachée à l'engagement de ce tour, avec son code.
    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 1);
    assert.equal(document.outcomes[0]?.invocation_id, sendDispatch?.invocation_id);
    assert.deepEqual(document.outcomes[0]?.terminal_negative_outcome, {
      kind: 'NATIVE_PROCESS_FAILED',
      error_code: 'AGENT_EXIT_NONZERO',
    });

    // La corrélation vers le prompt reste celle du dispatch : le modèle de
    // lecture joint par elle, et ne conclut rien de l'absence.
    const view = projectInvocationOutcomes({
      invocations,
      outcomes: document.outcomes,
      events,
      controversies: [],
      evidence: [],
      reconciliations: [],
    });
    const projected = view.by_invocation.find(
      (entry) => entry.invocation_id === sendDispatch?.invocation_id,
    );
    assert.equal(projected?.state, 'NEGATIVE_KNOWN');
    assert.equal(view.anomalies.inconsistent.length, 0);
    assert.equal(view.anomalies.orphan_outcomes.length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// A — unicité de l'identifiant d'invocation
// --------------------------------------------------------------------------

test("A — l'engagement START s'écrit sous sérialisation : le journal reste relisible", async () => {
  const dir = await makeTempDir('ccr-outcome-unique-');
  const h = harness(dir);
  try {
    const result = await start(h, dir);
    const paths = runPaths(dir, result.runId);

    // Relire le journal applique le contrôle d'unicité et la stricte
    // croissance : un doublon le rendrait invalide.
    const invocations = await (await openInvocationLedger(paths, result.runId)).readAll();
    assert.equal(invocations.length, 2);
    const ids = invocations.map((entry: InvocationDispatchRecord) => entry.invocation_id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, ['inv_000001', 'inv_000002']);
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// L — état durable contradictoire
// --------------------------------------------------------------------------

function dispatch(invocationId: string, promptEventId?: string): InvocationDispatchRecord {
  return {
    schema_version: 1,
    kind: 'DISPATCH_COMMITTED',
    invocation_id: invocationId,
    run_id: 'CCR-20260831-001',
    identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
    trigger_kind: 'START',
    ...(promptEventId === undefined ? {} : { prompt_event_id: promptEventId }),
    dispatch_committed_at: AT,
  } as InvocationDispatchRecord;
}

function outcome(invocationId: string): InvocationOutcomeRecord {
  return {
    schema_version: 1,
    invocation_id: invocationId,
    recorded_at: AT,
    terminal_negative_outcome: { kind: 'NATIVE_PROCESS_FAILED', error_code: 'AGENT_TIMEOUT' },
  };
}

const NO_SOURCES = { events: [], controversies: [], evidence: [], reconciliations: [] } as const;

test('L — fait négatif ET preuve de succès : INCONSISTENT, sans vainqueur', () => {
  const model = projectInvocationOutcomes({
    ...NO_SOURCES,
    invocations: [dispatch('inv_000001', 'evt_000002')],
    outcomes: [outcome('inv_000001')],
    events: [
      {
        schema_version: 1,
        event_id: 'evt_000003',
        run_id: 'CCR-20260831-001',
        round: 0,
        actor: 'expert',
        type: 'assistant_response',
        expert_slot_id: 'author',
        session_id: 'claude-1',
        content: 'réponse',
        based_on: ['evt_000002'],
        timestamp: AT,
      } as unknown as NativeCcrEvent,
    ],
  });

  const view = model.by_invocation[0];
  assert.equal(view?.state, 'INCONSISTENT');
  // Les deux faits restent lisibles : aucun n'est écarté au profit de l'autre.
  assert.notEqual(view?.negative, undefined);
  assert.deepEqual(view?.success_evidence, ['evt_000003']);
  assert.equal(model.anomalies.inconsistent.length, 1);
});

test('L — absence de fait négatif ne conclut rien par elle-même', () => {
  const model = projectInvocationOutcomes({
    ...NO_SOURCES,
    invocations: [dispatch('inv_000001')],
    outcomes: [],
  });
  assert.equal(model.by_invocation[0]?.state, 'UNKNOWN');
  assert.equal(model.anomalies.inconsistent.length, 0);
});

test('L — fait négatif seul : négatif connu ; preuve de succès seule : préservée', () => {
  const negativeOnly = projectInvocationOutcomes({
    ...NO_SOURCES,
    invocations: [dispatch('inv_000001')],
    outcomes: [outcome('inv_000001')],
  });
  assert.equal(negativeOnly.by_invocation[0]?.state, 'NEGATIVE_KNOWN');

  const successOnly = projectInvocationOutcomes({
    ...NO_SOURCES,
    invocations: [dispatch('inv_000001')],
    outcomes: [],
    reconciliations: [
      {
        entry_id: 'rcn_000001',
        derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000001', inputs: [] },
      } as unknown as Parameters<typeof projectInvocationOutcomes>[0]['reconciliations'][number],
    ],
  });
  assert.equal(successOnly.by_invocation[0]?.state, 'SUCCESS_EVIDENCE');
  assert.deepEqual(successOnly.by_invocation[0]?.success_evidence, ['rcn_000001']);
});

test('une issue orpheline est rendue au diagnostic, jamais levée', () => {
  const model = projectInvocationOutcomes({
    ...NO_SOURCES,
    invocations: [],
    outcomes: [outcome('inv_000009')],
  });
  assert.deepEqual(model.anomalies.orphan_outcomes, [{ invocation_id: 'inv_000009' }]);
  assert.equal(model.by_invocation.length, 0);
});

// --------------------------------------------------------------------------
// M — legacy
// --------------------------------------------------------------------------

test('M — un run sans document d’issues reste lisible, et rien n’est reconstitué', async () => {
  const dir = await makeTempDir('ccr-outcome-legacy-');
  const h = harness(dir);
  try {
    const result = await start(h, dir);
    const paths = runPaths(dir, result.runId);

    // Un START abouti n'écrit aucune issue : il n'y en a aucune à écrire.
    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 0);

    const invocations = await (await openInvocationLedger(paths, result.runId)).readAll();
    const model = projectInvocationOutcomes({
      ...NO_SOURCES,
      invocations,
      outcomes: document.outcomes,
      events: await journal(dir, result.runId),
    });

    // Deux engagements aboutis : la preuve de succès native est corrélée par
    // l'événement de prompt, et aucune issue n'est fabriquée.
    assert.equal(model.by_invocation.length, 2);
    for (const view of model.by_invocation) {
      assert.equal(view.state, 'SUCCESS_EVIDENCE');
      assert.equal(view.negative, undefined);
    }
    assert.equal(model.anomalies.inconsistent.length, 0);
  } finally {
    await removeTempDir(dir);
  }
});
