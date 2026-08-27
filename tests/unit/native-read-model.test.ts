/**
 * Slice 2D — Native Operational Read Model & Capabilities.
 *
 * La projection ne réimplémente aucune règle : elle interroge les moteurs qui
 * font autorité, et se contente d'en exposer les verdicts sous une forme
 * stable. Ce fichier éprouve exactement cela — que les codes exposés sont ceux
 * du planificateur et des gardes, et que la lecture n'écrit rien.
 *
 * Aucun fournisseur, aucun adapter, aucun processus : les runs sont
 * matérialisés par les **stores** canoniques, en reproduisant les séquences
 * réellement écrites par les moteurs :
 *
 * ```text
 * START    native-start-service.ts   prompt_sent · assistant_response · session_created
 * STEP     native-step-service.ts    round_started · prompt_sent · assistant_response
 *                                    · round_completed
 * SEND     native-send-service.ts    human_message · assistant_response
 * HANDOFF  native-handoff-service.ts human_handoff_started · human_handoff_finished
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../../src/core/run-native.ts';
import type {
  NativePendingOperation,
  NativeRunManifest,
  NativeRunStateDocument,
} from '../../src/core/run-native.ts';
import { buildNativeRunReadModel } from '../../src/services/native-read-model.ts';
import type { NativeRunReadModelV1 } from '../../src/services/native-read-model.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import type { NativeEventStore } from '../../src/store/native-event-store.ts';
import { writeNativeManifest, writeNativeState } from '../../src/store/native-store.ts';
import { materializeRun } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-001';
const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Matérialisation par les stores canoniques
// --------------------------------------------------------------------------

interface Bindings {
  readonly author: ProviderKind;
  readonly challenger: ProviderKind;
}

interface Sessions {
  readonly author?: string | null;
  readonly challenger?: string | null;
}

const DEFAULT_SESSIONS: Required<Sessions> = { author: 'codex-1', challenger: 'claude-1' };

function manifestOf(bindings: Bindings, sessions: Sessions = {}): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Contre-expertise',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: {
        provider: bindings.author,
        session_id: sessions.author === undefined ? DEFAULT_SESSIONS.author : sessions.author,
      },
      challenger: {
        provider: bindings.challenger,
        session_id:
          sessions.challenger === undefined ? DEFAULT_SESSIONS.challenger : sessions.challenger,
      },
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

interface Materialized {
  readonly runsDir: string;
  readonly paths: ReturnType<typeof runPaths>;
  readonly events: NativeEventStore;
}

async function materialize(
  dir: string,
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
): Promise<Materialized> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, state);
  return { runsDir, paths, events: await openNativeEventStore(paths, manifest) };
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

/** Ouverture START restée sans réponse : le slot manque réellement. */
async function startSlotFailed(events: NativeEventStore, slot: ExpertSlotId): Promise<void> {
  const prompt = await events.append({
    round: 0,
    actor: 'human',
    type: 'prompt_sent',
    target_expert_slot_id: slot,
    content: MISSION,
    timestamp: AT,
  });
  await events.append({
    round: 0,
    actor: 'system',
    type: 'process_failed',
    target_expert_slot_id: slot,
    content: 'le fournisseur a échoué',
    details: { code: 'AGENT_TIMEOUT' },
    based_on: [prompt.event_id],
    timestamp: AT,
  });
}

/** SEND vers un slot, tel que `sendNativeMessage` l'écrit. */
async function send(
  events: NativeEventStore,
  slot: ExpertSlotId,
  session: string,
  options: { readonly withResponse?: boolean } = {},
): Promise<{ prompt: string; response: string | null }> {
  const message = await events.append({
    round: 0,
    actor: 'human',
    type: 'human_message',
    target_expert_slot_id: slot,
    session_id: session,
    content: 'question humaine',
    timestamp: AT,
  });
  if (options.withResponse === false) return { prompt: message.event_id, response: null };
  const response = await events.append({
    round: 0,
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: slot,
    session_id: session,
    content: 'réponse à la question humaine',
    exit_code: 0,
    based_on: [message.event_id],
    timestamp: AT,
  });
  return { prompt: message.event_id, response: response.event_id };
}

/** Handoff vers un slot, tel que `handoffNativeExpert` l'écrit. */
async function handoff(
  events: NativeEventStore,
  slot: ExpertSlotId,
  session: string,
  options: { readonly finished?: boolean } = {},
): Promise<string> {
  const started = await events.append({
    round: 0,
    actor: 'human',
    type: 'human_handoff_started',
    target_expert_slot_id: slot,
    session_id: session,
    details: { state: 'PAUSED', control: 'HUMAN' },
    timestamp: AT,
  });
  if (options.finished === false) return started.event_id;
  await events.append({
    round: 0,
    actor: 'human',
    type: 'human_handoff_finished',
    target_expert_slot_id: slot,
    session_id: session,
    exit_code: 0,
    based_on: [started.event_id],
    details: { cost: 'NOT CONTROLLED / NOT MEASURED' },
    timestamp: AT,
  });
  return started.event_id;
}

