/**
 * V2.2-IMP-03 — SEND natif gouverné.
 *
 * Mêmes trois propriétés que le transfert, sur un chemin qui n'est pas un
 * transfert : un envoi n'a ni round consommé, ni source, ni curseur à avancer.
 *
 *  1. **L'engagement précède l'appel** — constaté par le fake adapter lui-même.
 *  2. **Un engagement impossible n'appelle personne**, et se clôt avec le fait
 *     honnête que 2B-R avait déjà défini.
 *  3. **La controverse prime sur la gouvernance** : une réponse obtenue reste
 *     persistée, et l'envoi se finalise, même si les journaux d'usage tombent.
 *
 * Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { UsageObservation } from '../../src/core/usage.ts';
import type { InvocationDispatchRecord, UsageObservationRecord } from '../../src/core/usage-governance.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings } from '../../src/services/native-start-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import type { NativeSendSeams } from '../../src/services/native-send-service.ts';
import { buildNativeSendRecoveryView } from '../../src/services/native-send-recovery-service.ts';
import { planNativeStepForRun } from '../../src/services/native-step-planner.ts';
import { expertSlotTarget, providerAliasTarget } from '../../src/services/native-target-resolver.ts';
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
const MESSAGE = 'Précisez le coût de report.';

const PROVIDER_USAGE: UsageObservation = {
  tokens: {
    provider: 'claude',
    input_tokens: 7,
    output_tokens: 9,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5,
  },
  model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' },
  provider_reported_cost: { amount: 0.03, currency: 'USD', source: 'PROVIDER_REPORTED' },
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
  readonly resumeSessionId?: string;
}

interface Harness {
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
      ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
      onCall: async (phase) => {
        if (phase === 'resume') await options.onResume?.();
      },
    });

  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
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

function brokenInvocationLedger(): NativeSendSeams['openInvocationLedger'] {
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

function brokenUsageLedger(which: 'ALL' | 'PROVIDER_REPORTED' | 'CCR_MEASURED'): NativeSendSeams['openUsageLedger'] {
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

test('1–6 · un envoi gouverné : engagement d’abord, observations ensuite', async () => {
  const dir = await makeTempDir('ccr-1c-nominal-');
  try {
    const runsDir = `${dir}/runs`;
    let seenAtResume: InvocationDispatchRecord[] = [];
    let runIdRef = '';
    const h = harness(runsDir, {
      usage: PROVIDER_USAGE,
      elapsedMs: 250,
      onResume: async () => {
        seenAtResume = (await ledgers(runsDir, runIdRef)).invocations;
      },
    });
    // Same-provider : l'identité doit rester le slot, jamais le moteur.
    runIdRef = await startedRun(h, dir, { author: 'claude', challenger: 'claude' });
    const before = await stateOf(runsDir, runIdRef);

    const result = await sendNativeMessage(h.deps, runIdRef, expertSlotTarget('challenger'), MESSAGE);
    const { invocations, usage } = await ledgers(runsDir, runIdRef);

    // 1 · l'engagement de l'envoi existait déjà au moment de l'appel, après les
    // deux de START — gouverné depuis IMP-04.
    assert.equal(seenAtResume.length, 3);
    assert.equal(dispatchesOf(seenAtResume, 'START').length, 2);
    assert.equal(dispatchesOf(invocations, 'SEND').length, 1, 'un seul engagement pour un envoi');

    const dispatch = dispatchesOf(invocations, 'SEND')[0] as InvocationDispatchRecord;
    // 2 · déclencheur exact.
    assert.equal(dispatch.trigger_kind, 'SEND');
    // 3 · 6 · cible exacte, slot-first, session du challenger.
    assert.deepEqual(dispatch.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'challenger',
      provider: 'claude',
    });
    assert.equal(dispatch.session_id, 'claude-2');
    // 4 · la corrélation est le message humain lui-même.
    assert.equal(dispatch.prompt_event_id, result.promptEventId);
    // 5 · un envoi n'a ni round consommé ni source : rien n'est fabriqué.
    assert.equal(dispatch.round, undefined);
    assert.equal(dispatch.source_event_id, undefined);
    assert.equal(result.invocationId, dispatch.invocation_id);

    // 15–16 · les deux observations, jamais fusionnées.
    const own = usageOf(usage, dispatch.invocation_id);
    assert.equal(own.length, 2);
    const provider = own.find((entry) => entry.provenance === 'PROVIDER_REPORTED');
    const measured = own.find((entry) => entry.provenance === 'CCR_MEASURED');
    assert.deepEqual(provider?.tokens, PROVIDER_USAGE.tokens);
    assert.deepEqual(provider?.provider_reported_cost, PROVIDER_USAGE.provider_reported_cost);
    assert.equal(measured?.ccr_elapsed_ms, 250);
    assert.equal(measured?.exit_code, 0);
    assert.deepEqual(result.usageGovernanceWarnings, []);

    // 9 · 23 · le métier est intact : round et curseur d'un envoi ne bougent pas.
    const after = await stateOf(runsDir, runIdRef);
    assert.equal(after['round'], before['round']);
    assert.equal(after['next_step_source_slot'], before['next_step_source_slot']);
    assert.equal(after['pending_operation'], null);
    const events = await journal(runsDir, runIdRef);
    assert.equal(events.filter((e) => e.type === 'human_message').length, 1);
    assert.equal(events.filter((e) => e.type === 'round_started').length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('24 · la réponse d’un envoi conserve son éligibilité au transfert', async () => {
  const dir = await makeTempDir('ccr-1c-step-eligibility-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, { usage: PROVIDER_USAGE });
    const runId = await startedRun(h, dir, { author: 'codex', challenger: 'claude' });

    // Le curseur attend `author` : un envoi vers lui produit une réponse qui
    // reste la source du prochain transfert.
    await sendNativeMessage(h.deps, runId, expertSlotTarget('author'), MESSAGE);

    const plan = await planNativeStepForRun(h.deps, runId);
    assert.equal(plan.kind, 'READY', 'le transfert reste possible');
    if (plan.kind !== 'READY') return;
    assert.equal(plan.sourceSlot, 'author');
    const events = await journal(runsDir, runId);
    const lastAuthor = [...events]
      .reverse()
      .find((e) => e.type === 'assistant_response' && (e as { expert_slot_id?: string }).expert_slot_id === 'author');
    assert.equal(plan.sourceEventId, lastAuthor?.event_id, 'la réponse de l’envoi est la source');
  } finally {
    await removeTempDir(dir);
  }
});

test('17 · un adapter sans usage fournisseur produit la seule mesure CCR', async () => {
  const dir = await makeTempDir('ccr-1c-no-usage-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, { elapsedMs: 120 });
    const runId = await startedRun(h, dir);

    await sendNativeMessage(h.deps, runId, expertSlotTarget('author'), MESSAGE);
    const { usage } = await ledgers(runsDir, runId);

    const send = dispatchesOf((await ledgers(runsDir, runId)).invocations, 'SEND')[0];
    const own = usageOf(usage, send?.invocation_id ?? '');
    assert.equal(own.length, 1);
    assert.equal(own[0]?.provenance, 'CCR_MEASURED');
    assert.equal(own[0]?.ccr_elapsed_ms, 120);
    assert.equal(own[0]?.tokens, undefined, 'aucun jeton inventé');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Rien avant le dispatch
// ==========================================================================

test('7–8 · alias ambigu et lanceur introuvable ne consomment aucune invocation', async () => {
  const dir = await makeTempDir('ccr-1c-pre-dispatch-');
  try {
    const runsDir = `${dir}/runs`;

    // 7 · same-provider : l'alias `claude` ne désigne personne. La résolution
    // a lieu avant le moindre événement, donc avant tout engagement.
    const alias = harness(runsDir);
    const aliasRun = await startedRun(alias, dir, { author: 'claude', challenger: 'claude' });
    await expectRejection(
      sendNativeMessage(alias.deps, aliasRun, providerAliasTarget('claude'), MESSAGE),
      'AMBIGUOUS_PROVIDER_ALIAS',
      'alias ambigu',
    );
    const afterAlias = await ledgers(runsDir, aliasRun);
    assert.deepEqual(dispatchesOf(afterAlias.invocations, 'SEND'), [], 'aucun engagement d’envoi');
    assert.equal(afterAlias.invocations.length, 2, 'seuls les deux engagements de START subsistent');
    assert.equal(alias.resumeCalls(), 0);
    assert.equal(
      (await journal(runsDir, aliasRun)).filter((e) => e.type === 'human_message').length,
      0,
      'aucun message n’a même été journalisé',
    );

    // 8 · lanceur introuvable : décidé avant l'engagement.
    const brokenRun = await startedRun(harness(runsDir), dir);
    const broken = harness(runsDir, {
      failCreateAdapters: () => new CcrError('AGENT_EXECUTABLE_UNRESOLVED', 'aucune CLI (fixture)'),
    });
    await expectRejection(
      sendNativeMessage(broken.deps, brokenRun, expertSlotTarget('author'), MESSAGE),
      'AGENT_EXECUTABLE_UNRESOLVED',
      'adapters non construits',
    );
    const afterBroken = await ledgers(runsDir, brokenRun);
    assert.deepEqual(dispatchesOf(afterBroken.invocations, 'SEND'), []);
    assert.equal(afterBroken.invocations.length, 2);
    assert.equal(broken.resumeCalls(), 0);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Échec de l'engagement
// ==========================================================================

test('9–12 · un engagement impossible n’appelle personne et clôt l’envoi', async () => {
  const dir = await makeTempDir('ccr-1c-append-fail-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir);
    const runId = await startedRun(h, dir);
    const before = await stateOf(runsDir, runId);

    await expectRejection(
      sendNativeMessage(h.deps, runId, expertSlotTarget('author'), MESSAGE, {
        openInvocationLedger: brokenInvocationLedger(),
      }),
      'INVOCATION_LEDGER_WRITE_FAILED',
      'échec de persistance de l’engagement',
    );

    // 9 · aucun fournisseur.
    assert.equal(h.resumeCalls(), 0);

    const events = await journal(runsDir, runId);
    // 10 · le marqueur exact de 2B-R, et rien d'autre.
    const aborted = events.filter((e) => e.type === 'send_aborted_before_provider');
    assert.equal(aborted.length, 1);
    const marker = aborted[0] as unknown as Record<string, unknown>;
    assert.equal(marker['reason'], 'PRE_PROVIDER_ABORTED');
    assert.equal(marker['target_expert_slot_id'], 'author');
    assert.equal('response_event_id' in marker, false);
    assert.equal('session_id' in marker, false);
    assert.equal(
      events.filter((e) => e.type === 'process_failed').length,
      0,
      'la panne appartient à CCR, jamais à l’expert',
    );
    assert.equal(events.filter((e) => e.type === 'assistant_response' && e.round === 0).length, 2,
      'seules les deux réponses initiales subsistent');

    // 11 · finalisation canonique, obtenue de la primitive de 2B-R.
    const after = await stateOf(runsDir, runId);
    assert.equal(after['control'], 'HUMAN');
    assert.equal(after['pending_operation'], null);
    assert.equal(after['active_expert_slot'], null);
    assert.equal(after['round'], before['round'], 'un envoi n’a jamais de round');
    assert.equal(after['next_step_source_slot'], before['next_step_source_slot']);

    // 12 · la tentative est close : plus rien à reprendre.
    const snapshot = await readStableNativeRunSnapshot(runsDir, runId);
    const recovery = buildNativeSendRecoveryView(runId, snapshot.manifest, snapshot.state, snapshot.events);
    assert.equal(recovery.status, 'NONE');
    assert.deepEqual(dispatchesOf((await ledgers(runsDir, runId)).invocations, 'SEND'), []);
  } finally {
    await removeTempDir(dir);
  }
});

test('13 · interrompu pendant la fermeture, le marqueur reste finalisable localement', async () => {
  const dir = await makeTempDir('ccr-1c-marker-only-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir);
    const runId = await startedRun(h, dir);

    await expectRejection(
      sendNativeMessage(h.deps, runId, expertSlotTarget('author'), MESSAGE, {
        openInvocationLedger: brokenInvocationLedger(),
        afterPreProviderAbortJournaled: () => {
          throw new CcrError('STATE_INVALID', 'arrêt simulé (fixture)');
        },
      }),
      'INVOCATION_LEDGER_WRITE_FAILED',
      'la cause première est préservée',
    );

    const snapshot = await readStableNativeRunSnapshot(runsDir, runId);
    const recovery = buildNativeSendRecoveryView(runId, snapshot.manifest, snapshot.state, snapshot.events);
    assert.equal(recovery.status, 'RESOLUTION_NEEDS_COMMIT');
    assert.equal(recovery.canFinalizeWithoutProvider, true);
    assert.equal(h.resumeCalls(), 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('14 · un échec fournisseur après engagement conserve l’invocation', async () => {
  const dir = await makeTempDir('ccr-1c-provider-fail-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, {
      failResume: () => new CcrError('AGENT_TIMEOUT', 'délai dépassé (fixture)'),
    });
    const runId = await startedRun(h, dir);

    await expectRejection(
      sendNativeMessage(h.deps, runId, expertSlotTarget('author'), MESSAGE),
      'AGENT_TIMEOUT',
      'échec fournisseur',
    );

    const { invocations, usage } = await ledgers(runsDir, runId);
    const send = dispatchesOf(invocations, 'SEND')[0];
    assert.ok(send !== undefined, 'l’engagement est conservé');
    assert.equal(usageOf(usage, send.invocation_id).length, 0, 'aucun usage fictif');
    assert.equal(
      (await journal(runsDir, runId)).filter((e) => e.type === 'process_failed').length,
      1,
      'la sémantique V2.1 de l’échec est intacte',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('22 · un tour refusé avant `assistant_response` n’écrit aucun usage', async () => {
  const dir = await makeTempDir('ccr-1c-mismatch-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, { usage: PROVIDER_USAGE, resumeSessionId: 'derive' });
    const runId = await startedRun(h, dir);

    await expectRejection(
      sendNativeMessage(h.deps, runId, expertSlotTarget('author'), MESSAGE),
      'AGENT_SESSION_MISMATCH',
      'la session a dérivé',
    );

    const { invocations, usage } = await ledgers(runsDir, runId);
    const send = dispatchesOf(invocations, 'SEND')[0];
    assert.ok(send !== undefined, 'l’engagement reste autoritaire');
    // Limite assumée, identique à celle de STEP : une observation fournisseur
    // réelle est perdue plutôt que rattachée à un tour que V2.1 refuse.
    assert.deepEqual(usageOf(usage, send.invocation_id), []);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. La gouvernance ne met jamais l'envoi en péril
// ==========================================================================

for (const [label, which, expected] of [
  ['18 · observation fournisseur', 'PROVIDER_REPORTED', ['CCR_MEASURED']],
  ['19 · mesure CCR', 'CCR_MEASURED', ['PROVIDER_REPORTED']],
  ['20 · les deux', 'ALL', []],
] as const) {
  test(`${label} en échec : la réponse et la finalisation survivent`, async () => {
    const dir = await makeTempDir('ccr-1c-usage-fail-');
    try {
      const runsDir = `${dir}/runs`;
      const h = harness(runsDir, { usage: PROVIDER_USAGE, elapsedMs: 300 });
      const runId = await startedRun(h, dir);

      const result = await sendNativeMessage(
        h.deps,
        runId,
        expertSlotTarget('author'),
        MESSAGE,
        { openUsageLedger: brokenUsageLedger(which) },
      );

      const events = await journal(runsDir, runId);
      assert.equal(events.filter((e) => e.type === 'human_message').length, 1);
      assert.ok(result.responseEventId.length > 0, 'la réponse est journalisée');
      assert.equal(events.filter((e) => e.type === 'process_failed').length, 0);
      const state = await stateOf(runsDir, runId);
      assert.equal(state['pending_operation'], null, 'l’envoi est bien finalisé');

      // 20 · ce qui a pu être écrit est conservé, sans rollback.
      const { invocations, usage } = await ledgers(runsDir, runId);
      const send = dispatchesOf(invocations, 'SEND')[0] as InvocationDispatchRecord;
      assert.deepEqual(usageOf(usage, send.invocation_id).map((entry) => entry.provenance), expected);

      // 21 · diagnostic structuré, sans matière sensible.
      assert.equal(result.usageGovernanceWarnings.length, which === 'ALL' ? 2 : 1);
      for (const warning of result.usageGovernanceWarnings) {
        assert.equal(warning.invocation_id, send.invocation_id);
        assert.equal(warning.error_code, 'JOURNAL_INVALID');
        const serialized = JSON.stringify(warning);
        for (const forbidden of ['prompt', 'response', 'stdout', 'Précisez']) {
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

test('25–28 · corrélation optionnelle, révision et planificateur indépendants', async () => {
  const dir = await makeTempDir('ccr-1c-correlation-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, { usage: PROVIDER_USAGE });

    // 25 · CLI : aucun identifiant d'opération.
    const cliRun = await startedRun(h, dir);
    await sendNativeMessage(h.deps, cliRun, expertSlotTarget('author'), MESSAGE);
    assert.equal(
      dispatchesOf((await ledgers(runsDir, cliRun)).invocations, 'SEND')[0]?.operation_id,
      undefined,
    );

    // 26 · application : la corrélation voyage jusqu'au journal.
    const httpRun = await startedRun(h, dir);
    const snapshot = await readStableNativeRunSnapshot(runsDir, httpRun);
    await applyNativeLongMutation(
      { runService: h.deps, manager: createLongOperationManager(), operationId: 'op_send' },
      {
        runId: httpRun,
        action: 'SEND',
        expectedRevision: snapshot.revision,
        ref: expertSlotTarget('author'),
        content: MESSAGE,
      },
    );
    assert.equal(
      dispatchesOf((await ledgers(runsDir, httpRun)).invocations, 'SEND')[0]?.operation_id,
      'op_send',
    );

    // 27 · la révision ne dépend que des trois sources canoniques.
    const after = await readStableNativeRunSnapshot(runsDir, cliRun);
    assert.equal(after.revision, computeNativeRunRevision(after.manifest, after.state, after.events));
    const { invocations, usage } = await ledgers(runsDir, cliRun);
    assert.ok(invocations.length > 0 && usage.length > 0);

    // 28 · le planificateur STEP ignore structurellement les journaux.
    const planner = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../src/services/native-step-planner.ts', import.meta.url), 'utf8'),
    );
    for (const forbidden of ['invocation-ledger', 'usage-ledger', 'usage-governance']) {
      assert.equal(planner.includes(forbidden), false, `le planificateur ignore ${forbidden}`);
    }
  } finally {
    await removeTempDir(dir);
  }
});
