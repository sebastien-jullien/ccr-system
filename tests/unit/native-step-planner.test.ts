/**
 * Slice 1E — Native STEP Planning & Source Authority.
 *
 * La propriété centrale se teste en une phrase : après un START, la réponse du
 * CHALLENGER est la plus récente du journal, et le premier transfert part
 * pourtant de l'AUTHOR. Un planificateur qui prendrait « la dernière réponse »
 * passerait tous les autres tests et échouerait sur celui-là.
 *
 * Aucun fournisseur, aucun adapter, aucun processus : ce fichier construit des
 * runs sur disque et ne fait que décider.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type {
  NativeCcrEvent,
  NativeRunManifest,
  NativeRunRuntimeConfig,
  NativeRunStateDocument,
} from '../../src/core/run-native.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import {
  buildInitialNativeState,
  readPersistedManifest,
  readPersistedState,
  writeNativeManifest,
  writeNativeState,
} from '../../src/store/native-store.ts';
import {
  buildNativeTransferEnvelope,
  planNativeStep,
  planNativeStepForRun,
} from '../../src/services/native-step-planner.ts';
import type { NativeStepPlan } from '../../src/services/native-step-planner.ts';
import { DEFAULT_MAX_TRANSFER_BYTES } from '../../src/services/transfer.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { startRun } from '../../src/services/run-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260810-001';
const AT = '2026-08-10T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

function expectRefusal(plan: NativeStepPlan, code: CcrErrorCode, what: string): void {
  assert.equal(plan.kind, 'REFUSED', `${what} — plan attendu REFUSED`);
  if (plan.kind !== 'REFUSED') return;
  assert.equal(plan.error.code, code, what);
  assert.equal(plan.reason, code, `${what} — raison alignée sur le code`);
}

function ready(plan: NativeStepPlan): Extract<NativeStepPlan, { kind: 'READY' }> {
  assert.equal(plan.kind, 'READY', `plan READY attendu, reçu ${plan.kind}`);
  if (plan.kind !== 'READY') throw new Error('inatteignable');
  return plan;
}

// --------------------------------------------------------------------------
// Construction de runs natifs, sans aucun adapter
// --------------------------------------------------------------------------

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

interface Turn {
  readonly slot: ExpertSlotId;
  readonly content: string;
  readonly session?: string;
  /**
   * Index, dans l'ordre des reponses deja emises, de la source consommee par ce
   * tour — journalisee en `round_completed`. Un index plutot qu'un identifiant :
   * les `event_id` ne sont connus qu'a l'ecriture.
   */
  readonly consumesResponse?: number;
  readonly round?: number;
}

interface RunSpec {
  readonly bindings?: { readonly author: ProviderKind; readonly challenger: ProviderKind };
  readonly sessions?: { readonly author: string | null; readonly challenger: string | null };
  /** Positions initiales puis réponses successives, dans l'ordre du journal. */
  readonly turns: readonly Turn[];
  readonly state?: Partial<NativeRunStateDocument>;
}

interface BuiltRun {
  readonly runsDir: string;
  readonly manifest: NativeRunManifest;
  readonly state: NativeRunStateDocument;
  readonly events: readonly NativeCcrEvent[];
  /** Identifiants des `assistant_response`, dans l'ordre. */
  readonly responseIds: readonly string[];
}

/**
 * Construit un run natif dont le journal reproduit l'ordre réel de 1C :
 * `run_created`, puis pour chaque expert `prompt_sent` / `assistant_response` /
 * `session_created`, puis les tours suivants.
 */
