/**
 * V2.2-IMP-02 — STEP natif gouverné.
 *
 * Premier slice où la gouvernance d'usage observe un appel model-producing
 * réel de CCR. Trois propriétés portent tout le reste.
 *
 *  1. **L'engagement précède l'appel.** Le fake adapter constate, au moment
 *     même de son `resume`, que `DISPATCH_COMMITTED` est déjà écrit. C'est la
 *     preuve directe de l'ordre, et elle ne dépend d'aucun seam de production.
 *  2. **Un échec d'engagement n'appelle personne, et ne ment pas.** Il ferme la
 *     tentative comme un abandon pré-fournisseur, laisse la source réutilisable,
 *     et n'écrit jamais `process_failed` — la panne appartient à CCR.
 *  3. **La controverse prime sur la gouvernance.** Une réponse obtenue reste
 *     persistée même si les deux journaux d'usage tombent en panne.
 *
 * Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { UsageObservation } from '../../src/core/usage.ts';
import type { InvocationDispatchRecord, UsageObservationRecord } from '../../src/core/usage-governance.ts';
import { DEFAULT_NATIVE_BINDINGS, startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings } from '../../src/services/native-start-service.ts';
import { stepNativeRun } from '../../src/services/native-step-service.ts';
import type { NativeStepSeams } from '../../src/services/native-step-service.ts';
import { buildNativeStepRecoveryView } from '../../src/services/native-step-recovery-service.ts';
import { applyNativeLongMutation } from '../../src/services/native-mutations.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openUsageLedger } from '../../src/store/usage-ledger.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import { readStableNativeRunSnapshot, computeNativeRunRevision } from '../../src/store/native-run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

/** Observation fournisseur minimale, de la forme rendue par l'adapter Claude. */
const PROVIDER_USAGE: UsageObservation = {
  tokens: {
    provider: 'claude',
    input_tokens: 11,
    output_tokens: 22,
    cache_creation_input_tokens: 33,
    cache_read_input_tokens: 44,
  },
  model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' },
  provider_reported_cost: { amount: 0.25, currency: 'USD', source: 'PROVIDER_REPORTED' },
};

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface HarnessOptions {
  readonly usage?: UsageObservation;
  readonly elapsedMs?: number;
  readonly onResume?: () => Promise<void> | void;
  readonly failResume?: () => unknown;
  readonly failCreateAdapters?: () => unknown;
  readonly maxTransferBytes?: number;
  readonly answer?: (prompt: string) => string;
}

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  resumeCalls(): number;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: [`${kind}-1`, `${kind}-2`],
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.elapsedMs === undefined ? {} : { elapsedMs: options.elapsedMs }),
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
      ...(options.answer === undefined ? {} : { respond: options.answer }),
      onCall: async (phase) => {
        if (phase === 'resume') await options.onResume?.();
      },
    });

  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
    runsDir,
    adapters,
    resumeCalls: () =>
      adapters.claude.calls.filter((call) => call.phase === 'resume').length +
      adapters.codex.calls.filter((call) => call.phase === 'resume').length,
    deps: {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => {
        const failure = options.failCreateAdapters?.();
        if (failure !== undefined) throw failure;
        return adapters;
      },
      ...(options.maxTransferBytes === undefined ? {} : { maxTransferBytes: options.maxTransferBytes }),
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

async function startedRun(h: Harness, dir: string, bindings?: NativeExpertBindings): Promise<string> {
  const result = await startNativeRun(h.deps, {
    title: 'T',
    cwd: dir,
    prompt: MISSION,
    ...(bindings === undefined ? {} : { bindings }),
    runtimeConfig: nativeRuntime(),
  });
  assert.equal(result.failure, undefined, 'START doit aboutir');
  return result.runId;
}

async function journal(runsDir: string, runId: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

async function ledgers(
  runsDir: string,
  runId: string,
): Promise<{ invocations: InvocationDispatchRecord[]; usage: UsageObservationRecord[] }> {
  const paths = runPaths(runsDir, runId);
  return {
    invocations: await (await openInvocationLedger(paths, runId)).readAll(),
    usage: await (await openUsageLedger(paths, runId)).readAll(),
  };
}


/**
 * Enregistrements du seul déclencheur visé.
 *
 * Depuis `V2.2-IMP-04`, START écrit ses deux engagements avant tout autre :
 * filtrer rend l'assertion plus précise qu'un index, et non plus permissive.
 */
function dispatchesOf(
  records: readonly InvocationDispatchRecord[],
  trigger: string,
): InvocationDispatchRecord[] {
  return records.filter((entry) => entry.trigger_kind === trigger);
}

function usageOf(
  records: readonly UsageObservationRecord[],
  invocationId: string,
): UsageObservationRecord[] {
  return records.filter((entry) => entry.invocation_id === invocationId);
}

async function stateOf(runsDir: string, runId: string): Promise<Record<string, unknown>> {
  const doc = await readPersistedState(runPaths(runsDir, runId));
  if (doc.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return doc.document as unknown as Record<string, unknown>;
}

/** Journal d'invocations dont l'append échoue, sans toucher au disque. */
function brokenInvocationLedger(): NativeStepSeams['openInvocationLedger'] {
  return async () => ({
    readAll: async () => [],
    append: async () => {
      throw new CcrError('JOURNAL_INVALID', 'disque saturé (fixture)');
    },
    lastInvocationId: () => null,
    count: () => 0,
    nextSequence: () => 1,
  });
}

/** Journal d'usage dont l'append échoue, sélectivement. */
function brokenUsageLedger(which: 'ALL' | 'PROVIDER_REPORTED' | 'CCR_MEASURED'): NativeStepSeams['openUsageLedger'] {
  return async (paths, runId, options) => {
    const real = await openUsageLedger(paths, runId, options);
    return {
      ...real,
      append: async (draft, now) => {
        if (which === 'ALL' || draft.provenance === which) {
          throw new CcrError('JOURNAL_INVALID', 'usage indisponible (fixture)');
        }
        return real.append(draft, now);
      },
    };
  };
}

// ==========================================================================
// A. Chemin nominal
// ==========================================================================

test('1–6 · l’engagement précède l’appel, et les deux observations suivent la réponse', async () => {
  const dir = await makeTempDir('ccr-1b-nominal-');
  try {
    const runsDir = `${dir}/runs`;
    let seenAtResume: InvocationDispatchRecord[] = [];
    const h = harness(runsDir, {
      usage: PROVIDER_USAGE,
      elapsedMs: 1500,
      // 1 · preuve directe de l'ordre : au moment même de l'appel, le fait
      // autoritaire doit déjà exister sur disque.
      onResume: async () => {
        seenAtResume = (await ledgers(runsDir, runIdRef)).invocations;
      },
    });
    let runIdRef = '';
    runIdRef = await startedRun(h, dir, { author: 'codex', challenger: 'claude' });

    const result = await stepNativeRun(h.deps, runIdRef);
    const { invocations, usage } = await ledgers(runsDir, runIdRef);

    // 1 · l'adapter a vu l'engagement du transfert, déjà écrit — et les deux de
    // START qui le précèdent, puisque START est gouverné depuis IMP-04.
    assert.equal(seenAtResume.length, 3, 'START (2) + STEP (1) au moment du resume');
    assert.deepEqual(dispatchesOf(seenAtResume, 'START').length, 2);
    assert.equal(dispatchesOf(seenAtResume, 'STEP')[0]?.invocation_id, 'inv_000003');
    assert.equal(dispatchesOf(invocations, 'STEP').length, 1, 'un seul engagement pour un STEP');

    const dispatch = dispatchesOf(invocations, 'STEP')[0] as InvocationDispatchRecord;
    // 2 · identité native, portée par le rôle.
    assert.deepEqual(dispatch.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'challenger',
      provider: 'claude',
    });
    assert.equal(dispatch.trigger_kind, 'STEP');
    assert.equal(dispatch.kind, 'DISPATCH_COMMITTED');

    // 3 · corrélations, toutes connues avant l'appel.
    const events = await journal(runsDir, runIdRef);
    const prompt = events.find((e) => e.type === 'prompt_sent' && e.round === 1);
    assert.equal(dispatch.prompt_event_id, prompt?.event_id);
    assert.equal(dispatch.source_event_id, result.sourceEventId);
    assert.equal(dispatch.round, 1);
    assert.equal(dispatch.session_id, 'claude-1');
    assert.equal(dispatch.dispatch_committed_at, AT);
    assert.equal(dispatch.operation_id, undefined, 'aucune origine HTTP ici');
    assert.equal(result.invocationId, dispatch.invocation_id);

    // 5–6 · deux observations, deux provenances, jamais fusionnées.
    const own = usageOf(usage, dispatch.invocation_id);
    assert.equal(own.length, 2);
    const provider = own.find((entry) => entry.provenance === 'PROVIDER_REPORTED');
    const measured = own.find((entry) => entry.provenance === 'CCR_MEASURED');
    assert.ok(provider !== undefined && measured !== undefined);
    assert.deepEqual(provider.tokens, PROVIDER_USAGE.tokens);
    assert.deepEqual(provider.model, PROVIDER_USAGE.model);
    assert.deepEqual(provider.provider_reported_cost, PROVIDER_USAGE.provider_reported_cost);
    assert.equal(measured.ccr_elapsed_ms, 1500, 'mesure CCR, depuis la paire existante');
    assert.equal(measured.exit_code, 0);
    // 8 · identifiants d'observation strictement croissants, sur tout le run.
    const ids = usage.map((entry) => entry.usage_observation_id);
    assert.deepEqual([...ids].sort(), ids, 'séquence croissante');
    assert.equal(new Set(ids).size, ids.length, 'aucun doublon');
    assert.deepEqual(result.usageGovernanceWarnings, []);

    // Le travail métier est inchangé : la réponse et le transfert sont là.
    assert.equal(events.filter((e) => e.type === 'round_completed').length, 1);
    assert.equal((await stateOf(runsDir, runIdRef))['next_step_source_slot'], 'challenger');
  } finally {
    await removeTempDir(dir);
  }
});

test('4 · same-provider : l’identité est le slot, jamais le moteur', async () => {
  const dir = await makeTempDir('ccr-1b-same-provider-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir);
    const runId = await startedRun(h, dir, { author: 'claude', challenger: 'claude' });

    await stepNativeRun(h.deps, runId);
    const dispatch = dispatchesOf(
      (await ledgers(runsDir, runId)).invocations,
      'STEP',
    )[0] as InvocationDispatchRecord;

    assert.deepEqual(dispatch.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'challenger',
      provider: 'claude',
    });
    // La session est celle du challenger, pas « la session Claude ».
    assert.equal(dispatch.session_id, 'claude-2');
    assert.equal('agent_kind' in dispatch.identity, false);
  } finally {
    await removeTempDir(dir);
  }
});

test('7 · un adapter sans usage fournisseur produit la seule mesure CCR', async () => {
  const dir = await makeTempDir('ccr-1b-no-usage-');
  try {
    const runsDir = `${dir}/runs`;
    // Forme exacte d'une sortie antérieure à V2.2.
    const h = harness(runsDir, { elapsedMs: 400 });
    const runId = await startedRun(h, dir);

    await stepNativeRun(h.deps, runId);
    const { usage } = await ledgers(runsDir, runId);

    const step = dispatchesOf((await ledgers(runsDir, runId)).invocations, 'STEP')[0];
    const own = usageOf(usage, step?.invocation_id ?? '');
    assert.equal(own.length, 1);
    assert.equal(own[0]?.provenance, 'CCR_MEASURED');
    assert.equal(own[0]?.ccr_elapsed_ms, 400);
    assert.equal(own[0]?.tokens, undefined, 'aucun jeton inventé');
    assert.equal(own[0]?.provider_reported_cost, undefined, 'aucun coût inventé');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Rien avant le dispatch
// ==========================================================================

test('9–10 · refus pré-dispatch : aucun engagement, aucun appel', async () => {
  const dir = await makeTempDir('ccr-1b-pre-dispatch-');
  try {
    const runsDir = `${dir}/runs`;

    // 9 · garde-fou de taille : le refus précède l'ouverture du round.
    const blocked = harness(runsDir, { maxTransferBytes: 8 });
    const blockedRun = await startedRun(blocked, dir);
    await expectRejection(
      stepNativeRun(blocked.deps, blockedRun),
      'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
      'transfert refusé',
    );
    const afterBlocked = await ledgers(runsDir, blockedRun);
    assert.deepEqual(dispatchesOf(afterBlocked.invocations, 'STEP'), [], 'aucun engagement de transfert');
    assert.equal(afterBlocked.invocations.length, 2, 'seuls les deux engagements de START subsistent');
    assert.equal(blocked.resumeCalls(), 0);
    assert.equal(
      (await journal(runsDir, blockedRun)).filter((e) => e.type === 'transfer_blocked').length,
      1,
    );

    // 10 · lanceur introuvable : décidé avant l'engagement, donc gratuit.
    const broken = harness(runsDir, {
      failCreateAdapters: () => new CcrError('AGENT_EXECUTABLE_UNRESOLVED', 'aucune CLI (fixture)'),
    });
    const brokenRun = await startedRun(harness(runsDir), dir);
    await expectRejection(
      stepNativeRun(broken.deps, brokenRun),
      'AGENT_EXECUTABLE_UNRESOLVED',
      'adapters non construits',
    );
    const afterBroken = await ledgers(runsDir, brokenRun);
    assert.deepEqual(dispatchesOf(afterBroken.invocations, 'STEP'), [], 'InvocationLedger += 0');
    assert.equal(afterBroken.invocations.length, 2);
    assert.equal(broken.resumeCalls(), 0);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Échec de l'engagement
// ==========================================================================

test('11–15 · un engagement impossible n’appelle personne et ferme honnêtement', async () => {
  const dir = await makeTempDir('ccr-1b-append-fail-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir);
    const runId = await startedRun(h, dir);
    const before = await stateOf(runsDir, runId);

    await expectRejection(
      stepNativeRun(h.deps, runId, { openInvocationLedger: brokenInvocationLedger() }),
      'INVOCATION_LEDGER_WRITE_FAILED',
      'échec de persistance de l’engagement',
    );

    // 11 · aucun fournisseur, aucun fake adapter.
    assert.equal(h.resumeCalls(), 0);

    const events = await journal(runsDir, runId);
    // 12 · marqueur exact, et rien d'autre.
    const aborted = events.filter((e) => e.type === 'transfer_aborted_before_provider');
    assert.equal(aborted.length, 1);
    const marker = aborted[0] as unknown as Record<string, unknown>;
    assert.equal(marker['reason'], 'PRE_PROVIDER_ABORTED');
    assert.equal(marker['actor'], 'system');
    assert.equal(marker['source_slot_id'], 'author');
    assert.equal(marker['target_slot_id'], 'challenger');
    assert.equal('response_event_id' in marker, false);
    assert.equal(
      events.filter((e) => e.type === 'process_failed').length,
      0,
      'la panne appartient à CCR, jamais à l’expert',
    );
    assert.equal(events.filter((e) => e.type === 'assistant_response' && e.round === 1).length, 0);
    assert.equal(events.filter((e) => e.type === 'round_completed').length, 0);

    // 13–14 · état fermé, source intacte.
    const after = await stateOf(runsDir, runId);
    assert.equal(after['state'], 'PAUSED');
    assert.equal(after['control'], 'HUMAN');
    assert.equal(after['pending_operation'], null);
    assert.equal(after['active_expert_slot'], null);
    assert.equal(after['round'], before['round'], 'le round n’avance pas');
    assert.equal(after['next_step_source_slot'], before['next_step_source_slot'], 'curseur intact');

    // 15 · la tentative est close : plus rien à reprendre.
    const snapshot = await readStableNativeRunSnapshot(runsDir, runId);
    const recovery = await buildNativeStepRecoveryView(
      snapshot.paths,
      runId,
      snapshot.manifest,
      snapshot.state,
      snapshot.events,
    );
    assert.equal(recovery.status, 'NONE');

    // Le journal d'invocations ne conserve aucun enregistrement partiel.
    assert.deepEqual(dispatchesOf((await ledgers(runsDir, runId)).invocations, 'STEP'), []);
  } finally {
    await removeTempDir(dir);
  }
});

test('16 · interrompu pendant la fermeture, le marqueur reste finalisable localement', async () => {
  const dir = await makeTempDir('ccr-1b-marker-only-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir);
    const runId = await startedRun(h, dir);

    await expectRejection(
      stepNativeRun(h.deps, runId, {
        openInvocationLedger: brokenInvocationLedger(),
        // Arrêt simulé entre le marqueur et son commit d'état.
        afterPreProviderAbortJournaled: () => {
          throw new CcrError('STATE_INVALID', 'arrêt simulé (fixture)');
        },
      }),
      'INVOCATION_LEDGER_WRITE_FAILED',
      'la cause première est préservée',
    );

    const snapshot = await readStableNativeRunSnapshot(runsDir, runId);
    const recovery = await buildNativeStepRecoveryView(
      snapshot.paths,
      runId,
      snapshot.manifest,
      snapshot.state,
      snapshot.events,
    );
    assert.equal(recovery.status, 'RESOLUTION_NEEDS_COMMIT');
    assert.equal(recovery.canFinalizeWithoutProvider, true, 'aucun fournisseur nécessaire');
    assert.equal(h.resumeCalls(), 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('17 · un échec fournisseur après engagement conserve l’invocation', async () => {
  const dir = await makeTempDir('ccr-1b-provider-fail-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, {
      failResume: () => new CcrError('AGENT_TIMEOUT', 'délai dépassé (fixture)'),
    });
    const runId = await startedRun(h, dir);

    await expectRejection(stepNativeRun(h.deps, runId), 'AGENT_TIMEOUT', 'échec fournisseur');

    // L'engagement reste : CCR l'avait pris, et l'exécution a échoué.
    const { invocations, usage } = await ledgers(runsDir, runId);
    const step = dispatchesOf(invocations, 'STEP')[0];
    assert.ok(step !== undefined, 'l’engagement du transfert est conservé');
    assert.equal(usageOf(usage, step.invocation_id).length, 0, 'aucun jeton inventé');

    // Le comportement V2.1 est intact.
    const events = await journal(runsDir, runId);
    assert.equal(events.filter((e) => e.type === 'process_failed').length, 1);
    assert.equal((await stateOf(runsDir, runId))['state'], 'PAUSED');
  } finally {
    await removeTempDir(dir);
  }
});

test('session · un tour refusé avant `assistant_response` n’écrit aucun usage', async () => {
  const dir = await makeTempDir('ccr-1b-mismatch-');
  try {
    const runsDir = `${dir}/runs`;
    // La dérive est armée sur le moteur qui porte la CIBLE du STEP #1 — le
    // CHALLENGER. Armée ailleurs, aucune dérive ne se produirait, et le refus
    // attendu n'aurait jamais lieu.
    const targetProvider = DEFAULT_NATIVE_BINDINGS.challenger;
    const build = (kind: 'claude' | 'codex'): FakeAdapter =>
      createFakeAdapter({
        kind,
        startSessionIds: [`${kind}-1`, `${kind}-2`],
        ...(kind === targetProvider
          ? { resumeSessionId: `${kind}-derive`, usage: PROVIDER_USAGE }
          : {}),
      });
    const adapters = { claude: build('claude'), codex: build('codex') };
    const deps: RunServiceDeps = {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => adapters,
    };
    const started = await startNativeRun(deps, {
      title: 'T',
      cwd: dir,
      prompt: MISSION,
      runtimeConfig: nativeRuntime(),
    });

    await expectRejection(
      stepNativeRun(deps, started.runId),
      'AGENT_SESSION_MISMATCH',
      'la session a dérivé',
    );

    const { invocations, usage } = await ledgers(runsDir, started.runId);
    const step = dispatchesOf(invocations, 'STEP')[0];
    assert.ok(step !== undefined, 'l’engagement reste autoritaire');
    // Limite assumée de 1B : une observation fournisseur réelle est perdue
    // plutôt que rattachée à un tour que le contrat V2.1 refuse.
    assert.deepEqual(usageOf(usage, step.invocation_id), []);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. La gouvernance ne met jamais la controverse en péril
// ==========================================================================

for (const [label, which, expected] of [
  ['18 · observation fournisseur', 'PROVIDER_REPORTED', ['CCR_MEASURED']],
  ['19 · mesure CCR', 'CCR_MEASURED', ['PROVIDER_REPORTED']],
  ['20 · les deux', 'ALL', []],
] as const) {
  test(`${label} en échec : la réponse et le transfert survivent`, async () => {
    const dir = await makeTempDir('ccr-1b-usage-fail-');
    try {
      const runsDir = `${dir}/runs`;
      const h = harness(runsDir, { usage: PROVIDER_USAGE, elapsedMs: 900 });
      const runId = await startedRun(h, dir);

      const result = await stepNativeRun(h.deps, runId, { openUsageLedger: brokenUsageLedger(which) });

      // La controverse est intacte : réponse durable, transfert commité.
      const events = await journal(runsDir, runId);
      assert.equal(events.filter((e) => e.type === 'assistant_response' && e.round === 1).length, 1);
      assert.equal(events.filter((e) => e.type === 'round_completed').length, 1);
      assert.equal(events.filter((e) => e.type === 'process_failed').length, 0);
      const state = await stateOf(runsDir, runId);
      assert.equal(state['next_step_source_slot'], 'challenger');
      assert.equal(state['pending_operation'], null);

      // 20 · ce qui a pu être écrit est conservé, sans rollback.
      const { invocations, usage } = await ledgers(runsDir, runId);
      const step = dispatchesOf(invocations, 'STEP')[0] as InvocationDispatchRecord;
      assert.deepEqual(usageOf(usage, step.invocation_id).map((entry) => entry.provenance), expected);

      // L'échec est visible, structuré, et sans matière sensible.
      assert.equal(result.usageGovernanceWarnings.length, which === 'ALL' ? 2 : 1);
      for (const warning of result.usageGovernanceWarnings) {
        assert.equal(warning.invocation_id, step.invocation_id);
        assert.equal(warning.error_code, 'JOURNAL_INVALID');
        const serialized = JSON.stringify(warning);
        for (const forbidden of ['prompt', 'response', 'stdout', 'Mission']) {
          assert.equal(serialized.includes(forbidden), false, `diagnostic sans ${forbidden}`);
        }
      }
    } finally {
      await removeTempDir(dir);
    }
  });
}

// ==========================================================================
// E. Corrélation, révision, planificateur
// ==========================================================================

test('21–22 · `operation_id` absent en CLI, présent depuis l’application', async () => {
  const dir = await makeTempDir('ccr-1b-correlation-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir);
    const cliRun = await startedRun(h, dir);
    await stepNativeRun(h.deps, cliRun);
    assert.equal(
      dispatchesOf((await ledgers(runsDir, cliRun)).invocations, 'STEP')[0]?.operation_id,
      undefined,
      'une invocation CLI n’a pas d’identifiant d’opération',
    );

    // 22 · même service, corrélation fournie par la couche application.
    const httpRun = await startedRun(h, dir);
    const snapshot = await readStableNativeRunSnapshot(runsDir, httpRun);
    await applyNativeLongMutation(
      { runService: h.deps, manager: createLongOperationManager(), operationId: 'op_x' },
      { runId: httpRun, action: 'STEP', expectedRevision: snapshot.revision },
    );
    assert.equal(
      dispatchesOf((await ledgers(runsDir, httpRun)).invocations, 'STEP')[0]?.operation_id,
      'op_x',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('23–24 · les journaux restent hors révision, et le planificateur les ignore', async () => {
  const dir = await makeTempDir('ccr-1b-revision-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, { usage: PROVIDER_USAGE });
    const runId = await startedRun(h, dir);
    await stepNativeRun(h.deps, runId);

    // 23 · la révision se recalcule des trois seules sources canoniques.
    const snapshot = await readStableNativeRunSnapshot(runsDir, runId);
    assert.equal(
      snapshot.revision,
      computeNativeRunRevision(snapshot.manifest, snapshot.state, snapshot.events),
    );
    const { invocations, usage } = await ledgers(runsDir, runId);
    assert.ok(invocations.length > 0 && usage.length > 0, 'les journaux sont bien remplis');

    // 24 · le planificateur ne connaît structurellement pas les journaux.
    const planner = await readFile(
      new URL('../../src/services/native-step-planner.ts', import.meta.url),
      'utf8',
    );
    for (const forbidden of ['invocation-ledger', 'usage-ledger', 'usage-governance', 'invocations.jsonl']) {
      assert.equal(planner.includes(forbidden), false, `le planificateur ignore ${forbidden}`);
    }
  } finally {
    await removeTempDir(dir);
  }
});
