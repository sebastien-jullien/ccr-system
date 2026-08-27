/**
 * Catalogue tarifaire versionné (CCR V2.2, `V2.2-IMP-11`).
 *
 * Module **pur** : aucune entrée/sortie, aucun réseau, aucune connaissance des
 * fournisseurs. Il définit ce qu'une règle tarifaire est, et ce qu'un document
 * doit prouver pour en porter.
 *
 * ## Ce qu'il n'est pas
 *
 * Ni un calcul, ni une facture, ni un budget. Aucun montant n'est multiplié
 * ici, et `CostEstimate` n'existe pas encore. Ce module décrit des **règles**,
 * pas des observations : il ignore les journaux d'invocations et d'usage.
 *
 * ## Catégories par fournisseur
 *
 * Les compteurs de jetons sont une union discriminée par moteur — Claude exclut
 * le cache de son `input_tokens` là où Codex l'y inclut. Une règle qui
 * prétendrait tarifer `reasoning_output_tokens` sur Claude nommerait donc un
 * compteur qui n'existe pas de ce côté, et le futur estimateur appliquerait un
 * prix à une sémantique étrangère. Les catégories sont donc **fermées par
 * fournisseur**, et reprises telles quelles du contrat d'usage.
 *
 * ## Taux : une chaîne décimale, et pourquoi
 *
 * Un tarif s'écrit couramment `0.000003` par jeton. Confié à un `number`, il
 * devient un binaire approché dès la lecture, et l'erreur se propage
 * silencieusement dans une multiplication par des millions de jetons. Le
 * catalogue conserve donc la **forme décimale exacte** telle qu'elle a été
 * écrite ; le futur estimateur choisira son arithmétique en partant d'un
 * chiffre fidèle plutôt que d'un flottant déjà dégradé.
 *
 * Les types monétaires déjà gelés — `ProviderReportedCost.amount` — ne sont pas
 * touchés : ils décrivent une valeur qu'un tiers a **calculée**, là où un taux
 * est une donnée d'entrée que CCR relit.
 *
 * ## Zéro explicite
 *
 * Un taux nul est valide, et il ne se confond pas avec un taux absent. Le
 * premier dit « cette catégorie est connue de la règle, et son coût est nul » ;
 * le second dit « cette règle ne sait pas traiter cette catégorie ». C'est
 * exactement la distinction dont `UNSUPPORTED_USAGE_SHAPE` a besoin.
 */

import { CcrError } from './errors.ts';

export const PRICING_CATALOG_SCHEMA_VERSION = 1;

/** Versions de catalogue que cette version de CCR sait lire. */
export const SUPPORTED_PRICING_CATALOG_SCHEMA_VERSIONS: readonly number[] = [1];

export const PRICING_PROVIDERS = ['claude', 'codex'] as const;
export type PricingProvider = (typeof PRICING_PROVIDERS)[number];

/**
 * Catégories tarifables, **par fournisseur**.
 *
 * Reprises mot pour mot des compteurs que chaque moteur publie. Aucune
 * catégorie générique : ni `total_tokens`, ni `all_input`, ni `all_output`.
 */
export const PRICING_CATEGORIES: Readonly<Record<PricingProvider, readonly string[]>> = {
  claude: [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ],
  codex: [
    'input_tokens',
    'output_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'reasoning_output_tokens',
  ],
};

/**
 * Provenance déclarée du catalogue.
 *
 * Obligatoire : un tarif sans origine ni date ne peut être ni vérifié, ni
 * périmé. Les clés sont fermées — la provenance n'est pas un sac JSON.
 */
export interface PricingCatalogSource {
  /** Qui affirme ces taux. */
  readonly identifier: string;
  /** Où ils ont été relevés — référence citable, jamais une garantie. */
  readonly reference: string;
  /** Date de relevé, déclarée par celui qui l'a fait. */
  readonly declared_at: string;
}

