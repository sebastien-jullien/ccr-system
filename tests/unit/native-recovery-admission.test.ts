/**
 * V2.1-REPAIR — véracité de l'admission fournisseur de la reprise
 * d'initialisation.
 *
 * Défaut découvert pendant le preflight V2.2 : `may_call_provider` répondait
 * « le statut est-il `CLEAN_MISSING` ? » au lieu de « cette exécution peut-elle
 * atteindre un appel fournisseur ? ». Or la précédence des statuts place
 * `RECONCILABLE_DURABLE_RESPONSE` avant `CLEAN_MISSING` : un run dont un slot
 * est réconciliable **et** l'autre manquant était annoncé local, alors que la
 * reprise réconcilie le premier puis appelle réellement le fournisseur pour le
 * second — sans passer par la garde de concurrence.
 *
 * Ce fichier éprouve les deux moitiés du fait : ce que la projection annonce, et
 * ce que le service fait réellement. Aucun fournisseur réel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeRunManifest, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { RunState } from '../../src/core/state.ts';
import {
  buildNativeInitializationView,
  continueNativeInitialization,
} from '../../src/services/native-recovery-service.ts';
import { applyNativeRecoveryMutation } from '../../src/services/native-recovery-mutations.ts';
import { projectNativeRunReadModelFromSnapshot } from '../../src/services/native-read-model.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { writeNativeManifest, writeNativeState, buildInitialNativeState, persistNativeStateUpdate } from '../../src/store/native-store.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-777';
const AT = '2026-08-11T00:00:00.000Z';
const PROMPT = 'Mission initiale : évaluer la refonte.';

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

// --------------------------------------------------------------------------
// Fixtures — écrites comme les services les produisent
// --------------------------------------------------------------------------

interface SlotWindow {
  readonly prompt?: boolean;
  /** Réponse initiale durable, avec sa session. */
  readonly response?: string;
  /** Session liée dans le manifest. */
  readonly bound?: string;
  /** `session_created` journalisé. */
  readonly created?: string;
}

interface WindowSpec {
  readonly bindings?: { readonly author: ProviderKind; readonly challenger: ProviderKind };
  readonly author: SlotWindow;
  readonly challenger: SlotWindow;
  readonly state?: RunState;
  readonly pendingSlot?: ExpertSlotId;
}

async function materialize(runsDir: string, spec: WindowSpec): Promise<void> {
  const bindings = spec.bindings ?? { author: 'codex', challenger: 'claude' };
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });

  let manifest: NativeRunManifest = {
    schema_version: 2,
    run_id: RUN_ID,
    title: 'T',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: bindings.author, session_id: null },
      challenger: { provider: bindings.challenger, session_id: null },
    },
    runtime_config: nativeRuntime(),
  };
  await writeNativeManifest(paths, manifest);
  let state = buildInitialNativeState(RUN_ID, 'READY', new Date(AT));
  await writeNativeState(paths, state);

  const ref = { manifest };
  const events = await openNativeEventStore(paths, () => ref.manifest);
  await events.append({ round: 0, actor: 'system', type: 'run_created', content: 'T', timestamp: AT });

  let promptEventId: string | null = null;
  for (const slot of ['author', 'challenger'] as const) {
    const window = spec[slot];
    if (window.prompt !== true) continue;
    const prompt = await events.append({
      round: 0,
      actor: 'human',
      type: 'prompt_sent',
      target_expert_slot_id: slot,
      content: PROMPT,
      timestamp: AT,
    });
    promptEventId = prompt.event_id;

    if (window.response !== undefined) {
      await events.append({
        round: 0,
        actor: 'expert',
        type: 'assistant_response',
        expert_slot_id: slot,
        session_id: window.response,
        content: `réponse ${slot}`,
        based_on: [prompt.event_id],
        timestamp: AT,
      });
    }
    if (window.bound !== undefined) {
      manifest = {
        ...manifest,
        experts: { ...manifest.experts, [slot]: { ...manifest.experts[slot], session_id: window.bound } },
      };
      ref.manifest = manifest;
      await writeNativeManifest(paths, manifest);
    }
    if (window.created !== undefined) {
      await events.append({
        round: 0,
        actor: 'system',
        type: 'session_created',
        expert_slot_id: slot,
        session_id: window.created,
        timestamp: AT,
      });
    }
  }

  // Un run porteur d'un slot manquant a été laissé là par START : il n'est
  // jamais `READY`. La transition passe par `RUNNING`, seul chemin autorisé
  // depuis `READY` — la fixture emprunte donc l'ordre réel du moteur.
  const target = spec.state ?? 'FAILED_INITIALIZATION';
  state = await persistNativeStateUpdate(paths, state, { state: 'RUNNING' }, new Date(AT));
  state = await persistNativeStateUpdate(
    paths,
    state,
    {
      state: target,
      ...(spec.pendingSlot === undefined
        ? {}
        : {
            pendingOperation: {
              kind: 'initialization' as const,
              expert_slot: spec.pendingSlot,
              round: 0,
              prompt_event_id: promptEventId,
              session_id: null,
              return_state: 'FAILED_INITIALIZATION' as const,
              return_control: 'AUTOMATION' as const,
              started_at: AT,
            },
          }),
    },
    new Date(AT),
  );
}

