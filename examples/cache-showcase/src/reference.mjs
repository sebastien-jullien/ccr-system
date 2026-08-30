/**
 * Oracle non caché — la REFERENCE.
 *
 * Ordre de balayage gelé, identique pour les quatre chemins :
 *
 * ```text
 * MATÉRIALISER → APPARIER LA REQUÊTE → AUTORISER → ACCUMULER
 * ```
 *
 * L'autorisation ne décide JAMAIS si le travail d'appariement est exécuté : le
 * filtre vient après l'appariement, jamais avant.
 *
 * La projection est réellement recalculée à chaque lecture, pour chaque
 * document. Rien n'est pré-matérialisé : ce serait exactement l'économie que la
 * stratégie S3 est censée démontrer.
 */

import { authorized, materialize, matches, normalizeQuery } from './query.mjs';

/**
 * Résultat d'une lecture : identifiants de documents, ordre stable croissant.
 *
 * Le parcours suit l'ordre canonique d'identifiant, donc l'accumulation est
 * déjà triée ; le tri final n'existe pas parce qu'il n'est pas nécessaire.
 */
export function referenceRead(state, viewerId, query) {
  // Normalisation de la requête : une fois, en tête de la lecture logique.
  const querySet = normalizeQuery(query);
  const viewer = state.viewersById.get(viewerId);
  const grantSet = viewer.grantSet;
  const result = [];

  for (const document of state.documents) {
    const projection = materialize(document);
    if (!matches(projection, querySet)) continue;
    if (authorized(document, viewerId, grantSet)) result.push(document.id);
  }

  return result;
}

/** Adaptateur de stratégie pour la REFERENCE : aucun cache, aucune invalidation. */
export function createReference(state) {
  return {
    name: 'REFERENCE',
    read(viewerId, query) {
      return referenceRead(state, viewerId, query);
    },
    onMutation() {
      return 0;
    },
    residency() {
      return { total: 0 };
    },
  };
}
