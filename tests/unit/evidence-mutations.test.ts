/**
 * V4 · S4 — les deux mutations humaines, à zéro fournisseur.
 *
 * Question de preuve :
 *
 * > **Le service est-il l'autorité unique de l'écriture V4, sans qu'aucun
 * > appelant puisse forger une autorité, ni obtenir une adduction qu'il n'a pas
 * > demandée ?**
 *
 * Quatre propriétés.
 *
 *  1. **Enregistrer n'est pas adduire.** Un matériau enregistré laisse le
 *     compte d'adductions à zéro, sans exception.
 *  2. **Rien d'autoritaire n'est reçu.** Identités, horodatage, scribe, origine
 *     sémantique et dérivation viennent du serveur, jamais de l'appelant.
 *  3. **La fraîcheur V4 gouverne.** Une vue périmée invalide la demande
 *     entière, avant toute validation métier et avant tout octet écrit.
 *  4. **Les actes sont historiques.** Deux gestes identiques donnent deux faits.
 *     Aucune déduplication, aucune idempotence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { readEvidenceJournal } from '../../src/store/evidence-store.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { projectEvidenceReadModel } from '../../src/services/evidence-read-model.ts';
import {
  EVIDENCE_HUMAN_PROVIDER_EFFECT,
  adduceMaterial,
  registerMaterial,
} from '../../src/services/evidence-service.ts';
import type { EvidenceServiceDeps } from '../../src/services/evidence-service.ts';
import { appendControversyEntry } from '../../src/store/controversy-store.ts';
import { CONTROVERSY_SCHEMA_VERSION } from '../../src/core/controversy.ts';
import type { AdductionRecordedEntry, MaterialRecordedEntry } from '../../src/core/evidence.ts';
import { isCcrError } from '../../src/core/errors.ts';

const RUN_ID = 'CCR-20260818-601';
const SRC = new URL('../../src/', import.meta.url);
const EVENT_TEXT = 'le cache doit expirer apres 60 secondes, et le cache doit expirer';

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: EvidenceServiceDeps;
  revision(): Promise<string>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s4-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's4', created_at: '2026-08-18T09:00:00.000Z',
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

  // Une cible V3 réelle : `ctve_000001`, écrite par la primitive V3 elle-même.
  await appendControversyEntry(paths, {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: 'ctve_000001',
    controversy_id: 'ctv_000001',
    kind: 'CONTROVERSY_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-18T09:30:00.000Z',
    round: 1,
    anchors: {
      provenance: [{ event_id: 'evt_000001', round: 1, expert_slot_id: 'author', session_id: 'S1' }],
      semantic: { text: 'Duree de vie du cache', semantic_origin: { kind: 'HUMAN' } },
    },
  });

  const deps: EvidenceServiceDeps = { runsDir, now: () => new Date('2026-08-18T10:00:00.000Z') };
  return {
    runsDir,
    paths,
    deps,
    revision: async () => (await readStableNativeRunSnapshot(runsDir, RUN_ID)).evidence_revision,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

async function refuses(fn: () => Promise<unknown>, reason: string, what: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(isCcrError(error), `${what} : attendu une CcrError, reçu ${String(error)}`);
    const actual = (error.details as { reason?: string } | undefined)?.reason ?? error.code;
    assert.equal(actual, reason, what);
    return;
  }
  assert.fail(`${what} : aucun refus`);
}

async function inline(h: Fixture, text = EVENT_TEXT): Promise<string> {
  const result = await registerMaterial(h.deps, {
    runId: RUN_ID,
    expected_evidence_revision: await h.revision(),
    representation: { form: 'INLINE_TEXT', text },
  });
  return result.entry.entry_id;
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ==========================================================================
// A. Enregistrement d'un matériau
// ==========================================================================

test('1 · T1/T4/T5 — l’identité, le scribe et l’horodatage viennent du serveur', async () => {
  const h = await fixture();
  try {
    const before = await h.revision();
    const result = await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: before,
      representation: { form: 'INLINE_TEXT', text: 'un texte' },
      label: 'note humaine',
    });

    const entry = result.entry as MaterialRecordedEntry;
    assert.equal(entry.entry_id, 'mat_000001', 'identité allouée par le serveur');
    assert.equal(entry.kind, 'MATERIAL_RECORDED');
    assert.equal(entry.schema_version, 1);
    assert.equal(entry.recorded_by, 'CCR');
    assert.equal(entry.recorded_at, '2026-08-18T10:00:00.000Z');
    assert.equal(entry.submitted_by, 'HUMAN');
    assert.equal(entry.observed_by_ccr, true);
    assert.equal(entry.label, 'note humaine');
    assert.equal(result.provider_effect, EVIDENCE_HUMAN_PROVIDER_EFFECT);
    assert.notEqual(result.evidence_revision, before, 'la fraîcheur a changé');

    // T4/T5 — l'appelant ne peut rien forger : la signature ne porte aucun de
    // ces champs, et une charge qui les glisserait est simplement ignorée par
    // la construction serveur.
    const forge = await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: result.evidence_revision,
      representation: { form: 'INLINE_TEXT', text: 'autre' },
      entry_id: 'mat_999999',
      recorded_by: 'HUMAN',
      recorded_at: '1999-01-01T00:00:00.000Z',
      schema_version: 7,
      observed_by_ccr: false,
      submitted_by: 'SOURCE',
    } as never);
    const second = forge.entry as MaterialRecordedEntry;
    assert.equal(second.entry_id, 'mat_000002', 'séquence serveur, jamais celle de l’appelant');
    assert.equal(second.recorded_by, 'CCR');
    assert.equal(second.recorded_at, '2026-08-18T10:00:00.000Z');
    assert.equal(second.schema_version, 1);
    assert.equal(second.observed_by_ccr, true);
    assert.equal(second.submitted_by, 'HUMAN');
  } finally {
    await h.dispose();
  }
});

test('2 · T6 — enregistrer un matériau ne produit JAMAIS d’adduction', async () => {
  const h = await fixture();
  try {
    for (const representation of [
      { form: 'INLINE_TEXT', text: 'a' } as const,
      { form: 'RUN_EVENT', event_id: 'evt_000001' } as const,
      { form: 'EXTERNAL_REFERENCE', locator: 'https://example.test/a' } as const,
    ]) {
      await registerMaterial(h.deps, {
        runId: RUN_ID,
        expected_evidence_revision: await h.revision(),
        representation,
      });
    }

    const model = projectEvidenceReadModel(await readStableNativeRunSnapshot(h.runsDir, RUN_ID));
    assert.equal(model.availability, 'AVAILABLE');
    if (model.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.equal(model.recorded_material_count, 3);
    assert.equal(model.recorded_adduction_count, 0, 'aucune adduction synthétisée');

    // Aucune ligne d'adduction dans le journal, sous aucune forme.
    const brut = await readFile(h.paths.evidence, 'utf8');
    assert.equal(brut.includes('ADDUCTION_RECORDED'), false);
    assert.equal(brut.includes('"orientation"'), false);
    assert.equal(brut.includes('"target"'), false);
  } finally {
    await h.dispose();
  }
});

test('3 · T2 — un RUN_EVENT doit résoudre dans le run, sans seconde lecture', async () => {
  const h = await fixture();
  try {
    const ok = await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      representation: { form: 'RUN_EVENT', event_id: 'evt_000001' },
    });
    assert.equal((ok.entry as MaterialRecordedEntry).observed_by_ccr, true);

    await refuses(
      () =>
        registerMaterial(h.deps, {
          runId: RUN_ID,
          expected_evidence_revision: ok.evidence_revision,
          representation: { form: 'RUN_EVENT', event_id: 'evt_999999' },
        }),
      'RUN_EVENT_NOT_FOUND',
      'événement inconnu',
    );

    // Le refus n'a rien écrit.
    assert.equal((await readEvidenceJournal(h.paths)).entries.length, 1);
  } finally {
    await h.dispose();
  }
});

test('4 · T3 — une référence externe n’est ni résolue, ni contactée, ni promue', async () => {
  const h = await fixture();
  try {
    const digest = `sha256:${'b'.repeat(64)}`;
    const result = await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      representation: {
        form: 'EXTERNAL_REFERENCE',
        locator: 'https://example.test/rapport.pdf',
        declared_digest: digest,
      },
    });

    const entry = result.entry as MaterialRecordedEntry;
    assert.equal(entry.observed_by_ccr, false, 'rien n’a été observé');
    assert.equal(entry.representation.form, 'EXTERNAL_REFERENCE');
    assert.equal(
      entry.representation.form === 'EXTERNAL_REFERENCE' ? entry.representation.declared_digest : undefined,
      digest,
      'l’empreinte déclarée est conservée telle quelle',
    );

    // Aucune promotion : aucun champ de vérification n'apparaît.
    const serialise = JSON.stringify(entry);
    for (const interdit of ['verified', 'integrity', 'hash_match', 'computed', 'trusted']) {
      assert.equal(serialise.includes(interdit), false, interdit);
    }

    // Aucun accès au monde extérieur : garde de source sur le service.
    const source = codeOnly(await readFile(new URL('services/evidence-service.ts', SRC), 'utf8'));
    for (const interdit of ['fetch(', 'http.get', 'https.get', "from 'node:http", "from 'node:https",
                            'readFile(', 'writeFile(', 'createReadStream', 'locator)']) {
      assert.equal(source.includes(interdit), false, `service : ${interdit}`);
    }
  } finally {
    await h.dispose();
  }
});

test('5 · T7 — deux charges identiques donnent deux matériaux', async () => {
  const h = await fixture();
  try {
    const a = await inline(h, 'exactement le même texte');
    const b = await inline(h, 'exactement le même texte');
    const c = await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      representation: { form: 'EXTERNAL_REFERENCE', locator: 'https://example.test/x' },
    });
    const d = await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      representation: { form: 'EXTERNAL_REFERENCE', locator: 'https://example.test/x' },
    });

    assert.deepEqual([a, b], ['mat_000001', 'mat_000002']);
    assert.deepEqual([c.entry.entry_id, d.entry.entry_id], ['mat_000003', 'mat_000004']);
    assert.equal((await readEvidenceJournal(h.paths)).entries.length, 4, 'aucune déduplication');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// B. Fraîcheur et concurrence
// ==========================================================================

test('6 · T8/T9/T25 — une vue périmée invalide la demande, avant tout octet', async () => {
  const h = await fixture();
  try {
    const partagee = await h.revision();

    // Première mutation : elle aboutit et change la fraîcheur.
    const gagnante = await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: partagee,
      representation: { form: 'INLINE_TEXT', text: 'premier' },
    });
    assert.notEqual(gagnante.evidence_revision, partagee);

    // Seconde mutation partie de la MÊME révision : refusée sur fraîcheur, sans
    // réutiliser l'ancien identifiant suivant.
    const avant = await readFile(h.paths.evidence, 'utf8');
    await refuses(
      () =>
        registerMaterial(h.deps, {
          runId: RUN_ID,
          expected_evidence_revision: partagee,
          representation: { form: 'INLINE_TEXT', text: 'second' },
        }),
      'STALE_REVISION',
      'révision partagée',
    );
    assert.equal(await readFile(h.paths.evidence, 'utf8'), avant, 'journal intact');

    // La même demande, avec la fraîcheur courante, aboutit — et alloue mat_000002.
    const rejoue = await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: gagnante.evidence_revision,
      representation: { form: 'INLINE_TEXT', text: 'second' },
    });
    assert.equal(rejoue.entry.entry_id, 'mat_000002');

    // La fraîcheur du run et celle des controverses n'ont jamais été consultées
    // comme précondition : une révision de run ne périme pas une adduction.
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    await refuses(
      () =>
        registerMaterial(h.deps, {
          runId: RUN_ID,
          expected_evidence_revision: snapshot.revision,
          representation: { form: 'INLINE_TEXT', text: 'x' },
        }),
      'STALE_REVISION',
      'révision de run passée comme fraîcheur V4',
    );
    await refuses(
      () =>
        registerMaterial(h.deps, {
          runId: RUN_ID,
          expected_evidence_revision: snapshot.controversy_revision,
          representation: { form: 'INLINE_TEXT', text: 'x' },
        }),
      'STALE_REVISION',
      'révision V3 passée comme fraîcheur V4',
    );
  } finally {
    await h.dispose();
  }
});

test('7 · T26/T27 — une écriture V4 ne périme ni le run, ni les controverses', async () => {
  const h = await fixture();
  try {
    const avant = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    const materiau = await inline(h);
    await adduceMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      material_id: materiau,
      target_entry_id: 'ctve_000001',
      orientation: 'SUPPORTS',
    });
    const apres = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);

    assert.equal(apres.revision, avant.revision, 'révision de run inchangée');
    assert.equal(apres.controversy_revision, avant.controversy_revision, 'révision V3 inchangée');
    assert.notEqual(apres.evidence_revision, avant.evidence_revision);
    assert.equal(apres.controversies.length, avant.controversies.length, 'aucune donnée V3 touchée');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// C. Adduction humaine
// ==========================================================================

test('8 · T10/T11/T12/T13 — les trois orientations, sous une origine humaine', async () => {
  const h = await fixture();
  try {
    const materiau = await inline(h);

    for (const orientation of ['NONE', 'SUPPORTS', 'OBJECTS_TO'] as const) {
      const result = await adduceMaterial(h.deps, {
        runId: RUN_ID,
        expected_evidence_revision: await h.revision(),
        material_id: materiau,
        target_entry_id: 'ctve_000001',
        orientation,
      });
      const entry = result.entry as AdductionRecordedEntry;
      assert.equal(entry.orientation, orientation);
      assert.equal(entry.semantic_origin, 'HUMAN');
      assert.equal(entry.recorded_by, 'CCR', 'le scribe n’est pas l’auteur');
      assert.equal(entry.derivation, undefined, 'aucune dérivation');
      assert.deepEqual(entry.target, { kind: 'CONTROVERSY_ENTRY', entry_id: 'ctve_000001' });
      assert.equal(result.provider_effect, EVIDENCE_HUMAN_PROVIDER_EFFECT);
    }

    const journal = await readEvidenceJournal(h.paths);
    assert.deepEqual(journal.entries.map((e) => e.entry_id), [
      'mat_000001', 'add_000001', 'add_000002', 'add_000003',
    ]);
  } finally {
    await h.dispose();
  }
});

test('9 · T14/T15 — aucun appelant ne peut forger une origine CCR ni une dérivation', async () => {
  const h = await fixture();
  try {
    const materiau = await inline(h);

    const result = await adduceMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      material_id: materiau,
      target_entry_id: 'ctve_000001',
      orientation: 'SUPPORTS',
      semantic_origin: 'CCR',
      derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000001', inputs: ['x'] },
      recorded_by: 'HUMAN',
    } as never);

    const entry = result.entry as AdductionRecordedEntry;
    assert.equal(entry.semantic_origin, 'HUMAN', 'l’origine est imposée par le service');
    assert.equal(entry.derivation, undefined, 'la dérivation soumise est ignorée');
    assert.equal(entry.recorded_by, 'CCR');

    // Rien de tout cela n'est parvenu au journal.
    const brut = await readFile(h.paths.evidence, 'utf8');
    for (const interdit of ['MODEL_ASSISTED', 'invocation_id', '"CCR","derivation"', 'inv_000001']) {
      assert.equal(brut.includes(interdit), false, interdit);
    }

    // Et la garde de source : le service ne nomme aucune primitive d'assistance.
    const source = codeOnly(await readFile(new URL('services/evidence-service.ts', SRC), 'utf8'));
    for (const interdit of [
      'MODEL_ASSISTED', 'requestModelAdduction', 'invocation_id', 'openInvocationLedger',
      'assertInvocationQuota', 'EVIDENCE_ADDUCTION', 'createAdapters', 'adapter', 'Adapter',
      'prompt', 'parse' + 'AdductionProposals',
    ]) {
      assert.equal(source.includes(interdit), false, `service : ${interdit}`);
    }
  } finally {
    await h.dispose();
  }
});

test('10 · T16/T17/T18/T19 — matériau et cible doivent résoudre, et ctv_ n’est jamais une cible', async () => {
  const h = await fixture();
  try {
    const materiau = await inline(h);

    // T19 — cible valide.
    await adduceMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      material_id: materiau,
      target_entry_id: 'ctve_000001',
      orientation: 'NONE',
    });

    const base = async (): Promise<string> => h.revision();

    // T16 — matériau inconnu, et matériau non canonique.
    for (const id of ['mat_000999', 'mat_00001', 'add_000001', 'ctve_000001', '']) {
      await refuses(
        async () =>
          adduceMaterial(h.deps, {
            runId: RUN_ID,
            expected_evidence_revision: await base(),
            material_id: id,
            target_entry_id: 'ctve_000001',
            orientation: 'NONE',
          }),
        'MATERIAL_NOT_FOUND',
        `matériau ${id}`,
      );
    }

    // T17/T18 — cible inconnue, cible non canonique, et `ctv_`.
    for (const id of ['ctve_000999', 'ctv_000001', 'ctve_00001', 'mat_000001', '']) {
      await refuses(
        async () =>
          adduceMaterial(h.deps, {
            runId: RUN_ID,
            expected_evidence_revision: await base(),
            material_id: materiau,
            target_entry_id: id,
            orientation: 'NONE',
          }),
        'TARGET_NOT_FOUND',
        `cible ${id}`,
      );
    }

    // T24 — aucun de ces refus n'a écrit.
    assert.equal((await readEvidenceJournal(h.paths)).entries.length, 2);
  } finally {
    await h.dispose();
  }
});

test('11 · T20/T21/T22 — citation : confrontée quand elle peut l’être, refusée sinon', async () => {
  const h = await fixture();
  try {
    const inlineId = await inline(h);
    const externe = (await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      representation: { form: 'EXTERNAL_REFERENCE', locator: 'https://example.test/a' },
    })).entry.entry_id;
    const evenement = (await registerMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      representation: { form: 'RUN_EVENT', event_id: 'evt_000001' },
    })).entry.entry_id;

    // T20 — une référence externe est parfaitement adductible SANS citation :
    // non vérifiable ne signifie pas faux.
    const sansCitation = await adduceMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      material_id: externe,
      target_entry_id: 'ctve_000001',
      orientation: 'OBJECTS_TO',
    });
    assert.equal((sansCitation.entry as AdductionRecordedEntry).material_id, externe);

    // T21 — mais une citation y est structurellement impossible.
    await refuses(
      async () =>
        adduceMaterial(h.deps, {
          runId: RUN_ID,
          expected_evidence_revision: await h.revision(),
          material_id: externe,
          target_entry_id: 'ctve_000001',
          orientation: 'NONE',
          citation: { quoted_text: 'x', occurrence: 1 },
        }),
      'CITATION_MATERIAL_NOT_HELD',
      'citation sur référence externe',
    );

    // T22 — sur un matériau détenu, les deux membres sont exigés : texte présent
    // ET rang exact. Les occurrences chevauchantes sont comptées.
    for (const [materialId, quote, occurrence] of [
      [inlineId, 'le cache doit expirer', 1],
      [inlineId, 'le cache doit expirer', 2],
      [evenement, 'le cache doit expirer', 2],
    ] as const) {
      const ok = await adduceMaterial(h.deps, {
        runId: RUN_ID,
        expected_evidence_revision: await h.revision(),
        material_id: materialId,
        target_entry_id: 'ctve_000001',
        orientation: 'SUPPORTS',
        citation: { quoted_text: quote, occurrence },
      });
      assert.deepEqual((ok.entry as AdductionRecordedEntry).citation, {
        quoted_text: quote,
        occurrence,
      });
    }

    for (const [quote, occurrence] of [['le cache doit expirer', 3], ['introuvable', 1]] as const) {
      await refuses(
        async () =>
          adduceMaterial(h.deps, {
            runId: RUN_ID,
            expected_evidence_revision: await h.revision(),
            material_id: inlineId,
            target_entry_id: 'ctve_000001',
            orientation: 'NONE',
            citation: { quoted_text: quote, occurrence },
          }),
        'CITATION_OCCURRENCE_NOT_FOUND',
        `citation « ${quote} » rang ${String(occurrence)}`,
      );
    }
  } finally {
    await h.dispose();
  }
});

test('12 · T23 — deux gestes humains identiques donnent deux actes historiques', async () => {
  const h = await fixture();
  try {
    const materiau = await inline(h);

    const identiques = [];
    for (let i = 0; i < 3; i += 1) {
      identiques.push(
        await adduceMaterial(h.deps, {
          runId: RUN_ID,
          expected_evidence_revision: await h.revision(),
          material_id: materiau,
          target_entry_id: 'ctve_000001',
          orientation: 'SUPPORTS',
          citation: { quoted_text: 'le cache doit expirer', occurrence: 1 },
        }),
      );
    }

    // Trois faits, trois identités. Effacer le second effacerait l'information
    // qu'une personne a agi deux fois, ou que deux personnes ont agi.
    assert.deepEqual(
      identiques.map((r) => r.entry.entry_id),
      ['add_000001', 'add_000002', 'add_000003'],
    );
    assert.equal(new Set(identiques.map((r) => r.evidence_revision)).size, 3);
    assert.equal((await readEvidenceJournal(h.paths)).entries.length, 4);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// D. Refus, effet fournisseur, générations
// ==========================================================================

test('13 · T24 — un refus ne laisse aucun effet, et ne crée jamais le journal', async () => {
  const h = await fixture();
  try {
    // Sur un journal encore absent, chaque refus laisse le fichier inexistant.
    for (const [input, reason, what] of [
      [{ representation: { form: 'RUN_EVENT', event_id: 'evt_x' } }, 'RUN_EVENT_NOT_FOUND', 'événement'],
      [{ representation: { form: 'INLINE_TEXT', text: '' } }, 'INVALID_ARGUMENT', 'texte vide'],
      [
        { representation: { form: 'INLINE_TEXT', text: 'a'.repeat(256 * 1024 + 1) } },
        'INVALID_ARGUMENT',
        'texte au-delà de la borne',
      ],
      [
        { representation: { form: 'EXTERNAL_REFERENCE', locator: 'x', declared_digest: 'nope' } },
        'INVALID_ARGUMENT',
        'empreinte non canonique',
      ],
    ] as const) {
      await refuses(
        async () =>
          registerMaterial(h.deps, {
            runId: RUN_ID,
            expected_evidence_revision: await h.revision(),
            ...(input as object),
          } as never),
        reason,
        what,
      );
      assert.equal(existsSync(h.paths.evidence), false, `${what} : journal non créé`);
    }

    // Une orientation absente ou inconnue est refusée par le domaine S1 : le
    // service n'applique aucun défaut.
    const materiau = await inline(h);
    for (const orientation of [undefined, null, 'MAYBE', ''] as const) {
      await refuses(
        async () =>
          adduceMaterial(h.deps, {
            runId: RUN_ID,
            expected_evidence_revision: await h.revision(),
            material_id: materiau,
            target_entry_id: 'ctve_000001',
            orientation: orientation as never,
          }),
        'INVALID_ARGUMENT',
        `orientation ${String(orientation)}`,
      );
    }
    assert.equal((await readEvidenceJournal(h.paths)).entries.length, 1);
  } finally {
    await h.dispose();
  }
});

test('14 · T28 — effet fournisseur EXACT(0), prouvé par le type et par la source', async () => {
  const source = codeOnly(await readFile(new URL('services/evidence-service.ts', SRC), 'utf8'));

  // La forme des dépendances ne porte aucune fabrique d'adaptateur : c'est la
  // preuve au niveau du type.
  assert.match(source, /interface EvidenceServiceDeps \{[^}]*runsDir[^}]*now\(\)[^}]*\}/s);
  assert.equal(source.includes('createAdapters'), false);

  for (const interdit of [
    'AgentAdapter', 'claude-adapter', 'codex-adapter', 'adapters/', '.start(', '.resume(',
    'invocation-ledger', 'invocation-policy', 'usage-governance', 'usage-ledger',
    'CCR_CLAUDE_BIN', 'CCR_CODEX_BIN', 'process.env', 'spawn(', 'child_process',
  ]) {
    assert.equal(source.includes(interdit), false, `service : ${interdit}`);
  }

  // Aucun vocabulaire de mérite, aucune classe de preuve, aucun cycle de vie.
  for (const interdit of [
    'confidence', 'reliability', 'credibility', 'weight', 'strength', 'sufficiency',
    'winner', 'resolved', 'REAL_NOW', 'FIXTURE', 'NOT_TESTED', 'status:', 'lifecycle',
  ]) {
    assert.equal(source.includes(interdit), false, `mérite : ${interdit}`);
  }
});

test('15 · un run historique refuse toute mutation V4, sans créer de journal', async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s4-legacy-'));
  const paths = runPaths(runsDir, RUN_ID);
  try {
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.manifest, JSON.stringify({
      schema_version: 1, run_id: RUN_ID, title: 'legacy', created_at: '2026-08-18T09:00:00.000Z',
      workspace: { cwd: runsDir },
      agents: {
        claude: { role: 'author', session_id: 'C1' },
        codex: { role: 'challenger', session_id: 'X1' },
      },
    }), 'utf8');
    await writeFile(paths.state, JSON.stringify({
      schema_version: 1, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
      updated_at: '2026-08-18T09:00:00.000Z',
    }), 'utf8');

    const deps: EvidenceServiceDeps = { runsDir, now: () => new Date() };
    await assert.rejects(
      () =>
        registerMaterial(deps, {
          runId: RUN_ID,
          expected_evidence_revision: 'ev-sha256:0',
          representation: { form: 'INLINE_TEXT', text: 'x' },
        }),
      (error: unknown) => isCcrError(error) && error.code === 'SCHEMA_VERSION_UNSUPPORTED',
    );
    assert.equal(existsSync(paths.evidence), false, 'aucun journal V4 créé');
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('16 · T29 — la projection S3 rend le fait nouveau, sans rien inventer', async () => {
  const h = await fixture();
  try {
    const materiau = await inline(h);
    await adduceMaterial(h.deps, {
      runId: RUN_ID,
      expected_evidence_revision: await h.revision(),
      material_id: materiau,
      target_entry_id: 'ctve_000001',
      orientation: 'OBJECTS_TO',
      citation: { quoted_text: 'le cache doit expirer', occurrence: 1 },
    });

    const model = projectEvidenceReadModel(await readStableNativeRunSnapshot(h.runsDir, RUN_ID));
    assert.equal(model.availability, 'AVAILABLE');
    if (model.availability !== 'AVAILABLE') throw new Error('inatteignable');

    assert.equal(model.recorded_material_count, 1);
    assert.equal(model.recorded_adduction_count, 1);
    assert.deepEqual(model.materials[0]?.verifiability, { kind: 'HELD_AND_RESOLVABLE' });
    assert.deepEqual(model.adductions[0]?.citation_resolution, { kind: 'RESOLVABLE' });
    assert.equal(model.adductions[0]?.entry.orientation, 'OBJECTS_TO');

    // L'orientation est rendue telle que déclarée : rien n'en est tiré.
    const serialise = JSON.stringify(model);
    for (const interdit of ['"true"', 'verdict', 'winner', 'preferred', 'is_false']) {
      assert.equal(serialise.includes(interdit), false, interdit);
    }
  } finally {
    await h.dispose();
  }
});
