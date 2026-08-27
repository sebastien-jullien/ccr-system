/**
 * Tests unitaires de l'orchestration de connexion (lot V1.1-3, spécification
 * V1.1 §8.2, §9.3, §15.5, §19, §23.3).
 *
 * Ces tests exercent de vrais sous-processus. Ils prouvent le contrat de la
 * couche — consentement, terminal, commandes, re-probe, absence de capture —
 * mais **pas** le comportement d'un vrai flow de connexion fournisseur, qui
 * relève de IT-11.1-08 et d'une action humaine explicite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectTty, loginClaude, loginCodex } from '../../src/runtime/agent-login.ts';
import type { AgentLoginOptions, LoginOutcome } from '../../src/runtime/agent-login.ts';
import { resolveLauncher as claudeProbeResolver } from '../../src/runtime/claude-runtime-probe.ts';
import { resolveLauncher as codexProbeResolver } from '../../src/runtime/codex-runtime-probe.ts';
import { resolveClaudeLauncher } from '../../src/adapters/claude-adapter.ts';
import { resolveCodexLauncher } from '../../src/adapters/codex-adapter.ts';
import type { AgentLauncher } from '../../src/adapters/agent-adapter.ts';
import { defaultConfigPath } from '../../src/config/config-store.ts';
import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-login-cli.mjs', import.meta.url));

const TTY_PRESENT = { stdin: true, stdout: true } as const;

interface FixtureState {
  readonly auth: 'authenticated' | 'unauthenticated' | 'unknown';
  readonly loginExit?: number;
  readonly loginEffect?: 'authenticate' | 'unknown' | 'none';
}

interface Harness {
  readonly dir: string;
  readonly argsFile: string;
  readonly launcher: AgentLauncher;
  readonly env: NodeJS.ProcessEnv;
  options(overrides?: Partial<AgentLoginOptions>): AgentLoginOptions;
  invocations(): Promise<string[][]>;
  cleanup(): Promise<void>;
}

async function harness(agent: 'claude' | 'codex', state: FixtureState): Promise<Harness> {
  const dir = await makeTempDir(`ccr-login-${agent}-`);
  const argsFile = path.join(dir, 'args.jsonl');
  const stateFile = path.join(dir, 'state.json');
  await writeFile(stateFile, JSON.stringify(state), 'utf8');

  const env = {
    ...process.env,
    FAKE_LOGIN_AGENT: agent,
    FAKE_LOGIN_STATE_FILE: stateFile,
    FAKE_LOGIN_ARGS_FILE: argsFile,
  };
  const launcher: AgentLauncher = { executable: process.execPath, prefixArgs: [FIXTURE], source: 'test-fixture' };

  return {
    dir,
    argsFile,
    launcher,
    env,
    options(overrides: Partial<AgentLoginOptions> = {}): AgentLoginOptions {
      return {
        consentGranted: true,
        tty: TTY_PRESENT,
        cwd: dir,
        timeoutMs: 20_000,
        launcher,
        env,
        ...overrides,
      };
    },
    async invocations(): Promise<string[][]> {
      try {
        const raw = await readFile(argsFile, 'utf8');
        return raw
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
    cleanup: () => removeTempDir(dir),
  };
}

async function expectCcrError(
  promise: Promise<unknown>,
  code: CcrErrorCode,
  what: string,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isCcrError(error), `${what} : attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code, what);
    return error.details;
  }
  assert.fail(`${what} : attendu ${code}, aucune erreur levée`);
}

const login = (agent: 'claude' | 'codex', options: AgentLoginOptions): Promise<LoginOutcome> =>
  agent === 'claude' ? loginClaude(options) : loginCodex(options);

/** Invocations attendues d'un probe complet, pour chaque CLI. */
const PROBE_CALLS: Record<'claude' | 'codex', string[][]> = {
  claude: [['--version'], ['auth', 'status']],
  codex: [['--version'], ['login', 'status']],
};
const LOGIN_CALL: Record<'claude' | 'codex', string[]> = {
  claude: ['auth', 'login'],
  codex: ['login'],
};

// --------------------------------------------------------------------------
// Consentement
// --------------------------------------------------------------------------

