/**
 * Slice 1G — Native STEP Crash Recovery & Source Quarantine.
 *
 * L'ordre durable de 1F a été conçu pour rendre ces fenêtres lisibles. La
 * distinction qui porte tout : `pending_operation` est persisté **avant**
 * `adapter.resume`, donc son absence prouve qu'aucun appel n'a été engagé.
 * Sans cette garantie, un abandon avant appel et une incertitude seraient
 * indiscernables, et tout devrait être traité comme incertain.
 *
 * Les fenêtres sont construites en capturant les octets réellement durables à
 * l'instant voulu, puis en les restaurant : c'est ce qu'un arrêt brutal aurait
 * laissé, et non un état inventé.
 *
 * Aucun fournisseur : les adapters sont des fixtures, et la reprise n'a
 * structurellement aucune dépendance d'adapter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import type { NativeExpertBindings } from '../../src/services/native-start-service.ts';
import { stepNativeRun } from '../../src/services/native-step-service.ts';
import { planNativeStep } from '../../src/services/native-step-planner.ts';
import {
  acknowledgeNativeStepUncertainty,
  buildNativeStepRecoveryView,
  finalizeNativeStepRecovery,
  inspectNativeStepRecovery,
} from '../../src/services/native-step-recovery-service.ts';
import { buildNativeRunReadModel } from '../../src/services/native-read-model.ts';
import type { NativeStepRecoveryDeps } from '../../src/services/native-step-recovery-service.ts';
import { startRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { roundDir, runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import {
  persistNativeStateUpdate,
  readPersistedManifest,
  readPersistedState,
} from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  /** Dépendances de reprise : aucune fabrique d'adapter n'y figure. */
  readonly recovery: NativeStepRecoveryDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  readonly resumes: string[];
}

function harness(
  runsDir: string,
  options: { readonly sessions?: Partial<Record<ProviderKind, readonly string[]>>; readonly failResume?: () => unknown } = {},
): Harness {
  const resumes: string[] = [];
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: options.sessions?.[kind] ?? [`${kind}-1`, `${kind}-2`],
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
      onCall: (phase, prompt) => {
        if (phase === 'resume') resumes.push(prompt.slice(0, 12));
      },
    });
  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
    runsDir,
    adapters,
    resumes,
    deps: { runsDir, now: () => new Date(AT), createAdapters: (): AgentAdapters => adapters },
    recovery: { runsDir, now: () => new Date(AT) },
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

interface Snapshot {
  readonly state: string;
  readonly events: string;
}

