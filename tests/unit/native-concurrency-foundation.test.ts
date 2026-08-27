/**
 * V2.1-IMP-17A — fondation de concurrence des mutations natives.
 *
 * Le contrat historique n'est pas « vérifier une révision ». C'est **vérifier
 * et agir dans la même section critique**, et le run lock n'étant pas
 * réentrant, il n'existe qu'une seule position possible pour la précondition :
 * à l'intérieur du verrou que le service détient déjà.
 *
 * Ce fichier éprouve exactement cela — que `BEFORE` s'exécute sous le verrou et
 * avant le premier fait durable, que `SETTLED` s'exécute sous le **même**
 * verrou y compris lorsque le corps a levé après avoir écrit, et qu'une
 * révision périmée arrête le service réel, pas seulement un helper.
 *
 * Aucun fournisseur réel, aucun processus, aucun terminal : les adapters sont
 * des fixtures, et chaque preuve de refus compte les appels pour démontrer
 * qu'aucun n'a eu lieu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_ROUND_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../../src/core/run-native.ts';
import type { NativeRunManifest, NativeRunStateDocument } from '../../src/core/run-native.ts';
import { acquireRunLock, readRunLock, withRunLock } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import type { NativeEventStore } from '../../src/store/native-event-store.ts';
import { writeNativeRoundMetadata } from '../../src/store/native-round-store.ts';
import {
  bindNativeSession,
  writeNativeManifest,
  writeNativeState,
} from '../../src/store/native-store.ts';
import {
  computeNativeRunRevision,
  readStableNativeRunSnapshot,
} from '../../src/store/native-run-snapshot.ts';
import { computeRunRevision } from '../../src/store/run-snapshot.ts';
import { projectNativeRunReadModelFromSnapshot } from '../../src/services/native-read-model.ts';
import type { NativeMutationBoundary, NativeMutationOutcome } from '../../src/services/native-mutation-boundary.ts';
import { pauseNativeRun, resumeNativeRun } from '../../src/services/native-control-service.ts';
import { stepNativeRun } from '../../src/services/native-step-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import { expertSlotTarget } from '../../src/services/native-target-resolver.ts';
import { continueNativeInitialization } from '../../src/services/native-recovery-service.ts';
import { finalizeNativeStepRecovery } from '../../src/services/native-step-recovery-service.ts';
import { abortNativeSendBeforeProvider } from '../../src/services/native-send-recovery-service.ts';
import { abortNativeHandoffBeforeInteractive } from '../../src/services/native-handoff-recovery-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-001';
const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';
const SESSIONS = { author: 'codex-1', challenger: 'claude-1' } as const;

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

function manifestOf(sessions: { author: string | null; challenger: string | null }): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Contre-expertise',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: 'codex', session_id: sessions.author },
      challenger: { provider: 'claude', session_id: sessions.challenger },
    },
    runtime_config: {
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
    },
  };
}

function stateOf(over: Partial<NativeRunStateDocument> = {}): NativeRunStateDocument {
  return {
    schema_version: NATIVE_STATE_SCHEMA_VERSION,
    run_id: RUN_ID,
    state: 'READY',
    control: 'AUTOMATION',
    round: 0,
    active_expert_slot: null,
    next_step_source_slot: 'author',
    last_event_id: null,
    pending_operation: null,
    uncertainty: null,
    updated_at: AT,
    ...over,
  };
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: ReturnType<typeof runPaths>;
  readonly events: NativeEventStore;
  readonly manifest: NativeRunManifest;
  readonly authorResponse: string;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  readonly deps: RunServiceDeps;
  calls(): number;
  interactives(): number;
}

async function startSlot(events: NativeEventStore, slot: ExpertSlotId, session: string): Promise<string> {
  const prompt = await events.append({
    round: 0,
    actor: 'human',
    type: 'prompt_sent',
    target_expert_slot_id: slot,
    content: MISSION,
    timestamp: AT,
  });
  const response = await events.append({
    round: 0,
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: slot,
    session_id: session,
    content: `position initiale de ${slot}`,
    exit_code: 0,
    based_on: [prompt.event_id],
    timestamp: AT,
  });
  await events.append({
    round: 0,
    actor: 'system',
    type: 'session_created',
    expert_slot_id: slot,
    session_id: session,
    timestamp: AT,
  });
  return response.event_id;
}

interface FixtureOptions {
  readonly state?: Partial<NativeRunStateDocument>;
  readonly sessions?: { author: string | null; challenger: string | null };
  /** N'initialise que les slots ayant une session : sert à 1D. */
  readonly maxTransferBytes?: number;
}

