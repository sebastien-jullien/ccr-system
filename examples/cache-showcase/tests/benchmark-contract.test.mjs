/**
 * Contrat du banc d'essai — agrégation, rotation des rejeux, métadonnées
 * d'hôte, et non-réutilisation d'une projection périmée.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_REPLAY_ORDER,
  DOCUMENT_IDS,
  MEASURED_READS,
  QUERIES,
  R1_TARGET_RATIO,
  WARMUP_OPERATIONS,
} from '../src/constants.mjs';
import {
  medianOf, nearestRank, percentiles, ratioOf, sortDurations, summarize,
} from '../src/metrics.mjs';
import { buildInitialState } from '../src/state.mjs';
import { createS3 } from '../src/strategies/s3.mjs';
import { hostMetadata, replayOrderFor } from '../../cache-showcase/bench/run-bench.mjs';

test('les percentiles suivent le rang le plus proche, sans interpolation', () => {
  const values = [10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n, 100n];
  const sorted = sortDurations(values);
  // ceil(0.95 * 10) - 1 = 9 → dernière valeur.
  assert.equal(nearestRank(sorted, 0.95), 100n);
  // ceil(0.50 * 10) - 1 = 4 → cinquième valeur.
  assert.equal(nearestRank(sorted, 0.5), 50n);

  const stats = percentiles(values);
  assert.equal(stats.count, 10);
  assert.equal(stats.p50, 50n);
  assert.equal(stats.p95, 100n);
});

test('le percentile trie numériquement, jamais lexicographiquement', () => {
  const values = [2n, 10n, 9n];
  assert.deepEqual(sortDurations(values), [2n, 9n, 10n]);
  assert.equal(percentiles(values).p95, 10n);
});

test('la médiane de trois ratios prend le rang le plus proche', () => {
  assert.equal(medianOf([0.9, 0.1, 0.5]), 0.5);
  const summary = summarize([0.9, 0.1, 0.5]);
  assert.equal(summary.median, 0.5);
  assert.equal(summary.min, 0.1);
  assert.equal(summary.max, 0.9);
});

test('le ratio R1 rapporte un p95 de stratégie au p95 de la REFERENCE', () => {
  assert.equal(ratioOf(400n, 1000n), 0.4);
  assert.equal(ratioOf(null, 1000n), null);
  assert.equal(ratioOf(400n, 0n), null);
  assert.equal(R1_TARGET_RATIO, 0.4);
});

test('l\'ordre de rejeu tourne à gauche de ordinal mod 4', () => {
  assert.deepEqual(replayOrderFor(0), ['REFERENCE', 'S1', 'S2', 'S3']);
  assert.deepEqual(replayOrderFor(1), ['S1', 'S2', 'S3', 'REFERENCE']);
  assert.deepEqual(replayOrderFor(2), ['S2', 'S3', 'REFERENCE', 'S1']);
  assert.deepEqual(replayOrderFor(3), ['S3', 'REFERENCE', 'S1', 'S2']);
  assert.deepEqual(replayOrderFor(4), ['REFERENCE', 'S1', 'S2', 'S3']);
  assert.deepEqual(replayOrderFor(26), replayOrderFor(2));
  for (let ordinal = 0; ordinal < 27; ordinal += 1) {
    assert.deepEqual([...replayOrderFor(ordinal)].sort(), [...BASE_REPLAY_ORDER].sort());
  }
});

test('les métadonnées d\'hôte n\'exposent que les champs autorisés', () => {
  const metadata = hostMetadata();
  assert.deepEqual(
    Object.keys(metadata).sort(),
    ['arch', 'cpu_model', 'logical_cores', 'node_version', 'platform'],
  );
  const forbidden = ['hostname', 'username', 'user', 'home', 'cwd', 'env', 'account'];
  for (const key of forbidden) {
    assert.ok(!Object.keys(metadata).includes(key), `champ interdit : ${key}`);
  }
});

test('les fenêtres de mesure gelées sont celles du contrat', () => {
  assert.equal(WARMUP_OPERATIONS, 200);
  assert.equal(MEASURED_READS, 1900);
});

test('S3 ne réutilise jamais une projection d\'une version de contenu antérieure', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS3(state);
  const query = QUERIES[0];

  strategy.read('viewer-000', query, 0);
  const cache = strategy.inspect();
  const document = state.documents[0];
  const cachedBefore = cache.get(document.id);
  assert.equal(cachedBefore.content_version, document.content_version);
  const projectionBefore = cachedBefore.projection;

  // Écriture de contenu : la version canonique avance.
  document.tokens[7] = document.tokens[7] === 'word-000' ? 'word-001' : 'word-000';
  document.body = document.tokens.join(' ');
  document.content_version += 1;

  strategy.read('viewer-000', query, 0);
  const cachedAfter = cache.get(document.id);
  assert.equal(cachedAfter.content_version, document.content_version);
  assert.notEqual(cachedAfter.projection, projectionBefore, 'la projection doit être remplacée');
  // `tokens` est une SÉQUENCE (P1), non un ensemble.
  assert.ok(cachedAfter.projection.tokens.includes(document.tokens[7]));
  assert.equal(cache.size, DOCUMENT_IDS.length, 'remplacement en place, jamais ajout de clé');
});

test('la loi de résidence de S3 tient sur une longue série d\'écritures', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS3(state);
  for (let step = 0; step < 60; step += 1) {
    const document = state.documents[(step * 13) % state.documents.length];
    document.tokens[3] = `word-${String(step % 256).padStart(3, '0')}`;
    document.body = document.tokens.join(' ');
    document.content_version += 1;
    strategy.read(`viewer-${String(step % 400).padStart(3, '0')}`, QUERIES[step % 32], step % 32);
    assert.ok(strategy.residency().total <= DOCUMENT_IDS.length);
  }
});
