/**
 * Frontière d'engagement de `ccr start` (lot V1.1-6, spécification §17.2).
 *
 * Invariant central du slice :
 *
 *   défaut connaissable avant l'allocation  → aucun run n'existe
 *   défaut fournisseur après l'allocation   → sémantique V1 inchangée
 *
 * Ce fichier éprouve les deux versants, ainsi que l'arrivée effective de
 * `skip_git_repo_check` jusqu'à la ligne de commande réellement passée à Codex.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../../src/cli/main.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { createCliDeps } from '../../src/cli/deps.ts';
import { startRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import type { StartPreflightDeps } from '../../src/runtime/preflight-service.ts';
import { CONFIG_FILE_NAME, writeConfig } from '../../src/config/config-store.ts';
import { defaultConfig } from '../../src/config/config-schema.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { AgentKind } from '../../src/core/run.ts';
import { listRunIds, runPaths } from '../../src/store/layout.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG, testRuntimeConfig } from '../helpers/runtime-config.ts';
import { CcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const CLAUDE_FIXTURE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));

function capture(): CliIo & { text(): string; errorText(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
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
    version: '1.0.0',
    authStatus: 'AUTHENTICATED',
    launcherSource: 'path',
    ...over,
  };
}

// --------------------------------------------------------------------------
// Aucun run avant le franchissement de la frontière
// --------------------------------------------------------------------------

test('aucun blocage de preflight ne laisse un run derrière lui', async () => {
  const cases: readonly [string, (dir: string) => Promise<Partial<StartPreflightDeps>>][] = [
    [
      'configuration invalide',
      async (dir) => {
        await writeFile(path.join(dir, CONFIG_FILE_NAME), '{ "schema_version": 1,', 'utf8');
        return {};
      },
    ],
    [
      'configuration illisible',
      async (dir) => {
        await mkdir(path.join(dir, CONFIG_FILE_NAME), { recursive: true });
        return {};
      },
    ],
    [
      'CLI absente',
      async () => ({
        probes: {
          claude: async (): Promise<AgentRuntimeProbe> => ({
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
    ],
    [
      'authentification Claude requise',
      async () => ({
        tty: { stdin: false, stdout: false },
        probes: {
          claude: async () => probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
          codex: async () => probeOf('codex'),
        },
      }),
    ],
  ];

  for (const [label, prepare] of cases) {
    const dir = await makeTempDir('ccr-boundary-');
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    try {
      const extra = await prepare(dir);
      const io = capture();

      const adapters: AgentAdapters = {
        claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
        codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
      };
      const deps: RunServiceDeps = { runsDir, now: () => new Date(), createAdapters: () => adapters };

      const code = await runCli(['start', '--title', 'T', '--prompt', 'p'], {
        io,
        deps,
        preflight: {
          configPath: path.join(dir, CONFIG_FILE_NAME),
          env: {},
          tty: { stdin: true, stdout: true },
          confirm: async () => false,
          probes: {
            claude: async () => probeOf('claude'),
            codex: async () => probeOf('codex'),
          },
          ...extra,
        },
      });

      assert.equal(code, 1, `${label} : échec`);
      assert.ok(!io.text().includes('Run créé'), `${label} : aucun run annoncé`);
      // Preuve matérielle : aucun identifiant consommé, aucun répertoire.
      assert.deepEqual(await listRunIds(runsDir), [], `${label} : aucun run alloué`);
      assert.deepEqual(await readdir(runsDir), [], `${label} : aucun répertoire`);
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('un preflight vert alloue exactement un run', async () => {
  const dir = await makeTempDir('ccr-boundary-ok-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  try {
    const io = capture();
    const adapters: AgentAdapters = {
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
    };

    const code = await runCli(['start', '--title', 'T', '--prompt', 'p'], {
      io,
      deps: { runsDir, now: () => new Date(), createAdapters: () => adapters },
      preflight: {
        configPath: path.join(dir, CONFIG_FILE_NAME),
        env: {},
        tty: { stdin: false, stdout: false },
        probes: { claude: async () => probeOf('claude'), codex: async () => probeOf('codex') },
      },
    });

    assert.equal(code, 0);
    assert.equal((await listRunIds(runsDir)).length, 1, 'exactement un run');
    assert.match(io.text(), /Run créé : CCR-/);
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// FAILED_INITIALIZATION reste régi par la V1
// --------------------------------------------------------------------------

test('un échec fournisseur après allocation reste un FAILED_INITIALIZATION', async () => {
  const dir = await makeTempDir('ccr-boundary-failinit-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  try {
    const io = capture();
    // L'AUTHOR est initialisé en premier : c'est donc le CHALLENGER qui doit
    // échouer pour que la propriété testée — « la session déjà créée est
    // préservée » — reste celle d'origine.
    const adapters: AgentAdapters = {
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
      claude: createFakeAdapter({
        kind: 'claude',
        sessionId: 'claude-1',
        failStart: () => new CcrError('AGENT_EXIT_NONZERO', 'claude a échoué', { details: { agent: 'claude' } }),
      }),
    };

    const code = await runCli(['start', '--title', 'T', '--prompt', 'p'], {
      io,
      deps: { runsDir, now: () => new Date(), createAdapters: () => adapters },
      preflight: {
        configPath: path.join(dir, CONFIG_FILE_NAME),
        env: {},
        tty: { stdin: false, stdout: false },
        probes: { claude: async () => probeOf('claude'), codex: async () => probeOf('codex') },
      },
    });

    assert.equal(code, 1);

    // Le run existe : la frontière a bien été franchie avant l'échec.
    const runIds = await listRunIds(runsDir);
    assert.equal(runIds.length, 1, 'le run est conservé, aucun rollback inventé');

    const paths = runPaths(runsDir, runIds[0] ?? '');
    const state = await readPersistedState(paths);
    const manifest = await readPersistedManifest(paths);
    assert.equal(state.execution_mode, 'NATIVE_V21_EXECUTION', 'la CLI crée désormais du natif');
    assert.equal(state.document.state, 'FAILED_INITIALIZATION', 'sémantique inchangée');
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    // La session déjà créée est préservée.
    assert.equal(manifest.manifest.experts.author.session_id, 'codex-1');
    assert.equal(manifest.manifest.experts.challenger.session_id, null);
    assert.match(io.errorText(), /Initialisation incomplète/);
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// La configuration effective atteint réellement la ligne de commande Codex
// --------------------------------------------------------------------------

/**
 * Exécute un vrai `startRun` à travers la fabrique de dépendances de la CLI,
 * avec les fixtures V1 comme exécutables, et rend les arguments réellement
 * reçus par Codex.
 */
