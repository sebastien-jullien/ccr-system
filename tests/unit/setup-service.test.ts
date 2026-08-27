/**
 * Tests unitaires de `ccr setup` (lot V1.1-4, spécification V1.1 §15).
 *
 * Périmètre : l'**orchestration** — ce qui est demandé, dans quel ordre, ce qui
 * est écrit, ce qui est conclu. Les probes et la connexion sont éprouvés pour
 * eux-mêmes aux lots précédents ; ils sont ici injectés afin que chaque
 * scénario reste déterministe.
 *
 * Un test câble néanmoins les implémentations réelles sur des fixtures, pour
 * qu'un défaut de branchement ne puisse pas passer inaperçu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSetup } from '../../src/services/setup-service.ts';
import type { SetupDeps, SetupIo, SetupResult } from '../../src/services/setup-service.ts';
import { formatConfirmQuestion, interpretConfirmAnswer } from '../../src/cli/prompt.ts';
import { CONFIG_FILE_NAME, readConfig, writeConfig } from '../../src/config/config-store.ts';
import { defaultConfig } from '../../src/config/config-schema.ts';
import type { CcrConfig } from '../../src/config/config-schema.ts';
import { acquireConfigLock, configLockFilePath, readConfigLock } from '../../src/lock/config-lock.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { AgentLoginOptions, LoginOutcome } from '../../src/runtime/agent-login.ts';
import type { AgentKind } from '../../src/core/run.ts';
import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const TTY = { stdin: true, stdout: true } as const;
/** PID libre avec quasi-certitude. */
const DEAD_PID = 0x7fff_fffe;

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface Recorder extends SetupIo {
  readonly lines: string[];
  readonly questions: string[];
  text(): string;
}

