/**
 * Estimation de coût, par invocation (CCR V2.2, `V2.2-IMP-12`).
 *
 * Fonction **pure** : aucune entrée/sortie, aucun réseau, aucune horloge propre.
 * Elle reçoit ce qu'une invocation a rendu observable, le catalogue courant, et
 * rend une estimation — ou dit pourquoi elle n'en a pas.
 *
 * ## Une estimation n'est pas un coût
 *
 * `CostEstimate` est une projection dérivée. Elle n'affirme aucune facture,
 * n'observe aucun terminal, et ne remplace jamais le montant qu'un fournisseur
 * a lui-même publié — les deux coexistent, et aucun ne valide l'autre.
 *
 * ## Quatre raisons, dans cet ordre
 *
 * ```text
 * 1  usage non observé ou ambigu   USAGE_UNKNOWN
 * 2  modèle non résolu             MODEL_UNKNOWN
 * 3  aucune règle pour ce couple   PRICING_UNKNOWN
 * 4  règle inapplicable à la forme UNSUPPORTED_USAGE_SHAPE
 * ```
 *
 * L'ordre est normatif, et il compte : une invocation dont l'usage est ambigu
 * est `USAGE_UNKNOWN` même si le catalogue est absent. Répondre « pas de tarif »
 * laisserait croire qu'un tarif suffirait à l'estimer, ce qui est faux.
 *
 * ## Le modèle ne se devine pas
 *
 * Sans `resolved_model` observé, aucune règle n'est choisie — pas même lorsque
 * le catalogue ne contient qu'une seule entrée pour ce moteur. C'est l'état
 * normal de Codex aujourd'hui, et transformer cette absence en prix supposé
 * produirait un montant d'apparence exacte assis sur une invention.
 *
 * ## Absent n'est pas gratuit
 *
 * Une catégorie observée qu'aucune règle ne tarife rend l'estimation
 * impossible : la supposer gratuite inventerait un prix. À l'inverse, une
 * catégorie explicitement à `"0"` est tarifée, et son terme vaut zéro.
 *
 * ## Arithmétique
 *
 * Le catalogue conserve ses taux en décimal exact ; les convertir en flottant
 * dès la lecture dégraderait le chiffre avant même la multiplication par des
 * millions de jetons. Le calcul est donc **rationnel exact** en `BigInt`, et il
 * n'existe qu'un seul point de matérialisation décimale — documenté, à la fin.
 *
 * ## Deux objets, deux noms
 *
 * ```text
 * rationnel interne   exact, toujours
 * montant public      EXACT   écriture décimale exacte du rationnel
 *                     ROUNDED approximation à 12 décimales, HALF_UP
 * ```
 *
 * Un rationnel dont le développement décimal est fini est publié **entièrement**,
 * quel qu'en soit le nombre de décimales. Seul un développement infini est
 * arrondi, et l'estimation le dit alors dans sa structure. Aucune chaîne publique
 * arrondie n'est jamais qualifiée d'exacte.
 */

import type { PricingCatalog, PricingCatalogSource } from '../core/pricing-catalog.ts';
import { PRICING_CATEGORIES } from '../core/pricing-catalog.ts';
import type { CurrentPricingCatalog } from '../store/pricing-catalog-store.ts';
import type { UsageInvocationView } from './usage-read-model.ts';
import type { UsageTokens } from '../core/usage.ts';

/** Les quatre raisons gelées. Il n'y en a pas de cinquième. */
export type CostEstimateUnknownReason =
  | 'USAGE_UNKNOWN'
  | 'MODEL_UNKNOWN'
  | 'PRICING_UNKNOWN'
  | 'UNSUPPORTED_USAGE_SHAPE';

/** Décimales publiées lorsqu'un montant doit être arrondi. Gelé. */
export const ROUNDED_DECIMAL_PLACES = 12;

/** Mode d'arrondi de cette matérialisation. Gelé, et non plus émergent. */
export const COST_AMOUNT_ROUNDING_MODE = 'HALF_UP';

