/**
 * V2.2-IMP-08 — application de la politique de quota per-run.
 *
 * Une seule question, posée juste avant chaque tentative, et trois propriétés
 * qui portent tout le reste.
 *
 *  1. **Un refus ne consomme rien.** Aucun `DISPATCH_COMMITTED`, aucun agent,
 *     et aucun fait durable de la tentative refusée.
 *  2. **Rien n'est réservé d'avance.** Sur deux slots avec une seule unité, le
 *     premier l'obtient, le second est refusé — parce que le compte est relu
 *     du journal réel entre les deux.
 *  3. **Le quota compte des engagements, pas des succès.** Un tour engagé puis
 *     échoué reste consommé ; aucun remboursement n'existe.
 *
 * Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrEvent } from '../../src/core/run.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { assertInvocationQuotaAvailable } from '../../src/services/invocation-quota.ts';
import { recoverRun, sendMessage, startRun, stepRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import { stepNativeRun } from '../../src/services/native-step-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import { continueNativeInitialization } from '../../src/services/native-recovery-service.ts';
import { expertSlotTarget } from '../../src/services/native-target-resolver.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readManifest, readState } from '../../src/store/state-store.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const WORKSPACE = 'E:/prog/exemple';
const MISSION = 'Mission initiale : évaluer la refonte.';

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  providerCalls(): number;
  cleanup(): Promise<void>;
}

interface HarnessOptions {
  readonly failStart?: () => unknown;
  readonly failResume?: () => unknown;
  readonly sessionSuffix?: string;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const runsDir = await makeTempDir('ccr-quota-');
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: [`${kind}-1`, `${kind}-2`],
      sessionId: `${kind}-1`,
      ...(options.failStart === undefined ? {} : { failStart: options.failStart }),
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
    });
  const claude = build('claude');
  const codex = build('codex');
  const adapters: AgentAdapters = { claude, codex };

  return {
    runsDir,
    providerCalls: () => claude.calls.length + codex.calls.length,
    deps: { runsDir, now: () => new Date(), createAdapters: () => adapters },
    cleanup: () => removeTempDir(runsDir),
  };
}

async function ledgerCount(runsDir: string, runId: string): Promise<number> {
  return (await openInvocationLedger(runPaths(runsDir, runId), runId)).count();
}

async function setPolicy(runsDir: string, runId: string, max: number): Promise<void> {
  await openInvocationPolicyStore(runPaths(runsDir, runId)).create(max);
}

function expectRefusal(error: unknown): boolean {
  return isCcrError(error) && error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED';
}

async function legacyRun(h: Harness): Promise<string> {
  const run = await startRun(h.deps, {
    runtimeConfig: TEST_RUNTIME_CONFIG,
    title: 'Historique',
    cwd: WORKSPACE,
    prompt: MISSION,
  });
  assert.equal(run.failure, undefined);
  return run.runId;
}

async function nativeRun(h: Harness): Promise<string> {
  const run = await startNativeRun(h.deps, {
    title: 'Natif',
    cwd: WORKSPACE,
    prompt: MISSION,
    runtimeConfig: nativeRuntimeConfig(),
  });
  assert.equal(run.failure, undefined, 'la création native doit aboutir');
  return run.runId;
}

function nativeRuntimeConfig(): Parameters<typeof startNativeRun>[1]['runtimeConfig'] {
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: '2026-08-11T00:00:00.000Z',
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

async function legacyJournal(runsDir: string, runId: string): Promise<readonly CcrEvent[]> {
  return (await openEventStore(runPaths(runsDir, runId), runId)).readAll();
}

async function nativeJournal(runsDir: string, runId: string): Promise<readonly { type: string }[]> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

// ==========================================================================
// A. Le helper — aucun décalage d'une unité
// ==========================================================================

test('1 · politique absente, zéro, atteinte, dépassée', async () => {
  const dir = await makeTempDir('ccr-quota-helper-');
  try {
    const runsDir = path.join(dir, 'runs');
    const runId = 'CCR-20260811-001';
    const paths = runPaths(runsDir, runId);
    await mkdir(paths.root, { recursive: true });

    // Aucune politique : autorisé, et rien à rapporter.
    assert.equal(await assertInvocationQuotaAvailable(paths, runId), undefined);

    const ledger = await openInvocationLedger(paths, runId);
    const engage = async (): Promise<void> => {
      await ledger.append(
        {
          identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'claude', provider: 'claude' },
          trigger_kind: 'STEP',
        },
        new Date('2026-08-11T00:00:00.000Z'),
      );
    };

    // Limite zéro, rien de consommé : refusé — l'opposé exact de l'absence.
    await openInvocationPolicyStore(paths).create(0);
    await assert.rejects(assertInvocationQuotaAvailable(paths, runId), expectRefusal);

    const other = 'CCR-20260811-002';
    const two = runPaths(runsDir, other);
    await mkdir(two.root, { recursive: true });
    await openInvocationPolicyStore(two).create(1);

    // Limite 1, rien de consommé : autorisé, et l'instantané est exact.
    assert.deepEqual(await assertInvocationQuotaAvailable(two, other), {
      limit: 1,
      consumed: 0,
      remaining: 1,
    });

    // Limite 1, une unité engagée : refusé. La frontière est `>=`, jamais `>`.
    await engage();
    const ledgerTwo = await openInvocationLedger(two, other);
    await ledgerTwo.append(
      {
        identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'claude', provider: 'claude' },
        trigger_kind: 'STEP',
      },
      new Date('2026-08-11T00:00:00.000Z'),
    );
    await assert.rejects(assertInvocationQuotaAvailable(two, other), expectRefusal);
  } finally {
    await removeTempDir(dir);
  }
});

test('2 · le refus porte trois nombres exacts, et rien de sensible', async () => {
  const dir = await makeTempDir('ccr-quota-details-');
  try {
    const runsDir = path.join(dir, 'runs');
    const runId = 'CCR-20260811-001';
    const paths = runPaths(runsDir, runId);
    await mkdir(paths.root, { recursive: true });
    await openInvocationPolicyStore(paths).create(1);

    const ledger = await openInvocationLedger(paths, runId);
    for (let index = 0; index < 2; index += 1) {
      await ledger.append(
        {
          identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'codex', provider: 'codex' },
          trigger_kind: 'SEND',
        },
        new Date('2026-08-11T00:00:00.000Z'),
      );
    }

    // Consommé au-delà de la limite : toujours refusé, jamais un `remaining`
    // négatif.
    const error = await assertInvocationQuotaAvailable(paths, runId).catch((e: unknown) => e);
    assert.ok(isCcrError(error) && error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED');
    assert.deepEqual(error.details, { runId, scope: 'run', limit: 1, consumed: 2, remaining: 0 });
    for (const forbidden of ['Mission', 'prompt', 'response', 'stdout', 'token']) {
      assert.equal(JSON.stringify(error.details).includes(forbidden), false, `sans ${forbidden}`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('3 · gouvernance en panne : jamais une autorisation', async () => {
  const dir = await makeTempDir('ccr-quota-broken-');
  try {
    const runsDir = path.join(dir, 'runs');
    const runId = 'CCR-20260811-001';
    const paths = runPaths(runsDir, runId);
    await mkdir(paths.root, { recursive: true });

    // Politique présente mais illisible : erreur de politique, pas de quota.
    await writeFile(paths.invocationPolicy, '{ pas du JSON', 'utf8');
    const policyError = await assertInvocationQuotaAvailable(paths, runId).catch((e: unknown) => e);
    assert.ok(isCcrError(policyError) && policyError.code === 'INVOCATION_POLICY_INVALID');
    assert.notEqual(policyError.code, 'CCR_INVOCATION_QUOTA_EXCEEDED');

    // Politique valide, journal illisible : impossible de compter n'est pas
    // « zéro consommé ».
    await writeFile(
      paths.invocationPolicy,
      `${JSON.stringify({ schema_version: 1, invocation_quota: { max_invocations: 5 } })}\n`,
      'utf8',
    );
    await writeFile(paths.invocations, 'ceci n’est pas une ligne JSON\n', 'utf8');
    const ledgerError = await assertInvocationQuotaAvailable(paths, runId).catch((e: unknown) => e);
    assert.ok(isCcrError(ledgerError) && ledgerError.code === 'JOURNAL_INVALID');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Moteur natif
// ==========================================================================

test('4 · START natif, limite 0 : aucun slot n’est tenté', async () => {
  const h = await harness();
  try {
    const result = await startNativeRun(
      h.deps,
      { title: 'Natif', cwd: WORKSPACE, prompt: MISSION, runtimeConfig: nativeRuntimeConfig() },
      // Dernier instant sans fournisseur : la politique est posée là, comme le
      // ferait une future surface de provisioning.
      { onAllocated: async (runId) => setPolicy(h.runsDir, runId, 0) },
    );

    assert.ok(result.failure, 'la création est refusée');
    assert.equal(result.failure.slot, 'author');
    assert.ok(expectRefusal(result.failure.error));
    assert.equal(h.providerCalls(), 0);
    assert.equal(await ledgerCount(h.runsDir, result.runId), 0);
    assert.deepEqual(result.positions, []);

    const state = await readPersistedState(runPaths(h.runsDir, result.runId));
    assert.equal(state.execution_mode, 'NATIVE_V21_EXECUTION');
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('natif attendu');
    assert.equal(state.document.state, 'FAILED_INITIALIZATION');
    assert.equal(state.document.control, 'HUMAN');
    assert.equal(state.document.pending_operation, null);

    // Les faits de création du run subsistent ; aucun fait de tentative.
    const events = await nativeJournal(h.runsDir, result.runId);
    assert.deepEqual(
      events.map((event) => event.type),
      ['run_created'],
    );
  } finally {
    await h.cleanup();
  }
});

test('5 · START natif, limite 1 : l’auteur seul, sans réservation', async () => {
  const h = await harness();
  try {
    const result = await startNativeRun(
      h.deps,
      { title: 'Natif', cwd: WORKSPACE, prompt: MISSION, runtimeConfig: nativeRuntimeConfig() },
      { onAllocated: async (runId) => setPolicy(h.runsDir, runId, 1) },
    );

    assert.ok(result.failure);
    assert.equal(result.failure.slot, 'challenger');
    assert.ok(expectRefusal(result.failure.error), 'le challenger est refusé par la politique');
    assert.equal(result.positions.length, 1, 'la position de l’auteur est conservée');

    assert.equal(await ledgerCount(h.runsDir, result.runId), 1);
    assert.equal(h.providerCalls(), 1, 'un seul appel');

    const persisted = await readPersistedManifest(runPaths(h.runsDir, result.runId));
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('natif attendu');
    assert.notEqual(persisted.manifest.experts.author.session_id, null, 'auteur acquis');
    assert.equal(persisted.manifest.experts.challenger.session_id, null, 'challenger manquant');

    // Aucun fait de tentative pour le slot refusé.
    const events = await nativeJournal(h.runsDir, result.runId);
    const challengerFacts = events.filter(
      (event) => (event as { expert_slot_id?: string; target_expert_slot_id?: string })
        .target_expert_slot_id === 'challenger'
        || (event as { expert_slot_id?: string }).expert_slot_id === 'challenger',
    );
    assert.deepEqual(challengerFacts, []);
    assert.equal(events.filter((event) => event.type === 'process_failed').length, 0);
  } finally {
    await h.cleanup();
  }
});

test('6 · STEP natif refusé : aucun fait durable, aucun état modifié', async () => {
  const h = await harness();
  try {
    const runId = await nativeRun(h);
    const before = {
      count: await ledgerCount(h.runsDir, runId),
      events: (await nativeJournal(h.runsDir, runId)).length,
      calls: h.providerCalls(),
    };
    await setPolicy(h.runsDir, runId, before.count);

    await assert.rejects(stepNativeRun(h.deps, runId), expectRefusal);

    assert.equal(await ledgerCount(h.runsDir, runId), before.count);
    assert.equal(h.providerCalls(), before.calls);
    const events = await nativeJournal(h.runsDir, runId);
    assert.equal(events.length, before.events, 'ni round_started, ni prompt_sent');
    for (const type of ['round_started', 'transfer_blocked', 'process_failed']) {
      assert.equal(
        events.filter((event) => event.type === type).length,
        0,
        `aucun ${type} pour une tentative refusée`,
      );
    }
  } finally {
    await h.cleanup();
  }
});

test('7 · SEND natif refusé : aucun message humain', async () => {
  const h = await harness();
  try {
    const runId = await nativeRun(h);
    const before = (await nativeJournal(h.runsDir, runId)).length;
    const state = await readPersistedState(runPaths(h.runsDir, runId));
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('natif attendu');
    await setPolicy(h.runsDir, runId, await ledgerCount(h.runsDir, runId));

    await assert.rejects(
      sendNativeMessage(h.deps, runId, expertSlotTarget('author'), 'Une question.'),
      expectRefusal,
    );

    const events = await nativeJournal(h.runsDir, runId);
    assert.equal(events.length, before);
    assert.equal(events.filter((event) => event.type === 'human_message').length, 0);

    const after = await readPersistedState(runPaths(h.runsDir, runId));
    if (after.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('natif attendu');
    assert.equal(after.document.state, state.document.state, 'état d’origine intact');
    assert.equal(after.document.pending_operation, null);
  } finally {
    await h.cleanup();
  }
});

test('8 · reprise native, deux slots manquants et une seule unité', async () => {
  const h = await harness({ failStart: firstCallFails() });
  try {
    // Une création dont les deux slots échouent : le run existe sans session.
    const created = await startNativeRun(h.deps, {
      title: 'Natif',
      cwd: WORKSPACE,
      prompt: MISSION,
      runtimeConfig: nativeRuntimeConfig(),
    });
    const runId = created.runId;
    assert.ok(created.failure);
    assert.equal(await ledgerCount(h.runsDir, runId), 1, 'la tentative échouée reste engagée');

    // Une unité de plus, pour un seul des deux slots restants.
    await setPolicy(h.runsDir, runId, 2);
    const calls = h.providerCalls();

    const outcome = await continueNativeInitialization(h.deps, runId);

    assert.equal(h.providerCalls() - calls, 1, 'un seul appel');
    assert.equal(await ledgerCount(h.runsDir, runId), 2);
    assert.equal(outcome.positions.length, 1);
    assert.ok(outcome.failure, 'le second slot est nommé');
    assert.ok(expectRefusal(outcome.failure.error));
    assert.deepEqual(outcome.view.missingSlots, [outcome.failure.slot]);

    // Le classifieur reste indépendant : la reprise est toujours proposée.
    assert.equal(outcome.view.canContinueWithProvider, true);
    assert.equal(outcome.state.state, 'FAILED_INITIALIZATION');

    // Une nouvelle tentative est refusée sans rien consommer.
    const second = await continueNativeInitialization(h.deps, runId);
    assert.ok(second.failure && expectRefusal(second.failure.error));
    assert.equal(await ledgerCount(h.runsDir, runId), 2);
    assert.equal(h.providerCalls() - calls, 1);
  } finally {
    await h.cleanup();
  }
});

/** Le premier `start` échoue, les suivants aboutissent. */
function firstCallFails(): () => unknown {
  let seen = 0;
  return () => {
    seen += 1;
    return seen === 1 ? new CcrError('AGENT_TIMEOUT', 'délai (fixture)') : undefined;
  };
}

