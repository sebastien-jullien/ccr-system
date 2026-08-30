/**
 * Fraîcheur d'autorisation — R3, contrainte DURE.
 *
 * Après validation d'une mutation d'autorisation, la LECTURE SUIVANTE doit
 * égaler l'oracle d'autorisation. Aucune visibilité interdite périmée n'est
 * tolérée, pour aucune stratégie.
 *
 * Modèle temporel : un tic = une opération achevée. La mutation s'achève au tic
 * `t` ; la lecture suivante a lieu au tic `t+1`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANTS,
  OP_GRANT,
  OP_LABEL,
  OP_OWNERSHIP,
  PRIVATE_LABEL,
  QUERIES,
} from '../src/constants.mjs';
import { buildInitialState } from '../src/state.mjs';
import { referenceRead } from '../src/reference.mjs';
import { createS1 } from '../src/strategies/s1.mjs';
import { createS2 } from '../src/strategies/s2.mjs';
import { createS3 } from '../src/strategies/s3.mjs';

const FACTORIES = [['S1', createS1], ['S2', createS2], ['S3', createS3]];

/** Requête canonique appariant exactement ce document. */
function queryOf(document) {
  const tokens = document.body.split(' ');
  const index = QUERIES.findIndex((q) => q.topic === tokens[0] && q.facet === tokens[1]);
  return { query: QUERIES[index], queryIndex: index };
}

/** Prépare un état neuf, une stratégie neuve, et chauffe une lecture. */
function warm(factory, classCount, privateCount, viewerId, document) {
  const state = buildInitialState(classCount, privateCount);
  const live = state.documentsById.get(document.id);
  const strategy = factory(state);
  const { query, queryIndex } = queryOf(live);
  strategy.read(viewerId, query, queryIndex);
  return { state, live, strategy, query, queryIndex };
}

test('ajout de grant : le document nouvellement visible apparaît au tic suivant', () => {
  const probe = buildInitialState(4, 40);
  const document = probe.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const label = document.labels[0];
  const outsider = probe.viewers.find((v) => v.id !== document.owner && !v.grantSet.has(label));

  for (const [name, factory] of FACTORIES) {
    const ctx = warm(factory, 4, 40, outsider.id, document);
    const before = ctx.strategy.read(outsider.id, ctx.query, ctx.queryIndex);
    assert.ok(!before.includes(document.id), `${name} · invisible avant`);

    // Mutation d'octroi : échange complet d'affectation de classe.
    const donor = ctx.state.viewers.find((v) => v.grantSet.has(ctx.live.labels[0]));
    const target = ctx.state.viewersById.get(outsider.id);
    const swap = target.grants;
    target.grants = donor.grants;
    donor.grants = swap;
    target.grantSet = new Set(target.grants);
    donor.grantSet = new Set(donor.grants);
    ctx.strategy.onMutation({ kind: OP_GRANT, viewerA: target, viewerB: donor });

    const after = ctx.strategy.read(outsider.id, ctx.query, ctx.queryIndex);
    assert.deepEqual(after, referenceRead(ctx.state, outsider.id, ctx.query), `${name} · oracle`);
    assert.ok(after.includes(document.id), `${name} · visible après l'octroi`);
  }
});

test('révocation de grant : le document interdit disparaît au tic suivant', () => {
  const probe = buildInitialState(4, 40);
  const document = probe.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const label = document.labels[0];
  const holder = probe.viewers.find((v) => v.id !== document.owner && v.grantSet.has(label));

  for (const [name, factory] of FACTORIES) {
    const ctx = warm(factory, 4, 40, holder.id, document);
    const before = ctx.strategy.read(holder.id, ctx.query, ctx.queryIndex);
    assert.ok(before.includes(document.id), `${name} · visible avant`);

    const stranger = ctx.state.viewers.find((v) => !v.grantSet.has(ctx.live.labels[0]));
    const target = ctx.state.viewersById.get(holder.id);
    const swap = target.grants;
    target.grants = stranger.grants;
    stranger.grants = swap;
    target.grantSet = new Set(target.grants);
    stranger.grantSet = new Set(stranger.grants);
    ctx.strategy.onMutation({ kind: OP_GRANT, viewerA: target, viewerB: stranger });

    const after = ctx.strategy.read(holder.id, ctx.query, ctx.queryIndex);
    assert.deepEqual(after, referenceRead(ctx.state, holder.id, ctx.query), `${name} · oracle`);
    assert.ok(!after.includes(document.id), `${name} · AUCUNE visibilité interdite périmée`);
  }
});

