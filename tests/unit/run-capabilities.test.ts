/**
 * Capacités d'un run — parité exhaustive avec les services (V2-IMP-30, 0C).
 *
 * La contre-expertise a montré (`CLX2-A3`) qu'une table d'actions écrite à la
 * main diverge du code. La garantie recherchée ici n'est donc pas « quelques
 * exemples heureux » : c'est une **preuve de parité** sur toutes les
 * combinaisons pertinentes.
 *
 * Pour chaque combinaison, on exécute réellement le service mutateur sur un run
 * fabriqué dans cet état, et on compare son issue à la capacité annoncée. Un
 * écart, dans un sens ou dans l'autre, fait échouer le test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { deriveRunCapabilities, CAPABILITY_IDS } from '../../src/services/run-capabilities.ts';
import type { CapabilityId } from '../../src/services/run-capabilities.ts';
import { classifyRunLiveness, NO_EVIDENCE } from '../../src/core/run-liveness.ts';
import { RUN_STATES, CONTROL_OWNERS } from '../../src/core/state.ts';
import type { ControlOwner, RunState } from '../../src/core/state.ts';
import { STATE_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { PendingOperation, RunManifest, RunStateDocument } from '../../src/core/run.ts';
import {
  pauseRun,
  resumeRun,
  stopRun,
  stepRun,
  sendMessage,
  recordDecision,
} from '../../src/services/run-service.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import { writeManifest, writeState } from '../../src/store/state-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260402-001';
const WORKSPACE = 'E:/prog/exemple';

function manifestOf(claude: string | null, codex: string | null): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'T',
    created_at: '2026-08-08T00:00:00.000Z',
    workspace: { cwd: WORKSPACE },
    agents: {
      claude: { session_id: claude, role: 'challenger' },
      codex: { session_id: codex, role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
  };
}

const PENDING: PendingOperation = {
  kind: 'step',
  agent: 'claude',
  round: 1,
  prompt_event_id: 'evt_000004',
  source_event_id: 'evt_000003',
  session_id: 'claude-session-1',
  return_state: 'READY',
  return_control: 'AUTOMATION',
  started_at: '2026-08-08T00:00:00.000Z',
};

function stateOf(
  state: RunState,
  control: ControlOwner,
  pending: PendingOperation | null,
): RunStateDocument {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: RUN_ID,
    state,
    control,
    round: 1,
    active_agent: null,
    last_event_id: 'evt_000003',
    pending_operation: pending,
    uncertainty: null,
    updated_at: '2026-08-08T00:00:00.000Z',
  };
}

/** Prédicat historique du state store, reproduit à l'identique. */
function requiresRecoveryOf(state: RunStateDocument): boolean {
  return state.state === 'WAITING_AGENT' || state.pending_operation !== null;
}

/**
 * Écrit sur disque un run exactement dans l'état voulu, avec un journal
 * portant une réponse d'agent transférable.
 */
async function materialize(
  runsDir: string,
  state: RunStateDocument,
  manifest: RunManifest,
): Promise<void> {
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeManifest(paths, manifest);

  const events = await openEventStore(paths, RUN_ID);
  await events.append({ round: 0, actor: 'system', type: 'run_created', content: 'T', timestamp: '2026-08-08T00:00:00.000Z' });
  await events.append({ round: 0, actor: 'human', type: 'prompt_sent', target: 'codex', content: 'p', timestamp: '2026-08-08T00:00:00.000Z' });
  // Réponse d'agent : source transférable pour `step`.
  await events.append({
    round: 0,
    actor: 'codex',
    type: 'assistant_response',
    session_id: 'codex-session-1',
    content: 'réponse',
    timestamp: '2026-08-08T00:00:00.000Z',
  });

  await writeState(paths, state);
}

function depsFor(runsDir: string): RunServiceDeps {
  return {
    runsDir,
    now: () => new Date('2026-08-08T01:00:00.000Z'),
    createAdapters: () => ({
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-session-1' }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-session-1' }),
    }),
  };
}

/** Issue observée d'un service : succès effectif, succès sans effet, ou refus. */
type Outcome = { readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly code: string };

async function invoke(id: CapabilityId, deps: RunServiceDeps): Promise<Outcome> {
  try {
    switch (id) {
      case 'PAUSE': {
        const r = await pauseRun(deps, { runId: RUN_ID });
        return { ok: true, changed: r.changed };
      }
      case 'RESUME': {
        const r = await resumeRun(deps, { runId: RUN_ID });
        return { ok: true, changed: r.changed };
      }
      case 'STOP': {
        const r = await stopRun(deps, { runId: RUN_ID });
        return { ok: true, changed: r.changed };
      }
      case 'STEP': {
        await stepRun(deps, { runId: RUN_ID });
        return { ok: true, changed: true };
      }
      case 'SEND': {
        await sendMessage(deps, { runId: RUN_ID, agent: 'claude', message: 'm' });
        return { ok: true, changed: true };
      }
      case 'DECIDE': {
        await recordDecision(deps, { runId: RUN_ID, content: 'décision' });
        return { ok: true, changed: true };
      }
    }
  } catch (error) {
    if (isCcrError(error)) return { ok: false, code: error.code };
    throw error;
  }
}

