/**
 * V2.2-IMP-05 — reprise d'initialisation gouvernée.
 *
 * Une reprise n'est pas la poursuite d'un ancien appel : c'est une **nouvelle
 * tentative**, décidée par un humain. Trois propriétés en découlent.
 *
 *  1. **Identité neuve.** Chaque slot repris reçoit son propre `invocation_id`
 *     et un déclencheur `RECOVERY_CONTINUE`. L'enregistrement `START` antérieur
 *     n'est ni modifié, ni recompté, ni requalifié.
 *  2. **Prompt frais.** Le dispatch se rattache à l'événement de la nouvelle
 *     tentative, jamais à un `prompt_sent` orphelin laissé par l'ancienne.
 *  3. **Ce qui est local le reste.** Une reprise sans slot manquant n'écrit
 *     aucun engagement et n'appelle personne.
 *
 * Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunManifest, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { RunState } from '../../src/core/state.ts';
import type { UsageObservation } from '../../src/core/usage.ts';
import type { InvocationDispatchRecord, UsageObservationRecord } from '../../src/core/usage-governance.ts';
import {
  buildNativeInitializationView,
  continueNativeInitialization,
} from '../../src/services/native-recovery-service.ts';
import type { ContinueNativeInitializationInput } from '../../src/services/native-recovery-service.ts';
import { applyNativeRecoveryMutation } from '../../src/services/native-recovery-mutations.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openUsageLedger } from '../../src/store/usage-ledger.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import {
  buildInitialNativeState,
  persistNativeStateUpdate,
  readPersistedManifest,
  writeNativeManifest,
  writeNativeState,
} from '../../src/store/native-store.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-555';
const AT = '2026-08-11T00:00:00.000Z';
const PROMPT = 'Mission initiale : évaluer la refonte.';

const PROVIDER_USAGE: UsageObservation = {
  tokens: {
    provider: 'claude',
    input_tokens: 5,
    output_tokens: 6,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' },
  provider_reported_cost: { amount: 0.02, currency: 'USD', source: 'PROVIDER_REPORTED' },
};

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

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

interface SlotWindow {
  readonly prompt?: boolean;
  readonly response?: string;
  readonly bound?: string;
  readonly created?: string;
}

interface WindowSpec {
  readonly bindings?: { readonly author: ProviderKind; readonly challenger: ProviderKind };
  readonly author: SlotWindow;
  readonly challenger: SlotWindow;
  readonly state?: RunState;
  readonly pendingSlot?: ExpertSlotId;
  /**
   * Enregistrement `START` historique, écrit par le vrai store.
   *
   * Il représente l'ancienne tentative : celle que la reprise ne doit ni
   * modifier, ni réutiliser, ni recompter.
   */
  readonly historicalStart?: readonly ExpertSlotId[];
}

