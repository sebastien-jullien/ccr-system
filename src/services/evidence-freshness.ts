/**
 * Fraîcheur V4 — lecture seule, pour les surfaces qui ne tiennent aucune vue.
 *
 * Tranche S5 du plan gelé, §8.2. Ce module existe pour une raison précise et
 * bornée : le service d'écriture V4 exige un `expected_evidence_revision`, et la
 * CLI n'a aucun moyen honnête de l'obtenir sans devenir consommatrice du format
 * natif — ce que la garde d'architecture lui interdit, et à juste titre.
 *
 * ```text
 * CLI  →  ce service  →  jeton autoritaire  →  service d'écriture V4
 * ```
 *
 * La CLI n'ouvre donc aucun journal, ne calcule aucune révision, et ne connaît
 * aucun format natif. Le consommateur légitime, c'est ce module.
 *
 * ## Ce que le jeton signifie — et ce qu'il ne signifie pas
 *
 * ```text
 * CLI_JIT_FRESHNESS_MEANS
 *     la commande agit contre un état V4 autoritairement observé au début de
 *     son exécution, et refuse si cet état change avant la mutation
 *
 * CLI_JIT_FRESHNESS_DOES_NOT_MEAN
 *     l'humain détenait cette vue avant de décider son geste
 * ```
 *
 * ```text
 * JIT CURRENT REVISION   ≠   USER-HELD PRIOR VIEW
 * ```
 *
 * Cette limite est **assumée**. Ce module ne protège pas contre une intention
 * fondée sur une vue ancienne extérieure à la commande : il protège contre
 * exactement une chose, qu'une mutation concurrente s'insère entre l'observation
 * et l'écriture. Aucune surface ne peut prétendre davantage.
 *
 * ## Une seule responsabilité
 *
 * Obtenir un snapshot stable par la primitive autoritaire, et rendre son
 * `evidence_revision` **tel quel**. Ce module n'écrit rien, ne crée aucun
 * journal, ne calcule aucune révision, ne projette aucun read model, ne
 * reconstruit ni matériau ni adduction, n'appelle aucun fournisseur et ne joint
 * aucun ledger.
 *
 * Recalculer la révision localement en créerait une seconde, qui divergerait le
 * jour où le store changerait d'espace de noms. Le snapshot est l'autorité.
 */

import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';

/** Dépendances — la forme qu'emploie déjà `buildNativeRunReadModel`. */
export interface EvidenceFreshnessDeps {
  readonly runsDir: string;
}

/**
 * Rend la fraîcheur V4 courante d'un run natif.
 *
 * Lève exactement ce que lève la primitive de snapshot, sans le convertir :
 * un run historique, un snapshot instable, un journal corrompu ou de version
 * inconnue sont des échecs de lecture. Aucun repli, aucune valeur par défaut,
 * aucun jeton fabriqué — un appelant qui ne peut pas observer l'état n'a pas le
 * droit de muter à l'aveugle.
 */
export async function readCurrentEvidenceRevision(
  deps: EvidenceFreshnessDeps,
  runId: string,
): Promise<string> {
  const snapshot = await readStableNativeRunSnapshot(deps.runsDir, runId);
  return snapshot.evidence_revision;
}
