/**
 * Preuves de la tranche S6 — supersession de décision.
 *
 * Classe de preuve : `FIXTURE`.
 *
 * ```text
 * SUPERSESSION  ≠  CLOSURE WITHDRAWAL                                CR5-01
 * ```
 *
 * Ce fichier ne prouve **aucune** actualité : ni de décision, ni d'effet de
 * clôture. S6 persiste la relation historique ; S9 en dérivera l'actualité.
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
import { RECONCILIATION_SCHEMA_VERSION, formatReconciliationId } from '../../src/core/reconciliation.ts';
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
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s6-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's6', created_at: '2026-08-20T09:00:00.000Z',
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

/** Un premier acte, cible des supersessions à venir. */
async function seedAct(h: Fixture, over: Partial<RecordReconciliationInput> = {}): Promise<string> {
  const result = await recordReconciliation(deps(h.runsDir), input({
    expected_revision: await h.revision(), ...over,
  }));
  return result.entry.entry_id;
}

// --------------------------------------------------------------------------
// C17 · V20–V23 — la relation valide
// --------------------------------------------------------------------------

test('C17 · C18 · P33 — une supersession explicite est enregistrée avec son périmètre propre', async () => {
  const h = await fixture();
  try {
    const h1 = await seedAct(h);

    const result = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      supersedes: [{ superseded_act_id: h1, supersession_scope: [E1] }],
    }));

    assert.equal(result.outcome, 'RECORDED');
    assert.deepEqual(result.entry.supersedes, [{ superseded_act_id: h1, supersession_scope: [E1] }]);
    // Le périmètre de la relation est PROPRE : il ne se confond pas avec celui
    // de l'acte, qui porte deux unités.
    assert.deepEqual(result.entry.scope, [E1, E2]);
  } finally {
    await h.dispose();
  }
});

test('P11 · P27 — l\'acte supersédé reste intact ; supersédé ne signifie pas faux', async () => {
  const h = await fixture();
  try {
    const h1 = await seedAct(h);
    const before = await readReconciliationJournal(h.paths);
    const original = before.entries.find((e) => e.entry_id === h1);

    await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      supersedes: [{ superseded_act_id: h1, supersession_scope: [E1] }],
    }));

    const after = await readReconciliationJournal(h.paths);
    assert.deepEqual(after.entries.find((e) => e.entry_id === h1), original,
      'aucun marquage, aucune réécriture, aucune suppression.');
    assert.equal(after.entries.length, 2);
  } finally {
    await h.dispose();
  }
});

test('aucun pointeur d\'actualité n\'est persisté — S9 reste propriétaire', async () => {
  const h = await fixture();
  try {
    const h1 = await seedAct(h);
    const result = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      supersedes: [{ superseded_act_id: h1, supersession_scope: [E1] }],
    }));

    const serialized = JSON.stringify((await readReconciliationJournal(h.paths)).entries);
    for (const forged of [
      'current_decision_id', 'active_reconciliation', 'latest_authoritative',
      'superseded_flag', 'is_superseded', 'current',
    ]) {
      assert.equal(serialized.includes(forged), false, `${forged} ne doit pas exister.`);
    }
    assert.equal('supersedes' in (result.entry as unknown as Record<string, unknown>), true);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// CR5-01 — PREUVE PRIORITAIRE
// --------------------------------------------------------------------------