async function materialize(runsDir: string, spec: WindowSpec): Promise<void> {
  const bindings = spec.bindings ?? { author: 'codex', challenger: 'claude' };
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });

  let manifest: NativeRunManifest = {
    schema_version: 2,
    run_id: RUN_ID,
    title: 'T',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: bindings.author, session_id: null },
      challenger: { provider: bindings.challenger, session_id: null },
    },
    runtime_config: nativeRuntime(),
  };
  await writeNativeManifest(paths, manifest);
  let state = buildInitialNativeState(RUN_ID, 'READY', new Date(AT));
  await writeNativeState(paths, state);

  const ref = { manifest };
  const events = await openNativeEventStore(paths, () => ref.manifest);
  await events.append({ round: 0, actor: 'system', type: 'run_created', content: 'T', timestamp: AT });

  const prompts: Partial<Record<ExpertSlotId, string>> = {};
  let promptEventId: string | null = null;
  for (const slot of ['author', 'challenger'] as const) {
    const window = spec[slot];
    if (window.prompt !== true) continue;
    const prompt = await events.append({
      round: 0,
      actor: 'human',
      type: 'prompt_sent',
      target_expert_slot_id: slot,
      content: PROMPT,
      timestamp: AT,
    });
    prompts[slot] = prompt.event_id;
    promptEventId = prompt.event_id;

    if (window.response !== undefined) {
      await events.append({
        round: 0,
        actor: 'expert',
        type: 'assistant_response',
        expert_slot_id: slot,
        session_id: window.response,
        content: `réponse ${slot}`,
        based_on: [prompt.event_id],
        timestamp: AT,
      });
    }
    if (window.bound !== undefined) {
      manifest = {
        ...manifest,
        experts: { ...manifest.experts, [slot]: { ...manifest.experts[slot], session_id: window.bound } },
      };
      ref.manifest = manifest;
      await writeNativeManifest(paths, manifest);
    }
    if (window.created !== undefined) {
      await events.append({
        round: 0,
        actor: 'system',
        type: 'session_created',
        expert_slot_id: slot,
        session_id: window.created,
        timestamp: AT,
      });
    }
  }

  // L'ancienne tentative, telle que START l'aurait écrite.
  if (spec.historicalStart !== undefined) {
    const ledger = await openInvocationLedger(paths, RUN_ID);
    for (const slot of spec.historicalStart) {
      await ledger.append(
        {
          identity: {
            generation: 'NATIVE_V21_EXECUTION',
            expert_slot: slot,
            provider: manifest.experts[slot].provider,
          },
          trigger_kind: 'START',
          ...(prompts[slot] === undefined ? {} : { prompt_event_id: prompts[slot] }),
        },
        new Date(AT),
      );
    }
  }

  const target = spec.state ?? 'FAILED_INITIALIZATION';
  state = await persistNativeStateUpdate(paths, state, { state: 'RUNNING' }, new Date(AT));
  state = await persistNativeStateUpdate(
    paths,
    state,
    {
      state: target,
      ...(spec.pendingSlot === undefined
        ? {}
        : {
            pendingOperation: {
              kind: 'initialization' as const,
              expert_slot: spec.pendingSlot,
              round: 0,
              prompt_event_id: promptEventId,
              session_id: null,
              return_state: 'FAILED_INITIALIZATION' as const,
              return_control: 'AUTOMATION' as const,
              started_at: AT,
            },
          }),
    },
    new Date(AT),
  );
}

interface Harness {
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  startCalls(): number;
}

interface HarnessOptions {
  readonly usage?: UsageObservation;
  readonly elapsedMs?: number;
  readonly onStart?: () => Promise<void> | void;
  readonly failStart?: () => unknown;
  readonly failCreateAdapters?: () => unknown;
  readonly sameSession?: string;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds:
        options.sameSession === undefined
          ? [`${kind}-new-1`, `${kind}-new-2`]
          : [options.sameSession, options.sameSession],
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.elapsedMs === undefined ? {} : { elapsedMs: options.elapsedMs }),
      ...(options.failStart === undefined ? {} : { failStart: options.failStart }),
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
      createAdapters: (): AgentAdapters => {
        const failure = options.failCreateAdapters?.();
        if (failure !== undefined) throw failure;
        return adapters;
      },
    },
  };
}

async function ledgers(
  runsDir: string,
): Promise<{ invocations: InvocationDispatchRecord[]; usage: UsageObservationRecord[] }> {
  const paths = runPaths(runsDir, RUN_ID);
  return {
    invocations: await (await openInvocationLedger(paths, RUN_ID)).readAll(),
    usage: await (await openUsageLedger(paths, RUN_ID)).readAll(),
  };
}

/** Jamais un index global : le run porte déjà d'autres engagements. */
function recoveryDispatches(records: readonly InvocationDispatchRecord[]): InvocationDispatchRecord[] {
  return records.filter((entry) => entry.trigger_kind === 'RECOVERY_CONTINUE');
}

function usageOf(
  records: readonly UsageObservationRecord[],
  invocationId: string,
): UsageObservationRecord[] {
  return records.filter((entry) => entry.invocation_id === invocationId);
}

async function journal(runsDir: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(runsDir, RUN_ID);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

async function viewOf(runsDir: string): Promise<ReturnType<typeof buildNativeInitializationView>> {
  const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);
  return buildNativeInitializationView(RUN_ID, snapshot.manifest, snapshot.state, snapshot.events);
}

function brokenInvocationLedger(failAt: number): NonNullable<ContinueNativeInitializationInput['governanceSeams']>['openInvocationLedger'] {
  let seen = 0;
  return async (paths, runId, options) => {
    const real = await openInvocationLedger(paths, runId, options);
    return {
      ...real,
      append: async (draft, now) => {
        if (draft.trigger_kind === 'RECOVERY_CONTINUE') {
          seen += 1;
          if (seen === failAt) throw new CcrError('JOURNAL_INVALID', 'disque saturé (fixture)');
        }
        return real.append(draft, now);
      },
    };
  };
}

