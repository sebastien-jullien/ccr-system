/**
 * Preuves de la tranche S4 — seam de fraîcheur V5.
 *
 * Classe de preuve : `FIXTURE`.
 *
 * Ce fichier ne prouve **aucune** application de fraîcheur : la comparaison
 * `expected` / `observed` sous verrou appartient à S5.
 *
 * ```text
 * REVISION PRODUCTION  ≠  FRESHNESS ENFORCEMENT
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
import { readCurrentReconciliationRevision } from '../../src/services/reconciliation-freshness.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { appendReconciliationEntries } from '../../src/store/reconciliation-store.ts';
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

async function fixture(native = true): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s4f-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.manifest, JSON.stringify(
    native
      ? {
          schema_version: 2, run_id: RUN_ID, title: 's4f', created_at: '2026-08-20T09:00:00.000Z',
          workspace: { cwd: runsDir },
          experts: {
            author: { provider: 'codex', session_id: 'S1' },
            challenger: { provider: 'claude', session_id: 'S2' },
          },
        }
      : {
          schema_version: 1, run_id: RUN_ID, title: 'legacy',
          created_at: '2026-08-20T09:00:00.000Z', workspace: { cwd: runsDir },
        },
  ), 'utf8');
  if (native) {
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
  return { runsDir, paths, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

function act(sequence: number): ReconciliationEntry {
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
  } as unknown as ReconciliationEntry;
}

// --------------------------------------------------------------------------
// C42 · V31 (part S4) — le jeton vient de la source autoritaire, tel quel
//
// `V31` exige que la fraîcheur soit revérifiée SOUS VERROU. S4 n'en couvre que
// la moitié — la CAPTURE du jeton autoritaire. La revérification sous verrou,
// immédiatement avant l'écriture, appartient à S5 et n'est pas prouvée ici.
// --------------------------------------------------------------------------

test('C42 · le jeton est celui de l\'instantané stable, rendu tel quel', async () => {
  const h = await fixture();
  try {
    await appendReconciliationEntries(h.paths, [act(1)]);

    const token = await readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID);
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);

    // Rendu TEL QUEL : aucune révision recalculée localement.
    assert.equal(token, snapshot.reconciliation_revision);
    assert.match(token, /^rcn-sha256:[0-9a-f]{64}$/);
  } finally {
    await h.dispose();
  }
});

test('le domaine est celui de V5, jamais un autre', async () => {
  const h = await fixture();
  try {
    const token = await readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID);
    const s = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);

    // Le jeton n'est aucune des trois autres révisions du même instantané.
    assert.notEqual(token, s.revision);
    assert.notEqual(token, s.controversy_revision);
    assert.notEqual(token, s.evidence_revision);
    for (const foreign of ['sha256:', 'ctv-sha256:', 'ev-sha256:']) {
      assert.equal(token.startsWith(foreign), false);
    }
  } finally {
    await h.dispose();
  }
});

test('le jeton bouge quand la source V5 bouge, et pas autrement', async () => {
  const h = await fixture();
  try {
    const before = await readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID);
    await appendReconciliationEntries(h.paths, [act(1)]);
    const after = await readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID);
    assert.notEqual(after, before);

    // Deux lectures successives sans écriture rendent le même jeton.
    assert.equal(await readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID), after);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Le seam ne mute rien
// --------------------------------------------------------------------------

test('le seam n\'écrit rien et ne crée aucun journal', async () => {
  const h = await fixture();
  try {
    const manifestBefore = await readFile(h.paths.manifest, 'utf8');
    const stateBefore = await readFile(h.paths.state, 'utf8');

    await readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID);

    assert.equal(existsSync(h.paths.reconciliations), false, 'la source n\'est jamais matérialisée.');
    assert.equal(existsSync(h.paths.controversies), false);
    assert.equal(existsSync(h.paths.evidence), false);
    assert.equal(await readFile(h.paths.manifest, 'utf8'), manifestBefore);
    assert.equal(await readFile(h.paths.state, 'utf8'), stateBefore);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Aucun repli : un état non observable n'est pas un jeton fabriqué
// --------------------------------------------------------------------------

test('un run non natif est refusé — aucun jeton par défaut', async () => {
  const h = await fixture(false);
  try {
    await assert.rejects(
      () => readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID),
      (error: unknown) => {
        assert.ok(isCcrError(error));
        return true;
      },
      'un appelant qui ne peut pas observer l\'état n\'a pas le droit de muter à l\'aveugle.',
    );
  } finally {
    await h.dispose();
  }
});

test('une source corrompue lève — le jeton n\'est jamais fabriqué', async () => {
  const h = await fixture();
  try {
    await writeFile(h.paths.reconciliations, '{ corrompu }\n', 'utf8');
    await assert.rejects(() => readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID));
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Aucune tautologie possible par l'API
// --------------------------------------------------------------------------

test('l\'API ne peut pas rendre une comparaison tautologique inévitable', () => {
  // Le seam prend (deps, runId) et rend une chaîne. Il n'accepte aucune valeur
  // « attendue » et ne rend aucun booléen : il ne compare rien, donc il ne peut
  // pas comparer une valeur à elle-même.
  assert.equal(readCurrentReconciliationRevision.length, 2);
  assert.equal(typeof readCurrentReconciliationRevision, 'function');
});

test('JIT CURRENT REVISION ≠ USER-HELD PRIOR VIEW', async () => {
  const h = await fixture();
  try {
    // Ce que le jeton établit : l'état V5 observé À CET INSTANT.
    const token = await readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID);

    // Un écrivain agit ensuite. Le jeton déjà rendu ne « sait » rien de ce
    // changement : il reste la valeur d'une observation passée, et c'est
    // exactement pourquoi une comparaison ultérieure sous verrou a un sens.
    await appendReconciliationEntries(h.paths, [act(1)]);
    const later = await readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID);

    assert.notEqual(token, later);
    // Le seam n'a produit aucune trace de « qui a vu quoi » : aucune session,
    // aucune identité, aucune vue humaine n'est enregistrée nulle part.
    assert.equal(typeof token, 'string');
  } finally {
    await h.dispose();
  }
});