async function capture(paths: { state: string; events: string }): Promise<Snapshot> {
  return { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') };
}

/** Restaure exactement les octets durables d'un instant donné. */
async function restore(paths: { state: string; events: string }, snapshot: Snapshot): Promise<void> {
  await writeFile(paths.state, snapshot.events === '' ? snapshot.state : snapshot.state, 'utf8');
  await writeFile(paths.events, snapshot.events, 'utf8');
}

async function startedRun(h: Harness, dir: string, bindings?: NativeExpertBindings): Promise<string> {
  const result = await startNativeRun(h.deps, {
    title: 'T',
    cwd: dir,
    prompt: MISSION,
    ...(bindings === undefined ? {} : { bindings }),
    runtimeConfig: nativeRuntime(),
  });
  assert.equal(result.failure, undefined);
  return result.runId;
}

async function journal(runsDir: string, runId: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

// --------------------------------------------------------------------------
// Fabrication des fenêtres
// --------------------------------------------------------------------------

interface Windows {
  readonly runId: string;
  readonly paths: ReturnType<typeof runPaths>;
  /** Contexte engagé, aucune réponse. */
  readonly inFlight: Snapshot;
  /** Réponse durable, contexte encore engagé, finalisation absente. */
  readonly responded: Snapshot;
  /** État d'avant le commit — identique à `responded.state` par construction. */
  readonly preCommit: Snapshot;
  readonly sourceEventId: string;
  readonly responseEventId: string;
}

/**
 * Exécute un vrai transfert en capturant ce qui est durable aux deux instants
 * décisifs : pendant l'appel, et juste après la réponse.
 */
async function runStepCapturingWindows(h: Harness, dir: string, bindings?: NativeExpertBindings): Promise<Windows> {
  const runId = await startedRun(h, dir, bindings);
  const paths = runPaths(h.runsDir, runId);

  let inFlight: Snapshot | undefined;
  const target = bindings === undefined ? h.adapters.claude : h.adapters[bindings.challenger];
  const original = target.resume.bind(target);
  (target as { resume: typeof target.resume }).resume = async (session, prompt) => {
    inFlight = await capture(paths);
    return original(session, prompt);
  };

  let responded: Snapshot | undefined;
  const result = await stepNativeRun(h.deps, runId, {
    afterResponseJournaled: async () => {
      responded = await capture(paths);
    },
  });

  assert.ok(inFlight !== undefined && responded !== undefined);
  return {
    runId,
    paths,
    inFlight,
    responded,
    // Entre la réponse et le commit, `state.json` n'est plus touché : l'état
    // capturé au seam **est** l'état d'avant commit.
    preCommit: responded,
    sourceEventId: result.sourceEventId,
    responseEventId: result.responseEventId,
  };
}

// ==========================================================================
// Classification — tests 1 à 8
// ==========================================================================

test('1–2 · W0 — un transfert abandonné avant tout appel est distinct d’une incertitude', async () => {
  const dir = await makeTempDir('ccr-1g-w0-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const runId = await startedRun(h, dir);
    const paths = runPaths(h.runsDir, runId);
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif');
    const events = await openNativeEventStore(paths, persisted.manifest);
    const source = (await events.readAll()).find(
      (event) => event.type === 'assistant_response' && (event as { expert_slot_id?: string }).expert_slot_id === 'author',
    );
    assert.ok(source !== undefined);

    // W0a : seul `round_started` est durable — le contexte n'a jamais été écrit.
    const started = await events.append({
      round: 1,
      actor: 'system',
      type: 'round_started',
      target_expert_slot_id: 'challenger',
      based_on: [source.event_id],
      details: { round: 1, source_slot: 'author', target_slot: 'challenger', source_event_id: source.event_id },
      timestamp: AT,
    });
    await writeFile(
      paths.state,
      JSON.stringify({
        ...(JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>),
        state: 'RUNNING',
        last_event_id: started.event_id,
      }),
      'utf8',
    );

    const w0a = await inspectNativeStepRecovery(h.recovery, runId);
    assert.equal(w0a.status, 'PRE_PROVIDER_ABORTED');
    assert.equal(w0a.canFinalizeWithoutProvider, true);
    assert.equal(w0a.requiresHumanAcknowledgement, false);
    assert.equal(w0a.sourceReplayStatus, 'ELIGIBLE', 'la source n’est ni consommée ni quarantainée');

    // W0b : `prompt_sent` durable, toujours aucun contexte engagé.
    await events.append({
      round: 1,
      actor: 'system',
      type: 'prompt_sent',
      target_expert_slot_id: 'challenger',
      session_id: 'claude-1',
      content: 'SOURCE_EXPERT: AUTHOR',
      based_on: [source.event_id],
      timestamp: AT,
    });
    const w0b = await inspectNativeStepRecovery(h.recovery, runId);
    assert.equal(w0b.status, 'PRE_PROVIDER_ABORTED');

    // 27 · aucune quarantaine, et la reprise rend simplement la main.
    const outcome = await finalizeNativeStepRecovery(h.recovery, runId);
    assert.equal(outcome.state.state, 'PAUSED');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.round, 0, 'aucun round n’a abouti');
    assert.equal(outcome.state.next_step_source_slot, 'author', 'curseur intact');
    assert.equal(
      (await journal(h.runsDir, runId)).some(
        (event) => event.type === 'transfer_uncertainty_acknowledged',
      ),
      false,
      'aucune quarantaine pour un abandon prouvé sans appel',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('3–7 · W1 à W5 sont distingués par les seuls faits canoniques', async () => {
  const dir = await makeTempDir('ccr-1g-windows-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await runStepCapturingWindows(h, dir);

    // W5 · le transfert est complet.
    const done = await inspectNativeStepRecovery(h.recovery, w.runId);
    assert.equal(done.status, 'NONE');
    assert.equal(done.diagnosticRound, 'MATCHING');
    assert.equal(done.sourceReplayStatus, 'TRANSFERRED');

    // W4 · finalisé, artefact présent, état pas encore commité.
    await writeFile(w.paths.state, w.preCommit.state, 'utf8');
    const w4 = await inspectNativeStepRecovery(h.recovery, w.runId);
    assert.equal(w4.status, 'ROUND_COMPLETED_NEEDS_COMMIT');
    assert.equal(w4.diagnosticRound, 'MATCHING');
    assert.equal(w4.canFinalizeWithoutProvider, true);

    // W3 · même chose, artefact diagnostique absent.
    await rm(roundDir(w.paths, 1), { recursive: true, force: true });
    const w3 = await inspectNativeStepRecovery(h.recovery, w.runId);
    assert.equal(w3.status, 'ROUND_COMPLETED_NEEDS_COMMIT', 'un artefact absent ne change pas le statut');
    assert.equal(w3.diagnosticRound, 'MISSING');

    // W2 · réponse durable, finalisation absente.
    await restore(w.paths, w.responded);
    const w2 = await inspectNativeStepRecovery(h.recovery, w.runId);
    assert.equal(w2.status, 'RESPONSE_NEEDS_FINALIZATION');
    assert.equal(w2.responseEventId, w.responseEventId);
    assert.equal(w2.sourceEventId, w.sourceEventId);
    assert.equal(w2.canFinalizeWithoutProvider, true);
    assert.equal(w2.requiresHumanAcknowledgement, false);

    // W1 · contexte engagé, aucune réponse.
    await restore(w.paths, w.inFlight);
    const w1 = await inspectNativeStepRecovery(h.recovery, w.runId);
    assert.equal(w1.status, 'IN_FLIGHT_UNCERTAIN');
    assert.equal(w1.canFinalizeWithoutProvider, false);
    assert.equal(w1.requiresHumanAcknowledgement, true);
    assert.equal(w1.sourceReplayStatus, 'ELIGIBLE', 'pas encore quarantainée');
  } finally {
    await removeTempDir(dir);
  }
});

test('8 · une contradiction canonique est un échec fermé, jamais une réparation', async () => {
  const dir = await makeTempDir('ccr-1g-conflict-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await runStepCapturingWindows(h, dir);

    // La réponse durable est attribuée au mauvais slot : impossible dans
    // l'ordre 1F, où la réponse porte le slot cible du contexte engagé.
    await restore(w.paths, w.responded);
    const lines = w.responded.events.trim().split('\n');
    const rewritten = lines.map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event['event_id'] === w.responseEventId) event['expert_slot_id'] = 'author';
      return JSON.stringify(event);
    });
    await writeFile(w.paths.events, `${rewritten.join('\n')}\n`, 'utf8');

    const view = await inspectNativeStepRecovery(h.recovery, w.runId);
    assert.equal(view.status, 'EVIDENCE_CONFLICT');
    assert.ok(view.conflicts.length > 0);
    await expectRejection(
      finalizeNativeStepRecovery(h.recovery, w.runId),
      'STATE_INVALID',
      'aucune réparation sur contradiction',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Finalisation locale — tests 9 à 17
// ==========================================================================

test('9–14 · W2, W3 et W4 se finalisent sans fournisseur, une seule fois', async () => {
  for (const window of ['W2', 'W3', 'W4'] as const) {
    const dir = await makeTempDir('ccr-1g-finalize-');
    try {
      const h = harness(path.join(dir, 'runs'));
      const w = await runStepCapturingWindows(h, dir);
      const resumesBefore = h.resumes.length;

      if (window === 'W2') await restore(w.paths, w.responded);
      else {
        await writeFile(w.paths.state, w.preCommit.state, 'utf8');
        if (window === 'W3') await rm(roundDir(w.paths, 1), { recursive: true, force: true });
      }

      const outcome = await finalizeNativeStepRecovery(h.recovery, w.runId);

      // 9 · aucun appel d'adapter — structurellement impossible ici.
      assert.equal(h.resumes.length, resumesBefore, `${window} · aucun fournisseur`);

      // 11 · round, curseur, autorité.
      assert.equal(outcome.state.round, 1, `${window} · round commité une fois`);
      assert.equal(outcome.state.next_step_source_slot, 'challenger');
      assert.equal(outcome.state.state, 'READY');
      assert.equal(outcome.state.control, 'HUMAN', `${window} · l’humain garde la main`);
      assert.equal(outcome.state.pending_operation, null);
      assert.equal(outcome.view.status, 'NONE');

      // 10 · 13 · exactement une réponse et une finalisation.
      const events = await journal(h.runsDir, w.runId);
      assert.equal(
        events.filter((event) => event.type === 'round_completed').length,
        1,
        `${window} · un seul round_completed`,
      );
      assert.equal(
        events.filter(
          (event) => event.type === 'assistant_response' && event.round === 1,
        ).length,
        1,
        `${window} · aucune réponse dupliquée`,
      );

      // 14 · une seconde reprise ne produit plus rien.
      const before = await readFile(w.paths.events, 'utf8');
      const again = await finalizeNativeStepRecovery(h.recovery, w.runId);
      assert.equal(again.view.status, 'NONE');
      assert.equal(await readFile(w.paths.events, 'utf8'), before, `${window} · journal inchangé`);
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('15–17 · l’artefact diagnostique ne conditionne rien, et rien n’est inventé', async () => {
  const dir = await makeTempDir('ccr-1g-artifact-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await runStepCapturingWindows(h, dir);

    // 16 · un artefact contradictoire n'altère jamais la vérité canonique.
    await writeFile(w.paths.state, w.preCommit.state, 'utf8');
    const metadataPath = path.join(roundDir(w.paths, 1), 'metadata.json');
    const original = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      metadataPath,
      JSON.stringify({ ...original, source_event_id: 'evt_999999' }),
      'utf8',
    );
    const invalid = await inspectNativeStepRecovery(h.recovery, w.runId);
    assert.equal(invalid.diagnosticRound, 'INVALID');
    assert.equal(invalid.status, 'ROUND_COMPLETED_NEEDS_COMMIT', 'le statut vient des faits canoniques');

    const outcome = await finalizeNativeStepRecovery(h.recovery, w.runId);
    assert.equal(outcome.state.round, 1, 'le commit n’est jamais bloqué par un artefact');

    // 15 · 17 · artefact reconstruit depuis les faits, sans inventer les
    // sorties brutes du processus, qui sont perdues.
    const rebuilt = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    assert.equal(rebuilt['source_event_id'], w.sourceEventId, 'métadonnées reconstruites');
    assert.equal(rebuilt['response_event_id'], w.responseEventId);
    assert.ok(
      outcome.actions.some((action) => action.includes('sorties brutes non recréées')),
      'la perte est dite, pas comblée',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Incertitude et quarantaine — tests 18 à 26
// ==========================================================================

test('18–23 · une incertitude exige un acquittement, qui met la source en quarantaine', async () => {
  const dir = await makeTempDir('ccr-1g-uncertain-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await runStepCapturingWindows(h, dir);
    await restore(w.paths, w.inFlight);

    // 18 · l'inspection n'écrit rien.
    const before = await capture(w.paths);
    assert.equal((await inspectNativeStepRecovery(h.recovery, w.runId)).status, 'IN_FLIGHT_UNCERTAIN');
    assert.deepEqual(await capture(w.paths), before, 'inspection sans effet');

    // 19 · finaliser directement est refusé.
    await expectRejection(
      finalizeNativeStepRecovery(h.recovery, w.runId),
      'RECOVERY_REQUIRED',
      'finalisation avant acquittement',
    );

    // 20–22 · l'acquittement n'appelle rien, marque la source, et n'avance rien.
    const resumesBefore = h.resumes.length;
    const outcome = await acknowledgeNativeStepUncertainty(h.recovery, w.runId, 'Vérifié côté fournisseur.');
    assert.equal(h.resumes.length, resumesBefore, 'aucun fournisseur');
    assert.equal(outcome.state.round, 0, 'round inchangé');
    assert.equal(outcome.state.next_step_source_slot, 'author', 'curseur inchangé');
    assert.equal(outcome.state.state, 'PAUSED');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.view.sourceReplayStatus, 'QUARANTINED');

    const events = await journal(h.runsDir, w.runId);
    const marks = events.filter((event) => event.type === 'transfer_uncertainty_acknowledged');
    assert.equal(marks.length, 1, '21 · exactement un marqueur');
    const mark = marks[0] as unknown as Record<string, unknown>;
    assert.equal(mark['source_slot_id'], 'author');
    assert.equal(mark['target_slot_id'], 'challenger');
    assert.equal(mark['source_event_id'], w.sourceEventId);
    assert.equal(mark['reason'], 'IN_FLIGHT_UNCERTAIN');
    assert.equal('response_event_id' in mark, false, 'aucune conclusion sur une réponse');
    assert.ok(String((mark['details'] as Record<string, unknown>)['conclusion']).startsWith('Aucune'));

    // 23 · un second acquittement est refusé, sans duplication.
    const journalBefore = await readFile(w.paths.events, 'utf8');
    await expectRejection(
      acknowledgeNativeStepUncertainty(h.recovery, w.runId, 'encore'),
      'INVALID_ARGUMENT',
      'second acquittement',
    );
    assert.equal(await readFile(w.paths.events, 'utf8'), journalBefore, 'journal inchangé');
  } finally {
    await removeTempDir(dir);
  }
});

test('24–26 · le planificateur refuse une source quarantainée, sans remonter, jusqu’à une réponse neuve', async () => {
  const dir = await makeTempDir('ccr-1g-quarantine-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const w = await runStepCapturingWindows(h, dir);
    await restore(w.paths, w.inFlight);
    await acknowledgeNativeStepUncertainty(h.recovery, w.runId, 'note');

    const persisted = await readPersistedManifest(w.paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif');
    const store = await openNativeEventStore(w.paths, persisted.manifest);

    // Le planificateur est éprouvé sur un état explicitement automatisable :
    // la garde de contrôle est déjà couverte en 1E, ce qui est en jeu ici est
    // la règle de source.
    const persistedState = await readPersistedState(w.paths);
    if (persistedState.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif');
    const automatable = {
      ...persistedState.document,
      state: 'READY' as const,
      control: 'AUTOMATION' as const,
      next_step_source_slot: 'author' as ExpertSlotId,
    };

    const refused = planNativeStep({
      runId: w.runId,
      manifest: persisted.manifest,
      state: automatable,
      events: await store.readAll(),
    });
    assert.equal(refused.kind, 'REFUSED');
    if (refused.kind !== 'REFUSED') return;
    // 24 · un refus distinct d'une source consommée.
    assert.equal(refused.reason, 'SOURCE_NOT_REPLAYABLE');
    assert.notEqual(refused.reason, 'SOURCE_ALREADY_TRANSFERRED');

    // 25 · aucune remontée vers une réponse plus ancienne du même slot : il n'y
    // en a qu'une, et le refus persiste même si l'on en ajoute une antérieure.
    // 26 · une réponse **plus récente** de l'auteur rend un plan possible.
    const fresh = await store.append({
      round: 0,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: 'author',
      session_id: 'codex-1',
      content: 'nouvelle position AUTHOR',
      timestamp: AT,
    });
    const planned = planNativeStep({
      runId: w.runId,
      manifest: persisted.manifest,
      state: automatable,
      events: await store.readAll(),
    });
    assert.equal(planned.kind, 'READY');
    if (planned.kind !== 'READY') return;
    assert.equal(planned.sourceEventId, fresh.event_id, 'la source est la réponse neuve');
    assert.notEqual(planned.sourceEventId, w.sourceEventId);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// États stables — tests 29 à 31
// ==========================================================================

test('29–31 · un refus de taille et les échecs déterministes ne sont pas des incertitudes', async () => {
  const dir = await makeTempDir('ccr-1g-stable-');
  try {
    const runsDir = path.join(dir, 'runs');

    // 29 · transfert refusé pour taille : aucun `round_started`, run stable.
    const blocked = harness(runsDir);
    const blockedRun = await startedRun(blocked, dir);
    await expectRejection(
      stepNativeRun({ ...blocked.deps, maxTransferBytes: 16 }, blockedRun),
      'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
      'refus de taille',
    );
    const blockedView = await inspectNativeStepRecovery(blocked.recovery, blockedRun);
    assert.equal(blockedView.status, 'NONE');
    assert.equal(blockedView.requiresHumanAcknowledgement, false);

    // 30 · échec d'adapter déterministe : contexte libéré, run stable.
    const failing = harness(runsDir, { failResume: () => new CcrError('AGENT_TIMEOUT', 'expiré') });
    const failingRun = await startedRun(failing, dir);
    await expectRejection(stepNativeRun(failing.deps, failingRun), 'AGENT_TIMEOUT', 'échec adapter');
    const failedView = await inspectNativeStepRecovery(failing.recovery, failingRun);
    assert.equal(failedView.status, 'NONE', 'un échec conclu n’est pas une incertitude');
    assert.equal(failedView.requiresHumanAcknowledgement, false);

    // 31 · session dérivée : même conclusion.
    const drifting = harness(runsDir);
    const driftingRun = await startedRun(drifting, dir);
    const claude = drifting.adapters.claude;
    (claude as { resume: typeof claude.resume }).resume = async () => {
      const at = new Date(0).toISOString();
      return {
        agent: 'claude' as const,
        sessionId: 'claude-autre',
        content: 'x',
        exitCode: 0,
        startedAt: at,
        completedAt: at,
        stdoutRaw: '',
        stderrRaw: '',
      };
    };
    await expectRejection(stepNativeRun(drifting.deps, driftingRun), 'AGENT_SESSION_MISMATCH', 'session dérivée');
    assert.equal((await inspectNativeStepRecovery(drifting.recovery, driftingRun)).status, 'NONE');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Same-provider — tests 32 et 33
// ==========================================================================

test('32–33 · same-provider : la finalisation nomme les deux slots corrects', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const dir = await makeTempDir('ccr-1g-same-');
    try {
      const h = harness(path.join(dir, 'runs'), { sessions: { [provider]: ['S1', 'S2'] } });
      const w = await runStepCapturingWindows(h, dir, { author: provider, challenger: provider });
      await restore(w.paths, w.responded);

      const view = await inspectNativeStepRecovery(h.recovery, w.runId);
      assert.equal(view.status, 'RESPONSE_NEEDS_FINALIZATION', `${provider}/${provider}`);
      assert.equal(view.sourceSlot, 'author');
      assert.equal(view.targetSlot, 'challenger');

      const outcome = await finalizeNativeStepRecovery(h.recovery, w.runId);
      assert.equal(outcome.state.next_step_source_slot, 'challenger');
      const completed = (await journal(h.runsDir, w.runId)).find(
        (event) => event.type === 'round_completed',
      ) as unknown as Record<string, unknown>;
      assert.equal(completed['source_slot_id'], 'author');
      assert.equal(completed['target_slot_id'], 'challenger');
      assert.equal(completed['response_event_id'], w.responseEventId);
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// Legacy — test 34
// ==========================================================================

test('34 · un run historique est refusé par les trois entrées, sans écriture', async () => {
  const dir = await makeTempDir('ccr-1g-legacy-');
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
    const recovery: NativeStepRecoveryDeps = { runsDir, now: () => new Date(AT) };
    const before = {
      manifest: await readFile(paths.manifest, 'utf8'),
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
      rounds: (await readdir(paths.roundsDir)).sort(),
    };

    for (const call of [
      () => inspectNativeStepRecovery(recovery, started.runId),
      () => finalizeNativeStepRecovery(recovery, started.runId),
      () => acknowledgeNativeStepUncertainty(recovery, started.runId, 'note'),
    ]) {
      await expectRejection(call(), 'SCHEMA_VERSION_UNSUPPORTED', 'run historique refusé');
    }

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

// ==========================================================================
// Foundation repair 1G.2 — résolution durable de la reprise de transfert
// ==========================================================================

/**
 * Ouvre un round exactement comme `stepNativeRun`, puis fige le contexte
 * engagé : la fenêtre `IN_FLIGHT_UNCERTAIN`, sans appeler le moindre adapter.
 */
async function inFlightWindow(
  h: Harness,
  dir: string,
  options: { readonly prompt?: boolean } = {},
): Promise<{ runId: string; paths: ReturnType<typeof runPaths>; sourceEventId: string; startedEventId: string }> {
  const runId = await startedRun(h, dir);
  const paths = runPaths(h.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  const events = await openNativeEventStore(paths, persisted.manifest);
  const source = (await events.readAll()).find(
    (event) =>
      event.type === 'assistant_response' &&
      (event as { expert_slot_id?: string }).expert_slot_id === 'author',
  );
  assert.ok(source !== undefined);

  const started = await events.append({
    round: 1,
    actor: 'system',
    type: 'round_started',
    target_expert_slot_id: 'challenger',
    based_on: [source.event_id],
    details: {
      round: 1,
      source_slot: 'author',
      target_slot: 'challenger',
      source_event_id: source.event_id,
    },
    timestamp: AT,
  });
  let promptEventId: string | null = null;
  if (options.prompt !== false) {
    const prompt = await events.append({
      round: 1,
      actor: 'system',
      type: 'prompt_sent',
      target_expert_slot_id: 'challenger',
      session_id: 'claude-1',
      content: 'SOURCE_EXPERT: AUTHOR',
      based_on: [source.event_id],
      timestamp: AT,
    });
    promptEventId = prompt.event_id;
  }

  const current = await readPersistedState(paths);
  if (current.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  await persistNativeStateUpdate(
    paths,
    current.document,
    {
      state: 'RUNNING',
      lastEventId: promptEventId ?? started.event_id,
    },
    new Date(AT),
  );
  return { runId, paths, sourceEventId: source.event_id, startedEventId: started.event_id };
}

/** Ajoute le contexte engagé d'un transfert : la fenêtre est alors incertaine. */
async function engage(
  h: Harness,
  window: { runId: string; paths: ReturnType<typeof runPaths>; sourceEventId: string },
): Promise<void> {
  const current = await readPersistedState(window.paths);
  if (current.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  const events = await journal(h.runsDir, window.runId);
  const prompt = events.find((event) => event.type === 'prompt_sent' && event.round === 1);
  await persistNativeStateUpdate(
    window.paths,
    current.document,
    {
      state: 'WAITING_AGENT',
      activeExpertSlot: 'challenger',
      pendingOperation: {
        kind: 'step',
        source_slot: 'author',
        target_slot: 'challenger',
        source_event_id: window.sourceEventId,
        round: 1,
        prompt_event_id: prompt?.event_id ?? null,
        session_id: 'claude-1',
        return_state: 'READY',
        return_control: 'AUTOMATION',
        started_at: AT,
      },
    },
    new Date(AT),
  );
}

async function stepView(h: Harness, runId: string) {
  const paths = runPaths(h.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  const state = await readPersistedState(paths);
  if (state.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  return buildNativeStepRecoveryView(
    paths,
    runId,
    persisted.manifest,
    state.document,
    await journal(h.runsDir, runId),
  );
}

async function plannerFor(h: Harness, runId: string) {
  const paths = runPaths(h.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  const state = await readPersistedState(paths);
  if (state.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  return planNativeStep({
    runId,
    manifest: persisted.manifest,
    // Le planificateur exige l'automatisation : la reprise rend toujours la
    // main à l'humain, et ce n'est pas la propriété observée ici.
    state: { ...state.document, state: 'READY', control: 'AUTOMATION' },
    events: await journal(h.runsDir, runId),
  });
}

test('1G.2 A · un acquittement complètement commité ne demande plus rien', async () => {
  const dir = await makeTempDir('ccr-1g2-ack-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const window = await inFlightWindow(h, dir);
    await engage(h, window);
    assert.equal((await stepView(h, window.runId)).status, 'IN_FLIGHT_UNCERTAIN');

    const outcome = await acknowledgeNativeStepUncertainty(h.recovery, window.runId, 'issue inconnue');

    // 1–2 · plus aucune reprise, et la source reste quarantainée.
    assert.equal(outcome.view.status, 'NONE', 'la primitive ne se contredit plus');
    const view = await stepView(h, window.runId);
    assert.equal(view.status, 'NONE');
    assert.equal(view.sourceReplayStatus, 'QUARANTINED');
    assert.equal(view.canFinalizeWithoutProvider, false);

    // 3 · le planificateur, lui, continue de refuser la source.
    const plan = await plannerFor(h, window.runId);
    assert.equal(plan.kind, 'REFUSED');
    if (plan.kind === 'REFUSED') assert.equal(plan.reason, 'SOURCE_NOT_REPLAYABLE');

    // 4 · aucune action fantôme dans la projection.
    const readModel = await buildNativeRunReadModel({ runsDir: h.runsDir }, window.runId);
    assert.equal(readModel.recovery.step.status, 'NONE');
    assert.equal(readModel.recovery.step.available_actions.length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('1G.2 B · un acquittement interrompu se termine localement, sans second marqueur', async () => {
  const dir = await makeTempDir('ccr-1g2-ack-crash-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const window = await inFlightWindow(h, dir);
    await engage(h, window);

    // Le journal est append-only : restaurer le seul `state.json` reproduit
    // exactement « marqueur durable, commit perdu ».
    const engaged = await readFile(window.paths.state, 'utf8');
    await acknowledgeNativeStepUncertainty(h.recovery, window.runId, 'issue inconnue');
    await writeFile(window.paths.state, engaged, 'utf8');

    // 5 · ce n'est plus une incertitude à acquitter.
    const view = await stepView(h, window.runId);
    assert.equal(view.status, 'RESOLUTION_NEEDS_COMMIT');
    assert.equal(view.canFinalizeWithoutProvider, true);
    assert.equal(view.requiresHumanAcknowledgement, false);

    // 6 · un second acquittement est refusé, et n'écrit rien.
    const before = await readFile(window.paths.events, 'utf8');
    await expectRejection(
      acknowledgeNativeStepUncertainty(h.recovery, window.runId, 'encore'),
      'INVALID_ARGUMENT',
      'acquittement déjà écrit',
    );
    assert.equal(await readFile(window.paths.events, 'utf8'), before);

    // 7–8 · la finalisation pose l'état, et n'ajoute aucun événement.
    const outcome = await finalizeNativeStepRecovery(h.recovery, window.runId);
    assert.equal(await readFile(window.paths.events, 'utf8'), before, 'journal inchangé');
    assert.equal(outcome.state.state, 'PAUSED');
    assert.equal(outcome.state.control, 'HUMAN');
    assert.equal(outcome.state.pending_operation, null);
    assert.equal(outcome.state.active_expert_slot, null);
    assert.equal(outcome.state.round, 0, 'round inchangé');
    assert.equal(outcome.state.next_step_source_slot, 'author', 'curseur inchangé');
    assert.equal(
      (await journal(h.runsDir, window.runId)).filter(
        (event) => event.type === 'transfer_uncertainty_acknowledged',
      ).length,
      1,
    );

    // 9 · la reprise suivante n'a plus rien à faire.
    assert.equal(outcome.view.status, 'NONE');
    assert.equal((await stepView(h, window.runId)).status, 'NONE');
  } finally {
    await removeTempDir(dir);
  }
});

test('1G.2 C · un abandon avant appel se clôt durablement, sans toucher la source', async () => {
  for (const withPrompt of [false, true]) {
    const dir = await makeTempDir('ccr-1g2-pre-');
    try {
      const h = harness(path.join(dir, 'runs'));
      const window = await inFlightWindow(h, dir, { prompt: withPrompt });

      // 10–11 · W0a et W0b sont toutes deux des abandons avant appel.
      assert.equal((await stepView(h, window.runId)).status, 'PRE_PROVIDER_ABORTED', `prompt=${String(withPrompt)}`);

      const outcome = await finalizeNativeStepRecovery(h.recovery, window.runId);

      // 12 · exactement un marqueur, rattaché à SA tentative.
      const markers = (await journal(h.runsDir, window.runId)).filter(
        (event) => event.type === 'transfer_aborted_before_provider',
      );
      assert.equal(markers.length, 1);
      const marker = markers[0] as unknown as Record<string, unknown>;
      assert.deepEqual(marker['based_on'], [window.startedEventId], 'identité de tentative');
      assert.equal(marker['source_event_id'], window.sourceEventId);
      assert.equal(marker['source_slot_id'], 'author');
      assert.equal(marker['target_slot_id'], 'challenger');
      assert.equal(marker['reason'], 'PRE_PROVIDER_ABORTED');
      assert.equal('response_event_id' in marker, false, 'aucune réponse prétendue');

      // 13–14 · plus rien à reprendre, et la source reste transférable.
      assert.equal(outcome.view.status, 'NONE');
      assert.equal(outcome.view.sourceReplayStatus, 'ELIGIBLE');
      assert.equal(outcome.state.state, 'PAUSED');
      assert.equal(outcome.state.control, 'HUMAN');
      assert.equal(outcome.state.round, 0);
      assert.equal(outcome.state.next_step_source_slot, 'author');

      // 15 · rendue à l'automatisation, la même source repart.
      const plan = await plannerFor(h, window.runId);
      assert.equal(plan.kind, 'READY');
      if (plan.kind === 'READY') assert.equal(plan.sourceEventId, window.sourceEventId);
    } finally {
      await removeTempDir(dir);
    }
  }
});

test('1G.2 D · une clôture interrompue avant son commit se termine sans second marqueur', async () => {
  const dir = await makeTempDir('ccr-1g2-pre-crash-');
  try {
    const h = harness(path.join(dir, 'runs'));
    const window = await inFlightWindow(h, dir);

    const interrupted = new Error('processus interrompu après le marqueur');
    await assert.rejects(
      finalizeNativeStepRecovery(h.recovery, window.runId, {
        afterResolutionJournaled: () => {
          throw interrupted;
        },
      }),
      (error: unknown) => error === interrupted,
    );

    // 16 · le marqueur est durable, le commit ne l'est pas.
    const view = await stepView(h, window.runId);
    assert.equal(view.status, 'RESOLUTION_NEEDS_COMMIT');
    const before = await readFile(window.paths.events, 'utf8');

    // 17 · la finalisation pose l'état, sans second marqueur.
    const outcome = await finalizeNativeStepRecovery(h.recovery, window.runId);
    assert.equal(await readFile(window.paths.events, 'utf8'), before, 'journal inchangé');
    assert.equal(
      (await journal(h.runsDir, window.runId)).filter(
        (event) => event.type === 'transfer_aborted_before_provider',
      ).length,
      1,
    );
    assert.equal(outcome.state.state, 'PAUSED');
    assert.equal(outcome.state.control, 'HUMAN');

    // 18 · l'inspection suivante ne trouve plus rien.
    assert.equal(outcome.view.status, 'NONE');
    assert.equal((await stepView(h, window.runId)).status, 'NONE');
    assert.equal((await stepView(h, window.runId)).sourceReplayStatus, 'ELIGIBLE');
  } finally {
    await removeTempDir(dir);
  }
});

test('1G.2 E · une clôture ne vaut que pour SA tentative, même source comprise', async () => {
  const dir = await makeTempDir('ccr-1g2-scope-');
  try {
    const h = harness(path.join(dir, 'runs'));
    // 19 · tentative A, close.
    const a = await inFlightWindow(h, dir);
    await finalizeNativeStepRecovery(h.recovery, a.runId);
    assert.equal((await stepView(h, a.runId)).status, 'NONE');

    // 20 · tentative B : même source, même round logique, nouvelle ouverture.
    const paths = runPaths(h.runsDir, a.runId);
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    const events = await openNativeEventStore(paths, persisted.manifest);
    const startedB = await events.append({
      round: 1,
      actor: 'system',
      type: 'round_started',
      target_expert_slot_id: 'challenger',
      based_on: [a.sourceEventId],
      details: {
        round: 1,
        source_slot: 'author',
        target_slot: 'challenger',
        source_event_id: a.sourceEventId,
      },
      timestamp: AT,
    });
    const current = await readPersistedState(paths);
    if (current.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
    await persistNativeStateUpdate(
      paths,
      current.document,
      { state: 'READY', lastEventId: startedB.event_id },
      new Date(AT),
    );

    // 21 · B n'est pas close par le marqueur de A.
    const view = await stepView(h, a.runId);
    assert.equal(view.status, 'PRE_PROVIDER_ABORTED', 'la tentative B est la sienne');
    assert.equal(view.startedEventId, startedB.event_id);

    // 22 · finalisée, B produit son propre marqueur, lié à SON ouverture.
    await finalizeNativeStepRecovery(h.recovery, a.runId);
    const markers = (await journal(h.runsDir, a.runId)).filter(
      (event) => event.type === 'transfer_aborted_before_provider',
    );
    assert.equal(markers.length, 2);
    assert.deepEqual(
      markers.map((marker) => (marker.based_on ?? [])[0]),
      [a.startedEventId, startedB.event_id],
      'chaque clôture nomme sa propre tentative',
    );
    assert.equal((await stepView(h, a.runId)).status, 'NONE');
    assert.equal((await stepView(h, a.runId)).sourceReplayStatus, 'ELIGIBLE');
  } finally {
    await removeTempDir(dir);
  }
});

test('1G.2 F · les issues voisines gardent leur sens', async () => {
  // 23 · un transfert refusé avant le round reste NONE, source transférable.
  const blockedDir = await makeTempDir('ccr-1g2-blocked-');
  try {
    const h = harness(path.join(blockedDir, 'runs'));
    const runId = await startedRun(h, blockedDir);
    const paths = runPaths(h.runsDir, runId);
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    const events = await openNativeEventStore(paths, persisted.manifest);
    const source = (await events.readAll()).find(
      (event) =>
        event.type === 'assistant_response' &&
        (event as { expert_slot_id?: string }).expert_slot_id === 'author',
    );
    assert.ok(source !== undefined);
    await events.append({
      round: 1,
      actor: 'system',
      type: 'transfer_blocked',
      source_slot_id: 'author',
      target_slot_id: 'challenger',
      source_event_id: source.event_id,
      reason: 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
      based_on: [source.event_id],
      details: { payload_bytes: 1, limit_bytes: 0 },
      timestamp: AT,
    });
    const view = await stepView(h, runId);
    assert.equal(view.status, 'NONE');
    assert.equal(view.sourceReplayStatus, 'NOT_APPLICABLE');
  } finally {
    await removeTempDir(blockedDir);
  }

  // 24 · un échec déterministe finalisé reste NONE.
  const failedDir = await makeTempDir('ccr-1g2-failed-');
  try {
    const h = harness(path.join(failedDir, 'runs'));
    const window = await inFlightWindow(h, failedDir);
    const paths = runPaths(h.runsDir, window.runId);
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    const events = await openNativeEventStore(paths, persisted.manifest);
    const prompt = (await events.readAll()).find(
      (event) => event.type === 'prompt_sent' && event.round === 1,
    );
    await events.append({
      round: 1,
      actor: 'system',
      type: 'process_failed',
      target_expert_slot_id: 'challenger',
      session_id: 'claude-1',
      content: 'échec',
      details: { code: 'AGENT_TIMEOUT' },
      based_on: [prompt?.event_id ?? ''],
      timestamp: AT,
    });
    assert.equal((await stepView(h, window.runId)).status, 'NONE');
  } finally {
    await removeTempDir(failedDir);
  }
});

