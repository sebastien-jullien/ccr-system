/**
 * Slice 1F — Native STEP Execution & Cursor Commit.
 *
 * Premier transfert réellement exécuté par les slots. Deux propriétés portent
 * tout le reste :
 *
 *   1. c'est la session de la **cible** qui est reprise, jamais celle de la
 *      source — et en same-provider, les deux sont servies par le même adapter ;
 *   2. le curseur et `state.round` n'avancent qu'au commit du transfert
 *      finalisé, et le contexte de reprise reste durable jusque-là.
 *
 * Aucun fournisseur réel : tous les adapters sont des fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_ROUND_SCHEMA_VERSION, NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import { DEFAULT_NATIVE_BINDINGS, startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings } from '../../src/services/native-start-service.ts';
import { stepNativeRun } from '../../src/services/native-step-service.ts';
import { planNativeStepForRun } from '../../src/services/native-step-planner.ts';
import { startRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { roundDir, runPaths } from '../../src/store/layout.ts';
import { readJsonFile } from '../../src/store/atomic-file.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readNativeRoundMetadata, nativeRoundArtifactNames } from '../../src/store/native-round-store.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-10T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

interface ResumeCall {
  readonly provider: ProviderKind;
  readonly sessionId: string;
  readonly prompt: string;
}

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  readonly resumes: ResumeCall[];
  readonly starts: ProviderKind[];
}

interface HarnessOptions {
  readonly claudeSessions?: readonly string[];
  readonly codexSessions?: readonly string[];
  readonly resumeSessionId?: { readonly claude?: string; readonly codex?: string };
  readonly failResume?: { readonly claude?: () => unknown; readonly codex?: () => unknown };
  readonly maxTransferBytes?: number;
  readonly answer?: (prompt: string) => string;
}

function harness(runsDir: string, options: HarnessOptions = {}): Harness {
  const resumes: ResumeCall[] = [];
  const starts: ProviderKind[] = [];

  const build = (kind: ProviderKind): FakeAdapter => {
    const sessions = kind === 'claude' ? options.claudeSessions : options.codexSessions;
    const drift = options.resumeSessionId?.[kind];
    const failure = options.failResume?.[kind];
    return createFakeAdapter({
      kind,
      startSessionIds: sessions ?? [`${kind}-1`, `${kind}-2`],
      ...(drift === undefined ? {} : { resumeSessionId: drift }),
      ...(failure === undefined ? {} : { failResume: failure }),
      ...(options.answer === undefined ? {} : { respond: options.answer }),
      onCall: (phase, prompt) => {
        if (phase === 'start') starts.push(kind);
      },
    });
  };

  const adapters = { claude: build('claude'), codex: build('codex') };

  // L'identité de session réellement reprise est lue depuis les appels du fake.
  const collectResumes = (): void => {
    resumes.length = 0;
    for (const kind of ['claude', 'codex'] as const) {
      for (const call of adapters[kind].calls) {
        if (call.phase === 'resume' && call.sessionId !== undefined) {
          resumes.push({ provider: kind, sessionId: call.sessionId, prompt: call.prompt });
        }
      }
    }
  };

  return {
    runsDir,
    adapters,
    starts,
    get resumes(): ResumeCall[] {
      collectResumes();
      return resumes;
    },
    deps: {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => adapters,
      ...(options.maxTransferBytes === undefined ? {} : { maxTransferBytes: options.maxTransferBytes }),
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

async function startedRun(h: Harness, dir: string, bindings?: NativeExpertBindings): Promise<string> {
  const result = await startNativeRun(h.deps, {
    title: 'T',
    cwd: dir,
    prompt: MISSION,
    ...(bindings === undefined ? {} : { bindings }),
    runtimeConfig: nativeRuntime(),
  });
  assert.equal(result.failure, undefined, 'START doit aboutir');
  return result.runId;
}

async function journal(runsDir: string, runId: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// ==========================================================================
// A. Mixed-provider et alternance réelle
// ==========================================================================

test('A1–A4 · deux STEP successifs alternent les slots et reprennent la bonne session', async () => {
  const dir = await makeTempDir('ccr-1f-mixed-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const runId = await startedRun(h, dir);
    const paths = runPaths(h.runsDir, runId);

    // 22 · START n'a créé aucun artefact de round.
    assert.deepEqual(await readdir(paths.roundsDir), []);

    // ---- STEP #1 : AUTHOR → CHALLENGER. Les rôles portent le scénario ;
    // le moteur de chacun est lu dans la liaison, jamais recopié.
    const authorProvider = DEFAULT_NATIVE_BINDINGS.author;
    const challengerProvider = DEFAULT_NATIVE_BINDINGS.challenger;
    const first = await stepNativeRun(h.deps, runId);
    assert.equal(first.sourceSlot, 'author');
    assert.equal(first.targetSlot, 'challenger');
    assert.deepEqual(
      h.resumes.map((call) => [call.provider, call.sessionId]),
      [[challengerProvider, `${challengerProvider}-1`]],
      'seule la session du challenger est reprise',
    );
    assert.equal(first.round, 1);
    assert.equal(first.state.round, 1);
    assert.equal(first.state.next_step_source_slot, 'challenger');
    assert.equal(first.state.state, 'READY');
    assert.equal(first.state.control, 'AUTOMATION');

    // ---- STEP #2 : CHALLENGER → AUTHOR.
    const second = await stepNativeRun(h.deps, runId);
    assert.equal(second.sourceSlot, 'challenger');
    assert.equal(second.targetSlot, 'author');
    // `collectResumes` parcourt les moteurs, pas la chronologie : l'ordre du
    // tableau collecté ne dit donc rien de la succession. Ce qui est éprouvé
    // ici, c'est que chaque expert a été repris exactement une fois et sur SA
    // session ; la chronologie, elle, est déjà établie par l'assertion du
    // STEP #1, qui observait une seule reprise.
    assert.deepEqual(
      h.resumes.filter((call) => call.provider === challengerProvider).map((call) => call.sessionId),
      [`${challengerProvider}-1`],
      'le challenger a été repris une fois, sur sa session',
    );
    assert.deepEqual(
      h.resumes.filter((call) => call.provider === authorProvider).map((call) => call.sessionId),
      [`${authorProvider}-1`],
      'le second transfert reprend la session de l’auteur',
    );
    assert.equal(h.resumes.length, 2, 'exactement deux reprises, pas une de plus');
    assert.equal(second.round, 2);
    assert.equal(second.state.round, 2);
    assert.equal(second.state.next_step_source_slot, 'author');

    // Aucun démarrage supplémentaire : un STEP reprend, il ne crée jamais.
    assert.deepEqual(
      h.starts,
      [authorProvider, challengerProvider],
      'les deux seuls `start` sont ceux du START',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Same-provider
// ==========================================================================

test('B5–B8 · same-provider : la cible est choisie par slot, jamais par moteur', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const dir = await makeTempDir('ccr-1f-same-');
    try {
      const h = harness(path.join(dir, 'runs'), {
        [`${provider}Sessions`]: ['S1', 'S2'],
      } as HarnessOptions);
      const runId = await startedRun(h, dir, { author: provider, challenger: provider });

      const first = await stepNativeRun(h.deps, runId);
      assert.equal(first.targetSlot, 'challenger');
      assert.deepEqual(
        h.resumes.map((call) => call.sessionId),
        ['S2'],
        `${provider}/${provider} : la session du challenger, jamais celle de l’auteur`,
      );

      const second = await stepNativeRun(h.deps, runId);
      assert.equal(second.targetSlot, 'author');
      assert.deepEqual(h.resumes.map((call) => call.sessionId), ['S2', 'S1']);
      // Un seul adapter a servi les deux experts : c'est le slot qui décide.
      assert.deepEqual(new Set(h.resumes.map((call) => call.provider)), new Set([provider]));
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// C. Frontières durables
// ==========================================================================

test('C9–C12 · le contexte de reprise est durable avant l’appel, et le reste après la réponse', async () => {
  const dir = await makeTempDir('ccr-1f-durable-');
  try {
    const observed: Record<string, unknown>[] = [];
    const h = harness(path.join(dir, 'runs'));
    const runId = await startedRun(h, dir);
    const paths = runPaths(h.runsDir, runId);

    const readState = async (): Promise<Record<string, unknown>> =>
      (await readJsonFile(paths.state)) as Record<string, unknown>;

    // 9–10 · pendant l'appel : contexte durable, round et curseur intacts.
    // La cible du STEP #1 est le CHALLENGER : c'est son adaptateur qui est
    // instrumenté, quel que soit le moteur qui porte ce rôle.
    const targetAdapter = h.adapters[DEFAULT_NATIVE_BINDINGS.challenger];
    targetAdapter.calls.length = 0;
    const duringCall = { captured: undefined as Record<string, unknown> | undefined };
    const originalResume = targetAdapter.resume.bind(targetAdapter);
    (targetAdapter as { resume: typeof targetAdapter.resume }).resume = async (session, prompt) => {
      duringCall.captured = await readState();
      return originalResume(session, prompt);
    };

    const result = await stepNativeRun(h.deps, runId, {
      // 11 · après la réponse, avant la finalisation.
      afterResponseJournaled: async () => {
        observed.push(await readState());
      },
    });

    const before = duringCall.captured;
    assert.ok(before !== undefined, 'état observé pendant l’appel');
    assert.equal(before['state'], 'WAITING_AGENT');
    assert.equal(before['active_expert_slot'], 'challenger', 'la session en vol est celle de la cible');
    assert.equal(before['round'], 0, 'round intact pendant l’appel');
    assert.equal(before['next_step_source_slot'], 'author', 'curseur intact pendant l’appel');
    const pendingBefore = before['pending_operation'] as Record<string, unknown>;
    assert.equal(pendingBefore['kind'], 'step');
    assert.equal(pendingBefore['source_slot'], 'author');
    assert.equal(pendingBefore['target_slot'], 'challenger');
    assert.equal(typeof pendingBefore['source_event_id'], 'string');

    const afterResponse = observed[0];
    assert.ok(afterResponse !== undefined, 'état observé après la réponse');
    const pendingAfter = afterResponse['pending_operation'] as Record<string, unknown> | null;
    assert.ok(pendingAfter !== null, 'le contexte de reprise survit à la réponse');
    assert.equal(pendingAfter?.['source_event_id'], pendingBefore['source_event_id']);
    assert.equal(afterResponse['round'], 0, 'round encore intact');
    assert.equal(afterResponse['next_step_source_slot'], 'author', 'curseur encore intact');

    // …et la réponse est bien déjà durable à cet instant.
    const events = await journal(h.runsDir, runId);
    assert.ok(events.some((event) => event.event_id === result.responseEventId));

    // 12 · après le commit.
    const committed = await readState();
    assert.equal(committed['pending_operation'], null);
    assert.equal(committed['active_expert_slot'], null);
    assert.equal(committed['round'], 1);
    assert.equal(committed['next_step_source_slot'], 'challenger');
    assert.equal(committed['state'], 'READY');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Événements
// ==========================================================================

test('D13–D17 · les événements du transfert portent la provenance native, et rien d’autre', async () => {
  const dir = await makeTempDir('ccr-1f-events-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const runId = await startedRun(h, dir);
    const before = await journal(h.runsDir, runId);
    const result = await stepNativeRun(h.deps, runId);
    const events = await journal(h.runsDir, runId);
    const fresh = events.slice(before.length);

    const started = fresh.find((event) => event.type === 'round_started');
    assert.equal((started as { target_expert_slot_id?: ExpertSlotId })?.target_expert_slot_id, 'challenger');

    const prompt = fresh.find((event) => event.type === 'prompt_sent');
    assert.equal((prompt as { target_expert_slot_id?: ExpertSlotId })?.target_expert_slot_id, 'challenger');
    assert.ok(String(prompt?.content).startsWith('SOURCE_EXPERT: AUTHOR\n'), 'enveloppe 1E');
    assert.ok(String(prompt?.content).includes('TARGET_EXPERT: CHALLENGER'));

    const response = fresh.find((event) => event.type === 'assistant_response');
    assert.equal((response as { expert_slot_id?: ExpertSlotId })?.expert_slot_id, 'challenger');
    assert.equal(
      (response as { session_id?: string })?.session_id,
      `${DEFAULT_NATIVE_BINDINGS.challenger}-1`,
    );
    assert.equal(response?.actor, 'expert');

    const completed = fresh.find((event) => event.type === 'round_completed') as
      | Record<string, unknown>
      | undefined;
    assert.equal(completed?.['source_slot_id'], 'author');
    assert.equal(completed?.['target_slot_id'], 'challenger');
    assert.equal(completed?.['source_event_id'], result.sourceEventId);
    assert.equal(completed?.['response_event_id'], result.responseEventId);

    // 17 · aucune identité fournisseur, sur le fichier lui-même.
    const raw = await readFile(runPaths(h.runsDir, runId).events, 'utf8');
    for (const forbidden of ['"actor":"claude"', '"actor":"codex"', '"target":"claude"', '"target":"codex"']) {
      assert.equal(raw.includes(forbidden), false, `${forbidden} absent`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Artefact de round v2
// ==========================================================================

test('E18–E22 · le premier vrai transfert écrit `rounds/001`, nommé par slot', async () => {
  const dir = await makeTempDir('ccr-1f-round-');
  try {
    const h = harness(path.join(dir, 'runs'), { claudeSessions: ['S1', 'S2'], codexSessions: ['S1', 'S2'] });
    const runId = await startedRun(h, dir, { author: 'claude', challenger: 'claude' });
    const paths = runPaths(h.runsDir, runId);

    assert.deepEqual(await readdir(paths.roundsDir), [], 'START n’écrit aucun round');

    const result = await stepNativeRun(h.deps, runId);
    assert.deepEqual(await readdir(paths.roundsDir), ['001'], 'un seul round, le premier');

    const metadata = await readNativeRoundMetadata(paths, 1);
    assert.equal(metadata.schema_version, NATIVE_ROUND_SCHEMA_VERSION);
    assert.equal(metadata.source_slot, 'author');
    assert.equal(metadata.target_slot, 'challenger');
    assert.equal(metadata.source_event_id, result.sourceEventId);
    assert.equal(metadata.response_event_id, result.responseEventId);
    assert.equal(metadata.turns[0]?.expert_slot, 'challenger');

    // 20–21 · noms dérivés du slot ; same-provider sans collision.
    const names = await readdir(roundDir(paths, 1));
    assert.deepEqual(
      names.filter((name) => name.endsWith('.txt')).sort(),
      ['challenger_prompt.txt', 'challenger_response.txt'],
    );
    assert.equal(names.some((name) => name.startsWith('claude') || name.startsWith('codex')), false);

    const artifacts = nativeRoundArtifactNames('challenger');
    assert.ok(
      (await readFile(path.join(roundDir(paths, 1), artifacts.prompt), 'utf8')).includes('TARGET_EXPERT: CHALLENGER'),
    );

    // Le second transfert écrit `002`, et l'auteur y devient la cible.
    await stepNativeRun(h.deps, runId);
    assert.deepEqual((await readdir(paths.roundsDir)).sort(), ['001', '002']);
    const secondNames = await readdir(roundDir(paths, 2));
    assert.deepEqual(
      secondNames.filter((name) => name.endsWith('.txt')).sort(),
      ['author_prompt.txt', 'author_response.txt'],
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// F. Transfert refusé pour taille
// ==========================================================================

test('F23–F29 · un transfert trop volumineux est refusé avant tout appel, et journalisé comme tel', async () => {
  const dir = await makeTempDir('ccr-1f-payload-');
  try {
    const h = harness(path.join(dir, 'runs'), {
      maxTransferBytes: 512,
      answer: () => 'R'.repeat(4096),
    });
    const runId = await startedRun(h, dir);
    const paths = runPaths(h.runsDir, runId);
    const before = await journal(h.runsDir, runId);
    const resumesBefore = h.resumes.length;

    await expectRejection(
      stepNativeRun(h.deps, runId),
      'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
      'transfert refusé',
    );

    // 23 · aucun appel d'adapter.
    assert.equal(h.resumes.length, resumesBefore, 'aucune reprise de session');

    const fresh = (await journal(h.runsDir, runId)).slice(before.length);
    assert.equal(fresh.length, 1, 'un seul événement ajouté');
    const blocked = fresh[0] as unknown as Record<string, unknown>;

    // 24–25 · deux slots, l'événement source, et surtout aucune réponse.
    assert.equal(blocked['type'], 'transfer_blocked');
    assert.equal(blocked['source_slot_id'], 'author');
    assert.equal(blocked['target_slot_id'], 'challenger');
    assert.equal(typeof blocked['source_event_id'], 'string');
    assert.equal(blocked['reason'], 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
    assert.equal('response_event_id' in blocked, false, 'aucune réponse n’a existé');
    const details = blocked['details'] as Record<string, unknown>;
    assert.equal(details['limit_bytes'], 512);
    assert.ok(Number(details['payload_bytes']) > 512);

    // 26–28 · rien n'a avancé, rien n'a été finalisé, rien n'a été projeté.
    const state = await readPersistedState(paths);
    assert.equal(state.document.round, 0);
    assert.equal((state.document as { next_step_source_slot?: unknown }).next_step_source_slot, 'author');
    assert.equal(state.document.state, 'WAITING_HUMAN');
    assert.equal(state.document.control, 'HUMAN');
    assert.equal(fresh.some((event) => event.type === 'round_completed'), false);
    assert.deepEqual(await readdir(paths.roundsDir), []);

    // 29 · la source n'est pas consommée : elle n'a été transférée à personne.
    // Le plan la refuse désormais pour une autre raison — le contrôle humain.
    const plan = await planNativeStepForRun(h.deps, runId, { maxTransferBytes: 512 });
    assert.equal(plan.kind, 'REFUSED');
    if (plan.kind !== 'REFUSED') return;
    assert.equal(plan.reason, 'AUTOMATION_NOT_IN_CONTROL', 'la reprise appartient à l’humain');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// G. Échecs
// ==========================================================================

test('G30–G31 · un échec d’adapter ne se retente pas, et n’avance ni round ni curseur', async () => {
  const dir = await makeTempDir('ccr-1f-fail-');
  try {
    let attempts = 0;
    const h = harness(path.join(dir, 'runs'), {
      failResume: {
        [DEFAULT_NATIVE_BINDINGS.challenger]: () => {
          attempts += 1;
          return new CcrError('AGENT_TIMEOUT', 'le tour a expiré');
        },
      },
    });
    const runId = await startedRun(h, dir);
    const paths = runPaths(h.runsDir, runId);

    await expectRejection(stepNativeRun(h.deps, runId), 'AGENT_TIMEOUT', 'échec de transfert');
    assert.equal(attempts, 1, 'une seule tentative');

    const state = await readPersistedState(paths);
    assert.equal(state.document.round, 0);
    assert.equal((state.document as { next_step_source_slot?: unknown }).next_step_source_slot, 'author');
    assert.equal(state.document.state, 'PAUSED');
    assert.equal(state.document.control, 'HUMAN');
    assert.equal(state.document.pending_operation, null);

    const events = await journal(h.runsDir, runId);
    assert.equal(events.filter((event) => event.type === 'round_completed').length, 0);
    const failure = events.find((event) => event.type === 'process_failed');
    assert.equal((failure as { target_expert_slot_id?: ExpertSlotId })?.target_expert_slot_id, 'challenger');
    assert.deepEqual(await readdir(paths.roundsDir), []);
  } finally {
    await removeTempDir(dir);
  }
});

test('G32–G33 · une session qui dérive est un échec fermé, sans réponse ni finalisation', async () => {
  const dir = await makeTempDir('ccr-1f-mismatch-');
  try {
    // La dérive est armée sur le moteur qui porte la CIBLE du transfert.
    const targetProvider = DEFAULT_NATIVE_BINDINGS.challenger;
    const h = harness(path.join(dir, 'runs'), {
      resumeSessionId: { [targetProvider]: `${targetProvider}-autre` },
    });
    const runId = await startedRun(h, dir);
    const paths = runPaths(h.runsDir, runId);
    const before = await journal(h.runsDir, runId);

    await expectRejection(stepNativeRun(h.deps, runId), 'AGENT_SESSION_MISMATCH', 'session dérivée');

    const fresh = (await journal(h.runsDir, runId)).slice(before.length);
    assert.equal(
      fresh.filter((event) => event.type === 'assistant_response').length,
      0,
      'aucune réponse attribuée à une session étrangère',
    );
    assert.equal(fresh.filter((event) => event.type === 'round_completed').length, 0);
    const failure = fresh.find((event) => event.type === 'process_failed');
    assert.equal(failure?.details?.['code'], 'AGENT_SESSION_MISMATCH');
    assert.equal(failure?.details?.['expected'], `${targetProvider}-1`);
    assert.equal(failure?.details?.['found'], `${targetProvider}-autre`);

    const state = await readPersistedState(paths);
    // L'invariant fondamental du run est brisé : V2 classe ce cas `FAILED`.
    assert.equal(state.document.state, 'FAILED');
    assert.equal(state.document.round, 0);
    assert.equal((state.document as { next_step_source_slot?: unknown }).next_step_source_slot, 'author');
    assert.deepEqual(await readdir(paths.roundsDir), []);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// H. Consommation de la source · I. Legacy
// ==========================================================================

test('H34–H35 · la source consommée est refusée, et la réponse cible devient la suivante', async () => {
  const dir = await makeTempDir('ccr-1f-consume-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const runId = await startedRun(h, dir);
    const first = await stepNativeRun(h.deps, runId);

    // 35 · le plan suivant part de la cible, avec sa réponse fraîche.
    const next = await planNativeStepForRun(h.deps, runId);
    assert.equal(next.kind, 'READY');
    if (next.kind !== 'READY') return;
    assert.equal(next.sourceSlot, 'challenger');
    assert.equal(next.sourceEventId, first.responseEventId, 'la réponse du transfert est la source suivante');
    assert.notEqual(next.sourceEventId, first.sourceEventId);

    // 34 · l'ancienne source ne peut plus être choisie : elle est consommée.
    const events = await journal(h.runsDir, runId);
    const consumed = events.some(
      (event) =>
        event.type === 'round_completed' &&
        (event as { source_event_id?: string }).source_event_id === first.sourceEventId,
    );
    assert.equal(consumed, true, 'round_completed prouve la consommation');
  } finally {
    await removeTempDir(dir);
  }
});

test('I36 · un run historique est refusé sans la moindre écriture', async () => {
  const dir = await makeTempDir('ccr-1f-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    const adapters = {
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
    };
    const deps: RunServiceDeps = {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => adapters,
    };
    const started = await startRun(deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'T',
      cwd: dir,
      prompt: MISSION,
    });
    const paths = runPaths(runsDir, started.runId);
    const before = {
      manifest: await readFile(paths.manifest, 'utf8'),
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
      rounds: (await readdir(paths.roundsDir)).sort(),
    };

    await expectRejection(
      stepNativeRun(deps, started.runId),
      'SCHEMA_VERSION_UNSUPPORTED',
      'run historique refusé',
    );

    assert.deepEqual(
      {
        manifest: await readFile(paths.manifest, 'utf8'),
        state: await readFile(paths.state, 'utf8'),
        events: await readFile(paths.events, 'utf8'),
        rounds: (await readdir(paths.roundsDir)).sort(),
      },
      before,
      'aucune écriture native sur un run historique',
    );
  } finally {
    await removeTempDir(dir);
  }
});
