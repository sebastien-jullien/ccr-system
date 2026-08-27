/**
 * V2.2-IMP-04 — START natif gouverné.
 *
 * START est le seul chemin à deux appels. Trois propriétés le distinguent.
 *
 *  1. **Deux engagements séquentiels, jamais préalloués.** Le fake adapter le
 *     constate lui-même : un seul enregistrement existe quand l'auteur est
 *     appelé, deux quand le challenger l'est.
 *  2. **Un engagement impossible ferme le slot sans inventer d'événement.** Le
 *     slot redevient `CLEAN_MISSING`, et l'auteur déjà acquis n'est jamais
 *     dégradé.
 *  3. **Un défaut de télémétrie ne transforme pas un START complet en
 *     fail-fast.** Le challenger est lancé même si l'usage de l'auteur échoue.
 *
 * Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { UsageObservation } from '../../src/core/usage.ts';
import type { InvocationDispatchRecord, UsageObservationRecord } from '../../src/core/usage-governance.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings, NativeStartHooks } from '../../src/services/native-start-service.ts';
import { buildNativeInitializationView } from '../../src/services/native-recovery-service.ts';
import { applyNativeStartMutation } from '../../src/services/native-mutations.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openUsageLedger } from '../../src/store/usage-ledger.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import { readStableNativeRunSnapshot, computeNativeRunRevision } from '../../src/store/native-run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

const PROVIDER_USAGE: UsageObservation = {
  tokens: {
    provider: 'claude',
    input_tokens: 3,
    output_tokens: 4,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2,
  },
  model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' },
  provider_reported_cost: { amount: 0.01, currency: 'USD', source: 'PROVIDER_REPORTED' },
};

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface HarnessOptions {
  readonly usage?: UsageObservation;
  readonly elapsedMs?: number;
  readonly onStart?: () => Promise<void> | void;
  readonly failStart?: () => unknown;
  readonly failCreateAdapters?: () => unknown;
  readonly claudeSessions?: readonly string[];
}

interface Harness {
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  startCalls(): number;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds:
        kind === 'claude' && options.claudeSessions !== undefined
          ? options.claudeSessions
          : [`${kind}-1`, `${kind}-2`],
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.elapsedMs === undefined ? {} : { elapsedMs: options.elapsedMs }),
      ...(options.failStart === undefined ? {} : { failStart: options.failStart }),
      onCall: async (phase) => {
        if (phase === 'start') await options.onStart?.();
      },
    });

  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
    adapters,
    startCalls: () =>
      adapters.claude.calls.filter((call) => call.phase === 'start').length +
      adapters.codex.calls.filter((call) => call.phase === 'start').length,
    deps: {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => {
        const failure = options.failCreateAdapters?.();
        if (failure !== undefined) throw failure;
        return adapters;
      },
    },
  };
}

function nativeRuntime(): NativeRunRuntimeConfig {
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: AT,
    claude: { required: true, probe_status: 'OBSERVED', cli_version: '2.1.224', auth_preflight: 'AUTHENTICATED' },
    codex: {
      required: true,
      probe_status: 'OBSERVED',
      cli_version: '0.146.0',
      auth_preflight: 'AUTHENTICATED',
      skip_git_repo_check: false,
      source_at_capture: 'default',
    },
  };
}

function start(
  h: Harness,
  dir: string,
  options: { bindings?: NativeExpertBindings; hooks?: NativeStartHooks } = {},
): ReturnType<typeof startNativeRun> {
  return startNativeRun(
    h.deps,
    {
      title: 'T',
      cwd: dir,
      prompt: MISSION,
      ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
      runtimeConfig: nativeRuntime(),
    },
    options.hooks ?? {},
  );
}

async function journal(runsDir: string, runId: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

async function ledgers(
  runsDir: string,
  runId: string,
): Promise<{ invocations: InvocationDispatchRecord[]; usage: UsageObservationRecord[] }> {
  const paths = runPaths(runsDir, runId);
  return {
    invocations: await (await openInvocationLedger(paths, runId)).readAll(),
    usage: await (await openUsageLedger(paths, runId)).readAll(),
  };
}

function usageOf(
  records: readonly UsageObservationRecord[],
  invocationId: string,
): UsageObservationRecord[] {
  return records.filter((entry) => entry.invocation_id === invocationId);
}

/** Journal d'invocations dont l'append échoue au N-ième appel. */
function brokenInvocationLedger(failAt: number): NativeStartHooks['openInvocationLedger'] {
  let seen = 0;
  return async (paths, runId, options) => {
    const real = await openInvocationLedger(paths, runId, options);
    return {
      ...real,
      append: async (draft, now) => {
        seen += 1;
        if (seen === failAt) throw new CcrError('JOURNAL_INVALID', 'disque saturé (fixture)');
        return real.append(draft, now);
      },
    };
  };
}

