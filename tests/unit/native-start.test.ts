/**
 * Slice 1C — Native START & Session Initialization.
 *
 * Premier gate où un service métier exécute réellement
 * `ExpertSlot → ProviderBinding → NativeSession`.
 *
 * Quatre propriétés qu'un START provider-driven ne peut pas satisfaire :
 *
 *   1. l'ordre des appels suit les slots, pas les moteurs ;
 *   2. deux experts sur le même moteur obtiennent deux continuités distinctes,
 *      et une collision est un échec fermé ;
 *   3. un moteur qu'aucun slot n'emploie n'est ni sondé, ni bloquant, ni observé ;
 *   4. le curseur d'alternance n'existe qu'après une initialisation complète.
 *
 * Aucun fournisseur réel n'est invoqué : tous les adapters sont des fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../../src/core/run-native.ts';
import type { NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import {
  DEFAULT_NATIVE_BINDINGS,
  buildNativeRuntimeConfig,
  requiredProviders,
  startNativeRun,
  startNativeRunWithPreflight,
} from '../../src/services/native-start-service.ts';
import type {
  NativeExpertBindings,
  NativeStartApplicationDeps,
} from '../../src/services/native-start-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { startRun } from '../../src/services/run-service.ts';
import { runNativeStartPreflight } from '../../src/runtime/preflight-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readJsonFile } from '../../src/store/atomic-file.ts';
import { openNativeEventStore, openRunEventStore } from '../../src/store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const PROMPT = 'Mission initiale : évaluer la refonte.';

function expectCcrCode(error: unknown, code: CcrErrorCode, what: string): void {
  assert.ok(isCcrError(error) && error.code === code, `${what} — reçu ${String(error)}`);
}

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  /** Ordre réel des appels `start()`, tous moteurs confondus. */
  readonly callOrder: { provider: ProviderKind; prompt: string }[];
}

interface HarnessOptions {
  readonly claudeSessions?: readonly string[];
  readonly codexSessions?: readonly string[];
  readonly failClaude?: () => unknown;
  readonly failCodex?: () => unknown;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  const callOrder: { provider: ProviderKind; prompt: string }[] = [];

  const build = (kind: ProviderKind, sessions: readonly string[] | undefined, fail?: () => unknown): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: sessions ?? [`${kind}-1`, `${kind}-2`],
      onCall: (phase, prompt) => {
        if (phase === 'start') callOrder.push({ provider: kind, prompt });
      },
      ...(fail === undefined ? {} : { failStart: fail }),
    });

  const adapters = {
    claude: build('claude', options.claudeSessions, options.failClaude),
    codex: build('codex', options.codexSessions, options.failCodex),
  };

  return {
    runsDir,
    adapters,
    callOrder,
    deps: {
      runsDir,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
      createAdapters: (): AgentAdapters => adapters,
    },
  };
}

function nativeRuntime(bindings: NativeExpertBindings): NativeRunRuntimeConfig {
  const used = requiredProviders(bindings);
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: '2026-08-10T00:00:00.000Z',
    claude: used.has('claude')
      ? { required: true, probe_status: 'OBSERVED', cli_version: '2.1.224', auth_preflight: 'AUTHENTICATED' }
      : { required: false, probe_status: 'NOT_REQUIRED' },
    codex: used.has('codex')
      ? {
          required: true,
          probe_status: 'OBSERVED',
          cli_version: '0.146.0',
          auth_preflight: 'AUTHENTICATED',
          skip_git_repo_check: false,
          source_at_capture: 'default',
        }
      : { required: false, probe_status: 'NOT_REQUIRED' },
  };
}

const PERMUTATIONS: readonly { readonly bindings: NativeExpertBindings; readonly order: readonly ProviderKind[] }[] = [
  { bindings: { author: 'codex', challenger: 'claude' }, order: ['codex', 'claude'] },
  { bindings: { author: 'claude', challenger: 'codex' }, order: ['claude', 'codex'] },
  { bindings: { author: 'claude', challenger: 'claude' }, order: ['claude', 'claude'] },
  { bindings: { author: 'codex', challenger: 'codex' }, order: ['codex', 'codex'] },
];

function label(bindings: NativeExpertBindings): string {
  return `author=${bindings.author} challenger=${bindings.challenger}`;
}

