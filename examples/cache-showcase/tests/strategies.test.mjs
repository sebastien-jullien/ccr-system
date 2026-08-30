/**
 * Équivalence des stratégies avec la MÊME REFERENCE non cachée.
 *
 * Toute comparaison sémantique de la fixture passe par l'oracle non caché. Une
 * stratégie n'est jamais comparée à une autre stratégie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DOCUMENT_IDS, QUERIES } from '../src/constants.mjs';
import { buildInitialState } from '../src/state.mjs';
import { referenceRead } from '../src/reference.mjs';
import { createS1 } from '../src/strategies/s1.mjs';
import { createS2 } from '../src/strategies/s2.mjs';
import { createS3 } from '../src/strategies/s3.mjs';

const FACTORIES = [['S1', createS1], ['S2', createS2], ['S3', createS3]];

function matrix(classCount, privateCount, viewerIds) {
  const state = buildInitialState(classCount, privateCount);
  for (const [name, factory] of FACTORIES) {
    const strategy = factory(state);
    for (const viewerId of viewerIds) {
      QUERIES.forEach((query, queryIndex) => {
        assert.deepEqual(
          strategy.read(viewerId, query, queryIndex),
          referenceRead(state, viewerId, query),
          `${name} · ${viewerId} · ${query.topic} ${query.facet}`,
        );
      });
    }
    // Deuxième passe : les résultats servis depuis le cache restent exacts.
    for (const viewerId of viewerIds) {
      QUERIES.forEach((query, queryIndex) => {
        assert.deepEqual(
          strategy.read(viewerId, query, queryIndex),
          referenceRead(state, viewerId, query),
          `${name} (cache chaud) · ${viewerId} · ${query.topic} ${query.facet}`,
        );
      });
    }
  }
}

test('S1, S2 et S3 égalent la REFERENCE — 4 classes, 10 %', () => {
  matrix(4, 40, ['viewer-000', 'viewer-001', 'viewer-100', 'viewer-399']);
});

test('S1, S2 et S3 égalent la REFERENCE — 40 classes, 35 %', () => {
  matrix(40, 140, ['viewer-000', 'viewer-041', 'viewer-222']);
});

test('S1, S2 et S3 égalent la REFERENCE — 400 classes, 70 %', () => {
  matrix(400, 280, ['viewer-000', 'viewer-199', 'viewer-399']);
});

test('deux viewers de grants identiques, dont un propriétaire d\'un document privé', () => {
  // Le piège central de S2 : mêmes grants n'implique pas même visibilité.
  const state = buildInitialState(4, 280);
  const groups = new Map();
  for (const viewer of state.viewers) {
    const key = viewer.grants.join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(viewer);
  }
  const peers = [...groups.values()].find((list) => list.length >= 2);
  const [a, b] = peers;

  const privateOfA = state.documents.find(
    (d) => d.owner === a.id && d.labels[0] === 'private',
  );
  assert.ok(privateOfA !== undefined, 'le viewer A doit posséder un document privé');
  const tokens = privateOfA.body.split(' ');
  const query = { topic: tokens[0], facet: tokens[1] };
  const queryIndex = QUERIES.findIndex((q) => q.topic === query.topic && q.facet === query.facet);

  for (const [name, factory] of FACTORIES) {
    const strategy = factory(state);
    // B lit en premier, ce qui peuple la région partagée sans A.
    const forB = strategy.read(b.id, query, queryIndex);
    const forA = strategy.read(a.id, query, queryIndex);
    assert.deepEqual(forB, referenceRead(state, b.id, query), `${name} · B`);
    assert.deepEqual(forA, referenceRead(state, a.id, query), `${name} · A`);
    assert.ok(forA.includes(privateOfA.id), `${name} · A doit voir son document privé`);
    assert.ok(!forB.includes(privateOfA.id), `${name} · B ne doit pas voir le privé de A`);
  }
});

test('un résultat vide est un résultat mis en cache valide', () => {
  const state = buildInitialState(4, 280);
  const strategy = createS2(state);
  // Un viewer sans document apparié doit tout de même peupler ses deux régions.
  let emptyFound = false;
  QUERIES.forEach((query, queryIndex) => {
    const result = strategy.read('viewer-000', query, queryIndex);
    if (result.length === 0) emptyFound = true;
    assert.deepEqual(result, referenceRead(state, 'viewer-000', query));
  });
  assert.ok(emptyFound, 'au moins une requête doit rendre un résultat vide');
  const residency = strategy.residency();
  assert.equal(residency.part1, QUERIES.length);
  assert.equal(residency.part2, QUERIES.length);
});

test('S3 ne dépasse jamais le nombre de documents en projections résidentes', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS3(state);
  QUERIES.forEach((query, queryIndex) => {
    strategy.read('viewer-000', query, queryIndex);
    assert.ok(strategy.residency().total <= DOCUMENT_IDS.length);
  });
  assert.equal(strategy.residency().total, DOCUMENT_IDS.length);

  // Des écritures répétées remplacent la valeur ; elles n'ajoutent aucune clé.
  for (let i = 0; i < 25; i += 1) {
    const document = state.documents[i % state.documents.length];
    document.tokens[5] = `word-${String((i * 7) % 256).padStart(3, '0')}`;
    document.body = document.tokens.join(' ');
    document.content_version += 1;
    strategy.read('viewer-001', QUERIES[0], 0);
    assert.ok(
      strategy.residency().total <= DOCUMENT_IDS.length,
      `résidence ${String(strategy.residency().total)} après ${String(i)} écritures`,
    );
  }
  assert.equal(strategy.inspect().size, DOCUMENT_IDS.length);
});

test('S2 partage réellement une région Part-1 entre viewers d\'une même classe', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS2(state);
  strategy.read('viewer-000', QUERIES[0], 0);
  const afterFirst = strategy.residency();
  // viewer-004 partage la classe de viewer-000 lorsque classCount vaut 4.
  strategy.read('viewer-004', QUERIES[0], 0);
  const afterSecond = strategy.residency();
  assert.equal(afterSecond.part1, afterFirst.part1, 'Part-1 doit être réutilisée');
  assert.equal(afterSecond.part2, afterFirst.part2 + 1, 'Part-2 reste propre au viewer');
});
