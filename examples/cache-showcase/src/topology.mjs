/**
 * Topologie gelée des classes de grants.
 *
 * Une classe est un ensemble de 5 grants distincts parmi 11, soit
 * `C(11,5) = 462` candidats. La suite imbriquée est construite gloutonnement,
 * et les préfixes 4 / 40 / 400 sont ceux que les configurations emploient.
 *
 * Départage, dans cet ordre exact :
 *
 * ```text
 * 1  RANGE d'incidence résultante
 * 2  BALANCE_SSE = Σ (11 * incidence_i - 5 * nombreDeClassesSélectionnées)^2
 * 3  octets bruts de SHA-256(graine ‖ 0x00 ‖ classe canonique), croissants
 * 4  classe canonique croissante
 * ```
 */

import { CLASS_SIZE, GRANTS, GRANT_CLASS_SEED, GRANT_COUNT } from './constants.mjs';
import { NUL, compareRank, digestOf } from './prng.mjs';

/** Sérialisation canonique d'une classe. Injective, lisible, décodable. */
export function canonicalClass(grants) {
  return JSON.stringify([...grants].sort());
}

/** Les 462 candidats, chacun avec son masque, sa forme canonique et son rang. */
function buildCandidates() {
  const candidates = [];
  const walk = (start, acc) => {
    if (acc.length === CLASS_SIZE) {
      const grants = [...acc].sort();
      const key = canonicalClass(grants);
      candidates.push({
        grants,
        mask: grants.map((grant) => GRANTS.indexOf(grant)),
        key,
        digest: digestOf(`${GRANT_CLASS_SEED}${NUL}${key}`),
      });
      return;
    }
    for (let i = start; i < GRANT_COUNT; i += 1) {
      acc.push(GRANTS[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return candidates;
}

let nestedSequenceCache = null;

/**
 * Suite imbriquée complète — 400 classes, gloutonnement sélectionnées.
 *
 * Le résultat est mémoïsé : il ne dépend d'aucune configuration, et le
 * recalculer par appel coûterait sans rien changer.
 */
export function nestedClassSequence() {
  if (nestedSequenceCache !== null) return nestedSequenceCache;

  const candidates = buildCandidates();
  const taken = new Set();
  const incidence = new Array(GRANT_COUNT).fill(0);
  const selected = [];

  for (let step = 1; step <= 400; step += 1) {
    let best = null;
    let bestRange = Infinity;
    let bestSse = Infinity;

    for (const candidate of candidates) {
      if (taken.has(candidate.key)) continue;

      let min = Infinity;
      let max = -Infinity;
      let sse = 0;
      for (let g = 0; g < GRANT_COUNT; g += 1) {
        const value = incidence[g] + (candidate.mask.includes(g) ? 1 : 0);
        if (value < min) min = value;
        if (value > max) max = value;
        const delta = GRANT_COUNT * value - CLASS_SIZE * step;
        sse += delta * delta;
      }
      const range = max - min;

      if (best === null
        || range < bestRange
        || (range === bestRange && sse < bestSse)
        || (range === bestRange && sse === bestSse && compareRank(candidate, best) < 0)) {
        best = candidate;
        bestRange = range;
        bestSse = sse;
      }
    }

    taken.add(best.key);
    selected.push(best);
    for (const g of best.mask) incidence[g] += 1;
  }

  nestedSequenceCache = selected.map((candidate) => Object.freeze({
    grants: Object.freeze([...candidate.grants]),
    key: candidate.key,
  }));
  return nestedSequenceCache;
}

/** Préfixe de `count` classes de la suite imbriquée. */
export function classesFor(count) {
  return nestedClassSequence().slice(0, count);
}

/** Vecteur d'incidence trié croissant d'un préfixe — sert aux invariants gelés. */
export function incidenceVector(count) {
  const incidence = new Array(GRANT_COUNT).fill(0);
  for (const entry of classesFor(count)) {
    for (const grant of entry.grants) incidence[GRANTS.indexOf(grant)] += 1;
  }
  return incidence.sort((a, b) => a - b);
}

/**
 * Attribution initiale des classes aux viewers : `viewer i → classe i mod n`.
 *
 * Donne 100 / 10 / 1 viewer(s) par classe pour 4 / 40 / 400 classes.
 */
export function initialClassAssignment(classCount) {
  const classes = classesFor(classCount);
  return (viewerIndex) => classes[viewerIndex % classCount];
}