async function readyRun(dir: string, options: FixtureOptions = {}): Promise<Fixture> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  const sessions = options.sessions ?? { author: SESSIONS.author, challenger: SESSIONS.challenger };
  const manifest = manifestOf(sessions);
  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, stateOf(options.state));
  const events = await openNativeEventStore(paths, manifest);

  let authorResponse = '';
  if (sessions.author !== null) authorResponse = await startSlot(events, 'author', sessions.author);
  if (sessions.challenger !== null) await startSlot(events, 'challenger', sessions.challenger);

  const interactives: string[] = [];
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: [`${kind}-recovered`],
      sessionId: kind === 'codex' ? SESSIONS.author : SESSIONS.challenger,
      onInteractive: (sessionId) => {
        interactives.push(`${kind}:${sessionId}`);
      },
    });
  const adapters = { claude: build('claude'), codex: build('codex') };

  return {
    runsDir,
    paths,
    events,
    manifest,
    authorResponse,
    adapters,
    deps: {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => adapters,
      ...(options.maxTransferBytes === undefined ? {} : { maxTransferBytes: options.maxTransferBytes }),
    },
    calls: () => adapters.claude.calls.length + adapters.codex.calls.length,
    interactives: () => interactives.length,
  };
}

async function bytes(f: Fixture): Promise<{ state: string; events: string; manifest: string }> {
  return {
    state: await readFile(f.paths.state, 'utf8'),
    events: await readFile(f.paths.events, 'utf8'),
    manifest: await readFile(f.paths.manifest, 'utf8'),
  };
}

async function revisionOf(f: Fixture): Promise<string> {
  return (await readStableNativeRunSnapshot(f.runsDir, RUN_ID)).revision;
}

/** Couture instrumentée : compte, ordonne, et peut refuser dans `before`. */
interface Probe extends NativeMutationBoundary {
  readonly log: string[];
  readonly outcomes: NativeMutationOutcome[];
}

function probe(options: { refuse?: boolean; onBefore?: () => Promise<void> | void; onSettled?: () => Promise<void> | void } = {}): Probe {
  const log: string[] = [];
  const outcomes: NativeMutationOutcome[] = [];
  return {
    log,
    outcomes,
    before: async () => {
      log.push('before');
      await options.onBefore?.();
      if (options.refuse === true) {
        throw new CcrError('STALE_REVISION', 'Vue périmée.', { details: { runId: RUN_ID } });
      }
    },
    settled: async (outcome) => {
      log.push('settled');
      outcomes.push(outcome);
      await options.onSettled?.();
    },
  };
}

/** Précondition réelle : celle que la surface HTTP posera en 2F.2. */
function expectRevision(runsDir: string, expected: string): NativeMutationBoundary {
  return {
    before: async () => {
      const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);
      if (snapshot.revision !== expected) {
        throw new CcrError('STALE_REVISION', "La vue n'est plus la vue courante du run.", {
          details: { expected, actual: snapshot.revision },
        });
      }
    },
  };
}

// ==========================================================================
// A. Snapshot et révision
// ==========================================================================

