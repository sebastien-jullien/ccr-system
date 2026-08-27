/**
 * V3-S2 — journal V3, snapshot stable, révision.
 *
 * Question de preuve :
 *
 * > **La quatrième source rejoint-elle la frontière de stabilité sans déplacer
 * > d'un octet la révision d'un run existant ?**
 *
 * Trois propriétés.
 *
 *  1. **L'absence est une observation, pas un manque.** Lire un run antérieur
 *     à V3 ne crée rien, et son jeton V3 existe quand même.
 *  2. **La révision native ne bouge pas.** Ajouter, remplir ou vider le journal
 *     V3 laisse `revision` strictement identique.
 *  3. **Rien n'est masqué.** Une queue non terminée est transitoire ; une ligne
 *     terminée invalide et une version inconnue échouent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import {
  appendControversyEntry,
  computeControversyRevision,
  readControversyJournal,
} from '../../src/store/controversy-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';

const RUN_ID = 'CCR-20260817-001';

function domainEntry(sequence: number): ControversyEntry {
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: formatControversyId(1),
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-17T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000010', round: 1 }] },
  };
}

/**
 * Run natif minimal sur disque réel.
 *
 * Les documents sont écrits directement : S2 lit une source, elle n'en produit
 * aucune, et faire tourner les services de création dépasserait la tranche.
 */
