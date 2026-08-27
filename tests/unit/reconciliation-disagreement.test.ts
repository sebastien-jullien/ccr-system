/**
 * Preuves de la tranche S11 — la vue dérivée du désaccord.
 *
 * Classe de preuve : `FIXTURE`. Chaque entrée V3 passe par
 * `validateControversyEntry` : les fixtures sont des faits V3 réellement bien
 * formés. Un audit `STATIC` complète les preuves négatives d'architecture.
 *
 * ```text
 * FIXTURE JOURNAL    ≠  REAL RECORDED HISTORY
 * DISAGREEMENT VIEW  ≠  NEW AUTHORITATIVE FACT
 * HUMAN DECISION     ≠  EXPERT AGREEMENT
 * CONVERGED          =  RESERVED
 * ```
 *
 * `S9` est importé **par ce test seulement**, pour établir les pivots : il faut
 * montrer que les actualités V5 bougent pendant que les signaux V3 ne bougent
 * pas. Le module S11, lui, n'en dépend pas — et ne peut pas en dépendre.
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
import type { ReconciliationEntry } from '../../src/core/reconciliation.ts';
import {
  currentClosureEffects,
  currentDecisions,
} from '../../src/services/reconciliation-currentness.ts';
import {
  DISAGREEMENT_SIGNALS,
  observedDisagreementSignals,
} from '../../src/services/reconciliation-disagreement.ts';

// --------------------------------------------------------------------------
// Fixtures V3
// --------------------------------------------------------------------------

const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);

let v3Sequence = 0;

function v3(over: Partial<ControversyEntry> = {}): ControversyEntry {
  v3Sequence += 1;
  return validateControversyEntry({
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(v3Sequence),
    controversy_id: CTV,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'SOURCE', actor: 'author' },
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000010', round: 1, expert_slot_id: 'author' }] },
    ...over,
  } as ControversyEntry);
}

/** Une relation V3, avec son acte déclaré. */
function relation(
  act: 'CONTESTS' | 'REFORMULATES' | 'WITHDRAWS',
  over: Partial<ControversyEntry> = {},
): ControversyEntry {
  return v3({
    kind: 'RELATION_RECORDED',
    relation: { from_entry_id: E2, to_entry_id: E1, act },
    ...over,
  });
}

/** Une autorité humaine V3. Origine `HUMAN` exigée par le domaine. */
function authority(
  act: 'ARBITRATION' | 'CONFIRM_RELATION' | 'CONTEST_RELATION',
): ControversyEntry {
  return v3({
    kind: 'HUMAN_AUTHORITY_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    authority: { act, target_entry_id: E1 },
  });
}

/** Une inférence CCR : origine `CCR`, donc `derivation` obligatoire. */
function inferred(over: Partial<ControversyEntry> = {}): ControversyEntry {
  return v3({
    semantic_origin: { kind: 'CCR' },
    derivation: { method: 'DETERMINISTIC_LOCAL', inputs: ['evt_000010'] },
    ...over,
  });
}

// --------------------------------------------------------------------------
// Fixtures V5 — pour les pivots seulement
// --------------------------------------------------------------------------

function rcn(sequence: number): string {
  return formatReconciliationId(sequence);
}

interface ActOptions {
  readonly closure?: boolean;
  readonly withdraws?: { readonly closures: readonly string[]; readonly scope: readonly string[] };
  readonly supersedes?: readonly { readonly act: string; readonly scope: readonly string[] }[];
}

function act(sequence: number, options: ActOptions = {}): ReconciliationEntry {
  const entry: Record<string, unknown> = {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: rcn(sequence),
    kind: 'RECONCILIATION_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: `2026-08-20T12:0${String(sequence)}:00.000Z`,
    observed_revision: `rcn-sha256:${'0'.repeat(64)}`,
    scope_kind: 'SUBSET',
    scope: [E1],
    content: `décision humaine ${String(sequence)}`,
    provenance: { kind: 'DECLARED', statement: 'décidé en revue' },
  };
  if (options.closure === true) {
    entry['closure'] = { declared: true, statement: 'clôture déclarée' };
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
    entry['supersedes'] = options.supersedes.map((r) => ({
      superseded_act_id: r.act,
      supersession_scope: [...r.scope],
    }));
  }
  return validateReconciliationEntry(entry as unknown as ReconciliationEntry);
}

const MODULE_URL = new URL('../../src/services/reconciliation-disagreement.ts', import.meta.url);

