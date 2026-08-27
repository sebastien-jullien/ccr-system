/**
 * Slice 2C — Native HANDOFF Execution.
 *
 * `handoff` n'envoie rien. Trois propriétés le distinguent de tout le reste :
 *
 *   1. c'est la session **déjà existante** du slot visé qui est ouverte — jamais
 *      créée, jamais reprise par un tour, jamais celle de l'autre expert ;
 *   2. aucun prompt, aucune réponse : CCR ne journalise que la frontière de
 *      l'intervention, et n'invente pas la conversation qu'il n'a pas vue ;
 *   3. le contexte d'opération survit à l'événement de fin, jusqu'au commit —
 *      c'est ce qui rendra les fenêtres H0→H3 lisibles par 2C-R.
 *
 * Aucun fournisseur réel : `openInteractive` est simulé par des fixtures, et
 * aucun terminal n'est lancé.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { RunState } from '../../src/core/state.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings } from '../../src/services/native-start-service.ts';
import { handoffNativeExpert } from '../../src/services/native-handoff-service.ts';
import {
  expertSlotTarget,
  providerAliasTarget,
} from '../../src/services/native-target-resolver.ts';
import { startRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import {
  persistNativeStateUpdate,
  readPersistedManifest,
  readPersistedState,
} from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeNativeRun } from '../helpers/run-fixture.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  /** Sessions réellement ouvertes en interactif, dans l'ordre. */
  readonly interactives: { provider: ProviderKind; sessionId: string }[];
  /** Tours d'agent : un handoff ne doit en produire aucun. */
  turns(): readonly { provider: ProviderKind; phase: 'start' | 'resume' }[];
}

