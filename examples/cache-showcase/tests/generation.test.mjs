/**
 * Génération — corpus, topologie, densité de propriété, empreinte d'état.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOCUMENT_IDS,
  FACETS,
  FILLERS,
  GRANTS,
  PRIVATE_COUNTS,
  PRIVATE_LABEL,
  TOPICS,
  VIEWER_IDS,
} from '../src/constants.mjs';
import {
  baseLabelFor,
  bodyTokensFor,
  buildCorpus,
  corpusDigest,
  initialOwnerAssignment,
  privateRanking,
} from '../src/corpus.mjs';
import { canonicalClass, classesFor, incidenceVector } from '../src/topology.mjs';
import { buildInitialState, stateDigest } from '../src/state.mjs';

test('le corpus se régénère à l\'identique', () => {
  const first = buildCorpus();
  const second = buildCorpus();
  assert.deepEqual(first, second);
  assert.equal(corpusDigest(first), corpusDigest(second));
  assert.equal(first.length, 400);
});

test('chaque corps porte 96 jetons : un topic, une facette, 94 remplisseurs', () => {
  for (const id of [DOCUMENT_IDS[0], DOCUMENT_IDS[199], DOCUMENT_IDS[399]]) {
    const tokens = bodyTokensFor(id);
    assert.equal(tokens.length, 96);
    assert.ok(TOPICS.includes(tokens[0]), `topic attendu, obtenu ${tokens[0]}`);
    assert.ok(FACETS.includes(tokens[1]), `facette attendue, obtenue ${tokens[1]}`);
    for (let i = 2; i < 96; i += 1) {
      assert.ok(FILLERS.includes(tokens[i]), `remplisseur attendu en ${i}`);
    }
  }
});

test('les vocabulaires de recherche sont disjoints', () => {
  const all = new Set([...TOPICS, ...FACETS, ...FILLERS]);
  assert.equal(all.size, TOPICS.length + FACETS.length + FILLERS.length);
});

test('base_label est stable, grantable, et ne consomme aucun tirage de corps', () => {
  for (const id of DOCUMENT_IDS) {
    const label = baseLabelFor(id);
    assert.ok(GRANTS.includes(label), `${id} porte ${label}`);
    assert.equal(baseLabelFor(id), label);
  }
  // Le 97ᵉ tirage du PRNG de corps n'existe pas : le corps fait exactement 96.
  assert.equal(bodyTokensFor(DOCUMENT_IDS[0]).length, 96);
});

test('l\'attribution initiale des propriétaires est une bijection', () => {
  const owners = initialOwnerAssignment();
  assert.equal(owners.size, 400);
  const distinct = new Set(owners.values());
  assert.equal(distinct.size, 400);
  for (const viewerId of VIEWER_IDS) assert.ok(distinct.has(viewerId));
});

test('les préfixes d\'incidence des classes équilibrées sont conformes', () => {
  assert.deepEqual(incidenceVector(4), [1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(incidenceVector(40), [18, 18, 18, 18, 18, 18, 18, 18, 18, 19, 19]);
  assert.deepEqual(
    incidenceVector(400),
    [181, 181, 182, 182, 182, 182, 182, 182, 182, 182, 182],
  );
});

test('les classes sont imbriquées, distinctes, et de taille 5', () => {
  const four = classesFor(4);
  const forty = classesFor(40);
  const fourHundred = classesFor(400);
  assert.deepEqual(forty.slice(0, 4), four);
  assert.deepEqual(fourHundred.slice(0, 40), forty);
  assert.equal(new Set(fourHundred.map((c) => c.key)).size, 400);
  for (const entry of fourHundred) assert.equal(entry.grants.length, 5);
});

test('la sérialisation canonique d\'une classe est injective et indépendante de l\'ordre', () => {
  const a = canonicalClass(['grant-03', 'grant-00', 'grant-07', 'grant-01', 'grant-10']);
  const b = canonicalClass(['grant-10', 'grant-07', 'grant-03', 'grant-01', 'grant-00']);
  assert.equal(a, b);
  assert.equal(a, '["grant-00","grant-01","grant-03","grant-07","grant-10"]');
  assert.notEqual(a, canonicalClass(['grant-00', 'grant-01', 'grant-03', 'grant-07', 'grant-09']));
  assert.deepEqual(JSON.parse(a).sort(), JSON.parse(a));
});

test('les ensembles « propriété seule » sont des préfixes imbriqués d\'un seul classement', () => {
  const ranking = privateRanking();
  assert.equal(ranking.length, 400);
  assert.equal(new Set(ranking).size, 400);

  const [p10, p35, p70] = PRIVATE_COUNTS;
  const small = new Set(ranking.slice(0, p10));
  const medium = new Set(ranking.slice(0, p35));
  const large = new Set(ranking.slice(0, p70));

  assert.equal(small.size, 40);
  assert.equal(medium.size, 140);
  assert.equal(large.size, 280);
  for (const id of small) assert.ok(medium.has(id), `${id} devrait rester privé à 35 %`);
  for (const id of medium) assert.ok(large.has(id), `${id} devrait rester privé à 70 %`);
});

test('la densité fixe les étiquettes effectives sans toucher base_label', () => {
  for (const [index, privateCount] of PRIVATE_COUNTS.entries()) {
    const state = buildInitialState(4, privateCount);
    const privates = state.documents.filter((d) => d.labels[0] === PRIVATE_LABEL);
    assert.equal(privates.length, privateCount, `densité index ${index}`);
    for (const document of state.documents) {
      assert.ok(GRANTS.includes(document.base_label));
      if (document.labels[0] === PRIVATE_LABEL) {
        assert.deepEqual(document.labels, [PRIVATE_LABEL]);
      } else {
        assert.deepEqual(document.labels, [document.base_label]);
      }
    }
  }
});

test('« private » n\'est jamais octroyable', () => {
  assert.ok(!GRANTS.includes(PRIVATE_LABEL));
  const state = buildInitialState(400, 280);
  for (const viewer of state.viewers) {
    assert.ok(!viewer.grantSet.has(PRIVATE_LABEL));
  }
});

test('viewer i reçoit la classe i mod classCount', () => {
  for (const classCount of [4, 40, 400]) {
    const state = buildInitialState(classCount, 40);
    const classes = classesFor(classCount);
    for (const index of [0, 1, 7, 123, 399]) {
      assert.deepEqual(state.viewers[index].grants, [...classes[index % classCount].grants]);
    }
    const occupancy = new Map();
    state.viewers.forEach((v, i) => {
      const key = classes[i % classCount].key;
      occupancy.set(key, (occupancy.get(key) ?? 0) + 1);
    });
    for (const count of occupancy.values()) assert.equal(count, 400 / classCount);
  }
});

test('l\'empreinte d\'état initial est reproductible', () => {
  assert.equal(stateDigest(buildInitialState(4, 40)), stateDigest(buildInitialState(4, 40)));
});

test('les grants d\'un viewer sont toujours en ordre canonique', () => {
  const state = buildInitialState(40, 140);
  for (const viewer of state.viewers) {
    assert.deepEqual(viewer.grants, [...viewer.grants].sort());
  }
});

test('l\'empreinte d\'état initial change si les grants d\'un viewer changent', () => {
  const state = buildInitialState(4, 40);
  const before = stateDigest(state);
  const replacement = GRANTS.find((g) => !state.viewers[0].grantSet.has(g));
  state.viewers[0].grants = [...state.viewers[0].grants.slice(1), replacement].sort();
  assert.notEqual(stateDigest(state), before);
});

test('l\'empreinte d\'état initial couvre aussi les documents', () => {
  const state = buildInitialState(4, 40);
  const before = stateDigest(state);
  state.documents[0].owner = state.documents[0].owner === 'viewer-000' ? 'viewer-001' : 'viewer-000';
  assert.notEqual(stateDigest(state), before);
});
