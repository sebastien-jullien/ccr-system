/**
 * Fraîcheur de contenu — R2a et R2b.
 *
 * Modèle temporel : un tic = une opération achevée. Une écriture s'achève au tic
 * `t`, la lecture suivante a lieu au tic `t+1`. Borne de péremption de contenu :
 * 0 opération achevée après validation — la première lecture pertinente
 * postérieure reflète déjà l'écriture.
 *
 * Les deux transitions comptent, et l'invalidation ne doit inspecter ni ce que
 * l'entrée contenait, ni la direction du changement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FACETS,
  OP_CONTENT_MEMBERSHIP,
  PRIVATE_LABEL,
  QUERIES,
  TOPICS,
} from '../src/constants.mjs';
import { buildInitialState } from '../src/state.mjs';
import { referenceRead } from '../src/reference.mjs';
import { createS1 } from '../src/strategies/s1.mjs';
import { createS2 } from '../src/strategies/s2.mjs';
import { createS3 } from '../src/strategies/s3.mjs';

const FACTORIES = [['S1', createS1], ['S2', createS2], ['S3', createS3]];

function indexOfQuery(topic, facet) {
  return QUERIES.findIndex((q) => q.topic === topic && q.facet === facet);
}

/** Écriture de contenu d'appartenance : change exactement le topic. */
function rewriteTopic(document, topic) {
  document.tokens[0] = topic;
  document.body = document.tokens.join(' ');
  document.content_version += 1;
}

test('T-content-new-match — non apparié → apparié, pour les trois stratégies', () => {
  for (const [name, factory] of FACTORIES) {
    const state = buildInitialState(4, 40);
    const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
    const label = document.labels[0];
    const authorizedViewer = state.viewers.find(
      (v) => v.id !== document.owner && v.grantSet.has(label),
    );
    const unauthorizedViewer = state.viewers.find(
      (v) => v.id !== document.owner && !v.grantSet.has(label),
    );

    // Requête cible : celle que le document N'apparie PAS encore.
    const currentTopic = document.tokens[0];
    const otherTopic = TOPICS.find((t) => t !== currentTopic);
    const facet = document.tokens[1];
    const queryIndex = indexOfQuery(otherTopic, facet);
    const query = QUERIES[queryIndex];

    const strategy = factory(state);
    const warmA = strategy.read(authorizedViewer.id, query, queryIndex);
    const warmU = strategy.read(unauthorizedViewer.id, query, queryIndex);
    assert.ok(!warmA.includes(document.id), `${name} · absent avant (autorisé)`);
    assert.ok(!warmU.includes(document.id), `${name} · absent avant (non autorisé)`);

    // Tic t — l'écriture s'achève.
    rewriteTopic(document, otherTopic);
    strategy.onMutation({ kind: OP_CONTENT_MEMBERSHIP, document, dimension: 'topic' });

    // Tic t+1 — première lecture pertinente.
    const afterA = strategy.read(authorizedViewer.id, query, queryIndex);
    const afterU = strategy.read(unauthorizedViewer.id, query, queryIndex);

    assert.deepEqual(afterA, referenceRead(state, authorizedViewer.id, query), `${name} · oracle A`);
    assert.deepEqual(afterU, referenceRead(state, unauthorizedViewer.id, query), `${name} · oracle U`);
    assert.ok(afterA.includes(document.id), `${name} · l'autorisé voit le nouvel apparié`);
    assert.ok(!afterU.includes(document.id), `${name} · le non autorisé ne le voit toujours pas`);
  }
});

