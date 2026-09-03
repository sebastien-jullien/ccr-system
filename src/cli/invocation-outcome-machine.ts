/**
 * Représentation machine des faits dédiés d'issue d'invocation.
 *
 * **Une représentation alternative de la même autorité**, jamais une autorité
 * nouvelle. Elle ne lit rien que la vue déjà normalisée par le service de
 * lecture, n'ouvre aucune persistance, et n'interroge aucune autre autorité.
 *
 * ## Construction explicite, jamais par diffusion
 *
 * Chaque objet rendu est bâti champ par champ, à partir d'un `switch` fermé sur
 * le genre d'issue. Aucun `...outcome`, aucun report d'attribut inconnu : un
 * champ qui apparaîtrait demain dans le domaine ou dans la persistance ne peut
 * pas fuir dans le contrat public par simple diffusion d'objet.
 *
 * ```text
 * NOMS DE STOCKAGE   outcomes · terminal_outcome · terminal_negative_outcome
 *                    · schema_version de document
 *                    → n'apparaissent JAMAIS ici
 * ```
 *
 * ## Absence
 *
 * ```text
 * ABSENCE  =  CLÉ OMISE
 * null     =  JAMAIS ÉMIS
 * ```
 *
 * L'absence d'`error_code` porte un sens exact — CCR ne connaît pas de code
 * significatif. Sérialiser `"error_code": null` transformerait cette ignorance
 * déclarée en valeur rendue.
 *
 * ## `recorded_at`
 *
 * Transmis **verbatim**. Le sérialiseur ne l'analyse pas, ne le reformate pas
 * et n'y attache aucune promesse de format, de fuseau ni de précision.
 *
 * ## Ce que ce module n'écrit jamais
 *
 * ```text
 * aucun statut          ni SUCCESS, ni FAILED, ni UNKNOWN, ni NOT_COMMITTED
 * aucun agrégat         ni compte, ni taux, ni gravité
 * aucun document partiel
 * aucun objet d'erreur structuré
 * ```
 */

import type { NativeFailureDetail, TerminalOutcome } from '../core/invocation-outcome.ts';
import type {
  InvocationOutcomeFact,
  InvocationOutcomeFactsView,
} from '../services/invocation-outcome-read.ts';

/** Version du contrat de représentation machine. */
export const MACHINE_REPRESENTATION_VERSION = 1;

/** Version du contrat sémantique dont ce document rend les jetons. */
export const MACHINE_SEMANTIC_CONTRACT_VERSION = 1;

/** Seule valeur admise par `--format`. */
export const MACHINE_FORMAT = 'json';

/**
 * Détail natif typé, membre par membre.
 *
 * Les deux variantes ne partagent que `code`, `expert_slot` et `provider` ; le
 * reste est propre à chacune, et aucun membre d'une variante n'apparaît dans
 * l'autre.
 */
function machineNativeDetail(detail: NativeFailureDetail): Record<string, unknown> {
  if (detail.code === 'SESSION_ID_COLLISION') {
    return {
      code: detail.code,
      expert_slot: detail.expert_slot,
      provider: detail.provider,
      session_id: detail.session_id,
    };
  }
  return {
    code: detail.code,
    expert_slot: detail.expert_slot,
    provider: detail.provider,
    expected_session_id: detail.expected_session_id,
    found_session_id: detail.found_session_id,
  };
}

/**
 * Issue, en objet discriminé fermé.
 *
 * Le `switch` est exhaustif sur l'union du domaine : ajouter un genre sans
 * l'aiguiller ici casse le `typecheck`, plutôt que de tomber dans une branche
 * générique qu'il faudrait inventer.
 */
function machineOutcome(outcome: TerminalOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case 'VALID_ZERO':
      // Fait sans charge utile. Rien n'est ajouté : ni succès, ni statut, ni
      // glose — sa signification appartient à la doctrine.
      return { kind: outcome.kind };

    case 'V3_INVALID_OUTPUT':
    case 'V4_INVALID_OUTPUT':
    case 'V5_INVALID_OUTPUT':
      return { kind: outcome.kind, reason: outcome.reason, at: outcome.at };

    case 'V4_REVALIDATION_REFUSED':
    case 'V5_REVALIDATION_REFUSED':
      return { kind: outcome.kind, check: outcome.check, detail: outcome.detail };

    case 'V3_PROVIDER_FAILED':
    case 'V4_PROVIDER_FAILED':
    case 'V5_PROVIDER_FAILED':
      return outcome.error_code === undefined
        ? { kind: outcome.kind }
        : { kind: outcome.kind, error_code: outcome.error_code };

    case 'NATIVE_PROCESS_FAILED':
      return {
        kind: outcome.kind,
        ...(outcome.error_code === undefined ? {} : { error_code: outcome.error_code }),
        ...(outcome.native_detail === undefined
          ? {}
          : { native_detail: machineNativeDetail(outcome.native_detail) }),
      };
  }
}

/** Un fait, réduit aux quatre concepts publics du contrat. */
function machineFact(fact: InvocationOutcomeFact): Record<string, unknown> {
  return {
    invocation_id: fact.invocation_id,
    // Verbatim : aucune analyse, aucune reformulation.
    recorded_at: fact.recorded_at,
    source_record_version: fact.source_schema_version,
    outcome: machineOutcome(fact.outcome),
  };
}

/**
 * Rend le document machine complet.
 *
 * Un seul document JSON, plat au premier niveau. `invocation_filter` n'est
 * présent que si un filtre a réellement été appliqué : son omission dit qu'il
 * n'y en avait pas, là où `null` inventerait une valeur.
 *
 * Une projection complète sans correspondance rend `"facts": []`. Ce tableau
 * vide est une cardinalité, jamais un succès, un échec, un `VALID_ZERO`, un
 * `UNKNOWN` ni un `NOT_COMMITTED`.
 */
export function serializeInvocationOutcomeFacts(view: InvocationOutcomeFactsView): string {
  const document = {
    machine_representation_version: MACHINE_REPRESENTATION_VERSION,
    semantic_contract_version: MACHINE_SEMANTIC_CONTRACT_VERSION,
    run_id: view.run_id,
    ...(view.filter === undefined ? {} : { invocation_filter: view.filter.invocation_id }),
    facts: view.facts.map(machineFact),
  };

  return JSON.stringify(document, null, 2);
}
