/**
 * Activité durable machine d'un run — `ccr run-activity <run_id> --format json`.
 *
 * Question de preuve :
 *
 * > **La projection rend-elle une histoire F2 *complète* — ou dit-elle
 * > explicitement qu'elle ne le peut pas — sans jamais deviner un rôle, un
 * > ordre ou un rattachement, et sans jamais laisser fuir un fait interne ?**
 *
 * Cinq propriétés.
 *
 *  1. **Trois issues, jamais confondues.** `AVAILABLE`, `UNAVAILABLE` et
 *     `PROJECTION_FAILURE` sont trois faits distincts, tous en sortie 0.
 *  2. **Jeux de champs fermés.** Quatre champs communs, plus ceux de la
 *     variante ; un champ non applicable est structurellement absent.
 *  3. **Identité et ordre publics.** `activity_id` opaque et stable,
 *     `sequence` autorité d'ordre, aucun identifiant interne exposé.
 *  4. **Une activité logique agrège plusieurs faits.** Une reprise rejoint la
 *     même identité ; un envoi humain ne consomme aucun round.
 *  5. **Jamais de devinette.** Un rôle inconnu rend `UNAVAILABLE`, jamais un
 *     document partiel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RunServiceDeps } from '../../src/services/run-service.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runCli } from '../../src/cli/main.ts';
import {
  DURABLE_RUN_ACTIVITY_CONTRACT_VERSION,
  DURABLE_RUN_ACTIVITY_MACHINE_REPRESENTATION_VERSION,
  serializeRunActivity,
} from '../../src/cli/run-activity-machine.ts';
import { projectRunActivity } from '../../src/services/run-activity-projection.ts';
import type { NativeCcrEvent, NativeRunStateDocument } from '../../src/core/run-native.ts';

const AT = '2026-09-05T10:00:00.000Z';
const RUN = 'CCR-20260905-001';

const COMMON_FIELDS = ['activity_id', 'activity_kind', 'procedural_disposition', 'sequence'];

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  dispose(): Promise<void>;
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function harness(): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-activity-'));
  return {
    runsDir,
    deps: { runsDir, now: () => new Date(AT) } as RunServiceDeps,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

async function cli(h: Harness, argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await runCli([...argv, '--runs-dir', h.runsDir], { io, deps: h.deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// --------------------------------------------------------------------------
// Fabrique de faits durables
// --------------------------------------------------------------------------

type EventDraft = Record<string, unknown>;

let sequence = 0;

function evt(fields: EventDraft): EventDraft {
  sequence += 1;
  return {
    event_id: `evt_${String(sequence).padStart(6, '0')}`,
    run_id: RUN,
    round: 0,
    timestamp: AT,
    ...fields,
  };
}

/** Réinitialise le compteur d'identifiants entre deux journaux. */
function journal(build: () => EventDraft[]): EventDraft[] {
  sequence = 0;
  return build();
}

const SESSION = { author: 'S1', challenger: 'S2' } as const;

type Slot = 'author' | 'challenger';

function initializationEvents(): EventDraft[] {
  const created = evt({ actor: 'system', type: 'run_created' });
  const promptAuthor = evt({ actor: 'human', type: 'prompt_sent', target_expert_slot_id: 'author' });
  const answerAuthor = evt({
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: SESSION.author,
    based_on: [promptAuthor['event_id']],
    exit_code: 0,
  });
  const sessionAuthor = evt({
    actor: 'system',
    type: 'session_created',
    expert_slot_id: 'author',
    session_id: SESSION.author,
  });
  const promptChallenger = evt({
    actor: 'human',
    type: 'prompt_sent',
    target_expert_slot_id: 'challenger',
  });
  const answerChallenger = evt({
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'challenger',
    session_id: SESSION.challenger,
    based_on: [promptChallenger['event_id']],
    exit_code: 0,
  });
  const sessionChallenger = evt({
    actor: 'system',
    type: 'session_created',
    expert_slot_id: 'challenger',
    session_id: SESSION.challenger,
  });
  return [
    created,
    promptAuthor,
    answerAuthor,
    sessionAuthor,
    promptChallenger,
    answerChallenger,
    sessionChallenger,
  ];
}

/** Un passage de témoin complet : ouverture, demande, réponse, clôture. */
function completedRound(round: number, source: Slot, target: Slot, sourceEventId: string): EventDraft[] {
  const started = evt({
    actor: 'system',
    type: 'round_started',
    round,
    target_expert_slot_id: target,
    based_on: [sourceEventId],
  });
  const prompt = evt({
    actor: 'system',
    type: 'prompt_sent',
    round,
    target_expert_slot_id: target,
    session_id: SESSION[target],
    based_on: [sourceEventId],
  });
  const answer = evt({
    actor: 'expert',
    type: 'assistant_response',
    round,
    expert_slot_id: target,
    session_id: SESSION[target],
    based_on: [prompt['event_id']],
    exit_code: 0,
  });
  const completed = evt({
    actor: 'system',
    type: 'round_completed',
    round,
    source_slot_id: source,
    target_slot_id: target,
    source_event_id: sourceEventId,
    response_event_id: answer['event_id'],
    based_on: [sourceEventId, answer['event_id']],
  });
  return [started, prompt, answer, completed];
}

