/**
 * Lecture agrégée d'une invocation : engagement, issue négative, preuve de
 * succès.
 *
 * ## La règle que ce module refuse d'appliquer
 *
 * ```text
 * fait négatif absent   →  UNKNOWN        ✗ INTERDIT
 * objet résultat absent →  ÉCHEC          ✗ INTERDIT
 * ```
 *
 * L'absence n'est une conclusion dans aucun sens. C'est la même discipline que
 * le modèle de lecture d'usage, dont la doc pose déjà « Zéro signifie `UNKNOWN`
 * — jamais zéro jeton, jamais zéro coût ».
 *
 * ## L'état contradictoire ne se tranche pas
 *
 * Un fait négatif durable **et** une preuve de succès durable pour la même
 * invocation décrivent un monde impossible. CCR ne choisit pas : il rend
 * `INCONSISTENT` et le signale au diagnostic, exactement comme
 * `findOrphanUsageObservations` rend une incohérence croisée « au diagnostic
 * plutôt que levée ». Aucune priorité automatique, aucun vainqueur.
 *
 * Un run reste lisible : une contradiction sémantique n'est pas une corruption
 * de persistance, et seule la seconde justifie de refuser une lecture.
 *
 * ## Corrélation de la preuve de succès
 *
 * ```text
 * V3 · V4 · V5   derivation.invocation_id           corrélation DIRECTE
 * natif          InvocationDispatchRecord.prompt_event_id
 *                ↔ assistant_response.based_on      corrélation INDIRECTE
 * ```
 *
 * Les événements natifs ne portent aucun `invocation_id` : la jointure passe
 * par l'événement de prompt, que le dispatch nomme et que la réponse cite. Ce
 * module lit cette corrélation ; il n'en crée aucune, et **n'écrit aucun
 * enregistrement de succès** — la durabilité du succès n'est pas décidée.
 */

import type { ControversyEntry } from '../core/controversy.ts';
import type { EvidenceEntry } from '../core/evidence.ts';
import { isValidZeroOutcome, terminalOutcomeOf } from '../core/invocation-outcome.ts';
import type { InvocationOutcomeRecord } from '../core/invocation-outcome.ts';
import type { ReconciliationEntry } from '../core/reconciliation.ts';
import type { NativeCcrEvent } from '../core/run-native.ts';
import type { InvocationDispatchRecord } from '../core/usage-governance.ts';

/**
 * Ce que l'état durable établit d'une invocation.
 *
 * ```text
 * VALID_ZERO_KNOWN   un fait VALID_ZERO durable existe
 * NEGATIVE_KNOWN     un fait négatif durable existe
 * SUCCESS_EVIDENCE   une preuve de succès durable existe, et elle seule
 * UNKNOWN            aucune preuve durable suffisante, dans aucun sens
 * INCONSISTENT       un fait terminal ET une preuve de succès — contradictoire
 * ```
 *
 * `VALID_ZERO_KNOWN` nomme **une** issue objectless précise, et rien de plus
 * large. Ce n'est pas un `SUCCESS_KNOWN` générique, et il n'en existe aucun :
 * un succès qui produit son objet de domaine reste attesté par cet objet.
 *
 * La version persistée du fait n'entre pas dans cette lecture — un fait négatif
 * historique et un fait négatif courant disent exactement la même chose.
 */
export type InvocationOutcomeState =
  | 'VALID_ZERO_KNOWN'
  | 'NEGATIVE_KNOWN'
  | 'SUCCESS_EVIDENCE'
  | 'UNKNOWN'
  | 'INCONSISTENT';

export interface InvocationOutcomeView {
  readonly invocation_id: string;
  readonly state: InvocationOutcomeState;
  /** Renseigné dès qu'un fait terminal existe — y compris en `INCONSISTENT`. */
  readonly terminal?: InvocationOutcomeRecord;
  /** Références des preuves de succès durables corrélées à cette invocation. */
  readonly success_evidence: readonly string[];
}

/** Une contradiction observée, rendue au diagnostic et jamais tranchée. */
export interface InvocationOutcomeInconsistency {
  readonly invocation_id: string;
  readonly terminal: InvocationOutcomeRecord;
  readonly success_evidence: readonly string[];
}

/** Un fait d'issue dont l'invocation n'existe pas au ledger. */
export interface OrphanInvocationOutcome {
  readonly invocation_id: string;
}

export interface InvocationOutcomeReadModel {
  readonly by_invocation: readonly InvocationOutcomeView[];
  readonly anomalies: {
    readonly inconsistent: readonly InvocationOutcomeInconsistency[];
    readonly orphan_outcomes: readonly OrphanInvocationOutcome[];
  };
}

