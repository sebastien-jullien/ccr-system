/**
 * Preuves de la tranche S5 — forme d'autorité humaine, provenance, clôture.
 *
 * Classe de preuve : `FIXTURE`.
 *
 * Ce fichier porte la preuve d'exécution de `C35` et l'équivalence de
 * provenance exigée par le plan : à conditions `H1`–`H5` rigoureusement
 * identiques, faire varier le seul `provenance.kind` — chacune avec une
 * référence réellement résoluble — ne confère ni ne retire l'éligibilité aux
 * effets.
 *
 * ```text
 * PROVENANCE  ≠  AUTHORITY
 * OBSERVABLE HUMAN FORM  ≠  REAL-WORLD ENTITLEMENT
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { readCurrentReconciliationRevision } from '../../src/services/reconciliation-freshness.ts';
import {
  PROVENANCE_KINDS_RESOLVED_AGAINST_SNAPSHOT,
  recordReconciliation,
} from '../../src/services/reconciliation-service.ts';
import type {
  ReconciliationServiceDeps,
  RecordReconciliationInput,
} from '../../src/services/reconciliation-service.ts';
import { PROVENANCE_KINDS } from '../../src/core/reconciliation.ts';
import type { Provenance } from '../../src/core/reconciliation.ts';
import { isCcrError } from '../../src/core/errors.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import { formatDecisionId } from '../../src/core/ids.ts';

const RUN_ID = 'CCR-20260403-001';
const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const AUTHORITY_ENTRY = formatControversyEntryId(2);
const LEGACY = formatDecisionId(3);

const NOW = new Date('2026-08-20T12:00:00.000Z');

function v3Assertion(sequence: number): ControversyEntry {
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: CTV,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-20T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  };
}

/**
 * Une autorité humaine V3 réelle, avec un `scope` TEXTUEL.
 *
 * Ce texte est précisément ce qui ne doit **jamais** être promu en périmètre
 * canonique V5 : il ne satisfait pas `CANONICAL_SCOPE_UNIT`, et sa cible est une
 * entrée, non une controverse.
 */
