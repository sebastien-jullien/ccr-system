/**
 * Tests unitaires des probes runtime (lot V1.1-2, spécification V1.1 §7.1,
 * §8, §9, §10).
 *
 * Ces tests exercent de **vrais sous-processus** pilotés par des fixtures qui
 * reproduisent les contrats observés sur les CLI réelles. Ils prouvent le
 * classement des observations et la sanitisation ; ils ne prouvent pas le
 * comportement fournisseur — c'est le rôle de
 * `tests/integration/runtime-probes.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeClaudeRuntime, resolveLauncher as claudeProbeResolver } from '../../src/runtime/claude-runtime-probe.ts';
import { interpretClaudeAuth, readLoggedInStatement } from '../../src/runtime/claude-runtime-probe.ts';
import { probeCodexRuntime, resolveLauncher as codexProbeResolver } from '../../src/runtime/codex-runtime-probe.ts';
import { extractVersion } from '../../src/runtime/agent-runtime-probe.ts';
import type { AgentRuntimeProbe, RuntimeProbeOptions } from '../../src/runtime/agent-runtime-probe.ts';
import { resolveClaudeLauncher } from '../../src/adapters/claude-adapter.ts';
import { resolveCodexLauncher } from '../../src/adapters/codex-adapter.ts';
import type { AgentLauncher } from '../../src/adapters/agent-adapter.ts';
import { findDirectExecutable } from '../../src/process/which.ts';
import { defaultConfigPath } from '../../src/config/config-store.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const CLAUDE_FIXTURE = fileURLToPath(new URL('../fixtures/fake-claude-runtime.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('../fixtures/fake-codex-runtime.mjs', import.meta.url));

function fixtureLauncher(fixture: string): AgentLauncher {
  return { executable: process.execPath, prefixArgs: [fixture], source: 'test-fixture' };
}

interface Harness {
  readonly probe: AgentRuntimeProbe;
  readonly argsFile: string;
  readonly dir: string;
  cleanup(): Promise<void>;
}

async function runProbe(
  agent: 'claude' | 'codex',
  mode: string,
  extra: Partial<RuntimeProbeOptions> = {},
): Promise<Harness> {
  const dir = await makeTempDir(`ccr-probe-${agent}-`);
  const argsFile = path.join(dir, 'args.jsonl');
  const fixture = agent === 'claude' ? CLAUDE_FIXTURE : CODEX_FIXTURE;
  const env =
    agent === 'claude'
      ? { ...process.env, FAKE_CLAUDE_RUNTIME_MODE: mode, FAKE_CLAUDE_RUNTIME_ARGS_FILE: argsFile }
      : { ...process.env, FAKE_CODEX_RUNTIME_MODE: mode, FAKE_CODEX_RUNTIME_ARGS_FILE: argsFile };

  const options: RuntimeProbeOptions = {
    cwd: dir,
    timeoutMs: 20_000,
    launcher: fixtureLauncher(fixture),
    env,
    ...extra,
  };

  const probe = agent === 'claude' ? await probeClaudeRuntime(options) : await probeCodexRuntime(options);
  return { probe, argsFile, dir, cleanup: () => removeTempDir(dir) };
}

/** Exécute `fn` avec un `PATH` synthétique, restauré en toutes circonstances. */
async function withPath<T>(dirs: readonly string[], fn: () => Promise<T>): Promise<T> {
  const previous = process.env['PATH'];
  process.env['PATH'] = dirs.join(path.delimiter);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
}

/** Exécutable directement lançable par `spawn` sur cette plateforme. */
async function writeDirectExecutable(dir: string, name: string): Promise<string> {
  const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  await writeFile(file, '', 'utf8');
  if (process.platform !== 'win32') await chmod(file, 0o755);
  return file;
}

/** Installation npm : un shim non lançable + le point d'entrée officiel. */
async function writeNpmShimLayout(
  dir: string,
  name: string,
  entryRelative: string,
  versionLine: string,
): Promise<string> {
  await writeFile(path.join(dir, `${name}.cmd`), '@echo off\r\n', 'utf8');
  const entry = path.join(dir, entryRelative);
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(
    entry,
    `if (process.argv.includes('--version')) { process.stdout.write(${JSON.stringify(versionLine)} + '\\n'); }\n` +
      `else { process.stderr.write('Not logged in\\n'); process.exitCode = 1; }\n`,
    'utf8',
  );
  return entry;
}

