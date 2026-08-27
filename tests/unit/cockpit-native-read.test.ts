/**
 * V2.1-IMP-17B — surface de **lecture** HTTP native.
 *
 * Deux propriétés gouvernent ce fichier.
 *
 * D'abord : la révision et la vue proviennent du **même** instantané. Rendre
 * une empreinte calculée sur des faits A et une vue construite sur des faits B
 * décrirait deux mondes, et la future précondition `expected_revision`
 * porterait sur celui que l'humain n'a pas vu.
 *
 * Ensuite : le transport ne réévalue rien. Sources, alias, sessions, reprises,
 * `pause`, `resume`, `handoff` et barrière de fraîcheur traversent la
 * projection 2D sans qu'une seule règle ne soit rejouée côté HTTP.
 *
 * Aucun serveur n'est lancé : les fonctions de lecture sont éprouvées
 * directement, et le câblage des routes est vérifié statiquement. Aucun
 * fournisseur, aucun processus, aucune mutation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_ROUND_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../../src/core/run-native.ts';
import type { NativeRunManifest, NativeRunStateDocument } from '../../src/core/run-native.ts';
import { withRunLock } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import type { NativeEventStore } from '../../src/store/native-event-store.ts';
import { writeNativeRoundMetadata } from '../../src/store/native-round-store.ts';
import { writeNativeManifest, writeNativeState } from '../../src/store/native-store.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { listRunDirectory } from '../../src/store/run-directory.ts';
import { projectNativeRunReadModelFromSnapshot } from '../../src/services/native-read-model.ts';
import { projectCockpitPresentation } from '../../src/services/cockpit-presentation.ts';
import { projectEvidenceReadModel } from '../../src/services/evidence-read-model.ts';
import { listCockpitRuns } from '../../src/services/cockpit-read-model.ts';
import type { CockpitReadModelDeps } from '../../src/services/cockpit-read-model.ts';
import { resolveRunExecutionSettings } from '../../src/services/run-execution-settings.ts';
import {
  readNativeRecoveryHttpView,
  readNativeRunHttpView,
  readNativeTimelineHttpView,
} from '../../src/cockpit/native-read-http.ts';
import { materializeRun } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-002';
const LEGACY_ID = 'CCR-20260811-001';
const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Harnais — stores canoniques uniquement
// --------------------------------------------------------------------------

interface Bindings {
  readonly author: ProviderKind;
  readonly challenger: ProviderKind;
}

function manifestOf(bindings: Bindings, sessions: { author: string; challenger: string }): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Contre-expertise',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: bindings.author, session_id: sessions.author },
      challenger: { provider: bindings.challenger, session_id: sessions.challenger },
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

interface Fixture {
  readonly runsDir: string;
  readonly paths: ReturnType<typeof runPaths>;
  readonly events: NativeEventStore;
  readonly authorResponse: string;
  readonly deps: { runsDir: string };
}

async function nativeRun(
  dir: string,
  options: { bindings?: Bindings; state?: Partial<NativeRunStateDocument> } = {},
): Promise<Fixture> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  const bindings = options.bindings ?? { author: 'codex', challenger: 'claude' };
  const same = bindings.author === bindings.challenger;
  const sessions = same
    ? { author: 'S1', challenger: 'S2' }
    : { author: `${bindings.author}-1`, challenger: `${bindings.challenger}-1` };
  await writeNativeManifest(paths, manifestOf(bindings, sessions));
  await writeNativeState(paths, stateOf(options.state));
  const events = await openNativeEventStore(paths, manifestOf(bindings, sessions));
  const authorResponse = await startSlot(events, 'author', sessions.author);
  await startSlot(events, 'challenger', sessions.challenger);
  return { runsDir, paths, events, authorResponse, deps: { runsDir } };
}

function cockpitDeps(runsDir: string): CockpitReadModelDeps {
  return { runsDir, settings: resolveRunExecutionSettings({}) };
}

// ==========================================================================
// A. LIST bi-génération
// ==========================================================================

test('1–6 · `/api/runs` énumère les deux générations sans inventer d’identité', async () => {
  const dir = await makeTempDir('ccr-17b-list-');
  try {
    const f = await nativeRun(dir, { state: { state: 'PAUSED', control: 'HUMAN', active_expert_slot: 'challenger' } });
    // 1 · un run historique sain reste décrit comme avant.
    await materializeRun(f.runsDir, { runId: LEGACY_ID });

    const runs = await listCockpitRuns(cockpitDeps(f.runsDir));
    const legacy = runs.find((run) => run.run_id === LEGACY_ID);
    const native = runs.find((run) => run.run_id === RUN_ID);

    assert.ok(legacy !== undefined);
    assert.equal(legacy.unreadable, false);
    assert.equal(legacy.generation, 'LEGACY_V2_EXECUTION');
    assert.equal(legacy.active_expert_slot, null, 'un run historique n’a pas de slot');

    // 2–3 · un run natif sain n'est plus illisible, et porte ses vrais faits.
    assert.ok(native !== undefined);
    assert.equal(native.unreadable, false);
    assert.equal(native.generation, 'NATIVE_V21_EXECUTION');
    assert.equal(native.title, 'Contre-expertise');
    assert.equal(native.state, 'PAUSED');
    assert.equal(native.control, 'HUMAN');
    assert.equal(native.round, 0);
    assert.equal(native.updated_at, AT);
    assert.equal(native.runtime_pinned, true);

    // 4 · l'identité active n'est jamais traduite en fournisseur.
    assert.equal(native.active_expert_slot, 'challenger');
    assert.equal(native.active_agent, null, 'aucun `claude|codex` fabriqué depuis un slot');

    // 5 · une version qu'aucune génération ne connaît reste illisible.
    const corrupt = JSON.parse(await readFile(f.paths.manifest, 'utf8')) as Record<string, unknown>;
    await writeFile(f.paths.manifest, JSON.stringify({ ...corrupt, schema_version: 99 }), 'utf8');
    const after = await listCockpitRuns(cockpitDeps(f.runsDir));
    const broken = after.find((run) => run.run_id === RUN_ID);
    assert.equal(broken?.unreadable, true);
    assert.equal(broken?.generation, null);
    assert.equal(broken?.title, null);
  } finally {
    await removeTempDir(dir);
  }
});

test('7 · l’énumération n’ouvre aucun journal et ne classifie aucune reprise', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src/store/run-directory.ts', import.meta.url)),
    'utf8',
  );
  // Une liste doit rester O(runs) sur deux petits documents : c'est ce qui la
  // garde utilisable pendant qu'un autre processus détient un verrou.
  for (const forbidden of ['EventStore', 'RecoveryView', 'ReadModel', 'planNativeStep', 'decision']) {
    assert.equal(source.includes(forbidden), false, `run-directory ne connaît pas ${forbidden}`);
  }
});

// ==========================================================================
// B. GET run natif
// ==========================================================================

test('8–11 · la vue native porte sa révision, et les deux viennent du même instantané', async () => {
  const dir = await makeTempDir('ccr-17b-get-');
  try {
    const f = await nativeRun(dir);

    const view = await readNativeRunHttpView(f.deps, RUN_ID);
    assert.equal(view.generation, 'NATIVE_V21_EXECUTION');
    assert.match(view.revision, /^sha256:[0-9a-f]{64}$/);
    assert.equal(view.run.read_model_version, 1);
    assert.equal(view.run.identity.execution_mode, 'NATIVE_V21_EXECUTION');

    // Preuve d'instantané unique : la projection consomme les **objets** du
    // snapshot. Une seconde lecture disque produirait des objets égaux mais
    // distincts, et cette identité tomberait.
    const snapshot = await readStableNativeRunSnapshot(f.runsDir, RUN_ID);
    const projected = await projectNativeRunReadModelFromSnapshot(snapshot);
    assert.equal(projected.providers, snapshot.manifest.runtime_config);
    assert.equal(projected.operational_state.pending_operation, snapshot.state.pending_operation);
    assert.equal(projected.counts.events, snapshot.events.length);
    assert.equal(snapshot.revision, view.revision, 'aucune mutation entre les deux lectures');

    // V2.3-S1 : la présentation est **additive**, et vient du même instantané.
    // Aucun champ existant n'est déplacé ni modifié par sa venue.
    assert.equal(view.presentation.presentation_version, 1);
    assert.deepEqual(view.presentation, projectCockpitPresentation(snapshot));
    // V3-S3, puis V4-S3, puis V5.1 : trois projections ont rejoint la vue,
    // chacune additivement et depuis le même instantané. L'ensemble des clés
    // reste figé — il gagne exactement un champ par tranche, et aucun précédent
    // n'a bougé.
    //
    // `controversy_revision` s'y ajoute à son tour : la projection V3 ne porte
    // pas son jeton de fraîcheur — c'est son contrat — et une surface de
    // mutation V3 en a besoin comme précondition. L'enveloppe l'expose, depuis
    // le MÊME instantané, sans toucher à la projection.
    //
    // `in_flight` rejoint l'ensemble par la même règle — **cinquième** champ
    // additif, calculé depuis le MÊME instantané, sans seconde lecture et sans
    // toucher à ses voisins. Il ne découvre aucun fait : `pending_operation` et
    // les liaisons d'experts existaient déjà, personne ne les joignait, et le
    // run réel `CCR-20260404-001` a montré ce que ce silence coûte. La position
    // dans la séquence d'initialisation est calculée ici parce qu'elle dépend
    // de l'ordre canonique des slots — une règle du cœur, que le navigateur ne
    // doit pas redériver.
    assert.deepEqual(Object.keys(view).sort(), [
      'controversies',
      'controversy_revision',
      'evidence',
      'generation',
      'in_flight',
      'presentation',
      'reconciliations',
      'revision',
      'run',
    ]);
    // Rien en vol sur ce run : `null`, jamais un objet vide décrivant une
    // attente qui n'existe pas.
    assert.equal(view.run.operational_state.pending_operation, null);
    assert.equal(view.in_flight, null);
    assert.equal(view.controversy_revision, snapshot.controversy_revision);
    assert.notEqual(view.controversy_revision, view.revision);

    // V4-S3 : la projection de l'Evidence Engine vient du **même** instantané,
    // et porte sa propre fraîcheur — jamais celle du run.
    assert.deepEqual(view.evidence, projectEvidenceReadModel(snapshot));
    assert.equal(view.evidence.availability, 'AVAILABLE');
    if (view.evidence.availability === 'AVAILABLE') {
      assert.equal(view.evidence.evidence_revision, snapshot.evidence_revision);
      assert.notEqual(view.evidence.evidence_revision, view.revision);
      // Un run natif sans journal V4 : disponible, et à zéro. Ce n'est pas un
      // run non regardé, et ce n'est pas une absence de preuve dans le monde.
      assert.equal(view.evidence.recorded_material_count, 0);
      assert.equal(view.evidence.recorded_adduction_count, 0);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('12–13 · same-provider : deux experts distincts, alias projetés par 2D', async () => {
  const dir = await makeTempDir('ccr-17b-same-provider-');
  try {
    const f = await nativeRun(dir, { bindings: { author: 'claude', challenger: 'claude' } });
    const view = (await readNativeRunHttpView(f.deps, RUN_ID)).run;

    assert.equal(view.experts.author.provider, 'claude');
    assert.equal(view.experts.challenger.provider, 'claude');
    assert.notEqual(view.experts.author.session_id, view.experts.challenger.session_id);
    // Aucune fusion : les deux slots restent adressables séparément.
    assert.equal(view.compatibility.provider_aliases.claude.resolution, 'AMBIGUOUS');
    assert.equal(view.compatibility.provider_aliases.codex.resolution, 'NOT_BOUND');
  } finally {
    await removeTempDir(dir);
  }
});

test('14–15 · les capacités de contrôle et de handoff traversent intactes', async () => {
  const dir = await makeTempDir('ccr-17b-capabilities-');
  try {
    const automated = await nativeRun(dir);
    const ready = (await readNativeRunHttpView(automated.deps, RUN_ID)).run;
    assert.deepEqual(ready.operations.pause, { allowed: true, noop: false });
    assert.deepEqual(ready.operations.resume, { allowed: true, noop: true });
    // Un run automatisé refuse le handoff : le transport le transmet, il ne
    // l'interprète pas.
    assert.equal(ready.operations.experts.author.handoff.allowed, false);
    assert.equal(ready.operations.experts.author.handoff.reason_code, 'HANDOFF_NOT_ALLOWED');
    await removeTempDir(dir);

    const suspendedDir = await makeTempDir('ccr-17b-capabilities-paused-');
    const suspended = await nativeRun(suspendedDir, { state: { state: 'PAUSED', control: 'HUMAN' } });
    const paused = (await readNativeRunHttpView(suspended.deps, RUN_ID)).run;
    assert.deepEqual(paused.operations.pause, { allowed: true, noop: true });
    assert.deepEqual(paused.operations.resume, { allowed: true, noop: false });
    assert.equal(paused.operations.experts.challenger.handoff.allowed, true);
    await removeTempDir(suspendedDir);
  } finally {
    // Les répertoires sont déjà retirés ; l'appel final reste sans effet.
  }
});

test('16 · une position périmée après handoff est transmise telle quelle', async () => {
  const dir = await makeTempDir('ccr-17b-stale-');
  try {
    const f = await nativeRun(dir, { state: { state: 'PAUSED', control: 'HUMAN' } });
    const started = await f.events.append({
      round: 0,
      actor: 'human',
      type: 'human_handoff_started',
      target_expert_slot_id: 'author',
      session_id: 'codex-1',
      details: { state: 'PAUSED', control: 'HUMAN' },
      timestamp: AT,
    });
    await f.events.append({
      round: 0,
      actor: 'human',
      type: 'human_handoff_finished',
      target_expert_slot_id: 'author',
      session_id: 'codex-1',
      exit_code: 0,
      based_on: [started.event_id],
      details: { cost: 'NOT CONTROLLED / NOT MEASURED' },
      timestamp: AT,
    });

    // Rendu a l'automatisation : sans cela le planificateur refuserait sur le
    // controle, et la barriere de fraicheur ne serait jamais atteinte.
    await writeNativeState(f.paths, stateOf({ state: 'READY', control: 'AUTOMATION' }));

    const view = (await readNativeRunHttpView(f.deps, RUN_ID)).run;
    assert.equal(view.operations.step.allowed, false);
    assert.equal(view.operations.step.source_status, 'STALE_AFTER_HANDOFF');
    assert.equal(view.operations.step.reason_code, 'SOURCE_STALE_AFTER_HANDOFF');
    // Les quatre reprises restent `NONE` : la barrière de fraîcheur n'est pas
    // une reprise, et le transport ne les confond pas.
    assert.equal(view.recovery.handoff.status, 'NONE');
  } finally {
    await removeTempDir(dir);
  }
});

test('17–18 · conflit de faits et diagnostic orphelin traversent sans altération', async () => {
  const dir = await makeTempDir('ccr-17b-conflict-');
  try {
    const f = await nativeRun(dir, { state: { state: 'PAUSED', control: 'HUMAN' } });
    const message = await f.events.append({
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: 'codex-1',
      content: 'question humaine',
      timestamp: AT,
    });
    for (const content of ['première', 'seconde']) {
      await f.events.append({
        round: 0,
        actor: 'expert',
        type: 'assistant_response',
        expert_slot_id: 'author',
        session_id: 'codex-1',
        content,
        exit_code: 0,
        based_on: [message.event_id],
        timestamp: AT,
      });
    }

    const view = (await readNativeRunHttpView(f.deps, RUN_ID)).run;
    // 17 · le conflit est visible dans la reprise **et** dans la capacité.
    assert.equal(view.recovery.send.status, 'EVIDENCE_CONFLICT');
    assert.ok(view.recovery.send.conflicts.length > 0);
    assert.equal(view.operations.resume.allowed, false);
    assert.equal(view.operations.resume.reason_code, 'RECOVERY_EVIDENCE_CONFLICT');
    assert.deepEqual(view.operations.resume.conflicting_recovery_domains, ['send']);
    // L'asymétrie de IMP-16 est préservée : perdre en autonomie reste permis.
    assert.equal(view.operations.pause.allowed, true);
    await removeTempDir(dir);

    // 18 · un diagnostic orphelin non bloquant reste visible sans fermer resume.
    const orphanDir = await makeTempDir('ccr-17b-orphan-');
    const g = await nativeRun(orphanDir, { state: { state: 'PAUSED', control: 'HUMAN' } });
    await g.events.append({
      round: 0,
      actor: 'human',
      type: 'human_handoff_started',
      target_expert_slot_id: 'challenger',
      session_id: 'claude-1',
      details: { state: 'PAUSED', control: 'HUMAN' },
      timestamp: AT,
    });
    const orphan = (await readNativeRunHttpView(g.deps, RUN_ID)).run;
    assert.equal(orphan.recovery.handoff.status, 'PRE_INTERACTIVE_ABORTED');
    assert.deepEqual(orphan.operations.resume, { allowed: true, noop: false });
    await removeTempDir(orphanDir);
  } finally {
    // Répertoires déjà retirés.
  }
});

// ==========================================================================
// C. GET recovery natif
// ==========================================================================

test('19–22 · la reprise native expose quatre domaines et la révision du même instantané', async () => {
  const dir = await makeTempDir('ccr-17b-recovery-');
  try {
    const f = await nativeRun(dir, { state: { state: 'PAUSED', control: 'HUMAN' } });
    await f.events.append({
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: 'codex-1',
      content: 'envoi resté sans issue',
      timestamp: AT,
    });

    const view = await readNativeRecoveryHttpView(f.deps, RUN_ID);
    assert.equal(view.generation, 'NATIVE_V21_EXECUTION');
    assert.deepEqual(Object.keys(view.recovery).sort(), ['handoff', 'initialization', 'send', 'step']);
    assert.equal(view.recovery.send.status, 'PRE_PROVIDER_ABORTED');
    assert.deepEqual(
      view.recovery.send.available_actions.map((action) => action.action),
      ['ABORT_BEFORE_PROVIDER'],
    );
    assert.equal(view.recovery.initialization.status, 'NONE');
    assert.equal(view.recovery.step.status, 'NONE');
    assert.equal(view.recovery.handoff.status, 'NONE');

    // La révision est celle des mêmes faits : c'est elle que portera plus tard
    // `expected_revision`.
    assert.equal(view.revision, (await readStableNativeRunSnapshot(f.runsDir, RUN_ID)).revision);
    assert.equal(view.operational_state.state, 'PAUSED');

    // 23 · aucune taxonomie V1 sur le natif.
    const serialized = JSON.stringify(view);
    for (const legacy of [
      'RECOVERY_FINALIZE_JOURNALED_RESPONSE',
      'RECOVERY_CONTINUE_INITIALIZATION',
      'RECOVERY_MATERIALIZE_AMBIGUITY',
      'RECOVERY_ACKNOWLEDGE_AMBIGUITY',
      'recoverRun',
      'missing_primitives',
    ]) {
      assert.equal(serialized.includes(legacy), false, `${legacy} absent de la vue native`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Snapshot, diagnostics, verrou
// ==========================================================================

test('24–25 · un artefact de round change le diagnostic sans périmer la révision', async () => {
  const dir = await makeTempDir('ccr-17b-rounds-');
  try {
    const f = await nativeRun(dir);
    const before = await readNativeRunHttpView(f.deps, RUN_ID);

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

    const after = await readNativeRunHttpView(f.deps, RUN_ID);
    assert.equal(after.revision, before.revision, 'rounds/ ne périme rien');
    // Aucune capacité mutante ne dépend de cet artefact.
    assert.deepEqual(after.run.operations.step, before.run.operations.step);
    assert.deepEqual(after.run.operations.pause, before.run.operations.pause);
    assert.deepEqual(after.run.operations.resume, before.run.operations.resume);
  } finally {
    await removeTempDir(dir);
  }
});

test('26 · la lecture native fonctionne pendant qu’un verrou est détenu', async () => {
  const dir = await makeTempDir('ccr-17b-locked-');
  try {
    const f = await nativeRun(dir);
    // Un HANDOFF détient le verrou pendant toute l'interaction humaine : la vue
    // doit rester lisible, sinon le cockpit devient inutile quand il compte.
    const view = await withRunLock(f.paths, 'handoff-simulé', () => readNativeRunHttpView(f.deps, RUN_ID));
    assert.equal(view.run.identity.run_id, RUN_ID);
    assert.match(view.revision, /^sha256:/);
  } finally {
    await removeTempDir(dir);
  }
});

test('27 · un run illisible est refusé, jamais rendu à moitié', async () => {
  const dir = await makeTempDir('ccr-17b-unreadable-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: LEGACY_ID });
    // Le lecteur natif ne convertit pas un run historique.
    await expectRejection(
      readNativeRunHttpView({ runsDir }, LEGACY_ID),
      'SCHEMA_VERSION_UNSUPPORTED',
      'aucune conversion',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Chronologie native, et câblage des routes
// ==========================================================================

test('28 · la chronologie native est servie, et n’est plus une surface refusée', async () => {
  // Le refus de surface de 17B a été levé par V2.1-IMP-19 : le read model
  // d'événements existe désormais, et la lecture rend la matière du run.
  const dir = await makeTempDir('ccr-19-served-');
  try {
    const f = await nativeRun(dir);
    const page = await readNativeTimelineHttpView(f.deps, RUN_ID);
    assert.equal(page.generation, 'NATIVE_V21_EXECUTION');
    assert.equal(page.timeline_version, 1);
    assert.ok(page.entries.length > 0, 'le journal du run est lisible');
    assert.match(page.revision, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await removeTempDir(dir);
  }
});

test('29–30 · les routes de lecture aiguillent sur la génération, et rien d’autre', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src/cockpit/server.ts', import.meta.url)),
    'utf8',
  );

  // La génération est établie depuis les faits persistés, jamais devinée.
  assert.ok(source.includes('readRunGeneration'));
  assert.ok(source.includes('readNativeRunHttpView'));
  assert.ok(source.includes('readNativeRecoveryHttpView'));
  assert.ok(source.includes('readNativeTimelineHttpView'));

  // Aucune règle métier dans le transport, et aucune dépendance à la CLI.
  for (const forbidden of [
    'planNativeStep',
    'evaluateNativeManualAction',
    'pauseGuard',
    'resumeGuard',
    'buildNativeRunReadModel',
    "'../cli/",
  ]) {
    assert.equal(source.includes(forbidden), false, `server.ts ne contient pas ${forbidden}`);
  }

  // Aucune route POST native : les mutations restent historiques dans ce slice.
  // Le raisonnement porte sur les **imports**, jamais sur la prose : un module
  // a parfaitement le droit de nommer dans un commentaire ce qu'il n'appelle
  // pas.
  const nativeReadSource = await readFile(
    fileURLToPath(new URL('../../src/cockpit/native-read-http.ts', import.meta.url)),
    'utf8',
  );
  const imports = nativeReadSource
    .split(String.fromCharCode(10))
    .filter((line) => line.startsWith('import'))
    .join(String.fromCharCode(10));
  for (const forbidden of ['run-lock', 'operations-store', 'mutation-boundary', 'long-operations']) {
    assert.equal(imports.includes(forbidden), false, `lecture native sans ${forbidden}`);
  }
  // Et aucun appel d'écriture dans le corps.
  for (const forbidden of ['persistNative', 'writeNative', '.append(']) {
    assert.equal(nativeReadSource.includes(forbidden), false, `lecture native sans ${forbidden}`);
  }
});

test('31 · aucune couche HTTP ni service ne dépend de `src/cli`', async () => {
  const roots = ['src/cockpit/server.ts', 'src/cockpit/native-read-http.ts', 'src/services/cockpit-read-model.ts'];
  for (const relative of roots) {
    const source = await readFile(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
    assert.equal(source.includes('/cli/'), false, `${relative} n’importe rien de la CLI`);
  }
});

// ==========================================================================
// F. Pureté
// ==========================================================================

test('32 · les trois lectures natives n’écrivent aucun fait canonique', async () => {
  const dir = await makeTempDir('ccr-17b-purity-');
  try {
    const f = await nativeRun(dir);
    const before = {
      manifest: await readFile(f.paths.manifest, 'utf8'),
      state: await readFile(f.paths.state, 'utf8'),
      events: await readFile(f.paths.events, 'utf8'),
    };

    await listCockpitRuns(cockpitDeps(f.runsDir));
    await readNativeRunHttpView(f.deps, RUN_ID);
    await readNativeRecoveryHttpView(f.deps, RUN_ID);
    await listRunDirectory(f.runsDir);

    assert.deepEqual(
      {
        manifest: await readFile(f.paths.manifest, 'utf8'),
        state: await readFile(f.paths.state, 'utf8'),
        events: await readFile(f.paths.events, 'utf8'),
      },
      before,
      'aucune lecture n’écrit',
    );
  } finally {
    await removeTempDir(dir);
  }
});
