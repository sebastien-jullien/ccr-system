/**
 * Slice 2B-R — Native SEND Crash Recovery.
 *
 * L'ordre durable réparé en 2B rend ces fenêtres lisibles :
 *
 * ```text
 * S0a  human_message durable, état encore d'origine, aucun contexte
 * S0b  human_message durable, état RUNNING, aucun contexte
 * S1   contexte engagé, aucune réponse
 * S2   réponse durable, contexte encore engagé
 * S3   envoi commité
 * ```
 *
 * `S0` et `S1` ne sont pas la même chose : le contexte de reprise est persisté
 * **avant** l'appel, donc son absence prouve qu'aucun fournisseur n'a été
 * sollicité. Sans cette garantie, tout devrait être traité comme incertain.
 *
 * Les fenêtres sont construites en capturant les octets réellement durables à
 * l'instant voulu, puis en les restaurant : c'est ce qu'un arrêt brutal aurait
 * laissé, et non un état inventé. Les preuves de processus réel sont dans
 * `native-send-crash.test.ts`.
 *
 * Aucun fournisseur : les adapters sont des fixtures, et la reprise n'a
 * structurellement aucune dépendance d'adapter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { classifyRunLiveness } from '../../src/core/run-liveness.ts';
import type { RunManifest, RunStateDocument } from '../../src/core/run.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { RunState } from '../../src/core/state.ts';
import { DEFAULT_NATIVE_BINDINGS, startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings } from '../../src/services/native-start-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import { planNativeStep } from '../../src/services/native-step-planner.ts';
import {
  abortNativeSendBeforeProvider,
  acknowledgeNativeSendUncertainty,
  finalizeNativeSendRecovery,
  inspectNativeSendRecovery,
} from '../../src/services/native-send-recovery-service.ts';
import type { NativeSendRecoveryDeps } from '../../src/services/native-send-recovery-service.ts';
import { expertSlotTarget } from '../../src/services/native-target-resolver.ts';
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
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';
const MESSAGE = 'Précise ton troisième argument, il me paraît fragile.';
const NOTE = 'Tué pendant l’appel ; l’issue reste inconnue.';

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  /** Dépendances de reprise : aucune fabrique d'adapter n'y figure. */
  readonly recovery: NativeSendRecoveryDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  /** Reprises fournisseur réellement engagées, tous moteurs confondus. */
  readonly resumes: string[];
}

interface HarnessOptions {
  readonly sessions?: Partial<Record<ProviderKind, readonly string[]>>;
  readonly failResume?: () => unknown;
  readonly resumeSessionId?: string;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  const resumes: string[] = [];
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: options.sessions?.[kind] ?? [`${kind}-1`, `${kind}-2`],
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
      ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
      onCall: (phase, prompt) => {
        if (phase === 'resume') resumes.push(`${kind}:${prompt.slice(0, 12)}`);
      },
    });
  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
    runsDir,
    adapters,
    resumes,
    deps: { runsDir, now: () => new Date(AT), createAdapters: (): AgentAdapters => adapters },
    recovery: { runsDir, now: () => new Date(AT) },
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

// --------------------------------------------------------------------------
// Fabrication des fenêtres
// --------------------------------------------------------------------------

interface Snapshot {
  readonly state: string;
  readonly events: string;
}

