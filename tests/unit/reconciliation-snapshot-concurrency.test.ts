/**
 * Preuve inter-processus de la sixième source (tranche S3, contrat V5 §30).
 *
 * Classe de preuve : `AUTOMATED_REAL_PROCESS`.
 *
 * La propriété centrale ne se démontre pas dans une closure : elle dit qu'une
 * écriture **par un autre processus du système d'exploitation**, survenue dans
 * la fenêtre d'observation, empêche l'instantané de se prétendre stable. Ce
 * fichier lance donc de vrais processus enfants, sur le vrai système de
 * fichiers — précédent `tests/unit/cross-process-snapshot.test.ts`.
 *
 * ```text
 * observe → lit → RÉOBSERVE → si une source a bougé : retry, puis REFUS
 * ```
 *
 * Aucun `Promise.all`, aucun double appel dans le même processus, aucun mock de
 * verrou : une concurrence simulée ne prouverait rien de ce qui est affirmé ici.
 *
 * Ce que ce fichier n'établit **pas** :
 *
 * ```text
 * SNAPSHOT INSTABILITY   ≠   REFUSED_FRESHNESS
 * ```
 *
 * L'instabilité d'instantané est un constat de lecture. Le refus de fraîcheur
 * d'une mutation humaine appartient à S4/S5, et rien ici ne l'anticipe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { RECONCILIATION_SCHEMA_VERSION, formatReconciliationId } from '../../src/core/reconciliation.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { formatControversyEntryId, formatControversyId } from '../../src/core/controversy.ts';

const run = promisify(execFile);

const RUN_ID = 'CCR-20260403-001';
const CTV = formatControversyId(7);
const E1 = formatControversyEntryId(11);

/**
 * Le programme de l'enfant, réduit à l'essentiel : ajouter une ligne au journal.
 *
 * Il n'importe **rien** de CCR — ni le domaine, ni le store. C'est délibéré : la
 * preuve porte sur ce qu'un écrivain extérieur fait au fichier, pas sur ce que
 * nos propres primitives feraient si on les rappelait.
 */
const CHILD = "require('fs').appendFileSync(process.argv[1], process.argv[2] + '\\n');";

function line(sequence: number): string {
  return JSON.stringify({
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
    content: `écrit par un autre processus ${String(sequence)}`,
    provenance: { kind: 'DECLARED', statement: 'décidé en revue' },
  });
}

/** Lance un VRAI processus enfant qui ajoute une ligne au journal V5. */
async function appendFromChildProcess(file: string, sequence: number): Promise<void> {
  await run(process.execPath, ['-e', CHILD, file, line(sequence)]);
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s3x-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's3x', created_at: '2026-08-20T09:00:00.000Z',
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
  return { runsDir, paths, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

// --------------------------------------------------------------------------
// A · une écriture réelle d'un autre processus est visible
// --------------------------------------------------------------------------

test('A · un processus enfant écrit le journal V5 ; l\'instantané le voit', async () => {
  const h = await fixture();
  try {
    await appendFromChildProcess(h.paths.reconciliations, 1);

    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.deepEqual(snapshot.reconciliations.map((e) => e.entry_id), ['rcn_000001']);
    assert.equal(snapshot.attempts, 1, 'aucune instabilité : rien n\'a bougé pendant la lecture.');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// B · une écriture DANS la fenêtre empêche la revendication de stabilité
// --------------------------------------------------------------------------

test('B · une écriture inter-processus dans la fenêtre refuse l\'instantané', async () => {
  const h = await fixture();
  try {
    await appendFromChildProcess(h.paths.reconciliations, 1);

    let spawned = 0;
    await assert.rejects(
      () =>
        readStableNativeRunSnapshot(h.runsDir, RUN_ID, {
          budget: { attempts: 2, delaysMs: [1] },
          // Seul instant où la course est provoquable de façon déterministe :
          // les faits viennent d'être lus, la réobservation n'a pas eu lieu.
          beforeReobserve: async (attempt) => {
            spawned += 1;
            await appendFromChildProcess(h.paths.reconciliations, attempt + 1);
          },
        }),
      (error: unknown) => {
        assert.ok(isCcrError(error), 'une CcrError est attendue.');
        assert.equal((error as { code?: string }).code, 'SNAPSHOT_UNSTABLE');
        return true;
      },
      'une combinaison dont la coexistence n\'est pas établie n\'est jamais rendue.',
    );

    assert.equal(spawned, 2, 'les deux tentatives ont réellement vu un écrivain concurrent.');

    // Le journal porte bien les trois lignes : l'enfant a réellement écrit.
    const lines = (await readFile(h.paths.reconciliations, 'utf8')).split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 3);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C · l'écrivain concurrent cesse : l'instantané redevient possible
// --------------------------------------------------------------------------

test('C · le refus est un constat, pas un état — la lecture suivante aboutit', async () => {
  const h = await fixture();
  try {
    await appendFromChildProcess(h.paths.reconciliations, 1);

    let attemptsSeen = 0;
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID, {
      budget: { attempts: 3, delaysMs: [1, 1] },
      beforeReobserve: async (attempt) => {
        attemptsSeen = attempt;
        // L'écrivain concurrent n'agit que sur la PREMIÈRE tentative.
        if (attempt === 1) await appendFromChildProcess(h.paths.reconciliations, 2);
      },
    });

    assert.ok(attemptsSeen >= 2, 'la première tentative a bien été rejouée.');
    assert.equal(snapshot.attempts, 2);
    assert.deepEqual(
      snapshot.reconciliations.map((e) => e.entry_id),
      ['rcn_000001', 'rcn_000002'],
      'l\'instantané rendu contient l\'écriture de l\'enfant, observée deux fois identique.',
    );
  } finally {
    await h.dispose();
  }
});
