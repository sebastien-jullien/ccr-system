/**
 * Preuves de la tranche S12 — le read model V5.
 *
 * Classe de preuve : `FIXTURE`. Instantanés en mémoire, entrées V3 et V5
 * validées par leurs domaines. Un audit `STATIC` complète les preuves négatives
 * d'architecture — notamment la **non-duplication** des sémantiques métier.
 *
 * ```text
 * READ MODEL  ≠  AUTHORITY        COMPOSITION  ≠  NEW SEMANTICS
 * COUNT       ≠  MEANING          ORDER        ≠  PREFERENCE
 * NOT_AVAILABLE  ≠  EMPTY         UNKNOWN      ≠  ZERO
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
  validateControversyEntry,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import {
  RECONCILIATION_SCHEMA_VERSION,
  formatReconciliationId,
  validateReconciliationEntry,
} from '../../src/core/reconciliation.ts';
import type {
  ActRespondsTo,
  Provenance,
  ReconciliationEntry,
  ResponseMode,
  ScopeKind,
} from '../../src/core/reconciliation.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { NativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { computeEvidenceRevision } from '../../src/store/evidence-store.ts';
import { computeReconciliationRevision } from '../../src/store/reconciliation-store.ts';
import {
  currentClosureEffects,
  currentDecisions,
} from '../../src/services/reconciliation-currentness.ts';
import { detectReconciliationStructures } from '../../src/services/reconciliation-detector.ts';
import { observedDisagreementSignals } from '../../src/services/reconciliation-disagreement.ts';
import {
  RECONCILIATION_READ_MODEL_VERSION,
  projectReconciliationReadModel,
  reconciliationReadModelNotAvailable,
} from '../../src/services/reconciliation-read-model.ts';
import type {
  ControversyReconciliationV1,
  ReconciliationReadModelV1,
} from '../../src/services/reconciliation-read-model.ts';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const RUN_ID = 'CCR-20260820-012';
const CTV = formatControversyId(1);
const CTV_B = formatControversyId(2);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);
const E3 = formatControversyEntryId(3);
const REVISION = `rcn-sha256:${'0'.repeat(64)}`;

function id(sequence: number): string {
  return formatReconciliationId(sequence);
}

function unit(
  sequence: number,
  controversyId: string = CTV,
  over: Partial<ControversyEntry> = {},
): ControversyEntry {
  return validateControversyEntry({
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: controversyId,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'SOURCE', actor: 'author' },
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000010', round: 1 }] },
    ...over,
  } as ControversyEntry);
}

/** Un signal `S1` — une relation `CONTESTS` attribuée à un expert. */
function contests(sequence: number, controversyId: string = CTV): ControversyEntry {
  return unit(sequence, controversyId, {
    kind: 'RELATION_RECORDED',
    semantic_origin: { kind: 'SOURCE', actor: 'challenger' },
    relation: { from_entry_id: E2, to_entry_id: E1, act: 'CONTESTS' },
  });
}

interface ActOptions {
  readonly scope?: readonly string[];
  readonly scopeKind?: ScopeKind;
  readonly closure?: boolean;
  readonly withdraws?: { readonly closures: readonly string[]; readonly scope: readonly string[] };
  readonly supersedes?: readonly { readonly act: string; readonly scope: readonly string[] }[];
  readonly respondsTo?: ActRespondsTo;
  readonly provenance?: Provenance;
  readonly target?: string;
}

