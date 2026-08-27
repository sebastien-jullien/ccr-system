/**
 * V2.2-IMP-06 — moteur historique gouverné.
 *
 * Les trois chemins model-producing encore exécutables sur un run legacy —
 * `STEP`, `SEND`, reprise d'initialisation — traversent **un seul** goulot,
 * `dispatchTurn`. Le câblage y vit, et trois propriétés portent tout le reste.
 *
 *  1. **L'engagement précède l'appel**, et le fake adapter le constate lui-même,
 *     verrou de run tenu.
 *  2. **Un engagement impossible n'appelle personne, et ne ment pas.** Placé
 *     avant `WAITING_AGENT`, son échec laisse un état qui n'a jamais prétendu
 *     qu'un tour avait pu avoir lieu.
 *  3. **La controverse prime sur la gouvernance** : une réponse obtenue reste
 *     persistée, et l'opération se finalise, même si les journaux tombent.
 *
 * Aucun fournisseur réel : les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { AgentKind, CcrEvent } from '../../src/core/run.ts';
import type { UsageObservation } from '../../src/core/usage.ts';
import type { InvocationDispatchRecord, UsageObservationRecord } from '../../src/core/usage-governance.ts';
import { readRunLock } from '../../src/lock/run-lock.ts';
import {
  handoffRun,
  pauseRun,
  recoverRun,
  recoverRunLocked,
  sendMessage,
  startRun,
  stepRun,
} from '../../src/services/run-service.ts';
import type {
  AgentAdapters,
  LegacyGovernanceContext,
  RunServiceDeps,
} from '../../src/services/run-service.ts';
import { applyLongMutation } from '../../src/services/long-mutations.ts';
import { applyCanonicalRecovery } from '../../src/services/recovery-application-service.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openUsageLedger } from '../../src/store/usage-ledger.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { readManifest, readState } from '../../src/store/state-store.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const WORKSPACE = 'E:/prog/exemple';
const MISSION = 'Mission initiale : évaluer la refonte.';

const PROVIDER_USAGE: UsageObservation = {
  tokens: {
    provider: 'claude',
    input_tokens: 13,
    output_tokens: 17,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 4,
  },
  model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' },
  provider_reported_cost: { amount: 0.11, currency: 'USD', source: 'PROVIDER_REPORTED' },
};

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface HarnessOptions {
  readonly usage?: UsageObservation;
  readonly elapsedMs?: number;
  readonly onCall?: (phase: 'start' | 'resume') => Promise<void> | void;
  readonly failStart?: () => unknown;
  readonly failResume?: () => unknown;
}

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  readonly claude: FakeAdapter;
  readonly codex: FakeAdapter;
  startCalls(): number;
  resumeCalls(): number;
  cleanup(): Promise<void>;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const runsDir = await makeTempDir('ccr-legacy-usage-');
  const build = (kind: AgentKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      sessionId: `${kind}-1`,
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.elapsedMs === undefined ? {} : { elapsedMs: options.elapsedMs }),
      ...(options.failStart === undefined ? {} : { failStart: options.failStart }),
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
      onCall: async (phase) => {
        await options.onCall?.(phase);
      },
    });

  const claude = build('claude');
  const codex = build('codex');
  const adapters: AgentAdapters = { claude, codex };
  const phase = (which: 'start' | 'resume'): number =>
    claude.calls.filter((call) => call.phase === which).length +
    codex.calls.filter((call) => call.phase === which).length;

  return {
    runsDir,
    claude,
    codex,
    startCalls: () => phase('start'),
    resumeCalls: () => phase('resume'),
    deps: { runsDir, now: () => new Date(), createAdapters: () => adapters },
    cleanup: () => removeTempDir(runsDir),
  };
}

async function newRun(h: Harness): Promise<string> {
  const run = await startRun(h.deps, {
    runtimeConfig: TEST_RUNTIME_CONFIG,
    title: 'Historique',
    cwd: WORKSPACE,
    prompt: MISSION,
  });
  assert.equal(run.failure, undefined, 'la création doit aboutir');
  return run.runId;
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

/** Jamais un index global : un run historique porte plusieurs déclencheurs. */
function dispatchesOf(
  records: readonly InvocationDispatchRecord[],
  trigger: string,
): InvocationDispatchRecord[] {
  return records.filter((entry) => entry.trigger_kind === trigger);
}

function usageOf(
  records: readonly UsageObservationRecord[],
  invocationId: string,
): UsageObservationRecord[] {
  return records.filter((entry) => entry.invocation_id === invocationId);
}