// ==========================================================================
// C. Moteur historique
// ==========================================================================

test('9 · STEP legacy refusé : ni round, ni prompt, ni source consommée', async () => {
  const h = await harness();
  try {
    const runId = await legacyRun(h);
    const before = {
      state: await readState(runPaths(h.runsDir, runId)),
      events: (await legacyJournal(h.runsDir, runId)).length,
      calls: h.providerCalls(),
    };
    await setPolicy(h.runsDir, runId, 0);

    await assert.rejects(stepRun(h.deps, { runId }), expectRefusal);

    assert.equal(await ledgerCount(h.runsDir, runId), 0);
    assert.equal(h.providerCalls(), before.calls);
    const state = await readState(runPaths(h.runsDir, runId));
    assert.equal(state.state, before.state.state, 'état intact');
    assert.equal(state.round, before.state.round, 'aucun round consommé');
    assert.equal((await legacyJournal(h.runsDir, runId)).length, before.events);

    // La source reste transférable : lever la politique n'est pas possible en
    // V0.1, mais un autre run le prouve — ici, le fait qu'aucun
    // `round_started` n'existe suffit.
    const events = await legacyJournal(h.runsDir, runId);
    assert.equal(events.filter((event) => event.type === 'round_started').length, 0);
  } finally {
    await h.cleanup();
  }
});

