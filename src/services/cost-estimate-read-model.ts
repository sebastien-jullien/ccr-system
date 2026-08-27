/**
 * Lecture des estimations de coût d'un run (CCR V2.2, `V2.2-IMP-12`).
 *
 * Orchestration, et rien d'autre : elle lit la lecture d'usage, lit le
 * catalogue courant, confie chaque invocation à l'estimateur **pur**, puis
 * agrège. Aucun calcul ne vit ici, et aucune décision non plus.
 *
 * ## Ce qu'elle ne refait pas
 *
 * Ambiguïtés de provenance, orphelins, couverture, comptage des invocations :
 * tout cela appartient à `IMP-10`, et une seconde résolution parallèle
 * risquerait de le contredire. L'univers reste le journal d'invocations.
 *
 * ## Une somme n'est pas plus exacte que ses termes
 *
 * L'agrégat somme les montants **publics** de chaque invocation, si bien que le
 * total réconcilie toujours exactement le détail affiché. Il hérite en revanche
 * de l'arrondi éventuel de chaque terme : le compartiment de devise déclare donc
 * combien de montants y sont entrés exacts, et combien arrondis.
 *
 * ## Rien n'est persisté
 *
 * Une estimation est une fonction pure de faits déjà écrits — usage, modèle,
 * version de catalogue. La persister créerait une seconde source de vérité
 * pouvant diverger de ses propres entrées. Deux lectures peuvent donc rendre un
 * `computed_at` différent ; le montant, lui, ne bouge pas.
 *
 * ## En production, aucun tarif
 *
 * CCR n'embarque aucun catalogue. Le courant vaut `NONE`, et toute invocation
 * par ailleurs estimable rend `PRICING_UNKNOWN`. C'est l'état normal, pas une
 * panne — et surtout pas un coût nul.
 */

import { estimateInvocationCost, sumCostAmounts } from './cost-estimator.ts';
import type { CostEstimate, CostEstimateUnknownReason } from './cost-estimator.ts';
import { readUsageReadModel } from './usage-read-model.ts';
import type { UsageCoverage, UsageInvocationView } from './usage-read-model.ts';
import type { PricingCatalogSource } from '../core/pricing-catalog.ts';
import { readCurrentPricingCatalog } from '../store/pricing-catalog-store.ts';
import type { CurrentPricingCatalog } from '../store/pricing-catalog-store.ts';
import type { RunPaths } from '../store/layout.ts';

type ProviderKind = UsageInvocationView['provider'];

/** Le catalogue employé, cité pour que l'estimation reste vérifiable. */
export type CostEstimatePricing =
  | { readonly kind: 'NONE' }
  | {
      readonly kind: 'CONFIGURED';
      readonly catalog_version: string;
      readonly currency: string;
      readonly source: PricingCatalogSource;
    };

export interface CostEstimateUnknownTally {
  readonly reason: CostEstimateUnknownReason;
  readonly invocations: number;
}

/**
 * Montants estimés, par devise.
 *
 * Seules les estimations `KNOWN` y participent : une invocation dont le tarif
 * est inconnu n'a pas de devise, et lui en attribuer une inventerait une
 * couverture. Celle-ci vit au niveau du fournisseur, où elle est exacte.
 */
export interface CostEstimateByCurrency {
  readonly currency: string;
  readonly estimated_amount_sum: string;
  readonly estimated_invocations: number;
  /** Montants publiés exactement. Partitionne `estimated_invocations`... */
  readonly exact_amount_invocations: number;
  /** ...avec ceux dont l'écriture publique est arrondie à 12 décimales. */
  readonly rounded_amount_invocations: number;
}

export interface CostEstimateProviderAggregate {
  readonly provider: ProviderKind;
  readonly invocations: number;
  readonly estimated_invocations: number;
  readonly unknown_invocations: number;
  /** Partitionne exactement `unknown_invocations`. */
  readonly unknown_by_reason: readonly CostEstimateUnknownTally[];
  readonly amounts_by_currency: readonly CostEstimateByCurrency[];
}