// --------------------------------------------------------------------------
// (24 à 31) Matrice exhaustive et parité réelle
// --------------------------------------------------------------------------

test(
  '(24-31) parité exhaustive entre capacités annoncées et services réels',
  { timeout: 300_000 },
  async (t) => {
    const combinations: { state: RunState; control: ControlOwner; pending: PendingOperation | null }[] = [];
    for (const state of RUN_STATES) {
      for (const control of CONTROL_OWNERS) {
        for (const pending of [null, PENDING]) {
          combinations.push({ state, control, pending });
        }
      }
    }

    let checks = 0;
    const divergences: string[] = [];

    for (const combo of combinations) {
      const stateDoc = stateOf(combo.state, combo.control, combo.pending);
      const manifest = manifestOf('claude-session-1', 'codex-session-1');
      const requiresRecovery = requiresRecoveryOf(stateDoc);

      for (const id of CAPABILITY_IDS) {
        const dir = await makeTempDir('ccr-cap-');
        try {
          const runsDir = path.join(dir, 'runs');
          await mkdir(runsDir, { recursive: true });
          await materialize(runsDir, stateDoc, manifest);

          const events = await (await openEventStore(runPaths(runsDir, RUN_ID), RUN_ID)).readAll();
          const liveness = classifyRunLiveness(
            { manifest, state: stateDoc, pendingResponseJournaled: false },
            NO_EVIDENCE,
          );
          const derived = deriveRunCapabilities(
            { manifest, state: stateDoc, events, decisions: [], requiresRecovery },
            liveness.liveness,
          );
          const capability = derived.capabilities.find((c) => c.id === id);
          assert.ok(capability !== undefined);

          const outcome = await invoke(id, depsFor(runsDir));
          checks += 1;

          // Parité stricte : annoncé permis ⇔ le service aboutit.
          if (capability.allowed !== outcome.ok) {
            divergences.push(
              `${combo.state}/${combo.control}/pending=${combo.pending === null ? 'non' : 'oui'} ` +
                `${id} : annoncé allowed=${String(capability.allowed)}, service=${
                  outcome.ok ? 'succès' : `refus ${outcome.code}`
                }`,
            );
            continue;
          }

          // Et lorsqu'il refuse, le motif annoncé est le code réellement levé.
          if (!outcome.ok && capability.reason !== undefined && capability.reason !== 'OPERATION_IN_FLIGHT') {
            if (capability.reason !== outcome.code) {
              divergences.push(
                `${combo.state}/${combo.control}/pending=${combo.pending === null ? 'non' : 'oui'} ` +
                  `${id} : motif annoncé ${capability.reason}, code réel ${outcome.code}`,
              );
            }
          }

          // Et l'idempotence annoncée correspond à l'absence d'effet.
          if (outcome.ok && capability.idempotentNoop !== !outcome.changed) {
            divergences.push(
              `${combo.state}/${combo.control}/pending=${combo.pending === null ? 'non' : 'oui'} ` +
                `${id} : idempotence annoncée ${String(capability.idempotentNoop)}, effet réel changed=${String(outcome.changed)}`,
            );
          }
        } finally {
          await removeTempDir(dir);
        }
      }
    }

    t.diagnostic(
      `combinaisons=${String(combinations.length)} · vérifications=${String(checks)} · ` +
        `divergences=${String(divergences.length)}`,
    );
    assert.deepEqual(divergences, [], `parité rompue :\n${divergences.join('\n')}`);
    assert.equal(checks, RUN_STATES.length * CONTROL_OWNERS.length * 2 * CAPABILITY_IDS.length);
  },
);

// --------------------------------------------------------------------------
// (32 à 34) Propriétés du contrat
// --------------------------------------------------------------------------

