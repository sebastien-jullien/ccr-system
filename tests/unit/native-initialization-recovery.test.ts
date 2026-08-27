/**
 * Slice 1D — Native Initialization Recovery & Crash Reconciliation.
 *
 * Un `session_id` absent n'a pas une cause : il en a plusieurs, et confondre
 * « le fournisseur n'a jamais répondu » avec « CCR est mort avant d'écrire »
 * conduit à rappeler un fournisseur qui a déjà répondu. Ce fichier éprouve que
 * les cinq fenêtres de crash de l'ordre durable 1C sont distinguées, et que
 * seule la dernière — l'incertitude — exige une décision humaine.
 *
 * Aucun fournisseur réel n'est invoqué.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeRunManifest, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import {
  DEFAULT_NATIVE_BINDINGS,
  startNativeRun,
} from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings } from '../../src/services/native-start-service.ts';
import {
  acknowledgeNativeUncertainty,
  continueNativeInitialization,
  inspectNativeInitialization,
} from '../../src/services/native-recovery-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { startRun } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readJsonFile } from '../../src/store/atomic-file.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import {
  buildInitialNativeState,
  readPersistedManifest,
  readPersistedState,
  writeNativeManifest,
  writeNativeState,
} from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260810-001';
const PROMPT = 'Mission initiale : évaluer la refonte.';
const AT = '2026-08-10T00:00:00.000Z';

function expectCcrCode(error: unknown, code: CcrErrorCode, what: string): void {
  assert.ok(isCcrError(error) && error.code === code, `${what} — reçu ${String(error)}`);
}

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
  readonly calls: { provider: string; prompt: string }[];
}

function harness(runsDir: string, options: { failClaude?: () => unknown; failCodex?: () => unknown; claudeSessions?: readonly string[]; codexSessions?: readonly string[] } = {}): Harness {
  const calls: { provider: string; prompt: string }[] = [];
  const build = (kind: 'claude' | 'codex', sessions: readonly string[] | undefined, fail?: () => unknown): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: sessions ?? [`${kind}-1`, `${kind}-2`],
      onCall: (phase, prompt) => {
        if (phase === 'start') calls.push({ provider: kind, prompt });
      },
      ...(fail === undefined ? {} : { failStart: fail }),
    });
  const adapters = {
    claude: build('claude', options.claudeSessions, options.failClaude),
    codex: build('codex', options.codexSessions, options.failCodex),
  };
  return {
    runsDir,
    adapters,
    calls,
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

// --------------------------------------------------------------------------
// Fabrication des fenêtres de crash
// --------------------------------------------------------------------------
//
// Chaque fenêtre est un **préfixe réel** de l'ordre durable de 1C :
//
//   prompt_sent → WAITING_AGENT+pending → appel → assistant_response
//   → RUNNING → manifest lié → session_created → READY + curseur
//
// Les fixtures écrivent exactement ce préfixe, jamais un état inventé.

interface SlotWindow {
  readonly prompt: boolean;
  readonly response?: string;
  readonly bound?: string;
  readonly created?: string;
}

interface WindowSpec {
  readonly bindings?: NativeExpertBindings;
  readonly author: SlotWindow;
  readonly challenger: SlotWindow;
  readonly state: 'READY' | 'RUNNING' | 'WAITING_AGENT' | 'FAILED_INITIALIZATION';
  readonly cursor?: ExpertSlotId | null;
  readonly pendingSlot?: ExpertSlotId;
  /**
   * Suites **legitimes** d'un run initialise, ecrites exactement comme les
   * services les produisent (repair 1D.2).
   */
  readonly send?: { readonly slot: ExpertSlotId; readonly session: string };
  readonly step?: { readonly source: ExpertSlotId; readonly target: ExpertSlotId; readonly session: string };
  /** Seconde reponse satisfaisant reellement le contrat START : vrai conflit. */
  readonly doubleInitial?: { readonly slot: ExpertSlotId; readonly session: string };
}

