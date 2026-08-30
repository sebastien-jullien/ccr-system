/**
 * Moteur de rejeu d'une trace configurée contre une stratégie.
 *
 * Module purement organisationnel : il n'introduit aucune sémantique. Il assemble
 * l'état initial, le squelette de charge et une stratégie, puis exécute les 2 200
 * opérations en respectant les frontières de mesure gelées.
 *
 * Frontières de chronométrage :
 *
 * ```text
 * départ  immédiatement avant l'invocation logique de lecture
 * arrêt   immédiatement après que le résultat ORDONNÉ COMPLET existe
 * ```
 *
 * Le chargement du module, la construction de l'état et le décodage de la trace
 * sont hors mesure.
 */

import {
  MEASUREMENT_OPERATIONS,
  MUTATION_KINDS,
  OP_READ,
  STRATEGY_REFERENCE,
  STRATEGY_S1,
  STRATEGY_S2,
  STRATEGY_S3,
  WARMUP_OPERATIONS,
} from './constants.mjs';
import { buildInitialState, applyMutation, stateDigest } from './state.mjs';
import { buildSkeleton, resolveRead } from './trace.mjs';
import { createReference } from './reference.mjs';
import { createS1 } from './strategies/s1.mjs';
import { createS2 } from './strategies/s2.mjs';
import { createS3 } from './strategies/s3.mjs';

const FACTORIES = {
  [STRATEGY_REFERENCE]: createReference,
  [STRATEGY_S1]: createS1,
  [STRATEGY_S2]: createS2,
  [STRATEGY_S3]: createS3,
};

/** Construit une stratégie nommée sur un état donné. */
export function createStrategy(name, state) {
  const factory = FACTORIES[name];
  if (factory === undefined) throw new Error(`Stratégie inconnue : ${String(name)}`);
  return factory(state);
}

/**
 * Exécute un rejeu complet.
 *
 * @param {object} options
 * @param {number} options.classCount
 * @param {number} options.privateCount
 * @param {number} options.seedOrdinal
 * @param {string} options.strategy
 * @param {(info: object) => void} [options.observer] appelé après chaque lecture
 */
export function runReplay(options) {
  const {
    classCount, privateCount, seedOrdinal, strategy: strategyName, observer,
  } = options;

  const state = buildInitialState(classCount, privateCount);
  const initialDigest = stateDigest(state);
  const skeleton = buildSkeleton(seedOrdinal);
  const strategy = createStrategy(strategyName, state);

  const readDurations = [];
  const mutationDurations = new Map(MUTATION_KINDS.map((kind) => [kind, []]));
  const mutationCounts = new Map(MUTATION_KINDS.map((kind) => [kind, 0]));
  const mutationEntries = new Map(MUTATION_KINDS.map((kind) => [kind, 0]));

  let residencyAfterWarmup = null;
  let residencyPeak = 0;
  let residencyPeakSnapshot = null;

  for (let index = 0; index < skeleton.length; index += 1) {
    const operation = skeleton[index];
    const measured = index >= WARMUP_OPERATIONS;

    if (index === WARMUP_OPERATIONS) {
      residencyAfterWarmup = strategy.residency();
      residencyPeak = residencyAfterWarmup.total;
      residencyPeakSnapshot = residencyAfterWarmup;
    }

    if (operation.kind === OP_READ) {
      const read = resolveRead(operation);
      const started = process.hrtime.bigint();
      const result = strategy.read(read.viewerId, read.query, read.queryIndex);
      const finished = process.hrtime.bigint();
      if (measured) readDurations.push(finished - started);
      if (observer !== undefined) {
        observer({ index, measured, ...read, result, strategy: strategyName });
      }
    } else {
      const started = process.hrtime.bigint();
      const descriptor = applyMutation(state, operation);
      const invalidated = strategy.onMutation(descriptor);
      const finished = process.hrtime.bigint();
      if (measured) {
        mutationDurations.get(operation.kind).push(finished - started);
        mutationCounts.set(operation.kind, mutationCounts.get(operation.kind) + 1);
        mutationEntries.set(operation.kind, mutationEntries.get(operation.kind) + invalidated);
      }
    }

    if (measured) {
      const residency = strategy.residency();
      if (residency.total > residencyPeak) {
        residencyPeak = residency.total;
        residencyPeakSnapshot = residency;
      }
    }
  }

  return {
    strategy: strategyName,
    classCount,
    privateCount,
    seedOrdinal,
    initialStateDigest: initialDigest,
    operations: skeleton.length,
    measuredOperations: MEASUREMENT_OPERATIONS,
    readDurations,
    mutationDurations,
    mutationCounts,
    mutationEntries,
    residency: {
      afterWarmup: residencyAfterWarmup,
      peak: residencyPeakSnapshot,
      end: strategy.residency(),
    },
  };
}
