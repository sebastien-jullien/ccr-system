/**
 * Runtime snapshot, autorité et compatibilité legacy (lot V1.1-7, §14, §15.7).
 *
 * L'invariant éprouvé ici est celui qui donne son sens à la V1.1 :
 *
 *   la configuration exécutable d'un run V1.1 est figée à sa création et
 *   gouverne toute sa durée de vie, quels que soient les changements ultérieurs
 *   de la configuration globale, de l'environnement ou du processus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startRun, sendMessage, stepRun, runtimeSettingsOf } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunRuntimeSettings, RunServiceDeps } from '../../src/services/run-service.ts';
import { updateRunRuntimeConfig, requirePinnedSnapshot } from '../../src/services/run-runtime-service.ts';
import { RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { RunManifest, RunRuntimeConfig } from '../../src/core/run.ts';
import {
  loadRun,
  readManifest,
  setAgentSessionId,
  validateManifest,
  writeManifest,
} from '../../src/store/state-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { demoteToLegacyManifest } from '../helpers/legacy-run.ts';
import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

function snapshotOf(skip: boolean): RunRuntimeConfig {
  return {
    schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: '2026-08-08T03:00:00.000Z',
    claude: { cli_version: '2.1.224', auth_preflight: 'AUTHENTICATED' },
    codex: {
      cli_version: '0.146.0',
      auth_preflight: 'AUTHENTICATED',
      skip_git_repo_check: skip,
      source_at_capture: 'config',
    },
  };
}

interface Harness {
  readonly runsDir: string;
  readonly dir: string;
  /** Valeur reçue par la fabrique d'adapters à chaque construction. */
  readonly received: (boolean | undefined)[];
  deps(legacyFallback?: () => boolean): RunServiceDeps;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await makeTempDir('ccr-snapshot-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const received: (boolean | undefined)[] = [];

  return {
    dir,
    runsDir,
    received,
    deps(legacyFallback: () => boolean = () => false): RunServiceDeps {
      const adapters: AgentAdapters = {
        claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
        codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
      };
      return {
        runsDir,
        now: () => new Date(),
        createAdapters(_cwd: string, runtime?: RunRuntimeSettings) {
          received.push(runtime?.codexSkipGitRepoCheck ?? legacyFallback());
          return adapters;
        },
      };
    },
    cleanup: () => removeTempDir(dir),
  };
}

