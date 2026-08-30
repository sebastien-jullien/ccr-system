/**
 * S3 — cache de projection matérialisée, par document.
 *
 * ```text
 * clé    document_id
 * valeur { content_version, materialized_projection }
 * ```
 *
 * Politique de remplacement PARESSEUSE : l'espace de clés est exactement
 * l'espace des identifiants de documents, donc le nombre de projections
 * résidentes ne peut jamais dépasser le nombre de documents. Une écriture
 * remplace une valeur ; elle n'ajoute jamais de clé.
 *
 * Aucun cache de résultat de requête n'existe. L'autorisation est évaluée
 * VIVANTE à chaque lecture, après l'appariement — jamais avant, et jamais pour
 * décider si l'appariement doit avoir lieu.
 */

import { authorized, materialize, matches, normalizeQuery } from '../query.mjs';

export function createS3(state) {
  /** @type {Map<string, { content_version: number, projection: object }>} */
  const cache = new Map();

  return {
    name: 'S3',

    read(viewerId, query) {
      // Normalisation de la requête : une fois, en tête de la lecture logique.
      const querySet = normalizeQuery(query);
      const grantSet = state.viewersById.get(viewerId).grantSet;
      const result = [];

      for (const document of state.documents) {
        const entry = cache.get(document.id);
        let projection;
        if (entry !== undefined && entry.content_version === document.content_version) {
          projection = entry.projection;
        } else {
          projection = materialize(document);
          // Remplacement en place : la clé existe déjà ou est créée une fois.
          cache.set(document.id, {
            content_version: document.content_version,
            projection,
          });
        }
        if (!matches(projection, querySet)) continue;
        if (authorized(document, viewerId, grantSet)) result.push(document.id);
      }

      return result;
    },

    onMutation() {
      // Rien. Une écriture de contenu incrémente la version canonique ; la
      // lecture suivante constate l'écart et remplace la valeur. Une mutation
      // d'autorisation ne touche pas ce cache, qui n'en contient rien.
      return 0;
    },

    residency() {
      return { total: cache.size, projections: cache.size };
    },

    /** Exposé pour la qualification : la loi de résidence doit être vérifiable. */
    inspect() {
      return cache;
    },
  };
}
