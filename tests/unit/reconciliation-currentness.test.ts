/**
 * Preuves de la tranche S9 — les **deux** actualités dérivées.
 *
 * Classe de preuve : `FIXTURE`. Les journaux sont construits en mémoire, chaque
 * enregistrement passant par `validateReconciliationEntry` : les fixtures sont
 * donc des entrées V5 réellement bien formées, non des objets arbitraires. Un
 * audit `STATIC` du source complète l'ensemble pour la pureté du module.
 *
 * ```text
 * FIXTURE JOURNAL  ≠  REAL RECORDED HISTORY
 * ```
 *
 * Aucune écriture, aucun verrou, aucun processus, aucun fournisseur.
 *
 * ```text
 * DECISION CURRENTNESS  ≠  CLOSURE-EFFECT CURRENTNESS
 * CURRENTNESS           ≠  TRUTH · MERITS · CONVERGENCE · LIFECYCLE
 * ```
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
  ProposalResponseRecordedEntry,
  ReconciliationEntry,
  ReconciliationProposedEntry,
  ReconciliationRecordedEntry,
  ResponseMode,
} from '../../src/core/reconciliation.ts';
import { formatControversyEntryId, formatControversyId } from '../../src/core/controversy.ts';
import {
  CURRENTNESS_REFUSAL_REASONS,
  currentClosureEffects,
  currentDecisions,
} from '../../src/services/reconciliation-currentness.ts';
import { isCcrError } from '../../src/core/errors.ts';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);
const E3 = formatControversyEntryId(3);
const REVISION = `rcn-sha256:${'0'.repeat(64)}`;

/** Identité `rcn_` d'une fixture, pour la nommer avant de la construire. */
function id(sequence: number): string {
  return formatReconciliationId(sequence);
}

interface ActOptions {
  readonly scope?: readonly string[];
  readonly closure?: boolean;
  readonly withdraws?: { readonly closures: readonly string[]; readonly scope: readonly string[] };
  readonly supersedes?: readonly { readonly act: string; readonly scope: readonly string[] }[];
  readonly respondsTo?: ActRespondsTo;
  readonly content?: string;
}

/**
 * Un acte humain valide.
 *
 * `recorded_at` croît avec la séquence, et l'identité `rcn_` aussi : toute
 * fixture où un acte « plus récent » n'emporte rien le prouve avec les deux
 * marqueurs de récence à la fois.
 */
