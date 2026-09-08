/**
 * Représentation machine de l'état opérationnel d'un run natif (contrat R2).
 *
 * **Construction explicite, champ par champ.** Aucun document interne ne
 * traverse : ni identifiant d'événement, ni session, ni fournisseur, ni contenu.
 *
 * Sous `NOT_APPLICABLE` et `PROJECTION_FAILURE`, aucune autre clé n'est rendue.
 * Aucun état natif n'est fabriqué pour un run qui n'en a pas.
 */

import type { RunOperationalStateView } from '../services/run-operational-state-read.ts';

/** Version du contrat sémantique R2. */
export const RUN_OPERATIONAL_STATE_CONTRACT_VERSION = 1;

/** Version de la représentation machine R2. */
export const RUN_OPERATIONAL_STATE_MACHINE_REPRESENTATION_VERSION = 1;

/** Seule valeur admise par `--format`. */
export const RUN_OPERATIONAL_STATE_FORMAT = 'json';

export function serializeRunOperationalState(view: RunOperationalStateView): string {
  const envelope = {
    run_operational_state_contract_version: RUN_OPERATIONAL_STATE_CONTRACT_VERSION,
    run_operational_state_machine_representation_version:
      RUN_OPERATIONAL_STATE_MACHINE_REPRESENTATION_VERSION,
    run_id: view.run_id,
    projection_status: view.projection_status,
  };

  if (view.projection_status !== 'AVAILABLE') {
    return JSON.stringify(envelope, null, 2);
  }

  const plan = view.next_transfer_plan;
  return JSON.stringify(
    {
      ...envelope,
      native_state: view.native_state,
      terminal: view.terminal,
      control_owner: view.control_owner,
      // Indisponible : aucune raison publique en version 1. Le consommateur qui
      // veut savoir pourquoi consulte les autorités concernées à leur surface.
      next_transfer_plan: plan.available
        ? {
            available: true,
            source_role: plan.source_role,
            target_role: plan.target_role,
            next_round: plan.next_round,
          }
        : { available: false },
    },
    null,
    2,
  );
}
