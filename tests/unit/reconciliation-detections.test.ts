/**
 * Preuves de la tranche S10 — les huit détections structurelles `D01`–`D08`.
 *
 * Classe de preuve : `FIXTURE`. Instantanés construits en mémoire, entrées V5
 * passées par `validateReconciliationEntry`. Un audit `STATIC` du source
 * complète les preuves négatives d'architecture ; il ne remplace aucune fixture.
 *
 * ```text
 * FIXTURE SNAPSHOT  ≠  REAL RECORDED HISTORY
 * DETECTION         ≠  REMEDIATION · DECISION · TRUTH · MERITS · AUTHORITY
 * ```
 *
 * Aucune écriture, aucun verrou, aucun processus, aucun fournisseur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
} from '../../src/core/reconciliation.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import type { ControversyEntry, TextualAnchor } from '../../src/core/controversy.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { NativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { computeEvidenceRevision } from '../../src/store/evidence-store.ts';
import { computeReconciliationRevision } from '../../src/store/reconciliation-store.ts';
import {
  DETECTION_CATEGORIES,
  detectReconciliationStructures,
  reconciliationDetectionsNotAvailable,
} from '../../src/services/reconciliation-detector.ts';
import type { StructuralDetection } from '../../src/services/reconciliation-detector.ts';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const RUN_ID = 'CCR-20260820-010';
const CTV = formatControversyId(1);
const CTV_B = formatControversyId(2);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);
const E3 = formatControversyEntryId(3);
const REVISION = `rcn-sha256:${'0'.repeat(64)}`;

function id(sequence: number): string {
  return formatReconciliationId(sequence);
}

/** Une unité V3 — l'objet que `D01`, `D02` et `D04` observent. */
function unit(
  sequence: number,
  controversyId: string = CTV,
  textual?: TextualAnchor,
): ControversyEntry {
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: controversyId,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-20T10:00:00.000Z',
    round: 1,
    anchors:
      textual === undefined
        ? { provenance: [{ event_id: 'evt_000010', round: 1 }] }
        : { provenance: [{ event_id: 'evt_000010', round: 1 }], textual },
  } as ControversyEntry;
}

interface ActOptions {
  readonly scope?: readonly string[];
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
    scope_kind: 'SUBSET',
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
    options: [{ option_id: 'oa', content: 'option a' }],
  } as unknown as ReconciliationEntry);
}

function response(
  sequence: number,
  proposalId: string,
  mode: ResponseMode,
  provenance: Provenance = { kind: 'DECLARED', statement: 'répondu en revue' },
): ReconciliationEntry {
  return validateReconciliationEntry({
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: id(sequence),
    kind: 'PROPOSAL_RESPONSE_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: `2026-08-20T11:${String(sequence).padStart(2, '0')}:00.000Z`,
    observed_revision: REVISION,
    provenance,
    responds_to: { proposal_id: proposalId, mode },
  } as unknown as ReconciliationEntry);
}

/** Instantané minimal, sans disque : la détection est pure. */
function snapshotOf(
  controversies: readonly ControversyEntry[],
  reconciliations: readonly ReconciliationEntry[],
  events: readonly { event_id: string; content?: string | null }[] = [],
): NativeRunSnapshot {
  const written = reconciliations.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  return {
    runId: RUN_ID,
    paths: runPaths('/nowhere', RUN_ID),
    manifest: {} as NativeRunSnapshot['manifest'],
    state: {} as NativeRunSnapshot['state'],
    events: events as NativeRunSnapshot['events'],
    controversies,
    evidence: [],
    reconciliations,
    revision: 'sha256:x',
    controversy_revision: 'ctv-sha256:x',
    // Les jetons de fraîcheur ne sont PAS consommés par S10 ; ils sont calculés
    // par les primitives autoritaires pour que la fixture ne décrive jamais un
    // état que les stores ne produisent pas.
    evidence_revision: computeEvidenceRevision({ present: false }),
    reconciliation_revision:
      written.length === 0
        ? computeReconciliationRevision({ present: false })
        : computeReconciliationRevision({ present: true, written }),
    attempts: 1,
  } as NativeRunSnapshot;
}