test('1 · la généralisation du typage ne déplace aucune révision historique', () => {
  const inputs = {
    manifest: { schema_version: 1, run_id: RUN_ID, title: 'T' },
    state: { schema_version: 2, run_id: RUN_ID, state: 'READY' },
    events: [{ event_id: 'evt_000001', type: 'run_created' }],
    decisions: [],
  };

  // Réimplémentation indépendante de la recette **documentée** : préfixe,
  // ordre, séparateurs, longueurs. Élargir le typage des entrées ne pouvait
  // rien y changer — le corps ne fait que sérialiser — et c'est précisément ce
  // que cette comparaison démontre plutôt qu'elle ne le suppose.
  const nl = String.fromCharCode(10);
  const digest = createHash('sha256');
  digest.update(`ccr-run-revision/1${nl}`);
  digest.update(`manifest:${JSON.stringify(inputs.manifest)}${nl}`);
  digest.update(`state:${JSON.stringify(inputs.state)}${nl}`);
  digest.update(`events:${String(inputs.events.length)}:${JSON.stringify(inputs.events)}${nl}`);
  digest.update(`decisions:${String(inputs.decisions.length)}:${JSON.stringify(inputs.decisions)}`);

  assert.equal(computeRunRevision(inputs), `sha256:${digest.digest('hex')}`);
  // Vecteur figé : une évolution silencieuse de la recette échouerait ici même
  // si les deux implémentations dérivaient ensemble.
  assert.equal(
    computeRunRevision(inputs),
    'sha256:682d834462daaba6ed8d1bf1b3f223bbffeac79c0243e5fb32aaaca58936a3e6',
  );
});

test('2–5 · la révision native suit les faits canoniques, et eux seuls', async () => {
  const dir = await makeTempDir('ccr-17a-revision-');
  try {
    const f = await readyRun(dir);

    // 2 · déterminisme : mêmes faits, même empreinte.
    const first = await revisionOf(f);
    assert.equal(await revisionOf(f), first);
    assert.match(first, /^sha256:[0-9a-f]{64}$/, 'format historique, aucun préfixe de génération');

    // 3 · une liaison de session dans le manifest périme la vue : elle change
    // les capacités mutables sans qu'aucun autre fichier ne bouge.
    await bindNativeSession(f.paths, manifestOf({ author: SESSIONS.author, challenger: null }), 'challenger', 'C2');
    const afterManifest = await revisionOf(f);
    assert.notEqual(afterManifest, first);

    // 4 · l'état.
    await writeNativeState(f.paths, stateOf({ state: 'PAUSED', control: 'HUMAN' }));
    const afterState = await revisionOf(f);
    assert.notEqual(afterState, afterManifest);

    // 5 · un événement appendé.
    await f.events.append({ round: 0, actor: 'human', type: 'run_resumed', timestamp: AT });
    const afterEvent = await revisionOf(f);
    assert.notEqual(afterEvent, afterState);
  } finally {
    await removeTempDir(dir);
  }
});

test('6 · un artefact de round ne périme aucune révision', async () => {
  const dir = await makeTempDir('ccr-17a-rounds-');
  try {
    const f = await readyRun(dir);
    const before = await revisionOf(f);

    // `rounds/` est un artefact diagnostique. Il peut apparaître, changer ou
    // disparaître sans qu'aucun fait canonique ne bouge — exactement comme
    // l'observation du verrou côté historique.
    await writeNativeRoundMetadata(f.paths, {
      schema_version: NATIVE_ROUND_SCHEMA_VERSION,
      run_id: RUN_ID,
      round: 1,
      started_at: AT,
      completed_at: AT,
      workspace_cwd: 'E:/prog/exemple',
      source_slot: 'author',
      target_slot: 'challenger',
      source_event_id: f.authorResponse,
      response_event_id: 'evt_000099',
      turns: [],
    });

    assert.equal(await revisionOf(f), before, 'la révision ignore rounds/');
  } finally {
    await removeTempDir(dir);
  }
});

test('7 · le runtime participe, parce qu’il appartient au manifest', async () => {
  const dir = await makeTempDir('ccr-17a-runtime-');
  try {
    const f = await readyRun(dir);
    const before = await revisionOf(f);

    const mutated = manifestOf({ author: SESSIONS.author, challenger: SESSIONS.challenger });
    await writeNativeManifest(f.paths, {
      ...mutated,
      runtime_config: { ...mutated.runtime_config!, captured_at: '2026-08-12T00:00:00.000Z' },
    });
    assert.notEqual(await revisionOf(f), before);
  } finally {
    await removeTempDir(dir);
  }
});

