/**
 * Fraîcheur V5 — lecture seule, pour les surfaces qui ne tiennent aucune vue.
 *
 * Tranche S4 du plan gelé. Ce module existe pour une raison précise et bornée :
 * le contrat §32 exige que toute mutation déclare la révision autoritaire sur
 * laquelle elle a été préparée, et la CLI n'a aucun moyen honnête de l'obtenir
 * sans devenir consommatrice directe du format d'instantané — ce que la
 * séparation déjà tenue par le dépôt lui interdit, et à juste titre.
 *
 * ```text
 * CLI  →  ce service  →  jeton autoritaire  →  service d'écriture V5
 * ```
 *
 * ## Ce que le jeton signifie — et ce qu'il ne signifie pas
 *
 * ```text
 * JIT_FRESHNESS_MEANS
 *     la commande agit contre un état V5 autoritairement observé au début de
 *     son exécution, et refusera si cet état change avant la mutation
 *
 * JIT_FRESHNESS_DOES_NOT_MEAN
 *     l'humain a vu cet état, a décidé sur cet état, ou détient une session
 *     rattachée à cet état
 * ```
 *
 * ```text
 * JIT CURRENT REVISION   ≠   USER-HELD PRIOR VIEW
 * FRESHNESS              ≠   HUMAN COGNITIVE SNAPSHOT
 * ```
 *
 * Cette limite est **assumée**. Le jeton protège contre exactement une chose :
 * qu'une mutation concurrente s'insère entre l'observation et l'écriture. Aucune
 * surface ne peut prétendre davantage, et aucun champ de ce module ne le
 * suggère.
 *
 * ## Une seule responsabilité
 *
 * Obtenir un instantané stable par la primitive autoritaire, et rendre sa
 * `reconciliation_revision` **telle quelle**. Ce module n'écrit rien, ne crée
 * aucun journal, ne calcule aucune révision, ne projette aucun read model,
 * n'acquiert aucun verrou, n'appelle aucun fournisseur et ne joint aucun ledger.
 *
 * Recalculer la révision localement en créerait une seconde, qui divergerait le
 * jour où le store changerait d'espace de noms. L'instantané est l'autorité.
 *
 * ## Aucune comparaison ici
 *
 * Ce module rend une valeur ; il n'en compare aucune. `expected_revision` est
 * une **entrée** du service de mutation, distincte de l'`observed_revision` que
 * celui-ci relira sous son propre verrou. L'API ci-dessous ne prend aucun
 * paramètre attendu et ne rend aucun booléen : elle ne peut donc pas rendre une
 * comparaison tautologique inévitable.
 *
 * ```text
 * REVISION PRODUCTION   ≠   FRESHNESS ENFORCEMENT
 * ```
 */

import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';

/** Dépendances — la forme qu'emploient déjà les seams de lecture natifs. */
export interface ReconciliationFreshnessDeps {
  readonly runsDir: string;
}

/**
 * Rend la fraîcheur V5 courante d'un run natif.
 *
 * Le jeton appartient au domaine `rcn-sha256:` et à lui seul. Il n'est jamais
 * comparé à `sha256:`, `ctv-sha256:` ni `ev-sha256:` : une égalité d'empreintes
 * entre deux domaines n'aurait aucune signification.
 *
 * Lève exactement ce que lève la primitive d'instantané, sans le convertir : un
 * run historique, un instantané instable, un journal corrompu ou de version
 * inconnue sont des échecs de lecture. Aucun repli, aucune valeur par défaut,
 * aucun jeton fabriqué — un appelant qui ne peut pas observer l'état n'a pas le
 * droit de muter à l'aveugle.
 */
export async function readCurrentReconciliationRevision(
  deps: ReconciliationFreshnessDeps,
  runId: string,
): Promise<string> {
  const snapshot = await readStableNativeRunSnapshot(deps.runsDir, runId);
  return snapshot.reconciliation_revision;
}