interface Harness {
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  startCalls(): number;
  startedSlots(): string[];
}

function harness(runsDir: string): Harness {
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({ kind, startSessionIds: [`${kind}-new-1`, `${kind}-new-2`] });
  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
    adapters,
    startCalls: () =>
      adapters.claude.calls.filter((call) => call.phase === 'start').length +
      adapters.codex.calls.filter((call) => call.phase === 'start').length,
    startedSlots: () =>
      (['claude', 'codex'] as const).flatMap((kind) =>
        adapters[kind].calls.filter((call) => call.phase === 'start').map(() => kind),
      ),
    deps: {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => adapters,
    },
  };
}

async function viewOf(runsDir: string): Promise<ReturnType<typeof buildNativeInitializationView>> {
  const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);
  return buildNativeInitializationView(RUN_ID, snapshot.manifest, snapshot.state, snapshot.events);
}

/** `may_call_provider` tel que la surface d'admission le lit réellement. */
async function projectedMayCall(runsDir: string): Promise<boolean | undefined> {
  const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);
  const model = await projectNativeRunReadModelFromSnapshot(snapshot);
  return model.recovery.initialization.available_actions.find(
    (action) => action.action === 'CONTINUE',
  )?.may_call_provider;
}

// ==========================================================================
// A. Le cas mixte — le défaut réparé
// ==========================================================================

test('1–2 · réconciliable + manquant : l’admission dit vrai, et le service appelle', async () => {
  const dir = await makeTempDir('ccr-repair-mixed-');
  try {
    const runsDir = path.join(dir, 'runs');
    // L'auteur possède une réponse durable non liée — donc réconciliable.
    // Le challenger n'a rien — donc manquant.
    await materialize(runsDir, {
      author: { prompt: true, response: 'codex-1' },
      challenger: {},
    });

    const view = await viewOf(runsDir);
    assert.equal(view.status, 'RECONCILABLE_DURABLE_RESPONSE', 'la précédence des statuts est intacte');
    assert.deepEqual(view.missingSlots, ['challenger']);

    // 1 · la projection annonce désormais ce que l'exécution fera.
    assert.equal(view.canContinueWithProvider, true);
    assert.equal(await projectedMayCall(runsDir), true, 'lu par la surface d’admission');

    // 2 · et l'exécution l'atteint réellement : un seul appel, sur le challenger.
    const h = harness(runsDir);
    const outcome = await continueNativeInitialization(h.deps, RUN_ID);
    assert.equal(h.startCalls(), 1);
    assert.deepEqual(h.startedSlots(), ['claude'], 'le fournisseur du seul slot manquant');
    assert.deepEqual(outcome.positions.map((position) => position.slot), ['challenger']);
    // La réconciliation locale a bien eu lieu au passage.
    assert.equal(outcome.view.conditions.author, 'COMPLETE');
  } finally {
    await removeTempDir(dir);
  }
});

test('3 · lié-à-finaliser + manquant : même vérité', async () => {
  const dir = await makeTempDir('ccr-repair-linked-');
  try {
    const runsDir = path.join(dir, 'runs');
    // Session liée au manifest mais `session_created` absent : LINKED.
    await materialize(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1' },
      challenger: {},
    });

    const view = await viewOf(runsDir);
    assert.equal(view.status, 'LINKED_NEEDS_FINALIZATION');
    assert.deepEqual(view.missingSlots, ['challenger']);
    assert.equal(view.canContinueWithProvider, true);
    assert.equal(await projectedMayCall(runsDir), true);

    const h = harness(runsDir);
    await continueNativeInitialization(h.deps, RUN_ID);
    assert.equal(h.startCalls(), 1, 'le slot manquant est bien initialisé');
  } finally {
    await removeTempDir(dir);
  }
});