export interface PricingRule {
  readonly provider: PricingProvider;
  /** Identité exacte du modèle observé. Aucun joker, aucune normalisation. */
  readonly model: string;
  readonly usage_category: string;
  /** Forme décimale exacte, conservée telle qu'écrite. */
  readonly rate: string;
  /** Nombre d'unités d'usage auquel `rate` s'applique. Jamais zéro. */
  readonly unit_scale: number;
}

export interface PricingCatalog {
  readonly schema_version: number;
  /** Identifiant opaque, cité plus tard par toute estimation. */
  readonly catalog_version: string;
  readonly currency: string;
  readonly source: PricingCatalogSource;
  readonly entries: readonly PricingRule[];
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

const ROOT_KEYS: readonly string[] = [
  'schema_version',
  'catalog_version',
  'currency',
  'source',
  'entries',
];
const SOURCE_KEYS: readonly string[] = ['identifier', 'reference', 'declared_at'];
const ENTRY_KEYS: readonly string[] = ['provider', 'model', 'usage_category', 'rate', 'unit_scale'];

/**
 * Identifiant de version.
 *
 * Opaque, mais pas quelconque : il participe à la résolution d'un nom de
 * fichier, et un identifiant libre y ouvrirait une traversée de chemin. La
 * contrainte porte sur les caractères, jamais sur une sémantique — ni semver,
 * ni date, ni version de fournisseur n'est exigée.
 */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Devise, forme canonique. Aucune conversion n'existe, ni n'existera ici. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Décimale canonique, sans signe ni exposant.
 *
 * `1e-6` est refusé : la notation scientifique se relit trop facilement de
 * travers, et un tarif se lit autant qu'il se calcule. La virgule décimale
 * l'est aussi — elle vaut mille fois plus ou moins selon la locale du lecteur.
 */
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function invalid(message: string, details: Record<string, unknown> = {}): CcrError {
  return new CcrError('PRICING_CATALOG_INVALID', message, { details });
}

function assertClosedKeys(record: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    throw invalid(`catalogue tarifaire : champ « ${key} » inconnu dans ${at}.`, { at, field: key });
  }
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`catalogue tarifaire : ${at} doit être un objet JSON.`, { at });
  }
  return value as Record<string, unknown>;
}

function requireText(record: Record<string, unknown>, field: string, at: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`catalogue tarifaire : « ${field} » doit être une chaîne non vide.`, {
      at,
      field,
    });
  }
  return value;
}

/** Vrai pour un identifiant de version utilisable comme nom de fichier. */
export function isPricingCatalogVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value) && value !== '.' && value !== '..';
}

function validateSource(value: unknown): PricingCatalogSource {
  const record = asRecord(value, 'source');
  assertClosedKeys(record, SOURCE_KEYS, 'source');

  const declaredAt = requireText(record, 'declared_at', 'source');
  if (Number.isNaN(Date.parse(declaredAt))) {
    throw invalid('catalogue tarifaire : « source.declared_at » doit être une date lisible.', {
      at: 'source.declared_at',
    });
  }

  return {
    identifier: requireText(record, 'identifier', 'source'),
    reference: requireText(record, 'reference', 'source'),
    declared_at: declaredAt,
  };
}