async function nativeRun(): Promise<{ runsDir: string; paths: ReturnType<typeof runPaths>; dispose: () => Promise<void> }> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v3-s2-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-08-17T09:00:00.000Z',
      title: 'S2',
      workspace: { cwd: runsDir },
      experts: {
        author: { provider: 'codex', session_id: 'S1' },
        challenger: { provider: 'claude', session_id: 'S2' },
      },
    }),
    'utf8',
  );
  await writeFile(
    paths.state,
    JSON.stringify({
      schema_version: 3,
      run_id: RUN_ID,
      state: 'READY',
      control: 'AUTOMATION',
      round: 1,
      active_expert_slot: null,
      next_step_source_slot: 'author',
      last_event_id: null,
      updated_at: '2026-08-17T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, '', 'utf8');

  return { runsDir, paths, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

// ==========================================================================
// A. Absence — une observation, jamais un manque
// ==========================================================================

test('1 · run natif pré-V3 : le journal absent est lu, et n’est jamais créé', async () => {
  const run = await nativeRun();
  try {
    assert.equal(existsSync(run.paths.controversies), false, 'absent avant la lecture');

    const first = await readStableNativeRunSnapshot(run.runsDir, RUN_ID);

    assert.equal(existsSync(run.paths.controversies), false, 'absent APRÈS la lecture');
    assert.deepEqual(first.controversies, []);
    assert.equal(typeof first.controversy_revision, 'string');
    assert.ok(first.controversy_revision.length > 0);

    // Déterminisme : deux lectures d'un même état rendent le même jeton.
    const second = await readStableNativeRunSnapshot(run.runsDir, RUN_ID);
    assert.equal(second.controversy_revision, first.controversy_revision);
    assert.equal(existsSync(run.paths.controversies), false);
  } finally {
    await run.dispose();
  }
});

test('2 · absent et vide ne sont pas le même fait', async () => {
  const absent = computeControversyRevision({ present: false });
  const empty = computeControversyRevision({ present: true, written: '' });

  assert.notEqual(absent, empty, 'un journal absent n’a pas été observé comme un journal vide');

  // Espace de noms distinct de celui d'une révision de run : un jeton V3 ne
  // peut être confondu avec un jeton de run, ni l'inverse.
  assert.ok(absent.startsWith('ctv-sha256:'));
  assert.equal(absent.startsWith('sha256:'), false);

  // Contenu identique → même empreinte, y compris pour une copie.
  const a = computeControversyRevision({ present: true, written: '{"x":1}\n' });
  const b = computeControversyRevision({ present: true, written: '{"x":1}\n' });
  assert.equal(a, b);
  assert.notEqual(a, computeControversyRevision({ present: true, written: '{"x":2}\n' }));
});

// ==========================================================================
// B. La révision native ne bouge pas
// ==========================================================================

test('3 · ajouter, remplir puis vider le journal V3 laisse `revision` identique', async () => {
  const run = await nativeRun();
  try {
    const before = await readStableNativeRunSnapshot(run.runsDir, RUN_ID);

    await appendControversyEntry(run.paths, domainEntry(1));
    const withEntry = await readStableNativeRunSnapshot(run.runsDir, RUN_ID);

    await writeFile(run.paths.controversies, '', 'utf8');
    const emptied = await readStableNativeRunSnapshot(run.runsDir, RUN_ID);

    // Les trois sources historiques n'ont pas bougé : la révision non plus.
    assert.equal(withEntry.revision, before.revision, 'une entrée V3 ne périme pas le run');
    assert.equal(emptied.revision, before.revision, 'vider le journal V3 non plus');

    // Le jeton V3, lui, suit sa propre source.
    assert.notEqual(withEntry.controversy_revision, before.controversy_revision);
    assert.notEqual(emptied.controversy_revision, before.controversy_revision);
    assert.notEqual(emptied.controversy_revision, withEntry.controversy_revision);
  } finally {
    await run.dispose();
  }
});

// ==========================================================================
// C. Lecture des entrées
// ==========================================================================

test('4 · les entrées valides sont rendues dans leur ordre d’append', async () => {
  const run = await nativeRun();
  try {
    await appendControversyEntry(run.paths, domainEntry(1));
    await appendControversyEntry(run.paths, domainEntry(2));
    await appendControversyEntry(run.paths, domainEntry(3));

    const journal = await readControversyJournal(run.paths);
    assert.equal(journal.present, true);
    assert.deepEqual(
      journal.entries.map((entry) => entry.entry_id),
      [formatControversyEntryId(1), formatControversyEntryId(2), formatControversyEntryId(3)],
    );

    const snapshot = await readStableNativeRunSnapshot(run.runsDir, RUN_ID);
    assert.equal(snapshot.controversies.length, 3);
    assert.equal(snapshot.controversy_revision, journal.revision);
  } finally {
    await run.dispose();
  }
});

test('5 · un journal vide se lit sans erreur, et se distingue d’un journal absent', async () => {
  const run = await nativeRun();
  try {
    await writeFile(run.paths.controversies, '', 'utf8');
    const journal = await readControversyJournal(run.paths);

    assert.equal(journal.present, true);
    assert.deepEqual(journal.entries, []);
    assert.equal(journal.revision, computeControversyRevision({ present: true, written: '' }));
    assert.notEqual(journal.revision, computeControversyRevision({ present: false }));
  } finally {
    await run.dispose();
  }
});

// ==========================================================================
// D. Ce qui ne doit jamais être masqué
// ==========================================================================

test('6 · une version de schéma inconnue est refusée', async () => {
  const run = await nativeRun();
  try {
    const foreign = { ...domainEntry(1), schema_version: CONTROVERSY_SCHEMA_VERSION + 1 };
    await writeFile(run.paths.controversies, `${JSON.stringify(foreign)}\n`, 'utf8');

    await assert.rejects(() => readControversyJournal(run.paths), /schema_version/);
    await assert.rejects(() => readStableNativeRunSnapshot(run.runsDir, RUN_ID), /schema_version/);
  } finally {
    await run.dispose();
  }
});

test('7 · une ligne terminée invalide est une corruption stable, jamais une fin de journal', async () => {
  const run = await nativeRun();
  try {
    const valid = JSON.stringify(domainEntry(1));
    // Ligne médiane corrompue, terminée : le saut de ligne prouve que son
    // écriture est achevée. La tolérer serait tronquer le journal en silence.
    await writeFile(run.paths.controversies, `${valid}\n{"broken":\n${valid}\n`, 'utf8');

    await assert.rejects(() => readControversyJournal(run.paths));
  } finally {
    await run.dispose();
  }
});

test('8 · un fragment final non terminé est ignoré comme non encore écrit', async () => {
  const run = await nativeRun();
  try {
    const first = JSON.stringify(domainEntry(1));
    const second = JSON.stringify(domainEntry(2));
    const budget = { attempts: 1, delaysMs: [0] };

    // Contrat §16.5 : le saut de ligne fait l'écriture. Un fragment qui ne le
    // porte pas n'est pas une entrée — « jamais une corruption », donc jamais
    // une erreur. Le préfixe terminé est rendu intact.
    for (const tail of ['{"partial":', second, '', '   ']) {
      const raw = `${first}\n${tail}`;
      await writeFile(run.paths.controversies, raw, 'utf8');

      const journal = await readControversyJournal(run.paths, { budget });
      assert.equal(journal.entries.length, 1, `queue « ${tail.slice(0, 12)} » ignorée`);
      assert.equal(journal.entries[0]?.entry_id, formatControversyEntryId(1));

      // Le lecteur ne répare rien : la source est intacte, y compris sa queue.
      assert.equal(await readFile(run.paths.controversies, 'utf8'), raw);
    }

    // Un fichier réduit à un seul fragment non terminé : zéro entrée écrite.
    await writeFile(run.paths.controversies, '{"partial":', 'utf8');
    const none = await readControversyJournal(run.paths, { budget });
    assert.deepEqual(none.entries, []);
    assert.equal(none.present, true);
  } finally {
    await run.dispose();
  }
});

test('9 · la révision porte le préfixe écrit, jamais la queue ignorée', async () => {
  const run = await nativeRun();
  try {
    const first = JSON.stringify(domainEntry(1));
    const budget = { attempts: 1, delaysMs: [0] };

    await writeFile(run.paths.controversies, `${first}\n`, 'utf8');
    const clean = await readControversyJournal(run.paths, { budget });

    // Même préfixe écrit, queues différentes : les entrées ET la révision sont
    // identiques. Un append en vol n'a encore rien écrit, il ne périme donc
    // aucun jeton.
    for (const tail of ['{"partial":', '{"other":', 'x']) {
      await writeFile(run.paths.controversies, `${first}\n${tail}`, 'utf8');
      const pending = await readControversyJournal(run.paths, { budget });

      assert.deepEqual(
        pending.entries.map((entry) => entry.entry_id),
        clean.entries.map((entry) => entry.entry_id),
      );
      assert.equal(pending.revision, clean.revision, 'la queue ne participe pas à la révision');
    }

    // La révision est bien celle du préfixe, calculée depuis la même lecture.
    assert.equal(clean.revision, computeControversyRevision({ present: true, written: `${first}\n` }));

    // Et une entrée réellement écrite, elle, la fait changer.
    await writeFile(run.paths.controversies, `${first}\n`, 'utf8');
    await appendControversyEntry(run.paths, domainEntry(2));
    const grown = await readControversyJournal(run.paths, { budget });
    assert.equal(grown.entries.length, 2);
    assert.notEqual(grown.revision, clean.revision);
  } finally {
    await run.dispose();
  }
});

// ==========================================================================
// E. Frontière de stabilité
// ==========================================================================

test('10 · une mutation du journal V3 pendant la lecture rend le snapshot instable', async () => {
  const run = await nativeRun();
  try {
    await appendControversyEntry(run.paths, domainEntry(1));

    await assert.rejects(
      () =>
        readStableNativeRunSnapshot(run.runsDir, RUN_ID, {
          budget: { attempts: 2, delaysMs: [0, 0] },
          sleep: () => Promise.resolve(),
          // La course est provoquée dans la seule fenêtre déterministe : les
          // faits sont lus, la réobservation n'a pas encore eu lieu.
          beforeReobserve: () => appendControversyEntry(run.paths, domainEntry(2)).then(() => undefined),
        }),
      /SNAPSHOT_UNSTABLE|modifié pendant/,
    );
  } finally {
    await run.dispose();
  }
});

test('11 · aucun événement n’est écrit dans events.jsonl par une écriture V3', async () => {
  const run = await nativeRun();
  try {
    const before = await readFile(run.paths.events, 'utf8');
    await appendControversyEntry(run.paths, domainEntry(1));
    await appendControversyEntry(run.paths, domainEntry(2));
    assert.equal(await readFile(run.paths.events, 'utf8'), before, 'events.jsonl est inchangé');
  } finally {
    await run.dispose();
  }
});

// ==========================================================================
// F. Append après une queue non écrite
//
// `appendJsonLine` ouvre en mode 'a'. Sur un journal terminé par un fragment
// non écrit, un append naïf produirait une ligne CONCATÉNÉE — et terminée,
// donc une corruption stable. Le contrat qualifie ce fragment de non écrit ;
// le promouvoir en histoire serait exactement l'inverse de ce qu'il dit.
// ==========================================================================

test('12 · append sur ABSENT, sur vide, et sur un préfixe valide', async () => {
  for (const initial of [undefined, '', `${JSON.stringify(domainEntry(1))}\n`]) {
    const run = await nativeRun();
    try {
      if (initial !== undefined) await writeFile(run.paths.controversies, initial, 'utf8');

      await appendControversyEntry(run.paths, domainEntry(2));
      const journal = await readControversyJournal(run.paths);

      const expected = initial === undefined || initial === '' ? [2] : [1, 2];
      assert.deepEqual(
        journal.entries.map((entry) => entry.entry_id),
        expected.map((n) => formatControversyEntryId(n)),
      );
      assert.equal(journal.has_unwritten_tail, false);
    } finally {
      await run.dispose();
    }
  }
});

test('13 · une queue non écrite ne contamine jamais l’append suivant', async () => {
  const first = JSON.stringify(domainEntry(1));

  // Deux natures de queue, et la seconde est la plus instructive : un JSON
  // parfaitement valide, mais sans saut de ligne. Parsable ≠ écrit.
  for (const tail of ['{"partial":', JSON.stringify(domainEntry(9))]) {
    const run = await nativeRun();
    try {
      await writeFile(run.paths.controversies, `${first}\n${tail}`, 'utf8');

      await appendControversyEntry(run.paths, domainEntry(2));

      const journal = await readControversyJournal(run.paths);
      assert.deepEqual(
        journal.entries.map((entry) => entry.entry_id),
        [formatControversyEntryId(1), formatControversyEntryId(2)],
        'la queue a disparu, et n’a rien laissé derrière elle',
      );
      assert.equal(journal.has_unwritten_tail, false);

      // Et surtout : le fichier vaut EXACTEMENT le préfixe écrit suivi de la
      // nouvelle ligne. Aucune concaténation, aucune ligne corrompue, aucun
      // reliquat de la queue.
      const raw = await readFile(run.paths.controversies, 'utf8');
      assert.equal(raw, `${first}\n${JSON.stringify(domainEntry(2))}\n`);
    } finally {
      await run.dispose();
    }
  }
});

test('14 · un fichier réduit à une queue non écrite ne contient plus qu’une entrée', async () => {
  const run = await nativeRun();
  try {
    await writeFile(run.paths.controversies, '{"partial":', 'utf8');

    await appendControversyEntry(run.paths, domainEntry(1));

    const journal = await readControversyJournal(run.paths);
    assert.deepEqual(
      journal.entries.map((entry) => entry.entry_id),
      [formatControversyEntryId(1)],
    );
    const raw = await readFile(run.paths.controversies, 'utf8');
    assert.equal(raw.startsWith('{"partial":'), false, 'la queue non écrite a été retirée');
    assert.equal(raw.split('\n').filter((line) => line.length > 0).length, 1);
  } finally {
    await run.dispose();
  }
});

test('15 · une corruption terminée refuse l’append, et le fichier reste intact', async () => {
  const valid = JSON.stringify(domainEntry(1));
  const foreign = JSON.stringify({ ...domainEntry(2), schema_version: CONTROVERSY_SCHEMA_VERSION + 1 });

  const cases: readonly (readonly [string, string])[] = [
    ['ligne finale terminée invalide', `${valid}\n{"broken":\n`],
    ['ligne médiane terminée invalide', `${valid}\n{"broken":\n${valid}\n`],
    ['version terminée non supportée', `${valid}\n${foreign}\n`],
  ];

  for (const [label, content] of cases) {
    const run = await nativeRun();
    try {
      await writeFile(run.paths.controversies, content, 'utf8');

      await assert.rejects(() => appendControversyEntry(run.paths, domainEntry(3)), label);

      // Aucune troncature, aucune réparation silencieuse, aucun ajout.
      assert.equal(await readFile(run.paths.controversies, 'utf8'), content, `${label} : octets intacts`);
    } finally {
      await run.dispose();
    }
  }
});

test('16 · normaliser une queue ne change pas la révision ; écrire une entrée la change', async () => {
  const run = await nativeRun();
  try {
    const first = JSON.stringify(domainEntry(1));
    await writeFile(run.paths.controversies, `${first}\n`, 'utf8');
    const clean = await readControversyJournal(run.paths);

    // Le même préfixe, suivi d'octets non écrits : révision inchangée.
    await writeFile(run.paths.controversies, `${first}\n{"partial":`, 'utf8');
    const withTail = await readControversyJournal(run.paths);
    assert.equal(withTail.revision, clean.revision);
    assert.equal(withTail.has_unwritten_tail, true);
    assert.equal(withTail.written_bytes, Buffer.byteLength(`${first}\n`, 'utf8'));

    // L'append normalise puis écrit : la révision change à cause de l'entrée,
    // pas à cause de la normalisation.
    await appendControversyEntry(run.paths, domainEntry(2));
    const grown = await readControversyJournal(run.paths);
    assert.notEqual(grown.revision, clean.revision);
    assert.equal(grown.entries.length, 2);
  } finally {
    await run.dispose();
  }
});