// ==========================================================================
// A. Quatre permutations
// ==========================================================================

test('A1–A4 · les quatre permutations démarrent dans l’ordre AUTHOR puis CHALLENGER', async () => {
  for (const { bindings, order } of PERMUTATIONS) {
    const dir = await makeTempDir('ccr-1c-perm-');
    try {
      const h = harness(path.join(dir, 'runs'));
      const result = await startNativeRun(h.deps, {
        title: 'T',
        cwd: dir,
        prompt: PROMPT,
        bindings,
        runtimeConfig: nativeRuntime(bindings),
      });

      assert.equal(result.failure, undefined, label(bindings));

      // L'ordre vient des slots, jamais d'une convention claude-puis-codex.
      assert.deepEqual(h.callOrder.map((call) => call.provider), [...order], `${label(bindings)} · ordre`);
      assert.deepEqual(
        result.positions.map((position) => position.slot),
        ['author', 'challenger'],
        `${label(bindings)} · slots`,
      );

      // Bindings, sessions et versions relus depuis le disque.
      const persisted = await readPersistedManifest(runPaths(h.runsDir, result.runId));
      assert.equal(persisted.execution_mode, 'NATIVE_V21_EXECUTION');
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return;
      assert.equal(persisted.manifest.schema_version, NATIVE_MANIFEST_SCHEMA_VERSION);
      assert.equal(persisted.manifest.experts.author.provider, bindings.author);
      assert.equal(persisted.manifest.experts.challenger.provider, bindings.challenger);
      assert.notEqual(
        persisted.manifest.experts.author.session_id,
        persisted.manifest.experts.challenger.session_id,
        `${label(bindings)} · deux sessions distinctes`,
      );
      assert.equal(persisted.manifest.runtime_config?.schema_version, NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION);

      const state = await readPersistedState(runPaths(h.runsDir, result.runId));
      assert.equal(state.execution_mode, 'NATIVE_V21_EXECUTION');
      assert.equal(state.document.schema_version, NATIVE_STATE_SCHEMA_VERSION);
      assert.equal(
        (state.document as { next_step_source_slot?: ExpertSlotId | null }).next_step_source_slot,
        'author',
        `${label(bindings)} · curseur posé`,
      );
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('A · le défaut produit est Claude auteur, Codex contradicteur', async () => {
  const dir = await makeTempDir('ccr-1c-default-');
  try {
    assert.deepEqual(DEFAULT_NATIVE_BINDINGS, { author: 'claude', challenger: 'codex' });
    const h = harness(path.join(dir, 'runs'));
    const result = await startNativeRun(h.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      runtimeConfig: nativeRuntime(DEFAULT_NATIVE_BINDINGS),
    });
    // L'ordre d'appel vient des slots, jamais des fournisseurs : AUTHOR
    // d'abord, quel que soit le moteur qui lui est lié.
    assert.deepEqual(h.callOrder.map((call) => call.provider), ['claude', 'codex']);
    assert.equal(result.manifest.experts.author.provider, 'claude');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Preflight
// ==========================================================================

function probe(installed: boolean, authStatus: AgentRuntimeProbe['authStatus'] = 'AUTHENTICATED'): AgentRuntimeProbe {
  return {
    agent: 'claude',
    installed,
    version: installed ? '1.0.0' : null,
    authStatus,
    launcher: null,
    diagnostics: [],
  } as unknown as AgentRuntimeProbe;
}

interface ProbeSpy {
  readonly probed: ProviderKind[];
  readonly probes: { claude: () => Promise<AgentRuntimeProbe>; codex: () => Promise<AgentRuntimeProbe> };
}

function probeSpy(available: { claude?: boolean; codex?: boolean } = {}): ProbeSpy {
  const probed: ProviderKind[] = [];
  return {
    probed,
    probes: {
      claude: async () => {
        probed.push('claude');
        return probe(available.claude ?? true);
      },
      codex: async () => {
        probed.push('codex');
        return probe(available.codex ?? true);
      },
    },
  };
}

test('B5–B7 · seuls les fournisseurs employés sont sondés pour l’admission', async () => {
  const dir = await makeTempDir('ccr-1c-preflight-');
  try {
    for (const { bindings, expected } of [
      { bindings: { author: 'codex', challenger: 'claude' } as const, expected: ['claude', 'codex'] },
      { bindings: { author: 'claude', challenger: 'claude' } as const, expected: ['claude'] },
      { bindings: { author: 'codex', challenger: 'codex' } as const, expected: ['codex'] },
    ]) {
      const spy = probeSpy();
      const result = await runNativeStartPreflight(requiredProviders(bindings), {
        configPath: path.join(dir, 'absent.json'),
        env: {},
        probes: spy.probes,
        tty: { stdin: false, stdout: false },
      });
      assert.deepEqual(spy.probed.sort(), expected, `${label(bindings)} · sondes`);
      assert.equal(result.claude.required, requiredProviders(bindings).has('claude'));
      assert.equal(result.codex.required, requiredProviders(bindings).has('codex'));
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('B8 · un fournisseur non employé peut être absent du poste sans bloquer START', async () => {
  const dir = await makeTempDir('ccr-1c-unused-');
  try {
    const bindings: NativeExpertBindings = { author: 'claude', challenger: 'claude' };
    // Codex n'est pas installé — et n'est même pas sondé.
    const spy = probeSpy({ codex: false });
    const h = harness(path.join(dir, 'runs'));

    const deps: NativeStartApplicationDeps = {
      createRunServiceDeps: () => h.deps,
      preflight: {
        configPath: path.join(dir, 'absent.json'),
        env: {},
        probes: spy.probes,
      },
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    };

    const result = await startNativeRunWithPreflight(deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      bindings,
    });

    assert.equal(result.failure, undefined, 'START abouti sans Codex');
    assert.deepEqual(spy.probed, ['claude'], 'Codex jamais sondé');
    assert.deepEqual([...result.requiredProviders].sort(), ['claude']);

    // B10 · le snapshot dit l'abstention, sans version ni auth fabriquées.
    assert.equal(result.runtimeConfig.codex.required, false);
    assert.equal(result.runtimeConfig.codex.probe_status, 'NOT_REQUIRED');
    assert.deepEqual(Object.keys(result.runtimeConfig.codex).sort(), ['probe_status', 'required']);
    assert.equal(result.runtimeConfig.claude.required, true);
  } finally {
    await removeTempDir(dir);
  }
});

test('B9 · un blocage de preflight précède toute allocation', async () => {
  const dir = await makeTempDir('ccr-1c-blocked-');
  try {
    const runsDir = path.join(dir, 'runs');
    const h = harness(runsDir);
    const spy = probeSpy({ claude: false });

    const deps: NativeStartApplicationDeps = {
      createRunServiceDeps: () => h.deps,
      preflight: {
        configPath: path.join(dir, 'absent.json'),
        env: {},
        probes: spy.probes,
      },
    };

    let raised: unknown;
    try {
      await startNativeRunWithPreflight(deps, {
        title: 'T',
        cwd: dir,
        prompt: PROMPT,
        bindings: { author: 'claude', challenger: 'codex' },
      });
    } catch (error) {
      raised = error;
    }

    expectCcrCode(raised, 'AGENT_CLI_NOT_FOUND', 'CLI requise absente');
    // Rien n'a été engagé : ni run_id, ni répertoire, ni adapter appelé.
    await assert.rejects(readdir(runsDir), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.deepEqual(h.callOrder, [], 'aucun appel fournisseur');
  } finally {
    await removeTempDir(dir);
  }
});

test('B · le snapshot natif se construit depuis le preflight, sans rien inventer', () => {
  const preflight = {
    claude: { required: true as const, probe: probe(true, 'UNKNOWN') },
    codex: { required: false as const },
    effectiveConfig: {
      preflight: { offerInteractiveLogin: false },
      codex: { skipGitRepoCheck: true, source: 'config' as const },
    },
    warnings: [],
  };
  const config = buildNativeRuntimeConfig(preflight, new Date('2026-08-10T00:00:00.000Z'));
  assert.equal(config.claude.required, true);
  if (!config.claude.required) return;
  assert.equal(config.claude.auth_preflight, 'UNKNOWN', "l'incertitude est reconduite telle quelle");
  assert.equal(config.codex.required, false);
  assert.deepEqual(Object.keys(config.codex).sort(), ['probe_status', 'required']);
});

// ==========================================================================
// C. Positions initiales
// ==========================================================================

test('C11–C15 · deux positions initiales indépendantes, à provenance native', async () => {
  const dir = await makeTempDir('ccr-1c-positions-');
  try {
    const bindings: NativeExpertBindings = { author: 'claude', challenger: 'claude' };
    const h = harness(path.join(dir, 'runs'), { claudeSessions: ['C1', 'C2'] });
    const result = await startNativeRun(h.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      bindings,
      runtimeConfig: nativeRuntime(bindings),
    });

    // 11 · même mission métier pour les deux.
    assert.deepEqual(h.callOrder.map((call) => call.prompt), [PROMPT, PROMPT]);

    // 12 · le prompt du challenger ne contient pas la réponse de l'auteur.
    const authorAnswer = result.positions[0]?.turn.content ?? '';
    assert.ok(authorAnswer.length > 0);
    assert.equal(h.callOrder[1]?.prompt.includes(authorAnswer), false, 'aucune contamination');

    const paths = runPaths(h.runsDir, result.runId);
    const store = await openNativeEventStore(paths, result.manifest);
    const events = await store.readAll();

    // 13 · deux réponses, chacune avec son slot et sa session.
    const responses = events.filter((event) => event.type === 'assistant_response');
    assert.deepEqual(
      responses.map((event) => [
        (event as { expert_slot_id: ExpertSlotId }).expert_slot_id,
        (event as { session_id: string }).session_id,
      ]),
      [
        ['author', 'C1'],
        ['challenger', 'C2'],
      ],
    );
    assert.deepEqual(responses.map((event) => event.actor), ['expert', 'expert']);

    // 14 · deux `session_created`, même provenance.
    const created = events.filter((event) => event.type === 'session_created');
    assert.deepEqual(
      created.map((event) => (event as { expert_slot_id: ExpertSlotId }).expert_slot_id),
      ['author', 'challenger'],
    );

    // 15 · aucune identité fournisseur dans le journal natif.
    const raw = await readFile(paths.events, 'utf8');
    for (const forbidden of ['"actor":"claude"', '"actor":"codex"', '"target":"claude"', '"target":"codex"']) {
      assert.equal(raw.includes(forbidden), false, `${forbidden} absent`);
    }
    // …et les prompts nomment bien un slot cible.
    const prompts = events.filter((event) => event.type === 'prompt_sent');
    assert.deepEqual(
      prompts.map((event) => (event as { target_expert_slot_id: ExpertSlotId }).target_expert_slot_id),
      ['author', 'challenger'],
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Frontières d'échec
// ==========================================================================

test('D16 · un échec AUTHOR laisse zéro session et n’appelle jamais CHALLENGER', async () => {
  const dir = await makeTempDir('ccr-1c-fail-author-');
  try {
    const bindings: NativeExpertBindings = { author: 'codex', challenger: 'claude' };
    const h = harness(path.join(dir, 'runs'), {
      failCodex: () => new CcrError('AGENT_EXIT_NONZERO', 'codex a échoué'),
    });

    const result = await startNativeRun(h.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      bindings,
      runtimeConfig: nativeRuntime(bindings),
    });

    assert.equal(result.failure?.slot, 'author');
    assert.deepEqual(h.callOrder.map((call) => call.provider), ['codex'], 'un seul appel, aucun retry');
    assert.equal(h.adapters.claude.calls.length, 0, 'le challenger n’est jamais appelé');

    const persisted = await readPersistedManifest(runPaths(h.runsDir, result.runId));
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(persisted.manifest.experts.author.session_id, null);
    assert.equal(persisted.manifest.experts.challenger.session_id, null);

    const state = await readPersistedState(runPaths(h.runsDir, result.runId));
    assert.equal(state.document.state, 'FAILED_INITIALIZATION');
    assert.equal((state.document as { next_step_source_slot?: unknown }).next_step_source_slot, null);
  } finally {
    await removeTempDir(dir);
  }
});

test('D17 · un échec CHALLENGER laisse une session, honnêtement', async () => {
  const dir = await makeTempDir('ccr-1c-fail-challenger-');
  try {
    const bindings: NativeExpertBindings = { author: 'codex', challenger: 'claude' };
    const h = harness(path.join(dir, 'runs'), {
      failClaude: () => new CcrError('AGENT_TIMEOUT', 'claude a expiré'),
    });

    const result = await startNativeRun(h.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      bindings,
      runtimeConfig: nativeRuntime(bindings),
    });

    assert.equal(result.failure?.slot, 'challenger');
    assert.deepEqual(h.callOrder.map((call) => call.provider), ['codex', 'claude']);
    assert.equal(h.adapters.claude.calls.length, 1, 'aucun retry');

    const persisted = await readPersistedManifest(runPaths(h.runsDir, result.runId));
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(persisted.manifest.experts.author.session_id, 'codex-1');
    assert.equal(persisted.manifest.experts.challenger.session_id, null);

    const state = await readPersistedState(runPaths(h.runsDir, result.runId));
    assert.equal(state.document.state, 'FAILED_INITIALIZATION');
    assert.equal((state.document as { next_step_source_slot?: unknown }).next_step_source_slot, null);
  } finally {
    await removeTempDir(dir);
  }
});

test('D18–D20 · une collision d’identité native est un échec fermé', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const dir = await makeTempDir('ccr-1c-collision-');
    try {
      const bindings: NativeExpertBindings = { author: provider, challenger: provider };
      // Le second démarrage rend l'identifiant du premier.
      const h = harness(path.join(dir, 'runs'), {
        ...(provider === 'claude' ? { claudeSessions: ['S1', 'S1'] } : { codexSessions: ['S1', 'S1'] }),
      });

      const result = await startNativeRun(h.deps, {
        title: 'T',
        cwd: dir,
        prompt: PROMPT,
        bindings,
        runtimeConfig: nativeRuntime(bindings),
      });

      assert.equal(result.failure?.slot, 'challenger', `${provider}/${provider}`);
      expectCcrCode(result.failure?.error, 'SESSION_ID_COLLISION', `${provider}/${provider}`);
      assert.equal(h.adapters[provider].calls.length, 2, 'aucun retry');

      const paths = runPaths(h.runsDir, result.runId);
      const persisted = await readPersistedManifest(paths);
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');

      // Les faits du premier slot restent ; la session n'est attribuée à personne d'autre.
      assert.equal(persisted.manifest.experts.author.session_id, 'S1');
      assert.equal(persisted.manifest.experts.challenger.session_id, null);

      // Et aucune réponse du second slot n'a été journalisée sous l'identité en conflit.
      const events = await (await openNativeEventStore(paths, persisted.manifest)).readAll();
      const responses = events.filter((event) => event.type === 'assistant_response');
      assert.equal(responses.length, 1, 'une seule réponse journalisée');
      assert.equal((responses[0] as { expert_slot_id: ExpertSlotId }).expert_slot_id, 'author');
      assert.ok(
        events.some((event) => event.type === 'process_failed'),
        'la collision est journalisée comme un échec',
      );
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// E. Curseur, round, rounds/
// ==========================================================================

test('E21–E25 · curseur, round et absence totale de `rounds/`', async () => {
  const dir = await makeTempDir('ccr-1c-cursor-');
  try {
    const runsDir = path.join(dir, 'runs');

    // Succès complet : curseur posé, round inchangé, aucun artefact.
    const ok = harness(runsDir);
    const success = await startNativeRun(ok.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      runtimeConfig: nativeRuntime(DEFAULT_NATIVE_BINDINGS),
    });
    const successPaths = runPaths(runsDir, success.runId);
    assert.equal(success.state.next_step_source_slot, 'author');
    assert.equal(success.state.round, 0, 'START ne crée aucun round de transfert');
    assert.equal(success.state.state, 'READY');
    assert.deepEqual(await readdir(successPaths.roundsDir), [], 'aucun artefact de round');

    // Échec du challenger : curseur toujours nul.
    const ko = harness(runsDir, { failClaude: () => new CcrError('AGENT_TIMEOUT', 'expiré') });
    const failed = await startNativeRun(ko.deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      runtimeConfig: nativeRuntime(DEFAULT_NATIVE_BINDINGS),
    });
    assert.equal(failed.state.next_step_source_slot, null);
    assert.equal(failed.state.round, 0);
    assert.deepEqual(await readdir(runPaths(runsDir, failed.runId).roundsDir), []);
  } finally {
    await removeTempDir(dir);
  }
});

test('E · l’ordre de durabilité est observable, et il est celui du START V2', async () => {
  const dir = await makeTempDir('ccr-1c-durability-');
  try {
    const runsDir = path.join(dir, 'runs');
    const observed: string[] = [];

    // L'observation porte sur le PREMIER appel, c'est-à-dire celui du slot
    // AUTHOR. Elle est donc attachée à l'adapter que le défaut lie à AUTHOR ;
    // ce qui est observé reste slot-first, jamais fournisseur-first.
    const adapters = {
      codex: createFakeAdapter({ kind: 'codex', startSessionIds: ['X1'] }),
      claude: createFakeAdapter({
        kind: 'claude',
        startSessionIds: ['C1'],
        // Observation **pendant** l'appel : ce qui est déjà durable à cet instant.
        onCall: async () => {
          const runId = (await readdir(runsDir))[0] ?? '';
          const paths = runPaths(runsDir, runId);
          const state = (await readJsonFile(paths.state)) as Record<string, unknown>;
          const manifest = (await readJsonFile(paths.manifest)) as {
            experts: Record<string, { session_id: string | null }>;
          };
          observed.push(`state=${String(state['state'])}`);
          observed.push(`active=${String(state['active_expert_slot'])}`);
          observed.push(
            `pending=${String((state['pending_operation'] as { expert_slot?: string } | null)?.expert_slot)}`,
          );
          observed.push(`session=${String(manifest.experts['author']?.session_id)}`);
          const journal = await readFile(paths.events, 'utf8');
          observed.push(`prompt_sent=${String(journal.includes('"prompt_sent"'))}`);
          observed.push(`response=${String(journal.includes('"assistant_response"'))}`);
        },
      }),
    };

    const deps: RunServiceDeps = {
      runsDir,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
      createAdapters: (): AgentAdapters => adapters,
    };

    const result = await startNativeRun(deps, {
      title: 'T',
      cwd: dir,
      prompt: PROMPT,
      runtimeConfig: nativeRuntime(DEFAULT_NATIVE_BINDINGS),
    });

    // Avant le retour de l'adapter : l'intention est journalisée, l'état dit
    // qu'un tour est en vol pour ce slot, et rien n'est encore lié.
    assert.deepEqual(observed, [
      'state=WAITING_AGENT',
      'active=author',
      'pending=author',
      'session=null',
      'prompt_sent=true',
      'response=false',
    ]);

    // Après : la réponse est journalisée avant que la session ne soit liée.
    const paths = runPaths(runsDir, result.runId);
    const journal = (await readFile(paths.events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(
      journal.map((event) => event.type),
      [
        'run_created',
        'prompt_sent',
        'assistant_response',
        'session_created',
        'prompt_sent',
        'assistant_response',
        'session_created',
      ],
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// F. Non-régression legacy
// ==========================================================================

test('F26–F27 · un START historique reste historique, et rien ne le normalise', async () => {
  const dir = await makeTempDir('ccr-1c-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    const adapters = {
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
    };
    const started = await startRun(
      { runsDir, now: () => new Date(), createAdapters: (): AgentAdapters => adapters },
      { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: dir, prompt: PROMPT },
    );

    const paths = runPaths(runsDir, started.runId);
    const before = {
      manifest: await readFile(paths.manifest, 'utf8'),
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
    };

    // Le run reste de génération historique, avec ses schémas d'origine.
    const persisted = await readPersistedManifest(paths);
    assert.equal(persisted.execution_mode, 'LEGACY_V2_EXECUTION');
    if (persisted.execution_mode !== 'LEGACY_V2_EXECUTION') return;
    assert.equal(persisted.manifest.schema_version, 1);
    assert.equal('experts' in persisted.manifest, false);

    const state = await readPersistedState(paths);
    assert.equal(state.execution_mode, 'LEGACY_V2_EXECUTION');
    assert.equal(state.document.schema_version, 2);

    // Le journal ouvert est celui de sa génération, et son contenu est intact.
    const store = await openRunEventStore(paths, persisted);
    assert.equal(store.execution_mode, 'LEGACY_V2_EXECUTION');

    assert.deepEqual(
      {
        manifest: await readFile(paths.manifest, 'utf8'),
        state: await readFile(paths.state, 'utf8'),
        events: await readFile(paths.events, 'utf8'),
      },
      before,
      'aucune lecture native ne normalise un run historique',
    );
  } finally {
    await removeTempDir(dir);
  }
});
