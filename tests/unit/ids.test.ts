/**
 * Tests unitaires des identifiants CCR (spécification V1, §7, §42).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDatePart,
  formatDecisionId,
  formatEventId,
  formatRoundDirName,
  formatRunId,
  isRunId,
  parseDecisionSequence,
  parseEventSequence,
  parseRunId,
} from '../../src/core/ids.ts';
import { isCcrError } from '../../src/core/errors.ts';

test('un run_id respecte le format CCR-YYYYMMDD-NNN', () => {
  assert.equal(formatRunId('20260401', 1), 'CCR-20260401-001');
  assert.equal(formatRunId('20260401', 42), 'CCR-20260401-042');
  assert.equal(isRunId('CCR-20260401-001'), true);
  assert.equal(isRunId('CCR-2026087-1'), false);
});

test('un run_id ne se confond avec aucun identifiant natif', () => {
  // Un UUID Claude ou un thread_id Codex ne peut jamais être lu comme run_id.
  assert.equal(isRunId('019fdd0a-38d8-7793-8232-e3447e6848db'), false);
  assert.equal(isRunId('168ac2d0-e273-4da3-b916-05a66e4255d9'), false);
});

test('parseRunId restitue la date et l\'ordinal', () => {
  assert.deepEqual(parseRunId('CCR-20260401-007'), { datePart: '20260401', ordinal: 7 });
  assert.equal(parseRunId('pas-un-run'), undefined);
});

test('formatDatePart utilise la date locale', () => {
  assert.equal(formatDatePart(new Date(2026, 3, 1, 12, 0, 0)), '20260401');
  assert.equal(formatDatePart(new Date(2026, 0, 1, 12, 0, 0)), '20260101');
});

test('les ordinaux hors bornes sont rejetés', () => {
  for (const ordinal of [0, -1, 1000, 1.5]) {
    assert.throws(
      () => formatRunId('20260401', ordinal),
      (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
    );
  }
});

test('les identifiants d\'événement sont ordonnables lexicographiquement', () => {
  assert.equal(formatEventId(1), 'evt_000001');
  assert.equal(formatEventId(42), 'evt_000042');
  assert.ok(formatEventId(9) < formatEventId(10));
  assert.ok(formatEventId(99) < formatEventId(100));
  assert.equal(parseEventSequence('evt_000042'), 42);
  assert.equal(parseEventSequence('evt_42'), undefined);
});

test('les identifiants de décision suivent DEC-NNNN', () => {
  assert.equal(formatDecisionId(1), 'DEC-0001');
  assert.equal(formatDecisionId(7), 'DEC-0007');
  assert.equal(parseDecisionSequence('DEC-0007'), 7);
  assert.equal(parseDecisionSequence('DEC-7'), undefined);
});

test('les répertoires de round sont numérotés sur trois chiffres', () => {
  assert.equal(formatRoundDirName(1), '001');
  assert.equal(formatRoundDirName(4), '004');
  assert.equal(formatRoundDirName(120), '120');
  assert.throws(
    () => formatRoundDirName(0),
    (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
  );
});