const CODEX_NPM_ENTRY = path.join('node_modules', '@openai', 'codex', 'bin', 'codex.js');
const CLAUDE_NPM_ENTRY = path.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

// --------------------------------------------------------------------------
// Résolution partagée (§7.1)
// --------------------------------------------------------------------------

test('(5) le probe et l\'adapter partagent la même primitive de résolution', () => {
  // Égalité de référence : une réimplémentation locale, même correcte, la
  // romprait. C'est la garantie structurelle qu'aucune divergence ne peut
  // s'installer entre ce que CCR sonde et ce que CCR lance.
  assert.equal(claudeProbeResolver, resolveClaudeLauncher);
  assert.equal(codexProbeResolver, resolveCodexLauncher);
});

test('(1/2) un exécutable direct est résolu depuis le PATH', async () => {
  const dir = await makeTempDir('ccr-resolver-direct-');
  try {
    const claude = await writeDirectExecutable(dir, 'claude');
    const codex = await writeDirectExecutable(dir, 'codex');

    await withPath([dir], async () => {
      const claudeLauncher = resolveClaudeLauncher();
      assert.equal(claudeLauncher.executable, claude);
      assert.deepEqual(claudeLauncher.prefixArgs, []);
      assert.equal(claudeLauncher.source, 'path');

      const codexLauncher = resolveCodexLauncher();
      assert.equal(codexLauncher.executable, codex);
      assert.equal(codexLauncher.source, 'path');
    });
  } finally {
    await removeTempDir(dir);
  }
});

test('(3) une installation npm sans exécutable direct reste détectée et lançable', async () => {
  const dir = await makeTempDir('ccr-resolver-shim-');
  try {
    const codexEntry = await writeNpmShimLayout(dir, 'codex', CODEX_NPM_ENTRY, 'codex-cli 9.9.9');
    const claudeEntry = await writeNpmShimLayout(dir, 'claude', CLAUDE_NPM_ENTRY, '9.9.9 (Claude Code)');

    await withPath([dir], async () => {
      // Le défaut visé : une résolution naïve ne trouve rien de lançable.
      assert.equal(findDirectExecutable('codex', [dir]), undefined, 'aucun exécutable direct');
      assert.equal(findDirectExecutable('claude', [dir]), undefined);

      const codexLauncher = resolveCodexLauncher();
      assert.equal(codexLauncher.executable, process.execPath);
      assert.deepEqual(codexLauncher.prefixArgs, [codexEntry]);
      assert.equal(codexLauncher.source, 'npm-shim');

      const claudeLauncher = resolveClaudeLauncher();
      assert.deepEqual(claudeLauncher.prefixArgs, [claudeEntry]);
      assert.equal(claudeLauncher.source, 'npm-shim');

      // …et le probe fonctionne réellement à travers ce chemin.
      const codexProbe = await probeCodexRuntime({ cwd: dir, timeoutMs: 20_000 });
      assert.equal(codexProbe.installed, true);
      assert.equal(codexProbe.version, '9.9.9');
      assert.equal(codexProbe.launcherSource, 'npm-shim');
      assert.equal(codexProbe.authStatus, 'UNAUTHENTICATED');

      const claudeProbe = await probeClaudeRuntime({ cwd: dir, timeoutMs: 20_000 });
      assert.equal(claudeProbe.installed, true);
      assert.equal(claudeProbe.version, '9.9.9');
      assert.equal(claudeProbe.launcherSource, 'npm-shim');
    });
  } finally {
    await removeTempDir(dir);
  }
});

test('(4/7/17) une CLI introuvable est rapportée sans conclure sur l\'authentification', async () => {
  const dir = await makeTempDir('ccr-resolver-absent-');
  try {
    await withPath([dir], async () => {
      for (const probe of [
        await probeClaudeRuntime({ cwd: dir, timeoutMs: 20_000 }),
        await probeCodexRuntime({ cwd: dir, timeoutMs: 20_000 }),
      ]) {
        assert.equal(probe.installed, false);
        assert.equal(probe.version, null);
        // Absente n'est pas déconnectée : on ne sait rien.
        assert.equal(probe.authStatus, 'UNKNOWN');
        assert.equal(probe.diagnostic, 'CLI_NOT_FOUND');
        assert.equal(probe.launcherSource, null);
      }
    });
  } finally {
    await removeTempDir(dir);
  }
});

