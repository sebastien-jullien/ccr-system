/**
 * V2.2-IMP-09 — politique posée à la naissance, et lue sans ambiguïté.
 *
 * Deux propriétés, et une distinction.
 *
 *  1. **À la naissance, ou jamais.** Un run natif peut recevoir sa limite avant
 *     sa première tentative ; aucune surface ne permet d'en attacher une plus
 *     tard, ni d'en changer une. Le schéma ne porte ni date d'effet ni
 *     consommation de référence : une pose tardive perdrait la vérité même que
 *     le choix per-run persistant doit préserver.
 *  2. **La lecture ne modifie rien.** Aucun fichier n'est créé pour afficher un
 *     zéro.
 *
 * Et la distinction : `consumed = 0` ne dit pas qu'aucun modèle n'a répondu.
 * C'est `coverage` qui le dit.
 *
 * Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { readInvocationQuotaView } from '../../src/services/invocation-quota-read.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import { buildNativeRunReadModel } from '../../src/services/native-read-model.ts';
import { getRecoveryView, getRunView } from '../../src/services/cockpit-read-model.ts';
import { getRunStatus, startRun, stepRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { DEFAULT_MAX_TRANSFER_BYTES } from '../../src/services/transfer.ts';
import { runCli } from '../../src/cli/main.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { readPersistedManifest } from '../../src/store/native-store.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const WORKSPACE = 'E:/prog/exemple';
const MISSION = 'Mission initiale : évaluer la refonte.';
const SETTINGS = { maxTransferBytes: DEFAULT_MAX_TRANSFER_BYTES };

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  providerCalls(): number;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const runsDir = await makeTempDir('ccr-provisioning-');
  const build = (kind: ProviderKind) =>
    createFakeAdapter({ kind, sessionId: `${kind}-1`, startSessionIds: [`${kind}-1`, `${kind}-2`] });
  const claude = build('claude');
  const codex = build('codex');
  const adapters: AgentAdapters = { claude, codex };
  return {
    runsDir,
    providerCalls: () => claude.calls.length + codex.calls.length,
    deps: { runsDir, now: () => new Date(), createAdapters: () => adapters },
    cleanup: () => removeTempDir(runsDir),
  };
}

function nativeRuntimeConfig(): Parameters<typeof startNativeRun>[1]['runtimeConfig'] {
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: '2026-08-11T00:00:00.000Z',
    claude: { required: true, probe_status: 'OBSERVED', cli_version: '2.1.224', auth_preflight: 'AUTHENTICATED' },
    codex: {
      required: true,
      probe_status: 'OBSERVED',
      cli_version: '0.146.0',
      auth_preflight: 'AUTHENTICATED',
      skip_git_repo_check: false,
      source_at_capture: 'default',
    },
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

// ==========================================================================
// A. Provisioning à la naissance
// ==========================================================================

test('1 · sans option, aucun document et aucun changement', async () => {
  const h = await harness();
  try {
    const run = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
    });
    assert.equal(run.failure, undefined);
    assert.equal(await exists(runPaths(h.runsDir, run.runId).invocationPolicy), false);
    assert.deepEqual(await readInvocationQuotaView(runPaths(h.runsDir, run.runId)), {
      kind: 'NONE',
      consumed: 2,
      coverage: 'SINCE_LEDGER_START',
    });
  } finally {
    await h.cleanup();
  }
});

test('2 · limite 0 : la politique est durable avant la première tentative', async () => {
  const h = await harness();
  try {
    const run = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
      maxInvocations: 0,
    });

    assert.ok(run.failure, 'l’auteur est refusé par sa propre politique');
    assert.equal(run.failure.slot, 'author');
    assert.ok(isCcrError(run.failure.error) && run.failure.error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED');
    assert.equal(h.providerCalls(), 0);

    const paths = runPaths(h.runsDir, run.runId);
    assert.equal(await exists(paths.invocationPolicy), true, 'posée avant le premier contrôle');
    // V2.2-IMP-09R : le journal est activé à la naissance. Présent et vide, il
    // dit exactement « autorité active, aucun engagement » — là où son absence
    // aurait dit « histoire indémontrable », ce qui serait faux ici.
    assert.equal(await exists(paths.invocations), true, 'autorité activée');
    assert.equal(await readFile(paths.invocations, 'utf8'), '', 'et strictement vide');
    assert.deepEqual(await readInvocationQuotaView(paths), {
      kind: 'CONFIGURED',
      limit: 0,
      consumed: 0,
      remaining: 0,
      exhausted: true,
      coverage: 'SINCE_LEDGER_START',
    });

    // Le run existe, inspectable et récupérable — simplement sans budget.
    const view = await buildNativeRunReadModel({ runsDir: h.runsDir }, run.runId);
    assert.equal(view.operational_state.state, 'FAILED_INITIALIZATION');
    assert.deepEqual(view.recovery.initialization.missing_slots, ['author', 'challenger']);
  } finally {
    await h.cleanup();
  }
});

test('3–4 · limite 1 puis limite 2 : la naissance ne réserve rien', async () => {
  const one = await harness();
  try {
    const run = await startNativeRun(one.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
      maxInvocations: 1,
    });
    assert.ok(run.failure && run.failure.slot === 'challenger');
    assert.equal(run.positions.length, 1);
    assert.equal(one.providerCalls(), 1);
    assert.deepEqual(await readInvocationQuotaView(runPaths(one.runsDir, run.runId)), {
      kind: 'CONFIGURED',
      limit: 1,
      consumed: 1,
      remaining: 0,
      exhausted: true,
      coverage: 'SINCE_LEDGER_START',
    });
  } finally {
    await one.cleanup();
  }

  const two = await harness();
  try {
    const run = await startNativeRun(two.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
      maxInvocations: 3,
    });
    assert.equal(run.failure, undefined, 'les deux slots aboutissent');
    assert.equal(two.providerCalls(), 2);
    assert.deepEqual(await readInvocationQuotaView(runPaths(two.runsDir, run.runId)), {
      kind: 'CONFIGURED',
      limit: 3,
      consumed: 2,
      remaining: 1,
      exhausted: false,
      coverage: 'SINCE_LEDGER_START',
    });
  } finally {
    await two.cleanup();
  }
});

test('5–6 · une limite mal formée n’alloue aucun run', async () => {
  const h = await harness();
  try {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        startNativeRun(h.deps, {
          title: 'Natif',
          cwd: WORKSPACE,
          prompt: MISSION,
          runtimeConfig: nativeRuntimeConfig(),
          maxInvocations: value,
        }),
        (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_POLICY_INVALID',
        `max_invocations = ${String(value)}`,
      );
    }
    // Aucun run n'a été matérialisé, et aucun fournisseur joint.
    const { listRunIds } = await import('../../src/store/layout.ts');
    assert.deepEqual(await listRunIds(h.runsDir), []);
    assert.equal(h.providerCalls(), 0);
  } finally {
    await h.cleanup();
  }
});

test('7 · politique impossible à écrire : aucune tentative', async () => {
  const h = await harness();
  try {
    // Le nom du document est déjà pris par une politique établie — le seul
    // moyen déterministe d'échouer à la publication.
    const first = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
      maxInvocations: 5,
    });
    const paths = runPaths(h.runsDir, first.runId);
    await assert.rejects(
      openInvocationPolicyStore(paths).create(9),
      (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_POLICY_WRITE_FAILED',
    );
    // La politique d'origine est intacte : elle est immuable.
    const raw = JSON.parse(await readFile(paths.invocationPolicy, 'utf8')) as {
      invocation_quota: { max_invocations: number };
    };
    assert.equal(raw.invocation_quota.max_invocations, 5);
  } finally {
    await h.cleanup();
  }
});

test('8 · la CLI transmet la valeur exacte, et refuse le reste', async () => {
  const h = await harness();
  // Workspace **réel** : ce test passe par la CLI, qui canonicalise désormais
  // la racine comme le cockpit. L'objet éprouvé reste la valeur de quota
  // transmise — `WORKSPACE` demeure employé par les appels directs au service,
  // qui ne canonicalisent pas.
  const workspace = await makeTempDir('ccr-provisioning-ws-');
  try {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };

    const code = await runCli(
      ['start', '--title', 'T', '--prompt', MISSION, '--cwd', workspace, '--max-invocations', '2'],
      { deps: h.deps, io, preflight: { tty: { stdin: false, stdout: false } } },
    );
    assert.equal(code, 0, lines.join(' | '));

    const { listRunIds } = await import('../../src/store/layout.ts');
    const [runId] = await listRunIds(h.runsDir);
    assert.ok(runId);
    const view = await readInvocationQuotaView(runPaths(h.runsDir, runId));
    assert.deepEqual(view, {
      kind: 'CONFIGURED',
      limit: 2,
      consumed: 2,
      remaining: 0,
      exhausted: true,
      coverage: 'SINCE_LEDGER_START',
    });

    // Le statut natif rend la donnée lisible, sans devenir un tableau de bord.
    const status: string[] = [];
    await runCli(['status', runId], {
      deps: h.deps,
      io: { out: (line) => status.push(line), err: (line) => status.push(line) },
    });
    const rendered = status.join('\n');
    assert.ok(rendered.includes('quota CCR'), rendered);
    assert.ok(rendered.includes('2/2'), rendered);

    // Une valeur mal formée est refusée par la surface, avant tout preflight.
    for (const bad of ['-1', '1.5', 'trois', '']) {
      const errors: string[] = [];
      const exit = await runCli(
        // Workspace réel ici aussi : avec un chemin fictif, le refus pourrait
        // venir de la racine plutôt que de la valeur mal formée, et
        // l'assertion passerait pour la mauvaise raison.
        ['start', '--title', 'T', '--prompt', MISSION, '--cwd', workspace, '--max-invocations', bad],
        { deps: h.deps, io: { out: () => undefined, err: (line) => errors.push(line) } },
      );
      assert.equal(exit, 2, `« ${bad} » doit être refusé`);
    }
  } finally {
    await removeTempDir(workspace);
    await h.cleanup();
  }
});

// ==========================================================================
// B. Lecture
// ==========================================================================

test('9–12 · limite, consommé, restant : quatre situations exactes', async () => {
  const dir = await makeTempDir('ccr-quota-view-');
  try {
    const runsDir = path.join(dir, 'runs');
    const runId = 'CCR-20260811-001';
    const paths = runPaths(runsDir, runId);
    await mkdir(paths.root, { recursive: true });

    // Aucune politique, aucun journal : zéro, et la couverture le nuance.
    assert.deepEqual(await readInvocationQuotaView(paths), {
      kind: 'NONE',
      consumed: 0,
      coverage: 'PRE_LEDGER',
    });

    const ledger = await openInvocationLedger(paths, runId);
    const engage = async (trigger: 'STEP' | 'SEND'): Promise<void> => {
      await ledger.append(
        {
          identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'claude', provider: 'claude' },
          trigger_kind: trigger,
        },
        new Date('2026-08-11T00:00:00.000Z'),
      );
    };
    await engage('STEP');
    await engage('SEND');

    await openInvocationPolicyStore(paths).create(5);
    assert.deepEqual(await readInvocationQuotaView(paths), {
      kind: 'CONFIGURED',
      limit: 5,
      consumed: 2,
      remaining: 3,
      exhausted: false,
      coverage: 'SINCE_LEDGER_START',
    });
  } finally {
    await removeTempDir(dir);
  }

  // Limite atteinte, puis dépassée : le restant reste planché à zéro, et le
  // journal n'est jamais qualifié d'invalide pour autant.
  for (const [count, limit] of [
    [1, 1],
    [2, 1],
  ] as const) {
    const dir2 = await makeTempDir('ccr-quota-view-edge-');
    try {
      const runsDir = path.join(dir2, 'runs');
      const runId = 'CCR-20260811-002';
      const paths = runPaths(runsDir, runId);
      await mkdir(paths.root, { recursive: true });
      const ledger = await openInvocationLedger(paths, runId);
      for (let index = 0; index < count; index += 1) {
        await ledger.append(
          {
            identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'codex', provider: 'codex' },
            trigger_kind: 'RECOVERY_CONTINUE',
          },
          new Date('2026-08-11T00:00:00.000Z'),
        );
      }
      await openInvocationPolicyStore(paths).create(limit);
      assert.deepEqual(await readInvocationQuotaView(paths), {
        kind: 'CONFIGURED',
        limit,
        consumed: count,
        remaining: 0,
        exhausted: true,
        coverage: 'SINCE_LEDGER_START',
      });
    } finally {
      await removeTempDir(dir2);
    }
  }
});

test('13 · lire ne crée rien', async () => {
  const dir = await makeTempDir('ccr-quota-readonly-');
  try {
    const runsDir = path.join(dir, 'runs');
    const paths = runPaths(runsDir, 'CCR-20260811-001');
    await mkdir(paths.root, { recursive: true });

    await readInvocationQuotaView(paths);
    await readInvocationQuotaView(paths);

    assert.equal(await exists(paths.invocations), false, 'aucun journal fabriqué');
    assert.equal(await exists(paths.invocationPolicy), false, 'aucune politique fabriquée');
    assert.equal(await exists(paths.usage), false);
  } finally {
    await removeTempDir(dir);
  }
});

test('14 · corruption : jamais NONE, jamais zéro', async () => {
  const dir = await makeTempDir('ccr-quota-corrupt-');
  try {
    const runsDir = path.join(dir, 'runs');
    const runId = 'CCR-20260811-001';
    const paths = runPaths(runsDir, runId);
    await mkdir(paths.root, { recursive: true });

    await writeFile(paths.invocationPolicy, '{ pas du JSON', 'utf8');
    await assert.rejects(
      readInvocationQuotaView(paths),
      (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_POLICY_INVALID',
    );

    await writeFile(
      paths.invocationPolicy,
      `${JSON.stringify({ schema_version: 1, invocation_quota: { max_invocations: 4 } })}\n`,
      'utf8',
    );
    await writeFile(paths.invocations, 'ceci n’est pas une ligne JSON\n', 'utf8');
    await assert.rejects(
      readInvocationQuotaView(paths),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('15–16 · les deux générations sont lues, et la révision ne bouge pas', async () => {
  const h = await harness();
  try {
    // Historique : activité antérieure réelle, aucun journal d'invocations.
    const legacy = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'Historique',
      cwd: WORKSPACE,
      prompt: MISSION,
    });
    const paths = runPaths(h.runsDir, legacy.runId);
    await rm(paths.invocations, { force: true });

    const before = (await readStableRunSnapshot(h.runsDir, legacy.runId)).revision;
    const status = await getRunStatus(h.deps, legacy.runId);
    assert.deepEqual(status.invocationQuota, {
      kind: 'NONE',
      consumed: 0,
      coverage: 'PRE_LEDGER',
    });

    // Une politique posée hors surface produit — la primitive reste bas niveau.
    await openInvocationPolicyStore(paths).create(1);
    const runView = await getRunView({ runsDir: h.runsDir, settings: SETTINGS }, legacy.runId);
    assert.deepEqual(runView.invocation_quota, {
      kind: 'CONFIGURED',
      limit: 1,
      consumed: 0,
      remaining: 1,
      exhausted: false,
      coverage: 'PRE_LEDGER',
    });

    // 16 · la révision métier ignore la politique.
    assert.equal((await readStableRunSnapshot(h.runsDir, legacy.runId)).revision, before);

    // Et l'enforcement 2B s'applique à ce run historique porteur d'une
    // politique, sans qu'aucune surface n'ait pu la lui attacher.
    await stepRun(h.deps, { runId: legacy.runId });
    await assert.rejects(
      stepRun(h.deps, { runId: legacy.runId }),
      (error: unknown) => isCcrError(error) && error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED',
    );
  } finally {
    await h.cleanup();
  }
});

test('17 · la reprise reste disponible alors que le budget est épuisé', async () => {
  const h = await harness();
  try {
    // Un run natif dont l'auteur est acquis, le challenger refusé.
    const run = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
      maxInvocations: 1,
    });
    assert.ok(run.failure);

    const view = await buildNativeRunReadModel({ runsDir: h.runsDir }, run.runId);

    // Les deux faits, côte à côte, sans que l'un n'efface l'autre.
    assert.equal(view.recovery.initialization.status, 'CLEAN_MISSING');
    assert.deepEqual(
      view.recovery.initialization.available_actions
        .filter((action) => action.may_call_provider)
        .map((entry) => entry.action),
      ['CONTINUE'],
      'la reprise reste métier-disponible',
    );
    assert.deepEqual(view.recovery.initialization.missing_slots, ['challenger']);
    assert.equal(view.invocation_quota.kind, 'CONFIGURED');
    if (view.invocation_quota.kind !== 'CONFIGURED') throw new Error('configurée attendue');
    assert.equal(view.invocation_quota.exhausted, true);
    assert.equal(view.invocation_quota.remaining, 0);

    const persisted = await readPersistedManifest(runPaths(h.runsDir, run.runId));
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('natif attendu');
    assert.notEqual(persisted.manifest.experts.author.session_id, null);
  } finally {
    await h.cleanup();
  }

  // Côté historique, la vue de reprise porte les deux faits également.
  const legacy = await harness();
  try {
    const created = await startRun(legacy.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'Historique',
      cwd: WORKSPACE,
      prompt: MISSION,
    });
    const paths = runPaths(legacy.runsDir, created.runId);
    // Un run partiellement initialisé, et un budget épuisé.
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      agents: Record<string, { session_id: string | null }>;
    };
    const codex = manifest.agents['codex'];
    assert.ok(codex);
    codex.session_id = null;
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const state = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>;
    state['state'] = 'FAILED_INITIALIZATION';
    await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    // La création historique n'est pas gouvernée : son journal est vide. Une
    // limite nulle suffit donc à représenter un budget épuisé.
    await openInvocationPolicyStore(paths).create(0);

    const recovery = await getRecoveryView(
      { runsDir: legacy.runsDir, settings: SETTINGS },
      created.runId,
    );
    assert.deepEqual(
      recovery.capabilities.map((entry) => entry.id),
      ['RECOVERY_CONTINUE_INITIALIZATION'],
      'la capacité métier subsiste',
    );
    assert.equal(recovery.invocation_quota.kind, 'CONFIGURED');
    if (recovery.invocation_quota.kind !== 'CONFIGURED') throw new Error('configurée attendue');
    assert.equal(recovery.invocation_quota.exhausted, true);
    assert.equal(recovery.invocation_quota.consumed, 0);
    assert.equal(recovery.invocation_quota.coverage, 'PRE_LEDGER');
  } finally {
    await legacy.cleanup();
  }
});

test('18 · la gouvernance ne contient ni jetons, ni coût, ni quota fournisseur', async () => {
  const { readFile: read } = await import('node:fs/promises');
  const executable = async (relative: string): Promise<string> => {
    const raw = await read(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  const view = await executable('services/invocation-quota-read.ts');
  for (const forbidden of ['tokens', 'usd', 'USD', 'currency', 'pricing', 'CostEstimate', 'usage-ledger']) {
    assert.equal(view.includes(forbidden), false, `la vue ignore ${forbidden}`);
  }
  // Elle ne compte jamais depuis le curseur d'allocation.
  assert.equal(view.includes('nextSequence'), false);
  assert.ok(view.includes('count()'));

  // Le classifieur de reprise reste indépendant des deux journaux.
  const recovery = await executable('services/native-recovery-service.ts');
  const classifier = recovery.slice(
    recovery.indexOf('export function buildNativeInitializationView'),
    recovery.indexOf('async function loadNativeRun'),
  );
  for (const forbidden of ['invocation-policy', 'invocation-ledger', 'Quota']) {
    assert.equal(classifier.includes(forbidden), false, `le classifieur ignore ${forbidden}`);
  }

  // L'admission ignore toujours la politique.
  const manager = await executable('cockpit/long-operations.ts');
  assert.equal(manager.includes('uota'), false);
});
