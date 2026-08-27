/**
 * Observations d'usage d'un tour d'agent (CCR V2.2, contrat de données V0.1).
 *
 * ## Ce que ce module est
 *
 * Le vocabulaire commun de ce qu'un fournisseur **rapporte** et de ce que CCR
 * **mesure** autour d'un appel. Rien d'autre : aucun coût dérivé, aucun tarif,
 * aucun quota, aucune persistance.
 *
 * ## Ce qu'il n'unifie pas
 *
 * Les compteurs de jetons sont une **union discriminée par fournisseur**, et
 * délibérément. Les deux moteurs ne composent pas leurs totaux de la même
 * façon — fait relevé sur les sorties réelles de la matrice `V2.1-REAL-01` :
 *
 * ```text
 * Claude   input_tokens 2 · cache_creation_input_tokens 39855
 *          → `input_tokens` EXCLUT manifestement le cache
 *
 * Codex    input_tokens 1247744 · cached_input_tokens 1124352
 *          → `cached_input_tokens` est inférieur à `input_tokens`,
 *            donc vraisemblablement INCLUS dedans
 * ```
 *
 * Une catégorie commune nommée « tokens de cache » additionnerait donc des
 * choses différentes. Chaque compteur conserve le nom exact que son moteur lui
 * donne, et aucun total n'est dérivé ici — `total_tokens` reste `UNKNOWN`
 * jusqu'à ce qu'une règle de composition soit démontrée par fournisseur.
 */

/**
 * Qui affirme une observation.
 *
 * `DERIVED` n'existe pas dans ce slice : rien n'est recomposé. L'ajouter sans
 * producteur donnerait une provenance qu'aucun enregistrement ne pourrait
 * porter honnêtement.
 */
export const USAGE_PROVENANCES = ['PROVIDER_REPORTED', 'CCR_MEASURED'] as const;
export type UsageProvenance = (typeof USAGE_PROVENANCES)[number];

/**
 * Compteurs de jetons, **par fournisseur**.
 *
 * `input_tokens` et `output_tokens` portent le même nom des deux côtés parce
 * que les deux moteurs les nomment ainsi ; leur composition, elle, diffère et
 * n'est pas normalisée. Les catégories de cache ne partagent volontairement
 * aucun nom.
 */
export type UsageTokens =
  | {
      readonly provider: 'claude';
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cache_creation_input_tokens: number | null;
      readonly cache_read_input_tokens: number | null;
    }
  | {
      readonly provider: 'codex';
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cached_input_tokens: number | null;
      readonly cache_write_input_tokens: number | null;
      readonly reasoning_output_tokens: number | null;
    };

/**
 * Identité du modèle réellement employé.
 *
 * `CCR_REQUESTED` n'existe pas : CCR ne demande aucun modèle, et aucun de ses
 * appels ne porte d'option de modèle. Déclarer cette source sans producteur
 * laisserait croire qu'une demande a eu lieu.
 *
 * `AMBIGUOUS_MULTIPLE_MODELS` n'est pas un modèle : c'est un refus de choisir.
 * Retenir la première entrée d'une table en comptant deux serait exactement la
 * faute que la résolution d'alias interdit déjà côté experts.
 */
export type UsageModel =
  | { readonly source: 'PROVIDER_REPORTED'; readonly resolved_model: string }
  | {
      readonly source: 'UNKNOWN';
      readonly reason: 'NOT_REPORTED' | 'AMBIGUOUS_MULTIPLE_MODELS';
    };

/**
 * Valeur monétaire **rapportée par le fournisseur**.
 *
 * Ce n'est pas une estimation CCR, et surtout pas une facture : c'est un nombre
 * qu'un outil tiers a calculé et publié dans sa sortie. Le nommer
 * `billing_total` ou `exact_cost` lui prêterait une autorité qu'il n'a pas.
 */
export interface ProviderReportedCost {
  readonly amount: number;
  readonly currency: string;
  readonly source: 'PROVIDER_REPORTED';
}

/**
 * Mesures de temps **du fournisseur**.
 *
 * Conservées à part, et jamais substituées à la mesure de CCR : elles décrivent
 * ce que le fournisseur dit de lui-même, pas ce que CCR a observé.
 */
export interface ProviderTimings {
  readonly duration_ms?: number;
  readonly duration_api_ms?: number;
  readonly ttft_ms?: number;
}

/** Scalaires propres à un moteur. Jamais de contenu, jamais de structure. */
export type ProviderDetails = Readonly<Record<string, string | number>>;

/**
 * Ce qu'un tour a rendu observable, au retour de l'adapter.
 *
 * Facultatif de bout en bout : un tour peut aboutir sans que le fournisseur
 * rapporte quoi que ce soit, et une sortie historique dépourvue de ces champs
 * reste parfaitement valide.
 */
export interface UsageObservation {
  readonly tokens?: UsageTokens;
  readonly model: UsageModel;
  readonly provider_reported_cost?: ProviderReportedCost;
  readonly provider_timings?: ProviderTimings;
  readonly provider_details?: ProviderDetails;
}

// --------------------------------------------------------------------------
// Primitives pures
// --------------------------------------------------------------------------

/**
 * Scalaire non négatif réellement présent, ou `undefined`. Aucun défaut à 0.
 *
 * Volontairement **non entier** : ses porteurs sont le montant rapporté par le
 * fournisseur, les durées et les scalaires de détail, dont un `0.0234` est une
 * valeur parfaitement légitime. Les compteurs de jetons, eux, ne le sont pas et
 * ont leur propre primitive.
 */
export function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Compteur de jetons réellement présent : entier sûr, non négatif.
 *
 * Un jeton ne se compte pas par moitiés. La contrainte n'est pas cosmétique :
 * un compteur fractionnaire traverserait la validation, puis atteindrait plus
 * loin une conversion entière exacte qui lèverait une exception technique brute
 * — une donnée douteuse doit être refusée à la frontière, là où elle entre, et
 * jamais arrondie pour la faire passer.
 */
export function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Compteur de jetons présent, ou `null` — l'absence n'est pas un zéro. */
export function nullableTokenCount(value: unknown): number | null {
  return optionalTokenCount(value) ?? null;
}

/**
 * Durée mesurée **par CCR** autour de l'exécution de l'adapter.
 *
 * Ce n'est ni `provider_latency_ms` ni `api_duration_ms` : elle inclut le
 * lancement du processus, la lecture des flux et l'analyse de la sortie.
 *
 * Pure, et volontairement inemployée par les stores de ce slice : la fondation
 * la rend calculable, le câblage viendra plus tard.
 */
export function ccrElapsedMs(turn: { readonly startedAt: string; readonly completedAt: string }): number | undefined {
  const start = Date.parse(turn.startedAt);
  const end = Date.parse(turn.completedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  const elapsed = end - start;
  return elapsed >= 0 ? elapsed : undefined;
}
