/**
 * V5 · S15 — acceptation finale, sur système de fichiers réel.
 *
 * Question de preuve :
 *
 * > **Les quatorze tranches acceptées se composent-elles réellement, sur de
 * > vrais journaux, de vrais verrous et de vraies révisions — ou seulement dans
 * > leurs tests unitaires respectifs ?**
 *
 * Ce fichier est un **gate**, pas une tranche. Il ne répare rien et n'ajoute
 * aucune propriété : il vérifie une composition et une couverture.
 *
 * ```text
 * RÉEL      filesystem · JSONL · instantanés · verrous · séquences d'identité
 *           services S1–S12 · proposeur S13 · surface CLI S14
 * DOUBLÉ    l'adaptateur fournisseur, et lui seul
 * ```
 *
 * La chaîne éprouvée, dans cet ordre :
 *
 * ```text
 * run natif → controverse V3 → acte humain + clôture → supersession
 * → retrait de clôture → proposition CCR → réponse humaine → acte ADOPTS
 * → les DEUX actualités → détections → signaux de désaccord → read model
 * → surface CLI
 * ```
 *
 * Aucun fournisseur réel. Aucun réseau. Aucune credential.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NATIVE_MANIFEST_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { createRunDirectory } from '../../src/store/state-store.ts';
import {
  buildInitialNativeState,
  persistNativeStateUpdate,
  writeNativeManifest,
  writeNativeState,
} from '../../src/store/native-store.ts';
import type { NativeRunManifest } from '../../src/core/run-native.ts';
import { initializeInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readControversyJournal } from '../../src/store/controversy-store.ts';
import { readReconciliationJournal } from '../../src/store/reconciliation-store.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { recordAssertion, recordControversy } from '../../src/services/controversy-service.ts';
import { readCurrentReconciliationRevision } from '../../src/services/reconciliation-freshness.ts';
import {
  recordProposalResponse,
  recordReconciliation,
} from '../../src/services/reconciliation-service.ts';
import {
  currentClosureEffects,
  currentDecisions,
} from '../../src/services/reconciliation-currentness.ts';
import { detectReconciliationStructures } from '../../src/services/reconciliation-detector.ts';
import { observedDisagreementSignals } from '../../src/services/reconciliation-disagreement.ts';
import { projectReconciliationReadModel } from '../../src/services/reconciliation-read-model.ts';
import {
  MODEL_RECONCILIATION_PROPOSAL_RUNTIME_AVAILABILITY,
  RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
  runControlledAcceptanceProposal,
} from '../../src/services/reconciliation-proposer.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runCli } from '../../src/cli/main.ts';

// --------------------------------------------------------------------------
// Harnais réel — adaptateur doublé, et lui seul
// --------------------------------------------------------------------------

let dispatches = 0;

function doubledAdapter(kind: 'claude' | 'codex', content: string): AgentAdapter {
  return {
    kind,
    async start(): Promise<AgentTurnResult> {
      dispatches += 1;
      return {
        agent: kind,
        sessionId: `v5-s15-${kind}`,
        content,
        exitCode: 0,
        startedAt: '2026-08-20T10:00:00.000Z',
        completedAt: '2026-08-20T10:00:01.000Z',
        stdoutRaw: content,
        stderrRaw: '',
      };
    },
    resume(): never {
      throw new Error('aucune reprise en S15');
    },
    openInteractive(): never {
      throw new Error('aucun terminal en S15');
    },
  };
}

function capture(): CliIo & { text(): string; errorText(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    text: () => out.join('\n'),
    errorText: () => err.join('\n'),
  };
}

const PROVENANCE = { kind: 'DECLARED', statement: 'décidé en revue S15' } as const;

// --------------------------------------------------------------------------
// La chaîne complète, sur un vrai filesystem
// --------------------------------------------------------------------------

test('V5 · S15 — les quatorze tranches se composent sur de vrais journaux', async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s15-'));
  const now = (): Date => new Date('2026-08-20T12:00:00.000Z');
  const deps = { runsDir, now };

  try {
    // ---- Run natif, par les écrivains de production.
    const paths = await createRunDirectory(runsDir, now());
    const manifest: NativeRunManifest = {
      schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
      run_id: paths.runId,
      title: 'V5 S15',
      created_at: now().toISOString(),
      workspace: { cwd: runsDir },
      experts: {
        author: { provider: 'codex', session_id: null },
        challenger: { provider: 'claude', session_id: null },
      },
    };
    await writeNativeManifest(paths, manifest);
    const initial = buildInitialNativeState(paths.runId, 'READY', now());
    await writeNativeState(paths, initial);
    await initializeInvocationLedger(paths);
    const events = await openNativeEventStore(paths, manifest);
    const created = await events.append({
      round: 0,
      actor: 'system',
      type: 'run_created',
      content: manifest.title,
      details: { workspace_cwd: runsDir },
      timestamp: now().toISOString(),
    });
    await persistNativeStateUpdate(paths, initial, { lastEventId: created.event_id }, now());

    // ---- V3 : une controverse et une assertion — deux unités.
    const opened = await recordControversy(deps, {
      runId: paths.runId,
      expected_controversy_revision: (await readControversyJournal(paths)).revision,
      provenance_event_ids: [created.event_id],
      statement: 'Durée de vie du cache',
    });
    const second = await recordAssertion(deps, {
      runId: paths.runId,
      controversy_id: opened.controversy_id,
      expected_controversy_revision: opened.controversy_revision,
      provenance_event_ids: [created.event_id],
      statement: 'Le TTL doit être court',
    });
    const ctv = opened.controversy_id;
    const e1 = opened.entry.entry_id;
    const e2 = second.entry.entry_id;

    const revision = async (): Promise<string> =>
      readCurrentReconciliationRevision({ runsDir }, paths.runId);

    // ---- S5 : acte humain avec clôture explicite sur E1.
    const h1 = await recordReconciliation(deps, {
      runId: paths.runId,
      expected_revision: await revision(),
      target_controversy_id: ctv,
      scope_kind: 'SUBSET',
      scope: [e1, e2],
      content: 'nous retenons la variante courte',
      provenance: PROVENANCE,
      closure: { declared: true, statement: 'point clos' },
    });

    // ---- S6 : supersession scopée sur E1, sans retrait.
    const h2 = await recordReconciliation(deps, {
      runId: paths.runId,
      expected_revision: await revision(),
      target_controversy_id: ctv,
      scope_kind: 'SUBSET',
      scope: [e1],
      content: 'nous révisons la variante',
      provenance: PROVENANCE,
      supersedes: [{ superseded_act_id: h1.entry.entry_id, supersession_scope: [e1] }],
    });

    // ---- `CR5-01` sur des journaux réels : la décision bascule, la clôture non.
    let entries = (await readReconciliationJournal(paths)).entries;
    assert.deepEqual(currentDecisions(entries, e1), [h2.entry.entry_id]);
    assert.deepEqual(currentClosureEffects(entries, e1), [h1.entry.entry_id]);
    assert.deepEqual(currentClosureEffects(entries, e2), [h1.entry.entry_id]);

    // ---- S7 : retrait explicite, scopé sur E1 seulement.
    const h3 = await recordReconciliation(deps, {
      runId: paths.runId,
      expected_revision: await revision(),
      target_controversy_id: ctv,
      scope_kind: 'SUBSET',
      scope: [e1],
      content: 'nous rouvrons ce point précis',
      provenance: PROVENANCE,
      closure_withdrawal: {
        declared: true,
        withdrawn_closures: [h1.entry.entry_id],
        withdrawal_scope: [e1],
        statement: 'retrait explicite',
      },
    });
    entries = (await readReconciliationJournal(paths)).entries;
    assert.deepEqual(currentClosureEffects(entries, e1), []);
    // Le retrait est scopé : E2 conserve l'effet historique de H1.
    assert.deepEqual(currentClosureEffects(entries, e2), [h1.entry.entry_id]);

    // ---- S13 : proposition assistée, adaptateur DOUBLÉ, par la voie contrôlée.
    const adapters = {
      claude: doubledAdapter(
        'claude',
        JSON.stringify({
          version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
          target_controversy_id: ctv,
          proposals: [
            {
              scope: [e1],
              options: [
                { option_id: 'oa', content: 'TTL de 30 s' },
                { option_id: 'ob', content: 'TTL de 5 min' },
              ],
            },
          ],
        }),
      ),
      codex: doubledAdapter('codex', ''),
    };
    const proposerDeps = { runsDir, now, createAdapters: () => adapters };
    const proposed = await runControlledAcceptanceProposal(
      proposerDeps,
      {
        runId: paths.runId,
        target_controversy_id: ctv,
        scope_kind: 'SUBSET',
        scope: [e1, e2],
        expert_slot: 'challenger',
      },
      { gate: 'G4_REAL_PROPOSAL_ACCEPTANCE', humanAuthorization: 'S15 — adaptateur doublé' },
    );
    assert.equal(proposed.kind, 'RECORDED');
    if (proposed.kind !== 'RECORDED') throw new Error('inatteignable');
    const proposal = proposed.entries[0];
    assert.ok(proposal, 'une proposition canonique existe');
    assert.equal(proposal.semantic_origin, 'CCR');
    assert.equal(proposal.derivation.method, 'MODEL_ASSISTED');
    assert.equal(proposal.derivation.invocation_id, proposed.invocation_id);
    assert.equal(dispatches, 1);

    // ---- S8 : une réponse historique, puis un acte humain ADOPTS.
    await recordProposalResponse(deps, {
      runId: paths.runId,
      expected_revision: await revision(),
      target_controversy_id: ctv,
      proposal_id: proposal.entry_id,
      mode: 'REJECT',
      provenance: PROVENANCE,
    });
    const h4 = await recordReconciliation(deps, {
      runId: paths.runId,
      expected_revision: await revision(),
      target_controversy_id: ctv,
      scope_kind: 'SUBSET',
      scope: [e2],
      content: 'nous adoptons cette option, dans nos termes',
      provenance: PROVENANCE,
      responds_to: { proposal_id: proposal.entry_id, relation: 'ADOPTS', adopted_option_id: 'oa' },
    });

    // La proposition CCR reste CCR après adoption ET rejet.
    entries = (await readReconciliationJournal(paths)).entries;
    const stored = entries.find((entry) => entry.entry_id === proposal.entry_id);
    assert.equal(stored?.semantic_origin, 'CCR');
    assert.equal(stored?.recorded_by, 'CCR');

    // ---- S9 · S10 · S11 · S12 : les dérivées, sur l'instantané réel.
    const snapshot = await readStableNativeRunSnapshot(runsDir, paths.runId);
    const model = projectReconciliationReadModel(snapshot);
    assert.equal(model.availability, 'AVAILABLE');
    if (model.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.equal(model.recorded_count, 6);
    const item = model.items[0];
    assert.ok(item, 'le read model expose la controverse observée');
    assert.equal(item.controversy_id, ctv);
    assert.equal(item.recorded_acts.length, 4);
    assert.equal(item.proposals.length, 1);
    assert.equal(item.responses.length, 1);
    assert.equal(item.closure_declarations.length, 1);
    assert.equal(item.closure_withdrawal_declarations.length, 1);
    assert.equal(item.supersession_relations.length, 1);

    // Les deux actualités restent deux champs — `C51`, sur un journal réel.
    assert.deepEqual(
      item.decision_currentness.filter((row) => row.act_id === h1.entry.entry_id),
      [
        { act_id: h1.entry.entry_id, unit: e1, current: false },
        { act_id: h1.entry.entry_id, unit: e2, current: true },
      ],
    );
    assert.deepEqual(item.closure_effect_currentness, [
      { unit: e1, act_ids: [] },
      { unit: e2, act_ids: [h1.entry.entry_id] },
    ]);

    // Détections et signaux composés, non réinterprétés.
    const detected = detectReconciliationStructures(snapshot);
    assert.equal(detected.availability, 'PRODUCED');
    if (detected.availability !== 'PRODUCED') throw new Error('inatteignable');
    assert.deepEqual(item.detections, detected.detections);
    assert.deepEqual(item.disagreement_view, observedDisagreementSignals(snapshot.controversies));
    // `D08` — l'effet retiré est observé sur E1, et lui seul.
    assert.deepEqual(
      item.detections.filter((d) => d.category === 'D08'),
      [{ category: 'D08', controversy_id: ctv, unit: e1, act_id: h1.entry.entry_id }],
    );

    // ---- S14 : la surface CLI rend les mêmes faits, sans statut global.
    const io = capture();
    const cliDeps = { runsDir, now, createAdapters: () => adapters } as never;
    assert.equal(await runCli(['reconciliation', '--run', paths.runId], { deps: cliDeps, io }), 0);
    const text = io.text();
    assert.ok(text.includes('actualité de décision'));
    assert.ok(text.includes("actualité d'effet de clôture"));
    assert.ok(text.includes(h4.entry.entry_id));
    for (const forbidden of ['CONVERGED', 'REOPENED', 'RESOLVED', 'gagnant']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }

    // ---- La porte publique est OUVERTE depuis la décision produit du
    // 2026-08-21. Cette composition n'en dépend pas : elle a emprunté la voie
    // d'acceptation contrôlée, avec son autorisation explicite, et un seul appel
    // — doublé — a eu lieu.
    assert.equal(MODEL_RECONCILIATION_PROPOSAL_RUNTIME_AVAILABILITY, 'AVAILABLE');
    assert.equal(dispatches, 1);
    assert.ok(existsSync(paths.reconciliations));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Couverture — vérification, sans nouvelle propriété
// --------------------------------------------------------------------------

/** Classes de preuve du §44. Ensemble fermé. */
const PROOF_CLASSES = [
  'STATIC',
  'FIXTURE',
  'AUTOMATED_REAL_PROCESS',
  'REAL_NOW',
  'MODEL REAL GATE',
  'NOT_TESTED',
] as const;
type ProofClass = (typeof PROOF_CLASSES)[number];