async function expectCcrError(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isCcrError(error), `${what} : attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code, what);
    return;
  }
  assert.fail(`${what} : attendu ${code}, aucune erreur levée`);
}

// --------------------------------------------------------------------------
// Manifest (29.1 à 29.9)
// --------------------------------------------------------------------------

test('(1/2) le snapshot est durablement écrit AVANT le premier appel agent', async () => {
  const box = await harness();
  try {
    let seenDuringFirstCall: RunManifest | undefined;
    const adapters: AgentAdapters = {
      claude: createFakeAdapter({
        kind: 'claude',
        sessionId: 'claude-1',
        // Inspection du disque **pendant** l'invocation du premier agent.
        onCall: async () => {
          const ids = await import('../../src/store/layout.ts').then((m) => m.listRunIds(box.runsDir));
          seenDuringFirstCall = await readManifest(runPaths(box.runsDir, ids[0] ?? ''));
        },
      }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
    };

    await startRun(
      { runsDir: box.runsDir, now: () => new Date(), createAdapters: () => adapters },
      { title: 'T', cwd: box.dir, prompt: 'p', runtimeConfig: snapshotOf(true) },
    );

    assert.ok(seenDuringFirstCall !== undefined, 'le manifest a été lu pendant le premier appel');
    assert.deepEqual(
      seenDuringFirstCall?.runtime_config,
      snapshotOf(true),
      'snapshot complet déjà présent, non ajouté après coup',
    );
  } finally {
    await box.cleanup();
  }
});

test('(3/4/5) validation : legacy accepté, V1.1 accepté, snapshot invalide rejeté', () => {
  const base = {
    schema_version: 1,
    run_id: 'CCR-20260402-001',
    title: 'T',
    created_at: '2026-08-08T00:00:00.000Z',
    workspace: { cwd: 'E:/x' },
    agents: { claude: { session_id: null, role: 'challenger' }, codex: { session_id: null, role: 'author' } },
  };

  // Run V1 historique : accepté tel quel, sans snapshot inventé.
  assert.equal(validateManifest(base).runtime_config, undefined);

  const pinned = validateManifest({ ...base, runtime_config: snapshotOf(true) });
  assert.deepEqual(pinned.runtime_config, snapshotOf(true));

  for (const broken of [
    { ...snapshotOf(true), codex: { ...snapshotOf(true).codex, skip_git_repo_check: 'true' } },
    { ...snapshotOf(true), claude: { cli_version: 2, auth_preflight: 'AUTHENTICATED' } },
    { ...snapshotOf(true), claude: { cli_version: null, auth_preflight: 'PEUT-ETRE' } },
    { ...snapshotOf(true), captured_at: 42 },
    'pas un objet',
  ]) {
    assert.throws(
      () => validateManifest({ ...base, runtime_config: broken }),
      (error: unknown) => isCcrError(error) && error.details['field'] === 'runtime_config',
      `snapshot invalide accepté : ${JSON.stringify(broken).slice(0, 60)}`,
    );
  }

  // Version de schéma inconnue : rejetée, jamais assimilée à une absence.
  assert.throws(
    () => validateManifest({ ...base, runtime_config: { ...snapshotOf(true), schema_version: 99 } }),
    (error: unknown) => isCcrError(error) && error.code === 'SCHEMA_VERSION_UNSUPPORTED',
  );
});

test('(6/7/8/9) le snapshot survit à l\'enregistrement des deux sessions', async () => {
  const box = await harness();
  try {
    const result = await startRun(box.deps(), {
      title: 'T',
      cwd: box.dir,
      prompt: 'p',
      runtimeConfig: snapshotOf(true),
    });

    // Défaut exact anticipé par la contre-expertise : une reconstruction champ
    // par champ supprimerait le snapshot dès la première session enregistrée.
    const loaded = await loadRun(box.runsDir, result.runId);
    assert.deepEqual(loaded.manifest.runtime_config, snapshotOf(true));
    assert.equal(loaded.manifest.agents.claude.session_id, 'claude-1');
    assert.equal(loaded.manifest.agents.codex.session_id, 'codex-1');

    // Une mise à jour supplémentaire ne l'altère pas davantage.
    const paths = runPaths(box.runsDir, result.runId);
    const updated = await setAgentSessionId(paths, loaded.manifest, 'claude', 'claude-2');
    assert.deepEqual(updated.runtime_config, snapshotOf(true));
    assert.deepEqual((await readManifest(paths)).runtime_config, snapshotOf(true));

    // Sérialisation/relecture exactes, et aucune donnée personnelle.
    const raw = await readFile(paths.manifest, 'utf8');
    for (const pii of ['@', 'token', 'orgId', 'account']) {
      assert.ok(!raw.includes(pii), `fuite : ${pii}`);
    }
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Autorité du snapshot (30.10 à 30.17)
// --------------------------------------------------------------------------

test('(10/11/13/14/17) le snapshot fait autorité sur send et step, quoi que dise la config globale', async () => {
  for (const pinned of [true, false]) {
    const box = await harness();
    try {
      const result = await startRun(box.deps(), {
        title: 'T',
        cwd: box.dir,
        prompt: 'p',
        runtimeConfig: snapshotOf(pinned),
      });
      box.received.length = 0;

      // Le repli hérité dit l'inverse du snapshot : il ne doit jamais servir.
      const contraire = box.deps(() => !pinned);
      await sendMessage(contraire, { runId: result.runId, agent: 'claude', message: 'm' });
      await stepRun(contraire, { runId: result.runId });

      assert.ok(box.received.length >= 2, 'les adapters ont bien été reconstruits');
      for (const value of box.received) {
        assert.equal(value, pinned, `run pinné à ${String(pinned)} : la valeur du run prime`);
      }
    } finally {
      await box.cleanup();
    }
  }
});

test('(15) recover reconstruit les adapters avec le snapshot du run', async () => {
  const box = await harness();
  try {
    // Initialisation partielle : Claude créé, Codex en échec.
    const adapters: AgentAdapters = {
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
      codex: createFakeAdapter({
        kind: 'codex',
        sessionId: 'codex-1',
        failStart: () => new Error('codex indisponible'),
      }),
    };
    const received: (boolean | undefined)[] = [];
    const deps: RunServiceDeps = {
      runsDir: box.runsDir,
      now: () => new Date(),
      createAdapters: (_cwd, runtime) => {
        received.push(runtime?.codexSkipGitRepoCheck ?? false);
        return adapters;
      },
    };

    const started = await startRun(deps, {
      title: 'T',
      cwd: box.dir,
      prompt: 'p',
      runtimeConfig: snapshotOf(true),
    });
    assert.ok(started.failure !== undefined, 'initialisation partielle attendue');

    const loaded = await loadRun(box.runsDir, started.runId);
    assert.equal(loaded.state.state, 'FAILED_INITIALIZATION');
    // Le snapshot survit à l'initialisation partielle.
    assert.deepEqual(loaded.manifest.runtime_config, snapshotOf(true));

    // La reprise doit utiliser `true`, même si l'environnement dirait `false`.
    assert.deepEqual(runtimeSettingsOf(loaded.manifest), { codexSkipGitRepoCheck: true });
    assert.ok(received.every((value) => value === true), 'aucune construction avec la valeur héritée');
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Runs legacy (31.18 à 31.24)
// --------------------------------------------------------------------------

test('(18/19/20/21/22) un run legacy reste lisible et utilise la résolution héritée', async () => {
  const box = await harness();
  try {
    // Forme V1 historique : fixture disque, la création moderne exigeant
    // désormais un snapshot (V2-IMP-28).
    const result = await startRun(box.deps(), {
      runtimeConfig: snapshotOf(true),
      title: 'T',
      cwd: box.dir,
      prompt: 'p',
    });
    await demoteToLegacyManifest(box.runsDir, result.runId);
    const paths = runPaths(box.runsDir, result.runId);
    const before = await readFile(paths.manifest, 'utf8');

    assert.equal((await loadRun(box.runsDir, result.runId)).manifest.runtime_config, undefined);

    for (const legacyValue of [true, false]) {
      box.received.length = 0;
      await sendMessage(box.deps(() => legacyValue), {
        runId: result.runId,
        agent: 'claude',
        message: 'm',
      });
      assert.ok(
        box.received.every((value) => value === legacyValue),
        `run non pinné : la résolution héritée (${String(legacyValue)}) s'applique`,
      );
    }

    // Aucune migration silencieuse : le manifest est inchangé.
    assert.equal(await readFile(paths.manifest, 'utf8'), before);
  } finally {
    await box.cleanup();
  }
});

