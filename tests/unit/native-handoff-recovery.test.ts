/**
 * Slice 2C-R — Native HANDOFF Crash Recovery & Epistemic Boundary.
 *
 * Deux choses sont éprouvées ici, et elles sont indissociables.
 *
 * D'abord les fenêtres de crash : l'ordre durable de 2C écrit l'ouverture, puis
 * le contexte, puis lance — donc un contexte absent prouve qu'aucun client
 * interactif n'a vécu, et un contexte présent ne prouve rien de plus que
 * « peut-être ».
 *
 * Ensuite la conséquence épistémique : dès qu'une interaction a pu être
 * engagée, la session native a pu avancer **hors** du journal CCR. La dernière
 * réponse observée reste une trace historique, mais n'est plus une preuve
 * suffisante de la position actuelle de l'expert — et cesse donc d'être
 * transférable.
 *
 * Aucun fournisseur, aucun terminal : `openInteractive` est une fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { RunState } from '../../src/core/state.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings } from '../../src/services/native-start-service.ts';
import { handoffNativeExpert } from '../../src/services/native-handoff-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import { planNativeStep } from '../../src/services/native-step-planner.ts';
import {
  abortNativeHandoffBeforeInteractive,
  acknowledgeNativeHandoffUncertainty,
  finalizeNativeHandoffRecovery,
  inspectNativeHandoffRecovery,
} from '../../src/services/native-handoff-recovery-service.ts';
import type { NativeHandoffRecoveryDeps } from '../../src/services/native-handoff-recovery-service.ts';
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
const NOTE = 'Processus tué pendant l’attachement ; l’étendue reste inconnue.';

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
  readonly recovery: NativeHandoffRecoveryDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  readonly interactives: string[];
}

interface HarnessOptions {
  readonly sessions?: Partial<Record<ProviderKind, readonly string[]>>;
  readonly failInteractive?: () => unknown;
  readonly interactiveExitCode?: number;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  const interactives: string[] = [];
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: options.sessions?.[kind] ?? [`${kind}-1`, `${kind}-2`],
      ...(options.failInteractive === undefined ? {} : { failInteractive: options.failInteractive }),
      ...(options.interactiveExitCode === undefined
        ? {}
        : { interactiveExitCode: options.interactiveExitCode }),
      onInteractive: (sessionId) => {
        interactives.push(`${kind}:${sessionId}`);
      },
    });
  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
    runsDir,
    adapters,
    interactives,
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

async function suspendedRun(
  h: Harness,
  dir: string,
  bindings?: NativeExpertBindings,
  state: RunState = 'PAUSED',
): Promise<string> {
  const result = await startNativeRun(h.deps, {
    title: 'T',
    cwd: dir,
    prompt: MISSION,
    ...(bindings === undefined ? {} : { bindings }),
    runtimeConfig: nativeRuntime(),
  });
  assert.equal(result.failure, undefined);
  await forceState(h.runsDir, result.runId, { state, control: 'HUMAN' });
  return result.runId;
}

async function journal(runsDir: string, runId: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

interface Snapshot {
  readonly state: string;
  readonly events: string;
}

async function capture(paths: { state: string; events: string }): Promise<Snapshot> {
  return { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') };
}

async function restore(paths: { state: string; events: string }, snapshot: Snapshot): Promise<void> {
  await writeFile(paths.state, snapshot.state, 'utf8');
  await writeFile(paths.events, snapshot.events, 'utf8');
}

interface Windows {
  readonly runId: string;
  readonly paths: ReturnType<typeof runPaths>;
  /** Ouverture durable, aucun contexte. */
  readonly h0: Snapshot;
  /** Contexte durable, aucune fin. */
  readonly h1: Snapshot;
  /** Fin durable, contexte encore engagé. */
  readonly h2: Snapshot;
  readonly startedEventId: string;
  readonly finishedEventId: string;
}