async function materializeWindow(runsDir: string, spec: WindowSpec): Promise<string> {
  const bindings = spec.bindings ?? DEFAULT_NATIVE_BINDINGS;
  const paths = runPaths(runsDir, RUN_ID);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(paths.roundsDir, { recursive: true });

  // Manifest sans session : les événements sont journalisés d'abord, comme en 1C.
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
  await writeNativeState(paths, buildInitialNativeState(RUN_ID, 'READY', new Date(AT)));

  const ref = { manifest };
  const events = await openNativeEventStore(paths, () => ref.manifest);
  await events.append({ round: 0, actor: 'system', type: 'run_created', content: 'T', timestamp: AT });

  let lastEventId: string | null = null;
  let promptEventId: string | null = null;

  for (const slot of ['author', 'challenger'] as const) {
    const window = spec[slot];
    if (!window.prompt) continue;
    const prompt = await events.append({
      round: 0,
      actor: 'human',
      type: 'prompt_sent',
      target_expert_slot_id: slot,
      content: PROMPT,
      timestamp: AT,
    });
    lastEventId = prompt.event_id;
    promptEventId = prompt.event_id;

    if (window.response !== undefined) {
      const response = await events.append({
        round: 0,
        actor: 'expert',
        type: 'assistant_response',
        expert_slot_id: slot,
        session_id: window.response,
        content: `réponse ${slot}`,
        based_on: [prompt.event_id],
        timestamp: AT,
      });
      lastEventId = response.event_id;
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
      const created = await events.append({
        round: 0,
        actor: 'system',
        type: 'session_created',
        expert_slot_id: slot,
        session_id: window.created,
        timestamp: AT,
      });
      lastEventId = created.event_id;
    }
  }

  // ---- Suites legitimes. Sequences relues dans le code de production :
  // SEND  native-send-service.ts:178 / 291
  // STEP  native-step-service.ts:163 / 186 / 285 / 308
  if (spec.doubleInitial !== undefined) {
    const prompt = await events.append({
      round: 0,
      actor: 'human',
      type: 'prompt_sent',
      target_expert_slot_id: spec.doubleInitial.slot,
      content: PROMPT,
      timestamp: AT,
    });
    const response = await events.append({
      round: 0,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: spec.doubleInitial.slot,
      session_id: spec.doubleInitial.session,
      content: 'seconde position initiale',
      based_on: [prompt.event_id],
      timestamp: AT,
    });
    lastEventId = response.event_id;
  }

  if (spec.send !== undefined) {
    const message = await events.append({
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: spec.send.slot,
      session_id: spec.send.session,
      content: 'question humaine',
      timestamp: AT,
    });
    const response = await events.append({
      round: 0,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: spec.send.slot,
      session_id: spec.send.session,
      content: 'réponse à la question humaine',
      based_on: [message.event_id],
      timestamp: AT,
    });
    lastEventId = response.event_id;
  }

  if (spec.step !== undefined) {
    const history = await events.readAll();
    const source = history.find(
      (event) =>
        event.type === 'assistant_response' &&
        (event as { expert_slot_id?: string }).expert_slot_id === spec.step?.source,
    );
    const sourceId = source?.event_id ?? '';
    await events.append({
      round: 1,
      actor: 'system',
      type: 'round_started',
      target_expert_slot_id: spec.step.target,
      based_on: [sourceId],
      details: {
        round: 1,
        source_slot: spec.step.source,
        target_slot: spec.step.target,
        source_event_id: sourceId,
      },
      timestamp: AT,
    });
    const prompt = await events.append({
      round: 1,
      actor: 'system',
      type: 'prompt_sent',
      target_expert_slot_id: spec.step.target,
      session_id: spec.step.session,
      content: 'SOURCE_EXPERT: ...',
      based_on: [sourceId],
      timestamp: AT,
    });
    const response = await events.append({
      round: 1,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: spec.step.target,
      session_id: spec.step.session,
      content: 'contre-expertise',
      based_on: [prompt.event_id],
      timestamp: AT,
    });
    const completed = await events.append({
      round: 1,
      actor: 'system',
      type: 'round_completed',
      source_slot_id: spec.step.source,
      target_slot_id: spec.step.target,
      source_event_id: sourceId,
      response_event_id: response.event_id,
      based_on: [sourceId, response.event_id],
      timestamp: AT,
    });
    lastEventId = completed.event_id;
  }

  await writeNativeState(paths, {
    ...buildInitialNativeState(RUN_ID, 'READY', new Date(AT)),
    round: spec.step === undefined ? 0 : 1,
    state: spec.state,
    control: spec.state === 'FAILED_INITIALIZATION' ? 'HUMAN' : 'AUTOMATION',
    next_step_source_slot: spec.cursor ?? null,
    last_event_id: lastEventId,
    active_expert_slot: spec.pendingSlot ?? null,
    pending_operation:
      spec.pendingSlot === undefined
        ? null
        : {
            kind: 'initialization',
            expert_slot: spec.pendingSlot,
            round: 0,
            prompt_event_id: promptEventId,
            session_id: null,
            return_state: 'FAILED_INITIALIZATION',
            return_control: 'AUTOMATION',
            started_at: AT,
          },
  });

  return RUN_ID;
}

