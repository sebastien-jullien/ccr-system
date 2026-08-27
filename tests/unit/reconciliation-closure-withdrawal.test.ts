/**
 * Preuves de la tranche S7 — retrait explicite d'effet de clôture.
 *
 * Classe de preuve : `FIXTURE`.
 *
 * ```text
 * CLOSURE WITHDRAWAL  ≠  SUPERSESSION
 * CLOSURE WITHDRAWAL  ≠  HISTORY REWRITE
 * CLOSURE WITHDRAWAL  ≠  TRUTH CORRECTION
 * CLOSURE WITHDRAWAL  ≠  DISAGREEMENT
 * CLOSURE WITHDRAWAL  ≠  NEGATIVE CONVERGENCE
 * ```
 *
 * Ce fichier ne prouve **aucune** actualité d'effet : le §20.3 est la règle de
 * S9. S7 n'écrit que des faits historiques.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { readReconciliationJournal } from '../../src/store/reconciliation-store.ts';
import { readCurrentReconciliationRevision } from '../../src/services/reconciliation-freshness.ts';
import {
  RECONCILIATION_OUTCOMES,
  recordReconciliation,
} from '../../src/services/reconciliation-service.ts';
import type { RecordReconciliationInput } from '../../src/services/reconciliation-service.ts';
import { formatReconciliationId } from '../../src/core/reconciliation.ts';
import type { ClosureWithdrawalDeclaration } from '../../src/core/reconciliation.ts';
import { isCcrError } from '../../src/core/errors.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';

const RUN_ID = 'CCR-20260403-001';
const CTV = formatControversyId(1);
const OTHER_CTV = formatControversyId(2);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);
const E3 = formatControversyEntryId(3);
const FOREIGN = formatControversyEntryId(9);

const NOW = new Date('2026-08-20T12:00:00.000Z');
const deps = (runsDir: string): { runsDir: string; now(): Date } => ({ runsDir, now: () => NOW });

function v3Entry(sequence: number, controversyId = CTV): ControversyEntry {
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: controversyId,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-20T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  };
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  revision(): Promise<string>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s7-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's7', created_at: '2026-08-20T09:00:00.000Z',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'codex', session_id: 'S1' },
      challenger: { provider: 'claude', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000001',
    updated_at: '2026-08-20T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, `${JSON.stringify({
    event_id: 'evt_000001', run_id: RUN_ID, round: 1, timestamp: '2026-08-20T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: 'le cache doit expirer',
  })}\n`, 'utf8');
  await writeFile(
    paths.controversies,
    `${[v3Entry(1), v3Entry(2), v3Entry(3), v3Entry(9, OTHER_CTV)].map((e) => JSON.stringify(e)).join('\n')}\n`,
    'utf8',
  );
  return {
    runsDir,
    paths,
    revision: () => readCurrentReconciliationRevision({ runsDir }, RUN_ID),
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

function input(over: Partial<RecordReconciliationInput> = {}): RecordReconciliationInput {
  return {
    runId: RUN_ID,
    expected_revision: 'rcn-sha256:placeholder',
    target_controversy_id: CTV,
    scope_kind: 'SUBSET',
    scope: [E1, E2],
    content: 'ce que la personne a décidé',
    provenance: { kind: 'DECLARED', statement: 'décidé en revue' },
    ...over,
  } as RecordReconciliationInput;
}

async function refusalReason(body: () => Promise<unknown>): Promise<string> {
  let reason = '<aucun refus>';
  await assert.rejects(body, (error: unknown) => {
    assert.ok(isCcrError(error));
    const details = (error as { details?: Record<string, unknown> }).details ?? {};
    assert.equal(details['outcome'], 'REFUSED_VALIDATION');
    reason = String(details['reason']);
    return true;
  });
  return reason;
}

/** Un acte portant une clôture explicite — la cible des retraits à venir. */
async function seedClosure(h: Fixture, over: Partial<RecordReconciliationInput> = {}): Promise<string> {
  const result = await recordReconciliation(deps(h.runsDir), input({
    expected_revision: await h.revision(),
    closure: { declared: true, statement: 'clos sur ce périmètre' },
    ...over,
  }));
  return result.entry.entry_id;
}