test('10 · SEND legacy refusé : le message humain n’est pas écrit', async () => {
  const h = await harness();
  try {
    const runId = await legacyRun(h);
    const before = await readState(runPaths(h.runsDir, runId));
    const events = (await legacyJournal(h.runsDir, runId)).length;
    await setPolicy(h.runsDir, runId, 0);

    await assert.rejects(
      sendMessage(h.deps, { runId, agent: 'claude', message: 'Une question.' }),
      expectRefusal,
    );

    assert.equal(await ledgerCount(h.runsDir, runId), 0);
    const after = await readState(runPaths(h.runsDir, runId));
    assert.equal(after.state, before.state);
    assert.equal(after.control, before.control);
    assert.equal(after.pending_operation, null);
    const journal = await legacyJournal(h.runsDir, runId);
    assert.equal(journal.length, events);
    assert.equal(journal.filter((event) => event.type === 'human_message').length, 0);
  } finally {
    await h.cleanup();
  }
});

test('11 · reprise legacy zéro-session, limite 1 : un agent, puis refus', async () => {
  const h = await harness({ failStart: firstCallFails() });
  try {
    const created = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'Historique',
      cwd: WORKSPACE,
      prompt: MISSION,
    });
    const runId = created.runId;
    assert.notEqual(created.failure, undefined);
    const manifest = await readManifest(runPaths(h.runsDir, runId));
    assert.equal(manifest.agents.claude.session_id, null);
    assert.equal(manifest.agents.codex.session_id, null);

    // Le moteur historique n'engage pas encore : la tentative de création a
    // échoué avant tout `DISPATCH_COMMITTED` ? Non — elle l'a bien engagé.
    const engaged = await ledgerCount(h.runsDir, runId);
    await setPolicy(h.runsDir, runId, engaged + 1);
    const calls = h.providerCalls();

    const result = await recoverRun(h.deps, { runId });

    assert.equal(h.providerCalls() - calls, 1, 'un seul agent repris');
    assert.deepEqual([...result.sessionsCreated], ['claude']);
    assert.ok(result.failure, 'le second agent est nommé');
    assert.equal(result.failure.agent, 'codex');
    assert.ok(expectRefusal(result.failure.error));
    assert.ok(
      result.actions.some((line) => line.includes("politique d'invocations")),
      `le motif est rapporté : ${result.actions.join(' | ')}`,
    );

    const after = await readManifest(runPaths(h.runsDir, runId));
    assert.notEqual(after.agents.claude.session_id, null);
    assert.equal(after.agents.codex.session_id, null);
    const state = await readState(runPaths(h.runsDir, runId));
    assert.equal(state.state, 'FAILED_INITIALIZATION', 'toujours récupérable');
    assert.equal(state.pending_operation, null);
    assert.equal(await ledgerCount(h.runsDir, runId), engaged + 1);
  } finally {
    await h.cleanup();
  }
});

