/**
 * Tests black-box de `ccr doctor` au niveau de la CLI (lot V1.1-5).
 *
 * Vérifient l'analyse des arguments, les codes de sortie et l'absence de toute
 * interaction. Aucune de ces exécutions ne touche la configuration réelle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { runCli } from '../../src/cli/main.ts';
import type { CliIo } from '../../src/cli/main.ts';
import type { DoctorDeps } from '../../src/services/doctor-service.ts';
import { CONFIG_FILE_NAME, defaultConfigPath } from '../../src/config/config-store.ts';
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

interface Harness {
  readonly dir: string;
  readonly io: Capture;
  doctor(over?: Partial<DoctorDeps>): DoctorDeps;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await makeTempDir('ccr-cli-doctor-');
  const io = capture();
  return {
    dir,
    io,
    doctor(over: Partial<DoctorDeps> = {}): DoctorDeps {
      return {
        configPath: path.join(dir, CONFIG_FILE_NAME),
        env: {},
        home: dir,
        probes: {
          claude: async () => probeOf('claude'),
          codex: async () => probeOf('codex'),
        },
        ...over,
      };
    },
    cleanup: () => removeTempDir(dir),
  };
}

test('l\'usage annonce la commande doctor', async () => {
  const io = capture();
  assert.equal(await runCli(['--help'], { io }), 0);
  assert.match(io.text(), /ccr doctor/);
});

test('un diagnostic sain sort en 0', async () => {
  const box = await harness();
  try {
    const code = await runCli(['doctor'], { io: box.io, doctor: box.doctor() });

    assert.equal(code, 0);
    assert.match(box.io.text(), /Statut : READY/);
    assert.deepEqual(await readdir(box.dir), [], 'aucun fichier créé');
  } finally {
    await box.cleanup();
  }
});

test('une attention sort en 0 : un signalement n\'est pas un échec', async () => {
  const box = await harness();
  try {
    const code = await runCli(['doctor'], {
      io: box.io,
      doctor: box.doctor({
        probes: {
          claude: async () => probeOf('claude', { authStatus: 'UNKNOWN' }),
          codex: async () => probeOf('codex', { authStatus: 'UNAUTHENTICATED' }),
        },
      }),
    });

    assert.equal(code, 0);
    assert.match(box.io.text(), /Statut : ATTENTION/);
    assert.match(box.io.text(), /CLAUDE_AUTH_UNKNOWN/);
    assert.match(box.io.text(), /CODEX_AUTH_NOT_REPORTED/);
  } finally {
    await box.cleanup();
  }
});

test('un blocage sort en 1', async () => {
  const box = await harness();
  try {
    const code = await runCli(['doctor'], {
      io: box.io,
      doctor: box.doctor({
        probes: {
          claude: async () => ({
            agent: 'claude',
            installed: false,
            version: null,
            authStatus: 'UNKNOWN',
            diagnostic: 'CLI_NOT_FOUND',
            launcherSource: null,
          }),
          codex: async () => probeOf('codex'),
        },
      }),
    });

    assert.equal(code, 1);
    assert.match(box.io.text(), /Statut : BLOCKED/);
    assert.match(box.io.text(), /CLAUDE_CLI_MISSING/);
  } finally {
    await box.cleanup();
  }
});

test('`ccr doctor` refuse plus d\'un identifiant de run', async () => {
  const box = await harness();
  try {
    const code = await runCli(['doctor', 'CCR-1', 'CCR-2'], { io: box.io, doctor: box.doctor() });

    assert.equal(code, 2);
    assert.match(box.io.errorText(), /au plus un identifiant/);
  } finally {
    await box.cleanup();
  }
});

test('`ccr doctor <run_id>` sur un run inexistant echoue explicitement', async () => {
  const box = await harness();
  try {
    const code = await runCli(['doctor', 'CCR-20260101-001'], {
      io: box.io,
      doctor: box.doctor({ runsDir: box.dir }),
    });

    assert.equal(code, 1);
    assert.match(box.io.errorText(), /RUN_NOT_FOUND/);
  } finally {
    await box.cleanup();
  }
});

test('une option inconnue est refusée', async () => {
  const box = await harness();
  try {
    assert.equal(await runCli(['doctor', '--fix'], { io: box.io, doctor: box.doctor() }), 2);
    assert.match(box.io.errorText(), /Option inconnue/);
  } finally {
    await box.cleanup();
  }
});

test('aucune exécution CLI de doctor ne touche la configuration réelle', async () => {
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

  const box = await harness();
  try {
    await runCli(['doctor'], { io: box.io, doctor: box.doctor() });

    assert.deepEqual([await describe(path.dirname(real)), await describe(real)], before);
  } finally {
    await box.cleanup();
  }
});