function pendingOf(over: Partial<NativePendingOperation> = {}): NativePendingOperation {
  return {
    kind: 'send',
    expert_slot: 'author',
    round: 0,
    prompt_event_id: 'evt_000001',
    session_id: 'codex-1',
    return_state: 'READY',
    return_control: 'AUTOMATION',
    started_at: AT,
    ...over,
  } as NativePendingOperation;
}

/** Run complètement initialisé, prêt à transférer. */
async function readyRun(dir: string, bindings: Bindings = { author: 'codex', challenger: 'claude' }): Promise<{
  m: Materialized;
  authorResponse: string;
  challengerResponse: string;
  sessions: { author: string; challenger: string };
}> {
  const same = bindings.author === bindings.challenger;
  const sessions = same
    ? { author: 'S1', challenger: 'S2' }
    : { author: `${bindings.author}-1`, challenger: `${bindings.challenger}-1` };
  const m = await materialize(dir, manifestOf(bindings, sessions), stateOf());
  const authorResponse = await startSlot(m.events, 'author', sessions.author);
  const challengerResponse = await startSlot(m.events, 'challenger', sessions.challenger);
  return { m, authorResponse, challengerResponse, sessions };
}

interface CanonicalBytes {
  readonly manifest: string;
  readonly state: string;
  readonly events: string;
  readonly rounds: string;
}

async function canonicalBytes(paths: ReturnType<typeof runPaths>): Promise<CanonicalBytes> {
  const read = async (file: string): Promise<string> => {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return '<absent>';
    }
  };
  const rounds = await readdir(paths.roundsDir).catch(() => ['<absent>']);
  return {
    manifest: await read(paths.manifest),
    state: await read(paths.state),
    events: await read(paths.events),
    rounds: rounds.join(','),
  };
}

// ==========================================================================
// A. Structure
// ==========================================================================

