/**
 * Représentation machine de l'effet d'invocation prospectif des opérations
 * supportées (contrat P).
 *
 * **Projection de la primitive canonique**, jamais une table recopiée. Ce module
 * ne connaît aucun nombre : il demande à `operationEffect()` ce qu'une opération
 * peut engager, et le sérialise. Une seconde table publique divergerait au
 * premier changement d'exécution.
 *
 * Contrat statique : aucun run, aucune politique, aucun journal, aucun état.
 */

import { COCKPIT_OPERATION_IDS, operationEffect } from '../services/invocation-effect.ts';
import type { InvocationEffect } from '../services/invocation-effect.ts';

/** Version du contrat sémantique P. */
export const OPERATION_INVOCATION_EFFECT_CONTRACT_VERSION = 1;

/** Version de la représentation machine P. */
export const OPERATION_INVOCATION_EFFECT_MACHINE_REPRESENTATION_VERSION = 1;

/** Seule valeur admise par `--format`. */
export const OPERATION_INVOCATION_EFFECT_FORMAT = 'json';

/**
 * Vocabulaire d'opération de la représentation 1.
 *
 * Énoncé ici comme **liste figée de la version**, et non comme un alias du
 * vocabulaire courant du produit : une opération supportée nouvellement
 * introduite ne doit pas apparaître silencieusement dans un document de
 * représentation 1.
 */
export const OPERATION_INVOCATION_EFFECT_OPERATIONS_V1 = [
  'START',
  'STEP',
  'SEND',
  'PAUSE',
  'RESUME',
  'HANDOFF',
] as const;

/** L'effet traverse en union discriminée : `UNKNOWN` ne porte aucun compte. */
function serializeEffect(effect: InvocationEffect): Record<string, unknown> {
  return effect.kind === 'UNKNOWN' ? { kind: 'UNKNOWN' } : { kind: effect.kind, count: effect.count };
}

export function serializeOperationInvocationEffects(): string {
  const known = new Set<string>(COCKPIT_OPERATION_IDS);
  const operations = OPERATION_INVOCATION_EFFECT_OPERATIONS_V1.map((operation) => {
    if (!known.has(operation)) {
      // Le vocabulaire figé de la version 1 nomme une opération que la primitive
      // ne connaît plus : la projection ne fabrique aucun effet de repli.
      throw new Error(`Opération ${operation} absente de la primitive d'effet d'invocation.`);
    }
    const effect = operationEffect(operation);
    return {
      operation: effect.operation,
      may_call_provider: effect.may_call_provider,
      invocation_effect: serializeEffect(effect.invocation_effect),
    };
  });

  return JSON.stringify(
    {
      operation_invocation_effect_contract_version: OPERATION_INVOCATION_EFFECT_CONTRACT_VERSION,
      operation_invocation_effect_machine_representation_version:
        OPERATION_INVOCATION_EFFECT_MACHINE_REPRESENTATION_VERSION,
      operations,
    },
    null,
    2,
  );
}