test('CR5-01 · superséder un acte clôturant NE CRÉE AUCUN retrait de clôture', async () => {
  const h = await fixture();
  try {
    // H1 porte une clôture explicite.
    const h1 = await seedAct(h, { closure: { declared: true, statement: 'clos sur ce périmètre' } });
    const seeded = await readReconciliationJournal(h.paths);
    const h1Entry = seeded.entries.find((e) => e.entry_id === h1) as unknown as Record<string, unknown>;
    assert.deepEqual(h1Entry['closure'], { declared: true, statement: 'clos sur ce périmètre' });

    // H2 supersède H1, sans le moindre acte humain de retrait.
    const h2 = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      supersedes: [{ superseded_act_id: h1, supersession_scope: [E1] }],
    }));

    // La relation est enregistrée…
    assert.deepEqual(h2.entry.supersedes, [{ superseded_act_id: h1, supersession_scope: [E1] }]);
    // …et AUCUN retrait n'a été créé, ni sur H2, ni ailleurs.
    assert.equal('closure_withdrawal' in (h2.entry as unknown as Record<string, unknown>), false);

    const journal = await readReconciliationJournal(h.paths);
    const serialized = JSON.stringify(journal.entries);
    assert.equal(serialized.includes('closure_withdrawal'), false,
      'aucun retrait de clôture n\'existe nulle part dans le journal.');
    assert.equal(serialized.includes('withdrawn_closures'), false);

    // La déclaration de clôture de H1 est intacte : rien ne dit qu'elle serait
    // retirée. SUPERSESSION OF DECISION ≠ SUPERSESSION OF CLOSURE EFFECT.
    const h1After = journal.entries.find((e) => e.entry_id === h1) as unknown as Record<string, unknown>;
    assert.deepEqual(h1After['closure'], { declared: true, statement: 'clos sur ce périmètre' });
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// V23 · V24 · V26 — cible, auto-référence, doublon
// --------------------------------------------------------------------------

test('V23 — une cible inexistante, d\'une autre controverse, ou non superséssible est refusée', async () => {
  const h = await fixture();
  try {
    const h1 = await seedAct(h);
    const revision = await h.revision();

    // Inexistante.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: revision,
        supersedes: [{ superseded_act_id: formatReconciliationId(99), supersession_scope: [E1] }],
      }))),
      'SUPERSEDED_ACT_NOT_FOUND',
    );

    // Une PROPOSITION n'est pas superséssible (§18.3). Écrite hors service, car
    // S13 ne la produit pas encore.
    const raw = await readFile(h.paths.reconciliations, 'utf8');
    await writeFile(h.paths.reconciliations, `${raw}${JSON.stringify({
      schema_version: RECONCILIATION_SCHEMA_VERSION,
      entry_id: formatReconciliationId(7),
      kind: 'RECONCILIATION_PROPOSED',
      target: { kind: 'CONTROVERSY', controversy_id: CTV },
      semantic_origin: 'CCR', recorded_by: 'CCR', recorded_at: '2026-08-20T11:00:00.000Z',
      observed_revision: 'rcn-sha256:seed', scope_kind: 'SUBSET', scope: [E1],
      derivation: { method: 'DETERMINISTIC', inputs: [E1] },
      options: [{ option_id: 'o1', content: 'une lecture' }],
    })}\n`, 'utf8');

    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        supersedes: [{ superseded_act_id: formatReconciliationId(7), supersession_scope: [E1] }],
      }))),
      'SUPERSEDED_ACT_NOT_SUPERSEDABLE',
    );

    // Cible d'une AUTRE controverse — aucun remappage automatique.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        target_controversy_id: OTHER_CTV,
        scope: [FOREIGN],
        supersedes: [{ superseded_act_id: h1, supersession_scope: [FOREIGN] }],
      }))),
      'SUPERSEDED_ACT_FOREIGN_CONTROVERSY',
    );
  } finally {
    await h.dispose();
  }
});

test('C20 · V24 — l\'auto-supersession est refusée, globalement', async () => {
  const h = await fixture();
  try {
    // L'acte en cours recevra `rcn_000001` : il se vise lui-même.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        supersedes: [{ superseded_act_id: formatReconciliationId(1), supersession_scope: [E1] }],
      }))),
      'SELF_SUPERSESSION',
    );
    assert.equal(existsSync(h.paths.reconciliations), false, 'aucun octet écrit.');
  } finally {
    await h.dispose();
  }
});

