/**
 * Journal append-only d'un run **natif V2.1**.
 *
 * Mêmes garanties structurelles que le journal historique — append-only,
 * séquence strictement croissante reconstruite depuis le fichier, ligne
 * illisible signalée et jamais ignorée — avec une provenance différente : les
 * acteurs sont des slots d'expert, pas des fournisseurs.
 *
 * Deux niveaux de validation, volontairement séparés :
 *
 *   forme         `validateNativeEventShape` — indépendante du run
 *   contexte      confrontation au manifest — seulement quand elle est applicable
 *
 * La séparation n'est pas cosmétique : `session_created` **est** l'événement
 * qui accompagne l'acquisition d'une session. Exiger qu'il corresponde à une
 * session déjà liée créerait une dépendance circulaire qu'aucune
 * initialisation ne pourrait satisfaire.
 */

import { CcrError } from '../core/errors.ts';
import { assertNoLegacyProvenance, provenanceShapeOf } from '../core/event-provenance.ts';
import { validateNativeEventShape } from '../core/event-provenance.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import { formatEventId, parseEventSequence } from '../core/ids.ts';
import type { NativeCcrEvent, NativeRunManifest, NewNativeCcrEvent } from '../core/run-native.ts';
import type {
  ExpertTargetEventType,
  HandoffResolutionEventType,
  NativeEventType,
  SendResolutionEventType,
} from '../core/run-native.ts';
import { appendJsonLine } from './atomic-file.ts';
import type { EventStore, JournalReadSeams } from './event-store.ts';
import { openEventStore } from './event-store.ts';
import { parseJournalLine, readJsonlJournal } from './jsonl-journal.ts';
import type { JournalRecord } from './jsonl-journal.ts';
import type { RunPaths } from './layout.ts';
import type { PersistedManifest } from './native-store.ts';

export interface NativeEventStore {
  append(event: NewNativeCcrEvent): Promise<NativeCcrEvent>;
  readAll(): Promise<NativeCcrEvent[]>;
  lastEventId(): string | null;
  nextSequence(): number;
}

function journalInvalid(message: string, details: Record<string, unknown> = {}): CcrError {
  return new CcrError('JOURNAL_INVALID', message, { details });
}

/**
 * Slots concernés par un événement, pour la validation contextuelle.
 *
 * Le couple `(slot, session)` est renvoyé plutôt que le slot seul : c'est le
 * couple qui doit rester cohérent avec le manifest, jamais l'un des deux pris
 * isolément.
 */
function slotsConcernedBy(event: NativeCcrEvent): readonly { slot: ExpertSlotId; session: string | null }[] {
  switch (provenanceShapeOf(event.type as NativeEventType)) {
    case 'EXPERT_SESSION': {
      const e = event as Extract<NativeCcrEvent, { expert_slot_id: ExpertSlotId }>;
      return [{ slot: e.expert_slot_id, session: e.session_id }];
    }
    case 'EXPERT_TARGET': {
      const e = event as Extract<NativeCcrEvent, { type: ExpertTargetEventType }>;
      return [{ slot: e.target_expert_slot_id, session: e.session_id ?? null }];
    }
    // Une clôture d'envoi ou de handoff nomme le slot visé, jamais une
    // session : elle ne prétend pas qu'une continuité native a été atteinte.
    case 'SEND_RESOLUTION': {
      const e = event as Extract<NativeCcrEvent, { type: SendResolutionEventType }>;
      return [{ slot: e.target_expert_slot_id, session: null }];
    }
    case 'HANDOFF_RESOLUTION': {
      const e = event as Extract<NativeCcrEvent, { type: HandoffResolutionEventType }>;
      return [{ slot: e.target_expert_slot_id, session: null }];
    }
    case 'TRANSFER':
    case 'TRANSFER_BLOCKED':
    case 'TRANSFER_QUARANTINED':
    case 'TRANSFER_ABORTED': {
      const e = event as Extract<NativeCcrEvent, { source_slot_id: ExpertSlotId }>;
      return [
        { slot: e.source_slot_id, session: null },
        { slot: e.target_slot_id, session: null },
      ];
    }
    case 'GENERATION_NEUTRAL':
      return [];
  }
}

/**
 * Confronte un événement au manifest du run.
 *
 * Deux vérifications, et pas une de plus :
 *
 *  - le slot existe réellement dans `manifest.experts` ;
 *  - si l'événement nomme une session **et** que le slot en a déjà une liée,
 *    ce doit être la même.
 *
 * `session_created` est exempté de la seconde : il documente précisément le
 * moment où la session devient celle du slot.
 */