/**
 * La forme canonique d'un retrait, telle que le domaine la déclare.
 *
 * Le type est celui de `S1` — non un sac de clés. Les cas négatifs restent
 * exprimables à l'identique : une liste vide, un doublon ou un périmètre vide
 * sont **structurellement typables** et refusés par le SERVICE, ce qui est
 * précisément ce que ces tests éprouvent.
 */
function withdrawal(
  targets: readonly string[],
  scope: readonly string[],
): ClosureWithdrawalDeclaration {
  return {
    declared: true,
    withdrawn_closures: targets,
    withdrawal_scope: scope,
    statement: 'retrait décidé en revue',
  };
}

// --------------------------------------------------------------------------
// C15 · C16 · P37 — le retrait valide
// --------------------------------------------------------------------------

test('C15 · V15 · C16 · P37 — un retrait explicite est enregistré, désignant sa cible', async () => {
  const h = await fixture();
  try {
    const h1 = await seedClosure(h);

    const h2 = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      closure_withdrawal: withdrawal([h1], [E1]),
    }) as RecordReconciliationInput);

    assert.equal(h2.outcome, 'RECORDED');
    const stored = h2.entry as unknown as Record<string, unknown>;
    assert.deepEqual(stored['closure_withdrawal'], {
      declared: true,
      withdrawn_closures: [h1],
      withdrawal_scope: [E1],
      statement: 'retrait décidé en revue',
    });
    // Le retrait est un effet DISTINCT : cet acte ne déclare aucune clôture.
    assert.equal('closure' in stored, false);
  } finally {
    await h.dispose();
  }
});

test('P38 — le retrait est scopé, et son périmètre est celui déclaré', async () => {
  const h = await fixture();
  try {
    // Clôture sur {E1, E2} ; retrait sur {E1} seulement.
    const h1 = await seedClosure(h, { scope: [E1, E2] });
    const h2 = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      scope: [E1, E2],
      closure_withdrawal: withdrawal([h1], [E1]),
    }) as RecordReconciliationInput);

    const stored = h2.entry as unknown as Record<string, unknown>;
    const declared = stored['closure_withdrawal'] as Record<string, unknown>;
    assert.deepEqual(declared['withdrawal_scope'], [E1],
      'ni élargi à {E1,E2}, ni réduit, ni recalculé.');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// P39 · historicité — rien n'est effacé
// --------------------------------------------------------------------------

test('P39 — la clôture historique demeure enregistrée et lisible', async () => {
  const h = await fixture();
  try {
    const h1 = await seedClosure(h);
    const before = await readFile(h.paths.reconciliations, 'utf8');

    await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      closure_withdrawal: withdrawal([h1], [E1]),
    }) as RecordReconciliationInput);

    const after = await readFile(h.paths.reconciliations, 'utf8');
    // L'acte de clôture est un préfixe exact du journal : ni modifié, ni marqué,
    // ni supprimé. REOPENING ≠ ERASURE OF HISTORICAL CLOSURE.
    assert.equal(after.startsWith(before), true);

    const journal = await readReconciliationJournal(h.paths);
    const closureAct = journal.entries.find((e) => e.entry_id === h1) as unknown as Record<string, unknown>;
    assert.deepEqual(closureAct['closure'], { declared: true, statement: 'clos sur ce périmètre' });
    // Les DEUX faits coexistent : déclaration et retrait.
    assert.equal(journal.entries.length, 2);
  } finally {
    await h.dispose();
  }
});