test('T-content-lost-match — apparié → non apparié, pour les trois stratégies', () => {
  for (const [name, factory] of FACTORIES) {
    const state = buildInitialState(4, 40);
    const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
    const label = document.labels[0];
    const authorizedViewer = state.viewers.find(
      (v) => v.id !== document.owner && v.grantSet.has(label),
    );
    const unauthorizedViewer = state.viewers.find(
      (v) => v.id !== document.owner && !v.grantSet.has(label),
    );

    const currentTopic = document.tokens[0];
    const facet = document.tokens[1];
    const queryIndex = indexOfQuery(currentTopic, facet);
    const query = QUERIES[queryIndex];

    const strategy = factory(state);
    const warmA = strategy.read(authorizedViewer.id, query, queryIndex);
    const warmU = strategy.read(unauthorizedViewer.id, query, queryIndex);
    assert.ok(warmA.includes(document.id), `${name} · présent avant (autorisé)`);
    assert.ok(!warmU.includes(document.id), `${name} · absent avant (non autorisé)`);

    rewriteTopic(document, TOPICS.find((t) => t !== currentTopic));
    strategy.onMutation({ kind: OP_CONTENT_MEMBERSHIP, document, dimension: 'topic' });

    const afterA = strategy.read(authorizedViewer.id, query, queryIndex);
    const afterU = strategy.read(unauthorizedViewer.id, query, queryIndex);

    assert.deepEqual(afterA, referenceRead(state, authorizedViewer.id, query), `${name} · oracle A`);
    assert.deepEqual(afterU, referenceRead(state, unauthorizedViewer.id, query), `${name} · oracle U`);
    assert.ok(!afterA.includes(document.id), `${name} · l'autorisé ne le voit plus`);
    assert.ok(!afterU.includes(document.id), `${name} · le non autorisé ne le voit toujours pas`);
  }
});

test('R2a — le rédacteur observe son écriture à sa lecture suivante', () => {
  for (const [name, factory] of FACTORIES) {
    const state = buildInitialState(4, 280);
    const document = state.documents.find((d) => d.labels[0] === PRIVATE_LABEL);
    const writer = document.owner;

    const currentTopic = document.tokens[0];
    const facet = document.tokens[1];
    const otherTopic = TOPICS.find((t) => t !== currentTopic);
    const queryIndex = indexOfQuery(otherTopic, facet);
    const query = QUERIES[queryIndex];

    const strategy = factory(state);
    assert.ok(!strategy.read(writer, query, queryIndex).includes(document.id));

    rewriteTopic(document, otherTopic);
    strategy.onMutation({ kind: OP_CONTENT_MEMBERSHIP, document, dimension: 'topic' });

    const after = strategy.read(writer, query, queryIndex);
    assert.deepEqual(after, referenceRead(state, writer, query), `${name} · oracle`);
    assert.ok(after.includes(document.id), `${name} · lecture de ses propres écritures`);
  }
});

test('R2b — chaque viewer affecté et autorisé observe l\'écriture, borne 0', () => {
  for (const [name, factory] of FACTORIES) {
    const state = buildInitialState(4, 40);
    const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
    const label = document.labels[0];
    const affected = state.viewers.filter(
      (v) => v.id !== document.owner && v.grantSet.has(label),
    ).slice(0, 5);
    const unaffected = state.viewers.filter(
      (v) => v.id !== document.owner && !v.grantSet.has(label),
    ).slice(0, 5);

    const facet = document.tokens[1];
    const otherTopic = TOPICS.find((t) => t !== document.tokens[0]);
    const queryIndex = indexOfQuery(otherTopic, facet);
    const query = QUERIES[queryIndex];

    const strategy = factory(state);
    for (const viewer of [...affected, ...unaffected]) {
      strategy.read(viewer.id, query, queryIndex);
    }

    rewriteTopic(document, otherTopic);
    strategy.onMutation({ kind: OP_CONTENT_MEMBERSHIP, document, dimension: 'topic' });

    // Aucune opération n'intervient entre la validation et ces lectures.
    for (const viewer of affected) {
      const result = strategy.read(viewer.id, query, queryIndex);
      assert.deepEqual(result, referenceRead(state, viewer.id, query), `${name} · ${viewer.id}`);
      assert.ok(result.includes(document.id), `${name} · ${viewer.id} observe l'écriture`);
    }
    for (const viewer of unaffected) {
      const result = strategy.read(viewer.id, query, queryIndex);
      assert.deepEqual(result, referenceRead(state, viewer.id, query), `${name} · ${viewer.id}`);
      assert.ok(!result.includes(document.id), `${name} · ${viewer.id} reste sans visibilité`);
    }
  }
});

test('une écriture de remplisseur ne change aucune appartenance', () => {
  const state = buildInitialState(4, 40);
  const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const before = QUERIES.map((query) => referenceRead(state, document.owner, query));

  document.tokens[42] = document.tokens[42] === 'word-000' ? 'word-001' : 'word-000';
  document.body = document.tokens.join(' ');
  document.content_version += 1;

  const after = QUERIES.map((query) => referenceRead(state, document.owner, query));
  assert.deepEqual(after, before);
  assert.ok(FACETS.length === 4 && TOPICS.length === 8);
});
