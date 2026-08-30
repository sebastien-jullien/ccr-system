/**
 * S2 — réponse partagée visible par grants (Part-1) + surcouche de propriété
 * propre au viewer (Part-2).
 *
 * Décomposition exacte, et non approchée :
 *
 * ```text
 * oracle(v, q) = { d ∈ q : grants(v) ∩ labels(d) ≠ ∅ }   ← ne dépend que des grants
 *              ∪ { d ∈ q : owner(d) = v }                 ← ne dépend que de v
 * ```
 *
 * Double manque : UNE seule traversée, une matérialisation par document, un
 * appariement par document, puis les deux prédicats évalués indépendamment.
 * Manque simple : la région touchée seule est calculée — une région en succès
 * n'est JAMAIS recalculée parce que l'autre a manqué.
 *
 * Invalidation fondée sur l'ESPACE DE CLÉS RÉSIDENT, jamais sur les viewers
 * actifs : une entrée Part-1 survit à tous les occupants de sa classe.
 */

import {
  OP_CONTENT_FILLER,
  OP_CONTENT_MEMBERSHIP,
  OP_GRANT,
  OP_LABEL,
  OP_OWNERSHIP,
} from '../constants.mjs';
import { grantVisible, materialize, matches, normalizeQuery } from '../query.mjs';
import { liveGrantClass } from '../state.mjs';

/** Union, déduplication, ordre stable croissant d'identifiant. */
function assemble(part1, part2) {
  if (part2.length === 0) return part1;
  if (part1.length === 0) return part2;
  const seen = new Set(part1);
  const merged = [...part1];
  for (const id of part2) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  merged.sort();
  return merged;
}

export function createS2(state) {
  /** @type {Map<string, Map<number, string[]>>} clé Part-1 : classe canonique */
  const part1 = new Map();
  /** @type {Map<string, Map<number, string[]>>} clé Part-2 : viewer */
  const part2 = new Map();

  function purgeRegion(region, key) {
    const entries = region.get(key);
    if (entries === undefined) return 0;
    const count = entries.size;
    region.delete(key);
    return count;
  }

  function store(region, key, queryIndex, value) {
    let entries = region.get(key);
    if (entries === undefined) {
      entries = new Map();
      region.set(key, entries);
    }
    entries.set(queryIndex, value);
  }

  /**
   * Traversée unique. `wantPart1` et `wantPart2` disent quelles régions doivent
   * être produites ; la matérialisation et l'appariement n'ont lieu qu'une fois.
   */
  function traverse(querySet, grantSet, viewerId, wantPart1, wantPart2) {
    const first = wantPart1 ? [] : null;
    const second = wantPart2 ? [] : null;

    for (const document of state.documents) {
      const projection = materialize(document);
      if (!matches(projection, querySet)) continue;
      if (wantPart1 && grantVisible(document, grantSet)) first.push(document.id);
      if (wantPart2 && document.owner === viewerId) second.push(document.id);
    }

    return { first, second };
  }

  return {
    name: 'S2',

    read(viewerId, query, queryIndex) {
      // Normalisation de la requête AVANT toute consultation de cache, et donc
      // exactement une fois par lecture logique — double succès compris.
      const querySet = normalizeQuery(query);

      const viewer = state.viewersById.get(viewerId);
      const classKey = liveGrantClass(viewer);

      const classEntries = part1.get(classKey);
      const viewerEntries = part2.get(viewerId);
      const hit1 = classEntries === undefined ? undefined : classEntries.get(queryIndex);
      const hit2 = viewerEntries === undefined ? undefined : viewerEntries.get(queryIndex);

      const need1 = hit1 === undefined;
      const need2 = hit2 === undefined;

      if (!need1 && !need2) return assemble(hit1, hit2);

      const { first, second } = traverse(querySet, viewer.grantSet, viewerId, need1, need2);

      const resolved1 = need1 ? first : hit1;
      const resolved2 = need2 ? second : hit2;

      // Un résultat vide EST un résultat mis en cache valide.
      if (need1) store(part1, classKey, queryIndex, resolved1);
      if (need2) store(part2, viewerId, queryIndex, resolved2);

      return assemble(resolved1, resolved2);
    },

    onMutation(descriptor) {
      switch (descriptor.kind) {
        case OP_CONTENT_MEMBERSHIP:
        case OP_CONTENT_FILLER: {
          const document = descriptor.document;
          let purged = 0;
          // Classes RÉSIDENTES, énumérées depuis l'espace de clés du cache.
          for (const classKey of [...part1.keys()]) {
            const grants = JSON.parse(classKey);
            if (grants.some((grant) => document.labels.includes(grant))) {
              purged += purgeRegion(part1, classKey);
            }
          }
          purged += purgeRegion(part2, document.owner);
          return purged;
        }

        case OP_LABEL: {
          const affected = new Set([...descriptor.oldLabels, ...descriptor.newLabels]);
          let purged = 0;
          for (const classKey of [...part1.keys()]) {
            const grants = JSON.parse(classKey);
            if (grants.some((grant) => affected.has(grant))) {
              purged += purgeRegion(part1, classKey);
            }
          }
          // Part-2 ne dépend pas des étiquettes : la propriété n'est pas
          // gouvernée par elles, et les étiquettes ne sont pas indexables.
          return purged;
        }

        case OP_GRANT:
          // Le viewer se réachemine entre classes canoniques à la lecture
          // suivante. Aucune invalidation du cache partagé.
          return 0;

        case OP_OWNERSHIP:
          return purgeRegion(part2, descriptor.oldOwner) + purgeRegion(part2, descriptor.newOwner);

        default:
          throw new Error(`Mutation inconnue : ${String(descriptor.kind)}`);
      }
    },

    residency() {
      let one = 0;
      let two = 0;
      for (const entries of part1.values()) one += entries.size;
      for (const entries of part2.values()) two += entries.size;
      return { part1: one, part2: two, total: one + two, classes: part1.size };
    },
  };
}