test('V26 — un même acte visé deux fois dans une seule relation-liste est refusé', async () => {
  const h = await fixture();
  try {
    const h1 = await seedAct(h);
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        supersedes: [
          { superseded_act_id: h1, supersession_scope: [E1] },
          { superseded_act_id: h1, supersession_scope: [E2] },
        ],
      }))),
      'DUPLICATE_SUPERSEDED_ACT',
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C19 · V20 · V21 · V22 — le périmètre de la relation
// --------------------------------------------------------------------------

test('C19 · V20 · V21 · V22 — le périmètre de la relation est validé dans les DEUX actes', async () => {
  const h = await fixture();
  try {
    // H1 ne porte que ctve_000001.
    const h1 = await seedAct(h, { scope: [E1] });
    const revision = await h.revision();

    // Vide.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: revision,
        supersedes: [{ superseded_act_id: h1, supersession_scope: [] }],
      }))),
      'SUPERSESSION_SCOPE_EMPTY',
    );

    // Hors du périmètre de l'acte QUI SUPERSÈDE.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: revision,
        scope: [E1],
        supersedes: [{ superseded_act_id: h1, supersession_scope: [E2] }],
      }))),
      'SUPERSESSION_SCOPE_NOT_IN_SUPERSEDING_ACT',
    );

    // Dans l'acte qui supersède, mais hors du périmètre de l'acte SUPERSÉDÉ.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: revision,
        scope: [E1, E2],
        supersedes: [{ superseded_act_id: h1, supersession_scope: [E2] }],
      }))),
      'SUPERSESSION_SCOPE_NOT_IN_SUPERSEDED_ACT',
    );

    assert.equal((await readReconciliationJournal(h.paths)).entries.length, 1,
      'aucun de ces refus n\'a écrit quoi que ce soit.');
  } finally {
    await h.dispose();
  }
});

test('P41 — VALIDATION ≠ SCOPE AUTHORSHIP — l\'intersection n\'est jamais calculée', async () => {
  const h = await fixture();
  try {
    // H1 porte {E1}. L'acte suivant porte {E1, E2}. L'intersection vaut {E1},
    // mais le système ne la produit pas : une relation déclarée sur {E1, E2}
    // est REFUSÉE, non réduite à {E1}.
    const h1 = await seedAct(h, { scope: [E1] });
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        scope: [E1, E2],
        supersedes: [{ superseded_act_id: h1, supersession_scope: [E1, E2] }],
      }))),
      'SUPERSESSION_SCOPE_NOT_IN_SUPERSEDED_ACT',
    );

    // Le périmètre déclaré valide est enregistré TEL QUEL, sans réordonnancement.
    const h2 = await seedAct(h, { scope: [E1, E2, E3] });
    const h3 = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      scope: [E3, E1, E2],
      supersedes: [{ superseded_act_id: h2, supersession_scope: [E3, E1] }],
    }));
    assert.deepEqual(h3.entry.supersedes?.[0]?.supersession_scope, [E3, E1]);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C21 · C22 · V25 — acyclicité PAR UNITÉ
// --------------------------------------------------------------------------

test('P42 — une CHAÎNE dont les arcs portent sur des unités disjointes est acceptée', async () => {
  const h = await fixture();
  try {
    // Ce test n'est PAS une preuve de `C22` : il ne contient aucune paire
    // réciproque. Il démontre qu'une chaîne A ← B ← C, dont les deux arcs
    // portent sur des unités différentes, ne produit de cycle sur aucune unité.
    const a = await seedAct(h, { scope: [E1, E2] });
    const b = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      scope: [E1, E2],
      supersedes: [{ superseded_act_id: a, supersession_scope: [E1] }],
    }));
    const c = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      scope: [E1, E2],
      supersedes: [{ superseded_act_id: b.entry.entry_id, supersession_scope: [E2] }],
    }));

    assert.equal(c.outcome, 'RECORDED');
    // graph(E1) = { B → A }   ·   graph(E2) = { C → B }   — deux arcs, aucun
    // retour : ni cycle, ni réciprocité.
    assert.equal((await readReconciliationJournal(h.paths)).entries.length, 3);
  } finally {
    await h.dispose();
  }
});