test('4 · slot manquant seul : inchangé', async () => {
  const dir = await makeTempDir('ccr-repair-clean-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, { author: { prompt: true }, challenger: {} });

    const view = await viewOf(runsDir);
    assert.equal(view.status, 'CLEAN_MISSING');
    assert.deepEqual([...view.missingSlots].sort(), ['author', 'challenger']);
    assert.equal(view.canContinueWithProvider, true);
    assert.equal(await projectedMayCall(runsDir), true);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Ce qui reste local le reste
// ==========================================================================

test('5–7 · une reprise sans slot manquant n’annonce aucun fournisseur', async () => {
  const dir = await makeTempDir('ccr-repair-local-');
  try {
    const runsDir = path.join(dir, 'runs');
    // Les deux slots ont répondu ; l'un attend seulement sa finalisation.
    await materialize(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1' },
      challenger: { prompt: true, response: 'claude-1', bound: 'claude-1', created: 'claude-1' },
      state: 'READY',
    });

    const view = await viewOf(runsDir);
    assert.equal(view.status, 'LINKED_NEEDS_FINALIZATION');
    assert.deepEqual(view.missingSlots, [], 'aucun slot manquant');
    // 5 · la garde reste **vraie**, pas conservatrice sans raison.
    assert.equal(view.canContinueWithProvider, false);
    assert.equal(await projectedMayCall(runsDir), false);

    // 6 · et l'exécution ne touche réellement aucun fournisseur.
    const h = harness(runsDir);
    await continueNativeInitialization(h.deps, RUN_ID);
    assert.equal(h.startCalls(), 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('8 · incertitude et contradiction n’ouvrent aucune admission', async () => {
  for (const scenario of ['uncertain', 'conflict'] as const) {
    const dir = await makeTempDir(`ccr-repair-${scenario}-`);
    try {
      const runsDir = path.join(dir, 'runs');
      if (scenario === 'uncertain') {
        // Un contexte engagé sans réponse : CCR ignore ce qui a eu lieu.
        await materialize(runsDir, {
          author: { prompt: true, response: 'codex-1', bound: 'codex-1', created: 'codex-1' },
          challenger: { prompt: true },
          state: 'WAITING_AGENT',
          pendingSlot: 'challenger',
        });
      } else {
        // Le manifest lie une session dont aucune réponse durable ne témoigne.
        await materialize(runsDir, {
          author: { prompt: true, bound: 'codex-1' },
          challenger: {},
        });
      }

      const view = await viewOf(runsDir);
      assert.equal(view.status, scenario === 'uncertain' ? 'IN_FLIGHT_UNCERTAIN' : 'EVIDENCE_CONFLICT');
      // Un slot peut être manquant, et pourtant aucun appel n'est atteignable :
      // la reprise lève avant tout fournisseur.
      assert.equal(view.canContinueWithProvider, false, scenario);

      const h = harness(runsDir);
      await assert.rejects(continueNativeInitialization(h.deps, RUN_ID));
      assert.equal(h.startCalls(), 0, scenario);
    } finally {
      await removeTempDir(dir);
    }
  }
});

// ==========================================================================
// C. `requiredProviders`
// ==========================================================================

test('9 · les fournisseurs annoncés sont ceux des slots réellement manquants', async () => {
  const dir = await makeTempDir('ccr-repair-providers-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, {
      bindings: { author: 'claude', challenger: 'codex' },
      author: { prompt: true, response: 'claude-1' },
      challenger: {},
    });
    const mixed = await viewOf(runsDir);
    assert.equal(mixed.canContinueWithProvider, true);
    assert.deepEqual(
      mixed.requiredProviders,
      ['codex'],
      'le moteur du slot seulement réconcilié n’est pas requis',
    );
  } finally {
    await removeTempDir(dir);
  }

  const dir2 = await makeTempDir('ccr-repair-same-provider-');
  try {
    const runsDir = path.join(dir2, 'runs');
    await materialize(runsDir, {
      bindings: { author: 'claude', challenger: 'claude' },
      author: {},
      challenger: {},
    });
    const same = await viewOf(runsDir);
    assert.deepEqual([...same.missingSlots].sort(), ['author', 'challenger']);
    assert.deepEqual(same.requiredProviders, ['claude'], 'dédoublonné');
  } finally {
    await removeTempDir(dir2);
  }
});

// ==========================================================================
// D. La garde de concurrence, réellement
// ==========================================================================

test('10–11 · le cas mixte réserve un créneau, la reprise locale n’en réserve aucun', async () => {
  const dir = await makeTempDir('ccr-repair-admission-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, {
      author: { prompt: true, response: 'codex-1' },
      challenger: {},
    });

    const h = harness(runsDir);
    const manager = createLongOperationManager();
    const admitted: string[] = [];
    const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);

    const outcome = await applyNativeRecoveryMutation(
      { runService: h.deps, manager, operationId: 'op_mixed' },
      {
        runId: RUN_ID,
        domain: 'initialization',
        action: 'CONTINUE',
        expectedRevision: snapshot.revision,
      },
      { onAdmitted: (id) => admitted.push(id) },
    );

    // 10 · le créneau a bien été réservé avant l'appel, puis relâché.
    assert.deepEqual(admitted, ['op_mixed']);
    assert.equal(outcome.usedProvider, true);
    assert.equal(h.startCalls(), 1);
    assert.equal(manager.activeCount(), 0, 'libéré dans le `finally`');
  } finally {
    await removeTempDir(dir);
  }

  const dir2 = await makeTempDir('ccr-repair-admission-local-');
  try {
    const runsDir = path.join(dir2, 'runs');
    await materialize(runsDir, {
      author: { prompt: true, response: 'codex-1', bound: 'codex-1' },
      challenger: { prompt: true, response: 'claude-1', bound: 'claude-1', created: 'claude-1' },
      state: 'READY',
    });

    const h = harness(runsDir);
    const manager = createLongOperationManager();
    const admitted: string[] = [];
    const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);

    const outcome = await applyNativeRecoveryMutation(
      { runService: h.deps, manager, operationId: 'op_local' },
      {
        runId: RUN_ID,
        domain: 'initialization',
        action: 'CONTINUE',
        expectedRevision: snapshot.revision,
      },
      { onAdmitted: (id) => admitted.push(id) },
    );

    // 11 · aucune réservation pour une action qui n'appelle personne.
    assert.deepEqual(admitted, []);
    assert.equal(outcome.usedProvider, false);
    assert.equal(h.startCalls(), 0);
  } finally {
    await removeTempDir(dir2);
  }
});