/** Les détections produites, ou l'échec du test si le run n'était pas concerné. */
function produced(snapshot: NativeRunSnapshot): readonly StructuralDetection[] {
  const result = detectReconciliationStructures(snapshot);
  assert.equal(result.availability, 'PRODUCED');
  return result.availability === 'PRODUCED' ? result.detections : [];
}

function only(
  detections: readonly StructuralDetection[],
  category: StructuralDetection['category'],
): readonly StructuralDetection[] {
  return detections.filter((detection) => detection.category === category);
}

const MODULE_URL = new URL('../../src/services/reconciliation-detector.ts', import.meta.url);

/** Le source privé de ses commentaires : un interdit peut être *cité*. */
function codeOnly(source: string): string {
  return source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `fonction introuvable : ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `fin de corps introuvable : ${name}`);
  return source.slice(start, end);
}

// --------------------------------------------------------------------------
// Invariants transverses
// --------------------------------------------------------------------------

test('S10 — ensemble fermé de huit catégories', () => {
  assert.deepEqual([...DETECTION_CATEGORIES], [
    'D01',
    'D02',
    'D03',
    'D04',
    'D05',
    'D06',
    'D07',
    'D08',
  ]);
});

test('S10 — pureté : aucune écriture, aucun verrou, aucune horloge, aucun aléa', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  const specifiers = [...source.matchAll(/from '([^']+)';/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(specifiers)].sort(), [
    '../core/reconciliation.ts',
    '../store/native-run-snapshot.ts',
    './controversy-read-model.ts',
    './reconciliation-currentness.ts',
  ]);
  for (const forbidden of [
    'node:fs',
    'append',
    'withNativeMutation',
    'acquireRunLock',
    'Date.now',
    'new Date',
    'Math.random',
    'adapter',
    'provider',
  ]) {
    assert.equal(source.includes(forbidden), false, `motif interdit : ${forbidden}`);
  }
});

test('S10 — aucun score, aucun rang, aucun poids, aucun jugement de fond', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  for (const forbidden of [
    'score',
    'confidence',
    'probability',
    'rank',
    'priority',
    'weight',
    'severity',
    'percent',
    'maturity',
    'winner',
    'count',
    'sort(',
    'correct',
    'reliab',
    'sufficient',
    'better',
    'worse',
  ]) {
    assert.equal(source.includes(forbidden), false, `motif interdit : ${forbidden}`);
  }
});

test('S10 — aucun état de désaccord, aucune convergence, aucun cycle de vie', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  for (const forbidden of [
    'DISAGREEMENT',
    'AGREEMENT',
    'CONVERGED',
    'RESOLVED',
    'REOPENED',
    'OPEN',
    'CLOSED',
  ]) {
    assert.equal(source.includes(forbidden), false, `motif interdit : ${forbidden}`);
  }
});

test('S10 — aucun chemin de remédiation ni de proposition', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  for (const forbidden of [
    'recordReconciliation',
    'recordProposalResponse',
    'propose(',
    'generateProposal',
    'recommend',
    'remediat',
    'repair',
    'fix(',
  ]) {
    assert.equal(source.includes(forbidden), false, `motif interdit : ${forbidden}`);
  }
});

test('S10 — les deux actualités ne sont ni recopiées ni recouplées', async () => {
  const source = await readFile(MODULE_URL, 'utf8');
  // Aucune formule d'actualité n'est réécrite : les champs de relation et de
  // retrait n'apparaissent nulle part dans le code du détecteur.
  const code = codeOnly(source);
  for (const field of [
    'superseded_act_id',
    'supersession_scope',
    'withdrawn_closures',
    'withdrawal_scope',
  ]) {
    assert.equal(code.includes(field), false, `formule d'actualité recopiée : ${field}`);
  }
  // Indépendance des entrées : chaque détection ne reçoit QUE sa dimension.
  for (const name of ['detectD02', 'detectD08']) {
    const body = bodyOf(source, name);
    assert.ok(body.includes('currentClosureEffects'), `${name} n'utilise pas S9`);
    assert.equal(body.includes('currentDecisions'), false, `${name} recouple les actualités`);
  }
  for (const name of ['detectD03', 'detectD04']) {
    const body = bodyOf(source, name);
    assert.ok(body.includes('currentDecisions'), `${name} n'utilise pas S9`);
    assert.equal(body.includes('currentClosureEffects'), false, `${name} recouple les actualités`);
  }
  // `D01`, `D05`, `D06`, `D07` ne dépendent d'aucune actualité.
  for (const name of ['detectD01', 'detectD05', 'detectD06']) {
    const body = bodyOf(source, name);
    assert.equal(body.includes('current'), false, `${name} consulte une actualité`);
  }
});