/**
 * État **synthétique préexistant**, écrit directement dans le journal.
 *
 * ```text
 * FIXTURE SEEDING  ≠  CANONICAL WRITE PATH
 * ```
 *
 * Une paire réciproque ne peut **pas** être produite par le chemin canonique :
 * la séquence `rcn_` croît strictement et l'acte visé doit exister au moment de
 * la validation, si bien qu'aucun acte ne peut référencer un acte ultérieur. Ce
 * seed ne prétend donc **pas** être une histoire produite par le service, et
 * n'a franchi aucune validation métier S6. Il n'existe que pour placer le
 * détecteur devant un état globalement réciproque, et vérifier qu'il ne le
 * confond pas avec un cycle par unité.
 *
 * Les invariants mécaniques du journal S2 sont respectés : identités
 * canoniques, séquence strictement croissante, formes de domaine valides.
 */
function forgeAct(sequence: number, target: number, unit: string): string {
  return JSON.stringify({
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: formatReconciliationId(sequence),
    kind: 'RECONCILIATION_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T11:00:00.000Z',
    observed_revision: 'rcn-sha256:seed',
    scope_kind: 'SUBSET',
    scope: [E1, E2],
    content: `acte semé ${String(sequence)}`,
    provenance: { kind: 'DECLARED', statement: 'état synthétique préexistant' },
    supersedes: [{ superseded_act_id: formatReconciliationId(target), supersession_scope: [unit] }],
  });
}

test('C22 · une paire RÉCIPROQUE sur unités disjointes est acceptée', async () => {
  const h = await fixture();
  try {
    // X ↔ Y : réciprocité globale, unités DISJOINTES.
    //   X = rcn_000001  supersedes Y  on [ctve_000001]
    //   Y = rcn_000002  supersedes X  on [ctve_000002]
    await writeFile(h.paths.reconciliations, `${forgeAct(1, 2, E1)}\n${forgeAct(2, 1, E2)}\n`, 'utf8');
    const seeded = await readFile(h.paths.reconciliations, 'utf8');

    const X = formatReconciliationId(1);
    const Y = formatReconciliationId(2);

    // Une VRAIE mutation S6 qui touche les DEUX unités : elle déclenche
    // réellement la validation de supersession, donc le détecteur de cycles.
    // Sans champ `supersedes`, ce chemin ne serait jamais exercé.
    const z = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      scope: [E1, E2],
      supersedes: [
        { superseded_act_id: X, supersession_scope: [E1] },
        { superseded_act_id: Y, supersession_scope: [E2] },
      ],
    }));

    // C22 — acceptée. Aucun faux refus tiré de la réciprocité globale.
    assert.equal(z.outcome, 'RECORDED');
    assert.equal(z.entry.entry_id, formatReconciliationId(3));

    // graph(ctve_000001) = { X → Y , Z → X }   acyclique
    // graph(ctve_000002) = { Y → X , Z → Y }   acyclique
    // graphe global      = { X → Y , Y → X , … }   réciproque, mais jamais
    //                      construit : la partition est PAR UNITÉ.
    const journal = await readReconciliationJournal(h.paths);
    assert.equal(journal.entries.length, 3);

    // Les deux actes semés sont intacts : aucune réécriture d'histoire.
    assert.equal((await readFile(h.paths.reconciliations, 'utf8')).startsWith(seeded), true);

    // Aucun retrait de clôture, aucune actualité : hors périmètre de S6.
    const serialized = JSON.stringify(journal.entries);
    assert.equal(serialized.includes('closure_withdrawal'), false);
    assert.equal(serialized.includes('current_decision'), false);
  } finally {
    await h.dispose();
  }
});

