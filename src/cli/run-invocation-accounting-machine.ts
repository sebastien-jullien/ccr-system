/**
 * Représentation machine de la comptabilité d'invocation d'un run (contrat R1).
 *
 * **Construction explicite, champ par champ.** Aucun objet interne n'est diffusé,
 * si bien qu'un champ apparaissant demain en amont ne peut pas fuir dans le
 * contrat public.
 *
 * ## Absence structurelle
 *
 * Une clé absente est absente. Elle n'est jamais rendue à `null`, ni à `0`, ni à
 * une chaîne sentinelle. C'est ce qui distingue « CCR ne sait pas » de « CCR sait
 * que c'est zéro », et le contrat en fait un invariant.
 */

import type {
  PublicBudgetPolicy,
  RunInvocationAccountingView,
} from '../services/run-invocation-accounting-read.ts';

/** Version du contrat sémantique R1. */
export const RUN_INVOCATION_ACCOUNTING_CONTRACT_VERSION = 1;

/** Version de la représentation machine R1. */
export const RUN_INVOCATION_ACCOUNTING_MACHINE_REPRESENTATION_VERSION = 1;

/** Seule valeur admise par `--format`. */
export const RUN_INVOCATION_ACCOUNTING_FORMAT = 'json';

/** La politique traverse en union discriminée, jamais en nombre nullable. */
function serializePolicy(policy: PublicBudgetPolicy): Record<string, unknown> {
  return policy.kind === 'NONE'
    ? { kind: 'NONE' }
    : { kind: 'CONFIGURED', max_invocations: policy.max_invocations };
}

export function serializeRunInvocationAccounting(view: RunInvocationAccountingView): string {
  const envelope = {
    run_invocation_accounting_contract_version: RUN_INVOCATION_ACCOUNTING_CONTRACT_VERSION,
    run_invocation_accounting_machine_representation_version:
      RUN_INVOCATION_ACCOUNTING_MACHINE_REPRESENTATION_VERSION,
    run_id: view.run_id,
    projection_status: view.projection_status,
  };

  if (view.projection_status === 'PROJECTION_FAILURE') {
    return JSON.stringify(envelope, null, 2);
  }

  if (view.coverage === 'PRE_LEDGER') {
    // Ni `consumed`, ni `remaining`, ni `exhausted`, ni attribution : l'activité
    // antérieure au journal n'est pas reconstructible, et un zéro mentirait.
    return JSON.stringify(
      { ...envelope, budget_policy: serializePolicy(view.budget_policy), coverage: view.coverage },
      null,
      2,
    );
  }

  const configured =
    view.remaining === undefined || view.exhausted === undefined
      ? {}
      : { remaining: view.remaining, exhausted: view.exhausted };

  return JSON.stringify(
    {
      ...envelope,
      budget_policy: serializePolicy(view.budget_policy),
      coverage: view.coverage,
      consumed: view.consumed,
      ...configured,
      // Dense : une entrée par déclencheur connu, y compris à zéro. La densité
      // rend impossible de confondre une absence d'entrée avec une ignorance.
      trigger_attribution: { ...view.trigger_attribution },
    },
    null,
    2,
  );
}