async function buildRun(runsDir: string, spec: RunSpec): Promise<BuiltRun> {
  const bindings = spec.bindings ?? { author: 'codex', challenger: 'claude' };
  const sessions = spec.sessions ?? { author: 'codex-1', challenger: 'claude-1' };
  const paths = runPaths(runsDir, RUN_ID);
  // Chaque construction repart d'un run vierge : le journal est append-only, et
  // deux constructions successives dans le meme repertoire concatenaient leurs
  // evenements.
  await rm(paths.root, { recursive: true, force: true });
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
  await writeNativeState(paths, buildInitialNativeState(RUN_ID, 'READY', new Date(AT)));

  const ref = { manifest };
  const events = await openNativeEventStore(paths, () => ref.manifest);
  await events.append({ round: 0, actor: 'system', type: 'run_created', content: 'T', timestamp: AT });

  const responseIds: string[] = [];
  const bound = new Set<ExpertSlotId>();

  for (const turn of spec.turns) {
    const session = turn.session ?? sessions[turn.slot] ?? `${turn.slot}-session`;
    const round = turn.round ?? 0;

    const prompt = await events.append({
      round,
      actor: 'human',
      type: 'prompt_sent',
      target_expert_slot_id: turn.slot,
      content: MISSION,
      timestamp: AT,
    });
    const response = await events.append({
      round,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: turn.slot,
      session_id: session,
      content: turn.content,
      based_on: [prompt.event_id],
      timestamp: AT,
    });
    responseIds.push(response.event_id);

    if (!bound.has(turn.slot)) {
      manifest = {
        ...manifest,
        experts: { ...manifest.experts, [turn.slot]: { ...manifest.experts[turn.slot], session_id: session } },
      };
      ref.manifest = manifest;
      await writeNativeManifest(paths, manifest);
      await events.append({
        round,
        actor: 'system',
        type: 'session_created',
        expert_slot_id: turn.slot,
        session_id: session,
        timestamp: AT,
      });
      bound.add(turn.slot);
    }

    if (turn.consumesResponse !== undefined) {
      const consumed = responseIds[turn.consumesResponse];
      assert.ok(consumed !== undefined, 'la source consommee doit deja exister');
      await events.append({
        round,
        actor: 'system',
        type: 'round_completed',
        source_slot_id: turn.slot === 'author' ? 'challenger' : 'author',
        target_slot_id: turn.slot,
        source_event_id: consumed,
        response_event_id: response.event_id,
        timestamp: AT,
      });
    }
  }

  // Sessions explicitement absentes : le manifest est réécrit après coup.
  if (spec.sessions !== undefined) {
    manifest = {
      ...manifest,
      experts: {
        author: { provider: bindings.author, session_id: spec.sessions.author },
        challenger: { provider: bindings.challenger, session_id: spec.sessions.challenger },
      },
    };
    ref.manifest = manifest;
    await writeNativeManifest(paths, manifest);
  }

  const state: NativeRunStateDocument = {
    ...buildInitialNativeState(RUN_ID, 'READY', new Date(AT)),
    next_step_source_slot: 'author',
    ...spec.state,
  };
  await writeNativeState(paths, state);

  return { runsDir, manifest, state, events: await events.readAll(), responseIds };
}

function plan(run: BuiltRun, maxTransferBytes?: number): NativeStepPlan {
  return planNativeStep({
    runId: RUN_ID,
    manifest: run.manifest,
    state: run.state,
    events: run.events,
    ...(maxTransferBytes === undefined ? {} : { maxTransferBytes }),
  });
}

/** Les deux positions initiales, celle du challenger en dernier. */
const AFTER_START: readonly Turn[] = [
  { slot: 'author', content: 'position AUTHOR' },
  { slot: 'challenger', content: 'position CHALLENGER' },
];

// ==========================================================================
// Direction — tests 1 à 4
// ==========================================================================

test('1 · le premier transfert part de l’AUTHOR, malgré une réponse CHALLENGER plus récente', async () => {
  const dir = await makeTempDir('ccr-1e-direction-');
  try {
    const run = await buildRun(path.join(dir, 'runs'), { turns: AFTER_START });

    // Le fait qui rend le test discriminant : la dernière réponse du journal
    // est bien celle du challenger.
    const responses = run.events.filter((event) => event.type === 'assistant_response');
    const last = responses[responses.length - 1];
    assert.equal((last as { expert_slot_id?: ExpertSlotId }).expert_slot_id, 'challenger');

    const decided = ready(plan(run));
    assert.equal(decided.sourceSlot, 'author', 'le curseur décide, pas la chronologie');
    assert.equal(decided.targetSlot, 'challenger');
    assert.equal(decided.sourceContent, 'position AUTHOR');
    assert.equal(decided.sourceEventId, run.responseIds[0]);
  } finally {
    await removeTempDir(dir);
  }
});

