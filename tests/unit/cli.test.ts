/**
 * Tests unitaires de la CLI (lot V1.5).
 *
 * La CLI est un adaptateur : ces tests vérifient l'analyse des arguments, les
 * codes de sortie et le fait qu'elle délègue aux services — pas la logique
 * métier, testée dans run-service.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../../src/cli/main.ts';
import type { CliIo } from '../../src/cli/main.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { startRun } from '../../src/services/run-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import path from 'node:path';

import type { StartPreflightDeps } from '../../src/runtime/preflight-service.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

interface Capture extends CliIo {
  readonly stdout: string[];
  readonly stderr: string[];
  text(): string;
  errorText(): string;
}

function capture(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    text: () => stdout.join('\n'),
    errorText: () => stderr.join('\n'),
  };
}

/**
 * Le preflight V1.1 de `ccr start` s'exécute désormais avant toute allocation.
 * Il est ici alimenté par des sondes fictives et une configuration isolée : ces
 * tests portent sur l'analyse d'arguments et le rendu, pas sur les fournisseurs.
 */
function fakePreflight(runsDir: string): StartPreflightDeps {
  const probe = (agent: 'claude' | 'codex'): AgentRuntimeProbe => ({
    agent,
    installed: true,
    version: '1.0.0',
    authStatus: 'AUTHENTICATED',
    launcherSource: 'path',
  });
  return {
    configPath: path.join(runsDir, 'config-isole.json'),
    env: {},
    tty: { stdin: false, stdout: false },
    probes: { claude: async () => probe('claude'), codex: async () => probe('codex') },
  };
}

async function testDeps(): Promise<{
  deps: RunServiceDeps;
  preflight: StartPreflightDeps;
  workspace: string;
  cleanup(): Promise<void>;
}> {
  const runsDir = await makeTempDir('ccr-cli-');
  // Workspace **réel**. Depuis que la CLI partage `canonicalizeWorkspace()`
  // avec le cockpit, un chemin fictif est refusé avant tout preflight : un
  // workspace est une frontière de données projet, et une frontière doit
  // désigner un répertoire qui existe.
  const workspace = await makeTempDir('ccr-cli-ws-');
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-uuid-1' }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-thread-1' }),
  };
  return {
    deps: { runsDir, now: () => new Date(), createAdapters: () => adapters },
    preflight: fakePreflight(runsDir),
    workspace,
    cleanup: async () => {
      await removeTempDir(runsDir);
      await removeTempDir(workspace);
    },
  };
}

test('sans argument, la CLI affiche l\'usage et sort en 2', async () => {
  const io = capture();
  assert.equal(await runCli([], { io }), 2);
  assert.ok(io.text().includes('ccr start'));
});

test('--help sort en 0', async () => {
  const io = capture();
  assert.equal(await runCli(['--help'], { io }), 0);
  assert.ok(io.text().includes('Usage'));
});

test('une commande inconnue sort en 2', async () => {
  const io = capture();
  assert.equal(await runCli(['converge'], { io }), 2);
  assert.ok(io.errorText().includes('Commande inconnue'));
});

test('une option inconnue sort en 2 plutôt que d\'être ignorée', async () => {
  const io = capture();
  assert.equal(await runCli(['list', '--verbeux'], { io }), 2);
  assert.ok(io.errorText().includes('--verbeux'));
});

test('start exige un titre et un contexte initial', async () => {
  const { deps, preflight, cleanup } = await testDeps();
  try {
    const withoutPrompt = capture();
    assert.equal(await runCli(['start', '--title', 'T'], { deps, preflight, io: withoutPrompt }), 2);
    assert.ok(withoutPrompt.errorText().includes('contexte initial'));

    const withoutTitle = capture();
    assert.equal(await runCli(['start', '--prompt', 'p'], { deps, preflight, io: withoutTitle }), 2);
    assert.ok(withoutTitle.errorText().includes('--title'));
  } finally {
    await cleanup();
  }
});

test('un rôle invalide est refusé', async () => {
  const { deps, preflight, cleanup } = await testDeps();
  try {
    const io = capture();
    const code = await runCli(['start', '--title', 'T', '--prompt', 'p', '--claude-role', 'arbitre'], { deps, preflight, io });
    assert.equal(code, 2);
    assert.ok(io.errorText().includes('author'));
  } finally {
    await cleanup();
  }
});

