/**
 * Lecture d'usage, par invocation d'abord (CCR V2.2, `V2.2-IMP-10`).
 *
 * ## L'univers est le journal d'invocations
 *
 * `InvocationLedger` dit ce que CCR a **engagé** ; `UsageLedger` dit ce qui a été
 * **observé** de ces engagements. Compter les observations reviendrait à compter
 * deux fois une invocation ordinaire, qui en porte normalement deux — une du
 * fournisseur, une de CCR. Le total d'invocations vient donc du seul journal
 * d'invocations, toujours.
 *
 * ## Trois états, jamais un choix arbitraire
 *
 * ```text
 * 0 observation d'une provenance   UNOBSERVED
 * 1 observation                    OBSERVED
 * plusieurs                        AMBIGUOUS
 * ```
 *
 * Le contrat ne donne aucune règle de composition pour deux observations de
 * même provenance : enrichissement tardif, duplicat, remplacement et fragments
 * partiels sont indiscernables sur les seuls champs persistés. Sommer ou
 * retenir la dernière serait un choix déguisé en arithmétique. L'ambiguïté est
 * donc **rendue**, et l'invocation reste comptée.
 *
 * Les deux provenances sont jugées séparément : une observation fournisseur
 * ambiguë ne détruit pas une mesure CCR parfaitement claire.
 *
 * ## Ce qui n'est jamais zéro
 *
 * Une invocation sans observation n'a pas zéro jeton : elle a un usage inconnu.
 * Chaque dimension porte donc sa propre couverture — combien d'invocations l'ont
 * renseignée, combien ne l'ont pas — et toute somme est explicitement partielle.
 *
 * ## Ce qui n'est jamais totalisé
 *
 * Les jetons ne se somment qu'à l'intérieur d'un fournisseur. Claude exclut le
 * cache de son `input_tokens` là où Codex l'y inclut, et rien n'établit que les
 * sorties se composent pareillement. Il n'existe donc ni `total_tokens`, ni
 * total inter-fournisseurs — et aucun tarif, aucun coût estimé.
 */

import { findOrphanUsageObservations } from '../core/usage-governance.ts';
import type {
  InvocationDispatchRecord,
  InvocationIdentity,
  InvocationTriggerKind,
  UsageObservationRecord,
} from '../core/usage-governance.ts';
import type { UsageProvenance, UsageTokens } from '../core/usage.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { openUsageLedger } from '../store/usage-ledger.ts';
import { pathExists } from '../store/atomic-file.ts';
import type { RunPaths } from '../store/layout.ts';

// --------------------------------------------------------------------------
// Contrat rendu
// --------------------------------------------------------------------------

/**
 * Moteur joint, tel que **le journal d'invocations** le nomme.
 *
 * Dérivé du contrat de gouvernance, et non du vocabulaire d'experts natifs :
 * cette lecture sert les deux générations, et n'a pas à connaître le modèle
 * d'un moteur pour lire l'autre.
 */
type ProviderKind = InvocationIdentity['provider'];

/** Vocabulaire gelé, partagé avec la lecture de quota. */
export type UsageCoverage = 'PRE_LEDGER' | 'SINCE_LEDGER_START';

export type UsageProvenanceState = 'UNOBSERVED' | 'OBSERVED' | 'AMBIGUOUS';

/** Partition d'un ensemble d'invocations selon l'état d'une provenance. */
export interface UsageProvenancePartition {
  readonly observed: number;
  readonly unobserved: number;
  readonly ambiguous: number;
}

/**
 * Une dimension de jetons, avec sa couverture.
 *
 * `observed_sum` n'a de sens qu'accompagné de ce qu'il ne couvre pas :
 * `unknown_invocations` est la part que cette somme ignore, et qui ne vaut
 * jamais zéro.
 */
export interface UsageDimensionTotal {
  readonly observed_sum: number;
  readonly observed_invocations: number;
  readonly unknown_invocations: number;
}

/** Dimensions Claude, sous les noms exacts que Claude leur donne. */
export interface ClaudeTokenTotals {
  readonly provider: 'claude';
  readonly input_tokens: UsageDimensionTotal;
  readonly output_tokens: UsageDimensionTotal;
  readonly cache_creation_input_tokens: UsageDimensionTotal;
  readonly cache_read_input_tokens: UsageDimensionTotal;
}

/** Dimensions Codex, sous les noms exacts que Codex leur donne. */
export interface CodexTokenTotals {
  readonly provider: 'codex';
  readonly input_tokens: UsageDimensionTotal;
  readonly output_tokens: UsageDimensionTotal;
  readonly cached_input_tokens: UsageDimensionTotal;
  readonly cache_write_input_tokens: UsageDimensionTotal;
  readonly reasoning_output_tokens: UsageDimensionTotal;
}

