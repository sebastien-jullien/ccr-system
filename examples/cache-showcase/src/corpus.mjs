/**
 * Corpus gelé — indépendant de toute configuration.
 *
 * Un enregistrement de corpus porte exactement :
 *
 * ```text
 * id · owner · base_label · content_version · body
 * ```
 *
 * `base_label` est une propriété stable de CHAQUE document, y compris d'un
 * document rendu « propriété seule » par une configuration : la confidentialité
 * est une surcouche de configuration, elle ne supprime pas l'étiquette de base.
 */

import {
  BODY_TOKEN_COUNT,
  CORPUS_SEED,
  DOCUMENT_IDS,
  FACETS,
  FACET_COUNT,
  FILLERS,
  FILLER_COUNT,
  FILLER_TOKEN_COUNT,
  GRANTS,
  GRANT_COUNT,
  INITIAL_CONTENT_VERSION,
  OWNER_RANKING_SEED,
  PRIVATE_RANKING_SEED,
  TOPICS,
  TOPIC_COUNT,
  VIEWER_IDS,
} from './constants.mjs';
import { INDEX, NUL, digestOf, generatorFromString, rankByDigest } from './prng.mjs';

/**
 * Corps d'un document — 96 jetons.
 *
 * Le PRNG par document est amorcé une seule fois et consommé séquentiellement.
 * Il n'est ni réinitialisé ni dupliqué entre le topic, la facette et les
 * remplisseurs : les 96 tirages forment une seule suite.
 */
export function bodyTokensFor(documentId) {
  const next = generatorFromString(`${CORPUS_SEED}${NUL}${documentId}`);
  const tokens = new Array(BODY_TOKEN_COUNT);
  tokens[0] = TOPICS[INDEX(next(), TOPIC_COUNT)];
  tokens[1] = FACETS[INDEX(next(), FACET_COUNT)];
  for (let i = 0; i < FILLER_TOKEN_COUNT; i += 1) {
    tokens[2 + i] = FILLERS[INDEX(next(), FILLER_COUNT)];
  }
  return tokens;
}

/**
 * Étiquette de base d'un document.
 *
 * Aucun tirage du PRNG de corps n'est consommé : le condensat est dédié, et le
 * 97ᵉ tirage du corps n'existe pas.
 */
export function baseLabelFor(documentId) {
  const digest = digestOf(`${CORPUS_SEED}${NUL}label${NUL}${documentId}`);
  return GRANTS[digest.readUInt32BE(0) % GRANT_COUNT];
}

/**
 * Attribution initiale des propriétaires — bijection documents ↔ viewers.
 *
 * Ce sont les DOCUMENTS qui sont classés, jamais les viewers. Le document au
 * rang zéro appartient à `viewer-000`, et ainsi de suite.
 */
export function initialOwnerAssignment() {
  const ranked = rankByDigest(OWNER_RANKING_SEED, [...DOCUMENT_IDS]);
  const owners = new Map();
  ranked.forEach((documentId, position) => {
    owners.set(documentId, VIEWER_IDS[position]);
  });
  return owners;
}

/**
 * Classement unique des documents « propriété seule ».
 *
 * Les trois densités sont des préfixes imbriqués de ce même classement :
 * `PRIVATE_10 ⊂ PRIVATE_35 ⊂ PRIVATE_70`.
 */
export function privateRanking() {
  return rankByDigest(PRIVATE_RANKING_SEED, [...DOCUMENT_IDS]);
}

/** Corpus complet, en ordre canonique d'identifiant de document. */
export function buildCorpus() {
  const owners = initialOwnerAssignment();
  return DOCUMENT_IDS.map((id) => ({
    id,
    owner: owners.get(id),
    base_label: baseLabelFor(id),
    content_version: INITIAL_CONTENT_VERSION,
    body: bodyTokensFor(id).join(' '),
  }));
}

/**
 * Sérialisation canonique du corpus — NDJSON compact, UTF-8, LF, LF final.
 *
 * L'ordre des champs est celui du contrat ; `JSON.stringify` suit l'ordre
 * d'insertion, la construction ci-dessus le fixe donc exactement.
 */
export function serializeCorpus(corpus) {
  return corpus
    .map((record) => JSON.stringify({
      id: record.id,
      owner: record.owner,
      base_label: record.base_label,
      content_version: record.content_version,
      body: record.body,
    }))
    .map((line) => `${line}\n`)
    .join('');
}

/** SHA-256 du corpus canonique. Artefact dérivé : jamais codé en dur. */
export function corpusDigest(corpus = buildCorpus()) {
  return digestOf(serializeCorpus(corpus)).toString('hex');
}