function act(sequence: number, options: ActOptions = {}): ReconciliationEntry {
  const entry: Record<string, unknown> = {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: id(sequence),
    kind: 'RECONCILIATION_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: options.target ?? CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: `2026-08-20T11:${String(sequence).padStart(2, '0')}:00.000Z`,
    observed_revision: REVISION,
    scope_kind: options.scopeKind ?? 'SUBSET',
    scope: options.scope ?? [E1],
    content: `décision humaine ${String(sequence)}`,
    provenance: options.provenance ?? { kind: 'DECLARED', statement: 'décidé en revue' },
  };
  if (options.closure === true) {
    entry['closure'] = { declared: true, statement: `clôture de ${id(sequence)}` };
  }
  if (options.withdraws !== undefined) {
    entry['closure_withdrawal'] = {
      declared: true,
      withdrawn_closures: [...options.withdraws.closures],
      withdrawal_scope: [...options.withdraws.scope],
      statement: 'retrait explicite',
    };
  }
  if (options.supersedes !== undefined) {
    entry['supersedes'] = options.supersedes.map((relation) => ({
      superseded_act_id: relation.act,
      supersession_scope: [...relation.scope],
    }));
  }
  if (options.respondsTo !== undefined) entry['responds_to'] = { ...options.respondsTo };
  return validateReconciliationEntry(entry as unknown as ReconciliationEntry);
}

function proposal(
  sequence: number,
  scope: readonly string[] = [E1],
  target: string = CTV,
): ReconciliationEntry {
  return validateReconciliationEntry({
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: id(sequence),
    kind: 'RECONCILIATION_PROPOSED',
    target: { kind: 'CONTROVERSY', controversy_id: target },
    semantic_origin: 'CCR',
    recorded_by: 'CCR',
    recorded_at: `2026-08-20T11:${String(sequence).padStart(2, '0')}:00.000Z`,
    observed_revision: REVISION,
    scope_kind: 'SUBSET',
    scope: [...scope],
    derivation: { method: 'DETERMINISTIC', inputs: [] },
    options: [
      { option_id: 'oa', content: 'option a' },
      { option_id: 'ob', content: 'option b' },
    ],
  } as unknown as ReconciliationEntry);
}

function response(sequence: number, proposalId: string, mode: ResponseMode): ReconciliationEntry {
  return validateReconciliationEntry({
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: id(sequence),
    kind: 'PROPOSAL_RESPONSE_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: `2026-08-20T11:${String(sequence).padStart(2, '0')}:00.000Z`,
    observed_revision: REVISION,
    provenance: { kind: 'DECLARED', statement: 'répondu en revue' },
    responds_to: { proposal_id: proposalId, mode, responded_option_id: 'ob' },
  } as unknown as ReconciliationEntry);
}

function snapshotOf(
  controversies: readonly ControversyEntry[],
  reconciliations: readonly ReconciliationEntry[],
): NativeRunSnapshot {
  const written = reconciliations.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  return {
    runId: RUN_ID,
    paths: runPaths('/nowhere', RUN_ID),
    manifest: {} as NativeRunSnapshot['manifest'],
    state: {} as NativeRunSnapshot['state'],
    events: [] as unknown as NativeRunSnapshot['events'],
    controversies,
    evidence: [],
    reconciliations,
    revision: 'sha256:x',
    controversy_revision: 'ctv-sha256:x',
    evidence_revision: computeEvidenceRevision({ present: false }),
    reconciliation_revision:
      written.length === 0
        ? computeReconciliationRevision({ present: false })
        : computeReconciliationRevision({ present: true, written }),
    attempts: 1,
  } as NativeRunSnapshot;
}

/** La projection, ou l'échec du test si le run n'était pas concerné. */
function available(
  snapshot: NativeRunSnapshot,
): Extract<ReconciliationReadModelV1, { availability: 'AVAILABLE' }> {
  const model = projectReconciliationReadModel(snapshot);
  assert.equal(model.availability, 'AVAILABLE');
  if (model.availability !== 'AVAILABLE') throw new Error('inatteignable');
  return model;
}

function itemOf(
  snapshot: NativeRunSnapshot,
  controversyId: string = CTV,
): ControversyReconciliationV1 {
  const item = available(snapshot).items.find((row) => row.controversy_id === controversyId);
  assert.ok(item !== undefined, `controverse absente : ${controversyId}`);
  return item;
}

/** Toutes les clés présentes dans une valeur, à toute profondeur. */
function allKeys(value: unknown, into: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      allKeys(child, into);
    }
  }
  return into;
}

const MODULE_URL = new URL('../../src/services/reconciliation-read-model.ts', import.meta.url);

