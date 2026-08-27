/**
 * Parité des capacités sur les préconditions **non state-machine**
 * (mini-gate 0C).
 *
 * La matrice de `run-capabilities.test.ts` couvre trois dimensions — état,
 * contrôle, opération en vol. Elle ne prouve donc rien sur les préconditions
 * que `step` et `send` portent réellement : source transférable, session cible,
 * garde-fou de taille, cibles disponibles.
 *
 * Ce fichier est la matrice orthogonale. Chaque scénario compare la capacité
 * annoncée à l'issue **réelle** du service, sur un run matérialisé.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { deriveRunCapabilities } from '../../src/services/run-capabilities.ts';
import type { CapabilityFacts } from '../../src/services/run-capabilities.ts';
import { DEFAULT_MAX_TRANSFER_BYTES } from '../../src/services/transfer.ts';
import { classifyRunLiveness, NO_EVIDENCE } from '../../src/core/run-liveness.ts';
import { MANIFEST_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { AgentKind, CcrEvent, NewCcrEvent, RunManifest } from '../../src/core/run.ts';
import { sendMessage, stepRun } from '../../src/services/run-service.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import { buildInitialState, writeManifest, writeState } from '../../src/store/state-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260402-001';
const T = '2026-08-08T00:00:00.000Z';

function manifestOf(claude: string | null, codex: string | null): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'T',
    created_at: T,
    workspace: { cwd: 'E:/prog/exemple' },
    agents: {
      claude: { session_id: claude, role: 'challenger' },
      codex: { session_id: codex, role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
  };
}

interface Scenario {
  readonly label: string;
  /**
   * Attente **absolue**, indépendante du service.
   *
   * La parité seule ne suffit pas : les prédicats étant partagés, une règle
   * fausse déplacerait capacité et service ensemble et resterait invisible.
   * Chaque scénario déclare donc aussi ce qui *doit* se produire.
   */
  readonly expect?: { readonly allowed: boolean; readonly reason?: string };
  readonly manifest: RunManifest;
  readonly journal: readonly NewCcrEvent[];
  readonly maxTransferBytes?: number;
  /** Agent visé par l'appel réel de `send`. */
  readonly sendTarget?: AgentKind;
}

const RUN_CREATED: NewCcrEvent = { round: 0, actor: 'system', type: 'run_created', content: 'T', timestamp: T };
const HUMAN_MESSAGE: NewCcrEvent = { round: 0, actor: 'human', type: 'human_message', target: 'claude', content: 'question humaine', timestamp: T };

function codexResponse(content: string): NewCcrEvent {
  return { round: 0, actor: 'codex', type: 'assistant_response', session_id: 'codex-1', content, timestamp: T };
}

/** Marque une source comme déjà consommée par un round abouti. */
function roundCompleted(sourceEventId: string): NewCcrEvent {
  return {
    round: 1,
    actor: 'system',
    type: 'round_completed',
    target: 'claude',
    details: { source_event_id: sourceEventId, target_agent: 'claude' },
    timestamp: T,
  };
}

interface Materialized {
  readonly dir: string;
  readonly runsDir: string;
  readonly events: readonly CcrEvent[];
}

async function materialize(scenario: Scenario): Promise<Materialized> {
  const dir = await makeTempDir('ccr-precond-');
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeManifest(paths, scenario.manifest);
  await writeState(paths, buildInitialState(RUN_ID, 'READY', new Date(T)));

  const store = await openEventStore(paths, RUN_ID);
  for (const event of scenario.journal) await store.append(event);
  const events = await store.readAll();
  return { dir, runsDir, events };
}

function depsFor(runsDir: string, maxTransferBytes?: number): RunServiceDeps {
  return {
    runsDir,
    now: () => new Date(T),
    ...(maxTransferBytes === undefined ? {} : { maxTransferBytes }),
    createAdapters: () => ({
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
    }),
  };
}

function factsOf(scenario: Scenario, events: readonly CcrEvent[]): CapabilityFacts {
  return {
    manifest: scenario.manifest,
    state: buildInitialState(RUN_ID, 'READY', new Date(T)),
    events,
    decisions: [],
    requiresRecovery: false,
    ...(scenario.maxTransferBytes === undefined ? {} : { maxTransferBytes: scenario.maxTransferBytes }),
  };
}

type Outcome = { readonly ok: true } | { readonly ok: false; readonly code: string };

async function callStep(runsDir: string, maxTransferBytes?: number): Promise<Outcome> {
  try {
    await stepRun(depsFor(runsDir, maxTransferBytes), { runId: RUN_ID });
    return { ok: true };
  } catch (error) {
    if (isCcrError(error)) return { ok: false, code: error.code };
    throw error;
  }
}

