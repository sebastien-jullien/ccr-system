/**
 * V2.1-IMP-16 — contrôle humain natif : `pause` et `resume`.
 *
 * Le défaut fermé ici est une impasse, pas une gêne : aucun écrivain natif ne
 * rendait le contrôle à l'automatisation, si bien qu'un simple timeout de
 * fournisseur — ou n'importe quelle finalisation de reprise — laissait un run
 * sain **définitivement** incapable de produire un tour.
 *
 * La propriété centrale de ce fichier tient en une asymétrie :
 *
 * ```text
 * gagner en autonomie    HUMAN → AUTOMATION   fail-closed sur EVIDENCE_CONFLICT
 * en perdre              → HUMAN              toujours permis
 * ```
 *
 * et en son complément : un diagnostic de reprise **non bloquant** ne devient
 * pas une barrière parce qu'il est visible. Trois d'entre eux sont éprouvés
 * nommément.
 *
 * Aucun fournisseur, aucun adapter, aucun processus. Les runs sont matérialisés
 * par les stores canoniques, en reproduisant les séquences que les moteurs
 * écrivent réellement — et les dépendances du service ne portent aucune
 * fabrique d'adapter, ce qui rend l'invocation d'un fournisseur structurellement
 * impossible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../../src/core/run-native.ts';
import type {
  NativeCcrEvent,
  NativePendingOperation,
  NativeRunManifest,
  NativeRunStateDocument,
} from '../../src/core/run-native.ts';
import type { RunState } from '../../src/core/state.ts';
import { pauseNativeRun, resumeNativeRun } from '../../src/services/native-control-service.ts';
import type { NativeControlDeps } from '../../src/services/native-control-service.ts';
import { buildNativeRunReadModel } from '../../src/services/native-read-model.ts';
import { planNativeStep } from '../../src/services/native-step-planner.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import type { NativeEventStore } from '../../src/store/native-event-store.ts';
import {
  readPersistedManifest,
  readPersistedState,
  writeNativeManifest,
  writeNativeState,
} from '../../src/store/native-store.ts';
import { materializeRun } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-001';
const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

function deps(runsDir: string): NativeControlDeps {
  return { runsDir, now: () => new Date(AT) };
}

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Matérialisation
// --------------------------------------------------------------------------

interface Bindings {
  readonly author: ProviderKind;
  readonly challenger: ProviderKind;
}

const SESSIONS = { author: 'codex-1', challenger: 'claude-1' } as const;

function manifestOf(bindings: Bindings = { author: 'codex', challenger: 'claude' }): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Contre-expertise',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: bindings.author, session_id: SESSIONS.author },
      challenger: { provider: bindings.challenger, session_id: SESSIONS.challenger },
    },
    runtime_config: {
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
    },
  };
}

function stateOf(over: Partial<NativeRunStateDocument> = {}): NativeRunStateDocument {
  return {
    schema_version: NATIVE_STATE_SCHEMA_VERSION,
    run_id: RUN_ID,
    state: 'READY',
    control: 'AUTOMATION',
    round: 0,
    active_expert_slot: null,
    next_step_source_slot: 'author',
    last_event_id: null,
    pending_operation: null,
    uncertainty: null,
    updated_at: AT,
    ...over,
  };
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: ReturnType<typeof runPaths>;
  readonly events: NativeEventStore;
  readonly manifest: NativeRunManifest;
  /** Dernière réponse de l'AUTHOR : la source du premier transfert. */
  readonly authorResponse: string;
}

/** START d'un slot, tel que `initializeNativeSlot` l'écrit. */
async function startSlot(events: NativeEventStore, slot: ExpertSlotId, session: string): Promise<string> {
  const prompt = await events.append({
    round: 0,
    actor: 'human',
    type: 'prompt_sent',
    target_expert_slot_id: slot,
    content: MISSION,
    timestamp: AT,
  });
  const response = await events.append({
    round: 0,
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: slot,
    session_id: session,
    content: `position initiale de ${slot}`,
    exit_code: 0,
    based_on: [prompt.event_id],
    timestamp: AT,
  });
  await events.append({
    round: 0,
    actor: 'system',
    type: 'session_created',
    expert_slot_id: slot,
    session_id: session,
    timestamp: AT,
  });
  return response.event_id;
}