test('(4) un lanceur résolu mais non lançable est rapporté CLI_NOT_FOUND', async () => {
  const dir = await makeTempDir('ccr-resolver-ghost-');
  try {
    const ghost: AgentLauncher = { executable: path.join(dir, 'disparu.exe'), prefixArgs: [], source: 'explicit' };
    const probe = await probeCodexRuntime({ cwd: dir, timeoutMs: 20_000, launcher: ghost });

    assert.equal(probe.installed, false);
    assert.equal(probe.diagnostic, 'CLI_NOT_FOUND');
    assert.equal(probe.authStatus, 'UNKNOWN');
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Extraction de version
// --------------------------------------------------------------------------

test('(6/16) la version est extraite des formats réels des deux CLI', () => {
  assert.equal(extractVersion('2.1.224 (Claude Code)\n', ''), '2.1.224');
  assert.equal(extractVersion('codex-cli 0.146.0\n', ''), '0.146.0');
  assert.equal(extractVersion('', 'codex-cli 0.146.0-beta.1\n'), '0.146.0-beta.1');
  assert.equal(extractVersion('aucune version ici', ''), null);
});

// --------------------------------------------------------------------------
// Claude — version
// --------------------------------------------------------------------------

test('(6/10) Claude installé et connecté est rapporté complet', async () => {
  const harness = await runProbe('claude', 'ok');
  try {
    assert.deepEqual(harness.probe, {
      agent: 'claude',
      installed: true,
      version: '2.1.224',
      authStatus: 'AUTHENTICATED',
      launcherSource: 'test-fixture',
    });
  } finally {
    await harness.cleanup();
  }
});

test('(8) une commande de version en échec n\'empêche pas de conclure sur l\'auth', async () => {
  const harness = await runProbe('claude', 'version-fail');
  try {
    // `installed` ne dépend ni de la version, ni de l'authentification.
    assert.equal(harness.probe.installed, true);
    assert.equal(harness.probe.version, null);
    assert.equal(harness.probe.authStatus, 'AUTHENTICATED');
    assert.equal(harness.probe.diagnostic, 'VERSION_COMMAND_FAILED');
  } finally {
    await harness.cleanup();
  }
});

test('(9) une sortie de version non reconnue est signalée sans être inventée', async () => {
  const harness = await runProbe('claude', 'version-unknown');
  try {
    assert.equal(harness.probe.installed, true);
    assert.equal(harness.probe.version, null);
    assert.equal(harness.probe.diagnostic, 'VERSION_UNRECOGNIZED');
  } finally {
    await harness.cleanup();
  }
});

// --------------------------------------------------------------------------
// Claude — authentification
// --------------------------------------------------------------------------

test('(11) un état explicitement déconnecté est rapporté UNAUTHENTICATED', async () => {
  for (const mode of ['logged-out', 'logged-out-exit1']) {
    const harness = await runProbe('claude', mode);
    try {
      assert.equal(harness.probe.authStatus, 'UNAUTHENTICATED', mode);
      assert.equal(harness.probe.installed, true, mode);
      assert.equal(harness.probe.diagnostic, undefined, mode);
    } finally {
      await harness.cleanup();
    }
  }
});

test('(12) un échec inattendu reste UNKNOWN', async () => {
  const harness = await runProbe('claude', 'unexpected-failure');
  try {
    assert.equal(harness.probe.authStatus, 'UNKNOWN');
    assert.equal(harness.probe.diagnostic, 'AUTH_STATUS_COMMAND_FAILED');
  } finally {
    await harness.cleanup();
  }
});

test('(13) une sortie inconnue reste UNKNOWN, jamais UNAUTHENTICATED', async () => {
  for (const mode of ['unrecognized-output', 'unknown-command']) {
    const harness = await runProbe('claude', mode);
    try {
      // `unknown-command` sort en 1 : sans énoncé explicite, CCR ne conclut
      // pas à une déconnexion qu'une reconnexion ne réparerait pas.
      assert.equal(harness.probe.authStatus, 'UNKNOWN', mode);
      assert.equal(harness.probe.diagnostic, 'AUTH_STATUS_UNRECOGNIZED', mode);
    } finally {
      await harness.cleanup();
    }
  }
});

test('un énoncé positif contredit par le code de sortie n\'est jamais optimiste', async () => {
  const harness = await runProbe('claude', 'contradiction');
  try {
    assert.equal(harness.probe.authStatus, 'UNKNOWN');
    assert.equal(harness.probe.diagnostic, 'AUTH_STATUS_COMMAND_FAILED');
  } finally {
    await harness.cleanup();
  }
});

test('l\'énoncé est reconnu quel que soit le flux qui le porte', async () => {
  const harness = await runProbe('claude', 'auth-on-stderr');
  try {
    assert.equal(harness.probe.authStatus, 'AUTHENTICATED');
  } finally {
    await harness.cleanup();
  }
});

test('(14) un timeout de probe Claude ne devient jamais UNAUTHENTICATED', async () => {
  const harness = await runProbe('claude', 'auth-hang', { timeoutMs: 400 });
  try {
    assert.equal(harness.probe.authStatus, 'UNKNOWN');
    assert.equal(harness.probe.diagnostic, 'AUTH_STATUS_COMMAND_FAILED');
    assert.equal(harness.probe.installed, true);
  } finally {
    await harness.cleanup();
  }
});

test('(15) aucune donnée personnelle de la sortie Claude ne survit à la normalisation', async () => {
  const pii = [
    'temoin.pii@exemple-ccr.test',
    '9b68f0df',
    'Organisation temoin PII',
    'subscriptionType',
    'claude.ai',
    'firstParty',
    'internal error',
  ];

  // Chemin nominal — la sortie réelle de `claude auth status` porte ces
  // données — et chemin d'échec, où un diagnostic recopié fuiterait.
  for (const mode of ['ok', 'unexpected-failure']) {
    const harness = await runProbe('claude', mode);
    try {
      const serialized = JSON.stringify(harness.probe);
      for (const secret of pii) {
        assert.ok(!serialized.includes(secret), `fuite (${mode}) : ${secret} dans ${serialized}`);
      }
      // Le résultat ne porte que des champs fermés.
      const keys = Object.keys(harness.probe).sort().join(',');
      assert.ok(
        keys === 'agent,authStatus,installed,launcherSource,version' ||
          keys === 'agent,authStatus,diagnostic,installed,launcherSource,version',
        `champs inattendus : ${keys}`,
      );
    } finally {
      await harness.cleanup();
    }
  }
});

test('readLoggedInStatement ne retient que le booléen', () => {
  assert.equal(readLoggedInStatement('{"loggedIn":true,"email":"a@b.c"}', ''), true);
  assert.equal(readLoggedInStatement('{"loggedIn":false}', ''), false);
  assert.equal(readLoggedInStatement('{"loggedIn":"true"}', ''), undefined, 'aucune coercition');
  assert.equal(readLoggedInStatement('texte libre', ''), undefined);
  assert.equal(readLoggedInStatement('', '{"loggedIn":true}'), true);
  // Les flux ne sont jamais fusionnés : un JSON coupé en deux ne se recolle pas.
  assert.equal(readLoggedInStatement('{"loggedIn"', ':true}'), undefined);
});

test('la table Claude est appliquée telle qu\'elle est documentée', () => {
  const base = { launchFailed: false, timedOut: false, stdout: '', stderr: '' };
  const cases: readonly [number | null, string, string][] = [
    [0, '{"loggedIn":true}', 'AUTHENTICATED'],
    [0, '{"loggedIn":false}', 'UNAUTHENTICATED'],
    [1, '{"loggedIn":false}', 'UNAUTHENTICATED'],
    [1, '', 'UNKNOWN'],
    [0, 'sortie inconnue', 'UNKNOWN'],
    [7, '{"loggedIn":true}', 'UNKNOWN'],
    [null, '', 'UNKNOWN'],
  ];
  for (const [exitCode, stdout, expected] of cases) {
    assert.equal(
      interpretClaudeAuth({ ...base, exitCode, stdout }).authStatus,
      expected,
      `exit=${String(exitCode)} stdout=${stdout}`,
    );
  }
});

// --------------------------------------------------------------------------
// Codex — version et authentification
// --------------------------------------------------------------------------

test('(16/20/26) Codex connecté est reconnu alors que stdout est vide', async () => {
  const harness = await runProbe('codex', 'ok');
  try {
    // Cas réel : tout le message part sur stderr, exit 0.
    assert.deepEqual(harness.probe, {
      agent: 'codex',
      installed: true,
      version: '0.146.0',
      authStatus: 'AUTHENTICATED',
      launcherSource: 'test-fixture',
    });
  } finally {
    await harness.cleanup();
  }
});

test('(18/19) les échecs de version Codex sont distingués', async () => {
  const failed = await runProbe('codex', 'version-fail');
  try {
    assert.equal(failed.probe.installed, true);
    assert.equal(failed.probe.version, null);
    assert.equal(failed.probe.diagnostic, 'VERSION_COMMAND_FAILED');
  } finally {
    await failed.cleanup();
  }

  const unknown = await runProbe('codex', 'version-unknown');
  try {
    assert.equal(unknown.probe.version, null);
    assert.equal(unknown.probe.diagnostic, 'VERSION_UNRECOGNIZED');
  } finally {
    await unknown.cleanup();
  }
});

test('(21/22) le marqueur explicite est reconnu sur stderr comme sur stdout', async () => {
  for (const mode of ['logged-out-stderr', 'logged-out-stdout']) {
    const harness = await runProbe('codex', mode);
    try {
      assert.equal(harness.probe.authStatus, 'UNAUTHENTICATED', mode);
      assert.equal(harness.probe.diagnostic, undefined, mode);
      assert.equal(harness.probe.installed, true, mode);
    } finally {
      await harness.cleanup();
    }
  }
});

test('(23) un exit 1 sans marqueur reste UNKNOWN', async () => {
  const harness = await runProbe('codex', 'exit1-plain');
  try {
    assert.equal(harness.probe.authStatus, 'UNKNOWN');
    assert.equal(harness.probe.diagnostic, 'AUTH_STATUS_UNRECOGNIZED');
  } finally {
    await harness.cleanup();
  }
});

test('(24) une erreur de configuration en exit 1 est UNKNOWN, jamais UNAUTHENTICATED', async () => {
  const harness = await runProbe('codex', 'config-error');
  try {
    // Proposer une reconnexion ne réparerait pas un config.toml invalide.
    assert.equal(harness.probe.authStatus, 'UNKNOWN');
    assert.equal(harness.probe.diagnostic, 'PROVIDER_CONFIG_ERROR');
  } finally {
    await harness.cleanup();
  }
});

test('(28) un autre code de sortie reste UNKNOWN', async () => {
  const harness = await runProbe('codex', 'unexpected-failure');
  try {
    assert.equal(harness.probe.authStatus, 'UNKNOWN');
    assert.equal(harness.probe.diagnostic, 'AUTH_STATUS_COMMAND_FAILED');
  } finally {
    await harness.cleanup();
  }
});

test('(25) un timeout de probe Codex ne devient jamais UNAUTHENTICATED', async () => {
  const harness = await runProbe('codex', 'login-hang', { timeoutMs: 400 });
  try {
    assert.equal(harness.probe.authStatus, 'UNKNOWN');
    assert.equal(harness.probe.diagnostic, 'AUTH_STATUS_COMMAND_FAILED');
  } finally {
    await harness.cleanup();
  }
});

test('(27) aucune donnée personnelle de la sortie Codex ne survit à la normalisation', async () => {
  // Deux chemins : le succès, et l'échec — c'est sur ce dernier qu'un
  // diagnostic recopié serait le plus tentant.
  const cases: readonly [string, string][] = [
    ['authenticated-with-pii', 'AUTHENTICATED'],
    ['exit1-plain', 'UNKNOWN'],
  ];

  for (const [mode, expected] of cases) {
    const harness = await runProbe('codex', mode);
    try {
      const serialized = JSON.stringify(harness.probe);
      for (const pii of ['temoin.pii@exemple-ccr.test', 'org_TEMOIN_PII', 'ChatGPT', 'unexpected failure']) {
        assert.ok(!serialized.includes(pii), `fuite (${mode}) : ${pii} dans ${serialized}`);
      }
      assert.equal(harness.probe.authStatus, expected, mode);
    } finally {
      await harness.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Absence d'effet de bord (§16.1, §23)
// --------------------------------------------------------------------------

test('(31) un probe n\'invoque que version et statut, jamais un login', async () => {
  const claude = await runProbe('claude', 'ok');
  try {
    const lines = (await readFile(claude.argsFile, 'utf8')).trim().split(/\r?\n/);
    assert.deepEqual(
      lines.map((line) => JSON.parse(line) as string[]),
      [['--version'], ['auth', 'status']],
    );
  } finally {
    await claude.cleanup();
  }

  const codex = await runProbe('codex', 'ok');
  try {
    const lines = (await readFile(codex.argsFile, 'utf8')).trim().split(/\r?\n/);
    assert.deepEqual(
      lines.map((line) => JSON.parse(line) as string[]),
      [['--version'], ['login', 'status']],
    );
    // `codex login` seul lancerait un flow d'authentification.
    for (const line of lines) {
      assert.ok(!/^\["login"\]$/.test(line), 'aucune commande de login');
    }
  } finally {
    await codex.cleanup();
  }
});

test('(29/30) un probe ne crée aucun run et ne touche à aucune configuration', async () => {
  const realConfig = defaultConfigPath();
  const describe = async (target: string): Promise<string> => {
    try {
      const info = await stat(target);
      return `${String(info.size)}:${String(info.mtimeMs)}`;
    } catch (error) {
      return `absent:${(error as NodeJS.ErrnoException).code ?? '?'}`;
    }
  };
  const before = [await describe(path.dirname(realConfig)), await describe(realConfig)];

  const dir = await makeTempDir('ccr-probe-purity-');
  try {
    const launcherClaude = fixtureLauncher(CLAUDE_FIXTURE);
    const launcherCodex = fixtureLauncher(CODEX_FIXTURE);
    await probeClaudeRuntime({ cwd: dir, timeoutMs: 20_000, launcher: launcherClaude });
    await probeCodexRuntime({ cwd: dir, timeoutMs: 20_000, launcher: launcherCodex });

    // Aucun manifest, aucun state, aucun événement, aucun verrou.
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(dir), [], 'le répertoire de travail reste vide');

    const after = [await describe(path.dirname(realConfig)), await describe(realConfig)];
    assert.deepEqual(after, before, 'la configuration réelle est intacte');
  } finally {
    await removeTempDir(dir);
  }
});

test('(32) le code des probes ne lit aucun magasin de credentials', async () => {
  const sources = await Promise.all(
    ['agent-runtime-probe.ts', 'claude-runtime-probe.ts', 'codex-runtime-probe.ts'].map((name) =>
      readFile(fileURLToPath(new URL(`../../src/runtime/${name}`, import.meta.url)), 'utf8'),
    ),
  );

  // Interdits partout, y compris en commentaire : leur seule mention
  // suggérerait que CCR s'intéresse au contenu d'un magasin de credentials.
  const forbiddenAnywhere = [
    /ANTHROPIC_API_KEY/,
    /ANTHROPIC_AUTH_TOKEN/,
    /CLAUDE_CODE_OAUTH_TOKEN/,
    /OPENAI_API_KEY/,
    /access_token/,
    /refresh_token/,
    /auth\.json/,
    /credentials\.json/,
    /keychain/i,
  ];

  // Interdits dans le **code** seulement : la documentation a le droit
  // d'expliquer pourquoi ils sont proscrits.
  const forbiddenInCode = [
    /shell:\s*true/,
    // Attacher un terminal serait un login, pas une observation.
    /runInteractiveProcess/,
  ];

  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const source of sources) {
    for (const pattern of forbiddenAnywhere) {
      assert.ok(!pattern.test(source), `motif interdit : ${pattern.source}`);
    }
    for (const pattern of forbiddenInCode) {
      assert.ok(!pattern.test(stripComments(source)), `motif interdit dans le code : ${pattern.source}`);
    }
  }
});