function brokenUsageLedger(failAt: number): NonNullable<ContinueNativeInitializationInput['governanceSeams']>['openUsageLedger'] {
  let seen = 0;
  return async (paths, runId, options) => {
    const real = await openUsageLedger(paths, runId, options);
    return {
      ...real,
      append: async (draft, now) => {
        seen += 1;
        if (seen === failAt) throw new CcrError('JOURNAL_INVALID', 'usage indisponible (fixture)');
        return real.append(draft, now);
      },
    };
  };
}

// ==========================================================================
// A. Une nouvelle tentative, jamais la poursuite d'une ancienne
// ==========================================================================

test('1–6 · un slot repris reçoit une invocation neuve, l’ancienne est intacte', async () => {
  const dir = await makeTempDir('ccr-1e-fresh-');
  try {
    const runsDir = path.join(dir, 'runs');
    // L'auteur a échoué : son engagement START existe, sans réponse ni session.
    await materialize(runsDir, {
      author: { prompt: true },
      challenger: { prompt: true, response: 'claude-1', bound: 'claude-1', created: 'claude-1' },
      historicalStart: ['author', 'challenger'],
    });
    const beforeLedger = (await ledgers(runsDir)).invocations;
    assert.equal(beforeLedger.length, 2, 'deux engagements historiques');

    const h = harness(runsDir, { usage: PROVIDER_USAGE, elapsedMs: 700 });
    const outcome = await continueNativeInitialization(h.deps, RUN_ID);

    const { invocations, usage } = await ledgers(runsDir);
    const fresh = recoveryDispatches(invocations);

    // 1 · 3 · une invocation neuve, au déclencheur exact.
    assert.equal(fresh.length, 1);
    const dispatch = fresh[0] as InvocationDispatchRecord;
    assert.equal(dispatch.trigger_kind, 'RECOVERY_CONTINUE');
    assert.equal(dispatch.invocation_id, 'inv_000003');
    assert.deepEqual(dispatch.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'author',
      provider: 'codex',
    });

    // 2 · l'ancienne est bit pour bit celle d'avant.
    const oldAuthor = invocations.find((entry) => entry.invocation_id === 'inv_000001');
    assert.deepEqual(oldAuthor, beforeLedger[0], 'l’enregistrement START n’a pas bougé');
    assert.equal(oldAuthor?.trigger_kind, 'START');

    // 4 · le prompt est celui de la NOUVELLE tentative, jamais l'orphelin.
    const events = await journal(runsDir);
    const authorPrompts = events.filter(
      (event) =>
        event.type === 'prompt_sent' &&
        (event as { target_expert_slot_id?: string }).target_expert_slot_id === 'author',
    );
    assert.equal(authorPrompts.length, 2, 'un prompt frais a été écrit');
    assert.equal(dispatch.prompt_event_id, authorPrompts[1]?.event_id);
    assert.notEqual(dispatch.prompt_event_id, authorPrompts[0]?.event_id);
    assert.notEqual(dispatch.prompt_event_id, oldAuthor?.prompt_event_id);

    // 5 · une reprise d'initialisation n'est pas un transfert.
    assert.equal(dispatch.session_id, undefined);
    assert.equal(dispatch.round, undefined);
    assert.equal(dispatch.source_event_id, undefined);
    // 6 · aucune corrélation en CLI.
    assert.equal(dispatch.operation_id, undefined);

    // Observations rattachées à la NOUVELLE invocation.
    assert.deepEqual(
      usageOf(usage, dispatch.invocation_id).map((entry) => entry.provenance).sort(),
      ['CCR_MEASURED', 'PROVIDER_REPORTED'],
    );
    assert.deepEqual(usageOf(usage, 'inv_000001'), [], 'l’ancienne n’en reçoit aucune');
    assert.deepEqual(outcome.usageGovernanceWarnings, []);
    assert.equal(h.startCalls(), 1);
  } finally {
    await removeTempDir(dir);
  }
});