function v3Authority(): ControversyEntry {
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: AUTHORITY_ENTRY,
    controversy_id: CTV,
    kind: 'HUMAN_AUTHORITY_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-20T10:05:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
    authority: { act: 'ARBITRATION', target_entry_id: E1, scope: 'toute la question du cache' },
  };
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: ReconciliationServiceDeps;
  revision(): Promise<string>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s5a-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's5a', created_at: '2026-08-20T09:00:00.000Z',
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
    `${[v3Assertion(1), v3Authority()].map((e) => JSON.stringify(e)).join('\n')}\n`,
    'utf8',
  );
  // Une décision legacy RÉELLEMENT présente : la référence désigne un objet qui
  // existe dans ce run, et non un identifiant en l'air.
  await writeFile(paths.decisions, `${JSON.stringify({
    decision_id: LEGACY, round: 1, timestamp: '2026-08-20T09:20:00.000Z',
    author: 'human', status: 'ACTIVE', content: 'décision historique, sans périmètre',
  })}\n`, 'utf8');

  return {
    runsDir,
    paths,
    deps: { runsDir, now: () => NOW },
    revision: () => readCurrentReconciliationRevision({ runsDir }, RUN_ID),
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

/** Conditions H1–H5 rigoureusement identiques ; seule la provenance varie. */
function act(revision: string, provenance: Provenance, closure = true): RecordReconciliationInput {
  return {
    runId: RUN_ID,
    expected_revision: revision,
    target_controversy_id: CTV,
    scope_kind: 'SUBSET',
    scope: [E1],
    content: 'ce que la personne a décidé',
    provenance,
    ...(closure ? { closure: { declared: true, statement: 'clos sur ce périmètre' } as const } : {}),
  } as RecordReconciliationInput;
}

// --------------------------------------------------------------------------
// C33 · V13 — provenance obligatoire et fermée
// --------------------------------------------------------------------------

test('C33 · V13 — les trois sortes de provenance sont admises, et elles seules', async () => {
  const h = await fixture();
  try {
    assert.deepEqual(PROVENANCE_KINDS, ['DECLARED', 'CONTROVERSY_AUTHORITY', 'LEGACY_DECISION']);
    const revision = await h.revision();
    await assert.rejects(() => recordReconciliation(h.deps, act(
      revision, { kind: 'VERIFIED_AUTHORITY', statement: 'x' } as unknown as Provenance,
    )));
    await assert.rejects(() => recordReconciliation(h.deps, act(
      revision, undefined as unknown as Provenance,
    )));
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C35 — la référence à une autorité humaine V3
// --------------------------------------------------------------------------

test('C35 · une référence CONTROVERSY_AUTHORITY doit RÉSOUDRE dans le journal V3', async () => {
  const h = await fixture();
  try {
    // Résolution réelle : l'entrée existe dans ce run.
    const ok = await recordReconciliation(h.deps, act(
      await h.revision(), { kind: 'CONTROVERSY_AUTHORITY', entry_id: AUTHORITY_ENTRY },
    ));
    assert.equal(ok.outcome, 'RECORDED');

    // Référence canonique mais inexistante : refus.
    const nextRevision = await h.revision();
    await assert.rejects(
      () => recordReconciliation(h.deps, act(
        nextRevision, { kind: 'CONTROVERSY_AUTHORITY', entry_id: formatControversyEntryId(99) },
      )),
      (error: unknown) => {
        assert.ok(isCcrError(error));
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        assert.equal(details['reason'], 'PROVENANCE_REFERENCE_NOT_FOUND');
        return true;
      },
    );

    assert.deepEqual(PROVENANCE_KINDS_RESOLVED_AGAINST_SNAPSHOT, ['CONTROVERSY_AUTHORITY']);
  } finally {
    await h.dispose();
  }
});

test('C35 · P33 — référence ≠ duplication ≠ conversion ; le scope textuel V3 n\'est jamais promu', async () => {
  const h = await fixture();
  try {
    const result = await recordReconciliation(h.deps, act(
      await h.revision(), { kind: 'CONTROVERSY_AUTHORITY', entry_id: AUTHORITY_ENTRY },
    ));

    const stored = result.entry as unknown as Record<string, unknown>;
    // Le périmètre V5 vient du champ de l'acte, validé par S4 — jamais du
    // `scope` TEXTUEL de l'autorité V3 référencée.
    assert.deepEqual(stored['scope'], [E1]);
    assert.equal(JSON.stringify(stored).includes('toute la question du cache'), false,
      'aucun contenu V3 n\'est recopié dans l\'acte V5.');
    // L'entrée V3 n'est ni dupliquée, ni convertie : seule sa référence figure.
    assert.deepEqual(stored['provenance'], { kind: 'CONTROVERSY_AUTHORITY', entry_id: AUTHORITY_ENTRY });
    assert.equal(stored['kind'], 'RECONCILIATION_RECORDED');
  } finally {
    await h.dispose();
  }
});

test('C34 · P34 — une référence LEGACY_DECISION reste une référence, sans autorité importée', async () => {
  const h = await fixture();
  try {
    const result = await recordReconciliation(h.deps, act(
      await h.revision(), { kind: 'LEGACY_DECISION', decision_id: LEGACY },
    ));
    const stored = result.entry as unknown as Record<string, unknown>;
    assert.deepEqual(stored['provenance'], { kind: 'LEGACY_DECISION', decision_id: LEGACY });
    // Aucun contenu legacy recopié, aucun périmètre inféré.
    assert.equal(JSON.stringify(stored).includes('décision historique'), false);
    assert.deepEqual(stored['scope'], [E1]);

    // Forme non canonique : refusée par le domaine.
    const nextRevision = await h.revision();
    await assert.rejects(() => recordReconciliation(h.deps, act(
      nextRevision, { kind: 'LEGACY_DECISION', decision_id: 'dec_000003' } as unknown as Provenance,
    )));
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// P46 — équivalence de provenance
// --------------------------------------------------------------------------

test('C34 — une référence legacy N\'EXIGE PAS d\'existence : decisions.jsonl absent', async () => {
  const h = await fixture();
  try {
    // Le journal legacy est retiré : il n'est **pas observé dans l'instantané
    // stable** (§28), et `V13` valide la présence et le TYPE FERMÉ de la
    // provenance, jamais l'existence de l'objet référencé.
    await rm(h.paths.decisions, { force: true });

    const result = await recordReconciliation(h.deps, act(
      await h.revision(), { kind: 'LEGACY_DECISION', decision_id: LEGACY },
    ));

    assert.equal(result.outcome, 'RECORDED');
    assert.deepEqual(result.entry.provenance, { kind: 'LEGACY_DECISION', decision_id: LEGACY });

    // `LEGACY_DECISIONS_ROLE = REFERENCE_ONLY` — et une référence sans exigence
    // d'existence n'est pas pour autant une référence FAUSSE : le service ne
    // prétend rien de l'objet visé, il enregistre que l'acte le désigne.
    assert.equal(existsSync(h.paths.decisions), false,
      'le service ne lit ni ne matérialise le journal legacy.');
  } finally {
    await h.dispose();
  }
});

test('P46 — à conditions H1–H5 identiques, la sorte de provenance ne change RIEN', async () => {
  const provenances: readonly Provenance[] = [
    { kind: 'DECLARED', statement: 'décidé en revue' },
    { kind: 'CONTROVERSY_AUTHORITY', entry_id: AUTHORITY_ENTRY },
    { kind: 'LEGACY_DECISION', decision_id: LEGACY },
  ];

  for (const provenance of provenances) {
    const h = await fixture();
    try {
      // Les trois provenances sont **contractuellement valides**, chacune selon
      // SA règle : la référence V3 est effectivement RÉSOLUE contre l'état
      // autoritaire ; la référence legacy respecte sa règle `REFERENCE_ONLY`,
      // qui n'exige aucune existence ; `DECLARED` ne porte aucune référence
      // externe. Le test ne rend jamais valide une référence invalide.
      const result = await recordReconciliation(h.deps, act(await h.revision(), provenance));

      // Éligibilité aux effets : rigoureusement identique dans les trois cas.
      assert.equal(result.outcome, 'RECORDED', `${provenance.kind} doit être recevable.`);
      assert.deepEqual(result.entry.closure, { declared: true, statement: 'clos sur ce périmètre' });
      assert.equal(result.entry.semantic_origin, 'HUMAN');
      assert.deepEqual(result.entry.scope, [E1]);
      assert.equal(result.entry.entry_id, 'rcn_000001');
      // Seule la provenance diffère.
      assert.deepEqual(result.entry.provenance, provenance);
    } finally {
      await h.dispose();
    }
  }
});

test('P46 — une provenance valide ne confère AUCUN effet par elle-même', async () => {
  const h = await fixture();
  try {
    // Même provenance d'autorité V3, mais aucune clôture déclarée.
    const result = await recordReconciliation(h.deps, act(
      await h.revision(), { kind: 'CONTROVERSY_AUTHORITY', entry_id: AUTHORITY_ENTRY }, false,
    ));
    const stored = result.entry as unknown as Record<string, unknown>;
    assert.equal('closure' in stored, false,
      'référencer une autorité V3 ne produit pas de clôture.');
    assert.equal('closure_withdrawal' in stored, false);
    assert.equal('supersedes' in stored, false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C14 · V14 — la clôture, effet explicite et séparé
// --------------------------------------------------------------------------

test('C14 · V14 — une clôture absente ne produit aucune déclaration', async () => {
  const h = await fixture();
  try {
    const result = await recordReconciliation(h.deps, act(
      await h.revision(), { kind: 'DECLARED', statement: 'décidé en revue' }, false,
    ));
    assert.equal('closure' in (result.entry as unknown as Record<string, unknown>), false);
    // Exécuter l'opération ne produit jamais un effet : `H3`.
    assert.equal(result.outcome, 'RECORDED');
  } finally {
    await h.dispose();
  }
});

test('P01 · P02 · P03 — ni contenu, ni provenance, ni opération ne closent implicitement', async () => {
  const h = await fixture();
  try {
    // Un contenu qui *dit* clore ne clôt pas : seule la déclaration compte.
    const result = await recordReconciliation(h.deps, {
      ...act(await h.revision(), { kind: 'DECLARED', statement: 'je clos cette controverse' }, false),
      content: 'je considère la controverse close et convergée',
    } as RecordReconciliationInput);

    const stored = result.entry as unknown as Record<string, unknown>;
    assert.equal('closure' in stored, false, 'aucune clôture n\'est inférée d\'un texte.');
    // Le contenu humain traverse tel quel — il n'est ni résumé, ni corrigé.
    assert.equal(stored['content'], 'je considère la controverse close et convergée');
  } finally {
    await h.dispose();
  }
});

test('P09 · P33 — une clôture déclarée porte exactement le périmètre de l\'acte', async () => {
  const h = await fixture();
  try {
    const result = await recordReconciliation(h.deps, act(
      await h.revision(), { kind: 'DECLARED', statement: 'décidé en revue' },
    ));
    // §16.3 — l'effet porte sur les unités énumérées de l'acte, et la clôture
    // n'a aucun champ de périmètre propre par lequel déborder.
    assert.deepEqual(result.entry.scope, [E1]);
    assert.deepEqual(Object.keys(result.entry.closure ?? {}).sort(), ['declared', 'statement']);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// H1 · H2 — origine humaine et chemin humain
// --------------------------------------------------------------------------

test('H1 · P05 — l\'origine sémantique est posée par le serveur, jamais reçue', async () => {
  const h = await fixture();
  try {
    const smuggled = {
      ...act(await h.revision(), { kind: 'DECLARED', statement: 'décidé en revue' }),
      semantic_origin: 'CCR',
      recorded_by: 'HUMAN',
      entry_id: 'rcn_000042',
      recorded_at: '1999-01-01T00:00:00.000Z',
      observed_revision: 'rcn-sha256:forge',
      derivation: { method: 'MODEL_ASSISTED', inputs: [] },
    } as unknown as RecordReconciliationInput;

    const result = await recordReconciliation(h.deps, smuggled);

    // Aucun champ serveur n'a été forgé par l'appelant.
    assert.equal(result.entry.semantic_origin, 'HUMAN');
    assert.equal(result.entry.recorded_by, 'CCR');
    assert.equal(result.entry.entry_id, 'rcn_000001');
    assert.equal(result.entry.recorded_at, NOW.toISOString());
    assert.match(result.entry.observed_revision, /^rcn-sha256:[0-9a-f]{64}$/);
    assert.notEqual(result.entry.observed_revision, 'rcn-sha256:forge');
    assert.equal('derivation' in (result.entry as unknown as Record<string, unknown>), false,
      'une origine HUMAN n\'a pas de dérivation.');
  } finally {
    await h.dispose();
  }
});

test('H2 — aucun fournisseur n\'est atteignable depuis le chemin humain', async () => {
  const h = await fixture();
  try {
    // La preuve est au niveau du type : `ReconciliationServiceDeps` n'expose que
    // `runsDir` et `now`. Aucune fabrique d'adaptateur, aucun ledger.
    assert.deepEqual(Object.keys(h.deps).sort(), ['now', 'runsDir']);
    const result = await recordReconciliation(h.deps, act(
      await h.revision(), { kind: 'DECLARED', statement: 'décidé en revue' },
    ));
    assert.equal(result.provider_effect, 'EXACT(0)');
    // Aucun ledger d'invocation n'a été créé.
    assert.equal(JSON.stringify(result.entry).includes('invocation_id'), false);
  } finally {
    await h.dispose();
  }
});

test('la forme observable n\'établit aucune habilitation du monde réel', async () => {
  const h = await fixture();
  try {
    const result = await recordReconciliation(h.deps, act(
      await h.revision(), { kind: 'CONTROVERSY_AUTHORITY', entry_id: AUTHORITY_ENTRY },
    ));
    const serialized = JSON.stringify(result.entry);
    for (const claim of [
      'identity_verified', 'role_verified', 'legal_authorization', 'person_entitlement',
      'authorized_by_role', 'verified_authority',
    ]) {
      assert.equal(serialized.includes(claim), false, `${claim} ne doit jamais apparaître.`);
    }
  } finally {
    await h.dispose();
  }
});
