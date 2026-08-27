/**
 * Identifiants CCR (spécification V1, §7 et §42).
 *
 * Les identifiants sont générés par CCR. Le `run_id` est l'identité de
 * l'expérience CCR ; il ne se confond jamais avec les identifiants natifs
 * Claude et Codex, qui sont des références externes attachées au run.
 */

import { CcrError } from './errors.ts';

const RUN_ID_PATTERN = /^CCR-(\d{8})-(\d{3})$/;
const EVENT_ID_PATTERN = /^evt_(\d{6})$/;
const DECISION_ID_PATTERN = /^DEC-(\d{4})$/;

/** Partie date d'un `run_id`, en heure locale : `YYYYMMDD`. */
export function formatDatePart(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function formatRunId(datePart: string, ordinal: number): string {
  if (!/^\d{8}$/.test(datePart)) {
    throw new CcrError('INVALID_ARGUMENT', `Partie date invalide : ${datePart}`);
  }
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 999) {
    throw new CcrError('INVALID_ARGUMENT', `Ordinal de run hors bornes : ${String(ordinal)}`);
  }
  return `CCR-${datePart}-${String(ordinal).padStart(3, '0')}`;
}

export function parseRunId(runId: string): { datePart: string; ordinal: number } | undefined {
  const match = RUN_ID_PATTERN.exec(runId);
  if (match === null) return undefined;
  const datePart = match[1];
  const ordinal = match[2];
  if (datePart === undefined || ordinal === undefined) return undefined;
  return { datePart, ordinal: Number.parseInt(ordinal, 10) };
}

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

export function formatEventId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Séquence d'événement invalide : ${String(sequence)}`);
  }
  return `evt_${String(sequence).padStart(6, '0')}`;
}

export function parseEventSequence(eventId: string): number | undefined {
  const match = EVENT_ID_PATTERN.exec(eventId);
  const digits = match?.[1];
  return digits === undefined ? undefined : Number.parseInt(digits, 10);
}

export function formatDecisionId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Séquence de décision invalide : ${String(sequence)}`);
  }
  return `DEC-${String(sequence).padStart(4, '0')}`;
}

export function parseDecisionSequence(decisionId: string): number | undefined {
  const match = DECISION_ID_PATTERN.exec(decisionId);
  const digits = match?.[1];
  return digits === undefined ? undefined : Number.parseInt(digits, 10);
}

/** Nom de répertoire d'un round : `001`, `002`, … */
export function formatRoundDirName(round: number): string {
  if (!Number.isInteger(round) || round < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Numéro de round invalide : ${String(round)}`);
  }
  return String(round).padStart(3, '0');
}
