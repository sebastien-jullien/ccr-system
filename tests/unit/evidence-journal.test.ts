/**
 * V4 · S2 — journal, révision, cinquième source stable.
 *
 * Question de preuve :
 *
 * > **La persistance V4 est-elle append-only, honnête sur ce qu'elle n'a pas
 * > observé, et rigoureusement étanche à la révision historique du run ?**
 *
 * Quatre propriétés.
 *
 *  1. **Absent, vide, corrompu et non supporté sont quatre faits.** Aucun ne se
 *     replie sur un autre, et aucune erreur ne devient un journal vide.
 *  2. **Le saut de ligne fait l'écriture.** Un fragment final n'est ni une
 *     entrée, ni une corruption : il est absent, et ne consomme aucune séquence.
 *  3. **La révision de run ne bouge pas.** V4 est une cinquième source du
 *     snapshot stable, jamais une cinquième composante de son empreinte.
 *  4. **Aucune déduplication.** Deux charges identiques coexistent ; seule une
 *     identité canonique répétée est refusée, et comme une corruption.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import {
  appendEvidenceEntries,
  computeEvidenceRevision,
  readEvidenceJournal,
} from '../../src/store/evidence-store.ts';
import {
  NATIVE_STABLE_SNAPSHOT_SOURCE_COUNT,
  computeNativeRunRevision,
  readStableNativeRunSnapshot,
} from '../../src/store/native-run-snapshot.ts';
import { EVIDENCE_SCHEMA_VERSION } from '../../src/core/evidence.ts';
import type { AdductionRecordedEntry, EvidenceEntry, MaterialRecordedEntry } from '../../src/core/evidence.ts';
import { isCcrError } from '../../src/core/errors.ts';

const RUN_ID = 'CCR-20260818-401';

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s2-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  return { runsDir, paths, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

/** Un run natif minimal, pour les tests de snapshot. */
async function nativeRun(paths: RunPaths, runsDir: string): Promise<void> {
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's2', created_at: '2026-08-18T09:00:00.000Z',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'codex', session_id: 'S1' },
      challenger: { provider: 'claude', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000001',
    updated_at: '2026-08-18T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, `${JSON.stringify({
    event_id: 'evt_000001', run_id: RUN_ID, round: 1, timestamp: '2026-08-18T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: 'le cache doit expirer',
  })}\n`, 'utf8');
}

function material(sequence: number, over: Partial<MaterialRecordedEntry> = {}): MaterialRecordedEntry {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    entry_id: `mat_${String(sequence).padStart(6, '0')}`,
    kind: 'MATERIAL_RECORDED',
    recorded_by: 'CCR',
    recorded_at: '2026-08-18T10:00:00.000Z',
    submitted_by: 'HUMAN',
    representation: { form: 'INLINE_TEXT', text: 'le cache doit expirer' },
    observed_by_ccr: true,
    ...over,
  } as MaterialRecordedEntry;
}

function adduction(sequence: number, over: Partial<AdductionRecordedEntry> = {}): AdductionRecordedEntry {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    entry_id: `add_${String(sequence).padStart(6, '0')}`,
    kind: 'ADDUCTION_RECORDED',
    recorded_by: 'CCR',
    recorded_at: '2026-08-18T10:00:00.000Z',
    material_id: 'mat_000001',
    target: { kind: 'CONTROVERSY_ENTRY', entry_id: 'ctve_000007' },
    orientation: 'NONE',
    semantic_origin: 'HUMAN',
    ...over,
  } as AdductionRecordedEntry;
}

async function rejects(fn: () => Promise<unknown>, code: string, what: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(isCcrError(error), `${what} : attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code, what);
    return;
  }
  assert.fail(`${what} : aucun refus`);
}

// ==========================================================================
// A. Chemin et absence
// ==========================================================================