/** Journal d'usage dont l'append échoue pour un slot donné, par son rang. */
function brokenUsageLedger(failAt: number): NativeStartHooks['openUsageLedger'] {
  let seen = 0;
  return async (paths, runId, options) => {
    const real = await openUsageLedger(paths, runId, options);
    return {
      ...real,
      append: async (draft, now) => {
        seen += 1;
        if (seen === failAt) throw new CcrError('JOURNAL_INVALID', 'usage indisponible (fixture)');
        return real.append(draft, now);
      },
    };
  };
}

// ==========================================================================
// A. Deux dispatchs séquentiels
// ==========================================================================

test('1–8 · deux engagements, jamais préalloués, jamais fusionnés', async () => {
  const dir = await makeTempDir('ccr-1d-nominal-');
  try {
    const runsDir = `${dir}/runs`;
    const seen: number[] = [];
    let runsDirRef = runsDir;
    let runIdRef = '';
    const h = harness(runsDir, {
      usage: PROVIDER_USAGE,
      elapsedMs: 500,
      // 2–3 · au moment de chaque appel, exactement ce qui doit exister.
      onStart: async () => {
        if (runIdRef === '') return;
        seen.push((await ledgers(runsDirRef, runIdRef)).invocations.length);
      },
    });
    // Same-provider : l'identité doit rester le slot.
    const result = await start(h, dir, { bindings: { author: 'claude', challenger: 'claude' } });
    runIdRef = result.runId;

    const { invocations, usage } = await ledgers(runsDir, result.runId);
    assert.equal(invocations.length, 2, '1 · un engagement par slot');
    const [author, challenger] = invocations as [InvocationDispatchRecord, InvocationDispatchRecord];

    // 4 · déclencheur, et 8 · identités distinctes malgré le moteur partagé.
    for (const record of invocations) assert.equal(record.trigger_kind, 'START');
    assert.deepEqual(author.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'author',
      provider: 'claude',
    });
    assert.deepEqual(challenger.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'challenger',
      provider: 'claude',
    });
    assert.equal(author.invocation_id, 'inv_000001');
    assert.equal(challenger.invocation_id, 'inv_000002');

    // 5–6 · une position initiale n'a ni session au dispatch, ni round, ni source.
    for (const record of invocations) {
      assert.equal(record.session_id, undefined, 'la session n’existe pas encore');
      assert.equal(record.round, undefined);
      assert.equal(record.source_event_id, undefined);
      assert.equal(record.operation_id, undefined, 'aucune origine HTTP ici');
    }

    // 7 · deux prompts distincts, exacts.
    const events = await journal(runsDir, result.runId);
    const prompts = events.filter((event) => event.type === 'prompt_sent');
    assert.equal(prompts.length, 2);
    assert.equal(author.prompt_event_id, prompts[0]?.event_id);
    assert.equal(challenger.prompt_event_id, prompts[1]?.event_id);
    assert.notEqual(author.prompt_event_id, challenger.prompt_event_id);

    // 9–12 · deux observations par slot, rattachées à leur propre invocation.
    assert.equal(usage.length, 4);
    for (const record of invocations) {
      const own = usageOf(usage, record.invocation_id);
      assert.deepEqual(
        own.map((entry) => entry.provenance).sort(),
        ['CCR_MEASURED', 'PROVIDER_REPORTED'],
      );
      assert.equal(own.find((entry) => entry.provenance === 'CCR_MEASURED')?.ccr_elapsed_ms, 500);
    }
    assert.deepEqual(result.usageGovernanceWarnings, []);

    // 29 · les sessions restent distinctes, gouvernées par V2.1 seule.
    assert.notEqual(
      result.manifest.experts.author.session_id,
      result.manifest.experts.challenger.session_id,
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('2–3 · l’adapter voit un engagement au premier appel, deux au second', async () => {
  const dir = await makeTempDir('ccr-1d-order-');
  try {
    const runsDir = `${dir}/runs`;
    const seen: number[] = [];
    // Le run n'est nommé qu'au retour ; on lit le seul run du répertoire.
    const readAll = async (): Promise<number> => {
      const { readdir } = await import('node:fs/promises');
      const ids = await readdir(runsDir).catch(() => []);
      const runId = ids[0];
      if (runId === undefined) return 0;
      return (await ledgers(runsDir, runId)).invocations.length;
    };
    const h = harness(runsDir, { onStart: async () => void seen.push(await readAll()) });

    await start(h, dir);
    assert.deepEqual(seen, [1, 2], 'jamais deux engagements avant le premier appel');
  } finally {
    await removeTempDir(dir);
  }
});

test('13 · un adapter sans usage fournisseur produit la seule mesure CCR', async () => {
  const dir = await makeTempDir('ccr-1d-no-usage-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, { elapsedMs: 60 });
    const result = await start(h, dir);
    const { usage } = await ledgers(runsDir, result.runId);

    assert.equal(usage.length, 2, 'une observation par slot');
    for (const entry of usage) {
      assert.equal(entry.provenance, 'CCR_MEASURED');
      assert.equal(entry.tokens, undefined, 'aucun jeton inventé');
      assert.equal(entry.provider_reported_cost, undefined, 'aucun coût inventé');
    }
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Échecs d'engagement
// ==========================================================================

test('18–20 · un engagement auteur impossible n’appelle personne', async () => {
  const dir = await makeTempDir('ccr-1d-author-ledger-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir);
    const result = await start(h, dir, { hooks: { openInvocationLedger: brokenInvocationLedger(1) } });

    // 18 · aucun fournisseur, ni pour l'auteur ni pour le challenger.
    assert.equal(h.startCalls(), 0);
    assert.equal(result.positions.length, 0);
    assert.equal(result.failure?.slot, 'author');
    assert.equal(isCcrError(result.failure?.error) && result.failure.error.code, 'INVOCATION_LEDGER_WRITE_FAILED');

    const events = await journal(runsDir, result.runId);
    assert.equal(
      events.filter((event) => event.type === 'process_failed').length,
      0,
      'la panne appartient à CCR, jamais à l’expert',
    );
    assert.equal(events.filter((event) => event.type === 'assistant_response').length, 0);

    // 19 · le slot redevient MISSING, sans le moindre événement neuf.
    const snapshot = await readStableNativeRunSnapshot(runsDir, result.runId);
    const view = buildNativeInitializationView(result.runId, snapshot.manifest, snapshot.state, snapshot.events);
    assert.equal(view.status, 'CLEAN_MISSING');
    assert.deepEqual([...view.missingSlots].sort(), ['author', 'challenger']);
    assert.equal(snapshot.state.pending_operation, null);
    assert.equal(snapshot.state.control, 'HUMAN');

    // 20 · le challenger n'a jamais été tenté.
    assert.deepEqual((await ledgers(runsDir, result.runId)).invocations, []);
  } finally {
    await removeTempDir(dir);
  }
});

test('21–24 · un engagement challenger impossible préserve l’auteur acquis', async () => {
  const dir = await makeTempDir('ccr-1d-challenger-ledger-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, { usage: PROVIDER_USAGE });
    const result = await start(h, dir, { hooks: { openInvocationLedger: brokenInvocationLedger(2) } });

    assert.equal(h.startCalls(), 1, 'seul l’auteur a été appelé');
    assert.equal(result.failure?.slot, 'challenger');
    assert.equal(result.positions.length, 1);

    // 21 · l'auteur reste complet : session liée, réponse et session_created.
    assert.notEqual(result.manifest.experts.author.session_id, null);
    const events = await journal(runsDir, result.runId);
    assert.equal(events.filter((event) => event.type === 'session_created').length, 1);
    assert.equal(events.filter((event) => event.type === 'assistant_response').length, 1);

    // 22–23 · le challenger est manquant, l'auteur non.
    const snapshot = await readStableNativeRunSnapshot(runsDir, result.runId);
    const view = buildNativeInitializationView(result.runId, snapshot.manifest, snapshot.state, snapshot.events);
    assert.equal(view.status, 'CLEAN_MISSING');
    assert.deepEqual(view.missingSlots, ['challenger']);
    assert.equal(view.conditions.author, 'COMPLETE');

    // 24 · la reprise viserait ce seul slot — sans être lancée ici.
    assert.deepEqual(view.requiredProviders, [result.manifest.experts.challenger.provider]);

    // L'engagement de l'auteur, lui, subsiste : il a bien été pris.
    const { invocations, usage } = await ledgers(runsDir, result.runId);
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0]?.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'author',
      provider: result.manifest.experts.author.provider,
    });
    assert.equal(usageOf(usage, 'inv_000001').length, 2);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Échecs fournisseur
// ==========================================================================

test('25 · 27 · un échec fournisseur auteur conserve son engagement, et s’arrête là', async () => {
  const dir = await makeTempDir('ccr-1d-author-provider-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, { failStart: () => new CcrError('AGENT_TIMEOUT', 'délai (fixture)') });
    const result = await start(h, dir);

    assert.equal(h.startCalls(), 1, 'aucun troisième appel, aucun challenger');
    assert.equal(result.failure?.slot, 'author');

    const { invocations, usage } = await ledgers(runsDir, result.runId);
    assert.equal(invocations.length, 1, 'l’engagement pris est conservé');
    assert.equal(usage.length, 0, 'aucun jeton inventé pour un tour sans retour');
    assert.equal(
      (await journal(runsDir, result.runId)).filter((event) => event.type === 'process_failed').length,
      1,
      'la sémantique V2.1 de l’échec est intacte',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('26 · un échec fournisseur challenger laisse deux engagements et l’auteur acquis', async () => {
  const dir = await makeTempDir('ccr-1d-challenger-provider-');
  try {
    const runsDir = `${dir}/runs`;
    let calls = 0;
    const h = harness(runsDir, {
      failStart: () => {
        calls += 1;
        return calls === 2 ? new CcrError('AGENT_TIMEOUT', 'délai (fixture)') : undefined;
      },
    });
    const result = await start(h, dir);

    assert.equal(h.startCalls(), 2);
    assert.equal(result.failure?.slot, 'challenger');
    assert.equal(result.positions.length, 1);
    const { invocations } = await ledgers(runsDir, result.runId);
    assert.equal(invocations.length, 2, 'les deux engagements avaient été pris');
    assert.notEqual(result.manifest.experts.author.session_id, null, 'l’auteur reste acquis');
  } finally {
    await removeTempDir(dir);
  }
});

test('28 · une collision de session conserve le dispatch et n’écrit aucun usage', async () => {
  const dir = await makeTempDir('ccr-1d-collision-');
  try {
    const runsDir = `${dir}/runs`;
    // Le même identifiant rendu deux fois : la collision que V2.1 refuse.
    const h = harness(runsDir, { usage: PROVIDER_USAGE, claudeSessions: ['S1', 'S1'] });
    const result = await start(h, dir, { bindings: { author: 'claude', challenger: 'claude' } });

    assert.equal(result.failure?.slot, 'challenger');
    assert.equal(
      isCcrError(result.failure?.error) && result.failure.error.code,
      'SESSION_ID_COLLISION',
    );

    const { invocations, usage } = await ledgers(runsDir, result.runId);
    assert.equal(invocations.length, 2, 'le dispatch du challenger reste enregistré');
    // Limite assumée : l'observation d'un tour refusé n'est pas conservée.
    assert.deepEqual(usageOf(usage, 'inv_000002'), []);
    assert.equal(usageOf(usage, 'inv_000001').length, 2, 'l’auteur garde la sienne');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. La télémétrie ne commande jamais START
// ==========================================================================

test('14–17 · un échec d’usage auteur n’empêche pas le challenger', async () => {
  const dir = await makeTempDir('ccr-1d-usage-author-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir, { usage: PROVIDER_USAGE });
    // Le premier append d'usage est celui de l'auteur.
    const result = await start(h, dir, { hooks: { openUsageLedger: brokenUsageLedger(1) } });

    // 15 · propriété bloquante du slice : le challenger est bien lancé.
    assert.equal(h.startCalls(), 2);
    assert.equal(result.failure, undefined, 'un défaut de télémétrie n’est pas un fail-fast');
    assert.equal(result.positions.length, 2);

    // 16 · et START se termine normalement.
    const state = await readPersistedState(runPaths(runsDir, result.runId));
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
    assert.equal(state.document.state, 'READY');
    assert.equal(state.document.next_step_source_slot, 'author');
    assert.equal(state.document.pending_operation, null);

    // 17 · l'échec est visible, structuré, et sans matière sensible.
    assert.equal(result.usageGovernanceWarnings.length, 1);
    const warning = result.usageGovernanceWarnings[0];
    assert.equal(warning?.invocation_id, 'inv_000001');
    assert.equal(warning?.provenance, 'PROVIDER_REPORTED');
    assert.equal(warning?.error_code, 'JOURNAL_INVALID');
    for (const forbidden of ['prompt', 'response', 'stdout', 'Mission']) {
      assert.equal(JSON.stringify(warning).includes(forbidden), false, `diagnostic sans ${forbidden}`);
    }

    // L'auteur conserve malgré tout sa mesure CCR : rien n'est annulé.
    const { usage } = await ledgers(runsDir, result.runId);
    assert.deepEqual(usageOf(usage, 'inv_000001').map((entry) => entry.provenance), ['CCR_MEASURED']);
    assert.equal(usageOf(usage, 'inv_000002').length, 2, 'le challenger est intact');
  } finally {
    await removeTempDir(dir);
  }
});

test('17 · un avertissement d’usage coexiste avec un échec ultérieur', async () => {
  const dir = await makeTempDir('ccr-1d-warning-failure-');
  try {
    const runsDir = `${dir}/runs`;
    let calls = 0;
    const h = harness(runsDir, {
      usage: PROVIDER_USAGE,
      failStart: () => {
        calls += 1;
        return calls === 2 ? new CcrError('AGENT_TIMEOUT', 'délai (fixture)') : undefined;
      },
    });
    const result = await start(h, dir, { hooks: { openUsageLedger: brokenUsageLedger(1) } });

    // L'avertissement de l'auteur ne masque pas l'échec du challenger.
    assert.equal(result.failure?.slot, 'challenger');
    assert.equal(result.usageGovernanceWarnings.length, 1);
    assert.equal(result.usageGovernanceWarnings[0]?.invocation_id, 'inv_000001');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Frontières
// ==========================================================================

test('32–33 · un adapter introuvable ne consomme rien, et les journaux restent hors révision', async () => {
  const dir = await makeTempDir('ccr-1d-frontiers-');
  try {
    const runsDir = `${dir}/runs`;

    // 32 · `createAdapters` s'exécute après la matérialisation du run mais avant
    // tout engagement : aucun dispatch, aucun appel fournisseur.
    const broken = harness(runsDir, {
      failCreateAdapters: () => new CcrError('AGENT_EXECUTABLE_UNRESOLVED', 'aucune CLI (fixture)'),
    });
    await assert.rejects(
      start(broken, dir),
      (error: unknown) => isCcrError(error) && error.code === 'AGENT_EXECUTABLE_UNRESOLVED',
    );
    assert.equal(broken.startCalls(), 0);

    // 33 · la révision ne dépend que des trois sources canoniques.
    const h = harness(runsDir, { usage: PROVIDER_USAGE });
    const result = await start(h, dir);
    const snapshot = await readStableNativeRunSnapshot(runsDir, result.runId);
    assert.equal(
      snapshot.revision,
      computeNativeRunRevision(snapshot.manifest, snapshot.state, snapshot.events),
    );
    const { invocations, usage } = await ledgers(runsDir, result.runId);
    assert.equal(invocations.length, 2);
    assert.equal(usage.length, 4);
  } finally {
    await removeTempDir(dir);
  }
});

test('30–31 · corrélation applicative sur les deux engagements, absente en CLI', async () => {
  const dir = await makeTempDir('ccr-1d-correlation-');
  try {
    const runsDir = `${dir}/runs`;
    const h = harness(runsDir);

    // 31 · CLI : aucun identifiant d'opération.
    const cli = await start(h, dir);
    for (const record of (await ledgers(runsDir, cli.runId)).invocations) {
      assert.equal(record.operation_id, undefined);
    }

    // 30 · une opération de création vaut deux invocations, même identifiant.
    const created = await applyNativeStartMutation(
      {
        createRunServiceDeps: () => h.deps,
        manager: createLongOperationManager(),
        operationId: 'op_start',
        preflightSeams: {
          configPath: `${dir}/config.json`,
          env: {},
          probes: {
            claude: async () => ({
              agent: 'claude',
              installed: true,
              version: '2.1.224',
              authStatus: 'AUTHENTICATED',
              launcherSource: 'path',
            }),
            codex: async () => ({
              agent: 'codex',
              installed: true,
              version: '0.146.0',
              authStatus: 'AUTHENTICATED',
              launcherSource: 'path',
            }),
          },
        },
      },
      { title: 'T', workspaceCwd: dir, prompt: MISSION },
    );

    const records = (await ledgers(runsDir, created.runId)).invocations;
    assert.equal(records.length, 2);
    for (const record of records) assert.equal(record.operation_id, 'op_start');
  } finally {
    await removeTempDir(dir);
  }
});

test('34–35 · le legacy a son propre goulot, et START garde son propre déclencheur', async () => {
  const executable = async (relative: string): Promise<string> => {
    const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  // Le moteur historique a été câblé à son tour (IMP-06), depuis son propre
  // goulot. Ce qui doit rester vrai ici : il ne passe **jamais** par les
  // services natifs, et n'écrit jamais une identité à slot.
  const legacy = await executable('services/run-service.ts');
  assert.ok(legacy.includes('invocation-ledger'), 'le legacy a son propre câblage');
  assert.equal(legacy.includes('expert_slot'), false, 'ce moteur n’a pas de rôles');
  for (const forbidden of [
    'native-start-service',
    'native-step-service',
    'native-send-service',
    'native-recovery-service',
  ]) {
    assert.equal(legacy.includes(forbidden), false, `le legacy n’emprunte pas ${forbidden}`);
  }

  const started = await executable('services/native-start-service.ts');
  assert.ok(started.includes('invocation-ledger'));
  assert.ok(started.includes('usage-governance-writer'));
  // Le déclencheur de START reste le sien, malgré la primitive partagée avec la
  // reprise d'initialisation (V2.2-IMP-05).
  assert.ok(started.includes("trigger: 'START'"), 'START déclare son propre déclencheur');
});
