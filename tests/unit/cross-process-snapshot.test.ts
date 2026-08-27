/**
 * Preuve inter-processus du snapshot (lot V1.1-7, §31.1).
 *
 * La propriété centrale de V1.1 ne se démontre pas dans une closure : elle dit
 * que le comportement d'un run **survit au processus qui l'a créé**. Ce test
 * lance donc deux vrais processus CCR distincts, via le binaire réel.
 *
 *   Processus A   configuration isolée disant `true`  → run pinné à `true`
 *   Processus B   configuration isolée disant `false` → opération sur le run
 *
 * Le second doit encore transmettre `--skip-git-repo-check` à Codex.
 *
 * L'isolation passe par un répertoire personnel dédié au processus enfant :
 * aucune variable publique n'est inventée, et la configuration réelle de
 * l'utilisateur n'est ni lue ni écrite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { CONFIG_FILE_NAME } from '../../src/config/config-store.ts';
import { defaultConfig } from '../../src/config/config-schema.ts';
import { listRunIds, runPaths } from '../../src/store/layout.ts';
import { readPersistedManifest } from '../../src/store/native-store.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const run = promisify(execFile);

const CCR_BIN = fileURLToPath(new URL('../../bin/ccr.mjs', import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));

/** Environnement d'un processus CCR isolé : home dédié, aucune variable héritée. */
async function isolatedEnv(home: string, skipGitRepoCheck: boolean, argsFile: string): Promise<NodeJS.ProcessEnv> {
  const configDir = path.join(home, '.ccr');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, CONFIG_FILE_NAME),
    JSON.stringify({ ...defaultConfig(), codex: { skip_git_repo_check: skipGitRepoCheck } }),
    'utf8',
  );

  const env = { ...process.env };
  delete env['CCR_CODEX_SKIP_GIT_REPO_CHECK'];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CCR_CLAUDE_BIN: CLAUDE_FIXTURE,
    CCR_CODEX_BIN: CODEX_FIXTURE,
    FAKE_CODEX_ARGS_FILE: argsFile,
  };
}

async function codexArgs(argsFile: string): Promise<string[]> {
  return JSON.parse(await readFile(argsFile, 'utf8')) as string[];
}

test(
  'la configuration figée d\'un run survit au processus qui l\'a créé',
  { timeout: 180_000 },
  async (t) => {
    for (const pinned of [true, false]) {
      const dir = await makeTempDir('ccr-xproc-');
      try {
        const runsDir = path.join(dir, 'runs');
        await mkdir(runsDir, { recursive: true });

        // ---- Processus A : crée le run avec une configuration disant `pinned`.
        const homeA = path.join(dir, 'home-a');
        const argsA = path.join(dir, 'codex-args-a.json');
        await run(process.execPath, [CCR_BIN, 'start', '--title', 'T', '--prompt', 'p', '--cwd', dir, '--runs-dir', runsDir], {
          env: await isolatedEnv(homeA, pinned, argsA),
          timeout: 60_000,
        });

        const runIds = await listRunIds(runsDir);
        assert.equal(runIds.length, 1, 'un run créé');
        const runId = runIds[0] ?? '';

        // La CLI cree desormais des runs natifs : le snapshot est lu par le
        // lecteur de generation, et la propriete testee est inchangee.
        const created = await readPersistedManifest(runPaths(runsDir, runId));
        assert.equal(created.execution_mode, 'NATIVE_V21_EXECUTION');
        if (created.execution_mode !== 'NATIVE_V21_EXECUTION') return;
        const codex = created.manifest.runtime_config?.codex;
        assert.equal(
          codex?.required === true ? codex.skip_git_repo_check : undefined,
          pinned,
          'le snapshot porte la valeur de la configuration du processus A',
        );
        assert.deepEqual(
          (await codexArgs(argsA)).includes('--skip-git-repo-check'),
          pinned,
          'processus A : le drapeau suit la configuration',
        );

        // ---- Processus B : configuration **contraire**, variable absente.
        const homeB = path.join(dir, 'home-b');
        const argsB = path.join(dir, 'codex-args-b.json');
        await run(
          process.execPath,
          [CCR_BIN, 'send', 'codex', 'message de suite', '--run', runId, '--runs-dir', runsDir],
          { env: await isolatedEnv(homeB, !pinned, argsB), timeout: 60_000 },
        );

        const observed = await codexArgs(argsB);
        t.diagnostic(`pinné=${String(pinned)} · processus B argv=${observed.join(' ')}`);

        assert.equal(
          observed.includes('--skip-git-repo-check'),
          pinned,
          'le second processus obéit au snapshot du run, non à sa propre configuration',
        );
      } finally {
        await removeTempDir(dir);
      }
    }
  },
);

test(
  'un run V1 historique reste gouverné par la résolution héritée, dans un autre processus',
  { timeout: 180_000 },
  async () => {
    const dir = await makeTempDir('ccr-xproc-legacy-');
    try {
      const runsDir = path.join(dir, 'runs');
      await mkdir(runsDir, { recursive: true });

      // Run V1 historique : fixture disque, la création moderne exigeant
      // désormais un snapshot (V2-IMP-28).
      const { startRun } = await import('../../src/services/run-service.ts');
      const { createFakeAdapter } = await import('../helpers/fake-adapter.ts');
      const { TEST_RUNTIME_CONFIG } = await import('../helpers/runtime-config.ts');
      const { demoteToLegacyManifest } = await import('../helpers/legacy-run.ts');
      const { loadRun } = await import('../../src/store/state-store.ts');
      const adapters = {
        claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
        codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
      };
      const started = await startRun(
        { runsDir, now: () => new Date(), createAdapters: () => adapters },
        { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: dir, prompt: 'p' },
      );
      await demoteToLegacyManifest(runsDir, started.runId);
      assert.equal((await loadRun(runsDir, started.runId)).manifest.runtime_config, undefined);

      // Un autre processus, dont la configuration dit `true`.
      const home = path.join(dir, 'home');
      const argsFile = path.join(dir, 'codex-args.json');
      await run(
        process.execPath,
        [CCR_BIN, 'send', 'codex', 'message', '--run', started.runId, '--runs-dir', runsDir],
        { env: await isolatedEnv(home, true, argsFile), timeout: 60_000 },
      );

      // Non pinné : la configuration globale s'applique bien (§13.3).
      assert.ok(
        (await codexArgs(argsFile)).includes('--skip-git-repo-check'),
        'un run legacy suit la résolution héritée',
      );
      // …et son manifest n'a pas été migré au passage.
      assert.equal((await loadRun(runsDir, started.runId)).manifest.runtime_config, undefined);
    } finally {
      await removeTempDir(dir);
    }
  },
);