async function capture(paths: { state: string; events: string }): Promise<Snapshot> {
  return { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') };
}

/** Restaure exactement les octets durables d'un instant donné. */
async function restore(paths: { state: string; events: string }, snapshot: Snapshot): Promise<void> {
  await writeFile(paths.state, snapshot.state, 'utf8');
  await writeFile(paths.events, snapshot.events, 'utf8');
}

interface Windows {
  readonly runId: string;
  readonly paths: ReturnType<typeof runPaths>;
  /** Message durable, état encore celui d'origine, aucun contexte. */
  readonly s0a: Snapshot;
  /** Message durable, état transitoire RUNNING, toujours aucun contexte. */
  readonly s0b: Snapshot | undefined;
  /** Contexte engagé, aucune réponse. */
  readonly s1: Snapshot;
  /** Réponse durable, contexte encore engagé. */
  readonly s2: Snapshot;
  readonly promptEventId: string;
  readonly responseEventId: string;
}

/**
 * Exécute un vrai envoi en capturant ce qui est durable aux quatre instants
 * décisifs.
 */
async function sendCapturingWindows(
  h: Harness,
  dir: string,
  options: { readonly slot?: 'author' | 'challenger'; readonly origin?: RunState; readonly bindings?: NativeExpertBindings } = {},
): Promise<Windows> {
  const runId = await startedRun(h, dir, options.bindings);
  const paths = runPaths(h.runsDir, runId);
  if (options.origin !== undefined) {
    await forceState(h.runsDir, runId, { state: options.origin, control: 'HUMAN' });
  }

  const slot = options.slot ?? 'challenger';
  // L'adaptateur instrumenté est celui qui porte RÉELLEMENT le slot visé :
  // la liaison du run, explicite ou par défaut, en décide. Recopier une
  // convention ici instrumenterait le mauvais moteur dès qu'elle change, et les
  // captures resteraient silencieusement `undefined`.
  const provider = (options.bindings ?? DEFAULT_NATIVE_BINDINGS)[slot];
  const target = h.adapters[provider];
  const original = target.resume.bind(target);
  let s1: Snapshot | undefined;
  (target as { resume: typeof target.resume }).resume = async (session, prompt) => {
    s1 = await capture(paths);
    return original(session, prompt);
  };

  let s0a: Snapshot | undefined;
  let s0b: Snapshot | undefined;
  let s2: Snapshot | undefined;
  const sent = await sendNativeMessage(h.deps, runId, expertSlotTarget(slot), MESSAGE, {
    afterHumanMessageJournaled: async () => {
      s0a = await capture(paths);
    },
    afterTransientStatePersisted: async () => {
      s0b = await capture(paths);
    },
    afterResponseJournaled: async () => {
      s2 = await capture(paths);
    },
  });
  (target as { resume: typeof target.resume }).resume = original;

  assert.ok(s0a !== undefined && s1 !== undefined && s2 !== undefined);
  return {
    runId,
    paths,
    s0a,
    s0b,
    s1,
    s2,
    promptEventId: sent.promptEventId,
    responseEventId: sent.responseEventId,
  };
}

interface PartialWindows {
  readonly runId: string;
  readonly paths: ReturnType<typeof runPaths>;
  /** Message durable, etat encore FAILED_INITIALIZATION, aucun contexte. */
  readonly s0a: Snapshot;
  /** Message durable, etat transitoire RUNNING, aucun contexte. */
  readonly s0b: Snapshot;
  /** Reponse durable, contexte encore engage. */
  readonly s2: Snapshot;
  readonly sent: Awaited<ReturnType<typeof sendNativeMessage>>;
}

/**
 * Projection legacy d'un run natif, pour interroger `classifyRunLiveness`.
 *
 * Le classifieur de vivacite est celui de V2 : il lit `manifest.agents` et
 * `state.state`. Aucun read model natif n'existe encore, mais la regle qu'il
 * porte est la reponse canonique du projet a « que signifie cet etat ? ». La
 * projection est fidele sur les deux seuls faits qu'il consulte : l'etat, et le
 * nombre de sessions presentes.
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
        claude: { session_id: sessionsPresent >= 2 ? 'claude-1' : null, role: 'challenger' },
        codex: { session_id: sessionsPresent >= 1 ? 'codex-1' : null, role: 'author' },
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

/**
 * Envoi reussi sur un run **reellement** partiel.
 *
 * Le challenger echoue au START : une seule session native existe, et le run
 * porte `FAILED_INITIALIZATION`. L'envoi vise l'author, seul expert joignable —
 * et ne complete evidemment pas l'autre.
 */
async function sendOnPartialRun(h: Harness, dir: string): Promise<PartialWindows> {
  // L'échec est armé sur le fournisseur qui porte RÉELLEMENT le challenger :
  // c'est le rôle qui définit ce scénario, jamais un nom de moteur.
  const challengerProvider = DEFAULT_NATIVE_BINDINGS.challenger;
  const failing = createFakeAdapter({
    kind: challengerProvider,
    failStart: () => new CcrError('AGENT_TIMEOUT', 'échec du challenger'),
  });
  const deps: RunServiceDeps = {
    ...h.deps,
    createAdapters: (): AgentAdapters => ({
      claude: challengerProvider === 'claude' ? failing : h.adapters.claude,
      codex: challengerProvider === 'codex' ? failing : h.adapters.codex,
    }),
  };
  const started = await startNativeRun(deps, {
    title: 'T',
    cwd: dir,
    prompt: MISSION,
    runtimeConfig: nativeRuntime(),
  });
  assert.equal(started.failure?.slot, 'challenger');
  const paths = runPaths(h.runsDir, started.runId);

  let s0a: Snapshot | undefined;
  let s0b: Snapshot | undefined;
  let s2: Snapshot | undefined;
  const sent = await sendNativeMessage(deps, started.runId, expertSlotTarget('author'), MESSAGE, {
    afterHumanMessageJournaled: async () => {
      s0a = await capture(paths);
    },
    afterTransientStatePersisted: async () => {
      s0b = await capture(paths);
    },
    afterResponseJournaled: async () => {
      s2 = await capture(paths);
    },
  });
  assert.ok(s0a !== undefined && s0b !== undefined && s2 !== undefined);
  return { runId: started.runId, paths, s0a, s0b, s2, sent };
}

function lines(snapshot: Snapshot): Record<string, unknown>[] {
  return snapshot.events
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rebuild(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

// ==========================================================================
// A. Classification — S0a, S0b, S1, S2, S3
// ==========================================================================

test('1–2 · S0a et S0b — un envoi abandonné avant tout appel, quel que soit l’état atteint', async () => {
  const dir = await makeTempDir('ccr-2br-s0-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);
    assert.ok(w.s0b !== undefined, 'la fenêtre transitoire existe depuis un état non humain');

    for (const [name, window, expectedState] of [
      ['S0a', w.s0a, 'READY'],
      ['S0b', w.s0b, 'RUNNING'],
    ] as readonly (readonly [string, Snapshot, string])[]) {
      await restore(w.paths, window);
      const persisted = await readPersistedState(w.paths);
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
      assert.equal(persisted.document.state, expectedState, `${name} · état durable`);
      assert.equal(persisted.document.pending_operation, null, `${name} · aucun contexte engagé`);

      const view = await inspectNativeSendRecovery(h.recovery, w.runId);
      assert.equal(view.status, 'PRE_PROVIDER_ABORTED', `${name} · classification`);
      assert.equal(view.promptEventId, w.promptEventId);
      assert.equal(view.targetSlot, 'challenger');
      assert.equal(view.responseEventId, undefined, `${name} · aucune réponse`);
      assert.equal(view.requiresHumanAcknowledgement, false, `${name} · rien à acquitter`);
      assert.deepEqual([...view.orphanPromptEventIds], [w.promptEventId]);
      // 14 · ni round, ni curseur : un envoi n'est pas un transfert.
      assert.equal(persisted.document.round, 0, `${name} · round intact`);
      assert.equal(persisted.document.next_step_source_slot, 'author', `${name} · curseur intact`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('3–5 · S1, S2 et S3 sont distingués par les seuls faits canoniques', async () => {
  const dir = await makeTempDir('ccr-2br-s1s3-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);

    // 5 · S3 — l'envoi est commité : il n'y a rien à reprendre.
    const committed = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(committed.status, 'NONE');
    assert.equal(committed.orphanPromptEventIds.length, 0);

    // 4 · S2 — la réponse est durable, le contexte l'est encore.
    await restore(w.paths, w.s2);
    const responded = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(responded.status, 'RESPONSE_NEEDS_FINALIZATION');
    assert.equal(responded.canFinalizeWithoutProvider, true);
    assert.equal(responded.requiresHumanAcknowledgement, false);
    assert.equal(responded.responseEventId, w.responseEventId);

    // 3 · S1 — le contexte est engagé, aucune réponse n'existe.
    await restore(w.paths, w.s1);
    const inFlight = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(inFlight.status, 'IN_FLIGHT_UNCERTAIN');
    assert.equal(inFlight.canFinalizeWithoutProvider, false);
    assert.equal(inFlight.requiresHumanAcknowledgement, true);
    assert.equal(inFlight.responseEventId, undefined);
    assert.equal(inFlight.promptEventId, w.promptEventId);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Contradictions
// ==========================================================================

test('6 · des faits contradictoires ferment la reprise au lieu de choisir', async () => {
  const dir = await makeTempDir('ccr-2br-conflict-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);

    const misattributed = lines(w.s2).map((record) =>
      record['type'] === 'assistant_response' ? { ...record, expert_slot_id: 'author' } : record,
    );
    // La réponse de CET envoi, et non l'une des positions initiales.
    const sendResponse = lines(w.s2).find((record) => record['event_id'] === w.responseEventId);
    assert.ok(sendResponse !== undefined);
    const duplicated = [...lines(w.s2), { ...sendResponse, event_id: 'evt_000099' }];

    const cases: readonly (readonly [string, Snapshot])[] = [
      // Réponse attribuée à un autre slot que celui visé.
      ['slot', { state: w.s2.state, events: rebuild(misattributed) }],
      // Deux réponses incompatibles au même message.
      ['deux réponses', { state: w.s2.state, events: rebuild(duplicated) }],
      // Contexte désignant un message inexistant.
      [
        'prompt fantôme',
        {
          state: JSON.stringify({
            ...(JSON.parse(w.s1.state) as Record<string, unknown>),
            pending_operation: {
              ...((JSON.parse(w.s1.state) as { pending_operation: Record<string, unknown> })
                .pending_operation),
              prompt_event_id: 'evt_000404',
            },
          }),
          events: w.s1.events,
        },
      ],
      // Contexte visant un slot que le message ne visait pas.
      [
        'slot du contexte',
        {
          state: JSON.stringify({
            ...(JSON.parse(w.s1.state) as Record<string, unknown>),
            pending_operation: {
              ...((JSON.parse(w.s1.state) as { pending_operation: Record<string, unknown> })
                .pending_operation),
              expert_slot: 'author',
            },
          }),
          events: w.s1.events,
        },
      ],
    ];

    for (const [name, snapshot] of cases) {
      await restore(w.paths, snapshot);
      const view = await inspectNativeSendRecovery(h.recovery, w.runId);
      assert.equal(view.status, 'EVIDENCE_CONFLICT', `${name} · échec fermé`);
      assert.ok(view.conflicts.length > 0, `${name} · la contradiction est nommée`);
      assert.equal(view.canFinalizeWithoutProvider, false);

      const before = await capture(w.paths);
      await expectRejection(
        finalizeNativeSendRecovery(h.recovery, w.runId),
        'STATE_INVALID',
        `${name} · aucune réparation`,
      );
      assert.deepEqual(await capture(w.paths), before, `${name} · rien n’a été écrit`);
    }
    assert.equal(h.resumes.length, 1, 'un seul appel, celui de l’envoi initial');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Clôture d'un envoi abandonné avant appel
// ==========================================================================

test('7–9 · la clôture S0 est durable, unique, et n’appelle aucun fournisseur', async () => {
  const dir = await makeTempDir('ccr-2br-abort-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);
    assert.ok(w.s0b !== undefined, 'la fenêtre transitoire existe depuis un état non humain');
    await restore(w.paths, w.s0b);
    const callsBefore = h.resumes.length;

    const outcome = await abortNativeSendBeforeProvider(h.recovery, w.runId);
    assert.equal(outcome.view.status, 'NONE', 'la fenêtre est refermée');
    assert.equal(outcome.state.state, 'PAUSED');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    // 14 · ni round, ni curseur.
    assert.equal(outcome.state.round, 0);
    assert.equal(outcome.state.next_step_source_slot, 'author');
    // 8 · aucun appel fournisseur pendant la reprise.
    assert.equal(h.resumes.length, callsBefore, 'aucun fournisseur appelé par la reprise');

    // 7 · un seul marqueur, et c'est celui du bon fait.
    const after = await journal(h.runsDir, w.runId);
    const markers = after.filter((event) => event.type === 'send_aborted_before_provider');
    assert.equal(markers.length, 1);
    const marker = markers[0] as unknown as Record<string, unknown>;
    assert.equal(marker['prompt_event_id'], w.promptEventId);
    assert.equal(marker['target_expert_slot_id'], 'challenger');
    assert.equal(marker['reason'], 'PRE_PROVIDER_ABORTED');
    assert.equal('response_event_id' in marker, false, 'aucune réponse n’est prétendue');
    assert.equal('session_id' in marker, false, 'aucune session n’est prétendue atteinte');
    assert.equal(
      after.some((event) => event.type === 'send_uncertainty_acknowledged'),
      false,
      'un abandon prouvé n’est pas une incertitude',
    );
    assert.equal(after.filter((event) => event.type === 'assistant_response' && event.round === 0).length, 2, 'les deux positions initiales, et rien de plus');
    assert.equal((await readdir(w.paths.roundsDir)).length, 0, 'aucun artefact de round');

    // 9 · une seconde clôture ne duplique rien, et n'écrit pas.
    const before = await capture(w.paths);
    const again = await abortNativeSendBeforeProvider(h.recovery, w.runId);
    assert.equal(again.view.status, 'NONE');
    assert.deepEqual(await capture(w.paths), before, 'seconde invocation sans effet');
    assert.equal(
      (await journal(h.runsDir, w.runId)).filter((event) => event.type === 'send_aborted_before_provider')
        .length,
      1,
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('4 · une initialisation partielle n’est pas normalisée par une clôture', async () => {
  const dir = await makeTempDir('ccr-2br-partial-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendOnPartialRun(h, dir);
    assert.equal(
      (JSON.parse(w.s0a.state) as { state: string }).state,
      'FAILED_INITIALIZATION',
      'la fenêtre S0a porte bien l’état signalé',
    );

    // La clôture ne doit pas transformer ce signalement en run sain.
    await restore(w.paths, w.s0a);
    const outcome = await abortNativeSendBeforeProvider(h.recovery, w.runId);
    assert.equal(outcome.state.state, 'FAILED_INITIALIZATION', 'le signalement 1D survit');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.view.status, 'NONE');

    const manifest = await readPersistedManifest(w.paths);
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(manifest.manifest.experts.challenger.session_id, null, 'la session manquante le reste');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Incertitude
// ==========================================================================

test('10–13 · S1 s’acquitte, ne se finalise pas, et ne se rejoue jamais', async () => {
  const dir = await makeTempDir('ccr-2br-uncertain-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);
    await restore(w.paths, w.s1);
    const callsBefore = h.resumes.length;

    // 10 · l'inspection n'écrit rien.
    const before = await capture(w.paths);
    const view = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'IN_FLIGHT_UNCERTAIN');
    assert.deepEqual(await capture(w.paths), before, 'inspection sans effet');

    // 11 · la finalisation directe est refusée, sans rien écrire.
    await expectRejection(
      finalizeNativeSendRecovery(h.recovery, w.runId),
      'RECOVERY_REQUIRED',
      'finalisation directe refusée',
    );
    assert.deepEqual(await capture(w.paths), before, 'le refus n’a rien écrit');
    await expectRejection(
      acknowledgeNativeSendUncertainty(h.recovery, w.runId, '   '),
      'INVALID_ARGUMENT',
      'acquittement sans note refusé',
    );

    // 12 · un seul marqueur, qui ne conclut rien.
    const outcome = await acknowledgeNativeSendUncertainty(h.recovery, w.runId, NOTE);
    assert.equal(outcome.view.status, 'NONE');
    assert.equal(outcome.state.state, 'PAUSED');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    assert.equal(outcome.state.round, 0);
    assert.equal(outcome.state.next_step_source_slot, 'author');
    assert.equal(h.resumes.length, callsBefore, 'aucun rejeu, aucun fournisseur');

    const after = await journal(h.runsDir, w.runId);
    const markers = after.filter((event) => event.type === 'send_uncertainty_acknowledged');
    assert.equal(markers.length, 1);
    const marker = markers[0] as unknown as Record<string, unknown>;
    assert.equal(marker['prompt_event_id'], w.promptEventId);
    assert.equal(marker['target_expert_slot_id'], 'challenger');
    assert.equal(marker['reason'], 'IN_FLIGHT_UNCERTAIN');
    assert.equal(marker['content'], NOTE);
    assert.equal('response_event_id' in marker, false, 'aucune réponse n’est prétendue');
    assert.equal(
      (marker['details'] as Record<string, unknown>)['conclusion'],
      "Aucune : CCR n'a pas déterminé si l'appel a eu lieu.",
    );
    // Les deux marqueurs ne sont pas interchangeables.
    assert.equal(
      after.some((event) => event.type === 'send_aborted_before_provider'),
      false,
      'une incertitude n’est pas un abandon prouvé',
    );
    assert.equal(after.filter((event) => event.type === 'assistant_response').length, 2, 'aucune réponse inventée');

    // 13 · un second acquittement ne duplique pas le marqueur.
    const settled = await capture(w.paths);
    await expectRejection(
      acknowledgeNativeSendUncertainty(h.recovery, w.runId, NOTE),
      'INVALID_ARGUMENT',
      'second acquittement refusé',
    );
    assert.deepEqual(await capture(w.paths), settled, 'aucune duplication');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Finalisation locale d'une réponse durable
// ==========================================================================

test('15–20 · S2 se finalise localement, sans fournisseur et sans seconde réponse', async () => {
  const dir = await makeTempDir('ccr-2br-finalize-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);
    await restore(w.paths, w.s2);
    const callsBefore = h.resumes.length;
    const journalBefore = (await capture(w.paths)).events;

    const outcome = await finalizeNativeSendRecovery(h.recovery, w.runId);
    // 17 · l'état de retour persisté avant l'appel est restauré.
    assert.equal(outcome.state.state, 'READY');
    // 18 · une reprise réussie reste sous autorité humaine (1D, 1G).
    assert.equal(outcome.state.control, 'HUMAN');
    // 19 · contexte et slot actif libérés.
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    // 14 · ni round, ni curseur.
    assert.equal(outcome.state.round, 0);
    assert.equal(outcome.state.next_step_source_slot, 'author');
    // 15 · aucun fournisseur.
    assert.equal(h.resumes.length, callsBefore);
    // 16 · aucun événement n'est ajouté : la réponse durable EST le fait.
    assert.equal((await capture(w.paths)).events, journalBefore, 'le journal est inchangé');
    assert.equal(
      (await journal(h.runsDir, w.runId)).filter(
        (event) => event.type === 'assistant_response' && (event.based_on ?? []).includes(w.promptEventId),
      ).length,
      1,
      'aucune seconde réponse',
    );

    // 20 · une seconde reprise n'a plus rien à faire.
    const settled = await capture(w.paths);
    const again = await finalizeNativeSendRecovery(h.recovery, w.runId);
    assert.equal(again.view.status, 'NONE');
    assert.deepEqual(await capture(w.paths), settled, 'seconde invocation sans effet');
  } finally {
    await removeTempDir(dir);
  }
});

test('17 · l’état restauré est celui persisté avant l’appel, jamais un état par défaut', async () => {
  const dir = await makeTempDir('ccr-2br-return-');
  try {
    const h = harness(path.join(dir, 'runs'));
    // Un envoi parti d'un run suspendu doit l'y ramener, et non le rendre prêt.
    const w = await sendCapturingWindows(h, dir, { origin: 'PAUSED' });
    await restore(w.paths, w.s2);

    const outcome = await finalizeNativeSendRecovery(h.recovery, w.runId);
    assert.equal(outcome.state.state, 'PAUSED', 'l’état d’origine, pas READY');
    assert.equal(outcome.state.control, 'HUMAN');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// F. Échecs déterministes
// ==========================================================================

test('21–22 · un échec journalisé l’emporte sur le constat « message sans réponse »', async () => {
  const dir = await makeTempDir('ccr-2br-failures-');
  try {
    // 21 · échec adapter : pending libéré par 2B, run stable.
    const failing = harness(path.join(dir, 'runs'), {
      failResume: () => new CcrError('AGENT_TIMEOUT', 'le fournisseur n’a pas répondu'),
    });
    const failingRun = await startedRun(failing, dir);
    await expectRejection(
      sendNativeMessage(failing.deps, failingRun, expertSlotTarget('challenger'), MESSAGE),
      'AGENT_TIMEOUT',
      'échec déterministe',
    );
    const afterFailure = await inspectNativeSendRecovery(failing.recovery, failingRun);
    assert.equal(afterFailure.status, 'NONE', 'un échec conclu n’appelle aucune reprise');
    assert.equal(afterFailure.orphanPromptEventIds.length, 0, 'le message porte son issue');

    // 22 · session dérivée : le run est FAILED, et ce n'est pas une incertitude.
    const drifting = harness(path.join(dir, 'runs'), { resumeSessionId: 'autre-session' });
    const driftingRun = await startedRun(drifting, dir);
    await expectRejection(
      sendNativeMessage(drifting.deps, driftingRun, expertSlotTarget('challenger'), MESSAGE),
      'AGENT_SESSION_MISMATCH',
      'session dérivée',
    );
    const afterDrift = await inspectNativeSendRecovery(drifting.recovery, driftingRun);
    assert.equal(afterDrift.status, 'NONE');
    const state = await readPersistedState(runPaths(drifting.runsDir, driftingRun));
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(state.document.state, 'FAILED');
  } finally {
    await removeTempDir(dir);
  }
});

test('21 · un échec durable dont le contexte a survécu se finalise, sans devenir une incertitude', async () => {
  const dir = await makeTempDir('ccr-2br-failure-window-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);

    // Fenêtre produite par 2B et non énumérée par le gate : `process_failed`
    // est journalisé AVANT la libération du contexte. Tué entre les deux, le
    // run porte un échec terminal et un contexte encore engagé.
    await restore(w.paths, w.s1);
    const persisted = await readPersistedManifest(w.paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    const events = await openNativeEventStore(w.paths, persisted.manifest);
    const failure = await events.append({
      round: 0,
      actor: 'system',
      type: 'process_failed',
      target_expert_slot_id: 'challenger',
      // La session est LUE du manifest de ce run : un fait semé doit être
      // cohérent avec la liaison réellement construite, sinon le journal le
      // refuse pour une raison qui n'a rien à voir avec ce que le test éprouve.
      session_id: persisted.manifest.experts.challenger.session_id ?? '',
      content: 'le fournisseur n’a pas répondu',
      details: { code: 'AGENT_TIMEOUT' },
      based_on: [w.promptEventId],
      timestamp: AT,
    });

    const view = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'FAILURE_NEEDS_FINALIZATION', 'l’issue est connue, donc jamais incertaine');
    assert.equal(view.failureEventId, failure.event_id);
    assert.equal(view.requiresHumanAcknowledgement, false);

    const callsBefore = h.resumes.length;
    const outcome = await finalizeNativeSendRecovery(h.recovery, w.runId);
    assert.equal(outcome.state.state, 'PAUSED', 'l’état que 2B aurait persisté');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.view.status, 'NONE');
    assert.equal(h.resumes.length, callsBefore, 'aucun fournisseur');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// G. Interaction avec le planificateur
// ==========================================================================

test('23–24 · une réponse récupérée reste une source ordinaire, un envoi clos n’en produit aucune', async () => {
  const dir = await makeTempDir('ccr-2br-planner-');
  try {
    const h = harness(path.join(dir, 'runs'));
    // Envoi vers le slot désigné par le curseur.
    const w = await sendCapturingWindows(h, dir, { slot: 'author' });
    await restore(w.paths, w.s2);
    await finalizeNativeSendRecovery(h.recovery, w.runId);

    const persisted = await readPersistedManifest(w.paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    const state = await readPersistedState(w.paths);
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    const history = await journal(h.runsDir, w.runId);

    // La reprise ne rend pas la main à l'automatisation : le planificateur le
    // constate, et refuse — c'est la frontière humaine, pas un défaut de source.
    const underHuman = planNativeStep({
      runId: w.runId,
      manifest: persisted.manifest,
      state: state.document,
      events: history,
    });
    assert.equal(underHuman.kind, 'REFUSED');
    if (underHuman.kind === 'REFUSED') assert.equal(underHuman.reason, 'AUTOMATION_NOT_IN_CONTROL');

    // 23 · rendue à l'automatisation, la réponse récupérée est la source.
    const resumed = planNativeStep({
      runId: w.runId,
      manifest: persisted.manifest,
      state: { ...state.document, control: 'AUTOMATION' },
      events: history,
    });
    assert.equal(resumed.kind, 'READY');
    if (resumed.kind !== 'READY') return;
    assert.equal(resumed.sourceSlot, 'author', 'le curseur n’a pas bougé');
    assert.equal(resumed.sourceEventId, w.responseEventId, 'aucun marqueur ne la rend intransférable');

    // 24 · un envoi clos sans réponse ne produit aucune source.
    const closed = harness(path.join(dir, 'runs'));
    const c = await sendCapturingWindows(closed, dir, { slot: 'author' });
    await restore(c.paths, c.s0a);
    await abortNativeSendBeforeProvider(closed.recovery, c.runId);
    const closedManifest = await readPersistedManifest(c.paths);
    if (closedManifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    const closedState = await readPersistedState(c.paths);
    if (closedState.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    const closedHistory = await journal(closed.runsDir, c.runId);
    const initial = closedHistory.find(
      (event) =>
        event.type === 'assistant_response' &&
        (event as { expert_slot_id?: string }).expert_slot_id === 'author',
    );
    const plan = planNativeStep({
      runId: c.runId,
      manifest: closedManifest.manifest,
      state: { ...closedState.document, state: 'READY', control: 'AUTOMATION' },
      events: closedHistory,
    });
    assert.equal(plan.kind, 'READY');
    if (plan.kind !== 'READY') return;
    assert.equal(plan.sourceEventId, initial?.event_id, 'la source reste la position initiale');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// H. Same-provider, orphelins multiples, legacy
// ==========================================================================

test('25 · same-provider : la clôture nomme le slot, jamais le moteur', async () => {
  const dir = await makeTempDir('ccr-2br-same-');
  try {
    const h = harness(path.join(dir, 'runs'), { sessions: { claude: ['S1', 'S2'] } });
    const w = await sendCapturingWindows(h, dir, {
      slot: 'challenger',
      bindings: { author: 'claude', challenger: 'claude' },
    });
    await restore(w.paths, w.s1);

    const view = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'IN_FLIGHT_UNCERTAIN');
    assert.equal(view.targetSlot, 'challenger', 'le slot reste sans ambiguïté');

    const outcome = await acknowledgeNativeSendUncertainty(h.recovery, w.runId, NOTE);
    assert.equal(outcome.view.status, 'NONE');
    const marker = (await journal(h.runsDir, w.runId)).find(
      (event) => event.type === 'send_uncertainty_acknowledged',
    ) as unknown as Record<string, unknown>;
    assert.equal(marker['target_expert_slot_id'], 'challenger');
    assert.equal(JSON.stringify(marker).includes('claude'), false, 'aucun moteur nommé');
  } finally {
    await removeTempDir(dir);
  }
});

test('plusieurs envois orphelins ne se masquent pas les uns les autres', async () => {
  const dir = await makeTempDir('ccr-2br-orphans-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);

    // Après un crash en S0, le run reste parfaitement envoyable : rien dans
    // l'état ne trahit l'envoi perdu. Un second envoi réussit donc, et laisse
    // le premier orphelin derrière lui.
    await restore(w.paths, w.s0a);
    const second = await sendNativeMessage(h.deps, w.runId, expertSlotTarget('challenger'), 'second envoi');

    const view = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'PRE_PROVIDER_ABORTED', 'le premier envoi est toujours signalé');
    assert.equal(view.promptEventId, w.promptEventId);
    assert.deepEqual([...view.orphanPromptEventIds], [w.promptEventId], 'le second a son issue');

    await abortNativeSendBeforeProvider(h.recovery, w.runId);
    const after = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(after.status, 'NONE');
    assert.equal(
      (await journal(h.runsDir, w.runId)).filter(
        (event) => event.type === 'assistant_response' && (event.based_on ?? []).includes(second.promptEventId),
      ).length,
      1,
      'la réponse du second envoi est intacte',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('26 · un run historique est refusé par les quatre portes, sans écriture', async () => {
  const dir = await makeTempDir('ccr-2br-legacy-');
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
    const before = await capture(paths);

    for (const [name, call] of [
      ['inspect', () => inspectNativeSendRecovery(h.recovery, legacy.runId)],
      ['abort', () => abortNativeSendBeforeProvider(h.recovery, legacy.runId)],
      ['finalize', () => finalizeNativeSendRecovery(h.recovery, legacy.runId)],
      ['acknowledge', () => acknowledgeNativeSendUncertainty(h.recovery, legacy.runId, NOTE)],
    ] as readonly (readonly [string, () => Promise<unknown>])[]) {
      await expectRejection(call(), 'SCHEMA_VERSION_UNSUPPORTED', `${name} refusé`);
    }
    assert.deepEqual(await capture(paths), before, 'le run historique est intact');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// I. Reprise de la reprise — defaut A
// ==========================================================================

/**
 * Interruption exacte a la frontiere durable d'une reprise.
 *
 * Le journal est append-only, et aucune transaction ne couvre `events.jsonl`
 * **et** `state.json` : le marqueur est donc ecrit en premier, et l'exception
 * injectee reproduit precisement ce qu'un arret brutal laisserait entre les
 * deux ecritures.
 */
const INTERRUPTED = new Error('processus interrompu après le marqueur');

test('A1 · une clôture interrompue après son marqueur n’est plus « rien à faire »', async () => {
  const dir = await makeTempDir('ccr-2br-a1-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);
    assert.ok(w.s0b !== undefined);
    await restore(w.paths, w.s0b);

    await assert.rejects(
      abortNativeSendBeforeProvider(h.recovery, w.runId, {
        afterResolutionJournaled: () => {
          throw INTERRUPTED;
        },
      }),
      (error: unknown) => error === INTERRUPTED,
      'interruption injectée après le marqueur',
    );

    // Ce que l'interruption a laissé : le marqueur, et un état non finalisé.
    const stranded = await readPersistedState(w.paths);
    if (stranded.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(stranded.document.state, 'RUNNING', 'le commit n’a pas eu lieu');
    assert.equal(stranded.document.control, 'AUTOMATION', 'la frontière humaine n’est pas encore posée');
    const marker = (await journal(h.runsDir, w.runId)).find(
      (event) => event.type === 'send_aborted_before_provider',
    );
    assert.ok(marker !== undefined, 'le marqueur est durable');

    // 1 · ce n'est plus `NONE`.
    const view = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'RESOLUTION_NEEDS_COMMIT');
    assert.equal(view.resolutionEventId, marker.event_id);
    assert.equal(view.canFinalizeWithoutProvider, true);
    assert.equal(view.requiresHumanAcknowledgement, false);

    // 3 · la clôture refuse de repasser : aucun second marqueur.
    await expectRejection(
      abortNativeSendBeforeProvider(h.recovery, w.runId),
      'INVALID_ARGUMENT',
      'clôture déjà écrite',
    );

    // 2 · la finalisation locale pose l'état, sans toucher au journal.
    const callsBefore = h.resumes.length;
    const journalBefore = (await capture(w.paths)).events;
    const outcome = await finalizeNativeSendRecovery(h.recovery, w.runId);
    assert.equal(outcome.state.state, 'PAUSED');
    // 5 · la frontière humaine est restaurée.
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    // 9 · ni round, ni curseur.
    assert.equal(outcome.state.round, 0);
    assert.equal(outcome.state.next_step_source_slot, 'author');
    assert.equal(h.resumes.length, callsBefore, 'aucun fournisseur');
    assert.equal((await capture(w.paths)).events, journalBefore, 'le marqueur n’est ni réécrit ni dupliqué');
    assert.equal(
      (await journal(h.runsDir, w.runId)).filter(
        (event) => event.type === 'send_aborted_before_provider',
      ).length,
      1,
    );

    // 4 · une nouvelle reprise devient réellement `NONE`.
    assert.equal(outcome.view.status, 'NONE');
    const settled = await capture(w.paths);
    const again = await finalizeNativeSendRecovery(h.recovery, w.runId);
    assert.equal(again.view.status, 'NONE');
    assert.deepEqual(await capture(w.paths), settled, 'seconde reprise sans effet');
  } finally {
    await removeTempDir(dir);
  }
});

test('A2 · un acquittement interrompu ne redevient jamais une incertitude à acquitter', async () => {
  const dir = await makeTempDir('ccr-2br-a2-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendCapturingWindows(h, dir);
    await restore(w.paths, w.s1);

    await assert.rejects(
      acknowledgeNativeSendUncertainty(h.recovery, w.runId, NOTE, {
        afterResolutionJournaled: () => {
          throw INTERRUPTED;
        },
      }),
      (error: unknown) => error === INTERRUPTED,
      'interruption injectée après le marqueur',
    );

    // Le contexte engagé a survécu au marqueur : c'est exactement le résidu
    // qu'un second acquittement aurait pris pour une incertitude neuve.
    const stranded = await readPersistedState(w.paths);
    if (stranded.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(stranded.document.state, 'WAITING_AGENT');
    assert.equal(stranded.document.pending_operation?.kind, 'send');

    const view = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'RESOLUTION_NEEDS_COMMIT', 'l’issue fournisseur est close, une fois pour toutes');
    assert.equal(view.promptEventId, w.promptEventId);

    // 3 · un second acquittement est refusé, et ne duplique pas le marqueur.
    await expectRejection(
      acknowledgeNativeSendUncertainty(h.recovery, w.runId, NOTE),
      'INVALID_ARGUMENT',
      'incertitude déjà acquittée',
    );
    assert.equal(
      (await journal(h.runsDir, w.runId)).filter(
        (event) => event.type === 'send_uncertainty_acknowledged',
      ).length,
      1,
    );

    const callsBefore = h.resumes.length;
    const journalBefore = (await capture(w.paths)).events;
    const outcome = await finalizeNativeSendRecovery(h.recovery, w.runId);
    assert.equal(outcome.state.state, 'PAUSED');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    assert.equal(outcome.state.round, 0);
    assert.equal(outcome.state.next_step_source_slot, 'author');
    assert.equal(outcome.view.status, 'NONE');
    assert.equal(h.resumes.length, callsBefore, 'aucun fournisseur, aucun rejeu');
    assert.equal((await capture(w.paths)).events, journalBefore, 'aucun second marqueur');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// J. Initialisation partielle — defaut B
// ==========================================================================

test('B2 · une reprise S2 depuis un run partiel restaure le signalement, jamais READY', async () => {
  const dir = await makeTempDir('ccr-2br-b2-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendOnPartialRun(h, dir);

    // L'envoi natif rend le run là où il l'a pris : un expert joignable qui
    // répond ne complète pas l'initialisation de l'autre.
    assert.equal(w.sent.state.state, 'FAILED_INITIALIZATION');

    await restore(w.paths, w.s2);
    const window = await readPersistedState(w.paths);
    if (window.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(
      window.document.pending_operation?.return_state,
      'FAILED_INITIALIZATION',
      'l’état à restaurer est durable, et c’est le bon',
    );

    const callsBefore = h.resumes.length;
    const journalBefore = (await capture(w.paths)).events;
    const outcome = await finalizeNativeSendRecovery(h.recovery, w.runId);
    assert.equal(outcome.state.state, 'FAILED_INITIALIZATION');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    assert.equal(outcome.state.round, 0);
    // Le curseur n'existe pas encore : il n'y a pas deux experts entre lesquels
    // alterner. La reprise ne l'invente pas.
    assert.equal(outcome.state.next_step_source_slot, null);
    assert.equal(outcome.view.status, 'NONE');
    assert.equal(h.resumes.length, callsBefore, 'aucun fournisseur');
    assert.equal((await capture(w.paths)).events, journalBefore, 'aucune seconde réponse');

    const manifest = await readPersistedManifest(w.paths);
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(manifest.manifest.experts.challenger.session_id, null, 'la session manquante le reste');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// K. Intersection S0b + initialisation partielle
// ==========================================================================

test('P0–P1 · une clôture S0b sur run partiel rend FAILED_INITIALIZATION, jamais PAUSED', async () => {
  const dir = await makeTempDir('ccr-2br-p0-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendOnPartialRun(h, dir);

    // Avant l'envoi comme après, le run est partiellement initialisé.
    assert.equal(
      classifyRunLiveness(livenessProjection(1, 'FAILED_INITIALIZATION')).liveness,
      'PARTIAL_INITIALIZATION',
    );

    // ---- P0 · la fenêtre S0b : le message est durable, l'état est RUNNING,
    // et l'état d'origine n'existe plus nulle part.
    await restore(w.paths, w.s0b);
    const stranded = await readPersistedState(w.paths);
    if (stranded.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    assert.equal(stranded.document.state, 'RUNNING', 'l’état d’origine n’est plus lisible');
    assert.equal(stranded.document.pending_operation, null);

    const callsBefore = h.resumes.length;
    const view = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'PRE_PROVIDER_ABORTED');
    assert.equal(h.resumes.length, callsBefore, 'aucun fournisseur');

    // ---- P1 · la clôture ne masque pas l'initialisation incomplète.
    const outcome = await abortNativeSendBeforeProvider(h.recovery, w.runId);
    assert.equal(outcome.state.state, 'FAILED_INITIALIZATION', 'ni PAUSED, ni READY');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    assert.equal(outcome.state.round, 0, 'round inchangé');
    assert.equal(outcome.state.next_step_source_slot, null, 'curseur inchangé');
    assert.equal(h.resumes.length, callsBefore, 'aucun fournisseur');

    const manifest = await readPersistedManifest(w.paths);
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(manifest.manifest.experts.challenger.session_id, null, 'la session manquante le reste');
    assert.equal(
      classifyRunLiveness(livenessProjection(1, outcome.state.state)).liveness,
      'PARTIAL_INITIALIZATION',
      'le fait métier survit à la clôture',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('P2–P4 · la reprise de la reprise préserve elle aussi l’initialisation partielle', async () => {
  const dir = await makeTempDir('ccr-2br-p2-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await sendOnPartialRun(h, dir);
    await restore(w.paths, w.s0b);
    const callsBefore = h.resumes.length;

    // ---- P2 · interruption entre le marqueur et le commit d'état.
    await assert.rejects(
      abortNativeSendBeforeProvider(h.recovery, w.runId, {
        afterResolutionJournaled: () => {
          throw INTERRUPTED;
        },
      }),
      (error: unknown) => error === INTERRUPTED,
    );
    const view = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'RESOLUTION_NEEDS_COMMIT');

    // ---- P3 · la finalisation rend le run à son signalement, pas à PAUSED.
    const outcome = await finalizeNativeSendRecovery(h.recovery, w.runId);
    assert.equal(outcome.state.state, 'FAILED_INITIALIZATION');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    assert.equal(outcome.state.round, 0);
    assert.equal(outcome.state.next_step_source_slot, null);
    assert.equal(h.resumes.length, callsBefore, 'aucun fournisseur');
    assert.equal(
      (await journal(h.runsDir, w.runId)).filter(
        (event) => event.type === 'send_aborted_before_provider',
      ).length,
      1,
      'un seul marqueur',
    );

    // ---- P4 · une nouvelle inspection ne trouve plus rien à reprendre, et le
    // fait métier reste observable.
    const settled = await inspectNativeSendRecovery(h.recovery, w.runId);
    assert.equal(settled.status, 'NONE');
    const manifest = await readPersistedManifest(w.paths);
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(manifest.manifest.experts.challenger.session_id, null);
    assert.equal(
      classifyRunLiveness(livenessProjection(1, outcome.state.state)).liveness,
      'PARTIAL_INITIALIZATION',
    );
  } finally {
    await removeTempDir(dir);
  }
});

