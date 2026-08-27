/**
 * Preuves de la tranche S2 — journal V5, révision de domaine, séquence.
 *
 * Classe de preuve : `FIXTURE`. Aucune preuve inter-processus n'est revendiquée
 * ici : la concurrence réelle appartient à S3, et un test en processus unique ne
 * l'établirait pas.
 *
 * Ce fichier ne prouve **aucune** sémantique métier : ni actualité de décision,
 * ni effet de clôture, ni fraîcheur, ni autorité. S2 est un magasin.
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
  appendReconciliationEntries,
  computeReconciliationRevision,
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

async function withRun(body: (paths: RunPaths) => Promise<void>): Promise<void> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s2-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  try {
    await body(paths);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
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

function proposal(sequence: number): ReconciliationEntry {
  return {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: formatReconciliationId(sequence),
    kind: 'RECONCILIATION_PROPOSED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'CCR',
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T10:00:00.000Z',
    observed_revision: 'rcn-sha256:seed',
    scope_kind: 'SUBSET',
    scope: [E1],
    derivation: { method: 'DETERMINISTIC', inputs: [E1] },
    options: [{ option_id: 'o1', content: 'une lecture possible' }],
  } as unknown as ReconciliationEntry;
}

// --------------------------------------------------------------------------
// Chemin dédié
// --------------------------------------------------------------------------

test('le journal V5 est dédié — aucun journal V3/V4 n\'est touché', async () => {
  await withRun(async (paths) => {
    assert.equal(path.basename(paths.reconciliations), 'reconciliations.jsonl');
    assert.notEqual(paths.reconciliations, paths.events);
    assert.notEqual(paths.reconciliations, paths.controversies);
    assert.notEqual(paths.reconciliations, paths.evidence);
    assert.notEqual(paths.reconciliations, paths.decisions);

    await appendReconciliationEntries(paths, [act(1)]);

    // Le seul fichier créé est celui de V5.
    for (const foreign of [paths.events, paths.controversies, paths.evidence, paths.decisions]) {
      assert.equal(existsSync(foreign), false, `${foreign} ne doit pas exister.`);
    }
  });
});

// --------------------------------------------------------------------------
// C39 — ABSENT ≠ PRESENT-EMPTY
// --------------------------------------------------------------------------

test('C39 · absent et présent-vide ne sont jamais le même état', async () => {
  await withRun(async (paths) => {
    const absent = await readReconciliationJournal(paths);
    assert.equal(absent.present, false);
    assert.deepEqual(absent.entries, []);
    assert.equal(absent.next_sequence, 1);
    assert.equal(existsSync(paths.reconciliations), false, 'une lecture ne crée jamais le fichier.');

    await writeFile(paths.reconciliations, '', 'utf8');
    const empty = await readReconciliationJournal(paths);
    assert.equal(empty.present, true);
    assert.deepEqual(empty.entries, []);

    // Les deux listes sont vides ; les DEUX révisions diffèrent. C'est la
    // révision, et elle seule, qui porte la différence.
    assert.notEqual(absent.revision, empty.revision);
    assert.equal(computeReconciliationRevision({ present: false }), absent.revision);
    assert.equal(computeReconciliationRevision({ present: true, written: '' }), empty.revision);
  });
});

// --------------------------------------------------------------------------
// C40 · révision de domaine
// --------------------------------------------------------------------------

test('C40 · la révision V5 porte son propre espace et n\'est comparable à aucun autre', () => {
  const revision = computeReconciliationRevision({ present: true, written: 'x\n' });
  assert.match(revision, /^rcn-sha256:[0-9a-f]{64}$/);
  for (const foreign of ['sha256:', 'ctv-sha256:', 'ev-sha256:']) {
    assert.equal(revision.startsWith(foreign), false, `le jeton V5 ne doit pas porter ${foreign}.`);
  }
  // Fondée sur le CONTENU : deux observations identiques rendent la même
  // empreinte, sans dépendre d'aucune métadonnée de fichier.
  assert.equal(revision, computeReconciliationRevision({ present: true, written: 'x\n' }));
  assert.notEqual(revision, computeReconciliationRevision({ present: true, written: 'y\n' }));
});

test('la révision bouge à chaque append, et seulement sur ce qui est écrit', async () => {
  await withRun(async (paths) => {
    const before = (await readReconciliationJournal(paths)).revision;
    await appendReconciliationEntries(paths, [act(1)]);
    const after = (await readReconciliationJournal(paths)).revision;
    assert.notEqual(before, after);

    // Un fragment non terminé n'a rien écrit : la révision ne bouge pas.
    const raw = await readFile(paths.reconciliations, 'utf8');
    await writeFile(paths.reconciliations, `${raw}{"partiel":`, 'utf8');
    const withTail = await readReconciliationJournal(paths);
    assert.equal(withTail.revision, after);
    assert.equal(withTail.has_unwritten_tail, true);
    assert.equal(withTail.entries.length, 1);
  });
});

// --------------------------------------------------------------------------
// Aller-retour et ordre
// --------------------------------------------------------------------------

test('aller-retour — les trois classes cohabitent, dans l\'ordre d\'append', async () => {
  await withRun(async (paths) => {
    const entries = [act(1), proposal(2), act(3)];
    const written = await appendReconciliationEntries(paths, entries);
    assert.equal(written.length, 3);

    const read = await readReconciliationJournal(paths);
    assert.deepEqual(read.entries, entries);
    assert.deepEqual(
      read.entries.map((entry) => entry.entry_id),
      ['rcn_000001', 'rcn_000002', 'rcn_000003'],
    );
    assert.equal(read.next_sequence, 4);
    assert.equal(read.present, true);
    assert.equal(read.has_unwritten_tail, false);
  });
});

test('deux actes de contenu identique coexistent — aucune déduplication métier', async () => {
  await withRun(async (paths) => {
    await appendReconciliationEntries(paths, [act(1, { content: 'même texte' })]);
    await appendReconciliationEntries(paths, [act(2, { content: 'même texte' })]);
    const read = await readReconciliationJournal(paths);
    assert.equal(read.entries.length, 2);
  });
});

// --------------------------------------------------------------------------
// Corruption — CORRUPT ≠ ABSENT ≠ PRESENT_EMPTY
// --------------------------------------------------------------------------

test('une ligne TERMINÉE invalide est une corruption stable : la lecture lève', async () => {
  await withRun(async (paths) => {
    await appendReconciliationEntries(paths, [act(1)]);
    const raw = await readFile(paths.reconciliations, 'utf8');
    await writeFile(paths.reconciliations, `${raw}{ pas du JSON }\n`, 'utf8');

    await assert.rejects(
      () => readReconciliationJournal(paths),
      (error: unknown) => {
        assert.ok(isCcrError(error), 'une CcrError est attendue.');
        return true;
      },
      'une corruption ne devient jamais un journal vide.',
    );
  });
});

test('V01 · V32 — un enregistrement hors domaine ou hors version fait lever la lecture', async () => {
  await withRun(async (paths) => {
    // Ligne syntaxiquement valide, sémantiquement hors domaine : un acte humain
    // sans contenu. Le store délègue au domaine S1, il ne juge pas lui-même.
    const forged = JSON.stringify({ ...(act(1) as unknown as Record<string, unknown>), content: '' });
    await writeFile(paths.reconciliations, `${forged}\n`, 'utf8');
    await assert.rejects(() => readReconciliationJournal(paths));

    // `V32` — une version de schéma inconnue est refusée, jamais lue « au mieux ».
    const wrongVersion = JSON.stringify({
      ...(act(1) as unknown as Record<string, unknown>),
      schema_version: RECONCILIATION_SCHEMA_VERSION + 1,
    });
    await writeFile(paths.reconciliations, `${wrongVersion}\n`, 'utf8');
    await assert.rejects(() => readReconciliationJournal(paths));
  });
});

test('P11 · P28 — le magasin n\'écrit qu\'en append et n\'expose aucun champ dérivé', async () => {
  await withRun(async (paths) => {
    await appendReconciliationEntries(paths, [act(1)]);
    const first = await readFile(paths.reconciliations, 'utf8');
    await appendReconciliationEntries(paths, [act(2)]);
    const second = await readFile(paths.reconciliations, 'utf8');

    // `P11` — l'acte antérieur n'est jamais réécrit : ses octets sont un préfixe
    // exact du journal ultérieur.
    assert.ok(second.startsWith(first), 'un append ne réécrit jamais ce qui précède.');

    // `P28` — la lecture ne fabrique aucun fait : elle rend des entrées, une
    // révision et un état physique. Aucune actualité, aucune clôture, aucun
    // désaccord, aucune préférence.
    const read = await readReconciliationJournal(paths);
    assert.deepEqual(Object.keys(read).sort(), [
      'entries',
      'has_unwritten_tail',
      'next_sequence',
      'present',
      'revision',
      'written_bytes',
    ]);
  });
});

test('C02 · une identité dupliquée ou décroissante est refusée à la lecture', async () => {
  await withRun(async (paths) => {
    const duplicated = `${JSON.stringify(act(1))}\n${JSON.stringify(act(1))}\n`;
    await writeFile(paths.reconciliations, duplicated, 'utf8');
    await assert.rejects(
      () => readReconciliationJournal(paths),
      (error: unknown) => {
        assert.ok(isCcrError(error));
        assert.equal((error as { code?: string }).code, 'JOURNAL_INVALID');
        return true;
      },
    );

    // Une séquence qui recule est la même corruption d'identité.
    await writeFile(paths.reconciliations, `${JSON.stringify(act(5))}\n${JSON.stringify(act(2))}\n`, 'utf8');
    await assert.rejects(() => readReconciliationJournal(paths));
  });
});

test('C02 · C03 — une seule séquence rcn_ gouverne les trois classes', async () => {
  await withRun(async (paths) => {
    // Une proposition et un acte ne puisent pas dans deux compteurs distincts :
    // réutiliser `rcn_000001` pour une autre sorte reste une collision.
    const collision = `${JSON.stringify(act(1))}\n${JSON.stringify(proposal(1))}\n`;
    await writeFile(paths.reconciliations, collision, 'utf8');
    await assert.rejects(() => readReconciliationJournal(paths));

    // `C03` — le journal ne lit que l'espace `rcn_`. Une identité empruntée à
    // un autre espace canonique est refusée par le domaine, à la lecture comme
    // à l'écriture : le magasin n'ouvre aucune porte dérobée.
    for (const foreign of ['ctv_000001', 'ctve_000001', 'mat_000001', 'evt_000001', 'DEC-0001']) {
      await writeFile(paths.reconciliations, `${JSON.stringify(act(1, { entry_id: foreign }))}\n`, 'utf8');
      await assert.rejects(() => readReconciliationJournal(paths), `${foreign} ne doit pas être lu comme une identité V5.`);
    }
  });
});

test('aucune règle de continuité — un trou de séquence est licite', async () => {
  await withRun(async (paths) => {
    await appendReconciliationEntries(paths, [act(1)]);
    await appendReconciliationEntries(paths, [act(7)]);
    const read = await readReconciliationJournal(paths);
    assert.equal(read.entries.length, 2);
    assert.equal(read.next_sequence, 8);
  });
});

// --------------------------------------------------------------------------
// Append — tout ou rien, queue non écrite
// --------------------------------------------------------------------------

test('un lot dont une entrée est invalide ne laisse aucune trace', async () => {
  await withRun(async (paths) => {
    await assert.rejects(() =>
      appendReconciliationEntries(paths, [act(1), act(2, { content: '' })]),
    );
    assert.equal(existsSync(paths.reconciliations), false, 'un refus ne crée jamais le fichier.');

    await appendReconciliationEntries(paths, [act(1)]);
    const before = await readFile(paths.reconciliations, 'utf8');

    // Un lot bien formé dont deux entrées portent la MÊME identité : le magasin
    // le refuse avant le premier octet, plutôt que d'écrire un journal qu'il
    // refuserait de relire.
    await assert.rejects(() => appendReconciliationEntries(paths, [act(2), act(2)]));
    assert.equal(await readFile(paths.reconciliations, 'utf8'), before, 'le journal reste intact.');

    // Une identité DÉJÀ écrite est refusée de la même façon.
    await assert.rejects(() => appendReconciliationEntries(paths, [act(1)]));
    // Et un lot dont l'ordre interne recule aussi.
    await assert.rejects(() => appendReconciliationEntries(paths, [act(9), act(4)]));
    assert.equal(await readFile(paths.reconciliations, 'utf8'), before, 'le journal reste intact.');
  });
});

test('un lot vide ne s\'écrit pas', async () => {
  await withRun(async (paths) => {
    await assert.rejects(() => appendReconciliationEntries(paths, []));
  });
});

test('la queue non écrite est retirée avant append, jamais concaténée', async () => {
  await withRun(async (paths) => {
    await appendReconciliationEntries(paths, [act(1)]);
    const raw = await readFile(paths.reconciliations, 'utf8');
    await writeFile(paths.reconciliations, `${raw}{"frag`, 'utf8');

    await appendReconciliationEntries(paths, [act(2)]);

    const read = await readReconciliationJournal(paths);
    assert.equal(read.entries.length, 2);
    assert.equal(read.has_unwritten_tail, false);
    const lines = (await readFile(paths.reconciliations, 'utf8')).split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2, 'aucune ligne concaténée n\'a été promue en histoire.');
  });
});

test('un append refuse d\'écrire sur un journal corrompu', async () => {
  await withRun(async (paths) => {
    await writeFile(paths.reconciliations, '{ corrompu }\n', 'utf8');
    await assert.rejects(() => appendReconciliationEntries(paths, [act(1)]));
    assert.equal(await readFile(paths.reconciliations, 'utf8'), '{ corrompu }\n', 'fichier intact.');
  });
});

// --------------------------------------------------------------------------
// Frontière : le store n'est pas une autorité métier
// --------------------------------------------------------------------------

test('le contenu humain traverse octet pour octet, sans normalisation', async () => {
  await withRun(async (paths) => {
    const content = '  Décision\tavec\nespaces  et « accents »  ';
    await appendReconciliationEntries(paths, [act(1, { content })]);
    const read = await readReconciliationJournal(paths);
    const entry = read.entries[0] as unknown as Record<string, unknown>;
    assert.equal(entry['content'], content);
  });
});

test('l\'ordre des options est celui du producteur, jamais retrié', async () => {
  await withRun(async (paths) => {
    const options = [
      { option_id: 'zeta', content: 'z' },
      { option_id: 'alpha', content: 'a' },
    ];
    const entry = { ...(proposal(1) as unknown as Record<string, unknown>), options } as unknown as ReconciliationEntry;
    await appendReconciliationEntries(paths, [entry]);
    const read = await readReconciliationJournal(paths);
    const stored = read.entries[0] as unknown as Record<string, unknown>;
    assert.deepEqual(stored['options'], options);
  });
});