function codeOnly(source: string): string {
  return source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const CATEGORY_FIELDS = [
  'recorded_acts',
  'proposals',
  'responses',
  'scopes',
  'closure_declarations',
  'closure_withdrawal_declarations',
  'supersession_relations',
  'decision_currentness',
  'closure_effect_currentness',
  'current_decisions',
  'historical_explicit_whole_scope_closure_declaration',
  'current_all_entries_closure_coverage',
  'disagreement_view',
  'detections',
  'attribution',
] as const;

// --------------------------------------------------------------------------
// Forme
// --------------------------------------------------------------------------

test('S12 — les seize catégories du §31.3, rendues une à une', () => {
  const snapshot = snapshotOf([unit(1)], [act(1, { closure: true })]);
  const model = available(snapshot);
  // Quinze catégories par controverse…
  const first = model.items[0];
  assert.ok(first, 'la controverse observée est projetée');
  assert.deepEqual(
    Object.keys(first).sort(),
    ['controversy_id', ...CATEGORY_FIELDS].sort(),
  );
  // …plus la seizième, la révision V5, au niveau du run.
  assert.deepEqual(Object.keys(model).sort(), [
    'availability',
    'items',
    'read_model_version',
    'reconciliation_revision',
    'recorded_count',
  ]);
  assert.equal(model.read_model_version, RECONCILIATION_READ_MODEL_VERSION);
  // Aucune fusion n'a réduit ce nombre.
  assert.equal(CATEGORY_FIELDS.length, 15);
});

test('S12 — `C51` : les deux actualités sont deux champs, jamais un statut', () => {
  const snapshot = snapshotOf([unit(1)], [act(1, { closure: true })]);
  const keys = allKeys(available(snapshot));
  for (const forbidden of [
    'status',
    'state',
    'effective_state',
    'resolution_state',
    'currentness',
    'lifecycle',
    'summary',
  ]) {
    assert.equal(keys.has(forbidden), false, `champ agrégeant : ${forbidden}`);
  }
  assert.equal(keys.has('decision_currentness'), true);
  assert.equal(keys.has('closure_effect_currentness'), true);
});

// --------------------------------------------------------------------------
// Disponibilité
// --------------------------------------------------------------------------

test('S12 — `C52` : `NOT_AVAILABLE` ne porte ni liste, ni compteur, ni révision', () => {
  const absent = reconciliationReadModelNotAvailable();
  assert.deepEqual(Object.keys(absent).sort(), ['availability', 'read_model_version']);
  assert.equal(absent.availability, 'NOT_AVAILABLE');
  const keys = allKeys(absent);
  for (const forbidden of [
    'recorded_count',
    'items',
    'reconciliation_revision',
    'no_disagreement',
    'no_detection',
    'no_decision',
  ]) {
    assert.equal(keys.has(forbidden), false, `faux zéro : ${forbidden}`);
  }
});

test('S12 — `PRODUCED` vide ≠ `NOT_AVAILABLE`', () => {
  // A — la source est disponible, la projection légitime est vide.
  const empty = available(snapshotOf([unit(1), unit(2)], []));
  assert.equal(empty.recorded_count, 0);
  assert.equal(empty.items.length, 1);
  const emptyItem = empty.items[0];
  assert.ok(emptyItem, 'la controverse observée est projetée même sans acte V5');
  assert.deepEqual(emptyItem.recorded_acts, []);
  assert.deepEqual(emptyItem.proposals, []);
  assert.equal(emptyItem.historical_explicit_whole_scope_closure_declaration, false);
  // Un run natif sans acte V5 conserve ses unités et ses dérivations vides…
  assert.deepEqual(
    emptyItem.current_decisions.map((row) => row.act_ids),
    [[], []],
  );
  // B — la projection n'est pas produite.
  const absent = reconciliationReadModelNotAvailable();
  assert.notDeepEqual(absent, empty);
  assert.notEqual(absent.availability, empty.availability);
});

// --------------------------------------------------------------------------
// Composition — non-duplication
// --------------------------------------------------------------------------

test('S12 — aucune sémantique métier n\'est réimplémentée', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  // Les quatre opérations qui constituent les formules d'actualité du §19.1 et
  // du §20.3 n'apparaissent nulle part : le module EXPOSE ces tableaux, il ne
  // les parcourt jamais pour décider d'une actualité.
  for (const formula of [
    'supersession_scope.includes',
    'withdrawal_scope.includes',
    'withdrawn_closures.includes',
    'superseded_act_id ===',
  ]) {
    assert.equal(source.includes(formula), false, `formule d'actualité recopiée : ${formula}`);
  }
  // Aucun prédicat de détection : le module ne nomme aucune catégorie.
  for (const category of ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08']) {
    assert.equal(source.includes(category), false, `prédicat de détection recopié : ${category}`);
  }
  // Aucun prédicat de signal : le module ne nomme aucun acte V3.
  for (const signal of ['CONTESTS', 'WITHDRAWS', 'CONTEST_RELATION', 'NATURE_RECORDED']) {
    assert.equal(source.includes(signal), false, `prédicat de signal recopié : ${signal}`);
  }
  // Les propriétaires sont bien appelés.
  for (const owner of [
    'currentDecisions',
    'currentClosureEffects',
    'detectReconciliationStructures',
    'observedDisagreementSignals',
    'coversAllObservedEntries',
  ]) {
    assert.ok(source.includes(owner), `propriétaire non composé : ${owner}`);
  }
});

