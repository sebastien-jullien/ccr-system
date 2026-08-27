/**
 * Composition inter-gates du Slice 0 (V2-IMP-32).
 *
 * Les quatre gates ont été prouvés séparément. Ce fichier éprouve ce qu'aucun
 * d'eux ne peut prouver seul : que leurs propriétés **se composent** sans
 * s'annuler.
 *
 * ```text
 * A  0A + 0C  un run créé par la façade est lisible comme snapshot stable,
 *             son runtime pinné y est visible, sa révision est déterministe
 * B  0A + 0D  une création de run associe l'opération au verrou exact, sans
 *             déplacer la frontière pré-allocation, et ne fuit pas
 * C  0B + 0C  un fragment JSONL transitoire est absorbé par 0B, la stabilité
 *             multi-source restant l'affaire de 0C  (déjà couvert ailleurs)
 * D  0C + 0D  mêmes faits canoniques → même révision, quelles que soient les
 *             évidences runtime ; seule la vivacité change
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { startRunWithPreflight } from '../../src/services/start-application-service.ts';
import { readStableRunSnapshot, computeRunRevision } from '../../src/store/run-snapshot.ts';
import { createHostOperationRegistry } from '../../src/lock/host-operation-registry.ts';
import { classifyLockObservation } from '../../src/lock/run-execution-evidence.ts';
import { classifyRunLiveness } from '../../src/core/run-liveness.ts';
import { lockFilePath } from '../../src/lock/run-lock.ts';
import { runPaths, listRunIds } from '../../src/store/layout.ts';
import { RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { AgentKind, PendingOperation } from '../../src/core/run.ts';
import { CONFIG_FILE_NAME, writeConfig } from '../../src/config/config-store.ts';
import { defaultConfig } from '../../src/config/config-schema.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

function probeOf(agent: AgentKind, over: Partial<AgentRuntimeProbe> = {}): AgentRuntimeProbe {
  return {
    agent,
    installed: true,
    version: agent === 'claude' ? '2.1.224' : '0.146.0',
    authStatus: 'AUTHENTICATED',
    launcherSource: 'path',
    ...over,
  };
}

interface Box {
  readonly dir: string;
  readonly runsDir: string;
  readonly configPath: string;
  cleanup(): Promise<void>;
}

async function box(prefix: string): Promise<Box> {
  const dir = await makeTempDir(prefix);
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  return {
    dir,
    runsDir,
    configPath: path.join(dir, CONFIG_FILE_NAME),
    cleanup: () => removeTempDir(dir),
  };
}

// --------------------------------------------------------------------------
// Composition A — 0A + 0C
// --------------------------------------------------------------------------

test('A. un run créé par la façade est un snapshot stable au runtime visible', async (t) => {
  const b = await box('ccr-comp-a-');
  try {
    await writeConfig(
      { ...defaultConfig(), codex: { skip_git_repo_check: true } },
      { configPath: b.configPath },
    );

    const created = await startRunWithPreflight(
      {
        interaction: { kind: 'non-interactive' },
        preflight: {
          configPath: b.configPath,
          env: {},
          probes: { claude: async () => probeOf('claude'), codex: async () => probeOf('codex') },
        },
        createRunServiceDeps: () => ({
          runsDir: b.runsDir,
          now: () => new Date('2026-08-08T00:00:00.000Z'),
          createAdapters: () => ({
            claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
            codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
          }),
        }),
      },
      { title: 'Composition A', cwd: b.dir, prompt: 'contexte' },
    );

    // 0C lit ce que 0A a écrit.
    const snapshot = await readStableRunSnapshot(b.runsDir, created.runId);

    // Le runtime pinné de 0A est visible dans le snapshot de 0C.
    assert.equal(snapshot.manifest.runtime_config?.schema_version, RUNTIME_CONFIG_SCHEMA_VERSION);
    assert.equal(snapshot.manifest.runtime_config?.codex.skip_git_repo_check, true);
    assert.equal(snapshot.manifest.runtime_config?.codex.source_at_capture, 'config');
    assert.deepEqual(snapshot.manifest.runtime_config, created.runtimeConfig);

    // Les deux sessions natives et le journal complet sont lisibles.
    assert.equal(snapshot.manifest.agents.claude.session_id, 'claude-1');
    assert.equal(snapshot.manifest.agents.codex.session_id, 'codex-1');
    assert.equal(snapshot.state.state, 'READY');
    assert.ok(snapshot.events.length >= 7, 'journal d’initialisation complet');

    // Révision déterministe et stable au repos.
    const second = await readStableRunSnapshot(b.runsDir, created.runId);
    assert.equal(second.revision, snapshot.revision);
    assert.equal(
      computeRunRevision({
        manifest: snapshot.manifest,
        state: snapshot.state,
        events: snapshot.events,
        decisions: snapshot.decisions,
      }),
      snapshot.revision,
    );
    assert.equal(snapshot.attempts, 1, 'aucune reprise sur un run au repos');

    t.diagnostic(
      `run=${created.runId} · événements=${String(snapshot.events.length)} · ` +
        `révision=${snapshot.revision.slice(0, 16)}…`,
    );
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Composition B — 0A + 0D
// --------------------------------------------------------------------------

test('B. une création de run associe l’opération au verrou exact, sans fuite', async (t) => {
  const b = await box('ccr-comp-b-');
  try {
    const registry = createHostOperationRegistry();
    const lockVisibleAtBind: boolean[] = [];
    let runRoot: string | undefined;

    // Registre instrumenté : note si le verrou était déjà publié au moment de
    // l'association — la fenêtre que 0D ferme structurellement.
    const inner = createHostOperationRegistry();
    const probe = {
      begin: (runId: string, action: string) => {
        runRoot = runPaths(b.runsDir, runId).root;
        return inner.begin(runId, action);
      },
      bindLock: (id: string, lockId: string) => {
        lockVisibleAtBind.push(
          runRoot === undefined ? false : existsSync(lockFilePath(runPaths(b.runsDir, path.basename(runRoot)))),
        );
        inner.bindLock(id, lockId);
      },
      end: (id: string) => inner.end(id),
      find: (runId: string, lockId: string) => inner.find(runId, lockId),
      active: () => inner.active(),
      size: () => inner.size(),
    };
    void registry;

    const created = await startRunWithPreflight(
      {
        interaction: { kind: 'non-interactive' },
        preflight: {
          configPath: b.configPath,
          env: {},
          probes: { claude: async () => probeOf('claude'), codex: async () => probeOf('codex') },
        },
        createRunServiceDeps: () => ({
          runsDir: b.runsDir,
          now: () => new Date('2026-08-08T00:00:00.000Z'),
          hostRegistry: probe,
          createAdapters: () => ({
            claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
            codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
          }),
        }),
      },
      { title: 'Composition B', cwd: b.dir, prompt: 'contexte' },
    );

    t.diagnostic(
      `associations=${String(lockVisibleAtBind.length)} · verrou déjà visible=${JSON.stringify(lockVisibleAtBind)}`,
    );

    // 0D : association avant publication, sur le chemin réel de création.
    assert.equal(lockVisibleAtBind.length, 1, 'le start a bien associé une opération');
    assert.deepEqual(lockVisibleAtBind, [false], 'jamais lié après publication');

    // 0D : aucune fuite après completion, verrou libéré.
    assert.equal(inner.size(), 0, 'registre nettoyé');
    assert.equal(existsSync(lockFilePath(runPaths(b.runsDir, created.runId))), false);

    // 0A : la frontière pré-allocation est intacte — exactement un run.
    assert.deepEqual(await listRunIds(b.runsDir), [created.runId]);
    assert.equal(created.state.state, 'READY');
    assert.notEqual(created.manifest.runtime_config, undefined, 'snapshot toujours pinné');
  } finally {
    await b.cleanup();
  }
});

test('B bis. un preflight bloquant n’alloue rien, même avec un registre host', async () => {
  const b = await box('ccr-comp-b2-');
  try {
    const inner = createHostOperationRegistry();

    await assert.rejects(
      () =>
        startRunWithPreflight(
          {
            interaction: { kind: 'non-interactive' },
            preflight: {
              configPath: b.configPath,
              env: {},
              probes: {
                claude: async () => probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
                codex: async () => probeOf('codex'),
              },
            },
            createRunServiceDeps: () => ({
              runsDir: b.runsDir,
              now: () => new Date(),
              hostRegistry: inner,
              createAdapters: () => ({
                claude: createFakeAdapter({ kind: 'claude' }),
                codex: createFakeAdapter({ kind: 'codex' }),
              }),
            }),
          },
          { title: 'T', cwd: b.dir, prompt: 'p' },
        ),
      (error: unknown) => isCcrError(error) && error.code === 'AUTH_REQUIRED',
    );

    assert.deepEqual(await readdir(b.runsDir), [], 'aucun répertoire alloué');
    assert.equal(inner.size(), 0, 'aucune opération enregistrée');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Composition D — 0C + 0D
// --------------------------------------------------------------------------

test('D. l’évidence runtime change la vivacité, jamais la révision', async (t) => {
  const b = await box('ccr-comp-d-');
  try {
    const created = await startRunWithPreflight(
      {
        interaction: { kind: 'non-interactive' },
        preflight: {
          configPath: b.configPath,
          env: {},
          probes: { claude: async () => probeOf('claude'), codex: async () => probeOf('codex') },
        },
        createRunServiceDeps: () => ({
          runsDir: b.runsDir,
          now: () => new Date('2026-08-08T00:00:00.000Z'),
          createAdapters: () => ({
            claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
            codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
          }),
        }),
      },
      { title: 'Composition D', cwd: b.dir, prompt: 'contexte' },
    );

    const snapshot = await readStableRunSnapshot(b.runsDir, created.runId);

    // Faits canoniques figés, portant une opération en vol.
    const pending: PendingOperation = {
      kind: 'step',
      agent: 'claude',
      round: 1,
      prompt_event_id: 'evt_000008',
      source_event_id: 'evt_000007',
      session_id: 'claude-1',
      return_state: 'READY',
      return_control: 'AUTOMATION',
      started_at: '2026-08-08T01:00:00.000Z',
    };
    const state = { ...snapshot.state, state: 'WAITING_AGENT' as const, pending_operation: pending };
    const facts = {
      manifest: snapshot.manifest,
      state,
      events: snapshot.events,
      decisions: snapshot.decisions,
    };
    const reference = computeRunRevision(facts);

    // Trois évidences runtime radicalement différentes.
    const registryActive = createHostOperationRegistry();
    const bound = registryActive.begin(created.runId, 'step');
    registryActive.bindLock(bound, 'lock-A');

    const lock = {
      lock_id: 'lock-A',
      pid: process.pid,
      hostname: (await import('node:os')).hostname(),
      started_at: '2026-08-08T00:59:00.000Z',
      command: 'step',
    };

    const cases = [
      { label: 'registre actif', observation: classifyLockObservation(created.runId, lock, { registry: registryActive, pendingOperation: pending }) },
      { label: 'registre vide', observation: classifyLockObservation(created.runId, lock, { registry: createHostOperationRegistry(), pendingOperation: pending }) },
      { label: 'aucun verrou', observation: classifyLockObservation(created.runId, undefined, { registry: createHostOperationRegistry(), pendingOperation: pending }) },
    ];

    const livenesses: string[] = [];
    for (const testCase of cases) {
      // La révision ne dépend que des faits canoniques.
      assert.equal(computeRunRevision(facts), reference, `${testCase.label} : révision inchangée`);

      const verdict = classifyRunLiveness(
        { manifest: snapshot.manifest, state, pendingResponseJournaled: false },
        testCase.observation.evidence,
      );
      livenesses.push(verdict.liveness);
    }

    t.diagnostic(`révision unique=${reference.slice(0, 16)}… · vivacités=${livenesses.join(', ')}`);

    assert.deepEqual(
      livenesses,
      ['OPERATION_IN_FLIGHT', 'ORPHAN_LOCK', 'AMBIGUOUS'],
      'trois interprétations opérationnelles distinctes',
    );
    assert.equal(new Set(livenesses).size, 3, 'et réellement distinctes');
  } finally {
    await b.cleanup();
  }
});
