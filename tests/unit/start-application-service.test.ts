/**
 * StartApplicationService — voie applicative unique de création d'un run
 * (V2-IMP-28, Slice 0A).
 *
 * Le blocker corrigé ici est `CX2-001`, confirmé par les deux reviewers : la
 * composition normative vivait dans la CLI, et la primitive bas niveau
 * acceptait un snapshot optionnel — donc créait silencieusement des runs non
 * pinnés.
 *
 * Trois familles d'invariants sont éprouvées :
 *
 *  1. **composition** — la façade produit exactement la configuration
 *     effective, la provenance et les deux probes attendus ;
 *  2. **frontière** — rien n'est alloué avant le succès du preflight, et une
 *     panne fournisseur après l'engagement reste un `FAILED_INITIALIZATION`
 *     V1 ;
 *  3. **autorité** — la valeur figée dans le snapshot, et elle seule, atteint
 *     l'initialisation de Codex.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { startRunWithPreflight } from '../../src/services/start-application-service.ts';
import type {
  StartApplicationDeps,
  StartInteraction,
} from '../../src/services/start-application-service.ts';
import type { AgentAdapters, RunRuntimeSettings } from '../../src/services/run-service.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { AgentKind } from '../../src/core/run.ts';
import { RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run.ts';
import { CONFIG_FILE_NAME, writeConfig } from '../../src/config/config-store.ts';
import { defaultConfig } from '../../src/config/config-schema.ts';
import { listRunIds } from '../../src/store/layout.ts';
import { loadRun, readManifest } from '../../src/store/state-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { CcrError, isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const LEGACY_ENV = 'CCR_CODEX_SKIP_GIT_REPO_CHECK';

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

const SILENT: StartInteraction = { kind: 'non-interactive' };

interface Box {
  readonly dir: string;
  readonly runsDir: string;
  readonly configPath: string;
  /** Valeur reçue par la fabrique de dépendances à chaque construction. */
  readonly received: boolean[];
  /** Prompts reçus par chaque agent, dans l'ordre. */
  readonly calls: { agent: AgentKind; prompt: string }[];
  cleanup(): Promise<void>;
}

async function box(prefix = 'ccr-facade-'): Promise<Box> {
  const dir = await makeTempDir(prefix);
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  return {
    dir,
    runsDir,
    configPath: path.join(dir, CONFIG_FILE_NAME),
    received: [],
    calls: [],
    cleanup: () => removeTempDir(dir),
  };
}

interface DepsOptions {
  readonly interaction?: StartInteraction;
  readonly probes?: StartApplicationDeps['preflight'] extends undefined
    ? never
    : NonNullable<StartApplicationDeps['preflight']>['probes'];
  readonly env?: NodeJS.ProcessEnv;
  readonly onPreflight?: StartApplicationDeps['onPreflight'];
  readonly failCodexStart?: () => unknown;
  readonly failClaudeStart?: () => unknown;
  /** Exécuté pendant l'appel réel d'un agent : observe l'état persisté en vol. */
  readonly onAgentCall?: (agent: AgentKind) => Promise<void> | void;
}

function depsFor(b: Box, options: DepsOptions = {}): StartApplicationDeps {
  return {
    interaction: options.interaction ?? SILENT,
    preflight: {
      configPath: b.configPath,
      env: options.env ?? {},
      probes: options.probes ?? {
        claude: async () => probeOf('claude'),
        codex: async () => probeOf('codex'),
      },
    },
    ...(options.onPreflight === undefined ? {} : { onPreflight: options.onPreflight }),
    createRunServiceDeps: (runtime: RunRuntimeSettings) => {
      b.received.push(runtime.codexSkipGitRepoCheck);
      const adapters: AgentAdapters = {
        claude: createFakeAdapter({
          kind: 'claude',
          sessionId: 'claude-session-1',
          onCall: async (_phase, prompt) => {
            b.calls.push({ agent: 'claude', prompt });
            await options.onAgentCall?.('claude');
          },
          ...(options.failClaudeStart === undefined ? {} : { failStart: options.failClaudeStart }),
        }),
        codex: createFakeAdapter({
          kind: 'codex',
          sessionId: 'codex-session-1',
          onCall: async (_phase, prompt) => {
            b.calls.push({ agent: 'codex', prompt });
            await options.onAgentCall?.('codex');
          },
          ...(options.failCodexStart === undefined ? {} : { failStart: options.failCodexStart }),
        }),
      };
      return { runsDir: b.runsDir, now: () => new Date(), createAdapters: () => adapters };
    },
  };
}