test('S10 — aucune écriture canonique : l\'instantané est rendu intact', () => {
  const snapshot = snapshotOf(
    [unit(1), unit(2)],
    [act(1, { scope: [E1], closure: true }), proposal(2, [E2])],
  );
  const before = JSON.stringify({
    reconciliations: snapshot.reconciliations,
    controversies: snapshot.controversies,
  });
  detectReconciliationStructures(snapshot);
  detectReconciliationStructures(snapshot);
  assert.equal(
    JSON.stringify({
      reconciliations: snapshot.reconciliations,
      controversies: snapshot.controversies,
    }),
    before,
  );
  assert.equal(snapshot.reconciliations.length, 2);
});

test('S10 — déterminisme : deux exécutions rendent exactement la même sortie', () => {
  const snapshot = snapshotOf(
    [unit(1), unit(2), unit(3)],
    [
      act(1, { scope: [E1, E2], closure: true }),
      act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
      proposal(3, [E2]),
    ],
  );
  assert.deepEqual(produced(snapshot), produced(snapshot));
});

test('S10 — une détection ne porte aucun effet `E1`–`E4`, aucune autorité', () => {
  const snapshot = snapshotOf(
    [unit(1), unit(2)],
    [
      act(1, { scope: [E1], closure: true }),
      act(2, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } }),
      act(3, { scope: [E2], supersedes: [{ act: id(1), scope: [E2] }] }),
      proposal(4, [E2]),
    ],
  );
  const detections = produced(snapshot);
  assert.ok(detections.length > 0);
  for (const detection of detections) {
    for (const forbidden of [
      'closure',
      'closure_withdrawal',
      'supersedes',
      'content',
      'semantic_origin',
      'recorded_by',
      'provenance',
      'scope_kind',
      'score',
      'rank',
      'severity',
      'status',
    ]) {
      assert.equal(forbidden in detection, false, `${detection.category} porte ${forbidden}`);
    }
    // Une détection référence des actes HUMAN sans devenir humaine.
    assert.equal(Object.values(detection).includes('HUMAN'), false);
  }
});

test('S10 — `C52` : un run non concerné rend `NOT_AVAILABLE`, sans liste ni compteur', () => {
  const absent = reconciliationDetectionsNotAvailable();
  assert.equal(absent.availability, 'NOT_AVAILABLE');
  assert.deepEqual(Object.keys(absent), ['availability']);
  // `NOT_AVAILABLE` n'est PAS `PRODUCED` avec zéro détection : un run natif sans
  // aucun fait rend bien `PRODUCED`.
  const empty = detectReconciliationStructures(snapshotOf([], []));
  assert.equal(empty.availability, 'PRODUCED');
  assert.notDeepEqual(absent, empty);
});

// --------------------------------------------------------------------------
// `D01` — entrée hors de tout périmètre V5
// --------------------------------------------------------------------------

test('S10 — `D01` : positif hors périmètre, négatif dès qu\'un périmètre V5 couvre l\'unité', () => {
  const snapshot = snapshotOf(
    [unit(1), unit(2), unit(3)],
    [
      // `E1` est couvert par un ACTE HUMAIN.
      act(1, { scope: [E1] }),
      // `E2` est couvert par une PROPOSITION CCR — §14.2 dit « acte V5 », là où
      // `D03` dit « acte humain ». Une proposition déclare bien un périmètre V5.
      proposal(2, [E2]),
    ],
  );
  const detections = only(produced(snapshot), 'D01');
  assert.deepEqual(detections, [{ category: 'D01', controversy_id: CTV, unit: E3 }]);
});