/** Le source privé de ses commentaires : un interdit peut être *cité*. */
function codeOnly(source: string): string {
  return source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// --------------------------------------------------------------------------
// Vocabulaire et architecture
// --------------------------------------------------------------------------

test('S11 — liste fermée de quatre signaux', () => {
  assert.deepEqual([...DISAGREEMENT_SIGNALS], ['S1', 'S2', 'S3', 'S4']);
});

test('S11 — aucune importation d\'exécution : la vue ne peut rien écrire', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  // Le module n'importe QUE des types. Aucune valeur n'entre, donc aucun
  // effet ne peut sortir : ni écriture, ni verrou, ni horloge, ni aléa.
  const imports = [...source.matchAll(/^import (type )?/gm)].map((match) => match[1]);
  assert.equal(imports.length, 1);
  assert.deepEqual(imports, ['type ']);
  for (const forbidden of [
    'node:fs',
    'store/',
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

test('S11 — aucun couplage V5 n\'est possible : rien de V5 n\'entre', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  // Toutes les entrées interdites par le gate sont exclues STRUCTURELLEMENT :
  // supersession, retrait, clôture, détections, propositions, réponses et les
  // deux actualités n'apparaissent nulle part, faute de pouvoir y entrer.
  for (const forbidden of [
    'reconciliation',
    'currentDecisions',
    'currentClosureEffects',
    'closure',
    'supersed',
    'withdraw',
    'PROPOSED',
    'RESPONSE',
    'ADOPTS',
    'ACCEPT',
    'REJECT',
    'detect',
    'D01',
    'D02',
    'D04',
  ]) {
    assert.equal(source.includes(forbidden), false, `entrée interdite : ${forbidden}`);
  }
});

test('S11 — `C37` : aucun `CONVERGED`, aucun cycle de vie, aucun score', async () => {
  const source = await readFile(MODULE_URL, 'utf8');
  const code = codeOnly(source);
  for (const forbidden of [
    'CONVERGED',
    'AGREED',
    'ALIGNED',
    'PERSISTENT_DISAGREEMENT',
    'RESOLVED',
    'REOPENED',
    'OPEN',
    'CLOSED',
    'score',
    'confidence',
    'probability',
    'severity',
    'priority',
    'weight',
    'rank',
    'maturity',
    'count',
    'intensity',
    'sort(',
    'correct',
    'winner',
    'reliab',
    'merit',
    'truth',
  ]) {
    assert.equal(code.includes(forbidden), false, `motif interdit : ${forbidden}`);
  }
  // `CONVERGED` n'apparaît que comme mot RÉSERVÉ dans la documentation, jamais
  // comme champ ni comme valeur.
  assert.ok(/CONVERGED\s+=\s+RESERVED/.test(source));
});

test('S11 — aucune écriture : les entrées fournies sont rendues intactes', () => {
  const entries = [relation('CONTESTS'), authority('CONTEST_RELATION'), v3({ kind: 'NATURE_RECORDED' })];
  const before = JSON.stringify(entries);
  observedDisagreementSignals(entries);
  observedDisagreementSignals(entries);
  assert.equal(JSON.stringify(entries), before);
  assert.equal(entries.length, 3);
});

// --------------------------------------------------------------------------
// Les quatre prédicats — positifs et négatifs discriminants
// --------------------------------------------------------------------------

test('S11 — `S1` : `CONTESTS` seul ; `REFORMULATES` n\'est pas un signal', () => {
  const contests = relation('CONTESTS');
  const reformulates = relation('REFORMULATES');
  const signals = observedDisagreementSignals([contests, reformulates]);
  assert.deepEqual(
    signals.map((s) => [s.signal, s.entry_id]),
    [['S1', contests.entry_id]],
  );
});

test('S11 — `S2` : `WITHDRAWS` est un fait attribué, jamais une clôture', () => {
  const withdraws = relation('WITHDRAWS');
  const signals = observedDisagreementSignals([withdraws]);
  assert.equal(signals.length, 1);
  const withdrawn = signals[0];
  assert.ok(withdrawn, 'le signal S2 est observé');
  assert.equal(withdrawn.signal, 'S2');
  // Le signal ne porte aucun champ de clôture, et n'en produit aucun.
  assert.equal('closure' in withdrawn, false);
  assert.deepEqual(Object.keys(withdrawn).sort(), [
    'anchors',
    'controversy_id',
    'entry_id',
    'semantic_origin',
    'signal',
  ]);
});

test('S11 — `S3` : `CONTEST_RELATION` seul ; `CONFIRM_RELATION` et `ARBITRATION` non', () => {
  const contest = authority('CONTEST_RELATION');
  const confirm = authority('CONFIRM_RELATION');
  const arbitration = authority('ARBITRATION');
  const signals = observedDisagreementSignals([confirm, arbitration, contest]);
  assert.deepEqual(
    signals.map((s) => [s.signal, s.entry_id]),
    [['S3', contest.entry_id]],
  );
});

test('S11 — `S4` : `NATURE_RECORDED` ; assertion et ouverture ne sont pas des signaux', () => {
  const nature = v3({ kind: 'NATURE_RECORDED' });
  const assertion = v3({ kind: 'ASSERTION_RECORDED' });
  const opening = v3({ kind: 'CONTROVERSY_RECORDED' });
  const signals = observedDisagreementSignals([assertion, opening, nature]);
  assert.deepEqual(
    signals.map((s) => [s.signal, s.entry_id]),
    [['S4', nature.entry_id]],
  );
});

// --------------------------------------------------------------------------
// Attribution
// --------------------------------------------------------------------------

test('S11 — l\'attribution de source est préservée telle quelle', () => {
  const asserted = relation('CONTESTS', {
    semantic_origin: { kind: 'SOURCE', actor: 'challenger' },
  });
  const signals = observedDisagreementSignals([asserted]);
  const bySource = signals[0];
  assert.ok(bySource, 'le signal attribué à la source est observé');
  assert.deepEqual(bySource.semantic_origin, { kind: 'SOURCE', actor: 'challenger' });
  // Ni renommée, ni aplatie, ni remplacée par un booléen.
  assert.equal(bySource.derivation, undefined);
});

test('S11 — une inférence CCR reste une inférence, avec son mécanisme', () => {
  const systemInferred = inferred({
    kind: 'RELATION_RECORDED',
    relation: { from_entry_id: E2, to_entry_id: E1, act: 'CONTESTS' },
  });
  const signals = observedDisagreementSignals([systemInferred]);
  const byCcr = signals[0];
  assert.ok(byCcr, "le signal d'origine CCR est observé");
  assert.equal(byCcr.semantic_origin.kind, 'CCR');
  // `PERSISTED ≠ TRUE` · `INFERRED ≠ OBSERVED` : la dérivation accompagne le
  // signal, et rien ne le promeut en assertion de source.
  assert.deepEqual(byCcr.derivation, {
    method: 'DETERMINISTIC_LOCAL',
    inputs: ['evt_000010'],
  });
  assert.notEqual(byCcr.semantic_origin.kind, 'SOURCE');
  assert.equal(byCcr.semantic_origin.actor, undefined);
});

test('S11 — les trois attributions coexistent sans être uniformisées', () => {
  const bySource = relation('CONTESTS', { semantic_origin: { kind: 'SOURCE', actor: 'author' } });
  const byHuman = authority('CONTEST_RELATION');
  const byCcr = inferred({ kind: 'NATURE_RECORDED' });
  const signals = observedDisagreementSignals([bySource, byHuman, byCcr]);
  assert.deepEqual(
    signals.map((s) => s.semantic_origin.kind),
    ['SOURCE', 'HUMAN', 'CCR'],
  );
});

test('S11 — l\'ancrage est rendu tel quel, sans reconstruction', () => {
  const anchored = relation('CONTESTS', {
    anchors: {
      provenance: [{ event_id: 'evt_000042', round: 3, expert_slot_id: 'challenger' }],
      textual: { event_id: 'evt_000042', quoted_text: 'la mesure est biaisée', occurrence: 2 },
    },
  });
  const signals = observedDisagreementSignals([anchored]);
  const rendered = signals[0];
  assert.ok(rendered, 'le signal ancré est observé');
  assert.deepEqual(rendered.anchors, anchored.anchors);
});

// --------------------------------------------------------------------------
// Ordre et absence
// --------------------------------------------------------------------------

test('S11 — ordre d\'append, sans regroupement par catégorie', () => {
  const nature = v3({ kind: 'NATURE_RECORDED' });
  const contests = relation('CONTESTS');
  const contest = authority('CONTEST_RELATION');
  const withdraws = relation('WITHDRAWS');
  const signals = observedDisagreementSignals([nature, contests, contest, withdraws]);
  // Une vue regroupée par catégorie rendrait `S1 S2 S3 S4` ; le journal impose
  // son ordre, et la position ne signifie rien.
  assert.deepEqual(
    signals.map((s) => s.signal),
    ['S4', 'S1', 'S3', 'S2'],
  );
});

test('S11 — absence de signal ne dit rien de plus que l\'absence de signal', () => {
  const quiet = [
    v3({ kind: 'ASSERTION_RECORDED' }),
    relation('REFORMULATES'),
    authority('CONFIRM_RELATION'),
  ];
  const signals = observedDisagreementSignals(quiet);
  assert.deepEqual(signals, []);
  // `INTERDIT absence de signal ⇒ accord` : la forme rendue est une suite vide,
  // et non un objet portant `agreement`, `converged` ou une disponibilité.
  assert.equal(Array.isArray(signals), true);
  assert.deepEqual(observedDisagreementSignals([]), []);
  // Un journal V3 vide et un journal sans signal rendent la même chose : cette
  // vue ne distingue pas les deux, et ne prétend pas le faire.
});

// --------------------------------------------------------------------------
// Pivots — coexistence et séquence `CR5-01`
// --------------------------------------------------------------------------

test('S11 — pivot : désaccord historique ET clôture humaine courante coexistent', () => {
  const contests = relation('CONTESTS', {
    semantic_origin: { kind: 'SOURCE', actor: 'challenger' },
  });
  const v3Entries = [contests];
  const v5Entries = [act(1, { closure: true })];

  // Un effet de clôture humain est courant sur `E1`…
  assert.deepEqual(currentClosureEffects(v5Entries, E1), [rcn(1)]);
  // …et le désaccord expert reste visible, attribué à son expert.
  const signals = observedDisagreementSignals(v3Entries);
  assert.deepEqual(signals.map((s) => s.signal), ['S1']);
  const contested = signals[0];
  assert.ok(contested, 'le désaccord historique est observé');
  assert.deepEqual(contested.semantic_origin, { kind: 'SOURCE', actor: 'challenger' });

  // `HUMAN DECISION ≠ EXPERT AGREEMENT` — la décision humaine n'a rien réécrit.
  assert.deepEqual(observedDisagreementSignals(v3Entries), signals);
  // `CLOSURE ≠ CONVERGENCE` — aucune sortie ne porte un accord.
  for (const signal of signals) {
    for (const forbidden of ['converged', 'agreed', 'agreement', 'resolved', 'status']) {
      assert.equal(forbidden in signal, false);
    }
  }
});

test('S11 — séquence `CR5-01` : les actualités bougent, les signaux ne bougent pas', () => {
  const v3Entries = [
    relation('CONTESTS', { semantic_origin: { kind: 'SOURCE', actor: 'author' } }),
    inferred({ kind: 'NATURE_RECORDED' }),
  ];
  const baseline = observedDisagreementSignals(v3Entries);
  assert.equal(baseline.length, 2);

  const h1 = act(1, { closure: true });
  const h2 = act(2, { supersedes: [{ act: rcn(1), scope: [E1] }] });
  const h3 = act(3, { withdraws: { closures: [rcn(1)], scope: [E1] } });

  const stages = [
    { label: 'clôture', v5: [h1] },
    { label: 'supersession sans retrait', v5: [h1, h2] },
    { label: 'retrait explicite', v5: [h1, h2, h3] },
  ];
  const observed: string[] = [];
  for (const stage of stages) {
    observed.push(
      `${String(currentDecisions(stage.v5, E1).length)}/${String(currentClosureEffects(stage.v5, E1).length)}`,
    );
    // À chaque étape, la vue est IDENTIQUE — octet pour octet.
    assert.deepEqual(observedDisagreementSignals(v3Entries), baseline, stage.label);
  }
  // Les actualités, elles, ont bien changé : décision puis effet. Sans cela le
  // test serait vide de contenu.
  assert.deepEqual(observed, ['1/1', '1/1', '2/0']);

  // Aucun état `DISAGREEMENT_RESTORED`, `REOPENED_DISAGREEMENT` ni
  // `PERSISTENT_DISAGREEMENT` n'apparaît après le retrait : la forme n'en a pas.
  const afterWithdrawal = observedDisagreementSignals(v3Entries);
  assert.deepEqual(
    afterWithdrawal.map((s) => s.signal),
    ['S1', 'S4'],
  );
  // Et l'inférence CCR est toujours qualifiée comme telle.
  const inference = afterWithdrawal[1];
  assert.ok(inference, "l'inférence CCR demeure observée après le retrait");
  assert.equal(inference.semantic_origin.kind, 'CCR');
  assert.notEqual(inference.derivation, undefined);
});