test('1–3 · les deux experts sont projetés par slot, jamais par moteur', async () => {
  for (const bindings of [
    { author: 'codex', challenger: 'claude' },
    { author: 'claude', challenger: 'codex' },
    { author: 'claude', challenger: 'claude' },
  ] as readonly Bindings[]) {
    const dir = await makeTempDir('ccr-2d-structure-');
    try {
      const { m, sessions } = await readyRun(dir, bindings);
      const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);

      assert.equal(view.read_model_version, 1);
      assert.equal(view.identity.run_id, RUN_ID);
      assert.equal(view.identity.execution_mode, 'NATIVE_V21_EXECUTION');
      assert.equal(view.identity.manifest_schema_version, 2);
      assert.equal(view.identity.state_schema_version, 3);
      assert.equal(view.identity.runtime_schema_version, 2);

      assert.equal(view.experts.author.provider, bindings.author);
      assert.equal(view.experts.challenger.provider, bindings.challenger);
      assert.equal(view.experts.author.session_id, sessions.author);
      assert.equal(view.experts.challenger.session_id, sessions.challenger);
      assert.equal(view.experts.author.session_status, 'BOUND');
      assert.equal(view.experts.challenger.session_status, 'BOUND');
      // 3 · same-provider : deux sessions distinctes, jamais fusionnées.
      assert.notEqual(view.experts.author.session_id, view.experts.challenger.session_id);

      // Le snapshot runtime persisté est exposé tel quel, sans sonde.
      assert.equal(view.providers?.schema_version, 2);
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('4 · les alias fournisseur sont secondaires, et suivent la règle 0/1/2', async () => {
  const dir = await makeTempDir('ccr-2d-alias-');
  try {
    const mixed = await readyRun(dir, { author: 'codex', challenger: 'claude' });
    const mixedView = await buildNativeRunReadModel({ runsDir: mixed.m.runsDir }, RUN_ID);
    assert.deepEqual(mixedView.compatibility.provider_aliases['claude'], {
      resolution: 'UNIQUE',
      expert_slot: 'challenger',
    });
    assert.deepEqual(mixedView.compatibility.provider_aliases['codex'], {
      resolution: 'UNIQUE',
      expert_slot: 'author',
    });
  } finally {
    await removeTempDir(dir);
  }

  const dir2 = await makeTempDir('ccr-2d-alias-same-');
  try {
    const same = await readyRun(dir2, { author: 'claude', challenger: 'claude' });
    const view = await buildNativeRunReadModel({ runsDir: same.m.runsDir }, RUN_ID);
    assert.deepEqual(view.compatibility.provider_aliases['claude'], { resolution: 'AMBIGUOUS' });
    assert.deepEqual(view.compatibility.provider_aliases['codex'], { resolution: 'NOT_BOUND' });
    // 20 · l'ambiguïté d'alias ne désactive jamais les cibles canoniques.
    assert.equal(view.operations.experts.author.send.allowed, true);
    assert.equal(view.operations.experts.challenger.send.allowed, true);
  } finally {
    await removeTempDir(dir2);
  }
});

// ==========================================================================
// B. État opérationnel
// ==========================================================================

test('5–6 · état, contrôle, curseur et opération engagée sont projetés fidèlement', async () => {
  const dir = await makeTempDir('ccr-2d-state-');
  try {
    const { m, authorResponse } = await readyRun(dir);
    const pending = pendingOf({
      kind: 'step',
      source_slot: 'author',
      target_slot: 'challenger',
      source_event_id: authorResponse,
      round: 1,
      prompt_event_id: 'evt_000007',
      session_id: 'claude-1',
      return_state: 'READY',
    } as Partial<NativePendingOperation>);
    await writeNativeState(
      m.paths,
      stateOf({
        state: 'WAITING_AGENT',
        control: 'AUTOMATION',
        round: 0,
        next_step_source_slot: 'author',
        active_expert_slot: 'challenger',
        last_event_id: 'evt_000007',
        pending_operation: pending,
      }),
    );

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.operational_state.state, 'WAITING_AGENT');
    assert.equal(view.operational_state.control, 'AUTOMATION');
    assert.equal(view.operational_state.round, 0);
    assert.equal(view.operational_state.next_step_source_slot, 'author');
    assert.equal(view.operational_state.active_expert_slot, 'challenger');
    assert.equal(view.operational_state.last_event_id, 'evt_000007');
    // Le pending est projeté tel qu'il est persisté, jamais reformulé : la
    // comparaison porte sur le document relu, et non sur un littéral de test.
    const persistedPending = (
      JSON.parse(await readFile(m.paths.state, 'utf8')) as { pending_operation: unknown }
    ).pending_operation;
    assert.deepEqual(view.operational_state.pending_operation, persistedPending);
    assert.equal(view.operational_state.pending_operation?.kind, 'step');

    // 29 · les gardes réelles refusent : opération engagée.
    assert.equal(view.operations.step.allowed, false);
    assert.equal(view.operations.step.reason_code, 'RECOVERY_REQUIRED');
    assert.equal(view.operations.experts.author.send.allowed, false);
    assert.equal(view.operations.experts.author.send.reason_code, 'RECOVERY_REQUIRED');
    assert.equal(view.operations.experts.challenger.handoff.allowed, false);
    assert.equal(view.operations.experts.challenger.handoff.reason_code, 'RECOVERY_REQUIRED');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Les quatre reprises
// ==========================================================================

test('7 · initialisation partielle : CLEAN_MISSING, et le slot manquant reste manquant', async () => {
  const dir = await makeTempDir('ccr-2d-init-');
  try {
    const m = await materialize(
      dir,
      manifestOf({ author: 'codex', challenger: 'claude' }, { challenger: null }),
      stateOf({ state: 'FAILED_INITIALIZATION', control: 'HUMAN', next_step_source_slot: null }),
    );
    await startSlot(m.events, 'author', 'codex-1');
    await startSlotFailed(m.events, 'challenger');

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);

    // 25 · les deux slots sont représentés tels qu'ils sont.
    assert.equal(view.experts.author.session_status, 'BOUND');
    assert.equal(view.experts.challenger.session_status, 'MISSING');
    assert.equal(view.experts.challenger.session_id, null);

    assert.equal(view.recovery.initialization.status, 'CLEAN_MISSING');
    assert.deepEqual([...view.recovery.initialization.missing_slots], ['challenger']);
    assert.deepEqual(view.recovery.initialization.available_actions, [
      { action: 'CONTINUE', may_call_provider: true, requires_note: false, resulting_control: 'HUMAN' },
    ]);

    // 26–27 · les gardes réelles décident, par slot : aucun rebind silencieux.
    assert.equal(view.operations.experts.author.send.allowed, true, 'le slot lié reste joignable');
    assert.equal(view.operations.experts.challenger.send.allowed, false);
    assert.equal(view.operations.experts.challenger.send.reason_code, 'SESSION_MISSING');
    // `FAILED_INITIALIZATION` n'est pas suspendu : le handoff reste refusé pour
    // sa vraie raison, et non parce que le run serait « cassé ».
    assert.equal(view.operations.experts.author.handoff.allowed, false);
    assert.equal(view.operations.experts.author.handoff.reason_code, 'HANDOFF_NOT_ALLOWED');
    assert.equal(view.operations.step.allowed, false);
    assert.equal(view.operations.step.reason_code, 'SESSION_MISSING');
  } finally {
    await removeTempDir(dir);
  }
});

test('8–10 · les fenêtres de transfert, d’envoi et de handoff sont exposées séparément', async () => {
  // 8 · STEP engagé, sans réponse.
  const stepDir = await makeTempDir('ccr-2d-step-rec-');
  try {
    const { m, authorResponse } = await readyRun(stepDir);
    await m.events.append({
      round: 1,
      actor: 'system',
      type: 'round_started',
      target_expert_slot_id: 'challenger',
      based_on: [authorResponse],
      details: { round: 1, source_slot: 'author', target_slot: 'challenger', source_event_id: authorResponse },
      timestamp: AT,
    });
    const prompt = await m.events.append({
      round: 1,
      actor: 'system',
      type: 'prompt_sent',
      target_expert_slot_id: 'challenger',
      session_id: 'claude-1',
      content: 'SOURCE_EXPERT: AUTHOR',
      based_on: [authorResponse],
      timestamp: AT,
    });
    await writeNativeState(
      m.paths,
      stateOf({
        state: 'WAITING_AGENT',
        active_expert_slot: 'challenger',
        pending_operation: pendingOf({
          kind: 'step',
          source_slot: 'author',
          target_slot: 'challenger',
          source_event_id: authorResponse,
          round: 1,
          prompt_event_id: prompt.event_id,
          session_id: 'claude-1',
        } as Partial<NativePendingOperation>),
      }),
    );

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.recovery.step.status, 'IN_FLIGHT_UNCERTAIN');
    assert.equal(view.recovery.step.source_event_id, authorResponse);
    assert.equal(view.recovery.step.target_slot, 'challenger');
    assert.deepEqual(view.recovery.step.available_actions.map((a) => a.action), [
      'ACKNOWLEDGE_UNCERTAINTY',
    ]);
    assert.equal(view.recovery.step.available_actions[0]?.requires_note, true);
    // Les trois autres domaines restent silencieux : rien n'est aplati.
    assert.equal(view.recovery.send.status, 'NONE');
    assert.equal(view.recovery.handoff.status, 'NONE');
    assert.equal(view.recovery.initialization.status, 'NONE');
  } finally {
    await removeTempDir(stepDir);
  }

  // 9 · SEND dont la réponse est durable, mais non commitée.
  const sendDir = await makeTempDir('ccr-2d-send-rec-');
  try {
    const { m } = await readyRun(sendDir);
    const sent = await send(m.events, 'author', 'codex-1');
    await writeNativeState(
      m.paths,
      stateOf({
        state: 'WAITING_AGENT',
        active_expert_slot: 'author',
        pending_operation: pendingOf({ prompt_event_id: sent.prompt }),
      }),
    );

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.recovery.send.status, 'RESPONSE_NEEDS_FINALIZATION');
    assert.equal(view.recovery.send.prompt_event_id, sent.prompt);
    assert.equal(view.recovery.send.response_event_id, sent.response);
    assert.deepEqual(view.recovery.send.available_actions.map((a) => a.action), ['FINALIZE']);
    assert.equal(view.recovery.send.available_actions[0]?.resulting_control, 'HUMAN');
  } finally {
    await removeTempDir(sendDir);
  }

  // 10 · HANDOFF engagé, d'étendue inconnue.
  const handoffDir = await makeTempDir('ccr-2d-handoff-rec-');
  try {
    const { m } = await readyRun(handoffDir);
    const started = await handoff(m.events, 'challenger', 'claude-1', { finished: false });
    await writeNativeState(
      m.paths,
      stateOf({
        state: 'PAUSED',
        control: 'HUMAN',
        active_expert_slot: 'challenger',
        pending_operation: pendingOf({
          kind: 'handoff',
          expert_slot: 'challenger',
          prompt_event_id: started,
          session_id: 'claude-1',
          return_state: 'PAUSED',
          return_control: 'HUMAN',
        }),
      }),
    );

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.recovery.handoff.status, 'IN_FLIGHT_UNCERTAIN');
    assert.equal(view.recovery.handoff.started_event_id, started);
    assert.equal(view.recovery.handoff.target_slot, 'challenger');
    assert.deepEqual(view.recovery.handoff.available_actions.map((a) => a.action), [
      'ACKNOWLEDGE_UNCERTAINTY',
    ]);
  } finally {
    await removeTempDir(handoffDir);
  }
});

test('11 · une contradiction reste visible, et n’est jamais réduite à un refus', async () => {
  const dir = await makeTempDir('ccr-2d-conflict-');
  try {
    const { m } = await readyRun(dir);
    const sent = await send(m.events, 'author', 'codex-1');
    // Deux réponses pour un seul envoi : contradiction que l'ordre d'écriture
    // rend impossible.
    await m.events.append({
      round: 0,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: 'author',
      session_id: 'codex-1',
      content: 'seconde réponse',
      exit_code: 0,
      based_on: [sent.prompt],
      timestamp: AT,
    });

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.recovery.send.status, 'EVIDENCE_CONFLICT');
    assert.ok(view.recovery.send.conflicts.length > 0, 'la contradiction est nommée');
    assert.equal(view.recovery.send.available_actions.length, 0, 'aucune réparation proposée');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Capacité de transfert
// ==========================================================================

test('12 · un run prêt expose le transfert que le planificateur produirait', async () => {
  const dir = await makeTempDir('ccr-2d-step-ready-');
  try {
    const { m, authorResponse } = await readyRun(dir);
    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);

    assert.equal(view.operations.step.allowed, true);
    assert.equal(view.operations.step.source_status, 'READY');
    assert.equal(view.operations.step.source_slot, 'author');
    assert.equal(view.operations.step.target_slot, 'challenger');
    assert.equal(view.operations.step.source_event_id, authorResponse);
    assert.equal(view.operations.step.next_round, 1);
    assert.ok((view.operations.step.payload_bytes ?? 0) > 0);
    assert.ok((view.operations.step.payload_limit_bytes ?? 0) > 0);
    assert.equal(view.operations.step.reason_code, undefined);
  } finally {
    await removeTempDir(dir);
  }
});

test('13–14 · source consommée et source quarantainée gardent leurs codes distincts', async () => {
  // 13 · déjà transférée. Journal construit à la main : le curseur avance
  // normalement au commit, si bien que cette combinaison ne s'obtient pas par
  // une exécution nominale. C'est le **code du planificateur** qui est projeté.
  const consumedDir = await makeTempDir('ccr-2d-consumed-');
  try {
    const { m, authorResponse, challengerResponse } = await readyRun(consumedDir);
    await m.events.append({
      round: 1,
      actor: 'system',
      type: 'round_completed',
      source_slot_id: 'author',
      target_slot_id: 'challenger',
      source_event_id: authorResponse,
      response_event_id: challengerResponse,
      based_on: [authorResponse, challengerResponse],
      timestamp: AT,
    });

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.operations.step.allowed, false);
    assert.equal(view.operations.step.reason_code, 'SOURCE_ALREADY_TRANSFERRED');
    assert.equal(view.operations.step.source_status, 'ALREADY_TRANSFERRED');
  } finally {
    await removeTempDir(consumedDir);
  }

  // 14 · quarantainée après une incertitude acquittée.
  const quarantineDir = await makeTempDir('ccr-2d-quarantine-');
  try {
    const { m, authorResponse } = await readyRun(quarantineDir);
    await m.events.append({
      round: 1,
      actor: 'human',
      type: 'transfer_uncertainty_acknowledged',
      source_slot_id: 'author',
      target_slot_id: 'challenger',
      source_event_id: authorResponse,
      reason: 'IN_FLIGHT_UNCERTAIN',
      content: 'issue inconnue',
      timestamp: AT,
    });

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.operations.step.allowed, false);
    assert.equal(view.operations.step.reason_code, 'SOURCE_NOT_REPLAYABLE');
    assert.equal(view.operations.step.source_status, 'NON_REPLAYABLE');
  } finally {
    await removeTempDir(quarantineDir);
  }
});

