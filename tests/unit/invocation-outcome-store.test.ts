/**
 * Source canonique des issues négatives — store et domaine.
 *
 * Ce qui est éprouvé ici, et rien d'autre :
 *
 * ```text
 * fichier absent       →  ensemble vide, jamais une erreur
 * document corrompu    →  erreur, jamais « vide »
 * doublon              →  refusé, et le fait d'origine demeure
 * union native         →  vocabulaires V3/V4/V5 non fusionnés
 * UNEXPECTED           →  jamais persisté comme cause
 * ```
 *
 * Aucun fournisseur, aucun run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import {
  INVOCATION_OUTCOME_SCHEMA_VERSION,
  nativeProcessFailedOutcome,
  validateInvocationOutcomeDocument,
  validateTerminalNegativeOutcome,
} from '../../src/core/invocation-outcome.ts';
import {
  appendInvocationOutcome,
  findInvocationOutcome,
  readInvocationOutcomes,
} from '../../src/store/invocation-outcome-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-31T00:00:00.000Z';
const RUN = 'CCR-20260831-001';

async function freshRun(): Promise<{ dir: string; paths: ReturnType<typeof runPaths> }> {
  const dir = await makeTempDir('ccr-outcome-store-');
  const paths = runPaths(dir, RUN);
  await mkdir(paths.root, { recursive: true });
  return { dir, paths };
}

// --------------------------------------------------------------------------
// K — store atomique
// --------------------------------------------------------------------------

test('K — un fichier absent est un ensemble vide, jamais une erreur', async () => {
  const { dir, paths } = await freshRun();
  try {
    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 0);
    assert.equal(document.schema_version, INVOCATION_OUTCOME_SCHEMA_VERSION);
    assert.equal(findInvocationOutcome(document, 'inv_000001'), undefined);
  } finally {
    await removeTempDir(dir);
  }
});

test('K — un document corrompu lève, et ne se requalifie jamais en absence', async () => {
  const { dir, paths } = await freshRun();
  try {
    await writeFile(paths.invocationOutcomes, '{ ceci n’est pas du JSON', 'utf8');
    await assert.rejects(() => readInvocationOutcomes(paths));

    // Document lisible mais non conforme : même exigence.
    await writeFile(paths.invocationOutcomes, JSON.stringify({ schema_version: 99, outcomes: [] }), 'utf8');
    await assert.rejects(
      () => readInvocationOutcomes(paths),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('K — le fait écrit survit et se relit à l’identique', async () => {
  const { dir, paths } = await freshRun();
  try {
    await appendInvocationOutcome(
      paths,
      'inv_000001',
      { kind: 'V5_INVALID_OUTPUT', reason: 'OUTPUT_UNPARSABLE', at: 'output' },
      AT,
    );
    await appendInvocationOutcome(paths, 'inv_000002', { kind: 'NATIVE_PROCESS_FAILED' }, AT);

    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 2);

    const first = findInvocationOutcome(document, 'inv_000001');
    assert.deepEqual(first?.terminal_negative_outcome, {
      kind: 'V5_INVALID_OUTPUT',
      reason: 'OUTPUT_UNPARSABLE',
      at: 'output',
    });
    assert.equal(first?.recorded_at, AT);

    // Le document sur disque est un JSON complet, jamais une suite de lignes.
    const raw = await readFile(paths.invocationOutcomes, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw) as unknown);
    assert.equal(path.basename(paths.invocationOutcomes), 'invocation-outcomes.json');
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// J — doublon
// --------------------------------------------------------------------------

test('J — une seconde issue pour la même invocation est refusée, l’originale demeure', async () => {
  const { dir, paths } = await freshRun();
  try {
    await appendInvocationOutcome(
      paths,
      'inv_000001',
      { kind: 'V5_INVALID_OUTPUT', reason: 'OUTPUT_UNPARSABLE', at: 'output' },
      AT,
    );

    await assert.rejects(
      () =>
        appendInvocationOutcome(
          paths,
          'inv_000001',
          { kind: 'V5_REVALIDATION_REFUSED', check: 'R0', detail: 'autre' },
          '2026-09-01T00:00:00.000Z',
        ),
      (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_OUTCOME_ALREADY_RECORDED',
    );

    const document = await readInvocationOutcomes(paths);
    assert.equal(document.outcomes.length, 1);
    // Le fait d'origine est inchangé : ni remplacé, ni réécrit sémantiquement.
    assert.deepEqual(document.outcomes[0]?.terminal_negative_outcome, {
      kind: 'V5_INVALID_OUTPUT',
      reason: 'OUTPUT_UNPARSABLE',
      at: 'output',
    });
    assert.equal(document.outcomes[0]?.recorded_at, AT);
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Union native — aucune taxonomie universelle
// --------------------------------------------------------------------------

test('les vocabulaires V3, V4 et V5 ne sont pas fusionnés', () => {
  // `OUTPUT_UNPARSABLE` appartient à V5 seul ; V3 et V4 nomment `INVALID_JSON`.
  assert.doesNotThrow(() =>
    validateTerminalNegativeOutcome({ kind: 'V5_INVALID_OUTPUT', reason: 'OUTPUT_UNPARSABLE', at: 'output' }),
  );
  assert.throws(() =>
    validateTerminalNegativeOutcome({ kind: 'V3_INVALID_OUTPUT', reason: 'OUTPUT_UNPARSABLE', at: 'output' }),
  );

  // `DUPLICATE_PROPOSAL` existe en V4 et V5, pas en V3.
  assert.doesNotThrow(() =>
    validateTerminalNegativeOutcome({ kind: 'V4_INVALID_OUTPUT', reason: 'DUPLICATE_PROPOSAL', at: 'x' }),
  );
  assert.throws(() =>
    validateTerminalNegativeOutcome({ kind: 'V3_INVALID_OUTPUT', reason: 'DUPLICATE_PROPOSAL', at: 'x' }),
  );

  // `INVALID_JSON` appartient à V3/V4, jamais à V5.
  assert.doesNotThrow(() =>
    validateTerminalNegativeOutcome({ kind: 'V3_INVALID_OUTPUT', reason: 'INVALID_JSON', at: 'output' }),
  );
  assert.throws(() =>
    validateTerminalNegativeOutcome({ kind: 'V5_INVALID_OUTPUT', reason: 'INVALID_JSON', at: 'output' }),
  );
});

test('aucun champ libre : les variantes refusent tout attribut non prévu', () => {
  assert.throws(() =>
    validateTerminalNegativeOutcome({
      kind: 'NATIVE_PROCESS_FAILED',
      error_code: 'AGENT_TIMEOUT',
      metadata: { anything: true },
    }),
  );
  assert.throws(() => validateTerminalNegativeOutcome({ kind: 'V5_PROVIDER_FAILED', detail: 'libre' }));
});

// --------------------------------------------------------------------------
// N — détail natif typé : fermé des deux côtés
// --------------------------------------------------------------------------

const COLLISION = {
  code: 'SESSION_ID_COLLISION',
  expert_slot: 'challenger',
  provider: 'claude',
  session_id: 'claude-partagee',
} as const;

const MISMATCH = {
  code: 'AGENT_SESSION_MISMATCH',
  expert_slot: 'author',
  provider: 'codex',
  expected_session_id: 'codex-1',
  found_session_id: 'codex-9',
} as const;

test('N — les deux formes de détail natif se valident et se relisent entières', () => {
  for (const native_detail of [COLLISION, MISMATCH]) {
    const outcome = { kind: 'NATIVE_PROCESS_FAILED', error_code: native_detail.code, native_detail };
    assert.deepEqual(validateTerminalNegativeOutcome(outcome), outcome);
  }
});

test('N — le code de l’issue est recopié depuis le détail, jamais depuis l’erreur', () => {
  const built = nativeProcessFailedOutcome(new CcrError('SESSION_ID_COLLISION', 'collision'), COLLISION);
  assert.deepEqual(built, {
    kind: 'NATIVE_PROCESS_FAILED',
    error_code: 'SESSION_ID_COLLISION',
    native_detail: COLLISION,
  });

  // Sans détail, la forme d'origine est strictement inchangée.
  assert.deepEqual(nativeProcessFailedOutcome(new CcrError('AGENT_TIMEOUT', 'délai')), {
    kind: 'NATIVE_PROCESS_FAILED',
    error_code: 'AGENT_TIMEOUT',
  });
});

test('N — un détail natif incomplet, élargi ou incohérent est refusé', () => {
  const detailed = (native_detail: unknown, error_code = 'SESSION_ID_COLLISION'): unknown => ({
    kind: 'NATIVE_PROCESS_FAILED',
    error_code,
    native_detail,
  });

  // Champ manquant : aucun repli ne comble un manque.
  assert.throws(() => validateTerminalNegativeOutcome(detailed({ ...COLLISION, session_id: undefined })));
  // Champ supplémentaire : le sac générique reste impossible.
  assert.throws(() => validateTerminalNegativeOutcome(detailed({ ...COLLISION, metadata: { x: 1 } })));
  // Vocabulaires fermés : ni slot, ni moteur, ni code arbitraire.
  assert.throws(() => validateTerminalNegativeOutcome(detailed({ ...COLLISION, expert_slot: 'arbitre' })));
  assert.throws(() => validateTerminalNegativeOutcome(detailed({ ...COLLISION, provider: 'gemini' })));
  assert.throws(() =>
    validateTerminalNegativeOutcome(detailed({ ...COLLISION, code: 'AGENT_TIMEOUT' }, 'AGENT_TIMEOUT')),
  );
  // Les champs de l'autre forme ne se mélangent pas.
  assert.throws(() => validateTerminalNegativeOutcome(detailed({ ...MISMATCH, code: 'SESSION_ID_COLLISION' })));
  // Code discordant entre l'issue et son détail : deux échecs à la fois.
  assert.throws(() => validateTerminalNegativeOutcome(detailed(COLLISION, 'AGENT_TIMEOUT')));
  // Un détail sans code d'issue est tout aussi incohérent.
  assert.throws(() =>
    validateTerminalNegativeOutcome({ kind: 'NATIVE_PROCESS_FAILED', native_detail: COLLISION }),
  );
  // Et le détail n'appartient qu'au fait natif : aucun chemin assisté ne le porte.
  assert.throws(() =>
    validateTerminalNegativeOutcome({
      kind: 'V5_PROVIDER_FAILED',
      error_code: 'SESSION_ID_COLLISION',
      native_detail: COLLISION,
    }),
  );
});

test('N — une cause inconnue ne reçoit toujours aucun détail fabriqué', () => {
  const unknown = nativeProcessFailedOutcome(new Error('panne quelconque'));
  assert.deepEqual(unknown, { kind: 'NATIVE_PROCESS_FAILED' });
  assert.equal('native_detail' in unknown, false);
});

// --------------------------------------------------------------------------
// I — code natif connu, et rien d'inventé sinon
// --------------------------------------------------------------------------

test('I — un code natif significatif est conservé ; une cause inconnue reste absente', () => {
  const known = nativeProcessFailedOutcome(new CcrError('AGENT_TIMEOUT', 'délai dépassé'));
  assert.deepEqual(known, { kind: 'NATIVE_PROCESS_FAILED', error_code: 'AGENT_TIMEOUT' });

  const unknown = nativeProcessFailedOutcome(new Error('panne quelconque'));
  assert.deepEqual(unknown, { kind: 'NATIVE_PROCESS_FAILED' });
  assert.equal('error_code' in unknown, false);

  // `UNEXPECTED` n'est jamais fabriqué comme cause.
  assert.notEqual((unknown as { error_code?: string }).error_code, 'UNEXPECTED');
});

test('un document portant deux fois la même invocation est refusé à la relecture', () => {
  const duplicated = {
    schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION,
    outcomes: [
      {
        schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION,
        invocation_id: 'inv_000001',
        recorded_at: AT,
        terminal_negative_outcome: { kind: 'NATIVE_PROCESS_FAILED' },
      },
      {
        schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION,
        invocation_id: 'inv_000001',
        recorded_at: AT,
        terminal_negative_outcome: { kind: 'NATIVE_PROCESS_FAILED' },
      },
    ],
  };
  assert.throws(
    () => validateInvocationOutcomeDocument(duplicated),
    (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
  );
});