const INPUT = { title: 'T', cwd: 'E:/prog/exemple', prompt: 'contexte initial' };

// --------------------------------------------------------------------------
// (1 à 8) Composition
// --------------------------------------------------------------------------

test('(1) configuration absente : les défauts V1.1 s’appliquent', async () => {
  const b = await box();
  try {
    const result = await startRunWithPreflight(depsFor(b), INPUT);
    assert.equal(result.runtimeConfig.codex.skip_git_repo_check, false, 'opt-in, jamais implicite');
    assert.equal(result.runtimeConfig.codex.source_at_capture, 'default');
  } finally {
    await b.cleanup();
  }
});

test('(2) configuration valide : sa valeur est figée dans le snapshot', async () => {
  const b = await box();
  try {
    await writeConfig({ ...defaultConfig(), codex: { skip_git_repo_check: true } }, { configPath: b.configPath });
    const result = await startRunWithPreflight(depsFor(b), INPUT);
    assert.equal(result.runtimeConfig.codex.skip_git_repo_check, true);
    assert.equal(result.runtimeConfig.codex.source_at_capture, 'config');
  } finally {
    await b.cleanup();
  }
});

test('(3) variable héritée « 1 » : prise en compte et provenance legacy-env', async () => {
  const b = await box();
  try {
    const result = await startRunWithPreflight(depsFor(b, { env: { [LEGACY_ENV]: '1' } }), INPUT);
    assert.equal(result.runtimeConfig.codex.skip_git_repo_check, true);
    assert.equal(result.runtimeConfig.codex.source_at_capture, 'legacy-env');
    assert.ok(result.warnings.includes('LEGACY_ENV_OVERRIDE'));
  } finally {
    await b.cleanup();
  }
});

test('(4) variable héritée non canonique : override signalé, valeur non coercée', async () => {
  const b = await box();
  try {
    await writeConfig({ ...defaultConfig(), codex: { skip_git_repo_check: true } }, { configPath: b.configPath });
    const result = await startRunWithPreflight(depsFor(b, { env: { [LEGACY_ENV]: 'yes' } }), INPUT);

    // La variable est présente : elle prime sur la configuration, et « yes »
    // n'est pas « 1 » — donc `false`, sans coercition indulgente.
    assert.equal(result.runtimeConfig.codex.skip_git_repo_check, false);
    assert.equal(result.runtimeConfig.codex.source_at_capture, 'legacy-env');
    assert.ok(result.warnings.includes('LEGACY_ENV_OVERRIDE'));
    assert.ok(result.warnings.includes('LEGACY_ENV_NON_CANONICAL'));
  } finally {
    await b.cleanup();
  }
});

test('(5) le snapshot recopie versions, statuts et provenance observés', async () => {
  const b = await box();
  try {
    const result = await startRunWithPreflight(
      depsFor(b, {
        probes: {
          claude: async () => probeOf('claude', { version: '9.9.9' }),
          codex: async () => probeOf('codex', { version: '0.0.1', authStatus: 'UNKNOWN' }),
        },
      }),
      INPUT,
    );

    assert.equal(result.runtimeConfig.schema_version, RUNTIME_CONFIG_SCHEMA_VERSION);
    assert.equal(result.runtimeConfig.claude.cli_version, '9.9.9');
    assert.equal(result.runtimeConfig.claude.auth_preflight, 'AUTHENTICATED');
    assert.equal(result.runtimeConfig.codex.cli_version, '0.0.1');
    assert.equal(result.runtimeConfig.codex.auth_preflight, 'UNKNOWN');
    assert.ok(Number.isFinite(Date.parse(result.runtimeConfig.captured_at)));

    // Et il est durablement écrit dans le manifest.
    const manifest = await readManifest(runPaths(b.runsDir, result.runId));
    assert.deepEqual(manifest.runtime_config, result.runtimeConfig);
  } finally {
    await b.cleanup();
  }
});

