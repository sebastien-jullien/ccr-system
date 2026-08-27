/**
 * Decision store — journal append-only des décisions humaines
 * (spécification V1, §17).
 *
 * Raison d'être : une décision normative ne doit jamais exister uniquement
 * dans l'historique conversationnel d'un agent. Elle est donc écrite dans
 * l'état canonique CCR.
 *
 * La V1 n'implémente pas la supersession : toute décision est `ACTIVE`. Une
 * version ultérieure ajoutera `SUPERSEDED`, `REVOKED`, `TEMPORARY` — sans
 * jamais réécrire une ligne existante.
 */

import { CcrError } from '../core/errors.ts';
import { formatDecisionId, parseDecisionSequence } from '../core/ids.ts';
import type { CcrDecision, NewCcrDecision } from '../core/run.ts';
import { appendJsonLine } from './atomic-file.ts';
import { parseJournalLine, readJsonlJournal } from './jsonl-journal.ts';
import type { JournalRecord } from './jsonl-journal.ts';
import type { JournalReadSeams } from './event-store.ts';
import type { RunPaths } from './layout.ts';

function validateDecision(value: unknown, lineNumber: number): CcrDecision {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CcrError('JOURNAL_INVALID', `decisions.jsonl ligne ${lineNumber} : objet JSON attendu.`, {
      details: { line: lineNumber },
    });
  }
  const record = value as Record<string, unknown>;

  const decisionId = record['decision_id'];
  if (typeof decisionId !== 'string' || parseDecisionSequence(decisionId) === undefined) {
    throw new CcrError('JOURNAL_INVALID', `decisions.jsonl ligne ${lineNumber} : decision_id invalide.`, {
      details: { line: lineNumber, decisionId: decisionId ?? null },
    });
  }

  if (typeof record['content'] !== 'string' || record['content'].length === 0) {
    throw new CcrError('JOURNAL_INVALID', `decisions.jsonl ligne ${lineNumber} : contenu vide.`, {
      details: { line: lineNumber },
    });
  }

  return record as unknown as CcrDecision;
}

export interface DecisionStore {
  append(decision: NewCcrDecision): Promise<CcrDecision>;
  readAll(): Promise<CcrDecision[]>;
  lastDecisionId(): string | null;
}

export async function openDecisionStore(
  paths: RunPaths,
  runId: string,
  options: JournalReadSeams = {},
): Promise<DecisionStore> {
  /** Même lecture cohérente que les événements (V2-IMP-29) : un seul mécanisme. */
  const readDecisions = (): Promise<JournalRecord<CcrDecision>[]> =>
    readJsonlJournal(paths.decisions, {
      ...options,
      parseLine: (line, lineNumber) =>
        validateDecision(parseJournalLine(line, lineNumber, 'decisions.jsonl'), lineNumber),
    });

  const lines = await readDecisions();

  let sequence = 0;
  for (const line of lines) {
    const decision = line.value;
    const parsed = parseDecisionSequence(decision.decision_id);
    if (parsed === undefined || parsed <= sequence) {
      throw new CcrError(
        'JOURNAL_INVALID',
        `decisions.jsonl ligne ${line.lineNumber} : séquence non strictement croissante (${decision.decision_id}).`,
        { details: { line: line.lineNumber, decisionId: decision.decision_id, previous: sequence } },
      );
    }
    sequence = parsed;
  }

  let lastId: string | null = sequence === 0 ? null : formatDecisionId(sequence);

  return {
    async append(decision: NewCcrDecision): Promise<CcrDecision> {
      sequence += 1;
      const complete: CcrDecision = {
        ...decision,
        decision_id: formatDecisionId(sequence),
        run_id: runId,
        timestamp: decision.timestamp ?? new Date().toISOString(),
      };
      await appendJsonLine(paths.decisions, complete);
      lastId = complete.decision_id;
      return complete;
    },

    async readAll(): Promise<CcrDecision[]> {
      return (await readDecisions()).map((line) => line.value);
    },

    lastDecisionId(): string | null {
      return lastId;
    },
  };
}