test('8 · un run historique est refusé par le snapshot natif', async () => {
  const dir = await makeTempDir('ccr-17a-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    await expectRejection(
      readStableNativeRunSnapshot(runsDir, RUN_ID),
      'SCHEMA_VERSION_UNSUPPORTED',
      'aucune conversion',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Stabilité
// ==========================================================================

test('9–10 · une source qui bouge pendant la lecture provoque un retry, puis un refus', async () => {
  const dir = await makeTempDir('ccr-17a-unstable-');
  try {
    const f = await readyRun(dir);

    // 9 · une seule course : la seconde tentative est stable, et c'est elle
    // qui est rendue.
    const unstable: number[] = [];
    let perturbations = 0;
    const snapshot = await readStableNativeRunSnapshot(f.runsDir, RUN_ID, {
      sleep: async () => undefined,
      onUnstable: (attempt) => unstable.push(attempt),
      beforeReobserve: async () => {
        if (perturbations > 0) return;
        perturbations += 1;
        await writeNativeState(f.paths, stateOf({ state: 'PAUSED', control: 'HUMAN' }));
      },
    });
    assert.deepEqual(unstable, [1]);
    assert.equal(snapshot.attempts, 2);
    assert.equal(snapshot.state.state, 'PAUSED', 'les faits rendus sont ceux de la fenêtre stable');
    assert.equal(snapshot.revision, computeNativeRunRevision(snapshot.manifest, snapshot.state, snapshot.events));

    // 10 · perturbation systématique : refus explicite, jamais un mélange, et
    // jamais une boucle sans fin.
    let round = 0;
    await expectRejection(
      readStableNativeRunSnapshot(f.runsDir, RUN_ID, {
        sleep: async () => undefined,
        beforeReobserve: async () => {
          round += 1;
          await writeNativeState(f.paths, stateOf({ round, state: 'PAUSED', control: 'HUMAN' }));
        },
      }),
      'SNAPSHOT_UNSTABLE',
      'budget épuisé',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('11 · un snapshot en lecture se prend pendant qu’un verrou est détenu', async () => {
  const dir = await makeTempDir('ccr-17a-read-under-lock-');
  try {
    const f = await readyRun(dir);
    // C'est la propriété qui rend un cockpit utilisable : un HANDOFF détient le
    // verrou pendant toute l'interaction humaine, et la vue doit rester lisible.
    const observed = await withRunLock(f.paths, 'handoff-simulé', async () => {
      assert.ok(await readRunLock(f.paths), 'le verrou est bien détenu');
      return readStableNativeRunSnapshot(f.runsDir, RUN_ID);
    });
    assert.equal(observed.runId, RUN_ID);
  } finally {
    await removeTempDir(dir);
  }
});

test('12 · révision et projection 2D partent des mêmes octets', async () => {
  const dir = await makeTempDir('ccr-17a-projection-');
  try {
    const f = await readyRun(dir);
    const snapshot = await readStableNativeRunSnapshot(f.runsDir, RUN_ID);
    const view = await projectNativeRunReadModelFromSnapshot(snapshot);

    assert.equal(view.read_model_version, 1);
    assert.equal(view.identity.run_id, RUN_ID);
    assert.equal(view.operational_state.state, snapshot.state.state);
    assert.equal(view.experts.author.session_id, snapshot.manifest.experts.author.session_id);
    assert.equal(view.counts.events, snapshot.events.length);
    assert.equal(view.operations.step.allowed, true);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. `BEFORE` précède le premier fait durable
// ==========================================================================

test('13 · STEP : un refus dans BEFORE n’ouvre aucun round et n’appelle personne', async () => {
  const dir = await makeTempDir('ccr-17a-step-before-');
  try {
    const f = await readyRun(dir);
    const before = await bytes(f);
    const p = probe({ refuse: true });

    await expectRejection(stepNativeRun(f.deps, RUN_ID, {}, p), 'STALE_REVISION', 'STEP arrêté');

    assert.deepEqual(p.log, ['before'], 'aucun SETTLED : rien n’a été tenté');
    assert.equal(f.calls(), 0, 'aucun appel fournisseur, même simulé');
    assert.deepEqual(await bytes(f), before, 'ni round_started, ni prompt_sent, ni contexte');
  } finally {
    await removeTempDir(dir);
  }
});

test('14 · SEND : BEFORE précède le premier fait durable, `human_message`', async () => {
  const dir = await makeTempDir('ccr-17a-send-before-');
  try {
    const f = await readyRun(dir);
    const before = await bytes(f);
    const p = probe({ refuse: true });

    await expectRejection(
      sendNativeMessage(f.deps, RUN_ID, expertSlotTarget('author'), 'question', {}, p),
      'STALE_REVISION',
      'SEND arrêté',
    );

    assert.deepEqual(p.log, ['before']);
    assert.equal(f.calls(), 0);
    assert.deepEqual(await bytes(f), before, 'aucun human_message, aucune réponse');
  } finally {
    await removeTempDir(dir);
  }
});

test('15 · PAUSE et RESUME : BEFORE l’emporte sur le verdict métier', async () => {
  const dir = await makeTempDir('ccr-17a-control-before-');
  try {
    // PAUSE serait ici un succès, RESUME un NOOP : dans les deux cas la
    // précondition de vue prime, exactement comme en historique où la révision
    // est vérifiée avant `resumeRunLocked`.
    const f = await readyRun(dir);
    const before = await bytes(f);

    const onPause = probe({ refuse: true });
    await expectRejection(pauseNativeRun(f.deps, RUN_ID, onPause), 'STALE_REVISION', 'PAUSE');
    const onResume = probe({ refuse: true });
    await expectRejection(resumeNativeRun(f.deps, RUN_ID, onResume), 'STALE_REVISION', 'RESUME');

    assert.deepEqual(onPause.log, ['before']);
    assert.deepEqual(onResume.log, ['before']);
    assert.deepEqual(await bytes(f), before, 'aucun run_paused, aucun run_resumed');
  } finally {
    await removeTempDir(dir);
  }
});

test('16 · reprise d’initialisation : BEFORE précède tout appel fournisseur', async () => {
  const dir = await makeTempDir('ccr-17a-init-before-');
  try {
    // Un slot réellement manquant : la continuation appellerait le fournisseur.
    const f = await readyRun(dir, {
      sessions: { author: SESSIONS.author, challenger: null },
      state: { state: 'FAILED_INITIALIZATION', control: 'HUMAN', next_step_source_slot: null },
    });
    const before = await bytes(f);
    const p = probe({ refuse: true });

    await expectRejection(continueNativeInitialization(f.deps, RUN_ID, {}, p), 'STALE_REVISION', '1D arrêté');

    assert.deepEqual(p.log, ['before']);
    assert.equal(f.calls(), 0, 'FAKE_MODEL_CALLS = 0');
    assert.deepEqual(await bytes(f), before);
  } finally {
    await removeTempDir(dir);
  }
});

test('17 · les trois autres familles de reprise s’arrêtent aussi dans BEFORE', async () => {
  const dir = await makeTempDir('ccr-17a-recoveries-before-');
  try {
    const f = await readyRun(dir, { state: { state: 'PAUSED', control: 'HUMAN' } });
    // Un geste discriminant par famille : chacun écrirait un marqueur durable.
    await f.events.append({
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: SESSIONS.author,
      content: 'envoi resté sans issue',
      timestamp: AT,
    });
    await f.events.append({
      round: 0,
      actor: 'human',
      type: 'human_handoff_started',
      target_expert_slot_id: 'challenger',
      session_id: SESSIONS.challenger,
      details: { state: 'PAUSED', control: 'HUMAN' },
      timestamp: AT,
    });
    await f.events.append({
      round: 1,
      actor: 'system',
      type: 'round_started',
      target_expert_slot_id: 'challenger',
      based_on: [f.authorResponse],
      details: { round: 1, source_slot: 'author', target_slot: 'challenger', source_event_id: f.authorResponse },
      timestamp: AT,
    });
    const before = await bytes(f);

    const recoveryDeps = { runsDir: f.runsDir, now: () => new Date(AT) };
    const gestures: readonly (readonly [string, (p: NativeMutationBoundary) => Promise<unknown>])[] = [
      ['step:finalize', (p) => finalizeNativeStepRecovery(recoveryDeps, RUN_ID, {}, p)],
      ['send:abort', (p) => abortNativeSendBeforeProvider(recoveryDeps, RUN_ID, {}, p)],
      ['handoff:abort', (p) => abortNativeHandoffBeforeInteractive(recoveryDeps, RUN_ID, {}, p)],
    ];

    for (const [label, call] of gestures) {
      const p = probe({ refuse: true });
      await expectRejection(call(p), 'STALE_REVISION', label);
      assert.deepEqual(p.log, ['before'], label);
    }

    assert.deepEqual(await bytes(f), before, 'aucun marqueur, aucune écriture d’état');
    assert.equal(f.calls(), 0);
    assert.equal(f.interactives(), 0, 'FAKE_INTERACTIVE_CALLS = 0');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. `BEFORE` et `SETTLED` sont réellement dans la section critique
// ==========================================================================

test('18 · BEFORE s’exécute sous le verrou, et le verrou n’est pas repris', async () => {
  const dir = await makeTempDir('ccr-17a-before-locked-');
  try {
    const f = await readyRun(dir);
    let held = false;
    let second: string | undefined;

    const p = probe({
      refuse: true,
      onBefore: async () => {
        held = (await readRunLock(f.paths)) !== undefined;
        // Le verrou n'est pas réentrant : une seconde acquisition depuis ce
        // même processus est refusée. C'est la preuve que la précondition est
        // physiquement dans la section critique du service.
        try {
          const handle = await acquireRunLock(f.paths, 'sonde');
          await handle.release();
        } catch (error) {
          second = isCcrError(error) ? error.code : 'INATTENDU';
        }
      },
    });

    await expectRejection(pauseNativeRun(f.deps, RUN_ID, p), 'STALE_REVISION', 'refus');
    assert.equal(held, true, '.ccr.lock présent pendant BEFORE');
    assert.equal(second, 'RUN_ALREADY_LOCKED');
  } finally {
    await removeTempDir(dir);
  }
});

test('19–20 · SETTLED s’exécute sous le même verrou, et capture revision_after', async () => {
  const dir = await makeTempDir('ccr-17a-settled-success-');
  try {
    const f = await readyRun(dir);
    const revisionBefore = await revisionOf(f);

    let held = false;
    let second: string | undefined;
    let revisionAfter: string | undefined;
    const outcomes: NativeMutationOutcome[] = [];

    const boundary: NativeMutationBoundary = {
      settled: async (outcome) => {
        outcomes.push(outcome);
        held = (await readRunLock(f.paths)) !== undefined;
        try {
          const handle = await acquireRunLock(f.paths, 'sonde');
          await handle.release();
        } catch (error) {
          second = isCcrError(error) ? error.code : 'INATTENDU';
        }
        // 20 · la révision d'après est lue **avant** la libération : c'est le
        // contrat historique, et la seule façon qu'elle décrive l'effet.
        revisionAfter = (await readStableNativeRunSnapshot(f.runsDir, RUN_ID)).revision;
      },
    };

    const result = await pauseNativeRun(f.deps, RUN_ID, boundary);
    assert.equal(result.changed, true);
    assert.deepEqual(outcomes, [{ kind: 'SUCCEEDED' }]);
    assert.equal(held, true, '.ccr.lock encore présent pendant SETTLED');
    assert.equal(second, 'RUN_ALREADY_LOCKED');
    assert.notEqual(revisionAfter, revisionBefore);
    // Aucune autre mutation n'a eu lieu : la révision capturée sous verrou est
    // celle que l'on relit après la libération.
    assert.equal(revisionAfter, await revisionOf(f));
    assert.equal(await readRunLock(f.paths), undefined, 'verrou libéré après SETTLED');
  } finally {
    await removeTempDir(dir);
  }
});

test('21 · SETTLED s’exécute aussi quand le corps lève APRÈS avoir écrit', async () => {
  const dir = await makeTempDir('ccr-17a-settled-error-');
  try {
    // Chemin natif existant et purement déterministe : le garde-fou de taille
    // journalise `transfer_blocked`, passe en WAITING_HUMAN / HUMAN, puis lève.
    // Aucun fournisseur n'est atteint.
    const f = await readyRun(dir, { maxTransferBytes: 8 });
    const revisionBefore = await revisionOf(f);

    const outcomes: NativeMutationOutcome[] = [];
    let heldDuringSettled = false;
    let revisionAfter: string | undefined;

    const boundary: NativeMutationBoundary = {
      settled: async (outcome) => {
        outcomes.push(outcome);
        heldDuringSettled = (await readRunLock(f.paths)) !== undefined;
        revisionAfter = (await readStableNativeRunSnapshot(f.runsDir, RUN_ID)).revision;
      },
    };

    await expectRejection(
      stepNativeRun(f.deps, RUN_ID, {}, boundary),
      'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
      'garde-fou de taille',
    );

    assert.equal(outcomes.length, 1, 'SETTLED appelé exactement une fois');
    assert.equal(outcomes[0]?.kind, 'FAILED');
    assert.equal(heldDuringSettled, true);
    assert.equal(f.calls(), 0, 'aucun fournisseur atteint');
    // Une intention qui échoue n'implique pas un état inchangé.
    assert.notEqual(revisionAfter, revisionBefore);
    assert.equal(revisionAfter, await revisionOf(f));
    const journal = await readFile(f.paths.events, 'utf8');
    assert.ok(journal.includes('"type":"transfer_blocked"'));
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Révision périmée — à travers le service réel
// ==========================================================================

test('22 · une révision périmée arrête le service natif, pas seulement un helper', async () => {
  const dir = await makeTempDir('ccr-17a-stale-');
  try {
    const f = await readyRun(dir);

    // R1 est la vue que l'humain a lue…
    const r1 = await revisionOf(f);
    // …puis une mutation canonique locale la périme.
    const paused = await pauseNativeRun(f.deps, RUN_ID);
    assert.equal(paused.changed, true);
    const r2 = await revisionOf(f);
    assert.notEqual(r2, r1);

    const before = await bytes(f);
    await expectRejection(
      resumeNativeRun(f.deps, RUN_ID, expectRevision(f.runsDir, r1)),
      'STALE_REVISION',
      'la vue de l’humain n’est plus la vue courante',
    );

    assert.deepEqual(await bytes(f), before, 'aucun nouvel effet');
    assert.equal(await revisionOf(f), r2, 'la révision reste celle du monde réel');

    // La même mutation, proposée sur la vue courante, aboutit.
    const resumed = await resumeNativeRun(f.deps, RUN_ID, expectRevision(f.runsDir, r2));
    assert.equal(resumed.changed, true);
    assert.equal(resumed.state.control, 'AUTOMATION');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// F. Optionalité
// ==========================================================================

test('23 · sans couture, les services natifs se comportent exactement comme avant', async () => {
  const dir = await makeTempDir('ccr-17a-optional-');
  try {
    const f = await readyRun(dir);

    // Les signatures d'appel de la CLI sont inchangées : aucun paramètre
    // obligatoire n'a été ajouté.
    const paused = await pauseNativeRun(f.deps, RUN_ID);
    assert.equal(paused.state.state, 'PAUSED');
    const resumed = await resumeNativeRun(f.deps, RUN_ID);
    assert.equal(resumed.state.state, 'READY');
    const step = await stepNativeRun(f.deps, RUN_ID);
    assert.equal(step.sourceSlot, 'author');
    assert.equal(step.targetSlot, 'challenger');
    const sent = await sendNativeMessage(f.deps, RUN_ID, expertSlotTarget('author'), 'précision');
    assert.equal(sent.expertSlot, 'author');

    // Et le verrou est bien libéré à chaque fois.
    assert.equal(await readRunLock(f.paths), undefined);
  } finally {
    await removeTempDir(dir);
  }
});
