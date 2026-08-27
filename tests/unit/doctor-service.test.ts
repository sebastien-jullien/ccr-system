/**
 * Tests unitaires de `ccr doctor` (lot V1.1-5, spécification V1.1 §16).
 *
 * Deux propriétés dominent : le diagnostic est **complet** — aucun fail-fast —
 * et **non mutant** sur le domaine CCR.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateStatus, runDoctor, toDisplayPath } from '../../src/services/doctor-service.ts';
import type { DoctorDeps, DoctorFindingCode, DoctorReport } from '../../src/services/doctor-service.ts';
import { formatDoctorReport } from '../../src/cli/doctor-format.ts';
import { CONFIG_FILE_NAME, defaultConfigPath, writeConfig } from '../../src/config/config-store.ts';
import { defaultConfig } from '../../src/config/config-schema.ts';
import { configLockFilePath } from '../../src/lock/config-lock.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { AgentKind } from '../../src/core/run.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const DEAD_PID = 0x7fff_fffe;

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
  readonly probeCalls: AgentKind[];
  deps(over?: Partial<DoctorDeps>): DoctorDeps;
  cleanup(): Promise<void>;
}

async function harness(
  input: { claude?: AgentRuntimeProbe; codex?: AgentRuntimeProbe; env?: NodeJS.ProcessEnv } = {},
): Promise<Harness> {
  const dir = await makeTempDir('ccr-doctor-');
  const configPath = path.join(dir, CONFIG_FILE_NAME);
  const probeCalls: AgentKind[] = [];

  return {
    dir,
    configPath,
    probeCalls,
    deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
      return {
        configPath,
        env: input.env ?? {},
        home: dir,
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
        ...over,
      };
    },
    cleanup: () => removeTempDir(dir),
  };
}

function codes(report: DoctorReport): DoctorFindingCode[] {
  return report.findings.map((finding) => finding.code);
}

// --------------------------------------------------------------------------
// Pureté (1 à 7)
// --------------------------------------------------------------------------

test('(1/2/3/4/5/6) doctor ne modifie rien et n\'exige aucun terminal', async () => {
  const box = await harness();
  try {
    // Aucun TTY n'est fourni, aucun n'est consulté : le lanceur de tests n'en a pas.
    const report = await runDoctor(box.deps());

    assert.equal(report.status, 'READY');
    // Ni configuration créée, ni verrou posé, ni répertoire ~/.ccr.
    assert.deepEqual(await readdir(box.dir), []);
  } finally {
    await box.cleanup();
  }
});

test('(4/5) une configuration et un verrou existants sont laissés intacts', async () => {
  const box = await harness();
  try {
    await writeConfig(
      { ...defaultConfig(), codex: { skip_git_repo_check: true } },
      { configPath: box.configPath },
    );
    await writeFile(
      configLockFilePath(box.configPath),
      JSON.stringify({
        lock_id: 'verrou-temoin',
        pid: DEAD_PID,
        hostname: hostname(),
        created_at: new Date().toISOString(),
        command: 'setup',
      }),
      'utf8',
    );

    const before = await Promise.all(
      [box.configPath, configLockFilePath(box.configPath)].map(async (file) => {
        const info = await stat(file);
        return `${String(info.size)}:${String(info.mtimeMs)}`;
      }),
    );

    await runDoctor(box.deps());

    const after = await Promise.all(
      [box.configPath, configLockFilePath(box.configPath)].map(async (file) => {
        const info = await stat(file);
        return `${String(info.size)}:${String(info.mtimeMs)}`;
      }),
    );
    assert.deepEqual(after, before, 'aucun octet ni horodatage modifié');
  } finally {
    await box.cleanup();
  }
});

test('(3/7) le code de doctor ne peut ni se connecter, ni lire un credential, ni muter un run', async () => {
  const sources = await Promise.all(
    [
      '../../src/services/doctor-service.ts',
      '../../src/cli/doctor-format.ts',
    ].map((relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')),
  );

  for (const source of sources) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const pattern of [
      /loginClaude|loginCodex|runInteractiveProcess/,
      /acquireConfigLock|removeAbandonedConfigLock|unlink|writeConfig|updateConfig/,
      /startRun|createRunDirectory|writeManifest|writeState|appendEvent/,
      // Motifs de code, non de prose : un message a le droit de mentionner
      // qu'un humain devra confirmer quelque chose dans `ccr setup`.
      /\bconfirm\s*\(|createTerminalPrompt|readline/,
      /ANTHROPIC_API_KEY|OPENAI_API_KEY|auth\.json|credentials\.json|keychain/i,
    ]) {
      assert.ok(!pattern.test(code), `motif interdit : ${pattern.source}`);
    }
  }
});

// --------------------------------------------------------------------------
// Classification des agents (8 à 16)
// --------------------------------------------------------------------------

test('(8) tout étant en ordre, le diagnostic est READY sans aucun constat', async () => {
  const box = await harness();
  try {
    const report = await runDoctor(box.deps());

    assert.equal(report.status, 'READY');
    assert.deepEqual(report.findings, []);
    assert.equal(report.config.origin, 'defaults');
    assert.equal(report.configLock.presence, 'ABSENT');
  } finally {
    await box.cleanup();
  }
});

test('(9/10/11/12) classification Claude', async () => {
  const cases: readonly [Partial<AgentRuntimeProbe> | 'absent', DoctorFindingCode, string][] = [
    ['absent', 'CLAUDE_CLI_MISSING', 'BLOCKED'],
    [{ authStatus: 'UNAUTHENTICATED' }, 'CLAUDE_AUTH_REQUIRED', 'BLOCKED'],
    [{ authStatus: 'UNKNOWN' }, 'CLAUDE_AUTH_UNKNOWN', 'ATTENTION'],
    [{ version: null }, 'CLAUDE_VERSION_UNKNOWN', 'ATTENTION'],
  ];

  for (const [over, expectedCode, expectedStatus] of cases) {
    const box = await harness({ claude: over === 'absent' ? ABSENT('claude') : probeOf('claude', over) });
    try {
      const report = await runDoctor(box.deps());

      assert.ok(codes(report).includes(expectedCode), `${expectedCode} attendu`);
      assert.equal(report.status, expectedStatus, expectedCode);
      // Codex reste diagnostiqué : aucun fail-fast.
      assert.equal(report.agents.codex.installed, true);
    } finally {
      await box.cleanup();
    }
  }
});

test('(13/14/15/16) classification Codex, asymétrie comprise', async () => {
  const cases: readonly [Partial<AgentRuntimeProbe> | 'absent', DoctorFindingCode, string][] = [
    ['absent', 'CODEX_CLI_MISSING', 'BLOCKED'],
    // Une absence de connexion OpenAI ne prouve pas l'inexécutabilité.
    [{ authStatus: 'UNAUTHENTICATED' }, 'CODEX_AUTH_NOT_REPORTED', 'ATTENTION'],
    [{ authStatus: 'UNKNOWN' }, 'CODEX_AUTH_UNKNOWN', 'ATTENTION'],
    [{ version: null }, 'CODEX_VERSION_UNKNOWN', 'ATTENTION'],
  ];

  for (const [over, expectedCode, expectedStatus] of cases) {
    const box = await harness({ codex: over === 'absent' ? ABSENT('codex') : probeOf('codex', over) });
    try {
      const report = await runDoctor(box.deps());

      assert.ok(codes(report).includes(expectedCode), `${expectedCode} attendu`);
      assert.equal(report.status, expectedStatus, expectedCode);
    } finally {
      await box.cleanup();
    }
  }
});

test('une CLI absente ne produit qu\'un seul constat, actionnable', async () => {
  const box = await harness({ claude: ABSENT('claude') });
  try {
    const report = await runDoctor(box.deps());

    assert.deepEqual(codes(report), ['CLAUDE_CLI_MISSING'], 'ni version ni auth en cascade');
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Configuration (17 à 22)
// --------------------------------------------------------------------------

test('(17/18) configuration absente puis valide', async () => {
  const box = await harness();
  try {
    const absent = await runDoctor(box.deps());
    assert.equal(absent.config.origin, 'defaults');
    assert.equal(absent.status, 'READY', 'une configuration absente ne bloque pas');
    assert.equal(absent.config.effective?.skipGitRepoCheck, false);
    assert.equal(absent.config.effective?.source, 'default');

    await writeConfig(
      { schema_version: 1, preflight: { offer_interactive_login: false }, codex: { skip_git_repo_check: true } },
      { configPath: box.configPath },
    );

    const present = await runDoctor(box.deps());
    assert.equal(present.config.origin, 'file');
    assert.equal(present.config.preflightOfferInteractiveLogin, false);
    assert.equal(present.config.persistedSkipGitRepoCheck, true);
    assert.equal(present.config.effective?.skipGitRepoCheck, true);
    assert.equal(present.config.effective?.source, 'config');
    assert.equal(present.status, 'READY');
  } finally {
    await box.cleanup();
  }
});

test('(19/20/21/22) une configuration inexploitable bloque sans être réparée', async () => {
  const cases: readonly [string, DoctorFindingCode][] = [
    ['{ "schema_version": 1,', 'CONFIG_INVALID'],
    [JSON.stringify({ ...defaultConfig(), schema_version: 99 }), 'CONFIG_SCHEMA_UNSUPPORTED'],
  ];

  for (const [content, expected] of cases) {
    const box = await harness();
    try {
      await writeFile(box.configPath, content, 'utf8');

      const report = await runDoctor(box.deps());

      assert.equal(report.status, 'BLOCKED', expected);
      assert.ok(codes(report).includes(expected), expected);
      assert.equal(report.config.origin, 'unreadable');
      assert.equal(report.config.error, expected);
      // Ni valeurs par défaut substituées, ni fichier réécrit.
      assert.equal(report.config.persistedSkipGitRepoCheck, undefined);
      assert.equal(report.config.effective, undefined, 'aucune valeur inventée');
      assert.equal(await readFile(box.configPath, 'utf8'), content, 'fichier intact');
      // Les agents restent diagnostiqués.
      assert.equal(report.agents.claude.installed, true);
      assert.equal(report.agents.codex.installed, true);
    } finally {
      await box.cleanup();
    }
  }
});

test('(21) une configuration illisible est distinguée d\'une configuration invalide', async () => {
  const box = await harness();
  try {
    // Un répertoire à la place du document : présent, non lisible.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(box.configPath, { recursive: true });

    const report = await runDoctor(box.deps());

    assert.equal(report.status, 'BLOCKED');
    assert.ok(codes(report).includes('CONFIG_READ_FAILED'));
    assert.equal(report.config.error, 'CONFIG_READ_FAILED');
  } finally {
    await box.cleanup();
  }
});

test('une variable héritée tranche même sans configuration lisible', async () => {
  const box = await harness({ env: { CCR_CODEX_SKIP_GIT_REPO_CHECK: '1' } });
  try {
    await writeFile(box.configPath, 'pas du json', 'utf8');

    const report = await runDoctor(box.deps());

    assert.equal(report.config.error, 'CONFIG_INVALID');
    // Fait vérifiable : la variable décide, indépendamment du fichier.
    assert.equal(report.config.effective?.skipGitRepoCheck, true);
    assert.equal(report.config.effective?.source, 'legacy-env');
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Variable héritée (23 à 26)
// --------------------------------------------------------------------------

test('(23/24/25/26) la variable héritée est signalée sans que sa valeur brute ne circule', async () => {
  const cases: readonly [string | undefined, readonly DoctorFindingCode[], boolean | undefined][] = [
    [undefined, [], undefined],
    ['1', ['LEGACY_ENV_OVERRIDE'], true],
    ['0', ['LEGACY_ENV_NON_CANONICAL', 'LEGACY_ENV_OVERRIDE'], false],
    ['jeton-secret-ABC', ['LEGACY_ENV_NON_CANONICAL', 'LEGACY_ENV_OVERRIDE'], false],
  ];

  for (const [value, expected, effective] of cases) {
    const env = value === undefined ? {} : { CCR_CODEX_SKIP_GIT_REPO_CHECK: value };
    const box = await harness({ env });
    try {
      const report = await runDoctor(box.deps());

      assert.deepEqual(codes(report), [...expected], `valeur ${String(value)}`);
      assert.equal(report.status, expected.length > 0 ? 'ATTENTION' : 'READY');
      if (effective !== undefined) assert.equal(report.config.effective?.skipGitRepoCheck, effective);

      // La valeur brute ne figure ni dans le rapport, ni dans le rendu.
      const serialized = `${JSON.stringify(report)}\n${formatDoctorReport(report)}`;
      if (value !== undefined && value !== '1' && value !== '0') {
        assert.ok(!serialized.includes(value), 'valeur brute absente');
      }
    } finally {
      await box.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Verrou de configuration (27 à 32)
// --------------------------------------------------------------------------

test('(27/28/29/30/31/32) chaque état de verrou est observé, aucun n\'est modifié', async () => {
  const cases: readonly [string, Record<string, unknown> | 'illisible', DoctorFindingCode | undefined][] = [
    ['vivant', { pid: process.pid }, 'CONFIG_LOCK_HELD'],
    ['abandonné', { pid: DEAD_PID }, 'CONFIG_LOCK_STALE'],
    ['autre hôte', { pid: DEAD_PID, hostname: 'une-autre-machine' }, 'CONFIG_LOCK_FOREIGN'],
    ['illisible', 'illisible', 'CONFIG_LOCK_UNREADABLE'],
  ];

  for (const [label, over, expected] of cases) {
    const box = await harness();
    try {
      const lockPath = configLockFilePath(box.configPath);
      if (over === 'illisible') {
        await writeFile(lockPath, '{ "lock_id": ', 'utf8');
      } else {
        await writeFile(
          lockPath,
          JSON.stringify({
            lock_id: 'verrou-temoin',
            pid: DEAD_PID,
            hostname: hostname(),
            created_at: new Date().toISOString(),
            command: 'setup',
            ...over,
          }),
          'utf8',
        );
      }
      const before = await readFile(lockPath, 'utf8');

      const report = await runDoctor(box.deps());

      assert.ok(expected !== undefined && codes(report).includes(expected), label);
      // Un verrou n'est jamais un blocage : il empêche d'écrire, pas de lire.
      assert.equal(report.status, 'ATTENTION', label);
      assert.equal(await readFile(lockPath, 'utf8'), before, `${label} : verrou intact`);
    } finally {
      await box.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Agrégation (33 à 36)
// --------------------------------------------------------------------------

test('(33/34/35) l\'agrégation est déterministe et rapporte tous les constats', async () => {
  assert.equal(aggregateStatus([]), 'READY');
  assert.equal(aggregateStatus([{ code: 'CODEX_AUTH_UNKNOWN', severity: 'ATTENTION' }]), 'ATTENTION');
  assert.equal(
    aggregateStatus([
      { code: 'CODEX_AUTH_UNKNOWN', severity: 'ATTENTION' },
      { code: 'CLAUDE_CLI_MISSING', severity: 'BLOCKER' },
    ]),
    'BLOCKED',
  );

  // Deux blocages et deux attentions simultanés : tous rapportés.
  const box = await harness({
    claude: ABSENT('claude'),
    codex: probeOf('codex', { authStatus: 'UNAUTHENTICATED', version: null }),
    env: { CCR_CODEX_SKIP_GIT_REPO_CHECK: '0' },
  });
  try {
    await writeFile(box.configPath, 'pas du json', 'utf8');

    const report = await runDoctor(box.deps());

    assert.equal(report.status, 'BLOCKED');
    assert.deepEqual(codes(report), [
      'CLAUDE_CLI_MISSING',
      'CONFIG_INVALID',
      'CODEX_AUTH_NOT_REPORTED',
      'CODEX_VERSION_UNKNOWN',
      'LEGACY_ENV_NON_CANONICAL',
      'LEGACY_ENV_OVERRIDE',
    ]);
    // Blocages d'abord, puis attentions : ordre stable.
    assert.deepEqual(
      report.findings.map((finding) => finding.severity),
      ['BLOCKER', 'BLOCKER', 'ATTENTION', 'ATTENTION', 'ATTENTION', 'ATTENTION'],
    );
  } finally {
    await box.cleanup();
  }
});

test('(36) l\'ordre de réponse des sondes n\'influence pas le rapport', async () => {
  const build = async (claudeDelay: number, codexDelay: number): Promise<DoctorReport> => {
    const box = await harness();
    try {
      return await runDoctor(
        box.deps({
          probes: {
            claude: async () => {
              await new Promise((resolve) => setTimeout(resolve, claudeDelay));
              return probeOf('claude', { authStatus: 'UNKNOWN' });
            },
            codex: async () => {
              await new Promise((resolve) => setTimeout(resolve, codexDelay));
              return probeOf('codex', { authStatus: 'UNAUTHENTICATED' });
            },
          },
        }),
      );
    } finally {
      await box.cleanup();
    }
  };

  const claudeFirst = await build(0, 20);
  const codexFirst = await build(20, 0);

  assert.deepEqual(codes(claudeFirst), codes(codexFirst));
  assert.equal(claudeFirst.status, codexFirst.status);
});

// --------------------------------------------------------------------------
// Sanitisation et rendu (37 à 39)
// --------------------------------------------------------------------------

test('(37/38) aucune donnée personnelle ne traverse le rapport ni le rendu', async () => {
  const box = await harness({
    claude: probeOf('claude', { authStatus: 'UNKNOWN', diagnostic: 'AUTH_STATUS_UNRECOGNIZED' }),
  });
  try {
    const report = await runDoctor(box.deps());
    const rendered = formatDoctorReport(report);

    for (const pii of ['temoin.pii@', '@exemple', 'orgId', 'subscriptionType', 'Logged in using']) {
      assert.ok(!JSON.stringify(report).includes(pii), `rapport : ${pii}`);
      assert.ok(!rendered.includes(pii), `rendu : ${pii}`);
    }
    // Le rendu n'expose que des codes fermés et des libellés CCR.
    assert.match(rendered, /Statut : ATTENTION/);
    assert.match(rendered, /\[CLAUDE_AUTH_UNKNOWN\]/);
  } finally {
    await box.cleanup();
  }
});

test('(39) le chemin de configuration est rendu relatif à la racine personnelle', async () => {
  const home = path.join('/maison', 'alice');
  assert.equal(toDisplayPath(path.join(home, '.ccr', 'config.json'), home), '~/.ccr/config.json');
  assert.equal(toDisplayPath(path.join('/ailleurs', 'config.json'), home), path.join('/ailleurs', 'config.json'));

  // Le chemin par défaut réel ne divulgue pas l'identifiant utilisateur.
  const displayed = toDisplayPath(defaultConfigPath());
  assert.match(displayed, /^~[\\/]\.ccr[\\/]config\.json$/);
});

// --------------------------------------------------------------------------
// `ccr doctor <run_id>` (lot V1.1-7, §16.4)
// --------------------------------------------------------------------------

async function runWithSnapshot(
  runsDir: string,
  cwd: string,
  snapshot: Record<string, unknown> | undefined,
): Promise<string> {
  const { startRun } = await import('../../src/services/run-service.ts');
  const { createFakeAdapter } = await import('../helpers/fake-adapter.ts');
  const { TEST_RUNTIME_CONFIG } = await import('../helpers/runtime-config.ts');
  const { demoteToLegacyManifest } = await import('../helpers/legacy-run.ts');
  const adapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
  };
  const result = await startRun(
    { runsDir, now: () => new Date(), createAdapters: () => adapters },
    {
      title: 'T',
      cwd,
      prompt: 'p',
      runtimeConfig: (snapshot ?? TEST_RUNTIME_CONFIG) as never,
    },
  );
  // `undefined` demande un run V1 historique : il n'est plus créable, il est
  // fabriqué comme fixture disque (V2-IMP-28).
  if (snapshot === undefined) await demoteToLegacyManifest(runsDir, result.runId);
  return result.runId;
}

const SNAPSHOT = {
  schema_version: 1,
  captured_at: '2026-08-08T03:00:00.000Z',
  claude: { cli_version: '2.1.224', auth_preflight: 'AUTHENTICATED' },
  codex: {
    cli_version: '0.146.0',
    auth_preflight: 'AUTHENTICATED',
    skip_git_repo_check: true,
    source_at_capture: 'config',
  },
};

test('(40) un run pinné nominal est rapporté sans constat superflu', async () => {
  const box = await harness();
  try {
    const runsDir = path.join(box.dir, 'runs');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(runsDir, { recursive: true });
    await writeConfig(
      { ...defaultConfig(), codex: { skip_git_repo_check: true } },
      { configPath: box.configPath },
    );
    const runId = await runWithSnapshot(runsDir, box.dir, SNAPSHOT);

    const report = await runDoctor(box.deps({ runId, runsDir }));

    assert.equal(report.status, 'READY');
    assert.equal(report.run?.runtimeConfigMode, 'PINNED');
    assert.equal(report.run?.skipGitRepoCheck, true);
    assert.equal(report.run?.capturedAt, '2026-08-08T03:00:00.000Z');
    assert.equal(report.run?.claudeVersionAtStart, '2.1.224');
    assert.equal(report.run?.globalSkipGitRepoCheck, true);
    assert.deepEqual(codes(report), []);
    // Le mode global reste intact lorsqu'aucun run n'est demandé.
    assert.equal((await runDoctor(box.deps())).run, undefined);
  } finally {
    await box.cleanup();
  }
});

test('(41/42/43) versions et configuration divergentes sont des attentions, jamais des blocages', async () => {
  const box = await harness({
    claude: probeOf('claude', { version: '2.9.9' }),
    codex: probeOf('codex', { version: '0.999.0' }),
  });
  try {
    const runsDir = path.join(box.dir, 'runs');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(runsDir, { recursive: true });
    // Configuration globale contraire au snapshot du run.
    await writeConfig(
      { ...defaultConfig(), codex: { skip_git_repo_check: false } },
      { configPath: box.configPath },
    );
    const runId = await runWithSnapshot(runsDir, box.dir, SNAPSHOT);

    const report = await runDoctor(box.deps({ runId, runsDir }));

    assert.equal(report.status, 'ATTENTION', 'une mise à jour de CLI ne condamne pas un run');
    for (const expected of ['CLAUDE_VERSION_CHANGED', 'CODEX_VERSION_CHANGED', 'RUN_CONFIG_DIFFERS_FROM_GLOBAL']) {
      assert.ok(codes(report).includes(expected as never), expected);
    }
    // Le run conserve sa valeur ; la globale n'est que comparative.
    assert.equal(report.run?.skipGitRepoCheck, true);
    assert.equal(report.run?.globalSkipGitRepoCheck, false);
  } finally {
    await box.cleanup();
  }
});

test('(45) un run legacy est signalé sans être migré', async () => {
  const box = await harness();
  try {
    const runsDir = path.join(box.dir, 'runs');
    const { mkdir, readFile } = await import('node:fs/promises');
    await mkdir(runsDir, { recursive: true });
    const runId = await runWithSnapshot(runsDir, box.dir, undefined);
    const { runPaths } = await import('../../src/store/layout.ts');
    const manifestPath = runPaths(runsDir, runId).manifest;
    const before = await readFile(manifestPath, 'utf8');

    const report = await runDoctor(box.deps({ runId, runsDir }));

    assert.equal(report.status, 'ATTENTION');
    assert.ok(codes(report).includes('RUNTIME_CONFIG_UNPINNED'));
    assert.equal(report.run?.runtimeConfigMode, 'LEGACY_UNPINNED');
    // La résolution qui s'appliquerait est affichée, distincte d'un snapshot.
    assert.equal(report.run?.skipGitRepoCheck, undefined);
    assert.equal(report.run?.globalSkipGitRepoCheck, false);
    assert.equal(await readFile(manifestPath, 'utf8'), before, 'aucune migration');
  } finally {
    await box.cleanup();
  }
});

test('(46) un snapshot invalide bloque, et n\'est jamais confondu avec une absence', async () => {
  const box = await harness();
  try {
    const runsDir = path.join(box.dir, 'runs');
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    await mkdir(runsDir, { recursive: true });
    const runId = await runWithSnapshot(runsDir, box.dir, SNAPSHOT);

    const { runPaths } = await import('../../src/store/layout.ts');
    const manifestPath = runPaths(runsDir, runId).manifest;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        runtime_config: { ...SNAPSHOT, codex: { ...SNAPSHOT.codex, skip_git_repo_check: 'oui' } },
      }),
      'utf8',
    );

    const report = await runDoctor(box.deps({ runId, runsDir }));

    assert.equal(report.status, 'BLOCKED');
    assert.ok(codes(report).includes('RUNTIME_CONFIG_INVALID'));
    assert.equal(report.run?.runtimeConfigMode, 'INVALID');
    assert.ok(!codes(report).includes('RUNTIME_CONFIG_UNPINNED'), 'jamais requalifié en legacy');
  } finally {
    await box.cleanup();
  }
});

test('(47/48) un run absent échoue en RUN_NOT_FOUND, et rien n\'est modifié', async () => {
  const box = await harness();
  try {
    const runsDir = path.join(box.dir, 'runs');
    const { mkdir, readdir } = await import('node:fs/promises');
    await mkdir(runsDir, { recursive: true });

    await assert.rejects(
      runDoctor(box.deps({ runId: 'CCR-20260101-001', runsDir })),
      (error: unknown) => isCcrError(error) && error.code === 'RUN_NOT_FOUND',
    );
    assert.deepEqual(await readdir(runsDir), [], 'aucun run fabriqué');
  } finally {
    await box.cleanup();
  }
});

test('(10) doctor rapporte la provenance comme un fait historique, jamais comme une autorite', async () => {
  const box = await harness();
  try {
    const runsDir = path.join(box.dir, 'runs');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(runsDir, { recursive: true });
    await writeConfig(
      { ...defaultConfig(), codex: { skip_git_repo_check: false } },
      { configPath: box.configPath },
    );
    // Snapshot dissonant : provenance `legacy-env`, valeur `true`, globale `false`.
    const runId = await runWithSnapshot(runsDir, box.dir, {
      ...SNAPSHOT,
      codex: { ...SNAPSHOT.codex, source_at_capture: 'legacy-env' },
    });

    const report = await runDoctor(box.deps({ runId, runsDir }));
    const rendered = formatDoctorReport(report);

    assert.equal(report.run?.sourceAtCapture, 'legacy-env');
    // La valeur exécutable reste celle du snapshot, non celle de la provenance.
    assert.equal(report.run?.skipGitRepoCheck, true);
    assert.equal(report.run?.globalSkipGitRepoCheck, false);

    // Le libellé est explicitement historique.
    assert.match(rendered, /Source à la capture\s+legacy-env/);
    assert.ok(!/Source actuelle|Current source/i.test(rendered), 'jamais présentée comme actuelle');
  } finally {
    await box.cleanup();
  }
});