test('start crée un run natif et affiche les deux experts', async () => {
  const { deps, preflight, workspace, cleanup } = await testDeps();
  try {
    const io = capture();
    const code = await runCli(
      ['start', '--title', 'Assainissement', '--prompt', 'contexte', '--cwd', workspace],
      { deps, preflight, io },
    );

    assert.equal(code, 0);
    assert.ok(io.text().includes('Run créé : CCR-'));
    // Les experts sont nommés par leur slot, leur moteur entre parenthèses :
    // c'est la seule forme qui reste vraie quand les deux partagent un moteur.
    assert.ok(io.text().includes('author (codex) : session codex-thread-1'));
    assert.ok(io.text().includes('challenger (claude) : session claude-uuid-1'));
    assert.ok(io.text().includes('État : READY'));
  } finally {
    await cleanup();
  }
});

test('la syntaxe --option=valeur est acceptée', async () => {
  const { deps, preflight, cleanup } = await testDeps();
  try {
    const io = capture();
    assert.equal(await runCli(['start', '--title=T', '--prompt=p'], { deps, preflight, io }), 0);
  } finally {
    await cleanup();
  }
});

test('status affiche l\'état, le workspace et les deux sessions', async () => {
  const { deps, preflight, cleanup } = await testDeps();
  try {
    const run = await startRun(deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Assainissement', cwd: 'E:/prog/exemple', prompt: 'p' });

    const io = capture();
    assert.equal(await runCli(['status', run.runId], { deps, io }), 0);

    const text = io.text();
    assert.ok(text.includes(run.runId));
    assert.ok(text.includes('State       : READY'));
    assert.ok(text.includes('Control     : AUTOMATION'));
    assert.ok(text.includes('Workspace   : E:/prog/exemple'));
    assert.ok(text.includes('session   : claude-uuid-1'));
    assert.ok(text.includes('session   : codex-thread-1'));
    assert.ok(!text.includes('SHA'), 'aucun contexte Git (amendement A-1)');
  } finally {
    await cleanup();
  }
});

test('list énumère les runs avec leur état', async () => {
  const { deps, preflight, cleanup } = await testDeps();
  try {
    await startRun(deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Premier', cwd: 'E:/prog/exemple', prompt: 'p' });
    await startRun(deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'Second', cwd: 'E:/prog/exemple', prompt: 'p' });

    const io = capture();
    assert.equal(await runCli(['list'], { deps, io }), 0);
    // La generation est explicite depuis V2.1-IMP-16 : `list` lit les deux, et
    // un run historique reste nomme comme tel.
    assert.ok(io.text().includes('READY  historique  Premier'));
    assert.ok(io.text().includes('READY  historique  Second'));
  } finally {
    await cleanup();
  }
});

test('send exige un destinataire valide', async () => {
  const { deps, preflight, cleanup } = await testDeps();
  try {
    // Un run doit exister : la génération est établie **avant** que la cible
    // ne soit interprétée, puisque le même mot n'y a pas le même sens.
    await startRun(deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: 'E:/prog/exemple', prompt: 'p' });
    const io = capture();
    assert.equal(await runCli(['send', 'gemini', 'bonjour'], { deps, io }), 2);
    assert.ok(io.errorText().includes('claude'));
  } finally {
    await cleanup();
  }
});

test('send transmet le message et affiche la réponse avec sa provenance', async () => {
  const { deps, preflight, cleanup } = await testDeps();
  try {
    await startRun(deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: 'E:/prog/exemple', prompt: 'p' });

    const io = capture();
    assert.equal(await runCli(['send', 'claude', 'précision'], { deps, io }), 0);

    const text = io.text();
    assert.ok(text.includes('--- CLAUDE (claude-uuid-1) ---'));
    assert.ok(text.includes('claude:précision'));
    assert.ok(text.includes('état READY, contrôle AUTOMATION'));
  } finally {
    await cleanup();
  }
});

test('une erreur CCR sort en 1 avec son code', async () => {
  const { deps, preflight, cleanup } = await testDeps();
  try {
    const io = capture();
    assert.equal(await runCli(['status'], { deps, io }), 1);
    assert.ok(io.errorText().includes('[NO_ACTIVE_RUN]'));
  } finally {
    await cleanup();
  }
});
