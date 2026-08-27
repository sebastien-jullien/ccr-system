/**
 * V5.1 — surface HTTP de mutation V5, et opération longue de proposition.
 *
 * Question de preuve :
 *
 * > **Le transport peut-il exposer les gestes V5 sans en devenir une seconde
 * > autorité, et une retransmission peut-elle produire un second appel
 * > fournisseur ?**
 *
 * Quatre propriétés.
 *
 *  1. **Union fermée.** Une opération inconnue, un champ inattendu ou un champ
 *     dont CCR est l'autorité sont refusés avant tout claim.
 *  2. **Délégation.** Chaque opération appelle son service propriétaire, et le
 *     transport ne rejoue aucune règle : `ACCEPT` reste une réponse, `MODIFIES`
 *     reste un acte humain.
 *  3. **Opération longue.** La proposition assistée rend `202` puis se termine ;
 *     aucune requête n'est maintenue ouverte pendant l'appel.
 *  4. **Idempotence.** Deux envois de la même clé produisent UN appel
 *     fournisseur, et le même reçu.
 *
 * Aucun fournisseur réel : l'adaptateur est doublé, et il compte ses appels.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import {
  createOperationStore,
  newServerInstanceId,
} from '../../src/cockpit/operations-store.ts';
import type { OperationStore } from '../../src/cockpit/operations-store.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import type { LongOperationManager } from '../../src/cockpit/long-operations.ts';
import {
  RECONCILIATION_MUTATION_ROUTE_SEGMENT,
  RECONCILIATION_OPERATIONS,
  executeReconciliationMutation,
} from '../../src/cockpit/mutations-http.ts';
import type { MutationResponse } from '../../src/cockpit/mutations-http.ts';
import { readNativeRunHttpView } from '../../src/cockpit/native-read-http.ts';
import { readReconciliationJournal } from '../../src/store/reconciliation-store.ts';
import { readCurrentReconciliationRevision } from '../../src/services/reconciliation-freshness.ts';
import { RECONCILIATION_PROPOSAL_OUTPUT_VERSION } from '../../src/services/reconciliation-proposer.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import { isCcrError } from '../../src/core/errors.ts';

const RUN_ID = 'CCR-20260821-501';
const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);

const PROVENANCE = { kind: 'DECLARED', statement: 'décidé en revue' } as const;

const VALID_OUTPUT = JSON.stringify({
  version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
  target_controversy_id: CTV,
  proposals: [{ scope: [E1], options: [{ option_id: 'oa', content: 'option a' }] }],
});

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly store: OperationStore;
  readonly manager: LongOperationManager;
  readonly deps: {
    runService: RunServiceDeps;
    store: OperationStore;
    manager: LongOperationManager;
  };
  calls(): number;
  revision(): Promise<string>;
  dispose(): Promise<void>;
}

function countingAdapter(kind: 'claude' | 'codex', calls: string[]): AgentAdapter {
  return {
    kind,
    async start(prompt: string): Promise<AgentTurnResult> {
      calls.push(prompt);
      return {
        agent: kind,
        sessionId: `v51-${kind}`,
        content: VALID_OUTPUT,
        exitCode: 0,
        startedAt: '2026-08-21T10:00:00.000Z',
        completedAt: '2026-08-21T10:00:01.000Z',
        stdoutRaw: VALID_OUTPUT,
        stderrRaw: '',
      };
    },
    resume(): never {
      throw new Error('jamais');
    },
    openInteractive(): never {
      throw new Error('jamais');
    },
  };
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-v51-http-'));
  const dataRoot = await resolveCockpitDataRoot(dir);
  const runsDir = dataRoot.runsDir;
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, created_at: '2026-08-21T09:00:00.000Z', title: 'v51',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'codex', session_id: 'S1' },
      challenger: { provider: 'claude', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000001',
    updated_at: '2026-08-21T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, `${JSON.stringify({
    event_id: 'evt_000001', run_id: RUN_ID, round: 1, timestamp: '2026-08-21T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: 'le cache doit expirer',
  })}\n`, 'utf8');
  await writeFile(paths.controversies, `${JSON.stringify({
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: E1,
    controversy_id: CTV,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-21T09:30:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  })}\n`, 'utf8');

  const calls: string[] = [];
  const adapters = {
    claude: countingAdapter('claude', calls),
    codex: countingAdapter('codex', calls),
  };
  const store = createOperationStore(dataRoot, newServerInstanceId());
  const manager = createLongOperationManager();
  const runService: RunServiceDeps = {
    runsDir,
    now: () => new Date('2026-08-21T12:00:00.000Z'),
    createAdapters: (): AgentAdapters => adapters as unknown as AgentAdapters,
  };

  return {
    runsDir,
    paths,
    store,
    manager,
    deps: { runService, store, manager },
    calls: () => calls.length,
    revision: () => readCurrentReconciliationRevision({ runsDir }, RUN_ID),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Le corps voyage comme sur le fil : une chaîne, jamais un objet déjà parsé. */
