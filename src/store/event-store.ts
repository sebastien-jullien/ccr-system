/**
 * Event store — journal append-only du run (spécification V1, §12, §42).
 *
 * Propriétés garanties :
 *
 *  - append-only : aucune fonction de ce module ne permet de modifier ou de
 *    supprimer un événement déjà écrit. Une correction crée un événement ;
 *  - identifiants strictement croissants `evt_000001`, `evt_000002`, … ;
 *  - la numérotation est reconstruite depuis le journal lui-même, ce qui la
 *    rend correcte après un redémarrage de CCR ;
 *  - une ligne illisible est signalée, jamais ignorée.
 *
 * La séquence est tenue en mémoire par le store ouvert. L'unicité de
 * l'écrivain relèvera du verrou de run (lot V1.8) ; ce module est conçu pour
 * s'y adosser sans modification : il ne fait aucune hypothèse d'exclusivité et
 * relit systématiquement le journal à l'ouverture.
 */

import { CcrError } from '../core/errors.ts';
import { assertNoNativeProvenance } from '../core/event-provenance.ts';
import { formatEventId, parseEventSequence } from '../core/ids.ts';
import type { CcrEvent, NewCcrEvent } from '../core/run.ts';
import { EVENT_ACTORS, EVENT_TYPES } from '../core/run.ts';
import { appendJsonLine } from './atomic-file.ts';
import { parseJournalLine, readJsonlJournal } from './jsonl-journal.ts';
import type { JournalRecord, ReadJournalOptions } from './jsonl-journal.ts';
import type { RunPaths } from './layout.ts';

/** Seams de lecture partagés par les journaux canoniques (tests déterministes). */
export type JournalReadSeams = Omit<ReadJournalOptions<never>, 'parseLine'>;

function validateEvent(value: unknown, lineNumber: number): CcrEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CcrError('JOURNAL_INVALID', `events.jsonl ligne ${lineNumber} : objet JSON attendu.`, {
      details: { line: lineNumber },
    });
  }
  const record = value as Record<string, unknown>;

  const eventId = record['event_id'];
  if (typeof eventId !== 'string' || parseEventSequence(eventId) === undefined) {
    throw new CcrError('JOURNAL_INVALID', `events.jsonl ligne ${lineNumber} : event_id invalide.`, {
      details: { line: lineNumber, eventId: eventId ?? null },
    });
  }

  const actor = record['actor'];
  if (typeof actor !== 'string' || !(EVENT_ACTORS as readonly string[]).includes(actor)) {
    throw new CcrError('JOURNAL_INVALID', `events.jsonl ligne ${lineNumber} : acteur inconnu ${String(actor)}.`, {
      details: { line: lineNumber },
    });
  }

  const type = record['type'];
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) {
    throw new CcrError('JOURNAL_INVALID', `events.jsonl ligne ${lineNumber} : type inconnu ${String(type)}.`, {
      details: { line: lineNumber },
    });
  }

  return record as unknown as CcrEvent;
}

export interface EventStore {
  /** Ajoute un événement et renvoie sa forme complète, identifiant compris. */
  append(event: NewCcrEvent): Promise<CcrEvent>;
  readAll(): Promise<CcrEvent[]>;
  /** Dernier identifiant émis, ou `null` si le journal est vide. */
  lastEventId(): string | null;
  nextSequence(): number;
}

/**
 * Ouvre le journal d'un run.
 *
 * Relit intégralement `events.jsonl` pour déterminer la prochaine séquence :
 * après un crash, la vérité est dans le journal, pas dans `state.json`.
 */
export async function openEventStore(
  paths: RunPaths,
  runId: string,
  options: JournalReadSeams = {},
): Promise<EventStore> {
  /**
   * Lecture cohérente : seul un fragment final non terminé est repris (V2-IMP-29).
   * Aucun verrou n'est pris — un lecteur doit pouvoir observer un run pendant
   * `WAITING_AGENT`.
   */
  const readEvents = (): Promise<JournalRecord<CcrEvent>[]> =>
    readJsonlJournal(paths.events, {
      ...options,
      parseLine: (line, lineNumber) =>
        validateEvent(parseJournalLine(line, lineNumber, 'events.jsonl'), lineNumber),
    });

  const lines = await readEvents();

  let sequence = 0;
  for (const line of lines) {
    const event = line.value;
    const parsed = parseEventSequence(event.event_id);
    if (parsed === undefined || parsed <= sequence) {
      throw new CcrError(
        'JOURNAL_INVALID',
        `events.jsonl ligne ${line.lineNumber} : séquence non strictement croissante (${event.event_id}).`,
        { details: { line: line.lineNumber, eventId: event.event_id, previous: sequence } },
      );
    }
    sequence = parsed;
  }

  let lastId: string | null = sequence === 0 ? null : formatEventId(sequence);

  return {
    async append(event: NewCcrEvent): Promise<CcrEvent> {
      // Frontière de génération (V2.1-IMP-02) : un journal historique n'accueille
      // jamais une provenance native. Le refus précède l'incrément de séquence
      // et tout accès au fichier — un append rejeté ne laisse aucune trace.
      assertNoNativeProvenance(event as unknown as Record<string, unknown>);

      sequence += 1;
      const complete: CcrEvent = {
        ...event,
        event_id: formatEventId(sequence),
        run_id: runId,
        timestamp: event.timestamp ?? new Date().toISOString(),
      };
      await appendJsonLine(paths.events, complete);
      lastId = complete.event_id;
      return complete;
    },

    async readAll(): Promise<CcrEvent[]> {
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
