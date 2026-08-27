/**
 * Repair IMP-15.1 — fidélité de la note humaine d'acquittement.
 *
 * Un acquittement d'incertitude est un **fait de provenance** : c'est le seul
 * endroit où CCR enregistre ce qu'un humain a constaté d'une situation que la
 * machine ne peut pas trancher. En rogner les bordures était une habitude
 * héritée de V1, jamais une exigence — et `V2.1-IMP-15` promettait l'inverse.
 *
 * ```text
 * note.trim()   VALIDE      « y a-t-il quelque chose ? »
 * note          PERSISTE    ce que l'humain a écrit, tel qu'il l'a écrit
 * ```
 *
 * Le témoin porte des espaces de bordure **et** de l'Unicode : sans les
 * premiers, la propriété serait indistinguable de l'ancienne — c'est
 * exactement pourquoi les témoins antérieurs la déclaraient tenue alors qu'elle
 * ne l'était pas.
 *
 * Aucun fournisseur, aucun processus, aucun socket.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { ExpertSlotId } from '../../src/core/expert.ts';
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
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import type { NativeEventStore } from '../../src/store/native-event-store.ts';
import { writeNativeManifest, writeNativeState } from '../../src/store/native-store.ts';
import { computeFingerprint, digestOfContent } from '../../src/cockpit/operations-store.ts';
import { acknowledgeNativeUncertainty } from '../../src/services/native-recovery-service.ts';
import { acknowledgeNativeStepUncertainty } from '../../src/services/native-step-recovery-service.ts';
import { acknowledgeNativeSendUncertainty } from '../../src/services/native-send-recovery-service.ts';
import { acknowledgeNativeHandoffUncertainty } from '../../src/services/native-handoff-recovery-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-001';
const AT = '2026-08-11T00:00:00.000Z';
const SESSIONS = { author: 'codex-1', challenger: 'claude-1' } as const;

/**
 * Témoin canonique.
 *
 * Deux espaces en tête, deux en queue, guillemets français, tiret cadratin,
 * lettre accentuée et une lettre grecque. Chaque caractère est là pour une
 * raison : les bordures distinguent la propriété corrigée de l'ancienne,
 * l'Unicode prouve qu'aucune normalisation ne s'est glissée.
 */
const NOTE = '  « décision humaine — élève / β »  ';

function manifestOf(): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Contre-expertise',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: 'codex', session_id: SESSIONS.author },
      challenger: { provider: 'claude', session_id: SESSIONS.challenger },
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
  readonly deps: RunServiceDeps;
  readonly recovery: { runsDir: string; now: () => Date };
  readonly authorResponse: string;
  calls(): number;
}

async function startSlot(events: NativeEventStore, slot: ExpertSlotId, session: string): Promise<string> {
  const prompt = await events.append({
    round: 0,
    actor: 'human',
    type: 'prompt_sent',
    target_expert_slot_id: slot,
    content: 'mission',
    timestamp: AT,
  });
  const response = await events.append({
    round: 0,
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: slot,
    session_id: session,
    content: `position de ${slot}`,
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

async function fixture(dir: string, state: Partial<NativeRunStateDocument> = {}): Promise<Fixture> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  await writeNativeManifest(paths, manifestOf());
  await writeNativeState(paths, stateOf(state));
  const events = await openNativeEventStore(paths, manifestOf());
  const authorResponse = await startSlot(events, 'author', SESSIONS.author);
  await startSlot(events, 'challenger', SESSIONS.challenger);

  const adapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: SESSIONS.challenger }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: SESSIONS.author }),
  };
  return {
    runsDir,
    paths,
    events,
    authorResponse,
    deps: { runsDir, now: () => new Date(AT), createAdapters: (): AgentAdapters => adapters },
    recovery: { runsDir, now: () => new Date(AT) },
    calls: () => adapters.claude.calls.length + adapters.codex.calls.length,
  };
}

async function journal(f: Fixture): Promise<readonly NativeCcrEvent[]> {
  return (await openNativeEventStore(f.paths, manifestOf())).readAll();
}

function markerOf(events: readonly NativeCcrEvent[], type: string): NativeCcrEvent {
  const found = events.filter((event) => event.type === type);
  assert.equal(found.length, 1, `un seul ${type}`);
  return found[0] as NativeCcrEvent;
}

/**
 * L'assertion centrale, en trois temps.
 *
 * Le second point est celui qui compte : sans lui, un témoin sans bordure
 * rendrait la propriété vraie pour la mauvaise raison — c'est précisément
 * l'erreur que ce repair corrige.
 */