async function writeRun(
  h: Harness,
  options: {
    readonly runId?: string;
    readonly manifest?: 'native' | 'legacy' | 'corrupt' | 'absent';
    readonly events?: readonly EventDraft[] | 'corrupt' | 'absent';
    readonly state?: Record<string, unknown> | 'corrupt' | 'absent';
  } = {},
): Promise<string> {
  const runId = options.runId ?? RUN;
  const root = path.join(h.runsDir, runId);
  await mkdir(root, { recursive: true });

  const manifestKind = options.manifest ?? 'native';
  if (manifestKind === 'corrupt') {
    await writeFile(path.join(root, 'manifest.json'), '{ pas du JSON', 'utf8');
  } else if (manifestKind === 'legacy') {
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        schema_version: 1,
        run_id: runId,
        title: 'Run historique',
        created_at: AT,
        workspace: { cwd: h.runsDir },
        agents: {
          claude: { session_id: 'S1', role: 'author' },
          codex: { session_id: 'S2', role: 'challenger' },
        },
      }),
      'utf8',
    );
  } else if (manifestKind === 'native') {
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        schema_version: 2,
        run_id: runId,
        title: 'Run natif',
        created_at: AT,
        workspace: { cwd: h.runsDir },
        experts: {
          author: { provider: 'claude', session_id: SESSION.author },
          challenger: { provider: 'codex', session_id: SESSION.challenger },
        },
      }),
      'utf8',
    );
  }

  const state = options.state ?? {};
  if (state === 'corrupt') {
    await writeFile(path.join(root, 'state.json'), '{ pas du JSON', 'utf8');
  } else if (state !== 'absent' && manifestKind !== 'legacy') {
    await writeFile(
      path.join(root, 'state.json'),
      JSON.stringify({
        schema_version: 3,
        run_id: runId,
        state: 'READY',
        control: 'AUTOMATION',
        round: 0,
        active_expert_slot: null,
        next_step_source_slot: 'author',
        last_event_id: null,
        pending_operation: null,
        uncertainty: null,
        updated_at: AT,
        ...state,
      }),
      'utf8',
    );
  }

  const events = options.events ?? [];
  if (events === 'corrupt') {
    await writeFile(path.join(root, 'events.jsonl'), 'pas du JSON\n', 'utf8');
  } else if (events !== 'absent') {
    await writeFile(
      path.join(root, 'events.jsonl'),
      events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : ''),
      'utf8',
    );
  }

  return runId;
}

interface ActivityDoc {
  readonly durable_run_activity_contract_version: number;
  readonly durable_run_activity_machine_representation_version: number;
  readonly run_id: string;
  readonly projection_status: string;
  readonly activities?: Record<string, unknown>[];
}

async function read(h: Harness, runId = RUN): Promise<{ code: number; doc: ActivityDoc; raw: string }> {
  const result = await cli(h, ['run-activity', runId, '--format', 'json']);
  return { code: result.code, doc: JSON.parse(result.out) as ActivityDoc, raw: result.out };
}

// --------------------------------------------------------------------------
// A1 — AVAILABLE, histoire non vide, jeux de champs exacts
// --------------------------------------------------------------------------

test('A1 · AVAILABLE avec une histoire complète, et des jeux de champs fermés', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      const round1 = completedRound(1, 'author', 'challenger', authorAnswer);
      const send = evt({
        actor: 'human',
        type: 'human_message',
        round: 1,
        target_expert_slot_id: 'author',
        session_id: SESSION.author,
      });
      const sendAnswer = evt({
        actor: 'expert',
        type: 'assistant_response',
        round: 1,
        expert_slot_id: 'author',
        session_id: SESSION.author,
        based_on: [send['event_id']],
        exit_code: 0,
      });
      return [...init, ...round1, send, sendAnswer];
    });
    await writeRun(h, { events, state: { round: 1 } });

    const { code, doc } = await read(h);
    assert.equal(code, 0);

    assert.deepEqual(Object.keys(doc).sort(), [
      'activities',
      'durable_run_activity_contract_version',
      'durable_run_activity_machine_representation_version',
      'projection_status',
      'run_id',
    ]);
    assert.equal(doc.durable_run_activity_contract_version, DURABLE_RUN_ACTIVITY_CONTRACT_VERSION);
    assert.equal(
      doc.durable_run_activity_machine_representation_version,
      DURABLE_RUN_ACTIVITY_MACHINE_REPRESENTATION_VERSION,
    );
    assert.equal(doc.run_id, RUN);
    assert.equal(doc.projection_status, 'AVAILABLE');

    const activities = doc.activities ?? [];
    assert.deepEqual(
      activities.map((a) => a['activity_kind']),
      ['RUN_START', 'NATIVE_STEP', 'HUMAN_SEND'],
    );

    // Jeux de champs exacts, variante par variante.
    assert.deepEqual(Object.keys(activities[0] ?? {}).sort(), COMMON_FIELDS);
    assert.deepEqual(
      Object.keys(activities[1] ?? {}).sort(),
      [...COMMON_FIELDS, 'round', 'source_role', 'target_role'].sort(),
    );
    assert.deepEqual(
      Object.keys(activities[2] ?? {}).sort(),
      [...COMMON_FIELDS, 'target_role'].sort(),
    );

    assert.equal(activities[1]?.['source_role'], 'author');
    assert.equal(activities[1]?.['target_role'], 'challenger');
    assert.equal(activities[1]?.['round'], 1);
    assert.equal(activities[2]?.['target_role'], 'author');
    for (const activity of activities) {
      assert.equal(activity['procedural_disposition'], 'COMPLETED');
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A2 — champs non applicables : structurellement absents, jamais nuls
// --------------------------------------------------------------------------

test('A2 · un champ non applicable est absent, et jamais rendu nul', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const send = evt({
        actor: 'human',
        type: 'human_message',
        target_expert_slot_id: 'challenger',
        session_id: SESSION.challenger,
      });
      return [...init, send];
    });
    await writeRun(h, { events });

    const { doc, raw } = await read(h);
    const activities = doc.activities ?? [];

    const runStart = activities.find((a) => a['activity_kind'] === 'RUN_START') ?? {};
    for (const absent of ['source_role', 'target_role', 'round']) {
      assert.ok(!(absent in runStart), `RUN_START ne porte pas ${absent}`);
    }

    const humanSend = activities.find((a) => a['activity_kind'] === 'HUMAN_SEND') ?? {};
    for (const absent of ['source_role', 'round']) {
      assert.ok(!(absent in humanSend), `HUMAN_SEND ne porte pas ${absent}`);
    }

    assert.ok(!raw.includes('null'), 'aucune clé n’est rendue nulle');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A3 — histoire absente ≠ histoire vide