async function journal(runsDir: string, runId: string): Promise<readonly CcrEvent[]> {
  return (await openEventStore(runPaths(runsDir, runId), runId)).readAll();
}

/** Journal d'invocations dont l'écriture échoue **avant** tout append effectif. */
function brokenInvocations(
  failAt = 1,
): NonNullable<LegacyGovernanceContext['seams']>['openInvocationLedger'] {
  let seen = 0;
  return async (paths, runId, opts) => {
    const real = await openInvocationLedger(paths, runId, opts);
    return {
      ...real,
      append: async (draft, now) => {
        seen += 1;
        // Déterministe, et strictement avant l'écriture : « journal inchangé »
        // reste une affirmation vérifiable.
        if (seen === failAt) throw new CcrError('JOURNAL_INVALID', 'disque saturé (fixture)');
        return real.append(draft, now);
      },
    };
  };
}

function brokenUsage(failAt = 1): NonNullable<LegacyGovernanceContext['seams']>['openUsageLedger'] {
  let seen = 0;
  return async (paths, runId, opts) => {
    const real = await openUsageLedger(paths, runId, opts);
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

/** Ce que le verrou et le journal montrent au moment exact de l'appel. */
interface Witness {
  lockHeld: boolean;
  records: InvocationDispatchRecord[];
}

function witnessAt(runsDirOf: () => string, runIdOf: () => string, witness: Witness) {
  return async (): Promise<void> => {
    const runId = runIdOf();
    if (runId.length === 0) return;
    const paths: RunPaths = runPaths(runsDirOf(), runId);
    witness.lockHeld = (await readRunLock(paths)) !== undefined;
    witness.records = await (await openInvocationLedger(paths, runId)).readAll();
  };
}

// ==========================================================================
// A. STEP
// ==========================================================================

test('1 · STEP : l’engagement précède l’appel, sous verrou, avec ses corrélations', async () => {
  let runId = '';
  const witness: Witness = { lockHeld: false, records: [] };
  const runsDirBox = { value: '' };
  const h = await harness({
    usage: PROVIDER_USAGE,
    elapsedMs: 900,
    onCall: witnessAt(() => runsDirBox.value, () => runId, witness),
  });
  runsDirBox.value = h.runsDir;
  try {
    runId = await newRun(h);
    // Aucun engagement n'a été pris par le helper historique de création.
    assert.deepEqual((await ledgers(h.runsDir, runId)).invocations, []);

    const history = await journal(h.runsDir, runId);
    const source = [...history].reverse().find((event) => event.type === 'assistant_response');
    assert.ok(source);

    const result = await stepRun(h.deps, { runId });

    const { invocations, usage } = await ledgers(h.runsDir, runId);
    const steps = dispatchesOf(invocations, 'STEP');
    assert.equal(steps.length, 1);
    const dispatch = steps[0] as InvocationDispatchRecord;

    // Le fake adapter a constaté l'engagement au moment même de sa reprise…
    assert.equal(dispatchesOf(witness.records, 'STEP').length, 1);
    // …et le verrou de run le couvrait : c'est lui qui sérialise l'allocation.
    assert.equal(witness.lockHeld, true);

    assert.equal(dispatch.trigger_kind, 'STEP');
    assert.deepEqual(dispatch.identity, {
      generation: 'LEGACY_V2_EXECUTION',
      agent_kind: result.targetAgent,
      provider: result.targetAgent,
    });
    assert.equal(dispatch.session_id, result.targetSessionId);
    assert.equal(dispatch.source_event_id, source.event_id);
    assert.equal(dispatch.source_event_id, result.sourceEventId);
    assert.equal(dispatch.round, result.round);
    assert.equal(dispatch.operation_id, undefined, 'la CLI ne corrèle rien');

    // Le prompt engagé est celui que ce tour a réellement écrit.
    const after = await journal(h.runsDir, runId);
    const prompt = after.find((event) => event.event_id === dispatch.prompt_event_id);
    assert.equal(prompt?.type, 'prompt_sent');
    assert.equal(prompt?.round, result.round);

    // Deux observations, rattachées à cette invocation.
    assert.deepEqual(
      usageOf(usage, dispatch.invocation_id)
        .map((entry) => entry.provenance)
        .sort(),
      ['CCR_MEASURED', 'PROVIDER_REPORTED'],
    );
    assert.deepEqual(result.usageGovernanceWarnings, []);
  } finally {
    await h.cleanup();
  }
});

test('2 · STEP : un engagement impossible n’appelle personne et ne ment pas', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const before = await readState(runPaths(h.runsDir, runId));
    const resumes = h.resumeCalls();

    await assert.rejects(
      (await import('../../src/services/run-service.ts')).stepRunLocked(h.deps, runId, {
        seams: { openInvocationLedger: brokenInvocations() },
      }),
      (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_LEDGER_WRITE_FAILED',
    );

    assert.equal(h.resumeCalls() - resumes, 0, 'aucun fournisseur');
    assert.deepEqual((await ledgers(h.runsDir, runId)).invocations, [], 'journal inchangé');

    const state = await readState(runPaths(h.runsDir, runId));
    // L'état ne dit jamais « un tour a peut-être eu lieu » : c'est tout l'objet
    // du placement avant `WAITING_AGENT`.
    assert.notEqual(state.state, 'WAITING_AGENT');
    assert.equal(state.pending_operation, null);

    const events = await journal(h.runsDir, runId);
    assert.equal(
      events.filter((event) => event.type === 'process_failed').length,
      0,
      'la panne appartient à CCR, jamais à l’expert',
    );
    // Le round ouvert n'a consommé aucune source : la tentative reste possible.
    assert.equal(events.filter((event) => event.type === 'round_completed').length, 0);
    assert.equal(events.filter((event) => event.type === 'round_started').length, 1);
    assert.equal(state.round, before.round + 1, 'le numéro de round est consommé — assumé');

    // Et la tentative suivante aboutit sur la même source.
    const retry = await stepRun(h.deps, { runId });
    const steps = dispatchesOf((await ledgers(h.runsDir, runId)).invocations, 'STEP');
    assert.equal(steps.length, 1, 'un seul engagement, celui qui a abouti');
    assert.equal(retry.sourceEventId, (steps[0] as InvocationDispatchRecord).source_event_id);
  } finally {
    await h.cleanup();
  }
});

test('3 · STEP : un échec fournisseur conserve l’engagement, sans usage', async () => {
  const h = await harness({
    usage: PROVIDER_USAGE,
    failResume: () => new CcrError('AGENT_TIMEOUT', 'délai (fixture)'),
  });
  try {
    const runId = await newRun(h);
    await assert.rejects(
      stepRun(h.deps, { runId }),
      (error: unknown) => isCcrError(error) && error.code === 'AGENT_TIMEOUT',
    );

    const { invocations, usage } = await ledgers(h.runsDir, runId);
    assert.equal(dispatchesOf(invocations, 'STEP').length, 1, 'l’engagement demeure');
    assert.equal(usage.length, 0, 'aucun usage pour un tour sans retour');

    // Sémantique legacy intacte.
    const events = await journal(h.runsDir, runId);
    assert.equal(events.filter((event) => event.type === 'process_failed').length, 1);
    assert.equal((await readState(runPaths(h.runsDir, runId))).state, 'PAUSED');
  } finally {
    await h.cleanup();
  }
});

test('4 · STEP : sans usage fournisseur, une seule observation — jamais des zéros', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await stepRun(h.deps, { runId });

    const { invocations, usage } = await ledgers(h.runsDir, runId);
    const dispatch = dispatchesOf(invocations, 'STEP')[0] as InvocationDispatchRecord;
    const observations = usageOf(usage, dispatch.invocation_id);
    assert.deepEqual(
      observations.map((entry) => entry.provenance),
      ['CCR_MEASURED'],
    );
    const measured = observations[0] as unknown as Record<string, unknown>;
    assert.equal(measured['tokens'], undefined, 'aucun jeton inventé');
    assert.equal(measured['provider_reported_cost'], undefined, 'aucun coût inventé');
  } finally {
    await h.cleanup();
  }
});