test('S10 — `D01` : un acte supersédé continue de déclarer son périmètre', () => {
  // Cas complémentaire, et non discriminant : le §18.2 exige
  // `supersession_scope ⊆ scope` de l'acte qui supersède, si bien qu'une unité
  // couverte par un acte supersédé reste couverte par son superséder. La
  // supersession ne peut donc PAS falsifier l'historicité de `D01`.
  //
  // Le vrai discriminant est la PROPOSITION — test précédent : elle déclare un
  // périmètre V5 sans être un acte humain et sans posséder aucune actualité.
  const snapshot = snapshotOf(
    [unit(1)],
    [
      act(1, { scope: [E1] }),
      act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    ],
  );
  assert.deepEqual(only(produced(snapshot), 'D01'), []);
});

// --------------------------------------------------------------------------
// `D02` — entrée sans effet de clôture courant
// --------------------------------------------------------------------------

test('S10 — `D02` : vide ⇒ positif ; clôture courante ⇒ négatif', () => {
  const snapshot = snapshotOf(
    [unit(1), unit(2), unit(3)],
    [
      // `E1` porte une clôture courante ; `E2` une clôture retirée ; `E3` rien.
      act(1, { scope: [E1, E2], closure: true }),
      act(2, { scope: [E2], withdraws: { closures: [id(1)], scope: [E2] } }),
    ],
  );
  assert.deepEqual(
    only(produced(snapshot), 'D02').map((d) => ('unit' in d ? d.unit : '')),
    [E2, E3],
  );
});

test('S10 — `D02` réparé : la supersession seule ne déclenche pas `D02`', () => {
  // `SUPERSEDED → CLOSURE GONE` n'est PAS réintroduit.
  const snapshot = snapshotOf(
    [unit(1)],
    [
      act(1, { scope: [E1], closure: true }),
      act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    ],
  );
  const detections = produced(snapshot);
  assert.deepEqual(only(detections, 'D02'), []);
  // …tandis que `D03` se déclenche bien sur le même acte, même unité.
  assert.deepEqual(only(detections, 'D03'), [
    { category: 'D03', controversy_id: CTV, unit: E1, act_id: id(1) },
  ]);
});

test('S10 — `D02` : couverture structurelle ⇏ clôture humaine', () => {
  // Toutes les unités appartiennent au périmètre d'un acte : `D01` est vide.
  // Aucune clôture n'est déclarée : `D02` se déclenche partout. Une couverture
  // structurelle ne produit AUCUNE clôture.
  const snapshot = snapshotOf([unit(1), unit(2)], [act(1, { scope: [E1, E2] })]);
  const detections = produced(snapshot);
  assert.deepEqual(only(detections, 'D01'), []);
  assert.equal(only(detections, 'D02').length, 2);
});

// --------------------------------------------------------------------------
// `D03` — acte humain non courant comme décision sur une unité
// --------------------------------------------------------------------------

test('S10 — `D03` : par unité, jamais par acte entier', () => {
  const snapshot = snapshotOf(
    [unit(1), unit(2)],
    [
      act(1, { scope: [E1, E2] }),
      act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    ],
  );
  // Supersédé sur `E1` seulement : une seule détection, et pas sur `E2`.
  assert.deepEqual(only(produced(snapshot), 'D03'), [
    { category: 'D03', controversy_id: CTV, unit: E1, act_id: id(1) },
  ]);
});

test('S10 — `D03` réparé : non courant comme décision, clôture toujours courante', () => {
  const snapshot = snapshotOf(
    [unit(1)],
    [
      act(1, { scope: [E1], closure: true }),
      act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    ],
  );
  const detections = produced(snapshot);
  assert.equal(only(detections, 'D03').length, 1);
  // `D08` ne se déclenche pas : l'effet de clôture de `H1` est intact.
  assert.deepEqual(only(detections, 'D08'), []);
});

test('S10 — `D03` : récence et contradiction ne le déclenchent pas', () => {
  const snapshot = snapshotOf([unit(1)], [act(1, { scope: [E1] }), act(2, { scope: [E1] })]);
  assert.deepEqual(only(produced(snapshot), 'D03'), []);
});

