/**
 * Slice 2B — Native SEND Execution.
 *
 * `send` n'est pas un transfert. Trois propriétés le prouvent :
 *
 *   1. c'est la session de la cible qui est reprise, choisie par slot — en
 *      same-provider, le même adapter sert les deux experts ;
 *   2. le run revient exactement là où le contrat V2 le prévoit, et le
 *      propriétaire du contrôle n'est jamais touché par un succès ;
 *   3. ni curseur, ni `state.round`, ni `rounds/` ne bougent — mais la réponse
 *      reste une `assistant_response` ordinaire, que le planificateur peut
 *      retenir comme n'importe quelle autre.
 *
 * Aucun fournisseur réel : tous les adapters sont des fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import { classifyRunLiveness } from '../../src/core/run-liveness.ts';
import type { RunManifest, RunStateDocument } from '../../src/core/run.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { RunState } from '../../src/core/state.ts';
import { DEFAULT_NATIVE_BINDINGS, startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings } from '../../src/services/native-start-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import { planNativeStepForRun } from '../../src/services/native-step-planner.ts';
import {
  expertSlotTarget,
  providerAliasTarget,
} from '../../src/services/native-target-resolver.ts';
import { startRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readJsonFile } from '../../src/store/atomic-file.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import {
  persistNativeStateUpdate,
  readPersistedManifest,
  readPersistedState,
} from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';
const MESSAGE = 'Précise ton troisième argument, il me paraît fragile.';

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
  /** Sessions réellement reprises, dans l'ordre. */
  resumes(): readonly { provider: ProviderKind; sessionId: string; prompt: string }[];
  starts(): readonly ProviderKind[];
}