async function callSend(runsDir: string, agent: AgentKind, message = 'm'): Promise<Outcome> {
  try {
    await sendMessage(depsFor(runsDir), { runId: RUN_ID, agent, message });
    return { ok: true };
  } catch (error) {
    if (isCcrError(error)) return { ok: false, code: error.code };
    throw error;
  }
}

/** Une source dont l'enveloppe dépasse strictement la limite fournie. */
function contentForBytes(target: number): string {
  // L'enveloppe de protocole ajoute un préambule ; on l'ajuste par mesure.
  return 'x'.repeat(target);
}

// --------------------------------------------------------------------------
// (1 à 10) STEP
// --------------------------------------------------------------------------

const STEP_SCENARIOS: readonly Scenario[] = [
  {
    label: '(1) source valide + deux sessions',
    manifest: manifestOf('claude-1', 'codex-1'),
    journal: [RUN_CREATED, codexResponse('réponse')],
    expect: { allowed: true },
  },
  {
    label: '(2) aucune source transférable',
    manifest: manifestOf('claude-1', 'codex-1'),
    journal: [RUN_CREATED],
    expect: { allowed: false, reason: 'NO_TRANSFERABLE_SOURCE' },
  },
  {
    label: '(3) dernier événement humain seulement',
    manifest: manifestOf('claude-1', 'codex-1'),
    journal: [RUN_CREATED, HUMAN_MESSAGE],
    // Un message humain n'est JAMAIS une source, même s'il est le dernier.
    expect: { allowed: false, reason: 'NO_TRANSFERABLE_SOURCE' },
  },
  {
    label: '(4) source déjà consommée par un round abouti',
    manifest: manifestOf('claude-1', 'codex-1'),
    journal: [RUN_CREATED, codexResponse('réponse'), roundCompleted('evt_000002')],
    expect: { allowed: false, reason: 'SOURCE_ALREADY_TRANSFERRED' },
  },
  {
    label: '(5) cible Claude sans session',
    manifest: manifestOf(null, 'codex-1'),
    journal: [RUN_CREATED, codexResponse('réponse')],
    expect: { allowed: false, reason: 'SESSION_MISSING' },
  },
  {
    label: '(6) cible Codex sans session',
    manifest: manifestOf('claude-1', null),
    journal: [
      RUN_CREATED,
      // Source Claude → cible Codex.
      { round: 0, actor: 'claude', type: 'assistant_response', session_id: 'claude-1', content: 'réponse', timestamp: T },
    ],
    expect: { allowed: false, reason: 'SESSION_MISSING' },
  },
  {
    label: '(7) transfert sous la limite',
    manifest: manifestOf('claude-1', 'codex-1'),
    journal: [RUN_CREATED, codexResponse(contentForBytes(1_000))],
    maxTransferBytes: 4_096,
    expect: { allowed: true },
  },
  {
    label: '(9) transfert au-delà de la limite',
    manifest: manifestOf('claude-1', 'codex-1'),
    journal: [RUN_CREATED, codexResponse(contentForBytes(8_000))],
    maxTransferBytes: 4_096,
    expect: { allowed: false, reason: 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER' },
  },
];

test('(1-9) parité STEP sur les préconditions réelles', { timeout: 120_000 }, async (t) => {
  const divergences: string[] = [];
  let checks = 0;

  for (const scenario of STEP_SCENARIOS) {
    const m = await materialize(scenario);
    try {
      const facts = factsOf(scenario, m.events);
      const liveness = classifyRunLiveness(
        { manifest: scenario.manifest, state: facts.state, pendingResponseJournaled: false },
        NO_EVIDENCE,
      );
      const step = deriveRunCapabilities(facts, liveness.liveness).capabilities.find((c) => c.id === 'STEP');
      assert.ok(step !== undefined);

      const outcome = await callStep(m.runsDir, scenario.maxTransferBytes);
      checks += 1;

      // Attente absolue : la règle elle-même, pas seulement sa cohérence.
      if (scenario.expect !== undefined) {
        if (step.allowed !== scenario.expect.allowed) {
          divergences.push(
            `${scenario.label} : attendu allowed=${String(scenario.expect.allowed)}, obtenu ${String(step.allowed)}`,
          );
        }
        if (scenario.expect.reason !== undefined && step.reason !== scenario.expect.reason) {
          divergences.push(
            `${scenario.label} : motif attendu ${scenario.expect.reason}, obtenu ${String(step.reason)}`,
          );
        }
      }

      if (step.allowed !== outcome.ok) {
        divergences.push(
          `${scenario.label} : annoncé allowed=${String(step.allowed)}, service=${
            outcome.ok ? 'succès' : `refus ${outcome.code}`
          }`,
        );
        continue;
      }
      if (!outcome.ok && step.reason !== outcome.code) {
        divergences.push(`${scenario.label} : motif ${String(step.reason)} vs code réel ${outcome.code}`);
      }
    } finally {
      await removeTempDir(m.dir);
    }
  }

  t.diagnostic(`scénarios STEP=${String(checks)} · divergences=${String(divergences.length)}`);
  assert.deepEqual(divergences, [], divergences.join('\n'));
});

test('(8) transfert exactement à la limite : conforme au contrat V1', async () => {
  // Le contrat V1 refuse au-delà de la limite (`>`), donc l'égalité passe.
  // On calibre la limite sur les octets réellement produits par l'enveloppe.
  const scenario: Scenario = {
    label: 'limite exacte',
    manifest: manifestOf('claude-1', 'codex-1'),
    journal: [RUN_CREATED, codexResponse(contentForBytes(2_000))],
  };
  const m = await materialize(scenario);
  try {
    const { planStepTransfer } = await import('../../src/services/transfer.ts');
    const probe = planStepTransfer({
      runId: RUN_ID,
      round: 1,
      events: m.events,
      sessions: { claude: 'claude-1', codex: 'codex-1' },
      state: 'READY',
    });
    assert.equal(probe.kind, 'READY');
    const exact = probe.kind === 'READY' ? probe.bytes : 0;

    for (const [limit, expected] of [
      [exact, true],
      [exact - 1, false],
    ] as const) {
      const facts = factsOf({ ...scenario, maxTransferBytes: limit }, m.events);
      const step = deriveRunCapabilities(facts, 'NONE').capabilities.find((c) => c.id === 'STEP');
      const outcome = await callStep(m.runsDir, limit);
      assert.equal(step?.allowed, expected, `limite ${String(limit)} : capacité`);
      assert.equal(outcome.ok, expected, `limite ${String(limit)} : service`);
      if (!expected) {
        assert.equal(step?.reason, 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
        assert.equal(outcome.ok ? '' : outcome.code, 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
      }
    }
  } finally {
    await removeTempDir(m.dir);
  }
});

test('(10) sous OPERATION_IN_FLIGHT, STEP est refusé avec le motif exact', async () => {
  const scenario: Scenario = {
    label: 'in flight',
    manifest: manifestOf('claude-1', 'codex-1'),
    journal: [RUN_CREATED, codexResponse('réponse')],
  };
  const m = await materialize(scenario);
  try {
    const facts: CapabilityFacts = { ...factsOf(scenario, m.events), requiresRecovery: true };
    const step = deriveRunCapabilities(facts, 'OPERATION_IN_FLIGHT').capabilities.find((c) => c.id === 'STEP');
    assert.equal(step?.allowed, false);
    assert.equal(step?.reason, 'OPERATION_IN_FLIGHT');
  } finally {
    await removeTempDir(m.dir);
  }
});

test('la constante de taille n’est pas dupliquée dans les capacités', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/services/run-capabilities.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('512'), 'aucune constante de taille recopiée');
  assert.ok(!source.includes('DEFAULT_MAX_TRANSFER_BYTES'), 'la limite vient du plan partagé');
  assert.equal(DEFAULT_MAX_TRANSFER_BYTES, 512 * 1024, 'la constante partagée reste celle de V1');
});

// --------------------------------------------------------------------------
// (11 à 16) SEND
// --------------------------------------------------------------------------

const SEND_SCENARIOS: readonly { label: string; manifest: RunManifest; expected: readonly AgentKind[] }[] = [
  { label: '(11) deux sessions présentes', manifest: manifestOf('claude-1', 'codex-1'), expected: ['claude', 'codex'] },
  { label: '(12) Claude absente', manifest: manifestOf(null, 'codex-1'), expected: ['codex'] },
  { label: '(13) Codex absente', manifest: manifestOf('claude-1', null), expected: ['claude'] },
  { label: '(14) les deux absentes', manifest: manifestOf(null, null), expected: [] },
];

test('(11-14) parité SEND par cible', { timeout: 120_000 }, async (t) => {
  const divergences: string[] = [];
  let checks = 0;

  for (const scenario of SEND_SCENARIOS) {
    const m = await materialize({ label: scenario.label, manifest: scenario.manifest, journal: [RUN_CREATED] });
    try {
      const facts = factsOf({ label: scenario.label, manifest: scenario.manifest, journal: [] }, m.events);
      const send = deriveRunCapabilities(facts, 'NONE').capabilities.find((c) => c.id === 'SEND');
      assert.ok(send !== undefined);

      assert.deepEqual(send.targets, scenario.expected, `${scenario.label} : cibles annoncées`);
      assert.equal(send.allowed, scenario.expected.length > 0, `${scenario.label} : disponibilité`);

      // Parité par cible : annoncée disponible ⇔ le service aboutit.
      for (const agent of ['claude', 'codex'] as const) {
        const announced = (send.targets ?? []).includes(agent);
        const outcome = await callSend(m.runsDir, agent);
        checks += 1;
        if (announced !== outcome.ok) {
          divergences.push(
            `${scenario.label} / ${agent} : annoncé=${String(announced)}, service=${
              outcome.ok ? 'succès' : `refus ${outcome.code}`
            }`,
          );
        }
        if (!announced && !outcome.ok && outcome.code !== 'SESSION_MISSING') {
          divergences.push(`${scenario.label} / ${agent} : code inattendu ${outcome.code}`);
        }
      }
    } finally {
      await removeTempDir(m.dir);
    }
  }

  t.diagnostic(`vérifications SEND par cible=${String(checks)} · divergences=${String(divergences.length)}`);
  assert.deepEqual(divergences, [], divergences.join('\n'));
});

test('(15/16) le contenu du message est une validation de requête, pas un fait du snapshot', async () => {
  const scenario: Scenario = { label: 'payload', manifest: manifestOf('claude-1', 'codex-1'), journal: [RUN_CREATED] };
  const m = await materialize(scenario);
  try {
    const send = deriveRunCapabilities(factsOf(scenario, m.events), 'NONE').capabilities.find((c) => c.id === 'SEND');
    assert.equal(send?.allowed, true, 'la capacité ne dépend pas d’un contenu pas encore saisi');

    // (15) payload valide : le service aboutit.
    assert.deepEqual(await callSend(m.runsDir, 'claude', 'message réel'), { ok: true });
  } finally {
    await removeTempDir(m.dir);
  }

  // (16) `send` ne porte aucune règle de contenu vide en V1 — contrairement à
  // `decide`. On le constate au lieu de le supposer.
  const m2 = await materialize(scenario);
  try {
    const empty = await callSend(m2.runsDir, 'claude', '');
    assert.equal(empty.ok, true, 'le service V1 accepte un message vide : aucune règle à refléter');
  } finally {
    await removeTempDir(m2.dir);
  }
});

// --------------------------------------------------------------------------
// UNDETERMINED n'autorise ni n'interdit rien par lui-même
// --------------------------------------------------------------------------

test('UNDETERMINED ne transforme aucune capacité et n’ouvre aucune recovery', async () => {
  const scenario: Scenario = {
    label: 'undetermined',
    manifest: manifestOf('claude-1', 'codex-1'),
    journal: [RUN_CREATED, codexResponse('réponse')],
  };
  const m = await materialize(scenario);
  try {
    const base = factsOf(scenario, m.events);

    // Barrières franchies : la classification ne change rien.
    const clear = deriveRunCapabilities(base, 'NONE').capabilities;
    const undetermined = deriveRunCapabilities(base, 'UNDETERMINED').capabilities;
    assert.deepEqual(undetermined, clear, 'aucune capacité modifiée par UNDETERMINED');

    // Barrière active : UNDETERMINED n'autorise pas ce que le core interdit.
    const blocked: CapabilityFacts = { ...base, requiresRecovery: true };
    for (const capability of deriveRunCapabilities(blocked, 'UNDETERMINED').capabilities) {
      if (capability.id === 'DECIDE') continue;
      assert.equal(capability.allowed, false, `${capability.id} reste interdit`);
      assert.equal(capability.reason, 'RECOVERY_REQUIRED', 'motif du core, non requalifié');
    }

    // Et aucune capacité de recovery n'existe dans le périmètre MUST V2.
    const ids = deriveRunCapabilities(blocked, 'UNDETERMINED').capabilities.map((c) => c.id);
    assert.ok(!ids.some((id) => id.startsWith('RECOVER')), 'aucune capacité de recovery activée');

    const { needsHumanAttention } = await import('../../src/core/run-liveness.ts');
    assert.equal(needsHumanAttention('UNDETERMINED'), false);
  } finally {
    await removeTempDir(m.dir);
  }
});