function assertExactNote(marker: NativeCcrEvent): void {
  assert.equal(marker.content, NOTE, 'la note est persistée telle qu’elle a été écrite');
  assert.notEqual(marker.content, NOTE.trim(), 'le témoin distingue bien les deux comportements');
  assert.equal(marker.content?.length, NOTE.length, 'aucun caractère perdu');
  // Aucune normalisation : les points de code sont ceux fournis.
  assert.deepEqual([...(marker.content ?? '')], [...NOTE]);
  assert.equal(marker.content, marker.content?.normalize('NFC') === NOTE ? NOTE : marker.content);
  assert.ok(marker.content?.includes('élève / β'));
}

function stepPending(sourceEventId: string, promptEventId: string): NativePendingOperation {
  return {
    kind: 'step',
    source_slot: 'author',
    target_slot: 'challenger',
    source_event_id: sourceEventId,
    round: 1,
    prompt_event_id: promptEventId,
    session_id: SESSIONS.challenger,
    return_state: 'READY',
    return_control: 'AUTOMATION',
    started_at: AT,
  } as NativePendingOperation;
}

// ==========================================================================
// A. Les quatre domaines
// ==========================================================================

test('1 · initialisation : la note humaine est persistée exactement', async () => {
  const dir = await makeTempDir('ccr-ack-init-');
  try {
    // Fenêtre d'incertitude de 1D : un tour d'initialisation engagé, sans réponse.
    const f = await fixture(dir);
    const prompt = await f.events.append({
      round: 0,
      actor: 'human',
      type: 'prompt_sent',
      target_expert_slot_id: 'challenger',
      content: 'mission',
      timestamp: AT,
    });
    await writeNativeState(
      f.paths,
      stateOf({
        state: 'WAITING_AGENT',
        active_expert_slot: 'challenger',
        last_event_id: prompt.event_id,
        pending_operation: {
          kind: 'initialization',
          expert_slot: 'challenger',
          round: 0,
          prompt_event_id: prompt.event_id,
          session_id: null,
          return_state: 'FAILED_INITIALIZATION',
          return_control: 'AUTOMATION',
          started_at: AT,
        },
      }),
    );

    await acknowledgeNativeUncertainty(f.deps, RUN_ID, NOTE);

    const marker = markerOf(await journal(f), 'state_changed');
    assertExactNote(marker);
    // Le contrat événementiel est inchangé : type, acteur, motif.
    assert.equal(marker.actor, 'human');
    assert.equal(
      (marker.details as Record<string, unknown>)['reason'],
      'NATIVE_INITIALIZATION_UNCERTAINTY_ACKNOWLEDGED',
    );
    assert.equal(f.calls(), 0, 'un acquittement n’appelle personne');
  } finally {
    await removeTempDir(dir);
  }
});