interface Coverage {
  readonly id: string;
  readonly proof: ProofClass;
  readonly owner: string;
}

function span(prefix: string, from: number, to: number, proof: ProofClass, owner: string): Coverage[] {
  const rows: Coverage[] = [];
  for (let index = from; index <= to; index += 1) {
    rows.push({ id: `${prefix}${String(index).padStart(2, '0')}`, proof, owner });
  }
  return rows;
}

/** Où chaque propriété du §45 est prouvée. Aucune n'est ajoutée ici. */
const PXX: readonly Coverage[] = [
  ...span('P', 1, 3, 'FIXTURE', 'reconciliation-domain · -mutations · proposer-output'),
  ...span('P', 4, 5, 'FIXTURE', 'reconciliation-authority-form · -supersession'),
  ...span('P', 6, 10, 'FIXTURE', 'reconciliation-scope · -mutations'),
  ...span('P', 11, 13, 'FIXTURE', 'reconciliation-supersession'),
  ...span('P', 14, 15, 'FIXTURE', 'reconciliation-currentness'),
  ...span('P', 16, 17, 'FIXTURE', 'reconciliation-domain · -read-model · cli-reconciliation'),
  ...span('P', 18, 18, 'FIXTURE', 'reconciliation-response'),
  ...span('P', 19, 20, 'FIXTURE', 'reconciliation-proposal-dispatch'),
  ...span('P', 21, 24, 'FIXTURE', 'reconciliation-domain · -disagreement'),
  ...span('P', 25, 26, 'FIXTURE', 'reconciliation-disagreement'),
  ...span('P', 27, 27, 'FIXTURE', 'reconciliation-supersession'),
  ...span('P', 28, 28, 'FIXTURE', 'reconciliation-read-model'),
  ...span('P', 29, 29, 'FIXTURE', 'reconciliation-domain'),
  ...span('P', 30, 30, 'FIXTURE', 'cli-reconciliation'),
  ...span('P', 31, 34, 'FIXTURE', 'reconciliation-scope · -mutations'),
  ...span('P', 35, 35, 'FIXTURE', 'reconciliation-mutations'),
  ...span('P', 36, 39, 'FIXTURE', 'reconciliation-closure-withdrawal'),
  ...span('P', 40, 40, 'FIXTURE', 'reconciliation-currentness'),
  ...span('P', 41, 42, 'FIXTURE', 'reconciliation-supersession'),
  ...span('P', 43, 44, 'FIXTURE', 'reconciliation-currentness'),
  ...span('P', 45, 45, 'FIXTURE', 'reconciliation-response'),
  ...span('P', 46, 46, 'FIXTURE', 'reconciliation-mutations'),
  ...span('P', 47, 47, 'FIXTURE', 'reconciliation-read-model'),
  ...span('P', 48, 48, 'FIXTURE', 'reconciliation-currentness · -detections'),
  ...span('P', 49, 50, 'FIXTURE', 'reconciliation-response'),
];