test('(24) setup --run refuse un run legacy sans le migrer', async () => {
  const box = await harness();
  try {
    const result = await startRun(box.deps(), {
      runtimeConfig: snapshotOf(true),
      title: 'T',
      cwd: box.dir,
      prompt: 'p',
    });
    await demoteToLegacyManifest(box.runsDir, result.runId);
    const paths = runPaths(box.runsDir, result.runId);
    const before = await readFile(paths.manifest, 'utf8');

    const loaded = await loadRun(box.runsDir, result.runId);
    assert.throws(
      () => requirePinnedSnapshot(loaded.manifest),
      (error: unknown) => isCcrError(error) && error.details['reason'] === 'LEGACY_UNPINNED',
    );

    assert.equal(await readFile(paths.manifest, 'utf8'), before, 'aucune migration');
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// setup --run (32.25 à 32.39)
// --------------------------------------------------------------------------

async function pausedRun(box: Harness, skip: boolean): Promise<string> {
  const result = await startRun(box.deps(), {
    title: 'T',
    cwd: box.dir,
    prompt: 'p',
    runtimeConfig: snapshotOf(skip),
  });
  const { pauseRun } = await import('../../src/services/run-service.ts');
  await pauseRun(box.deps(), { runId: result.runId });
  return result.runId;
}

test('(25/31/32/34/35/36/37) une bascule explicite mute la seule clé autorisée et la journalise', async () => {
  for (const initial of [true, false]) {
    const box = await harness();
    try {
      const runId = await pausedRun(box, initial);
      const before = await loadRun(box.runsDir, runId);

      const result = await updateRunRuntimeConfig(box.runsDir, { runId, skipGitRepoCheck: !initial });

      assert.equal(result.previous, initial);
      assert.equal(result.next, !initial);

      const after = await loadRun(box.runsDir, runId);
      assert.equal(after.manifest.runtime_config?.codex.skip_git_repo_check, !initial);
      // Les faits décrivant le démarrage ne sont pas recapturés.
      assert.equal(after.manifest.runtime_config?.captured_at, before.manifest.runtime_config?.captured_at);
      assert.equal(after.manifest.runtime_config?.claude.cli_version, '2.1.224');
      assert.equal(after.manifest.runtime_config?.codex.auth_preflight, 'AUTHENTICATED');
      // Ni état, ni contrôle, ni reprise.
      assert.equal(after.state.state, before.state.state);
      assert.equal(after.state.control, before.state.control);

      const events = await (await openEventStore(runPaths(box.runsDir, runId), runId)).readAll();
      const changed = events.filter((event) => event.type === 'runtime_config_changed');
      assert.equal(changed.length, 1, 'un seul événement, append-only');
      assert.equal(changed[0]?.actor, 'human');
      assert.deepEqual(changed[0]?.details, {
        key: 'codex.skip_git_repo_check',
        previous: initial,
        next: !initial,
        origin: 'human',
      });
      assert.ok((changed[0]?.timestamp ?? '').length > 0);
    } finally {
      await box.cleanup();
    }
  }
});

test('(27/28/29) la mutation est refusée hors des conditions normatives', async () => {
  const box = await harness();
  try {
    // AUTOMATION : le run n'est pas sous contrôle humain.
    const running = await startRun(box.deps(), {
      title: 'T',
      cwd: box.dir,
      prompt: 'p',
      runtimeConfig: snapshotOf(false),
    });
    const before = await readFile(runPaths(box.runsDir, running.runId).manifest, 'utf8');

    await expectCcrError(
      updateRunRuntimeConfig(box.runsDir, { runId: running.runId, skipGitRepoCheck: true }),
      'AUTOMATION_NOT_IN_CONTROL',
      'contrôle automatisé',
    );
    assert.equal(await readFile(runPaths(box.runsDir, running.runId).manifest, 'utf8'), before);

    // Opération en vol : la mutation est refusée même sous contrôle humain.
    const paths = runPaths(box.runsDir, running.runId);
    const loaded = await loadRun(box.runsDir, running.runId);
    const { writeState } = await import('../../src/store/state-store.ts');
    await writeState(paths, {
      ...loaded.state,
      state: 'PAUSED',
      control: 'HUMAN',
      pending_operation: {
        kind: 'send',
        agent: 'codex',
        round: 0,
        prompt_event_id: null,
        source_event_id: null,
        session_id: null,
        return_state: 'PAUSED',
        return_control: 'HUMAN',
        started_at: new Date().toISOString(),
      },
    });

    await expectCcrError(
      updateRunRuntimeConfig(box.runsDir, { runId: running.runId, skipGitRepoCheck: true }),
      'RECOVERY_REQUIRED',
      'opération en vol',
    );
  } finally {
    await box.cleanup();
  }
});

test('(38/39) la mutation relit l\'état sous le verrou, et le verrou arbitre la course', async () => {
  const box = await harness();
  try {
    const runId = await pausedRun(box, false);
    const paths = runPaths(box.runsDir, runId);

    // Un autre processus détient le verrou du run.
    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const holder = await acquireRunLock(paths, 'step');
    try {
      await expectCcrError(
        updateRunRuntimeConfig(box.runsDir, { runId, skipGitRepoCheck: true }),
        'RUN_ALREADY_LOCKED',
        'course arbitrée par le verrou',
      );
      assert.equal(
        (await loadRun(box.runsDir, runId)).manifest.runtime_config?.codex.skip_git_repo_check,
        false,
        'aucune mutation',
      );
    } finally {
      await holder.release();
    }

    // Le verrou libéré, la mutation redevient possible.
    await updateRunRuntimeConfig(box.runsDir, { runId, skipGitRepoCheck: true });
    assert.equal(
      (await loadRun(box.runsDir, runId)).manifest.runtime_config?.codex.skip_git_repo_check,
      true,
    );
  } finally {
    await box.cleanup();
  }
});

test('la valeur mutée gouverne immédiatement les opérations suivantes', async () => {
  const box = await harness();
  try {
    const runId = await pausedRun(box, false);
    await updateRunRuntimeConfig(box.runsDir, { runId, skipGitRepoCheck: true });

    const { resumeRun } = await import('../../src/services/run-service.ts');
    await resumeRun(box.deps(), { runId });

    box.received.length = 0;
    await sendMessage(box.deps(() => false), { runId, agent: 'claude', message: 'm' });

    assert.ok(box.received.length > 0);
    assert.ok(box.received.every((value) => value === true), 'la nouvelle valeur fait autorité');
  } finally {
    await box.cleanup();
  }
});


// --------------------------------------------------------------------------
// Provenance historique (gate de cloture, §14)
// --------------------------------------------------------------------------

test('(1/2/3) la provenance calculee par le preflight est celle persistee', async () => {
  const { runStartPreflight } = await import('../../src/runtime/preflight-service.ts');
  const { writeConfig, CONFIG_FILE_NAME } = await import('../../src/config/config-store.ts');
  const { defaultConfig } = await import('../../src/config/config-schema.ts');

  const cases: readonly [string, NodeJS.ProcessEnv, boolean | undefined, string, boolean][] = [
    ['aucune configuration', {}, undefined, 'default', false],
    ['configuration presente', {}, true, 'config', true],
    ['variable heritee', { CCR_CODEX_SKIP_GIT_REPO_CHECK: '1' }, false, 'legacy-env', true],
  ];

  for (const [label, env, persisted, expectedSource, expectedValue] of cases) {
    const box = await harness();
    try {
      const configPath = path.join(box.dir, CONFIG_FILE_NAME);
      if (persisted !== undefined) {
        await writeConfig({ ...defaultConfig(), codex: { skip_git_repo_check: persisted } }, { configPath });
      }

      const probe = (agent: 'claude' | 'codex'): AgentRuntimeProbe => ({
        agent,
        installed: true,
        version: '1.0.0',
        authStatus: 'AUTHENTICATED',
        launcherSource: 'path',
      });
      const preflight = await runStartPreflight({
        configPath,
        env,
        tty: { stdin: false, stdout: false },
        probes: { claude: async () => probe('claude'), codex: async () => probe('codex') },
      });

      assert.equal(preflight.effectiveConfig.codex.source, expectedSource, label);
      assert.equal(preflight.effectiveConfig.codex.skipGitRepoCheck, expectedValue, label);

      // La provenance voyage jusqu'au snapshot persiste, a l'identique.
      const result = await startRun(box.deps(), {
        title: 'T',
        cwd: box.dir,
        prompt: 'p',
        runtimeConfig: {
          schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
          captured_at: new Date().toISOString(),
          claude: { cli_version: '1.0.0', auth_preflight: 'AUTHENTICATED' },
          codex: {
            cli_version: '1.0.0',
            auth_preflight: 'AUTHENTICATED',
            skip_git_repo_check: preflight.effectiveConfig.codex.skipGitRepoCheck,
            source_at_capture: preflight.effectiveConfig.codex.source,
          },
        },
      });

      const loaded = await loadRun(box.runsDir, result.runId);
      assert.equal(loaded.manifest.runtime_config?.codex.source_at_capture, expectedSource, label);
    } finally {
      await box.cleanup();
    }
  }
});

test('(4/5) la provenance est serialisee exactement et strictement validee', async () => {
  const box = await harness();
  try {
    const result = await startRun(box.deps(), {
      title: 'T',
      cwd: box.dir,
      prompt: 'p',
      runtimeConfig: snapshotOf(true),
    });

    const raw = JSON.parse(await readFile(runPaths(box.runsDir, result.runId).manifest, 'utf8')) as {
      runtime_config: { codex: { source_at_capture: string } };
    };
    assert.equal(raw.runtime_config.codex.source_at_capture, 'config');

    // Toute valeur hors de l'union fermee est refusee, absence comprise.
    const base = {
      schema_version: 1,
      run_id: 'CCR-20260402-001',
      title: 'T',
      created_at: '2026-08-08T00:00:00.000Z',
      workspace: { cwd: 'E:/x' },
      agents: {
        claude: { session_id: null, role: 'challenger' },
        codex: { session_id: null, role: 'author' },
      },
    };
    for (const invalid of ['human-override', 'env', '', 42, null, 'ABSENT']) {
      const codex = { ...snapshotOf(true).codex } as Record<string, unknown>;
      if (invalid === 'ABSENT') delete codex['source_at_capture'];
      else codex['source_at_capture'] = invalid;

      assert.throws(
        () => validateManifest({ ...base, runtime_config: { ...snapshotOf(true), codex } }),
        (error: unknown) => isCcrError(error) && error.details['field'] === 'runtime_config',
        `provenance acceptee a tort : ${String(invalid)}`,
      );
    }
  } finally {
    await box.cleanup();
  }
});

test('(6) un run V1 historique reste accepte sans provenance', () => {
  const legacy = {
    schema_version: 1,
    run_id: 'CCR-20260401-001',
    title: 'T',
    created_at: '2026-08-07T00:00:00.000Z',
    workspace: { cwd: 'E:/x' },
    agents: {
      claude: { session_id: 'c', role: 'challenger' },
      codex: { session_id: 'x', role: 'author' },
    },
  };

  // Aucun snapshot du tout : la question de la provenance ne se pose pas.
  assert.equal(validateManifest(legacy).runtime_config, undefined);
});

test('(7/8/9) la provenance survit aux sessions et a un override humain', async () => {
  const box = await harness();
  try {
    const runId = await pausedRun(box, true);
    const before = await loadRun(box.runsDir, runId);
    assert.equal(before.manifest.runtime_config?.codex.source_at_capture, 'config');
    assert.equal(before.manifest.agents.codex.session_id, 'codex-1');

    await updateRunRuntimeConfig(box.runsDir, { runId, skipGitRepoCheck: false });

    const after = await loadRun(box.runsDir, runId);
    // La valeur executable change ; la provenance historique, non.
    assert.equal(after.manifest.runtime_config?.codex.skip_git_repo_check, false);
    assert.equal(
      after.manifest.runtime_config?.codex.source_at_capture,
      'config',
      "la provenance decrit le demarrage, pas l'override",
    );

    // C'est l'evenement qui porte la trace de l'override humain.
    const events = await (await openEventStore(runPaths(box.runsDir, runId), runId)).readAll();
    const changed = events.filter((event) => event.type === 'runtime_config_changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0]?.details?.['previous'], true);
    assert.equal(changed[0]?.details?.['next'], false);
    assert.equal(changed[0]?.actor, 'human');
  } finally {
    await box.cleanup();
  }
});

test("(11) la provenance n'est jamais l'autorite : seule la valeur compte", async () => {
  const box = await harness();
  try {
    // Snapshot volontairement dissonant mais parfaitement valide : la
    // provenance dit `legacy-env`, la valeur dit `true`, le repli dirait
    // `false`. Seule la valeur doit gouverner.
    const result = await startRun(box.deps(), {
      title: 'T',
      cwd: box.dir,
      prompt: 'p',
      runtimeConfig: {
        ...snapshotOf(true),
        codex: { ...snapshotOf(true).codex, source_at_capture: 'legacy-env' },
      },
    });
    box.received.length = 0;

    await sendMessage(box.deps(() => false), { runId: result.runId, agent: 'claude', message: 'm' });

    assert.ok(box.received.length > 0);
    assert.ok(
      box.received.every((value) => value === true),
      'la valeur executable gouverne, quelle que soit la provenance declaree',
    );
  } finally {
    await box.cleanup();
  }
});
