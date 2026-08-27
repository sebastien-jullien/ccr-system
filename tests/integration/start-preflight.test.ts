/**
 * IT-11.1-10 / IT-11.1-05 — preflight réel et Codex hors dépôt Git.
 *
 * Deux preuves qu'aucune fixture ne peut apporter :
 *
 *  1. le preflight passe sur les VRAIES CLI actuellement authentifiées, sans
 *     ouvrir la moindre connexion ;
 *  2. une configuration CCR isolée portant `codex.skip_git_repo_check = true`,
 *     **sans** variable d'environnement héritée, suffit à créer une vraie
 *     session Codex dans un répertoire qui n'est pas un dépôt Git.
 *
 * Aucun credential n'est modifié, aucune connexion n'est lancée, et la
 * configuration réelle de l'utilisateur n'est pas touchée : le chemin de
 * configuration est injecté dans un répertoire temporaire.
 *
 * Exécution : npm run test:integration
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { runStartPreflight } from '../../src/runtime/preflight-service.ts';
import type { StartPreflightResult } from '../../src/runtime/preflight-service.ts';
import { createClaudeAdapter, resolveClaudeLauncher } from '../../src/adapters/claude-adapter.ts';
import { createCodexAdapter, resolveCodexLauncher } from '../../src/adapters/codex-adapter.ts';
import type { AgentLauncher } from '../../src/adapters/agent-adapter.ts';
import { startRunWithPreflight } from '../../src/services/start-application-service.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import { writeConfig } from '../../src/config/config-store.ts';
import { defaultConfig } from '../../src/config/config-schema.ts';
import { CONFIG_FILE_NAME } from '../../src/config/config-store.ts';
import { loadRun } from '../../src/store/state-store.ts';
import { listRunIds } from '../../src/store/layout.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

/** Variables injectées par une session Claude Code hôte (convention V1). */
const HOST_AGENT_ENV = Object.keys(process.env).filter((name) =>
  /^(CLAUDE|CLAUDECODE|ANTHROPIC)/.test(name),
);

const LEGACY_ENV = 'CCR_CODEX_SKIP_GIT_REPO_CHECK';

function tryResolve(resolver: (explicit?: string) => AgentLauncher, envVar: string): AgentLauncher | undefined {
  try {
    return resolver(process.env[envVar]);
  } catch {
    return undefined;
  }
}

const claudeLauncher = tryResolve(resolveClaudeLauncher, 'CCR_CLAUDE_BIN');
const codexLauncher = tryResolve(resolveCodexLauncher, 'CCR_CODEX_BIN');

const cliMissing = claudeLauncher === undefined || codexLauncher === undefined;

test(
  'IT-11.1-10 — le preflight réel passe sur les CLI authentifiées sans ouvrir de connexion',
  { skip: cliMissing ? 'CLI Claude ou Codex introuvable' : false, timeout: 180_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-it-preflight-');
    try {
      let loginAttempted = false;

      const result = await runStartPreflight({
        // Configuration isolée : la configuration réelle n'est ni lue, ni écrite.
        configPath: path.join(dir, CONFIG_FILE_NAME),
        env: {},
        tty: { stdin: false, stdout: false },
        agentOptions: {
          claude: { cwd: dir, timeoutMs: 60_000, unsetEnv: HOST_AGENT_ENV },
          codex: { cwd: dir, timeoutMs: 60_000 },
        },
        logins: {
          claude: async () => {
            loginAttempted = true;
            throw new Error('aucune connexion ne doit être tentée');
          },
          codex: async () => {
            loginAttempted = true;
            throw new Error('aucune connexion ne doit être tentée');
          },
        },
      });

      t.diagnostic(
        `claude ${result.claude.version ?? '?'} ${result.claude.authStatus} · ` +
          `codex ${result.codex.version ?? '?'} ${result.codex.authStatus} · ` +
          `warnings=[${result.warnings.join(',')}]`,
      );

      assert.equal(loginAttempted, false, 'aucune connexion tentée');
      assert.equal(result.claude.installed, true);
      assert.equal(result.codex.installed, true);
      assert.match(result.claude.version ?? '', /^\d+\.\d+\.\d+/);
      assert.match(result.codex.version ?? '', /^\d+\.\d+\.\d+/);
      // Configuration absente et environnement vide : le défaut s'applique.
      assert.equal(result.effectiveConfig.codex.skipGitRepoCheck, false);
      assert.equal(result.effectiveConfig.codex.source, 'default');
    } finally {
      await removeTempDir(dir);
    }
  },
);