test('2–4 · le curseur est l’unique autorité, et source ≠ cible toujours', async () => {
  const dir = await makeTempDir('ccr-1e-cursor-');
  try {
    const runsDir = path.join(dir, 'runs');

    for (const [cursor, expectedTarget] of [
      ['author', 'challenger'],
      ['challenger', 'author'],
    ] as readonly (readonly [ExpertSlotId, ExpertSlotId])[]) {
      const run = await buildRun(runsDir, {
        turns: AFTER_START,
        state: { next_step_source_slot: cursor },
      });
      const decided = ready(plan(run));
      assert.equal(decided.sourceSlot, cursor);
      assert.equal(decided.targetSlot, expectedTarget);
      assert.notEqual(decided.sourceSlot, decided.targetSlot);
    }

    // 3 · sans curseur, aucune direction n'est déductible.
    const noCursor = await buildRun(runsDir, {
      turns: AFTER_START,
      state: { next_step_source_slot: null },
    });
    expectRefusal(plan(noCursor), 'RECOVERY_REQUIRED', 'curseur absent');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Source — tests 5 à 9
// ==========================================================================

test('5 · 7 · la dernière réponse **du slot attendu** est retenue', async () => {
  const dir = await makeTempDir('ccr-1e-source-');
  try {
    const run = await buildRun(path.join(dir, 'runs'), {
      turns: [
        { slot: 'author', content: 'A1' },
        { slot: 'challenger', content: 'C0' },
        { slot: 'author', content: 'A2', round: 1 },
      ],
    });
    const decided = ready(plan(run));
    assert.equal(decided.sourceContent, 'A2', 'la plus récente du slot, pas la première');
    assert.equal(decided.sourceEventId, run.responseIds[2]);
  } finally {
    await removeTempDir(dir);
  }
});

test('6 · une source déjà consommée est refusée, sans remonter à une plus ancienne', async () => {
  const dir = await makeTempDir('ccr-1e-consumed-');
  try {
    const runsDir = path.join(dir, 'runs');
    // A1 puis C0 ; le transfert de A1 vers le challenger est finalisé, et sa
    // réponse C1 consomme A1. Le curseur revient sur AUTHOR, dont la dernière
    // réponse reste A1 : elle est consommée, et la recherche ne remonte pas.
    const run = await buildRun(runsDir, {
      turns: [
        { slot: 'author', content: 'A1' },
        { slot: 'challenger', content: 'C0' },
        { slot: 'challenger', content: 'C1', round: 1, consumesResponse: 0 },
      ],
    });
    assert.equal(run.responseIds.length, 3);
    expectRefusal(plan(run), 'SOURCE_ALREADY_TRANSFERRED', 'source consommée');
  } finally {
    await removeTempDir(dir);
  }
});

test('8 · aucune réponse éligible du slot source → refus, la réponse de l’autre n’est pas une source', async () => {
  const dir = await makeTempDir('ccr-1e-nosource-');
  try {
    const run = await buildRun(path.join(dir, 'runs'), {
      turns: [{ slot: 'challenger', content: 'C0' }],
      sessions: { author: 'codex-1', challenger: 'claude-1' },
    });
    expectRefusal(plan(run), 'NO_TRANSFERABLE_SOURCE', 'aucune réponse AUTHOR');
  } finally {
    await removeTempDir(dir);
  }
});

test('9 · une réponse dont la session ne correspond plus au binding n’est pas une source', async () => {
  const dir = await makeTempDir('ccr-1e-session-');
  try {
    const run = await buildRun(path.join(dir, 'runs'), {
      turns: [
        { slot: 'author', content: 'A1', session: 'codex-ancienne' },
        { slot: 'challenger', content: 'C0' },
      ],
      // Le binding final de l'auteur diffère de la session de sa réponse.
      sessions: { author: 'codex-courante', challenger: 'claude-1' },
    });
    expectRefusal(plan(run), 'NO_TRANSFERABLE_SOURCE', 'session incohérente');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Same-provider — tests 10 à 12
// ==========================================================================

test('10–12 · same-provider : deux experts distincts, aucun choix fait depuis le moteur', async () => {
  const dir = await makeTempDir('ccr-1e-same-');
  try {
    const runsDir = path.join(dir, 'runs');
    for (const provider of ['claude', 'codex'] as const) {
      const run = await buildRun(runsDir, {
        bindings: { author: provider, challenger: provider },
        sessions: { author: 'S1', challenger: 'S2' },
        turns: [
          { slot: 'author', content: 'position AUTHOR', session: 'S1' },
          { slot: 'challenger', content: 'position CHALLENGER', session: 'S2' },
        ],
      });
      const decided = ready(plan(run));
      assert.equal(decided.sourceSlot, 'author');
      assert.equal(decided.targetSlot, 'challenger');
      assert.equal(decided.sourceProvider, provider);
      assert.equal(decided.targetProvider, provider, 'même moteur des deux côtés');
      assert.equal(decided.sourceSessionId, 'S1');
      assert.equal(decided.targetSessionId, 'S2');
      assert.notEqual(decided.sourceSessionId, decided.targetSessionId);
    }

    // Deux slots partageant l'identité native : aucun transfert n'a de sens.
    const collided = await buildRun(runsDir, {
      bindings: { author: 'claude', challenger: 'claude' },
      sessions: { author: 'S1', challenger: 'S1' },
      turns: [{ slot: 'author', content: 'A1', session: 'S1' }],
    });
    expectRefusal(plan(collided), 'SESSION_ID_COLLISION', 'identité partagée');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Pending / ambiguïté — tests 13 à 15
// ==========================================================================

test('13–15 · une opération engagée ou une incertitude interdit tout plan', async () => {
  const dir = await makeTempDir('ccr-1e-pending-');
  try {
    const runsDir = path.join(dir, 'runs');

    const pending = await buildRun(runsDir, {
      turns: AFTER_START,
      state: {
        state: 'WAITING_AGENT',
        pending_operation: {
          kind: 'step',
          source_slot: 'author',
          target_slot: 'challenger',
          source_event_id: 'evt_000003',
          round: 1,
          prompt_event_id: 'evt_000009',
          session_id: null,
          return_state: 'RUNNING',
          return_control: 'AUTOMATION',
          started_at: AT,
        },
      },
    });
    const refused = plan(pending);
    expectRefusal(refused, 'RECOVERY_REQUIRED', 'transfert engagé');
    // 15 · la source engagée n'est surtout pas resélectionnée en douce.
    assert.equal(refused.kind === 'REFUSED' && 'sourceEventId' in refused, false);
    assert.equal(
      refused.kind === 'REFUSED' ? refused.error.details['source_event_id'] : null,
      'evt_000003',
      'le refus nomme la source engagée, il ne la réutilise pas',
    );

    const uncertain = await buildRun(runsDir, {
      turns: AFTER_START,
      state: {
        state: 'RECOVERY_REQUIRED',
        control: 'HUMAN',
        uncertainty: { reason: 'processus disparu', since: AT, expert_slot: 'challenger', last_event_id: null },
      },
    });
    expectRefusal(plan(uncertain), 'RECOVERY_REQUIRED', 'incertitude non acquittée');
  } finally {
    await removeTempDir(dir);
  }
});

test('13bis · les gardes de contrôle et d’état de V2 restent celles qui s’appliquent', async () => {
  const dir = await makeTempDir('ccr-1e-guards-');
  try {
    const runsDir = path.join(dir, 'runs');

    // Un run rendu par une reprise est en HUMAN : l'automatisation ne produit
    // pas de tour tant qu'elle n'a pas été explicitement reprise.
    const human = await buildRun(runsDir, {
      turns: AFTER_START,
      state: { state: 'READY', control: 'HUMAN' },
    });
    expectRefusal(plan(human), 'AUTOMATION_NOT_IN_CONTROL', 'contrôle humain');

    const closed = await buildRun(runsDir, {
      turns: AFTER_START,
      state: { state: 'CLOSED' },
    });
    expectRefusal(plan(closed), 'ILLEGAL_STATE_TRANSITION', 'run clos');

    // Sessions manquantes : le transfert n'a pas de cible.
    const partial = await buildRun(runsDir, {
      turns: [{ slot: 'author', content: 'A1' }],
      sessions: { author: 'codex-1', challenger: null },
    });
    expectRefusal(plan(partial), 'SESSION_MISSING', 'challenger sans session');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Round — tests 16 et 17
// ==========================================================================

test('16–17 · le prochain round suit `state.round`, jamais le nombre de positions initiales', async () => {
  const dir = await makeTempDir('ccr-1e-round-');
  try {
    const runsDir = path.join(dir, 'runs');

    const afterStart = await buildRun(runsDir, { turns: AFTER_START });
    assert.equal(afterStart.state.round, 0, 'START ne crée aucun round de transfert');
    assert.equal(ready(plan(afterStart)).nextRoundNumber, 1);

    const afterTransfer = await buildRun(runsDir, {
      turns: [
        { slot: 'author', content: 'A1' },
        { slot: 'challenger', content: 'C0' },
        { slot: 'challenger', content: 'C1', round: 1, consumesResponse: 0 },
        { slot: 'author', content: 'A2', round: 1 },
      ],
      state: { round: 1, next_step_source_slot: 'author' },
    });
    assert.equal(ready(plan(afterTransfer)).nextRoundNumber, 2);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Enveloppe — tests 18 à 20
// ==========================================================================

test('18–20 · l’enveloppe nomme les experts d’abord, les moteurs ensuite, aucune session', async () => {
  const dir = await makeTempDir('ccr-1e-envelope-');
  try {
    const runsDir = path.join(dir, 'runs');

    // 18 · moteurs différents.
    const mixed = await buildRun(runsDir, { turns: AFTER_START });
    const mixedEnvelope = ready(plan(mixed)).envelope;
    assert.ok(mixedEnvelope.startsWith('SOURCE_EXPERT: AUTHOR\n'), 'identité épistémique en tête');
    assert.ok(mixedEnvelope.includes('SOURCE_PROVIDER: CODEX'));
    assert.ok(mixedEnvelope.includes('TARGET_EXPERT: CHALLENGER'));
    assert.ok(mixedEnvelope.includes('TARGET_PROVIDER: CLAUDE'));
    assert.ok(mixedEnvelope.includes('position AUTHOR'), 'contenu transmis verbatim');
    assert.equal(mixedEnvelope.includes('SOURCE: CODEX\n'), false, 'plus de provenance par moteur seul');

    // 19 · même moteur des deux côtés : les experts restent distincts.
    const same = await buildRun(runsDir, {
      bindings: { author: 'claude', challenger: 'claude' },
      sessions: { author: 'S1', challenger: 'S2' },
      turns: [
        { slot: 'author', content: 'position AUTHOR', session: 'S1' },
        { slot: 'challenger', content: 'position CHALLENGER', session: 'S2' },
      ],
    });
    const sameEnvelope = ready(plan(same)).envelope;
    assert.ok(sameEnvelope.includes('SOURCE_EXPERT: AUTHOR'));
    assert.ok(sameEnvelope.includes('TARGET_EXPERT: CHALLENGER'));
    assert.ok(sameEnvelope.includes('SOURCE_PROVIDER: CLAUDE'));
    assert.ok(sameEnvelope.includes('TARGET_PROVIDER: CLAUDE'));

    // 20 · aucun identifiant de session, dans aucune des deux enveloppes.
    for (const [what, envelope, sessions] of [
      ['mixte', mixedEnvelope, ['codex-1', 'claude-1']],
      ['same-provider', sameEnvelope, ['S1', 'S2']],
    ] as readonly (readonly [string, string, readonly string[]])[]) {
      for (const session of sessions) {
        assert.equal(envelope.includes(session), false, `${what} : ${session} absent de l’enveloppe`);
      }
      assert.equal(envelope.toLowerCase().includes('session'), false, `${what} : aucun champ session`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('18bis · l’enveloppe est une fonction pure de ses entrées', () => {
  const input = {
    runId: RUN_ID,
    round: 1,
    sourceSlot: 'author' as const,
    sourceProvider: 'claude' as const,
    targetSlot: 'challenger' as const,
    targetProvider: 'claude' as const,
    sourceEventId: 'evt_000003',
    content: 'contenu',
  };
  assert.equal(buildNativeTransferEnvelope(input), buildNativeTransferEnvelope(input));
});

// ==========================================================================
// Garde-fou de taille — tests 21 à 23
// ==========================================================================

test('21–23 · le garde-fou de taille se prononce sans la moindre mutation', async () => {
  const dir = await makeTempDir('ccr-1e-payload-');
  try {
    const runsDir = path.join(dir, 'runs');

    // 21 · sous le seuil, avec la limite par défaut.
    const small = await buildRun(runsDir, { turns: AFTER_START });
    const readyPlan = ready(plan(small));
    assert.equal(readyPlan.limitBytes, DEFAULT_MAX_TRANSFER_BYTES);
    assert.ok(readyPlan.payloadBytes < DEFAULT_MAX_TRANSFER_BYTES);

    // 22 · au-dessus du seuil.
    const big = await buildRun(runsDir, {
      turns: [
        { slot: 'author', content: 'A'.repeat(4096) },
        { slot: 'challenger', content: 'position CHALLENGER' },
      ],
    });
    const blocked = plan(big, 1024);
    assert.equal(blocked.kind, 'PAYLOAD_TOO_LARGE');
    if (blocked.kind !== 'PAYLOAD_TOO_LARGE') return;

    // 23 · le plan bloqué porte tout ce qu'un refus natif exigera, sans écrire.
    assert.equal(blocked.sourceSlot, 'author');
    assert.equal(blocked.targetSlot, 'challenger');
    assert.equal(blocked.sourceEventId, big.responseIds[0]);
    assert.ok(blocked.payloadBytes > blocked.limitBytes);
    assert.equal(blocked.limitBytes, 1024);
    assert.equal(blocked.error.code, 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
    assert.equal(blocked.sourceContent.length, 4096, 'le contenu source reste intact');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Pureté et legacy — tests 24 à 26
// ==========================================================================

test('24–25 · planifier ne touche aucun fichier et ne crée aucun `rounds/`', async () => {
  const dir = await makeTempDir('ccr-1e-purity-');
  try {
    const runsDir = path.join(dir, 'runs');
    await buildRun(runsDir, { turns: AFTER_START });
    const paths = runPaths(runsDir, RUN_ID);
    const deps: RunServiceDeps = {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => {
        throw new Error('le planificateur ne construit aucun adapter');
      },
    };

    const snapshot = async (): Promise<Record<string, unknown>> => ({
      manifest: await readFile(paths.manifest, 'utf8'),
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
      rounds: (await readdir(paths.roundsDir)).sort(),
    });

    const before = await snapshot();
    const first = await planNativeStepForRun(deps, RUN_ID);
    const second = await planNativeStepForRun(deps, RUN_ID);
    const after = await snapshot();

    assert.deepEqual(after, before, 'aucun octet modifié, aucun round créé');
    assert.deepEqual(before['rounds'], []);
    // Déterminisme : même instantané, même décision.
    assert.equal(ready(first).sourceEventId, ready(second).sourceEventId);
    assert.equal(ready(first).envelope, ready(second).envelope);
  } finally {
    await removeTempDir(dir);
  }
});

test('26 · un run historique est refusé sans la moindre écriture', async () => {
  const dir = await makeTempDir('ccr-1e-legacy-');
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
    };

    await assert.rejects(
      planNativeStepForRun(deps, started.runId),
      (error: unknown) => isCcrError(error) && error.code === 'SCHEMA_VERSION_UNSUPPORTED',
      'run historique refusé',
    );

    assert.deepEqual(
      {
        manifest: await readFile(paths.manifest, 'utf8'),
        state: await readFile(paths.state, 'utf8'),
        events: await readFile(paths.events, 'utf8'),
      },
      before,
      'aucune écriture native sur un run historique',
    );

    // Et le run historique reste lisible dans sa génération.
    assert.equal((await readPersistedManifest(paths)).execution_mode, 'LEGACY_V2_EXECUTION');
    assert.equal((await readPersistedState(paths)).execution_mode, 'LEGACY_V2_EXECUTION');
  } finally {
    await removeTempDir(dir);
  }
});