test('contrôle négatif — la MÊME paire sur la MÊME unité est refusée', async () => {
  const h = await fixture();
  try {
    // Mêmes deux actes, même réciprocité — mais les deux arcs portent
    // désormais sur `ctve_000001`. Le graphe de cette unité est cyclique.
    await writeFile(h.paths.reconciliations, `${forgeAct(1, 2, E1)}\n${forgeAct(2, 1, E1)}\n`, 'utf8');
    const before = await readFile(h.paths.reconciliations, 'utf8');

    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        scope: [E1, E2],
        supersedes: [{ superseded_act_id: formatReconciliationId(1), supersession_scope: [E1] }],
      }))),
      'SUPERSESSION_CYCLE',
    );
    assert.equal(await readFile(h.paths.reconciliations, 'utf8'), before, 'zéro octet écrit.');

    // Côte à côte : unités disjointes ⇒ ACCEPTÉ ; même unité ⇒ REFUSÉ.
    // C'est la partition PAR UNITÉ, et rien d'autre, qui les sépare.
  } finally {
    await h.dispose();
  }
});

test('C21 · V25 — un cycle sur une même unité est refusé', async () => {
  const h = await fixture();
  try {
    // Un journal écrit HORS du service, portant déjà un cycle sur E1 :
    // rcn_000001 → rcn_000002 et rcn_000002 → rcn_000001.
    const forge = (sequence: number, target: number): string => JSON.stringify({
      schema_version: RECONCILIATION_SCHEMA_VERSION,
      entry_id: formatReconciliationId(sequence),
      kind: 'RECONCILIATION_RECORDED',
      target: { kind: 'CONTROVERSY', controversy_id: CTV },
      semantic_origin: 'HUMAN', recorded_by: 'CCR', recorded_at: '2026-08-20T11:00:00.000Z',
      observed_revision: 'rcn-sha256:seed', scope_kind: 'SUBSET', scope: [E1, E2],
      content: `acte forgé ${String(sequence)}`,
      provenance: { kind: 'DECLARED', statement: 'hors service' },
      supersedes: [{ superseded_act_id: formatReconciliationId(target), supersession_scope: [E1] }],
    });
    await writeFile(h.paths.reconciliations, `${forge(1, 2)}\n${forge(2, 1)}\n`, 'utf8');
    const before = await readFile(h.paths.reconciliations, 'utf8');

    // Un acte qui touche E1 est refusé : le graphe de cette unité est cyclique.
    assert.equal(
      await refusalReason(async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: await h.revision(),
        scope: [E1, E2],
        supersedes: [{ superseded_act_id: formatReconciliationId(2), supersession_scope: [E1] }],
      }))),
      'SUPERSESSION_CYCLE',
    );
    assert.equal(await readFile(h.paths.reconciliations, 'utf8'), before, 'zéro octet écrit.');

    // Une relation sur E2 — unité SANS cycle — reste possible.
    const ok = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      scope: [E1, E2],
      supersedes: [{ superseded_act_id: formatReconciliationId(2), supersession_scope: [E2] }],
    }));
    assert.equal(ok.outcome, 'RECORDED');
  } finally {
    await h.dispose();
  }
});

test('P43 — aucune fermeture transitive n\'est inventée', async () => {
  const h = await fixture();
  try {
    const a = await seedAct(h, { scope: [E1] });
    const b = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope: [E1],
      supersedes: [{ superseded_act_id: a, supersession_scope: [E1] }],
    }));
    const c = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope: [E1],
      supersedes: [{ superseded_act_id: b.entry.entry_id, supersession_scope: [E1] }],
    }));

    // C ne vise QUE B. Aucun arc « C supersède A » n'a été ajouté.
    assert.deepEqual(c.entry.supersedes, [
      { superseded_act_id: b.entry.entry_id, supersession_scope: [E1] },
    ]);
    const journal = await readReconciliationJournal(h.paths);
    const arcs = journal.entries.flatMap((e) => {
      const relations = (e as unknown as Record<string, unknown>)['supersedes'] as
        | readonly { superseded_act_id: string }[] | undefined ?? [];
      return relations.map((r) => `${e.entry_id}->${r.superseded_act_id}`);
    });
    assert.deepEqual(arcs, ['rcn_000002->rcn_000001', 'rcn_000003->rcn_000002']);
    assert.equal(arcs.includes('rcn_000003->rcn_000001'), false, 'aucune transitivité persistée.');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// P04 · P12 · P13 — ce qui ne produit jamais une supersession