/** `answers` est une file ; épuisée, elle répond NON — comme un simple Enter. */
function recorder(answers: readonly (boolean | (() => boolean | Promise<boolean>))[] = []): Recorder {
  const lines: string[] = [];
  const questions: string[] = [];
  const queue = [...answers];

  return {
    lines,
    questions,
    out: (text: string) => lines.push(text),
    async confirm(question: string): Promise<boolean> {
      questions.push(question);
      const next = queue.shift();
      if (next === undefined) return false;
      return typeof next === 'function' ? await next() : next;
    },
    text: () => lines.join('\n'),
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
  readonly io: Recorder;
  readonly probeCalls: AgentKind[];
  readonly loginCalls: { agent: AgentKind; options: AgentLoginOptions }[];
  deps(over?: Partial<SetupDeps>): SetupDeps;
  config(): Promise<CcrConfig>;
  cleanup(): Promise<void>;
}

interface HarnessInput {
  readonly claude?: AgentRuntimeProbe;
  readonly codex?: AgentRuntimeProbe;
  readonly answers?: readonly (boolean | (() => boolean | Promise<boolean>))[];
  readonly loginClaude?: (options: AgentLoginOptions) => Promise<LoginOutcome>;
  readonly loginCodex?: (options: AgentLoginOptions) => Promise<LoginOutcome>;
  readonly env?: NodeJS.ProcessEnv;
}

async function harness(input: HarnessInput = {}): Promise<Harness> {
  const dir = await makeTempDir('ccr-setup-');
  const configPath = path.join(dir, CONFIG_FILE_NAME);
  const io = recorder(input.answers);
  const probeCalls: AgentKind[] = [];
  const loginCalls: { agent: AgentKind; options: AgentLoginOptions }[] = [];

  const makeLogin =
    (agent: AgentKind, custom?: (options: AgentLoginOptions) => Promise<LoginOutcome>) =>
    async (options: AgentLoginOptions): Promise<LoginOutcome> => {
      loginCalls.push({ agent, options });
      if (custom !== undefined) return custom(options);
      return { status: 'LOGIN_COMPLETED', probe: probeOf(agent) };
    };

  return {
    dir,
    configPath,
    io,
    probeCalls,
    loginCalls,
    deps(over: Partial<SetupDeps> = {}): SetupDeps {
      return {
        io,
        tty: TTY,
        configPath,
        env: input.env ?? {},
        probes: {
          claude: async () => {
            probeCalls.push('claude');
            return input.claude ?? probeOf('claude');
          },
          codex: async () => {
            probeCalls.push('codex');
            return input.codex ?? probeOf('codex');
          },
        },
        logins: {
          claude: makeLogin('claude', input.loginClaude),
          codex: makeLogin('codex', input.loginCodex),
        },
        ...over,
      };
    },
    async config(): Promise<CcrConfig> {
      return (await readConfig({ configPath })).config;
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
// Terminal (1/2/3)
// --------------------------------------------------------------------------

test('(1/2) sans terminal, setup n\'a strictement aucun effet', async () => {
  for (const tty of [
    { stdin: false, stdout: true },
    { stdin: true, stdout: false },
    { stdin: false, stdout: false },
  ]) {
    const box = await harness();
    try {
      await expectCcrError(
        runSetup(box.deps({ tty })),
        'INTERACTIVE_TTY_REQUIRED',
        `tty=${JSON.stringify(tty)}`,
      );

      assert.deepEqual(box.probeCalls, [], 'aucun agent sondé');
      assert.deepEqual(box.loginCalls, [], 'aucune connexion');
      assert.deepEqual(box.io.questions, [], 'aucune invite');
      assert.deepEqual(await readdir(box.dir), [], 'ni configuration, ni verrou');
    } finally {
      await box.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Diagnostic (4 à 10)
// --------------------------------------------------------------------------

test('(4/19/22) deux agents authentifiés : setup prêt et configuration créée', async () => {
  const box = await harness();
  try {
    const result = await runSetup(box.deps());

    assert.equal(result.status, 'READY');
    assert.deepEqual(result.attentions, []);
    assert.deepEqual(box.loginCalls, [], 'aucune connexion proposée ni lancée');
    // Une seule question : la préférence Codex hors Git.
    assert.equal(box.io.questions.length, 1);
    assert.match(box.io.questions[0] ?? '', /hors d'un dépôt Git/);

    assert.deepEqual(await box.config(), defaultConfig());
    assert.deepEqual(await readdir(box.dir), [CONFIG_FILE_NAME], 'aucun run, aucun verrou résiduel');
    assert.match(box.io.text(), /2\.1\.224/);
    assert.match(box.io.text(), /0\.146\.0/);
  } finally {
    await box.cleanup();
  }
});

test('(5/6) une CLI absente est rapportée sans proposer ni installer quoi que ce soit', async () => {
  for (const missing of ['claude', 'codex'] as const) {
    const box = await harness({ [missing]: ABSENT(missing) } as HarnessInput);
    try {
      const result = await runSetup(box.deps());

      assert.equal(result.status, 'INCOMPLETE', missing);
      assert.ok(
        result.attentions.includes(missing === 'claude' ? 'CLAUDE_NOT_INSTALLED' : 'CODEX_NOT_INSTALLED'),
        missing,
      );
      // Le diagnostic de l'autre fournisseur a tout de même été produit.
      assert.deepEqual(box.probeCalls, ['claude', 'codex'], 'diagnostic complet en une exécution');
      assert.deepEqual(box.loginCalls, [], 'aucune connexion pour une CLI absente');
      assert.match(box.io.text(), /absent — CCR n'installe rien/);
      assert.ok(!/install(er|ation) automatique|npm install/i.test(box.io.text()));
    } finally {
      await box.cleanup();
    }
  }
});

test('(8/10) un statut indéterminé n\'est jamais présenté comme une déconnexion', async () => {
  const box = await harness({
    claude: probeOf('claude', { authStatus: 'UNKNOWN', diagnostic: 'AUTH_STATUS_UNRECOGNIZED' }),
    codex: probeOf('codex', { authStatus: 'UNKNOWN', diagnostic: 'PROVIDER_CONFIG_ERROR' }),
  });
  try {
    const result = await runSetup(box.deps());

    assert.equal(result.status, 'INCOMPLETE');
    assert.ok(result.attentions.includes('CLAUDE_AUTH_UNKNOWN'));
    assert.ok(result.attentions.includes('CODEX_AUTH_UNKNOWN'));

    // §15.6 autorise une proposition sans l'imposer : CCR reste conservateur.
    assert.deepEqual(box.loginCalls, [], 'aucune connexion proposée sur un statut indéterminé');
    assert.equal(box.io.questions.length, 1, 'seule la préférence Codex est demandée');
    assert.match(box.io.text(), /indéterminé/);
    assert.ok(!/non authentifié/.test(box.io.text()), 'jamais requalifié en déconnecté');
  } finally {
    await box.cleanup();
  }
});

test('(9) le texte Codex ne prétend jamais que Codex est inexécutable', async () => {
  const box = await harness({ codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED' }) });
  try {
    await runSetup(box.deps());

    assert.match(box.io.text(), /aucune connexion OpenAI active/);
    assert.match(box.io.text(), /autre configuration fournisseur peut néanmoins être utilisable/);
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Consentement de connexion (11 à 15)
// --------------------------------------------------------------------------

test('(11) un refus de connexion ne lance aucun login', async () => {
  const box = await harness({
    claude: probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
    codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED' }),
    // File vide : chaque invite reçoit un simple Enter.
  });
  try {
    const result = await runSetup(box.deps());

    assert.deepEqual(box.loginCalls, [], 'aucune connexion sans oui explicite');
    assert.equal(result.status, 'INCOMPLETE');
    assert.ok(result.attentions.includes('CLAUDE_UNAUTHENTICATED'));
    assert.ok(result.attentions.includes('CODEX_UNAUTHENTICATED'));
    assert.equal(box.io.questions.length, 3, 'Claude, Codex, puis la préférence');
  } finally {
    await box.cleanup();
  }
});

test('(12/13/15) un oui explicite délègue au service de connexion et adopte son probe', async () => {
  const box = await harness({
    claude: probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
    codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED' }),
    answers: [true, true, false],
  });
  try {
    const result = await runSetup(box.deps());

    assert.deepEqual(box.loginCalls.map((call) => call.agent), ['claude', 'codex']);
    for (const call of box.loginCalls) {
      assert.equal(call.options.consentGranted, true, 'consentement transmis explicitement');
      assert.deepEqual(call.options.tty, TTY, 'état du terminal transmis');
    }

    // L'état final est celui du probe rendu par la connexion, pas une supposition.
    assert.equal(result.claude.authStatus, 'AUTHENTICATED');
    assert.equal(result.codex.authStatus, 'AUTHENTICATED');
    assert.equal(result.status, 'READY');
    assert.deepEqual(result.attentions, []);
  } finally {
    await box.cleanup();
  }
});

test('(14) un échec de connexion laisse le setup incomplet, sans fausse réussite', async () => {
  const box = await harness({
    claude: probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
    answers: [true, false],
    loginClaude: async () => {
      throw new CcrError('AUTH_LOGIN_FAILED', 'connexion refusée par le fournisseur', {
        details: { agent: 'claude', reason: 'POST_PROBE_NOT_AUTHENTICATED' },
      });
    },
  });
  try {
    const result = await runSetup(box.deps());

    assert.equal(result.status, 'INCOMPLETE');
    assert.ok(result.attentions.includes('CLAUDE_LOGIN_FAILED'));
    assert.equal(result.claude.authStatus, 'UNAUTHENTICATED', 'aucun état inventé');
    // Diagnostic normalisé, jamais la sortie du fournisseur.
    assert.match(box.io.text(), /POST_PROBE_NOT_AUTHENTICATED/);
    // …et la préférence locale est tout de même persistée.
    assert.equal((await box.config()).codex.skip_git_repo_check, false);
  } finally {
    await box.cleanup();
  }
});

test('une connexion qui aboutit sans authentifier ne rend pas le setup prêt', async () => {
  const box = await harness({
    claude: probeOf('claude', { authStatus: 'UNAUTHENTICATED' }),
    answers: [true, false],
    loginClaude: async () => ({
      status: 'LOGIN_COMPLETED',
      probe: probeOf('claude', { authStatus: 'UNKNOWN' }),
    }),
  });
  try {
    const result = await runSetup(box.deps());

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.claude.authStatus, 'UNKNOWN');
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Primitive de confirmation (16/17/18)
// --------------------------------------------------------------------------

test('(16/17/18) aucune réponse inconnue ne vaut oui', () => {
  for (const yes of ['y', 'Y', 'yes', 'YES', ' y ', 'Yes']) {
    assert.equal(interpretConfirmAnswer(yes), true, JSON.stringify(yes));
  }
  for (const no of ['', ' ', '\n', 'n', 'N', 'no', 'oui', 'o', 'true', '1', 'yep', 'y!', 'yy']) {
    assert.equal(interpretConfirmAnswer(no), false, JSON.stringify(no));
  }
  // Le défaut NON est visible dans la question elle-même.
  assert.match(formatConfirmQuestion('Continuer ?'), /\[y\/N\]/);
});

// --------------------------------------------------------------------------
// Configuration (19 à 25)
// --------------------------------------------------------------------------

test('(21/23/24) une configuration existante est modifiée, jamais remplacée', async () => {
  const box = await harness({ answers: [true] });
  try {
    // Valeur qu'aucun écran de setup ne propose de modifier.
    await writeConfig(
      { ...defaultConfig(), preflight: { offer_interactive_login: false } },
      { configPath: box.configPath },
    );

    await runSetup(box.deps());

    const config = await box.config();
    assert.equal(config.preflight.offer_interactive_login, false, 'valeur non demandée conservée');
    assert.equal(config.codex.skip_git_repo_check, true, 'préférence choisie enregistrée');
  } finally {
    await box.cleanup();
  }
});

test('(16/22) un simple Enter ne retire pas silencieusement une autorisation existante', async () => {
  const box = await harness();
  try {
    await writeConfig(
      { ...defaultConfig(), codex: { skip_git_repo_check: true } },
      { configPath: box.configPath },
    );

    await runSetup(box.deps());

    // Le défaut reste NON — mais la conséquence est annoncée avant la question.
    assert.match(box.io.text(), /Réglage actuel : autorisé\. Répondre non retirera cette autorisation\./);
    assert.equal((await box.config()).codex.skip_git_repo_check, false);
  } finally {
    await box.cleanup();
  }
});

test('(25) une écriture impossible ne corrompt pas la configuration existante', async () => {
  const box = await harness({ answers: [true] });
  try {
    const existing: CcrConfig = { ...defaultConfig(), codex: { skip_git_repo_check: true } };
    await writeConfig(existing, { configPath: box.configPath });

    // Un autre processus détient le verrou : l'écriture ne peut pas avoir lieu.
    const holder = await acquireConfigLock(box.configPath, 'setup');
    try {
      await expectCcrError(runSetup(box.deps()), 'CONFIG_BUSY', 'écriture concurrente');
      assert.deepEqual(await box.config(), existing, 'configuration précédente intacte');
    } finally {
      await holder.release();
    }
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Variable historique (26 à 29)
// --------------------------------------------------------------------------

test('(26/27/28/29) la variable historique est signalée sans être ni modifiée ni obéie à l\'écriture', async () => {
  const cases: readonly [string | undefined, boolean, RegExp][] = [
    [undefined, false, /^$/],
    ['1', true, /impose actuellement : autorisé/],
    ['0', true, /impose actuellement : non autorisé/],
    ['true', true, /seule la valeur exacte "1"/],
  ];

  for (const [value, expectAttention, pattern] of cases) {
    const env = value === undefined ? {} : { CCR_CODEX_SKIP_GIT_REPO_CHECK: value };
    const box = await harness({ env, answers: [true] });
    try {
      const result = await runSetup(box.deps());

      assert.equal(
        result.attentions.includes('LEGACY_ENV_OVERRIDE'),
        expectAttention,
        `valeur ${String(value)}`,
      );
      if (expectAttention) assert.match(box.io.text(), pattern, `valeur ${String(value)}`);

      // La préférence choisie est persistée quoi qu'il arrive : elle prendra
      // effet lorsque la variable ne sera plus là.
      assert.equal((await box.config()).codex.skip_git_repo_check, true, `valeur ${String(value)}`);
      // L'environnement du processus n'est jamais touché.
      assert.equal(process.env['CCR_CODEX_SKIP_GIT_REPO_CHECK'], undefined);
    } finally {
      await box.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Verrou de configuration (30 à 37)
// --------------------------------------------------------------------------

async function writeLock(configPath: string, over: Record<string, unknown>): Promise<void> {
  await writeFile(
    configLockFilePath(configPath),
    JSON.stringify({
      lock_id: 'verrou-fixture',
      pid: DEAD_PID,
      hostname: hostname(),
      created_at: new Date().toISOString(),
      command: 'setup',
      ...over,
    }),
    'utf8',
  );
}

test('(30/31/32) un verrou vivant, étranger ou illisible bloque sans jamais proposer sa suppression', async () => {
  const cases: readonly [string, Record<string, unknown> | 'illisible'][] = [
    ['vivant', { pid: process.pid }],
    ['autre hôte', { hostname: 'une-autre-machine' }],
    ['illisible', 'illisible'],
  ];

  for (const [label, over] of cases) {
    const box = await harness({ answers: [true] });
    try {
      if (over === 'illisible') {
        await writeFile(configLockFilePath(box.configPath), '{ "lock_id": ', 'utf8');
      } else {
        await writeLock(box.configPath, over);
      }
      const before = await readFile(configLockFilePath(box.configPath), 'utf8');

      await expectCcrError(runSetup(box.deps()), 'CONFIG_BUSY', label);

      assert.ok(
        !box.io.questions.some((question) => /supprimer/i.test(question)),
        `${label} : aucune proposition de suppression`,
      );
      assert.equal(await readFile(configLockFilePath(box.configPath), 'utf8'), before, `${label} : verrou intact`);
    } finally {
      await box.cleanup();
    }
  }
});

test('(33/34) un verrou abandonné est signalé, et un refus le laisse en place', async () => {
  const box = await harness({ answers: [false] });
  try {
    await writeLock(box.configPath, {});
    await expectCcrError(runSetup(box.deps()), 'CONFIG_BUSY', 'suppression refusée');

    assert.ok(
      box.io.questions.some((question) => /supprimer/i.test(question)),
      'la suppression a bien été proposée',
    );
    assert.match(box.io.text(), /verrou de configuration abandonné/i);
    assert.equal((await readConfigLock(box.configPath))?.lock_id, 'verrou-fixture', 'verrou intact');
  } finally {
    await box.cleanup();
  }
});

test('(35/37) un consentement explicite supprime ce seul verrou puis réacquiert', async () => {
  const box = await harness({ answers: [true, true] });
  try {
    await writeLock(box.configPath, {});

    const result = await runSetup(box.deps());

    assert.equal(result.status, 'READY');
    assert.equal(await readConfigLock(box.configPath), undefined, 'verrou supprimé');
    assert.equal((await box.config()).codex.skip_git_repo_check, true, 'écriture aboutie');
    assert.deepEqual(await readdir(box.dir), [CONFIG_FILE_NAME], 'aucun verrou résiduel');
  } finally {
    await box.cleanup();
  }
});

test('(36) un verrou remplacé entre la question et l\'action n\'est jamais supprimé', async () => {
  const box = await harness();
  try {
    await writeLock(box.configPath, {});

    // Entre l'invite et la réponse, un autre processus prend le verrou.
    const deps = box.deps({
      io: {
        out: box.io.out,
        confirm: async (question: string): Promise<boolean> => {
          box.io.questions.push(question);
          if (/supprimer/i.test(question)) {
            await writeLock(box.configPath, { lock_id: 'nouveau-proprietaire', pid: process.pid });
            return true;
          }
          return true;
        },
      },
    });

    await expectCcrError(runSetup(deps), 'CONFIG_BUSY', 'identité changée');

    assert.equal(
      (await readConfigLock(box.configPath))?.lock_id,
      'nouveau-proprietaire',
      "le verrou d'autrui est intact",
    );
    assert.match(box.io.text(), /a changé entre-temps/);
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Absence d'effet de bord (38 à 42)
// --------------------------------------------------------------------------

test('(38/39/40/41/42) setup ne touche ni aux runs, ni aux credentials, ni aux fournisseurs', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src/services/setup-service.ts', import.meta.url)),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const pattern of [
    /startRun|createRunDirectory|runsDir|writeManifest|writeState|appendEvent/,
    /logout/i,
    /npm install|winget|choco|brew install/i,
    /runProcess|runInteractiveProcess|spawn/,
    /ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|auth\.json|credentials\.json|keychain/i,
  ]) {
    assert.ok(!pattern.test(code), `motif interdit : ${pattern.source}`);
  }

  // Les seuls fournisseurs joignables le sont par les probes et la connexion.
  assert.match(source, /probeClaudeRuntime|probeCodexRuntime/);
  assert.match(source, /loginClaude|loginCodex/);
});

// --------------------------------------------------------------------------
// Branchement réel des implémentations par défaut
// --------------------------------------------------------------------------

const RUNTIME_FIXTURE = fileURLToPath(new URL('../fixtures/fake-claude-runtime.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('../fixtures/fake-codex-runtime.mjs', import.meta.url));

test('les probes réels sont câblés par défaut', async () => {
  const box = await harness({ answers: [false] });
  try {
    // Aucune implémentation injectée : ce sont `probeClaudeRuntime` et
    // `probeCodexRuntime` qui s'exécutent, sur des fixtures.
    const result: SetupResult = await runSetup({
      io: box.io,
      tty: TTY,
      configPath: box.configPath,
      env: {},
      agentOptions: {
        claude: {
          cwd: box.dir,
          timeoutMs: 20_000,
          launcher: { executable: process.execPath, prefixArgs: [RUNTIME_FIXTURE], source: 'test-fixture' },
          env: { ...process.env, FAKE_CLAUDE_RUNTIME_MODE: 'ok' },
        },
        codex: {
          cwd: box.dir,
          timeoutMs: 20_000,
          launcher: { executable: process.execPath, prefixArgs: [CODEX_FIXTURE], source: 'test-fixture' },
          env: { ...process.env, FAKE_CODEX_RUNTIME_MODE: 'ok' },
        },
      },
    });

    assert.equal(result.status, 'READY');
    assert.equal(result.claude.version, '2.1.224');
    assert.equal(result.codex.version, '0.146.0');
    // Aucune donnée personnelle de la sortie réelle ne remonte.
    assert.ok(!box.io.text().includes('@'), 'aucune adresse e-mail affichée');
  } finally {
    await box.cleanup();
  }
});
