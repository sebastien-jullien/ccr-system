/**
 * Représentation machine de l'activité durable d'un run (F2).
 *
 * **Une représentation d'une lecture déjà faite**, jamais une autorité
 * nouvelle. Elle n'ouvre aucune persistance, ne complète aucun champ, et ne
 * requalifie aucun statut.
 *
 * ## Construction explicite, jamais par diffusion
 *
 * Chaque activité est bâtie champ par champ, à partir d'un `switch` fermé sur
 * son genre. Aucun `...activity` : un champ qui apparaîtrait demain dans la
 * projection ne peut pas fuir dans le contrat public par simple diffusion.
 *
 * ```text
 * JEU DE CHAMPS PRODUCTEUR  =  FERMÉ
 *
 * commun        activity_id · sequence · activity_kind · procedural_disposition
 * RUN_START     rien de plus
 * NATIVE_STEP   source_role · target_role · round
 * HUMAN_SEND    target_role
 * ```
 *
 * Sont donc absents, et le resteront en v1 : `state`, `created_at`,
 * `workspace`, `provider`, `session`, `timestamp`, `reason`, `message`,
 * `metadata`, `invocation_id`, et tout identifiant d'événement interne.
 *
 * ## Absence structurelle
 *
 * ```text
 * NON APPLICABLE  =  CLÉ OMISE
 * null            =  JAMAIS ÉMIS
 * ```
 *
 * `RUN_START` n'a ni rôle ni round ; `HUMAN_SEND` n'a ni source ni round.
 * Sérialiser `"source_role": null` transformerait une inapplicabilité en
 * valeur rendue.
 *
 * ## `activities`, et seulement quand il existe
 *
 * Le tableau n'apparaît que sous `AVAILABLE`. Sous `UNAVAILABLE` et
 * `PROJECTION_FAILURE`, la clé est **omise** : une histoire absente n'est pas
 * une histoire vide.
 *
 * ## Ordre
 *
 * Le tableau est sérialisé par `sequence` croissante. L'autorité d'ordre reste
 * `sequence` : la position dans le tableau n'en porte aucune de son propre chef.
 */

import type { RunActivity } from '../services/run-activity-projection.ts';
import type { RunActivityView } from '../services/run-activity-read.ts';

/** Version du contrat sémantique dont ce document rend les jetons. */
export const DURABLE_RUN_ACTIVITY_CONTRACT_VERSION = 1;

/** Version de la représentation machine. */
export const DURABLE_RUN_ACTIVITY_MACHINE_REPRESENTATION_VERSION = 1;

/** Seule valeur admise par `--format` sur `ccr run-activity`. */
export const RUN_ACTIVITY_FORMAT = 'json';

/**
 * Une activité, en objet discriminé fermé.
 *
 * Le `switch` est exhaustif sur l'union de la projection : ajouter un genre
 * sans l'aiguiller ici casse le `typecheck`, plutôt que de tomber dans une
 * branche générique qu'il faudrait inventer.
 */
function machineActivity(activity: RunActivity): Record<string, unknown> {
  switch (activity.activity_kind) {
    case 'RUN_START':
      return {
        activity_id: activity.activity_id,
        sequence: activity.sequence,
        activity_kind: activity.activity_kind,
        procedural_disposition: activity.procedural_disposition,
      };

    case 'NATIVE_STEP':
      return {
        activity_id: activity.activity_id,
        sequence: activity.sequence,
        activity_kind: activity.activity_kind,
        procedural_disposition: activity.procedural_disposition,
        source_role: activity.source_role,
        target_role: activity.target_role,
        round: activity.round,
      };

    case 'HUMAN_SEND':
      return {
        activity_id: activity.activity_id,
        sequence: activity.sequence,
        activity_kind: activity.activity_kind,
        procedural_disposition: activity.procedural_disposition,
        target_role: activity.target_role,
      };
  }
}

/**
 * Rend le document machine complet.
 *
 * Un `AVAILABLE` avec `"activities": []` est une **cardinalité** : l'histoire
 * F2 requise a été reconstruite complètement, et elle ne contient aucune
 * activité des trois familles. Ce n'est ni une indisponibilité, ni un échec.
 */
export function serializeRunActivity(view: RunActivityView): string {
  const head = {
    durable_run_activity_contract_version: DURABLE_RUN_ACTIVITY_CONTRACT_VERSION,
    durable_run_activity_machine_representation_version:
      DURABLE_RUN_ACTIVITY_MACHINE_REPRESENTATION_VERSION,
    run_id: view.run_id,
    projection_status: view.projection_status,
  };

  if (view.projection_status !== 'AVAILABLE') {
    // Aucune clé `activities`. L'omission est le fait.
    return JSON.stringify(head, null, 2);
  }

  const ordered = [...view.activities].sort((a, b) => a.sequence - b.sequence);
  return JSON.stringify({ ...head, activities: ordered.map(machineActivity) }, null, 2);
}