export interface CostEstimateReadModel {
  readonly coverage: UsageCoverage;
  readonly pricing: CostEstimatePricing;
  readonly by_invocation: readonly CostEstimate[];
  /** Un seul axe, comme pour l'usage : le fournisseur. */
  readonly providers: readonly CostEstimateProviderAggregate[];
}

interface ProviderAccumulator {
  invocations: number;
  estimated: number;
  reasons: Map<CostEstimateUnknownReason, number>;
  currencies: Map<string, { amounts: string[]; invocations: number; exact: number; rounded: number }>;
}

function newProvider(): ProviderAccumulator {
  return { invocations: 0, estimated: 0, reasons: new Map(), currencies: new Map() };
}

function pricingOf(current: CurrentPricingCatalog): CostEstimatePricing {
  if (current.kind === 'NONE') return { kind: 'NONE' };
  return {
    kind: 'CONFIGURED',
    catalog_version: current.catalog.catalog_version,
    currency: current.catalog.currency,
    source: current.catalog.source,
  };
}

/**
 * Produit les estimations d'un run.
 *
 * `now` est une couture : l'horodatage est celui de la lecture, jamais un fait
 * persisté. Un catalogue courant absent donne des estimations `UNKNOWN` ; un
 * catalogue **corrompu** lève, et ne se dégrade jamais en « pas de tarif ».
 */
export async function readCostEstimateReadModel(
  paths: RunPaths,
  now: () => Date = () => new Date(),
  repoRoot?: string,
): Promise<CostEstimateReadModel> {
  const usage = await readUsageReadModel(paths);
  const current =
    repoRoot === undefined
      ? await readCurrentPricingCatalog()
      : await readCurrentPricingCatalog(repoRoot);
  const computedAt = now().toISOString();

  const providers = new Map<ProviderKind, ProviderAccumulator>();
  const estimates: CostEstimate[] = [];

  for (const view of usage.by_invocation) {
    const estimate = estimateInvocationCost(view, current, computedAt);
    estimates.push(estimate);

    const accumulator = providers.get(view.provider) ?? newProvider();
    providers.set(view.provider, accumulator);
    accumulator.invocations += 1;

    if (estimate.status === 'UNKNOWN') {
      accumulator.reasons.set(
        estimate.unknown_reason,
        (accumulator.reasons.get(estimate.unknown_reason) ?? 0) + 1,
      );
      continue;
    }

    accumulator.estimated += 1;
    const bucket = accumulator.currencies.get(estimate.currency) ?? {
      amounts: [],
      invocations: 0,
      exact: 0,
      rounded: 0,
    };
    bucket.amounts.push(estimate.amount);
    bucket.invocations += 1;
    if (estimate.amount_materialization.kind === 'EXACT') bucket.exact += 1;
    else bucket.rounded += 1;
    accumulator.currencies.set(estimate.currency, bucket);
  }

  return {
    coverage: usage.coverage,
    pricing: pricingOf(current),
    by_invocation: estimates,
    providers: [...providers.entries()].map(([provider, accumulator]) => ({
      provider,
      invocations: accumulator.invocations,
      estimated_invocations: accumulator.estimated,
      unknown_invocations: accumulator.invocations - accumulator.estimated,
      unknown_by_reason: [...accumulator.reasons.entries()].map(([reason, invocations]) => ({
        reason,
        invocations,
      })),
      amounts_by_currency: [...accumulator.currencies.entries()].map(([currency, bucket]) => ({
        currency,
        estimated_amount_sum: sumCostAmounts(bucket.amounts),
        estimated_invocations: bucket.invocations,
        exact_amount_invocations: bucket.exact,
        rounded_amount_invocations: bucket.rounded,
      })),
    })),
  };
}
