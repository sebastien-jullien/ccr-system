/**
 * Le workspace comme **contexte de travail initial** d'un run.
 *
 * Question de preuve :
 *
 * > **Un run conserve-t-il correctement son répertoire de travail initial — et
 * > CCR s'abstient-il désormais d'en faire une frontière de sécurité ?**
 *
 * La branche doctrinale de « hard workspace confinement » a été retirée par
 * décision humaine. Ce qui subsiste ici est utile indépendamment d'elle :
 *
 * ```text
 * CONTEXTE DE TRAVAIL INITIAL   ≠   FRONTIÈRE DE SÉCURITÉ
 * racine canonique              ≠   isolation du fournisseur
 * realpath                      ≠   confinement
 * ```
 *
 * CCR ne surveille pas l'exploration du système de fichiers par un fournisseur :
 * les permissions de ses outils appartiennent à son propre environnement.
 *
 * ```text
 * REAL_PROVIDER_CALLS = 0
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalizeWorkspace } from '../../src/services/start-mutation.ts';
import { validateNativeManifest } from '../../src/store/native-store.ts';
import { validateInvocationDispatchRecord } from '../../src/core/usage-governance.ts';
import { requestModelReconciliationProposal } from '../../src/services/reconciliation-proposer.ts';
import { RECONCILIATION_PROPOSAL_OUTPUT_VERSION } from '../../src/services/reconciliation-proposer.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { isCcrError } from '../../src/core/errors.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';

// --------------------------------------------------------------------------
// B. Canonicalisation — conservée, et sans sémantique de sécurité
// --------------------------------------------------------------------------

test('workspace — un chemin relatif est refusé', async () => {
  await assert.rejects(
    () => canonicalizeWorkspace('runs'),
    (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
  );
});

test('workspace — un répertoire absent est refusé sans décrire l’hôte', async () => {
  const absent = path.join(tmpdir(), `ccr-absent-${String(process.pid)}`, 'nulle-part');
  await assert.rejects(
    () => canonicalizeWorkspace(absent),
    (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT' && !error.message.includes(absent),
  );
});

test('workspace — un fichier n’est pas un répertoire de travail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-wsfile-'));
  try {
    const file = path.join(dir, 'fichier.txt');
    await writeFile(file, 'x', 'utf8');
    await assert.rejects(
      () => canonicalizeWorkspace(file),
      (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace — deux formes du même répertoire donnent une seule racine', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-wsalias-'));
  try {
    const real = path.join(dir, 'projet');
    await mkdir(real, { recursive: true });

    // Identité du run, pas sécurité : deux orthographes du même répertoire ne
    // doivent pas produire deux runs distincts.
    const detour = path.join(dir, 'projet', '.', '..', 'projet');
    assert.equal(await canonicalizeWorkspace(detour), await canonicalizeWorkspace(real));

    const link = path.join(dir, 'alias');
    let linked = true;
    try {
      await symlink(real, link, 'junction');
    } catch {
      linked = false;
    }
    if (linked) {
      assert.equal(await canonicalizeWorkspace(link), await canonicalizeWorkspace(real));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// A + C. Le manifeste conserve le contexte initial, et rien d'autre
// --------------------------------------------------------------------------

function manifestWith(workspace: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 2,
    run_id: 'CCR-20260821-960',
    title: 'contexte initial',
    created_at: '2026-08-21T09:00:00.000Z',
    workspace,
    experts: {
      author: { provider: 'claude', session_id: null },
      challenger: { provider: 'codex', session_id: null },
    },
  };
}

test('manifeste — le répertoire de travail initial est conservé', () => {
  const manifest = validateNativeManifest(manifestWith({
    cwd: 'E:/prog/projet',
    declared_cwd: 'E:/prog/projet/.',
  }));
  assert.equal(manifest.workspace.cwd, 'E:/prog/projet');
  assert.equal(manifest.workspace.declared_cwd, 'E:/prog/projet/.', 'la forme déclarée reste traçable');
});

test('manifeste — aucune sémantique de confinement n’est portée', () => {
  const manifest = validateNativeManifest(manifestWith({ cwd: 'E:/prog/projet' }));
  assert.deepEqual(Object.keys(manifest.workspace).sort(), ['cwd']);
  assert.equal('confinement' in manifest.workspace, false);
});

test('manifeste — un ancien champ de confinement est ignoré, jamais promu', () => {
  // Aucun run persisté ne porte ce champ ; s'il en existait un, il serait
  // simplement écarté à la relecture — ni erreur, ni sémantique courante.
  const manifest = validateNativeManifest(manifestWith({
    cwd: 'E:/prog/projet',
    confinement: { mode: 'PROJECT_DATA_BOUNDARY', required: true },
  }));
  assert.deepEqual(Object.keys(manifest.workspace).sort(), ['cwd']);
});

// --------------------------------------------------------------------------
// E. Aucun champ d'audit de confinement dans les engagements
// --------------------------------------------------------------------------

function ledgerLine(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 4,
    kind: 'DISPATCH_COMMITTED',
    invocation_id: 'inv_000001',
    run_id: 'CCR-20260821-960',
    identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
    trigger_kind: 'RECONCILIATION_PROPOSAL',
    dispatch_committed_at: '2026-08-21T13:05:47.597Z',
    ...extra,
  };
}

test('ledger — un engagement ne porte aucun champ de confinement', () => {
  const record = validateInvocationDispatchRecord(ledgerLine());
  const carried = Object.keys(record);
  for (const field of [
    'workspace_confinement_mode',
    'workspace_confinement_enforced',
    'workspace_confinement_mechanism',
    'workspace_root_canonical',
  ]) {
    assert.equal(carried.includes(field), false, `champ abandonné encore présent : ${field}`);
  }
});

test('ledger — un ancien champ de confinement est écarté sans erreur', () => {
  const record = validateInvocationDispatchRecord(ledgerLine({
    workspace_confinement_mode: 'PROJECT_DATA_BOUNDARY',
    workspace_confinement_enforced: false,
  }));
  assert.equal(record.invocation_id, 'inv_000001', 'la ligne reste lisible');
  assert.equal(
    Object.keys(record).includes('workspace_confinement_mode'),
    false,
    'et le champ n’est pas repris',
  );
});

// --------------------------------------------------------------------------
// D + G. Le dispatch n'est plus refusé, et rien n'est migré
// --------------------------------------------------------------------------

const RUN_ID = 'CCR-20260821-961';
const CTV = 'ctv_000001';
const E1 = 'ctve_000001';

interface Harness {
  readonly paths: RunPaths;
  readonly deps: RunServiceDeps;
  starts(): number;
  manifestRaw(): Promise<string>;
  dispose(): Promise<void>;
}

/** Run portant l'ancienne forme Phase 1, pour prouver qu'elle n'est ni lue ni migrée. */
async function harness(withLegacyConfinement: boolean): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-ws-context-'));
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, created_at: '2026-08-21T09:00:00.000Z', title: 'contexte',
    workspace: {
      cwd: runsDir,
      ...(withLegacyConfinement
        ? { confinement: { mode: 'PROJECT_DATA_BOUNDARY', required: true } }
        : {}),
    },
    experts: {
      author: { provider: 'claude', session_id: 'S1' },
      challenger: { provider: 'codex', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 0,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000001',
    updated_at: '2026-08-21T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, `${JSON.stringify({
    event_id: 'evt_000001', run_id: RUN_ID, round: 0, timestamp: '2026-08-21T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: 'une position',
  })}\n`, 'utf8');
  await writeFile(paths.controversies, `${JSON.stringify({
    schema_version: 1, entry_id: E1, controversy_id: CTV, kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' }, recorded_by: 'HUMAN',
    recorded_at: '2026-08-21T09:30:00.000Z', round: 0, content: 'un désaccord',
    anchors: { provenance: [{ event_id: 'evt_000001', round: 0 }] },
  })}\n`, 'utf8');

  let starts = 0;
  const adapter = (kind: 'claude' | 'codex'): AgentAdapter => ({
    kind,
    async start(): Promise<AgentTurnResult> {
      starts += 1;
      const output = JSON.stringify({
        version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
        target_controversy_id: CTV,
        proposals: [{ scope: [E1], options: [{ option_id: 'o1', content: 'une option' }] }],
      });
      return {
        agent: kind, sessionId: `c-${kind}`, content: output, exitCode: 0,
        startedAt: '2026-08-21T10:00:00.000Z', completedAt: '2026-08-21T10:00:01.000Z',
        stdoutRaw: output, stderrRaw: '',
      };
    },
    resume(): never {
      throw new Error('jamais');
    },
    openInteractive(): never {
      throw new Error('jamais');
    },
  });

  return {
    paths,
    deps: {
      runsDir,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
      createAdapters: (): AgentAdapters =>
        ({ claude: adapter('claude'), codex: adapter('codex') }) as unknown as AgentAdapters,
    },
    starts: () => starts,
    manifestRaw: () => readFile(paths.manifest, 'utf8'),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

function propose(h: Harness): Promise<unknown> {
  return requestModelReconciliationProposal(h.deps, {
    runId: RUN_ID, target_controversy_id: CTV, scope_kind: 'WHOLE', expert_slot: 'author',
  } as Parameters<typeof requestModelReconciliationProposal>[1]);
}

test('dispatch — un run ordinaire atteint le fournisseur sans refus de workspace', async () => {
  const h = await harness(false);
  try {
    await propose(h);
    assert.equal(h.starts(), 1, 'le dispatch aboutit');

    const record = JSON.parse((await readFile(h.paths.invocations, 'utf8')).trim()) as Record<string, unknown>;
    assert.equal('workspace_confinement_enforced' in record, false, 'aucun faux audit');
    assert.equal('workspace_confinement_mode' in record, false);
  } finally {
    await h.dispose();
  }
});

test('dispatch — un run portant l’ancienne forme n’est plus refusé', async () => {
  // Autrefois : WORKSPACE_CONFINEMENT_UNAVAILABLE. La capacité étant abandonnée,
  // la présence résiduelle du champ ne bloque plus rien.
  const h = await harness(true);
  try {
    await propose(h);
    assert.equal(h.starts(), 1, 'le fournisseur est atteint');
  } finally {
    await h.dispose();
  }
});

test('dispatch — l’ancienne forme n’est ni migrée ni réécrite sur disque', async () => {
  const h = await harness(true);
  try {
    const before = await h.manifestRaw();
    await propose(h);
    assert.equal(await h.manifestRaw(), before, 'le manifeste sur disque est intact');
    // Le champ résiduel est toujours là, octet pour octet — CCR ne migre rien.
    assert.ok(before.includes('PROJECT_DATA_BOUNDARY'));
  } finally {
    await h.dispose();
  }
});