test('7–10 · deux slots manquants : dispatchs séquentiels, identités distinctes', async () => {
  const dir = await makeTempDir('ccr-1e-two-slots-');
  try {
    const runsDir = path.join(dir, 'runs');
    const seen: number[] = [];
    // Same-provider : deux slots manquants sur le même moteur.
    await materialize(runsDir, {
      bindings: { author: 'claude', challenger: 'claude' },
      author: { prompt: true },
      challenger: {},
      historicalStart: ['author'],
    });

    const h = harness(runsDir, {
      // 8–9 · au moment de chaque appel, exactement ce qui doit exister.
      onStart: async () => {
        seen.push(recoveryDispatches((await ledgers(runsDir)).invocations).length);
      },
    });
    await continueNativeInitialization(h.deps, RUN_ID);

    assert.deepEqual(seen, [1, 2], 'jamais deux engagements avant le premier appel');

    const fresh = recoveryDispatches((await ledgers(runsDir)).invocations);
    assert.equal(fresh.length, 2);
    // 7 · l'ordre canonique est conservé.
    assert.deepEqual(
      fresh.map((entry) => (entry.identity as { expert_slot?: string }).expert_slot),
      ['author', 'challenger'],
    );
    // 10 · même moteur, deux identités et deux sessions distinctes.
    for (const entry of fresh) {
      assert.equal((entry.identity as { provider?: string }).provider, 'claude');
      assert.equal(entry.session_id, undefined);
    }
    const manifest = await readPersistedManifest(runPaths(runsDir, RUN_ID));
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
    assert.notEqual(
      manifest.manifest.experts.author.session_id,
      manifest.manifest.experts.challenger.session_id,
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Ce qui n'appelle personne n'engage rien
// ==========================================================================

test('11–13 · action locale, incertitude et adapters introuvables n’engagent rien', async () => {
  // 11 · aucune reprise fournisseur : la finalisation locale suffit.
  const dir = await makeTempDir('ccr-1e-local-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1' },
      challenger: { prompt: true, response: 'claude-1', bound: 'claude-1', created: 'claude-1' },
      state: 'READY',
    });
    const h = harness(runsDir);
    await continueNativeInitialization(h.deps, RUN_ID);
    const after = await ledgers(runsDir);
    assert.deepEqual(recoveryDispatches(after.invocations), []);
    assert.deepEqual(after.usage, []);
    assert.equal(h.startCalls(), 0);
  } finally {
    await removeTempDir(dir);
  }

  // 12 · une incertitude exige un acquittement : jamais un rejeu automatique.
  const dir2 = await makeTempDir('ccr-1e-uncertain-');
  try {
    const runsDir = path.join(dir2, 'runs');
    await materialize(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true },
      state: 'WAITING_AGENT',
      pendingSlot: 'challenger',
      historicalStart: ['challenger'],
    });
    const h = harness(runsDir);
    await assert.rejects(
      continueNativeInitialization(h.deps, RUN_ID),
      (error: unknown) => isCcrError(error) && error.code === 'RECOVERY_REQUIRED',
    );
    assert.deepEqual(recoveryDispatches((await ledgers(runsDir)).invocations), []);
    assert.equal(h.startCalls(), 0);
  } finally {
    await removeTempDir(dir2);
  }

  // 13 · les adapters sont construits avant la boucle : leur échec est gratuit.
  const dir3 = await makeTempDir('ccr-1e-adapters-');
  try {
    const runsDir = path.join(dir3, 'runs');
    await materialize(runsDir, { author: { prompt: true }, challenger: {} });
    const h = harness(runsDir, {
      failCreateAdapters: () => new CcrError('AGENT_EXECUTABLE_UNRESOLVED', 'aucune CLI (fixture)'),
    });
    await assert.rejects(
      continueNativeInitialization(h.deps, RUN_ID),
      (error: unknown) => isCcrError(error) && error.code === 'AGENT_EXECUTABLE_UNRESOLVED',
    );
    assert.deepEqual(recoveryDispatches((await ledgers(runsDir)).invocations), []);
    assert.equal(h.startCalls(), 0);
  } finally {
    await removeTempDir(dir3);
  }
});

// ==========================================================================
// C. Échecs
// ==========================================================================