function act(sequence: number, options: ActOptions = {}): ReconciliationRecordedEntry {
  const entry: Record<string, unknown> = {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: id(sequence),
    kind: 'RECONCILIATION_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: `2026-01-01T00:${String(sequence).padStart(2, '0')}:00.000Z`,
    observed_revision: REVISION,
    scope_kind: 'SUBSET',
    scope: options.scope ?? [E1],
    content: options.content ?? `décision humaine ${String(sequence)}`,
    provenance: { kind: 'DECLARED', statement: 'décidé en revue' },
  };
  if (options.closure === true) {
    entry['closure'] = { declared: true, statement: `clôture déclarée par ${id(sequence)}` };
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
  return validateReconciliationEntry(
    entry as unknown as ReconciliationEntry,
  ) as ReconciliationRecordedEntry;
}

/** Une proposition CCR valide — aucun effet, aucune autorité. */
function proposal(sequence: number, scope: readonly string[] = [E1]): ReconciliationProposedEntry {
  const entry: Record<string, unknown> = {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: id(sequence),
    kind: 'RECONCILIATION_PROPOSED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'CCR',
    recorded_by: 'CCR',
    recorded_at: `2026-01-01T00:${String(sequence).padStart(2, '0')}:00.000Z`,
    observed_revision: REVISION,
    scope_kind: 'SUBSET',
    scope: [...scope],
    derivation: { method: 'DETERMINISTIC', inputs: [] },
    options: [{ option_id: 'oa', content: 'option a' }],
  };
  return validateReconciliationEntry(
    entry as unknown as ReconciliationEntry,
  ) as ReconciliationProposedEntry;
}

/** Une réponse humaine valide — aucun effet, aucun périmètre. */
function response(
  sequence: number,
  proposalId: string,
  mode: ResponseMode,
): ProposalResponseRecordedEntry {
  const entry: Record<string, unknown> = {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: id(sequence),
    kind: 'PROPOSAL_RESPONSE_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: `2026-01-01T00:${String(sequence).padStart(2, '0')}:00.000Z`,
    observed_revision: REVISION,
    provenance: { kind: 'DECLARED', statement: 'répondu en revue' },
    responds_to: { proposal_id: proposalId, mode },
  };
  return validateReconciliationEntry(
    entry as unknown as ReconciliationEntry,
  ) as ProposalResponseRecordedEntry;
}

const MODULE_URL = new URL('../../src/services/reconciliation-currentness.ts', import.meta.url);

/**
 * Le source privé de ses commentaires.
 *
 * Un interdit peut être **cité** dans la documentation — « INTERDIT latest
 * closure wins » en est un. L'audit porte donc sur le code exécutable, jamais
 * sur la prose qui le motive.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Le corps d'une fonction du module, sans son commentaire de documentation. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `fonction introuvable : ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `fin de corps introuvable : ${name}`);
  return source.slice(start, end);
}

// --------------------------------------------------------------------------
// Pureté — audit STATIC et non-mutation
// --------------------------------------------------------------------------

test('S9 — le module n\'importe ni écriture, ni verrou, ni horloge, ni fournisseur', async () => {
  const source = codeOnly(await readFile(MODULE_URL, 'utf8'));
  const specifiers = [...source.matchAll(/from '([^']+)';/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(specifiers)].sort(), [
    '../core/errors.ts',
    '../core/reconciliation.ts',
  ]);
  // Aucune écriture canonique : le chemin d'append, le verrou et la frontière de
  // mutation ne sont pas atteignables depuis ce module.
  for (const forbidden of [
    'node:fs',
    'store/',
    'appendReconciliation',
    'withNativeMutation',
    'acquireRunLock',
    'Date.now',
    'new Date',
    'adapter',
  ]) {
    assert.equal(source.includes(forbidden), false, `motif interdit présent : ${forbidden}`);
  }
  // Aucun pointeur mutable, ici ou ailleurs (§19.5).
  for (const pointer of [
    'is_current',
    'current_decision_id',
    'current_closure',
    'closure_effect_current',
    'superseded_flag',
    'withdrawn_flag',
  ]) {
    assert.equal(source.includes(pointer), false, `pointeur mutable présent : ${pointer}`);
  }
  // Aucun cycle de vie global (§21.6), aucune convergence (§23).
  for (const lifecycle of ['REOPENED', 'RESOLVED', 'CONVERGED', 'DISAGREEMENT']) {
    assert.equal(source.includes(lifecycle), false, `état global présent : ${lifecycle}`);
  }
  // Aucune anticipation de `S10` : les catégories `D01`–`D08` ne sont pas
  // produites ici, sous aucun nom.
  for (const detection of ['FULLY_COVERED', 'PARTIALLY', 'DETECTED', 'D01', 'D02']) {
    assert.equal(source.includes(detection), false, `détection anticipée : ${detection}`);
  }
  // Aucun classement (§26).
  for (const ranking of ['sort(', 'latest', 'winner', 'rank', 'score']) {
    assert.equal(source.includes(ranking), false, `classement présent : ${ranking}`);
  }
});

test('S9 — les deux dérivations ne partagent aucun fait lu', async () => {
  const source = await readFile(MODULE_URL, 'utf8');
  // Contrôle de non-vacuité : l'extraction rend bien du code, et chaque
  // dérivation lit effectivement SES faits. Sans ce contrôle, les assertions
  // négatives passeraient sur une chaîne vide.
  assert.ok(bodyOf(source, 'currentDecisions').includes('supersessionRecordedAgainst'));
  assert.ok(bodyOf(source, 'supersessionRecordedAgainst').includes('supersession_scope'));
  assert.ok(bodyOf(source, 'currentClosureEffects').includes('closure'));
  assert.ok(bodyOf(source, 'withdrawalRecordedAgainst').includes('withdrawal_scope'));
  // A — l'actualité de décision ne lit ni clôture ni retrait.
  for (const name of ['currentDecisions', 'supersessionRecordedAgainst']) {
    const body = bodyOf(source, name);
    assert.equal(body.includes('closure'), false, `${name} lit une clôture`);
    assert.equal(body.includes('withdraw'), false, `${name} lit un retrait`);
  }
  // B — `C27` : l'actualité d'effet ne lit aucune supersession.
  for (const name of ['currentClosureEffects', 'withdrawalRecordedAgainst']) {
    const body = bodyOf(source, name);
    assert.equal(body.includes('supersed'), false, `${name} lit une supersession`);
  }
});

test('S9 — le journal fourni est rendu intact : aucune écriture, aucun marquage', () => {
  const entries: readonly ReconciliationEntry[] = [
    act(1, { scope: [E1, E2], closure: true }),
    act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    act(3, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } }),
  ];
  const before = JSON.stringify(entries);
  currentDecisions(entries, E1);
  currentDecisions(entries, E2);
  currentClosureEffects(entries, E1);
  currentClosureEffects(entries, E2);
  assert.equal(JSON.stringify(entries), before);
  assert.equal(entries.length, 3);
});

// --------------------------------------------------------------------------
// A — Actualité de décision (§19)
// --------------------------------------------------------------------------

test('S9 — une supersession explicite rend l\'acte visé non courant sur son unité', () => {
  const h1 = act(1, { scope: [E1] });
  const h2 = act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] });
  const entries = [h1, h2];
  assert.deepEqual(currentDecisions(entries, E1), [id(2)]);
});

test('S9 — récence et contradiction n\'engendrent aucune supersession : deux actes courants', () => {
  // `H2` est postérieur (horodatage ET identité), porte le même périmètre et un
  // contenu contradictoire, et ne déclare AUCUNE relation.
  const entries = [
    act(1, { scope: [E1], content: 'nous retenons A' }),
    act(2, { scope: [E1], content: 'nous retenons non-A' }),
  ];
  assert.deepEqual(currentDecisions(entries, E1), [id(1), id(2)]);
  // `P15` · `C25` — l'ensemble est rendu, aucun membre n'est départagé.
  assert.equal(currentDecisions(entries, E1).length, 2);
});

test('S9 — supersession partielle : la granularité par unité est préservée', () => {
  const entries = [
    act(1, { scope: [E1, E2] }),
    act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
  ];
  assert.deepEqual(currentDecisions(entries, E1), [id(2)]);
  // `H1` conserve son statut sur `E2` : aucune suppression globale.
  assert.deepEqual(currentDecisions(entries, E2), [id(1)]);
});

test('S9 — aucune résurrection : superséder un superséder ne réactive pas l\'acte antérieur', () => {
  const entries = [
    act(1, { scope: [E1] }),
    act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    act(3, { scope: [E1], supersedes: [{ act: id(2), scope: [E1] }] }),
  ];
  // `CR5-09` — le test porte sur l'existence de la relation, jamais sur
  // l'actualité de son auteur. `H2` est non courant, et `H1` DEMEURE non courant.
  assert.deepEqual(currentDecisions(entries, E1), [id(3)]);
});

test('S9 — non-transitivité : aucun arc absent n\'est fabriqué ni supposé', () => {
  const entries = [
    act(1, { scope: [E1] }),
    act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
    act(3, { scope: [E1], supersedes: [{ act: id(2), scope: [E1] }] }),
  ];
  // L'histoire contient exactement deux relations, et aucune `H3 → H1`.
  const relations = entries
    .filter((entry): entry is ReconciliationRecordedEntry => entry.kind === 'RECONCILIATION_RECORDED')
    .flatMap((entry) => (entry.supersedes ?? []).map((r) => `${entry.entry_id}→${r.superseded_act_id}`));
  assert.deepEqual(relations, [`${id(2)}→${id(1)}`, `${id(3)}→${id(2)}`]);
  assert.equal(relations.includes(`${id(3)}→${id(1)}`), false);
  // La dérivation ne l'ajoute pas non plus : elle n'écrit rien.
  currentDecisions(entries, E1);
  assert.deepEqual(
    (entries[2] as ReconciliationRecordedEntry).supersedes,
    [{ superseded_act_id: id(2), supersession_scope: [E1] }],
  );
});

test('S9 — réciprocité à périmètres disjoints : la dérivation reste par unité', () => {
  // État historique synthétique admis par `C22` : `X` supersède `Y` sur `E1`,
  // `Y` supersède `X` sur `E2`. Aucun cycle sur une même unité.
  const x = act(1, { scope: [E1, E2], supersedes: [{ act: id(2), scope: [E1] }] });
  const y = act(2, { scope: [E1, E2], supersedes: [{ act: id(1), scope: [E2] }] });
  const entries = [x, y];
  assert.deepEqual(currentDecisions(entries, E1), [id(1)]);
  assert.deepEqual(currentDecisions(entries, E2), [id(2)]);
  // Un algorithme global aurait rendu les deux unités vides. Ce test n'établit
  // rien sur l'acyclicité d'écriture : celle-ci appartient à `S6`.
});

test('S9 — une proposition et une réponse ne sont jamais des décisions courantes', () => {
  const entries = [
    proposal(1, [E1]),
    response(2, id(1), 'ACCEPT'),
    response(3, id(1), 'REJECT'),
    act(4, {
      scope: [E1],
      respondsTo: { proposal_id: id(1), relation: 'ADOPTS', adopted_option_id: 'oa' },
    }),
  ];
  // Seul l'acte humain figure. `ACCEPT`, `REJECT` et `ADOPTS` n'ajoutent rien et
  // ne retirent rien par eux-mêmes.
  assert.deepEqual(currentDecisions(entries, E1), [id(4)]);
  assert.deepEqual(currentClosureEffects(entries, E1), []);
});

test('S9 — l\'ordre rendu est celui du journal, et n\'est pas la règle sémantique', () => {
  const h1 = act(1, { scope: [E1] });
  const h2 = act(2, { scope: [E1] });
  const h3 = act(3, { scope: [E1] });
  // Ordre d'append : le résultat le suit, sans tri ni mise en avant.
  assert.deepEqual(currentDecisions([h1, h2, h3], E1), [id(1), id(2), id(3)]);
  // Un journal permuté rend le même ensemble : l'ordre n'a aucune valeur
  // sémantique, et aucun ordre canonique n'est reconstruit ici.
  assert.deepEqual(
    [...currentDecisions([h3, h1, h2], E1)].sort(),
    [...currentDecisions([h1, h2, h3], E1)].sort(),
  );
  assert.deepEqual(currentDecisions([h3, h1, h2], E1), [id(3), id(1), id(2)]);
});

// --------------------------------------------------------------------------
// B — Actualité d'effet de clôture (§20)
// --------------------------------------------------------------------------

test('S9 — une clôture déclarée est courante sur chaque unité de son périmètre', () => {
  const entries = [act(1, { scope: [E1, E2], closure: true }), act(2, { scope: [E3] })];
  assert.deepEqual(currentClosureEffects(entries, E1), [id(1)]);
  assert.deepEqual(currentClosureEffects(entries, E2), [id(1)]);
  // `H2` ne déclare aucune clôture : aucun effet n'est inventé pour lui.
  assert.deepEqual(currentClosureEffects(entries, E3), []);
});

test('S9 — seul un retrait explicite rend un effet de clôture non courant', () => {
  const closure = act(1, { scope: [E1], closure: true });
  assert.deepEqual(currentClosureEffects([closure], E1), [id(1)]);
  const withdrawal = act(2, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } });
  assert.deepEqual(currentClosureEffects([closure, withdrawal], E1), []);
  // La déclaration historique demeure enregistrée et lisible (§21.4).
  assert.equal(closure.closure?.declared, true);
});

test('S9 — retrait partiel : la partie non retirée demeure courante', () => {
  const entries = [
    act(1, { scope: [E1, E2], closure: true }),
    act(2, { scope: [E1, E2], withdraws: { closures: [id(1)], scope: [E1] } }),
  ];
  assert.deepEqual(currentClosureEffects(entries, E1), []);
  assert.deepEqual(currentClosureEffects(entries, E2), [id(1)]);
});

test('S9 — le retrait est nominatif : partager une unité ne retire pas la clôture voisine', () => {
  const entries = [
    act(1, { scope: [E1], closure: true }),
    act(2, { scope: [E1], closure: true }),
    // Le retrait ne nomme QUE la clôture de `H1`, sur la même unité.
    act(3, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } }),
  ];
  assert.deepEqual(currentClosureEffects(entries, E1), [id(2)]);
});

test('S9 — plusieurs clôtures sur une même unité sont rendues comme un ensemble', () => {
  const entries = [
    act(1, { scope: [E1], closure: true }),
    act(2, { scope: [E1], closure: true }),
    act(3, { scope: [E1], closure: true }),
  ];
  // Aucun `latest closure wins` : les trois effets sont courants.
  assert.deepEqual(currentClosureEffects(entries, E1), [id(1), id(2), id(3)]);
});

test('S9 — retrait répété : déterministe et idempotent, sans issue nouvelle', () => {
  const closure = act(1, { scope: [E1], closure: true });
  const first = act(2, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } });
  const second = act(3, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } });
  const once = currentClosureEffects([closure, first], E1);
  const twice = currentClosureEffects([closure, first, second], E1);
  assert.deepEqual(once, []);
  assert.deepEqual(twice, []);
  // Le second retrait n'emporte pas sur le premier, n'est pas une erreur, et ne
  // crée aucune sorte d'actualité supplémentaire.
  assert.deepEqual(twice, once);
  assert.deepEqual(currentClosureEffects([closure, second, first], E1), once);
});

test('S9 — `C27` : superséder l\'acte porteur ne retire pas son effet de clôture', () => {
  const entries = [
    act(1, { scope: [E1], closure: true }),
    act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
  ];
  // La décision `H1` n'est plus courante…
  assert.deepEqual(currentDecisions(entries, E1), [id(2)]);
  // …et son effet de clôture l'est toujours. La dérivation d'effet ne filtre
  // jamais les clôtures par l'actualité décisionnelle de leur acte.
  assert.deepEqual(currentClosureEffects(entries, E1), [id(1)]);
});

test('S9 — superséder l\'acte de retrait ne restaure pas la clôture retirée', () => {
  const entries = [
    act(1, { scope: [E1], closure: true }),
    act(2, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } }),
    act(3, { scope: [E1], supersedes: [{ act: id(2), scope: [E1] }] }),
  ];
  // §20.3 teste l'existence du retrait ENREGISTRÉ, jamais l'actualité de son
  // auteur ; §20.1 exclut la supersession des entrées de ce calcul.
  assert.deepEqual(currentDecisions(entries, E1), [id(1), id(3)]);
  assert.deepEqual(currentClosureEffects(entries, E1), []);
});

test('S9 — §20.4 : rien d\'autre qu\'un retrait explicite ne rouvre un effet', () => {
  const closure = act(1, { scope: [E1], closure: true });
  const cases: readonly (readonly ReconciliationEntry[])[] = [
    // récence et décision nouvelle
    [closure, act(2, { scope: [E1], content: 'décision postérieure' })],
    // contradiction
    [closure, act(3, { scope: [E1], content: 'nous retenons le contraire' })],
    // supersession
    [closure, act(4, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] })],
    // proposition CCR
    [closure, proposal(5, [E1])],
    // réponse `REJECT`
    [closure, proposal(6, [E1]), response(7, id(6), 'REJECT')],
    // relation `REPLACES` à une proposition — jamais une supersession
    [
      closure,
      proposal(8, [E1]),
      act(9, { scope: [E1], respondsTo: { proposal_id: id(8), relation: 'REPLACES' } }),
    ],
    // silence
    [closure],
  ];
  for (const entries of cases) {
    assert.deepEqual(currentClosureEffects(entries, E1), [id(1)]);
  }
});

// --------------------------------------------------------------------------
// `CR5-01` — la séparation, prouvée sur un pivot
// --------------------------------------------------------------------------

test('S9 — `CR5-01` pivot : supersession sans retrait sépare les deux actualités', () => {
  const h1 = act(1, { scope: [E1], closure: true });
  const h2 = act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] });
  const entries = [h1, h2];
  // A — l'actualité de DÉCISION est affectée par la supersession.
  assert.deepEqual(currentDecisions(entries, E1), [id(2)]);
  // B — l'EFFET DE CLÔTURE historique demeure courant : aucun acte humain ne l'a
  // explicitement retiré.
  assert.deepEqual(currentClosureEffects(entries, E1), [id(1)]);
});

test('S9 — un retrait explicite ne modifie que la projection d\'effet', () => {
  const h1 = act(1, { scope: [E1], closure: true });
  const h2 = act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] });
  const h3 = act(3, { scope: [E1], withdraws: { closures: [id(1)], scope: [E1] } });
  const before = [h1, h2];
  const after = [h1, h2, h3];
  // L'effet bascule…
  assert.deepEqual(currentClosureEffects(before, E1), [id(1)]);
  assert.deepEqual(currentClosureEffects(after, E1), []);
  // …et l'actualité de décision de `H1` est inchangée par `H3`, qui ne déclare
  // aucune supersession. `WITHDRAWAL ≠ SUPERSESSION`.
  assert.deepEqual(currentDecisions(before, E1), [id(2)]);
  assert.deepEqual(currentDecisions(after, E1), [id(2), id(3)]);
  assert.equal(currentDecisions(after, E1).includes(id(1)), false);
});

// --------------------------------------------------------------------------
// `C28` — la matrice `A`–`E` du §21.5, cas par cas
// --------------------------------------------------------------------------

test('S9 — §21.5 cas `A` : supersession seule, clôture inchangée', () => {
  const entries = [
    act(1, { scope: [E1], closure: true }),
    act(2, { scope: [E1], supersedes: [{ act: id(1), scope: [E1] }] }),
  ];
  assert.deepEqual(currentDecisions(entries, E1), [id(2)]);
  assert.deepEqual(currentClosureEffects(entries, E1), [id(1)]);
});

test('S9 — §21.5 cas `B` : supersession et clôture nouvelle', () => {
  const entries = [
    act(1, { scope: [E1], closure: true }),
    act(2, { scope: [E1], closure: true, supersedes: [{ act: id(1), scope: [E1] }] }),
  ];
  assert.deepEqual(currentDecisions(entries, E1), [id(2)]);
  // Effet AJOUTÉ sur le périmètre de `H2`, celui de `H1` demeurant courant.
  assert.deepEqual(currentClosureEffects(entries, E1), [id(1), id(2)]);
});

test('S9 — §21.5 cas `C` : supersession et retrait sur `S`', () => {
  const entries = [
    act(1, { scope: [E1, E2], closure: true }),
    act(2, {
      scope: [E1, E2],
      supersedes: [{ act: id(1), scope: [E1, E2] }],
      withdraws: { closures: [id(1)], scope: [E1] },
    }),
  ];
  assert.deepEqual(currentDecisions(entries, E1), [id(2)]);
  assert.deepEqual(currentDecisions(entries, E2), [id(2)]);
  // Effet de `H1` retiré UNIQUEMENT sur `S` = {E1}.
  assert.deepEqual(currentClosureEffects(entries, E1), []);
  assert.deepEqual(currentClosureEffects(entries, E2), [id(1)]);
});

test('S9 — §21.5 cas `D` : retrait sans supersession', () => {
  const entries = [
    act(1, { scope: [E1, E2], closure: true }),
    act(2, { scope: [E1, E2], withdraws: { closures: [id(1)], scope: [E1] } }),
  ];
  // Actualité de décision INCHANGÉE : `H1` demeure courant sur les deux unités.
  assert.deepEqual(currentDecisions(entries, E1), [id(1), id(2)]);
  assert.deepEqual(currentDecisions(entries, E2), [id(1), id(2)]);
  assert.deepEqual(currentClosureEffects(entries, E1), []);
  assert.deepEqual(currentClosureEffects(entries, E2), [id(1)]);
});

test('S9 — §21.5 cas `E` : supersession sur `S1`, retrait sur `S2`', () => {
  const entries = [
    act(1, { scope: [E1, E2], closure: true }),
    act(2, {
      scope: [E1, E2],
      supersedes: [{ act: id(1), scope: [E1] }],
      withdraws: { closures: [id(1)], scope: [E2] } },
    ),
  ];
  // Décision : selon `S1` = {E1}.
  assert.deepEqual(currentDecisions(entries, E1), [id(2)]);
  assert.deepEqual(currentDecisions(entries, E2), [id(1), id(2)]);
  // Effet : retrait selon `S2` = {E2}.
  assert.deepEqual(currentClosureEffects(entries, E1), [id(1)]);
  assert.deepEqual(currentClosureEffects(entries, E2), []);
});

// --------------------------------------------------------------------------
// Domaine — absence et refus
// --------------------------------------------------------------------------

test('S9 — journal vide : `NONE` des deux côtés, sans affirmation historique', () => {
  assert.deepEqual(currentDecisions([], E1), []);
  assert.deepEqual(currentClosureEffects([], E1), []);
  // Un ensemble vide ne distingue pas un journal absent d'un journal sans acte :
  // cette distinction est portée par `reconciliation_revision`, que ce module ne
  // consomme pas. `UNKNOWN ≠ ZERO`.
});

test('S9 — une unité non canonique est refusée, jamais rendue vide', () => {
  assert.deepEqual([...CURRENTNESS_REFUSAL_REASONS], ['UNIT_NOT_CANONICAL']);
  for (const derive of [currentDecisions, currentClosureEffects]) {
    for (const unit of ['', 'ctve_1', 'ctv_000001', 'rcn_000001', 'E1']) {
      assert.throws(
        () => derive([], unit),
        (error: unknown) =>
          isCcrError(error) &&
          (error.details as { reason?: string } | undefined)?.reason === 'UNIT_NOT_CANONICAL',
        `unité acceptée à tort : ${unit}`,
      );
    }
  }
});