test('S12 — l\'actualité composée est exactement celle de `S9`', () => {
  const entries = [
    act(1, { scope: [E1, E2], closure: true }),
    act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    act(3, { scope: [E2] }),
  ];
  const snapshot = snapshotOf([unit(1), unit(2)], entries);
  const item = itemOf(snapshot);
  // 10 — ensemble par unité, identique à `S9`.
  for (const row of item.current_decisions) {
    assert.deepEqual(row.act_ids, currentDecisions(entries, row.unit), row.unit);
  }
  // 9 — ensemble par unité, identique à `S9`, dérivé séparément.
  for (const row of item.closure_effect_currentness) {
    assert.deepEqual(row.act_ids, currentClosureEffects(entries, row.unit), row.unit);
  }
  // 8 — par acte ET par unité, appartenance à l'ensemble de `S9`.
  for (const row of item.decision_currentness) {
    assert.equal(
      row.current,
      currentDecisions(entries, row.unit).includes(row.act_id),
      `${row.act_id}/${row.unit}`,
    );
  }
  // La granularité est bien par couple : l'acte 1 est non courant sur `E1` et
  // courant sur `E2`. Un booléen global par acte échouerait ici.
  assert.deepEqual(
    item.decision_currentness.filter((row) => row.act_id === id(1)),
    [
      { act_id: id(1), unit: E1, current: false },
      { act_id: id(1), unit: E2, current: true },
    ],
  );
});

test('S12 — les détections sont composées, jamais réinterprétées', () => {
  const entries = [
    act(1, { scope: [E1], closure: true }),
    act(2, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } }),
    proposal(3, [E2]),
  ];
  const snapshot = snapshotOf([unit(1), unit(2)], entries);
  const produced = detectReconciliationStructures(snapshot);
  assert.equal(produced.availability, 'PRODUCED');
  const expected =
    produced.availability === 'PRODUCED'
      ? produced.detections.filter((d) => d.controversy_id === CTV)
      : [];
  // Identiques, dans le même ordre : ni résumées, ni priorisées, ni scorées.
  assert.deepEqual(itemOf(snapshot).detections, expected);
  assert.ok(expected.length > 0);
  const keys = allKeys(itemOf(snapshot).detections);
  for (const forbidden of [
    'has_problem',
    'needs_action',
    'blocking_issue',
    'risk_level',
    'recommended_fix',
    'severity',
  ]) {
    assert.equal(keys.has(forbidden), false, `remédiation : ${forbidden}`);
  }
});