/**
 * Comment la chaîne publique se rapporte au rationnel interne.
 *
 * `EXACT` affirme que le montant publié **est** la valeur ; `ROUNDED` qu'il en
 * est une approximation, à une précision et un mode nommés. Les confondre
 * laisserait un montant arrondi se lire comme une valeur exacte — et un positif
 * arrondi se lire comme un vrai zéro.
 *
 * Orthogonal au `status` : une estimation `ROUNDED` reste `KNOWN`, car ses
 * entrées tarifaires étaient connues. Ceci décrit l'écriture du nombre, pas la
 * calculabilité de l'estimation.
 */
export type CostAmountMaterialization =
  | { readonly kind: 'EXACT' }
  | {
      readonly kind: 'ROUNDED';
      readonly decimal_places: typeof ROUNDED_DECIMAL_PLACES;
      readonly rounding_mode: typeof COST_AMOUNT_ROUNDING_MODE;
    };

/**
 * Montant estimé, en décimal.
 *
 * Une chaîne, comme les taux du catalogue, et pour la même raison : ce que CCR
 * dérive lui-même de bout en bout, il peut le rendre fidèlement. Le montant
 * qu'un fournisseur publie reste un `number` — CCR le recopie, il ne le calcule
 * pas.
 *
 * L'exactitude de cette chaîne se lit dans `amount_materialization`, jamais
 * dans la chaîne elle-même.
 */
export type CostEstimate =
  | {
      readonly invocation_id: string;
      readonly status: 'KNOWN';
      readonly amount: string;
      readonly amount_materialization: CostAmountMaterialization;
      readonly currency: string;
      readonly model: string;
      /** Catégories ayant réellement participé au calcul, taux nul compris. */
      readonly usage_basis: readonly string[];
      readonly pricing_catalog_version: string;
      readonly pricing_source: PricingCatalogSource;
      readonly computed_at: string;
    }
  | {
      readonly invocation_id: string;
      readonly status: 'UNKNOWN';
      readonly unknown_reason: CostEstimateUnknownReason;
      /** Conservé lorsqu'il est déjà certain — un `PRICING_UNKNOWN` le connaît. */
      readonly model?: string;
      readonly computed_at: string;
    };

// --------------------------------------------------------------------------
// Arithmétique rationnelle exacte
// --------------------------------------------------------------------------

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const ZERO: Rational = { numerator: 0n, denominator: 1n };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

function reduce(value: Rational): Rational {
  const divisor = gcd(value.numerator, value.denominator);
  return { numerator: value.numerator / divisor, denominator: value.denominator / divisor };
}

