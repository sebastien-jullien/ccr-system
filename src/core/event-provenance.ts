/**
 * Règles de provenance des événements, par génération
 * (spécification V2.1 V0.3, §15.3 ; amendement V2.1-IMP-01).
 *
 * Deux vocabulaires cohabitent sur disque, jamais dans le même journal :
 *
 *   legacy    `actor = claude|codex`, `target = claude|codex`
 *   natif     `expert_slot_id`, `target_expert_slot_id`,
 *             `source_slot_id` + `target_slot_id`
 *
 * Ce module est pur : il décrit ce qu'un événement doit porter, et refuse ce
 * qui ferait cohabiter les deux identités. Il n'écrit rien, ne lit aucun
 * fichier, et ne connaît pas la disposition du run.
 *
 * Il est importé par les **deux** stores, ce qui garantit qu'aucun des deux ne
 * peut appliquer une règle que l'autre ignore.
 */

import { CcrError } from './errors.ts';
import { isExpertSlotId } from './expert.ts';
import type { ExpertSlotId } from './expert.ts';
import {
  EXPERT_SESSION_EVENT_TYPES,
  EXPERT_TARGET_EVENT_TYPES,
  HANDOFF_RESOLUTION_EVENT_TYPES,
  HANDOFF_RESOLUTION_REASONS,
  NATIVE_EVENT_ACTORS,
  SEND_RESOLUTION_EVENT_TYPES,
  SEND_RESOLUTION_REASONS,
  TRANSFER_ABORTED_EVENT_TYPES,
  TRANSFER_ABORTED_REASONS,
  TRANSFER_BLOCKED_EVENT_TYPES,
  TRANSFER_BLOCKED_REASONS,
  TRANSFER_EVENT_TYPES,
  TRANSFER_QUARANTINE_EVENT_TYPES,
  TRANSFER_QUARANTINE_REASONS,
} from './run-native.ts';
import type {
  HandoffResolutionEventType,
  NativeCcrEvent,
  NativeEventType,
  SendResolutionEventType,
} from './run-native.ts';
import { EVENT_TYPES } from './run.ts';

/**
 * Classe de provenance d'un type d'événement natif.
 *
 * `GENERATION_NEUTRAL` remplace l'ancien `SLOTLESS` (micro-gate 1B.1) : le nom
 * décrit désormais ce que la classe garantit — une forme identique dans les
 * deux générations — et non seulement ce qu'elle omet.
 */
export type EventProvenanceShape =
  | 'EXPERT_SESSION'
  | 'EXPERT_TARGET'
  | 'TRANSFER'
  | 'TRANSFER_BLOCKED'
  | 'TRANSFER_QUARANTINED'
  | 'TRANSFER_ABORTED'
  | 'SEND_RESOLUTION'
  | 'HANDOFF_RESOLUTION'
  | 'GENERATION_NEUTRAL';

/** Tous les champs de provenance natifs, quelle que soit la forme. */
export const NATIVE_SLOT_FIELDS = [
  'expert_slot_id',
  'target_expert_slot_id',
  'source_slot_id',
  'target_slot_id',
] as const;

const ALLOWED_SLOT_FIELDS: Readonly<Record<EventProvenanceShape, readonly string[]>> = {
  EXPERT_SESSION: ['expert_slot_id'],
  EXPERT_TARGET: ['target_expert_slot_id'],
  TRANSFER: ['source_slot_id', 'target_slot_id'],
  TRANSFER_BLOCKED: ['source_slot_id', 'target_slot_id'],
  TRANSFER_QUARANTINED: ['source_slot_id', 'target_slot_id'],
  TRANSFER_ABORTED: ['source_slot_id', 'target_slot_id'],
  SEND_RESOLUTION: ['target_expert_slot_id'],
  HANDOFF_RESOLUTION: ['target_expert_slot_id'],
  GENERATION_NEUTRAL: [],
};

/** Types qu'un journal natif accepte : ceux du cœur, plus les types natifs. */
const NATIVE_EVENT_TYPES: readonly string[] = [
  ...EVENT_TYPES,
  ...TRANSFER_BLOCKED_EVENT_TYPES,
  ...TRANSFER_QUARANTINE_EVENT_TYPES,
  ...TRANSFER_ABORTED_EVENT_TYPES,
  ...SEND_RESOLUTION_EVENT_TYPES,
  ...HANDOFF_RESOLUTION_EVENT_TYPES,
];

/** Types natifs absents du cœur : un journal historique ne les accepte jamais. */
const NATIVE_ONLY_EVENT_TYPES: readonly string[] = [
  ...TRANSFER_BLOCKED_EVENT_TYPES,
  ...TRANSFER_QUARANTINE_EVENT_TYPES,
  ...TRANSFER_ABORTED_EVENT_TYPES,
  ...SEND_RESOLUTION_EVENT_TYPES,
  ...HANDOFF_RESOLUTION_EVENT_TYPES,
];

