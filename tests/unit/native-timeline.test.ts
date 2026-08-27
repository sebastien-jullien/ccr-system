/**
 * V2.1-IMP-19 — chronologie de la controverse native.
 *
 * Quatre propriétés gouvernent ce fichier.
 *
 *  1. **L'identité est un rôle.** `author` et `challenger` restent distincts
 *     même lorsqu'ils partagent le moteur ; le fournisseur est dérivé du
 *     manifest, jamais de l'acteur, jamais d'une session.
 *  2. **Rien n'est fabriqué.** Contenu intégral, note humaine bit pour bit,
 *     événements neutres qui restent neutres, HANDOFF qui n'invente aucun
 *     transcript.
 *  3. **Une page appartient à une révision.** Entrées et empreinte viennent du
 *     même instantané ; deux pages de deux révisions ne sont jamais recousues.
 *  4. **L'ordre est celui du journal.** Aucun tri : ni horodatage, ni round, ni
 *     slot, ni fournisseur.
 *
 * Aucun serveur, aucun fournisseur, aucun processus : les stores canoniques
 * écrivent les fixtures, et les lectures sont éprouvées directement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import type { NativeRunManifest, NativeRunStateDocument } from '../../src/core/run-native.ts';
import { withRunLock } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import type { NativeEventStore } from '../../src/store/native-event-store.ts';
import { writeNativeManifest, writeNativeState } from '../../src/store/native-store.ts';
import {
  computeNativeRunRevision,
  readStableNativeRunSnapshot,
} from '../../src/store/native-run-snapshot.ts';
import { getTimeline, encodeTimelineCursor } from '../../src/services/cockpit-read-model.ts';
import { resolveRunExecutionSettings } from '../../src/services/run-execution-settings.ts';
import {
  NATIVE_TIMELINE_VERSION,
  projectNativeTimeline,
} from '../../src/services/native-timeline-read-model.ts';
import type { NativeTimelineEntryV1 } from '../../src/services/native-timeline-read-model.ts';
import {
  readNativeRunHttpView,
  readNativeTimelineHttpView,
} from '../../src/cockpit/native-read-http.ts';
import { publicErrorFor } from '../../src/cockpit/http-errors.ts';
import { materializeRun } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-019';
const LEGACY_ID = 'CCR-20260811-018';
const AT = '2026-08-11T00:00:00.000Z';

/** Témoin de fidélité : bordures significatives, Unicode, ponctuation. */
const NOTE = '  « décision humaine — élève / β »  ';
const MISSION = 'Mission initiale : évaluer la refonte.';
const AUTHOR_POSITION = 'Position de l’auteur : la refonte est prématurée.';
const CHALLENGER_POSITION = 'Réfutation : le coût de report dépasse le risque.';
const COUNTER_ARGUMENT = 'Contre-argument du challenger, après transfert.';
const HUMAN_MESSAGE = '  Précisez le coût de report.  ';

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Harnais — stores canoniques uniquement
// --------------------------------------------------------------------------

interface Bindings {
  readonly author: ProviderKind;
  readonly challenger: ProviderKind;
}

function manifestOf(bindings: Bindings, sessions: Record<ExpertSlotId, string>): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Contre-expertise',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: bindings.author, session_id: sessions.author },
      challenger: { provider: bindings.challenger, session_id: sessions.challenger },
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
    state: 'PAUSED',
    control: 'HUMAN',
    round: 1,
    active_expert_slot: null,
    next_step_source_slot: 'challenger',
    last_event_id: null,
    pending_operation: null,
    uncertainty: null,
    updated_at: AT,
    ...over,
  };
}

interface Journal {
  readonly authorResponse: string;
  readonly counterArgument: string;
  readonly humanMessage: string;
  readonly orphanPrompt: string;
  readonly handoffStarted: string;
}

/**
 * Un run complet : deux positions initiales, un passage de témoin, un envoi
 * humain avec sa réponse, deux acquittements humains, une ouverture de handoff,
 * et une suspension. C'est la matière minimale d'une controverse lisible.
 */