function add(left: Rational, right: Rational): Rational {
  return reduce({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

/** `"0.000001"` → 1 / 1 000 000, sans jamais passer par un flottant. */
function decimalToRational(decimal: string): Rational {
  const dot = decimal.indexOf('.');
  if (dot === -1) return { numerator: BigInt(decimal), denominator: 1n };
  const fraction = decimal.slice(dot + 1);
  return reduce({
    numerator: BigInt(decimal.slice(0, dot) + fraction),
    denominator: 10n ** BigInt(fraction.length),
  });
}

/**
 * Décimales nécessaires à l'écriture exacte, ou `-1` si elle est impossible.
 *
 * Un rationnel réduit s'écrit en décimal fini si et seulement si son
 * dénominateur ne retient que les facteurs premiers de dix — 2 et 5. Le nombre
 * de décimales vaut alors `max(a, b)` pour un dénominateur `2^a · 5^b`.
 *
 * C'est le rationnel **final** qui décide, jamais la forme du taux : `"1"` sur
 * une échelle de 3 est un taux entier dont le terme ne s'écrit pas, et
 * `"0.0000000000001"` un taux à treize décimales qui s'écrit parfaitement.
 */
function terminatingDecimalPlaces(denominator: bigint): number {
  let rest = denominator;
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos += 1;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives += 1;
  }
  return rest === 1n ? Math.max(twos, fives) : -1;
}

/** Écriture canonique d'un entier mis à l'échelle : zéros terminaux retirés. */
function formatScaled(scaled: bigint, places: number): string {
  if (places === 0) return scaled.toString();
  const digits = scaled.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

interface MaterializedAmount {
  readonly amount: string;
  readonly materialization: CostAmountMaterialization;
}

/**
 * Unique point de matérialisation : tout le reste est rationnel exact.
 *
 * Aucune borne n'est imposée à un montant qui s'écrit — la limite de douze
 * décimales ne s'applique qu'à ce qui ne s'écrirait jamais. Tronquer un décimal
 * fini au prétexte qu'il est long publierait `"0"` pour une valeur positive,
 * indiscernable d'un tarif réellement nul.
 */
function materialize(value: Rational): MaterializedAmount {
  const places = terminatingDecimalPlaces(value.denominator);
  if (places >= 0) {
    // La division est exacte : le dénominateur divise 10^places par construction.
    const scaled = (value.numerator * 10n ** BigInt(places)) / value.denominator;
    return { amount: formatScaled(scaled, places), materialization: { kind: 'EXACT' } };
  }

  const factor = 10n ** BigInt(ROUNDED_DECIMAL_PLACES);
  const scaled = value.numerator * factor;
  // HALF_UP, sur des entiers : aucune comparaison flottante, aucune égalité
  // laissée au hasard — `>=` fait monter le demi quantum exact.
  const quotient = scaled / value.denominator;
  const remainder = scaled % value.denominator;
  const rounded = remainder * 2n >= value.denominator ? quotient + 1n : quotient;
  return {
    amount: formatScaled(rounded, ROUNDED_DECIMAL_PLACES),
    materialization: {
      kind: 'ROUNDED',
      decimal_places: ROUNDED_DECIMAL_PLACES,
      rounding_mode: COST_AMOUNT_ROUNDING_MODE,
    },
  };
}

// --------------------------------------------------------------------------
// Estimation
// --------------------------------------------------------------------------

function unknown(
  invocationId: string,
  reason: CostEstimateUnknownReason,
  computedAt: string,
  model?: string,
): CostEstimate {
  return {
    invocation_id: invocationId,
    status: 'UNKNOWN',
    unknown_reason: reason,
    ...(model === undefined ? {} : { model }),
    computed_at: computedAt,
  };
}

/**
 * Ce qu'une observation dit d'une catégorie : rien, un compteur, ou n'importe
 * quoi.
 *
 * Trois états, et pas deux. Un compteur malformé n'est pas une absence : le
 * confondre avec elle le ferait ignorer en silence, et un compteur fractionnaire
 * atteindrait plus bas une conversion entière exacte qui lèverait une exception
 * technique brute au lieu d'un refus lisible. La validation d'entrée refuse
 * déjà de tels compteurs ; cette garde protège la fonction pure d'une vue
 * construite en mémoire qui ne serait jamais passée par elle.
 */
type CategoryCount =
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'INVALID' }
  | { readonly kind: 'COUNT'; readonly value: number };

function categoryCount(tokens: UsageTokens | undefined, category: string): CategoryCount {
  if (tokens === undefined) return { kind: 'ABSENT' };
  const value = (tokens as unknown as Record<string, unknown>)[category];
  if (value === undefined || value === null) return { kind: 'ABSENT' };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return { kind: 'INVALID' };
  return { kind: 'COUNT', value };
}

/**
 * Estime le coût d'une invocation, ou dit pourquoi elle ne s'estime pas.
 *
 * Pure : ni disque, ni réseau, ni horloge. `computedAt` est fourni, jamais lu.
 */
export function estimateInvocationCost(
  view: UsageInvocationView,
  pricing: CurrentPricingCatalog,
  computedAt: string,
): CostEstimate {
  const id = view.invocation_id;

  // ---- 1. Usage. Une observation absente ou ambiguë arrête tout : consulter
  //         le modèle ou le catalogue pour nommer une autre raison laisserait
  //         croire qu'ils suffiraient à estimer.
  if (view.provider_reported.state !== 'OBSERVED') {
    return unknown(id, 'USAGE_UNKNOWN', computedAt);
  }
  const observation = view.provider_reported.observation;
  if (observation === undefined) return unknown(id, 'USAGE_UNKNOWN', computedAt);

  // ---- 2. Modèle. Jamais déduit du fournisseur, de la configuration, du
  //         binaire ni de la session — c'est l'état normal de Codex.
  const model = observation.model;
  if (model === undefined || model.source !== 'PROVIDER_REPORTED') {
    return unknown(id, 'MODEL_UNKNOWN', computedAt);
  }
  const resolved = model.resolved_model;

  // ---- 3. Tarif. Aucun joker, aucun défaut de fournisseur, aucun modèle
  //         voisin : la règle est l'ensemble des entrées du couple exact.
  if (pricing.kind === 'NONE') return unknown(id, 'PRICING_UNKNOWN', computedAt, resolved);
  const catalog: PricingCatalog = pricing.catalog;
  const rules = catalog.entries.filter(
    (entry) => entry.provider === view.provider && entry.model === resolved,
  );
  if (rules.length === 0) return unknown(id, 'PRICING_UNKNOWN', computedAt, resolved);

  // ---- 4. Forme d'usage. La règle doit s'appliquer honnêtement à ce qui a
  //         réellement été observé, dans les deux sens.
  const tokens = observation.tokens;
  if (tokens !== undefined && tokens.provider !== view.provider) {
    return unknown(id, 'UNSUPPORTED_USAGE_SHAPE', computedAt, resolved);
  }

  const basis: string[] = [];
  let total: Rational = ZERO;
  for (const category of PRICING_CATEGORIES[view.provider]) {
    const count = categoryCount(tokens, category);
    const rule = rules.find((entry) => entry.usage_category === category);

    // Un compteur qui n'est pas un entier de jetons ne se tarife pas, et ne
    // s'ignore pas non plus : il est refusé, règle ou pas.
    if (count.kind === 'INVALID') {
      return unknown(id, 'UNSUPPORTED_USAGE_SHAPE', computedAt, resolved);
    }

    // Observée sans règle : la supposer gratuite inventerait un prix.
    // Tarifée sans observation : le montant serait incomplet sans le dire.
    if ((count.kind === 'ABSENT') !== (rule === undefined)) {
      return unknown(id, 'UNSUPPORTED_USAGE_SHAPE', computedAt, resolved);
    }
    if (count.kind === 'ABSENT' || rule === undefined) continue;

    const rate = decimalToRational(rule.rate);
    total = add(total, {
      numerator: BigInt(count.value) * rate.numerator,
      denominator: rate.denominator * BigInt(rule.unit_scale),
    });
    basis.push(category);
  }

  const materialized = materialize(total);
  return {
    invocation_id: id,
    status: 'KNOWN',
    amount: materialized.amount,
    amount_materialization: materialized.materialization,
    currency: catalog.currency,
    model: resolved,
    usage_basis: basis,
    pricing_catalog_version: catalog.catalog_version,
    pricing_source: catalog.source,
    computed_at: computedAt,
  };
}

/**
 * Somme d'une série de montants **publics** déjà matérialisés.
 *
 * La base d'agrégation est gelée : ce sont les montants publiés qui se somment,
 * jamais les rationnels internes. La somme affichée réconcilie donc toujours
 * exactement le détail affiché — au prix d'hériter de l'arrondi éventuel de
 * chaque terme, ce que la couverture exact/arrondi du compartiment déclare.
 *
 * Une somme finie de décimaux finis est finie : cette matérialisation-ci est
 * donc toujours `EXACT`, et n'introduit aucun second arrondi.
 */
export function sumCostAmounts(amounts: readonly string[]): string {
  return materialize(amounts.reduce<Rational>((acc, amount) => add(acc, decimalToRational(amount)), ZERO)).amount;
}