export function provenanceShapeOf(type: NativeEventType): EventProvenanceShape {
  if ((EXPERT_SESSION_EVENT_TYPES as readonly string[]).includes(type)) return 'EXPERT_SESSION';
  if ((EXPERT_TARGET_EVENT_TYPES as readonly string[]).includes(type)) return 'EXPERT_TARGET';
  if ((TRANSFER_EVENT_TYPES as readonly string[]).includes(type)) return 'TRANSFER';
  if ((TRANSFER_BLOCKED_EVENT_TYPES as readonly string[]).includes(type)) return 'TRANSFER_BLOCKED';
  if ((TRANSFER_QUARANTINE_EVENT_TYPES as readonly string[]).includes(type)) return 'TRANSFER_QUARANTINED';
  if ((TRANSFER_ABORTED_EVENT_TYPES as readonly string[]).includes(type)) return 'TRANSFER_ABORTED';
  if ((SEND_RESOLUTION_EVENT_TYPES as readonly string[]).includes(type)) return 'SEND_RESOLUTION';
  if ((HANDOFF_RESOLUTION_EVENT_TYPES as readonly string[]).includes(type)) return 'HANDOFF_RESOLUTION';
  return 'GENERATION_NEUTRAL';
}

function journalInvalid(message: string, details: Record<string, unknown> = {}): CcrError {
  return new CcrError('JOURNAL_INVALID', message, { details });
}

function at(lineNumber: number | null): string {
  return lineNumber === null ? 'événement' : `events.jsonl ligne ${lineNumber}`;
}

// --------------------------------------------------------------------------
// Gardes de génération
// --------------------------------------------------------------------------

/**
 * Refuse un événement portant une identité **native** dans un journal legacy.
 *
 * Appelée à l'écriture, avant tout accès au fichier : un append refusé ne
 * touche pas le journal. C'est ce qui rend le journal mixte impossible par
 * construction plutôt que déconseillé par convention.
 */
export function assertNoNativeProvenance(event: Readonly<Record<string, unknown>>): void {
  for (const field of NATIVE_SLOT_FIELDS) {
    if (field in event) {
      throw journalInvalid(
        `Un run historique n'accepte aucun événement natif : « ${field} » n'a pas de sens dans un journal legacy.`,
        { field, generation: 'LEGACY_V2_EXECUTION' },
      );
    }
  }
  if (event['actor'] === 'expert') {
    throw journalInvalid(
      "Un run historique n'accepte pas l'acteur « expert » : son journal nomme les acteurs par fournisseur.",
      { field: 'actor', generation: 'LEGACY_V2_EXECUTION' },
    );
  }
  if (NATIVE_ONLY_EVENT_TYPES.includes(String(event['type']))) {
    throw journalInvalid(
      `Un run historique n'accepte pas le type natif « ${String(event['type'])} ».`,
      { field: 'type', generation: 'LEGACY_V2_EXECUTION' },
    );
  }
}

/**
 * Portée exacte de la garde ci-dessus, consignée pour qu'elle ne soit pas
 * présentée comme plus large qu'elle ne l'est (micro-gate 1B.1).
 *
 * Elle refuse les événements **porteurs d'identité**. Un événement
 * generation-neutral — `run_created`, `run_paused`, `state_changed` sans cible —
 * possède volontairement le même contrat de fil dans les deux générations : il
 * n'y a rien à refuser, et le record ne prouve donc rien sur sa génération.
 *
 * Ce que la génération d'un run détermine reste, et seulement :
 *
 * ```text
 * manifest → execution_mode → store sélectionné
 * ```
 */
export const GENERATION_IS_NEVER_PROVEN_BY_A_NEUTRAL_RECORD = true;

/**
 * Refuse un événement portant une identité **fournisseur** dans un journal natif.
 *
 * Un `actor = claude` cohabitant avec un `expert_slot_id = author` créerait
 * deux faits capables de diverger. Il n'existe donc pas de règle de priorité
 * entre eux : le second n'est jamais écrit.
 */
export function assertNoLegacyProvenance(event: Readonly<Record<string, unknown>>): void {
  const actor = event['actor'];
  if (actor === 'claude' || actor === 'codex') {
    throw journalInvalid(
      `Un run natif n'accepte pas l'acteur « ${String(actor)} » : le fournisseur n'est pas une identité métier.`,
      { field: 'actor', generation: 'NATIVE_V21_EXECUTION' },
    );
  }
  if ('target' in event && event['target'] !== null && event['target'] !== undefined) {
    throw journalInvalid(
      "Un run natif n'accepte pas « target » : la cible est un slot, nommé par les champs de provenance.",
      { field: 'target', generation: 'NATIVE_V21_EXECUTION' },
    );
  }
}

