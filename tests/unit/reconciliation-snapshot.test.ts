/**
 * Preuves de la tranche S3 — le journal V5 comme sixième source stable.
 *
 * Classe de preuve : `FIXTURE`. La preuve inter-processus vit dans
 * `reconciliation-snapshot-concurrency.test.ts`, et elle seule y revendique
 * `AUTOMATED_REAL_PROCESS`.
 *
 * Ce fichier ne prouve **aucune** sémantique de S4 et au-delà : aucune
 * fraîcheur imposée, aucun périmètre validé, aucune autorité humaine, aucune
 * actualité, aucune détection.
 *
 * ```text
 * SNAPSHOT OBSERVATION  ≠  FRESHNESS ENFORCEMENT
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import {
  NATIVE_STABLE_SNAPSHOT_SOURCE_COUNT,
  readStableNativeRunSnapshot,
} from '../../src/store/native-run-snapshot.ts';
import {
  appendReconciliationEntries,
  readReconciliationJournal,
} from '../../src/store/reconciliation-store.ts';
import {
  RECONCILIATION_SCHEMA_VERSION,
  formatReconciliationId,
} from '../../src/core/reconciliation.ts';
import type { ReconciliationEntry } from '../../src/core/reconciliation.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { formatControversyEntryId, formatControversyId } from '../../src/core/controversy.ts';

const RUN_ID = 'CCR-20260403-001';
const CTV = formatControversyId(7);
const E1 = formatControversyEntryId(11);

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s3-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  return { runsDir, paths, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

/** Un run natif minimal, repris tel quel du précédent V4. */
async function nativeRun(paths: RunPaths, runsDir: string): Promise<void> {
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's3', created_at: '2026-08-20T09:00:00.000Z',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'codex', session_id: 'S1' },
      challenger: { provider: 'claude', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000001',
    updated_at: '2026-08-20T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, `${JSON.stringify({
    event_id: 'evt_000001', run_id: RUN_ID, round: 1, timestamp: '2026-08-20T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: 'le cache doit expirer',
  })}\n`, 'utf8');
}

function act(sequence: number, overrides: Record<string, unknown> = {}): ReconciliationEntry {
  return {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: formatReconciliationId(sequence),
    kind: 'RECONCILIATION_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T10:00:00.000Z',
    observed_revision: 'rcn-sha256:seed',
    scope_kind: 'SUBSET',
    scope: [E1],
    content: `décision ${String(sequence)}`,
    provenance: { kind: 'DECLARED', statement: 'décidé en revue' },
    ...overrides,
  } as unknown as ReconciliationEntry;
}

// --------------------------------------------------------------------------
// C41 — la source V5 est observée dans l'instantané stable
// --------------------------------------------------------------------------

test('C41 · la sixième source est enregistrée au protocole stable', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    assert.equal(NATIVE_STABLE_SNAPSHOT_SOURCE_COUNT, 6);

    await appendReconciliationEntries(h.paths, [act(1), act(2)]);

    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.deepEqual(
      snapshot.reconciliations.map((entry) => entry.entry_id),
      ['rcn_000001', 'rcn_000002'],
    );
    assert.match(snapshot.reconciliation_revision, /^rcn-sha256:[0-9a-f]{64}$/);
  } finally {
    await h.dispose();
  }
});

test('les quatre espaces de révision coexistent, distincts et jamais comparés', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    await appendReconciliationEntries(h.paths, [act(1)]);

    const s = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.match(s.revision, /^sha256:[0-9a-f]{64}$/);
    assert.match(s.controversy_revision, /^ctv-sha256:[0-9a-f]{64}$/);
    assert.match(s.evidence_revision, /^ev-sha256:[0-9a-f]{64}$/);
    assert.match(s.reconciliation_revision, /^rcn-sha256:[0-9a-f]{64}$/);

    const tokens = [s.revision, s.controversy_revision, s.evidence_revision, s.reconciliation_revision];
    assert.equal(new Set(tokens).size, 4, 'quatre jetons distincts.');
  } finally {
    await h.dispose();
  }
});

test('la révision de run ne bouge pas quand le journal V5 bouge', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    const before = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);

    await appendReconciliationEntries(h.paths, [act(1)]);
    const after = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);

    // Un acte V5 ne périme pas le run.
    assert.equal(after.revision, before.revision);
    assert.equal(after.controversy_revision, before.controversy_revision);
    assert.equal(after.evidence_revision, before.evidence_revision);
    // ...mais il périme bien le domaine V5.
    assert.notEqual(after.reconciliation_revision, before.reconciliation_revision);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Absent · présent-vide · corrompu
// --------------------------------------------------------------------------

test('source absente — aucune fausse preuve de « zéro réconciliation »', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);

    assert.deepEqual(snapshot.reconciliations, []);
    // Une lecture ne matérialise jamais la source.
    assert.equal(existsSync(h.paths.reconciliations), false);

    // La liste vide ne dit rien ; la révision, elle, distingue les deux états.
    const absentRevision = snapshot.reconciliation_revision;
    await writeFile(h.paths.reconciliations, '', 'utf8');
    const emptySnapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.deepEqual(emptySnapshot.reconciliations, []);
    assert.notEqual(
      emptySnapshot.reconciliation_revision,
      absentRevision,
      'ABSENT ≠ PRESENT-EMPTY doit rester observable dans l\'instantané.',
    );
  } finally {
    await h.dispose();
  }
});

test('source corrompue — l\'instantané lève, il n\'absorbe pas', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    await writeFile(h.paths.reconciliations, '{ pas du JSON }\n', 'utf8');

    await assert.rejects(
      () => readStableNativeRunSnapshot(h.runsDir, RUN_ID),
      (error: unknown) => {
        assert.ok(isCcrError(error), 'une CcrError est attendue.');
        return true;
      },
      'une corruption ne devient ni source vide, ni source absente.',
    );

    // Le journal n'a pas été réparé par la lecture.
    assert.equal(await readFile(h.paths.reconciliations, 'utf8'), '{ pas du JSON }\n');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Ordre et non-régression
// --------------------------------------------------------------------------

test('SERVER ORDER ≠ PREFERENCE — l\'ordre d\'append est rendu tel quel', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    // Horodatages volontairement décroissants : si l'instantané triait par
    // date, l'ordre rendu différerait de l'ordre d'écriture.
    await appendReconciliationEntries(h.paths, [
      act(1, { recorded_at: '2026-08-20T23:00:00.000Z' }),
      act(2, { recorded_at: '2026-08-20T08:00:00.000Z' }),
      act(3, { recorded_at: '2026-08-20T12:00:00.000Z' }),
    ]);

    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.deepEqual(
      snapshot.reconciliations.map((entry) => entry.entry_id),
      ['rcn_000001', 'rcn_000002', 'rcn_000003'],
    );
    const journal = await readReconciliationJournal(h.paths);
    assert.deepEqual(snapshot.reconciliations, journal.entries);
  } finally {
    await h.dispose();
  }
});

test('l\'instantané ne porte aucun champ dérivé de V5', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    await appendReconciliationEntries(h.paths, [act(1)]);
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID) as unknown as Record<string, unknown>;

    for (const forbidden of [
      'reconciliation_status', 'current_reconciliation', 'closure_status',
      'disagreement_status', 'converged', 'score', 'current_decisions',
    ]) {
      assert.equal(forbidden in snapshot, false, `${forbidden} n'a pas sa place dans l'instantané.`);
    }
  } finally {
    await h.dispose();
  }
});

test('les cinq sources historiques gardent leur sémantique', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    await appendReconciliationEntries(h.paths, [act(1)]);
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);

    assert.equal(snapshot.runId, RUN_ID);
    assert.equal(snapshot.manifest.run_id, RUN_ID);
    assert.equal(snapshot.state.state, 'READY');
    assert.equal(snapshot.events.length, 1);
    assert.deepEqual(snapshot.controversies, []);
    assert.deepEqual(snapshot.evidence, []);
    // Les noms de champs historiques sont inchangés.
    for (const field of ['manifest', 'state', 'events', 'controversies', 'evidence', 'revision',
      'controversy_revision', 'evidence_revision', 'attempts']) {
      assert.ok(field in snapshot, `${field} doit rester exposé.`);
    }
  } finally {
    await h.dispose();
  }
});