/** Où chaque critère du §46 est prouvé. */
const CXX: readonly Coverage[] = [
  ...span('C', 1, 3, 'STATIC', 'reconciliation-domain'),
  ...span('C', 4, 9, 'FIXTURE', 'reconciliation-scope'),
  ...span('C', 10, 11, 'STATIC', 'reconciliation-domain'),
  ...span('C', 12, 13, 'FIXTURE', 'reconciliation-domain · proposer-output'),
  ...span('C', 14, 14, 'FIXTURE', 'reconciliation-mutations'),
  ...span('C', 15, 16, 'FIXTURE', 'reconciliation-closure-withdrawal'),
  ...span('C', 17, 22, 'FIXTURE', 'reconciliation-supersession'),
  ...span('C', 23, 28, 'FIXTURE', 'reconciliation-currentness'),
  ...span('C', 29, 29, 'FIXTURE', 'reconciliation-read-model'),
  ...span('C', 30, 30, 'FIXTURE', 'reconciliation-response'),
  ...span('C', 31, 35, 'FIXTURE', 'reconciliation-mutations · -authority-form'),
  ...span('C', 36, 37, 'FIXTURE', 'reconciliation-disagreement'),
  ...span('C', 38, 38, 'STATIC', 'reconciliation-domain'),
  ...span('C', 39, 42, 'FIXTURE', 'reconciliation-journal · -snapshot · -freshness'),
  ...span('C', 43, 43, 'AUTOMATED_REAL_PROCESS', 'reconciliation-proposal-dispatch'),
  ...span('C', 44, 44, 'FIXTURE', 'reconciliation-domain'),
  ...span('C', 45, 45, 'FIXTURE', 'reconciliation-proposer-output'),
  ...span('C', 46, 46, 'FIXTURE', 'reconciliation-proposal-dispatch'),
  ...span('C', 47, 48, 'FIXTURE', 'cli-reconciliation-override'),
  ...span('C', 49, 49, 'FIXTURE', 'reconciliation-read-model · cli-reconciliation'),
  ...span('C', 50, 52, 'FIXTURE', 'reconciliation-read-model · -detections'),
  ...span('C', 53, 54, 'FIXTURE', 'reconciliation-response'),
];