test('aucun état de cycle de vie, aucune actualité d\'effet n\'est persisté', async () => {
  const h = await fixture();
  try {
    const h1 = await seedClosure(h);
    await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      closure_withdrawal: withdrawal([h1], [E1]),
    }) as RecordReconciliationInput);

    const serialized = JSON.stringify((await readReconciliationJournal(h.paths)).entries);
    for (const forged of [
      'is_closed', 'is_reopened', 'current_closure', 'active_closure',
      'current_withdrawal', 'closure_effect_current', 'REOPENED', 'REVOKED', 'CONVERGED',
    ]) {
      assert.equal(serialized.includes(forged), false, `${forged} n'a pas sa place ici.`);
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// CR5-01 — preuve directe
// --------------------------------------------------------------------------

test('CR5-01 · P36 · P48 — supersession seule ne retire rien ; un retrait exige un acte explicite', async () => {
  const h = await fixture();
  try {
    // H1 — clôture explicite.
    const h1 = await seedClosure(h);

    // H2 — supersède H1, SANS retrait.
    const h2 = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      supersedes: [{ superseded_act_id: h1, supersession_scope: [E1] }],
    }));
    assert.equal('closure_withdrawal' in (h2.entry as unknown as Record<string, unknown>), false);

    let journal = await readReconciliationJournal(h.paths);
    assert.equal(JSON.stringify(journal.entries).includes('closure_withdrawal'), false,
      'après H2 : AUCUN retrait n\'existe nulle part.');

    // H3 — retrait explicite, acte humain distinct.
    const h3 = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      closure_withdrawal: withdrawal([h1], [E1]),
    }) as RecordReconciliationInput);
    assert.equal(h3.outcome, 'RECORDED');

    journal = await readReconciliationJournal(h.paths);
    const withdrawals = journal.entries.filter(
      (e) => 'closure_withdrawal' in (e as unknown as Record<string, unknown>),
    );
    assert.equal(withdrawals.length, 1, 'après H3 : exactement UN fait de retrait, explicite.');
    assert.equal(withdrawals[0]?.entry_id, h3.entry.entry_id);

    // La clôture de H1 demeure enregistrée : S7 ne calcule aucune actualité.
    const closureAct = journal.entries.find((e) => e.entry_id === h1) as unknown as Record<string, unknown>;
    assert.deepEqual(closureAct['closure'], { declared: true, statement: 'clos sur ce périmètre' });
  } finally {
    await h.dispose();
  }
});

test('rien d\'autre ne produit un retrait — ni contenu, ni provenance, ni récence', async () => {
  const h = await fixture();
  try {
    const h1 = await seedClosure(h);

    // Un acte plus récent, dont le CONTENU affirme le retrait, sans déclaration.
    const later = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      content: 'je retire la clôture précédente',
      provenance: { kind: 'DECLARED', statement: 'je retire la clôture' },
    }));

    assert.equal('closure_withdrawal' in (later.entry as unknown as Record<string, unknown>), false,
      'ABSENT WITHDRAWAL DECLARATION → NO WITHDRAWAL ACT.');
    const journal = await readReconciliationJournal(h.paths);
    assert.equal(JSON.stringify(journal.entries).includes('withdrawn_closures'), false);
    assert.ok(h1.startsWith('rcn_'));
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// V16 — la cible doit exister, être humaine, et déclarer une clôture
// --------------------------------------------------------------------------

test('V16 — une cible sans clôture, inexistante ou étrangère est refusée', async () => {
  const h = await fixture();
  try {
    // Acte SANS clôture.
    const plain = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
    }));
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        closure_withdrawal: withdrawal([plain.entry.entry_id], [E1]),
      }) as RecordReconciliationInput)),
      'WITHDRAWN_ACT_DECLARES_NO_CLOSURE',
    );

    // Cible inexistante.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        closure_withdrawal: withdrawal([formatReconciliationId(99)], [E1]),
      }) as RecordReconciliationInput)),
      'WITHDRAWN_CLOSURE_NOT_FOUND',
    );

    // Cible d'une AUTRE controverse.
    const foreign = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      target_controversy_id: OTHER_CTV,
      scope: [FOREIGN],
      closure: { declared: true, statement: 'clos ailleurs' },
    }));
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        closure_withdrawal: withdrawal([foreign.entry.entry_id], [E1]),
      }) as RecordReconciliationInput)),
      'WITHDRAWN_CLOSURE_FOREIGN_CONTROVERSY',
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// V17 · V18 · V19 — désignation et périmètre
// --------------------------------------------------------------------------

