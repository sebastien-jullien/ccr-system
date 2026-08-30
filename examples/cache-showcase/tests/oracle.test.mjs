/**
 * Oracle — la REFERENCE dit-elle la vérité ?
 *
 * La REFERENCE est comparée à une définition ensembliste indépendante, écrite
 * ici depuis la règle de visibilité et non depuis le code de la fixture. Sans
 * cela, « conforme à l'oracle » ne voudrait rien dire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRIVATE_LABEL, QUERIES } from '../src/constants.mjs';
import { buildInitialState } from '../src/state.mjs';
import { referenceRead } from '../src/reference.mjs';

/**
 * Oracle indépendant.
 *
 * ```text
 * visible ⟺ owner(d) = v ∨ grants(v) ∩ labels(d) ≠ ∅
 * apparié ⟺ tous les jetons de la requête figurent dans le corps
 * ```
 */
function independentOracle(state, viewerId, query) {
  const viewer = state.viewersById.get(viewerId);
  const wanted = [query.topic, query.facet];
  const result = [];
  for (const document of state.documents) {
    const tokens = document.body.split(' ');
    const matched = wanted.every((token) => tokens.includes(token));
    if (!matched) continue;
    const owns = document.owner === viewerId;
    const granted = document.labels.some((label) => viewer.grants.includes(label));
    if (owns || granted) result.push(document.id);
  }
  return result;
}

test('la REFERENCE égale un oracle indépendant sur une matrice viewer × requête', () => {
  const state = buildInitialState(40, 140);
  const viewers = ['viewer-000', 'viewer-013', 'viewer-141', 'viewer-399'];
  for (const viewerId of viewers) {
    for (const query of QUERIES) {
      assert.deepEqual(
        referenceRead(state, viewerId, query),
        independentOracle(state, viewerId, query),
        `${viewerId} / ${query.topic} ${query.facet}`,
      );
    }
  }
});

test('la REFERENCE rend un ordre croissant stable d\'identifiants', () => {
  const state = buildInitialState(4, 40);
  for (const query of QUERIES.slice(0, 8)) {
    const result = referenceRead(state, 'viewer-007', query);
    assert.deepEqual(result, [...result].sort());
    assert.equal(new Set(result).size, result.length, 'aucun doublon');
  }
});

test('visibilité par propriété seule : seul le propriétaire voit le document', () => {
  const state = buildInitialState(4, 280);
  const document = state.documents.find((d) => d.labels[0] === PRIVATE_LABEL);
  const query = { topic: document.body.split(' ')[0], facet: document.body.split(' ')[1] };

  assert.ok(referenceRead(state, document.owner, query).includes(document.id));

  const others = state.viewers.filter((v) => v.id !== document.owner).slice(0, 40);
  for (const viewer of others) {
    assert.ok(
      !referenceRead(state, viewer.id, query).includes(document.id),
      `${viewer.id} ne doit pas voir ${document.id}`,
    );
  }
});

test('visibilité par grant seule : un non-propriétaire détenteur voit le document', () => {
  const state = buildInitialState(4, 40);
  const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const label = document.labels[0];
  const query = { topic: document.body.split(' ')[0], facet: document.body.split(' ')[1] };

  const holder = state.viewers.find((v) => v.id !== document.owner && v.grantSet.has(label));
  assert.ok(holder !== undefined, 'un détenteur non propriétaire doit exister');
  assert.ok(referenceRead(state, holder.id, query).includes(document.id));

  const stranger = state.viewers.find((v) => v.id !== document.owner && !v.grantSet.has(label));
  assert.ok(stranger !== undefined, 'un non-détenteur non propriétaire doit exister');
  assert.ok(!referenceRead(state, stranger.id, query).includes(document.id));
});

test('visibilité par les deux bases : le document apparaît exactement une fois', () => {
  const state = buildInitialState(4, 40);
  const document = state.documents.find(
    (d) => d.labels[0] !== PRIVATE_LABEL
      && state.viewersById.get(d.owner).grantSet.has(d.labels[0]),
  );
  assert.ok(document !== undefined, 'un document visible par les deux bases doit exister');

  const query = { topic: document.body.split(' ')[0], facet: document.body.split(' ')[1] };
  const result = referenceRead(state, document.owner, query);
  const occurrences = result.filter((id) => id === document.id).length;
  assert.equal(occurrences, 1);
});

test('les étiquettes ne sont pas indexables : changer une étiquette ne change aucun appariement', () => {
  const state = buildInitialState(4, 40);
  const document = state.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const query = { topic: document.body.split(' ')[0], facet: document.body.split(' ')[1] };
  const owner = document.owner;

  const before = referenceRead(state, owner, query);
  document.labels = ['grant-00'];
  const after = referenceRead(state, owner, query);
  // Le propriétaire voit le document par propriété : l'étiquette ne pèse pas.
  assert.deepEqual(after, before);
});
