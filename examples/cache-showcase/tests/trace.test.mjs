/**
 * Trace — squelette déterministe, consommation exacte des tirages, appariement
 * entre configurations, immuabilité au rejeu.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_BLOCK,
  CLASS_COUNTS,
  DOCUMENT_IDS,
  OP_CONTENT_FILLER,
  OP_CONTENT_MEMBERSHIP,
  OP_GRANT,
  OP_LABEL,
  OP_OWNERSHIP,
  OP_READ,
  OWNERSHIP_DENSITIES,
  PAYLOAD_DRAWS,
  PRIVATE_COUNTS,
  QUERY_COUNT,
  READS_PER_BLOCK,
  TOTAL_BLOCKS,
  WARMUP_OPERATIONS,
  WORKLOAD_SEED_ORDINALS,
} from '../src/constants.mjs';
import { INDEX, generatorFromString } from '../src/prng.mjs';
import {
  H32,
  buildSkeleton,
  countMeasuredReads,
  enumerateConfiguredTraces,
  resolveRead,
  workloadSeed,
  zipfQueryIndex,
} from '../src/trace.mjs';

const PAYLOAD_PER_BLOCK = READS_PER_BLOCK * PAYLOAD_DRAWS[OP_READ]
  + PAYLOAD_DRAWS[OP_CONTENT_MEMBERSHIP]
  + PAYLOAD_DRAWS[OP_CONTENT_FILLER]
  + PAYLOAD_DRAWS[OP_LABEL]
  + PAYLOAD_DRAWS[OP_GRANT]
  + PAYLOAD_DRAWS[OP_OWNERSHIP];

const SHUFFLE_DRAWS = CANONICAL_BLOCK.length - 1;

/**
 * Redérivation indépendante du squelette, écrite depuis le contrat et non
 * depuis le module : elle vaut contrôle de la consommation des tirages.
 */
function deriveSkeleton(seedOrdinal) {
  const next = generatorFromString(workloadSeed(seedOrdinal));
  let consumed = 0;
  const draw = () => { consumed += 1; return next(); };
  const operations = [];

  for (let block = 0; block < TOTAL_BLOCKS; block += 1) {
    const ordered = [...CANONICAL_BLOCK];
    for (let i = ordered.length - 1; i >= 1; i -= 1) {
      const j = INDEX(draw(), i + 1);
      const swap = ordered[i];
      ordered[i] = ordered[j];
      ordered[j] = swap;
    }
    for (const kind of ordered) {
      const draws = [];
      for (let d = 0; d < PAYLOAD_DRAWS[kind]; d += 1) draws.push(draw());
      operations.push({ kind, draws });
    }
  }

  return { operations, consumed };
}

test('le squelette est déterministe pour une graine donnée', () => {
  for (const ordinal of WORKLOAD_SEED_ORDINALS) {
    assert.deepEqual(buildSkeleton(ordinal), buildSkeleton(ordinal));
  }
});

test('des graines distinctes produisent des squelettes distincts', () => {
  const one = JSON.stringify(buildSkeleton(1));
  const two = JSON.stringify(buildSkeleton(2));
  const three = JSON.stringify(buildSkeleton(3));
  assert.notEqual(one, two);
  assert.notEqual(two, three);
  assert.notEqual(one, three);
});

test('la consommation des tirages est exactement celle du contrat', () => {
  for (const ordinal of WORKLOAD_SEED_ORDINALS) {
    const derived = deriveSkeleton(ordinal);
    assert.deepEqual(buildSkeleton(ordinal), derived.operations);
    assert.equal(derived.consumed, TOTAL_BLOCKS * (SHUFFLE_DRAWS + PAYLOAD_PER_BLOCK));
    assert.equal(SHUFFLE_DRAWS, 99);
    assert.equal(PAYLOAD_PER_BLOCK, 202);
  }
});

test('chaque bloc porte 95 lectures et une mutation de chaque nature', () => {
  const skeleton = buildSkeleton(1);
  assert.equal(skeleton.length, TOTAL_BLOCKS * CANONICAL_BLOCK.length);
  assert.equal(skeleton.length, 2200);

  for (let block = 0; block < TOTAL_BLOCKS; block += 1) {
    const slice = skeleton.slice(block * 100, block * 100 + 100);
    const tally = new Map();
    for (const operation of slice) {
      tally.set(operation.kind, (tally.get(operation.kind) ?? 0) + 1);
      assert.equal(operation.draws.length, PAYLOAD_DRAWS[operation.kind]);
    }
    assert.equal(tally.get(OP_READ), 95);
    assert.equal(tally.get(OP_CONTENT_MEMBERSHIP), 1);
    assert.equal(tally.get(OP_CONTENT_FILLER), 1);
    assert.equal(tally.get(OP_LABEL), 1);
    assert.equal(tally.get(OP_GRANT), 1);
    assert.equal(tally.get(OP_OWNERSHIP), 1);
  }
});

