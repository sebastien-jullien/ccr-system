/**
 * Contrat de projection (P1) et de normalisation de requête (P2).
 *
 * P1 — forme gelée de la projection :
 *
 * ```text
 * projection = { id, tokens, title, snippet }
 * tokens     = séquence COMPLÈTE des jetons normalisés du corps brut
 * title      = tokens.slice(0, 2).join(" ")
 * snippet    = tokens.slice(0, 8).join(" ")
 * ```
 *
 * P2 — la normalisation de la requête a lieu une fois par lecture logique, à
 * l'intérieur du chronométrage, AVANT toute consultation de cache, et
 * identiquement pour la REFERENCE, S1, S2 et S3.
 *
 * L'instrumentation P2 n'ajoute aucun coût au code de production : elle observe
 * les accès aux propriétés d'un objet de requête enveloppé dans un `Proxy`.
 * `queryText` lit `topic` puis `facet` exactement une fois par normalisation,
 * donc compter les lectures de `topic` compte les normalisations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BODY_TOKEN_COUNT, QUERIES } from '../src/constants.mjs';
import { buildCorpus } from '../src/corpus.mjs';
import { materialize, matches, normalizeQuery, tokenize } from '../src/query.mjs';
import { buildInitialState } from '../src/state.mjs';
import { referenceRead } from '../src/reference.mjs';
import { createS1 } from '../src/strategies/s1.mjs';
import { createS2 } from '../src/strategies/s2.mjs';
import { createS3 } from '../src/strategies/s3.mjs';

// --------------------------------------------------------------------------
// P1 — forme de la projection
// --------------------------------------------------------------------------

test('P1 — la projection porte exactement id, tokens, title, snippet', () => {
  const document = buildCorpus()[0];
  const projection = materialize(document);
  assert.deepEqual(Object.keys(projection), ['id', 'tokens', 'title', 'snippet']);
  assert.equal(projection.id, document.id);
});

test('P1 — tokens est la séquence complète, pas un ensemble', () => {
  const corpus = buildCorpus();
  for (const document of [corpus[0], corpus[137], corpus[399]]) {
    const expected = tokenize(document.body);
    const projection = materialize(document);
    assert.ok(Array.isArray(projection.tokens), 'tokens doit être une séquence');
    assert.equal(projection.tokens.length, BODY_TOKEN_COUNT);
    assert.deepEqual(projection.tokens, expected, 'ordre et répétitions conservés');
  }
});

test('P1 — les répétitions du corps sont conservées, ce qu\'un ensemble perdrait', () => {
  const corpus = buildCorpus();
  const withDuplicates = corpus.find((document) => {
    const tokens = tokenize(document.body);
    return new Set(tokens).size < tokens.length;
  });
  assert.ok(withDuplicates !== undefined, 'le corpus doit contenir un corps à jetons répétés');

  const projection = materialize(withDuplicates);
  assert.equal(projection.tokens.length, BODY_TOKEN_COUNT);
  assert.ok(
    new Set(projection.tokens).size < projection.tokens.length,
    'la séquence conserve au moins une répétition',
  );
});

test('P1 — title et snippet sont exactement les tranches gelées', () => {
  const corpus = buildCorpus();
  for (const document of [corpus[0], corpus[42], corpus[399]]) {
    const tokens = tokenize(document.body);
    const projection = materialize(document);
    assert.equal(projection.title, tokens.slice(0, 2).join(' '));
    assert.equal(projection.snippet, tokens.slice(0, 8).join(' '));
    // Le premier jeton est le topic, le second la facette : le titre les porte.
    assert.equal(projection.title, `${tokens[0]} ${tokens[1]}`);
    assert.equal(projection.snippet.split(' ').length, 8);
  }
});

test('P1 — l\'appariement conjonctif consulte la séquence', () => {
  const projection = materialize({ id: 'x', body: 'topic-01 facet-02 word-000 word-000' });
  assert.ok(matches(projection, normalizeQuery({ topic: 'topic-01', facet: 'facet-02' })));
  assert.ok(!matches(projection, normalizeQuery({ topic: 'topic-01', facet: 'facet-03' })));
  assert.ok(!matches(projection, normalizeQuery({ topic: 'topic-02', facet: 'facet-02' })));
});

// --------------------------------------------------------------------------
// P2 — normalisation de la requête
// --------------------------------------------------------------------------

test('P2 — la normalisation produit l\'ensemble conjonctif de la requête', () => {
  const querySet = normalizeQuery(QUERIES[5]);
  assert.ok(querySet instanceof Set);
  assert.deepEqual([...querySet].sort(), [QUERIES[5].facet, QUERIES[5].topic].sort());
});

/** Enveloppe une requête pour compter les lectures de `topic`. */
function counting(query) {
  const seen = { count: 0 };
  const proxy = new Proxy(query, {
    get(target, property, receiver) {
      if (property === 'topic') seen.count += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxy, seen };
}

test('P2 — exactement une normalisation par lecture, pour les quatre chemins', () => {
  const state = buildInitialState(4, 40);
  const strategies = [
    ['REFERENCE', { read: (v, q) => referenceRead(state, v, q) }],
    ['S1', createS1(state)],
    ['S2', createS2(state)],
    ['S3', createS3(state)],
  ];

  for (const [name, strategy] of strategies) {
    const first = counting(QUERIES[0]);
    strategy.read('viewer-000', first.proxy, 0);
    assert.equal(first.seen.count, 1, `${name} · manque : une seule normalisation`);

    // Deuxième lecture identique : S1 et S2 servent depuis le cache, et doivent
    // néanmoins normaliser — la normalisation précède la consultation.
    const second = counting(QUERIES[0]);
    strategy.read('viewer-000', second.proxy, 0);
    assert.equal(second.seen.count, 1, `${name} · succès : une seule normalisation`);
  }
});

test('P2 — S2 normalise une fois même lorsque les DEUX régions sont en succès', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS2(state);
  strategy.read('viewer-000', QUERIES[3], 3);
  const before = strategy.residency();

  const probe = counting(QUERIES[3]);
  strategy.read('viewer-000', probe.proxy, 3);
  assert.equal(probe.seen.count, 1, 'double succès : une seule normalisation');
  assert.deepEqual(strategy.residency(), before, 'aucune région recalculée');
});

test('P2 — S2 normalise une fois lorsqu\'une seule région manque', () => {
  const state = buildInitialState(4, 40);
  const strategy = createS2(state);
  // viewer-000 peuple Part-1 pour sa classe et Part-2 pour lui-même.
  strategy.read('viewer-000', QUERIES[7], 7);
  // viewer-004 partage la classe : Part-1 en succès, Part-2 en manque.
  const probe = counting(QUERIES[7]);
  strategy.read('viewer-004', probe.proxy, 7);
  assert.equal(probe.seen.count, 1, 'manque simple : une seule normalisation');
});

test('P2 — aucune requête normalisée n\'est mémorisée entre deux lectures', () => {
  // Une requête portant les mêmes valeurs mais construite à neuf doit être
  // normalisée à nouveau : il n'existe aucun cache de requête.
  const state = buildInitialState(4, 40);
  const strategy = createS3(state);
  const rebuilt = { topic: QUERIES[2].topic, facet: QUERIES[2].facet };
  const first = counting(rebuilt);
  strategy.read('viewer-000', first.proxy, 2);
  assert.equal(first.seen.count, 1);

  const again = counting({ topic: QUERIES[2].topic, facet: QUERIES[2].facet });
  strategy.read('viewer-000', again.proxy, 2);
  assert.equal(again.seen.count, 1, 'normalisée à nouveau, jamais réutilisée');
});

test('P2 — les quatre chemins restent équivalents après la normalisation gelée', () => {
  const state = buildInitialState(40, 140);
  const s1 = createS1(state);
  const s2 = createS2(state);
  const s3 = createS3(state);
  for (const viewerId of ['viewer-000', 'viewer-041', 'viewer-399']) {
    QUERIES.forEach((query, queryIndex) => {
      const expected = referenceRead(state, viewerId, query);
      assert.deepEqual(s1.read(viewerId, query, queryIndex), expected, `S1 ${viewerId}`);
      assert.deepEqual(s2.read(viewerId, query, queryIndex), expected, `S2 ${viewerId}`);
      assert.deepEqual(s3.read(viewerId, query, queryIndex), expected, `S3 ${viewerId}`);
    });
  }
});
