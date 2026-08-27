/**
 * Réglages d'exécution d'un run — **résolus une seule fois**
 * (limite L1 du ledger Slice 0 ; amendement V2-IMP-33).
 *
 * ## Problème corrigé
 *
 * Le garde-fou de transfert gouverne deux choses qui doivent répondre la même
 * chose :
 *
 * ```text
 * RunService              refuse un transfert trop volumineux
 * capability STEP         annonce si le transfert passera
 * ```
 *
 * Tant que chacun résolvait la valeur de son côté — variable d'environnement
 * lue deux fois, valeur par défaut appliquée à un seul endroit — rien
 * n'empêchait le read model d'annoncer `allowed` sur un transfert que le
 * service allait refuser. C'est un fait de catégorie **C** : il ne vient pas du
 * snapshot canonique, et ne doit y entrer sous aucune forme — ni dans
 * `state.json`, ni dans le registre host.
 *
 * ## Solution
 *
 * Une résolution unique, partagée par composition. La valeur voyage
 * explicitement jusqu'aux deux consommateurs ; aucun d'eux ne relit
 * l'environnement.
 */

import { CcrError } from '../core/errors.ts';
import { DEFAULT_MAX_TRANSFER_BYTES } from './transfer.ts';

export interface RunExecutionSettings {
  /** Garde-fou de transfert automatique, en octets UTF-8 (V1 §27). */
  readonly maxTransferBytes: number;
}

/** Nom historique de la variable, inchangé. */
export const MAX_TRANSFER_BYTES_ENV = 'CCR_MAX_TRANSFER_BYTES';

/**
 * Résout les réglages d'exécution.
 *
 * **Unique lecture** de la variable d'environnement dans tout CCR : tout autre
 * module qui la relirait rouvrirait la divergence que ce module ferme.
 */
export function resolveRunExecutionSettings(
  env: NodeJS.ProcessEnv = process.env,
): RunExecutionSettings {
  const raw = env[MAX_TRANSFER_BYTES_ENV];
  if (raw === undefined || raw.length === 0) {
    return { maxTransferBytes: DEFAULT_MAX_TRANSFER_BYTES };
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CcrError('INVALID_ARGUMENT', `${MAX_TRANSFER_BYTES_ENV} invalide : ${raw}`);
  }
  return { maxTransferBytes: value };
}