test('15–17 · la barrière de fraîcheur post-handoff est visible sans aucune reprise', async () => {
  const dir = await makeTempDir('ccr-2d-barrier-');
  try {
    const { m } = await readyRun(dir);
    await handoff(m.events, 'author', 'codex-1');

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    // 15 · aucune reprise n'est nécessaire, et pourtant le transfert est refusé.
    assert.equal(view.recovery.handoff.status, 'NONE');
    assert.equal(view.recovery.handoff.available_actions.length, 0);
    assert.equal(view.experts.author.session_status, 'BOUND', 'la session reste liée');
    assert.equal(view.operations.step.allowed, false);
    assert.equal(view.operations.step.reason_code, 'SOURCE_STALE_AFTER_HANDOFF');
    assert.equal(view.operations.step.source_status, 'STALE_AFTER_HANDOFF');

    // 16 · une réponse fraîche, postérieure à la barrière, rétablit l'ancrage.
    const sent = await send(m.events, 'author', 'codex-1');
    const restored = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(restored.operations.step.allowed, true);
    assert.equal(restored.operations.step.source_event_id, sent.response);
    assert.equal(restored.operations.step.source_status, 'READY');
  } finally {
    await removeTempDir(dir);
  }

  // 17 · un handoff sur l'autre slot ne périme pas le slot du curseur.
  const otherDir = await makeTempDir('ccr-2d-barrier-other-');
  try {
    const { m, authorResponse } = await readyRun(otherDir);
    await handoff(m.events, 'challenger', 'claude-1');
    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.operations.step.allowed, true);
    assert.equal(view.operations.step.source_event_id, authorResponse);
  } finally {
    await removeTempDir(otherDir);
  }
});

