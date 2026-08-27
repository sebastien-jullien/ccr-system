/**
 * Journal des observations d'usage (`V2.2-IMP-01`).
 *
 * Séparé du journal d'invocations, et pour une raison de fond : une invocation
 * est un fait de **CCR**, une observation est une déclaration d'un **tiers** ou
 * une mesure de CCR. Les mêler ferait dépendre l'exactitude du premier de la
 * complétude du second.
 *
 * ```text
 * une invocation  →  0, 1 ou N observations
 * zéro observation → UNKNOWN, jamais zéro jeton
 * ```
 *
 * Ce journal ne devient jamais une source d'invocations : la lecture d'une
 * ligne est purement structurelle, et la cohérence croisée est une vérification
 * composite explicite.
 */

import { CcrError } from '../core/errors.ts';
import {
  formatUsageObservationId,
  parseUsageObservationSequence,
  USAGE_LEDGER_SCHEMA_VERSION,
  validateUsageObservationRecord,
} from '../core/usage-governance.ts';
import type { NewUsageObservation, UsageObservationRecord } from '../core/usage-governance.ts';
import { appendJsonLine } from './atomic-file.ts';
import type { JournalReadSeams } from './event-store.ts';
import { parseJournalLine, readJsonlJournal } from './jsonl-journal.ts';
import type { RunPaths } from './layout.ts';

export interface UsageLedgerStore {
  readAll(): Promise<UsageObservationRecord[]>;
  append(draft: NewUsageObservation, now?: Date): Promise<UsageObservationRecord>;
  lastObservationId(): string | null;
  nextSequence(): number;
}

function journalInvalid(message: string, details: Record<string, unknown> = {}): CcrError {
  return new CcrError('JOURNAL_INVALID', message, { details });
}

export async function openUsageLedger(
  paths: RunPaths,
  runId: string,
  options: JournalReadSeams = {},
): Promise<UsageLedgerStore> {
  const readRecords = (): Promise<{ lineNumber: number; value: UsageObservationRecord }[]> =>
    readJsonlJournal(paths.usage, {
      ...options,
      parseLine: (line, lineNumber) =>
        validateUsageObservationRecord(parseJournalLine(line, lineNumber, 'usage.jsonl'), lineNumber),
    });

  const lines = await readRecords();

  let sequence = 0;
  const seen = new Set<string>();
  for (const line of lines) {
    const record = line.value;
    if (record.run_id !== runId) {
      throw journalInvalid(
        `usage.jsonl ligne ${String(line.lineNumber)} : run_id ${record.run_id} étranger à ce run.`,
        { line: line.lineNumber, expected: runId, found: record.run_id },
      );
    }
    if (seen.has(record.usage_observation_id)) {
      throw journalInvalid(
        `usage.jsonl ligne ${String(line.lineNumber)} : ${record.usage_observation_id} apparaît deux fois.`,
        { line: line.lineNumber, observationId: record.usage_observation_id },
      );
    }
    seen.add(record.usage_observation_id);

    const parsed = parseUsageObservationSequence(record.usage_observation_id);
    if (parsed === undefined || parsed <= sequence) {
      throw journalInvalid(
        `usage.jsonl ligne ${String(line.lineNumber)} : séquence non strictement croissante ` +
          `(${record.usage_observation_id}).`,
        { line: line.lineNumber, observationId: record.usage_observation_id, previous: sequence },
      );
    }
    sequence = parsed;
  }

  let last = lines.at(-1)?.value.usage_observation_id ?? null;

  return {
    async readAll(): Promise<UsageObservationRecord[]> {
      return (await readRecords()).map((line) => line.value);
    },

    async append(draft: NewUsageObservation, now: Date = new Date()): Promise<UsageObservationRecord> {
      sequence += 1;
      const record: UsageObservationRecord = {
        ...draft,
        schema_version: USAGE_LEDGER_SCHEMA_VERSION,
        usage_observation_id: formatUsageObservationId(sequence),
        run_id: runId,
        observed_at: draft.observed_at ?? now.toISOString(),
      };
      const validated = validateUsageObservationRecord(record, null);
      await appendJsonLine(paths.usage, validated);
      last = validated.usage_observation_id;
      return validated;
    },

    lastObservationId(): string | null {
      return last;
    },

    nextSequence(): number {
      return sequence + 1;
    },
  };
}