/** Run natif complet, prêt à transférer — l'état de sortie de START. */
async function readyRun(dir: string, state: Partial<NativeRunStateDocument> = {}): Promise<Fixture> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  const manifest = manifestOf();
  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, stateOf(state));
  const events = await openNativeEventStore(paths, manifest);
  const authorResponse = await startSlot(events, 'author', SESSIONS.author);
  await startSlot(events, 'challenger', SESSIONS.challenger);
  return { runsDir, paths, events, manifest, authorResponse };
}

async function currentState(fixture: Fixture): Promise<NativeRunStateDocument> {
  const persisted = await readPersistedState(fixture.paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  return persisted.document;
}

async function journal(fixture: Fixture): Promise<readonly NativeCcrEvent[]> {
  return (await openNativeEventStore(fixture.paths, fixture.manifest)).readAll();
}

function countOf(events: readonly NativeCcrEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

async function bytes(fixture: Fixture): Promise<{ state: string; events: string }> {
  return {
    state: await readFile(fixture.paths.state, 'utf8'),
    events: await readFile(fixture.paths.events, 'utf8'),
  };
}

/** Réécrit l'état : la matérialisation d'une fenêtre n'est pas une transition. */
async function forceState(fixture: Fixture, over: Partial<NativeRunStateDocument>): Promise<void> {
  await writeNativeState(fixture.paths, stateOf({ ...(await currentState(fixture)), ...over }));
}

function stepPending(over: Partial<NativePendingOperation> = {}): NativePendingOperation {
  return {
    kind: 'step',
    source_slot: 'author',
    target_slot: 'challenger',
    source_event_id: 'evt_000002',
    round: 1,
    prompt_event_id: null,
    session_id: SESSIONS.challenger,
    return_state: 'READY',
    return_control: 'AUTOMATION',
    started_at: AT,
    ...over,
  } as NativePendingOperation;
}

/** Ouverture de round, telle que `stepNativeRun` l'écrit avant tout appel. */
async function openRound(fixture: Fixture): Promise<string> {
  const started = await fixture.events.append({
    round: 1,
    actor: 'system',
    type: 'round_started',
    target_expert_slot_id: 'challenger',
    based_on: [fixture.authorResponse],
    details: {
      round: 1,
      source_slot: 'author',
      target_slot: 'challenger',
      source_event_id: fixture.authorResponse,
    },
    timestamp: AT,
  });
  return started.event_id;
}

async function readModel(fixture: Fixture): Promise<Awaited<ReturnType<typeof buildNativeRunReadModel>>> {
  return buildNativeRunReadModel({ runsDir: fixture.runsDir }, RUN_ID);
}

// ==========================================================================
// A. `pause`
// ==========================================================================

test('1–3 · pause suspend un run automatisé sans toucher au round ni au curseur', async () => {
  const dir = await makeTempDir('ccr-imp16-pause-');
  try {
    const fixture = await readyRun(dir);
    const before = await currentState(fixture);

    const result = await pauseNativeRun(deps(fixture.runsDir), RUN_ID);

    // 1 · READY / AUTOMATION → PAUSED / HUMAN.
    assert.equal(result.changed, true);
    assert.equal(result.state.state, 'PAUSED');
    assert.equal(result.state.control, 'HUMAN');

    // 2 · exactement un `run_paused`, et aucun type inventé.
    const events = await journal(fixture);
    assert.equal(countOf(events, 'run_paused'), 1);
    const paused = events.find((event) => event.type === 'run_paused');
    assert.equal(paused?.actor, 'human');
    assert.deepEqual(paused?.details, {
      state_from: 'READY',
      state_to: 'PAUSED',
      control_from: 'AUTOMATION',
      control_to: 'HUMAN',
    });
    // Classe generation-neutral : aucune identité de slot, aucune session.
    assert.equal('session_id' in (paused as unknown as Record<string, unknown>), false);
    assert.equal('target_expert_slot_id' in (paused as unknown as Record<string, unknown>), false);

    // 3 · tout le reste de l'état natif traverse la suspension intact.
    const after = await currentState(fixture);
    assert.equal(after.round, before.round);
    assert.equal(after.next_step_source_slot, before.next_step_source_slot);
    assert.equal(after.active_expert_slot, null);
    assert.equal(after.pending_operation, null);
    assert.equal(after.last_event_id, paused?.event_id);

    // Le handoff, refusé sur un run automatisé, devient atteignable : c'est
    // toute la raison d'être de `pause` en V2.1.
    const view = await readModel(fixture);
    assert.equal(view.operations.experts.author.handoff.allowed, true);
  } finally {
    await removeTempDir(dir);
  }
});

test('4–5 · pause est idempotente, et ne requalifie jamais WAITING_HUMAN', async () => {
  const dir = await makeTempDir('ccr-imp16-pause-noop-');
  try {
    const fixture = await readyRun(dir, { state: 'PAUSED', control: 'HUMAN' });

    // 4 · déjà satisfaite : succès, aucun événement.
    const before = await bytes(fixture);
    const noop = await pauseNativeRun(deps(fixture.runsDir), RUN_ID);
    assert.equal(noop.changed, false);
    assert.equal(noop.state.state, 'PAUSED');
    assert.deepEqual(await bytes(fixture), before, 'un NOOP n’écrit rien');

    // 5 · `WAITING_HUMAN` reste `WAITING_HUMAN` : une impossibilité constatée
    // par CCR et une suspension humaine ne disent pas la même chose.
    await forceState(fixture, { state: 'WAITING_HUMAN', control: 'AUTOMATION' });
    const kept = await pauseNativeRun(deps(fixture.runsDir), RUN_ID);
    assert.equal(kept.changed, true);
    assert.equal(kept.state.state, 'WAITING_HUMAN');
    assert.equal(kept.state.control, 'HUMAN');
    const paused = (await journal(fixture)).find((event) => event.type === 'run_paused');
    assert.equal((paused?.details as Record<string, unknown>)['state_to'], 'WAITING_HUMAN');
  } finally {
    await removeTempDir(dir);
  }
});

test('6 · un contexte engagé bloque pause comme resume', async () => {
  const dir = await makeTempDir('ccr-imp16-pending-');
  try {
    // Fenêtre réellement produite par 2C : le handoff pose son contexte sans
    // transitionner, donc PAUSED / HUMAN avec une opération engagée.
    const fixture = await readyRun(dir, { state: 'PAUSED', control: 'HUMAN' });
    const started = await fixture.events.append({
      round: 0,
      actor: 'human',
      type: 'human_handoff_started',
      target_expert_slot_id: 'challenger',
      session_id: SESSIONS.challenger,
      details: { state: 'PAUSED', control: 'HUMAN' },
      timestamp: AT,
    });
    await forceState(fixture, {
      active_expert_slot: 'challenger',
      last_event_id: started.event_id,
      pending_operation: {
        kind: 'handoff',
        expert_slot: 'challenger',
        round: 0,
        prompt_event_id: started.event_id,
        session_id: SESSIONS.challenger,
        return_state: 'PAUSED',
        return_control: 'HUMAN',
        started_at: AT,
      },
    });

    const before = await bytes(fixture);
    await expectRejection(pauseNativeRun(deps(fixture.runsDir), RUN_ID), 'RECOVERY_REQUIRED', 'pause');
    await expectRejection(resumeNativeRun(deps(fixture.runsDir), RUN_ID), 'RECOVERY_REQUIRED', 'resume');
    assert.deepEqual(await bytes(fixture), before, 'un refus n’écrit rien');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. `resume`
// ==========================================================================

test('7–9 · resume rend le contrôle sans rien lancer ni déplacer', async () => {
  const dir = await makeTempDir('ccr-imp16-resume-');
  try {
    const fixture = await readyRun(dir, { state: 'PAUSED', control: 'HUMAN', round: 2, next_step_source_slot: 'challenger' });

    const result = await resumeNativeRun(deps(fixture.runsDir), RUN_ID);

    // 7 · PAUSED / HUMAN → READY / AUTOMATION.
    assert.equal(result.changed, true);
    assert.equal(result.state.state, 'READY');
    assert.equal(result.state.control, 'AUTOMATION');

    // 8 · exactement un `run_resumed`.
    const events = await journal(fixture);
    assert.equal(countOf(events, 'run_resumed'), 1);
    const resumed = events.find((event) => event.type === 'run_resumed');
    assert.equal(resumed?.actor, 'human');

    // 9 · round, curseur et bindings sont ceux d'avant.
    assert.equal(result.state.round, 2);
    assert.equal(result.state.next_step_source_slot, 'challenger');
    const persisted = await readPersistedManifest(fixture.paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(persisted.manifest.experts.author.session_id, SESSIONS.author);
    assert.equal(persisted.manifest.experts.challenger.session_id, SESSIONS.challenger);

    // 10 · déjà exécutable : NOOP sans écriture.
    const before = await bytes(fixture);
    const noop = await resumeNativeRun(deps(fixture.runsDir), RUN_ID);
    assert.equal(noop.changed, false);
    assert.deepEqual(await bytes(fixture), before);
  } finally {
    await removeTempDir(dir);
  }
});

test('11 · FAILED_INITIALIZATION exige son mécanisme propre, pas resume', async () => {
  const dir = await makeTempDir('ccr-imp16-failed-init-');
  try {
    const fixture = await readyRun(dir, { state: 'FAILED_INITIALIZATION', control: 'HUMAN' });
    const before = await bytes(fixture);
    await expectRejection(resumeNativeRun(deps(fixture.runsDir), RUN_ID), 'RUN_NOT_RESUMABLE', 'resume refusé');
    assert.deepEqual(await bytes(fixture), before);
    // `pause` ne le transforme pas davantage : cet état a son propre chemin.
    await expectRejection(pauseNativeRun(deps(fixture.runsDir), RUN_ID), 'RUN_NOT_PAUSABLE', 'pause refusée');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. `EVIDENCE_CONFLICT` — l'asymétrie
// ==========================================================================

/**
 * Contradiction déterministe : un même message humain porte deux réponses.
 *
 * Une tentative n'en a qu'une. CCR ne choisit pas laquelle est vraie, et le
 * classifieur d'envoi le dit — sans qu'aucun contexte ne soit engagé.
 */
async function conflictingRun(dir: string, state: Partial<NativeRunStateDocument> = {}): Promise<Fixture> {
  const fixture = await readyRun(dir, state);
  const message = await fixture.events.append({
    round: 0,
    actor: 'human',
    type: 'human_message',
    target_expert_slot_id: 'author',
    session_id: SESSIONS.author,
    content: 'question humaine',
    timestamp: AT,
  });
  for (const content of ['première réponse', 'seconde réponse']) {
    await fixture.events.append({
      round: 0,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: 'author',
      session_id: SESSIONS.author,
      content,
      exit_code: 0,
      based_on: [message.event_id],
      timestamp: AT,
    });
  }
  return fixture;
}

test('12–14 · des faits contradictoires ferment resume, jamais pause', async () => {
  const dir = await makeTempDir('ccr-imp16-conflict-');
  try {
    const fixture = await conflictingRun(dir, { state: 'PAUSED', control: 'HUMAN' });
    assert.equal((await readModel(fixture)).recovery.send.status, 'EVIDENCE_CONFLICT');

    // 12 · resume est refusé, et nomme le domaine en cause.
    const before = await bytes(fixture);
    await assert.rejects(
      resumeNativeRun(deps(fixture.runsDir), RUN_ID),
      (error: unknown) =>
        isCcrError(error) &&
        error.code === 'RECOVERY_EVIDENCE_CONFLICT' &&
        Array.isArray(error.details['recovery_domains']) &&
        (error.details['recovery_domains'] as string[]).includes('send'),
      'resume fail-closed',
    );
    // 13 · aucun `run_resumed`, aucun octet touché.
    assert.deepEqual(await bytes(fixture), before);
    assert.equal(countOf(await journal(fixture), 'run_resumed'), 0);

    // 14 · pause reste permise : elle réduit l'autonomie, elle ne l'accorde pas.
    await forceState(fixture, { state: 'READY', control: 'AUTOMATION' });
    const paused = await pauseNativeRun(deps(fixture.runsDir), RUN_ID);
    assert.equal(paused.changed, true);
    assert.equal(paused.state.control, 'HUMAN');
  } finally {
    await removeTempDir(dir);
  }
});

test('15 · un run déjà automatisé mais contradictoire expose le conflit, il ne dit pas « déjà repris »', async () => {
  const dir = await makeTempDir('ccr-imp16-conflict-noop-');
  try {
    // READY / AUTOMATION : `resumeGuard` seul répondrait NOOP. La barrière de
    // conflit le précède délibérément.
    const fixture = await conflictingRun(dir, { state: 'READY', control: 'AUTOMATION' });
    await expectRejection(
      resumeNativeRun(deps(fixture.runsDir), RUN_ID),
      'RECOVERY_EVIDENCE_CONFLICT',
      'le conflit prime sur le NOOP',
    );
    assert.equal((await readModel(fixture)).operations.resume.noop, false);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Diagnostics non bloquants
// ==========================================================================

test('16 · une ouverture de transfert sans appel ne bloque pas resume, et survit à la reprise', async () => {
  const dir = await makeTempDir('ccr-imp16-step-orphan-');
  try {
    // Fenêtre W0a de 1G, reproduite par son propre chemin : le round est ouvert,
    // aucun appel n'a eu lieu, aucun contexte n'est engagé.
    const fixture = await readyRun(dir, { state: 'RUNNING' });
    const started = await openRound(fixture);
    await forceState(fixture, { last_event_id: started });
    assert.equal((await readModel(fixture)).recovery.step.status, 'PRE_PROVIDER_ABORTED');

    // La suspension humaine est possible…
    await pauseNativeRun(deps(fixture.runsDir), RUN_ID);
    // …et la reprise aussi : rien n'est engagé, la source reste transférable.
    const resumed = await resumeNativeRun(deps(fixture.runsDir), RUN_ID);
    assert.equal(resumed.state.state, 'READY');
    assert.equal(resumed.state.control, 'AUTOMATION');

    // Le diagnostic n'est ni purgé, ni transformé en barrière.
    const after = await readModel(fixture);
    assert.equal(after.recovery.step.status, 'PRE_PROVIDER_ABORTED');
    assert.equal(after.operations.step.allowed, true, 'le moteur reprend sur la même source');
    assert.equal(after.operations.step.source_event_id, fixture.authorResponse);
  } finally {
    await removeTempDir(dir);
  }
});

test('17 · un envoi humain orphelin ne bloque pas resume', async () => {
  const dir = await makeTempDir('ccr-imp16-send-orphan-');
  try {
    const fixture = await readyRun(dir, { state: 'PAUSED', control: 'HUMAN' });
    await fixture.events.append({
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: SESSIONS.author,
      content: 'question restée sans issue',
      timestamp: AT,
    });
    assert.equal((await readModel(fixture)).recovery.send.status, 'PRE_PROVIDER_ABORTED');

    const resumed = await resumeNativeRun(deps(fixture.runsDir), RUN_ID);
    assert.equal(resumed.state.control, 'AUTOMATION');
    const after = await readModel(fixture);
    assert.equal(after.recovery.send.status, 'PRE_PROVIDER_ABORTED', 'diagnostic conservé');
    assert.equal(after.operations.step.allowed, true, 'un orphelin d’envoi n’est pas une source');
  } finally {
    await removeTempDir(dir);
  }
});

test('18 · une ouverture de handoff sans client lancé ne bloque pas resume', async () => {
  const dir = await makeTempDir('ccr-imp16-handoff-orphan-');
  try {
    const fixture = await readyRun(dir, { state: 'PAUSED', control: 'HUMAN' });
    await fixture.events.append({
      round: 0,
      actor: 'human',
      type: 'human_handoff_started',
      target_expert_slot_id: 'challenger',
      session_id: SESSIONS.challenger,
      details: { state: 'PAUSED', control: 'HUMAN' },
      timestamp: AT,
    });
    assert.equal((await readModel(fixture)).recovery.handoff.status, 'PRE_INTERACTIVE_ABORTED');

    const resumed = await resumeNativeRun(deps(fixture.runsDir), RUN_ID);
    assert.equal(resumed.state.control, 'AUTOMATION');
    const after = await readModel(fixture);
    assert.equal(after.recovery.handoff.status, 'PRE_INTERACTIVE_ABORTED', 'diagnostic conservé');
    // Une ouverture abandonnée ne périme aucune position : seuls
    // `human_handoff_finished` et l'acquittement sont des barrières.
    assert.equal(after.operations.step.allowed, true);
    assert.equal(after.operations.step.source_status, 'READY');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. `RESOLUTION_NEEDS_COMMIT` — les deux variantes ne se ressemblent pas
// ==========================================================================

test('19–21 · une clôture avant appel déjà durable est supersédée par un resume explicite', async () => {
  const dir = await makeTempDir('ccr-imp16-resolution-abort-');
  try {
    const fixture = await readyRun(dir, { state: 'PAUSED', control: 'HUMAN' });
    const started = await openRound(fixture);
    const marker = await fixture.events.append({
      round: 1,
      actor: 'system',
      type: 'transfer_aborted_before_provider',
      source_slot_id: 'author',
      target_slot_id: 'challenger',
      source_event_id: fixture.authorResponse,
      reason: 'PRE_PROVIDER_ABORTED',
      based_on: [started],
      timestamp: AT,
    });
    // Marqueur durable, commit d'état perdu : `last_event_id` est resté en arrière.
    await forceState(fixture, { last_event_id: started });
    assert.equal((await readModel(fixture)).recovery.step.status, 'RESOLUTION_NEEDS_COMMIT');

    // 19 · le resume humain est autorisé : l'issue fournisseur était déjà close.
    const resumed = await resumeNativeRun(deps(fixture.runsDir), RUN_ID);
    assert.equal(resumed.state.state, 'READY');
    assert.equal(resumed.state.control, 'AUTOMATION');

    const after = await readModel(fixture);
    // 20 · le statut retombe à NONE — le marqueur n'est plus le dernier fait
    // non commité — sans que le marqueur ait été effacé ni dupliqué.
    assert.equal(after.recovery.step.status, 'NONE');
    const events = await journal(fixture);
    assert.equal(countOf(events, 'transfer_aborted_before_provider'), 1);
    assert.ok(events.some((event) => event.event_id === marker.event_id));

    // 21 · aucun rejeu, aucune consommation : la source reste éligible et le
    // planificateur repart exactement dessus.
    assert.equal(after.recovery.step.source_replay_status, 'ELIGIBLE');
    const persisted = await readPersistedManifest(fixture.paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    const plan = planNativeStep({
      runId: RUN_ID,
      manifest: persisted.manifest,
      state: await currentState(fixture),
      events,
    });
    assert.equal(plan.kind, 'READY');
    if (plan.kind === 'READY') assert.equal(plan.sourceEventId, fixture.authorResponse);
  } finally {
    await removeTempDir(dir);
  }
});

test('22 · un acquittement d’incertitude au contexte survivant reste bloquant', async () => {
  const dir = await makeTempDir('ccr-imp16-resolution-ack-');
  try {
    // Même statut, sémantique opposée : ici l'appel a **peut-être** eu lieu, et
    // le contexte engagé a survécu au commit perdu.
    const fixture = await readyRun(dir, { state: 'WAITING_AGENT' });
    const started = await openRound(fixture);
    const prompt = await fixture.events.append({
      round: 1,
      actor: 'system',
      type: 'prompt_sent',
      target_expert_slot_id: 'challenger',
      session_id: SESSIONS.challenger,
      content: 'enveloppe de transfert',
      based_on: [fixture.authorResponse],
      timestamp: AT,
    });
    await fixture.events.append({
      round: 1,
      actor: 'human',
      type: 'transfer_uncertainty_acknowledged',
      source_slot_id: 'author',
      target_slot_id: 'challenger',
      source_event_id: fixture.authorResponse,
      reason: 'IN_FLIGHT_UNCERTAIN',
      based_on: [started],
      timestamp: AT,
    });
    await forceState(fixture, {
      active_expert_slot: 'challenger',
      last_event_id: prompt.event_id,
      pending_operation: stepPending({ prompt_event_id: prompt.event_id, source_event_id: fixture.authorResponse }),
    });

    const view = await readModel(fixture);
    assert.equal(view.recovery.step.status, 'RESOLUTION_NEEDS_COMMIT');
    assert.equal(view.operations.resume.allowed, false);
    assert.equal(view.operations.resume.reason_code, 'RECOVERY_REQUIRED');

    const before = await bytes(fixture);
    await expectRejection(resumeNativeRun(deps(fixture.runsDir), RUN_ID), 'RECOVERY_REQUIRED', 'resume refusé');
    assert.deepEqual(await bytes(fixture), before);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// F. Frontière de génération
// ==========================================================================

test('23 · le contrôle natif refuse un run historique, et ne le convertit pas', async () => {
  const dir = await makeTempDir('ccr-imp16-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);
    const before = await readFile(paths.state, 'utf8');

    for (const call of [
      () => pauseNativeRun(deps(runsDir), RUN_ID),
      () => resumeNativeRun(deps(runsDir), RUN_ID),
    ]) {
      await expectRejection(call(), 'SCHEMA_VERSION_UNSUPPORTED', 'run historique refusé');
    }
    assert.equal(await readFile(paths.state, 'utf8'), before, 'aucune conversion, aucune écriture');
  } finally {
    await removeTempDir(dir);
  }
});

test('24 · une transition illégale reste refusée par la machine d’état', async () => {
  const dir = await makeTempDir('ccr-imp16-closed-');
  try {
    const fixture = await readyRun(dir, { state: 'CLOSED', control: 'HUMAN' });
    // `CLOSED` est terminal : ni suspension, ni reprise.
    await expectRejection(pauseNativeRun(deps(fixture.runsDir), RUN_ID), 'RUN_NOT_PAUSABLE', 'pause');
    await expectRejection(resumeNativeRun(deps(fixture.runsDir), RUN_ID), 'RUN_NOT_RESUMABLE', 'resume');
    assert.equal(countOf(await journal(fixture), 'run_paused'), 0);
  } finally {
    await removeTempDir(dir);
  }
});
