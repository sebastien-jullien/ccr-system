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

import {
  COCKPIT_OPERATION_IDS,
  MODEL_ASSISTED_OPERATION_IDS,
  operationEffect,
} from '../services/invocation-effect.ts';
import type { InvocationEffect, OperationId } from '../services/invocation-effect.ts';

/** Version du contrat sémantique P. */
export const OPERATION_INVOCATION_EFFECT_CONTRACT_VERSION = 1;

/**
 * Représentations machine que ce contrat définit.
 *
 * Deux axes indépendants : ajouter une opération au document exige une nouvelle
 * **représentation**, jamais une nouvelle version de **sens**. Le contrat
 * sémantique reste donc en 1 pendant que la représentation avance seule.
 */
export const OPERATION_INVOCATION_EFFECT_MACHINE_REPRESENTATION_VERSIONS = [1, 2] as const;

export type OperationInvocationEffectMachineRepresentationVersion =
  (typeof OPERATION_INVOCATION_EFFECT_MACHINE_REPRESENTATION_VERSIONS)[number];

/** Représentation rendue lorsque l'appelant n'en demande aucune. */
export const DEFAULT_OPERATION_INVOCATION_EFFECT_MACHINE_REPRESENTATION_VERSION: OperationInvocationEffectMachineRepresentationVersion = 1;

export function isOperationInvocationEffectMachineRepresentationVersion(
  value: number,
): value is OperationInvocationEffectMachineRepresentationVersion {
  return (OPERATION_INVOCATION_EFFECT_MACHINE_REPRESENTATION_VERSIONS as readonly number[]).includes(
    value,
  );
}

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

/**
 * Vocabulaire d'opération de la représentation 2.
 *
 * Liste **figée**, elle aussi : les six de la représentation 1, inchangées, plus
 * les trois opérations assistées par modèle. Ce n'est pas une énumération
 * dynamique du produit — une opération future ne s'y ajoute pas d'elle-même, et
 * exigera sa propre évolution de représentation.
 */
export const OPERATION_INVOCATION_EFFECT_OPERATIONS_V2 = [
  'START',
  'STEP',
  'SEND',
  'PAUSE',
  'RESUME',
  'HANDOFF',
  'DETECT',
  'PROPOSE',
  'ADDUCE_MODEL',
] as const;

const OPERATIONS_BY_REPRESENTATION: Readonly<
  Record<OperationInvocationEffectMachineRepresentationVersion, readonly OperationId[]>
> = {
  1: OPERATION_INVOCATION_EFFECT_OPERATIONS_V1,
  2: OPERATION_INVOCATION_EFFECT_OPERATIONS_V2,
};

/** L'effet traverse en union discriminée : `UNKNOWN` ne porte aucun compte. */
function serializeEffect(effect: InvocationEffect): Record<string, unknown> {
  return effect.kind === 'UNKNOWN' ? { kind: 'UNKNOWN' } : { kind: effect.kind, count: effect.count };
}

export function serializeOperationInvocationEffects(
  representation: OperationInvocationEffectMachineRepresentationVersion = DEFAULT_OPERATION_INVOCATION_EFFECT_MACHINE_REPRESENTATION_VERSION,
): string {
  const known = new Set<string>([...COCKPIT_OPERATION_IDS, ...MODEL_ASSISTED_OPERATION_IDS]);
  const operations = OPERATIONS_BY_REPRESENTATION[representation].map((operation) => {
    if (!known.has(operation)) {
      // Le vocabulaire figé de la représentation nomme une opération que la
      // primitive ne connaît plus : la projection ne fabrique aucun effet de
      // repli.
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
      operation_invocation_effect_machine_representation_version: representation,
      operations,
    },
    null,
    2,
  );
}
