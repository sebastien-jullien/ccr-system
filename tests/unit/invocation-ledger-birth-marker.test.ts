/**
 * V2.2-IMP-09R — marque de naissance de l'autorité d'invocations.
 *
 * L'absence de `invocations.jsonl` confondait deux vérités opposées :
 *
 * ```text
 * run antérieur          histoire indémontrable — PRE_LEDGER, à raison
 * run neuf sans dispatch histoire intégralement connue, et vide
 * ```
 *
 * Un journal **vide** écrit à la naissance d'un run natif tranche : sa présence
 * dit « autorité active », son absence « rien ne le prouve ». Le discriminant du
 * read model ne change pas — c'est le fait d'entrée qui devient exact.
 *
 * Aucun enregistrement fabriqué, aucun backfill, aucune valeur de couverture
 * nouvelle. Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { readInvocationQuotaView } from '../../src/services/invocation-quota-read.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import { sendMessage, startRun, stepRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import {
  initializeInvocationLedger,
  openInvocationLedger,
} from '../../src/store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { computeNativeRunRevision } from '../../src/store/native-run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const WORKSPACE = 'E:/prog/exemple';
const MISSION = 'Mission initiale : évaluer la refonte.';
const T = new Date('2026-08-12T00:00:00.000Z');

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  providerCalls(): number;
  cleanup(): Promise<void>;
}

async function harness(failAdapters?: () => unknown): Promise<Harness> {
  const runsDir = await makeTempDir('ccr-birth-marker-');
  const build = (kind: ProviderKind) =>
    createFakeAdapter({ kind, sessionId: `${kind}-1`, startSessionIds: [`${kind}-1`, `${kind}-2`] });
  const claude = build('claude');
  const codex = build('codex');
  const adapters: AgentAdapters = { claude, codex };
  return {
    runsDir,
    providerCalls: () => claude.calls.length + codex.calls.length,
    deps: {
      runsDir,
      now: () => new Date(),
      createAdapters: () => {
        const failure = failAdapters?.();
        if (failure !== undefined) throw failure;
        return adapters;
      },
    },
    cleanup: () => removeTempDir(runsDir),
  };
}

function nativeRuntimeConfig(): Parameters<typeof startNativeRun>[1]['runtimeConfig'] {
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: '2026-08-12T00:00:00.000Z',
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
// A. La primitive
// ==========================================================================

test('1–2 · un journal vide est un journal, et le premier engagement est inv_000001', async () => {
  const dir = await makeTempDir('ccr-marker-empty-');
  try {
    const runsDir = path.join(dir, 'runs');
    const runId = 'CCR-20260812-001';
    const paths = runPaths(runsDir, runId);
    await mkdir(paths.root, { recursive: true });

    await initializeInvocationLedger(paths);
    assert.equal(await readFile(paths.invocations, 'utf8'), '', 'strictement vide');

    const ledger = await openInvocationLedger(paths, runId);
    assert.deepEqual(await ledger.readAll(), []);
    assert.equal(ledger.count(), 0);
    assert.equal(ledger.nextSequence(), 1);

    // 2 · aucune branche spéciale ne survit à l'initialisation.
    const record = await ledger.append(
      {
        identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'claude', provider: 'claude' },
        trigger_kind: 'STEP',
      },
      T,
    );
    assert.equal(record.invocation_id, 'inv_000001');
    assert.equal(ledger.count(), 1);

    // Un journal initialisé puis alimenté est indiscernable d'un journal né du
    // premier append : même format, ligne pour ligne.
    const other = runPaths(runsDir, 'CCR-20260812-002');
    await mkdir(other.root, { recursive: true });
    const born = await openInvocationLedger(other, 'CCR-20260812-002');
    await born.append(
      {
        identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'claude', provider: 'claude' },
        trigger_kind: 'STEP',
      },
      T,
    );
    const normalize = (raw: string): string => raw.replace(/CCR-20260812-00\d/g, 'RUN');
    assert.equal(
      normalize(await readFile(paths.invocations, 'utf8')),
      normalize(await readFile(other.invocations, 'utf8')),
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('3 · une activation n’écrase jamais une histoire', async () => {
  const dir = await makeTempDir('ccr-marker-idempotent-');
  try {
    const runsDir = path.join(dir, 'runs');
    const runId = 'CCR-20260812-001';
    const paths = runPaths(runsDir, runId);
    await mkdir(paths.root, { recursive: true });

    const ledger = await openInvocationLedger(paths, runId);
    await ledger.append(
      {
        identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'codex', provider: 'codex' },
        trigger_kind: 'SEND',
      },
      T,
    );
    const before = await readFile(paths.invocations, 'utf8');

    await initializeInvocationLedger(paths);
    assert.equal(await readFile(paths.invocations, 'utf8'), before, 'aucune troncature');
    assert.equal((await openInvocationLedger(paths, runId)).count(), 1);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Naissance d'un run natif
// ==========================================================================

test('4 · quota 0 : marque présente, couverture exacte, aucun fournisseur', async () => {
  const h = await harness();
  try {
    const run = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
      maxInvocations: 0,
    });
    assert.ok(run.failure && isCcrError(run.failure.error));
    assert.equal(run.failure.error.code, 'CCR_INVOCATION_QUOTA_EXCEEDED');

    const paths = runPaths(h.runsDir, run.runId);
    assert.equal(await readFile(paths.invocations, 'utf8'), '', 'journal vide');
    assert.deepEqual(await readInvocationQuotaView(paths), {
      kind: 'CONFIGURED',
      limit: 0,
      consumed: 0,
      remaining: 0,
      exhausted: true,
      coverage: 'SINCE_LEDGER_START',
    });
    assert.equal(h.providerCalls(), 0);
  } finally {
    await h.cleanup();
  }
});

test('5 · échec avant le premier engagement : la marque est déjà là', async () => {
  // `createAdapters` est construit pendant le contexte, après l'activation.
  // C'est le cas B du micro-audit : un run matérialisé, zéro dispatch, et
  // aucune politique — donc rien d'autre que la marque pour le dater.
  const h = await harness(() => new CcrError('AGENT_EXECUTABLE_UNRESOLVED', 'aucune CLI (fixture)'));
  try {
    await assert.rejects(
      startNativeRun(h.deps, {
        title: 'Natif',
        cwd: WORKSPACE,
        prompt: MISSION,
        runtimeConfig: nativeRuntimeConfig(),
      }),
      (error: unknown) => isCcrError(error) && error.code === 'AGENT_EXECUTABLE_UNRESOLVED',
    );

    const { listRunIds } = await import('../../src/store/layout.ts');
    const [runId] = await listRunIds(h.runsDir);
    assert.ok(runId, 'le run est matérialisé');
    const paths = runPaths(h.runsDir, runId);

    assert.equal(await exists(paths.invocations), true);
    assert.equal(await readFile(paths.invocations, 'utf8'), '');
    assert.equal(await exists(paths.invocationPolicy), false, 'aucune politique demandée');
    assert.deepEqual(await readInvocationQuotaView(paths), {
      kind: 'NONE',
      consumed: 0,
      coverage: 'SINCE_LEDGER_START',
    });
    assert.equal(h.providerCalls(), 0);
  } finally {
    await h.cleanup();
  }
});

test('6 · START normal : le journal initialisé reçoit ses engagements', async () => {
  const h = await harness();
  try {
    const run = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
    });
    assert.equal(run.failure, undefined);

    const paths = runPaths(h.runsDir, run.runId);
    const records = await (await openInvocationLedger(paths, run.runId)).readAll();
    assert.deepEqual(
      records.map((entry) => entry.invocation_id),
      ['inv_000001', 'inv_000002'],
    );
    assert.deepEqual(await readInvocationQuotaView(paths), {
      kind: 'NONE',
      consumed: 2,
      coverage: 'SINCE_LEDGER_START',
    });
  } finally {
    await h.cleanup();
  }
});

test('7 · la marque ne fabrique aucune politique, aucun usage', async () => {
  const h = await harness();
  try {
    const run = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
      maxInvocations: 0,
    });
    const paths = runPaths(h.runsDir, run.runId);

    // Journal d'invocations activé, mais la politique reste ce que l'humain a
    // demandé, et l'usage n'existe pas.
    const view = await readInvocationQuotaView(paths);
    assert.equal(view.kind, 'CONFIGURED');
    assert.equal(await exists(paths.usage), false, 'aucun journal d’usage');

    // Et sur un run sans politique demandée, la marque ne fait pas naître de
    // politique : `NONE` reste `NONE`.
    const bare = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
    });
    const barePaths = runPaths(h.runsDir, bare.runId);
    assert.equal(await exists(barePaths.invocationPolicy), false);
    assert.equal((await readInvocationQuotaView(barePaths)).kind, 'NONE');
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// C. Runs antérieurs — rien n'est rétro-marqué
// ==========================================================================

test('8–10 · un run sans marque le reste, et la lecture ne crée rien', async () => {
  const h = await harness();
  try {
    // Natif antérieur : la marque est retirée pour reproduire un run créé
    // avant ce repair.
    const native = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
    });
    const nativePaths = runPaths(h.runsDir, native.runId);
    const { rm } = await import('node:fs/promises');
    await rm(nativePaths.invocations, { force: true });

    assert.deepEqual(await readInvocationQuotaView(nativePaths), {
      kind: 'NONE',
      consumed: 0,
      coverage: 'PRE_LEDGER',
    });
    // 10 · lire deux fois ne fabrique toujours rien.
    await readInvocationQuotaView(nativePaths);
    assert.equal(await exists(nativePaths.invocations), false, 'la lecture n’active rien');

    // 9 · historique legacy : aucune marque, et aucune n'est posée.
    const legacy = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'Historique',
      cwd: WORKSPACE,
      prompt: MISSION,
    });
    const legacyPaths = runPaths(h.runsDir, legacy.runId);
    await rm(legacyPaths.invocations, { force: true });
    assert.deepEqual(await readInvocationQuotaView(legacyPaths), {
      kind: 'NONE',
      consumed: 0,
      coverage: 'PRE_LEDGER',
    });

    // Une politique posée hors surface ne vaut toujours pas activation.
    await openInvocationPolicyStore(legacyPaths).create(2);
    const withPolicy = await readInvocationQuotaView(legacyPaths);
    assert.equal(withPolicy.coverage, 'PRE_LEDGER', 'la politique ne date rien');
    assert.equal(withPolicy.kind, 'CONFIGURED');
    assert.equal(await exists(legacyPaths.invocations), false);

    // Et le premier engagement gouverné, lui, active le journal.
    await stepRun(h.deps, { runId: legacy.runId });
    assert.deepEqual(await readInvocationQuotaView(legacyPaths), {
      kind: 'CONFIGURED',
      limit: 2,
      consumed: 1,
      remaining: 1,
      exhausted: false,
      coverage: 'SINCE_LEDGER_START',
    });
  } finally {
    await h.cleanup();
  }
});

test('11 · un envoi historique n’active aucun journal par avance', async () => {
  const h = await harness();
  try {
    const legacy = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'Historique',
      cwd: WORKSPACE,
      prompt: MISSION,
    });
    const paths = runPaths(h.runsDir, legacy.runId);
    const { rm } = await import('node:fs/promises');
    await rm(paths.invocations, { force: true });

    // Une lecture de statut, une vue, une politique : rien n'active.
    await readInvocationQuotaView(paths);
    assert.equal(await exists(paths.invocations), false);

    // Seul un engagement réel le fait.
    await sendMessage(h.deps, { runId: legacy.runId, agent: 'claude', message: 'Un mot.' });
    assert.equal(await exists(paths.invocations), true);
    assert.equal((await readInvocationQuotaView(paths)).coverage, 'SINCE_LEDGER_START');
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// D. Frontières
// ==========================================================================

test('12 · la marque reste hors révision métier', async () => {
  const h = await harness();
  try {
    const run = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
    });
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, run.runId);

    // La révision se calcule sur les quatre sources métier, et le journal n'en
    // est pas : elle est identique avec ou sans lui.
    const withMarker = computeNativeRunRevision(snapshot.manifest, snapshot.state, snapshot.events);
    assert.equal(withMarker, snapshot.revision);

    const { rm } = await import('node:fs/promises');
    await rm(runPaths(h.runsDir, run.runId).invocations, { force: true });
    assert.equal((await readStableNativeRunSnapshot(h.runsDir, run.runId)).revision, snapshot.revision);
  } finally {
    await h.cleanup();
  }
});

test('13 · l’enforcement lit la marque sans la confondre avec une politique', async () => {
  const h = await harness();
  try {
    // Journal vide + politique configurée : le compte part bien de zéro.
    const run = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
      maxInvocations: 1,
    });
    assert.ok(run.failure, 'le challenger est refusé');
    assert.equal(run.positions.length, 1, 'l’auteur a bien obtenu son unité');

    const paths = runPaths(h.runsDir, run.runId);
    assert.equal((await openInvocationLedger(paths, run.runId)).count(), 1);

    // Un journal vide n'implique jamais une politique : sans document, la vue
    // reste NONE et l'enforcement ne refuse rien.
    const bare = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
    });
    assert.equal(bare.failure, undefined, 'aucune politique, aucun refus');
    assert.equal((await readInvocationQuotaView(runPaths(h.runsDir, bare.runId))).kind, 'NONE');
  } finally {
    await h.cleanup();
  }
});

test('14 · gardes : deux valeurs de couverture, une seule surface d’activation', async () => {
  const executable = async (relative: string): Promise<string> => {
    const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  // La taxonomie n'a pas bougé : le repair améliore le fait d'entrée.
  const view = await executable('services/invocation-quota-read.ts');
  for (const invented of ['FROM_RUN_BIRTH', 'FULL_HISTORY', 'COMPLETE_FROM_BIRTH', 'BIRTH']) {
    assert.equal(view.includes(invented), false, `aucune valeur ${invented}`);
  }
  assert.ok(view.includes("'PRE_LEDGER'"));
  assert.ok(view.includes("'SINCE_LEDGER_START'"));
  // Le discriminant reste l'existence du fichier, inchangé.
  assert.ok(view.includes('pathExists(paths.invocations)'));
  for (const heuristic of ['created_at', 'schema_version', 'invocationPolicy', 'events']) {
    assert.equal(view.includes(heuristic), false, `aucune heuristique ${heuristic}`);
  }

  // Une seule surface active le journal, et c'est la naissance d'un run natif.
  const callers: string[] = [];
  for (const relative of [
    'services/native-start-service.ts',
    'services/run-service.ts',
    'services/native-step-service.ts',
    'services/native-send-service.ts',
    'services/native-recovery-service.ts',
    'services/invocation-quota.ts',
    'services/invocation-quota-read.ts',
    'cockpit/mutations-http.ts',
    'cli/main.ts',
  ]) {
    if ((await executable(relative)).includes('initializeInvocationLedger')) callers.push(relative);
  }
  assert.deepEqual(callers, ['services/native-start-service.ts']);

  // Ouvrir un journal reste une lecture : la seule autre écriture est l'append.
  const ledger = await executable('store/invocation-ledger.ts');
  const opener = ledger.slice(ledger.indexOf('export async function openInvocationLedger'));
  assert.equal(opener.includes("open("), false, 'l’ouverture n’écrit rien');
  assert.equal((opener.match(/appendJsonLine\(/g) ?? []).length, 1);
});