//
// Deux classes SÉPARÉES, et l'une ne prouve pas l'autre.
//
//   niveau représentation   `AVAILABLE` + `activities: []` reste une forme
//                           machine exacte de la v1
//   projection de run réel  un run natif résolu dont la base autoritative de
//                           création manque rend `UNAVAILABLE`
// --------------------------------------------------------------------------

test('A3a · REPRÉSENTATION — AVAILABLE + activities:[] reste une forme machine exacte', () => {
  // Aucune prétention sur un run : ce test n'exerce que le sérialiseur, à qui
  // l'on remet une vue disponible ne portant aucune activité sélectionnée.
  const document = JSON.parse(
    serializeRunActivity({
      run_id: RUN,
      projection_status: 'AVAILABLE',
      activities: [],
    }),
  ) as ActivityDoc;

  assert.deepEqual(Object.keys(document).sort(), [
    'activities',
    'durable_run_activity_contract_version',
    'durable_run_activity_machine_representation_version',
    'projection_status',
    'run_id',
  ]);
  assert.equal(document.projection_status, 'AVAILABLE');
  assert.deepEqual(document.activities, []);
  assert.equal(document.durable_run_activity_contract_version, 1);
  assert.equal(document.run_id, RUN);
});

test('A3b · PROJECTION — un run natif résolu sans journal rend UNAVAILABLE', async () => {
  const h = await harness();
  try {
    // Exactement la fenêtre que `ccr start` ouvre : manifest et state écrits,
    // aucun `run_created` encore appendé.
    await writeRun(h, { events: 'absent' });
    const { code, doc } = await read(h);

    assert.equal(code, 0);
    assert.equal(doc.projection_status, 'UNAVAILABLE');
    assert.ok(!('activities' in doc), 'une histoire absente n’est pas une histoire vide');
  } finally {
    await h.dispose();
  }
});