// --------------------------------------------------------------------------
// `D04` — actes courants multiples sur une même unité
// --------------------------------------------------------------------------

test('S10 — `D04` : deux actes courants ⇒ positif ; un supersédé ⇒ négatif', () => {
  const two = snapshotOf([unit(1)], [act(1, { scope: [E1] }), act(2, { scope: [E1] })]);
  assert.deepEqual(only(produced(two), 'D04'), [
    { category: 'D04', controversy_id: CTV, unit: E1 },
  ]);

  const superseded = snapshotOf(
    [unit(1)],
    [
      act(1, { scope: [E1] }),
      act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    ],
  );
  assert.deepEqual(only(produced(superseded), 'D04'), []);

  const single = snapshotOf([unit(1)], [act(1, { scope: [E1] })]);
  assert.deepEqual(only(produced(single), 'D04'), []);
});

test('S10 — `D04` réparé : signale sans résoudre, et sans cardinal', () => {
  const snapshot = snapshotOf(
    [unit(1)],
    [
      act(1, { scope: [E1], closure: true }),
      act(2, { scope: [E1] }),
      act(3, { scope: [E1] }),
    ],
  );
  const detections = only(produced(snapshot), 'D04');
  assert.equal(detections.length, 1);
  // Aucun acte n'est nommé, aucun n'est départagé, aucun compte n'est rendu.
  const signalled = detections[0];
  assert.ok(signalled, "`D04` est observée sur l'unité");
  assert.deepEqual(Object.keys(signalled).sort(), ['category', 'controversy_id', 'unit']);
  // Une clôture courante coexiste : `D04` ne consulte pas cette dimension.
  assert.deepEqual(only(produced(snapshot), 'D02'), []);
});

// --------------------------------------------------------------------------
// `D05` — proposition sans réponse humaine enregistrée
// --------------------------------------------------------------------------

test('S10 — `D05` : positif sans référence ; négatif dès qu\'une réponse existe', () => {
  const orphan = snapshotOf([unit(1)], [proposal(1, [E1])]);
  assert.deepEqual(only(produced(orphan), 'D05'), [
    { category: 'D05', controversy_id: CTV, proposal_id: id(1) },
  ]);

  for (const mode of ['ACCEPT', 'REJECT'] as const) {
    const answered = snapshotOf([unit(1)], [proposal(1, [E1]), response(2, id(1), mode)]);
    assert.deepEqual(only(produced(answered), 'D05'), [], `mode ${mode}`);
  }
});

test('S10 — `D05` : un acte humain qui référence la proposition compte aussi', () => {
  for (const relation of ['ADOPTS', 'MODIFIES', 'REPLACES'] as const) {
    const entries = [
      proposal(1, [E1]),
      act(2, {
        scope: [E1],
        respondsTo:
          relation === 'ADOPTS'
            ? { proposal_id: id(1), relation, adopted_option_id: 'oa' }
            : { proposal_id: id(1), relation },
      }),
    ];
    assert.deepEqual(only(produced(snapshotOf([unit(1)], entries)), 'D05'), [], relation);
  }
  // Une référence à une AUTRE proposition ne compte pas.
  const foreign = snapshotOf(
    [unit(1)],
    [proposal(1, [E1]), proposal(2, [E1]), response(3, id(2), 'ACCEPT')],
  );
  assert.deepEqual(only(produced(foreign), 'D05'), [
    { category: 'D05', controversy_id: CTV, proposal_id: id(1) },
  ]);
});

// --------------------------------------------------------------------------
// `D06` — acte dont la provenance est une décision legacy
// --------------------------------------------------------------------------

test('S10 — `D06` : `LEGACY_DECISION` ⇒ positif ; autre provenance ⇒ négatif', () => {
  const snapshot = snapshotOf(
    [unit(1)],
    [
      act(1, { scope: [E1], provenance: { kind: 'LEGACY_DECISION', decision_id: 'DEC-0007' } }),
      act(2, { scope: [E1], provenance: { kind: 'DECLARED', statement: 'décidé en revue' } }),
      act(3, {
        scope: [E1],
        provenance: { kind: 'CONTROVERSY_AUTHORITY', entry_id: E1 },
      }),
    ],
  );
  assert.deepEqual(only(produced(snapshot), 'D06'), [
    { category: 'D06', controversy_id: CTV, act_id: id(1) },
  ]);
});