interface HarnessOptions {
  readonly sessions?: Partial<Record<ProviderKind, readonly string[]>>;
  readonly failInteractive?: () => unknown;
  readonly interactiveExitCode?: number;
  /** Exécuté pendant l'attachement, verrou tenu. */
  readonly onInteractive?: () => Promise<void> | void;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  const interactives: { provider: ProviderKind; sessionId: string }[] = [];
  const turns: { provider: ProviderKind; phase: 'start' | 'resume' }[] = [];

  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: options.sessions?.[kind] ?? [`${kind}-1`, `${kind}-2`],
      ...(options.failInteractive === undefined ? {} : { failInteractive: options.failInteractive }),
      ...(options.interactiveExitCode === undefined
        ? {}
        : { interactiveExitCode: options.interactiveExitCode }),
      onCall: (phase) => {
        turns.push({ provider: kind, phase });
      },
      onInteractive: async (sessionId) => {
        interactives.push({ provider: kind, sessionId });
        await options.onInteractive?.();
      },
    });
  const adapters = { claude: build('claude'), codex: build('codex') };

  return {
    runsDir,
    adapters,
    interactives,
    turns: () => turns,
    deps: { runsDir, now: () => new Date(AT), createAdapters: (): AgentAdapters => adapters },
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

/** Run natif initialisé, puis suspendu sous contrôle humain. */
async function suspendedRun(
  h: Harness,
  dir: string,
  options: { readonly bindings?: NativeExpertBindings; readonly state?: RunState } = {},
): Promise<string> {
  const result = await startNativeRun(h.deps, {
    title: 'T',
    cwd: dir,
    prompt: MISSION,
    ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
    runtimeConfig: nativeRuntime(),
  });
  assert.equal(result.failure, undefined);
  await forceState(h.runsDir, result.runId, { state: options.state ?? 'PAUSED', control: 'HUMAN' });
  return result.runId;
}

async function forceState(
  runsDir: string,
  runId: string,
  update: { state: RunState; control?: 'AUTOMATION' | 'HUMAN' },
): Promise<void> {
  const paths = runPaths(runsDir, runId);
  const current = await readPersistedState(paths);
  if (current.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  await persistNativeStateUpdate(
    paths,
    current.document,
    { state: update.state, ...(update.control === undefined ? {} : { control: update.control }) },
    new Date(AT),
  );
}

async function journal(runsDir: string, runId: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

async function snapshot(paths: { state: string; events: string }): Promise<{ state: string; events: string }> {
  return { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') };
}

function field(event: NativeCcrEvent | undefined, name: string): unknown {
  return event === undefined ? undefined : (event as unknown as Record<string, unknown>)[name];
}

// ==========================================================================
// A. Cible canonique et same-provider
// ==========================================================================

test('1–6 · un handoff ouvre la session du slot visé, et ne produit aucun tour', async () => {
  for (const bindings of [
    { author: 'codex', challenger: 'claude' },
    { author: 'claude', challenger: 'codex' },
    { author: 'claude', challenger: 'claude' },
    { author: 'codex', challenger: 'codex' },
  ] as readonly NativeExpertBindings[]) {
    const dir = await makeTempDir('ccr-2c-canonical-');
    try {
      const same = bindings.author === bindings.challenger;
      const h = harness(path.join(dir, 'runs'), same ? { sessions: { [bindings.author]: ['S1', 'S2'] } } : {});
      const runId = await suspendedRun(h, dir, { bindings });
      const turnsAfterInit = h.turns().length;

      for (const slot of ['author', 'challenger'] as const) {
        const result = await handoffNativeExpert(h.deps, runId, expertSlotTarget(slot));
        assert.equal(result.expertSlot, slot);
        assert.equal(result.provider, bindings[slot]);
      }

      const expected = same
        ? ['S1', 'S2']
        : [`${bindings.author}-1`, `${bindings.challenger}-1`];
      assert.deepEqual(
        h.interactives.map((call) => call.sessionId),
        expected,
        `author=${bindings.author} challenger=${bindings.challenger}`,
      );
      assert.deepEqual(
        h.interactives.map((call) => call.provider),
        [bindings.author, bindings.challenger],
      );
      // 6 · aucun `start()`, aucun `resume()` : un handoff n'est pas un tour.
      assert.equal(h.turns().length, turnsAfterInit, 'aucun tour supplémentaire');
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// B. Aliases
// ==========================================================================

test('7–10 · un alias univoque résout, un alias ambigu ou absent refuse sans le moindre effet', async () => {
  const dir = await makeTempDir('ccr-2c-alias-');
  try {
    const runsDir = path.join(dir, 'runs');

    // 7 · configuration mixte : l'alias désigne un seul expert.
    const mixed = harness(runsDir);
    const mixedRun = await suspendedRun(mixed, dir);
    const viaAlias = await handoffNativeExpert(mixed.deps, mixedRun, providerAliasTarget('claude'));
    assert.equal(viaAlias.expertSlot, 'challenger');
    assert.deepEqual(mixed.interactives.map((call) => call.sessionId), ['claude-1']);

    // 8–9 · same-provider : les deux alias échouent, pour deux raisons.
    const same = harness(runsDir, { sessions: { claude: ['S1', 'S2'] } });
    const sameRun = await suspendedRun(same, dir, { bindings: { author: 'claude', challenger: 'claude' } });
    const paths = runPaths(runsDir, sameRun);
    const before = await snapshot(paths);

    await expectRejection(
      handoffNativeExpert(same.deps, sameRun, providerAliasTarget('claude')),
      'AMBIGUOUS_PROVIDER_ALIAS',
      'les deux experts emploient claude',
    );
    await expectRejection(
      handoffNativeExpert(same.deps, sameRun, providerAliasTarget('codex')),
      'PROVIDER_ALIAS_NOT_BOUND',
      'aucun expert n’emploie codex',
    );
    assert.deepEqual(await snapshot(paths), before, 'aucun événement, aucune mutation');
    assert.equal(same.interactives.length, 0, 'aucun lancement interactif');

    // 10 · la cible canonique reste parfaitement utilisable.
    const author = await handoffNativeExpert(same.deps, sameRun, expertSlotTarget('author'));
    const challenger = await handoffNativeExpert(same.deps, sameRun, expertSlotTarget('challenger'));
    assert.equal(author.sessionId, 'S1');
    assert.equal(challenger.sessionId, 'S2');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Gardes
// ==========================================================================

test('11–16 · le handoff exige un run suspendu sous contrôle humain, et une session', async () => {
  const dir = await makeTempDir('ccr-2c-guards-');
  try {
    const runsDir = path.join(dir, 'runs');

    // 11–12 · les deux états suspendus sont autorisés.
    for (const state of ['PAUSED', 'WAITING_HUMAN'] as const) {
      const h = harness(runsDir);
      const runId = await suspendedRun(h, dir, { state });
      const result = await handoffNativeExpert(h.deps, runId, expertSlotTarget('challenger'));
      assert.equal(result.state.state, state, `${state} · état conservé`);
      assert.equal(result.state.control, 'HUMAN');
    }

    // 13 · sous automatisation, jamais.
    const automated = harness(runsDir);
    const automatedRun = await suspendedRun(automated, dir);
    await forceState(runsDir, automatedRun, { state: 'PAUSED', control: 'AUTOMATION' });
    await expectRejection(
      handoffNativeExpert(automated.deps, automatedRun, expertSlotTarget('challenger')),
      'HANDOFF_NOT_ALLOWED',
      'contrôle automatique',
    );

    // 14 · un run prêt n'est pas un run suspendu.
    const ready = harness(runsDir);
    const readyRun = await suspendedRun(ready, dir);
    await forceState(runsDir, readyRun, { state: 'READY', control: 'HUMAN' });
    await expectRejection(
      handoffNativeExpert(ready.deps, readyRun, expertSlotTarget('challenger')),
      'HANDOFF_NOT_ALLOWED',
      'état non suspendu',
    );
    assert.equal(ready.interactives.length, 0);

    // 15 · une session absente est un refus, jamais une création.
    const missing = harness(runsDir);
    await materializeNativeRun(runsDir, {
      runId: 'CCR-20260811-777',
      bindings: { author: 'codex', challenger: 'claude' },
      manifest: { sessions: 'none' },
      state: { state: 'PAUSED', control: 'HUMAN' },
    });
    await expectRejection(
      handoffNativeExpert(missing.deps, 'CCR-20260811-777', expertSlotTarget('challenger')),
      'SESSION_MISSING',
      'le handoff n’ouvre pas de session',
    );
    assert.equal(missing.turns().length, 0, 'aucun `start()`');
    assert.equal(missing.interactives.length, 0);

    // 16 · une opération engagée interdit toute action manuelle.
    const engaged = harness(runsDir);
    const engagedRun = await suspendedRun(engaged, dir);
    const enginePaths = runPaths(runsDir, engagedRun);
    const current = await readPersistedState(enginePaths);
    if (current.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    await persistNativeStateUpdate(
      enginePaths,
      current.document,
      {
        pendingOperation: {
          kind: 'send',
          expert_slot: 'author',
          round: 0,
          prompt_event_id: 'evt_000001',
          session_id: 'codex-1',
          return_state: 'PAUSED',
          return_control: 'HUMAN',
          started_at: AT,
        },
      },
      new Date(AT),
    );
    await expectRejection(
      handoffNativeExpert(engaged.deps, engagedRun, expertSlotTarget('challenger')),
      'RECOVERY_REQUIRED',
      'opération engagée',
    );
    assert.equal(engaged.interactives.length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Frontières durables
// ==========================================================================

test('17–23 · l’ouverture est journalisée avant tout, le contexte survit jusqu’au commit', async () => {
  const dir = await makeTempDir('ccr-2c-durable-');
  try {
    const observations: Record<string, unknown> = {};
    let paths = runPaths(path.join(dir, 'runs'), 'placeholder');

    const h = harness(path.join(dir, 'runs'), {
      onInteractive: async () => {
        // 20 · pendant l'attachement, le contexte est là.
        const state = await readPersistedState(paths);
        if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return;
        observations['duringPending'] = state.document.pending_operation?.kind;
        observations['duringActive'] = state.document.active_expert_slot;
      },
    });
    const runId = await suspendedRun(h, dir);
    paths = runPaths(h.runsDir, runId);
    const beforeState = await readFile(paths.state, 'utf8');

    const result = await handoffNativeExpert(h.deps, runId, expertSlotTarget('challenger'), {
      afterStartedJournaled: async () => {
        // 17–18 · l'événement est durable, l'état n'a pas bougé d'un octet, et
        // aucun client interactif n'a été lancé.
        observations['startedState'] = await readFile(paths.state, 'utf8');
        observations['startedJournal'] = (await readFile(paths.events, 'utf8')).includes(
          '"human_handoff_started"',
        );
        observations['startedInteractives'] = h.interactives.length;
      },
      afterPendingPersisted: async () => {
        // 19 · le contexte est durable AVANT tout lancement.
        const state = await readPersistedState(paths);
        if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return;
        observations['pendingKind'] = state.document.pending_operation?.kind;
        observations['pendingSession'] = state.document.pending_operation?.session_id;
        observations['pendingPrompt'] = state.document.pending_operation?.prompt_event_id;
        observations['pendingActive'] = state.document.active_expert_slot;
        observations['pendingInteractives'] = h.interactives.length;
      },
      afterInteractiveReturned: async () => {
        // 21 · au retour, le contexte est toujours là, et rien ne conclut encore.
        const state = await readPersistedState(paths);
        if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return;
        observations['returnedPending'] = state.document.pending_operation?.kind;
        observations['returnedFinished'] = (await readFile(paths.events, 'utf8')).includes(
          '"human_handoff_finished"',
        );
      },
      afterFinishedJournaled: async () => {
        // 22 · la fin est durable, et le contexte ne l'est pas moins.
        const state = await readPersistedState(paths);
        if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return;
        observations['finishedPending'] = state.document.pending_operation?.kind;
        observations['finishedJournal'] = (await readFile(paths.events, 'utf8')).includes(
          '"human_handoff_finished"',
        );
      },
    });

    assert.equal(observations['startedState'], beforeState, '17 · aucune mutation avant l’événement');
    assert.equal(observations['startedJournal'], true, '17 · ouverture durable');
    assert.equal(observations['startedInteractives'], 0, '18 · aucun lancement');
    assert.equal(observations['pendingKind'], 'handoff', '19 · contexte durable');
    assert.equal(observations['pendingSession'], 'claude-1');
    assert.equal(observations['pendingPrompt'], result.startedEventId, 'le contexte nomme l’ouverture');
    assert.equal(observations['pendingActive'], 'challenger');
    assert.equal(observations['pendingInteractives'], 0, '19 · toujours aucun lancement');
    assert.equal(observations['duringPending'], 'handoff', '20 · contexte présent pendant l’attachement');
    assert.equal(observations['duringActive'], 'challenger');
    assert.equal(observations['returnedPending'], 'handoff', '21 · contexte présent au retour');
    assert.equal(observations['returnedFinished'], false, '21 · rien n’est encore conclu');
    assert.equal(observations['finishedPending'], 'handoff', '22 · contexte présent après la fin');
    assert.equal(observations['finishedJournal'], true);

    // 23 · après le commit, le contexte est libéré.
    assert.equal(result.state.pending_operation, null);
    assert.equal(result.state.active_expert_slot, null);
    const after = await readPersistedState(paths);
    if (after.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(after.document.pending_operation, null);
    assert.equal(after.document.active_expert_slot, null);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Événements
// ==========================================================================

test('24–28 · deux événements, causalement liés, et aucune conversation inventée', async () => {
  const dir = await makeTempDir('ccr-2c-events-');
  try {
    const h = harness(path.join(dir, 'runs'), { interactiveExitCode: 0 });
    const runId = await suspendedRun(h, dir);
    const beforeEvents = (await journal(h.runsDir, runId)).length;

    const result = await handoffNativeExpert(h.deps, runId, expertSlotTarget('author'));
    const events = await journal(h.runsDir, runId);
    const started = events.find((event) => event.type === 'human_handoff_started');
    const finished = events.find((event) => event.type === 'human_handoff_finished');

    // 24–25 · les deux événements nomment le slot, jamais le moteur.
    assert.equal(field(started, 'target_expert_slot_id'), 'author');
    assert.equal(field(finished, 'target_expert_slot_id'), 'author');
    assert.equal(field(started, 'session_id'), 'codex-1');
    assert.equal(field(finished, 'session_id'), 'codex-1');

    // 26 · la causalité est explicite, jamais temporelle.
    assert.deepEqual(finished?.based_on, [result.startedEventId]);
    assert.equal(started?.event_id, result.startedEventId);
    assert.equal(finished?.event_id, result.finishedEventId);

    // 27 · aucune identité fournisseur dans le journal.
    for (const event of [started, finished]) {
      assert.ok(event !== undefined);
      assert.equal('target' in (event as unknown as Record<string, unknown>), false);
      assert.equal(event.actor, 'human');
    }

    // 28 · aucun message, aucune réponse : CCR n'a pas vu la conversation.
    assert.equal(events.length, beforeEvents + 2, 'exactement deux événements ajoutés');
    assert.equal(
      events.filter((event) => event.type === 'human_message' || event.type === 'prompt_sent').length,
      2,
      'seuls les deux prompts initiaux de START subsistent',
    );
    assert.equal(
      events.filter((event) => event.type === 'assistant_response').length,
      2,
      'aucune réponse produite par le handoff',
    );
    assert.equal(events.filter((event) => event.type === 'round_completed').length, 0);
    // La frontière de coût est consignée, jamais mesurée.
    assert.equal((finished?.details ?? {})['cost'], 'NOT CONTROLLED / NOT MEASURED');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// F. État, contrôle, curseur
// ==========================================================================

test('29–34 · le run reste exactement où il était, sous autorité humaine', async () => {
  for (const origin of ['PAUSED', 'WAITING_HUMAN'] as readonly RunState[]) {
    const dir = await makeTempDir('ccr-2c-state-');
    try {
      const h = harness(path.join(dir, 'runs'));
      const runId = await suspendedRun(h, dir, { state: origin });
      const paths = runPaths(h.runsDir, runId);
      const before = await readPersistedState(paths);
      if (before.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
      assert.equal(before.document.control, 'HUMAN', '31 · contrôle humain avant');

      const result = await handoffNativeExpert(h.deps, runId, expertSlotTarget('challenger'));

      // 29–30 · l'état d'origine est conservé, sans normalisation.
      assert.equal(result.state.state, origin, `${origin} → ${origin}`);
      // 31 · le handoff ne rend jamais la main à l'automatisation.
      assert.equal(result.state.control, 'HUMAN');
      // 32–33 · ni curseur, ni round.
      assert.equal(result.state.next_step_source_slot, before.document.next_step_source_slot);
      assert.equal(result.state.round, before.document.round);

      // Le manifest est intact : aucun rebind, aucune session créée.
      const manifest = await readPersistedManifest(paths);
      if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
      assert.equal(manifest.manifest.experts.author.session_id, 'codex-1');
      assert.equal(manifest.manifest.experts.challenger.session_id, 'claude-1');

      // 34 · aucun artefact de round.
      assert.equal((await readdir(paths.roundsDir)).length, 0);
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// G. Échec
// ==========================================================================

test('35–37 · un échec de lancement est déterministe, unique, et non destructif', async () => {
  const dir = await makeTempDir('ccr-2c-failure-');
  try {
    const h = harness(path.join(dir, 'runs'), {
      failInteractive: () => new CcrError('PROCESS_LAUNCH_FAILED', 'le client interactif n’a pas démarré'),
    });
    const runId = await suspendedRun(h, dir);
    const paths = runPaths(h.runsDir, runId);

    await expectRejection(
      handoffNativeExpert(h.deps, runId, expertSlotTarget('challenger')),
      'PROCESS_LAUNCH_FAILED',
      'échec déterministe',
    );

    // 35 · une seule tentative, aucun retry.
    assert.equal(h.interactives.length, 1);

    const events = await journal(h.runsDir, runId);
    const failure = events.find((event) => event.type === 'process_failed');
    assert.ok(failure !== undefined, 'l’échec est journalisé');
    assert.equal(field(failure, 'target_expert_slot_id'), 'challenger');
    assert.deepEqual(failure.based_on, [
      events.find((event) => event.type === 'human_handoff_started')?.event_id,
    ]);
    assert.equal((failure.details ?? {})['phase'], 'handoff');

    // 37 · aucune fin n'est prétendue : il n'y a pas eu d'interaction.
    assert.equal(events.filter((event) => event.type === 'human_handoff_finished').length, 0);

    // 36 · contexte libéré, run intact sous contrôle humain.
    const state = await readPersistedState(paths);
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(state.document.pending_operation, null);
    assert.equal(state.document.active_expert_slot, null);
    assert.equal(state.document.state, 'PAUSED', 'un échec de lancement n’altère pas le run');
    assert.equal(state.document.control, 'HUMAN');
    assert.equal(state.document.round, 0);
    assert.equal(state.document.next_step_source_slot, 'author');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// H. Legacy
// ==========================================================================

test('38 · un run historique est refusé, sans écriture ni lancement', async () => {
  const dir = await makeTempDir('ccr-2c-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    const h = harness(runsDir);
    const legacy = await startRun(h.deps, {
      title: 'legacy',
      cwd: dir,
      prompt: MISSION,
      runtimeConfig: TEST_RUNTIME_CONFIG,
    });
    const paths = runPaths(runsDir, legacy.runId);
    const before = await snapshot(paths);

    await expectRejection(
      handoffNativeExpert(h.deps, legacy.runId, expertSlotTarget('challenger')),
      'SCHEMA_VERSION_UNSUPPORTED',
      'génération historique',
    );
    assert.deepEqual(await snapshot(paths), before, 'le run historique est intact');
    assert.equal(h.interactives.length, 0, 'aucun lancement interactif');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// I. Fenêtres réservées à 2C-R
// ==========================================================================

test('les fenêtres H0 → H3 sont produites et lisibles, sans être interprétées', async () => {
  const dir = await makeTempDir('ccr-2c-windows-');
  try {
    const windows: Record<string, { started: boolean; finished: boolean; pending: string | undefined }> = {};
    let paths = runPaths(path.join(dir, 'runs'), 'placeholder');

    const observe = async (name: string): Promise<void> => {
      const state = await readPersistedState(paths);
      const events = await readFile(paths.events, 'utf8');
      windows[name] = {
        started: events.includes('"human_handoff_started"'),
        finished: events.includes('"human_handoff_finished"'),
        pending:
          state.execution_mode === 'NATIVE_V21_EXECUTION'
            ? state.document.pending_operation?.kind
            : undefined,
      };
    };

    const h = harness(path.join(dir, 'runs'));
    const runId = await suspendedRun(h, dir);
    paths = runPaths(h.runsDir, runId);

    await handoffNativeExpert(h.deps, runId, expertSlotTarget('author'), {
      afterStartedJournaled: () => observe('H0'),
      afterPendingPersisted: () => observe('H1'),
      afterFinishedJournaled: () => observe('H2'),
    });
    await observe('H3');

    // H0 · ouverture durable, aucun contexte : le client n'a certainement pas
    // été lancé. C'est l'ordre d'écriture qui le prouve, et rien d'autre.
    assert.deepEqual(windows['H0'], { started: true, finished: false, pending: undefined });
    // H1 · contexte durable, aucune fin : l'issue est inconnue.
    assert.deepEqual(windows['H1'], { started: true, finished: false, pending: 'handoff' });
    // H2 · fin durable, contexte encore engagé : finalisation locale restante.
    assert.deepEqual(windows['H2'], { started: true, finished: true, pending: 'handoff' });
    // H3 · complet.
    assert.deepEqual(windows['H3'], { started: true, finished: true, pending: undefined });
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// I. Frontière déterministe avant lancement
// ==========================================================================

test('A · une construction d’adapter en échec est terminalisée, pas laissée en suspens', async () => {
  const dir = await makeTempDir('ccr-2c-factory-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const runId = await suspendedRun(h, dir);
    const paths = runPaths(h.runsDir, runId);
    const before = await readPersistedState(paths);
    if (before.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');

    // Défaillance **locale**, antérieure à tout lancement : exécutable
    // introuvable, snapshot runtime absent, fabrique en panne.
    const broken: RunServiceDeps = {
      ...h.deps,
      createAdapters: () => {
        throw new CcrError('AGENT_EXECUTABLE_UNRESOLVED', 'aucun exécutable claude résolu');
      },
    };

    await expectRejection(
      handoffNativeExpert(broken, runId, expertSlotTarget('challenger')),
      'AGENT_EXECUTABLE_UNRESOLVED',
      'échec déterministe pré-lancement',
    );

    // Aucun client interactif n'a été approché.
    assert.equal(h.interactives.length, 0);

    const events = await journal(h.runsDir, runId);
    const started = events.find((event) => event.type === 'human_handoff_started');
    const failure = events.find((event) => event.type === 'process_failed');
    assert.ok(started !== undefined, 'l’ouverture est durable');
    assert.ok(failure !== undefined, 'un fait terminal la conclut');
    assert.deepEqual(failure.based_on, [started.event_id], 'causalité explicite');
    assert.equal(field(failure, 'target_expert_slot_id'), 'challenger');
    assert.equal((failure.details ?? {})['phase'], 'handoff');
    assert.equal((failure.details ?? {})['code'], 'AGENT_EXECUTABLE_UNRESOLVED');
    assert.equal(events.filter((event) => event.type === 'human_handoff_finished').length, 0);

    // Contexte libéré, run intact : un échec local n'altère pas le run.
    const after = await readPersistedState(paths);
    if (after.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(after.document.pending_operation, null);
    assert.equal(after.document.active_expert_slot, null);
    assert.equal(after.document.state, before.document.state);
    assert.equal(after.document.control, 'HUMAN');
    assert.equal(after.document.round, before.document.round);
    assert.equal(after.document.next_step_source_slot, before.document.next_step_source_slot);
  } finally {
    await removeTempDir(dir);
  }
});