export interface InvocationOutcomeSources {
  readonly invocations: readonly InvocationDispatchRecord[];
  readonly outcomes: readonly InvocationOutcomeRecord[];
  readonly events: readonly NativeCcrEvent[];
  readonly controversies: readonly ControversyEntry[];
  readonly evidence: readonly EvidenceEntry[];
  readonly reconciliations: readonly ReconciliationEntry[];
}

function derivationInvocationId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const derivation = (value as { derivation?: unknown }).derivation;
  if (derivation === null || typeof derivation !== 'object') return undefined;
  const id = (derivation as { invocation_id?: unknown }).invocation_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Références de succès durables, par invocation.
 *
 * Une entrée V3/V4/V5 dérivée d'un modèle nomme son invocation ; un
 * `assistant_response` natif cite le `prompt_sent` que le dispatch désigne.
 * Aucune autre inférence : un événement qui ne cite rien n'est corrélé à rien.
 */
function successEvidenceByInvocation(sources: InvocationOutcomeSources): Map<string, string[]> {
  const byInvocation = new Map<string, string[]>();
  const push = (invocationId: string, reference: string): void => {
    const bucket = byInvocation.get(invocationId);
    if (bucket === undefined) byInvocation.set(invocationId, [reference]);
    else bucket.push(reference);
  };

  for (const entry of [...sources.controversies, ...sources.evidence, ...sources.reconciliations]) {
    const invocationId = derivationInvocationId(entry);
    const reference = (entry as { entry_id?: unknown }).entry_id;
    if (invocationId !== undefined && typeof reference === 'string') push(invocationId, reference);
  }

  // Corrélation native, par l'événement de prompt. Le dispatch le nomme ; la
  // réponse le cite. Rien d'autre n'est joint.
  const byPromptEvent = new Map<string, string>();
  for (const dispatch of sources.invocations) {
    if (dispatch.prompt_event_id !== undefined) {
      byPromptEvent.set(dispatch.prompt_event_id, dispatch.invocation_id);
    }
  }
  for (const event of sources.events) {
    if (event.type !== 'assistant_response') continue;
    for (const basis of event.based_on ?? []) {
      const invocationId = byPromptEvent.get(basis);
      if (invocationId !== undefined) push(invocationId, event.event_id);
    }
  }

  return byInvocation;
}

/**
 * Projette l'état durable de chaque invocation engagée.
 *
 * Fonction **pure** : elle n'ouvre rien, et ne conclut jamais d'une absence.
 */
export function projectInvocationOutcomes(
  sources: InvocationOutcomeSources,
): InvocationOutcomeReadModel {
  // Une seule table de faits terminaux, toutes versions et toutes polarités
  // confondues : l'exclusivité terminale garantit qu'une invocation n'en porte
  // qu'un, et le store la fait respecter sans jamais consulter la polarité.
  const terminals = new Map(sources.outcomes.map((outcome) => [outcome.invocation_id, outcome]));
  const successes = successEvidenceByInvocation(sources);

  const inconsistent: InvocationOutcomeInconsistency[] = [];

  const by_invocation = sources.invocations.map((dispatch): InvocationOutcomeView => {
    const terminal = terminals.get(dispatch.invocation_id);
    const evidence = successes.get(dispatch.invocation_id) ?? [];

    if (terminal !== undefined && evidence.length > 0) {
      const contradiction = {
        invocation_id: dispatch.invocation_id,
        terminal,
        success_evidence: evidence,
      };
      inconsistent.push(contradiction);
      return {
        invocation_id: dispatch.invocation_id,
        state: 'INCONSISTENT',
        terminal,
        success_evidence: evidence,
      };
    }

    if (terminal !== undefined) {
      return {
        invocation_id: dispatch.invocation_id,
        // Le nom de stockage historique n'entre pas ici : la lecture porte sur
        // ce que le fait signifie, pas sur la version qui l'a persisté.
        state: isValidZeroOutcome(terminalOutcomeOf(terminal)) ? 'VALID_ZERO_KNOWN' : 'NEGATIVE_KNOWN',
        terminal,
        success_evidence: [],
      };
    }

    // Absence de fait négatif : aucune conclusion par elle-même. Seule une
    // preuve de succès durable fait pencher la lecture, et uniquement pour ce
    // qu'elle établit.
    return {
      invocation_id: dispatch.invocation_id,
      state: evidence.length > 0 ? 'SUCCESS_EVIDENCE' : 'UNKNOWN',
      success_evidence: evidence,
    };
  });

  // Une issue dont l'invocation manque au ledger est rendue au diagnostic,
  // jamais levée : le motif de `findOrphanUsageObservations`, repris tel quel.
  const known = new Set(sources.invocations.map((dispatch) => dispatch.invocation_id));
  const orphan_outcomes = sources.outcomes
    .filter((outcome) => !known.has(outcome.invocation_id))
    .map((outcome) => ({ invocation_id: outcome.invocation_id }));

  return { by_invocation, anomalies: { inconsistent, orphan_outcomes } };
}