test('12 · FINALIZE legacy reste local : la politique ne l’empêche pas', async () => {
  const h = await harness();
  try {
    const runId = await legacyRun(h);
    const paths = runPaths(h.runsDir, runId);

    // Image d'un crash : la réponse de codex est journalisée, l'état ne l'a pas
    // enregistrée, sa session manque.
    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(paths.events, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    const index = lines.map((l) => (JSON.parse(l) as { type: string }).type).lastIndexOf('assistant_response');
    await writeFile(paths.events, `${lines.slice(0, index + 1).join('\n')}\n`, 'utf8');

    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      agents: Record<string, { session_id: string | null }>;
    };
    const codex = manifest.agents['codex'];
    assert.ok(codex);
    codex.session_id = null;
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const state = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>;
    state['state'] = 'WAITING_AGENT';
    state['pending_operation'] = {
      kind: 'initialization',
      agent: 'codex',
      round: 0,
      prompt_event_id: (JSON.parse(String(lines[index - 1])) as { event_id: string }).event_id,
      source_event_id: null,
      session_id: null,
      return_state: 'FAILED_INITIALIZATION',
      return_control: 'AUTOMATION',
      started_at: new Date().toISOString(),
    };
    await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    // Politique épuisée : un geste strictement local n'en dépend pas.
    await setPolicy(h.runsDir, runId, 0);
    const calls = h.providerCalls();
    const count = await ledgerCount(h.runsDir, runId);

    const result = await recoverRun(h.deps, { runId });

    assert.equal(result.failure, undefined, 'aucun refus : rien n’a été tenté');
    assert.equal(h.providerCalls(), calls);
    assert.equal(await ledgerCount(h.runsDir, runId), count);
    assert.notEqual((await readManifest(paths)).agents.codex.session_id, null, 'finalisé localement');
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// D. Propriétés transversales
// ==========================================================================

test('13 · un seul budget par run, jamais une enveloppe par déclencheur', async () => {
  const h = await harness();
  try {
    const runId = await legacyRun(h);
    await setPolicy(h.runsDir, runId, 1);

    // Un SEND consomme l'unique unité…
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'Une question.' });
    assert.equal(await ledgerCount(h.runsDir, runId), 1);

    // …et le STEP suivant est refusé, bien qu'aucun STEP n'ait jamais eu lieu.
    await assert.rejects(stepRun(h.deps, { runId }), expectRefusal);
    assert.equal(await ledgerCount(h.runsDir, runId), 1);

    // Un autre agent ne rouvre pas non plus d'enveloppe.
    await assert.rejects(
      sendMessage(h.deps, { runId, agent: 'codex', message: 'Une autre.' }),
      expectRefusal,
    );
    assert.equal(await ledgerCount(h.runsDir, runId), 1);
  } finally {
    await h.cleanup();
  }
});

test('14 · pré-ledger : l’histoire antérieure ne consomme rien', async () => {
  const h = await harness();
  try {
    const runId = await legacyRun(h);
    const paths = runPaths(h.runsDir, runId);

    // Un run historique porte déjà des réponses, et aucun journal d'invocations.
    const journal = await legacyJournal(h.runsDir, runId);
    assert.ok(journal.filter((event) => event.type === 'assistant_response').length >= 2);
    const { rm } = await import('node:fs/promises');
    await rm(paths.invocations, { force: true });
    assert.equal(await ledgerCount(h.runsDir, runId), 0);

    await setPolicy(h.runsDir, runId, 1);

    // La première invocation V2.2 est autorisée…
    await stepRun(h.deps, { runId });
    assert.equal(await ledgerCount(h.runsDir, runId), 1);
    // …la suivante non.
    await assert.rejects(stepRun(h.deps, { runId }), expectRefusal);
    assert.equal(await ledgerCount(h.runsDir, runId), 1);
  } finally {
    await h.cleanup();
  }
});

test('15 · un engagement échoué reste consommé, et le refus ne consomme rien', async () => {
  const h = await harness({ failResume: () => new CcrError('AGENT_TIMEOUT', 'délai (fixture)') });
  try {
    const runId = await legacyRun(h);
    await setPolicy(h.runsDir, runId, 1);

    // L'unité est engagée, puis le fournisseur échoue : aucun remboursement.
    await assert.rejects(
      stepRun(h.deps, { runId }),
      (error: unknown) => isCcrError(error) && error.code === 'AGENT_TIMEOUT',
    );
    assert.equal(await ledgerCount(h.runsDir, runId), 1, 'le quota compte les engagements');

    // Trois refus successifs ne changent rien, ni au journal ni au fournisseur.
    const calls = h.providerCalls();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        sendMessage(h.deps, { runId, agent: 'claude', message: 'Encore ?' }),
        expectRefusal,
      );
    }
    assert.equal(await ledgerCount(h.runsDir, runId), 1);
    assert.equal(h.providerCalls(), calls, 'un refus n’appelle personne');
  } finally {
    await h.cleanup();
  }
});

