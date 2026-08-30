/**
 * Sémantique de requête et projection de recherche.
 *
 * Normalisation gelée :
 *
 * ```text
 * NFKC → minuscules → jetons [a-z0-9-]+
 * ```
 *
 * Appariement CONJONCTIF : tous les jetons de la requête doivent exister dans
 * l'ensemble des jetons du document. La REFERENCE et les trois stratégies
 * emploient rigoureusement la même sémantique.
 *
 * Les étiquettes ne sont PAS indexables : elles gouvernent la visibilité, jamais
 * l'appariement. Une mutation d'étiquette est donc une mutation d'autorisation
 * pure, et une écriture de corps une mutation de contenu pure.
 */

const TOKEN_PATTERN = /[a-z0-9-]+/g;

/** Normalisation canonique d'un texte brut en liste de jetons. */
export function tokenize(text) {
  return text.normalize('NFKC').toLowerCase().match(TOKEN_PATTERN) ?? [];
}

/**
 * Matérialisation — la projection de recherche d'un document.
 *
 * C'est le travail réellement requis par une lecture : analyser le corps brut,
 * le normaliser, le découper en jetons, puis en dériver le titre et l'extrait
 * rendus par le listing.
 *
 * Forme gelée de la projection :
 *
 * ```text
 * tokens   séquence COMPLÈTE des jetons normalisés du corps brut
 * title    tokens.slice(0, 2).join(" ")
 * snippet  tokens.slice(0, 8).join(" ")
 * ```
 *
 * `tokens` est une séquence, non un ensemble : l'ordre et les répétitions du
 * corps sont conservés tels quels.
 */
export function materialize(document) {
  const tokens = tokenize(document.body);
  return {
    id: document.id,
    tokens,
    title: tokens.slice(0, 2).join(' '),
    snippet: tokens.slice(0, 8).join(' '),
  };
}

/** Représentation canonique d'une requête : un topic puis une facette. */
export function queryText(query) {
  return `${query.topic} ${query.facet}`;
}

/**
 * Normalisation d'une requête — UNE fois par lecture logique.
 *
 * Elle a lieu à l'intérieur du chronométrage, AVANT toute consultation de cache,
 * et identiquement pour la REFERENCE comme pour S1, S2 et S3. Aucune requête
 * normalisée n'est mémorisée : il n'existe pas de cache de requête.
 */
export function normalizeQuery(query) {
  return new Set(tokenize(queryText(query)));
}

/**
 * Appariement conjonctif : tous les jetons de la requête doivent figurer dans
 * la séquence de jetons du document.
 */
export function matches(projection, querySet) {
  for (const token of querySet) {
    if (!projection.tokens.includes(token)) return false;
  }
  return true;
}

/**
 * Prédicat d'autorisation vivant.
 *
 * ```text
 * visible ⟺ viewer possède le document ∨ grants(viewer) ∩ labels(document) ≠ ∅
 * ```
 */
export function authorized(document, viewerId, grantSet) {
  if (document.owner === viewerId) return true;
  for (const label of document.labels) {
    if (grantSet.has(label)) return true;
  }
  return false;
}

/** Visibilité par grants seule — moitié « Part-1 » de la règle. */
export function grantVisible(document, grantSet) {
  for (const label of document.labels) {
    if (grantSet.has(label)) return true;
  }
  return false;
}