test('14–16 · un engagement impossible n’appelle personne, et CONTINUE reste offert', async () => {
  const dir = await makeTempDir('ccr-1e-ledger-fail-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, {
      author: { prompt: true },
      challenger: { prompt: true, response: 'claude-1', bound: 'claude-1', created: 'claude-1' },
      historicalStart: ['author'],
    });

    const h = harness(runsDir);
    const outcome = await continueNativeInitialization(h.deps, RUN_ID, {
      governanceSeams: { openInvocationLedger: brokenInvocationLedger(1) },
    });

    // 14 · aucun fournisseur.
    assert.equal(h.startCalls(), 0);
    assert.equal(outcome.positions.length, 0);
    const events = await journal(runsDir);
    assert.equal(
      events.filter((event) => event.type === 'process_failed').length,
      0,
      'la panne appartient à CCR, jamais à l’expert',
    );

    // 15 · le slot redevient manquant, sans événement neuf.
    const view = await viewOf(runsDir);
    assert.equal(view.status, 'CLEAN_MISSING');
    assert.deepEqual(view.missingSlots, ['author']);
    // 16 · et l'action reste légalement disponible pour une nouvelle tentative.
    assert.equal(view.canContinueWithProvider, true);

    // Aucun enregistrement partiel n'a survécu.
    assert.deepEqual(recoveryDispatches((await ledgers(runsDir)).invocations), []);
    // L'ancienne invocation reste intacte.
    assert.equal((await ledgers(runsDir)).invocations.length, 1);
  } finally {
    await removeTempDir(dir);
  }
});

test('17 · succès partiel : le slot déjà repris n’est jamais dégradé', async () => {
  const dir = await makeTempDir('ccr-1e-partial-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, { author: { prompt: true }, challenger: {} });

    const h = harness(runsDir, { usage: PROVIDER_USAGE });
    const outcome = await continueNativeInitialization(h.deps, RUN_ID, {
      governanceSeams: { openInvocationLedger: brokenInvocationLedger(2) },
    });

    assert.equal(h.startCalls(), 1, 'seul l’auteur a été appelé');
    assert.equal(outcome.positions.length, 1);

    const view = await viewOf(runsDir);
    assert.equal(view.conditions.author, 'COMPLETE', 'l’auteur repris est conservé');
    assert.deepEqual(view.missingSlots, ['challenger']);
    assert.equal(view.status, 'CLEAN_MISSING');

    const { invocations, usage } = await ledgers(runsDir);
    const fresh = recoveryDispatches(invocations);
    assert.equal(fresh.length, 1);
    assert.equal(usageOf(usage, (fresh[0] as InvocationDispatchRecord).invocation_id).length, 2);
  } finally {
    await removeTempDir(dir);
  }
});

