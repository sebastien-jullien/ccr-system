/**
 * Contrôle de la politique de quota d'invocations (CCR V2.2, `V2.2-IMP-08`).
 *
 * Une seule question, posée juste avant chaque tentative :
 *
 * ```text
 * CCR s'autorise-t-il un engagement model-producing de plus sur ce run ?
 * ```
 *
 * Elle est distincte de celle que posent les planificateurs et les
 * classifieurs — « quelle action métier est possible ? ». Les deux ne se
 * mélangent jamais : une reprise reste proposée alors même que la politique
 * refusera son exécution, et c'est exact dans les deux sens.
 *
 * ## Autorité
 *
 * ```text
 * limite     invocation-policy.json          absent = aucune politique
 * consommé   InvocationLedger.count()        engagements réels
 * ```
 *
 * Rien d'autre. Ni jetons, ni coût, ni observation d'usage, ni reçu
 * d'opération, ni créneau d'admission, ni quota fournisseur — qui reste
 * `UNKNOWN`. Et jamais `nextSequence()`, qui est un curseur d'allocation : sur
 * un journal aux identifiants non contigus il dépasse le compte, et le quota
 * refuserait alors des tentatives légitimes.
 *
 * ## Juste-à-temps, sans réservation
 *
 * Le contrôle se rejoue **avant chaque tentative**, à partir du journal réel.
 * Une opération qui engage deux slots ne réserve donc rien : le premier
 * engagement est compté par le journal, et le second contrôle le voit. Aucun
 * `consumed` n'est mis en cache entre deux tentatives.
 *
 * ## Ce que cette primitive ne fait pas
 *
 * Elle n'alloue aucun `invocation_id`, n'écrit aucun `DISPATCH_COMMITTED`, ne
 * réserve aucune unité, ne mute aucun état et ne journalise aucun événement.
 * L'unité n'est consommée que par l'append autoritaire, là où il était déjà.
 */

import { CcrError } from '../core/errors.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../store/invocation-policy-store.ts';
import type { RunPaths } from '../store/layout.ts';

/** Ce que la politique autorisait au moment du contrôle. */
export interface InvocationQuotaSnapshot {
  readonly limit: number;
  readonly consumed: number;
  readonly remaining: number;
}

/**
 * Vérifie qu'une tentative de plus est permise, ou lève.
 *
 * Rend un instantané lorsqu'une politique existe, `undefined` lorsqu'il n'y en
 * a pas — le cas normal, et de loin le plus fréquent.
 *
 * Aucune politique ⇒ aucun refus, et **aucune lecture du journal** : un run non
 * gouverné par une limite ne paie pas le coût d'un comptage dont personne
 * n'aurait l'usage. Le journal sera ouvert de toute façon, plus tard, par
 * l'engagement lui-même.
 *
 * Un document présent mais illisible lève son propre code : ce n'est pas un
 * quota dépassé, c'est une gouvernance en panne, et surtout ce n'est **pas**
 * une autorisation. De même, une politique configurée dont le compte ne peut
 * pas être établi refuse la tentative en relayant l'erreur du journal : ne pas
 * savoir compter n'a jamais voulu dire zéro.
 */
export async function assertInvocationQuotaAvailable(
  paths: RunPaths,
  runId: string,
): Promise<InvocationQuotaSnapshot | undefined> {
  const policy = await openInvocationPolicyStore(paths).resolve();
  if (policy.kind === 'NONE') return undefined;

  const consumed = (await openInvocationLedger(paths, runId)).count();
  const limit = policy.maxInvocations;
  const remaining = Math.max(limit - consumed, 0);

  if (consumed >= limit) {
    throw new CcrError(
      'CCR_INVOCATION_QUOTA_EXCEEDED',
      `La politique du run ${runId} autorise ${String(limit)} invocation(s) ; ` +
        `${String(consumed)} ont déjà été engagées. Aucun agent n'est sollicité.`,
      // Trois nombres exacts sur la politique CCR, et le run qu'ils décrivent.
      // Ni prompt, ni réponse, ni sortie brute : un refus n'a rien à divulguer.
      { details: { runId, scope: 'run', limit, consumed, remaining: 0 } },
    );
  }

  return { limit, consumed, remaining };
}
