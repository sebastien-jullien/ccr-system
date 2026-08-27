/**
 * Lecture de la politique de quota et de sa consommation (CCR V2.2,
 * `V2.2-IMP-09`).
 *
 * Projection **dérivée**, calculée à la demande. Rien de ce qu'elle rend n'est
 * persisté : la limite vient du document de politique, le consommé du journal
 * d'invocations, et le restant s'en déduit. Persister l'un des deux créerait
 * une seconde vérité, capable de contredire les fichiers qui font autorité.
 *
 * ## Lire ne modifie rien
 *
 * Aucun fichier n'est créé pour afficher un zéro. Un run sans journal en est
 * dépourvu parce qu'aucune invocation V2.2 n'y a encore été engagée — et
 * consulter un statut n'a pas à changer cela.
 *
 * ## Zéro n'est pas « rien ne s'est passé »
 *
 * ```text
 * PRE_LEDGER            aucun journal : l'activité antérieure est
 *                       explicitement indisponible, jamais nulle
 * SINCE_LEDGER_START    le journal existe : le compte est exact depuis lui
 * ```
 *
 * Un run historique peut porter vingt réponses de modèle et un `consumed` de
 * zéro. Les deux sont vrais, et la couverture est ce qui les réconcilie.
 *
 * ## Ce que cette vue ne contient pas
 *
 * Ni jetons, ni coût, ni devise, ni estimation, ni quota fournisseur — qui
 * reste `UNKNOWN`. Elle décrit une politique CCR d'invocations, et rien
 * d'autre.
 */

import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../store/invocation-policy-store.ts';
import { pathExists } from '../store/atomic-file.ts';
import type { RunPaths } from '../store/layout.ts';

/**
 * Ce que le compte couvre réellement.
 *
 * Vocabulaire gelé par le contrat V2.2 (§22) : il ne se réinvente pas ici.
 */
export type InvocationQuotaCoverage = 'PRE_LEDGER' | 'SINCE_LEDGER_START';

export type InvocationQuotaView =
  | {
      readonly kind: 'NONE';
      readonly consumed: number;
      readonly coverage: InvocationQuotaCoverage;
    }
  | {
      readonly kind: 'CONFIGURED';
      readonly limit: number;
      readonly consumed: number;
      /** Dérivé, plancher à zéro : jamais un restant négatif. */
      readonly remaining: number;
      /** Seul dérivé booléen. Décrit la politique, jamais une capacité métier. */
      readonly exhausted: boolean;
      readonly coverage: InvocationQuotaCoverage;
    };

/**
 * Rend la politique du run et sa consommation.
 *
 * Une politique **présente mais illisible** lève, et ne devient jamais `NONE` :
 * ce serait présenter une gouvernance en panne comme une absence de règle. Un
 * journal illisible lève de même, plutôt que de rendre `consumed = 0` — ne pas
 * savoir compter n'a jamais voulu dire zéro.
 */
export async function readInvocationQuotaView(paths: RunPaths): Promise<InvocationQuotaView> {
  const policy = await openInvocationPolicyStore(paths).resolve();

  // L'absence du fichier est le fait ; sa présence rend le compte exact depuis
  // sa première ligne. Testée avant l'ouverture, qui ne crée rien mais ne
  // saurait pas distinguer « absent » de « vide ».
  const journaled = await pathExists(paths.invocations);
  const coverage: InvocationQuotaCoverage = journaled ? 'SINCE_LEDGER_START' : 'PRE_LEDGER';
  const consumed = journaled ? (await openInvocationLedger(paths, paths.runId)).count() : 0;

  if (policy.kind === 'NONE') return { kind: 'NONE', consumed, coverage };

  const limit = policy.maxInvocations;
  return {
    kind: 'CONFIGURED',
    limit,
    consumed,
    remaining: Math.max(limit - consumed, 0),
    exhausted: consumed >= limit,
    coverage,
  };
}
