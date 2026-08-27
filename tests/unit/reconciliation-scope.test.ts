/**
 * Preuves de la tranche S4 — périmètre `SUBSET` / `WHOLE`, appartenance.
 *
 * Classes de preuve : `FIXTURE` pour les refus déterministes, et
 * `AUTOMATED_REAL_PROCESS` pour la borne d'instantané de `WHOLE` — établie avec
 * un vrai processus enfant écrivant le journal V3.
 *
 * Ce fichier ne prouve **aucune** écriture V5 : aucun `RECONCILIATION_RECORDED`
 * n'est produit, aucune actualité n'est calculée, aucune clôture n'est déclarée.
 *
 * ```text
 * VALIDATION PRIMITIVE  ≠  BUSINESS MUTATION
 * SCOPE VALIDITY        ≠  DECISION CURRENTNESS
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import {
  SCOPE_REFUSAL_REASONS,
  coversAllObservedEntries,
  enumerateWholeScope,
  prepareScope,
  validateDeclaredScope,
} from '../../src/services/reconciliation-scope.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import { isCcrError } from '../../src/core/errors.ts';

const run = promisify(execFile);

const RUN_ID = 'CCR-20260403-001';
const CTV_A = formatControversyId(1);
const CTV_B = formatControversyId(2);

const CHILD = "require('fs').appendFileSync(process.argv[1], process.argv[2] + '\\n');";

function v3Entry(sequence: number, controversyId: string): ControversyEntry {
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: controversyId,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-20T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  };
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  snapshot(): Promise<NativeRunSnapshot>;
  dispose(): Promise<void>;
}

async function fixture(entries: readonly ControversyEntry[]): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s4-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's4', created_at: '2026-08-20T09:00:00.000Z',
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
  if (entries.length > 0) {
    await writeFile(paths.controversies, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  }
  return {
    runsDir,
    paths,
    snapshot: () => readStableNativeRunSnapshot(runsDir, RUN_ID),
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

function refusalReason(error: unknown): string {
  assert.ok(isCcrError(error), 'une CcrError est attendue.');
  const details = (error as { details?: Record<string, unknown> }).details ?? {};
  return String(details['reason']);
}

async function refuses(body: () => unknown, reason: string): Promise<void> {
  await assert.rejects(
    async () => {
      body();
    },
    (error: unknown) => {
      assert.equal(refusalReason(error), reason);
      return true;
    },
    `refus attendu : ${reason}`,
  );
}

// --------------------------------------------------------------------------
// C05 · C06 · V03 — présence et non-vacuité
// --------------------------------------------------------------------------

test('C05 · V03 — un périmètre absent est refusé ; WHOLE n\'est jamais une absence', async () => {
  const h = await fixture([v3Entry(1, CTV_A)]);
  try {
    const s = await h.snapshot();
    // Absent sur un SUBSET.
    await refuses(
      () => validateDeclaredScope(s, { target_controversy_id: CTV_A, scope_kind: 'SUBSET', scope: undefined }),
      'SCOPE_ABSENT',
    );
    // Absent sur un WHOLE : la validation le refuse tout autant. `WHOLE` ne se
    // représente pas par l'absence — c'est `prepareScope` qui l'ÉNUMÈRE.
    await refuses(
      () => validateDeclaredScope(s, { target_controversy_id: CTV_A, scope_kind: 'WHOLE', scope: undefined }),
      'SCOPE_ABSENT',
    );
  } finally {
    await h.dispose();
  }
});

test('C06 · un périmètre vide est refusé — EMPTY_SCOPE = INVALID', async () => {
  const h = await fixture([v3Entry(1, CTV_A)]);
  try {
    const s = await h.snapshot();
    for (const kind of ['SUBSET', 'WHOLE'] as const) {
      await refuses(
        () => validateDeclaredScope(s, { target_controversy_id: CTV_A, scope_kind: kind, scope: [] }),
        'SCOPE_EMPTY',
      );
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C04 · C07 · V02 · V04 · V05 · V06
// --------------------------------------------------------------------------

test('C04 · V04 — une unité dupliquée est refusée', async () => {
  const h = await fixture([v3Entry(1, CTV_A), v3Entry(2, CTV_A)]);
  try {
    const s = await h.snapshot();
    const e1 = formatControversyEntryId(1);
    await refuses(
      () => validateDeclaredScope(s, { target_controversy_id: CTV_A, scope_kind: 'SUBSET', scope: [e1, e1] }),
      'SCOPE_ENTRY_DUPLICATED',
    );
  } finally {
    await h.dispose();
  }
});

test('C07 · V05 — une unité étrangère est refusée, jamais déplacée', async () => {
  const h = await fixture([v3Entry(1, CTV_A), v3Entry(2, CTV_B)]);
  try {
    const s = await h.snapshot();
    const foreign = formatControversyEntryId(2);
    await refuses(
      () => validateDeclaredScope(s, { target_controversy_id: CTV_A, scope_kind: 'SUBSET', scope: [foreign] }),
      'SCOPE_ENTRY_FOREIGN',
    );
    // L'unité étrangère reste rattachée à SA controverse : rien n'a été réparé.
    assert.deepEqual(enumerateWholeScope(s, CTV_B), [foreign]);
  } finally {
    await h.dispose();
  }
});

test('V06 — une unité inexistante dans l\'instantané est refusée', async () => {
  const h = await fixture([v3Entry(1, CTV_A)]);
  try {
    const s = await h.snapshot();
    await refuses(
      () => validateDeclaredScope(s, {
        target_controversy_id: CTV_A, scope_kind: 'SUBSET', scope: [formatControversyEntryId(99)],
      }),
      'SCOPE_ENTRY_NOT_FOUND',
    );
    // Forme non canonique : refus distinct, avant toute recherche.
    await refuses(
      () => validateDeclaredScope(s, { target_controversy_id: CTV_A, scope_kind: 'SUBSET', scope: ['ctve_1'] }),
      'SCOPE_ENTRY_NOT_CANONICAL',
    );
  } finally {
    await h.dispose();
  }
});

test('V02 — la cible doit être canonique et observable', async () => {
  const h = await fixture([v3Entry(1, CTV_A)]);
  try {
    const s = await h.snapshot();
    await refuses(
      () => validateDeclaredScope(s, {
        target_controversy_id: 'ctv_1', scope_kind: 'SUBSET', scope: [formatControversyEntryId(1)],
      }),
      'TARGET_NOT_CANONICAL',
    );
    await refuses(
      () => validateDeclaredScope(s, {
        target_controversy_id: formatControversyId(9), scope_kind: 'SUBSET', scope: [formatControversyEntryId(1)],
      }),
      'TARGET_NOT_FOUND',
    );
    // Une controverse sans aucune entrée n'est pas observable (§6.5) : `WHOLE`
    // n'y produit pas un périmètre vide, il refuse.
    await refuses(() => enumerateWholeScope(s, formatControversyId(9)), 'TARGET_NOT_FOUND');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C08 · V07 — WHOLE explicite, énuméré, ordonné par le serveur
// --------------------------------------------------------------------------

test('C08 · V07 — WHOLE est énuméré explicitement, dans l\'ordre autoritaire', async () => {
  // Entrées écrites dans un ordre qui n'est PAS l'ordre des identifiants.
  const h = await fixture([v3Entry(3, CTV_A), v3Entry(1, CTV_A), v3Entry(2, CTV_A)]);
  try {
    const s = await h.snapshot();
    const enumerated = enumerateWholeScope(s, CTV_A);
    assert.deepEqual(enumerated, ['ctve_000003', 'ctve_000001', 'ctve_000002']);

    // `prepareScope` rend la même énumération, validée par le même chemin.
    const prepared = prepareScope(s, { target_controversy_id: CTV_A, scope_kind: 'WHOLE', scope: undefined });
    assert.deepEqual(prepared, enumerated);
  } finally {
    await h.dispose();
  }
});

test('un SUBSET couvrant toutes les unités reste un SUBSET', async () => {
  const h = await fixture([v3Entry(1, CTV_A), v3Entry(2, CTV_A)]);
  try {
    const s = await h.snapshot();
    const all = [formatControversyEntryId(1), formatControversyEntryId(2)];
    const prepared = prepareScope(s, { target_controversy_id: CTV_A, scope_kind: 'SUBSET', scope: all });

    assert.deepEqual(prepared, all);
    // `C29` — la couverture structurelle est un fait distinct, et elle ne
    // convertit aucune déclaration : STRUCTURAL COVERAGE ≠ WHOLE-CLOSURE DECISION.
    assert.equal(coversAllObservedEntries(s, CTV_A, prepared), true);
    // La sorte déclarée n'a pas été promue.
    assert.equal(prepared.length, 2);
  } finally {
    await h.dispose();
  }
});

test('le périmètre déclaré est rendu tel quel — aucune paternité de périmètre', async () => {
  const h = await fixture([v3Entry(1, CTV_A), v3Entry(2, CTV_A), v3Entry(3, CTV_A)]);
  try {
    const s = await h.snapshot();
    const declared = [formatControversyEntryId(3), formatControversyEntryId(1)];
    const validated = validateDeclaredScope(s, {
      target_controversy_id: CTV_A, scope_kind: 'SUBSET', scope: declared,
    });
    // Ni réordonné, ni complété avec ctve_000002, ni réduit.
    assert.deepEqual(validated, declared);
    assert.equal(coversAllObservedEntries(s, CTV_A, validated), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C09 · P32 · P47 — WHOLE borné à l'instantané  ·  AUTOMATED_REAL_PROCESS
// --------------------------------------------------------------------------

test('C09 · P32 — un WHOLE historique ne capture jamais une ctve_ future (processus réel)', async () => {
  const h = await fixture([v3Entry(1, CTV_A)]);
  try {
    const observed = await h.snapshot();
    const historical = enumerateWholeScope(observed, CTV_A);
    assert.deepEqual(historical, ['ctve_000001']);

    // Un VRAI processus enfant ajoute une entrée V3 après l'observation.
    await run(process.execPath, [
      '-e', CHILD, h.paths.controversies, JSON.stringify(v3Entry(2, CTV_A)),
    ]);

    // L'énumération historique ne bouge pas : elle est bornée à l'instantané
    // contre lequel elle a été produite.
    assert.deepEqual(enumerateWholeScope(observed, CTV_A), ['ctve_000001']);
    assert.deepEqual(historical, ['ctve_000001']);

    // Un instantané neuf voit bien la nouvelle entrée — l'enfant a réellement écrit.
    const fresh = await h.snapshot();
    assert.deepEqual(enumerateWholeScope(fresh, CTV_A), ['ctve_000001', 'ctve_000002']);

    // `P47` / `C29` — la déclaration historique reste vraie ; la couverture
    // actuelle, elle, est devenue fausse. Deux faits, jamais un seul.
    assert.equal(coversAllObservedEntries(observed, CTV_A, historical), true);
    assert.equal(coversAllObservedEntries(fresh, CTV_A, historical), false);
  } finally {
    await h.dispose();
  }
});

test('P06 · P07 · P08 · P31 — le vocabulaire de refus est fermé et sans réparation', () => {
  assert.deepEqual(SCOPE_REFUSAL_REASONS, [
    'TARGET_NOT_CANONICAL',
    'TARGET_NOT_FOUND',
    'SCOPE_ABSENT',
    'SCOPE_EMPTY',
    'SCOPE_ENTRY_NOT_CANONICAL',
    'SCOPE_ENTRY_DUPLICATED',
    'SCOPE_ENTRY_NOT_FOUND',
    'SCOPE_ENTRY_FOREIGN',
  ]);
  // Aucun motif de fraîcheur ni d'issue métier n'y figure : une révision périmée
  // et un périmètre invalide sont deux raisons de refus distinctes.
  for (const foreign of ['STALE_REVISION', 'REFUSED_FRESHNESS', 'RECORDED', 'REVALIDATION_REFUSED']) {
    assert.equal((SCOPE_REFUSAL_REASONS as readonly string[]).includes(foreign), false);
  }
});