export type UsageTokenTotals = ClaudeTokenTotals | CodexTokenTotals;

export interface UsageModelTally {
  readonly observed: readonly { readonly model: string; readonly invocations: number }[];
  readonly unknown: readonly { readonly reason: string; readonly invocations: number }[];
  /**
   * Invocations dont le modèle n'est pas lisible : usage fournisseur non
   * observé, ambigu, ou observation dépourvue de modèle. Aucune raison n'est
   * inventée pour elles.
   */
  readonly unavailable_invocations: number;
}

/**
 * Montant **rapporté par le fournisseur**, agrégé par devise.
 *
 * Ce n'est ni une facture, ni une estimation : c'est la somme de ce qu'un outil
 * tiers a publié, accompagnée de ce qu'elle ne couvre pas. Aucune conversion
 * n'est faite entre devises — deux devises, deux entrées.
 */
export interface UsageMoneyByCurrency {
  readonly currency: string;
  readonly observed_amount_sum: number;
  readonly covered_invocations: number;
}

export interface UsageMoneyTally {
  readonly by_currency: readonly UsageMoneyByCurrency[];
  readonly unknown_invocations: number;
  readonly ambiguous_invocations: number;
}

export interface UsageProviderAggregate {
  readonly provider: ProviderKind;
  readonly invocations: number;
  readonly provider_reported: UsageProvenancePartition;
  readonly ccr_measured: UsageProvenancePartition;
  readonly tokens: UsageTokenTotals;
  readonly models: UsageModelTally;
  readonly provider_reported_money: UsageMoneyTally;
}

/** Ce qu'une invocation a rendu observable, sans rien choisir à sa place. */
export interface UsageInvocationView {
  readonly invocation_id: string;
  readonly trigger_kind: InvocationTriggerKind;
  readonly identity: InvocationIdentity;
  readonly provider: ProviderKind;
  readonly provider_reported: {
    readonly state: UsageProvenanceState;
    /** Renseignée uniquement en `OBSERVED` : une ambiguïté ne se résout pas. */
    readonly observation?: UsageObservationRecord;
  };
  readonly ccr_measured: {
    readonly state: UsageProvenanceState;
    /** Mesures d'exécution **de CCR**, jamais une consommation fournisseur. */
    readonly ccr_elapsed_ms?: number;
    readonly exit_code?: number | null;
  };
}

export interface UsageOrphanObservation {
  readonly usage_observation_id: string;
  readonly invocation_id: string;
  readonly provenance: UsageProvenance;
}

export interface UsageDuplicateObservations {
  readonly invocation_id: string;
  readonly provenance: UsageProvenance;
  readonly usage_observation_ids: readonly string[];
}

export interface UsageAnomalies {
  readonly orphan_observations: readonly UsageOrphanObservation[];
  readonly duplicate_observations: readonly UsageDuplicateObservations[];
}

export interface UsageReadModel {
  readonly coverage: UsageCoverage;
  readonly invocations: {
    readonly total: number;
    readonly provider_reported: UsageProvenancePartition;
    readonly ccr_measured: UsageProvenancePartition;
  };
  readonly by_invocation: readonly UsageInvocationView[];
  /** Un seul axe agrégé : le fournisseur. Seul domaine où une somme a un sens. */
  readonly providers: readonly UsageProviderAggregate[];
  readonly anomalies: UsageAnomalies;
}

// --------------------------------------------------------------------------
// Accumulateurs
// --------------------------------------------------------------------------

interface DimensionAccumulator {
  sum: number;
  observed: number;
  unknown: number;
}

function newDimension(): DimensionAccumulator {
  return { sum: 0, observed: 0, unknown: 0 };
}

/** Ajoute une valeur, ou constate qu'elle manque. `null` est inconnu, pas zéro. */
function observe(dimension: DimensionAccumulator, value: number | null | undefined): void {
  if (typeof value === 'number') {
    dimension.sum += value;
    dimension.observed += 1;
    return;
  }
  dimension.unknown += 1;
}

function totalOf(dimension: DimensionAccumulator): UsageDimensionTotal {
  return {
    observed_sum: dimension.sum,
    observed_invocations: dimension.observed,
    unknown_invocations: dimension.unknown,
  };
}

const CLAUDE_DIMENSIONS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

const CODEX_DIMENSIONS = [
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'reasoning_output_tokens',
] as const;

interface ProviderAccumulator {
  invocations: number;
  providerReported: { observed: number; unobserved: number; ambiguous: number };
  ccrMeasured: { observed: number; unobserved: number; ambiguous: number };
  dimensions: Map<string, DimensionAccumulator>;
  models: Map<string, number>;
  unknownModels: Map<string, number>;
  unavailableModels: number;
  currencies: Map<string, { sum: number; invocations: number }>;
  moneyUnknown: number;
  moneyAmbiguous: number;
}

