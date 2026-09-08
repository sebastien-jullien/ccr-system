/**
 * Lecture de la comptabilité d'invocation publique d'un run (contrat R1).
 *
 * Projection **dérivée**, calculée à la demande. Rien de ce qu'elle rend n'est
 * persisté : la limite vient du document de politique, le consommé du journal
 * d'invocations, et le restant s'en déduit.
 *
 * ## Ce qui la distingue de la vue interne de quota
 *
 * `readInvocationQuotaView` rend `consumed = 0` lorsqu'aucun journal n'existe,
 * accompagné de la couverture `PRE_LEDGER` qui le qualifie. Le contrat public
 * refuse ce zéro : sous `PRE_LEDGER`, `consumed`, `remaining`, `exhausted` et
 * l'attribution par déclencheur sont **structurellement absents**.
 *
 * ```text
 * PRE_LEDGER   ≠  zéro invocation historique
 * ```
 *
 * L'autorité comptable n'est pas modifiée pour autant : c'est la projection qui
 * refuse d'affirmer ce qu'elle ne sait pas.
 *
 * ## Préalable de sélecteur, et rien de plus
 *
 * L'identité est résolue d'abord — **découvrabilité** — et l'échec traverse.
 * Rendre `NONE`, `PRE_LEDGER` ou `AVAILABLE` pour une identité non découvrable
 * affirmerait une propriété d'un objet qui n'existe pas, et ferait passer une
 * ignorance pour une connaissance exacte.
 *
 * Au-delà de ce préalable, **aucun étage d'applicabilité**. Ce contrat
 * s'applique à tout run découvrable, quelle que soit sa génération : une
 * métadonnée de domaine absente ou illisible — génération, état, titre — n'est
 * ni un échec de sélecteur, ni une cause de `PROJECTION_FAILURE`. Elle est sans
 * effet ici, et rien de ce module ne l'ouvre.
 *
 * ```text
 * S1   résolution d'identité   découvrabilité
 * S3   projection              politique · journal
 *      AUCUN étage d'applicabilité entre les deux
 * ```
 *
 * ## Autorités lues, et rien d'autre
 *
 * ```text
 * limite     invocation-policy.json     absent = aucune politique
 * consommé   InvocationLedger.count()   engagements réels, unité DISPATCH_COMMITTED
 * attribution  trigger_kind de chaque engagement
 * ```
 *
 * Ni activité procédurale, ni fait d'issue, ni observation d'usage, ni curseur
 * d'allocation.
 */

import { INVOCATION_TRIGGER_KINDS } from '../core/usage-governance.ts';
import type { InvocationTriggerKind } from '../core/usage-governance.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../store/invocation-policy-store.ts';
import { pathExists } from '../store/atomic-file.ts';
import { runPaths } from '../store/layout.ts';
import { requireDiscoverableRun } from './run-existence.ts';

/** Statuts de projection du contrat R1. Deux, et deux seulement. */
export const RUN_INVOCATION_ACCOUNTING_PROJECTION_STATUSES = [
  'AVAILABLE',
  'PROJECTION_FAILURE',
] as const;

export type RunInvocationAccountingProjectionStatus =
  (typeof RUN_INVOCATION_ACCOUNTING_PROJECTION_STATUSES)[number];

/**
 * Politique de budget, en union discriminée.
 *
 * `NONE` et `CONFIGURED` avec un maximum de zéro sont **opposés** : le premier
 * dit qu'aucune règle n'existe, le second qu'une règle interdit tout.
 */
export type PublicBudgetPolicy =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'CONFIGURED'; readonly max_invocations: number };

/** Ce que le compte couvre réellement. Vocabulaire gelé par le contrat V2.2 §22. */
export type InvocationAccountingCoverage = 'PRE_LEDGER' | 'SINCE_LEDGER_START';

/** Attribution dense : une entrée par déclencheur connu, sans exception. */
export type TriggerAttribution = Readonly<Record<InvocationTriggerKind, number>>;

