/**
 * Tests black-box de `ccr setup` au niveau de la CLI (lot V1.1-4).
 *
 * Portée : analyse des arguments, câblage du service et codes de sortie.
 * Aucune de ces exécutions ne touche la configuration réelle de l'utilisateur —
 * une garde le vérifie explicitement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { runCli } from '../../src/cli/main.ts';
import type { CliIo } from '../../src/cli/main.ts';
import type { SetupDeps, SetupIo } from '../../src/services/setup-service.ts';
import { CONFIG_FILE_NAME, defaultConfigPath, readConfig } from '../../src/config/config-store.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { AgentKind } from '../../src/core/run.ts';
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

function probeOf(agent: AgentKind, authStatus: AgentRuntimeProbe['authStatus']): AgentRuntimeProbe {
  return {
    agent,
    installed: true,
    version: agent === 'claude' ? '2.1.224' : '0.146.0',
    authStatus,
    launcherSource: 'path',
  };
}

interface CliHarness {
  readonly dir: string;
  readonly configPath: string;
  readonly io: Capture;
  readonly questions: string[];
  setup(over?: Partial<SetupDeps>): Partial<SetupDeps>;
  cleanup(): Promise<void>;
}

async function cliHarness(answers: readonly boolean[] = []): Promise<CliHarness> {
  const dir = await makeTempDir('ccr-cli-setup-');
  const configPath = path.join(dir, CONFIG_FILE_NAME);
  const io = capture();
  const questions: string[] = [];
  const queue = [...answers];

  const setupIo: SetupIo = {
    out: io.out,
    async confirm(question: string): Promise<boolean> {
      questions.push(question);
      return queue.shift() ?? false;
    },
  };

  return {
    dir,
    configPath,
    io,
    questions,
    setup(over: Partial<SetupDeps> = {}): Partial<SetupDeps> {
      return {
        io: setupIo,
        tty: { stdin: true, stdout: true },
        configPath,
        env: {},
        probes: {
          claude: async () => probeOf('claude', 'AUTHENTICATED'),
          codex: async () => probeOf('codex', 'AUTHENTICATED'),
        },
        ...over,
      };
    },
    cleanup: () => removeTempDir(dir),
  };
}

test('l\'usage annonce la commande setup', async () => {
  const io = capture();
  assert.equal(await runCli(['--help'], { io }), 0);
  assert.match(io.text(), /ccr setup/);
});

test('un setup complet sort en 0 et écrit la configuration', async () => {
  const box = await cliHarness([true]);
  try {
    const code = await runCli(['setup'], { io: box.io, setup: box.setup() });

    assert.equal(code, 0);
    assert.equal((await readConfig({ configPath: box.configPath })).config.codex.skip_git_repo_check, true);
    assert.match(box.io.text(), /Setup terminé\./);
  } finally {
    await box.cleanup();
  }
});

test('un setup incomplet sort en 1 sans prétendre à la réussite', async () => {
  const box = await cliHarness([false, false]);
  try {
    const code = await runCli(['setup'], {
      io: box.io,
      setup: box.setup({
        probes: {
          claude: async () => probeOf('claude', 'UNAUTHENTICATED'),
          codex: async () => probeOf('codex', 'AUTHENTICATED'),
        },
      }),
    });

    assert.equal(code, 1);
    assert.match(box.io.text(), /incomplète/);
    assert.match(box.io.text(), /CLAUDE_UNAUTHENTICATED/);
    // La préférence locale est tout de même enregistrée.
    assert.equal((await readConfig({ configPath: box.configPath })).config.codex.skip_git_repo_check, false);
  } finally {
    await box.cleanup();
  }
});

test('sans terminal, setup sort en 2 sans rien modifier', async () => {
  const box = await cliHarness();
  try {
    const code = await runCli(['setup'], {
      io: box.io,
      setup: box.setup({ tty: { stdin: false, stdout: true } }),
    });

    assert.equal(code, 2, 'contexte inadapté, pas erreur de traitement');
    assert.match(box.io.errorText(), /INTERACTIVE_TTY_REQUIRED/);
    assert.deepEqual(box.questions, [], 'aucune invite');
    assert.deepEqual(await readdir(box.dir), [], 'aucune configuration créée');
  } finally {
    await box.cleanup();
  }
});

test('`ccr setup --run` sans identifiant reste un usage invalide', async () => {
  const box = await cliHarness();
  try {
    const code = await runCli(['setup', '--run'], { io: box.io, setup: box.setup() });

    assert.equal(code, 2);
    assert.match(box.io.errorText(), /attend une valeur|identifiant de run/);
    assert.deepEqual(await readdir(box.dir), [], 'aucun effet');
  } finally {
    await box.cleanup();
  }
});

test('`ccr setup` refuse un argument positionnel', async () => {
  const box = await cliHarness();
  try {
    assert.equal(await runCli(['setup', 'CCR-20260401-001'], { io: box.io, setup: box.setup() }), 2);
    assert.match(box.io.errorText(), /argument positionnel/);
  } finally {
    await box.cleanup();
  }
});

test('une option inconnue de setup est refusée', async () => {
  const box = await cliHarness();
  try {
    const code = await runCli(['setup', '--force'], { io: box.io, setup: box.setup() });

    assert.equal(code, 2);
    assert.match(box.io.errorText(), /Option inconnue/);
  } finally {
    await box.cleanup();
  }
});

test('aucune exécution CLI de setup ne touche la configuration réelle', async () => {
  const real = defaultConfigPath();
  const describe = async (target: string): Promise<string> => {
    try {
      const info = await stat(target);
      return `${String(info.size)}:${String(info.mtimeMs)}`;
    } catch (error) {
      return `absent:${(error as NodeJS.ErrnoException).code ?? '?'}`;
    }
  };
  const before = [await describe(path.dirname(real)), await describe(real)];

  const box = await cliHarness([true]);
  try {
    await runCli(['setup'], { io: box.io, setup: box.setup() });

    const after = [await describe(path.dirname(real)), await describe(real)];
    assert.deepEqual(after, before, `${real} doit rester inchangé`);
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// `ccr setup --run <run_id>` (lot V1.1-7, §15.7)
// --------------------------------------------------------------------------

async function pinnedRun(runsDir: string, cwd: string, skip: boolean): Promise<string> {
  const { startRun, pauseRun } = await import('../../src/services/run-service.ts');
  const { createFakeAdapter } = await import('../helpers/fake-adapter.ts');
  const adapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
  };
  const deps = { runsDir, now: () => new Date(), createAdapters: () => adapters };
  const result = await startRun(deps, {
    title: 'T',
    cwd,
    prompt: 'p',
    runtimeConfig: {
      schema_version: 1,
      captured_at: '2026-08-08T03:00:00.000Z',
      claude: { cli_version: '2.1.224', auth_preflight: 'AUTHENTICATED' },
      codex: {
        cli_version: '0.146.0',
        auth_preflight: 'AUTHENTICATED',
        skip_git_repo_check: skip,
        source_at_capture: 'config' as const,
      },
    },
  });
  await pauseRun(deps, { runId: result.runId });
  return result.runId;
}

test('(30) un simple Enter ne modifie jamais la configuration du run', async () => {
  const box = await cliHarness();
  try {
    const { mkdir } = await import('node:fs/promises');
    const runsDir = path.join(box.dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const runId = await pinnedRun(runsDir, box.dir, true);

    // File de réponses vide : chaque invite reçoit l'équivalent d'un Enter.
    const code = await runCli(['setup', '--run', runId, '--runs-dir', runsDir], {
      io: box.io,
      setup: box.setup(),
    });

    assert.equal(code, 0);
    assert.match(box.io.text(), /Aucune modification\./);
    const { loadRun } = await import('../../src/store/state-store.ts');
    assert.equal(
      (await loadRun(runsDir, runId)).manifest.runtime_config?.codex.skip_git_repo_check,
      true,
      'valeur inchangée',
    );
  } finally {
    await box.cleanup();
  }
});

test('(31/32) la question porte sur le changement, jamais sur un état par défaut', async () => {
  for (const initial of [true, false]) {
    const box = await cliHarness([true]);
    try {
      const { mkdir } = await import('node:fs/promises');
      const runsDir = path.join(box.dir, 'runs');
      await mkdir(runsDir, { recursive: true });
      const runId = await pinnedRun(runsDir, box.dir, initial);

      const code = await runCli(['setup', '--run', runId, '--runs-dir', runsDir], {
        io: box.io,
        setup: box.setup(),
      });

      assert.equal(code, 0);
      // Formulation orientée vers l'acte, pour qu'un défaut NON ne bascule rien.
      assert.match(
        box.questions[0] ?? '',
        initial ? /Desactiver|Désactiver/ : /Activer/,
        `valeur initiale ${String(initial)}`,
      );

      const { loadRun } = await import('../../src/store/state-store.ts');
      assert.equal(
        (await loadRun(runsDir, runId)).manifest.runtime_config?.codex.skip_git_repo_check,
        !initial,
        'bascule appliquée',
      );
      assert.match(box.io.text(), /Configuration runtime modifiee|modifiée/);
    } finally {
      await box.cleanup();
    }
  }
});

test('`ccr setup --run` sans terminal ne modifie rien', async () => {
  const box = await cliHarness([true]);
  try {
    const { mkdir, readFile } = await import('node:fs/promises');
    const runsDir = path.join(box.dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const runId = await pinnedRun(runsDir, box.dir, false);
    const { runPaths } = await import('../../src/store/layout.ts');
    const before = await readFile(runPaths(runsDir, runId).manifest, 'utf8');

    const code = await runCli(['setup', '--run', runId, '--runs-dir', runsDir], {
      io: box.io,
      setup: box.setup({ tty: { stdin: false, stdout: false } }),
    });

    assert.equal(code, 2);
    assert.match(box.io.errorText(), /INTERACTIVE_TTY_REQUIRED/);
    assert.equal(await readFile(runPaths(runsDir, runId).manifest, 'utf8'), before);
  } finally {
    await box.cleanup();
  }
});