test('(1/2/6) sans consentement explicite, aucun sous-processus n\'est lancé', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const box = await harness(agent, { auth: 'unauthenticated' });
    try {
      // `consentGranted: false` ne compile pas : le type est le littéral
      // `true`. Un appelant JavaScript pourrait néanmoins le faire.
      const refused = box.options({ consentGranted: false as unknown as true });
      await expectCcrError(login(agent, refused), 'INVALID_ARGUMENT', `${agent} consentement faux`);

      const omitted = box.options();
      delete (omitted as { consentGranted?: unknown }).consentGranted;
      await expectCcrError(login(agent, omitted), 'INVALID_ARGUMENT', `${agent} consentement absent`);

      // Ni login, ni même un probe : rien n'a été lancé.
      assert.deepEqual(await box.invocations(), [], `${agent} : aucun sous-processus`);
    } finally {
      await box.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Terminal interactif
// --------------------------------------------------------------------------

const NO_TTY = { stdin: false, stdout: false } as const;

test('(4/5/6) sans terminal, une connexion réellement nécessaire est refusée', async () => {
  const cases = [
    { stdin: false, stdout: true },
    { stdin: true, stdout: false },
    { stdin: false, stdout: false },
  ];

  for (const tty of cases) {
    for (const auth of ['unauthenticated', 'unknown'] as const) {
      const box = await harness('claude', { auth });
      try {
        const details = await expectCcrError(
          loginClaude(box.options({ tty })),
          'INTERACTIVE_TTY_REQUIRED',
          `tty=${JSON.stringify(tty)} auth=${auth}`,
        );
        assert.equal(details['stdinIsTty'], tty.stdin);
        assert.equal(details['stdoutIsTty'], tty.stdout);

        // Le probe initial a bien eu lieu — c'est lui qui établit qu'une
        // interaction est nécessaire — mais aucune connexion n'a été lancée.
        assert.deepEqual(await box.invocations(), PROBE_CALLS.claude, 'aucune commande de connexion');
      } finally {
        await box.cleanup();
      }
    }
  }
});

test('un agent déjà authentifié n\'exige aucun terminal', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const box = await harness(agent, { auth: 'authenticated' });
    try {
      // Aucune interaction n'étant nécessaire, exiger un terminal reviendrait
      // à refuser un environnement parfaitement utilisable.
      const outcome = await login(agent, box.options({ tty: NO_TTY }));

      assert.equal(outcome.status, 'ALREADY_AUTHENTICATED', agent);
      assert.deepEqual(await box.invocations(), PROBE_CALLS[agent], `${agent} : aucune connexion lancée`);
    } finally {
      await box.cleanup();
    }
  }
});

test('detectTty observe isTTY, pas la simple existence des flux', () => {
  const observed = detectTty();

  assert.equal(typeof observed.stdin, 'boolean');
  assert.equal(typeof observed.stdout, 'boolean');
  // Le lanceur de tests n'attache pas de terminal : `process.stdin` existe
  // pourtant bel et bien. Une heuristique fondée sur son existence conclurait
  // faussement à la présence d'un terminal.
  assert.ok(process.stdin !== undefined);
  assert.equal(observed.stdin, process.stdin.isTTY === true);
  assert.equal(observed.stdout, process.stdout.isTTY === true);
});

// --------------------------------------------------------------------------
// Déjà authentifié
// --------------------------------------------------------------------------

test('(7/8/9) un agent déjà authentifié ne déclenche aucun flow de connexion', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const box = await harness(agent, { auth: 'authenticated' });
    try {
      const outcome = await login(agent, box.options());

      assert.equal(outcome.status, 'ALREADY_AUTHENTICATED', agent);
      assert.equal(outcome.probe.authStatus, 'AUTHENTICATED', agent);
      assert.equal(outcome.probe.installed, true, agent);

      // Un seul probe, aucune commande de connexion : aucun navigateur ouvert,
      // aucun compte valide ré-authentifié.
      assert.deepEqual(await box.invocations(), PROBE_CALLS[agent], agent);
    } finally {
      await box.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Connexion nominale
// --------------------------------------------------------------------------

test('(10/11/14/21/23/25) une connexion réussie est établie par le probe qui suit', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const box = await harness(agent, { auth: 'unauthenticated', loginExit: 0, loginEffect: 'authenticate' });
    try {
      const outcome = await login(agent, box.options());

      assert.equal(outcome.status, 'LOGIN_COMPLETED', agent);
      assert.equal(outcome.probe.authStatus, 'AUTHENTICATED', agent);
      assert.equal(outcome.probe.version, agent === 'claude' ? '2.1.224' : '0.146.0', agent);

      // Séquence complète : probe initial → commande officielle → re-probe.
      assert.deepEqual(
        await box.invocations(),
        [...PROBE_CALLS[agent], LOGIN_CALL[agent], ...PROBE_CALLS[agent]],
        agent,
      );
    } finally {
      await box.cleanup();
    }
  }
});