test('A3c · PROJECTION — un journal présent mais vide rend également UNAVAILABLE', async () => {
  const h = await harness();
  try {
    await writeRun(h, { events: [] });
    const { code, doc } = await read(h);

    assert.equal(code, 0);
    assert.equal(doc.projection_status, 'UNAVAILABLE');
    assert.ok(!('activities' in doc));
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A4 — UNAVAILABLE : aucune clé `activities`
// --------------------------------------------------------------------------

test('A4 · UNAVAILABLE n’a pas de clé activities — une histoire absente n’est pas vide', async () => {
  const h = await harness();
  try {
    // Des faits existent, mais la naissance du run n'est pas journalisée :
    // l'histoire requise ne peut pas être reconstruite complètement.
    const events = journal(() => [
      evt({ actor: 'human', type: 'human_message', target_expert_slot_id: 'author' }),
    ]);
    await writeRun(h, { events });

    const { code, doc } = await read(h);
    assert.equal(code, 0);
    assert.equal(doc.projection_status, 'UNAVAILABLE');
    assert.deepEqual(Object.keys(doc).sort(), [
      'durable_run_activity_contract_version',
      'durable_run_activity_machine_representation_version',
      'projection_status',
      'run_id',
    ]);
    assert.ok(!('activities' in doc));
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A5 — PROJECTION_FAILURE : sortie 0, distincte d'un échec de commande
// --------------------------------------------------------------------------

test('A5 · PROJECTION_FAILURE sort en 0, sans clé activities', async () => {
  const h = await harness();
  try {
    await writeRun(h, { events: 'corrupt' });
    const { code, doc } = await read(h);

    assert.equal(code, 0, 'un échec de projection n’est pas un échec de commande');
    assert.equal(doc.projection_status, 'PROJECTION_FAILURE');
    assert.ok(!('activities' in doc));
  } finally {
    await h.dispose();
  }
});

test('A5b · un état canonique illisible rend aussi PROJECTION_FAILURE', async () => {
  const h = await harness();
  try {
    await writeRun(h, { events: journal(() => initializationEvents()), state: 'corrupt' });
    const { code, doc } = await read(h);
    assert.equal(code, 0);
    assert.equal(doc.projection_status, 'PROJECTION_FAILURE');
  } finally {
    await h.dispose();
  }
});

test('A6 · sortie 1 : un run introuvable ne rend aucun document', async () => {
  const h = await harness();
  try {
    const result = await cli(h, ['run-activity', 'CCR-20260905-999', '--format', 'json']);
    assert.equal(result.code, 1);
    assert.equal(result.out, '', 'aucun document machine sur stdout');
    assert.ok(!result.out.includes('projection_status'));
  } finally {
    await h.dispose();
  }
});

test('A7 · sortie 2 : format inconnu, format absent, run_id absent', async () => {
  const h = await harness();
  try {
    await writeRun(h, { events: journal(() => initializationEvents()) });

    const unknown = await cli(h, ['run-activity', RUN, '--format', 'yaml']);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.out, '');

    const missingFormat = await cli(h, ['run-activity', RUN]);
    assert.equal(missingFormat.code, 2);
    assert.equal(missingFormat.out, '');

    const missingRun = await cli(h, ['run-activity', '--format', 'json']);
    assert.equal(missingRun.code, 2);
    assert.equal(missingRun.out, '');
    assert.match(missingRun.err, /run_id/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A8 — les quatre dispositions procédurales
// --------------------------------------------------------------------------

test('A8a · IN_PROGRESS : engagé durablement, canoniquement non résolu', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      const started = evt({
        actor: 'system',
        type: 'round_started',
        round: 1,
        target_expert_slot_id: 'challenger',
        based_on: [authorAnswer],
      });
      const prompt = evt({
        actor: 'system',
        type: 'prompt_sent',
        round: 1,
        target_expert_slot_id: 'challenger',
        session_id: SESSION.challenger,
        based_on: [authorAnswer],
      });
      return [...init, started, prompt];
    });
    await writeRun(h, { events, state: { round: 1, state: 'WAITING_AGENT' } });

    const { doc } = await read(h);
    const step = (doc.activities ?? []).find((a) => a['activity_kind'] === 'NATIVE_STEP');
    assert.equal(step?.['procedural_disposition'], 'IN_PROGRESS');
    assert.equal(step?.['source_role'], 'author', 'la source vient de la provenance journalisée');
    assert.equal(step?.['target_role'], 'challenger');
  } finally {
    await h.dispose();
  }
});

test('A8b · NOT_COMPLETED : résolution terminale sans complétion normale', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      const started = evt({
        actor: 'system',
        type: 'round_started',
        round: 1,
        target_expert_slot_id: 'challenger',
        based_on: [authorAnswer],
      });
      const blocked = evt({
        actor: 'system',
        type: 'transfer_blocked',
        round: 1,
        source_slot_id: 'author',
        target_slot_id: 'challenger',
        source_event_id: authorAnswer,
        reason: 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
        based_on: [started['event_id']],
      });
      return [...init, started, blocked];
    });
    await writeRun(h, { events, state: { round: 1, state: 'WAITING_HUMAN', control: 'HUMAN' } });

    const { doc, raw } = await read(h);
    const step = (doc.activities ?? []).find((a) => a['activity_kind'] === 'NATIVE_STEP');
    assert.equal(step?.['procedural_disposition'], 'NOT_COMPLETED');
    // Aucune raison détaillée n'est importée dans F2.
    assert.ok(!raw.includes('PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER'));
    assert.ok(!raw.includes('NATIVE_PROCESS_FAILED'));
    assert.ok(!raw.includes('reason'));
  } finally {
    await h.dispose();
  }
});

test('A8c · UNCERTAIN : engagement durablement irrésolvable', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      const started = evt({
        actor: 'system',
        type: 'round_started',
        round: 1,
        target_expert_slot_id: 'challenger',
        based_on: [authorAnswer],
      });
      const quarantined = evt({
        actor: 'human',
        type: 'transfer_uncertainty_acknowledged',
        round: 1,
        source_slot_id: 'author',
        target_slot_id: 'challenger',
        source_event_id: authorAnswer,
        reason: 'IN_FLIGHT_UNCERTAIN',
        based_on: [started['event_id']],
      });
      return [...init, started, quarantined];
    });
    await writeRun(h, { events, state: { round: 1, state: 'WAITING_HUMAN', control: 'HUMAN' } });

    const { doc } = await read(h);
    const step = (doc.activities ?? []).find((a) => a['activity_kind'] === 'NATIVE_STEP');
    assert.equal(step?.['procedural_disposition'], 'UNCERTAIN');
    // Le démarrage, lui, reste achevé : les dispositions ne se contaminent pas.
    const start = (doc.activities ?? []).find((a) => a['activity_kind'] === 'RUN_START');
    assert.equal(start?.['procedural_disposition'], 'COMPLETED');
  } finally {
    await h.dispose();
  }
});