test('V19 · C16 — la désignation est explicite : ni vide, ni dupliquée', async () => {
  const h = await fixture();
  try {
    const h1 = await seedClosure(h);
    const revision = await h.revision();

    assert.equal(
      await refusalReason(() => recordReconciliation(deps(h.runsDir), input({
        expected_revision: revision,
        closure_withdrawal: withdrawal([], [E1]),
      }) as RecordReconciliationInput)),
      'WITHDRAWN_CLOSURES_EMPTY',
    );
    assert.equal(
      await refusalReason(() => recordReconciliation(deps(h.runsDir), input({
        expected_revision: revision,
        closure_withdrawal: withdrawal([h1, h1], [E1]),
      }) as RecordReconciliationInput)),
      'DUPLICATE_WITHDRAWN_CLOSURE',
    );
  } finally {
    await h.dispose();
  }
});

test('V17 · V18 — le périmètre du retrait est validé dans les DEUX actes', async () => {
  const h = await fixture();
  try {
    // Clôture sur {E1} seulement.
    const h1 = await seedClosure(h, { scope: [E1] });
    const revision = await h.revision();

    // Vide.
    assert.equal(
      await refusalReason(() => recordReconciliation(deps(h.runsDir), input({
        expected_revision: revision,
        closure_withdrawal: withdrawal([h1], []),
      }) as RecordReconciliationInput)),
      'WITHDRAWAL_SCOPE_EMPTY',
    );

    // Hors du périmètre de l'acte DE RETRAIT.
    assert.equal(
      await refusalReason(() => recordReconciliation(deps(h.runsDir), input({
        expected_revision: revision,
        scope: [E1],
        closure_withdrawal: withdrawal([h1], [E2]),
      }) as RecordReconciliationInput)),
      'WITHDRAWAL_SCOPE_NOT_IN_WITHDRAWAL_ACT',
    );

    // Dans l'acte de retrait, mais hors du périmètre de LA CLÔTURE visée.
    assert.equal(
      await refusalReason(() => recordReconciliation(deps(h.runsDir), input({
        expected_revision: revision,
        scope: [E1, E2],
        closure_withdrawal: withdrawal([h1], [E2]),
      }) as RecordReconciliationInput)),
      'WITHDRAWAL_SCOPE_NOT_IN_CLOSURE_ACT',
    );

    assert.equal((await readReconciliationJournal(h.paths)).entries.length, 1,
      'aucun de ces refus n\'a écrit un octet.');
  } finally {
    await h.dispose();
  }
});

test('VALIDATION ≠ SCOPE AUTHORSHIP — aucune intersection n\'est calculée', async () => {
  const h = await fixture();
  try {
    // Clôture sur {E1}. Un retrait déclaré sur {E1, E2} est REFUSÉ, non réduit.
    const h1 = await seedClosure(h, { scope: [E1] });
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        scope: [E1, E2],
        closure_withdrawal: withdrawal([h1], [E1, E2]),
      }) as RecordReconciliationInput)),
      'WITHDRAWAL_SCOPE_NOT_IN_CLOSURE_ACT',
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C16 · §21.3 — aucune règle de récence
// --------------------------------------------------------------------------