test(
  'IT-11.1-05 — la configuration seule permet une vraie session Codex hors dépôt Git',
  {
    skip: cliMissing
      ? 'CLI Claude ou Codex introuvable'
      : process.env[LEGACY_ENV] !== undefined
        ? `${LEGACY_ENV} est définie : la preuve serait ambiguë`
        : false,
    timeout: 900_000,
  },
  async (t) => {
    // Répertoire temporaire : hors de tout dépôt Git, ce qui est précisément
    // la condition que Codex refuse par défaut.
    const workspace = await makeTempDir('ccr-it-hors-git-');
    const runsDir = path.join(workspace, 'runs');
    await mkdir(runsDir, { recursive: true });

    try {
      const configPath = path.join(workspace, CONFIG_FILE_NAME);
      await writeConfig(
        { ...defaultConfig(), codex: { skip_git_repo_check: true } },
        { configPath },
      );

      // La composition entière — configuration, probes, preflight, snapshot,
      // allocation, sessions natives — passe par la façade applicative, celle
      // que la CLI utilise et que le cockpit utilisera (V2-IMP-28).
      assert.equal(process.env[LEGACY_ENV], undefined, 'aucune variable héritée en jeu');

      let observed: StartPreflightResult | undefined;
      let receivedSkip: boolean | undefined;

      const result = await startRunWithPreflight(
        {
          interaction: { kind: 'non-interactive' },
          preflight: {
            configPath,
            env: {},
            agentOptions: {
              claude: { cwd: workspace, timeoutMs: 60_000, unsetEnv: HOST_AGENT_ENV },
              codex: { cwd: workspace, timeoutMs: 60_000 },
            },
          },
          onPreflight: (preflight) => {
            observed = preflight;
          },
          createRunServiceDeps: (runtime) => {
            receivedSkip = runtime.codexSkipGitRepoCheck;
            const adapters: AgentAdapters = {
              claude: createClaudeAdapter({
                cwd: workspace,
                timeoutMs: 600_000,
                unsetEnv: HOST_AGENT_ENV,
              }),
              // La valeur vient du snapshot que la façade vient de figer.
              codex: createCodexAdapter({
                cwd: workspace,
                timeoutMs: 600_000,
                skipGitRepoCheck: runtime.codexSkipGitRepoCheck,
              }),
            };
            return { runsDir, now: () => new Date(), createAdapters: () => adapters };
          },
        },
        { title: 'Preuve hors dépôt Git', cwd: workspace, prompt: 'Réponds uniquement : OK.' },
      );

      assert.equal(observed?.effectiveConfig.codex.skipGitRepoCheck, true);
      assert.equal(observed?.effectiveConfig.codex.source, 'config', 'la config décide, pas une variable');
      assert.equal(receivedSkip, true, 'le snapshot gouverne la construction des adapters');

      t.diagnostic(
        `run ${result.runId} · état ${result.state.state} · ` +
          `claude=${result.manifest.agents.claude.session_id ?? '—'} · ` +
          `codex=${result.manifest.agents.codex.session_id ?? '—'}`,
      );
      t.diagnostic(
        `snapshot · claude=${result.runtimeConfig.claude.cli_version ?? '—'} · ` +
          `codex=${result.runtimeConfig.codex.cli_version ?? '—'} · ` +
          `skip_git_repo_check=${String(result.runtimeConfig.codex.skip_git_repo_check)} · ` +
          `source_at_capture=${result.runtimeConfig.codex.source_at_capture}`,
      );

      assert.equal(result.failure, undefined, "aucune initialisation partielle n'était attendue");
      assert.equal((await listRunIds(runsDir)).length, 1);

      const loaded = await loadRun(runsDir, result.runId);
      assert.equal(loaded.state.state, 'READY');
      // Le snapshot est durablement figé dans le manifest du run réel.
      assert.equal(loaded.manifest.runtime_config?.codex.skip_git_repo_check, true);
      assert.equal(loaded.manifest.runtime_config?.codex.source_at_capture, 'config');
      // La vraie session Codex existe : Codex a donc bien accepté de s'exécuter
      // hors dépôt Git, sur la seule foi de la configuration CCR.
      assert.ok((loaded.manifest.agents.codex.session_id ?? '').length > 0, 'session Codex réelle créée');
      assert.ok((loaded.manifest.agents.claude.session_id ?? '').length > 0, 'session Claude réelle créée');
    } finally {
      await removeTempDir(workspace);
    }
  },
);