function newProvider(provider: ProviderKind): ProviderAccumulator {
  const names = provider === 'claude' ? CLAUDE_DIMENSIONS : CODEX_DIMENSIONS;
  return {
    invocations: 0,
    providerReported: { observed: 0, unobserved: 0, ambiguous: 0 },
    ccrMeasured: { observed: 0, unobserved: 0, ambiguous: 0 },
    dimensions: new Map(names.map((name) => [name, newDimension()])),
    models: new Map(),
    unknownModels: new Map(),
    unavailableModels: 0,
    currencies: new Map(),
    moneyUnknown: 0,
    moneyAmbiguous: 0,
  };
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/** Toutes les dimensions du fournisseur, déclarées inconnues d'un coup. */
function markAllUnknown(accumulator: ProviderAccumulator): void {
  for (const dimension of accumulator.dimensions.values()) dimension.unknown += 1;
}

function tokensOf(accumulator: ProviderAccumulator, provider: ProviderKind): UsageTokenTotals {
  const dimension = (name: string): UsageDimensionTotal =>
    totalOf(accumulator.dimensions.get(name) ?? newDimension());

  if (provider === 'claude') {
    return {
      provider: 'claude',
      input_tokens: dimension('input_tokens'),
      output_tokens: dimension('output_tokens'),
      cache_creation_input_tokens: dimension('cache_creation_input_tokens'),
      cache_read_input_tokens: dimension('cache_read_input_tokens'),
    };
  }
  return {
    provider: 'codex',
    input_tokens: dimension('input_tokens'),
    output_tokens: dimension('output_tokens'),
    cached_input_tokens: dimension('cached_input_tokens'),
    cache_write_input_tokens: dimension('cache_write_input_tokens'),
    reasoning_output_tokens: dimension('reasoning_output_tokens'),
  };
}

/** Valeur d'une dimension sur une observation, si le fournisseur correspond. */
function dimensionValue(
  tokens: UsageTokens | undefined,
  provider: ProviderKind,
  name: string,
): number | null | undefined {
  if (tokens === undefined || tokens.provider !== provider) return undefined;
  return (tokens as unknown as Record<string, number | null | undefined>)[name];
}

// --------------------------------------------------------------------------
// Lecture
// --------------------------------------------------------------------------

/**
 * Produit la lecture d'usage d'un run.
 *
 * Ne crée aucun fichier : l'absence d'un journal se constate, elle ne se
 * répare pas. Un journal présent mais invalide lève — jamais un usage nul.
 */
export async function readUsageReadModel(paths: RunPaths): Promise<UsageReadModel> {
  const marked = await pathExists(paths.invocations);
  const coverage: UsageCoverage = marked ? 'SINCE_LEDGER_START' : 'PRE_LEDGER';

  const invocations: InvocationDispatchRecord[] = marked
    ? await (await openInvocationLedger(paths, paths.runId)).readAll()
    : [];
  const observations: UsageObservationRecord[] = (await pathExists(paths.usage))
    ? await (await openUsageLedger(paths, paths.runId)).readAll()
    : [];

  // Regroupement par invocation puis par provenance : c'est ce qui garantit
  // qu'une invocation compte une fois, quelles que soient ses observations.
  const grouped = new Map<string, Map<UsageProvenance, UsageObservationRecord[]>>();
  for (const observation of observations) {
    const byProvenance = grouped.get(observation.invocation_id) ?? new Map();
    byProvenance.set(observation.provenance, [
      ...(byProvenance.get(observation.provenance) ?? []),
      observation,
    ]);
    grouped.set(observation.invocation_id, byProvenance);
  }

  const providers = new Map<ProviderKind, ProviderAccumulator>();
  const duplicates: UsageDuplicateObservations[] = [];
  const views: UsageInvocationView[] = [];
  const totals = {
    provider_reported: { observed: 0, unobserved: 0, ambiguous: 0 },
    ccr_measured: { observed: 0, unobserved: 0, ambiguous: 0 },
  };

  for (const invocation of invocations) {
    const provider = invocation.identity.provider;
    const accumulator = providers.get(provider) ?? newProvider(provider);
    providers.set(provider, accumulator);
    accumulator.invocations += 1;

    const byProvenance = grouped.get(invocation.invocation_id);
    const classify = (provenance: UsageProvenance): {
      state: UsageProvenanceState;
      single?: UsageObservationRecord;
    } => {
      const found = byProvenance?.get(provenance) ?? [];
      if (found.length === 0) return { state: 'UNOBSERVED' };
      if (found.length === 1) return { state: 'OBSERVED', single: found[0] as UsageObservationRecord };
      duplicates.push({
        invocation_id: invocation.invocation_id,
        provenance,
        usage_observation_ids: found.map((entry) => entry.usage_observation_id),
      });
      return { state: 'AMBIGUOUS' };
    };

    const reported = classify('PROVIDER_REPORTED');
    const measured = classify('CCR_MEASURED');

    // Les deux provenances sont comptées indépendamment : une ambiguïté d'un
    // côté ne retire rien à ce que l'autre affirme clairement.
    for (const [state, bucket] of [
      [reported.state, accumulator.providerReported],
      [measured.state, accumulator.ccrMeasured],
    ] as const) {
      if (state === 'OBSERVED') bucket.observed += 1;
      else if (state === 'AMBIGUOUS') bucket.ambiguous += 1;
      else bucket.unobserved += 1;
    }
    for (const [state, bucket] of [
      [reported.state, totals.provider_reported],
      [measured.state, totals.ccr_measured],
    ] as const) {
      if (state === 'OBSERVED') bucket.observed += 1;
      else if (state === 'AMBIGUOUS') bucket.ambiguous += 1;
      else bucket.unobserved += 1;
    }

    // ---- Jetons, modèle et montant : la seule observation exploitable est
    //      une observation fournisseur **unique**. Tout le reste est inconnu.
    const single = reported.single;
    if (single === undefined) {
      markAllUnknown(accumulator);
      accumulator.unavailableModels += 1;
      if (reported.state === 'AMBIGUOUS') accumulator.moneyAmbiguous += 1;
      else accumulator.moneyUnknown += 1;
    } else {
      const names = provider === 'claude' ? CLAUDE_DIMENSIONS : CODEX_DIMENSIONS;
      for (const name of names) {
        observe(
          accumulator.dimensions.get(name) as DimensionAccumulator,
          dimensionValue(single.tokens, provider, name),
        );
      }

      const model = single.model;
      if (model === undefined) accumulator.unavailableModels += 1;
      else if (model.source === 'PROVIDER_REPORTED') bump(accumulator.models, model.resolved_model);
      else bump(accumulator.unknownModels, model.reason);

      const money = single.provider_reported_cost;
      if (money === undefined) accumulator.moneyUnknown += 1;
      else {
        const entry = accumulator.currencies.get(money.currency) ?? { sum: 0, invocations: 0 };
        entry.sum += money.amount;
        entry.invocations += 1;
        accumulator.currencies.set(money.currency, entry);
      }
    }

    views.push({
      invocation_id: invocation.invocation_id,
      trigger_kind: invocation.trigger_kind,
      identity: invocation.identity,
      provider,
      provider_reported: {
        state: reported.state,
        ...(single === undefined ? {} : { observation: single }),
      },
      ccr_measured: {
        state: measured.state,
        ...(measured.single?.ccr_elapsed_ms === undefined
          ? {}
          : { ccr_elapsed_ms: measured.single.ccr_elapsed_ms }),
        ...(measured.single === undefined || measured.single.exit_code === undefined
          ? {}
          : { exit_code: measured.single.exit_code }),
      },
    });
  }

  // Contrat gelé : une observation sans invocation n'est pas une corruption de
  // ligne. Elle ne participe à rien, et elle se dit.
  const orphans = findOrphanUsageObservations(invocations, observations);

  return {
    coverage,
    invocations: {
      total: invocations.length,
      provider_reported: { ...totals.provider_reported },
      ccr_measured: { ...totals.ccr_measured },
    },
    by_invocation: views,
    providers: [...providers.entries()].map(([provider, accumulator]) => ({
      provider,
      invocations: accumulator.invocations,
      provider_reported: { ...accumulator.providerReported },
      ccr_measured: { ...accumulator.ccrMeasured },
      tokens: tokensOf(accumulator, provider),
      models: {
        observed: [...accumulator.models.entries()].map(([model, count]) => ({
          model,
          invocations: count,
        })),
        unknown: [...accumulator.unknownModels.entries()].map(([reason, count]) => ({
          reason,
          invocations: count,
        })),
        unavailable_invocations: accumulator.unavailableModels,
      },
      provider_reported_money: {
        by_currency: [...accumulator.currencies.entries()].map(([currency, entry]) => ({
          currency,
          observed_amount_sum: entry.sum,
          covered_invocations: entry.invocations,
        })),
        unknown_invocations: accumulator.moneyUnknown,
        ambiguous_invocations: accumulator.moneyAmbiguous,
      },
    })),
    anomalies: {
      orphan_observations: orphans.map((entry) => ({
        usage_observation_id: entry.usage_observation_id,
        invocation_id: entry.invocation_id,
        provenance: entry.provenance,
      })),
      duplicate_observations: duplicates,
    },
  };
}