test('aucun latest-wins — plusieurs clôtures sur une unité exigent une désignation explicite', async () => {
  const h = await fixture();
  try {
    // DEUX clôtures distinctes portent sur E1.
    const first = await seedClosure(h, { scope: [E1, E2] });
    const second = await seedClosure(h, { scope: [E1, E2] });

    // Un retrait qui ne désigne QUE la première ne touche pas la seconde.
    const w = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      closure_withdrawal: withdrawal([first], [E1]),
    }) as RecordReconciliationInput);

    const declared = (w.entry as unknown as Record<string, unknown>)['closure_withdrawal'] as
      Record<string, unknown>;
    assert.deepEqual(declared['withdrawn_closures'], [first],
      'la plus récente n\'est pas choisie ; seule la désignation compte.');
    assert.equal((declared['withdrawn_closures'] as string[]).includes(second), false);

    // Les deux clôtures historiques restent intactes.
    const journal = await readReconciliationJournal(h.paths);
    for (const id of [first, second]) {
      const act = journal.entries.find((e) => e.entry_id === id) as unknown as Record<string, unknown>;
      assert.deepEqual(act['closure'], { declared: true, statement: 'clos sur ce périmètre' });
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Politique de retrait répété — plan gelé, cas A à D
// --------------------------------------------------------------------------

test('retrait répété — les quatre cas A–D du plan sont RECORDED', async () => {
  const h = await fixture();
  try {
    const c1 = await seedClosure(h, { scope: [E1, E2, E3] });
    const c2 = await seedClosure(h, { scope: [E1, E2, E3] });

    // Premier retrait : c1 sur {E1}.
    const w1 = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope: [E1, E2, E3],
      closure_withdrawal: withdrawal([c1], [E1]),
    }) as RecordReconciliationInput);
    assert.equal(w1.outcome, 'RECORDED');

    // `A` — second retrait de la MÊME clôture, MÊME unité.
    const a = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope: [E1, E2, E3],
      closure_withdrawal: withdrawal([c1], [E1]),
    }) as RecordReconciliationInput);
    assert.equal(a.outcome, 'RECORDED');

    // `B` — recouvrement PARTIEL : {E1, E2}, dont E1 déjà retiré.
    const b = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope: [E1, E2, E3],
      closure_withdrawal: withdrawal([c1], [E1, E2]),
    }) as RecordReconciliationInput);
    assert.equal(b.outcome, 'RECORDED');

    // `C` — deux clôtures visées, dont une déjà retirée.
    const c = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope: [E1, E2, E3],
      closure_withdrawal: withdrawal([c1, c2], [E1]),
    }) as RecordReconciliationInput);
    assert.equal(c.outcome, 'RECORDED');

    // `D` — tous les effets visés déjà retirés.
    const d = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope: [E1, E2, E3],
      closure_withdrawal: withdrawal([c1], [E1]),
    }) as RecordReconciliationInput);
    assert.equal(d.outcome, 'RECORDED');

    // Cinq retraits historiques coexistent. Aucun n'a réécrit un précédent, et
    // le service n'a désigné aucun « retrait effectif » : aucune préférence,
    // aucune actualité. S9 les interprétera.
    const journal = await readReconciliationJournal(h.paths);
    const withdrawals = journal.entries.filter(
      (e) => 'closure_withdrawal' in (e as unknown as Record<string, unknown>),
    );
    assert.equal(withdrawals.length, 5);
    const serialized = JSON.stringify(journal.entries);
    assert.equal(serialized.includes('effective_withdrawal'), false);
    assert.equal(serialized.includes('superseded_withdrawal'), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Coexistence supersession / retrait — deux dimensions séparées
// --------------------------------------------------------------------------

test('supersession et retrait coexistent sur un acte, validés SÉPARÉMENT', async () => {
  const h = await fixture();
  try {
    const h1 = await seedClosure(h, { scope: [E1, E2] });

    // Les deux effets sur le même acte : le contrat §9.1 les déclare tous deux
    // optionnels sur `RECONCILIATION_RECORDED`.
    const both = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      scope: [E1, E2],
      supersedes: [{ superseded_act_id: h1, supersession_scope: [E2] }],
      closure_withdrawal: withdrawal([h1], [E1]),
    }) as RecordReconciliationInput);

    const stored = both.entry as unknown as Record<string, unknown>;
    assert.deepEqual(stored['supersedes'], [{ superseded_act_id: h1, supersession_scope: [E2] }]);
    assert.deepEqual((stored['closure_withdrawal'] as Record<string, unknown>)['withdrawal_scope'], [E1]);

    // Une supersession valide ne rend pas un retrait valide : un retrait dont le
    // périmètre sort de la clôture visée est refusé, même accompagné d'une
    // supersession parfaitement valide.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        scope: [E1, E2, E3],
        supersedes: [{ superseded_act_id: h1, supersession_scope: [E2] }],
        closure_withdrawal: withdrawal([h1], [E3]),
      }) as RecordReconciliationInput)),
      'WITHDRAWAL_SCOPE_NOT_IN_CLOSURE_ACT',
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Frontières et non-régression
// --------------------------------------------------------------------------

