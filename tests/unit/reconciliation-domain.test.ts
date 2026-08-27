/**
 * Preuves de la tranche S1 — fondation de domaine V5.
 *
 * Classes de preuve : `STATIC` (unions fermées, espaces d'identité, absence
 * structurelle des champs interdits) et `FIXTURE` (formes valides et refus).
 *
 * Ce fichier ne prouve **rien** qui appartienne à une tranche ultérieure :
 * aucune existence, aucun périmètre validé contre un instantané, aucune
 * fraîcheur, aucune actualité, aucun fournisseur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DERIVATION_METHODS,
  EFFECT_FIELDS,
  MAX_CONTENT_BYTES,
  PROPOSAL_RELATIONS,
  PROVENANCE_KINDS,
  RECONCILIATION_ENTRY_KINDS,
  RECONCILIATION_SCHEMA_VERSION,
  RESPONSE_MODES,
  SCOPE_KINDS,
  SEMANTIC_ORIGINS,
  formatReconciliationId,
  isControversyEntryId,
  isControversyId,
  isLegacyDecisionId,
  isReconciliationId,
  mayCarryAuthoritativeEffect,
  parseReconciliationSequence,
  validateReconciliationEntry,
} from '../../src/core/reconciliation.ts';
import type { ReconciliationEntry } from '../../src/core/reconciliation.ts';
import { formatMaterialId } from '../../src/core/evidence.ts';
import { formatControversyEntryId, formatControversyId } from '../../src/core/controversy.ts';
import { formatDecisionId, formatEventId } from '../../src/core/ids.ts';

// --------------------------------------------------------------------------
// Fixtures — les trois formes valides, et rien de plus
// --------------------------------------------------------------------------

const CTV = formatControversyId(7);
const E1 = formatControversyEntryId(11);
const E2 = formatControversyEntryId(12);
const ACT = formatReconciliationId(1);
const PROPOSAL = formatReconciliationId(2);

function proposed(overrides: Record<string, unknown> = {}): ReconciliationEntry {
  return {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: PROPOSAL,
    kind: 'RECONCILIATION_PROPOSED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'CCR',
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T10:00:00.000Z',
    observed_revision: 'rcn-sha256:abc',
    scope_kind: 'SUBSET',
    scope: [E1],
    derivation: { method: 'DETERMINISTIC', inputs: [E1] },
    options: [{ option_id: 'o1', content: 'une lecture possible' }],
    ...overrides,
  } as unknown as ReconciliationEntry;
}

function recorded(overrides: Record<string, unknown> = {}): ReconciliationEntry {
  return {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: ACT,
    kind: 'RECONCILIATION_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T10:00:00.000Z',
    observed_revision: 'rcn-sha256:abc',
    scope_kind: 'SUBSET',
    scope: [E1, E2],
    content: 'ce que la personne a décidé',
    provenance: { kind: 'DECLARED', statement: 'décidé en revue' },
    ...overrides,
  } as unknown as ReconciliationEntry;
}

function response(overrides: Record<string, unknown> = {}): ReconciliationEntry {
  return {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: formatReconciliationId(3),
    kind: 'PROPOSAL_RESPONSE_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T10:00:00.000Z',
    observed_revision: 'rcn-sha256:abc',
    provenance: { kind: 'DECLARED', statement: 'lu et répondu' },
    responds_to: { proposal_id: PROPOSAL, mode: 'ACCEPT' },
    ...overrides,
  } as unknown as ReconciliationEntry;
}

function refuses(entry: unknown, hint: string): void {
  assert.throws(
    () => validateReconciliationEntry(entry as ReconciliationEntry),
    (error: unknown) => {
      assert.ok(error instanceof Error, `${hint} : une CcrError est attendue.`);
      return true;
    },
    hint,
  );
}

// --------------------------------------------------------------------------
// C01 · C02 · C03 · V01 — classes et identité
// --------------------------------------------------------------------------

test('C01 · les trois classes existent, distinctes et discriminées', () => {
  assert.deepEqual(RECONCILIATION_ENTRY_KINDS, [
    'RECONCILIATION_PROPOSED',
    'RECONCILIATION_RECORDED',
    'PROPOSAL_RESPONSE_RECORDED',
  ]);
  for (const entry of [proposed(), recorded(), response()]) {
    assert.equal(validateReconciliationEntry(entry), entry);
  }
});

test('C02 · V01 — identité rcn_ canonique, aller-retour exigé', () => {
  assert.equal(formatReconciliationId(1), 'rcn_000001');
  assert.equal(formatReconciliationId(1234567), 'rcn_1234567');
  assert.equal(parseReconciliationSequence('rcn_000042'), 42);

  assert.ok(isReconciliationId('rcn_000001'));
  // `parseInt` absorberait les zéros de tête : seul l'aller-retour fait foi.
  assert.equal(isReconciliationId('rcn_0000001'), false);
  assert.equal(isReconciliationId('rcn_1'), false);
  assert.equal(isReconciliationId('rcn_000000'), false);
  assert.equal(isReconciliationId('RCN_000001'), false);
  assert.equal(isReconciliationId(42), false);

  assert.throws(() => formatReconciliationId(0));
  assert.throws(() => formatReconciliationId(1.5));
});

test('C03 · l\'espace rcn_ est disjoint de V1–V4', () => {
  for (const foreign of [
    formatEventId(1),
    formatControversyId(1),
    formatControversyEntryId(1),
    formatMaterialId(1),
    formatDecisionId(1),
  ]) {
    assert.equal(isReconciliationId(foreign), false, `${foreign} ne doit pas passer pour une identité V5.`);
  }
  assert.equal(isControversyId(formatReconciliationId(1)), false);
  assert.equal(isControversyEntryId(formatReconciliationId(1)), false);
  // `ctv_` désigne une controverse, `ctve_` une entrée : jamais l'inverse.
  assert.equal(isControversyEntryId(formatControversyId(1)), false);
  assert.equal(isControversyId(formatControversyEntryId(1)), false);
});

test('V01 — un identifiant non canonique est refusé partout où il apparaît', () => {
  refuses(recorded({ entry_id: 'rcn_1' }), 'entry_id non canonique');
  refuses(recorded({ target: { kind: 'CONTROVERSY', controversy_id: 'ctv_1' } }), 'cible non canonique');
  refuses(recorded({ scope: ['ctve_1'] }), 'unité de périmètre non canonique');
  refuses(
    recorded({ supersedes: [{ superseded_act_id: 'rcn_1', supersession_scope: [E1] }] }),
    'acte supersédé non canonique',
  );
});

// --------------------------------------------------------------------------
// C10 · C11 · V08 · V09 · P19 — origine, dérivation, fournisseur
// --------------------------------------------------------------------------

test('C10 · V08 — l\'union d\'origine sémantique est fermée à deux valeurs', () => {
  assert.deepEqual(SEMANTIC_ORIGINS, ['HUMAN', 'CCR']);
  // `SOURCE` existe en V3 ; il n'est pas emprunté par V5.
  refuses(recorded({ semantic_origin: 'SOURCE' }), 'origine V3 empruntée');
  refuses(proposed({ semantic_origin: 'HUMAN' }), 'proposition prétendant une origine humaine');
  refuses(recorded({ semantic_origin: 'CCR' }), 'acte humain prétendant une origine CCR');
  refuses(response({ semantic_origin: 'CCR' }), 'réponse prétendant une origine CCR');
});

test('C11 · V09 — dérivation si et seulement si origine CCR', () => {
  assert.deepEqual(DERIVATION_METHODS, ['DETERMINISTIC', 'MODEL_ASSISTED']);
  validateReconciliationEntry(proposed({ derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_1', inputs: [E1] } }));
  refuses(proposed({ derivation: undefined }), 'proposition sans dérivation');
  refuses(proposed({ derivation: { method: 'DETERMINISTIC_LOCAL', inputs: [] } }), 'méthode V3 empruntée');
  refuses(recorded({ derivation: { method: 'DETERMINISTIC', inputs: [] } }), 'acte humain porteur d\'une dérivation');
});

test('P19 · V11 — le fournisseur n\'est jamais une origine, et n\'a aucun champ', () => {
  for (const forged of ['provider', 'model', 'expert_slot', 'invocation_id', 'usage', 'cost']) {
    refuses(proposed({ [forged]: 'claude' }), `${forged} forgé sur une proposition`);
    refuses(recorded({ [forged]: 'claude' }), `${forged} forgé sur un acte humain`);
  }
  // `MODEL_ASSISTED` reste une MÉTHODE de dérivation, jamais une origine.
  assert.equal((SEMANTIC_ORIGINS as readonly string[]).includes('MODEL_ASSISTED'), false);
  assert.ok((DERIVATION_METHODS as readonly string[]).includes('MODEL_ASSISTED'));
});

// --------------------------------------------------------------------------
// C12 · C30 · C53 · V10 · P35 · P45 · P49 — effets et absence d'effet
// --------------------------------------------------------------------------

test('V10 · P35 — les effets sont réservés à RECONCILIATION_RECORDED', () => {
  assert.deepEqual(EFFECT_FIELDS, ['closure', 'closure_withdrawal', 'supersedes']);
  assert.ok(mayCarryAuthoritativeEffect('RECONCILIATION_RECORDED'));
  assert.equal(mayCarryAuthoritativeEffect('RECONCILIATION_PROPOSED'), false);
  assert.equal(mayCarryAuthoritativeEffect('PROPOSAL_RESPONSE_RECORDED'), false);

  for (const field of EFFECT_FIELDS) {
    refuses(proposed({ [field]: { declared: true, statement: 's' } }), `${field} sur une proposition`);
    refuses(response({ [field]: { declared: true, statement: 's' } }), `${field} sur une réponse`);
  }
});

test('C12 · P30 — une proposition ne porte ni effet, ni provenance, ni contenu de décision', () => {
  refuses(proposed({ provenance: { kind: 'DECLARED', statement: 's' } }), 'provenance sur une proposition');
  refuses(proposed({ content: 'décision' }), 'contenu de décision sur une proposition');
  refuses(proposed({ responds_to: { proposal_id: ACT, relation: 'ADOPTS' } }), 'relation sur une proposition');
});

test('C30 · C53 · P45 · P49 — une réponse ne porte ni périmètre, ni contenu, ni effet', () => {
  validateReconciliationEntry(response({ responds_to: { proposal_id: PROPOSAL, mode: 'REJECT' } }));
  for (const absent of ['scope_kind', 'scope', 'content']) {
    refuses(response({ [absent]: absent === 'scope' ? [E1] : 'SUBSET' }), `${absent} sur une réponse`);
  }
  assert.deepEqual(RESPONSE_MODES, ['ACCEPT', 'REJECT']);
  refuses(response({ responds_to: { proposal_id: PROPOSAL, mode: 'ABSTAIN' } }), 'mode hors union');
});

// --------------------------------------------------------------------------
// C31 · C32 · C54 · V12 · P50 — contenu humain et références d'option
// --------------------------------------------------------------------------

test('C31 · V12 — tout acte humain porte un content humain non vide', () => {
  refuses(recorded({ content: '' }), 'contenu vide');
  refuses(recorded({ content: undefined }), 'contenu absent');
  refuses(recorded({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) }), 'contenu hors borne');
});

test('C32 — ADOPTS, MODIFIES, REPLACES : trois valeurs, trois sémantiques', () => {
  assert.deepEqual(PROPOSAL_RELATIONS, ['ADOPTS', 'MODIFIES', 'REPLACES']);
  for (const relation of PROPOSAL_RELATIONS) {
    const entry = recorded({ responds_to: { proposal_id: PROPOSAL, relation } });
    assert.equal(validateReconciliationEntry(entry), entry);
  }
  refuses(recorded({ responds_to: { proposal_id: PROPOSAL, relation: 'ACCEPTS' } }), 'relation hors union');
});

test('C54 · P50 — responded_option_id et adopted_option_id sont deux champs distincts', () => {
  // L'acte adopte ; la réponse ne fait que désigner.
  validateReconciliationEntry(recorded({ responds_to: { proposal_id: PROPOSAL, relation: 'ADOPTS', adopted_option_id: 'o1' } }));
  validateReconciliationEntry(response({ responds_to: { proposal_id: PROPOSAL, mode: 'ACCEPT', responded_option_id: 'o1' } }));

  // Aucun des deux ne peut se glisser dans la forme de l'autre.
  refuses(
    recorded({ responds_to: { proposal_id: PROPOSAL, relation: 'ADOPTS', responded_option_id: 'o1' } }),
    'référence de réponse sur un acte',
  );
  refuses(
    response({ responds_to: { proposal_id: PROPOSAL, mode: 'ACCEPT', adopted_option_id: 'o1' } }),
    'référence d\'adoption sur une réponse',
  );
  refuses(response({ responds_to: { proposal_id: PROPOSAL, mode: 'ACCEPT', relation: 'ADOPTS' } }), 'relation sur une réponse');
});

// --------------------------------------------------------------------------
// C13 · C33 · C37 · C38 · V29 · V30 · P16 · P17 · P21 · P22 · P23
// --------------------------------------------------------------------------

test('C13 · V29 · P16 · P17 — les options sont non classées et sans champ de score', () => {
  const entry = proposed({
    options: [
      { option_id: 'o1', content: 'a' },
      { option_id: 'o2', content: 'b' },
    ],
  });
  assert.equal(validateReconciliationEntry(entry), entry);

  for (const ranked of ['rank', 'score', 'weight', 'preferred', 'recommended', 'best', 'order']) {
    refuses(
      proposed({ options: [{ option_id: 'o1', content: 'a', [ranked]: 1 }] }),
      `${ranked} sur une option`,
    );
  }
  refuses(proposed({ options: [] }), 'options vides');
  // Sans unicité, une référence d'option désignerait deux objets.
  refuses(
    proposed({ options: [{ option_id: 'o1', content: 'a' }, { option_id: 'o1', content: 'b' }] }),
    'option_id dupliqué',
  );
});

test('C38 · V30 · P21 · P22 · P23 — aucun champ de mérite n\'existe dans le schéma', () => {
  const forbidden = [
    'evidence_weight', 'reliability_score', 'credibility_score', 'support_count_score',
    'orientation_balance', 'merits_confidence', 'probability_of_truth', 'preferred_evidence',
    'preferred_claim', 'winner', 'ranked_recommendation',
  ];
  for (const field of forbidden) {
    refuses(recorded({ [field]: 1 }), `${field} sur un acte humain`);
    refuses(proposed({ [field]: 1 }), `${field} sur une proposition`);
    refuses(response({ [field]: 1 }), `${field} sur une réponse`);
  }
});

test('C37 — aucun champ ni valeur CONVERGED, aucun cycle de vie global', () => {
  const sources = [
    ...RECONCILIATION_ENTRY_KINDS,
    ...SEMANTIC_ORIGINS,
    ...DERIVATION_METHODS,
    ...SCOPE_KINDS,
    ...RESPONSE_MODES,
    ...PROPOSAL_RELATIONS,
    ...PROVENANCE_KINDS,
  ];
  for (const forbidden of ['CONVERGED', 'OPEN', 'CLOSED', 'REOPENED', 'ACTIVE', 'SUPERSEDED', 'REVOKED', 'TEMPORARY']) {
    assert.equal(sources.includes(forbidden as never), false, `${forbidden} ne doit être aucune valeur du domaine V5.`);
  }
  for (const field of ['status', 'state', 'lifecycle', 'converged', 'current']) {
    refuses(recorded({ [field]: 'CLOSED' }), `${field} sur un acte humain`);
  }
});

test('C33 · V13 · P46 — provenance obligatoire, fermée, et sans autorité', () => {
  assert.deepEqual(PROVENANCE_KINDS, ['DECLARED', 'CONTROVERSY_AUTHORITY', 'LEGACY_DECISION']);
  for (const provenance of [
    { kind: 'DECLARED', statement: 'décidé en revue' },
    { kind: 'CONTROVERSY_AUTHORITY', entry_id: E1 },
    { kind: 'LEGACY_DECISION', decision_id: formatDecisionId(3) },
  ]) {
    // Les trois provenances valides laissent l'ÉLIGIBILITÉ inchangée : la même
    // clôture, aux conditions de forme identiques, est acceptée dans les trois
    // cas. PROVENANCE ≠ AUTHORITY.
    const entry = recorded({ provenance, closure: { declared: true, statement: 'clos' } });
    assert.equal(validateReconciliationEntry(entry), entry);
  }
  refuses(recorded({ provenance: undefined }), 'provenance absente');
  refuses(recorded({ provenance: { kind: 'VERIFIED_AUTHORITY', statement: 's' } }), 'sorte de provenance inventée');
  refuses(recorded({ provenance: { kind: 'LEGACY_DECISION', decision_id: 'dec_000001' } }), 'identité legacy non canonique');
  assert.ok(isLegacyDecisionId('DEC-0003'));
  assert.equal(isLegacyDecisionId('dec_000003'), false);
  // Aucun nom de champ ne prétend une habilitation que CCR ne peut établir.
  for (const forged of ['verified_authority', 'authorized_by_role', 'identity_verified']) {
    refuses(recorded({ [forged]: true }), `${forged} sur un acte humain`);
  }
});

// --------------------------------------------------------------------------
// Périmètre, clôture, retrait, supersession — FORMES seulement
// --------------------------------------------------------------------------

test('WHOLE n\'est jamais une absence, ni un tableau vide', () => {
  assert.deepEqual(SCOPE_KINDS, ['SUBSET', 'WHOLE']);
  const whole = recorded({ scope_kind: 'WHOLE', scope: [E1, E2] });
  assert.equal(validateReconciliationEntry(whole), whole);
  refuses(recorded({ scope_kind: 'WHOLE', scope: [] }), 'WHOLE avec énumération vide');
  refuses(recorded({ scope_kind: 'WHOLE', scope: undefined }), 'WHOLE sans énumération');
  refuses(recorded({ scope_kind: 'ALL' }), 'sorte de périmètre inventée');
});

test('clôture, retrait et supersession sont trois déclarations distinctes', () => {
  const closure = recorded({ closure: { declared: true, statement: 'clos sur ce périmètre' } });
  assert.equal(validateReconciliationEntry(closure), closure);

  const withdrawal = recorded({
    closure_withdrawal: {
      declared: true,
      withdrawn_closures: [formatReconciliationId(9)],
      withdrawal_scope: [E1],
      statement: 'retiré sur ctve_000011',
    },
  });
  assert.equal(validateReconciliationEntry(withdrawal), withdrawal);

  const supersession = recorded({
    supersedes: [{ superseded_act_id: formatReconciliationId(9), supersession_scope: [E1] }],
  });
  assert.equal(validateReconciliationEntry(supersession), supersession);

  // Une relation de supersession n'a AUCUN champ par lequel encoder un retrait.
  refuses(
    recorded({ supersedes: [{ superseded_act_id: formatReconciliationId(9), supersession_scope: [E1], withdraws_closure: true }] }),
    'retrait glissé dans une relation de supersession',
  );
  // Une clôture n'a aucun champ de périmètre propre : elle porte sur le
  // périmètre de l'acte (§16.3).
  refuses(recorded({ closure: { declared: true, statement: 's', scope: [E1] } }), 'périmètre propre sur une clôture');
  // `declared` ne prend qu'une valeur ; l'absence du champ est la seule autre forme.
  refuses(recorded({ closure: { declared: false, statement: 's' } }), 'clôture déclarée fausse');
});

// --------------------------------------------------------------------------
// Enveloppe
// --------------------------------------------------------------------------

test('enveloppe — version, scribe, cible, horodatage, révision observée', () => {
  refuses(recorded({ schema_version: 2 }), 'version de schéma non prise en charge');
  refuses(recorded({ recorded_by: 'HUMAN' }), 'scribe confondu avec l\'origine');
  refuses(recorded({ kind: 'RECONCILIATION_CLOSED' }), 'sorte inventée');
  refuses(recorded({ target: { kind: 'CONTROVERSY_ENTRY', controversy_id: CTV } }), 'sorte de cible V4 empruntée');
  refuses(recorded({ observed_revision: '' }), 'révision observée vide');
  refuses(recorded({ recorded_at: undefined }), 'horodatage absent');
});