test('18 · un transfert trop volumineux est refusé sans recopier le moindre contenu', async () => {
  const dir = await makeTempDir('ccr-2d-payload-');
  try {
    const { m, authorResponse } = await readyRun(dir);
    const view = await buildNativeRunReadModel({ runsDir: m.runsDir, maxTransferBytes: 32 }, RUN_ID);

    assert.equal(view.operations.step.allowed, false);
    assert.equal(view.operations.step.reason_code, 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
    assert.equal(view.operations.step.source_status, 'PAYLOAD_TOO_LARGE');
    assert.equal(view.operations.step.source_event_id, authorResponse);
    assert.equal(view.operations.step.payload_limit_bytes, 32);
    assert.ok((view.operations.step.payload_bytes ?? 0) > 32);

    // Aucun contenu source, aucune enveloppe, nulle part dans la projection.
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes('position initiale de author'), false);
    assert.equal(serialized.includes('SOURCE_EXPERT'), false);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Envoi et handoff par slot
// ==========================================================================

test('19–24 · envoi et handoff sont évalués par slot, avec les gardes réelles', async () => {
  // 19 · sous automatisation, l'envoi reste permis — la règle n'est pas
  // simplifiée en « HUMAN seulement ».
  const readyDir = await makeTempDir('ccr-2d-caps-ready-');
  try {
    const { m } = await readyRun(readyDir);
    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.operational_state.control, 'AUTOMATION');
    assert.equal(view.operations.experts.author.send.allowed, true);
    assert.equal(view.operations.experts.challenger.send.allowed, true);
    // 22 · READY n'est pas un état suspendu.
    assert.equal(view.operations.experts.author.handoff.allowed, false);
    assert.equal(view.operations.experts.author.handoff.reason_code, 'HANDOFF_NOT_ALLOWED');
  } finally {
    await removeTempDir(readyDir);
  }

  // 21 · suspendu sous contrôle humain : le handoff devient possible.
  const pausedDir = await makeTempDir('ccr-2d-caps-paused-');
  try {
    const { m } = await readyRun(pausedDir);
    await writeNativeState(m.paths, stateOf({ state: 'PAUSED', control: 'HUMAN' }));
    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.operations.experts.author.handoff.allowed, true);
    assert.equal(view.operations.experts.challenger.handoff.allowed, true);
    assert.equal(view.operations.experts.author.send.allowed, true);
    // Le transfert, lui, exige l'automatisation.
    assert.equal(view.operations.step.allowed, false);
    assert.equal(view.operations.step.reason_code, 'AUTOMATION_NOT_IN_CONTROL');
  } finally {
    await removeTempDir(pausedDir);
  }

  // 23 · une session absente est un refus nommé, jamais un rebind.
  const missingDir = await makeTempDir('ccr-2d-caps-missing-');
  try {
    const m = await materialize(
      missingDir,
      manifestOf({ author: 'codex', challenger: 'claude' }, { challenger: null }),
      stateOf({ state: 'PAUSED', control: 'HUMAN', next_step_source_slot: null }),
    );
    await startSlot(m.events, 'author', 'codex-1');
    await startSlotFailed(m.events, 'challenger');
    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.operations.experts.challenger.handoff.allowed, false);
    assert.equal(view.operations.experts.challenger.handoff.reason_code, 'SESSION_MISSING');
    assert.equal(view.operations.experts.author.handoff.allowed, true, 'le slot lié reste joignable');
  } finally {
    await removeTempDir(missingDir);
  }
});

