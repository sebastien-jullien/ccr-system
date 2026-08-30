/**
 * Constantes gelées du showcase « stratégies de cache ».
 *
 * Aucune valeur de ce module n'est un choix d'implémentation : toutes
 * proviennent du contrat expérimental gelé. Les modifier invaliderait toute
 * mesure produite ensuite.
 */

// --------------------------------------------------------------------------
// Échelle
// --------------------------------------------------------------------------

export const DOCUMENT_COUNT = 400;
export const VIEWER_COUNT = 400;
export const BODY_TOKEN_COUNT = 96;
export const FILLER_TOKEN_COUNT = BODY_TOKEN_COUNT - 2; // 94

export const TOPIC_COUNT = 8;
export const FACET_COUNT = 4;
export const FILLER_COUNT = 256;
export const GRANT_COUNT = 11;
export const CLASS_SIZE = 5;

export const CLASS_COUNTS = Object.freeze([4, 40, 400]);
export const OWNERSHIP_DENSITIES = Object.freeze([10, 35, 70]);
export const PRIVATE_COUNTS = Object.freeze([40, 140, 280]);
export const WORKLOAD_SEED_ORDINALS = Object.freeze([1, 2, 3]);

// --------------------------------------------------------------------------
// Graines
// --------------------------------------------------------------------------

export const CORPUS_SEED = 'ccr-cache-showcase-corpus-v1';
export const GRANT_CLASS_SEED = 'ccr-cache-showcase-grant-classes-v1';
export const OWNER_RANKING_SEED = 'ccr-cache-showcase-owner-ranking-v1';
export const PRIVATE_RANKING_SEED = 'ccr-cache-showcase-private-ranking-v1';
export const WORKLOAD_SEED_PREFIX = 'ccr-cache-showcase-workload-v1:s';

// --------------------------------------------------------------------------
// Vocabulaires canoniques
// --------------------------------------------------------------------------

const pad = (value, width) => String(value).padStart(width, '0');

export const DOCUMENT_IDS = Object.freeze(
  Array.from({ length: DOCUMENT_COUNT }, (_, i) => `doc-${pad(i, 3)}`),
);
export const VIEWER_IDS = Object.freeze(
  Array.from({ length: VIEWER_COUNT }, (_, i) => `viewer-${pad(i, 3)}`),
);
export const TOPICS = Object.freeze(
  Array.from({ length: TOPIC_COUNT }, (_, i) => `topic-${pad(i, 2)}`),
);
export const FACETS = Object.freeze(
  Array.from({ length: FACET_COUNT }, (_, i) => `facet-${pad(i, 2)}`),
);
export const FILLERS = Object.freeze(
  Array.from({ length: FILLER_COUNT }, (_, i) => `word-${pad(i, 3)}`),
);
export const GRANTS = Object.freeze(
  Array.from({ length: GRANT_COUNT }, (_, i) => `grant-${pad(i, 2)}`),
);

/** Étiquette spéciale, jamais octroyable. */
export const PRIVATE_LABEL = 'private';

// --------------------------------------------------------------------------
// Requêtes canoniques — ordre topic-majeur puis facet-mineur
// --------------------------------------------------------------------------

export const QUERIES = Object.freeze(
  TOPICS.flatMap((topic) => FACETS.map((facet) => Object.freeze({ topic, facet }))),
);
export const QUERY_COUNT = QUERIES.length; // 32

// --------------------------------------------------------------------------
// Trace
// --------------------------------------------------------------------------

export const BLOCK_SIZE = 100;
export const READS_PER_BLOCK = 95;
export const WARMUP_OPERATIONS = 200;
export const MEASUREMENT_OPERATIONS = 2000;
export const WARMUP_BLOCKS = WARMUP_OPERATIONS / BLOCK_SIZE; // 2
export const MEASUREMENT_BLOCKS = MEASUREMENT_OPERATIONS / BLOCK_SIZE; // 20
export const TOTAL_BLOCKS = WARMUP_BLOCKS + MEASUREMENT_BLOCKS; // 22
export const MEASURED_READS = MEASUREMENT_BLOCKS * READS_PER_BLOCK; // 1900

export const OP_READ = 'READ';
export const OP_CONTENT_MEMBERSHIP = 'CONTENT_MEMBERSHIP_WRITE';
export const OP_CONTENT_FILLER = 'CONTENT_FILLER_WRITE';
export const OP_LABEL = 'LABEL_MUTATION';
export const OP_GRANT = 'GRANT_MUTATION';
export const OP_OWNERSHIP = 'OWNERSHIP_MUTATION';

/** Nombre de tirages de charge utile, par nature d'opération. */
export const PAYLOAD_DRAWS = Object.freeze({
  [OP_READ]: 2,
  [OP_CONTENT_MEMBERSHIP]: 3,
  [OP_CONTENT_FILLER]: 3,
  [OP_LABEL]: 2,
  [OP_GRANT]: 2,
  [OP_OWNERSHIP]: 2,
});

export const MUTATION_KINDS = Object.freeze([
  OP_CONTENT_MEMBERSHIP,
  OP_CONTENT_FILLER,
  OP_LABEL,
  OP_GRANT,
  OP_OWNERSHIP,
]);

/**
 * Composition canonique d'un bloc, AVANT mélange.
 *
 * Positions 0..94 lectures, puis les cinq mutations dans l'ordre gelé.
 */
export const CANONICAL_BLOCK = Object.freeze([
  ...Array.from({ length: READS_PER_BLOCK }, () => OP_READ),
  OP_CONTENT_MEMBERSHIP,
  OP_CONTENT_FILLER,
  OP_LABEL,
  OP_GRANT,
  OP_OWNERSHIP,
]);

// --------------------------------------------------------------------------
// Stratégies
// --------------------------------------------------------------------------

export const STRATEGY_REFERENCE = 'REFERENCE';
export const STRATEGY_S1 = 'S1';
export const STRATEGY_S2 = 'S2';
export const STRATEGY_S3 = 'S3';

/** Ordre de rejeu de base ; la rotation gauche par `ordinal mod 4` s'y applique. */
export const BASE_REPLAY_ORDER = Object.freeze([
  STRATEGY_REFERENCE,
  STRATEGY_S1,
  STRATEGY_S2,
  STRATEGY_S3,
]);

/** Cible d'auteur, figée avant toute mesure. Ce n'est pas un seuil universel. */
export const R1_TARGET_RATIO = 0.4;

/** Version de contenu initiale d'un document. */
export const INITIAL_CONTENT_VERSION = 0;