test('l\'ouverture du retrait n\'a rien ouvert d\'autre — chaque champ garde son propriétaire', async () => {
  const h = await fixture();
  try {
    const revision = await h.revision();

    // `responds_to` appartient à S8, désormais implémentée. Le champ n'est donc
    // plus refusé pour inexistence de sa tranche, mais par SON propriétaire, et
    // sur le fond : la proposition visée n'existe pas dans ce run. Le refus
    // n'a pas disparu — il a gagné son vrai motif.
    await assert.rejects(
      () => recordReconciliation(deps(h.runsDir), {
        ...input({ expected_revision: revision }),
        responds_to: { proposal_id: formatReconciliationId(1), relation: 'ADOPTS' },
      } as unknown as RecordReconciliationInput),
      (error: unknown) => {
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        assert.equal(details['outcome'], 'REFUSED_VALIDATION');
        assert.equal(details['reason'], 'PROPOSAL_NOT_FOUND');
        assert.equal(details['at'], 'responds_to');
        assert.equal(details['proposal_id'], formatReconciliationId(1));
        return true;
      },
    );

    await assert.rejects(
      () => recordReconciliation(deps(h.runsDir), {
        ...input({ expected_revision: revision }), merits_confidence: 0.9,
      } as unknown as RecordReconciliationInput),
      (error: unknown) => {
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        assert.equal(details['reason'], 'UNKNOWN_INPUT_FIELD');
        return true;
      },
    );
    assert.equal(existsSync(h.paths.reconciliations), false, 'zéro octet écrit.');
  } finally {
    await h.dispose();
  }
});

test('la fraîcheur garde sa précédence sur toute validation de retrait', async () => {
  const h = await fixture();
  try {
    const stale = await h.revision();
    const h1 = await seedClosure(h);
    const before = await readFile(h.paths.reconciliations, 'utf8');

    // Doublement fautive : révision périmée ET cible de retrait inexistante.
    await assert.rejects(
      () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: stale,
        closure_withdrawal: withdrawal([formatReconciliationId(99)], [E1]),
      }) as RecordReconciliationInput),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'STALE_REVISION');
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        assert.equal(details['outcome'], 'REFUSED_FRESHNESS');
        return true;
      },
    );
    assert.equal(await readFile(h.paths.reconciliations, 'utf8'), before);
    assert.ok(h1.startsWith('rcn_'));
  } finally {
    await h.dispose();
  }
});

test('aucune issue canonique nouvelle n\'a été introduite par S7', () => {
  assert.deepEqual(RECONCILIATION_OUTCOMES, [
    'RECORDED', 'REFUSED_VALIDATION', 'REFUSED_FRESHNESS', 'REFUSED_LOCK',
  ]);
  for (const forged of ['REOPENED', 'WITHDRAWAL_SUCCESS', 'ALREADY_WITHDRAWN', 'NO_EFFECT']) {
    assert.equal((RECONCILIATION_OUTCOMES as readonly string[]).includes(forged), false);
  }
});