test('S10 — `D06` : une RÉPONSE de provenance legacy n\'est pas un acte', () => {
  // §13.1 — `RESPONSE ≠ AUTHORITATIVE HUMAN ACT`. Le contrat nomme `D06` sur un
  // « acte », et une réponse n'en est pas un, quelle que soit sa provenance.
  const snapshot = snapshotOf(
    [unit(1)],
    [
      proposal(1, [E1]),
      response(2, id(1), 'ACCEPT', { kind: 'LEGACY_DECISION', decision_id: 'DEC-0009' }),
    ],
  );
  assert.deepEqual(only(produced(snapshot), 'D06'), []);
});

// --------------------------------------------------------------------------
// `D07` — ancrage de citation non résolvable dans le périmètre
// --------------------------------------------------------------------------

test('S10 — `D07` : motif de non-résolution rendu tel quel, jamais interprété', () => {
  const snapshot = snapshotOf(
    [
      unit(1, CTV, { event_id: 'evt_absent', quoted_text: 'ceci', occurrence: 1 }),
      unit(2, CTV, { event_id: 'evt_000020', quoted_text: 'présent', occurrence: 1 }),
    ],
    [],
    [{ event_id: 'evt_000020', content: 'un texte où présent figure' }],
  );
  // Seul l'ancrage non résolvable produit une détection, avec son motif exact.
  assert.deepEqual(only(produced(snapshot), 'D07'), [
    { category: 'D07', controversy_id: CTV, entry_id: E1, reason: 'EVENT_NOT_FOUND' },
  ]);
});

test('S10 — `D07` : les trois motifs techniques sont distingués, sans jugement', () => {
  const snapshot = snapshotOf(
    [
      unit(1, CTV, { event_id: 'evt_absent', quoted_text: 'a', occurrence: 1 }),
      unit(2, CTV, { event_id: 'evt_muet', quoted_text: 'a', occurrence: 1 }),
      unit(3, CTV, { event_id: 'evt_000020', quoted_text: 'zzz', occurrence: 1 }),
    ],
    [],
    [
      { event_id: 'evt_muet', content: null },
      { event_id: 'evt_000020', content: 'un texte' },
    ],
  );
  assert.deepEqual(
    only(produced(snapshot), 'D07').map((d) => ('reason' in d ? d.reason : '')),
    ['EVENT_NOT_FOUND', 'CONTENT_UNAVAILABLE', 'OCCURRENCE_NOT_FOUND'],
  );
  // `UNRESOLVABLE` est un fait technique : aucune sortie ne le convertit en
  // faux, en insuffisant, ni en erreur de citation.
  for (const detection of only(produced(snapshot), 'D07')) {
    assert.equal('valid' in detection, false);
    assert.equal('error' in detection, false);
  }
});

// --------------------------------------------------------------------------
// `D08` — effet de clôture retiré sur une unité
// --------------------------------------------------------------------------

test('S10 — `D08` : retrait ⇒ positif, par unité ; sans retrait ⇒ négatif', () => {
  const snapshot = snapshotOf(
    [unit(1), unit(2)],
    [
      act(1, { scope: [E1, E2], closure: true }),
      act(2, { scope: [E1, E2], withdraws: { closures: [id(1)], scope: [E1] } }),
    ],
  );
  assert.deepEqual(only(produced(snapshot), 'D08'), [
    { category: 'D08', controversy_id: CTV, unit: E1, act_id: id(1) },
  ]);
});

test('S10 — `D08` : sans clôture déclarée, aucun effet ne peut être retiré', () => {
  // L'acte est supersédé mais ne déclarait aucune clôture : `D08` reste muet.
  // Un `D08` fondé sur la supersession échouerait ici.
  const snapshot = snapshotOf(
    [unit(1)],
    [
      act(1, { scope: [E1] }),
      act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    ],
  );
  assert.deepEqual(only(produced(snapshot), 'D08'), []);
});