async function buildJournal(
  events: NativeEventStore,
  sessions: Record<ExpertSlotId, string>,
): Promise<Journal> {
  const authorPrompt = await events.append({
    round: 0, actor: 'human', type: 'prompt_sent', target_expert_slot_id: 'author',
    content: MISSION, timestamp: AT,
  });
  const authorResponse = await events.append({
    round: 0, actor: 'expert', type: 'assistant_response', expert_slot_id: 'author',
    session_id: sessions.author, content: AUTHOR_POSITION, exit_code: 0,
    based_on: [authorPrompt.event_id], timestamp: AT,
  });
  await events.append({
    round: 0, actor: 'system', type: 'session_created', expert_slot_id: 'author',
    session_id: sessions.author, timestamp: AT,
  });

  const challengerPrompt = await events.append({
    round: 0, actor: 'human', type: 'prompt_sent', target_expert_slot_id: 'challenger',
    content: MISSION, timestamp: AT,
  });
  await events.append({
    round: 0, actor: 'expert', type: 'assistant_response', expert_slot_id: 'challenger',
    session_id: sessions.challenger, content: CHALLENGER_POSITION, exit_code: 0,
    based_on: [challengerPrompt.event_id], timestamp: AT,
  });
  await events.append({
    round: 0, actor: 'system', type: 'session_created', expert_slot_id: 'challenger',
    session_id: sessions.challenger, timestamp: AT,
  });

  // Passage de témoin : la position de l'auteur devient la source.
  const started = await events.append({
    round: 1, actor: 'system', type: 'round_started', target_expert_slot_id: 'challenger', timestamp: AT,
  });
  const counterArgument = await events.append({
    round: 1, actor: 'expert', type: 'assistant_response', expert_slot_id: 'challenger',
    session_id: sessions.challenger, content: COUNTER_ARGUMENT, exit_code: 0,
    based_on: [started.event_id], timestamp: AT,
  });
  await events.append({
    round: 1, actor: 'system', type: 'round_completed', source_slot_id: 'author',
    target_slot_id: 'challenger', source_event_id: authorResponse.event_id,
    response_event_id: counterArgument.event_id, timestamp: AT,
  });

  // Envoi humain, et sa réponse : deux faits distincts.
  const humanMessage = await events.append({
    round: 1, actor: 'human', type: 'human_message', target_expert_slot_id: 'author',
    content: HUMAN_MESSAGE, timestamp: AT,
  });
  await events.append({
    round: 1, actor: 'expert', type: 'assistant_response', expert_slot_id: 'author',
    session_id: sessions.author, content: 'Réponse de l’auteur au message humain.', exit_code: 0,
    based_on: [humanMessage.event_id], timestamp: AT,
  });

  // Un second envoi resté sans issue, acquitté par un humain.
  const orphanPrompt = await events.append({
    round: 1, actor: 'human', type: 'human_message', target_expert_slot_id: 'author',
    content: 'Second message, resté sans réponse connue.', timestamp: AT,
  });
  await events.append({
    round: 1, actor: 'human', type: 'send_uncertainty_acknowledged', target_expert_slot_id: 'author',
    prompt_event_id: orphanPrompt.event_id, reason: 'IN_FLIGHT_UNCERTAIN', content: NOTE, timestamp: AT,
  });

  // Une ouverture de handoff, et son acquittement.
  const handoffStarted = await events.append({
    round: 1, actor: 'human', type: 'human_handoff_started', target_expert_slot_id: 'challenger',
    session_id: sessions.challenger, timestamp: AT,
  });
  await events.append({
    round: 1, actor: 'human', type: 'handoff_uncertainty_acknowledged',
    target_expert_slot_id: 'challenger', started_event_id: handoffStarted.event_id,
    reason: 'IN_FLIGHT_UNCERTAIN', content: NOTE, timestamp: AT,
  });

  // Événement generation-neutral : aucune identité, aucune session.
  await events.append({ round: 1, actor: 'human', type: 'run_paused', timestamp: AT });

  return {
    authorResponse: authorResponse.event_id,
    counterArgument: counterArgument.event_id,
    humanMessage: humanMessage.event_id,
    orphanPrompt: orphanPrompt.event_id,
    handoffStarted: handoffStarted.event_id,
  };
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: ReturnType<typeof runPaths>;
  readonly manifest: NativeRunManifest;
  readonly sessions: Record<ExpertSlotId, string>;
  readonly journal: Journal;
  readonly deps: { runsDir: string };
}

