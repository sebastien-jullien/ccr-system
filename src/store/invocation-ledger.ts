/**
 * Journal des invocations engagées par CCR (`V2.2-IMP-01`).
 *
 * ## Ce dont il est l'autorité
 *
 * De ce que CCR s'est **durablement engagé** à tenter, et de rien d'autre. Ni
 * d'un processus lancé, ni d'une requête réseau, ni d'une unité facturée.
 *
 * ## Ce qu'il ne connaît pas
 *
 * Aucun adapter, aucun fournisseur, aucune politique, aucun coût, aucun
 * événement métier. Il lit, valide, alloue et ajoute — quatre gestes.
 *
 * ## Absence ≠ corruption
 *
 * Un run antérieur à V2.2 n'a pas ce fichier. Le lecteur rend alors un journal
 * vide, jamais une erreur : c'est l'état `PRE_LEDGER`, et il est parfaitement
 * normal.
 */

import { CcrError } from '../core/errors.ts';
import {
  formatInvocationId,
  invocationLedgerSchemaVersionFor,
  parseInvocationSequence,
  validateInvocationDispatchRecord,
} from '../core/usage-governance.ts';
import type { InvocationDispatchRecord, NewInvocationDispatch } from '../core/usage-governance.ts';
import { open } from 'node:fs/promises';

import { appendJsonLine } from './atomic-file.ts';
import type { JournalReadSeams } from './event-store.ts';
import { parseJournalLine, readJsonlJournal } from './jsonl-journal.ts';
import type { RunPaths } from './layout.ts';

export interface InvocationLedgerStore {
  readAll(): Promise<InvocationDispatchRecord[]>;
  /** Ajoute un engagement de dispatch et rend l'enregistrement écrit. */
  append(draft: NewInvocationDispatch, now?: Date): Promise<InvocationDispatchRecord>;
  lastInvocationId(): string | null;
  /**
   * Nombre réel d'engagements valides du run (`V2.2-IMP-07`).
   *
   * **Ce n'est pas `nextSequence() - 1`.** La séquence doit être strictement
   * croissante, jamais contiguë : un journal dont les identifiants sauteraient
   * un numéro resterait valide, et le curseur d'allocation dépasserait alors le
   * compte. C'est ce compte-ci, et lui seul, qui fait autorité sur ce que CCR a
   * engagé — aucun compteur n'est persisté.
   */
  count(): number;
  nextSequence(): number;
}

function journalInvalid(message: string, details: Record<string, unknown> = {}): CcrError {
  return new CcrError('JOURNAL_INVALID', message, { details });
}

/**
 * Ouvre le journal d'invocations d'un run.
 *
 * L'ouverture relit l'intégralité du fichier : c'est ce qui permet d'allouer le
 * prochain identifiant sans jamais réutiliser un existant, et de refuser un
 * journal dont la séquence a régressé. Le fichier est court par nature — une
 * ligne par tentative de modèle.
 */
/**
 * Active durablement l'autorité `InvocationLedger` pour un run (`V2.2-IMP-09R`).
 *
 * Crée le journal **vide**. Un fichier vide n'est pas un journal vide par
 * accident : c'est un fait, et il dit exactement ceci —
 *
 * ```text
 * l'autorité a été activée pour ce run, et aucun engagement n'a encore eu lieu
 * ```
 *
 * Sans lui, l'absence de fichier confondait deux vérités opposées : un run
 * antérieur dont l'histoire est indémontrable, et un run neuf dont l'histoire
 * est intégralement connue et vide. Le premier doit rester `PRE_LEDGER` ; le
 * second ne le doit pas.
 *
 * Aucun enregistrement n'est fabriqué — ni `inv_000000`, ni dispatch de
 * complaisance : la marque **est** l'existence du fichier.
 *
 * Création exclusive (`wx`). Un journal déjà présent n'est jamais tronqué ni
 * réécrit : l'appel se retire alors sans rien faire, ce qui rend l'activation
 * idempotente sans jamais mettre une histoire en péril.
 *
 * C'est la **seule** primitive mutante de ce module en dehors de `append` :
 * ouvrir un journal reste une lecture, et une lecture ne crée rien.
 */