test('A8d · COMPLETED n’affirme rien du fond, et RUN_START suit sa propre frontière', async () => {
  const h = await harness();
  try {
    // Initialisation interrompue : une seule session liée, état terminal.
    const events = journal(() => {
      const created = evt({ actor: 'system', type: 'run_created' });
      const prompt = evt({ actor: 'human', type: 'prompt_sent', target_expert_slot_id: 'author' });
      return [created, prompt];
    });
    await writeRun(h, { events, state: { state: 'FAILED_INITIALIZATION', control: 'HUMAN' } });

    const { doc } = await read(h);
    assert.equal(doc.projection_status, 'AVAILABLE');
    assert.equal((doc.activities ?? []).length, 1);
    assert.equal(doc.activities?.[0]?.['activity_kind'], 'RUN_START');
    assert.equal(doc.activities?.[0]?.['procedural_disposition'], 'NOT_COMPLETED');
  } finally {
    await h.dispose();
  }
});

test('A8e · une incertitude canonique du run domine une activité non résolue', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const created = evt({ actor: 'system', type: 'run_created' });
      const prompt = evt({ actor: 'human', type: 'prompt_sent', target_expert_slot_id: 'author' });
      return [created, prompt];
    });
    await writeRun(h, {
      events,
      state: {
        state: 'RECOVERY_REQUIRED',
        control: 'HUMAN',
        uncertainty: {
          reason: 'IN_FLIGHT_UNCERTAIN',
          since: AT,
          expert_slot: 'author',
          last_event_id: 'evt_000002',
        },
      },
    });

    const { doc } = await read(h);
    assert.equal(doc.activities?.[0]?.['procedural_disposition'], 'UNCERTAIN');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A9 — identité publique
// --------------------------------------------------------------------------

test('A9 · activity_id : opaque, stable, unique, jamais un identifiant interne', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      const round1 = completedRound(1, 'author', 'challenger', authorAnswer);
      const challengerAnswer = round1[2]?.['event_id'] as string;
      const round2 = completedRound(2, 'challenger', 'author', challengerAnswer);
      const send = evt({
        actor: 'human',
        type: 'human_message',
        round: 2,
        target_expert_slot_id: 'author',
        session_id: SESSION.author,
      });
      return [...init, ...round1, ...round2, send];
    });
    await writeRun(h, { events, state: { round: 2 } });

    const first = await read(h);
    const second = await read(h);

    const ids = (first.doc.activities ?? []).map((a) => a['activity_id'] as string);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, 'quatre activités logiques, quatre identités');

    // Stabilité entre deux lectures successives du même run.
    assert.deepEqual(
      (second.doc.activities ?? []).map((a) => a['activity_id']),
      ids,
    );

    for (const id of ids) {
      assert.match(id, /^act_[0-9a-f]{24}$/, 'identité opaque');
      assert.ok(!id.startsWith('evt_'), 'jamais un identifiant d’événement interne');
      assert.ok(!id.startsWith('inv_'), 'jamais un identifiant d’invocation');
      assert.ok(!/^S[12]$/.test(id), 'jamais un identifiant de session fournisseur');
    }

    // Et aucun identifiant interne ne figure dans le document.
    for (const forbidden of ['evt_', 'inv_', 'S1', 'S2', 'claude', 'codex', 'session']) {
      assert.ok(!first.raw.includes(forbidden), `identifiant interne exposé : ${forbidden}`);
    }
  } finally {
    await h.dispose();
  }
});