async function nativeRun(dir: string, bindings: Bindings = { author: 'claude', challenger: 'claude' }): Promise<Fixture> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  // Deux sessions distinctes, dérivées du **slot** : c'est ce qui rend la
  // configuration same-provider réellement discriminante.
  const sessions: Record<ExpertSlotId, string> = { author: 'S1', challenger: 'S2' };
  const manifest = manifestOf(bindings, sessions);
  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, stateOf());
  const events = await openNativeEventStore(paths, manifest);
  const journal = await buildJournal(events, sessions);
  return { runsDir, paths, manifest, sessions, journal, deps: { runsDir } };
}

// --------------------------------------------------------------------------
// Lecture d'entrées
// --------------------------------------------------------------------------

function prov(entry: NativeTimelineEntryV1): Record<string, unknown> {
  return entry.provenance as unknown as Record<string, unknown>;
}

function byId(entries: readonly NativeTimelineEntryV1[], eventId: string): NativeTimelineEntryV1 {
  const found = entries.find((entry) => entry.event_id === eventId);
  assert.ok(found !== undefined, `entrée ${eventId} présente`);
  return found;
}

function ofType(entries: readonly NativeTimelineEntryV1[], type: string): readonly NativeTimelineEntryV1[] {
  return entries.filter((entry) => entry.type === type);
}

// ==========================================================================
// A. Provenance — l'identité est un rôle
// ==========================================================================