test('(6) les deux probes sont interrogés exactement une fois', async () => {
  const b = await box();
  try {
    let claude = 0;
    let codex = 0;
    await startRunWithPreflight(
      depsFor(b, {
        probes: {
          claude: async () => {
            claude += 1;
            return probeOf('claude');
          },
          codex: async () => {
            codex += 1;
            return probeOf('codex');
          },
        },
      }),
      INPUT,
    );
    assert.equal(claude, 1);
    assert.equal(codex, 1);
  } finally {
    await b.cleanup();
  }
});

test('(7) politique Claude inchangée : UNKNOWN avertit et n’interrompt pas', async () => {
  const b = await box();
  try {
    const result = await startRunWithPreflight(
      depsFor(b, {
        probes: {
          claude: async () => probeOf('claude', { authStatus: 'UNKNOWN' }),
          codex: async () => probeOf('codex'),
        },
      }),
      INPUT,
    );
    assert.ok(result.warnings.includes('CLAUDE_AUTH_UNKNOWN'));
    assert.equal(result.state.state, 'READY', "l'incertitude n'est pas une certitude négative");
  } finally {
    await b.cleanup();
  }
});

test('(8) politique Codex inchangée : un statut non rapporté ne bloque jamais', async () => {
  const b = await box();
  try {
    const result = await startRunWithPreflight(
      depsFor(b, {
        probes: {
          claude: async () => probeOf('claude'),
          codex: async () => probeOf('codex', { authStatus: 'UNAUTHENTICATED' }),
        },
      }),
      INPUT,
    );
    assert.ok(result.warnings.includes('CODEX_AUTH_NOT_REPORTED'));
    assert.equal(result.state.state, 'READY', "l'asymétrie V1.1 est préservée");
    assert.equal((await listRunIds(b.runsDir)).length, 1);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (9 à 14) Frontière d'allocation
// --------------------------------------------------------------------------

async function assertNoAllocation(b: Box, deps: StartApplicationDeps, code: string): Promise<void> {
  await assert.rejects(
    () => startRunWithPreflight(deps, INPUT),
    (error: unknown) => isCcrError(error) && error.code === code,
  );
  assert.deepEqual(await listRunIds(b.runsDir), [], 'aucun run alloué');
  assert.deepEqual(await readdir(b.runsDir), [], 'aucun répertoire');
  assert.deepEqual(b.calls, [], 'aucun agent appelé');
  assert.deepEqual(b.received, [], 'aucune dépendance de run construite');
}

test('(9) configuration invalide : aucun run, aucun agent', async () => {
  const b = await box();
  try {
    await writeFile(b.configPath, '{ "schema_version": 1,', 'utf8');
    await assertNoAllocation(b, depsFor(b), 'CONFIG_INVALID');
  } finally {
    await b.cleanup();
  }
});

test('(10) CLI fournisseur absente : aucun run, aucun agent', async () => {
  const b = await box();
  try {
    await assertNoAllocation(
      b,
      depsFor(b, {
        probes: {
          claude: async () => probeOf('claude', { installed: false, version: null, diagnostic: 'CLI_NOT_FOUND' }),
          codex: async () => probeOf('codex'),
        },
      }),
      'AGENT_CLI_NOT_FOUND',
    );
  } finally {
    await b.cleanup();
  }
});

test('(11) Claude AUTH_REQUIRED hors terminal : aucun run, aucun agent', async () => {
  const b = await box();
  try {
    await assertNoAllocation(
      b,
      depsFor(b, {
        probes: {
          claude: async () => probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
          codex: async () => probeOf('codex'),
        },
      }),
      'AUTH_REQUIRED',
    );
  } finally {
    await b.cleanup();
  }
});

test('(11bis) un caller non interactif ne peut pas déclencher de remédiation', async () => {
  const b = await box();
  try {
    let loginAttempts = 0;
    await assert.rejects(
      () =>
        startRunWithPreflight(
          {
            ...depsFor(b, {
              probes: {
                claude: async () => probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
                codex: async () => probeOf('codex'),
              },
            }),
            preflight: {
              configPath: b.configPath,
              env: {},
              probes: {
                claude: async () => probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
                codex: async () => probeOf('codex'),
              },
              logins: {
                claude: async () => {
                  loginAttempts += 1;
                  throw new Error('jamais atteint');
                },
                codex: async () => {
                  loginAttempts += 1;
                  throw new Error('jamais atteint');
                },
              },
            },
          },
          INPUT,
        ),
      (error: unknown) => isCcrError(error) && error.code === 'AUTH_REQUIRED',
    );
    assert.equal(loginAttempts, 0, 'aucune connexion fournisseur tentée');
  } finally {
    await b.cleanup();
  }
});

test('(12) preflight vert : exactement une allocation', async () => {
  const b = await box();
  try {
    const result = await startRunWithPreflight(depsFor(b), INPUT);
    assert.equal((await listRunIds(b.runsDir)).length, 1);
    assert.equal(result.state.state, 'READY');
    assert.equal(result.failure, undefined);
  } finally {
    await b.cleanup();
  }
});

test('(13) aucun agent n’est appelé avant l’allocation', async () => {
  const b = await box();
  try {
    let runsAtFirstCall: string[] | undefined;
    await startRunWithPreflight(
      depsFor(b, {
        onAgentCall: async () => {
          runsAtFirstCall ??= await listRunIds(b.runsDir);
        },
      }),
      INPUT,
    );
    assert.equal(runsAtFirstCall?.length, 1, 'le run existait déjà au premier appel agent');
  } finally {
    await b.cleanup();
  }
});

test('(14) le snapshot est durable AVANT le premier appel agent', async () => {
  const b = await box();
  try {
    await writeConfig({ ...defaultConfig(), codex: { skip_git_repo_check: true } }, { configPath: b.configPath });

    let seen: unknown;
    await startRunWithPreflight(
      depsFor(b, {
        onAgentCall: async () => {
          if (seen !== undefined) return;
          const [runId] = await listRunIds(b.runsDir);
          const raw = await readFile(runPaths(b.runsDir, runId as string).manifest, 'utf8');
          seen = (JSON.parse(raw) as { runtime_config?: unknown }).runtime_config;
        },
      }),
      INPUT,
    );

    assert.notEqual(seen, undefined, 'le manifest lu pendant le premier tour porte déjà le snapshot');
    assert.equal((seen as { codex: { skip_git_repo_check: boolean } }).codex.skip_git_repo_check, true);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (15 à 18) Autorité de la valeur runtime
// --------------------------------------------------------------------------

test('(15) skip = true atteint réellement la construction des adapters', async () => {
  const b = await box();
  try {
    await writeConfig({ ...defaultConfig(), codex: { skip_git_repo_check: true } }, { configPath: b.configPath });
    await startRunWithPreflight(depsFor(b), INPUT);
    assert.ok(b.received.length > 0);
    assert.ok(b.received.every((value) => value === true));
  } finally {
    await b.cleanup();
  }
});

test('(16) skip = false atteint réellement la construction des adapters', async () => {
  const b = await box();
  try {
    await writeConfig({ ...defaultConfig(), codex: { skip_git_repo_check: false } }, { configPath: b.configPath });
    await startRunWithPreflight(depsFor(b), INPUT);
    assert.ok(b.received.length > 0);
    assert.ok(b.received.every((value) => value === false));
  } finally {
    await b.cleanup();
  }
});

test('(17) une variable d’environnement contraire postérieure ne change rien', async () => {
  const b = await box();
  const saved = process.env[LEGACY_ENV];
  try {
    await writeConfig({ ...defaultConfig(), codex: { skip_git_repo_check: true } }, { configPath: b.configPath });

    // L'ambiant dit `false` — et il ne doit jamais être relu après la capture.
    process.env[LEGACY_ENV] = '0';

    const result = await startRunWithPreflight(depsFor(b), INPUT);

    assert.equal(result.runtimeConfig.codex.skip_git_repo_check, true);
    assert.ok(b.received.every((value) => value === true), 'la valeur figée gouverne');

    const manifest = await readManifest(runPaths(b.runsDir, result.runId));
    assert.equal(manifest.runtime_config?.codex.skip_git_repo_check, true);
  } finally {
    if (saved === undefined) delete process.env[LEGACY_ENV];
    else process.env[LEGACY_ENV] = saved;
    await b.cleanup();
  }
});

test('(18) la provenance ne décide jamais du drapeau', async () => {
  // Même valeur effective, deux provenances différentes : le comportement
  // exécutable doit être rigoureusement identique.
  const viaConfig = await box('ccr-facade-src-config-');
  const viaEnv = await box('ccr-facade-src-env-');
  try {
    await writeConfig(
      { ...defaultConfig(), codex: { skip_git_repo_check: true } },
      { configPath: viaConfig.configPath },
    );
    const a = await startRunWithPreflight(depsFor(viaConfig), INPUT);
    const c = await startRunWithPreflight(depsFor(viaEnv, { env: { [LEGACY_ENV]: '1' } }), INPUT);

    assert.equal(a.runtimeConfig.codex.source_at_capture, 'config');
    assert.equal(c.runtimeConfig.codex.source_at_capture, 'legacy-env');

    assert.equal(a.runtimeConfig.codex.skip_git_repo_check, true);
    assert.equal(c.runtimeConfig.codex.skip_git_repo_check, true);
    assert.deepEqual(viaConfig.received, viaEnv.received, 'provenances différentes, exécution identique');
  } finally {
    await viaConfig.cleanup();
    await viaEnv.cleanup();
  }
});

// --------------------------------------------------------------------------
// (19 à 21) Frontière post-allocation
// --------------------------------------------------------------------------

test('(19/20/21) un échec Codex après allocation reste un FAILED_INITIALIZATION V1', async () => {
  const b = await box();
  try {
    const result = await startRunWithPreflight(
      depsFor(b, {
        failCodexStart: () =>
          new CcrError('AGENT_EXIT_NONZERO', 'codex a échoué', { details: { agent: 'codex' } }),
      }),
      INPUT,
    );

    assert.equal(result.failure?.agent, 'codex');
    assert.equal(result.state.state, 'FAILED_INITIALIZATION');

    // (21) aucun rollback : le run existe toujours sur disque.
    assert.equal((await listRunIds(b.runsDir)).length, 1);
    const loaded = await loadRun(b.runsDir, result.runId);

    // (20) la session Claude déjà obtenue est préservée.
    assert.equal(loaded.manifest.agents.claude.session_id, 'claude-session-1');
    assert.equal(loaded.manifest.agents.codex.session_id, null);
    // Et le snapshot survit à l'initialisation partielle.
    assert.equal(loaded.manifest.runtime_config?.schema_version, RUNTIME_CONFIG_SCHEMA_VERSION);
  } finally {
    await b.cleanup();
  }
});

test('un échec Claude — le premier agent — laisse aussi le run en place', async () => {
  const b = await box();
  try {
    const result = await startRunWithPreflight(
      depsFor(b, {
        failClaudeStart: () =>
          new CcrError('AGENT_EXIT_NONZERO', 'claude a échoué', { details: { agent: 'claude' } }),
      }),
      INPUT,
    );

    assert.equal(result.failure?.agent, 'claude');
    assert.equal(result.state.state, 'FAILED_INITIALIZATION');
    assert.equal((await listRunIds(b.runsDir)).length, 1, 'aucun rollback');

    const loaded = await loadRun(b.runsDir, result.runId);
    assert.equal(loaded.manifest.agents.claude.session_id, null);
    assert.equal(loaded.manifest.agents.codex.session_id, null);
    // Le snapshot est écrit avant tout agent : il est là même sans session.
    assert.notEqual(loaded.manifest.runtime_config, undefined);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Contrat d'interaction
// --------------------------------------------------------------------------

test('un caller interactif conserve exactement la remédiation V1.1', async () => {
  const b = await box();
  try {
    const questions: string[] = [];
    let loginCalls = 0;

    const result = await startRunWithPreflight(
      {
        ...depsFor(b),
        interaction: {
          kind: 'interactive',
          out: () => undefined,
          confirm: async (question) => {
            questions.push(question);
            return true;
          },
          tty: { stdin: true, stdout: true },
        },
        preflight: {
          configPath: b.configPath,
          env: {},
          probes: {
            claude: async () => probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
            codex: async () => probeOf('codex'),
          },
          logins: {
            claude: async () => {
              loginCalls += 1;
              return { probe: probeOf('claude'), attempted: true, exitCode: 0 } as never;
            },
            codex: async () => {
              loginCalls += 1;
              return { probe: probeOf('codex'), attempted: true, exitCode: 0 } as never;
            },
          },
        },
      },
      INPUT,
    );

    assert.equal(loginCalls, 1, 'seul Claude avait besoin d’une remédiation');
    assert.ok(questions.some((q) => q.includes('Claude')));
    assert.equal(result.state.state, 'READY');
  } finally {
    await b.cleanup();
  }
});

test('un refus de consentement n’alloue aucun run', async () => {
  const b = await box();
  try {
    let loginCalls = 0;
    await assert.rejects(
      () =>
        startRunWithPreflight(
          {
            ...depsFor(b),
            interaction: {
              kind: 'interactive',
              out: () => undefined,
              // Un simple Enter vaut NON : la valeur par défaut est le refus.
              confirm: async () => false,
              tty: { stdin: true, stdout: true },
            },
            preflight: {
              configPath: b.configPath,
              env: {},
              probes: {
                claude: async () => probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
                codex: async () => probeOf('codex'),
              },
              logins: {
                claude: async () => {
                  loginCalls += 1;
                  throw new Error('jamais atteint');
                },
                codex: async () => {
                  loginCalls += 1;
                  throw new Error('jamais atteint');
                },
              },
            },
          },
          INPUT,
        ),
      (error: unknown) => isCcrError(error) && error.code === 'AUTH_REQUIRED',
    );

    assert.equal(loginCalls, 0);
    assert.deepEqual(await listRunIds(b.runsDir), []);
  } finally {
    await b.cleanup();
  }
});

test('onPreflight est invoqué avant toute allocation', async () => {
  const b = await box();
  try {
    // Lecture synchrone : la constatation est faite dans le callback lui-même,
    // sans dépendre de l'ordonnancement d'une promesse.
    let entriesAtPreflight: string[] | undefined;
    await startRunWithPreflight(
      depsFor(b, {
        onPreflight: () => {
          entriesAtPreflight ??= readdirSync(b.runsDir);
        },
      }),
      INPUT,
    );
    assert.deepEqual(entriesAtPreflight, [], 'aucun run n’existait quand le preflight a rendu la main');
    assert.equal((await listRunIds(b.runsDir)).length, 1, 'et le run existe bien ensuite');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (35) Un nouveau run ne peut plus être créé sans snapshot
// --------------------------------------------------------------------------

test('(35) le contrat de création moderne rend le snapshot obligatoire', async () => {
  const source = await readFile(
    new URL('../../src/services/run-service.ts', import.meta.url),
    'utf8',
  );
  const contract = source.slice(
    source.indexOf('export interface StartRunInput'),
    source.indexOf('export interface StartRunResult'),
  );

  assert.ok(contract.includes('readonly runtimeConfig: RunRuntimeConfig;'), 'snapshot obligatoire');
  assert.ok(
    !/runtimeConfig\?\s*:/.test(contract),
    'aucune voie générique ne permet plus de créer un run sans snapshot',
  );
});