export async function initializeInvocationLedger(paths: RunPaths): Promise<void> {
  let handle;
  try {
    handle = await open(paths.invocations, 'wx');
  } catch (error) {
    // Déjà activé : rien à faire, et surtout rien à écraser.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw new CcrError(
      'INVOCATION_LEDGER_WRITE_FAILED',
      `Le journal d'invocations du run ${paths.runId} n'a pas pu être initialisé. ` +
        "Aucun agent n'a été sollicité.",
      { details: { runId: paths.runId, path: paths.invocations }, cause: error },
    );
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function openInvocationLedger(
  paths: RunPaths,
  runId: string,
  options: JournalReadSeams = {},
): Promise<InvocationLedgerStore> {
  const readRecords = (): Promise<{ lineNumber: number; value: InvocationDispatchRecord }[]> =>
    readJsonlJournal(paths.invocations, {
      ...options,
      parseLine: (line, lineNumber) =>
        validateInvocationDispatchRecord(
          parseJournalLine(line, lineNumber, 'invocations.jsonl'),
          lineNumber,
        ),
    });

  const lines = await readRecords();

  let sequence = 0;
  const seen = new Set<string>();
  for (const line of lines) {
    const record = line.value;
    if (record.run_id !== runId) {
      throw journalInvalid(
        `invocations.jsonl ligne ${String(line.lineNumber)} : run_id ${record.run_id} étranger à ce run.`,
        { line: line.lineNumber, expected: runId, found: record.run_id },
      );
    }
    if (seen.has(record.invocation_id)) {
      throw journalInvalid(
        `invocations.jsonl ligne ${String(line.lineNumber)} : ${record.invocation_id} apparaît deux fois.`,
        { line: line.lineNumber, invocationId: record.invocation_id },
      );
    }
    seen.add(record.invocation_id);

    const parsed = parseInvocationSequence(record.invocation_id);
    if (parsed === undefined || parsed <= sequence) {
      throw journalInvalid(
        `invocations.jsonl ligne ${String(line.lineNumber)} : séquence non strictement croissante ` +
          `(${record.invocation_id}).`,
        { line: line.lineNumber, invocationId: record.invocation_id, previous: sequence },
      );
    }
    sequence = parsed;
  }

  const records = lines.map((line) => line.value);
  let last = records.at(-1)?.invocation_id ?? null;
  // Le compte vient des enregistrements relus à l'ouverture, jamais du curseur.
  let total = records.length;

  return {
    async readAll(): Promise<InvocationDispatchRecord[]> {
      return (await readRecords()).map((line) => line.value);
    },

    async append(draft: NewInvocationDispatch, now: Date = new Date()): Promise<InvocationDispatchRecord> {
      sequence += 1;
      const record: InvocationDispatchRecord = {
        // La version suit la CHARGE, pas le millésime du runtime. Un `SEND`
        // écrit après une détection reste donc en version 1 : un journal n'a
        // pas d'époque, et aucune installation sans détection ne voit ses
        // enregistrements changer de version parce que CCR a évolué.
        schema_version: invocationLedgerSchemaVersionFor(draft.trigger_kind),
        kind: 'DISPATCH_COMMITTED',
        invocation_id: formatInvocationId(sequence),
        run_id: runId,
        ...draft,
        dispatch_committed_at: draft.dispatch_committed_at ?? now.toISOString(),
      };
      // Validé avant écriture : une identité générationnellement incohérente
      // est refusée sans laisser de trace, plutôt que découverte à la relecture.
      const validated = validateInvocationDispatchRecord(record, null);
      await appendJsonLine(paths.invocations, validated);
      last = validated.invocation_id;
      total += 1;
      return validated;
    },

    lastInvocationId(): string | null {
      return last;
    },

    count(): number {
      return total;
    },

    nextSequence(): number {
      return sequence + 1;
    },
  };
}