export type RunInvocationAccountingView =
  | {
      readonly run_id: string;
      readonly projection_status: 'PROJECTION_FAILURE';
    }
  | {
      readonly run_id: string;
      readonly projection_status: 'AVAILABLE';
      readonly budget_policy: PublicBudgetPolicy;
      readonly coverage: 'PRE_LEDGER';
    }
  | {
      readonly run_id: string;
      readonly projection_status: 'AVAILABLE';
      readonly budget_policy: PublicBudgetPolicy;
      readonly coverage: 'SINCE_LEDGER_START';
      readonly consumed: number;
      /** Présent uniquement lorsque la politique est `CONFIGURED`. */
      readonly remaining?: number;
      /** Présent uniquement lorsque la politique est `CONFIGURED`. */
      readonly exhausted?: boolean;
      readonly trigger_attribution: TriggerAttribution;
    };

/** Objet dense initialisé à zéro sur tout le vocabulaire fermé. */
function emptyAttribution(): Record<InvocationTriggerKind, number> {
  const table = {} as Record<InvocationTriggerKind, number>;
  for (const trigger of INVOCATION_TRIGGER_KINDS) table[trigger] = 0;
  return table;
}

/**
 * Rend la comptabilité d'invocation publique du run.
 *
 * Le sélecteur est résolu **avant** toute lecture : une identité non découvrable
 * fait échouer l'appel, et ne rend aucune vue. Une identité découvrable, elle,
 * obtient toujours une réponse — la génération du run n'est jamais consultée.
 *
 * Sur un run découvrable, une politique présente mais illisible, comme un
 * journal présent mais illisible, rend `PROJECTION_FAILURE` — jamais `NONE`, et
 * jamais un consommé nul. Ne pas savoir compter n'a jamais voulu dire zéro, et
 * une gouvernance en panne n'est pas une absence de règle.
 *
 * Le `runsDir` est reçu tel quel plutôt que déduit d'un chemin de run : la
 * découvrabilité est une question posée à l'énumération, pas à un répertoire
 * particulier.
 */
export async function readRunInvocationAccounting(
  runsDir: string,
  runId: string,
): Promise<RunInvocationAccountingView> {
  // Hors du `try` : une identité non découvrable doit traverser. Captée par le
  // filet ci-dessous, elle deviendrait `PROJECTION_FAILURE` — c'est-à-dire un
  // fait rendu sur un run qui n'existe pas.
  await requireDiscoverableRun(runsDir, runId);

  const paths = runPaths(runsDir, runId);

  try {
    const resolved = await openInvocationPolicyStore(paths).resolve();
    const budget_policy: PublicBudgetPolicy =
      resolved.kind === 'NONE'
        ? { kind: 'NONE' }
        : { kind: 'CONFIGURED', max_invocations: resolved.maxInvocations };

    // L'absence du fichier est le fait ; sa présence rend le compte exact depuis
    // sa première ligne. Testée avant l'ouverture, qui ne crée rien mais ne
    // saurait pas distinguer « absent » de « vide ».
    if (!(await pathExists(paths.invocations))) {
      return { run_id: runId, projection_status: 'AVAILABLE', budget_policy, coverage: 'PRE_LEDGER' };
    }

    const ledger = await openInvocationLedger(paths, runId);
    const consumed = ledger.count();

    const attribution = emptyAttribution();
    for (const record of await ledger.readAll()) attribution[record.trigger_kind] += 1;

    const configured =
      budget_policy.kind === 'CONFIGURED'
        ? {
            remaining: Math.max(budget_policy.max_invocations - consumed, 0),
            exhausted: consumed >= budget_policy.max_invocations,
          }
        : {};

    return {
      run_id: runId,
      projection_status: 'AVAILABLE',
      budget_policy,
      coverage: 'SINCE_LEDGER_START',
      consumed,
      ...configured,
      trigger_attribution: attribution,
    };
  } catch {
    // Aucun code, aucun message ne traverse : le contrat public nomme un échec de
    // projection, il ne diagnostique pas.
    return { run_id: runId, projection_status: 'PROJECTION_FAILURE' };
  }
}
