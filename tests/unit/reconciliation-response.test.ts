/**
 * Preuves de la tranche S8 — réponse à une proposition, et relation humaine.
 *
 * Classe de preuve : `FIXTURE`.
 *
 * ```text
 * RESPONSE          ≠  AUTHORITATIVE HUMAN ACT
 * ACCEPT / REJECT   ≠  AUTHORITY EFFECT
 * ADOPTS            ≠  AUTHORITY EFFECT
 * HUMAN ACCEPTANCE  ≠  AUTHORSHIP OF CCR REASONING
 * REFERENCE VALIDATION  ≠  MERITS VALIDATION
 * ```
 *
 * Ce fichier ne prouve **aucune** actualité : ni de décision, ni d'effet, ni de
 * proposition. Aucun fournisseur n'est appelé ; les propositions sont semées.
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
  recordProposalResponse,
  recordReconciliation,
} from '../../src/services/reconciliation-service.ts';
import type {
  RecordProposalResponseInput,
  RecordReconciliationInput,
} from '../../src/services/reconciliation-service.ts';
import {
  PROPOSAL_RELATIONS,
  RECONCILIATION_SCHEMA_VERSION,
  RESPONSE_MODES,
  formatReconciliationId,
} from '../../src/core/reconciliation.ts';
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
const FOREIGN = formatControversyEntryId(9);

/** Les deux propositions semées : A porte `oa`, B porte `ob`. */
const PROPOSAL_A = formatReconciliationId(1);
const PROPOSAL_B = formatReconciliationId(2);

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

/**
 * Une proposition CCR **semée**, non produite par un fournisseur.
 *
 * ```text
 * FIXTURE PROPOSAL  ≠  REAL PROVIDER PROPOSAL
 * ```
 *
 * S13 possède la génération. S8 ne fait que consommer des propositions déjà
 * présentes dans l'historique.
 */