test('(32) HANDOFF n’est jamais une capacité mutable du cockpit', () => {
  assert.ok(!(CAPABILITY_IDS as readonly string[]).includes('HANDOFF'));

  const manifest = manifestOf('claude-session-1', 'codex-session-1');
  const state = stateOf('READY', 'AUTOMATION', null);
  const derived = deriveRunCapabilities(
    { manifest, state, events: [], decisions: [], requiresRecovery: false },
    'NONE',
  );

  assert.deepEqual(
    derived.capabilities.map((c) => c.id),
    ['STEP', 'SEND', 'PAUSE', 'RESUME', 'DECIDE', 'STOP'],
  );
  // Et l'information CLI est exacte : le handoff exige HUMAN + PAUSED.
  assert.equal(derived.handoff.availableViaCli, false, 'faux en READY/AUTOMATION — la V0.1 disait l’inverse');
  assert.equal(derived.handoff.reason, 'HANDOFF_NOT_ALLOWED');

  const paused = deriveRunCapabilities(
    { manifest, state: stateOf('PAUSED', 'HUMAN', null), events: [], decisions: [], requiresRecovery: false },
    'NONE',
  );
  assert.equal(paused.handoff.availableViaCli, true);
});

test('(33) les motifs sont un ensemble fermé et structuré', () => {
  const permitted = new Set([
    'ALREADY_SATISFIED',
    'RECOVERY_REQUIRED',
    'AUTOMATION_NOT_IN_CONTROL',
    'RUN_NOT_PAUSABLE',
    'RUN_NOT_RESUMABLE',
    'HANDOFF_NOT_ALLOWED',
    'SESSION_MISSING',
    'INVALID_ARGUMENT',
    'NO_TRANSFERABLE_SOURCE',
    'SOURCE_ALREADY_TRANSFERRED',
    'ILLEGAL_STATE_TRANSITION',
    'OPERATION_IN_FLIGHT',
  ]);

  for (const state of RUN_STATES) {
    for (const control of CONTROL_OWNERS) {
      for (const pending of [null, PENDING]) {
        const stateDoc = stateOf(state, control, pending);
        const derived = deriveRunCapabilities(
          {
            manifest: manifestOf('claude-session-1', 'codex-session-1'),
            state: stateDoc,
            events: [],
            decisions: [],
            requiresRecovery: requiresRecoveryOf(stateDoc),
          },
          'NONE',
        );
        for (const capability of derived.capabilities) {
          if (capability.reason !== undefined) {
            assert.ok(permitted.has(capability.reason), `motif inattendu : ${capability.reason}`);
          }
          // Aucun texte d'interface ne circule dans le core.
          assert.ok(!/[a-z]{2,}\s[a-z]{2,}/.test(capability.effect), 'effet en code, pas en phrase');
        }
      }
    }
  }
});

test('(34) une capacité impossible n’est jamais autorisée par défaut', () => {
  // Aucune session native : `send` doit être refusé, jamais permis par
  // omission. Idem `step`, sans source transférable.
  const manifest = manifestOf(null, null);
  const state = stateOf('READY', 'AUTOMATION', null);
  const derived = deriveRunCapabilities(
    { manifest, state, events: [], decisions: [], requiresRecovery: false },
    'NONE',
  );

  const send = derived.capabilities.find((c) => c.id === 'SEND');
  assert.equal(send?.allowed, false);
  assert.equal(send?.reason, 'SESSION_MISSING');

  const step = derived.capabilities.find((c) => c.id === 'STEP');
  assert.equal(step?.allowed, false);
  assert.equal(step?.reason, 'NO_TRANSFERABLE_SOURCE');
});

test('pendant une opération démontrée active, le motif n’est jamais « recovery »', () => {
  const manifest = manifestOf('claude-session-1', 'codex-session-1');
  const state = stateOf('WAITING_AGENT', 'AUTOMATION', PENDING);

  const inFlight = deriveRunCapabilities(
    { manifest, state, events: [], decisions: [], requiresRecovery: true },
    'OPERATION_IN_FLIGHT',
  );
  for (const capability of inFlight.capabilities) {
    if (capability.id === 'DECIDE') continue; // seule mutation sans barrière
    assert.equal(capability.allowed, false);
    assert.equal(capability.reason, 'OPERATION_IN_FLIGHT', `${capability.id} : motif exact`);
  }

  // Hors opération active, le motif reste celui du core.
  const abandoned = deriveRunCapabilities(
    { manifest, state, events: [], decisions: [], requiresRecovery: true },
    'ABANDONED_OPERATION',
  );
  assert.equal(abandoned.capabilities.find((c) => c.id === 'STEP')?.reason, 'RECOVERY_REQUIRED');
});

test('`decide` reste disponible pendant un tour agent : c’est la règle du core', () => {
  const manifest = manifestOf('claude-session-1', 'codex-session-1');
  const state = stateOf('WAITING_AGENT', 'AUTOMATION', PENDING);
  const derived = deriveRunCapabilities(
    { manifest, state, events: [], decisions: [], requiresRecovery: true },
    'OPERATION_IN_FLIGHT',
  );
  const decide = derived.capabilities.find((c) => c.id === 'DECIDE');
  assert.equal(decide?.allowed, true, 'une décision humaine n’est pas une progression du run');
});
