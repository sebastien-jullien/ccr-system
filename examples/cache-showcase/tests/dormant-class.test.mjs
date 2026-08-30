/**
 * S2 — correction des classes DORMANTES.
 *
 * ```text
 * CLASSE ACTIVE  ≠  CLASSE RÉSIDENTE
 * ```
 *
 * Une entrée Part-1 survit à tous les occupants de sa classe. L'invalidation
 * doit donc énumérer l'espace de clés RÉSIDENT, jamais les viewers actifs — sans
 * quoi un viewer entrant plus tard dans une classe vidée de ses occupants
 * frapperait une entrée périmée.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANTS,
  OP_CONTENT_MEMBERSHIP,
  OP_LABEL,
  PRIVATE_LABEL,
  QUERIES,
  TOPICS,
} from '../src/constants.mjs';
import { buildInitialState, liveGrantClass } from '../src/state.mjs';
import { referenceRead } from '../src/reference.mjs';
import { createS2 } from '../src/strategies/s2.mjs';

function indexOfQuery(topic, facet) {
  return QUERIES.findIndex((q) => q.topic === topic && q.facet === facet);
}

/**
 * Vide une classe de tous ses occupants en leur donnant les grants d'une autre
 * classe. L'entrée Part-1 de la classe abandonnée reste résidente.
 */
function evacuateClass(state, classKey) {
  const donor = state.viewers.find((v) => liveGrantClass(v) !== classKey);
  const donorGrants = [...donor.grants];
  for (const viewer of state.viewers) {
    if (liveGrantClass(viewer) === classKey) {
      viewer.grants = [...donorGrants];
      viewer.grantSet = new Set(viewer.grants);
    }
  }
  return donorGrants;
}

test('T-S2-DORMANT-CONTENT — non apparié → apparié sur une classe dormante', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS2(state);

  const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const label = document.labels[0];
  const occupant = state.viewers.find(
    (v) => v.id !== document.owner && v.grantSet.has(label),
  );
  const classKey = liveGrantClass(occupant);

  const facet = document.tokens[1];
  const otherTopic = TOPICS.find((t) => t !== document.tokens[0]);
  const queryIndex = indexOfQuery(otherTopic, facet);
  const query = QUERIES[queryIndex];

  // 1. Peupler Part-1 pour cette classe et cette requête ; le document n'apparie pas.
  const warm = strategy.read(occupant.id, query, queryIndex);
  assert.ok(!warm.includes(document.id));
  assert.ok(strategy.residency().part1 >= 1);

  // 2-3. Vider la classe de tout occupant ; l'entrée reste résidente.
  evacuateClass(state, classKey);
  assert.equal(
    state.viewers.filter((v) => liveGrantClass(v) === classKey).length,
    0,
    'plus aucun viewer actif dans la classe',
  );
  assert.ok(strategy.residency().classes >= 1, 'l\'entrée Part-1 reste résidente');

  // 4. Écriture de contenu : non apparié → apparié.
  document.tokens[0] = otherTopic;
  document.body = document.tokens.join(' ');
  document.content_version += 1;
  const purged = strategy.onMutation({
    kind: OP_CONTENT_MEMBERSHIP, document, dimension: 'topic',
  });
  assert.ok(purged >= 1, 'la classe dormante doit être purgée');

  // 5-6. Un autre viewer entre dans la classe et lit.
  const newcomer = state.viewers.find((v) => v.id !== document.owner);
  newcomer.grants = JSON.parse(classKey);
  newcomer.grantSet = new Set(newcomer.grants);
  assert.equal(liveGrantClass(newcomer), classKey);

  const after = strategy.read(newcomer.id, query, queryIndex);
  assert.deepEqual(after, referenceRead(state, newcomer.id, query));
  assert.ok(after.includes(document.id), 'le nouvel entrant voit le nouvel apparié');
});

test('T-S2-DORMANT-CONTENT inverse — apparié → non apparié sur une classe dormante', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS2(state);

  const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const label = document.labels[0];
  const occupant = state.viewers.find(
    (v) => v.id !== document.owner && v.grantSet.has(label),
  );
  const classKey = liveGrantClass(occupant);

  const queryIndex = indexOfQuery(document.tokens[0], document.tokens[1]);
  const query = QUERIES[queryIndex];

  const warm = strategy.read(occupant.id, query, queryIndex);
  assert.ok(warm.includes(document.id), 'apparié avant');

  evacuateClass(state, classKey);

  document.tokens[0] = TOPICS.find((t) => t !== document.tokens[0]);
  document.body = document.tokens.join(' ');
  document.content_version += 1;
  const purged = strategy.onMutation({
    kind: OP_CONTENT_MEMBERSHIP, document, dimension: 'topic',
  });
  assert.ok(purged >= 1);

  const newcomer = state.viewers.find((v) => v.id !== document.owner);
  newcomer.grants = JSON.parse(classKey);
  newcomer.grantSet = new Set(newcomer.grants);

  const after = strategy.read(newcomer.id, query, queryIndex);
  assert.deepEqual(after, referenceRead(state, newcomer.id, query));
  assert.ok(!after.includes(document.id), 'le nouvel entrant ne voit plus le document');
});