function seedProposal(sequence: number, optionId: string, controversyId = CTV, scope = [E1, E2]): string {
  return JSON.stringify({
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: formatReconciliationId(sequence),
    kind: 'RECONCILIATION_PROPOSED',
    target: { kind: 'CONTROVERSY', controversy_id: controversyId },
    semantic_origin: 'CCR',
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T11:00:00.000Z',
    observed_revision: 'rcn-sha256:seed',
    scope_kind: 'SUBSET',
    scope,
    derivation: { method: 'DETERMINISTIC', inputs: scope },
    options: [{ option_id: optionId, content: `contenu proposé ${optionId}` }],
  });
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  revision(): Promise<string>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s8-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's8', created_at: '2026-08-20T09:00:00.000Z',
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
    `${[v3Entry(1), v3Entry(2), v3Entry(9, OTHER_CTV)].map((e) => JSON.stringify(e)).join('\n')}\n`,
    'utf8',
  );
  // Deux propositions : A porte l'option `oa`, B porte `ob`.
  await writeFile(
    paths.reconciliations,
    `${seedProposal(1, 'oa')}\n${seedProposal(2, 'ob')}\n`,
    'utf8',
  );
  return {
    runsDir,
    paths,
    revision: () => readCurrentReconciliationRevision({ runsDir }, RUN_ID),
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

function response(over: Partial<RecordProposalResponseInput> = {}): RecordProposalResponseInput {
  return {
    runId: RUN_ID,
    expected_revision: 'rcn-sha256:placeholder',
    target_controversy_id: CTV,
    proposal_id: PROPOSAL_A,
    mode: 'ACCEPT',
    provenance: { kind: 'DECLARED', statement: 'lu et répondu' },
    ...over,
  } as RecordProposalResponseInput;
}

function act(over: Partial<RecordReconciliationInput> = {}): RecordReconciliationInput {
  return {
    runId: RUN_ID,
    expected_revision: 'rcn-sha256:placeholder',
    target_controversy_id: CTV,
    scope_kind: 'SUBSET',
    scope: [E1],
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

/** Le journal n'a pas bougé d'un octet. */
async function assertNoWrite(h: Fixture, before: string): Promise<void> {
  assert.equal(await readFile(h.paths.reconciliations, 'utf8'), before);
}

// --------------------------------------------------------------------------
// C30 · P18 — la réponse
// --------------------------------------------------------------------------

test('C30 · P18 — ACCEPT et REJECT sont enregistrés comme actes historiques', async () => {
  for (const mode of RESPONSE_MODES) {
    const h = await fixture();
    try {
      const result = await recordProposalResponse(deps(h.runsDir), response({
        expected_revision: await h.revision(), mode,
      }));

      assert.equal(result.outcome, 'RECORDED');
      assert.equal(result.entry.kind, 'PROPOSAL_RESPONSE_RECORDED');
      assert.equal(result.entry.semantic_origin, 'HUMAN');
      assert.equal(result.entry.recorded_by, 'CCR');
      assert.equal(result.entry.entry_id, formatReconciliationId(3));
      assert.deepEqual(result.entry.responds_to, { proposal_id: PROPOSAL_A, mode });
    } finally {
      await h.dispose();
    }
  }
});

test('C53 · V10 · P49 — la réponse ne porte ni périmètre, ni contenu, ni effet', async () => {
  const h = await fixture();
  try {
    const result = await recordProposalResponse(deps(h.runsDir), response({
      expected_revision: await h.revision(),
    }));

    const stored = result.entry as unknown as Record<string, unknown>;
    for (const forbidden of [
      'scope_kind', 'scope', 'content', 'closure', 'closure_withdrawal', 'supersedes',
    ]) {
      assert.equal(forbidden in stored, false, `${forbidden} n'a pas sa place sur une réponse.`);
    }
    assert.deepEqual(Object.keys(stored).sort(), [
      'entry_id', 'kind', 'observed_revision', 'provenance', 'recorded_at', 'recorded_by',
      'responds_to', 'schema_version', 'semantic_origin', 'target',
    ]);
  } finally {
    await h.dispose();
  }
});

test('un champ d\'effet soumis à une réponse est REFUSÉ, jamais écarté', async () => {
  const h = await fixture();
  try {
    const revision = await h.revision();
    const before = await readFile(h.paths.reconciliations, 'utf8');

    for (const field of ['scope', 'content', 'closure', 'closure_withdrawal', 'supersedes', 'relation']) {
      assert.equal(
        await refusalReason(() => recordProposalResponse(deps(h.runsDir), {
          ...response({ expected_revision: revision }), [field]: 'x',
        } as unknown as RecordProposalResponseInput)),
        'UNKNOWN_INPUT_FIELD',
        `${field} doit être refusé sur une réponse.`,
      );
    }
    await assertNoWrite(h, before);
  } finally {
    await h.dispose();
  }
});

test('P45 · P48 — ACCEPT ne clôt rien, REJECT ne retire rien, ni l\'un ni l\'autre ne supersède', async () => {
  const h = await fixture();
  try {
    await recordProposalResponse(deps(h.runsDir), response({
      expected_revision: await h.revision(), mode: 'ACCEPT', responded_option_id: 'oa',
    }));
    await recordProposalResponse(deps(h.runsDir), response({
      expected_revision: await h.revision(), mode: 'REJECT',
    }));

    const journal = await readReconciliationJournal(h.paths);
    const serialized = JSON.stringify(journal.entries);
    // Aucun effet d'aucune sorte n'a été produit, même par un ACCEPT portant
    // une référence d'option RÉELLE.
    assert.equal(serialized.includes('"closure"'), false);
    assert.equal(serialized.includes('closure_withdrawal'), false);
    assert.equal(serialized.includes('superseded_act_id'), false);
    // Et aucun RECONCILIATION_RECORDED n'a été créé au passage.
    assert.equal(journal.entries.filter((e) => e.kind === 'RECONCILIATION_RECORDED').length, 0);
    assert.equal(journal.entries.length, 4);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C54 — deux formes de responds_to, jamais confondues
// --------------------------------------------------------------------------

test('C54 — `mode` et `relation` appartiennent à deux formes distinctes', async () => {
  const h = await fixture();
  try {
    const revision = await h.revision();

    // Une réponse valide porte `mode`.
    const r = await recordProposalResponse(deps(h.runsDir), response({ expected_revision: revision }));
    const responseRelation = r.entry.responds_to as unknown as Record<string, unknown>;
    assert.equal('mode' in responseRelation, true);
    assert.equal('relation' in responseRelation, false);
    assert.equal('adopted_option_id' in responseRelation, false);

    // Un acte humain porte `relation`.
    const a = await recordReconciliation(deps(h.runsDir), act({
      expected_revision: await h.revision(),
      responds_to: { proposal_id: PROPOSAL_A, relation: 'MODIFIES' },
    }));
    const actRelation = a.entry.responds_to as unknown as Record<string, unknown>;
    assert.equal('relation' in actRelation, true);
    assert.equal('mode' in actRelation, false);
    assert.equal('responded_option_id' in actRelation, false);

    // Les deux vocabulaires sont fermés et disjoints.
    assert.deepEqual(RESPONSE_MODES, ['ACCEPT', 'REJECT']);
    assert.deepEqual(PROPOSAL_RELATIONS, ['ADOPTS', 'MODIFIES', 'REPLACES']);
    for (const mode of RESPONSE_MODES) {
      assert.equal((PROPOSAL_RELATIONS as readonly string[]).includes(mode), false);
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// V27 — résolution de la proposition
// --------------------------------------------------------------------------

test('V27 — la proposition doit exister et être une VRAIE proposition', async () => {
  const h = await fixture();
  try {
    const revision = await h.revision();
    const before = await readFile(h.paths.reconciliations, 'utf8');

    // Inexistante.
    assert.equal(
      await refusalReason(() => recordProposalResponse(deps(h.runsDir), response({
        expected_revision: revision, proposal_id: formatReconciliationId(99),
      }))),
      'PROPOSAL_NOT_FOUND',
    );

    // Une réponse n'est pas une proposition : on répond d'abord, puis on vise
    // cette réponse.
    const r = await recordProposalResponse(deps(h.runsDir), response({ expected_revision: revision }));
    assert.equal(
      await refusalReason(async () => recordProposalResponse(deps(h.runsDir), response({
        expected_revision: await h.revision(), proposal_id: r.entry.entry_id,
      }))),
      'REFERENCED_RECORD_NOT_A_PROPOSAL',
    );

    // Un acte humain non plus.
    const a = await recordReconciliation(deps(h.runsDir), act({ expected_revision: await h.revision() }));
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), act({
        expected_revision: await h.revision(),
        responds_to: { proposal_id: a.entry.entry_id, relation: 'REPLACES' },
      }))),
      'REFERENCED_RECORD_NOT_A_PROPOSAL',
    );
    assert.ok(before.length > 0);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// V33 · V28 — l'option appartient à la proposition EXACTEMENT référencée
// --------------------------------------------------------------------------

test('V33 — référence croisée entre propositions : REFUSÉE, zéro octet', async () => {
  const h = await fixture();
  try {
    const revision = await h.revision();
    const before = await readFile(h.paths.reconciliations, 'utf8');

    // `ob` existe — mais dans la proposition B, pas dans A.
    assert.equal(
      await refusalReason(() => recordProposalResponse(deps(h.runsDir), response({
        expected_revision: revision, proposal_id: PROPOSAL_A, responded_option_id: 'ob',
      }))),
      'OPTION_NOT_IN_PROPOSAL',
    );
    // Même attaque sur l'adoption.
    assert.equal(
      await refusalReason(() => recordReconciliation(deps(h.runsDir), act({
        expected_revision: revision,
        responds_to: { proposal_id: PROPOSAL_A, relation: 'ADOPTS', adopted_option_id: 'ob' },
      }))),
      'OPTION_NOT_IN_PROPOSAL',
    );
    // Option inexistante partout.
    assert.equal(
      await refusalReason(() => recordProposalResponse(deps(h.runsDir), response({
        expected_revision: revision, responded_option_id: 'inconnue',
      }))),
      'OPTION_NOT_IN_PROPOSAL',
    );

    await assertNoWrite(h, before);
  } finally {
    await h.dispose();
  }
});

test('la référence d\'option d\'une réponse est optionnelle, pour les DEUX modes', async () => {
  const h = await fixture();
  try {
    // Le §13.1 ne lie `responded_option_id` à aucun mode : absente, la réponse
    // est acceptée ; présente et résolue, elle l'est aussi — sans effet.
    for (const mode of RESPONSE_MODES) {
      const without = await recordProposalResponse(deps(h.runsDir), response({
        expected_revision: await h.revision(), mode,
      }));
      assert.equal(without.outcome, 'RECORDED');
      assert.equal('responded_option_id' in (without.entry.responds_to as unknown as Record<string, unknown>), false);

      const with_ = await recordProposalResponse(deps(h.runsDir), response({
        expected_revision: await h.revision(), mode, responded_option_id: 'oa',
      }));
      assert.equal(with_.outcome, 'RECORDED');
      assert.equal(
        (with_.entry.responds_to as unknown as Record<string, unknown>)['responded_option_id'],
        'oa',
      );
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// V28 — ADOPTS · MODIFIES · REPLACES
// --------------------------------------------------------------------------

test('V28 — ADOPTS exige une option existante de CETTE proposition', async () => {
  const h = await fixture();
  try {
    const revision = await h.revision();

    const adopted = await recordReconciliation(deps(h.runsDir), act({
      expected_revision: revision,
      responds_to: { proposal_id: PROPOSAL_A, relation: 'ADOPTS', adopted_option_id: 'oa' },
    }));
    assert.equal(adopted.outcome, 'RECORDED');
    assert.deepEqual(adopted.entry.responds_to, {
      proposal_id: PROPOSAL_A, relation: 'ADOPTS', adopted_option_id: 'oa',
    });
    // Le contenu humain reste exigé et demeure le sien (§13.3).
    assert.equal(adopted.entry.content, 'ce que la personne a décidé');
    assert.equal(adopted.entry.content.includes('contenu proposé'), false,
      'aucun contenu de proposition n\'est recopié.');

    // ADOPTS sans option.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), act({
        expected_revision: await h.revision(),
        responds_to: { proposal_id: PROPOSAL_A, relation: 'ADOPTS' },
      }))),
      'ADOPTED_OPTION_REQUIRED',
    );
  } finally {
    await h.dispose();
  }
});

test('MODIFIES et REPLACES sont distinctes, et n\'admettent pas adopted_option_id', async () => {
  const h = await fixture();
  try {
    for (const relation of ['MODIFIES', 'REPLACES'] as const) {
      const ok = await recordReconciliation(deps(h.runsDir), act({
        expected_revision: await h.revision(),
        responds_to: { proposal_id: PROPOSAL_A, relation },
      }));
      assert.equal(ok.outcome, 'RECORDED');
      assert.deepEqual(ok.entry.responds_to, { proposal_id: PROPOSAL_A, relation });

      assert.equal(
        await refusalReason(async () => recordReconciliation(deps(h.runsDir), act({
          expected_revision: await h.revision(),
          responds_to: { proposal_id: PROPOSAL_A, relation, adopted_option_id: 'oa' },
        }))),
        'ADOPTED_OPTION_FORBIDDEN_OUTSIDE_ADOPTS',
      );
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Aucun effet implicite
// --------------------------------------------------------------------------

test('aucune relation ne produit de clôture, de supersession ni de retrait', async () => {
  const h = await fixture();
  try {
    for (const responds_to of [
      { proposal_id: PROPOSAL_A, relation: 'ADOPTS' as const, adopted_option_id: 'oa' },
      { proposal_id: PROPOSAL_A, relation: 'MODIFIES' as const },
      { proposal_id: PROPOSAL_A, relation: 'REPLACES' as const },
    ]) {
      const result = await recordReconciliation(deps(h.runsDir), act({
        expected_revision: await h.revision(), responds_to,
      }));
      const stored = result.entry as unknown as Record<string, unknown>;
      assert.equal('closure' in stored, false, `${responds_to.relation} ne clôt rien.`);
      assert.equal('supersedes' in stored, false, `${responds_to.relation} ne supersède rien.`);
      assert.equal('closure_withdrawal' in stored, false, `${responds_to.relation} ne retire rien.`);
    }

    // `REPLACES` en particulier : le mot ne contamine pas S6.
    const journal = await readReconciliationJournal(h.paths);
    assert.equal(JSON.stringify(journal.entries).includes('superseded_act_id'), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Aucune réattribution rétroactive
// --------------------------------------------------------------------------

test('P50 — adopter ne réattribue pas la proposition : elle reste d\'origine CCR', async () => {
  const h = await fixture();
  try {
    const before = await readFile(h.paths.reconciliations, 'utf8');

    const adopted = await recordReconciliation(deps(h.runsDir), act({
      expected_revision: await h.revision(),
      responds_to: { proposal_id: PROPOSAL_A, relation: 'ADOPTS', adopted_option_id: 'oa' },
    }));

    // Le nouvel acte est HUMAN…
    assert.equal(adopted.entry.semantic_origin, 'HUMAN');
    // …et la proposition historique est intacte, octet pour octet.
    const after = await readFile(h.paths.reconciliations, 'utf8');
    assert.equal(after.startsWith(before), true);

    const journal = await readReconciliationJournal(h.paths);
    const proposal = journal.entries.find((e) => e.entry_id === PROPOSAL_A) as unknown as Record<string, unknown>;
    assert.equal(proposal['semantic_origin'], 'CCR');
    assert.equal(proposal['recorded_by'], 'CCR');
    assert.deepEqual(proposal['derivation'], { method: 'DETERMINISTIC', inputs: [E1, E2] });
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Coexistence, actualité, classement
// --------------------------------------------------------------------------

test('relation et effets coexistent, validés indépendamment', async () => {
  const h = await fixture();
  try {
    const both = await recordReconciliation(deps(h.runsDir), act({
      expected_revision: await h.revision(),
      responds_to: { proposal_id: PROPOSAL_A, relation: 'ADOPTS', adopted_option_id: 'oa' },
      closure: { declared: true, statement: 'clos sur ce périmètre' },
    }));
    assert.equal(both.outcome, 'RECORDED');
    assert.equal(both.entry.closure?.declared, true);

    // Une relation valide ne rend pas un effet valide : la clôture reste soumise
    // à ses propres conditions, et une relation invalide refuse l'acte entier
    // même accompagnée d'une clôture parfaitement formée.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), act({
        expected_revision: await h.revision(),
        responds_to: { proposal_id: PROPOSAL_A, relation: 'ADOPTS', adopted_option_id: 'ob' },
        closure: { declared: true, statement: 'clos' },
      }))),
      'OPTION_NOT_IN_PROPOSAL',
    );
  } finally {
    await h.dispose();
  }
});

test('plusieurs réponses à une même proposition coexistent, sans actualité ni gagnant', async () => {
  const h = await fixture();
  try {
    // Le contrat ne définit aucune actualité de réponse : rien n'en limite le
    // nombre, et le service n'en désigne aucune comme effective.
    await recordProposalResponse(deps(h.runsDir), response({
      expected_revision: await h.revision(), mode: 'ACCEPT',
    }));
    await recordProposalResponse(deps(h.runsDir), response({
      expected_revision: await h.revision(), mode: 'REJECT',
    }));

    const journal = await readReconciliationJournal(h.paths);
    const responses = journal.entries.filter((e) => e.kind === 'PROPOSAL_RESPONSE_RECORDED');
    assert.equal(responses.length, 2);

    const serialized = JSON.stringify(journal.entries);
    for (const forged of [
      'proposal_status', 'accepted', 'rejected', 'current_response', 'winning_option',
      'current_decision', 'active_option', 'rank', 'score',
    ]) {
      assert.equal(serialized.includes(forged), false, `${forged} n'a pas sa place ici.`);
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Non-régression
// --------------------------------------------------------------------------

test('la fraîcheur garde sa précédence sur les deux chemins S8', async () => {
  const h = await fixture();
  try {
    const stale = await h.revision();
    await recordProposalResponse(deps(h.runsDir), response({ expected_revision: stale }));
    const before = await readFile(h.paths.reconciliations, 'utf8');

    // Réponse : périmée ET proposition inexistante.
    await assert.rejects(
      () => recordProposalResponse(deps(h.runsDir), response({
        expected_revision: stale, proposal_id: formatReconciliationId(99),
      })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'STALE_REVISION');
        return true;
      },
    );

    // Acte humain : périmé ET option croisée.
    await assert.rejects(
      () => recordReconciliation(deps(h.runsDir), act({
        expected_revision: stale,
        responds_to: { proposal_id: PROPOSAL_A, relation: 'ADOPTS', adopted_option_id: 'ob' },
      })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'STALE_REVISION');
        return true;
      },
    );

    await assertNoWrite(h, before);
  } finally {
    await h.dispose();
  }
});

test('les champs serveur restent inusurpables, sur les deux chemins', async () => {
  const h = await fixture();
  try {
    const r = await recordProposalResponse(deps(h.runsDir), {
      ...response({ expected_revision: await h.revision() }),
      entry_id: formatReconciliationId(42),
      semantic_origin: 'CCR',
      recorded_by: 'HUMAN',
      recorded_at: '1999-01-01T00:00:00.000Z',
    } as unknown as RecordProposalResponseInput);

    assert.equal(r.entry.entry_id, formatReconciliationId(3));
    assert.equal(r.entry.semantic_origin, 'HUMAN');
    assert.equal(r.entry.recorded_by, 'CCR');
    assert.equal(r.entry.recorded_at, NOW.toISOString());

    // Un champ réellement inconnu reste refusé.
    assert.equal(
      await refusalReason(async () => recordProposalResponse(deps(h.runsDir), {
        ...response({ expected_revision: await h.revision() }), merits_confidence: 0.9,
      } as unknown as RecordProposalResponseInput)),
      'UNKNOWN_INPUT_FIELD',
    );
  } finally {
    await h.dispose();
  }
});

test('aucune issue canonique nouvelle n\'a été introduite par S8', () => {
  assert.deepEqual(RECONCILIATION_OUTCOMES, [
    'RECORDED', 'REFUSED_VALIDATION', 'REFUSED_FRESHNESS', 'REFUSED_LOCK',
  ]);
  for (const forged of ['ACCEPTED', 'REJECTED', 'ADOPTED', 'MODIFIED', 'REPLACED', 'PROPOSAL_HANDLED']) {
    assert.equal((RECONCILIATION_OUTCOMES as readonly string[]).includes(forged), false);
  }
});