// ==========================================================================
// Classification — tests 1 à 8
// ==========================================================================

test('1 · un run complètement initialisé ne demande aucune reprise', async () => {
  const dir = await makeTempDir('ccr-1d-none-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const started = await startNativeRun(h.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      runtimeConfig: nativeRuntime(),
    });
    const view = await inspectNativeInitialization(h.deps, started.runId);
    assert.equal(view.status, 'NONE');
    assert.deepEqual(view.missingSlots, []);
    assert.deepEqual(view.reconcilableSlots, []);
    assert.deepEqual(view.requiredProviders, []);
    assert.equal(view.uncertainSlot, null);
    assert.equal(view.canFinalizeWithoutProvider, false);
    assert.equal(view.canContinueWithProvider, false);
  } finally {
    await removeTempDir(dir);
  }
});

test('2 · W4 — deux slots durables, curseur encore nul', async () => {
  const dir = await makeTempDir('ccr-1d-w4-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeWindow(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true, response: 'claude-1', bound: 'claude-1', created: 'claude-1' },
      state: 'RUNNING',
      cursor: null,
    });
    const h = harness(runsDir);
    const view = await inspectNativeInitialization(h.deps, RUN_ID);
    assert.equal(view.status, 'COMPLETE_NEEDS_FINALIZATION');
    assert.equal(view.canFinalizeWithoutProvider, true);
    assert.deepEqual(view.missingSlots, []);
  } finally {
    await removeTempDir(dir);
  }
});

test('3 · W2 — réponse durable, manifest pas encore lié', async () => {
  const dir = await makeTempDir('ccr-1d-w2-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeWindow(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true, response: 'claude-1' },
      state: 'RUNNING',
    });
    const h = harness(runsDir);
    const view = await inspectNativeInitialization(h.deps, RUN_ID);
    assert.equal(view.status, 'RECONCILABLE_DURABLE_RESPONSE');
    assert.deepEqual(view.reconcilableSlots, ['challenger']);
    // L'identité est déjà connue : aucun fournisseur n'est requis.
    assert.deepEqual(view.missingSlots, []);
    assert.deepEqual(view.requiredProviders, []);
  } finally {
    await removeTempDir(dir);
  }
});

test('4 · W3 — session liée, `session_created` absent', async () => {
  const dir = await makeTempDir('ccr-1d-w3-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeWindow(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true, response: 'claude-1', bound: 'claude-1' },
      state: 'RUNNING',
    });
    const h = harness(runsDir);
    const view = await inspectNativeInitialization(h.deps, RUN_ID);
    assert.equal(view.status, 'LINKED_NEEDS_FINALIZATION');
    assert.deepEqual(view.reconcilableSlots, ['challenger']);
    assert.deepEqual(view.requiredProviders, []);
  } finally {
    await removeTempDir(dir);
  }
});

test('5–6 · échec propre — zéro puis une session', async () => {
  for (const [failing, expectedMissing, expectedProviders] of [
    ['codex', ['author', 'challenger'], ['codex', 'claude']],
    ['claude', ['challenger'], ['claude']],
  ] as const) {
    const dir = await makeTempDir('ccr-1d-clean-');
    try {
      const h = harness(path.join(dir, 'runs'), {
        ...(failing === 'codex'
          ? { failCodex: () => new CcrError('AGENT_EXIT_NONZERO', 'échec') }
          : { failClaude: () => new CcrError('AGENT_TIMEOUT', 'expiré') }),
      });
      const started = await startNativeRun(h.deps, {
        title: 'T',
        cwd: dir,
        prompt: PROMPT,
        runtimeConfig: nativeRuntime(),
      });
      const view = await inspectNativeInitialization(h.deps, started.runId);
      assert.equal(view.status, 'CLEAN_MISSING', `échec ${failing}`);
      assert.deepEqual(view.missingSlots, [...expectedMissing]);
      assert.deepEqual(view.requiredProviders, [...expectedProviders]);
      assert.equal(view.uncertainSlot, null, 'un échec terminé n’est pas une incertitude');
      assert.equal(view.canContinueWithProvider, true);
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('7 · W1 — opération engagée sans réponse journalisée', async () => {
  const dir = await makeTempDir('ccr-1d-w1-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeWindow(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true },
      state: 'WAITING_AGENT',
      pendingSlot: 'challenger',
    });
    const h = harness(runsDir);
    const view = await inspectNativeInitialization(h.deps, RUN_ID);
    assert.equal(view.status, 'IN_FLIGHT_UNCERTAIN');
    assert.equal(view.uncertainSlot, 'challenger');
    assert.equal(view.canContinueWithProvider, false);
    assert.equal(view.canFinalizeWithoutProvider, false);
  } finally {
    await removeTempDir(dir);
  }
});

test('8 · contradictions persistées — échec fermé, aucune réparation', async () => {
  const dir = await makeTempDir('ccr-1d-conflict-');
  try {
    const runsDir = path.join(dir, 'runs');
    // La réponse durable porte `claude-9`, le manifest lie `claude-1`.
    await materializeWindow(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true, response: 'claude-9' },
      state: 'RUNNING',
    });
    const paths = runPaths(runsDir, RUN_ID);
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    await writeNativeManifest(paths, {
      ...persisted.manifest,
      experts: {
        ...persisted.manifest.experts,
        challenger: { provider: 'claude', session_id: 'claude-1' },
      },
    });

    const h = harness(runsDir);
    const view = await inspectNativeInitialization(h.deps, RUN_ID);
    assert.equal(view.status, 'EVIDENCE_CONFLICT');
    assert.ok(view.conflicts.length > 0);
    assert.equal(view.canFinalizeWithoutProvider, false);
    assert.equal(view.canContinueWithProvider, false);

    await expectRejection(
      continueNativeInitialization(h.deps, RUN_ID),
      'STATE_INVALID',
      'aucune réparation sur contradiction',
    );
    assert.equal(h.calls.length, 0, 'aucun appel fournisseur');
  } finally {
    await removeTempDir(dir);
  }
});