test('2 · transfert : la note humaine est persistée exactement', async () => {
  const dir = await makeTempDir('ccr-ack-step-');
  try {
    const f = await fixture(dir, { state: 'RUNNING' });
    await f.events.append({
      round: 1,
      actor: 'system',
      type: 'round_started',
      target_expert_slot_id: 'challenger',
      based_on: [f.authorResponse],
      details: {
        round: 1,
        source_slot: 'author',
        target_slot: 'challenger',
        source_event_id: f.authorResponse,
      },
      timestamp: AT,
    });
    const prompt = await f.events.append({
      round: 1,
      actor: 'system',
      type: 'prompt_sent',
      target_expert_slot_id: 'challenger',
      session_id: SESSIONS.challenger,
      content: 'enveloppe',
      based_on: [f.authorResponse],
      timestamp: AT,
    });
    await writeNativeState(
      f.paths,
      stateOf({
        state: 'WAITING_AGENT',
        active_expert_slot: 'challenger',
        last_event_id: prompt.event_id,
        pending_operation: stepPending(f.authorResponse, prompt.event_id),
      }),
    );

    await acknowledgeNativeStepUncertainty(f.recovery, RUN_ID, NOTE);

    const marker = markerOf(await journal(f), 'transfer_uncertainty_acknowledged');
    assertExactNote(marker);
    // Les champs causaux sont inchangés : seul `content` était en cause.
    const record = marker as unknown as Record<string, unknown>;
    assert.equal(record['source_slot_id'], 'author');
    assert.equal(record['target_slot_id'], 'challenger');
    assert.equal(record['source_event_id'], f.authorResponse);
    assert.equal(record['reason'], 'IN_FLIGHT_UNCERTAIN');
    assert.equal(marker.round, 1);
    assert.equal(f.calls(), 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('3 · envoi : la note humaine est persistée exactement', async () => {
  const dir = await makeTempDir('ccr-ack-send-');
  try {
    const f = await fixture(dir);
    const message = await f.events.append({
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: SESSIONS.author,
      content: 'question humaine',
      timestamp: AT,
    });
    await writeNativeState(
      f.paths,
      stateOf({
        state: 'WAITING_AGENT',
        active_expert_slot: 'author',
        last_event_id: message.event_id,
        pending_operation: {
          kind: 'send',
          expert_slot: 'author',
          round: 0,
          prompt_event_id: message.event_id,
          session_id: SESSIONS.author,
          return_state: 'READY',
          return_control: 'AUTOMATION',
          started_at: AT,
        },
      }),
    );

    await acknowledgeNativeSendUncertainty(f.recovery, RUN_ID, NOTE);

    const marker = markerOf(await journal(f), 'send_uncertainty_acknowledged');
    assertExactNote(marker);
    const record = marker as unknown as Record<string, unknown>;
    assert.equal(record['target_expert_slot_id'], 'author');
    assert.equal(record['prompt_event_id'], message.event_id);
    assert.equal(record['reason'], 'IN_FLIGHT_UNCERTAIN');
    assert.equal(f.calls(), 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('4 · handoff : la note humaine est persistée exactement', async () => {
  const dir = await makeTempDir('ccr-ack-handoff-');
  try {
    const f = await fixture(dir, { state: 'PAUSED', control: 'HUMAN' });
    const started = await f.events.append({
      round: 0,
      actor: 'human',
      type: 'human_handoff_started',
      target_expert_slot_id: 'challenger',
      session_id: SESSIONS.challenger,
      details: { state: 'PAUSED', control: 'HUMAN' },
      timestamp: AT,
    });
    await writeNativeState(
      f.paths,
      stateOf({
        state: 'PAUSED',
        control: 'HUMAN',
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
      }),
    );

    await acknowledgeNativeHandoffUncertainty(f.recovery, RUN_ID, NOTE);

    const marker = markerOf(await journal(f), 'handoff_uncertainty_acknowledged');
    assertExactNote(marker);
    const record = marker as unknown as Record<string, unknown>;
    assert.equal(record['target_expert_slot_id'], 'challenger');
    assert.equal(record['reason'], 'IN_FLIGHT_UNCERTAIN');
    assert.equal(f.calls(), 0);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Ce qui n'a pas changé
// ==========================================================================

test('5 · une note faite d’espaces reste refusée, sans le moindre effet', async () => {
  const dir = await makeTempDir('ccr-ack-empty-');
  try {
    const f = await fixture(dir, { state: 'PAUSED', control: 'HUMAN' });
    const before = {
      state: await readFile(f.paths.state, 'utf8'),
      events: await readFile(f.paths.events, 'utf8'),
    };

    // `trim` valide toujours : c'est son seul rôle, et il est conservé.
    for (const blank of ['', ' ', '     ', '\t', '\n', ' \t\n ']) {
      await assert.rejects(
        acknowledgeNativeHandoffUncertainty(f.recovery, RUN_ID, blank),
        (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
        JSON.stringify(blank),
      );
    }

    assert.deepEqual(
      {
        state: await readFile(f.paths.state, 'utf8'),
        events: await readFile(f.paths.events, 'utf8'),
      },
      before,
      'aucun refus n’écrit',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('6 · l’empreinte d’idempotence et le contenu canonique concordent désormais', async () => {
  // Deux notes ne différant que par leurs bordures étaient déjà **deux
  // intentions** — empreintes distinctes. Elles produisaient pourtant un
  // contenu persisté identique : l'idempotence distinguait ce que le journal
  // confondait. Cette dissociation disparaît.
  const digests = ['note', ' note '].map((note) =>
    computeFingerprint({
      method: 'POST',
      action: 'NATIVE_RECOVERY:send:ACKNOWLEDGE_UNCERTAINTY',
      runId: RUN_ID,
      expectedRevision: `sha256:${'0'.repeat(64)}`,
      contentDigest: digestOfContent(note),
    }),
  );
  assert.notEqual(digests[0], digests[1], 'deux intentions distinctes');
  assert.notEqual(digestOfContent('note'), digestOfContent(' note '));
  // Et la note exacte est bien ce qui entre dans le condensat.
  assert.equal(digestOfContent(NOTE), digestOfContent(NOTE));
  assert.notEqual(digestOfContent(NOTE), digestOfContent(NOTE.trim()));
});
