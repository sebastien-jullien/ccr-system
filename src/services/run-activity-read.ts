/**
 * Activité durable machine d'un run — lecture (F2).
 *
 * Lecture **seule**, calculée à la demande, qui ne persiste rien et n'écrit
 * jamais. Elle établit d'abord si F2 s'applique au run visé, puis remet les
 * faits durables à la couche de normalisation.
 *
 * ```text
 * 1. APPLICABILITÉ   la génération du run, lue dans son manifest
 * 2. MATIÈRE         l'état canonique et le journal natif
 * 3. NORMALISATION   faits internes → activités publiques
 * ```
 *
 * ## Trois issues publiques, jamais confondues
 *
 * ```text
 * AVAILABLE            l'histoire F2 requise est complète, et la voici
 * UNAVAILABLE          elle ne peut pas être reconstruite complètement
 * PROJECTION_FAILURE   F2 s'applique, mais la projection n'a pas pu être
 *                      produite de façon fiable à la lecture
 * ```
 *
 * Les trois sont des **succès de commande**. Un run introuvable ou un manifest
 * illisible n'en fait pas partie : sans manifest, l'applicabilité elle-même
 * n'est pas établie, et la lecture lève.
 *
 * ## Pourquoi un run historique est indisponible
 *
 * Le contrat F2 nomme des rôles — `author`, `challenger`. Un journal historique
 * n'en porte aucun : il enregistre un **moteur** (`claude`, `codex`). Déduire
 * le rôle du fournisseur est explicitement interdit, et deux experts partageant
 * un moteur rendraient de toute façon la déduction fausse. L'histoire requise
 * n'existe donc pas, et le dire est le seul comportement honnête.
 *
 * ```text
 * provider → role   JAMAIS
 * ```
 */

import { isCcrError } from '../core/errors.ts';
import type { RunPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import { projectRunActivity } from './run-activity-projection.ts';
import type { RunActivity } from './run-activity-projection.ts';

/** Discriminant public de la lecture. Vocabulaire fermé. */
export const PROJECTION_STATUSES = ['AVAILABLE', 'UNAVAILABLE', 'PROJECTION_FAILURE'] as const;

export type ProjectionStatus = (typeof PROJECTION_STATUSES)[number];

/**
 * Vue rendue à la surface machine.
 *
 * `activities` n'existe **que** dans la variante disponible. Le rendre vide
 * dans les deux autres reviendrait à dire « zéro activité » là où CCR dit
 * « je ne peux pas reconstruire », ce que le contrat interdit.
 */
export type RunActivityView =
  | {
      readonly run_id: string;
      readonly projection_status: 'AVAILABLE';
      readonly activities: readonly RunActivity[];
    }
  | {
      readonly run_id: string;
      readonly projection_status: 'UNAVAILABLE' | 'PROJECTION_FAILURE';
    };

/**
 * Lit l'activité durable publique d'un run.
 *
 * Le manifest est lu **sans filet** : son absence ou son illisibilité est une
 * erreur de commande, pas une issue de projection. Tout ce qui vient ensuite
 * est protégé, parce qu'à ce stade l'applicabilité est établie et qu'un échec
 * de lecture ne doit plus être confondu avec une absence d'histoire.
 */
export async function readRunActivity(paths: RunPaths): Promise<RunActivityView> {
  const persisted = await readPersistedManifest(paths);
  const runId = paths.runId;

  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    // Génération historique : aucun rôle d'expert n'est enregistré. L'histoire
    // requise par F2 n'existe pas, et rien ne la reconstruira.
    return { run_id: runId, projection_status: 'UNAVAILABLE' };
  }

  const manifest = persisted.manifest;

  let state;
  let events;
  try {
    const persistedState = await readPersistedState(paths);
    if (persistedState.execution_mode !== 'NATIVE_V21_EXECUTION') {
      // Deux documents d'un même run se réclamant de générations différentes :
      // la projection ne tranche pas, et ne prétend pas non plus à une
      // histoire absente.
      return { run_id: runId, projection_status: 'PROJECTION_FAILURE' };
    }
    state = persistedState.document;
    const store = await openNativeEventStore(paths, manifest);
    events = await store.readAll();
  } catch (error) {
    // Applicabilité établie, matière inexploitable : c'est exactement ce que
    // `PROJECTION_FAILURE` nomme. Aucun code, aucun message ne traverse.
    void isCcrError(error);
    return { run_id: runId, projection_status: 'PROJECTION_FAILURE' };
  }

  const projection = projectRunActivity(runId, state, events);
  // Les deux issues non disponibles de la normalisation traversent telles
  // quelles : la lecture ne requalifie pas une histoire absente en échec de
  // projection, ni l'inverse.
  if (projection.status !== 'AVAILABLE') {
    return { run_id: runId, projection_status: projection.status };
  }

  return {
    run_id: runId,
    projection_status: 'AVAILABLE',
    activities: projection.activities,
  };
}