test('S12 — `C36` : les signaux sont composés, jamais agrégés', () => {
  const v3 = [unit(1), contests(2)];
  const snapshot = snapshotOf(v3, [act(1, { closure: true })]);
  const expected = observedDisagreementSignals(v3).filter((s) => s.controversy_id === CTV);
  assert.deepEqual(itemOf(snapshot).disagreement_view, expected);
  assert.equal(expected.length, 1);
  // Attribution préservée à travers la composition.
  const signal = itemOf(snapshot).disagreement_view[0];
  assert.ok(signal, 'le signal observé est composé');
  assert.deepEqual(signal.semantic_origin, {
    kind: 'SOURCE',
    actor: 'challenger',
  });
  const keys = allKeys(itemOf(snapshot).disagreement_view);
  for (const forbidden of [
    'disagreement_status',
    'persistent_disagreement',
    'agreement',
    'convergence',
    'resolved_disagreement',
    'disagreement_count',
  ]) {
    assert.equal(keys.has(forbidden), false, `agrégat : ${forbidden}`);
  }
});

// --------------------------------------------------------------------------
// Pivots `CR5-01`
// --------------------------------------------------------------------------

test('S12 — `CR5-01` : décision non courante ET clôture courante, sans synthèse', () => {
  const entries = [
    act(1, { scope: [E1], closure: true }),
    act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
  ];
  const item = itemOf(snapshotOf([unit(1)], entries));
  // 8 — `H1` n'est plus courant comme décision sur `E1`.
  assert.deepEqual(
    item.decision_currentness.filter((row) => row.act_id === id(1)),
    [{ act_id: id(1), unit: E1, current: false }],
  );
  // 9 — son effet de clôture reste courant sur `E1`.
  assert.deepEqual(item.closure_effect_currentness, [{ unit: E1, act_ids: [id(1)] }]);
  // 5 — la déclaration historique demeure lisible.
  assert.equal(item.closure_declarations.length, 1);
  const declared = item.closure_declarations[0];
  assert.ok(declared, 'la déclaration historique est projetée');
  assert.equal(declared.entry_id, id(1));
  // Aucune synthèse : ni `CLOSED`, ni `OPEN`, ni `SUPERSEDED_AND_CLOSED`.
  const keys = allKeys(item);
  for (const forbidden of ['closed', 'open', 'superseded', 'reopened', 'resolved', 'converged']) {
    assert.equal(keys.has(forbidden), false, `synthèse : ${forbidden}`);
  }
});

test('S12 — retrait explicite : les deux projections bougent séparément', () => {
  const before = [
    act(1, { scope: [E1], closure: true }),
    act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
  ];
  const after = [...before, act(3, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } })];
  const itemBefore = itemOf(snapshotOf([unit(1)], before));
  const itemAfter = itemOf(snapshotOf([unit(1)], after));

  // L'effet bascule…
  assert.deepEqual(itemBefore.closure_effect_currentness, [{ unit: E1, act_ids: [id(1)] }]);
  assert.deepEqual(itemAfter.closure_effect_currentness, [{ unit: E1, act_ids: [] }]);
  // …et l'actualité de décision de `H1` est inchangée par `H3`.
  assert.deepEqual(
    itemAfter.decision_currentness.filter((row) => row.act_id === id(1)),
    [{ act_id: id(1), unit: E1, current: false }],
  );
  // Les deux déclarations historiques demeurent, distinctes l'une de l'autre.
  assert.equal(itemAfter.closure_declarations.length, 1);
  assert.equal(itemAfter.closure_withdrawal_declarations.length, 1);
  const withdrawn = itemAfter.closure_withdrawal_declarations[0];
  assert.ok(withdrawn, 'la déclaration de retrait est projetée');
  assert.deepEqual(withdrawn.withdrawn_closures, [id(1)]);
  // Un ensemble vide n'est pas l'affirmation qu'aucune clôture n'a existé : la
  // déclaration est toujours là, à côté.
  const stillDeclared = itemAfter.closure_declarations[0];
  assert.ok(stillDeclared, 'la clôture historique demeure projetée');
  assert.equal(stillDeclared.entry_id, id(1));
});