test('A9b · deux runs ne partagent aucune identité d’activité', async () => {
  const h = await harness();
  try {
    await writeRun(h, { events: journal(() => initializationEvents()) });
    await writeRun(h, {
      runId: 'CCR-20260905-002',
      events: journal(() =>
        initializationEvents().map((event) => ({ ...event, run_id: 'CCR-20260905-002' })),
      ),
    });

    const a = await read(h, RUN);
    const b = await read(h, 'CCR-20260905-002');
    assert.notEqual(a.doc.activities?.[0]?.['activity_id'], b.doc.activities?.[0]?.['activity_id']);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A10 — ordre durable public
// --------------------------------------------------------------------------

test('A10 · sequence : entier positif, unique, croissant, stable, sans sémantique de trou', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      const round1 = completedRound(1, 'author', 'challenger', authorAnswer);
      const challengerAnswer = round1[2]?.['event_id'] as string;
      const round2 = completedRound(2, 'challenger', 'author', challengerAnswer);
      return [...init, ...round1, ...round2];
    });
    await writeRun(h, { events, state: { round: 2 } });

    const first = await read(h);
    const sequences = (first.doc.activities ?? []).map((a) => a['sequence'] as number);

    for (const value of sequences) {
      assert.ok(Number.isInteger(value) && value > 0, 'entier positif');
    }
    assert.equal(new Set(sequences).size, sequences.length, 'unique dans le run');
    assert.deepEqual(sequences, [...sequences].sort((x, y) => x - y), 'sérialisé en ordre croissant');

    // Autorité d'ordre : le premier engagé porte la plus petite valeur.
    const kinds = (first.doc.activities ?? []).map((a) => a['activity_kind']);
    assert.equal(kinds[0], 'RUN_START');
    assert.equal((first.doc.activities ?? [])[0]?.['sequence'], Math.min(...sequences));

    // Des trous existent, et ne portent rien : les valeurs ne sont pas
    // consécutives, et ne sont donc pas un décalage interne.
    const consecutive = sequences.every((value, index) => value === index + 1);
    assert.ok(!consecutive, 'la séquence n’est pas un index de tableau');

    // Stable d'une lecture à l'autre.
    const second = await read(h);
    assert.deepEqual((second.doc.activities ?? []).map((a) => a['sequence']), sequences);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A11 — une activité logique agrège plusieurs faits durables
// --------------------------------------------------------------------------

test('A11 · une reprise du même round rejoint la MÊME activité logique', async () => {
  const h = await harness();
  try {
    const withoutRetry = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      const started = evt({
        actor: 'system',
        type: 'round_started',
        round: 1,
        target_expert_slot_id: 'challenger',
        based_on: [authorAnswer],
      });
      const aborted = evt({
        actor: 'system',
        type: 'transfer_aborted_before_provider',
        round: 1,
        source_slot_id: 'author',
        target_slot_id: 'challenger',
        source_event_id: authorAnswer,
        reason: 'PRE_PROVIDER_ABORTED',
        based_on: [started['event_id']],
      });
      return [...init, started, aborted];
    });
    await writeRun(h, { events: withoutRetry, state: { round: 1 } });
    const before = await read(h);
    const abortedStep = (before.doc.activities ?? []).find((a) => a['activity_kind'] === 'NATIVE_STEP');
    assert.equal(abortedStep?.['procedural_disposition'], 'NOT_COMPLETED');

    // Même journal, plus une reprise aboutie du même round.
    const withRetry = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      const started = evt({
        actor: 'system',
        type: 'round_started',
        round: 1,
        target_expert_slot_id: 'challenger',
        based_on: [authorAnswer],
      });
      const aborted = evt({
        actor: 'system',
        type: 'transfer_aborted_before_provider',
        round: 1,
        source_slot_id: 'author',
        target_slot_id: 'challenger',
        source_event_id: authorAnswer,
        reason: 'PRE_PROVIDER_ABORTED',
        based_on: [started['event_id']],
      });
      const retry = completedRound(1, 'author', 'challenger', authorAnswer);
      return [...init, started, aborted, ...retry];
    });
    const h2 = await harness();
    try {
      await writeRun(h2, { events: withRetry, state: { round: 1 } });
      const after = await read(h2);

      const steps = (after.doc.activities ?? []).filter((a) => a['activity_kind'] === 'NATIVE_STEP');
      assert.equal(steps.length, 1, 'une tentative et sa reprise ne font qu’une activité');
      assert.equal(steps[0]?.['procedural_disposition'], 'COMPLETED');
      // Identité conservée : la reprise n'a pas créé une seconde identité.
      assert.equal(steps[0]?.['activity_id'], abortedStep?.['activity_id']);
      assert.equal(steps[0]?.['sequence'], abortedStep?.['sequence']);
    } finally {
      await h2.dispose();
    }
  } finally {
    await h.dispose();
  }
});

test('A12 · un envoi humain n’acquiert aucun round et ne déplace pas l’alternance', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      const round1 = completedRound(1, 'author', 'challenger', authorAnswer);
      const challengerAnswer = round1[2]?.['event_id'] as string;
      // Deux envois humains AU MILIEU du run, sans consommer de round.
      const sendA = evt({
        actor: 'human',
        type: 'human_message',
        round: 1,
        target_expert_slot_id: 'author',
        session_id: SESSION.author,
      });
      const answerA = evt({
        actor: 'expert',
        type: 'assistant_response',
        round: 1,
        expert_slot_id: 'author',
        session_id: SESSION.author,
        based_on: [sendA['event_id']],
        exit_code: 0,
      });
      // Puis l'alternance reprend exactement où elle en était.
      const round2 = completedRound(2, 'challenger', 'author', challengerAnswer);
      return [...init, ...round1, sendA, answerA, ...round2];
    });
    await writeRun(h, { events, state: { round: 2 } });

    const { doc } = await read(h);
    const activities = doc.activities ?? [];

    const send = activities.find((a) => a['activity_kind'] === 'HUMAN_SEND') ?? {};
    assert.ok(!('round' in send), 'un envoi humain ne porte aucun round');
    assert.ok(!('source_role' in send), 'un envoi humain n’a pas de source');

    const steps = activities.filter((a) => a['activity_kind'] === 'NATIVE_STEP');
    assert.deepEqual(steps.map((s) => s['round']), [1, 2]);
    // L'alternance n'a pas bougé : round 2 part bien du challenger.
    assert.equal(steps[1]?.['source_role'], 'challenger');
    assert.equal(steps[1]?.['target_role'], 'author');

    // Et l'envoi s'intercale dans l'ordre durable, entre les deux rounds.
    const order = activities.map((a) => a['activity_kind']);
    assert.deepEqual(order, ['RUN_START', 'NATIVE_STEP', 'HUMAN_SEND', 'NATIVE_STEP']);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A13 — jamais de devinette