test('16 · sans politique, rien ne change', async () => {
  const h = await harness();
  try {
    const runId = await legacyRun(h);
    const before = await ledgerCount(h.runsDir, runId);

    await stepRun(h.deps, { runId });
    await sendMessage(h.deps, { runId, agent: 'codex', message: 'Un mot.' });

    assert.equal(await ledgerCount(h.runsDir, runId), before + 2);
    assert.equal((await readState(runPaths(h.runsDir, runId))).state, 'READY');

    // Et le document n'a jamais été créé par le simple fait de contrôler.
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(runPaths(h.runsDir, runId).invocationPolicy));
  } finally {
    await h.cleanup();
  }
});

test('17 · un refus n’est jamais un avertissement d’usage', async () => {
  const h = await harness();
  try {
    const runId = await legacyRun(h);
    await setPolicy(h.runsDir, runId, 0);

    const error = await stepRun(h.deps, { runId }).catch((e: unknown) => e);
    assert.ok(isCcrError(error) && error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED');

    // Le refus est bloquant : il n'existe aucun résultat, donc aucun tableau
    // d'avertissements où il aurait pu se dissoudre.
    for (const forbidden of ['AGENT_', 'PROCESS_', 'COCKPIT_BUSY']) {
      assert.equal(error.code.startsWith(forbidden), false);
    }
    assert.equal('invocation_id' in (error.details as Record<string, unknown>), false);
  } finally {
    await h.cleanup();
  }
});

test('18 · l’usage n’entre jamais dans la décision', async () => {
  const h = await harness();
  try {
    const runId = await legacyRun(h);
    const paths = runPaths(h.runsDir, runId);
    await setPolicy(h.runsDir, runId, 1);

    // Un journal d'usage illisible n'empêche pas la décision de quota, qui ne
    // le consulte pas.
    await writeFile(paths.usage, 'ceci n’est pas une ligne JSON\n', 'utf8');
    assert.deepEqual(await assertInvocationQuotaAvailable(paths, runId), {
      limit: 1,
      consumed: 0,
      remaining: 1,
    });

    // Et une observation d'usage ne consomme aucune unité.
    const count = await ledgerCount(h.runsDir, runId);
    assert.equal(count, 0);
  } finally {
    await h.cleanup();
  }
});

test('19 · les surfaces de politique restent inexistantes', async () => {
  const { readFile } = await import('node:fs/promises');
  const executable = async (relative: string): Promise<string> => {
    const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  // Depuis `V2.2-IMP-09`, la création d'un run natif accepte une limite. Ce qui
  // doit rester vrai : aucune surface ne lit ni ne modifie une politique
  // existante, et aucun transport ne décide du quota à la place du service.
  for (const relative of [
    'cockpit/mutations-http.ts',
    'cockpit/server.ts',
    'cli/main.ts',
    'cockpit/web/api.js',
    'cockpit/web/render.js',
  ]) {
    const code = await executable(relative);
    for (const forbidden of [
      'openInvocationPolicyStore',
      'invocation-policy-store',
      'assertInvocationQuotaAvailable',
      'CCR_INVOCATION_QUOTA_EXCEEDED',
      'updateQuota',
    ]) {
      assert.equal(code.includes(forbidden), false, `${relative} n’expose pas ${forbidden}`);
    }
  }

  // `LongOperationManager` ignore toujours la politique : l'admission borne la
  // concurrence fournisseur, elle ne juge pas d'une règle.
  const manager = await executable('cockpit/long-operations.ts');
  assert.equal(manager.includes('quota'), false);
  assert.equal(manager.includes('Quota'), false);
});