test('S12 — un signal de désaccord et une clôture humaine courante coexistent', () => {
  const v3 = [unit(1), contests(2)];
  const item = itemOf(snapshotOf(v3, [act(1, { closure: true })]));
  assert.equal(item.disagreement_view.length, 1);
  const effect = item.closure_effect_currentness[0];
  assert.ok(effect, "l'unité observée porte sa ligne d'actualité d'effet");
  assert.deepEqual(effect.act_ids, [id(1)]);
  // Aucun conflit logique, et surtout aucun `experts_agreed`.
  const keys = allKeys(item);
  for (const forbidden of ['experts_agreed', 'agreed', 'consensus', 'aligned']) {
    assert.equal(keys.has(forbidden), false, `${forbidden} inventé`);
  }
});

// --------------------------------------------------------------------------
// `C29` · `C25`
// --------------------------------------------------------------------------

test('S12 — `C29` : `A` historique et `B` structurel courant sont deux champs', () => {
  const whole = act(1, { scopeKind: 'WHOLE', scope: [E1, E2], closure: true });
  // Les deux unités connues au moment de l'acte sont couvertes.
  const covered = itemOf(snapshotOf([unit(1), unit(2)], [whole]));
  assert.equal(covered.historical_explicit_whole_scope_closure_declaration, true);
  assert.equal(covered.current_all_entries_closure_coverage, true);

  // Une `ctve_` apparue depuis rend `B` faux SANS rendre `A` faux.
  const grown = itemOf(snapshotOf([unit(1), unit(2), unit(3)], [whole]));
  assert.equal(grown.historical_explicit_whole_scope_closure_declaration, true);
  assert.equal(grown.current_all_entries_closure_coverage, false);

  // Un `SUBSET` qui couvre tout reste un `SUBSET` : `B` vrai, `A` faux.
  const subset = itemOf(snapshotOf([unit(1)], [act(2, { scope: [E1], closure: true })]));
  assert.equal(subset.historical_explicit_whole_scope_closure_declaration, false);
  assert.equal(subset.current_all_entries_closure_coverage, true);
});

test('S12 — `C25` : `current_decisions` est un ensemble, jamais une valeur', () => {
  const entries = [act(1, { scope: [E1] }), act(2, { scope: [E1] })];
  const item = itemOf(snapshotOf([unit(1)], entries));
  assert.deepEqual(item.current_decisions, [{ unit: E1, act_ids: [id(1), id(2)] }]);
  // Aucun gagnant, aucun cardinal, aucune valeur unique.
  const keys = allKeys(item.current_decisions);
  for (const forbidden of ['act_id', 'winner', 'current_decision_id', 'count', 'cardinality']) {
    assert.equal(keys.has(forbidden), false, `${forbidden} exposé`);
  }
});

// --------------------------------------------------------------------------
// Compteurs, scores, cycles de vie
// --------------------------------------------------------------------------

test('S12 — un seul nombre contracté, aucun autre compteur', () => {
  const snapshot = snapshotOf(
    [unit(1), contests(2)],
    [act(1, { closure: true }), proposal(2, [E1]), response(3, id(2), 'ACCEPT')],
  );
  const model = available(snapshot);
  assert.equal(model.recorded_count, 3);
  // `recorded_count` compte les ENREGISTREMENTS V5, pas les controverses.
  assert.notEqual(model.recorded_count, model.items.length);
  const keys = [...allKeys(model)];
  for (const key of keys) {
    if (key === 'recorded_count') continue;
    assert.equal(/count|total|score|rank|priority|weight|severity|maturity|percent|confidence|progress/i.test(key), false, `compteur inventé : ${key}`);
  }
});

test('S12 — aucun score, aucun résumé, aucun cycle de vie global', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  for (const forbidden of [
    'CONVERGED',
    'REOPENED',
    'RESOLVED',
    'ACTIVE',
    'healthy',
    'unhealthy',
    'progress',
    'score',
    'confidence',
    'severity',
    'priority',
    'maturity',
    'rank',
    'sort(',
    'recommend',
    'remediat',
    'callModel',
    'propose(',
  ]) {
    assert.equal(source.includes(forbidden), false, `motif interdit : ${forbidden}`);
  }
});

// --------------------------------------------------------------------------
// Historique / dérivé · propositions · réponses
// --------------------------------------------------------------------------

