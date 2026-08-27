/**
 * V4 · S1 — le domaine pur de l'Evidence Engine.
 *
 * Question de preuve :
 *
 * > **Le vocabulaire V4 rend-il structurellement impossible ce que le contrat
 * > interdit, plutôt que de compter sur la discipline des appelants ?**
 *
 * Quatre propriétés.
 *
 *  1. **Rétention et invocation sont deux choses.** Un matériau ne porte ni
 *     cible, ni orientation, ni compteur ; une adduction le référence.
 *  2. **Les unions sont fermées.** Une valeur inconnue est refusée, jamais
 *     tolérée « pour l'avenir ».
 *  3. **Aucune reconstruction.** L'orientation est un champ requis, le booléen
 *     de détention suit la forme, une empreinte déclarée le reste.
 *  4. **Rien n'est affirmé sur le fond.** Aucun score, aucune force, aucune
 *     classe de preuve, aucun cycle de vie.
 *
 * Ce fichier ne teste **que** ce qu'un domaine pur peut établir. L'existence
 * réelle d'un matériau, d'une cible ou d'une citation appartient au store et au
 * service — tranches ultérieures, et le contrat les nomme.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ADDUCTION_DERIVATION_METHODS,
  ADDUCTION_SEMANTIC_ORIGINS,
  EVIDENCE_ENTRY_KINDS,
  EVIDENCE_RECORDING_ACTORS,
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_TARGET_KINDS,
  MATERIAL_REPRESENTATION_FORMS,
  MATERIAL_SUBMISSION_ORIGINS,
  MAX_INLINE_TEXT_BYTES,
  MAX_LABEL_BYTES,
  MAX_LOCATOR_BYTES,
  ORIENTATIONS,
  assertCitationSupportedByMaterial,
  formatAdductionId,
  formatMaterialId,
  isAdductionId,
  isControversyEntryTargetId,
  isMaterialId,
  materialIsHeld,
  parseAdductionSequence,
  parseMaterialSequence,
  validateEvidenceEntry,
} from '../../src/core/evidence.ts';
import type {
  AdductionRecordedEntry,
  EvidenceEntry,
  MaterialRecordedEntry,
} from '../../src/core/evidence.ts';
import { isCcrError } from '../../src/core/errors.ts';

const MODULE = new URL('../../src/core/evidence.ts', import.meta.url);

function refuses(fn: () => unknown, what: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(isCcrError(error), `${what} : attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, 'INVALID_ARGUMENT', what);
    return;
  }
  assert.fail(`${what} : aucun refus`);
}

function material(over: Partial<MaterialRecordedEntry> = {}): MaterialRecordedEntry {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    entry_id: 'mat_000001',
    kind: 'MATERIAL_RECORDED',
    recorded_by: 'CCR',
    recorded_at: '2026-08-18T10:00:00.000Z',
    submitted_by: 'HUMAN',
    representation: { form: 'INLINE_TEXT', text: 'le cache doit expirer' },
    observed_by_ccr: true,
    ...over,
  } as MaterialRecordedEntry;
}

function adduction(over: Partial<AdductionRecordedEntry> = {}): AdductionRecordedEntry {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    entry_id: 'add_000001',
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

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ==========================================================================
// A. Les deux concepts
// ==========================================================================

test('1 · A — un matériau ne porte aucune trace des adductions qui le visent', () => {
  // La rétention n'est pas l'invocation : un matériau enregistré existe
  // parfaitement sans que personne ne l'ait versé au débat.
  const held = validateEvidenceEntry(material()) as MaterialRecordedEntry;
  assert.equal(held.kind, 'MATERIAL_RECORDED');

  for (const forbidden of ['target', 'orientation', 'material_id', 'citation', 'derivation']) {
    assert.equal(forbidden in held, false, `un matériau ne porte pas « ${forbidden} »`);
  }

  // Et la garde est active : un appelant ne peut pas les y glisser.
  for (const forbidden of [
    { target: { kind: 'CONTROVERSY_ENTRY', entry_id: 'ctve_000001' } },
    { orientation: 'SUPPORTS' },
    { material_id: 'mat_000002' },
  ]) {
    refuses(
      () => validateEvidenceEntry(material(forbidden as Partial<MaterialRecordedEntry>)),
      `matériau portant ${Object.keys(forbidden)[0] ?? '?'}`,
    );
  }

  // Aucun compteur, aucun statut nulle part dans l'enveloppe.
  const keys = Object.keys(held);
  for (const banned of ['status', 'active', 'closed', 'deleted', 'superseded', 'adduction_count']) {
    assert.equal(keys.includes(banned), false, banned);
  }
});

test('2 · A — le même matériau est adduit plusieurs fois, sans jamais être dupliqué', () => {
  // Trois adductions distinctes, un seul material_id : la cardinalité que le
  // contrat impose est portée par la forme, pas par une convention.
  const trois = [
    adduction({ entry_id: 'add_000001', orientation: 'SUPPORTS' }),
    adduction({ entry_id: 'add_000002', orientation: 'OBJECTS_TO' }),
    adduction({
      entry_id: 'add_000003',
      orientation: 'NONE',
      target: { kind: 'CONTROVERSY_ENTRY', entry_id: 'ctve_000009' },
    }),
  ];
  for (const entry of trois) validateEvidenceEntry(entry);

  assert.equal(new Set(trois.map((e) => e.material_id)).size, 1, 'un seul matériau');
  assert.equal(new Set(trois.map((e) => e.entry_id)).size, 3, 'trois actes distincts');

  // Deux orientations opposées sur la même cible coexistent : V4 enregistre, il
  // ne choisit pas.
  assert.notEqual(trois[0]?.orientation, trois[1]?.orientation);
  assert.equal(trois[0]?.target.entry_id, trois[1]?.target.entry_id);
});

// ==========================================================================
// B. Identités
// ==========================================================================

test('3 · B — mat_ et add_ sont canoniques, stricts et disjoints', () => {
  assert.equal(formatMaterialId(1), 'mat_000001');
  assert.equal(formatMaterialId(1234567), 'mat_1234567');
  assert.equal(formatAdductionId(1), 'add_000001');
  assert.equal(parseMaterialSequence('mat_000042'), 42);
  assert.equal(parseAdductionSequence('add_000042'), 42);

  for (const valid of ['mat_000001', 'mat_999999', 'mat_1000000']) {
    assert.equal(isMaterialId(valid), true, valid);
  }

  const rejected: readonly unknown[] = [
    'add_000001',              // espace de noms croisé
    'ctve_000001',             // identité V3
    'mat_00001',               // largeur insuffisante
    'mat_0000001',             // zéro de tête surnuméraire — non canonique
    'MAT_000001',              // casse
    'mat_000001 ',             // espace final
    ' mat_000001',             // espace initial
    'mat_000001x',             // suffixe
    'xmat_000001',             // préfixe
    'mat_00000a',              // non chiffres
    'mat_000000',              // séquence nulle
    'mat_-00001',              // négatif
    'mat_',
    'mat',
    '',
    undefined,
    null,
    42,
    { id: 'mat_000001' },
    // `\d{6,}` est non borné et parseInt absorbe : sans aller-retour, ceci
    // passerait pour canonique. C'est le défaut exact trouvé en S7-A V3.
    `mat_${'0'.repeat(200)}1`,
    `mat_${'9'.repeat(400)}`,
  ];
  for (const value of rejected) {
    assert.equal(isMaterialId(value), false, `refus attendu : ${String(value).slice(0, 40)}`);
  }
  assert.equal(isAdductionId('mat_000001'), false, 'les deux espaces sont disjoints');
  assert.equal(isAdductionId(`add_${'9'.repeat(400)}`), false);

  refuses(() => formatMaterialId(0), 'séquence nulle');
  refuses(() => formatMaterialId(-1), 'séquence négative');
  refuses(() => formatMaterialId(1.5), 'séquence non entière');
  refuses(() => formatAdductionId(0), 'séquence nulle');
});

test('4 · B/H — une cible est une ENTRÉE : ctve_ accepté, ctv_ refusé', () => {
  assert.equal(isControversyEntryTargetId('ctve_000001'), true);
  assert.equal(isControversyEntryTargetId('ctve_1234567'), true);

  // `ctv_` désigne une controverse. Viser l'entrée d'ouverture vise exactement
  // cette entrée, jamais l'agrégat : aucune équivalence n'existe.
  for (const value of ['ctv_000001', 'ctve_00001', 'ctve_0000001', 'mat_000001', 'CTVE_000001', '']) {
    assert.equal(isControversyEntryTargetId(value), false, value);
  }
  assert.equal(isControversyEntryTargetId(`ctve_${'0'.repeat(200)}1`), false);

  refuses(
    () => validateEvidenceEntry(adduction({ target: { kind: 'CONTROVERSY_ENTRY', entry_id: 'ctv_000001' } })),
    'cible ctv_',
  );
});

test('5 · l’entry_id suit le genre de l’entrée', () => {
  refuses(() => validateEvidenceEntry(material({ entry_id: 'add_000001' })), 'matériau avec add_');
  refuses(() => validateEvidenceEntry(adduction({ entry_id: 'mat_000001' })), 'adduction avec mat_');
  refuses(() => validateEvidenceEntry(material({ entry_id: 'ctve_000001' })), 'identité V3');
});

// ==========================================================================
// C. Représentations
// ==========================================================================

test('6 · C/D — trois formes exactement, et aucune quatrième', () => {
  assert.deepEqual([...MATERIAL_REPRESENTATION_FORMS], [
    'RUN_EVENT',
    'INLINE_TEXT',
    'EXTERNAL_REFERENCE',
  ]);

  validateEvidenceEntry(material({ representation: { form: 'RUN_EVENT', event_id: 'evt_000001' } }));
  validateEvidenceEntry(material({ representation: { form: 'INLINE_TEXT', text: 'x' } }));
  validateEvidenceEntry(
    material({
      representation: { form: 'EXTERNAL_REFERENCE', locator: 'https://example.test/doc' },
      observed_by_ccr: false,
    }),
  );

  // Aucune catégorie argumentative n'est admise comme forme.
  for (const invented of ['FILE', 'DOCUMENT', 'LOG', 'SCREENSHOT', 'TEST', 'ARTIFACT', 'URL']) {
    refuses(
      () =>
        validateEvidenceEntry(
          material({ representation: { form: invented, text: 'x' } as never }),
        ),
      `forme inventée ${invented}`,
    );
  }

  refuses(
    () => validateEvidenceEntry(material({ representation: { form: 'RUN_EVENT', event_id: '' } as never })),
    'event_id vide',
  );
  refuses(
    () => validateEvidenceEntry(material({ representation: { form: 'INLINE_TEXT', text: '' } as never })),
    'texte vide',
  );
});

test('7 · détention : le booléen suit la forme, il ne se déclare pas', () => {
  assert.equal(materialIsHeld('RUN_EVENT'), true);
  assert.equal(materialIsHeld('INLINE_TEXT'), true);
  assert.equal(materialIsHeld('EXTERNAL_REFERENCE'), false);

  // La combinaison contractuellement impossible est structurellement refusée :
  // une référence externe « observée » décrirait une observation qui n'a pas eu
  // lieu — et un contenu détenu « non observé » masquerait une confrontation.
  refuses(
    () =>
      validateEvidenceEntry(
        material({
          representation: { form: 'EXTERNAL_REFERENCE', locator: 'https://example.test/a' },
          observed_by_ccr: true,
        }),
      ),
    'référence externe prétendue observée',
  );
  refuses(
    () => validateEvidenceEntry(material({ observed_by_ccr: false })),
    'texte détenu prétendu non observé',
  );
  refuses(
    () => validateEvidenceEntry(material({ observed_by_ccr: 'true' as never })),
    'booléen non booléen',
  );
});

test('8 · P — une empreinte déclarée reste déclarée, et CCR n’en calcule aucune', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  validateEvidenceEntry(
    material({
      representation: { form: 'EXTERNAL_REFERENCE', locator: 'https://example.test/a', declared_digest: digest },
      observed_by_ccr: false,
    }),
  );

  for (const bad of ['deadbeef', 'sha256:xyz', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, '']) {
    refuses(
      () =>
        validateEvidenceEntry(
          material({
            representation: {
              form: 'EXTERNAL_REFERENCE',
              locator: 'https://example.test/a',
              declared_digest: bad,
            },
            observed_by_ccr: false,
          }),
        ),
      `empreinte non canonique ${bad}`,
    );
  }

  // Le champ est confiné à la référence externe : aucune autre forme ne peut le
  // porter, donc aucune ne peut faire croire à une intégrité confirmée.
  refuses(
    () =>
      validateEvidenceEntry(
        material({
          representation: { form: 'INLINE_TEXT', text: 'x', declared_digest: digest } as never,
        }),
      ),
    'empreinte sur INLINE_TEXT',
  );
  refuses(
    () =>
      validateEvidenceEntry(
        material({
          representation: { form: 'RUN_EVENT', event_id: 'evt_000001', declared_digest: digest } as never,
        }),
      ),
    'empreinte sur RUN_EVENT',
  );
});

// ==========================================================================
// D. Orientation
// ==========================================================================

test('9 · E/F — orientation obligatoire, trois valeurs, aucune reconstruction', () => {
  assert.deepEqual([...ORIENTATIONS], ['NONE', 'SUPPORTS', 'OBJECTS_TO']);

  for (const value of ORIENTATIONS) {
    const entry = validateEvidenceEntry(adduction({ orientation: value })) as AdductionRecordedEntry;
    assert.equal(entry.orientation, value);
  }

  // `NONE` est une VALEUR. Un champ absent permettrait de la reconstruire comme
  // une position cachée — exactement ce que le contrat interdit.
  const sans: Record<string, unknown> = { ...adduction() };
  delete sans['orientation'];
  // Double conversion ASSUMÉE : la valeur est délibérément invalide, et c'est
  // le validateur — la frontière testée — qui doit la refuser. Le type dit
  // « entrée bien formée » ; l'objet ne l'est pas, et prétendre le contraire par
  // une conversion simple masquerait justement ce que le test éprouve.
  refuses(() => validateEvidenceEntry(sans as unknown as EvidenceEntry), 'orientation absente');

  for (const bad of [null, undefined, '', 'none', 'SUPPORT', 'AGAINST', 'NEUTRAL', 0, false]) {
    refuses(
      () => validateEvidenceEntry(adduction({ orientation: bad as never })),
      `orientation ${String(bad)}`,
    );
  }
});

// ==========================================================================
// E. Origine sémantique et dérivation
// ==========================================================================

test('10 · I/J/K/L/M — les deux origines admises, et leur exclusion mutuelle', () => {
  assert.deepEqual([...ADDUCTION_SEMANTIC_ORIGINS], ['HUMAN', 'CCR']);
  assert.deepEqual([...ADDUCTION_DERIVATION_METHODS], ['MODEL_ASSISTED']);

  // I — HUMAN sans dérivation.
  validateEvidenceEntry(adduction({ semantic_origin: 'HUMAN' }));

  // J — HUMAN AVEC dérivation : refusé. Une adduction humaine ne peut pas
  // emprunter l'attribution d'une inférence.
  refuses(
    () =>
      validateEvidenceEntry(
        adduction({
          semantic_origin: 'HUMAN',
          derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000001', inputs: [] },
        }),
      ),
    'HUMAN + dérivation',
  );

  // K — CCR avec dérivation MODEL_ASSISTED.
  const inferee = validateEvidenceEntry(
    adduction({
      semantic_origin: 'CCR',
      derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000001', inputs: ['mat_000001', 'ctve_000007'] },
    }),
  ) as AdductionRecordedEntry;
  assert.equal(inferee.derivation?.method, 'MODEL_ASSISTED');

  // L — CCR sans dérivation : refusé.
  refuses(() => validateEvidenceEntry(adduction({ semantic_origin: 'CCR' })), 'CCR sans dérivation');

  // M — méthode inconnue, dont celle que l'autorité humaine n'admet PAS.
  for (const method of ['DETERMINISTIC_LOCAL', 'HUMAN', 'AUTOMATIC', '', null]) {
    refuses(
      () =>
        validateEvidenceEntry(
          adduction({
            semantic_origin: 'CCR',
            derivation: { method: method as never, invocation_id: 'inv_000001', inputs: [] },
          }),
        ),
      `méthode ${String(method)}`,
    );
  }

  // Aucune origine que `docs/specs/evidence.md` n'admet pas.
  for (const origin of ['SOURCE', 'EXPERT', 'PROVIDER', 'claude', 'codex', 'SYSTEM']) {
    refuses(
      () => validateEvidenceEntry(adduction({ semantic_origin: origin as never })),
      `origine ${origin}`,
    );
  }
});

test('11 · le scribe n’est jamais l’auteur : recorded_by est distinct de semantic_origin', () => {
  assert.deepEqual([...EVIDENCE_RECORDING_ACTORS], ['CCR']);

  // CCR tient le journal, y compris pour une adduction humaine. Les deux champs
  // coexistent sans se confondre.
  const humaine = validateEvidenceEntry(adduction({ semantic_origin: 'HUMAN' })) as AdductionRecordedEntry;
  assert.equal(humaine.recorded_by, 'CCR');
  assert.equal(humaine.semantic_origin, 'HUMAN');

  for (const actor of ['HUMAN', 'claude', 'codex', 'SOURCE', '']) {
    refuses(() => validateEvidenceEntry(adduction({ recorded_by: actor as never })), `scribe ${actor}`);
  }
});

// ==========================================================================
// F. Citation
// ==========================================================================

test('12 · N/O — la citation valide sa forme, et refuse ce qui n’a rien à confronter', () => {
  validateEvidenceEntry(adduction({ citation: { quoted_text: 'doit expirer', occurrence: 1 } }));
  validateEvidenceEntry(adduction({ citation: { quoted_text: 'aa', occurrence: 2 } }));

  for (const bad of [0, -1, 1.5, Number.NaN, '1', null]) {
    refuses(
      () => validateEvidenceEntry(adduction({ citation: { quoted_text: 'x', occurrence: bad as never } })),
      `occurrence ${String(bad)}`,
    );
  }
  refuses(
    () => validateEvidenceEntry(adduction({ citation: { quoted_text: '', occurrence: 1 } })),
    'citation vide',
  );

  // Aucun décalage n'existe : la citation se confronte à l'original.
  const entry = validateEvidenceEntry(
    adduction({ citation: { quoted_text: 'x', occurrence: 1 } }),
  ) as AdductionRecordedEntry;
  for (const banned of ['offset', 'start', 'end', 'line', 'column', 'span']) {
    assert.equal(banned in (entry.citation ?? {}), false, banned);
  }

  // O — impossible sur un matériau non détenu. Le refus est MÉCANIQUE : il n'y
  // a rien à confronter. Il porte sur la citation, jamais sur l'adduction.
  const avecCitation = adduction({ citation: { quoted_text: 'x', occurrence: 1 } });
  refuses(
    () => assertCitationSupportedByMaterial(avecCitation, 'EXTERNAL_REFERENCE'),
    'citation sur référence externe',
  );
  assertCitationSupportedByMaterial(avecCitation, 'INLINE_TEXT');
  assertCitationSupportedByMaterial(avecCitation, 'RUN_EVENT');

  // Et une adduction SANS citation vers un matériau non détenu reste admise :
  // non vérifiable ne signifie pas faux.
  assertCitationSupportedByMaterial(adduction(), 'EXTERNAL_REFERENCE');
});

// ==========================================================================
// G. Bornes et unions fermées
// ==========================================================================

test('13 · Q — les bornes contractuelles, mesurées en OCTETS', () => {
  assert.equal(MAX_INLINE_TEXT_BYTES, 256 * 1024);
  assert.equal(MAX_LOCATOR_BYTES, 4 * 1024);
  assert.equal(MAX_LABEL_BYTES, 4 * 1024);

  // Exactement à la borne : admis. Un octet de plus : refusé, jamais tronqué.
  validateEvidenceEntry(
    material({ representation: { form: 'INLINE_TEXT', text: 'a'.repeat(MAX_INLINE_TEXT_BYTES) } }),
  );
  refuses(
    () =>
      validateEvidenceEntry(
        material({ representation: { form: 'INLINE_TEXT', text: 'a'.repeat(MAX_INLINE_TEXT_BYTES + 1) } }),
      ),
    'texte au-delà de la borne',
  );

  // La métrique est l'octet UTF-8, pas le caractère : « é » en pèse deux.
  const moitie = MAX_LOCATOR_BYTES / 2;
  validateEvidenceEntry(
    material({
      representation: { form: 'EXTERNAL_REFERENCE', locator: 'é'.repeat(moitie) },
      observed_by_ccr: false,
    }),
  );
  refuses(
    () =>
      validateEvidenceEntry(
        material({
          representation: { form: 'EXTERNAL_REFERENCE', locator: 'é'.repeat(moitie + 1) },
          observed_by_ccr: false,
        }),
      ),
    'localisateur au-delà de la borne, en octets',
  );

  validateEvidenceEntry(material({ label: 'x'.repeat(MAX_LABEL_BYTES) }));
  refuses(() => validateEvidenceEntry(material({ label: 'x'.repeat(MAX_LABEL_BYTES + 1) })), 'label trop long');
  refuses(() => validateEvidenceEntry(material({ label: '' })), 'label vide');
});

test('14 · R — les unions fermées refusent l’inconnu, sans permissivité d’avenir', () => {
  assert.deepEqual([...EVIDENCE_ENTRY_KINDS], ['MATERIAL_RECORDED', 'ADDUCTION_RECORDED']);
  assert.deepEqual([...EVIDENCE_TARGET_KINDS], ['CONTROVERSY_ENTRY']);
  assert.deepEqual([...MATERIAL_SUBMISSION_ORIGINS], ['HUMAN']);

  refuses(() => validateEvidenceEntry(material({ kind: 'EVIDENCE_RECORDED' as never })), 'genre inconnu');
  refuses(() => validateEvidenceEntry(material({ submitted_by: 'SOURCE' as never })), 'soumission SOURCE');
  refuses(() => validateEvidenceEntry(material({ schema_version: 2 })), 'version inconnue');
  refuses(() => validateEvidenceEntry(material({ recorded_at: '' })), 'horodatage vide');

  // Aucune sorte de cible n'est créée par anticipation.
  for (const kind of ['CONTROVERSY', 'RUN', 'DECISION', 'EVENT', 'INVOCATION', 'RELATION_GENERIC', 'MATERIAL']) {
    refuses(
      () => validateEvidenceEntry(adduction({ target: { kind: kind as never, entry_id: 'ctve_000001' } })),
      `sorte de cible ${kind}`,
    );
  }
});

// ==========================================================================
// H. Garde de source
// ==========================================================================

test('15 · S — le domaine ne connaît ni score, ni classe de preuve, ni I/O', async () => {
  const raw = await readFile(MODULE, 'utf8');
  const source = codeOnly(raw);

  // Aucun concept de force ou de mérite.
  for (const banned of [
    'EvidenceStrength', 'EvidenceScore', 'confidence', 'reliability', 'credibility',
    'weight', 'strength', 'sufficiency', 'winner', 'closure', 'resolved', 'preferred',
    'lifecycle', 'STRONG', 'WEAK', 'TRUSTED', 'AUTHORITATIVE',
  ]) {
    assert.equal(source.includes(banned), false, `concept interdit : ${banned}`);
  }

  // Les sept classes de preuve qualifient NOS preuves sur CCR, jamais un
  // matériau argumentatif.
  for (const klass of [
    'REAL_NOW', 'HISTORICAL_REAL_FROZEN', 'AUTOMATED_REAL_PROCESS',
    'FIXTURE', 'STATIC', 'MONITORED', 'NOT_TESTED',
  ]) {
    assert.equal(source.includes(klass), false, `classe de preuve : ${klass}`);
  }

  // Aucun statut, aucune mutation d'état.
  for (const banned of ["'ACTIVE'", "'CLOSED'", "'DELETED'", "'SUPERSEDED'", 'status:']) {
    assert.equal(source.includes(banned), false, banned);
  }

  // Pureté : aucun effet, aucune horloge, aucun hasard, aucun fournisseur.
  for (const impure of [
    "from 'node:fs", "from 'node:path", "from 'node:http", "from 'node:child_process",
    "from 'node:crypto", 'Date.now(', 'new Date(', 'Math.random(', 'process.env',
    'adapter', 'Adapter', 'provider', 'invocationLedger', 'openInvocation',
    'runPaths', 'withNativeMutation', 'readFile', 'writeFile',
  ]) {
    assert.equal(source.includes(impure), false, `impureté : ${impure}`);
  }

  // L'acteur legacy `evidence` n'est pas réutilisé.
  assert.equal(source.includes("'evidence'"), false, 'acteur legacy');

  // Les seuls imports sont deux modules core purs.
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ['./controversy.ts', './errors.ts']);
});