test('12 · manager saturé : le cas mixte est refusé AVANT tout fournisseur', async () => {
  const dir = await makeTempDir('ccr-repair-busy-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materialize(runsDir, {
      author: { prompt: true, response: 'codex-1' },
      challenger: {},
    });

    const h = harness(runsDir);
    const manager = createLongOperationManager();
    // Les deux créneaux du cockpit sont déjà pris.
    manager.admit('op_a');
    manager.admit('op_b');
    const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);

    await assert.rejects(
      applyNativeRecoveryMutation(
        { runService: h.deps, manager, operationId: 'op_mixed' },
        {
          runId: RUN_ID,
          domain: 'initialization',
          action: 'CONTINUE',
          expectedRevision: snapshot.revision,
        },
      ),
      (error: unknown) => isCcrError(error) && error.code === 'COCKPIT_BUSY',
    );

    // La preuve fonctionnelle du repair : aucun appel n'a échappé à la garde.
    assert.equal(h.startCalls(), 0);
    const after = await viewOf(runsDir);
    assert.deepEqual(after.missingSlots, ['challenger'], 'le run n’a pas bougé');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Sémantique de reprise inchangée
// ==========================================================================

test('13 · aucun geste, aucun statut, aucun événement de reprise n’a changé', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../src/services/native-recovery-service.ts', import.meta.url),
    'utf8',
  );
  // Le repair est une prédiction, pas une sémantique : le service n'apprend
  // aucun nouveau type d'événement et aucun nouveau statut.
  assert.equal(source.includes('initialization_aborted'), false, 'aucun événement neuf');

  // Le classifieur, lui, reste fondé sur les seuls faits V2.1. La gouvernance
  // d'usage a rejoint le **chemin d'exécution** (V2.2-IMP-05), jamais la
  // décision de légalité : la région du constructeur de vue n'en sait rien.
  const classifier = source.slice(
    source.indexOf('export function buildNativeInitializationView'),
    source.indexOf('async function loadNativeRun'),
  );
  assert.ok(classifier.length > 500, 'la région du classifieur a bien été isolée');
  for (const forbidden of ['invocation-ledger', 'usage-ledger', 'openInvocations', 'openUsage']) {
    assert.equal(classifier.includes(forbidden), false, `le classifieur ignore ${forbidden}`);
  }
  const statuses = [
    'NONE',
    'COMPLETE_NEEDS_FINALIZATION',
    'RECONCILABLE_DURABLE_RESPONSE',
    'LINKED_NEEDS_FINALIZATION',
    'CLEAN_MISSING',
    'IN_FLIGHT_UNCERTAIN',
    'EVIDENCE_CONFLICT',
  ];
  for (const status of statuses) assert.ok(source.includes(`'${status}'`), status);
});
