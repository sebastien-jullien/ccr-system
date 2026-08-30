/**
 * S1 — cache de résultat complet, par viewer.
 *
 * Clé : `(viewer, query)`. Le cache est stocké comme une table par viewer, ce
 * qui rend la purge d'un viewer exacte et énumérable.
 *
 * Invalidation sur écriture de contenu : TOUTES les entrées de TOUT viewer
 * actuellement autorisé au document modifié sont purgées — sans jamais inspecter
 * ce que l'entrée contenait auparavant. C'est ce qui couvre les deux directions,
 * `non-apparié → apparié` comme `apparié → non-apparié`.
 */

import {
  OP_CONTENT_FILLER,
  OP_CONTENT_MEMBERSHIP,
  OP_GRANT,
  OP_LABEL,
  OP_OWNERSHIP,
} from '../constants.mjs';
import { authorized, materialize, matches, normalizeQuery } from '../query.mjs';

export function createS1(state) {
  /** @type {Map<string, Map<number, string[]>>} */
  const cache = new Map();

  function purgeViewer(viewerId) {
    const entries = cache.get(viewerId);
    if (entries === undefined) return 0;
    const count = entries.size;
    cache.delete(viewerId);
    return count;
  }

  function compute(viewerId, querySet) {
    const grantSet = state.viewersById.get(viewerId).grantSet;
    const result = [];
    for (const document of state.documents) {
      const projection = materialize(document);
      if (!matches(projection, querySet)) continue;
      if (authorized(document, viewerId, grantSet)) result.push(document.id);
    }
    return result;
  }

  return {
    name: 'S1',

    read(viewerId, query, queryIndex) {
      // Normalisation de la requête AVANT toute consultation de cache, et donc
      // exactement une fois par lecture logique — succès comme manque.
      const querySet = normalizeQuery(query);

      let entries = cache.get(viewerId);
      if (entries !== undefined) {
        const hit = entries.get(queryIndex);
        if (hit !== undefined) return hit;
      }
      const result = compute(viewerId, querySet);
      if (entries === undefined) {
        entries = new Map();
        cache.set(viewerId, entries);
      }
      entries.set(queryIndex, result);
      return result;
    },

    onMutation(descriptor) {
      switch (descriptor.kind) {
        case OP_CONTENT_MEMBERSHIP:
        case OP_CONTENT_FILLER: {
          // Une écriture de contenu ne change ni le propriétaire ni les
          // étiquettes : l'ensemble autorisé est le même avant et après.
          const document = descriptor.document;
          let purged = 0;
          for (const viewer of state.viewers) {
            if (authorized(document, viewer.id, viewer.grantSet)) {
              purged += purgeViewer(viewer.id);
            }
          }
          return purged;
        }

        case OP_LABEL: {
          // Un viewer ne détenant ni l'ancienne ni la nouvelle étiquette ne
          // voyait pas le document par grants et ne le verra pas davantage ;
          // s'il le possède, sa visibilité est inchangée.
          const affected = new Set([...descriptor.oldLabels, ...descriptor.newLabels]);
          let purged = 0;
          for (const viewer of state.viewers) {
            for (const label of affected) {
              if (viewer.grantSet.has(label)) {
                purged += purgeViewer(viewer.id);
                break;
              }
            }
          }
          return purged;
        }

        case OP_GRANT:
          return purgeViewer(descriptor.viewerA.id) + purgeViewer(descriptor.viewerB.id);

        case OP_OWNERSHIP:
          return purgeViewer(descriptor.oldOwner) + purgeViewer(descriptor.newOwner);

        default:
          throw new Error(`Mutation inconnue : ${String(descriptor.kind)}`);
      }
    },

    residency() {
      let total = 0;
      for (const entries of cache.values()) total += entries.size;
      return { total, results: total };
    },
  };
}