// ==========================================================================
// F. Pureté, statique, legacy
// ==========================================================================

test('28 · une lecture ne touche aucun fichier canonique', async () => {
  const dir = await makeTempDir('ccr-2d-purity-');
  try {
    const { m } = await readyRun(dir);
    await handoff(m.events, 'author', 'codex-1');
    await writeNativeState(m.paths, stateOf({ state: 'PAUSED', control: 'HUMAN' }));

    const before = await canonicalBytes(m.paths);
    const first = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    const second = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    const after = await canonicalBytes(m.paths);

    assert.deepEqual(after, before, 'manifest, état, journal et rounds identiques');
    assert.deepEqual(second, first, 'deux lectures du même instant sont identiques');
    // Aucun marqueur de reprise n'est écrit, et rien n'est « nettoyé ».
    assert.equal(before.events.includes('handoff_aborted_before_interactive'), false);
    assert.equal(before.events.includes('send_aborted_before_provider'), false);
  } finally {
    await removeTempDir(dir);
  }
});

test('29 · la projection ne connaît aucun adapter, ni aucune fabrique', async () => {
  const raw = await readFile(
    fileURLToPath(new URL('../../src/services/native-read-model.ts', import.meta.url)),
    'utf8',
  );
  // Les commentaires **parlent** de ce qui est interdit ; c'est le code qui
  // doit en être exempt.
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  for (const forbidden of [
    'createAdapters',
    'AgentAdapters',
    'agent-adapter',
    'claude-adapter',
    'codex-adapter',
    'process-runner',
    'openInteractive',
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} absent de la projection`);
  }
  // Elle n'écrit pas davantage : aucune primitive de mutation n'y figure.
  for (const forbidden of ['persistNativeStateUpdate', 'writeNativeManifest', 'writeNativeState', '.append(']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} absent de la projection`);
  }
});

