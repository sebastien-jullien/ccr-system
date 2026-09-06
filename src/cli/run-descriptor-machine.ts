/**
 * Représentation machine de la découverte sémantique des runs (F1).
 *
 * **Une représentation d'une autorité déjà lue**, jamais une autorité nouvelle.
 * Elle n'ouvre aucune persistance, ne complète aucun champ, et ne juge pas la
 * vue qu'on lui remet.
 *
 * ## Construction explicite, jamais par diffusion
 *
 * Chaque descripteur est bâti champ par champ. Aucun `...descriptor` : un champ
 * qui apparaîtrait demain en amont ne peut pas fuir dans le contrat public par
 * simple diffusion d'objet.
 *
 * ```text
 * JEU DE CHAMPS PRODUCTEUR  =  FERMÉ
 * run_id · title            et rien d'autre
 * ```
 *
 * Sont donc absents, et le resteront en v1 : `state`, `created_at`,
 * `workspace`, `generation`, `provider`, `session`, `activity`, `metadata`.
 *
 * ## Ordre
 *
 * L'ordre reçu traverse tel quel. Ce module n'introduit aucun tri, et le
 * contrat v1 n'attache **aucune** sémantique à la position dans le tableau.
 *
 * ## Complet, ou rien
 *
 * Ce module ne sait produire qu'un document complet. Il n'existe aucun chemin
 * qui rendrait un descripteur sans titre, un titre nul, ou un sous-ensemble des
 * runs découvrables : une lecture qui n'a pas pu tout établir lève avant
 * d'arriver ici.
 */

import type { RunDescriptorsView } from '../services/run-descriptor-read.ts';

/** Version du contrat sémantique dont ce document rend les jetons. */
export const SEMANTIC_RUN_DISCOVERY_CONTRACT_VERSION = 1;

/** Version de la représentation machine. */
export const SEMANTIC_RUN_DISCOVERY_MACHINE_REPRESENTATION_VERSION = 1;

/** Seule valeur admise par `--format` sur `ccr run-descriptors`. */
export const RUN_DESCRIPTOR_FORMAT = 'json';

/**
 * Rend le document machine complet.
 *
 * Une énumération sans identité rend `"runs": []`. Ce tableau vide est une
 * **cardinalité** : il dit zéro run découvrable dans le contexte résolu, et
 * rien de plus — ni succès, ni échec, ni santé, ni absence d'activité passée.
 */
export function serializeRunDescriptors(view: RunDescriptorsView): string {
  const document = {
    semantic_run_discovery_contract_version: SEMANTIC_RUN_DISCOVERY_CONTRACT_VERSION,
    semantic_run_discovery_machine_representation_version:
      SEMANTIC_RUN_DISCOVERY_MACHINE_REPRESENTATION_VERSION,
    // Deux champs, nommés un par un. Les doublons de titre sont préservés :
    // chaque run découvrable a son descripteur, même titre ou non.
    runs: view.descriptors.map((descriptor) => ({
      run_id: descriptor.run_id,
      title: descriptor.title,
    })),
  };

  return JSON.stringify(document, null, 2);
}
