/**
 * V4 · S3 — projection de l'Evidence Engine, et vue HTTP additive.
 *
 * Question de preuve :
 *
 * > **La projection dérive-t-elle uniquement ce que CCR peut constater depuis
 * > un seul snapshot stable, sans jamais conclure sur le fond ?**
 *
 * Quatre propriétés.
 *
 *  1. **Un snapshot, une projection.** Aucune seconde lecture du journal,
 *     aucun accès réseau, aucune fenêtre de course.
 *  2. **La disponibilité est structurelle.** Un run historique ne peut pas
 *     porter un zéro ; une erreur n'est jamais projetée comme vide.
 *  3. **La vérifiabilité décrit un constat.** `UNRESOLVABLE` n'est pas faux,
 *     `NOT_OBSERVED_BY_CCR` n'est ni absent ni inexistant.
 *  4. **Aucune conclusion.** Ni force, ni fiabilité, ni suffisance, ni
 *     orientation dérivée, ni regroupement, ni déduplication.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { appendEvidenceEntries } from '../../src/store/evidence-store.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import {
  EVIDENCE_READ_MODEL_VERSION,
  evidenceReadModelNotAvailable,
  projectEvidenceReadModel,
} from '../../src/services/evidence-read-model.ts';
import type { EvidenceReadModelV1 } from '../../src/services/evidence-read-model.ts';
import { readNativeRunHttpView } from '../../src/cockpit/native-read-http.ts';
import { EVIDENCE_SCHEMA_VERSION } from '../../src/core/evidence.ts';
import type { AdductionRecordedEntry, MaterialRecordedEntry } from '../../src/core/evidence.ts';
import { isCcrError } from '../../src/core/errors.ts';

const RUN_ID = 'CCR-20260818-501';
const SRC = new URL('../../src/', import.meta.url);
const EVENT_TEXT = 'le cache doit expirer apres 60 secondes, et le cache doit expirer';

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  dispose(): Promise<void>;
}

async function nativeFixture(): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s3-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's3', created_at: '2026-08-18T09:00:00.000Z',
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
    content: EVENT_TEXT,
  })}\n`, 'utf8');

  return { runsDir, paths, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

function material(sequence: number, over: Partial<MaterialRecordedEntry> = {}): MaterialRecordedEntry {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    entry_id: `mat_${String(sequence).padStart(6, '0')}`,
    kind: 'MATERIAL_RECORDED',
    recorded_by: 'CCR',
    recorded_at: '2026-08-18T10:00:00.000Z',
    submitted_by: 'HUMAN',
    representation: { form: 'INLINE_TEXT', text: EVENT_TEXT },
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

async function project(h: Fixture): Promise<EvidenceReadModelV1> {
  return projectEvidenceReadModel(await readStableNativeRunSnapshot(h.runsDir, RUN_ID));
}

function available(model: EvidenceReadModelV1): Extract<EvidenceReadModelV1, { availability: 'AVAILABLE' }> {
  assert.equal(model.availability, 'AVAILABLE');
  if (model.availability !== 'AVAILABLE') throw new Error('inatteignable');
  return model;
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ==========================================================================
// A. Disponibilité et zéros
// ==========================================================================

test('1 · T1 — un run historique rend NOT_AVAILABLE, structurellement sans compte', () => {
  const legacy = evidenceReadModelNotAvailable();
  assert.equal(legacy.read_model_version, EVIDENCE_READ_MODEL_VERSION);
  assert.equal(legacy.availability, 'NOT_AVAILABLE');

  // La forme elle-même interdit de porter un zéro : un run non regardé n'a pas
  // « zéro matériau ».
  assert.deepEqual(Object.keys(legacy).sort(), ['availability', 'read_model_version']);
  for (const forbidden of ['materials', 'adductions', 'recorded_material_count', 'evidence_revision']) {
    assert.equal(forbidden in legacy, false, forbidden);
  }
});

test('2 · T2/T3/T4 — natif sans journal et journal vide : AVAILABLE, zéro, rien créé', async () => {
  const h = await nativeFixture();
  try {
    const sansJournal = available(await project(h));
    assert.deepEqual([...sansJournal.materials], []);
    assert.deepEqual([...sansJournal.adductions], []);
    assert.equal(sansJournal.recorded_material_count, 0);
    assert.equal(sansJournal.recorded_adduction_count, 0);
    assert.equal(existsSync(h.paths.evidence), false, 'la projection ne crée rien');

    await writeFile(h.paths.evidence, '', 'utf8');
    const vide = available(await project(h));
    assert.deepEqual([...vide.materials], []);
    assert.equal(vide.recorded_material_count, 0);

    // Les deux portent zéro. C'est la fraîcheur qui les distingue, comme le
    // contrat l'exige — jamais un compteur.
    assert.notEqual(vide.evidence_revision, sansJournal.evidence_revision);
  } finally {
    await h.dispose();
  }
});

test('3 · T5 — un matériau sans adduction reste visible : le fait que le finding rendait indicible', async () => {
  const h = await nativeFixture();
  try {
    await appendEvidenceEntries(h.paths, [material(1)]);
    const model = available(await project(h));

    assert.equal(model.recorded_material_count, 1);
    assert.equal(model.recorded_adduction_count, 0);
    assert.equal(model.materials[0]?.entry.entry_id, 'mat_000001');

    // CCR détient/identifie un matériau que personne n'a versé au débat. Cela ne
    // dit ni que les experts sont d'accord, ni que le matériau est sans valeur :
    // aucune conclusion de cette sorte n'existe dans la projection.
    const serialise = JSON.stringify(model);
    for (const interdit of ['agree', 'irrelevant', 'sans valeur', 'worthless']) {
      assert.equal(serialise.includes(interdit), false, interdit);
    }
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// B. Ordre, absence de regroupement
// ==========================================================================

test('4 · T6/T7/T8 — ordre serveur préservé, aucun regroupement, aucune déduplication', async () => {
  const h = await nativeFixture();
  try {
    // Ordre d'append entrelacé, identifiants volontairement non monotones entre
    // les deux espaces.
    await appendEvidenceEntries(h.paths, [
      material(1),
      adduction(1, { orientation: 'SUPPORTS' }),
      material(2, { representation: { form: 'EXTERNAL_REFERENCE', locator: 'https://example.test/a' }, observed_by_ccr: false }),
      adduction(2, { orientation: 'OBJECTS_TO' }),
      adduction(3, { orientation: 'NONE' }),
      material(3),
    ]);

    const model = available(await project(h));

    // Deux listes plates, chacune dans l'ordre d'apparition du journal.
    assert.deepEqual(model.materials.map((m) => m.entry.entry_id), ['mat_000001', 'mat_000002', 'mat_000003']);
    assert.deepEqual(model.adductions.map((a) => a.entry.entry_id), ['add_000001', 'add_000002', 'add_000003']);
    assert.equal(model.recorded_material_count, 3);
    assert.equal(model.recorded_adduction_count, 3);

    // Aucun regroupement par matériau, par cible, ni par orientation.
    for (const item of model.adductions) {
      assert.equal('children' in item, false);
      assert.equal('group' in item, false);
    }
    for (const item of model.materials) {
      assert.equal('adductions' in item, false, 'un matériau ne porte pas ses adductions');
      assert.equal('adduction_count' in item, false, 'ni un compteur');
    }

    // Trois adductions identiques hormis leur orientation restent trois
    // éléments : aucune consolidation.
    assert.deepEqual(model.adductions.map((a) => a.entry.orientation), ['SUPPORTS', 'OBJECTS_TO', 'NONE']);
    assert.equal(new Set(model.adductions.map((a) => a.entry.material_id)).size, 1);
  } finally {
    await h.dispose();
  }
});

test('5 · deux charges identiques restent deux éléments', async () => {
  const h = await nativeFixture();
  try {
    await appendEvidenceEntries(h.paths, [material(1), material(2), adduction(1), adduction(2)]);
    const model = available(await project(h));

    assert.equal(model.materials.length, 2);
    assert.equal(model.adductions.length, 2);
    assert.deepEqual(
      model.materials.map((m) => JSON.stringify(m.entry.representation)),
      Array(2).fill(JSON.stringify({ form: 'INLINE_TEXT', text: EVENT_TEXT })),
    );
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// C. Vérifiabilité
// ==========================================================================

test('6 · T9/T10/T11/T12/T13 — trois formes, trois constats, et aucun accès extérieur', async () => {
  const h = await nativeFixture();
  try {
    await appendEvidenceEntries(h.paths, [
      material(1),                                                                  // INLINE_TEXT
      material(2, { representation: { form: 'RUN_EVENT', event_id: 'evt_000001' } }),  // résolu
      material(3, { representation: { form: 'RUN_EVENT', event_id: 'evt_999999' } }),  // absent
      material(4, {
        representation: {
          form: 'EXTERNAL_REFERENCE',
          locator: 'https://example.test/doc',
          declared_digest: `sha256:${'a'.repeat(64)}`,
        },
        observed_by_ccr: false,
      }),
    ]);

    const model = available(await project(h));
    const verif = model.materials.map((m) => m.verifiability);

    // T9 — le contenu inline est dans l'enregistrement : rien à retrouver.
    assert.deepEqual(verif[0], { kind: 'HELD_AND_RESOLVABLE' });
    // T10 — l'événement se relit depuis LE MÊME snapshot.
    assert.deepEqual(verif[1], { kind: 'HELD_AND_RESOLVABLE' });
    // T11 — l'événement a disparu : détenu, mais non résoluble. Pas faux.
    assert.deepEqual(verif[2], { kind: 'HELD_BUT_UNRESOLVABLE', reason: 'EVENT_NOT_FOUND' });
    // T12 — rien n'a jamais été observé. Aucun motif de non-résolution : il n'y
    // a pas eu d'échec de lecture, il n'y a pas eu de lecture.
    assert.deepEqual(verif[3], { kind: 'NOT_OBSERVED_BY_CCR' });
    assert.equal('reason' in (verif[3] ?? {}), false);

    // T13 — l'empreinte déclarée traverse la projection sans être promue.
    const externe = model.materials[3]?.entry.representation;
    assert.equal(externe?.form, 'EXTERNAL_REFERENCE');
    assert.equal(
      externe?.form === 'EXTERNAL_REFERENCE' ? externe.declared_digest : undefined,
      `sha256:${'a'.repeat(64)}`,
    );
    const serialise = JSON.stringify(model);
    for (const interdit of ['verified', 'integrity', 'hash_match', 'trusted']) {
      assert.equal(serialise.includes(interdit), false, interdit);
    }
  } finally {
    await h.dispose();
  }
});

test('7 · un événement sans contenu textuel est détenu mais non résoluble', async () => {
  const h = await nativeFixture();
  try {
    // Un événement générationnellement neutre, sans champ `content`.
    const evenements = await readFile(h.paths.events, 'utf8');
    await writeFile(h.paths.events, `${evenements}${JSON.stringify({
      event_id: 'evt_000002', run_id: RUN_ID, round: 1, timestamp: '2026-08-18T09:20:00.000Z',
      actor: 'system', type: 'run_paused',
    })}\n`, 'utf8');

    await appendEvidenceEntries(h.paths, [
      material(1, { representation: { form: 'RUN_EVENT', event_id: 'evt_000002' } }),
    ]);

    const model = available(await project(h));
    assert.deepEqual(model.materials[0]?.verifiability, {
      kind: 'HELD_BUT_UNRESOLVABLE',
      reason: 'CONTENT_UNAVAILABLE',
    });
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// D. Citation
// ==========================================================================

test('8 · T14/T15/T16 — une citation se confronte, et son échec ne détruit rien', async () => {
  const h = await nativeFixture();
  try {
    await appendEvidenceEntries(h.paths, [
      material(1),                                                                     // INLINE_TEXT
      material(2, { representation: { form: 'EXTERNAL_REFERENCE', locator: 'x://y' }, observed_by_ccr: false }),
      material(3, { representation: { form: 'RUN_EVENT', event_id: 'evt_999999' } }),
      // rang 1 : présent · rang 2 : présent (le texte apparaît deux fois)
      adduction(1, { citation: { quoted_text: 'le cache doit expirer', occurrence: 1 } }),
      adduction(2, { citation: { quoted_text: 'le cache doit expirer', occurrence: 2 } }),
      adduction(3, { citation: { quoted_text: 'le cache doit expirer', occurrence: 3 } }),
      adduction(4, { citation: { quoted_text: 'introuvable', occurrence: 1 } }),
      adduction(5, { material_id: 'mat_000002', citation: { quoted_text: 'x', occurrence: 1 } }),
      adduction(6, { material_id: 'mat_000003', citation: { quoted_text: 'x', occurrence: 1 } }),
      adduction(7),                                                                    // sans citation
    ]);

    const model = available(await project(h));
    const r = model.adductions.map((a) => a.citation_resolution);

    assert.deepEqual(r[0], { kind: 'RESOLVABLE' }, 'rang 1');
    assert.deepEqual(r[1], { kind: 'RESOLVABLE' }, 'rang 2 — occurrences comptées');
    assert.deepEqual(r[2], { kind: 'UNRESOLVABLE', reason: 'OCCURRENCE_NOT_FOUND' }, 'rang 3 absent');
    assert.deepEqual(r[3], { kind: 'UNRESOLVABLE', reason: 'OCCURRENCE_NOT_FOUND' }, 'texte absent');
    assert.deepEqual(r[4], { kind: 'UNRESOLVABLE', reason: 'MATERIAL_NOT_HELD' }, 'référence externe');
    assert.deepEqual(r[5], { kind: 'UNRESOLVABLE', reason: 'CONTENT_UNAVAILABLE' }, 'événement disparu');

    // Aucune citation portée : null dit « rien à résoudre », jamais « échec ».
    assert.equal(r[6], null);

    // T16 — toutes les adductions restent visibles, y compris celles dont la
    // citation ne se résout plus. L'histoire n'est pas réécrite.
    assert.equal(model.recorded_adduction_count, 7);
    assert.deepEqual(
      model.adductions.map((a) => a.entry.entry_id),
      ['add_000001', 'add_000002', 'add_000003', 'add_000004', 'add_000005', 'add_000006', 'add_000007'],
    );

    // Et le journal n'a pas bougé d'un octet.
    assert.equal((await readFile(h.paths.evidence, 'utf8')).split('\n').filter(Boolean).length, 10);
  } finally {
    await h.dispose();
  }
});

test('9 · T22bis — un material_id qui ne résout pas ne supprime pas l’adduction', async () => {
  const h = await nativeFixture();
  try {
    // Situation qu'aucun chemin d'écriture CCR ne produit — S4 et S7-B exigent
    // tous deux que le matériau résolve. La projection ne suppose pourtant pas
    // ses entrées : elle rend le fait, avec le seul motif que le contrat admet.
    await appendEvidenceEntries(h.paths, [
      adduction(1, { material_id: 'mat_000999', citation: { quoted_text: 'x', occurrence: 1 } }),
    ]);

    const model = available(await project(h));
    assert.equal(model.recorded_adduction_count, 1, 'aucune suppression silencieuse');
    assert.equal(model.adductions[0]?.entry.material_id, 'mat_000999', 'aucune correction d’identifiant');
    assert.deepEqual(model.adductions[0]?.citation_resolution, {
      kind: 'UNRESOLVABLE',
      reason: 'MATERIAL_NOT_HELD',
    });
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// E. Ce que la projection n'affirme jamais
// ==========================================================================

test('10 · T17/T18/T19/T26 — aucune orientation dérivée, aucune cible agrégée', async () => {
  const h = await nativeFixture();
  try {
    await appendEvidenceEntries(h.paths, [
      material(1),
      adduction(1, { orientation: 'SUPPORTS' }),
      adduction(2, { orientation: 'OBJECTS_TO' }),
      adduction(3, { orientation: 'NONE' }),
    ]);

    const model = available(await project(h));

    // Les orientations sont rendues telles que déclarées, et rien n'en est tiré.
    assert.deepEqual(model.adductions.map((a) => a.entry.orientation), ['SUPPORTS', 'OBJECTS_TO', 'NONE']);
    for (const item of model.adductions) {
      for (const derive of [
        'true', 'false', 'is_true', 'is_false', 'verdict', 'resolved', 'winner',
        'preferred', 'current_orientation', 'effective_orientation', 'irrelevant',
      ]) {
        assert.equal(derive in item, false, `adduction porte ${derive}`);
      }
    }

    // Deux orientations opposées sur la même cible coexistent sans arbitrage.
    const surCible = model.adductions.filter((a) => a.entry.target.entry_id === 'ctve_000007');
    assert.equal(surCible.length, 3);

    // T26 — la cible reste une ENTRÉE. Aucun agrégat de controverse n'apparaît.
    for (const item of model.adductions) {
      assert.equal(item.entry.target.kind, 'CONTROVERSY_ENTRY');
      assert.match(item.entry.target.entry_id, /^ctve_/);
    }
    assert.equal(JSON.stringify(model).includes('"ctv_'), false, 'aucun identifiant de controverse');
  } finally {
    await h.dispose();
  }
});

test('11 · garde de source — la projection ne relit rien et ne conclut rien', async () => {
  const source = codeOnly(await readFile(new URL('services/evidence-read-model.ts', SRC), 'utf8'));

  // Un seul snapshot : aucune seconde lecture, aucun accès disque ou réseau.
  for (const interdit of [
    'readEvidenceJournal', 'readStableNativeRunSnapshot', 'readFile', 'writeFile',
    "from 'node:fs", "from 'node:http", 'fetch(', 'openInvocationLedger', 'invocations',
    'appendEvidenceEntries', 'runPaths', 'adapter', 'Adapter', 'provider',
  ]) {
    assert.equal(source.includes(interdit), false, `projection : ${interdit}`);
  }

  // Aucun vocabulaire de mérite, aucune classe de preuve.
  for (const interdit of [
    'confidence', 'reliability', 'credibility', 'weight', 'strength', 'sufficiency',
    'trust', 'quality', 'winner', 'unreliable', 'suspect',
    'REAL_NOW', 'FIXTURE', 'MONITORED', 'NOT_TESTED',
  ]) {
    assert.equal(source.includes(interdit), false, `mérite : ${interdit}`);
  }

  // La disponibilité du modèle assisté n'est pas touchée par S3.
  for (const interdit of ['MODEL_ADDUCTION', 'RUNTIME_AVAILABILITY', 'MODEL_ASSISTED']) {
    assert.equal(source.includes(interdit), false, `S7-C : ${interdit}`);
  }
});

// ==========================================================================
// F. Erreur, vue HTTP
// ==========================================================================

test('12 · T20 — une corruption est une erreur, jamais un modèle vide', async () => {
  const h = await nativeFixture();
  try {
    await appendEvidenceEntries(h.paths, [material(1)]);

    // Ligne terminée illisible : le snapshot lève, et la projection n'est jamais
    // atteinte. Aucun repli sur AVAILABLE + zéro.
    const bon = await readFile(h.paths.evidence, 'utf8');
    await writeFile(h.paths.evidence, `${bon}{ pas du json\n`, 'utf8');
    await assert.rejects(() => project(h), (error: unknown) => isCcrError(error));

    // Version non supportée : même refus.
    await writeFile(h.paths.evidence, `${JSON.stringify(material(1, { schema_version: 2 }))}\n`, 'utf8');
    await assert.rejects(() => project(h), (error: unknown) => isCcrError(error));

    // Restauré, la projection redevient lisible : rien n'a été réparé en silence.
    await writeFile(h.paths.evidence, bon, 'utf8');
    assert.equal(available(await project(h)).recorded_material_count, 1);
  } finally {
    await h.dispose();
  }
});

test('13 · T21/T22/T23/T25 — la vue HTTP est additive et porte la fraîcheur du snapshot', async () => {
  const h = await nativeFixture();
  try {
    await appendEvidenceEntries(h.paths, [material(1), adduction(1, { orientation: 'SUPPORTS' })]);

    const vue = await readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);

    // T22 — champ voisin, additif. Les champs historiques sont intacts.
    assert.equal(vue.generation, 'NATIVE_V21_EXECUTION');
    assert.match(vue.revision, /^sha256:[0-9a-f]{64}$/);
    assert.ok(vue.run !== undefined && vue.presentation !== undefined);
    assert.equal(vue.controversies.availability, 'AVAILABLE');

    const evidence = available(vue.evidence);
    assert.equal(evidence.read_model_version, EVIDENCE_READ_MODEL_VERSION);
    assert.equal(evidence.recorded_material_count, 1);
    assert.equal(evidence.recorded_adduction_count, 1);

    // T21 — la fraîcheur V4 vient du snapshot, jamais d'un recalcul local, et
    // reste distincte de la révision de run.
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.equal(evidence.evidence_revision, snapshot.evidence_revision);
    assert.match(evidence.evidence_revision, /^ev-sha256:[0-9a-f]{64}$/);
    assert.notEqual(evidence.evidence_revision, vue.revision);

    // T25 — la projection V3 est inchangée par la présence de V4.
    assert.equal(vue.controversies.availability, 'AVAILABLE');
    if (vue.controversies.availability === 'AVAILABLE') {
      assert.equal(vue.controversies.recorded_count, 0);
    }

    // T23 — la couche HTTP ne relit rien : une seule couture de snapshot.
    const http = codeOnly(await readFile(new URL('cockpit/native-read-http.ts', SRC), 'utf8'));
    assert.equal(http.includes('readEvidenceJournal'), false);
    assert.equal((http.match(/readStableNativeRunSnapshot\(/g) ?? []).length >= 1, true);
    assert.equal((http.match(/projectEvidenceReadModel\(/g) ?? []).length, 1);
  } finally {
    await h.dispose();
  }
});

test('14 · T24 — la disponibilité des données n’active aucune adduction assistée', async () => {
  const h = await nativeFixture();
  try {
    await appendEvidenceEntries(h.paths, [material(1)]);
    const model = available(await project(h));
    assert.equal(model.availability, 'AVAILABLE', 'les données sont lisibles');

    // S7-C n'existe pas encore : aucune constante de disponibilité du modèle
    // n'est créée, levée ni référencée par S3. La frontière est vérifiée par
    // l'absence, à la source — la garde du test 11 la couvre déjà — et par le
    // fait qu'aucun module V4 n'expose une telle constante à ce stade.
    const modules = ['services/evidence-read-model.ts', 'core/evidence.ts', 'store/evidence-store.ts'];
    for (const relative of modules) {
      const source = await readFile(new URL(relative, SRC), 'utf8');
      assert.equal(source.includes('MODEL_ADDUCTION_RUNTIME_AVAILABILITY'), false, relative);
    }
  } finally {
    await h.dispose();
  }
});