test('1–4 · START rend deux positions séparées, distinctes même moteur partagé', async () => {
  const dir = await makeTempDir('ccr-19-start-');
  try {
    const f = await nativeRun(dir);
    const page = await readNativeTimelineHttpView(f.deps, RUN_ID);

    // 1 · les deux réponses initiales sont visibles séparément.
    const responses = ofType(page.entries, 'assistant_response');
    const initial = responses.filter((entry) => entry.round === 0);
    assert.equal(initial.length, 2, 'deux positions initiales, jamais fusionnées');

    // 2–3 · chacune nomme son expert et sa session.
    const author = initial.find((entry) => prov(entry)['expert_slot_id'] === 'author');
    const challenger = initial.find((entry) => prov(entry)['expert_slot_id'] === 'challenger');
    assert.ok(author !== undefined && challenger !== undefined);
    assert.equal(author.content, AUTHOR_POSITION);
    assert.equal(challenger.content, CHALLENGER_POSITION);

    // 4 · same-provider : même moteur des deux côtés, deux identités distinctes.
    assert.equal(prov(author)['provider'], 'claude');
    assert.equal(prov(challenger)['provider'], 'claude');
    assert.notEqual(prov(author)['session_id'], prov(challenger)['session_id']);
    assert.equal(prov(author)['session_id'], 'S1');
    assert.equal(prov(challenger)['session_id'], 'S2');

    // Aucun `round_started`/`round_completed` fabriqué pour les rendre.
    assert.equal(ofType(page.entries, 'round_started').filter((e) => e.round === 0).length, 0);
    assert.equal(ofType(page.entries, 'round_completed').filter((e) => e.round === 0).length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('5–7 · SEND reste deux faits, et le transfert nomme sa source et sa cible', async () => {
  const dir = await makeTempDir('ccr-19-send-step-');
  try {
    const f = await nativeRun(dir);
    const page = await readNativeTimelineHttpView(f.deps, RUN_ID);

    // 5 · le message humain existe pour lui-même, avec son contenu intégral.
    const human = byId(page.entries, f.journal.humanMessage);
    assert.equal(human.actor, 'human');
    assert.equal(human.content, HUMAN_MESSAGE, 'contenu humain intégral, bordures comprises');
    assert.equal(prov(human)['target_expert_slot_id'], 'author');
    assert.equal(prov(human)['session_id'], null, 'aucune session inventée');

    // 6 · la réponse de l'expert est une entrée distincte, jamais absorbée.
    const answer = page.entries.find(
      (entry) => entry.type === 'assistant_response' && entry.based_on.includes(f.journal.humanMessage),
    );
    assert.ok(answer !== undefined, 'la réponse à l’envoi est visible');
    assert.equal(prov(answer)['expert_slot_id'], 'author');

    // 7 · le transfert porte ses quatre faits, par slots.
    const transfer = ofType(page.entries, 'round_completed')[0];
    assert.ok(transfer !== undefined);
    assert.equal(prov(transfer)['shape'], 'TRANSFER');
    assert.equal(prov(transfer)['source_slot_id'], 'author');
    assert.equal(prov(transfer)['target_slot_id'], 'challenger');
    assert.equal(prov(transfer)['source_event_id'], f.journal.authorResponse);
    assert.equal(prov(transfer)['response_event_id'], f.journal.counterArgument);
  } finally {
    await removeTempDir(dir);
  }
});

test('8–10 · notes exactes, événements neutres neutres, HANDOFF sans transcript', async () => {
  const dir = await makeTempDir('ccr-19-markers-');
  try {
    const f = await nativeRun(dir);
    const page = await readNativeTimelineHttpView(f.deps, RUN_ID);

    // 8 · la note humaine ressort **telle qu'elle a été écrite**.
    const sendAck = ofType(page.entries, 'send_uncertainty_acknowledged')[0];
    assert.ok(sendAck !== undefined);
    assert.equal(sendAck.content, NOTE);
    assert.notEqual(sendAck.content, NOTE.trim(), 'le témoin distingue les deux comportements');
    assert.deepEqual([...String(sendAck.content)], [...NOTE], 'aucune normalisation Unicode');
    assert.equal(sendAck.reason, 'IN_FLIGHT_UNCERTAIN');
    assert.equal(prov(sendAck)['prompt_event_id'], f.journal.orphanPrompt);
    assert.equal('response_event_id' in prov(sendAck), false, 'aucune conclusion fabriquée');

    // 9 · un événement generation-neutral reste sans identité.
    const paused = ofType(page.entries, 'run_paused')[0];
    assert.ok(paused !== undefined);
    assert.deepEqual(prov(paused), { shape: 'GENERATION_NEUTRAL' });
    for (const forbidden of ['expert_slot_id', 'target_expert_slot_id', 'provider', 'session_id']) {
      assert.equal(forbidden in prov(paused), false, `aucun ${forbidden} inventé`);
    }

    // 10 · le handoff se lit par ses faits journalisés, et rien de plus.
    const opened = byId(page.entries, f.journal.handoffStarted);
    assert.equal(prov(opened)['target_expert_slot_id'], 'challenger');
    const handoffAck = ofType(page.entries, 'handoff_uncertainty_acknowledged')[0];
    assert.ok(handoffAck !== undefined);
    assert.equal(prov(handoffAck)['started_event_id'], f.journal.handoffStarted);
    assert.equal(handoffAck.content, NOTE);
    // CCR ne possède pas le contenu de l'interaction : il ne le prétend pas.
    assert.equal('prompt_event_id' in prov(handoffAck), false);
    assert.equal('session_id' in prov(handoffAck), false);
  } finally {
    await removeTempDir(dir);
  }
});

test('11–13 · ordre journal, provider dérivé du manifest, session préservée', async () => {
  const dir = await makeTempDir('ccr-19-order-');
  try {
    // Bindings asymétriques : le fournisseur doit suivre le slot, pas l'acteur.
    const f = await nativeRun(dir, { author: 'codex', challenger: 'claude' });
    const snapshot = await readStableNativeRunSnapshot(f.runsDir, RUN_ID);
    const page = await readNativeTimelineHttpView(f.deps, RUN_ID);

    // 11 · exactement l'ordre journalisé, sans le moindre tri.
    assert.deepEqual(
      page.entries.map((entry) => entry.event_id),
      snapshot.events.map((event) => event.event_id),
    );
    // Tous les horodatages sont identiques : un tri stable par timestamp aurait
    // pu passer inaperçu, un tri par round ou par slot non.
    assert.equal(new Set(page.entries.map((entry) => entry.timestamp)).size, 1);

    // 12 · le moteur vient du binding du slot ; l'acteur reste une catégorie.
    const authorEntry = byId(page.entries, f.journal.authorResponse);
    assert.equal(authorEntry.actor, 'expert', 'jamais « codex » comme acteur');
    assert.equal(prov(authorEntry)['provider'], 'codex');
    const challengerEntry = byId(page.entries, f.journal.counterArgument);
    assert.equal(challengerEntry.actor, 'expert');
    assert.equal(prov(challengerEntry)['provider'], 'claude');
    const transfer = ofType(page.entries, 'round_completed')[0];
    assert.equal(prov(transfer!)['source_provider'], 'codex');
    assert.equal(prov(transfer!)['target_provider'], 'claude');

    // 13 · la session n'est transmise que lorsque l'événement la porte.
    assert.equal(prov(byId(page.entries, f.journal.handoffStarted))['session_id'], 'S2');
    assert.equal(prov(byId(page.entries, f.journal.humanMessage))['session_id'], null);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Instantané et révision
// ==========================================================================

test('14–16 · révision et entrées viennent du même instantané, lisible sous verrou', async () => {
  const dir = await makeTempDir('ccr-19-snapshot-');
  try {
    const f = await nativeRun(dir);
    const snapshot = await readStableNativeRunSnapshot(f.runsDir, RUN_ID);
    const page = await readNativeTimelineHttpView(f.deps, RUN_ID);
    const runView = await readNativeRunHttpView(f.deps, RUN_ID);

    // 14 · une seule empreinte pour tout le run : celle du snapshot natif.
    assert.equal(page.revision, snapshot.revision);
    assert.equal(page.revision, runView.revision);
    assert.equal(
      page.revision,
      computeNativeRunRevision(snapshot.manifest, snapshot.state, snapshot.events),
    );

    // 15 · les entrées sont exactement les événements de ce snapshot.
    assert.equal(page.total, snapshot.events.length);
    assert.deepEqual(
      page.entries,
      projectNativeTimeline(snapshot.manifest, snapshot.events),
      'aucune seconde lecture, aucune projection divergente',
    );
    assert.equal(page.timeline_version, NATIVE_TIMELINE_VERSION);
    assert.equal(page.run_id, RUN_ID);

    // 16 · un HANDOFF détient le verrou pendant toute l'intervention humaine :
    // la controverse doit rester lisible précisément à ce moment-là.
    const locked = await withRunLock(f.paths, 'handoff-simulé', () =>
      readNativeTimelineHttpView(f.deps, RUN_ID),
    );
    assert.equal(locked.entries.length, page.entries.length);
    assert.equal(locked.revision, page.revision);
  } finally {
    await removeTempDir(dir);
  }
});

test('17–19 · pureté, refus propagés, et `rounds/` jamais lu', async () => {
  const dir = await makeTempDir('ccr-19-purity-');
  try {
    const f = await nativeRun(dir);
    const before = {
      manifest: await readFile(f.paths.manifest, 'utf8'),
      state: await readFile(f.paths.state, 'utf8'),
      events: await readFile(f.paths.events, 'utf8'),
    };

    const page = await readNativeTimelineHttpView(f.deps, RUN_ID);
    await readNativeTimelineHttpView(f.deps, RUN_ID, { pageSize: 3 });

    // 17 · aucune écriture, aucun marqueur, aucun état.
    assert.deepEqual(
      {
        manifest: await readFile(f.paths.manifest, 'utf8'),
        state: await readFile(f.paths.state, 'utf8'),
        events: await readFile(f.paths.events, 'utf8'),
      },
      before,
      'une lecture ne touche aucun fait canonique',
    );

    // 18 · les refus du lecteur d'instantané traversent la surface **intacts** :
    // rien n'est rattrapé ici. Le cas déterministe est la génération ; le budget
    // de stabilité épuisé emprunte exactement le même chemin, et sa traduction
    // publique est vérifiée plus bas.
    await materializeRun(f.runsDir, { runId: LEGACY_ID });
    await expectRejection(
      readNativeTimelineHttpView(f.deps, LEGACY_ID),
      'SCHEMA_VERSION_UNSUPPORTED',
      'aucune conversion, aucun rattrapage',
    );
    const surface = await readFile(
      fileURLToPath(new URL('../../src/cockpit/native-read-http.ts', import.meta.url)),
      'utf8',
    );
    assert.equal(surface.includes('catch'), false, 'aucune erreur de lecture n’est avalée');

    // 19 · `rounds/` n'entre pas dans la chronologie : un artefact illisible ne
    // change rien, parce qu'il n'est jamais ouvert.
    await mkdir(path.join(f.paths.roundsDir, '1'), { recursive: true });
    await writeFile(path.join(f.paths.roundsDir, '1', 'metadata.json'), '{ ceci n’est pas du JSON', 'utf8');
    const after = await readNativeTimelineHttpView(f.deps, RUN_ID);
    assert.deepEqual(after.entries, page.entries);
    const model = await readFile(
      fileURLToPath(new URL('../../src/services/native-timeline-read-model.ts', import.meta.url)),
      'utf8',
    );
    for (const forbidden of ['round-store', 'roundsDir', 'metadata.json', 'node:fs']) {
      assert.equal(model.includes(forbidden), false, `la projection ignore ${forbidden}`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Pagination liée à la révision
// ==========================================================================

test('20–22 · première page, page suivante, et révision périmée refusée', async () => {
  const dir = await makeTempDir('ccr-19-pages-');
  try {
    const f = await nativeRun(dir);
    const first = await readNativeTimelineHttpView(f.deps, RUN_ID, { pageSize: 4 });

    // 20 · une première page bornée, avec son curseur.
    assert.equal(first.entries.length, 4);
    assert.equal(first.truncated, true);
    assert.ok(typeof first.cursor_next === 'string' && first.cursor_next.length > 0);
    assert.ok(first.total > 4);

    // 21 · la page suivante appartient à la **même** révision.
    const second = await readNativeTimelineHttpView(f.deps, RUN_ID, {
      pageSize: 4,
      cursor: first.cursor_next,
    });
    assert.equal(second.revision, first.revision);
    assert.equal(second.total, first.total);
    assert.deepEqual(
      second.entries.map((entry) => entry.event_id),
      (await readNativeTimelineHttpView(f.deps, RUN_ID)).entries.slice(4, 8).map((entry) => entry.event_id),
    );

    // 22 · un événement de plus, et l'ancien curseur devient périmé.
    const events = await openNativeEventStore(f.paths, f.manifest);
    await events.append({ round: 1, actor: 'human', type: 'run_resumed', timestamp: AT });
    await expectRejection(
      readNativeTimelineHttpView(f.deps, RUN_ID, { pageSize: 4, cursor: first.cursor_next }),
      'STALE_REVISION',
      'aucune page recousue',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('23–25 · aucune fusion entre révisions, ordre conservé, arguments refusés', async () => {
  const dir = await makeTempDir('ccr-19-pagination-guards-');
  try {
    const f = await nativeRun(dir);
    const whole = await readNativeTimelineHttpView(f.deps, RUN_ID);

    // 23 · un curseur émis pour une autre révision est refusé, jamais accepté
    // « au plus proche ».
    await expectRejection(
      readNativeTimelineHttpView(f.deps, RUN_ID, {
        cursor: encodeTimelineCursor(`sha256:${'f'.repeat(64)}`, 2),
      }),
      'STALE_REVISION',
      'une révision étrangère ne paginé rien',
    );

    // 24 · la concaténation des pages reproduit exactement le journal.
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: Awaited<ReturnType<typeof readNativeTimelineHttpView>> =
        await readNativeTimelineHttpView(f.deps, RUN_ID, {
          pageSize: 3,
          ...(cursor === null ? {} : { cursor }),
        });
      collected.push(...page.entries.map((entry) => entry.event_id));
      cursor = page.cursor_next;
      if (cursor === null) break;
    }
    assert.deepEqual(collected, whole.entries.map((entry) => entry.event_id));

    // 25 · taille et curseur invalides suivent le contrat historique.
    await expectRejection(
      readNativeTimelineHttpView(f.deps, RUN_ID, { pageSize: 0 }),
      'INVALID_ARGUMENT',
      'taille de page nulle',
    );
    await expectRejection(
      readNativeTimelineHttpView(f.deps, RUN_ID, { pageSize: 2.5 }),
      'INVALID_ARGUMENT',
      'taille de page non entière',
    );
    await expectRejection(
      readNativeTimelineHttpView(f.deps, RUN_ID, { cursor: 'pas-un-curseur' }),
      'INVALID_ARGUMENT',
      'curseur illisible',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Surface HTTP
// ==========================================================================

test('26–30 · la route aiguille sur la génération, et les codes restent ceux du contrat', async () => {
  const dir = await makeTempDir('ccr-19-http-');
  try {
    const f = await nativeRun(dir);
    await materializeRun(f.runsDir, {
      runId: LEGACY_ID,
      events: [{ round: 0, actor: 'human', type: 'human_message', target: 'claude', content: 'legacy' }],
    });

    // 26 · la chronologie historique est inchangée : sa forme est celle de V2.
    const legacy = await getTimeline(
      { runsDir: f.runsDir, settings: resolveRunExecutionSettings({}) },
      LEGACY_ID,
    );
    const legacyEntry = legacy.entries.find((entry) => entry.kind === 'event');
    assert.ok(legacyEntry !== undefined);
    assert.equal('target' in legacyEntry, true, 'l’entrée historique conserve sa cible fournisseur');
    assert.equal('provenance' in legacyEntry, false, 'aucune forme native injectée');
    assert.equal('generation' in legacy, false);

    // 27 · la chronologie native répond, et se déclare.
    const native = await readNativeTimelineHttpView(f.deps, RUN_ID);
    assert.equal(native.generation, 'NATIVE_V21_EXECUTION');
    assert.ok(native.entries.length > 0);

    // 28 · plus aucun refus de surface : la route ne connaît plus le helper.
    const server = await readFile(
      fileURLToPath(new URL('../../src/cockpit/server.ts', import.meta.url)),
      'utf8',
    );
    assert.equal(server.includes('nativeSurfaceUnsupported'), false);
    assert.ok(server.includes('readNativeTimelineHttpView'));
    // La génération est établie avant toute projection d'événement.
    assert.ok(server.indexOf('readRunGeneration') < server.indexOf('readNativeTimelineHttpView'));

    // 29–30 · les deux refus de la pagination gardent leur statut historique.
    assert.equal(publicErrorFor(await refusalOf(f.deps)).status, 409);
    assert.equal(publicErrorFor(await refusalOf(f.deps)).body.error.code, 'STALE_REVISION');
    const unstable = publicErrorFor(
      new (await import('../../src/core/errors.ts')).CcrError('SNAPSHOT_UNSTABLE', 'x'),
    );
    assert.equal(unstable.status, 503, 'transitoire, donc réessayable');
  } finally {
    await removeTempDir(dir);
  }
});

/** Produit un vrai refus de pagination, plutôt qu'une erreur fabriquée. */
async function refusalOf(deps: { runsDir: string }): Promise<unknown> {
  try {
    await readNativeTimelineHttpView(deps, RUN_ID, {
      cursor: encodeTimelineCursor(`sha256:${'e'.repeat(64)}`, 0),
    });
  } catch (error) {
    return error;
  }
  throw new Error('un curseur étranger doit être refusé');
}
