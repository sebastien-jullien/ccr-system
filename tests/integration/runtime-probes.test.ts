/**
 * IT-11.1-01 / IT-11.1-02 — probes runtime sur les VRAIES CLI locales.
 *
 * Aucune fixture ne peut démontrer ce que ce test démontre : que la résolution
 * partagée trouve les CLI réellement installées sur ce poste, et que leurs
 * sorties réelles sont correctement classées.
 *
 * Ce test est **en lecture seule** vis-à-vis des fournisseurs : il n'appelle
 * aucun modèle, ne crée aucune session, ne lance aucun login et ne modifie
 * aucun credential.
 *
 * Statut honnête : si une CLI est absente, le test est marqué `skip` avec un
 * motif explicite plutôt que de passer silencieusement.
 *
 * Exécution : npm run test:integration
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';

import { probeClaudeRuntime } from '../../src/runtime/claude-runtime-probe.ts';
import { probeCodexRuntime } from '../../src/runtime/codex-runtime-probe.ts';
import { loginClaude, loginCodex } from '../../src/runtime/agent-login.ts';
import { resolveClaudeLauncher } from '../../src/adapters/claude-adapter.ts';
import { resolveCodexLauncher } from '../../src/adapters/codex-adapter.ts';
import type { AgentLauncher } from '../../src/adapters/agent-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

/**
 * Variables injectées par une session Claude Code hôte : les conserver
 * détourne le client enfant vers l'authentification du parent. Même purge que
 * les tests de continuité V1.
 */
const HOST_AGENT_ENV = Object.keys(process.env).filter((name) =>
  /^(CLAUDE|CLAUDECODE|ANTHROPIC)/.test(name),
);

function tryResolve(resolver: (explicit?: string) => AgentLauncher, envVar: string): AgentLauncher | undefined {
  try {
    return resolver(process.env[envVar]);
  } catch {
    return undefined;
  }
}

const claudeLauncher = tryResolve(resolveClaudeLauncher, 'CCR_CLAUDE_BIN');
const codexLauncher = tryResolve(resolveCodexLauncher, 'CCR_CODEX_BIN');

const AUTH_STATUSES = ['AUTHENTICATED', 'UNAUTHENTICATED', 'UNKNOWN'];

test(
  'IT-11.1-01/02 — le probe Claude réel détecte la CLI, sa version et son statut',
  { skip: claudeLauncher === undefined ? 'CLI Claude introuvable' : false, timeout: 120_000 },
  async (t) => {
    const cwd = await makeTempDir('ccr-it-probe-claude-');
    try {
      const probe = await probeClaudeRuntime({ cwd, timeoutMs: 60_000, unsetEnv: HOST_AGENT_ENV });

      t.diagnostic(`claude: ${JSON.stringify(probe)}`);

      assert.equal(probe.installed, true);
      assert.equal(probe.agent, 'claude');
      assert.match(probe.version ?? '', /^\d+\.\d+\.\d+/, 'version réelle récupérée');
      assert.ok(AUTH_STATUSES.includes(probe.authStatus));

      // Aucune donnée personnelle ne doit survivre, alors que la sortie réelle
      // de `claude auth status` en contient.
      const serialized = JSON.stringify(probe);
      assert.ok(!serialized.includes('@'), "aucune adresse e-mail dans le résultat");
      assert.ok(!/orgId|orgName|subscription/i.test(serialized), 'aucune donnée de compte');
    } finally {
      await removeTempDir(cwd);
    }
  },
);

test(
  'IT-11.1-01/02 — le probe Codex réel fonctionne malgré le shim npm Windows',
  { skip: codexLauncher === undefined ? 'CLI Codex introuvable' : false, timeout: 120_000 },
  async (t) => {
    assert.ok(codexLauncher);
    const cwd = await makeTempDir('ccr-it-probe-codex-');
    try {
      const probe = await probeCodexRuntime({ cwd, timeoutMs: 60_000 });

      t.diagnostic(`codex: ${JSON.stringify(probe)} via ${codexLauncher.source}`);

      assert.equal(probe.installed, true);
      assert.equal(probe.agent, 'codex');
      assert.match(probe.version ?? '', /^\d+\.\d+\.\d+/, 'version réelle récupérée');
      assert.ok(AUTH_STATUSES.includes(probe.authStatus));

      const serialized = JSON.stringify(probe);
      assert.ok(!serialized.includes('@'), "aucune adresse e-mail dans le résultat");
    } finally {
      await removeTempDir(cwd);
    }
  },
);

/**
 * IT-11.1-09 — un compte réellement authentifié ne déclenche aucune connexion.
 *
 * C'est la seule portion du flow de connexion démontrable sans dégrader
 * l'environnement de travail : elle prouve que le service consomme les **vrais**
 * probes et qu'il n'ouvre ni navigateur ni flow lorsque ce n'est pas nécessaire.
 *
 * Le chemin complet `UNAUTHENTICATED → login réel → AUTHENTICATED` relève de
 * IT-11.1-08, avec profil isolé et action humaine explicite. Il reste
 * `NOT_TESTED` à ce stade.
 */
test(
  'IT-11.1-09 — un agent réellement authentifié ne déclenche aucun flow de connexion',
  {
    skip:
      claudeLauncher === undefined || codexLauncher === undefined
        ? 'CLI Claude ou Codex introuvable'
        : false,
    timeout: 180_000,
  },
  async (t) => {
    const cwd = await makeTempDir('ccr-it-login-');
    try {
      // Terminal déclaré **absent** : un agent déjà authentifié n'a besoin
      // d'aucune interaction, donc d'aucun terminal. C'est la règle arbitrée
      // de l'ordre des gardes, éprouvée ici sur les CLI réelles.
      const tty = { stdin: false, stdout: false };

      const claude = await loginClaude({ consentGranted: true, tty, cwd, timeoutMs: 60_000, unsetEnv: HOST_AGENT_ENV });
      const codex = await loginCodex({ consentGranted: true, tty, cwd, timeoutMs: 60_000 });

      t.diagnostic(`claude: ${claude.status} / ${claude.probe.authStatus}`);
      t.diagnostic(`codex: ${codex.status} / ${codex.probe.authStatus}`);

      // Aucun `claude auth login`, aucun `codex login` n'a été lancé.
      assert.equal(claude.status, 'ALREADY_AUTHENTICATED');
      assert.equal(codex.status, 'ALREADY_AUTHENTICATED');
      assert.equal(claude.probe.authStatus, 'AUTHENTICATED');
      assert.equal(codex.probe.authStatus, 'AUTHENTICATED');

      // Les vrais probes ont bien été employés : versions réelles observées.
      assert.match(claude.probe.version ?? '', /^\d+\.\d+\.\d+/);
      assert.match(codex.probe.version ?? '', /^\d+\.\d+\.\d+/);

      assert.deepEqual(await readdir(cwd), [], 'aucun fichier créé');
    } finally {
      await removeTempDir(cwd);
    }
  },
);