test('transfert de propriété : l\'ancien perd, le nouveau gagne, au tic suivant', () => {
  const probe = buildInitialState(4, 280);
  const document = probe.documents.find((d) => d.labels[0] === PRIVATE_LABEL);

  for (const [name, factory] of FACTORIES) {
    const ctx = warm(factory, 4, 280, document.owner, document);
    const oldOwner = ctx.live.owner;
    const newOwner = ctx.state.viewers.find((v) => v.id !== oldOwner).id;

    // Les deux propriétaires lisent avant le transfert.
    assert.ok(ctx.strategy.read(oldOwner, ctx.query, ctx.queryIndex).includes(document.id));
    assert.ok(!ctx.strategy.read(newOwner, ctx.query, ctx.queryIndex).includes(document.id));

    ctx.live.owner = newOwner;
    ctx.strategy.onMutation({ kind: OP_OWNERSHIP, document: ctx.live, oldOwner, newOwner });

    const forOld = ctx.strategy.read(oldOwner, ctx.query, ctx.queryIndex);
    const forNew = ctx.strategy.read(newOwner, ctx.query, ctx.queryIndex);
    assert.deepEqual(forOld, referenceRead(ctx.state, oldOwner, ctx.query), `${name} · ancien`);
    assert.deepEqual(forNew, referenceRead(ctx.state, newOwner, ctx.query), `${name} · nouveau`);
    assert.ok(!forOld.includes(document.id), `${name} · AUCUNE visibilité interdite périmée`);
    assert.ok(forNew.includes(document.id), `${name} · le nouveau propriétaire voit`);
  }
});

test('étiquette visible → interdite : disparition au tic suivant', () => {
  const probe = buildInitialState(4, 40);
  const document = probe.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const label = document.labels[0];
  const holder = probe.viewers.find((v) => v.id !== document.owner && v.grantSet.has(label));

  for (const [name, factory] of FACTORIES) {
    const ctx = warm(factory, 4, 40, holder.id, document);
    assert.ok(ctx.strategy.read(holder.id, ctx.query, ctx.queryIndex).includes(document.id));

    const grantSet = ctx.state.viewersById.get(holder.id).grantSet;
    const replacement = GRANTS.find((g) => !grantSet.has(g));
    const oldLabels = [...ctx.live.labels];
    ctx.live.labels = [replacement];
    ctx.strategy.onMutation({
      kind: OP_LABEL, document: ctx.live, oldLabels, newLabels: [...ctx.live.labels],
    });

    const after = ctx.strategy.read(holder.id, ctx.query, ctx.queryIndex);
    assert.deepEqual(after, referenceRead(ctx.state, holder.id, ctx.query), `${name} · oracle`);
    assert.ok(!after.includes(document.id), `${name} · AUCUNE visibilité interdite périmée`);
  }
});

test('étiquette interdite → visible : apparition au tic suivant', () => {
  const probe = buildInitialState(4, 40);
  const document = probe.documents.find((d) => d.labels[0] !== PRIVATE_LABEL);
  const outsider = probe.viewers.find(
    (v) => v.id !== document.owner && !v.grantSet.has(document.labels[0]),
  );

  for (const [name, factory] of FACTORIES) {
    const ctx = warm(factory, 4, 40, outsider.id, document);
    assert.ok(!ctx.strategy.read(outsider.id, ctx.query, ctx.queryIndex).includes(document.id));

    const grantSet = ctx.state.viewersById.get(outsider.id).grantSet;
    const replacement = [...grantSet][0];
    const oldLabels = [...ctx.live.labels];
    ctx.live.labels = [replacement];
    ctx.strategy.onMutation({
      kind: OP_LABEL, document: ctx.live, oldLabels, newLabels: [...ctx.live.labels],
    });

    const after = ctx.strategy.read(outsider.id, ctx.query, ctx.queryIndex);
    assert.deepEqual(after, referenceRead(ctx.state, outsider.id, ctx.query), `${name} · oracle`);
    assert.ok(after.includes(document.id), `${name} · visible après le changement d'étiquette`);
  }
});