test('(15/24) un exit 0 ne suffit jamais à conclure au succès', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const box = await harness(agent, { auth: 'unauthenticated', loginExit: 0, loginEffect: 'none' });
    try {
      const details = await expectCcrError(
        login(agent, box.options()),
        'AUTH_LOGIN_FAILED',
        `${agent} exit 0 sans effet`,
      );

      assert.equal(details['reason'], 'POST_PROBE_NOT_AUTHENTICATED', agent);
      assert.equal(details['loginExitCode'], 0, agent);
      assert.equal(details['postProbeAuthStatus'], 'UNAUTHENTICATED', agent);
    } finally {
      await box.cleanup();
    }
  }
});

test('(16) un post-probe UNKNOWN ne vaut pas succès et n\'est pas requalifié', async () => {
  const box = await harness('codex', { auth: 'unauthenticated', loginExit: 0, loginEffect: 'unknown' });
  try {
    const details = await expectCcrError(
      loginCodex(box.options()),
      'AUTH_LOGIN_FAILED',
      'post-probe indéterminé',
    );

    assert.equal(details['reason'], 'POST_PROBE_NOT_AUTHENTICATED');
    // `UNKNOWN` reste `UNKNOWN` : ni authentifié, ni déconnecté.
    assert.equal(details['postProbeAuthStatus'], 'UNKNOWN');
    assert.equal(details['postProbeDiagnostic'], 'PROVIDER_CONFIG_ERROR');
  } finally {
    await box.cleanup();
  }
});

test('(17/23) un exit non nul échoue, et le probe est tout de même exécuté', async () => {
  const box = await harness('claude', { auth: 'unauthenticated', loginExit: 3, loginEffect: 'authenticate' });
  try {
    const details = await expectCcrError(
      loginClaude(box.options()),
      'AUTH_LOGIN_FAILED',
      'exit non nul',
    );

    assert.equal(details['reason'], 'LOGIN_EXIT_NONZERO');
    assert.equal(details['loginExitCode'], 3);
    // Le probe suit malgré tout : c'est ainsi qu'une CLI qui échouerait en
    // authentifiant serait constatée plutôt que devinée.
    assert.equal(details['postProbeAuthStatus'], 'AUTHENTICATED');
    assert.deepEqual(await box.invocations(), [
      ...PROBE_CALLS.claude,
      LOGIN_CALL.claude,
      ...PROBE_CALLS.claude,
    ]);
  } finally {
    await box.cleanup();
  }
});

test('(18) un lancement impossible produit un échec explicite', async () => {
  const box = await harness('claude', { auth: 'unauthenticated' });
  try {
    const ghost: AgentLauncher = {
      executable: path.join(box.dir, 'disparu.exe'),
      prefixArgs: [],
      source: 'explicit',
    };
    const details = await expectCcrError(
      loginClaude(box.options({ launcher: ghost })),
      'AUTH_LOGIN_FAILED',
      'exécutable absent',
    );
    assert.equal(details['reason'], 'LOGIN_LAUNCH_FAILED');
  } finally {
    await box.cleanup();
  }
});