test('30 · un run historique est refusé, sans écriture', async () => {
  const dir = await makeTempDir('ccr-2d-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);
    const before = await canonicalBytes(paths);

    await expectRejection(
      buildNativeRunReadModel({ runsDir }, RUN_ID),
      'SCHEMA_VERSION_UNSUPPORTED',
      'génération historique',
    );
    assert.deepEqual(await canonicalBytes(paths), before, 'le run historique est intact');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// G. Contrat de la projection
// ==========================================================================

test('une capacité est un instantané consultatif, jamais une autorisation', async () => {
  const dir = await makeTempDir('ccr-2d-advisory-');
  try {
    const { m } = await readyRun(dir);
    const permissive = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(permissive.operations.step.allowed, true);

    // L'état change sous la projection : elle ne réserve rien, ne verrouille
    // rien, et n'émet aucun jeton. La lecture suivante dit simplement autre
    // chose — c'est l'opération mutante qui tranchera, sous verrou.
    await writeNativeState(m.paths, stateOf({ state: 'PAUSED', control: 'HUMAN' }));
    const later = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(later.operations.step.allowed, false);
    assert.equal(later.operations.step.reason_code, 'AUTOMATION_NOT_IN_CONTROL');

    const serialized = JSON.stringify(permissive);
    for (const forbidden of ['token', 'nonce', 'reservation', 'expires']) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} absent de la projection`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

/** Aucun texte d'interface : rien que des codes stables. */
test('la projection ne contient aucun texte destiné à un humain', async () => {
  const dir = await makeTempDir('ccr-2d-codes-');
  try {
    const m = await materialize(
      dir,
      manifestOf({ author: 'codex', challenger: 'claude' }, { challenger: null }),
      stateOf({ state: 'FAILED_INITIALIZATION', control: 'HUMAN', next_step_source_slot: null }),
    );
    await startSlot(m.events, 'author', 'codex-1');
    await startSlotFailed(m.events, 'challenger');

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    const capabilities = JSON.stringify(view.operations);
    // Les refus sont des codes, pas des phrases.
    assert.equal(capabilities.includes(' '), false, 'aucun espace : aucun texte dans les capacités');
    assert.equal(view.operations.experts.challenger.send.reason_code, 'SESSION_MISSING');
  } finally {
    await removeTempDir(dir);
  }
});

test('29 · le nouveau statut de reprise de transfert est projeté avec son geste', async () => {
  const dir = await makeTempDir('ccr-2d-step-resolution-');
  try {
    const { m, authorResponse } = await readyRun(dir);
    const started = await m.events.append({
      round: 1,
      actor: 'system',
      type: 'round_started',
      target_expert_slot_id: 'challenger',
      based_on: [authorResponse],
      details: { round: 1, source_slot: 'author', target_slot: 'challenger', source_event_id: authorResponse },
      timestamp: AT,
    });
    // Marqueur de clôture durable, commit d'état perdu : c'est la fenêtre que
    // 1G.2 rend finalisable localement.
    await m.events.append({
      round: 1,
      actor: 'system',
      type: 'transfer_aborted_before_provider',
      source_slot_id: 'author',
      target_slot_id: 'challenger',
      source_event_id: authorResponse,
      reason: 'PRE_PROVIDER_ABORTED',
      based_on: [started.event_id],
      timestamp: AT,
    });
    await writeNativeState(m.paths, stateOf({ state: 'RUNNING', last_event_id: started.event_id }));

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.recovery.step.status, 'RESOLUTION_NEEDS_COMMIT');
    assert.deepEqual(
      view.recovery.step.available_actions.map((action) => action.action),
      ['FINALIZE'],
    );
    assert.equal(view.recovery.step.available_actions[0]?.may_call_provider, false);
    assert.equal(view.recovery.step.available_actions[0]?.resulting_control, 'HUMAN');
    // Une clôture avant appel ne périme pas la source.
    assert.equal(view.recovery.step.source_replay_status, 'ELIGIBLE');
  } finally {
    await removeTempDir(dir);
  }
});


// ==========================================================================
// V2.1-IMP-16 — capacités de contrôle humain
// ==========================================================================

test('31 · pause et resume sont projetés depuis leurs primitives, NOOP compris', async () => {
  const dir = await makeTempDir('ccr-imp16-2d-control-');
  try {
    const { m } = await readyRun(dir);

    // READY / AUTOMATION : suspendre a un effet, reprendre n'en a pas.
    const automated = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.deepEqual(automated.operations.pause, { allowed: true, noop: false });
    assert.deepEqual(automated.operations.resume, { allowed: true, noop: true });

    // PAUSED / HUMAN : exactement l'inverse. Un NOOP reste un succès — jamais
    // un refus déguisé.
    await writeNativeState(m.paths, stateOf({ state: 'PAUSED', control: 'HUMAN' }));
    const suspended = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.deepEqual(suspended.operations.pause, { allowed: true, noop: true });
    assert.deepEqual(suspended.operations.resume, { allowed: true, noop: false });

    // Un contexte engagé ferme les deux, avec le code de la garde partagée.
    await writeNativeState(
      m.paths,
      stateOf({ state: 'WAITING_AGENT', active_expert_slot: 'author', pending_operation: pendingOf() }),
    );
    const engaged = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(engaged.operations.pause.reason_code, 'RECOVERY_REQUIRED');
    assert.equal(engaged.operations.resume.reason_code, 'RECOVERY_REQUIRED');
    assert.equal(engaged.operations.pause.noop, false);
  } finally {
    await removeTempDir(dir);
  }
});

test('32 · un conflit de faits est visible dans la reprise ET dans la capacité de reprise', async () => {
  const dir = await makeTempDir('ccr-imp16-2d-conflict-');
  try {
    const { m } = await readyRun(dir);
    // Deux réponses pour un même envoi : une tentative n'en a qu'une.
    const message = await send(m.events, 'author', 'codex-1');
    await m.events.append({
      round: 0,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: 'author',
      session_id: 'codex-1',
      content: 'seconde réponse',
      exit_code: 0,
      based_on: [message.prompt],
      timestamp: AT,
    });

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.recovery.send.status, 'EVIDENCE_CONFLICT');
    assert.ok(view.recovery.send.conflicts.length > 0);
    assert.equal(view.operations.resume.allowed, false);
    assert.equal(view.operations.resume.reason_code, 'RECOVERY_EVIDENCE_CONFLICT');
    assert.deepEqual(view.operations.resume.conflicting_recovery_domains, ['send']);
    // L'asymétrie : perdre en autonomie reste permis.
    assert.equal(view.operations.pause.allowed, true);
    assert.equal(view.operations.pause.noop, false);
  } finally {
    await removeTempDir(dir);
  }
});

test('33 · une ouverture de handoff abandonnée est visible sans fermer la reprise', async () => {
  const dir = await makeTempDir('ccr-imp16-2d-orphan-');
  try {
    const { m } = await readyRun(dir);
    await handoff(m.events, 'challenger', 'claude-1', { finished: false });
    await writeNativeState(m.paths, stateOf({ state: 'PAUSED', control: 'HUMAN' }));

    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.equal(view.recovery.handoff.status, 'PRE_INTERACTIVE_ABORTED');
    assert.equal(view.recovery.handoff.available_actions.length, 1);
    // Un diagnostic visible n'est pas une barrière.
    assert.deepEqual(view.operations.resume, { allowed: true, noop: false });
  } finally {
    await removeTempDir(dir);
  }
});

test('34 · la projection n’expose aucune capacité `decide` ni `stop`', async () => {
  const dir = await makeTempDir('ccr-imp16-2d-absent-');
  try {
    const { m } = await readyRun(dir);
    const view = await buildNativeRunReadModel({ runsDir: m.runsDir }, RUN_ID);
    assert.deepEqual(Object.keys(view.operations).sort(), ['experts', 'pause', 'resume', 'step']);
    // Elles n'ont aucun service natif en V2.1 : les annoncer serait promettre
    // un bouton qu'aucun code ne sait exécuter.
    const serialized = JSON.stringify(view.operations);
    assert.equal(serialized.toLowerCase().includes('decide'), false);
    assert.equal(serialized.toLowerCase().includes('stop'), false);
  } finally {
    await removeTempDir(dir);
  }
});