/** Les trente-trois validations du §34. */
const VXX: readonly Coverage[] = [
  ...span('V', 1, 33, 'FIXTURE', 'reconciliation-domain · -scope · -mutations · proposer-output'),
];

/** Les huit détections du §14.2. */
const DXX: readonly Coverage[] = [
  ...span('D', 1, 8, 'FIXTURE', 'reconciliation-detections'),
];

function assertClosedSpan(rows: readonly Coverage[], prefix: string, count: number): void {
  assert.equal(rows.length, count, `${prefix} : cardinalité`);
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, count, `${prefix} : doublon`);
  for (let index = 1; index <= count; index += 1) {
    const id = `${prefix}${String(index).padStart(2, '0')}`;
    assert.ok(ids.includes(id), `${prefix} : ${id} absent`);
  }
  for (const row of rows) {
    assert.ok(
      (PROOF_CLASSES as readonly string[]).includes(row.proof),
      `${row.id} : classe de preuve hors §44`,
    );
    assert.ok(row.owner.length > 0, `${row.id} : aucun propriétaire`);
  }
}

test('V5 · S15 — la couverture est complète, fermée et sans doublon', () => {
  assertClosedSpan(PXX, 'P', 50);
  assertClosedSpan(CXX, 'C', 54);
  assertClosedSpan(VXX, 'V', 33);
  assertClosedSpan(DXX, 'D', 8);

  // Aucune classe `NOT_TESTED` n'est employée pour une propriété du contrat :
  // ce qui reste non testé est nommé au rapport, jamais masqué dans la matrice.
  for (const row of [...PXX, ...CXX, ...VXX, ...DXX]) {
    assert.notEqual(row.proof, 'NOT_TESTED', `${row.id} : couverture manquante`);
  }
});

test('V5 · S15 — le fournisseur réel demeure hors de cette suite', () => {
  // La classe `REAL_NOW` du §44 est réservée à ce qu'un gate observe réellement.
  // Aucune ligne de cette matrice ne la revendique.
  for (const row of [...PXX, ...CXX, ...VXX, ...DXX]) {
    assert.notEqual(row.proof, 'REAL_NOW', `${row.id} : REAL_NOW revendiqué hors gate`);
    assert.notEqual(row.proof, 'MODEL REAL GATE', `${row.id} : gate modèle revendiqué`);
  }
  // La porte publique est ouverte depuis le 2026-08-21. Ce n'est donc plus elle
  // qui tient les fournisseurs hors de cette suite : ce sont les adaptateurs
  // doublés que chaque test injecte. La garantie a changé de porteur, et il faut
  // le dire plutôt que de laisser une assertion périmée en tenir lieu.
  assert.equal(MODEL_RECONCILIATION_PROPOSAL_RUNTIME_AVAILABILITY, 'AVAILABLE');
});