async function codexArgvFor(
  skipGitRepoCheck: boolean,
  options: { readonly ambientLegacy?: string } = {},
): Promise<string[]> {
  const dir = await makeTempDir('ccr-boundary-flag-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const argsFile = path.join(dir, 'codex-args.json');

  const saved = {
    claudeBin: process.env['CCR_CLAUDE_BIN'],
    codexBin: process.env['CCR_CODEX_BIN'],
    argsFileEnv: process.env['FAKE_CODEX_ARGS_FILE'],
    legacy: process.env['CCR_CODEX_SKIP_GIT_REPO_CHECK'],
  };

  try {
    // Seams V1 existants : aucun nouveau réglage public n'est introduit.
    process.env['CCR_CLAUDE_BIN'] = CLAUDE_FIXTURE;
    process.env['CCR_CODEX_BIN'] = CODEX_FIXTURE;
    process.env['FAKE_CODEX_ARGS_FILE'] = argsFile;
    // La variable ambiante reste en place lorsque le test veut prouver
    // qu'elle n'a **aucune** influence après la capture du snapshot.
    if (options.ambientLegacy === undefined) delete process.env['CCR_CODEX_SKIP_GIT_REPO_CHECK'];
    else process.env['CCR_CODEX_SKIP_GIT_REPO_CHECK'] = options.ambientLegacy;

    const deps = createCliDeps(runsDir, { codexSkipGitRepoCheck: skipGitRepoCheck });
    // Depuis V2-IMP-28, la décision effective voyage dans le snapshot, seule
    // autorité exécutable du run : c'est elle qui doit atteindre `codex exec`.
    await startRun(deps, {
      runtimeConfig: testRuntimeConfig({ skipGitRepoCheck, sourceAtCapture: 'config' }),
      title: 'T',
      cwd: dir,
      prompt: 'contexte',
    });

    return JSON.parse(await readFile(argsFile, 'utf8')) as string[];
  } finally {
    for (const [key, value] of [
      ['CCR_CLAUDE_BIN', saved.claudeBin],
      ['CCR_CODEX_BIN', saved.codexBin],
      ['FAKE_CODEX_ARGS_FILE', saved.argsFileEnv],
      ['CCR_CODEX_SKIP_GIT_REPO_CHECK', saved.legacy],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(dir);
  }
}

test('la valeur effective atteint réellement la ligne de commande de Codex', async () => {
  // Preuve de bout en bout : ce n'est pas `resolveEffectiveConfig` qui est
  // testé ici, mais l'arrivée de sa décision jusqu'à `codex exec`.
  const avecDrapeau = await codexArgvFor(true);
  assert.ok(avecDrapeau.includes('--skip-git-repo-check'), `argv reçus : ${avecDrapeau.join(' ')}`);

  const sansDrapeau = await codexArgvFor(false);
  assert.ok(!sansDrapeau.includes('--skip-git-repo-check'), `argv reçus : ${sansDrapeau.join(' ')}`);
});

test('la valeur explicite prime sur la variable historique de l\'environnement', async () => {
  // L'environnement dit `false` **pendant** la construction de l'adapter ;
  // le snapshot dit `true`. Le snapshot est la seule autorité exécutable.
  const argv = await codexArgvFor(true, { ambientLegacy: '0' });
  assert.ok(argv.includes('--skip-git-repo-check'), 'la valeur pinnée gouverne');
});

test("une variable ambiante ne peut pas non plus activer le drapeau", async () => {
  // Symétrique : le snapshot dit `false`, l'environnement dit `1`.
  // Relire l'environnement ici rendrait le run non reproductible.
  const argv = await codexArgvFor(false, { ambientLegacy: '1' });
  assert.ok(!argv.includes('--skip-git-repo-check'), 'la valeur pinnée gouverne dans les deux sens');
});

// --------------------------------------------------------------------------
// Non-généralisation aux autres commandes
// --------------------------------------------------------------------------

test('aucune commande V1 autre que start ne passe par le preflight', async () => {
  const source = await readFile(fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url)), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Une seule invocation dans tout le module, et elle est dans `commandStart`.
  // La façade est désormais la façade **native** : la CLI ne crée plus de run
  // historique, et la propriété gardée est la même.
  const invocations = code.match(/startNativeRunWithPreflight\(/g) ?? [];
  assert.equal(invocations.length, 1, 'une seule invocation de la façade');
  assert.equal((code.match(/startRunWithPreflight\(/g) ?? []).length, 0, 'aucune façade historique');

  const startBody = code.slice(code.indexOf('async function commandStart'), code.indexOf('async function commandList'));
  assert.match(startBody, /startNativeRunWithPreflight\(/, 'et elle appartient à commandStart');

  for (const command of ['commandSend', 'commandStep', 'commandRecover', 'commandHandoff', 'commandPause']) {
    const start = code.indexOf(`async function ${command}`);
    assert.ok(start > 0, `${command} présent`);
    const body = code.slice(start, start + 1_800);
    assert.ok(!body.includes('RunWithPreflight'), `${command} n'appelle pas la façade`);
    assert.ok(!body.includes('runStartPreflight'), `${command} n'appelle pas le preflight`);
  }
});

/**
 * Garde d'architecture (V2-IMP-28, V0.2 §16.3).
 *
 * La CLI est un adaptateur de surface : elle ne compose plus la politique de
 * `start`. Cette garde échoue si elle recommence — et c'est elle que le futur
 * module HTTP devra satisfaire à son tour au Slice 2.
 */
test("la CLI passe par la façade et ne recompose pas la politique de start", async () => {
  const source = await readFile(fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url)), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // La primitive bas niveau n'est plus importée par la surface CLI.
  assert.ok(!/\bstartRun\b(?!With)/.test(code), 'la CLI n’importe plus startRun');
  // Le preflight n'est plus invoqué depuis la CLI : la façade le possède.
  assert.equal((code.match(/runStartPreflight\(/g) ?? []).length, 0);
  // Le snapshot n'est plus fabriqué dans la CLI.
  assert.ok(!code.includes('RUNTIME_CONFIG_SCHEMA_VERSION'), 'la CLI ne fabrique plus le snapshot');
  assert.ok(!code.includes('source_at_capture'), 'la CLI ne fabrique plus la provenance');
});

test('send, step et recover conservent leur comportement V1 sans preflight', async () => {
  const dir = await makeTempDir('ccr-boundary-others-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  try {
    // Sondes qui feraient échouer tout preflight : elles ne doivent jamais
    // être appelées par ces commandes.
    let probed = false;
    const explosive: StartPreflightDeps = {
      configPath: path.join(dir, CONFIG_FILE_NAME),
      env: {},
      probes: {
        claude: async () => {
          probed = true;
          throw new Error('le preflight ne doit pas être exécuté ici');
        },
        codex: async () => {
          probed = true;
          throw new Error('le preflight ne doit pas être exécuté ici');
        },
      },
    };

    const adapters: AgentAdapters = {
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
    };
    const deps: RunServiceDeps = { runsDir, now: () => new Date(), createAdapters: () => adapters };

    // Un run existe déjà, créé sans passer par la CLI.
    await startRun(deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: dir, prompt: 'contexte' });

    for (const argv of [['status'], ['list'], ['send', 'claude', 'message'], ['step'], ['pause']]) {
      const io = capture();
      await runCli(argv, { io, deps, preflight: explosive });
      assert.equal(probed, false, `${argv[0] ?? ''} n'a déclenché aucune sonde de preflight`);
    }
  } finally {
    await removeTempDir(dir);
  }
});
