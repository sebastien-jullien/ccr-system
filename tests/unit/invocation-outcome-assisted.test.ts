/**
 * Durabilité de l'issue négative — chemin assisté V5.
 *
 * Ce qui est éprouvé :
 *
 * ```text
 * G  INVALID_OUTPUT       fait durable, motif natif V5 conservé
 * H  REVALIDATION_REFUSED fait durable avant exposition
 * I  PROVIDER_FAILED      code natif conservé quand connu,
 *                         aucune cause inventée sinon
 *    VALID_ZERO           n'est pas une issue négative : aucun fait écrit
 * ```
 *
 * Le harnais est celui de la tranche S13 : vrai filesystem, vrai verrou, vrai
 * ledger, adaptateur injecté. Aucun fournisseur réel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CcrError } from '../../src/core/errors.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
  validateControversyEntry,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import {
  RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
  proposeReconciliationByModel,
} from '../../src/services/reconciliation-proposer.ts';
import type { ReconciliationProposerDeps } from '../../src/services/reconciliation-proposer.ts';
import { readInvocationOutcomes } from '../../src/store/invocation-outcome-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';

const RUN_ID = 'CCR-20260820-914';
const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);

const EVENTS: readonly Record<string, unknown>[] = [
  {
    schema_version: 3,
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'S1',
    timestamp: '2026-08-20T09:10:00.000Z',
    content: 'Le cache doit expirer rapidement.',
  },
];

interface FakeAdapter extends AgentAdapter {
  readonly calls: string[];
}

interface AdapterScript {
  readonly content?: string;
  readonly fail?: unknown;
}

function fakeAdapter(kind: 'claude' | 'codex', script: AdapterScript): FakeAdapter {
  const calls: string[] = [];
  return {
    kind,
    calls,
    async start(prompt: string): Promise<AgentTurnResult> {
      calls.push(prompt);
      if (script.fail !== undefined) throw script.fail;
      return {
        agent: kind,
        sessionId: `propose-${kind}-1`,
        content: script.content ?? '',
        exitCode: 0,
        startedAt: '2026-08-20T10:00:00.000Z',
        completedAt: '2026-08-20T10:00:01.000Z',
        stdoutRaw: script.content ?? '',
        stderrRaw: '',
      };
    },
    resume(): Promise<AgentTurnResult> {
      throw new Error("une proposition assistée ne reprend jamais la session d'un expert");
    },
    openInteractive(): never {
      throw new Error("une proposition assistée n'ouvre aucun terminal");
    },
  };
}

interface Harness {
  readonly paths: RunPaths;
  readonly deps: ReconciliationProposerDeps;
  dispose(): Promise<void>;
}

function unit(sequence: number): ControversyEntry {
  return validateControversyEntry({
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: CTV,
    kind: sequence === 1 ? 'CONTROVERSY_RECORDED' : 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'SOURCE', actor: 'author' },
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T09:30:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  } as ControversyEntry);
}

async function harness(script: AdapterScript = {}): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-outcome-v5-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-08-20T09:00:00.000Z',
      title: 'issues négatives',
      workspace: { cwd: runsDir },
      experts: {
        author: { provider: 'codex', session_id: 'S1' },
        challenger: { provider: 'claude', session_id: 'S2' },
      },
    }),
    'utf8',
  );
  await writeFile(
    paths.state,
    JSON.stringify({
      schema_version: 3,
      run_id: RUN_ID,
      state: 'READY',
      control: 'AUTOMATION',
      round: 1,
      active_expert_slot: null,
      next_step_source_slot: 'author',
      last_event_id: 'evt_000001',
      updated_at: '2026-08-20T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  await writeFile(
    paths.controversies,
    [unit(1), unit(2)].map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );

  const adapters = { claude: fakeAdapter('claude', script), codex: fakeAdapter('codex', script) };
  let tick = 0;
  const now = (): Date => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 20, 12, 0, tick));
  };

  return {
    paths,
    deps: { runsDir, now, createAdapters: () => adapters },
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

function propose(h: Harness): ReturnType<typeof proposeReconciliationByModel> {
  return proposeReconciliationByModel(h.deps, {
    runId: RUN_ID,
    target_controversy_id: CTV,
    scope_kind: 'SUBSET',
    scope: [E1, E2],
    expert_slot: 'challenger',
  });
}

async function outcomes(h: Harness): Promise<ReturnType<typeof readInvocationOutcomes>> {
  return readInvocationOutcomes(h.paths);
}

// --------------------------------------------------------------------------
// G — INVALID_OUTPUT
// --------------------------------------------------------------------------

test('G — INVALID_OUTPUT : fait durable, motif natif V5 conservé', async () => {
  const h = await harness({ content: 'ceci n’est pas du JSON' });
  try {
    const result = await propose(h);
    assert.equal(result.kind, 'INVALID_OUTPUT');

    const document = await outcomes(h);
    assert.equal(document.outcomes.length, 1);
    assert.equal(document.outcomes[0]?.invocation_id, result.invocation_id);

    const fact = document.outcomes[0]?.terminal_negative_outcome;
    // Le discriminant nomme l'opération d'origine ; le motif reste celui de V5.
    assert.equal(fact?.kind, 'V5_INVALID_OUTPUT');
    assert.equal((fact as { reason: string }).reason, 'OUTPUT_UNPARSABLE');
    assert.equal((fact as { at: string }).at, 'output');
  } finally {
    await h.dispose();
  }
});

test("G — VALID_ZERO n'est pas une issue négative : aucun fait n'est écrit", async () => {
  const h = await harness({
    content: JSON.stringify({
      version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
      target_controversy_id: CTV,
      proposals: [],
    }),
  });
  try {
    const result = await propose(h);
    assert.equal(result.kind, 'VALID_ZERO');
    assert.equal(existsSync(h.paths.invocationOutcomes), false);
    assert.equal((await outcomes(h)).outcomes.length, 0);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// H — REVALIDATION_REFUSED
// --------------------------------------------------------------------------

test('H — REVALIDATION_REFUSED : fait durable, contrôle natif conservé', async () => {
  // `E3` n'appartient pas à l'ensemble soumis : la phase C refuse.
  const outside = formatControversyEntryId(3);
  const h = await harness({
    content: JSON.stringify({
      version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
      target_controversy_id: CTV,
      proposals: [{ scope: [outside], options: [{ option_id: 'oa', content: 'option a' }] }],
    }),
  });
  try {
    const result = await propose(h);
    assert.equal(result.kind, 'REVALIDATION_REFUSED');

    const document = await outcomes(h);
    assert.equal(document.outcomes.length, 1);
    const fact = document.outcomes[0]?.terminal_negative_outcome;
    assert.equal(fact?.kind, 'V5_REVALIDATION_REFUSED');
    // Le contrôle appartient au vocabulaire fermé de V5.
    assert.ok(
      ['R0', 'SCOPE', 'SUBMITTED_SET', 'CANONICAL_FORM'].includes((fact as { check: string }).check),
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// I — PROVIDER_FAILED
// --------------------------------------------------------------------------

test('I — PROVIDER_FAILED : le code natif connu est conservé', async () => {
  const h = await harness({ fail: new CcrError('AGENT_TIMEOUT', 'délai dépassé') });
  try {
    const result = await propose(h);
    assert.equal(result.kind, 'PROVIDER_FAILED');

    const document = await outcomes(h);
    assert.deepEqual(document.outcomes[0]?.terminal_negative_outcome, {
      kind: 'V5_PROVIDER_FAILED',
      error_code: 'AGENT_TIMEOUT',
    });
  } finally {
    await h.dispose();
  }
});

test("I — PROVIDER_FAILED : une cause inconnue n'est jamais fabriquée", async () => {
  const h = await harness({ fail: new Error('panne quelconque') });
  try {
    const result = await propose(h);
    assert.equal(result.kind, 'PROVIDER_FAILED');
    // La valeur publique du résultat demeure `UNEXPECTED` — inchangée.
    assert.equal((result as { error_code: string }).error_code, 'UNEXPECTED');

    // Mais rien de tel n'est persisté : un aveu d'ignorance n'est pas une cause.
    const document = await outcomes(h);
    assert.deepEqual(document.outcomes[0]?.terminal_negative_outcome, { kind: 'V5_PROVIDER_FAILED' });
  } finally {
    await h.dispose();
  }
});