function validateRule(value: unknown, index: number): PricingRule {
  const at = `entries[${String(index)}]`;
  const record = asRecord(value, at);
  assertClosedKeys(record, ENTRY_KEYS, at);

  const provider = record['provider'];
  if (provider !== 'claude' && provider !== 'codex') {
    throw invalid(`catalogue tarifaire : ${at}.provider inconnu (${String(provider)}).`, {
      at,
      field: 'provider',
    });
  }

  const model = requireText(record, 'model', at);

  const category = record['usage_category'];
  if (typeof category !== 'string' || !PRICING_CATEGORIES[provider].includes(category)) {
    throw invalid(
      `catalogue tarifaire : ${at}.usage_category « ${String(category)} » n'existe pas pour ` +
        `« ${provider} ». Les compteurs des deux moteurs ne se composent pas de la même façon : ` +
        "leur prêter une catégorie commune tariferait une sémantique étrangère.",
      { at, field: 'usage_category', provider, allowed: [...PRICING_CATEGORIES[provider]] },
    );
  }

  const rate = record['rate'];
  if (typeof rate !== 'string' || !DECIMAL_PATTERN.test(rate)) {
    throw invalid(
      `catalogue tarifaire : ${at}.rate doit être une décimale canonique — ni signe, ni ` +
        'exposant, ni virgule, ni espace.',
      { at, field: 'rate', found: typeof rate === 'string' ? rate : null },
    );
  }

  const scale = record['unit_scale'];
  if (typeof scale !== 'number' || !Number.isSafeInteger(scale) || scale <= 0) {
    throw invalid(
      `catalogue tarifaire : ${at}.unit_scale doit être un entier strictement positif et ` +
        "exactement représentable. C'est lui qui empêche une erreur silencieuse d'un facteur " +
        'un million.',
      { at, field: 'unit_scale' },
    );
  }

  return { provider, model, usage_category: category, rate, unit_scale: scale };
}

/**
 * Valide un catalogue, sans aucune coercition.
 *
 * Une clé `(provider, model, usage_category)` en double rend le document
 * invalide : ni la première, ni la dernière, ni leur somme. Deux prix pour la
 * même chose est une contradiction, pas une préférence à arbitrer.
 */
export function validatePricingCatalog(value: unknown): PricingCatalog {
  const record = asRecord(value, 'le catalogue');
  assertClosedKeys(record, ROOT_KEYS, 'le catalogue');

  const version = record['schema_version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw invalid('catalogue tarifaire : « schema_version » doit être un entier JSON.', {
      at: 'schema_version',
    });
  }
  if (!SUPPORTED_PRICING_CATALOG_SCHEMA_VERSIONS.includes(version)) {
    throw invalid(
      `catalogue tarifaire : schema_version ${String(version)} non supportée par cette version de CCR.`,
      { at: 'schema_version', supported: [...SUPPORTED_PRICING_CATALOG_SCHEMA_VERSIONS] },
    );
  }

  const catalogVersion = record['catalog_version'];
  if (!isPricingCatalogVersion(catalogVersion)) {
    throw invalid(
      'catalogue tarifaire : « catalog_version » doit être un identifiant non vide, limité aux ' +
        'lettres, chiffres, point, tiret et tiret bas.',
      { at: 'catalog_version' },
    );
  }

  const currency = record['currency'];
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw invalid(
      'catalogue tarifaire : « currency » doit être un code de trois lettres majuscules. ' +
        'Aucune conversion de devise n\'existe.',
      { at: 'currency' },
    );
  }

  const source = validateSource(record['source']);

  const rawEntries = record['entries'];
  if (!Array.isArray(rawEntries)) {
    throw invalid('catalogue tarifaire : « entries » doit être un tableau.', { at: 'entries' });
  }

  const entries: PricingRule[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawEntries.entries()) {
    const rule = validateRule(raw, index);
    const key = `${rule.provider} ${rule.model} ${rule.usage_category}`;
    if (seen.has(key)) {
      throw invalid(
        `catalogue tarifaire : entries[${String(index)}] redéfinit ` +
          `(${rule.provider}, ${rule.model}, ${rule.usage_category}). Deux prix pour la même ` +
          "chose est une contradiction, et CCR n'en choisit aucun.",
        { at: `entries[${String(index)}]`, provider: rule.provider, model: rule.model },
      );
    }
    seen.add(key);
    entries.push(rule);
  }

  return { schema_version: version, catalog_version: catalogVersion, currency, source, entries };
}

/** Règle applicable à un couple, ou `undefined`. Aucun repli, aucun joker. */
export function findPricingRule(
  catalog: PricingCatalog,
  provider: PricingProvider,
  model: string,
  usageCategory: string,
): PricingRule | undefined {
  return catalog.entries.find(
    (entry) =>
      entry.provider === provider &&
      entry.model === model &&
      entry.usage_category === usageCategory,
  );
}