test('1 · T1/T2 — le douzième chemin existe, et le lire ne le crée pas', async () => {
  const h = await fixture();
  try {
    assert.equal(h.paths.evidence, path.join(h.paths.root, 'evidence.jsonl'));

    // Les onze chemins historiques sont intacts.
    assert.equal(h.paths.controversies, path.join(h.paths.root, 'controversies.jsonl'));
    assert.equal(h.paths.events, path.join(h.paths.root, 'events.jsonl'));

    const read = await readEvidenceJournal(h.paths);
    assert.equal(read.present, false, 'absence constatée');
    assert.deepEqual([...read.entries], []);
    assert.equal(read.written_bytes, 0);
    assert.equal(read.has_unwritten_tail, false);
    assert.equal(read.next_material_sequence, 1);
    assert.equal(read.next_adduction_sequence, 1);

    assert.equal(existsSync(h.paths.evidence), false, 'la lecture ne matérialise rien');
  } finally {
    await h.dispose();
  }
});

test('2 · T15 — absent et vide ne sont pas le même fait', async () => {
  const h = await fixture();
  try {
    const absent = await readEvidenceJournal(h.paths);
    await writeFile(h.paths.evidence, '', 'utf8');
    const vide = await readEvidenceJournal(h.paths);

    assert.equal(absent.present, false);
    assert.equal(vide.present, true);
    assert.deepEqual([...absent.entries], [...vide.entries]);

    // Les deux portent zéro entrée. C'est la révision qui les distingue.
    assert.notEqual(absent.revision, vide.revision, 'absent ≠ vide');
    assert.match(absent.revision, /^ev-sha256:[0-9a-f]{64}$/);
    assert.match(vide.revision, /^ev-sha256:[0-9a-f]{64}$/);

    // Et le calcul pur porte la même distinction.
    assert.notEqual(
      computeEvidenceRevision({ present: false }),
      computeEvidenceRevision({ present: true, written: '' }),
    );
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// B. Append
// ==========================================================================

test('3 · T3/T4/T5 — matériaux et adductions s’ajoutent, dans l’ordre d’append', async () => {
  const h = await fixture();
  try {
    await appendEvidenceEntries(h.paths, [material(1)]);
    await appendEvidenceEntries(h.paths, [adduction(1, { orientation: 'SUPPORTS' })]);
    await appendEvidenceEntries(h.paths, [material(2, {
      representation: { form: 'EXTERNAL_REFERENCE', locator: 'https://example.test/a' },
      observed_by_ccr: false,
    })]);

    const read = await readEvidenceJournal(h.paths);
    assert.equal(read.present, true);
    assert.deepEqual(read.entries.map((e) => e.entry_id), ['mat_000001', 'add_000001', 'mat_000002']);
    assert.deepEqual(read.entries.map((e) => e.kind), [
      'MATERIAL_RECORDED', 'ADDUCTION_RECORDED', 'MATERIAL_RECORDED',
    ]);

    // L'ordre est celui de l'append : ni tri par identifiant, ni par genre.
    const trie = [...read.entries].sort((a, b) => a.entry_id.localeCompare(b.entry_id));
    assert.notDeepEqual(read.entries.map((e) => e.entry_id), trie.map((e) => e.entry_id));
  } finally {
    await h.dispose();
  }
});

test('4 · lot : tout ou rien avant le premier octet', async () => {
  const h = await fixture();
  try {
    // Un lot valide s'écrit en une fois.
    const lot = await appendEvidenceEntries(h.paths, [material(1), adduction(1), adduction(2)]);
    assert.equal(lot.length, 3);
    assert.equal((await readEvidenceJournal(h.paths)).entries.length, 3);

    // Un lot dont UNE entrée est invalide ne laisse aucune trace, pas même
    // partielle : la validation précède intégralement l'écriture.
    const avant = await readFile(h.paths.evidence, 'utf8');
    await rejects(
      () =>
        appendEvidenceEntries(h.paths, [
          material(2),
          adduction(3, { orientation: 'MAYBE' as never }),
        ]),
      'INVALID_ARGUMENT',
      'lot partiellement invalide',
    );
    assert.equal(await readFile(h.paths.evidence, 'utf8'), avant, 'octets intacts');

    await rejects(() => appendEvidenceEntries(h.paths, []), 'INVALID_ARGUMENT', 'lot vide');
  } finally {
    await h.dispose();
  }
});

test('5 · T6/T17 — deux charges identiques coexistent, et les séquences sont indépendantes', async () => {
  const h = await fixture();
  try {
    // Même représentation, deux identités : CCR n'a aucune autorité
    // d'équivalence, et ne déclare jamais deux matériaux « le même ».
    await appendEvidenceEntries(h.paths, [material(1), material(2)]);
    const deux = await readEvidenceJournal(h.paths);
    assert.equal(deux.entries.length, 2, 'aucune déduplication');
    assert.deepEqual(
      deux.entries.map((e) => JSON.stringify((e as MaterialRecordedEntry).representation)),
      Array(2).fill(JSON.stringify({ form: 'INLINE_TEXT', text: 'le cache doit expirer' })),
    );

    // Deux adductions identiques sont deux actes historiques.
    await appendEvidenceEntries(h.paths, [adduction(1), adduction(2)]);
    const quatre = await readEvidenceJournal(h.paths);
    assert.equal(quatre.entries.length, 4);

    // Les deux séquences progressent séparément : mat_000002 ne détermine pas
    // add_000002.
    assert.equal(quatre.next_material_sequence, 3);
    assert.equal(quatre.next_adduction_sequence, 3);

    await appendEvidenceEntries(h.paths, [material(3)]);
    const cinq = await readEvidenceJournal(h.paths);
    assert.equal(cinq.next_material_sequence, 4);
    assert.equal(cinq.next_adduction_sequence, 3, 'la séquence des adductions n’a pas bougé');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// C. Refus de lecture
// ==========================================================================

test('6 · T7 — une identité canonique répétée est une corruption, pas un doublon métier', async () => {
  const h = await fixture();
  try {
    for (const lignes of [
      [material(1), material(1)],                 // répétition exacte
      [material(2), material(1)],                 // séquence décroissante
      [adduction(1), adduction(1)],
      [adduction(5), adduction(5)],
    ]) {
      await writeFile(h.paths.evidence, lignes.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      await rejects(
        () => readEvidenceJournal(h.paths),
        'JOURNAL_INVALID',
        `séquence ${lignes.map((e) => e.entry_id).join(' → ')}`,
      );
    }

    // Une progression avec trou reste licite : rien n'exige la contiguïté.
    await writeFile(
      h.paths.evidence,
      [material(1), material(9)].map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
    const read = await readEvidenceJournal(h.paths);
    assert.equal(read.entries.length, 2);
    assert.equal(read.next_material_sequence, 10);
  } finally {
    await h.dispose();
  }
});

test('7 · T8/T9/T10/T18 — version, genre, corruption et forme invalide sont refusés', async () => {
  const h = await fixture();
  try {
    const cas: readonly (readonly [string, string])[] = [
      ['version inconnue', JSON.stringify(material(1, { schema_version: 2 }))],
      ['genre inconnu', JSON.stringify(material(1, { kind: 'EVIDENCE_RECORDED' as never }))],
      ['ligne terminée illisible', '{ ceci n’est pas du json'],
      ['orientation invalide', JSON.stringify(adduction(1, { orientation: 'MAYBE' as never }))],
      ['origine invalide', JSON.stringify(adduction(1, { semantic_origin: 'SOURCE' as never }))],
      [
        'HUMAN portant une dérivation',
        JSON.stringify(adduction(1, {
          semantic_origin: 'HUMAN',
          derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000001', inputs: [] },
        })),
      ],
      ['CCR sans dérivation', JSON.stringify(adduction(1, { semantic_origin: 'CCR' }))],
      ['identifiant non canonique', JSON.stringify(material(1, { entry_id: 'mat_00001' }))],
      ['cible ctv_', JSON.stringify(adduction(1, {
        target: { kind: 'CONTROVERSY_ENTRY', entry_id: 'ctv_000001' },
      }))],
      ['citation sans rang', JSON.stringify(adduction(1, {
        citation: { quoted_text: 'x', occurrence: 0 },
      }))],
      ['représentation inconnue', JSON.stringify(material(1, {
        representation: { form: 'SCREENSHOT', text: 'x' } as never,
      }))],
    ];

    for (const [label, ligne] of cas) {
      await writeFile(h.paths.evidence, `${ligne}\n`, 'utf8');
      const avant = await readFile(h.paths.evidence, 'utf8');
      try {
        await readEvidenceJournal(h.paths);
        assert.fail(`${label} : aucun refus`);
      } catch (error) {
        assert.ok(isCcrError(error), `${label} : ${String(error)}`);
      }
      // T22 — un refus laisse les octets historiques intacts.
      assert.equal(await readFile(h.paths.evidence, 'utf8'), avant, `${label} : octets intacts`);
    }
  } finally {
    await h.dispose();
  }
});

test('8 · T22 — une erreur de lecture n’est jamais un journal vide', async () => {
  const h = await fixture();
  try {
    await writeFile(h.paths.evidence, `${JSON.stringify(material(1))}\n`, 'utf8');

    // Une lecture impossible remonte telle quelle : elle ne se replie ni sur
    // « absent », ni sur « vide ».
    const panne = Object.assign(new Error('EIO'), { code: 'EIO' });
    await assert.rejects(
      () => readEvidenceJournal(h.paths, { read: () => Promise.reject(panne) }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EIO',
    );

    // Et le journal réel reste parfaitement lisible.
    assert.equal((await readEvidenceJournal(h.paths)).entries.length, 1);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// D. Queue non écrite
// ==========================================================================

test('9 · T11/T12/T16 — un fragment final n’est ni une entrée, ni une corruption', async () => {
  const h = await fixture();
  try {
    await appendEvidenceEntries(h.paths, [material(1)]);
    const propre = await readEvidenceJournal(h.paths);

    // Une queue non terminée est ajoutée derrière une ligne écrite.
    const octets = await readFile(h.paths.evidence, 'utf8');
    await writeFile(h.paths.evidence, `${octets}{"schema_version":1,"entry_id":"mat_0000`, 'utf8');

    const avecQueue = await readEvidenceJournal(h.paths);
    assert.equal(avecQueue.entries.length, 1, 'la queue n’est pas une entrée');
    assert.equal(avecQueue.has_unwritten_tail, true);
    assert.equal(avecQueue.written_bytes, propre.written_bytes);

    // T16 — elle ne fait pas bouger la révision : elle n'a rien écrit.
    assert.equal(avecQueue.revision, propre.revision);

    // Ni la séquence : un fragment ne consomme aucune identité.
    assert.equal(avecQueue.next_material_sequence, propre.next_material_sequence);

    // T12 — l'append suivant la retire, puis écrit. Rien de terminé n'est perdu.
    await appendEvidenceEntries(h.paths, [material(2)]);
    const apres = await readEvidenceJournal(h.paths);
    assert.deepEqual(apres.entries.map((e) => e.entry_id), ['mat_000001', 'mat_000002']);
    assert.equal(apres.has_unwritten_tail, false);
    assert.equal(
      (await readFile(h.paths.evidence, 'utf8')).includes('"mat_0000\n'),
      false,
      'aucune concaténation',
    );
  } finally {
    await h.dispose();
  }
});

test('10 · un append refusé ne crée jamais le fichier', async () => {
  const h = await fixture();
  try {
    await rejects(
      () => appendEvidenceEntries(h.paths, [material(1, { schema_version: 2 })]),
      'INVALID_ARGUMENT',
      'entrée invalide sur journal absent',
    );
    assert.equal(existsSync(h.paths.evidence), false);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// E. Révision
// ==========================================================================

test('11 · T13/T14 — stable à état identique, différente après un append', async () => {
  const h = await fixture();
  try {
    await appendEvidenceEntries(h.paths, [material(1)]);
    const a = await readEvidenceJournal(h.paths);
    const b = await readEvidenceJournal(h.paths);
    assert.equal(a.revision, b.revision, 'lire ne change rien');

    await appendEvidenceEntries(h.paths, [adduction(1)]);
    const c = await readEvidenceJournal(h.paths);
    assert.notEqual(c.revision, a.revision, 'écrire change la révision');

    // Fondée sur le CONTENU : une recopie à l'identique produit la même
    // empreinte, quelles que soient les métadonnées du fichier.
    const octets = await readFile(h.paths.evidence, 'utf8');
    const autre = await fixture();
    try {
      await writeFile(autre.paths.evidence, octets, 'utf8');
      assert.equal((await readEvidenceJournal(autre.paths)).revision, c.revision);
    } finally {
      await autre.dispose();
    }
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// F. Snapshot stable
// ==========================================================================

test('12 · T19 — le snapshot porte la cinquième source', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    await appendEvidenceEntries(h.paths, [material(1), adduction(1, { orientation: 'OBJECTS_TO' })]);

    // V5 a fait entrer `reconciliations.jsonl` dans la même fenêtre stable
    // (contrat V5 §30). L'extension est additive : la sémantique de la source
    // V4 vérifiée ci-dessous est inchangée.
    assert.equal(NATIVE_STABLE_SNAPSHOT_SOURCE_COUNT, 6);

    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.deepEqual(snapshot.evidence.map((e) => e.entry_id), ['mat_000001', 'add_000001']);
    assert.match(snapshot.evidence_revision, /^ev-sha256:[0-9a-f]{64}$/);
    assert.match(snapshot.controversy_revision, /^ctv-sha256:[0-9a-f]{64}$/);
    assert.match(snapshot.revision, /^sha256:[0-9a-f]{64}$/);

    // Trois espaces de noms, jamais confondus.
    assert.equal(new Set([snapshot.revision, snapshot.controversy_revision, snapshot.evidence_revision]).size, 3);

    // Un run natif sans journal V4 est lu sans que rien ne soit créé.
    const vierge = await fixture();
    try {
      await nativeRun(vierge.paths, vierge.runsDir);
      const vide = await readStableNativeRunSnapshot(vierge.runsDir, RUN_ID);
      assert.deepEqual([...vide.evidence], []);
      assert.equal(existsSync(vierge.paths.evidence), false);
    } finally {
      await vierge.dispose();
    }
  } finally {
    await h.dispose();
  }
});

test('13 · T20 — une écriture V4 ne fait PAS bouger la révision historique du run', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    const avant = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);

    await appendEvidenceEntries(h.paths, [material(1), material(2), adduction(1)]);
    const apres = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);

    // Critère de sortie de S2 : l'empreinte du run est INCHANGÉE.
    assert.equal(apres.revision, avant.revision, 'la révision de run ne bouge pas');
    assert.equal(
      computeNativeRunRevision(apres.manifest, apres.state, apres.events),
      avant.revision,
    );

    // La controverse non plus : les trois domaines sont étanches.
    assert.equal(apres.controversy_revision, avant.controversy_revision);

    // Seule la fraîcheur V4 a changé.
    assert.notEqual(apres.evidence_revision, avant.evidence_revision);
    assert.equal(apres.evidence.length, 3);
  } finally {
    await h.dispose();
  }
});

test('14 · T21 — une mutation V4 concurrente rend le snapshot instable', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);
    await appendEvidenceEntries(h.paths, [material(1)]);

    let injections = 0;
    await assert.rejects(
      () =>
        readStableNativeRunSnapshot(h.runsDir, RUN_ID, {
          budget: { attempts: 2, delaysMs: [0] },
          sleep: () => Promise.resolve(),
          // Le journal V4 bouge entre la lecture et la réobservation : la
          // combinaison obtenue n'a peut-être jamais coexisté.
          beforeReobserve: async () => {
            injections += 1;
            await appendEvidenceEntries(h.paths, [material(injections + 1)]);
          },
        }),
      (error: unknown) => isCcrError(error) && error.code === 'SNAPSHOT_UNSTABLE',
    );
    assert.equal(injections, 2, 'les deux tentatives ont été perturbées');

    // Sans perturbation, la lecture aboutit.
    const stable = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.equal(stable.evidence.length, 3);
    assert.equal(stable.attempts, 1);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// G. Étanchéité
// ==========================================================================

test('15 · V3 intact, et V4 n’écrit que son propre journal', async () => {
  const h = await fixture();
  try {
    await nativeRun(h.paths, h.runsDir);

    const empreintes = async (): Promise<readonly string[]> =>
      Promise.all(
        [h.paths.manifest, h.paths.state, h.paths.events].map((f) => readFile(f, 'utf8')),
      );
    const avant = await empreintes();

    await appendEvidenceEntries(h.paths, [material(1), adduction(1)]);

    assert.deepEqual(await empreintes(), avant, 'aucune source historique touchée');
    for (const absent of [h.paths.controversies, h.paths.decisions, h.paths.invocations, h.paths.usage]) {
      assert.equal(existsSync(absent), false, `${path.basename(absent)} non créé`);
    }
    assert.equal((await stat(h.paths.evidence)).isFile(), true);
  } finally {
    await h.dispose();
  }
});