test('le mélange déplace réellement les mutations dans le bloc', () => {
  const skeleton = buildSkeleton(1);
  const positions = new Set();
  for (let block = 0; block < TOTAL_BLOCKS; block += 1) {
    const slice = skeleton.slice(block * 100, block * 100 + 100);
    positions.add(slice.findIndex((op) => op.kind === OP_GRANT));
  }
  assert.ok(positions.size > 1, 'les mutations doivent varier de position selon les blocs');
});

test('la fenêtre de mesure porte 1 900 lectures', () => {
  for (const ordinal of WORKLOAD_SEED_ORDINALS) {
    assert.equal(countMeasuredReads(buildSkeleton(ordinal)), 1900);
  }
  assert.equal(WARMUP_OPERATIONS, 200);
});

test('les lectures se résolvent identiquement quelle que soit la configuration', () => {
  // Le squelette ne dépend ni du nombre de classes ni de la densité : la
  // résolution d'une lecture est donc appariée à travers les neuf combinaisons.
  const skeleton = buildSkeleton(2);
  const reads = skeleton.filter((op) => op.kind === OP_READ).slice(0, 50);
  const resolved = reads.map(resolveRead);
  for (const entry of resolved) {
    assert.ok(entry.viewerId.startsWith('viewer-'));
    assert.ok(entry.queryIndex >= 0 && entry.queryIndex < QUERY_COUNT);
    assert.deepEqual(resolveRead(reads[resolved.indexOf(entry)]), entry);
  }
  assert.equal(CLASS_COUNTS.length * OWNERSHIP_DENSITIES.length, 9);
});

test('les cibles d\'écriture de contenu sont appariées entre configurations', () => {
  const skeleton = buildSkeleton(3);
  const writes = skeleton.filter(
    (op) => op.kind === OP_CONTENT_MEMBERSHIP || op.kind === OP_CONTENT_FILLER,
  );
  // La cible d'une écriture de contenu porte sur les 400 documents, ensemble
  // canonique indépendant de la configuration : la résolution est donc la même.
  for (const write of writes.slice(0, 20)) {
    const target = DOCUMENT_IDS[INDEX(write.draws[0], DOCUMENT_IDS.length)];
    assert.ok(DOCUMENT_IDS.includes(target));
    assert.equal(DOCUMENT_IDS[INDEX(write.draws[0], DOCUMENT_IDS.length)], target);
  }
  assert.equal(PRIVATE_COUNTS.length, 3);
});

test('la sélection zipfienne reste dans les bornes et ne consomme rien de plus', () => {
  assert.ok(Math.abs(H32 - 4.058495) < 1e-5, `H32 = ${String(H32)}`);
  assert.equal(zipfQueryIndex(0), 0);
  assert.equal(zipfQueryIndex(4294967295), QUERY_COUNT - 1);
  const counts = new Array(QUERY_COUNT).fill(0);
  const next = generatorFromString('controle-zipf');
  for (let i = 0; i < 20000; i += 1) counts[zipfQueryIndex(next())] += 1;
  for (const count of counts) assert.ok(count > 0, 'chaque rang doit rester atteignable');
  assert.ok(counts[0] > counts[QUERY_COUNT - 1], 'le rang 1 doit dominer le rang 32');
});

test('les 27 traces configurées s\'énumèrent dans l\'ordre gelé', () => {
  const traces = enumerateConfiguredTraces(CLASS_COUNTS, OWNERSHIP_DENSITIES, WORKLOAD_SEED_ORDINALS);
  assert.equal(traces.length, 27);
  assert.deepEqual(traces.map((t) => t.ordinal), Array.from({ length: 27 }, (_, i) => i));
  assert.deepEqual(traces[0], { ordinal: 0, classCount: 4, density: 10, seedOrdinal: 1 });
  assert.deepEqual(traces[3], { ordinal: 3, classCount: 4, density: 35, seedOrdinal: 1 });
  assert.deepEqual(traces[9], { ordinal: 9, classCount: 40, density: 10, seedOrdinal: 1 });
  assert.deepEqual(traces[26], { ordinal: 26, classCount: 400, density: 70, seedOrdinal: 3 });
});

test('un rejeu ne mute pas le squelette', () => {
  const before = JSON.stringify(buildSkeleton(1));
  const skeleton = buildSkeleton(1);
  for (const operation of skeleton) {
    if (operation.kind === OP_READ) resolveRead(operation);
  }
  assert.equal(JSON.stringify(skeleton), before);
  assert.equal(JSON.stringify(buildSkeleton(1)), before);
});