function assertConsistentWithManifest(event: NativeCcrEvent, manifest: NativeRunManifest): void {
  for (const { slot, session } of slotsConcernedBy(event)) {
    const binding = manifest.experts[slot];
    if (binding === undefined) {
      throw journalInvalid(`Le slot « ${slot} » n'existe pas dans le manifest de ce run.`, { slot });
    }
    if (event.type === 'session_created') continue;
    if (session !== null && binding.session_id !== null && session !== binding.session_id) {
      throw journalInvalid(
        `La session « ${session} » n'est pas celle liée au slot « ${slot} » dans ce run.`,
        { slot, expected: binding.session_id, found: session },
      );
    }
  }
}

/**
 * Ouvre le journal natif d'un run.
 *
 * Le manifest est requis : sans lui, la validation contextuelle serait
 * impossible, et la provenance retomberait à une simple vérification de forme.
 */
export async function openNativeEventStore(
  paths: RunPaths,
  manifest: NativeRunManifest | (() => NativeRunManifest),
  options: JournalReadSeams = {},
): Promise<NativeEventStore> {
  // Un resolveur plutot qu'un instantane : le manifest change pendant START,
  // a chaque session liee. Valider contre une copie figee laisserait passer
  // une incoherence des le second slot.
  const currentManifest = (): NativeRunManifest =>
    typeof manifest === 'function' ? manifest() : manifest;
  const runId = currentManifest().run_id;

  const readEvents = (): Promise<JournalRecord<NativeCcrEvent>[]> =>
    readJsonlJournal(paths.events, {
      ...options,
      parseLine: (line, lineNumber) =>
        validateNativeEventShape(parseJournalLine(line, lineNumber, 'events.jsonl'), lineNumber),
    });

  const lines = await readEvents();

  let sequence = 0;
  for (const line of lines) {
    const parsed = parseEventSequence(line.value.event_id);
    if (parsed === undefined || parsed <= sequence) {
      throw journalInvalid(
        `events.jsonl ligne ${line.lineNumber} : séquence non strictement croissante (${line.value.event_id}).`,
        { line: line.lineNumber, eventId: line.value.event_id, previous: sequence },
      );
    }
    sequence = parsed;
  }

  let lastId: string | null = sequence === 0 ? null : formatEventId(sequence);

  return {
    async append(event: NewNativeCcrEvent): Promise<NativeCcrEvent> {
      // Refus **avant** toute écriture : un append rejeté ne touche pas le
      // journal, et ne consomme pas de numéro de séquence.
      assertNoLegacyProvenance(event as unknown as Record<string, unknown>);

      const candidate = {
        ...(event as object),
        event_id: formatEventId(sequence + 1),
        run_id: runId,
        timestamp: event.timestamp ?? new Date().toISOString(),
      };
      const complete = validateNativeEventShape(candidate, null);
      assertConsistentWithManifest(complete, currentManifest());

      await appendJsonLine(paths.events, complete);
      sequence += 1;
      lastId = complete.event_id;
      return complete;
    },

    async readAll(): Promise<NativeCcrEvent[]> {
      return (await readEvents()).map((line) => line.value);
    },

    lastEventId(): string | null {
      return lastId;
    },

    nextSequence(): number {
      return sequence + 1;
    },
  };
}

// --------------------------------------------------------------------------
// Sélection du journal par génération
// --------------------------------------------------------------------------

export type RunEventStore =
  | { readonly execution_mode: 'LEGACY_V2_EXECUTION'; readonly store: EventStore }
  | { readonly execution_mode: 'NATIVE_V21_EXECUTION'; readonly store: NativeEventStore };

/**
 * Ouvre le journal correspondant à la génération du run.
 *
 * La génération vient du **manifest**, et de lui seul : jamais d'un événement,
 * d'un acteur ni d'un fournisseur. Ouvrir le mauvais journal devient donc
 * impossible, plutôt que détectable après coup.
 */
export async function openRunEventStore(
  paths: RunPaths,
  persisted: PersistedManifest,
  options: JournalReadSeams = {},
): Promise<RunEventStore> {
  if (persisted.execution_mode === 'LEGACY_V2_EXECUTION') {
    return {
      execution_mode: 'LEGACY_V2_EXECUTION',
      store: await openEventStore(paths, persisted.manifest.run_id, options),
    };
  }
  const nativeManifest = persisted.manifest;
  return {
    execution_mode: 'NATIVE_V21_EXECUTION',
    store: await openNativeEventStore(paths, nativeManifest, options),
  };
}