// --------------------------------------------------------------------------
// Validation de forme d'un événement natif
// --------------------------------------------------------------------------

function requireSlot(record: Record<string, unknown>, field: string, where: string): ExpertSlotId {
  const value = record[field];
  if (!isExpertSlotId(value)) {
    throw journalInvalid(`${where} : ${field} invalide (${String(value)}) — un slot est attendu.`, { field });
  }
  return value;
}

function requireNonEmptyString(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw journalInvalid(`${where} : ${field} absent ou invalide.`, { field });
  }
  return value;
}

/**
 * Valide la forme d'un événement natif.
 *
 * La cardinalité est vérifiée **par type** : un `round_completed` ne peut pas
 * se contenter d'un slot unique, et un `decision_recorded` ne peut pas en
 * recevoir un. Un champ de slot étranger à la forme attendue est refusé plutôt
 * qu'ignoré — l'ignorer laisserait un fait non interprété dans un fichier
 * canonique.
 *
 * @param lineNumber numéro de ligne pour un journal relu, `null` à l'écriture.
 */
export function validateNativeEventShape(value: unknown, lineNumber: number | null): NativeCcrEvent {
  const where = at(lineNumber);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw journalInvalid(`${where} : objet JSON attendu.`, { line: lineNumber });
  }
  const record = value as Record<string, unknown>;

  assertNoLegacyProvenance(record);

  const actor = record['actor'];
  if (typeof actor !== 'string' || !(NATIVE_EVENT_ACTORS as readonly string[]).includes(actor)) {
    throw journalInvalid(`${where} : acteur natif inconnu ${String(actor)}.`, { field: 'actor' });
  }

  const type = record['type'];
  if (typeof type !== 'string' || !NATIVE_EVENT_TYPES.includes(type)) {
    throw journalInvalid(`${where} : type inconnu ${String(type)}.`, { field: 'type' });
  }

  const shape = provenanceShapeOf(type as NativeEventType);
  const allowed = ALLOWED_SLOT_FIELDS[shape];
  for (const field of NATIVE_SLOT_FIELDS) {
    if (field in record && !allowed.includes(field)) {
      throw journalInvalid(
        `${where} : « ${field} » n'a pas de sens sur un événement « ${type} » (provenance ${shape}).`,
        { field, type, shape },
      );
    }
  }

  switch (shape) {
    case 'EXPERT_SESSION': {
      requireSlot(record, 'expert_slot_id', where);
      requireNonEmptyString(record, 'session_id', where);
      break;
    }
    case 'EXPERT_TARGET': {
      requireSlot(record, 'target_expert_slot_id', where);
      const session = record['session_id'];
      if (session !== undefined && session !== null && (typeof session !== 'string' || session.length === 0)) {
        throw journalInvalid(`${where} : session_id invalide.`, { field: 'session_id' });
      }
      break;
    }
    case 'TRANSFER': {
      const source = requireSlot(record, 'source_slot_id', where);
      const target = requireSlot(record, 'target_slot_id', where);
      if (source === target) {
        throw journalInvalid(`${where} : un passage de témoin a une source et une cible distinctes.`, {
          field: 'source_slot_id',
        });
      }
      requireNonEmptyString(record, 'source_event_id', where);
      requireNonEmptyString(record, 'response_event_id', where);
      break;
    }
    case 'TRANSFER_BLOCKED':
    case 'TRANSFER_QUARANTINED':
    case 'TRANSFER_ABORTED': {
      const source = requireSlot(record, 'source_slot_id', where);
      const target = requireSlot(record, 'target_slot_id', where);
      if (source === target) {
        throw journalInvalid(`${where} : un transfert sans issue a une source et une cible distinctes.`, {
          field: 'source_slot_id',
        });
      }
      requireNonEmptyString(record, 'source_event_id', where);
      // Aucune réponse connue : le champ est **interdit**, pas facultatif. Sur
      // une quarantaine, l'inventer nul laisserait croire à une conclusion.
      if ('response_event_id' in record) {
        throw journalInvalid(
          `${where} : aucun transfert abouti ici ; « response_event_id » n'a pas de sens.`,
          { field: 'response_event_id' },
        );
      }
      // Trois vocabulaires distincts pour trois issues distinctes : un motif
      // ne migre jamais d'une classe à l'autre.
      const allowed =
        shape === 'TRANSFER_BLOCKED'
          ? (TRANSFER_BLOCKED_REASONS as readonly string[])
          : shape === 'TRANSFER_ABORTED'
            ? (TRANSFER_ABORTED_REASONS as readonly string[])
            : (TRANSFER_QUARANTINE_REASONS as readonly string[]);
      const reason = record['reason'];
      if (typeof reason !== 'string' || !allowed.includes(reason)) {
        throw journalInvalid(`${where} : motif inconnu ${String(reason)} pour ${shape}.`, { field: 'reason' });
      }
      break;
    }
    case 'SEND_RESOLUTION': {
      requireSlot(record, 'target_expert_slot_id', where);
      // L'envoi clos est **nommé**. Sans cet identifiant, le marqueur ne
      // clôturerait rien de vérifiable : le même message paraîtrait encore
      // sans issue au diagnostic suivant.
      requireNonEmptyString(record, 'prompt_event_id', where);
      // Aucune réponse n'est connue — dans un cas parce qu'aucun appel n'a eu
      // lieu, dans l'autre parce que CCR l'ignore. Le champ est donc interdit,
      // et non facultatif : nul, il laisserait croire à une conclusion.
      if ('response_event_id' in record) {
        throw journalInvalid(
          `${where} : aucun envoi abouti ici ; « response_event_id » n'a pas de sens.`,
          { field: 'response_event_id', type },
        );
      }
      // Ni session : une clôture ne nomme aucune continuité native, et
      // surtout n'affirme pas qu'une session a été touchée.
      if ('session_id' in record) {
        throw journalInvalid(
          `${where} : « session_id » n'a pas de sens sur une clôture d'envoi — ` +
            "elle ne prétend pas qu'une session a été atteinte.",
          { field: 'session_id', type },
        );
      }
      // Motif attribué **par type** : les deux marqueurs ne sont pas
      // interchangeables, et leurs motifs ne migrent pas de l'un à l'autre.
      const expected = SEND_RESOLUTION_REASONS[type as SendResolutionEventType];
      if (record['reason'] !== expected) {
        throw journalInvalid(
          `${where} : « ${type} » exige le motif « ${expected} », pas « ${String(record['reason'])} ».`,
          { field: 'reason', type },
        );
      }
      break;
    }
    case 'HANDOFF_RESOLUTION': {
      requireSlot(record, 'target_expert_slot_id', where);
      // L'ouverture close est **nommée**, comme une clôture d'envoi nomme son
      // message. Le champ diffère parce que le fait diffère : un handoff n'a
      // pas de prompt, il a une ouverture.
      requireNonEmptyString(record, 'started_event_id', where);
      // Et surtout pas `prompt_event_id` : une clôture d'envoi nomme un message
      // dont CCR possède le contenu, une clôture de handoff nomme une ouverture
      // dont il ignore la suite. Les deux familles ne se confondent pas.
      if ('prompt_event_id' in record) {
        throw journalInvalid(
          `${where} : un handoff n'a pas de prompt ; il a une ouverture, nommée par « started_event_id ».`,
          { field: 'prompt_event_id', type },
        );
      }
      if ('response_event_id' in record) {
        throw journalInvalid(
          `${where} : un handoff ne produit aucune réponse ; « response_event_id » n'a pas de sens.`,
          { field: 'response_event_id', type },
        );
      }
      // Aucune session : la clôture ne prétend pas qu'une continuité native a
      // été atteinte, et encore moins qu'elle est inchangée.
      if ('session_id' in record) {
        throw journalInvalid(
          `${where} : « session_id » n'a pas de sens sur une clôture de handoff.`,
          { field: 'session_id', type },
        );
      }
      const expectedReason = HANDOFF_RESOLUTION_REASONS[type as HandoffResolutionEventType];
      if (record['reason'] !== expectedReason) {
        throw journalInvalid(
          `${where} : « ${type} » exige le motif « ${expectedReason} », pas « ${String(record['reason'])} ».`,
          { field: 'reason', type },
        );
      }
      break;
    }
    case 'GENERATION_NEUTRAL': {
      // Le champ doit être **absent**, et non seulement vide. Tolérer
      // `session_id: null` donnerait deux représentations de fil pour un seul
      // fait — le champ omis et le champ nul — dans la classe même dont toute
      // la valeur est d'avoir une forme minimale, identique dans les deux
      // générations. Une provenance de session native est indissociable d'une
      // provenance d'ExpertSlot.
      if ('session_id' in record) {
        throw journalInvalid(
          `${where} : « session_id » n'existe pas sur un événement « ${type} » — ` +
            "une session native appartient toujours à un expert.",
          { field: 'session_id', type, shape },
        );
      }
      break;
    }
  }

  return record as unknown as NativeCcrEvent;
}