test('S12 — les cinq séparations du §24.3 restent des champs distincts', () => {
  const entries = [
    act(1, { scope: [E1], closure: true }),
    proposal(2, [E1]),
    response(3, id(2), 'REJECT'),
  ];
  // `E2` n'appartient au périmètre d'aucune entrée V5 : `D01` et `D02` s'y
  // déclenchent, si bien que la famille STRUCTURAL DETECTION est peuplée.
  const item = itemOf(snapshotOf([unit(1), unit(2)], entries));
  // RECORDED FACT · CCR PROPOSAL · HUMAN-AUTHORITATIVE EFFECT · DERIVED ·
  // STRUCTURAL DETECTION — cinq familles, aucun champ commun.
  assert.equal(item.recorded_acts.length, 1);
  assert.equal(item.proposals.length, 1);
  assert.equal(item.responses.length, 1);
  assert.equal(item.closure_declarations.length, 1);
  assert.ok(item.decision_currentness.length > 0);
  assert.ok(item.detections.length > 0);
  // Une proposition n'apparaît jamais parmi les actes, ni une réponse.
  assert.deepEqual(
    item.recorded_acts.map((row) => row.entry_id),
    [id(1)],
  );
  // Une déclaration historique n'est pas un effet courant : deux champs.
  assert.notDeepEqual(item.closure_declarations, item.closure_effect_currentness);
});

test('S12 — propositions et réponses gardent leurs distinctions', () => {
  const entries = [
    proposal(1, [E1]),
    response(2, id(1), 'ACCEPT'),
    act(3, {
      scope: [E1],
      respondsTo: { proposal_id: id(1), relation: 'ADOPTS', adopted_option_id: 'oa' },
    }),
  ];
  const item = itemOf(snapshotOf([unit(1)], entries));
  // `ACCEPT` reste une réponse ; `ADOPTS` reste la relation d'un acte humain.
  assert.deepEqual(item.responses[0], {
    entry_id: id(2),
    proposal_id: id(1),
    mode: 'ACCEPT',
    responded_option_id: 'ob',
  });
  const adopting = item.recorded_acts[0];
  assert.ok(adopting, "l'acte humain adoptant est projeté");
  assert.deepEqual(adopting.responds_to, {
    proposal_id: id(1),
    relation: 'ADOPTS',
    adopted_option_id: 'oa',
  });
  // `ADOPTS` ne produit aucun effet : la proposition n'est pas requalifiée.
  assert.deepEqual(item.closure_declarations, []);
  assert.deepEqual(item.supersession_relations, []);
  // Options non classées, et aucun statut de proposition.
  const projected = item.proposals[0];
  assert.ok(projected, 'la proposition est projetée');
  assert.deepEqual(
    projected.options.map((option) => Object.keys(option).sort()),
    [
      ['content', 'option_id'],
      ['content', 'option_id'],
    ],
  );
  const keys = allKeys(item);
  for (const forbidden of [
    'proposal_status',
    'accepted_proposal',
    'winning_option',
    'current_proposal',
    'adopted',
  ]) {
    assert.equal(keys.has(forbidden), false, `${forbidden} inventé`);
  }
});

test('S12 — provenance et attribution sont rendues telles quelles', () => {
  const entries = [
    act(1, { provenance: { kind: 'LEGACY_DECISION', decision_id: 'DEC-0007' } }),
    proposal(2, [E1]),
  ];
  const item = itemOf(snapshotOf([unit(1)], entries));
  assert.deepEqual(item.attribution, [
    {
      entry_id: id(1),
      kind: 'RECONCILIATION_RECORDED',
      semantic_origin: 'HUMAN',
      recorded_by: 'CCR',
      provenance: { kind: 'LEGACY_DECISION', decision_id: 'DEC-0007' },
    },
    {
      entry_id: id(2),
      kind: 'RECONCILIATION_PROPOSED',
      semantic_origin: 'CCR',
      recorded_by: 'CCR',
      derivation: { method: 'DETERMINISTIC', inputs: [] },
    },
  ]);
  // Une provenance legacy n'est ni promue en autorité, ni marquée invalide.
  const keys = allKeys(item.attribution);
  for (const forbidden of ['authorized', 'verified', 'valid', 'authority']) {
    assert.equal(keys.has(forbidden), false, `${forbidden} inventé`);
  }
});