test('8bis · une session liée sans réponse durable est une contradiction, pas une fenêtre', async () => {
  const dir = await makeTempDir('ccr-1d-impossible-');
  try {
    const runsDir = path.join(dir, 'runs');
    // `session_created` durable alors que le manifest ne lie rien : l'ordre 1C
    // écrit le manifest AVANT cet événement.
    await materializeWindow(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true, response: 'claude-1', bound: 'claude-1' },
      state: 'RUNNING',
    });
    const paths = runPaths(runsDir, RUN_ID);
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    // On délie le challenger sans retirer sa réponse : séquence impossible.
    await writeNativeManifest(paths, {
      ...persisted.manifest,
      experts: {
        ...persisted.manifest.experts,
        author: { provider: 'codex', session_id: null },
      },
    });

    const h = harness(runsDir);
    const view = await inspectNativeInitialization(h.deps, RUN_ID);
    assert.equal(view.status, 'EVIDENCE_CONFLICT');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Réconciliation locale — tests 9 à 13
// ==========================================================================

test('9–13 · W2, W3 et W4 se finalisent sans le moindre appel fournisseur', async () => {
  for (const [what, challenger] of [
    ['W2', { prompt: true, response: 'claude-1' }],
    ['W3', { prompt: true, response: 'claude-1', bound: 'claude-1' }],
    ['W4', { prompt: true, response: 'claude-1', bound: 'claude-1', created: 'claude-1' }],
  ] as readonly (readonly [string, SlotWindow])[]) {
    const dir = await makeTempDir('ccr-1d-reconcile-');
    try {
      const runsDir = path.join(dir, 'runs');
      await materializeWindow(runsDir, {
        author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
        challenger,
        state: 'RUNNING',
      });
      const h = harness(runsDir);
      const outcome = await continueNativeInitialization(h.deps, RUN_ID);

      assert.deepEqual(h.calls, [], `${what} · aucun appel fournisseur`);
      assert.equal(outcome.view.status, 'NONE', `${what} · finalisé`);
      assert.equal(outcome.state.next_step_source_slot, 'author');
      assert.equal(outcome.state.state, 'READY');

      // 12 · aucune seconde réponse n'est fabriquée.
      const paths = runPaths(runsDir, RUN_ID);
      const persisted = await readPersistedManifest(paths);
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
      const events = await (await openNativeEventStore(paths, persisted.manifest)).readAll();
      assert.equal(
        events.filter((event) => event.type === 'assistant_response').length,
        2,
        `${what} · exactement deux réponses`,
      );
      assert.equal(
        events.filter((event) => event.type === 'session_created').length,
        2,
        `${what} · exactement deux créations de session`,
      );
      // 13 · l'auteur, déjà initialisé, n'est pas rappelé.
      assert.equal(persisted.manifest.experts.author.session_id, 'codex-1');
      assert.equal(persisted.manifest.experts.challenger.session_id, 'claude-1');
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('25–26 · une finalisation rejouée n’ajoute aucun fait, et le run se relit `NONE`', async () => {
  const dir = await makeTempDir('ccr-1d-idempotent-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeWindow(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true, response: 'claude-1' },
      state: 'RUNNING',
    });
    const h = harness(runsDir);
    await continueNativeInitialization(h.deps, RUN_ID);
    const paths = runPaths(runsDir, RUN_ID);
    const afterFirst = await readFile(paths.events, 'utf8');

    const second = await continueNativeInitialization(h.deps, RUN_ID);
    assert.equal(second.view.status, 'NONE');
    assert.equal(await readFile(paths.events, 'utf8'), afterFirst, 'journal inchangé');
    assert.equal(h.calls.length, 0, 'aucun appel fournisseur');

    assert.equal((await inspectNativeInitialization(h.deps, RUN_ID)).status, 'NONE');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Continuation — tests 14 à 19
// ==========================================================================

test('14–15 · la continuation n’appelle que les slots réellement manquants', async () => {
  for (const [failing, expectedCalls] of [
    ['codex', ['codex', 'claude']],
    ['claude', ['claude']],
  ] as const) {
    const dir = await makeTempDir('ccr-1d-continue-');
    try {
      const runsDir = path.join(dir, 'runs');
      const first = harness(runsDir, {
        ...(failing === 'codex'
          ? { failCodex: () => new CcrError('AGENT_EXIT_NONZERO', 'échec') }
          : { failClaude: () => new CcrError('AGENT_TIMEOUT', 'expiré') }),
      });
      const started = await startNativeRun(first.deps, {
        title: 'T',
        cwd: dir,
        prompt: PROMPT,
        runtimeConfig: nativeRuntime(),
      });

      const second = harness(runsDir);
      const outcome = await continueNativeInitialization(second.deps, started.runId);

      assert.deepEqual(second.calls.map((call) => call.provider), [...expectedCalls], `échec ${failing}`);
      assert.deepEqual(second.calls.map((call) => call.prompt), expectedCalls.map(() => PROMPT));
      assert.equal(outcome.view.status, 'NONE');

      // 18 · l'humain garde la main, même après une reprise réussie.
      assert.equal(outcome.state.state, 'READY');
      assert.equal(outcome.state.control, 'HUMAN');
      assert.equal(outcome.state.next_step_source_slot, 'author');

      // 19 · aucun retry : un seul appel par slot manquant.
      const perProvider = second.calls.filter((call) => call.provider === failing).length;
      assert.equal(perProvider, 1, 'aucun retry');
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('16–17 · same-provider : binding du slot respecté, collision fermée', async () => {
  const dir = await makeTempDir('ccr-1d-same-');
  try {
    const runsDir = path.join(dir, 'runs');
    const bindings: NativeExpertBindings = { author: 'claude', challenger: 'claude' };

    // START : l'auteur réussit, le challenger échoue proprement.
    const first = harness(runsDir, {
      claudeSessions: ['S1'],
      failClaude: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls === 2 ? new CcrError('AGENT_TIMEOUT', 'expiré') : undefined;
        };
      })(),
    });
    const started = await startNativeRun(first.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      bindings,
      runtimeConfig: nativeRuntime(),
    });
    assert.equal(started.failure?.slot, 'challenger');

    // Reprise : le fournisseur rend l'identité déjà liée à l'auteur.
    const second = harness(runsDir, { claudeSessions: ['S1'] });
    const outcome = await continueNativeInitialization(second.deps, started.runId);

    assert.deepEqual(second.calls.map((call) => call.provider), ['claude'], 'binding du slot employé');
    assert.equal(outcome.view.status, 'CLEAN_MISSING', 'le challenger reste sans session');
    assert.deepEqual(outcome.view.missingSlots, ['challenger']);

    const paths = runPaths(runsDir, started.runId);
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(persisted.manifest.experts.author.session_id, 'S1', 'auteur conservé');
    assert.equal(persisted.manifest.experts.challenger.session_id, null);

    const events = await (await openNativeEventStore(paths, persisted.manifest)).readAll();
    assert.equal(events.filter((event) => event.type === 'assistant_response').length, 1);
    const failures = events.filter((event) => event.type === 'process_failed');
    assert.ok(
      failures.some((event) => (event.details?.['code'] ?? '') === 'SESSION_ID_COLLISION'),
      'la collision est journalisée avec son code',
    );

    const state = await readPersistedState(paths);
    assert.equal(state.document.state, 'FAILED_INITIALIZATION');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Incertitude — tests 20 à 24
// ==========================================================================

test('20–24 · une incertitude exige une décision humaine, et ne rejoue jamais rien', async () => {
  const dir = await makeTempDir('ccr-1d-uncertain-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeWindow(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true },
      state: 'WAITING_AGENT',
      pendingSlot: 'challenger',
    });
    const paths = runPaths(runsDir, RUN_ID);
    const h = harness(runsDir);

    // 20 · l'inspection n'a aucun effet.
    const before = {
      manifest: await readFile(paths.manifest, 'utf8'),
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
    };
    assert.equal((await inspectNativeInitialization(h.deps, RUN_ID)).status, 'IN_FLIGHT_UNCERTAIN');
    assert.deepEqual(
      {
        manifest: await readFile(paths.manifest, 'utf8'),
        state: await readFile(paths.state, 'utf8'),
        events: await readFile(paths.events, 'utf8'),
      },
      before,
      'inspection sans effet',
    );

    // 21 · continuer sans acquitter est refusé.
    await expectRejection(
      continueNativeInitialization(h.deps, RUN_ID),
      'RECOVERY_REQUIRED',
      'continuation avant acquittement',
    );
    assert.equal(h.calls.length, 0, 'aucun appel fournisseur');

    // 22 · l'acquittement n'appelle aucun fournisseur.
    const acknowledged = await acknowledgeNativeUncertainty(h.deps, RUN_ID, 'Vérifié côté fournisseur.');
    assert.equal(h.calls.length, 0, 'aucun appel fournisseur');
    assert.equal(acknowledged.state.state, 'PAUSED');
    assert.equal(acknowledged.state.control, 'HUMAN');
    assert.equal(acknowledged.state.pending_operation, null);
    assert.equal(acknowledged.view.status, 'CLEAN_MISSING');

    // 24 · l'ancienne tentative n'est jamais présentée comme non consommée.
    const events = await (
      await openNativeEventStore(paths, (await readJsonFile(paths.manifest)) as NativeRunManifest)
    ).readAll();
    const ack = events.find(
      (event) => event.details?.['reason'] === 'NATIVE_INITIALIZATION_UNCERTAINTY_ACKNOWLEDGED',
    );
    assert.ok(ack !== undefined, 'acquittement journalisé');
    assert.equal(ack?.details?.['uncertain_slot'], 'challenger');
    assert.equal(
      String(ack?.details?.['conclusion']).startsWith('Aucune'),
      true,
      'aucune conclusion sur ce qui a eu lieu',
    );

    // 23 · une nouvelle tentative explicite est alors possible.
    const outcome = await continueNativeInitialization(h.deps, RUN_ID);
    assert.deepEqual(h.calls.map((call) => call.provider), ['claude'], 'un nouvel appel, explicite');
    assert.equal(outcome.view.status, 'NONE');
    assert.equal(outcome.state.control, 'HUMAN');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Runtime épinglé · rounds · legacy
// ==========================================================================

test('runtime · la reprise emploie le snapshot épinglé, jamais la configuration courante', async () => {
  const dir = await makeTempDir('ccr-1d-pinned-');
  try {
    const runsDir = path.join(dir, 'runs');
    const first = harness(runsDir, { failClaude: () => new CcrError('AGENT_TIMEOUT', 'expiré') });
    const started = await startNativeRun(first.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      runtimeConfig: { ...nativeRuntime(), captured_at: '2020-01-01T00:00:00.000Z' },
    });
    const paths = runPaths(runsDir, started.runId);
    const runtimeBefore = JSON.stringify(
      ((await readJsonFile(paths.manifest)) as NativeRunManifest).runtime_config,
    );

    const settings: unknown[] = [];
    const second = harness(runsDir);
    await continueNativeInitialization(
      { ...second.deps, createAdapters: (_cwd, runtime) => { settings.push(runtime); return second.adapters; } },
      started.runId,
    );

    // Les réglages transmis à l'adapter viennent du snapshot du run.
    assert.deepEqual(settings, [{ codexSkipGitRepoCheck: false }]);
    assert.equal(
      JSON.stringify(((await readJsonFile(paths.manifest)) as NativeRunManifest).runtime_config),
      runtimeBefore,
      'snapshot inchangé par la reprise',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('rounds · aucune reprise d’initialisation n’écrit d’artefact de round', async () => {
  const dir = await makeTempDir('ccr-1d-rounds-');
  try {
    const runsDir = path.join(dir, 'runs');
    const first = harness(runsDir, { failClaude: () => new CcrError('AGENT_TIMEOUT', 'expiré') });
    const started = await startNativeRun(first.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      runtimeConfig: nativeRuntime(),
    });
    const second = harness(runsDir);
    await continueNativeInitialization(second.deps, started.runId);

    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(runPaths(runsDir, started.runId).roundsDir), []);
  } finally {
    await removeTempDir(dir);
  }
});

test('legacy · un run historique est refusé explicitement, sans écriture native', async () => {
  const dir = await makeTempDir('ccr-1d-legacy-');
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
      prompt: PROMPT,
    });

    const paths = runPaths(runsDir, started.runId);
    const before = {
      manifest: await readFile(paths.manifest, 'utf8'),
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
    };

    // Sequentiellement : deux de ces appels prennent le verrou de run, et les
    // lancer ensemble ferait echouer l'un d'eux sur le verrou plutot que sur la
    // generation.
    for (const call of [
      () => inspectNativeInitialization(deps, started.runId),
      () => continueNativeInitialization(deps, started.runId),
      () => acknowledgeNativeUncertainty(deps, started.runId, 'note'),
    ]) {
      await expectRejection(call(), 'SCHEMA_VERSION_UNSUPPORTED', 'run historique refusé');
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
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Foundation repair 1D.2 — identification causale des reponses initiales
// ==========================================================================

/** Fenêtre START complète des deux slots, telle que 1C la laisse. */
const COMPLETE_START = {
  author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
  challenger: { prompt: true, response: 'claude-1', bound: 'claude-1', created: 'claude-1' },
} as const;

test('1D.2 A→D · ni SEND ni STEP n’altèrent la vue d’initialisation', async () => {
  const cases = [
    { label: 'A · START seul', extra: {} },
    { label: 'B · + SEND vers author', extra: { send: { slot: 'author' as const, session: 'codex-1' } } },
    {
      label: 'C · + SEND vers challenger',
      extra: { send: { slot: 'challenger' as const, session: 'claude-1' } },
    },
    {
      label: 'D · + STEP author → challenger',
      extra: {
        step: { source: 'author' as const, target: 'challenger' as const, session: 'claude-1' },
        cursor: 'challenger' as const,
      },
    },
  ];

  for (const testCase of cases) {
    const dir = await makeTempDir('ccr-1d2-view-');
    try {
      const h = harness(path.join(dir, 'runs'));
      await materializeWindow(h.runsDir, {
        ...COMPLETE_START,
        state: 'READY',
        cursor: 'author',
        ...testCase.extra,
      });

      const view = await inspectNativeInitialization(h.deps, RUN_ID);
      assert.equal(view.status, 'NONE', `${testCase.label} · statut`);
      assert.equal(view.conflicts.length, 0, `${testCase.label} · aucun conflit`);
      assert.equal(view.conditions.author, 'COMPLETE');
      assert.equal(view.conditions.challenger, 'COMPLETE');
      assert.equal(view.slots.author.initialResponseCount, 1, `${testCase.label} · author`);
      assert.equal(view.slots.challenger.initialResponseCount, 1, `${testCase.label} · challenger`);
      assert.equal(view.missingSlots.length, 0);
      assert.equal(view.reconcilableSlots.length, 0);
      // La réponse initiale retenue reste celle de START, jamais la dernière.
      assert.equal(view.slots.author.initialResponseSession, 'codex-1');
      assert.equal(view.slots.challenger.initialResponseSession, 'claude-1');
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('1D.2 E · un run partiel ayant reçu un SEND redevient récupérable', async () => {
  const dir = await makeTempDir('ccr-1d2-partial-');
  try {
    const h = harness(path.join(dir, 'runs'));
    await materializeWindow(h.runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
      challenger: { prompt: true },
      state: 'FAILED_INITIALIZATION',
      send: { slot: 'author', session: 'codex-1' },
    });

    const view = await inspectNativeInitialization(h.deps, RUN_ID);
    assert.equal(view.status, 'CLEAN_MISSING', 'plus aucun faux conflit');
    assert.deepEqual([...view.missingSlots], ['challenger']);
    assert.equal(view.conditions.author, 'COMPLETE');
    assert.equal(view.conditions.challenger, 'MISSING');
    assert.equal(view.slots.author.initialResponseCount, 1, 'la réponse SEND n’est pas initiale');
    assert.equal(view.conflicts.length, 0);
    assert.equal(view.canContinueWithProvider, true);

    // La continuation redevient possible, et ne reprend que le slot manquant.
    const outcome = await continueNativeInitialization(h.deps, RUN_ID);
    assert.equal(outcome.view.status, 'NONE');
    assert.deepEqual(
      h.calls.map((call) => call.provider),
      ['claude'],
      'seul le slot manquant est initialisé',
    );
    assert.equal(outcome.state.state, 'READY');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.next_step_source_slot, 'author');

    const manifest = await readPersistedManifest(runPaths(h.runsDir, RUN_ID));
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(manifest.manifest.experts.challenger.session_id, 'claude-1');
  } finally {
    await removeTempDir(dir);
  }
});

test('1D.2 · un slot réconciliable le reste après un SEND légitime', async () => {
  const dir = await makeTempDir('ccr-1d2-linked-');
  try {
    const h = harness(path.join(dir, 'runs'));
    // Fenêtre de 1C : session liée, `session_created` jamais journalisé. Le
    // slot est donc joignable, et un SEND vers lui est parfaitement légitime.
    await materializeWindow(h.runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1' },
      challenger: { prompt: true, response: 'claude-1', bound: 'claude-1', created: 'claude-1' },
      state: 'RUNNING',
      send: { slot: 'author', session: 'codex-1' },
    });

    const view = await inspectNativeInitialization(h.deps, RUN_ID);
    assert.equal(view.conditions.author, 'LINKED_NEEDS_FINALIZATION', 'le SEND ne masque pas la lacune');
    assert.deepEqual([...view.reconcilableSlots], ['author']);
    assert.equal(view.status, 'LINKED_NEEDS_FINALIZATION');
    assert.equal(view.conflicts.length, 0);
    assert.equal(view.canFinalizeWithoutProvider, true);

    // Finalisation locale : `session_created` complété, aucun appel fournisseur.
    const before = h.calls.length;
    const outcome = await continueNativeInitialization(h.deps, RUN_ID, { localOnly: true });
    assert.equal(h.calls.length, before, 'aucun fournisseur appelé');
    assert.equal(outcome.view.status, 'NONE');
    assert.equal(outcome.view.conditions.author, 'COMPLETE');

    const events = await (
      await openNativeEventStore(
        runPaths(h.runsDir, RUN_ID),
        (await readPersistedManifest(runPaths(h.runsDir, RUN_ID))).manifest as NativeRunManifest,
      )
    ).readAll();
    assert.equal(
      events.filter(
        (event) =>
          event.type === 'session_created' &&
          (event as { expert_slot_id?: string }).expert_slot_id === 'author',
      ).length,
      1,
      'un seul session_created, complété une fois',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('1D.2 · deux vraies réponses initiales restent une contradiction', async () => {
  const dir = await makeTempDir('ccr-1d2-double-');
  try {
    const h = harness(path.join(dir, 'runs'));
    await materializeWindow(h.runsDir, {
      ...COMPLETE_START,
      state: 'READY',
      cursor: 'author',
      // Deux réponses satisfaisant RÉELLEMENT le contrat START pour l'author.
      doubleInitial: { slot: 'author', session: 'codex-1' },
      // Et un SEND par-dessus : il ne doit ni créer ni masquer le conflit.
      send: { slot: 'challenger', session: 'claude-1' },
    });

    const view = await inspectNativeInitialization(h.deps, RUN_ID);
    assert.equal(view.status, 'EVIDENCE_CONFLICT');
    assert.equal(view.slots.author.initialResponseCount, 2);
    assert.equal(view.conditions.author, 'CONFLICT');
    assert.equal(view.conditions.challenger, 'COMPLETE', 'le SEND du challenger reste sans effet');
    assert.equal(view.slots.challenger.initialResponseCount, 1);
    assert.ok(view.conflicts.some((conflict) => conflict.includes('2 réponses initiales durables')));

    // Et la réparation reste refusée, comme avant le repair.
    await expectRejection(
      continueNativeInitialization(h.deps, RUN_ID),
      'STATE_INVALID',
      'contradiction réelle non réparée',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('1D.2 · une reprise ne rembobine plus le curseur d’alternance', async () => {
  const dir = await makeTempDir('ccr-1d2-cursor-');
  try {
    const h = harness(path.join(dir, 'runs'));
    await materializeWindow(h.runsDir, {
      ...COMPLETE_START,
      state: 'READY',
      cursor: 'challenger',
      step: { source: 'author', target: 'challenger', session: 'claude-1' },
    });

    const outcome = await continueNativeInitialization(h.deps, RUN_ID);
    assert.equal(outcome.view.status, 'NONE', 'rien à récupérer');
    assert.equal(h.calls.length, 0, 'aucun fournisseur');
    assert.equal(outcome.state.next_step_source_slot, 'challenger', 'le curseur du transfert survit');
    assert.equal(outcome.state.round, 1, 'le round survit');
  } finally {
    await removeTempDir(dir);
  }
});