test('18–19 · un échec fournisseur conserve l’engagement et arrête la reprise', async () => {
  const dir = await makeTempDir('ccr-1e-provider-fail-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, { author: { prompt: true }, challenger: {} });

    const h = harness(runsDir, {
      failStart: () => new CcrError('AGENT_TIMEOUT', 'délai (fixture)'),
    });
    const outcome = await continueNativeInitialization(h.deps, RUN_ID);

    // 19 · fail-fast : le second slot n'est jamais tenté.
    assert.equal(h.startCalls(), 1);
    assert.equal(outcome.positions.length, 0);

    const { invocations, usage } = await ledgers(runsDir);
    const fresh = recoveryDispatches(invocations);
    // 18 · l'engagement pris demeure.
    assert.equal(fresh.length, 1);
    assert.equal(usage.length, 0, 'aucun usage fictif pour un tour sans retour');
    assert.equal(
      (await journal(runsDir)).filter((event) => event.type === 'process_failed').length,
      1,
      'la sémantique V2.1 de l’échec est intacte',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('26 · une collision de session conserve l’engagement sans écrire d’usage', async () => {
  const dir = await makeTempDir('ccr-1e-collision-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, {
      bindings: { author: 'claude', challenger: 'claude' },
      author: { prompt: true },
      challenger: {},
    });
    // Le même identifiant rendu deux fois : la collision que V2.1 refuse.
    const h = harness(runsDir, { usage: PROVIDER_USAGE, sameSession: 'S-collision' });
    const outcome = await continueNativeInitialization(h.deps, RUN_ID);

    assert.equal(outcome.positions.length, 1, 'seul l’auteur a été acquis');
    const { invocations, usage } = await ledgers(runsDir);
    const fresh = recoveryDispatches(invocations);
    assert.equal(fresh.length, 2, 'les deux engagements avaient été pris');
    const challenger = fresh[1] as InvocationDispatchRecord;
    assert.deepEqual(usageOf(usage, challenger.invocation_id), [], 'aucun usage pour un tour refusé');
    assert.equal(usageOf(usage, (fresh[0] as InvocationDispatchRecord).invocation_id).length, 2);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Gouvernance non bloquante
// ==========================================================================

test('20–25 · un échec d’usage n’interrompt jamais la reprise', async () => {
  const dir = await makeTempDir('ccr-1e-usage-fail-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, { author: { prompt: true }, challenger: {} });

    const h = harness(runsDir, { usage: PROVIDER_USAGE });
    // Le premier append d'usage est celui de l'auteur.
    const outcome = await continueNativeInitialization(h.deps, RUN_ID, {
      governanceSeams: { openUsageLedger: brokenUsageLedger(1) },
    });

    // Le challenger est bien repris malgré l'avertissement.
    assert.equal(h.startCalls(), 2);
    assert.equal(outcome.positions.length, 2);
    const view = await viewOf(runsDir);
    assert.deepEqual(view.missingSlots, [], 'l’initialisation est complète');

    // 24 · le diagnostic est structuré et sans matière sensible.
    assert.equal(outcome.usageGovernanceWarnings.length, 1);
    const warning = outcome.usageGovernanceWarnings[0];
    assert.equal(warning?.provenance, 'PROVIDER_REPORTED');
    assert.equal(warning?.error_code, 'JOURNAL_INVALID');
    for (const forbidden of ['prompt', 'response', 'stdout', 'Mission']) {
      assert.equal(JSON.stringify(warning).includes(forbidden), false, `sans ${forbidden}`);
    }

    // Aucun rollback : la mesure CCR de l'auteur subsiste.
    const { invocations, usage } = await ledgers(runsDir);
    const fresh = recoveryDispatches(invocations);
    assert.deepEqual(
      usageOf(usage, (fresh[0] as InvocationDispatchRecord).invocation_id).map((e) => e.provenance),
      ['CCR_MEASURED'],
    );
    assert.equal(usageOf(usage, (fresh[1] as InvocationDispatchRecord).invocation_id).length, 2);
  } finally {
    await removeTempDir(dir);
  }
});

test('25 · un avertissement coexiste avec un échec ultérieur', async () => {
  const dir = await makeTempDir('ccr-1e-warning-failure-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, { author: { prompt: true }, challenger: {} });

    let calls = 0;
    const h = harness(runsDir, {
      usage: PROVIDER_USAGE,
      failStart: () => {
        calls += 1;
        return calls === 2 ? new CcrError('AGENT_TIMEOUT', 'délai (fixture)') : undefined;
      },
    });
    const outcome = await continueNativeInitialization(h.deps, RUN_ID, {
      governanceSeams: { openUsageLedger: brokenUsageLedger(1) },
    });

    assert.equal(outcome.positions.length, 1, 'le challenger a échoué');
    assert.equal(outcome.usageGovernanceWarnings.length, 1, 'l’avertissement survit');
    assert.equal(outcome.view.missingSlots.length, 1);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Cas mixte, admission, indépendance
// ==========================================================================

test('27–30 · le cas mixte n’engage que le slot manquant, sous admission', async () => {
  const dir = await makeTempDir('ccr-1e-mixed-');
  try {
    const runsDir = path.join(dir, 'runs');
    // C'est le cas qui a déclenché le repair V2.1.
    await materialize(runsDir, {
      bindings: { author: 'claude', challenger: 'codex' },
      author: { prompt: true, response: 'claude-1' },
      challenger: {},
    });

    const view = await viewOf(runsDir);
    assert.equal(view.status, 'RECONCILABLE_DURABLE_RESPONSE');
    assert.equal(view.canContinueWithProvider, true, 'le repair V2.1 n’a pas régressé');
    // 28 · seul le moteur du slot manquant est requis.
    assert.deepEqual(view.requiredProviders, ['codex']);

    const h = harness(runsDir, { usage: PROVIDER_USAGE });
    const manager = createLongOperationManager();
    const admitted: string[] = [];
    const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);

    const outcome = await applyNativeRecoveryMutation(
      { runService: h.deps, manager, operationId: 'op_mixed' },
      { runId: RUN_ID, domain: 'initialization', action: 'CONTINUE', expectedRevision: snapshot.revision },
      { onAdmitted: (id) => admitted.push(id) },
    );

    // 29 · le créneau est réservé avant l'appel, et relâché ensuite.
    assert.deepEqual(admitted, ['op_mixed']);
    assert.equal(outcome.usedProvider, true);
    assert.equal(manager.activeCount(), 0);

    // 27 · un seul engagement, pour le seul slot manquant.
    const fresh = recoveryDispatches((await ledgers(runsDir)).invocations);
    assert.equal(fresh.length, 1);
    const dispatch = fresh[0] as InvocationDispatchRecord;
    assert.deepEqual(dispatch.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'challenger',
      provider: 'codex',
    });
    // L'auteur réconcilié localement n'en reçoit aucun.
    assert.equal(
      fresh.some((entry) => (entry.identity as { expert_slot?: string }).expert_slot === 'author'),
      false,
    );
    // La corrélation applicative est portée par l'enregistrement.
    assert.equal(dispatch.operation_id, 'op_mixed');
    assert.equal(h.startCalls(), 1);
    assert.deepEqual(outcome.usageGovernanceWarnings, []);
  } finally {
    await removeTempDir(dir);
  }
});

test('30 · manager saturé : aucun engagement, aucun fournisseur', async () => {
  const dir = await makeTempDir('ccr-1e-busy-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, {
      author: { prompt: true, response: 'codex-1' },
      challenger: {},
    });

    const h = harness(runsDir);
    const manager = createLongOperationManager();
    manager.admit('op_a');
    manager.admit('op_b');
    const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);

    await assert.rejects(
      applyNativeRecoveryMutation(
        { runService: h.deps, manager, operationId: 'op_mixed' },
        { runId: RUN_ID, domain: 'initialization', action: 'CONTINUE', expectedRevision: snapshot.revision },
      ),
      (error: unknown) => isCcrError(error) && error.code === 'COCKPIT_BUSY',
    );

    assert.deepEqual(recoveryDispatches((await ledgers(runsDir)).invocations), []);
    assert.equal(h.startCalls(), 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('31–34 · gardes : classifieur, legacy, déclencheurs et helper partagé', async () => {
  const { readFile } = await import('node:fs/promises');
  const executable = async (relative: string): Promise<string> => {
    const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  // 31 · le classifieur reste fondé sur les seuls faits V2.1.
  const recovery = await executable('services/native-recovery-service.ts');
  const classifier = recovery.slice(
    recovery.indexOf('export function buildNativeInitializationView'),
    recovery.indexOf('async function loadNativeRun'),
  );
  for (const forbidden of ['invocation-ledger', 'usage-ledger', 'openInvocations', 'openUsage']) {
    assert.equal(classifier.includes(forbidden), false, `le classifieur ignore ${forbidden}`);
  }

  // 32 · le legacy gouverne désormais ses propres chemins (IMP-06), sans jamais
  //      emprunter la reprise native ni son vocabulaire de slots.
  const legacy = await executable('services/run-service.ts');
  assert.ok(legacy.includes("trigger: 'RECOVERY_CONTINUE'"), 'la reprise legacy est câblée');
  assert.equal(legacy.includes('expert_slot'), false);
  assert.equal(legacy.includes('native-recovery-service'), false);

  // 33 · chaque appelant déclare son propre déclencheur.
  const started = await executable('services/native-start-service.ts');
  assert.ok(started.includes("trigger: 'START'"));
  assert.ok(recovery.includes("trigger: 'RECOVERY_CONTINUE'"));
  assert.equal(started.includes("trigger_kind: 'START'"), false, 'le déclencheur n’est plus figé');

  // 34 · le helper d'usage ignore toujours la reprise.
  const writer = await executable('services/usage-governance-writer.ts');
  for (const forbidden of ['recovery', 'missingSlots', 'expert_slot', 'operationId']) {
    assert.equal(writer.includes(forbidden), false, `le helper ignore ${forbidden}`);
  }
  // Ni tarif, ni quota, nulle part dans la gouvernance.
  for (const relative of ['core/usage-governance.ts', 'services/usage-governance-writer.ts']) {
    const code = await executable(relative);
    for (const forbidden of ['pricing', 'CostEstimate', 'quota']) {
      assert.equal(code.includes(forbidden), false, `${relative} sans ${forbidden}`);
    }
  }
});