function post(
  h: Harness,
  body: unknown,
  key: string,
): Promise<MutationResponse> {
  return executeReconciliationMutation(h.deps, {
    routeSegment: RECONCILIATION_MUTATION_ROUTE_SEGMENT,
    runId: RUN_ID,
    generation: 'NATIVE_V21_EXECUTION',
    contentType: 'application/json',
    idempotencyKey: key,
    body: JSON.stringify(body),
  });
}

/** Attend le reçu terminal d'une opération longue, sans jamais le supposer. */
async function settled(h: Harness, operationId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const receipt = await h.store.read(operationId);
    if (receipt !== undefined && receipt.status !== 'RUNNING') return String(receipt.status);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('le reçu n’est jamais devenu terminal');
}

// --------------------------------------------------------------------------
// A. Union fermée
// --------------------------------------------------------------------------

test('V5.1 — trois opérations exactement, et rien d’autre', () => {
  assert.deepEqual([...RECONCILIATION_OPERATIONS], [
    'RECORD_ACT',
    'RESPOND',
    'PROPOSE_BY_MODEL',
  ]);
  assert.equal(RECONCILIATION_MUTATION_ROUTE_SEGMENT, 'reconciliations');
});

test('V5.1 — opération inconnue, champ inattendu et champ serveur sont refusés', async () => {
  const h = await harness();
  try {
    const revision = await h.revision();
    for (const body of [
      { operation: 'ADOPT', expected_revision: revision },
      { operation: 'RESPOND', expected_revision: revision, merits_confidence: 0.9 },
      { operation: 'RECORD_ACT', expected_revision: revision, semantic_origin: 'HUMAN' },
      { operation: 'RECORD_ACT', expected_revision: revision, recorded_by: 'HUMAN' },
      { operation: 'RECORD_ACT' },
    ]) {
      await assert.rejects(
        () => post(h, body, `ccr-${JSON.stringify(body).length}-${String(Math.trunc(1))}`),
        (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
      );
    }
    // Aucun claim, donc aucun octet : le refus précède toute trace durable.
    assert.equal(existsSync(h.paths.reconciliations), false);
    assert.equal(h.calls(), 0);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// B. Délégation — chaque geste à son service propriétaire
// --------------------------------------------------------------------------

test('V5.1 — `RECORD_ACT` enregistre un acte humain, et la vue le montre', async () => {
  const h = await harness();
  try {
    const response = await post(h, {
      operation: 'RECORD_ACT',
      expected_revision: await h.revision(),
      target_controversy_id: CTV,
      scope_kind: 'SUBSET',
      scope: [E1],
      content: 'ce que la personne a décidé',
      provenance: PROVENANCE,
    }, 'ccr-record-act-1');

    assert.equal(response.status, 200);
    assert.equal(response.receipt.status, 'SUCCEEDED');
    // La révision du reçu est celle du DOMAINE V5, pas celle du run.
    assert.match(String(response.receipt.revision_after), /^rcn-sha256:/);

    const journal = await readReconciliationJournal(h.paths);
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.entries[0]?.semantic_origin, 'HUMAN');

    const vue = await readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);
    assert.equal(vue.reconciliations.availability, 'AVAILABLE');
    assert.equal(h.calls(), 0, 'un acte humain n’appelle aucun fournisseur');
  } finally {
    await h.dispose();
  }
});

test('V5.1 — `RESPOND` refuse une proposition absente, par son propriétaire', async () => {
  const h = await harness();
  try {
    const response = await post(h, {
      operation: 'RESPOND',
      expected_revision: await h.revision(),
      target_controversy_id: CTV,
      proposal_id: 'rcn_000009',
      mode: 'ACCEPT',
      provenance: PROVENANCE,
    }, 'ccr-respond-1');

    // Le refus est déterministe et terminal : le reçu le porte, sans réévaluer.
    assert.equal(response.receipt.status, 'FAILED');
    assert.equal(response.receipt.error_code, 'INVALID_ARGUMENT');
    assert.equal(existsSync(h.paths.reconciliations), false, 'aucun octet sur refus');
    assert.equal(h.calls(), 0);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — une vue périmée est refusée sous le verrou, pas prévalidée au transport', async () => {
  const h = await harness();
  try {
    const response = await post(h, {
      operation: 'RECORD_ACT',
      expected_revision: 'rcn-sha256:0000000000000000000000000000000000000000000000000000000000000000',
      target_controversy_id: CTV,
      scope_kind: 'SUBSET',
      scope: [E1],
      content: 'décidé sur une vue qui n’existe plus',
      provenance: PROVENANCE,
    }, 'ccr-stale-1');

    assert.equal(response.receipt.status, 'FAILED');
    assert.equal(existsSync(h.paths.reconciliations), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C. Opération longue et idempotence
// --------------------------------------------------------------------------

test('V5.1 — `PROPOSE_BY_MODEL` rend 202, puis se termine, sans requête maintenue', async () => {
  const h = await harness();
  try {
    const response = await post(h, {
      operation: 'PROPOSE_BY_MODEL',
      target_controversy_id: CTV,
      scope_kind: 'WHOLE',
      expert_slot: 'challenger',
    }, 'ccr-propose-1');

    // Le 202 arrive dès la réservation du créneau : la réponse ne dit rien du
    // fournisseur, et surtout ne l'attend pas.
    assert.equal(response.status, 202);
    assert.equal(response.receipt.status, 'RUNNING');

    const status = await settled(h, response.receipt.operation_id);
    assert.equal(status, 'SUCCEEDED');
    assert.equal(h.calls(), 1, 'un seul appel, sans reprise ni second essai');

    const journal = await readReconciliationJournal(h.paths);
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.entries[0]?.semantic_origin, 'CCR', 'la proposition reste CCR');

    // Le créneau est rendu : rien ne reste réservé après la fin.
    assert.equal(h.manager.activeCount(), 0);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — deux envois de la même clé : UN appel fournisseur, le même reçu', async () => {
  const h = await harness();
  try {
    const body = {
      operation: 'PROPOSE_BY_MODEL',
      target_controversy_id: CTV,
      scope_kind: 'WHOLE',
      expert_slot: 'challenger',
    };
    const first = await post(h, body, 'ccr-propose-idem');
    const status = await settled(h, first.receipt.operation_id);
    assert.equal(status, 'SUCCEEDED');

    // Rejeu exact de la MÊME intention : le reçu déjà rendu, tel quel.
    const second = await post(h, body, 'ccr-propose-idem');
    assert.equal(second.receipt.operation_id, first.receipt.operation_id);
    assert.equal(second.receipt.status, 'SUCCEEDED');

    assert.equal(h.calls(), 1, 'la retransmission n’a rappelé aucun fournisseur');
    const journal = await readReconciliationJournal(h.paths);
    assert.equal(journal.entries.length, 1, 'et n’a écrit aucun second acte');
  } finally {
    await h.dispose();
  }
});

test('V5.1 — sans gestionnaire d’opérations longues, la proposition n’est pas synchrone', async () => {
  const h = await harness();
  try {
    // Le refus est explicite : tenir la requête ouverte pendant l'appel serait
    // pire qu'échouer, et improviser un second moteur pire encore.
    const response = await executeReconciliationMutation(
      { runService: h.deps.runService, store: h.store },
      {
        routeSegment: RECONCILIATION_MUTATION_ROUTE_SEGMENT,
        runId: RUN_ID,
        generation: 'NATIVE_V21_EXECUTION',
        contentType: 'application/json',
        idempotencyKey: 'ccr-propose-nomanager',
        body: JSON.stringify({
          operation: 'PROPOSE_BY_MODEL',
          target_controversy_id: CTV,
          scope_kind: 'WHOLE',
          expert_slot: 'challenger',
        }),
      },
    );
    assert.equal(response.receipt.status, 'FAILED');
    assert.equal(h.calls(), 0);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D. Le transport n'est pas une autorité
// --------------------------------------------------------------------------

test('V5.1 — le transport ne construit ni origine, ni actualité, ni clôture', async () => {
  const source = (await readFile(new URL('../../src/cockpit/mutations-http.ts', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const forbidden of [
    "semantic_origin:",
    "recorded_by:",
    'decision_currentness',
    'closure_effect_currentness',
    'appendReconciliationEntries',
    'runControlledAcceptanceProposal',
  ]) {
    assert.equal(source.includes(forbidden), false, `le transport porte « ${forbidden} »`);
  }
});
