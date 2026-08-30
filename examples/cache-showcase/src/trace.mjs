/**
 * Squelette de charge et trace configurée.
 *
 * Le squelette ne dépend NI du nombre de classes NI de la densité de
 * propriété : une même graine apparie, à travers les neuf configurations,
 * l'ordre des opérations, les lectures, les requêtes, les cibles d'écriture de
 * contenu et les tirages génériques de mutation.
 *
 * Consommation des tirages, par bloc de 100 opérations :
 *
 * ```text
 * 1  tableau canonique : 0..94 READ, puis les cinq mutations dans l'ordre gelé
 * 2  exactement 99 tirages consécutifs — Fisher-Yates i = 99 → 1
 * 3  l'ordre est alors FINAL
 * 4  parcours des positions 0 → 99, charge utile consommée à la rencontre
 * 5  seulement ensuite, bloc suivant
 * ```
 *
 * Aucune charge utile n'est allouée avant le mélange.
 */

import {
  CANONICAL_BLOCK,
  OP_READ,
  PAYLOAD_DRAWS,
  QUERIES,
  QUERY_COUNT,
  TOTAL_BLOCKS,
  VIEWER_IDS,
  WARMUP_OPERATIONS,
  WORKLOAD_SEED_PREFIX,
} from './constants.mjs';
import { INDEX, UINT32_RANGE, generatorFromString } from './prng.mjs';

/** Somme harmonique H_32, calculée une fois. */
const HARMONIC = (() => {
  const partial = new Array(QUERY_COUNT + 1).fill(0);
  for (let k = 1; k <= QUERY_COUNT; k += 1) partial[k] = partial[k - 1] + 1 / k;
  return partial;
})();

export const H32 = HARMONIC[QUERY_COUNT];

/**
 * Sélection zipfienne gelée, exposant 1.0, sans tirage supplémentaire.
 *
 * Rend le premier rang `r` tel que `Σ(k=1..r) 1/k > u * H32`, puis l'index
 * canonique `r - 1`.
 */
export function zipfQueryIndex(draw) {
  const x = (draw / UINT32_RANGE) * H32;
  for (let r = 1; r <= QUERY_COUNT; r += 1) {
    if (HARMONIC[r] > x) return r - 1;
  }
  return QUERY_COUNT - 1;
}

/** Nom canonique de la graine de charge d'un ordinal 1..3. */
export function workloadSeed(ordinal) {
  return `${WORKLOAD_SEED_PREFIX}${ordinal}`;
}

/**
 * Engendre le squelette d'une graine : 22 blocs, ordre final et tirages de
 * charge utile, sans aucune résolution dépendante de la configuration.
 */
export function buildSkeleton(seedOrdinal) {
  const next = generatorFromString(workloadSeed(seedOrdinal));
  const operations = [];

  for (let block = 0; block < TOTAL_BLOCKS; block += 1) {
    // 1-2. Tableau canonique, puis exactement 99 tirages de mélange.
    const ordered = [...CANONICAL_BLOCK];
    for (let i = ordered.length - 1; i >= 1; i -= 1) {
      const j = INDEX(next(), i + 1);
      const swap = ordered[i];
      ordered[i] = ordered[j];
      ordered[j] = swap;
    }

    // 3-4. Ordre final figé, puis charge utile consommée position par position.
    for (const kind of ordered) {
      const draws = [];
      for (let d = 0; d < PAYLOAD_DRAWS[kind]; d += 1) draws.push(next());
      operations.push({ kind, draws });
    }
  }

  return operations;
}

/**
 * Résolution d'une lecture — indépendante de la configuration.
 *
 * Ordre gelé : tirage 1 le viewer, tirage 2 la requête.
 */
export function resolveRead(operation) {
  const viewerIndex = INDEX(operation.draws[0], VIEWER_IDS.length);
  const queryIndex = zipfQueryIndex(operation.draws[1]);
  return {
    viewerId: VIEWER_IDS[viewerIndex],
    viewerIndex,
    queryIndex,
    query: QUERIES[queryIndex],
  };
}

/** Ordinal d'une trace configurée : classes majeures, puis densité, puis graine. */
export function traceOrdinal(classIndex, densityIndex, seedIndex) {
  return classIndex * 9 + densityIndex * 3 + seedIndex;
}

/** Les 27 traces configurées, dans l'ordre d'énumération gelé. */
export function enumerateConfiguredTraces(classCounts, densities, seedOrdinals) {
  const traces = [];
  classCounts.forEach((classCount, classIndex) => {
    densities.forEach((density, densityIndex) => {
      seedOrdinals.forEach((seedOrdinal, seedIndex) => {
        traces.push({
          ordinal: traceOrdinal(classIndex, densityIndex, seedIndex),
          classCount,
          density,
          seedOrdinal,
        });
      });
    });
  });
  return traces.sort((a, b) => a.ordinal - b.ordinal);
}

/** Une opération appartient-elle à la fenêtre de mesure ? */
export function isMeasured(operationIndex) {
  return operationIndex >= WARMUP_OPERATIONS;
}

/** Nombre de lectures dans la fenêtre de mesure d'un squelette. */
export function countMeasuredReads(skeleton) {
  let count = 0;
  for (let i = WARMUP_OPERATIONS; i < skeleton.length; i += 1) {
    if (skeleton[i].kind === OP_READ) count += 1;
  }
  return count;
}