// --------------------------------------------------------------------------

test('A13 · un rôle source non établissable rend UNAVAILABLE, jamais un rôle deviné', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const started = evt({
        actor: 'system',
        type: 'round_started',
        round: 1,
        target_expert_slot_id: 'challenger',
        // Provenance pendante : rien ne dit de quel expert ce transfert part.
        based_on: ['evt_000999'],
      });
      return [...init, started];
    });
    await writeRun(h, { events, state: { round: 1 } });

    const { code, doc } = await read(h);
    assert.equal(code, 0);
    assert.equal(doc.projection_status, 'UNAVAILABLE');
    assert.ok(!('activities' in doc), 'aucune reconstruction partielle');
  } finally {
    await h.dispose();
  }
});

test('A14 · une reconstruction partielle n’est jamais rendue AVAILABLE', async () => {
  const h = await harness();
  try {
    // Une réponse d'expert sans provenance : impossible de savoir ce qu'elle clôt.
    const events = journal(() => {
      const init = initializationEvents();
      const orphan = evt({
        actor: 'expert',
        type: 'assistant_response',
        expert_slot_id: 'author',
        session_id: SESSION.author,
        exit_code: 0,
      });
      return [...init, orphan];
    });
    await writeRun(h, { events });

    const { doc } = await read(h);
    assert.equal(doc.projection_status, 'UNAVAILABLE');
    assert.ok(!('activities' in doc));
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A15 — historique : applicabilité et suffisance
// --------------------------------------------------------------------------

test('A15 · un run historique, dont les rôles ne sont pas enregistrés, rend UNAVAILABLE', async () => {
  const h = await harness();
  try {
    await writeRun(h, { manifest: 'legacy', events: 'absent', state: 'absent' });
    const { code, doc } = await read(h);

    assert.equal(code, 0);
    assert.equal(doc.projection_status, 'UNAVAILABLE');
    assert.ok(!('activities' in doc));
    // Et surtout, aucun fournisseur n'a été promu en rôle.
    assert.ok(!doc_includes(doc, 'claude'));
    assert.ok(!doc_includes(doc, 'codex'));
  } finally {
    await h.dispose();
  }
});

test('A16 · un run natif antérieur, dont le journal suffit, rend AVAILABLE', async () => {
  const h = await harness();
  try {
    // Journal tel qu'une version antérieure de CCR l'a écrit : aucun champ
    // n'a été ajouté pour F2, et l'histoire est pourtant reconstructible.
    const events = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      return [...init, ...completedRound(1, 'author', 'challenger', authorAnswer)];
    });
    await writeRun(h, { events, state: { round: 1 } });

    const { doc } = await read(h);
    assert.equal(doc.projection_status, 'AVAILABLE');
    assert.deepEqual(
      (doc.activities ?? []).map((a) => a['activity_kind']),
      ['RUN_START', 'NATIVE_STEP'],
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// A17 — discipline stdout, et aucun champ hors contrat
// --------------------------------------------------------------------------

test('A17 · un seul document JSON sur stdout, sans champ hors contrat', async () => {
  const h = await harness();
  try {
    const events = journal(() => {
      const init = initializationEvents();
      const authorAnswer = init[2]?.['event_id'] as string;
      return [...init, ...completedRound(1, 'author', 'challenger', authorAnswer)];
    });
    await writeRun(h, { events, state: { round: 1 } });

    const result = await cli(h, ['run-activity', RUN, '--format', 'json']);
    assert.equal(result.code, 0);
    const doc = JSON.parse(result.out);
    assert.equal(result.out.trim(), JSON.stringify(doc, null, 2));

    for (const forbidden of [
      '"state"',
      'created_at',
      'workspace',
      'provider',
      '"session"',
      'session_id',
      'timestamp',
      '"reason"',
      'message',
      'metadata',
      'invocation_id',
      'event_id',
      'based_on',
      'exit_code',
      'content',
      AT,
    ]) {
      assert.ok(!result.out.includes(forbidden), `champ hors contrat exposé : ${forbidden}`);
    }
  } finally {
    await h.dispose();
  }
});

function doc_includes(doc: ActivityDoc, needle: string): boolean {
  return JSON.stringify(doc).includes(needle);
}

// --------------------------------------------------------------------------
// A18 — unicité NORMATIVE de `activity_id`
//
// La garantie ne peut pas se prouver en cherchant une collision de SHA-256.
// Elle se prouve en forçant, par une couture interne, deux activités logiques
// distinctes à recevoir la même identité candidate, et en vérifiant que le
// document entier est refusé.
// --------------------------------------------------------------------------

/** Journal à quatre activités logiques : démarrage, deux rounds, un envoi. */
function fourActivityJournal(): readonly NativeCcrEvent[] {
  const events = journal(() => {
    const init = initializationEvents();
    const authorAnswer = init[2]?.['event_id'] as string;
    const round1 = completedRound(1, 'author', 'challenger', authorAnswer);
    const challengerAnswer = round1[2]?.['event_id'] as string;
    const round2 = completedRound(2, 'challenger', 'author', challengerAnswer);
    const send = evt({
      actor: 'human',
      type: 'human_message',
      round: 2,
      target_expert_slot_id: 'author',
      session_id: SESSION.author,
    });
    return [...init, ...round1, ...round2, send];
  });
  return events as unknown as readonly NativeCcrEvent[];
}

const READY_STATE = {
  schema_version: 3,
  run_id: RUN,
  state: 'READY',
  control: 'AUTOMATION',
  round: 2,
  active_expert_slot: null,
  next_step_source_slot: 'author',
  last_event_id: null,
  pending_operation: null,
  uncertainty: null,
  updated_at: AT,
} as unknown as NativeRunStateDocument;

test('A18a · sans couture, la projection est disponible, ses identités stables et uniques', () => {
  const events = fourActivityJournal();

  const first = projectRunActivity(RUN, READY_STATE, events);
  const second = projectRunActivity(RUN, READY_STATE, events);

  assert.equal(first.status, 'AVAILABLE');
  assert.equal(second.status, 'AVAILABLE');
  if (first.status !== 'AVAILABLE' || second.status !== 'AVAILABLE') return;

  const ids = first.activities.map((a) => a.activity_id);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4, 'quatre activités logiques, quatre identités');
  assert.deepEqual(
    second.activities.map((a) => a.activity_id),
    ids,
    'identités stables entre deux observations',
  );
});

test('A18b · une couture qui reste injective ne change rien à la sémantique', () => {
  const projected = projectRunActivity(RUN, READY_STATE, fourActivityJournal(), {
    deriveActivityId: (_runId, logicalKey) => `act_distinct_${logicalKey}`,
  });

  assert.equal(projected.status, 'AVAILABLE');
  if (projected.status !== 'AVAILABLE') return;
  assert.equal(new Set(projected.activities.map((a) => a.activity_id)).size, 4);
});

test('A18c · collision forcée entre DEUX activités logiques distinctes → PROJECTION_FAILURE', () => {
  // La collision est placée entre la TROISIÈME et la QUATRIÈME activité : le
  // contrôle porte sur toutes les activités du document, pas sur une paire
  // particulière ni sur deux variantes particulières.
  const projected = projectRunActivity(RUN, READY_STATE, fourActivityJournal(), {
    deriveActivityId: (_runId, logicalKey) =>
      logicalKey === 'NATIVE_STEP:2' || logicalKey === 'HUMAN_SEND:1'
        ? 'act_collision'
        : `act_distinct_${logicalKey}`,
  });

  assert.equal(projected.status, 'PROJECTION_FAILURE');
  assert.ok(!('activities' in projected), 'aucune liste d’activités n’est produite');
});

test('A18d · une collision entre les DEUX PREMIÈRES activités est refusée de la même façon', () => {
  const projected = projectRunActivity(RUN, READY_STATE, fourActivityJournal(), {
    deriveActivityId: (_runId, logicalKey) =>
      logicalKey === 'RUN_START' || logicalKey === 'NATIVE_STEP:1'
        ? 'act_collision'
        : `act_distinct_${logicalKey}`,
  });

  assert.equal(projected.status, 'PROJECTION_FAILURE');
});

test('A18e · le document rendu pour une collision est celui d’un PROJECTION_FAILURE, sans activities', () => {
  const projected = projectRunActivity(RUN, READY_STATE, fourActivityJournal(), {
    deriveActivityId: () => 'act_collision',
  });
  assert.equal(projected.status, 'PROJECTION_FAILURE');
  if (projected.status !== 'PROJECTION_FAILURE') return;

  const document = JSON.parse(
    serializeRunActivity({ run_id: RUN, projection_status: projected.status }),
  ) as ActivityDoc;

  assert.deepEqual(Object.keys(document).sort(), [
    'durable_run_activity_contract_version',
    'durable_run_activity_machine_representation_version',
    'projection_status',
    'run_id',
  ]);
  assert.equal(document.projection_status, 'PROJECTION_FAILURE');
  assert.ok(!('activities' in document));
  // Rien de la clé logique, ni de l'identité en collision, ne transparaît.
  assert.ok(!JSON.stringify(document).includes('act_collision'));
  assert.ok(!JSON.stringify(document).includes('NATIVE_STEP'));
});

test('A18f · un PROJECTION_FAILURE traverse la CLI en sortie 0, sans activities', async () => {
  // Le transport d'un `PROJECTION_FAILURE` est prouvé de bout en bout par un
  // chemin de production réel — la couture ne franchit jamais la CLI.
  const h = await harness();
  try {
    await writeRun(h, { events: journal(() => initializationEvents()), state: 'corrupt' });
    const result = await cli(h, ['run-activity', RUN, '--format', 'json']);
    const doc = JSON.parse(result.out) as ActivityDoc;

    assert.equal(result.code, 0);
    assert.equal(doc.projection_status, 'PROJECTION_FAILURE');
    assert.ok(!('activities' in doc));
  } finally {
    await h.dispose();
  }
});
