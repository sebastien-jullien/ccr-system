/**
 * Agrégation gelée des mesures.
 *
 * Percentiles par RANG LE PLUS PROCHE, sans interpolation :
 *
 * ```text
 * p(q) = trié[ ceil(q * N) - 1 ]
 * ```
 *
 * Les durées sont des `BigInt` de nanosecondes issues de
 * `process.hrtime.bigint()` ; elles ne sont jamais converties en flottant avant
 * le tri.
 */

/** Tri croissant d'un tableau de `BigInt`. */
export function sortDurations(values) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Percentile par rang le plus proche. `sorted` doit déjà être trié. */
export function nearestRank(sorted, quantile) {
  if (sorted.length === 0) return null;
  const index = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

/** p50 et p95 d'un échantillon de durées, en nanosecondes. */
export function percentiles(values) {
  const sorted = sortDurations(values);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
  };
}

/** Médiane d'un petit échantillon de nombres — rang le plus proche également. */
export function medianOf(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.ceil(0.5 * sorted.length) - 1];
}

/** Résumé médiane / min / max d'un petit échantillon de ratios. */
export function summarize(numbers) {
  if (numbers.length === 0) return { median: null, min: null, max: null };
  return {
    median: medianOf(numbers),
    min: Math.min(...numbers),
    max: Math.max(...numbers),
  };
}

/** Sérialise un `BigInt` de nanosecondes en nombre, pour le rapport JSON. */
export function toNanos(value) {
  return value === null ? null : Number(value);
}

/** Ratio d'un p95 de stratégie au p95 de la REFERENCE de la MÊME trace. */
export function ratioOf(strategyP95, referenceP95) {
  if (strategyP95 === null || referenceP95 === null || referenceP95 === 0n) return null;
  return Number(strategyP95) / Number(referenceP95);
}