test('S10 — `D08` : le retrait nominatif ne touche pas la clôture voisine', () => {
  const snapshot = snapshotOf(
    [unit(1)],
    [
      act(1, { scope: [E1], closure: true }),
      act(2, { scope: [E1], closure: true }),
      act(3, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } }),
    ],
  );
  assert.deepEqual(only(produced(snapshot), 'D08'), [
    { category: 'D08', controversy_id: CTV, unit: E1, act_id: id(1) },
  ]);
  // Une clôture demeure courante : `D02` ne se déclenche pas.
  assert.deepEqual(only(produced(snapshot), 'D02'), []);
});

// --------------------------------------------------------------------------
// Ordre, cardinalité, portée d'observation
// --------------------------------------------------------------------------

test('S10 — ordre : catégories du §14.2 puis ordre d\'append, jamais une préférence', () => {
  const snapshot = snapshotOf(
    [unit(3, CTV), unit(1, CTV), unit(2, CTV_B)],
    [
      act(1, { scope: [E1], closure: true }),
      act(2, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } }),
      proposal(3, [E1]),
    ],
  );
  const detections = produced(snapshot);
  const categories = detections.map((detection) => detection.category);
  // Les catégories apparaissent dans l'ordre de l'ensemble fermé du §14.2 : la
  // suite des rangs est non décroissante. Une sortie regroupée autrement — par
  // unité, par acte, par sévérité — romprait cette propriété.
  assert.ok(categories.length >= 4);
  for (let index = 1; index < categories.length; index += 1) {
    const previousCategory = categories[index - 1];
    const currentCategory = categories[index];
    assert.ok(previousCategory, `catégorie absente au rang ${index - 1}`);
    assert.ok(currentCategory, `catégorie absente au rang ${index}`);
    const previous = DETECTION_CATEGORIES.indexOf(previousCategory);
    const current = DETECTION_CATEGORIES.indexOf(currentCategory);
    assert.ok(previous <= current, `ordre rompu : ${previousCategory} → ${currentCategory}`);
  }
  // À l'intérieur de `D01`, l'ordre est celui du journal V3 — `E3` a été
  // enregistré avant `E1`, et la sortie ne le range pas.
  assert.deepEqual(
    only(detections, 'D01').map((d) => ('unit' in d ? d.unit : '')),
    [E3, E2],
  );
});

test('S10 — cardinalité : `D02` et `D08` coexistent sur la même unité, sans fusion', () => {
  const snapshot = snapshotOf(
    [unit(1)],
    [
      act(1, { scope: [E1], closure: true }),
      act(2, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } }),
    ],
  );
  const detections = produced(snapshot);
  assert.equal(only(detections, 'D02').length, 1);
  assert.equal(only(detections, 'D08').length, 1);
  // Deux observations distinctes : « aucun effet courant ici » et « cet effet
  // déclaré y a été retiré ». Aucun dédoublonnage ne les confond.
  const absent = only(detections, 'D02')[0];
  const withdrawn = only(detections, 'D08')[0];
  assert.ok(absent, '`D02` est observée sur cette unité');
  assert.ok(withdrawn, '`D08` est observée sur cette unité');
  assert.notDeepEqual(absent, withdrawn);
});

test('S10 — portée d\'observation : un journal V5 vide n\'affirme rien de plus', () => {
  const snapshot = snapshotOf([unit(1), unit(2)], []);
  const detections = produced(snapshot);
  // Les unités observées sont hors de tout périmètre et sans effet courant.
  assert.equal(only(detections, 'D01').length, 2);
  assert.equal(only(detections, 'D02').length, 2);
  // Rien d'autre n'est affirmé : aucune catégorie fondée sur des faits absents.
  for (const category of ['D03', 'D04', 'D05', 'D06', 'D07', 'D08'] as const) {
    assert.deepEqual(only(detections, category), [], category);
  }
  // Et un run SANS unité observée ne produit aucune détection — ce n'est pas
  // l'affirmation qu'aucune controverse n'existe. `UNKNOWN ≠ ZERO`.
  assert.deepEqual(produced(snapshotOf([], [])), []);
});