test('T-S2-DORMANT-LABEL — non visible → visible sur une classe dormante', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS2(state);

  const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  // Une classe qui ne détient PAS l'étiquette courante du document.
  const outsider = state.viewers.find(
    (v) => v.id !== document.owner && !v.grantSet.has(document.labels[0]),
  );
  const classKey = liveGrantClass(outsider);
  const classGrants = JSON.parse(classKey);

  const queryIndex = indexOfQuery(document.tokens[0], document.tokens[1]);
  const query = QUERIES[queryIndex];

  const warm = strategy.read(outsider.id, query, queryIndex);
  assert.ok(!warm.includes(document.id), 'non visible avant');

  evacuateClass(state, classKey);
  assert.equal(state.viewers.filter((v) => liveGrantClass(v) === classKey).length, 0);

  // Mutation d'étiquette : le document devient visible pour la classe dormante.
  const oldLabels = [...document.labels];
  document.labels = [classGrants[0]];
  const purged = strategy.onMutation({
    kind: OP_LABEL, document, oldLabels, newLabels: [...document.labels],
  });
  assert.ok(purged >= 1, 'la branche NEW doit purger la classe dormante');

  const newcomer = state.viewers.find((v) => v.id !== document.owner);
  newcomer.grants = [...classGrants];
  newcomer.grantSet = new Set(newcomer.grants);

  const after = strategy.read(newcomer.id, query, queryIndex);
  assert.deepEqual(after, referenceRead(state, newcomer.id, query));
  assert.ok(after.includes(document.id), 'le nouvel entrant voit le document désormais visible');
});

test('T-S2-DORMANT-LABEL inverse — visible → non visible sur une classe dormante', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS2(state);

  const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const label = document.labels[0];
  const holder = state.viewers.find(
    (v) => v.id !== document.owner && v.grantSet.has(label),
  );
  const classKey = liveGrantClass(holder);
  const classGrants = JSON.parse(classKey);

  const queryIndex = indexOfQuery(document.tokens[0], document.tokens[1]);
  const query = QUERIES[queryIndex];

  const warm = strategy.read(holder.id, query, queryIndex);
  assert.ok(warm.includes(document.id), 'visible avant');

  evacuateClass(state, classKey);

  const forbidden = GRANTS.find((g) => !classGrants.includes(g));
  const oldLabels = [...document.labels];
  document.labels = [forbidden];
  const purged = strategy.onMutation({
    kind: OP_LABEL, document, oldLabels, newLabels: [...document.labels],
  });
  assert.ok(purged >= 1, 'la branche OLD doit purger la classe dormante');

  const newcomer = state.viewers.find((v) => v.id !== document.owner);
  newcomer.grants = [...classGrants];
  newcomer.grantSet = new Set(newcomer.grants);

  const after = strategy.read(newcomer.id, query, queryIndex);
  assert.deepEqual(after, referenceRead(state, newcomer.id, query));
  assert.ok(
    !after.includes(document.id),
    'AUCUNE visibilité interdite périmée depuis une classe dormante',
  );
});

test('une mutation de grant n\'invalide pas le cache partagé', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS2(state);
  QUERIES.slice(0, 4).forEach((query, index) => strategy.read('viewer-000', query, index));
  const before = strategy.residency();

  const a = state.viewersById.get('viewer-000');
  const b = state.viewers.find((v) => liveGrantClass(v) !== liveGrantClass(a));
  const swap = a.grants;
  a.grants = b.grants;
  b.grants = swap;
  a.grantSet = new Set(a.grants);
  b.grantSet = new Set(b.grants);

  const purged = strategy.onMutation({ kind: 'GRANT_MUTATION', viewerA: a, viewerB: b });
  assert.equal(purged, 0, 'aucune entrée ne doit être purgée');
  assert.equal(strategy.residency().part1, before.part1);

  // Le viewer se réachemine simplement vers la classe canonique de sa nouvelle
  // affectation, et le résultat reste conforme à l'oracle.
  QUERIES.slice(0, 4).forEach((query, index) => {
    assert.deepEqual(
      strategy.read('viewer-000', query, index),
      referenceRead(state, 'viewer-000', query),
    );
  });
});