// --------------------------------------------------------------------------

test('P04 · P12 · P13 — récence, contradiction et acte nouveau ne supersèdent rien', async () => {
  const h = await fixture();
  try {
    const h1 = await seedAct(h, { content: 'le cache expire à 5 minutes' });

    // Un acte plus récent, contredisant le précédent, SANS relation déclarée.
    const h2 = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      content: 'le cache ne doit jamais expirer',
    }));

    assert.equal('supersedes' in (h2.entry as unknown as Record<string, unknown>), false,
      'ni la récence ni la contradiction ne créent une relation.');
    const journal = await readReconciliationJournal(h.paths);
    assert.equal(JSON.stringify(journal.entries).includes('superseded_act_id'), false);
    assert.equal(journal.entries.length, 2);
    assert.ok(h1 !== h2.entry.entry_id);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Frontières : chaque champ d'intention est traité par son propriétaire
// --------------------------------------------------------------------------

test('l\'ouverture de supersedes n\'a rien ouvert d\'autre — chaque champ garde son propriétaire', async () => {
  const h = await fixture();
  try {
    const revision = await h.revision();
    // `closure_withdrawal` et `responds_to` ont depuis trouvé leurs tranches —
    // S7 et S8. Ils ne sont donc plus refusés faute de propriétaire, mais PAR
    // leur propriétaire, et pour le motif du fond : la cible référencée
    // n'existe pas dans ce run. Le refus demeure ; sa raison est devenue vraie.
    const cases: readonly (readonly [string, string, string, unknown])[] = [
      ['closure_withdrawal', 'WITHDRAWN_CLOSURE_NOT_FOUND',
       'closure_withdrawal.withdrawn_closures[0]', {
         declared: true, withdrawn_closures: [formatReconciliationId(1)],
         withdrawal_scope: [E1], statement: 'x',
       }],
      ['responds_to', 'PROPOSAL_NOT_FOUND', 'responds_to',
       { proposal_id: formatReconciliationId(1), relation: 'ADOPTS' }],
    ];

    for (const [field, reason, at, value] of cases) {
      await assert.rejects(
        () => recordReconciliation(deps(h.runsDir), {
          ...input({ expected_revision: revision }), [field]: value,
        } as unknown as RecordReconciliationInput),
        (error: unknown) => {
          const details = (error as { details?: Record<string, unknown> }).details ?? {};
          assert.equal(details['outcome'], 'REFUSED_VALIDATION');
          assert.equal(details['reason'], reason);
          assert.equal(details['at'], at);
          return true;
        },
        `${field} doit rester refusé, et par son propriétaire.`,
      );
    }

    // Champ réellement inconnu : toujours refusé.
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
    assert.equal(existsSync(h.paths.reconciliations), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Non-régression de l'ordre acquis
// --------------------------------------------------------------------------

test('la fraîcheur garde sa précédence sur toute validation de supersession', async () => {
  const h = await fixture();
  try {
    const stale = await h.revision();
    const h1 = await seedAct(h);
    const before = await readFile(h.paths.reconciliations, 'utf8');

    // Doublement fautive : révision périmée ET auto-supersession.
    await assert.rejects(
      async () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: stale,
        supersedes: [{ superseded_act_id: formatReconciliationId(2), supersession_scope: [E1] }],
      })),
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

test('aucune issue canonique nouvelle n\'a été introduite par S6', () => {
  assert.deepEqual(RECONCILIATION_OUTCOMES, [
    'RECORDED', 'REFUSED_VALIDATION', 'REFUSED_FRESHNESS', 'REFUSED_LOCK',
  ]);
  for (const forged of ['SUPERSESSION_FAILED', 'CYCLE_DETECTED_FAILURE', 'NOT_CURRENT']) {
    assert.equal((RECONCILIATION_OUTCOMES as readonly string[]).includes(forged), false);
  }
});