// --------------------------------------------------------------------------
// Ordre, instantané, révision, écriture
// --------------------------------------------------------------------------

test('S12 — chaque sous-projection conserve l\'ordre de son propriétaire', () => {
  const v3 = [unit(3, CTV), unit(1, CTV_B), unit(2, CTV)];
  const entries = [act(2, { scope: [E3] }), proposal(3, [E3]), act(1, { scope: [E2] })];
  const model = available(snapshotOf(v3, entries));
  // Controverses : ordre de PREMIÈRE APPARITION dans le journal V3.
  assert.deepEqual(
    model.items.map((row) => row.controversy_id),
    [CTV, CTV_B],
  );
  const item = model.items[0];
  assert.ok(item, 'la première controverse du journal V3 est projetée');
  // Unités : ordre d'append V3 — `E3` avant `E2`.
  assert.deepEqual(
    item.current_decisions.map((row) => row.unit),
    [E3, E2],
  );
  // Actes : ordre d'append V5 — `rcn_000002` avant `rcn_000001`.
  assert.deepEqual(
    item.recorded_acts.map((row) => row.entry_id),
    [id(2), id(1)],
  );
  // Attribution : même ordre d'append, les trois sortes mêlées.
  assert.deepEqual(
    item.attribution.map((row) => row.entry_id),
    [id(2), id(3), id(1)],
  );
});

test('S12 — un seul instantané alimente toutes les composantes', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  // La fonction publique reçoit UN instantané et le passe tel quel : aucune
  // seconde lecture, aucune acquisition, aucun second état.
  assert.ok(source.includes('detectReconciliationStructures(snapshot)'));
  assert.ok(source.includes('observedDisagreementSignals(snapshot.controversies)'));
  assert.ok(source.includes('snapshot.reconciliations'));
  assert.equal(source.includes('readStableNativeRunSnapshot'), false);
  assert.equal((source.match(/snapshot: NativeRunSnapshot/g) ?? []).length >= 1, true);
});

test('S12 — la révision est un jeton technique, restitué tel quel', () => {
  const entries = [act(1, { closure: true })];
  const snapshot = snapshotOf([unit(1)], entries);
  const model = available(snapshot);
  assert.equal(model.reconciliation_revision, snapshot.reconciliation_revision);
  assert.ok(model.reconciliation_revision.startsWith('rcn-sha256:'));
  // Aucune comparaison entre espaces de noms : les autres révisions n'entrent
  // pas dans la forme.
  const keys = allKeys(model);
  assert.equal(keys.has('controversy_revision'), false);
  assert.equal(keys.has('evidence_revision'), false);
  assert.equal(keys.has('revision'), false);
});

test('S12 — aucune écriture canonique : l\'instantané est rendu intact', async () => {
  const snapshot = snapshotOf(
    [unit(1), contests(2)],
    [act(1, { closure: true }), proposal(2, [E1]), response(3, id(2), 'REJECT')],
  );
  const before = JSON.stringify({
    reconciliations: snapshot.reconciliations,
    controversies: snapshot.controversies,
  });
  projectReconciliationReadModel(snapshot);
  projectReconciliationReadModel(snapshot);
  assert.equal(
    JSON.stringify({
      reconciliations: snapshot.reconciliations,
      controversies: snapshot.controversies,
    }),
    before,
  );
  // Déterminisme : deux projections identiques.
  assert.deepEqual(
    projectReconciliationReadModel(snapshot),
    projectReconciliationReadModel(snapshot),
  );
  // Aucun écrivain, aucun verrou, aucune horloge, aucun aléa, aucun fournisseur.
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  for (const forbidden of [
    'node:fs',
    'append',
    'withNativeMutation',
    'acquireRunLock',
    'Date.now',
    'new Date',
    'Math.random',
    'adapter',
    'reconciliation-service',
    'argv',
  ]) {
    assert.equal(source.includes(forbidden), false, `motif interdit : ${forbidden}`);
  }
});