interface HarnessOptions {
  readonly claudeSessions?: readonly string[];
  readonly codexSessions?: readonly string[];
  readonly failResume?: () => unknown;
  readonly resumeSessionId?: string;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  // Journal chronologique **commun aux deux adapters** : lire les appels
  // adapter par adapter donnerait un ordre par moteur, ce qui masquerait
  // précisément la propriété à prouver — l'ordre vient des slots.
  const calls: { provider: ProviderKind; phase: 'start' | 'resume'; sessionId: string; prompt: string }[] = [];

  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds:
        (kind === 'claude' ? options.claudeSessions : options.codexSessions) ?? [`${kind}-1`, `${kind}-2`],
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
      ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
      onCall: (phase, prompt) => {
        const last = adapters[kind].calls[adapters[kind].calls.length - 1];
        calls.push({ provider: kind, phase, sessionId: last?.sessionId ?? '', prompt });
      },
    });
  const adapters = { claude: build('claude'), codex: build('codex') };

  return {
    runsDir,
    adapters,
    resumes: () =>
      calls
        .filter((call) => call.phase === 'resume')
        .map((call) => ({ provider: call.provider, sessionId: call.sessionId, prompt: call.prompt })),
    starts: () => calls.filter((call) => call.phase === 'start').map((call) => call.provider),
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

async function startedRun(h: Harness, dir: string, bindings?: NativeExpertBindings): Promise<string> {
  const result = await startNativeRun(h.deps, {
    title: 'T',
    cwd: dir,
    prompt: MISSION,
    ...(bindings === undefined ? {} : { bindings }),
    runtimeConfig: nativeRuntime(),
  });
  assert.equal(result.failure, undefined);
  return result.runId;
}

async function journal(runsDir: string, runId: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

/** Place un run natif dans un état donné, sans passer par un chemin métier. */
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

// ==========================================================================
// A. Cibles canoniques
// ==========================================================================

test('A1–A4 · un envoi reprend la session du slot visé, et rien d’autre', async () => {
  for (const bindings of [
    { author: 'codex', challenger: 'claude' },
    { author: 'claude', challenger: 'codex' },
  ] as readonly NativeExpertBindings[]) {
    const dir = await makeTempDir('ccr-2b-canonical-');
    try {
      const h = harness(path.join(dir, 'runs'));
      const runId = await startedRun(h, dir, bindings);
      const startsAfterInit = h.starts().length;

      for (const slot of ['author', 'challenger'] as const) {
        const result = await sendNativeMessage(h.deps, runId, expertSlotTarget(slot), `${MESSAGE} (${slot})`);
        assert.equal(result.expertSlot, slot);
        assert.equal(result.provider, bindings[slot]);
      }

      assert.deepEqual(
        h.resumes().map((call) => [call.provider, call.sessionId]),
        [
          [bindings.author, `${bindings.author}-1`],
          [bindings.challenger, `${bindings.challenger}-${bindings.author === bindings.challenger ? '2' : '1'}`],
        ],
        `author=${bindings.author} challenger=${bindings.challenger}`,
      );
      // 4 · un envoi reprend, il ne crée jamais de session.
      assert.equal(h.starts().length, startsAfterInit, 'aucun `start` supplémentaire');
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// B. Same-provider
// ==========================================================================

test('B5–B8 · same-provider : la session vient du slot, jamais du moteur', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const dir = await makeTempDir('ccr-2b-same-');
    try {
      const h = harness(path.join(dir, 'runs'), {
        [`${provider}Sessions`]: ['S1', 'S2'],
      } as HarnessOptions);
      const runId = await startedRun(h, dir, { author: provider, challenger: provider });

      await sendNativeMessage(h.deps, runId, expertSlotTarget('author'), 'à l’auteur');
      await sendNativeMessage(h.deps, runId, expertSlotTarget('challenger'), 'au contradicteur');

      assert.deepEqual(h.resumes().map((call) => call.sessionId), ['S1', 'S2'], `${provider}/${provider}`);
      assert.deepEqual(new Set(h.resumes().map((call) => call.provider)), new Set([provider]));
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// C. Alias
// ==========================================================================

test('C9–C12 · un alias univoque résout, un alias ambigu ou absent refuse sans le moindre effet', async () => {
  const dir = await makeTempDir('ccr-2b-alias-');
  try {
    const runsDir = path.join(dir, 'runs');

    // 9 · configuration mixte : l'alias désigne un seul expert.
    const mixed = harness(runsDir);
    const mixedRun = await startedRun(mixed, dir);
    // L'alias visé est celui du moteur qui porte le CHALLENGER.
    const challengerProvider = DEFAULT_NATIVE_BINDINGS.challenger;
    const viaAlias = await sendNativeMessage(
      mixed.deps,
      mixedRun,
      providerAliasTarget(challengerProvider),
      MESSAGE,
    );
    assert.equal(viaAlias.expertSlot, 'challenger');
    assert.deepEqual(mixed.resumes().map((call) => call.sessionId), [`${challengerProvider}-1`]);

    // 10–11 · same-provider : les deux alias échouent, pour deux raisons.
    const same = harness(runsDir, { claudeSessions: ['S1', 'S2'] });
    const sameRun = await startedRun(same, dir, { author: 'claude', challenger: 'claude' });
    const paths = runPaths(runsDir, sameRun);
    const before = {
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
    };
    const resumesBefore = same.resumes().length;

    await expectRejection(
      sendNativeMessage(same.deps, sameRun, providerAliasTarget('claude'), MESSAGE),
      'AMBIGUOUS_PROVIDER_ALIAS',
      'alias ambigu',
    );
    await expectRejection(
      sendNativeMessage(same.deps, sameRun, providerAliasTarget('codex'), MESSAGE),
      'PROVIDER_ALIAS_NOT_BOUND',
      'alias non lié',
    );

    assert.deepEqual(
      { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') },
      before,
      'aucun événement, aucune mutation',
    );
    assert.equal(same.resumes().length, resumesBefore, 'aucun appel fournisseur');

    // 12 · la cible canonique reste parfaitement utilisable.
    const canonical = await sendNativeMessage(same.deps, sameRun, expertSlotTarget('challenger'), MESSAGE);
    assert.equal(canonical.sessionId, 'S2');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. État d'origine et contrôle
// ==========================================================================

test('D13–D14 · le run revient là où le contrat V2 le prévoit, sans toucher au contrôle', async () => {
  for (const [origin, control, expected] of [
    ['READY', 'AUTOMATION', 'READY'],
    ['PAUSED', 'HUMAN', 'PAUSED'],
    ['WAITING_HUMAN', 'HUMAN', 'WAITING_HUMAN'],
    // Fait inspecté, repris tel quel : un envoi depuis RUNNING rend le run
    // READY. Ce n'est pas « l'origine » au sens littéral, et la règle V2 est
    // conservée plutôt que corrigée.
    ['RUNNING', 'AUTOMATION', 'READY'],
  ] as readonly (readonly [RunState, 'AUTOMATION' | 'HUMAN', RunState])[]) {
    const dir = await makeTempDir('ccr-2b-origin-');
    try {
      const h = harness(path.join(dir, 'runs'));
      const runId = await startedRun(h, dir);
      await forceState(h.runsDir, runId, { state: origin, control });

      const result = await sendNativeMessage(h.deps, runId, expertSlotTarget('challenger'), MESSAGE);

      assert.equal(result.state.state, expected, `${origin} → ${expected}`);
      assert.equal(result.state.control, control, `${origin} · contrôle inchangé`);
      assert.equal(result.state.pending_operation, null);
      assert.equal(result.state.active_expert_slot, null);

      const persisted = await readPersistedState(runPaths(h.runsDir, runId));
      assert.equal(persisted.document.state, expected, 'état relu depuis le disque');
      assert.equal(persisted.document.control, control);
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// E. Frontières durables
// ==========================================================================

test('E15–E19 · le contexte est durable avant l’appel, et le reste après la réponse', async () => {
  const dir = await makeTempDir('ccr-2b-durable-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const runId = await startedRun(h, dir);
    await forceState(h.runsDir, runId, { state: 'PAUSED', control: 'HUMAN' });
    const paths = runPaths(h.runsDir, runId);

    const readState = async (): Promise<Record<string, unknown>> =>
      (await readJsonFile(paths.state)) as Record<string, unknown>;

    // 15–17 · observation pendant l'appel.
    let during: Record<string, unknown> | undefined;
    let journalDuring = '';
    // La cible de cet envoi est le CHALLENGER : c'est son adaptateur qui est
    // instrumenté, quel que soit le moteur qui porte ce rôle.
    const targetAdapter = h.adapters[DEFAULT_NATIVE_BINDINGS.challenger];
    const original = targetAdapter.resume.bind(targetAdapter);
    (targetAdapter as { resume: typeof targetAdapter.resume }).resume = async (session, prompt) => {
      during = await readState();
      journalDuring = await readFile(paths.events, 'utf8');
      return original(session, prompt);
    };

    // 18 · observation après la réponse, avant la restauration.
    let afterResponse: Record<string, unknown> | undefined;
    const result = await sendNativeMessage(h.deps, runId, expertSlotTarget('challenger'), MESSAGE, {
      afterResponseJournaled: async () => {
        afterResponse = await readState();
      },
    });

    assert.ok(during !== undefined && afterResponse !== undefined);
    assert.ok(journalDuring.includes('"human_message"'), '15 · le message est durable avant l’appel');
    assert.equal(journalDuring.includes('"assistant_response"') && journalDuring.split('"assistant_response"').length > 3, false);

    assert.equal(during['state'], 'WAITING_AGENT');
    assert.equal(during['active_expert_slot'], 'challenger');
    const pendingDuring = during['pending_operation'] as Record<string, unknown>;
    assert.equal(pendingDuring['kind'], 'send', '16 · contexte durable avant l’appel');
    assert.equal(pendingDuring['expert_slot'], 'challenger');
    assert.equal(pendingDuring['session_id'], `${DEFAULT_NATIVE_BINDINGS.challenger}-1`);
    assert.equal(pendingDuring['return_state'], 'PAUSED', 'l’état à restaurer est durable');
    assert.equal(during['round'], 0, '17 · round intact');
    assert.equal(during['next_step_source_slot'], 'author', '17 · curseur intact');

    const pendingAfter = afterResponse['pending_operation'] as Record<string, unknown> | null;
    assert.ok(pendingAfter !== null, '18 · le contexte survit à la réponse');
    assert.equal(pendingAfter?.['prompt_event_id'], result.promptEventId);
    assert.equal(afterResponse['round'], 0);
    assert.equal(afterResponse['next_step_source_slot'], 'author');

    // 19 · après le commit.
    const committed = await readState();
    assert.equal(committed['pending_operation'], null);
    assert.equal(committed['active_expert_slot'], null);
    assert.equal(committed['state'], 'PAUSED');
    assert.equal(committed['control'], 'HUMAN');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// F. Événements · G. Curseur et round
// ==========================================================================

test('F20–F23 · G24–G26 · provenance native, causalité récupérable, rien qui bouge ailleurs', async () => {
  const dir = await makeTempDir('ccr-2b-events-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const runId = await startedRun(h, dir);
    const paths = runPaths(h.runsDir, runId);
    const before = await journal(h.runsDir, runId);
    const stateBefore = await readPersistedState(paths);

    const result = await sendNativeMessage(h.deps, runId, expertSlotTarget('challenger'), MESSAGE);
    const fresh = (await journal(h.runsDir, runId)).slice(before.length);

    // 20 · le message humain nomme son destinataire par son slot.
    const humanMessage = fresh.find((event) => event.type === 'human_message');
    assert.equal((humanMessage as { target_expert_slot_id?: ExpertSlotId })?.target_expert_slot_id, 'challenger');
    assert.equal(humanMessage?.actor, 'human');
    assert.equal(humanMessage?.content, MESSAGE);
    // 5 · ce n'est pas une enveloppe de transfert.
    for (const marker of ['SOURCE_EXPERT', 'TARGET_EXPERT', 'SOURCE_EVENT_ID', 'BEGIN ORIGINAL RESPONSE']) {
      assert.equal(String(humanMessage?.content).includes(marker), false, `${marker} absent`);
    }

    // 21 · la réponse porte son slot et sa session.
    const response = fresh.find((event) => event.type === 'assistant_response');
    assert.equal((response as { expert_slot_id?: ExpertSlotId })?.expert_slot_id, 'challenger');
    assert.equal(
      (response as { session_id?: string })?.session_id,
      `${DEFAULT_NATIVE_BINDINGS.challenger}-1`,
    );
    assert.equal(response?.actor, 'expert');

    // 23 · la causalité message → réponse est récupérable, et unique.
    assert.deepEqual(response?.based_on, [result.promptEventId]);

    // 22 · aucune identité fournisseur, sur le fichier lui-même.
    const raw = await readFile(paths.events, 'utf8');
    for (const forbidden of ['"actor":"claude"', '"actor":"codex"', '"target":"claude"', '"target":"codex"']) {
      assert.equal(raw.includes(forbidden), false, `${forbidden} absent`);
    }

    // 24–26 · rien d'un transfert : ni curseur, ni round, ni artefact.
    const stateAfter = await readPersistedState(paths);
    assert.equal(stateAfter.document.round, stateBefore.document.round);
    assert.equal(
      (stateAfter.document as { next_step_source_slot?: unknown }).next_step_source_slot,
      (stateBefore.document as { next_step_source_slot?: unknown }).next_step_source_slot,
    );
    assert.deepEqual(await readdir(paths.roundsDir), []);
    for (const type of ['round_started', 'round_completed', 'transfer_blocked', 'transfer_uncertainty_acknowledged']) {
      assert.equal(fresh.some((event) => event.type === type), false, `${type} absent`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// H. Interaction avec le planificateur
// ==========================================================================

test('H27–H28 · la réponse d’un envoi est une réponse ordinaire, et le curseur ne bouge pas', async () => {
  const dir = await makeTempDir('ccr-2b-planner-');
  try {
    const runsDir = path.join(dir, 'runs');

    // 27 · envoi vers le slot désigné par le curseur : sa réponse devient la
    // candidate naturelle du prochain transfert.
    const toCursor = harness(runsDir);
    const cursorRun = await startedRun(toCursor, dir);
    const sent = await sendNativeMessage(toCursor.deps, cursorRun, expertSlotTarget('author'), MESSAGE);
    const planAfter = await planNativeStepForRun(toCursor.deps, cursorRun);
    assert.equal(planAfter.kind, 'READY');
    if (planAfter.kind !== 'READY') return;
    assert.equal(planAfter.sourceSlot, 'author', 'le curseur n’a pas bougé');
    assert.equal(planAfter.sourceEventId, sent.responseEventId, 'la réponse de l’envoi est la source');

    // 28 · envoi vers l'autre slot : le curseur ne bouge pas non plus, et la
    // source reste celle du slot attendu.
    const toOther = harness(runsDir);
    const otherRun = await startedRun(toOther, dir);
    const planBefore = await planNativeStepForRun(toOther.deps, otherRun);
    assert.equal(planBefore.kind, 'READY');
    if (planBefore.kind !== 'READY') return;

    await sendNativeMessage(toOther.deps, otherRun, expertSlotTarget('challenger'), MESSAGE);
    const planAfterOther = await planNativeStepForRun(toOther.deps, otherRun);
    assert.equal(planAfterOther.kind, 'READY');
    if (planAfterOther.kind !== 'READY') return;
    assert.equal(planAfterOther.sourceSlot, 'author');
    assert.equal(
      planAfterOther.sourceEventId,
      planBefore.sourceEventId,
      'la source du slot attendu est inchangée',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// I. Échecs
// ==========================================================================

test('I29–I32 · un échec est déterministe, sans retry et sans ambiguïté résiduelle', async () => {
  const dir = await makeTempDir('ccr-2b-failure-');
  try {
    const runsDir = path.join(dir, 'runs');

    // 29–30 · échec d'adapter : une tentative, contexte libéré.
    let attempts = 0;
    const failing = harness(runsDir, {
      failResume: () => {
        attempts += 1;
        return new CcrError('AGENT_TIMEOUT', 'le tour a expiré');
      },
    });
    const failingRun = await startedRun(failing, dir);
    const failingPaths = runPaths(runsDir, failingRun);

    await expectRejection(
      sendNativeMessage(failing.deps, failingRun, expertSlotTarget('challenger'), MESSAGE),
      'AGENT_TIMEOUT',
      'échec de l’envoi',
    );
    assert.equal(attempts, 1, 'une seule tentative');

    const failedState = await readPersistedState(failingPaths);
    assert.equal(failedState.document.state, 'PAUSED');
    assert.equal(failedState.document.control, 'HUMAN', 'comportement V2 conservé');
    assert.equal(
      failedState.document.pending_operation,
      null,
      'un échec conclu ne laisse aucune opération engagée',
    );
    assert.equal(failedState.document.round, 0);
    const failedEvents = await journal(runsDir, failingRun);
    const failure = failedEvents.find((event) => event.type === 'process_failed');
    assert.equal((failure as { target_expert_slot_id?: ExpertSlotId })?.target_expert_slot_id, 'challenger');
    assert.equal(failedEvents.filter((event) => event.type === 'assistant_response').length, 2, 'seules les deux positions initiales');

    // 31–32 · session dérivée : échec fermé.
    const drifting = harness(runsDir, { resumeSessionId: 'claude-autre' });
    const driftingRun = await startedRun(drifting, dir);
    const driftingPaths = runPaths(runsDir, driftingRun);
    const beforeDrift = await journal(runsDir, driftingRun);

    await expectRejection(
      sendNativeMessage(drifting.deps, driftingRun, expertSlotTarget('challenger'), MESSAGE),
      'AGENT_SESSION_MISMATCH',
      'session dérivée',
    );

    const driftFresh = (await journal(runsDir, driftingRun)).slice(beforeDrift.length);
    assert.equal(
      driftFresh.filter((event) => event.type === 'assistant_response').length,
      0,
      'aucune réponse attribuée à une session étrangère',
    );
    const driftState = await readPersistedState(driftingPaths);
    assert.equal(driftState.document.state, 'FAILED', 'invariant brisé : règle V2');
    assert.equal(driftState.document.round, 0);
    assert.equal(
      (driftState.document as { next_step_source_slot?: unknown }).next_step_source_slot,
      'author',
    );
    assert.deepEqual(await readdir(driftingPaths.roundsDir), []);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// J. Legacy
// ==========================================================================

test('J33 · un run historique est refusé sans la moindre écriture', async () => {
  const dir = await makeTempDir('ccr-2b-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    const adapters = {
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
    };
    const deps: RunServiceDeps = {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => adapters,
    };
    const started = await startRun(deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'T',
      cwd: dir,
      prompt: MISSION,
    });
    const paths = runPaths(runsDir, started.runId);
    const before = {
      manifest: await readFile(paths.manifest, 'utf8'),
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
    };

    for (const ref of [expertSlotTarget('author'), providerAliasTarget('claude')]) {
      await expectRejection(
        sendNativeMessage(deps, started.runId, ref, MESSAGE),
        'SCHEMA_VERSION_UNSUPPORTED',
        'run historique refusé',
      );
    }

    assert.deepEqual(
      {
        manifest: await readFile(paths.manifest, 'utf8'),
        state: await readFile(paths.state, 'utf8'),
        events: await readFile(paths.events, 'utf8'),
      },
      before,
      'aucune écriture native sur un run historique',
    );
    assert.equal(adapters.claude.calls.filter((call) => call.phase === 'resume').length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Réparation d'ordre durable, après le micro-gate 2B.1
// ==========================================================================

/**
 * Projection legacy d'un run natif, pour interroger `classifyRunLiveness`.
 *
 * Le classifieur de vivacité est celui de V2 : il lit `manifest.agents` et
 * `state.state`. Aucun read model natif n'existe encore — c'est hors périmètre
 * — mais la règle qu'il porte est la réponse canonique du projet à « que
 * signifie cet état ? ». La projection est fidèle sur les deux seuls faits
 * qu'il consulte ici : l'état, et le nombre de sessions présentes.
 */
function livenessProjection(
  sessionsPresent: number,
  state: RunStateDocument['state'],
): { manifest: RunManifest; state: RunStateDocument; pendingResponseJournaled: boolean } {
  return {
    manifest: {
      schema_version: 1,
      run_id: 'CCR-20260811-001',
      title: 'T',
      created_at: AT,
      workspace: { cwd: 'E:/prog/exemple' },
      agents: {
        claude: { session_id: sessionsPresent >= 1 ? 'claude-1' : null, role: 'challenger' },
        codex: { session_id: sessionsPresent >= 2 ? 'codex-1' : null, role: 'author' },
      },
    },
    state: {
      schema_version: 2,
      run_id: 'CCR-20260811-001',
      state,
      control: 'HUMAN',
      round: 0,
      active_agent: null,
      last_event_id: null,
      pending_operation: null,
      uncertainty: null,
      updated_at: AT,
    },
    pendingResponseJournaled: false,
  };
}

test('2B.1 · aucune mutation d’état ne précède `human_message`, quelle que soit l’origine', async () => {
  for (const [origin, control] of [
    ['READY', 'AUTOMATION'],
    ['RUNNING', 'AUTOMATION'],
    ['PAUSED', 'HUMAN'],
    ['WAITING_HUMAN', 'HUMAN'],
  ] as readonly (readonly [RunState, 'AUTOMATION' | 'HUMAN'])[]) {
    const dir = await makeTempDir('ccr-2b1-order-');
    try {
      const h = harness(path.join(dir, 'runs'));
      const runId = await startedRun(h, dir);
      await forceState(h.runsDir, runId, { state: origin, control });
      const paths = runPaths(h.runsDir, runId);

      const stateBefore = await readFile(paths.state, 'utf8');
      let stateAtMessage = '';
      let journalAtMessage = '';
      let resumesAtMessage = -1;
      let stateAfterTransition: Record<string, unknown> | undefined;
      let resumesAfterTransition = -1;

      await sendNativeMessage(h.deps, runId, expertSlotTarget('challenger'), MESSAGE, {
        afterHumanMessageJournaled: async () => {
          stateAtMessage = await readFile(paths.state, 'utf8');
          journalAtMessage = await readFile(paths.events, 'utf8');
          resumesAtMessage = h.resumes().length;
        },
        afterTransientStatePersisted: async () => {
          stateAfterTransition = (await readJsonFile(paths.state)) as Record<string, unknown>;
          resumesAfterTransition = h.resumes().length;
        },
      });

      // 1–3 · 8–9 · le message est durable, et l'état n'a pas bougé d'un octet.
      assert.ok(journalAtMessage.includes('"human_message"'), `${origin} · message durable`);
      assert.equal(stateAtMessage, stateBefore, `${origin} · aucune mutation avant le message`);
      const observed = JSON.parse(stateAtMessage) as Record<string, unknown>;
      assert.equal(observed['state'], origin, `${origin} · l’origine réelle reste lisible`);
      assert.equal(observed['pending_operation'], null);
      assert.equal(resumesAtMessage, 0, `${origin} · aucun fournisseur engagé`);

      const humanOrigin = origin === 'PAUSED' || origin === 'WAITING_HUMAN';
      if (humanOrigin) {
        // Aucune transition transitoire : le seam n'est jamais appelé.
        assert.equal(stateAfterTransition, undefined, `${origin} · aucune transition intermédiaire`);
      } else {
        // 6 · la fenêtre pré-provider est désormais identifiable : le message
        // nomme l'envoi, le contexte n'existe pas encore, rien n'a été appelé.
        assert.ok(stateAfterTransition !== undefined, `${origin} · transition observée`);
        assert.equal(stateAfterTransition?.['state'], 'RUNNING');
        assert.equal(stateAfterTransition?.['pending_operation'], null);
        assert.equal(resumesAfterTransition, 0, `${origin} · toujours aucun fournisseur`);
      }

      // 7 · le fournisseur n'a été engagé qu'après le contexte de reprise.
      assert.equal(h.resumes().length, 1, `${origin} · un seul appel, après le pending`);
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('2B.1 · un envoi n’efface plus le signalement d’une initialisation partielle', async () => {
  const dir = await makeTempDir('ccr-2b1-partial-');
  try {
    const h = harness(path.join(dir, 'runs'));
    // Le challenger échoue à l'initialisation : une seule session liée.
    const failingProvider = DEFAULT_NATIVE_BINDINGS.challenger;
    const failing = createFakeAdapter({
      kind: failingProvider,
      failStart: () => new CcrError('AGENT_TIMEOUT', 'échec du challenger'),
    });
    const adapters = (): AgentAdapters => ({
      claude: failingProvider === 'claude' ? failing : h.adapters.claude,
      codex: failingProvider === 'codex' ? failing : h.adapters.codex,
    });
    const deps: RunServiceDeps = { ...h.deps, createAdapters: adapters };

    const started = await startNativeRun(deps, {
      title: 'T',
      cwd: dir,
      prompt: MISSION,
      runtimeConfig: nativeRuntime(),
    });
    assert.equal(started.failure?.slot, 'challenger');

    const paths = runPaths(h.runsDir, started.runId);
    const before = await readPersistedState(paths);
    if (before.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(before.document.state, 'FAILED_INITIALIZATION');

    // 4 · avant l'envoi, le run est signalé comme partiellement initialisé.
    assert.equal(
      classifyRunLiveness(livenessProjection(1, 'FAILED_INITIALIZATION')).liveness,
      'PARTIAL_INITIALIZATION',
    );

    // 5 · et il l'est encore juste après `human_message`, avant la transition.
    let atMessage: Record<string, unknown> | undefined;
    await sendNativeMessage(deps, started.runId, expertSlotTarget('author'), MESSAGE, {
      afterHumanMessageJournaled: async () => {
        atMessage = (await readJsonFile(paths.state)) as Record<string, unknown>;
      },
    });

    assert.equal(atMessage?.['state'], 'FAILED_INITIALIZATION', 'l’étiquette d’échec survit au message');
    assert.equal(atMessage?.['pending_operation'], null);
    assert.equal(
      classifyRunLiveness(livenessProjection(1, atMessage?.['state'] as RunStateDocument['state'])).liveness,
      'PARTIAL_INITIALIZATION',
      'le signalement n’est plus effacé avant même le travail transitoire',
    );

    // B1 · divergence native, décidée au Slice 2B-R : un envoi réussi rend le
    // run **là où il l'a pris**. V2 le rendait `READY`, ce qui revenait à
    // déclarer l'initialisation terminée parce qu'un expert déjà joignable
    // avait répondu — alors que la session de l'autre manque toujours.
    const after = await readPersistedState(paths);
    if (after.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(after.document.state, 'FAILED_INITIALIZATION', 'send ne complète pas une initialisation');
    assert.equal(after.document.control, before.document.control, 'contrôle inchangé au succès');
    assert.equal(after.document.round, before.document.round, 'round inchangé');
    assert.equal(
      after.document.next_step_source_slot,
      before.document.next_step_source_slot,
      'curseur inchangé',
    );
    assert.equal(after.document.pending_operation, null);
    assert.equal(after.document.active_expert_slot, null);

    const manifest = await readPersistedManifest(paths);
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(manifest.manifest.experts.challenger.session_id, null, 'la session manquante le reste');
    assert.equal(
      classifyRunLiveness(livenessProjection(1, after.document.state)).liveness,
      'PARTIAL_INITIALIZATION',
      'le signalement survit à un envoi réussi',
    );
  } finally {
    await removeTempDir(dir);
  }
});
