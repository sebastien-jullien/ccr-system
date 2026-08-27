/**
 * Tests unitaires des journaux append-only (spécification V1, §12, §17, §42).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';

import { openEventStore } from '../../src/store/event-store.ts';
import { openDecisionStore } from '../../src/store/decision-store.ts';
import { createRunDirectory } from '../../src/store/state-store.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const NOW = new Date(2026, 7, 7, 17, 50, 0);

// --------------------------------------------------------------------------
// Journal d'événements
// --------------------------------------------------------------------------

test('les identifiants d\'événement sont attribués par CCR et strictement croissants', async () => {
  const runsDir = await makeTempDir('ccr-events-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const store = await openEventStore(paths, paths.runId);

    assert.equal(store.lastEventId(), null);

    const first = await store.append({ round: 0, actor: 'system', type: 'run_created' });
    const second = await store.append({ round: 0, actor: 'system', type: 'session_created', target: 'codex' });

    assert.equal(first.event_id, 'evt_000001');
    assert.equal(second.event_id, 'evt_000002');
    assert.equal(first.run_id, paths.runId);
    assert.ok(Date.parse(first.timestamp) > 0);
    assert.equal(store.lastEventId(), 'evt_000002');
  } finally {
    await removeTempDir(runsDir);
  }
});

test('la numérotation reprend depuis le journal après un redémarrage de CCR', async () => {
  const runsDir = await makeTempDir('ccr-events-restart-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);

    const before = await openEventStore(paths, paths.runId);
    await before.append({ round: 0, actor: 'system', type: 'run_created' });
    await before.append({ round: 1, actor: 'human', type: 'human_message', content: 'bonjour' });

    // Nouveau processus : plus rien en mémoire, la vérité est dans le fichier.
    const after = await openEventStore(paths, paths.runId);
    assert.equal(after.lastEventId(), 'evt_000002');
    assert.equal(after.nextSequence(), 3);

    const third = await after.append({ round: 1, actor: 'claude', type: 'assistant_response', content: 'ok' });
    assert.equal(third.event_id, 'evt_000003');
    assert.equal((await after.readAll()).length, 3);
  } finally {
    await removeTempDir(runsDir);
  }
});

test('le contenu transmis est journalisé intégralement, sans résumé', async () => {
  const runsDir = await makeTempDir('ccr-events-content-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const store = await openEventStore(paths, paths.runId);

    const long = `Analyse contradictoire\n${'détail '.repeat(5_000)}fin`;
    await store.append({ round: 2, actor: 'codex', type: 'assistant_response', content: long });

    const [event] = await store.readAll();
    assert.equal(event?.content, long);
  } finally {
    await removeTempDir(runsDir);
  }
});

test('la provenance d\'un message transmis est conservée', async () => {
  const runsDir = await makeTempDir('ccr-events-provenance-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const store = await openEventStore(paths, paths.runId);

    const source = await store.append({ round: 1, actor: 'claude', type: 'assistant_response', content: 'position A' });
    const transferred = await store.append({
      round: 1,
      actor: 'system',
      type: 'prompt_sent',
      target: 'codex',
      content: 'position A (transmise)',
      based_on: [source.event_id],
    });

    assert.deepEqual(transferred.based_on, ['evt_000001']);
    assert.equal(transferred.actor, 'system');
    assert.equal(transferred.target, 'codex');
  } finally {
    await removeTempDir(runsDir);
  }
});

test('une correction crée un nouvel événement et ne réécrit pas l\'histoire', async () => {
  const runsDir = await makeTempDir('ccr-events-correction-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const store = await openEventStore(paths, paths.runId);

    await store.append({ round: 1, actor: 'codex', type: 'assistant_response', content: 'affirmation erronée' });
    const snapshot = await readFile(paths.events, 'utf8');

    await store.append({
      round: 1,
      actor: 'codex',
      type: 'assistant_response',
      content: 'rétractation',
      based_on: ['evt_000001'],
    });

    const after = await readFile(paths.events, 'utf8');
    assert.ok(after.startsWith(snapshot), 'la ligne initiale est intacte');
    const events = await store.readAll();
    assert.equal(events.length, 2);
    assert.equal(events[0]?.content, 'affirmation erronée');
  } finally {
    await removeTempDir(runsDir);
  }
});

test('un journal corrompu est signalé, jamais ignoré silencieusement', async () => {
  const runsDir = await makeTempDir('ccr-events-broken-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const store = await openEventStore(paths, paths.runId);
    await store.append({ round: 0, actor: 'system', type: 'run_created' });
    await appendFile(paths.events, '{"event_id":"evt_0000\n', 'utf8');

    await assert.rejects(
      openEventStore(paths, paths.runId),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});

test('une séquence non croissante est refusée', async () => {
  const runsDir = await makeTempDir('ccr-events-seq-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    await writeFile(
      paths.events,
      [
        JSON.stringify({ event_id: 'evt_000002', run_id: paths.runId, round: 0, timestamp: NOW.toISOString(), actor: 'system', type: 'run_created' }),
        JSON.stringify({ event_id: 'evt_000001', run_id: paths.runId, round: 0, timestamp: NOW.toISOString(), actor: 'system', type: 'run_created' }),
        '',
      ].join('\n'),
      'utf8',
    );

    await assert.rejects(
      openEventStore(paths, paths.runId),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});

test('un acteur ou un type inconnu est refusé', async () => {
  const runsDir = await makeTempDir('ccr-events-actor-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    await writeFile(
      paths.events,
      `${JSON.stringify({ event_id: 'evt_000001', run_id: paths.runId, round: 0, timestamp: NOW.toISOString(), actor: 'gemini', type: 'run_created' })}\n`,
      'utf8',
    );

    await assert.rejects(
      openEventStore(paths, paths.runId),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});

// --------------------------------------------------------------------------
// Journal de décisions
// --------------------------------------------------------------------------

test('une décision humaine est conservée dans l\'état canonique CCR', async () => {
  const runsDir = await makeTempDir('ccr-decisions-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const store = await openDecisionStore(paths, paths.runId);

    const decision = await store.append({
      round: 4,
      author: 'human',
      status: 'ACTIVE',
      content: 'Les seeds ne constituent pas une source de doctrine produit.',
    });

    assert.equal(decision.decision_id, 'DEC-0001');
    assert.equal(decision.run_id, paths.runId);
    assert.equal(decision.status, 'ACTIVE');
    assert.equal(decision.round, 4);

    const second = await store.append({ round: 5, author: 'human', status: 'ACTIVE', content: 'Deuxième décision.' });
    assert.equal(second.decision_id, 'DEC-0002');
  } finally {
    await removeTempDir(runsDir);
  }
});

test('la numérotation des décisions reprend après redémarrage', async () => {
  const runsDir = await makeTempDir('ccr-decisions-restart-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const before = await openDecisionStore(paths, paths.runId);
    await before.append({ round: 1, author: 'human', status: 'ACTIVE', content: 'A' });

    const after = await openDecisionStore(paths, paths.runId);
    assert.equal(after.lastDecisionId(), 'DEC-0001');
    const next = await after.append({ round: 2, author: 'human', status: 'ACTIVE', content: 'B' });
    assert.equal(next.decision_id, 'DEC-0002');
    assert.equal((await after.readAll()).length, 2);
  } finally {
    await removeTempDir(runsDir);
  }
});

test('une décision vide est refusée', async () => {
  const runsDir = await makeTempDir('ccr-decisions-empty-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    await writeFile(
      paths.decisions,
      `${JSON.stringify({ decision_id: 'DEC-0001', run_id: paths.runId, round: 0, timestamp: NOW.toISOString(), author: 'human', status: 'ACTIVE', content: '' })}\n`,
      'utf8',
    );

    await assert.rejects(
      openDecisionStore(paths, paths.runId),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});
