/**
 * Tests unitaires du preflight de `ccr start` (lot V1.1-6, spécification §17).
 *
 * Deux familles de propriétés :
 *
 *  - la **politique** : qui bloque, qui avertit, qui propose une connexion ;
 *  - la **frontière d'engagement** : rien de connaissable avant l'allocation ne
 *    doit laisser un run derrière lui.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runStartPreflight } from '../../src/runtime/preflight-service.ts';
import type { StartPreflightDeps, StartPreflightWarning } from '../../src/runtime/preflight-service.ts';
import { CONFIG_FILE_NAME, writeConfig } from '../../src/config/config-store.ts';
import { defaultConfig } from '../../src/config/config-schema.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { AgentLoginOptions, LoginOutcome } from '../../src/runtime/agent-login.ts';
import type { AgentKind } from '../../src/core/run.ts';
import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const TTY = { stdin: true, stdout: true } as const;
const NO_TTY = { stdin: false, stdout: false } as const;

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

const ABSENT = (agent: AgentKind): AgentRuntimeProbe => ({
  agent,
  installed: false,
  version: null,
  authStatus: 'UNKNOWN',
  diagnostic: 'CLI_NOT_FOUND',
  launcherSource: null,
});

interface Harness {
  readonly dir: string;
  readonly configPath: string;
  readonly questions: string[];
  readonly loginCalls: { agent: AgentKind; options: AgentLoginOptions }[];
  deps(over?: Partial<StartPreflightDeps>): StartPreflightDeps;
  cleanup(): Promise<void>;
}

interface HarnessInput {
  readonly claude?: AgentRuntimeProbe;
  readonly codex?: AgentRuntimeProbe;
  readonly answers?: readonly boolean[];
  readonly env?: NodeJS.ProcessEnv;
  readonly loginClaude?: (options: AgentLoginOptions) => Promise<LoginOutcome>;
  readonly loginCodex?: (options: AgentLoginOptions) => Promise<LoginOutcome>;
}

async function harness(input: HarnessInput = {}): Promise<Harness> {
  const dir = await makeTempDir('ccr-preflight-');
  const questions: string[] = [];
  const loginCalls: { agent: AgentKind; options: AgentLoginOptions }[] = [];
  const queue = [...(input.answers ?? [])];

  const makeLogin =
    (agent: AgentKind, custom?: (options: AgentLoginOptions) => Promise<LoginOutcome>) =>
    async (options: AgentLoginOptions): Promise<LoginOutcome> => {
      loginCalls.push({ agent, options });
      if (custom !== undefined) return custom(options);
      return { status: 'LOGIN_COMPLETED', probe: probeOf(agent) };
    };

  return {
    dir,
    configPath: path.join(dir, CONFIG_FILE_NAME),
    questions,
    loginCalls,
    deps(over: Partial<StartPreflightDeps> = {}): StartPreflightDeps {
      return {
        configPath: path.join(dir, CONFIG_FILE_NAME),
        env: input.env ?? {},
        tty: TTY,
        confirm: async (question: string): Promise<boolean> => {
          questions.push(question);
          return queue.shift() ?? false;
        },
        probes: {
          claude: async () => input.claude ?? probeOf('claude'),
          codex: async () => input.codex ?? probeOf('codex'),
        },
        logins: {
          claude: makeLogin('claude', input.loginClaude),
          codex: makeLogin('codex', input.loginCodex),
        },
        ...over,
      };
    },
    cleanup: () => removeTempDir(dir),
  };
}

async function expectCcrError(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<CcrError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isCcrError(error), `${what} : attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code, what);
    return error;
  }
  assert.fail(`${what} : attendu ${code}, aucune erreur levée`);
}

// --------------------------------------------------------------------------
// Configuration (1 à 8)
// --------------------------------------------------------------------------

test('(1/2) configuration absente puis valide', async () => {
  const box = await harness();
  try {
    const defaults = await runStartPreflight(box.deps());
    assert.equal(defaults.effectiveConfig.codex.skipGitRepoCheck, false);
    assert.equal(defaults.effectiveConfig.codex.source, 'default');
    assert.equal(defaults.effectiveConfig.preflight.offerInteractiveLogin, true);
    assert.deepEqual(defaults.warnings, []);

    await writeConfig(
      { schema_version: 1, preflight: { offer_interactive_login: false }, codex: { skip_git_repo_check: true } },
      { configPath: box.configPath },
    );

    const configured = await runStartPreflight(box.deps());
    assert.equal(configured.effectiveConfig.codex.skipGitRepoCheck, true);
    assert.equal(configured.effectiveConfig.codex.source, 'config');
    assert.equal(configured.effectiveConfig.preflight.offerInteractiveLogin, false);
  } finally {
    await box.cleanup();
  }
});

test('(3/4/5) une configuration inexploitable arrête le preflight', async () => {
  const cases: readonly [string | 'repertoire', CcrErrorCode][] = [
    ['{ "schema_version": 1,', 'CONFIG_INVALID'],
    [JSON.stringify({ ...defaultConfig(), schema_version: 99 }), 'CONFIG_SCHEMA_UNSUPPORTED'],
    ['repertoire', 'CONFIG_READ_FAILED'],
  ];

  for (const [content, code] of cases) {
    const box = await harness();
    try {
      if (content === 'repertoire') await mkdir(box.configPath, { recursive: true });
      else await writeFile(box.configPath, content, 'utf8');

      await expectCcrError(runStartPreflight(box.deps()), code, code);
      assert.deepEqual(box.loginCalls, [], 'aucune connexion tentée');
      assert.deepEqual(box.questions, [], 'aucune invite');
    } finally {
      await box.cleanup();
    }
  }
});

test('(6/7/8) résolution effective avec variable historique', async () => {
  const cases: readonly [string | undefined, boolean, boolean, string, readonly StartPreflightWarning[]][] = [
    [undefined, true, true, 'config', []],
    ['1', false, true, 'legacy-env', ['LEGACY_ENV_OVERRIDE']],
    ['0', true, false, 'legacy-env', ['LEGACY_ENV_OVERRIDE', 'LEGACY_ENV_NON_CANONICAL']],
    ['true', true, false, 'legacy-env', ['LEGACY_ENV_OVERRIDE', 'LEGACY_ENV_NON_CANONICAL']],
  ];

  for (const [value, persisted, expected, source, warnings] of cases) {
    const env = value === undefined ? {} : { CCR_CODEX_SKIP_GIT_REPO_CHECK: value };
    const box = await harness({ env });
    try {
      await writeConfig(
        { ...defaultConfig(), codex: { skip_git_repo_check: persisted } },
        { configPath: box.configPath },
      );

      const result = await runStartPreflight(box.deps());

      assert.equal(result.effectiveConfig.codex.skipGitRepoCheck, expected, `valeur ${String(value)}`);
      assert.equal(result.effectiveConfig.codex.source, source);
      assert.deepEqual(result.warnings, [...warnings]);
      // La valeur brute ne figure jamais dans le résultat.
      if (value !== undefined) assert.ok(!JSON.stringify(result).includes(`"${value}"`));
    } finally {
      await box.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Présence des CLI (9 à 13)
// --------------------------------------------------------------------------

test('(10/11/12/13) une CLI absente arrête le preflight avec un diagnostic complet', async () => {
  const cases: readonly [Partial<HarnessInput>, readonly AgentKind[]][] = [
    [{ claude: ABSENT('claude') }, ['claude']],
    [{ codex: ABSENT('codex') }, ['codex']],
    [{ claude: ABSENT('claude'), codex: ABSENT('codex') }, ['claude', 'codex']],
  ];

  for (const [input, missing] of cases) {
    const box = await harness({ ...input, answers: [true, true] });
    try {
      const error = await expectCcrError(
        runStartPreflight(box.deps()),
        'AGENT_CLI_NOT_FOUND',
        missing.join('+'),
      );

      assert.deepEqual(error.details['missing'], [...missing], 'agents concernés identifiés');
      assert.deepEqual(box.loginCalls, [], 'aucune connexion pour une CLI absente');
      assert.deepEqual(box.questions, [], 'aucune invite');
      // Aucun chemin de recherche recopié dans l'erreur.
      assert.ok(!JSON.stringify(error.details).toLowerCase().includes('path'));
    } finally {
      await box.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Politique Claude (14 à 21)
// --------------------------------------------------------------------------

test('(14) Claude authentifié : aucune invite, aucun login', async () => {
  const box = await harness();
  try {
    const result = await runStartPreflight(box.deps());

    assert.equal(result.claude.authStatus, 'AUTHENTICATED');
    assert.deepEqual(box.questions, []);
    assert.deepEqual(box.loginCalls, []);
  } finally {
    await box.cleanup();
  }
});

test('(15) une connexion Claude acceptée et réussie laisse le preflight se poursuivre', async () => {
  const box = await harness({
    claude: probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
    answers: [true],
  });
  try {
    const result = await runStartPreflight(box.deps());

    assert.equal(result.claude.authStatus, 'AUTHENTICATED', 'le probe post-connexion fait foi');
    assert.equal(box.loginCalls.length, 1);
    assert.equal(box.loginCalls[0]?.options.consentGranted, true);
    assert.deepEqual(box.loginCalls[0]?.options.tty, TTY);
  } finally {
    await box.cleanup();
  }
});

test('(16/17/18) Claude non authentifié : trois chemins, un seul verdict', async () => {
  const cases: readonly [string, Partial<StartPreflightDeps>, readonly boolean[], boolean][] = [
    ['refus explicite', {}, [false], true],
    ['aucun terminal', { tty: NO_TTY }, [true], false],
    ['aucune invite disponible', { confirm: undefined }, [], false],
  ];

  for (const [label, over, answers, expectQuestion] of cases) {
    const box = await harness({ claude: probeOf('claude', { authStatus: 'UNAUTHENTICATED' }), answers });
    try {
      await expectCcrError(runStartPreflight(box.deps(over)), 'AUTH_REQUIRED', label);

      assert.deepEqual(box.loginCalls, [], `${label} : aucune connexion lancée`);
      assert.equal(box.questions.length > 0, expectQuestion, `${label} : invite`);
    } finally {
      await box.cleanup();
    }
  }
});

test('(18) offer_interactive_login=false interdit toute invite, même en terminal', async () => {
  const box = await harness({ claude: probeOf('claude', { authStatus: 'UNAUTHENTICATED' }), answers: [true] });
  try {
    await writeConfig(
      { ...defaultConfig(), preflight: { offer_interactive_login: false } },
      { configPath: box.configPath },
    );

    await expectCcrError(runStartPreflight(box.deps()), 'AUTH_REQUIRED', 'connexion désactivée');
    assert.deepEqual(box.questions, [], 'aucune invite');
    assert.deepEqual(box.loginCalls, [], 'aucune connexion');
  } finally {
    await box.cleanup();
  }
});

test('(19) un échec de connexion Claude remonte tel quel, sans devenir une initialisation ratée', async () => {
  const box = await harness({
    claude: probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
    answers: [true],
    loginClaude: async () => {
      throw new CcrError('AUTH_LOGIN_FAILED', 'connexion non confirmée', {
        details: { agent: 'claude', reason: 'POST_PROBE_NOT_AUTHENTICATED' },
      });
    },
  });
  try {
    // Aucun run n'est engagé à ce stade : ce n'est pas un FAILED_INITIALIZATION.
    await expectCcrError(runStartPreflight(box.deps()), 'AUTH_LOGIN_FAILED', 'connexion en échec');
  } finally {
    await box.cleanup();
  }
});

test('(20/21) Claude indéterminé avertit et poursuit, sans connexion automatique', async () => {
  const box = await harness({ claude: probeOf('claude', { authStatus: 'UNKNOWN' }), answers: [true] });
  try {
    const result = await runStartPreflight(box.deps());

    assert.deepEqual(result.warnings, ['CLAUDE_AUTH_UNKNOWN']);
    assert.equal(result.claude.authStatus, 'UNKNOWN', 'jamais requalifié');
    assert.deepEqual(box.questions, [], 'aucune invite automatique');
    assert.deepEqual(box.loginCalls, [], 'aucune connexion automatique');
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Politique Codex (22 à 29)
// --------------------------------------------------------------------------

test('(23/24/25) Codex sans connexion rapportée avertit et laisse passer', async () => {
  const cases: readonly [string, Partial<StartPreflightDeps>, readonly boolean[], boolean][] = [
    ['refus explicite', {}, [false], true],
    ['aucun terminal', { tty: NO_TTY }, [], false],
    ['aucune invite disponible', { confirm: undefined }, [], false],
  ];

  for (const [label, over, answers, expectQuestion] of cases) {
    const box = await harness({ codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED' }), answers });
    try {
      const result = await runStartPreflight(box.deps(over));

      assert.deepEqual(result.warnings, ['CODEX_AUTH_NOT_REPORTED'], label);
      assert.deepEqual(box.loginCalls, [], `${label} : aucune connexion`);
      assert.equal(box.questions.length > 0, expectQuestion, `${label} : invite`);
    } finally {
      await box.cleanup();
    }
  }
});

test('(25) offer_interactive_login=false : Codex avertit sans invite et poursuit', async () => {
  const box = await harness({ codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED' }), answers: [true] });
  try {
    await writeConfig(
      { ...defaultConfig(), preflight: { offer_interactive_login: false } },
      { configPath: box.configPath },
    );

    const result = await runStartPreflight(box.deps());

    assert.deepEqual(result.warnings, ['CODEX_AUTH_NOT_REPORTED']);
    assert.deepEqual(box.questions, []);
  } finally {
    await box.cleanup();
  }
});

test('(26) une connexion Codex acceptée et réussie adopte le nouveau probe', async () => {
  const box = await harness({ codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED' }), answers: [true] });
  try {
    const result = await runStartPreflight(box.deps());

    assert.equal(result.codex.authStatus, 'AUTHENTICATED');
    assert.equal(box.loginCalls.length, 1);
    assert.equal(box.loginCalls[0]?.agent, 'codex');
  } finally {
    await box.cleanup();
  }
});

test('(27) un échec de connexion Codex n\'empêche pas d\'essayer réellement', async () => {
  const box = await harness({
    codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED' }),
    answers: [true],
    loginCodex: async () => {
      throw new CcrError('AUTH_LOGIN_FAILED', 'connexion non confirmée', {
        details: { agent: 'codex', reason: 'POST_PROBE_NOT_AUTHENTICATED' },
      });
    },
  });
  try {
    // L'échec d'une connexion OpenAI ne prouve pas qu'un fournisseur alternatif
    // ne puisse pas exécuter le run.
    const result = await runStartPreflight(box.deps());

    assert.deepEqual(result.warnings, ['CODEX_AUTH_NOT_REPORTED', 'CODEX_LOGIN_REMEDIATION_FAILED']);
    assert.equal(result.codex.authStatus, 'UNAUTHENTICATED', 'aucun état inventé');
  } finally {
    await box.cleanup();
  }
});

test('une CLI Codex disparue pendant la remédiation redevient un blocage', async () => {
  const box = await harness({
    codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED' }),
    answers: [true],
    loginCodex: async () => {
      throw new CcrError('AUTH_LOGIN_FAILED', 'CLI absente', {
        details: { agent: 'codex', reason: 'CLI_NOT_FOUND' },
      });
    },
  });
  try {
    const error = await expectCcrError(runStartPreflight(box.deps()), 'AGENT_CLI_NOT_FOUND', 'CLI disparue');
    assert.deepEqual(error.details['missing'], ['codex']);
  } finally {
    await box.cleanup();
  }
});

test('(28/29) Codex indéterminé avertit, sans invite ni connexion automatique', async () => {
  const box = await harness({ codex: probeOf('codex', { authStatus: 'UNKNOWN' }), answers: [true] });
  try {
    const result = await runStartPreflight(box.deps());

    assert.deepEqual(result.warnings, ['CODEX_AUTH_UNKNOWN']);
    assert.deepEqual(box.questions, []);
    assert.deepEqual(box.loginCalls, []);
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Consentement (30/31)
// --------------------------------------------------------------------------

test('(30/31) aucune connexion n\'est ouverte sans oui explicite', async () => {
  const box = await harness({
    claude: probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
    codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED' }),
    // File vide : chaque invite reçoit l'équivalent d'un simple Enter.
  });
  try {
    await expectCcrError(runStartPreflight(box.deps()), 'AUTH_REQUIRED', 'Enter vaut refus');
    assert.deepEqual(box.loginCalls, []);
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Frontière structurelle
// --------------------------------------------------------------------------

test('le preflight est structurellement incapable d\'allouer un run', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src/runtime/preflight-service.ts', import.meta.url)),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const pattern of [
    /createRunDirectory|startRun|writeManifest|writeState|openEventStore|withRunLock|runsDir/,
    /process\.env\s*\[[^\]]+\]\s*=/,
    /ANTHROPIC_API_KEY|OPENAI_API_KEY|auth\.json|keychain/i,
  ]) {
    assert.ok(!pattern.test(code), `motif interdit : ${pattern.source}`);
  }
});

test('le preflight n\'écrit rien et ne modifie pas l\'environnement', async () => {
  const box = await harness({ env: { CCR_CODEX_SKIP_GIT_REPO_CHECK: '1' } });
  try {
    await runStartPreflight(box.deps());

    assert.deepEqual(await readdir(box.dir), [], 'aucune configuration ni verrou créés');
    assert.equal(process.env['CCR_CODEX_SKIP_GIT_REPO_CHECK'], undefined, 'environnement intact');
  } finally {
    await box.cleanup();
  }
});