test('(18) une CLI introuvable produit un échec explicite avant toute tentative', async () => {
  const dir = await makeTempDir('ccr-login-absent-');
  const previous = process.env['PATH'];
  try {
    process.env['PATH'] = dir;
    const details = await expectCcrError(
      loginCodex({ consentGranted: true, tty: TTY_PRESENT, cwd: dir, timeoutMs: 20_000 }),
      'AUTH_LOGIN_FAILED',
      'CLI absente',
    );
    assert.equal(details['reason'], 'CLI_NOT_FOUND');
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Résolution partagée (§7.1)
// --------------------------------------------------------------------------

test('(19) la couche de connexion emploie le resolver partagé des adapters', () => {
  assert.equal(claudeProbeResolver, resolveClaudeLauncher);
  assert.equal(codexProbeResolver, resolveCodexLauncher);
});

test('(20) une installation npm sans exécutable direct permet aussi la connexion', async () => {
  const dir = await makeTempDir('ccr-login-shim-');
  const previous = process.env['PATH'];
  try {
    const packageDir = path.join(dir, 'node_modules', '@openai', 'codex');
    await mkdir(path.join(packageDir, 'bin'), { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    // Point d'entrée officiel : il délègue à la fixture, qui lit `process.argv`.
    await writeFile(
      path.join(packageDir, 'bin', 'codex.js'),
      `import ${JSON.stringify(pathToFileURL(FIXTURE).href)};\n`,
      'utf8',
    );
    await writeFile(path.join(dir, 'codex.cmd'), '@echo off\r\n', 'utf8');

    const argsFile = path.join(dir, 'args.jsonl');
    const stateFile = path.join(dir, 'state.json');
    await writeFile(
      stateFile,
      JSON.stringify({ auth: 'unauthenticated', loginExit: 0, loginEffect: 'authenticate' }),
      'utf8',
    );

    process.env['PATH'] = dir;
    const outcome = await loginCodex({
      consentGranted: true,
      tty: TTY_PRESENT,
      cwd: dir,
      timeoutMs: 20_000,
      env: {
        ...process.env,
        FAKE_LOGIN_AGENT: 'codex',
        FAKE_LOGIN_STATE_FILE: stateFile,
        FAKE_LOGIN_ARGS_FILE: argsFile,
      },
    });

    assert.equal(outcome.status, 'LOGIN_COMPLETED');
    // La connexion a bien transité par le point d'entrée npm, comme les probes.
    assert.equal(outcome.probe.launcherSource, 'npm-shim');

    const invocations = (await readFile(argsFile, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(invocations, [
      ...PROBE_CALLS.codex,
      LOGIN_CALL.codex,
      ...PROBE_CALLS.codex,
    ]);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Sécurité et absence d'effet de bord
// --------------------------------------------------------------------------

test('(26/27) rien de ce que produit le login ne figure dans les valeurs CCR', async () => {
  const box = await harness('claude', { auth: 'unauthenticated', loginExit: 0, loginEffect: 'authenticate' });
  try {
    // La fixture émet URL, code temporaire, e-mail et jeton sur ses flux.
    const outcome = await loginClaude(
      box.options({ env: { ...box.env, FAKE_LOGIN_EMIT_SECRETS: '1' } }),
    );

    const serialized = JSON.stringify(outcome);
    for (const secret of [
      'TEMOIN-CODE-9F3A',
      'TEMOIN-TOKEN-ABCDEF',
      'temoin.pii@exemple-ccr.test',
      'Organisation temoin PII',
      'OUVERTURE-NAVIGATEUR',
      'exemple-ccr.test',
    ]) {
      assert.ok(!serialized.includes(secret), `fuite : ${secret} dans ${serialized}`);
    }
    assert.deepEqual(Object.keys(outcome).sort(), ['probe', 'status']);
  } finally {
    await box.cleanup();
  }
});

test('(30/31) la connexion ne crée aucun run et ne touche à aucune configuration', async () => {
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

  const box = await harness('codex', { auth: 'unauthenticated', loginExit: 0, loginEffect: 'authenticate' });
  try {
    await loginCodex(box.options());

    // Le répertoire de travail ne contient que les fichiers du test :
    // ni manifest, ni state, ni events, ni verrou.
    assert.deepEqual((await readdir(box.dir)).sort(), ['args.jsonl', 'state.json']);

    const after = [await describe(path.dirname(realConfig)), await describe(realConfig)];
    assert.deepEqual(after, before, 'configuration réelle intacte');
  } finally {
    await box.cleanup();
  }
});

test('(12/26/28/29/32) le code de la couche respecte ses interdictions structurelles', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src/runtime/agent-login.ts', import.meta.url)),
    'utf8',
  );
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = stripComments(source);

  // Aucune capture : `runProcess` capture les flux, `runInteractiveProcess`
  // les laisse au terminal. La couche ne doit connaître que la seconde.
  assert.ok(code.includes('runInteractiveProcess'), 'primitive interactive employée');
  assert.ok(!/\brunProcess\b/.test(code), 'aucune primitive de capture');

  // Interdits dans le code seulement : la documentation a le droit d'expliquer
  // qu'aucune déconnexion et aucun shell n'existent ici.
  for (const pattern of [/shell:\s*true/, /logout/i, /CODEX_HOME/]) {
    assert.ok(!pattern.test(code), `motif interdit dans le code : ${pattern.source}`);
  }

  // Interdits partout, commentaires compris.
  for (const pattern of [
    /ANTHROPIC_API_KEY/,
    /OPENAI_API_KEY/,
    /CLAUDE_CODE_OAUTH_TOKEN/,
    /access_token/,
    /refresh_token/,
    /auth\.json/,
    /credentials\.json/,
    /keychain/i,
  ]) {
    assert.ok(!pattern.test(source), `motif interdit : ${pattern.source}`);
  }
});