/** Exécute un vrai handoff en capturant les trois instants décisifs. */
async function handoffCapturingWindows(
  h: Harness,
  dir: string,
  options: { readonly slot?: 'author' | 'challenger'; readonly bindings?: NativeExpertBindings } = {},
): Promise<Windows> {
  const runId = await suspendedRun(h, dir, options.bindings);
  const paths = runPaths(h.runsDir, runId);

  let h0: Snapshot | undefined;
  let h1: Snapshot | undefined;
  let h2: Snapshot | undefined;
  const result = await handoffNativeExpert(h.deps, runId, expertSlotTarget(options.slot ?? 'author'), {
    afterStartedJournaled: async () => {
      h0 = await capture(paths);
    },
    afterPendingPersisted: async () => {
      h1 = await capture(paths);
    },
    afterFinishedJournaled: async () => {
      h2 = await capture(paths);
    },
  });

  assert.ok(h0 !== undefined && h1 !== undefined && h2 !== undefined);
  return {
    runId,
    paths,
    h0,
    h1,
    h2,
    startedEventId: result.startedEventId,
    finishedEventId: result.finishedEventId,
  };
}

/** Journal du run, tel que le planificateur le lira. */
async function planFor(
  h: Harness,
  runId: string,
  over: { state?: RunState; control?: 'AUTOMATION' | 'HUMAN' } = {},
): Promise<ReturnType<typeof planNativeStep>> {
  const paths = runPaths(h.runsDir, runId);
  const manifest = await readPersistedManifest(paths);
  if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  const state = await readPersistedState(paths);
  if (state.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  return planNativeStep({
    runId,
    manifest: manifest.manifest,
    // Le planificateur exige un run prêt sous automatisation : la reprise rend
    // toujours la main à l'humain, et ce n'est pas la propriété testée ici.
    state: { ...state.document, state: over.state ?? 'READY', control: over.control ?? 'AUTOMATION' },
    events: await journal(h.runsDir, runId),
  });
}

// ==========================================================================
// A. Classification
// ==========================================================================

test('1–4 · H0, H1, H2 et H3 sont distingués par les seuls faits canoniques', async () => {
  const dir = await makeTempDir('ccr-2cr-windows-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await handoffCapturingWindows(h, dir);

    // 4 · H3 — le handoff est commité.
    const done = await inspectNativeHandoffRecovery(h.recovery, w.runId);
    assert.equal(done.status, 'NONE');
    assert.equal(done.orphanStartedEventIds.length, 0);

    // 3 · H2 — la fin est durable, le contexte l'est encore.
    await restore(w.paths, w.h2);
    const finished = await inspectNativeHandoffRecovery(h.recovery, w.runId);
    assert.equal(finished.status, 'FINISHED_NEEDS_COMMIT');
    assert.equal(finished.finishedEventId, w.finishedEventId);
    assert.equal(finished.canFinalizeWithoutInteractive, true);

    // 2 · H1 — le contexte est engagé, aucune fin n'existe.
    await restore(w.paths, w.h1);
    const inFlight = await inspectNativeHandoffRecovery(h.recovery, w.runId);
    assert.equal(inFlight.status, 'IN_FLIGHT_UNCERTAIN');
    assert.equal(inFlight.requiresHumanAcknowledgement, true);
    assert.equal(inFlight.canFinalizeWithoutInteractive, false);
    assert.equal(inFlight.startedEventId, w.startedEventId);

    // 1 · H0 — l'ouverture est durable, rien n'a été lancé.
    await restore(w.paths, w.h0);
    const aborted = await inspectNativeHandoffRecovery(h.recovery, w.runId);
    assert.equal(aborted.status, 'PRE_INTERACTIVE_ABORTED');
    assert.equal(aborted.targetSlot, 'author');
    assert.deepEqual([...aborted.orphanStartedEventIds], [w.startedEventId]);
  } finally {
    await removeTempDir(dir);
  }
});

test('5–6 · un échec de lancement conclu est NONE, son contexte survivant ne l’est pas', async () => {
  const dir = await makeTempDir('ccr-2cr-failure-');
  try {
    const h = harness(path.join(dir, 'runs'), {
      failInteractive: () => new CcrError('PROCESS_LAUNCH_FAILED', 'le client n’a pas démarré'),
    });
    const runId = await suspendedRun(h, dir);
    let h1: Snapshot | undefined;
    const paths = runPaths(h.runsDir, runId);

    await expectRejection(
      handoffNativeExpert(h.deps, runId, expertSlotTarget('author'), {
        afterPendingPersisted: async () => {
          h1 = await capture(paths);
        },
      }),
      'PROCESS_LAUNCH_FAILED',
      'échec déterministe',
    );

    // 5 · l'échec est entièrement finalisé par 2C : rien à reprendre.
    const settled = await inspectNativeHandoffRecovery(h.recovery, runId);
    assert.equal(settled.status, 'NONE');

    // 6 · fenêtre produite par 2C : `process_failed` durable, contexte encore
    // engagé. Ce n'est pas une incertitude — l'issue est journalisée.
    assert.ok(h1 !== undefined);
    const events = await journal(h.runsDir, runId);
    const failure = events.find((event) => event.type === 'process_failed');
    const started = events.find((event) => event.type === 'human_handoff_started');
    assert.ok(failure !== undefined && started !== undefined);
    await restore(paths, { state: h1.state, events: await readFile(paths.events, 'utf8') });

    const window = await inspectNativeHandoffRecovery(h.recovery, runId);
    assert.equal(window.status, 'FAILURE_NEEDS_FINALIZATION');
    assert.equal(window.failureEventId, failure.event_id);

    // 28–29 · finalisation locale, aucun retry, aucun marqueur d'incertitude.
    const before = h.interactives.length;
    const outcome = await finalizeNativeHandoffRecovery(h.recovery, runId);
    assert.equal(outcome.state.state, 'PAUSED');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.view.status, 'NONE');
    assert.equal(h.interactives.length, before, 'aucune réouverture');
    assert.equal(
      (await journal(h.runsDir, runId)).filter((event) => event.type === 'handoff_uncertainty_acknowledged')
        .length,
      0,
      'un échec connu n’est pas une incertitude',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('7 · des faits contradictoires ferment la reprise au lieu de choisir', async () => {
  const dir = await makeTempDir('ccr-2cr-conflict-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await handoffCapturingWindows(h, dir);

    const cases: readonly (readonly [string, Snapshot])[] = [
      // Contexte désignant une ouverture inexistante.
      [
        'ouverture fantôme',
        {
          state: JSON.stringify({
            ...(JSON.parse(w.h1.state) as Record<string, unknown>),
            pending_operation: {
              ...((JSON.parse(w.h1.state) as { pending_operation: Record<string, unknown> })
                .pending_operation),
              prompt_event_id: 'evt_000404',
            },
          }),
          events: w.h1.events,
        },
      ],
      // Contexte visant un slot que l'ouverture ne visait pas.
      [
        'slot du contexte',
        {
          state: JSON.stringify({
            ...(JSON.parse(w.h1.state) as Record<string, unknown>),
            pending_operation: {
              ...((JSON.parse(w.h1.state) as { pending_operation: Record<string, unknown> })
                .pending_operation),
              expert_slot: 'challenger',
            },
          }),
          events: w.h1.events,
        },
      ],
      // Deux fins pour la même ouverture.
      [
        'deux fins',
        {
          state: w.h2.state,
          events: (() => {
            const records = w.h2.events
              .split('\n')
              .filter((line) => line.trim() !== '')
              .map((line) => JSON.parse(line) as Record<string, unknown>);
            const finished = records.find((record) => record['event_id'] === w.finishedEventId);
            return `${[...records, { ...finished, event_id: 'evt_000099' }]
              .map((record) => JSON.stringify(record))
              .join('\n')}\n`;
          })(),
        },
      ],
    ];

    for (const [name, snapshot] of cases) {
      await restore(w.paths, snapshot);
      const view = await inspectNativeHandoffRecovery(h.recovery, w.runId);
      assert.equal(view.status, 'EVIDENCE_CONFLICT', `${name} · échec fermé`);
      assert.ok(view.conflicts.length > 0, `${name} · la contradiction est nommée`);

      const before = await capture(w.paths);
      await expectRejection(
        finalizeNativeHandoffRecovery(h.recovery, w.runId),
        'STATE_INVALID',
        `${name} · aucune réparation`,
      );
      assert.deepEqual(await capture(w.paths), before, `${name} · rien n’a été écrit`);
    }
    assert.equal(h.interactives.length, 1, 'un seul attachement, celui du handoff initial');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. H0 — clôture sans effet rétroactif
// ==========================================================================

test('8–11 · la clôture H0 est un marqueur, et rien d’autre', async () => {
  const dir = await makeTempDir('ccr-2cr-h0-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await handoffCapturingWindows(h, dir);
    await restore(w.paths, w.h0);

    // 10 · le run a légitimement progressé depuis l'ouverture perdue : il a été
    // rendu à l'automatisation, et son état ne doit pas être rembobiné.
    await forceState(h.runsDir, w.runId, { state: 'READY', control: 'AUTOMATION' });
    const stateBefore = await readFile(w.paths.state, 'utf8');
    const interactivesBefore = h.interactives.length;

    const outcome = await abortNativeHandoffBeforeInteractive(h.recovery, w.runId);
    assert.equal(outcome.view.status, 'NONE', 'la fenêtre est refermée');
    // 9 · aucune réouverture interactive.
    assert.equal(h.interactives.length, interactivesBefore);
    // 10 · l'état courant est intact, octet pour octet.
    assert.equal(await readFile(w.paths.state, 'utf8'), stateBefore, 'aucune mutation rétroactive');

    // 8 · un seul marqueur, et c'est celui du bon fait.
    const markers = (await journal(h.runsDir, w.runId)).filter(
      (event) => event.type === 'handoff_aborted_before_interactive',
    );
    assert.equal(markers.length, 1);
    const marker = markers[0] as unknown as Record<string, unknown>;
    assert.equal(marker['started_event_id'], w.startedEventId);
    assert.equal(marker['target_expert_slot_id'], 'author');
    assert.equal(marker['reason'], 'PRE_INTERACTIVE_ABORTED');
    assert.equal('session_id' in marker, false, 'aucune session n’est prétendue atteinte');
    assert.equal('response_event_id' in marker, false);

    // 11 · une seconde clôture ne duplique rien.
    const settled = await capture(w.paths);
    const again = await abortNativeHandoffBeforeInteractive(h.recovery, w.runId);
    assert.equal(again.view.status, 'NONE');
    assert.deepEqual(await capture(w.paths), settled, 'seconde invocation sans effet');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. H1 — incertitude
// ==========================================================================

test('12–18 · H1 s’acquitte, ne se finalise pas, et ne se rouvre jamais', async () => {
  const dir = await makeTempDir('ccr-2cr-h1-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await handoffCapturingWindows(h, dir);
    await restore(w.paths, w.h1);
    const interactivesBefore = h.interactives.length;

    // 12 · l'inspection n'écrit rien.
    const before = await capture(w.paths);
    assert.equal((await inspectNativeHandoffRecovery(h.recovery, w.runId)).status, 'IN_FLIGHT_UNCERTAIN');
    assert.deepEqual(await capture(w.paths), before, 'inspection sans effet');

    // 13 · la finalisation directe est refusée, sans rien écrire.
    await expectRejection(
      finalizeNativeHandoffRecovery(h.recovery, w.runId),
      'RECOVERY_REQUIRED',
      'finalisation directe refusée',
    );
    assert.deepEqual(await capture(w.paths), before, 'le refus n’a rien écrit');
    await expectRejection(
      acknowledgeNativeHandoffUncertainty(h.recovery, w.runId, '  '),
      'INVALID_ARGUMENT',
      'acquittement sans note refusé',
    );

    // 14–17 · un seul marqueur, qui ne conclut rien, et un commit local.
    const outcome = await acknowledgeNativeHandoffUncertainty(h.recovery, w.runId, NOTE);
    assert.equal(outcome.view.status, 'NONE');
    assert.equal(outcome.state.state, 'PAUSED', '17 · état d’origine restauré');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    assert.equal(outcome.state.round, 0);
    assert.equal(outcome.state.next_step_source_slot, 'author');
    assert.equal(h.interactives.length, interactivesBefore, 'aucune réouverture');

    const markers = (await journal(h.runsDir, w.runId)).filter(
      (event) => event.type === 'handoff_uncertainty_acknowledged',
    );
    assert.equal(markers.length, 1);
    const marker = markers[0] as unknown as Record<string, unknown>;
    assert.equal(marker['started_event_id'], w.startedEventId);
    assert.equal(marker['reason'], 'IN_FLIGHT_UNCERTAIN');
    assert.equal(marker['content'], NOTE);
    assert.equal((marker['details'] as Record<string, unknown>)['cost'], 'NOT CONTROLLED / NOT MEASURED');
    assert.equal(
      (await journal(h.runsDir, w.runId)).filter((event) => event.type === 'human_handoff_finished').length,
      0,
      'aucune fin inventée',
    );

    // 18 · un second acquittement ne duplique pas le marqueur.
    const settled = await capture(w.paths);
    await expectRejection(
      acknowledgeNativeHandoffUncertainty(h.recovery, w.runId, NOTE),
      'INVALID_ARGUMENT',
      'second acquittement refusé',
    );
    assert.deepEqual(await capture(w.paths), settled, 'aucune duplication');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Reprise de la reprise
// ==========================================================================

test('19–22 · un acquittement interrompu avant son commit se termine, sans second marqueur', async () => {
  const dir = await makeTempDir('ccr-2cr-rr-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await handoffCapturingWindows(h, dir);
    await restore(w.paths, w.h1);

    const interrupted = new Error('processus interrompu après le marqueur');
    await assert.rejects(
      acknowledgeNativeHandoffUncertainty(h.recovery, w.runId, NOTE, {
        afterResolutionJournaled: () => {
          throw interrupted;
        },
      }),
      (error: unknown) => error === interrupted,
    );

    // 19 · le contexte a survécu au marqueur : ce n'est plus une incertitude à
    // acquitter, et surtout pas « rien à faire ».
    const view = await inspectNativeHandoffRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'RESOLUTION_NEEDS_COMMIT');
    assert.equal(view.canFinalizeWithoutInteractive, true);

    await expectRejection(
      acknowledgeNativeHandoffUncertainty(h.recovery, w.runId, NOTE),
      'INVALID_ARGUMENT',
      'acquittement déjà écrit',
    );

    // 20–21 · finalisation locale, journal inchangé.
    const interactivesBefore = h.interactives.length;
    const journalBefore = (await capture(w.paths)).events;
    const outcome = await finalizeNativeHandoffRecovery(h.recovery, w.runId);
    assert.equal(outcome.state.state, 'PAUSED');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    assert.equal(h.interactives.length, interactivesBefore);
    assert.equal((await capture(w.paths)).events, journalBefore, 'aucun second marqueur');
    assert.equal(
      (await journal(h.runsDir, w.runId)).filter(
        (event) => event.type === 'handoff_uncertainty_acknowledged',
      ).length,
      1,
    );

    // 22 · la reprise suivante n'a plus rien à faire.
    assert.equal(outcome.view.status, 'NONE');
    assert.equal((await inspectNativeHandoffRecovery(h.recovery, w.runId)).status, 'NONE');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. H2 — finalisation locale
// ==========================================================================

test('23–27 · H2 se finalise localement, sans réouverture et sans seconde fin', async () => {
  for (const origin of ['PAUSED', 'WAITING_HUMAN'] as readonly RunState[]) {
    const dir = await makeTempDir('ccr-2cr-h2-');
    try {
      const h = harness(path.join(dir, 'runs'));
      const runId = await suspendedRun(h, dir, undefined, origin);
      const paths = runPaths(h.runsDir, runId);

      let h2: Snapshot | undefined;
      await handoffNativeExpert(h.deps, runId, expertSlotTarget('challenger'), {
        afterFinishedJournaled: async () => {
          h2 = await capture(paths);
        },
      });
      assert.ok(h2 !== undefined);
      await restore(paths, h2);

      const interactivesBefore = h.interactives.length;
      const journalBefore = (await capture(paths)).events;
      const outcome = await finalizeNativeHandoffRecovery(h.recovery, runId);

      // 23 · aucune réouverture.
      assert.equal(h.interactives.length, interactivesBefore);
      // 24–25 · le journal est identique : la fin durable EST le fait.
      assert.equal((await capture(paths)).events, journalBefore);
      assert.equal(
        (await journal(h.runsDir, runId)).filter((event) => event.type === 'human_handoff_finished').length,
        1,
      );
      // 26 · état d'origine restauré, contrôle humain.
      assert.equal(outcome.state.state, origin, `${origin} → ${origin}`);
      assert.equal(outcome.state.control, 'HUMAN');
      assert.equal(outcome.state.pending_operation, null);
      assert.equal(outcome.state.active_expert_slot, null);
      // 27 · ni curseur, ni round, ni artefact.
      assert.equal(outcome.state.round, 0);
      assert.equal(outcome.state.next_step_source_slot, 'author');
      assert.equal((await readdir(paths.roundsDir)).length, 0);
      assert.equal(outcome.view.status, 'NONE');

      // Idempotence.
      const settled = await capture(paths);
      assert.equal((await finalizeNativeHandoffRecovery(h.recovery, runId)).view.status, 'NONE');
      assert.deepEqual(await capture(paths), settled);
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// F. Barrière épistémique
// ==========================================================================

test('31–34 · une interaction terminée périme la position, une nouvelle réponse la rétablit', async () => {
  const dir = await makeTempDir('ccr-2cr-barrier-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const runId = await suspendedRun(h, dir);

    // Avant tout handoff, la position initiale de l'auteur est transférable.
    const before = await planFor(h, runId);
    assert.equal(before.kind, 'READY');
    if (before.kind !== 'READY') return;

    // 31–32 · handoff sur le slot du curseur : sa position n'est plus une preuve.
    await handoffNativeExpert(h.deps, runId, expertSlotTarget('author'));
    const after = await planFor(h, runId);
    assert.equal(after.kind, 'REFUSED');
    if (after.kind !== 'REFUSED') return;
    assert.equal(after.reason, 'SOURCE_STALE_AFTER_HANDOFF');
    assert.equal(after.error.code, 'SOURCE_STALE_AFTER_HANDOFF');
    assert.equal(after.error.details?.['source_slot'], 'author');
    assert.equal(after.error.details?.['barrier_type'], 'human_handoff_finished');

    // 33 · aucun repli vers une réponse plus ancienne : la seule réponse de
    // l'auteur est celle-là, et le refus ne cherche pas ailleurs.
    assert.equal(after.error.details?.['source_event_id'], before.sourceEventId);

    // 34 · un nouvel envoi humain produit une réponse postérieure à la
    // barrière, et rétablit l'ancrage.
    await forceState(h.runsDir, runId, { state: 'PAUSED', control: 'HUMAN' });
    const sent = await sendNativeMessage(h.deps, runId, expertSlotTarget('author'), 'où en es-tu ?');
    const restored = await planFor(h, runId);
    assert.equal(restored.kind, 'READY');
    if (restored.kind !== 'READY') return;
    assert.equal(restored.sourceEventId, sent.responseEventId, 'la nouvelle réponse est la source');
  } finally {
    await removeTempDir(dir);
  }
});

test('35–40 · la barrière est strictement par slot, et seule une interaction possible la pose', async () => {
  const dir = await makeTempDir('ccr-2cr-barrier-slots-');
  try {
    const runsDir = path.join(dir, 'runs');

    // 35 · un handoff sur l'autre slot ne bloque pas le slot du curseur.
    const other = harness(runsDir);
    const otherRun = await suspendedRun(other, dir);
    await handoffNativeExpert(other.deps, otherRun, expertSlotTarget('challenger'));
    const otherPlan = await planFor(other, otherRun);
    assert.equal(otherPlan.kind, 'READY', 'le curseur est sur author, la barrière sur challenger');

    // 36 · un acquittement d'incertitude pose la même barrière.
    const uncertain = harness(runsDir);
    const uncertainRun = await suspendedRun(uncertain, dir);
    const uncertainPaths = runPaths(runsDir, uncertainRun);
    let h1: Snapshot | undefined;
    await handoffNativeExpert(uncertain.deps, uncertainRun, expertSlotTarget('author'), {
      afterPendingPersisted: async () => {
        h1 = await capture(uncertainPaths);
      },
    });
    assert.ok(h1 !== undefined);
    await restore(uncertainPaths, h1);
    await acknowledgeNativeHandoffUncertainty(uncertain.recovery, uncertainRun, NOTE);
    const acknowledged = await planFor(uncertain, uncertainRun);
    assert.equal(acknowledged.kind, 'REFUSED');
    if (acknowledged.kind !== 'REFUSED') return;
    assert.equal(acknowledged.reason, 'SOURCE_STALE_AFTER_HANDOFF');
    assert.equal(acknowledged.error.details?.['barrier_type'], 'handoff_uncertainty_acknowledged');

    // 37 · une clôture avant lancement ne périme rien : CCR **sait** qu'aucune
    // interaction n'a eu lieu.
    const abortedHarness = harness(runsDir);
    const abortedRun = await suspendedRun(abortedHarness, dir);
    const abortedPaths = runPaths(runsDir, abortedRun);
    let h0: Snapshot | undefined;
    await handoffNativeExpert(abortedHarness.deps, abortedRun, expertSlotTarget('author'), {
      afterStartedJournaled: async () => {
        h0 = await capture(abortedPaths);
      },
    });
    assert.ok(h0 !== undefined);
    await restore(abortedPaths, h0);
    await abortNativeHandoffBeforeInteractive(abortedHarness.recovery, abortedRun);
    assert.equal((await planFor(abortedHarness, abortedRun)).kind, 'READY', 'aucune barrière');

    // 38 · un échec de lancement déterministe ne périme rien non plus.
    const failed = harness(runsDir, {
      failInteractive: () => new CcrError('PROCESS_LAUNCH_FAILED', 'le client n’a pas démarré'),
    });
    const failedRun = await suspendedRun(failed, dir);
    await expectRejection(
      handoffNativeExpert(failed.deps, failedRun, expertSlotTarget('author')),
      'PROCESS_LAUNCH_FAILED',
      'échec de lancement',
    );
    assert.equal((await planFor(failed, failedRun)).kind, 'READY', 'rien n’a vécu, rien n’est périmé');

    // 39 · un code de sortie non nul reste une interaction : la barrière tient.
    const nonZero = harness(runsDir, { interactiveExitCode: 3 });
    const nonZeroRun = await suspendedRun(nonZero, dir);
    await handoffNativeExpert(nonZero.deps, nonZeroRun, expertSlotTarget('author'));
    const nonZeroPlan = await planFor(nonZero, nonZeroRun);
    assert.equal(nonZeroPlan.kind, 'REFUSED');
    if (nonZeroPlan.kind !== 'REFUSED') return;
    assert.equal(nonZeroPlan.reason, 'SOURCE_STALE_AFTER_HANDOFF');

    // 40 · same-provider : l'identité est le slot, jamais le moteur.
    const same = harness(runsDir, { sessions: { claude: ['S1', 'S2'] } });
    const sameRun = await suspendedRun(same, dir, { author: 'claude', challenger: 'claude' });
    await handoffNativeExpert(same.deps, sameRun, expertSlotTarget('challenger'));
    assert.equal(
      (await planFor(same, sameRun)).kind,
      'READY',
      'le handoff du contradicteur ne périme pas l’auteur, même moteur partagé',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// G. Legacy
// ==========================================================================

test('41 · un run historique est refusé par les quatre portes, sans écriture', async () => {
  const dir = await makeTempDir('ccr-2cr-legacy-');
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
      ['inspect', () => inspectNativeHandoffRecovery(h.recovery, legacy.runId)],
      ['abort', () => abortNativeHandoffBeforeInteractive(h.recovery, legacy.runId)],
      ['finalize', () => finalizeNativeHandoffRecovery(h.recovery, legacy.runId)],
      ['acknowledge', () => acknowledgeNativeHandoffUncertainty(h.recovery, legacy.runId, NOTE)],
    ] as readonly (readonly [string, () => Promise<unknown>])[]) {
      await expectRejection(call(), 'SCHEMA_VERSION_UNSUPPORTED', `${name} refusé`);
    }
    assert.deepEqual(await capture(paths), before, 'le run historique est intact');
    assert.equal(h.interactives.length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// H. Défaillance locale avant lancement
// ==========================================================================

/** Handoff dont la **construction d'adapter** échoue, avant tout lancement. */
async function handoffWithBrokenFactory(h: Harness, runId: string, slot: 'author' | 'challenger'): Promise<void> {
  const broken: RunServiceDeps = {
    ...h.deps,
    createAdapters: () => {
      throw new CcrError('AGENT_EXECUTABLE_UNRESOLVED', 'aucun exécutable résolu');
    },
  };
  await expectRejection(
    handoffNativeExpert(broken, runId, expertSlotTarget(slot)),
    'AGENT_EXECUTABLE_UNRESOLVED',
    'échec déterministe pré-lancement',
  );
}

test('B–D · une défaillance locale pré-lancement ne devient ni incertitude ni barrière', async () => {
  const dir = await makeTempDir('ccr-2cr-prelaunch-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const runId = await suspendedRun(h, dir);

    // La position de l'auteur est fraîche avant la tentative.
    const before = await planFor(h, runId);
    assert.equal(before.kind, 'READY');
    if (before.kind !== 'READY') return;

    await handoffWithBrokenFactory(h, runId, 'author');
    assert.equal(h.interactives.length, 0, 'aucun client interactif approché');

    // B · la reprise n'a rien à faire : l'issue est journalisée.
    const view = await inspectNativeHandoffRecovery(h.recovery, runId);
    assert.equal(view.status, 'NONE');
    assert.notEqual(view.status, 'IN_FLIGHT_UNCERTAIN');
    assert.equal(view.orphanStartedEventIds.length, 0, 'l’ouverture porte son issue');

    // D · aucune fausse barrière : ni fin, ni acquittement.
    const events = await journal(h.runsDir, runId);
    assert.equal(events.filter((event) => event.type === 'human_handoff_finished').length, 0);
    assert.equal(
      events.filter((event) => event.type === 'handoff_uncertainty_acknowledged').length,
      0,
      'rien à acquitter, donc rien d’acquitté',
    );
    assert.equal(events.filter((event) => event.type === 'process_failed').length, 1);

    // C · la source d'origine reste fraîche : rien n'a pu faire avancer la
    // session native.
    const after = await planFor(h, runId);
    assert.equal(after.kind, 'READY', 'aucune SOURCE_STALE_AFTER_HANDOFF');
    if (after.kind !== 'READY') return;
    assert.equal(after.sourceEventId, before.sourceEventId, 'la même source, toujours transférable');
  } finally {
    await removeTempDir(dir);
  }
});

test('E · un reject d’openInteractive reste lui aussi pré-interactif', async () => {
  const dir = await makeTempDir('ccr-2cr-prelaunch-reject-');
  try {
    // Contrat des deux adapters, établi par le micro-gate : tout reject vient
    // d'un échec de spawn, donc d'avant l'existence du client.
    const h = harness(path.join(dir, 'runs'), {
      failInteractive: () => new CcrError('EXECUTABLE_NOT_FOUND', 'exécutable introuvable'),
    });
    const runId = await suspendedRun(h, dir);
    const before = await planFor(h, runId);
    assert.equal(before.kind, 'READY');

    await expectRejection(
      handoffNativeExpert(h.deps, runId, expertSlotTarget('author')),
      'EXECUTABLE_NOT_FOUND',
      'échec de lancement',
    );

    assert.equal((await inspectNativeHandoffRecovery(h.recovery, runId)).status, 'NONE');
    const events = await journal(h.runsDir, runId);
    assert.equal(events.filter((event) => event.type === 'process_failed').length, 1);
    assert.equal(events.filter((event) => event.type === 'human_handoff_finished').length, 0);
    assert.equal((await planFor(h, runId)).kind, 'READY', 'aucune barrière');
  } finally {
    await removeTempDir(dir);
  }
});