test('5 · STEP : une panne d’usage n’interrompt rien', async () => {
  const h = await harness({ usage: PROVIDER_USAGE });
  try {
    const runId = await newRun(h);
    const { stepRunLocked } = await import('../../src/services/run-service.ts');
    const { withRunLock } = await import('../../src/lock/run-lock.ts');

    const result = await withRunLock(runPaths(h.runsDir, runId), 'step', () =>
      stepRunLocked(h.deps, runId, { seams: { openUsageLedger: brokenUsage(1) } }),
    );

    // L'opération se finalise entièrement.
    assert.equal((await readState(runPaths(h.runsDir, runId))).state, 'READY');
    const events = await journal(h.runsDir, runId);
    assert.equal(events.filter((event) => event.type === 'round_completed').length, 1);
    assert.equal(events.filter((event) => event.type === 'assistant_response').length, 3);

    // Diagnostic structuré, sans matière sensible, et l'observation restante
    // subsiste : aucun rollback.
    assert.equal(result.usageGovernanceWarnings.length, 1);
    const warning = result.usageGovernanceWarnings[0];
    assert.equal(warning?.provenance, 'PROVIDER_REPORTED');
    assert.equal(warning?.error_code, 'JOURNAL_INVALID');
    for (const forbidden of ['Mission', 'prompt', 'response', 'stdout']) {
      assert.equal(JSON.stringify(warning).includes(forbidden), false, `sans ${forbidden}`);
    }

    const { invocations, usage } = await ledgers(h.runsDir, runId);
    const dispatch = dispatchesOf(invocations, 'STEP')[0] as InvocationDispatchRecord;
    assert.deepEqual(
      usageOf(usage, dispatch.invocation_id).map((entry) => entry.provenance),
      ['CCR_MEASURED'],
    );
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// B. SEND
// ==========================================================================

test('6 · SEND : engagement avant l’appel, sans source ni transfert', async () => {
  let runId = '';
  const witness: Witness = { lockHeld: false, records: [] };
  const box = { value: '' };
  const h = await harness({
    usage: PROVIDER_USAGE,
    onCall: witnessAt(() => box.value, () => runId, witness),
  });
  box.value = h.runsDir;
  try {
    runId = await newRun(h);
    const manifest = await readManifest(runPaths(h.runsDir, runId));

    const result = await sendMessage(h.deps, { runId, agent: 'claude', message: 'Précisez le coût.' });

    const { invocations, usage } = await ledgers(h.runsDir, runId);
    const sends = dispatchesOf(invocations, 'SEND');
    assert.equal(sends.length, 1);
    const dispatch = sends[0] as InvocationDispatchRecord;

    assert.equal(dispatchesOf(witness.records, 'SEND').length, 1, 'engagé avant l’appel');
    assert.equal(witness.lockHeld, true);

    assert.equal(dispatch.trigger_kind, 'SEND');
    assert.deepEqual(dispatch.identity, {
      generation: 'LEGACY_V2_EXECUTION',
      agent_kind: 'claude',
      provider: 'claude',
    });
    assert.equal(dispatch.session_id, manifest.agents.claude.session_id);
    // Un envoi humain n'a pas de source, et ne consomme aucun round.
    assert.equal(dispatch.source_event_id, undefined);
    assert.equal(dispatch.round, 0);

    const events = await journal(h.runsDir, runId);
    const prompt = events.find((event) => event.event_id === dispatch.prompt_event_id);
    assert.equal(prompt?.type, 'human_message');

    assert.deepEqual(
      usageOf(usage, dispatch.invocation_id)
        .map((entry) => entry.provenance)
        .sort(),
      ['CCR_MEASURED', 'PROVIDER_REPORTED'],
    );
    assert.deepEqual(result.usageGovernanceWarnings, []);
  } finally {
    await h.cleanup();
  }
});

test('7 · SEND : engagement impossible — le message humain survit, l’état aussi', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    await pauseRun(h.deps, { runId });
    const before = await readState(runPaths(h.runsDir, runId));
    const resumes = h.resumeCalls();

    const { sendMessageLocked } = await import('../../src/services/run-service.ts');
    const { withRunLock } = await import('../../src/lock/run-lock.ts');

    await assert.rejects(
      withRunLock(runPaths(h.runsDir, runId), 'send', () =>
        sendMessageLocked(
          h.deps,
          runId,
          { runId, agent: 'codex', message: 'Une question.' },
          { seams: { openInvocationLedger: brokenInvocations() } },
        ),
      ),
      (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_LEDGER_WRITE_FAILED',
    );

    assert.equal(h.resumeCalls() - resumes, 0);
    assert.deepEqual((await ledgers(h.runsDir, runId)).invocations, []);

    const state = await readState(runPaths(h.runsDir, runId));
    assert.equal(state.state, before.state, 'l’état d’origine est conservé');
    assert.equal(state.control, before.control);
    assert.equal(state.pending_operation, null);

    const events = await journal(h.runsDir, runId);
    assert.equal(events.filter((event) => event.type === 'process_failed').length, 0);
    // Le message humain reste un fait historique : il n'est pas supprimé.
    assert.equal(
      events.filter((event) => event.type === 'human_message').length,
      1,
      'le message est journalisé, et aucune réponse n’est fabriquée',
    );
    assert.equal(events.filter((event) => event.type === 'assistant_response').length, 2);
  } finally {
    await h.cleanup();
  }
});

test('8 · SEND : échec fournisseur puis panne d’usage — l’engagement tient', async () => {
  const failing = await harness({
    failResume: () => new CcrError('AGENT_TIMEOUT', 'délai (fixture)'),
  });
  try {
    const runId = await newRun(failing);
    await assert.rejects(
      sendMessage(failing.deps, { runId, agent: 'claude', message: 'Question.' }),
      (error: unknown) => isCcrError(error) && error.code === 'AGENT_TIMEOUT',
    );
    const { invocations, usage } = await ledgers(failing.runsDir, runId);
    assert.equal(dispatchesOf(invocations, 'SEND').length, 1);
    assert.equal(usage.length, 0);
  } finally {
    await failing.cleanup();
  }

  const h = await harness({ usage: PROVIDER_USAGE });
  try {
    const runId = await newRun(h);
    const { sendMessageLocked } = await import('../../src/services/run-service.ts');
    const { withRunLock } = await import('../../src/lock/run-lock.ts');

    const result = await withRunLock(runPaths(h.runsDir, runId), 'send', () =>
      sendMessageLocked(
        h.deps,
        runId,
        { runId, agent: 'claude', message: 'Question.' },
        { seams: { openUsageLedger: brokenUsage(2) } },
      ),
    );

    assert.equal(result.response.length > 0, true, 'la réponse est rendue');
    assert.equal(result.usageGovernanceWarnings.length, 1);
    assert.equal(result.usageGovernanceWarnings[0]?.provenance, 'CCR_MEASURED');
    assert.equal((await readState(runPaths(h.runsDir, runId))).state, 'READY');
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// C. Reprise d'initialisation
// ==========================================================================

/** Run historique dont l'initialisation s'est arrêtée sur le premier agent. */
async function crashedInitialization(
  options: HarnessOptions = {},
): Promise<{ h: Harness; runId: string }> {
  let failures = 1;
  const h = await harness({
    ...options,
    failStart: () => {
      if (failures <= 0) return options.failStart?.();
      failures -= 1;
      return new CcrError('AGENT_TIMEOUT', 'délai (fixture)');
    },
  });
  const run = await startRun(h.deps, {
    runtimeConfig: TEST_RUNTIME_CONFIG,
    title: 'Initialisation interrompue',
    cwd: WORKSPACE,
    prompt: MISSION,
  });
  assert.notEqual(run.failure, undefined);
  const manifest = await readManifest(runPaths(h.runsDir, run.runId));
  assert.equal(manifest.agents.claude.session_id, null);
  assert.equal(manifest.agents.codex.session_id, null);
  // Le helper historique de création n'a rien engagé, même en échouant.
  assert.deepEqual((await ledgers(h.runsDir, run.runId)).invocations, []);
  return { h, runId: run.runId };
}

test('9 · reprise : deux tentatives neuves, séquentielles, sans session au dispatch', async () => {
  let runId = '';
  const seen: number[] = [];
  const box = { value: '' };
  const h0 = { value: undefined as Harness | undefined };
  const { h, runId: id } = await crashedInitialization({
    usage: PROVIDER_USAGE,
    onCall: async (phase) => {
      if (phase !== 'start' || runId.length === 0) return;
      const records = await (
        await openInvocationLedger(runPaths(box.value, runId), runId)
      ).readAll();
      seen.push(dispatchesOf(records, 'RECOVERY_CONTINUE').length);
    },
  });
  h0.value = h;
  box.value = h.runsDir;
  runId = id;
  try {
    const result = await recoverRun(h.deps, { runId });
    assert.deepEqual([...result.sessionsCreated], ['claude', 'codex']);

    // Au premier appel exactement un engagement ; au second, exactement deux.
    assert.deepEqual(seen, [1, 2], 'aucune préallocation');

    const { invocations, usage } = await ledgers(h.runsDir, runId);
    const fresh = dispatchesOf(invocations, 'RECOVERY_CONTINUE');
    assert.equal(fresh.length, 2);
    assert.deepEqual(
      fresh.map((entry) => (entry.identity as { agent_kind?: string }).agent_kind),
      ['claude', 'codex'],
    );

    const events = await journal(h.runsDir, runId);
    for (const entry of fresh) {
      assert.equal(entry.session_id, undefined, 'la session est créée par l’adapter');
      assert.equal(entry.round, undefined, 'une reprise n’est pas un transfert');
      assert.equal(entry.source_event_id, undefined);
      assert.equal((entry.identity as { generation?: string }).generation, 'LEGACY_V2_EXECUTION');
      // Prompt FRAIS : celui de cette tentative, pas l'orphelin de l'ancienne.
      const prompt = events.find((event) => event.event_id === entry.prompt_event_id);
      assert.equal(prompt?.type, 'prompt_sent');
      assert.equal(usageOf(usage, entry.invocation_id).length, 2);
    }
    const firstPrompt = events.find((event) => event.type === 'prompt_sent');
    assert.notEqual(fresh[0]?.prompt_event_id, firstPrompt?.event_id);
    assert.deepEqual(result.usageGovernanceWarnings, []);
  } finally {
    await h.cleanup();
  }
});

test('10 · reprise : engagement impossible — aucun appel, slot toujours récupérable', async () => {
  const { h, runId } = await crashedInitialization();
  try {
    const starts = h.startCalls();
    const { withRunLock } = await import('../../src/lock/run-lock.ts');

    // La reprise legacy ne relève pas un échec de slot : elle le rapporte et
    // rend la main. Le câblage n'a pas changé ce contrat.
    const result = await withRunLock(runPaths(h.runsDir, runId), 'recover', () =>
      recoverRunLocked(h.deps, runId, { runId }, [], undefined, {
        seams: { openInvocationLedger: brokenInvocations() },
      }),
    );
    assert.deepEqual([...result.sessionsCreated], []);
    assert.ok(
      result.actions.some((line) => line.includes("journal d'invocations")),
      `la cause réelle est nommée : ${result.actions.join(' | ')}`,
    );

    assert.equal(h.startCalls() - starts, 0);
    assert.deepEqual((await ledgers(h.runsDir, runId)).invocations, []);

    const manifest = await readManifest(runPaths(h.runsDir, runId));
    assert.equal(manifest.agents.claude.session_id, null);
    const state = await readState(runPaths(h.runsDir, runId));
    assert.equal(state.state, 'FAILED_INITIALIZATION', 'toujours récupérable');
    assert.equal(state.pending_operation, null);
    assert.equal(
      (await journal(h.runsDir, runId)).filter((event) => event.type === 'process_failed').length,
      1,
      'seul l’échec fournisseur initial, aucun échec fabriqué',
    );

    // Et la tentative explicite suivante aboutit.
    const retry = await recoverRun(h.deps, { runId });
    assert.deepEqual([...retry.sessionsCreated], ['claude', 'codex']);
  } finally {
    await h.cleanup();
  }
});

test('11 · reprise : le premier engagement survit à l’échec du second', async () => {
  const { h, runId } = await crashedInitialization();
  try {
    const { withRunLock } = await import('../../src/lock/run-lock.ts');
    const result = await withRunLock(runPaths(h.runsDir, runId), 'recover', () =>
      recoverRunLocked(h.deps, runId, { runId }, [], undefined, {
        seams: { openInvocationLedger: brokenInvocations(2) },
      }),
    );

    assert.deepEqual([...result.sessionsCreated], ['claude'], 'seul le premier a abouti');
    assert.equal(h.startCalls(), 2, 'la création initiale, puis le seul slot repris');
    assert.equal(
      (await readState(runPaths(h.runsDir, runId))).state,
      'FAILED_INITIALIZATION',
      'le run reste récupérable',
    );

    const fresh = dispatchesOf((await ledgers(h.runsDir, runId)).invocations, 'RECOVERY_CONTINUE');
    assert.equal(fresh.length, 1);
    assert.equal((fresh[0]?.identity as { agent_kind?: string }).agent_kind, 'claude');

    const manifest = await readManifest(runPaths(h.runsDir, runId));
    assert.equal(manifest.agents.claude.session_id, 'claude-1', 'le premier slot est conservé');
    assert.equal(manifest.agents.codex.session_id, null);
  } finally {
    await h.cleanup();
  }
});

test('12 · reprise : échec fournisseur — engagement conservé, fail-fast historique', async () => {
  let starts = 0;
  const { h, runId } = await crashedInitialization({
    failStart: () => {
      starts += 1;
      return starts === 1 ? undefined : new CcrError('AGENT_TIMEOUT', 'délai (fixture)');
    },
  });
  try {
    const result = await recoverRun(h.deps, { runId });

    const fresh = dispatchesOf((await ledgers(h.runsDir, runId)).invocations, 'RECOVERY_CONTINUE');
    assert.equal(fresh.length, 2, 'les deux engagements ont été pris');
    assert.deepEqual([...result.sessionsCreated], ['claude'], 'le second a échoué');

    const manifest = await readManifest(runPaths(h.runsDir, runId));
    assert.equal(manifest.agents.codex.session_id, null);
    assert.equal((await readState(runPaths(h.runsDir, runId))).state, 'FAILED_INITIALIZATION');
  } finally {
    await h.cleanup();
  }
});

test('13 · FINALIZE reste local : aucun engagement, aucun appel', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);

    // Image d'un crash : la réponse d'initialisation de codex est journalisée,
    // l'état ne l'a pas enregistrée, et sa session manque encore.
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

    const calls = h.startCalls() + h.resumeCalls();
    await recoverRun(h.deps, { runId });

    // Le repair V2.1 est gelé : la finalisation est locale, et s'arrête là.
    assert.equal(h.startCalls() + h.resumeCalls() - calls, 0);
    const after = await ledgers(h.runsDir, runId);
    assert.deepEqual(dispatchesOf(after.invocations, 'RECOVERY_CONTINUE'), []);
    assert.deepEqual(after.usage, []);
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// D. Surfaces applicatives, frontières et cumul
// ==========================================================================

test('14 · voie applicative : corrélation portée, admission inchangée', async () => {
  const h = await harness({ usage: PROVIDER_USAGE });
  try {
    const runId = await newRun(h);
    const manager = createLongOperationManager();
    const snapshot = await readStableRunSnapshot(h.runsDir, runId);

    const step = await applyLongMutation(
      { runService: h.deps, manager, operationId: 'op_step' },
      { runId, action: 'STEP', expectedRevision: snapshot.revision },
    );
    assert.equal(step.usedProvider, true);
    assert.deepEqual(step.usageGovernanceWarnings, []);
    assert.equal(manager.activeCount(), 0, 'le créneau est relâché');

    const next = await readStableRunSnapshot(h.runsDir, runId);
    await applyLongMutation(
      { runService: h.deps, manager, operationId: 'op_send' },
      { runId, action: 'SEND', expectedRevision: next.revision, target: 'codex', content: 'Suite.' },
    );

    const { invocations } = await ledgers(h.runsDir, runId);
    assert.equal((dispatchesOf(invocations, 'STEP')[0] as InvocationDispatchRecord).operation_id, 'op_step');
    assert.equal((dispatchesOf(invocations, 'SEND')[0] as InvocationDispatchRecord).operation_id, 'op_send');

    // La reprise applicative porte aussi la sienne.
    const { h: r, runId: recovered } = await crashedInitialization();
    try {
      const before = await readStableRunSnapshot(r.runsDir, recovered);
      const admitted: string[] = [];
      await applyCanonicalRecovery(
        r.deps,
        {
          runId: recovered,
          expectedRevision: before.revision,
          capability: 'RECOVERY_CONTINUE_INITIALIZATION',
        },
        {
          onReadyForEffect: (id) => {
            admitted.push(id);
          },
        },
        { operationId: 'op_recover' },
      );
      assert.deepEqual(admitted, ['RECOVERY_CONTINUE_INITIALIZATION']);
      const fresh = dispatchesOf((await ledgers(r.runsDir, recovered)).invocations, 'RECOVERY_CONTINUE');
      assert.equal(fresh.length, 2);
      for (const entry of fresh) assert.equal(entry.operation_id, 'op_recover');
    } finally {
      await r.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test('15 · un même run historique : identifiants croissants, révision intacte', async () => {
  const h = await harness();
  try {
    const runId = await newRun(h);
    const paths = runPaths(h.runsDir, runId);

    // Le run porte déjà deux réponses historiques, sans aucun journal d'usage :
    // la première nouvelle invocation part malgré tout de `inv_000001`.
    assert.equal((await journal(h.runsDir, runId)).filter((e) => e.type === 'assistant_response').length, 2);

    const revisionBefore = (await readStableRunSnapshot(h.runsDir, runId)).revision;
    await stepRun(h.deps, { runId });
    await sendMessage(h.deps, { runId, agent: 'codex', message: 'Un mot.' });
    await stepRun(h.deps, { runId });

    const { invocations } = await ledgers(h.runsDir, runId);
    assert.deepEqual(
      invocations.map((entry) => entry.invocation_id),
      ['inv_000001', 'inv_000002', 'inv_000003'],
    );
    assert.deepEqual(
      invocations.map((entry) => entry.trigger_kind),
      ['STEP', 'SEND', 'STEP'],
    );
    // Filtrage explicite, jamais un index : les deux STEP restent distincts.
    const steps = dispatchesOf(invocations, 'STEP');
    assert.equal(steps.length, 2);
    assert.notEqual(steps[0]?.prompt_event_id, steps[1]?.prompt_event_id);
    assert.notEqual(steps[0]?.round, steps[1]?.round);

    // Les journaux de gouvernance restent hors de la révision métier : la
    // révision a changé à cause des tours, jamais à cause d'eux.
    const snapshot = await readStableRunSnapshot(h.runsDir, runId);
    assert.notEqual(snapshot.revision, revisionBefore);
    const before = snapshot.revision;
    await (await openUsageLedger(paths, runId)).readAll();
    assert.equal((await readStableRunSnapshot(h.runsDir, runId)).revision, before);
  } finally {
    await h.cleanup();
  }
});

test('16 · frontières : création historique, handoff, gestes locaux, identité', async () => {
  const h = await harness();
  try {
    // Le helper historique de création traverse le même goulot sans gouvernance.
    const runId = await newRun(h);
    assert.deepEqual((await ledgers(h.runsDir, runId)).invocations, []);
    assert.deepEqual((await ledgers(h.runsDir, runId)).usage, []);

    // HANDOFF : interactif, hors usage mesuré par CCR.
    await pauseRun(h.deps, { runId });
    await handoffRun(h.deps, { runId, agent: 'claude' });
    assert.deepEqual((await ledgers(h.runsDir, runId)).invocations, []);
    assert.deepEqual((await ledgers(h.runsDir, runId)).usage, []);

    // Un envoi humain gouverné, puis vérification de la forme d'identité.
    await sendMessage(h.deps, { runId, agent: 'claude', message: 'Un mot.' });
    const { invocations } = await ledgers(h.runsDir, runId);
    assert.equal(invocations.length, 1);
    const identity = invocations[0]?.identity as Record<string, unknown>;
    assert.equal(identity['generation'], 'LEGACY_V2_EXECUTION');
    assert.equal(identity['agent_kind'], 'claude');
    assert.equal(identity['provider'], 'claude');
    assert.equal('expert_slot' in identity, false, 'ce moteur n’a pas de rôles');
    assert.equal('author' in identity, false);
    assert.equal('challenger' in identity, false);
  } finally {
    await h.cleanup();
  }
});

test('17 · gardes de source : le goulot est unique, le writer reste ignorant', async () => {
  const executable = async (relative: string): Promise<string> => {
    const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  const service = await executable('services/run-service.ts');

  // Une seule implémentation de ledger dans tout le moteur historique.
  assert.equal(
    (service.match(/openInvocationLedger\)?\(/g) ?? []).length,
    1,
    'un seul site d’ouverture du journal d’invocations',
  );
  assert.equal((service.match(/invocations\.append\(/g) ?? []).length, 1);

  // Le déclencheur est reçu, jamais déduit de `operationKind`.
  assert.equal(service.includes("trigger_kind: 'STEP'"), false);
  assert.equal(service.includes('trigger_kind: governance.trigger'), true);
  for (const trigger of ["trigger: 'STEP'", "trigger: 'SEND'", "trigger: 'RECOVERY_CONTINUE'"]) {
    assert.ok(service.includes(trigger), `${trigger} est déclaré par son appelant`);
  }

  // Le helper d'usage ignore toujours tout du moteur qui l'appelle.
  const writer = await executable('services/usage-governance-writer.ts');
  for (const forbidden of ['legacy', 'LEGACY', 'agent_kind', 'trigger', 'recovery']) {
    assert.equal(writer.includes(forbidden), false, `le helper ignore ${forbidden}`);
  }

  // Ni tarif, ni coût estimé, ni quota, nulle part dans la gouvernance.
  for (const relative of ['core/usage-governance.ts', 'services/usage-governance-writer.ts']) {
    const code = await executable(relative);
    for (const forbidden of ['pricing', 'CostEstimate', 'quota']) {
      assert.equal(code.includes(forbidden), false, `${relative} sans ${forbidden}`);
    }
  }

  // Aucun import de transport dans le service historique.
  assert.equal(service.includes("from '../cockpit/"), false);
});
