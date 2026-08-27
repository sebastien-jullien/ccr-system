/**
 * Slice 1B — Native Event & Round Provenance Foundation.
 *
 * Ce fichier éprouve quatre propriétés qu'un journal provider-nommé ne peut pas
 * satisfaire :
 *
 *   1. un tour d'expert reste attribuable même quand les deux experts
 *      partagent le même moteur ;
 *   2. un passage de témoin porte **deux** slots, jamais un seul ;
 *   3. aucun journal ne peut mélanger les deux générations ;
 *   4. un artefact de round natif ne collisionne pas en same-provider, et ne
 *      prétend pas qu'un tour initial était déjà un transfert.
 *
 * Aucun fournisseur n'est invoqué : aucun processus n'est lancé ici.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { EXPERT_SLOT_IDS, PROVIDER_KINDS } from '../../src/core/expert.ts';
import type { ExpertSlotId } from '../../src/core/expert.ts';
import { validateNativeEventShape } from '../../src/core/event-provenance.ts';
import * as provenance from '../../src/core/event-provenance.ts';
import { ROUND_SCHEMA_VERSION } from '../../src/core/run.ts';
import { NATIVE_ROUND_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type {
  NativeRoundMetadata,
  NativeRunManifest,
  NewNativeCcrEvent,
} from '../../src/core/run-native.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { roundDir, runPaths } from '../../src/store/layout.ts';
import {
  openNativeEventStore,
  openRunEventStore,
} from '../../src/store/native-event-store.ts';
import {
  nativeRoundArtifactNames,
  readNativeRoundMetadata,
  readRunRoundMetadata,
  roundSchemaVersionFor,
  validateNativeRoundMetadata,
  writeNativeRoundMetadata,
  writeNativeRoundTurnArtifacts,
  writeRunRoundMetadata,
} from '../../src/store/native-round-store.ts';
import { readPersistedManifest } from '../../src/store/native-store.ts';
import { readRoundMetadata, writeRoundMetadata, writeRoundTurnArtifacts } from '../../src/store/round-store.ts';
import {
  FIXTURE_TIME,
  NATIVE_BINDING_PERMUTATIONS,
  materializeNativeRun,
  materializeRun,
  nativeFixtureManifest,
  nativeSessionId,
  permutationLabel,
} from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260402-001';
const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));

function expectCcrError(fn: () => unknown, code: CcrErrorCode, what: string): void {
  assert.throws(fn, (error: unknown) => isCcrError(error) && error.code === code, what);
}

async function expectCcrRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

async function journalBytes(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function nativeManifest(author: 'claude' | 'codex', challenger: 'claude' | 'codex'): NativeRunManifest {
  return nativeFixtureManifest(RUN_ID, { author, challenger });
}

// ==========================================================================
// 1–3. Le journal historique ne bouge pas
// ==========================================================================

test('1–3 · un journal historique reste lisible et intact, sans slot ajouté', async () => {
  const dir = await makeTempDir('ccr-1b-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, {
      runId: RUN_ID,
      events: [
        { round: 0, actor: 'system', type: 'run_created', content: 'créé' },
        {
          round: 1,
          actor: 'claude',
          type: 'assistant_response',
          session_id: 'claude-1',
          content: 'réponse historique',
          exit_code: 0,
        },
      ],
    });
    const paths = runPaths(runsDir, RUN_ID);

    const before = await readFile(paths.events, 'utf8');
    const store = await openEventStore(paths, RUN_ID);
    const events = await store.readAll();

    assert.equal(events.length, 2);
    const response = events[1];
    assert.ok(response !== undefined);
    // L'identité historique reste provider-driven, et son sens ne change pas.
    assert.equal(response.actor, 'claude');
    assert.equal(response.session_id, 'claude-1');
    assert.equal(response.content, 'réponse historique');

    // Aucun champ natif n'est synthétisé, ni en mémoire ni sur disque.
    for (const field of ['expert_slot_id', 'target_expert_slot_id', 'source_slot_id', 'target_slot_id']) {
      assert.equal(field in response, false, `${field} absent du record canonique`);
      assert.equal(before.includes(field), false, `${field} absent du fichier`);
    }
    assert.equal(await readFile(paths.events, 'utf8'), before, 'la lecture n’écrit rien');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// 4–9. Événements natifs mono-slot
// ==========================================================================

test('4–5 · `session_created` est valide pour chacun des deux slots', async () => {
  const dir = await makeTempDir('ccr-1b-session-');
  try {
    const runsDir = path.join(dir, 'runs');
    // Aucune session liée : l'initialisation est précisément en cours.
    await materializeNativeRun(runsDir, {
      runId: RUN_ID,
      bindings: { author: 'claude', challenger: 'claude' },
      manifest: { sessions: 'none' },
    });
    const paths = runPaths(runsDir, RUN_ID);
    const manifest = nativeFixtureManifest(RUN_ID, { author: 'claude', challenger: 'claude' }, { sessions: 'none' });
    const store = await openNativeEventStore(paths, manifest);

    for (const slot of EXPERT_SLOT_IDS) {
      const event = await store.append({
        round: 0,
        actor: 'system',
        type: 'session_created',
        expert_slot_id: slot,
        session_id: nativeSessionId(slot),
      });
      assert.equal(event.type, 'session_created');
      assert.equal('expert_slot_id' in event && event.expert_slot_id, slot);
    }

    const all = await store.readAll();
    assert.equal(all.length, 2);
    // Même moteur des deux côtés, deux tours parfaitement discernables.
    assert.notEqual(
      (all[0] as { expert_slot_id: ExpertSlotId }).expert_slot_id,
      (all[1] as { expert_slot_id: ExpertSlotId }).expert_slot_id,
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('6–9 · `assistant_response` exige slot **et** session, et refuse un fournisseur', () => {
  const complete = {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: FIXTURE_TIME,
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'native-author-1',
    content: 'position initiale',
  };
  const parsed = validateNativeEventShape(complete, null);
  assert.equal(parsed.type, 'assistant_response');

  const withoutSlot: Record<string, unknown> = { ...complete };
  delete withoutSlot['expert_slot_id'];
  expectCcrError(() => validateNativeEventShape(withoutSlot, null), 'JOURNAL_INVALID', '6 · slot absent');

  const withoutSession: Record<string, unknown> = { ...complete };
  delete withoutSession['session_id'];
  expectCcrError(() => validateNativeEventShape(withoutSession, null), 'JOURNAL_INVALID', '7 · session absente');

  for (const provider of PROVIDER_KINDS) {
    expectCcrError(
      () => validateNativeEventShape({ ...complete, expert_slot_id: provider }, null),
      'JOURNAL_INVALID',
      `8 · slot = ${provider}`,
    );
    expectCcrError(
      () => validateNativeEventShape({ ...complete, actor: provider }, null),
      'JOURNAL_INVALID',
      `8 · actor = ${provider}`,
    );
  }

  expectCcrError(
    () => validateNativeEventShape({ ...complete, expert_slot_id: 'referee' }, null),
    'JOURNAL_INVALID',
    '9 · slot inconnu',
  );

  // Et le fait technique historique ne peut pas revenir par la porte de côté.
  expectCcrError(
    () => validateNativeEventShape({ ...complete, target: 'claude' }, null),
    'JOURNAL_INVALID',
    'champ `target` fournisseur',
  );
});

test('9bis · un événement humain ou système ne reçoit aucun slot inventé', () => {
  const humanEvent = {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: FIXTURE_TIME,
    actor: 'human',
    type: 'decision_recorded',
    content: 'décision produit',
  };
  assert.equal(validateNativeEventShape(humanEvent, null).type, 'decision_recorded');

  for (const field of ['expert_slot_id', 'target_expert_slot_id', 'source_slot_id', 'target_slot_id']) {
    expectCcrError(
      () => validateNativeEventShape({ ...humanEvent, [field]: 'author' }, null),
      'JOURNAL_INVALID',
      `${field} sur un événement sans slot`,
    );
  }

  // Un prompt, lui, s'adresse bien à un expert.
  const prompt = { ...humanEvent, type: 'prompt_sent', actor: 'system', target_expert_slot_id: 'challenger' };
  assert.equal(validateNativeEventShape(prompt, null).type, 'prompt_sent');
  const withoutTarget: Record<string, unknown> = { ...prompt };
  delete withoutTarget['target_expert_slot_id'];
  expectCcrError(() => validateNativeEventShape(withoutTarget, null), 'JOURNAL_INVALID', 'prompt sans cible');
});

// ==========================================================================
// 10–15. Événement bi-slot
// ==========================================================================

test('10–15 · `round_completed` porte source et cible, distinctes, avec ses deux liens', () => {
  const base = {
    event_id: 'evt_000004',
    run_id: RUN_ID,
    round: 1,
    timestamp: FIXTURE_TIME,
    actor: 'system',
    type: 'round_completed',
    source_event_id: 'evt_000002',
    response_event_id: 'evt_000003',
  };

  for (const [source, target] of [
    ['author', 'challenger'],
    ['challenger', 'author'],
  ] as readonly (readonly [ExpertSlotId, ExpertSlotId])[]) {
    const parsed = validateNativeEventShape({ ...base, source_slot_id: source, target_slot_id: target }, null);
    assert.equal(parsed.type, 'round_completed');
    assert.equal((parsed as { source_slot_id: ExpertSlotId }).source_slot_id, source);
    assert.equal((parsed as { target_slot_id: ExpertSlotId }).target_slot_id, target);
  }

  const valid = { ...base, source_slot_id: 'author', target_slot_id: 'challenger' };

  expectCcrError(
    () => validateNativeEventShape({ ...valid, target_slot_id: 'author' }, null),
    'JOURNAL_INVALID',
    '12 · source = cible',
  );

  for (const field of ['source_event_id', 'response_event_id']) {
    const broken: Record<string, unknown> = { ...valid };
    delete broken[field];
    expectCcrError(() => validateNativeEventShape(broken, null), 'JOURNAL_INVALID', `13–14 · ${field} absent`);
  }

  // 15 · un identifiant unique ne peut pas porter une provenance à deux slots.
  expectCcrError(
    () => validateNativeEventShape({ ...base, expert_slot_id: 'author' }, null),
    'JOURNAL_INVALID',
    '15 · slot unique sur un transfert',
  );
});

// ==========================================================================
// 16–18. Frontière de génération
// ==========================================================================

test('16–18 · aucun journal ne mélange les générations, et un refus n’écrit rien', async () => {
  const dir = await makeTempDir('ccr-1b-boundary-');
  try {
    const runsDir = path.join(dir, 'runs');

    // ---- run historique
    await materializeRun(runsDir, {
      runId: RUN_ID,
      events: [{ round: 0, actor: 'system', type: 'run_created', content: 'créé' }],
    });
    const legacyPaths = runPaths(runsDir, RUN_ID);
    const legacyStore = await openEventStore(legacyPaths, RUN_ID);
    const legacyBefore = await journalBytes(legacyPaths.events);
    const legacySequence = legacyStore.nextSequence();

    await expectCcrRejection(
      legacyStore.append({
        round: 1,
        actor: 'system',
        type: 'session_created',
        expert_slot_id: 'author',
      } as unknown as Parameters<typeof legacyStore.append>[0]),
      'JOURNAL_INVALID',
      '16 · événement natif sur un run historique',
    );
    assert.equal(await journalBytes(legacyPaths.events), legacyBefore, '18 · journal historique intact');
    assert.equal(legacyStore.nextSequence(), legacySequence, '18 · aucune séquence consommée');

    // ---- run natif
    const nativeRunId = 'CCR-20260808-002';
    await materializeNativeRun(runsDir, { runId: nativeRunId, bindings: { author: 'codex', challenger: 'claude' } });
    const nativePaths = runPaths(runsDir, nativeRunId);
    const manifest = nativeManifest('codex', 'claude');
    const nativeStore = await openNativeEventStore(nativePaths, manifest);

    await nativeStore.append({ round: 0, actor: 'system', type: 'run_created', content: 'créé' });
    const nativeBefore = await journalBytes(nativePaths.events);
    const nativeSequence = nativeStore.nextSequence();

    for (const legacyShaped of [
      { round: 1, actor: 'claude', type: 'assistant_response', session_id: 'x', expert_slot_id: 'author' },
      { round: 1, actor: 'system', type: 'prompt_sent', target: 'codex', target_expert_slot_id: 'author' },
    ]) {
      await expectCcrRejection(
        nativeStore.append(legacyShaped as unknown as NewNativeCcrEvent),
        'JOURNAL_INVALID',
        '17 · identité fournisseur sur un run natif',
      );
    }
    assert.equal(await journalBytes(nativePaths.events), nativeBefore, '18 · journal natif intact');
    assert.equal(nativeStore.nextSequence(), nativeSequence, '18 · aucune séquence consommée');

    // Symétrie de lecture. Un événement natif SANS slot — `run_created` — a
    // exactement la même forme qu'un événement historique : la frontière ne
    // porte pas sur la forme, elle porte sur l'identité. Dès qu'un tour
    // d'expert est journalisé, le lecteur historique le refuse.
    const beforeExpertTurn = await openEventStore(nativePaths, nativeRunId);
    assert.equal((await beforeExpertTurn.readAll()).length, 1, 'un événement sans slot reste lisible partout');

    await nativeStore.append({
      round: 1,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: 'author',
      session_id: nativeSessionId('author'),
      content: 'position',
    });
    await expectCcrRejection(
      openEventStore(nativePaths, nativeRunId).then(async (s) => s.readAll()),
      'JOURNAL_INVALID',
      'lecteur historique sur un tour d’expert natif',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('16bis · la session nommée par un événement doit être celle du slot', async () => {
  const dir = await makeTempDir('ccr-1b-context-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeNativeRun(runsDir, { runId: RUN_ID, bindings: { author: 'claude', challenger: 'claude' } });
    const paths = runPaths(runsDir, RUN_ID);
    const store = await openNativeEventStore(paths, nativeManifest('claude', 'claude'));

    await store.append({
      round: 1,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: 'author',
      session_id: nativeSessionId('author'),
      content: 'ok',
    });

    // La session du challenger sur le slot author : deux moteurs identiques ne
    // rendent pas les continuités interchangeables.
    await expectCcrRejection(
      store.append({
        round: 1,
        actor: 'expert',
        type: 'assistant_response',
        expert_slot_id: 'author',
        session_id: nativeSessionId('challenger'),
        content: 'ok',
      }),
      'JOURNAL_INVALID',
      'session croisée',
    );

    // `session_created` reste exempté : il documente l'acquisition elle-même.
    const created = await store.append({
      round: 1,
      actor: 'system',
      type: 'session_created',
      expert_slot_id: 'author',
      session_id: 'session-remplacante',
    });
    assert.equal(created.type, 'session_created');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// 19–27. Artefacts `rounds/`
// ==========================================================================

test('19 · 27 · un artefact de round historique reste lisible et n’est jamais réécrit', async () => {
  const dir = await makeTempDir('ccr-1b-round-v1-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);

    await writeRoundMetadata(paths, {
      schema_version: ROUND_SCHEMA_VERSION,
      run_id: RUN_ID,
      round: 1,
      started_at: FIXTURE_TIME,
      completed_at: FIXTURE_TIME,
      workspace_cwd: 'E:/prog/exemple',
      turns: [
        {
          agent: 'claude',
          prompt_event_id: 'evt_000001',
          response_event_id: 'evt_000002',
          started_at: FIXTURE_TIME,
          completed_at: FIXTURE_TIME,
        },
      ],
    });
    await writeRoundTurnArtifacts(paths, 1, 'claude', {
      prompt: 'p',
      response: 'r',
      stdoutRaw: 'o',
      stderrRaw: 'e',
    });

    const file = path.join(roundDir(paths, 1), 'metadata.json');
    const before = { bytes: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs };

    const legacy = await readRunRoundMetadata(paths, 'LEGACY_V2_EXECUTION', 1);
    assert.equal(legacy.execution_mode, 'LEGACY_V2_EXECUTION');
    assert.equal(legacy.metadata.schema_version, ROUND_SCHEMA_VERSION);

    const after = { bytes: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs };
    assert.deepEqual(after, before, '27 · aucune promotion en v2 par lecture');

    // Le lecteur natif refuse un artefact v1 : aucune requalification.
    await expectCcrRejection(
      readNativeRoundMetadata(paths, 1),
      'SCHEMA_VERSION_UNSUPPORTED',
      'lecteur natif sur artefact v1',
    );
    // Le nom de fichier historique n'est pas renommé.
    const names = await readdir(roundDir(paths, 1));
    assert.ok(names.includes('claude_prompt.txt'), 'le fichier historique garde son nom');
  } finally {
    await removeTempDir(dir);
  }
});

test('3–5 · un round natif représente un transfert, et le premier porte le numéro 1', async () => {
  const dir = await makeTempDir('ccr-1b-round-v2-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeNativeRun(runsDir, { runId: RUN_ID, bindings: { author: 'codex', challenger: 'claude' } });
    const paths = runPaths(runsDir, RUN_ID);

    let round = 0;
    for (const [source, target] of [
      ['author', 'challenger'],
      ['challenger', 'author'],
    ] as readonly (readonly [ExpertSlotId, ExpertSlotId])[]) {
      round += 1;
      const metadata: NativeRoundMetadata = {
        schema_version: NATIVE_ROUND_SCHEMA_VERSION,
        run_id: RUN_ID,
        round,
        source_slot: source,
        target_slot: target,
        source_event_id: 'evt_000002',
        response_event_id: 'evt_000005',
        started_at: FIXTURE_TIME,
        completed_at: FIXTURE_TIME,
        workspace_cwd: 'E:/prog/exemple',
        turns: [
          {
            expert_slot: target,
            prompt_event_id: 'evt_000004',
            response_event_id: 'evt_000005',
            started_at: FIXTURE_TIME,
            completed_at: FIXTURE_TIME,
            provider: 'claude',
            session_id: 'diagnostic-seulement',
          },
        ],
      };
      await writeNativeRoundMetadata(paths, metadata);
      const read = await readRunRoundMetadata(paths, 'NATIVE_V21_EXECUTION', round);
      assert.equal(read.execution_mode, 'NATIVE_V21_EXECUTION');
      const artifact = await readNativeRoundMetadata(paths, round);
      assert.equal(artifact.source_slot, source);
      assert.equal(artifact.target_slot, target);
      assert.equal(artifact.source_event_id, 'evt_000002');
      assert.equal(artifact.response_event_id, 'evt_000005');
    }

    // 5 · le premier vrai transfert occupe `rounds/001/`, sans qu'aucun numéro
    // n'ait été consommé par une initialisation.
    assert.equal(path.basename(roundDir(paths, 1)), '001');
    assert.equal((await readNativeRoundMetadata(paths, 1)).source_slot, 'author');
  } finally {
    await removeTempDir(dir);
  }
});

test('2 · aucun round v2 initial n’est représentable, et START n’en écrit aucun', () => {
  const transfer = {
    schema_version: NATIVE_ROUND_SCHEMA_VERSION,
    run_id: RUN_ID,
    round: 1,
    source_slot: 'author',
    target_slot: 'challenger',
    source_event_id: 'evt_000002',
    response_event_id: null,
    started_at: FIXTURE_TIME,
    completed_at: null,
    workspace_cwd: 'E:/prog/exemple',
    turns: [],
  };
  assert.equal(validateNativeRoundMetadata(transfer).source_slot, 'author');

  // Les deux marqueurs de l'ancienne forme initiale sont refusés nommément :
  // un appelant qui tenterait d'écrire un round de START apprend pourquoi c'est
  // impossible, plutôt que de produire un artefact que le lecteur ignorerait.
  for (const initialShaped of [
    { ...transfer, kind: 'initial_turn' },
    { ...transfer, kind: 'transfer_round' },
    { ...transfer, expert_slot: 'author' },
  ]) {
    expectCcrError(
      () => validateNativeRoundMetadata(initialShaped),
      'STATE_INVALID',
      'forme initiale ou discriminant résiduel',
    );
  }

  // Et un transfert reste un transfert : deux slots, distincts, avec sa source.
  expectCcrError(
    () => validateNativeRoundMetadata({ ...transfer, target_slot: 'author' }),
    'STATE_INVALID',
    'source et cible confondues',
  );
  for (const field of ['source_slot', 'target_slot', 'source_event_id']) {
    const broken: Record<string, unknown> = { ...transfer };
    delete broken[field];
    expectCcrError(() => validateNativeRoundMetadata(broken), 'STATE_INVALID', `${field} absent`);
  }
});

test('24–26 · les fichiers natifs sont nommés par slot, sans collision same-provider', async () => {
  // 26 · l'API ne permet pas de nommer un artefact par un fournisseur.
  for (const provider of PROVIDER_KINDS) {
    expectCcrError(
      () => nativeRoundArtifactNames(provider as unknown as ExpertSlotId),
      'INVALID_ARGUMENT',
      `nom de fichier « ${provider} »`,
    );
  }

  const dir = await makeTempDir('ccr-1b-names-');
  try {
    const runsDir = path.join(dir, 'runs');
    let ordinal = 0;
    for (const bindings of NATIVE_BINDING_PERMUTATIONS) {
      ordinal += 1;
      const runId = `CCR-20260808-00${ordinal}`;
      await materializeNativeRun(runsDir, { runId, bindings });
      const paths = runPaths(runsDir, runId);

      for (const slot of EXPERT_SLOT_IDS) {
        await writeNativeRoundTurnArtifacts(paths, 1, slot, {
          prompt: `prompt ${slot}`,
          response: `réponse ${slot}`,
          stdoutRaw: `out ${slot}`,
          stderrRaw: `err ${slot}`,
        });
      }

      const roundPath = roundDir(paths, 1);
      const files = (await readdir(roundPath)).sort();
      assert.deepEqual(
        files.filter((name) => name.endsWith('.txt')),
        ['author_prompt.txt', 'author_response.txt', 'challenger_prompt.txt', 'challenger_response.txt'],
        permutationLabel(bindings),
      );

      // Aucun écrasement : chaque slot a conservé son propre contenu, y compris
      // lorsque les deux emploient le même moteur.
      for (const slot of EXPERT_SLOT_IDS) {
        const names = nativeRoundArtifactNames(slot);
        assert.equal(await readFile(path.join(roundPath, names.prompt), 'utf8'), `prompt ${slot}`);
        assert.equal(await readFile(path.join(roundPath, names.stdout), 'utf8'), `out ${slot}`);
      }
      assert.equal(files.some((name) => name.startsWith('claude') || name.startsWith('codex')), false);
    }
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// 28–30. Structure
// ==========================================================================

const NATIVE_MODULES = [
  'core/expert.ts',
  'core/run-native.ts',
  'core/event-provenance.ts',
  'core/legacy-projection.ts',
  'store/native-store.ts',
  'store/native-event-store.ts',
  'store/native-round-store.ts',
  'store/native-run-snapshot.ts',
];

async function sourceFilesUnder(relative: string): Promise<string[]> {
  const root = path.join(SRC_ROOT, relative);
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Modules autorises a connaitre les formats natifs.
 *
 * Depuis le Slice 1C, le moteur START natif existe et importe legitimement les
 * modules natifs. La garantie qui demeure est plus precise, et plus utile : les
 * services **historiques** ne les connaissent pas, et `rounds/` natif n'est
 * connu de personne.
 */
/**
 * Seuls modules metier autorises a ecrire dans `rounds/`.
 *
 * L'artefact diagnostique n'appartient qu'au transfert : son execution (1F) le
 * produit, et sa reprise (1G) le reconstruit lorsque les faits canoniques le
 * permettent. START (1C), la reprise d'initialisation (1D) et le planificateur
 * (1E) n'y touchent pas — et c'est ce qui garantit qu'aucun d'eux n'ecrit de
 * round.
 *
 * L'envoi (2B) et sa reprise (2B-R) n'y touchent pas davantage : un `send` n'est
 * pas un transfert, et son abandon ne le devient pas.
 */
const ROUND_WRITER_FILES = [
  'services/native-step-service.ts',
  'services/native-step-recovery-service.ts',
];

const NATIVE_ENGINE_FILES = [
  'services/native-start-service.ts',
  'services/native-recovery-service.ts',
  'services/native-step-planner.ts',
  'services/native-step-service.ts',
  'services/native-step-recovery-service.ts',
  // La resolution de cible native (2A) est pure et sans ecriture, mais elle
  // connait le modele natif : c'est le meme moteur, pas un service historique.
  'services/native-target-resolver.ts',
  'services/native-send-service.ts',
  'services/native-send-recovery-service.ts',
  'services/native-handoff-service.ts',
  'services/native-handoff-recovery-service.ts',
  // La projection 2D lit le modele natif et n'ecrit rien : meme moteur.
  'services/native-read-model.ts',
  // V2.1-IMP-16 : le controle humain natif ecrit `state.json` et le journal,
  // mais jamais `rounds/` — suspendre ou reprendre n'est pas un transfert.
  'services/native-control-service.ts',
  // V2.1-IMP-17A : la couture de mutation valide la generation avant toute
  // precondition. Elle ne connait ni HTTP ni `rounds/`.
  'services/native-mutation-boundary.ts',
  // V2.1-IMP-17B : la lecture HTTP native charge un snapshot stable et delegue
  // toute regle a la projection 2D. Elle n'ecrit rien et ne touche pas
  // `rounds/` — la garde ci-dessous continue de l'exclure.
  'cockpit/native-read-http.ts',
  // V2.1-IMP-17C : les mutations HTTP connaissent la generation du run avant
  // d'interpreter une cible, et delèguent la resolution au resolveur de 2A.
  // Elles n'ecrivent aucun fait canonique elles-memes.
  'cockpit/mutations-http.ts',
  // La composition native des mutations : precondition de vue et capture de
  // revision, autour des moteurs geles.
  'services/native-mutations.ts',
  // V2.3-S1 : la projection de presentation compose au-dessus du snapshot natif
  // deja lu. Elle lit le modele natif, n'ecrit rien, et ne touche pas `rounds/`.
  'services/cockpit-presentation.ts',
  // V2.1-IMP-17D : la matrice `domaine × geste` et la composition de reprise.
  // Elles nomment les primitives geles ; elles n'en reimplementent aucune.
  'services/native-recovery-dispatch.ts',
  'services/native-recovery-mutations.ts',
  // Le preflight borne aux fournisseurs employes vit avec le preflight
  // historique, dont il reutilise les politiques : le dupliquer ailleurs
  // aurait cree le second moteur que ce slice interdit.
  'runtime/preflight-service.ts',
  // Slice 2E : la CLI devient une surface **à deux générations**. Elle n'est
  // plus un service historique, et doit connaitre le modele natif pour
  // determiner la generation d'un run avant d'interpreter ses arguments.
  // Elle n'ecrit toujours rien : la garde `rounds/` ci-dessous continue de
  // l'exclure.
  'cli/main.ts',
  'cli/native-dispatch.ts',
  'cli/native-format.ts',
  // V2.1-IMP-19 : la chronologie native projette les evenements canoniques.
  // Elle reutilise la classification de provenance gelee en 1B plutot que d'en
  // etablir une seconde, ne lit aucun fichier, et n'ouvre jamais `rounds/` —
  // la garde ci-dessous continue donc de l'exclure des ecrivains d'artefacts.
  'services/native-timeline-read-model.ts',
  // V3-S3 : la projection de controverse compose au-dessus du snapshot natif
  // deja lu, exactement comme la presentation V2.3. Ses deux imports natifs
  // sont des TYPES — `NativeRunSnapshot` est sa donnee d'entree, `NativeCcrEvent`
  // le fait canonique contre lequel un ancrage se resout. Elle n'ouvre aucun
  // fichier, n'ecrit rien, et ne touche pas `rounds/`.
  'services/controversy-read-model.ts',
  // V3-S4 : le service d'ecriture V3 est un moteur natif, pas un service
  // historique. Il etablit les faits canoniques sous la frontiere de mutation
  // gelee, lit la provenance d'expert pour la recopier dans ses ancrages, et
  // n'ecrit que `controversies.jsonl` — jamais `rounds/`, que la garde
  // ci-dessous continue de lui interdire.
  'services/controversy-service.ts',
  // V3-S7-B : le détecteur porte le dispatch gouverné d'une détection. Il est
  // un moteur natif, pas un service historique — il lit le snapshot natif sous
  // verrou court, engage une invocation, puis délègue toute persistance au
  // service V3. Il n'ecrit rien lui-meme, et ne touche pas `rounds/`.
  'services/controversy-detector.ts',
  // V4-S3 : la projection de l'Evidence Engine compose au-dessus du snapshot
  // natif deja lu, exactement comme la projection V3 et la presentation V2.3.
  // Ses deux imports natifs sont des TYPES — `NativeRunSnapshot` est sa donnee
  // d'entree, `NativeCcrEvent` le fait canonique contre lequel un materiau
  // RUN_EVENT et une citation se resolvent. Elle n'ouvre aucun fichier, n'ecrit
  // rien, ne relit jamais `evidence.jsonl`, et ne touche pas `rounds/`.
  'services/evidence-read-model.ts',
  // V4-S4 : le service d'ecriture V4 est un moteur natif, pas un service
  // historique. Il etablit les faits canoniques sous la frontiere de mutation
  // gelee, lit le snapshot natif pour resoudre un event de materiau et une
  // entree de controverse cible, et n'ecrit que `evidence.jsonl` — jamais
  // `rounds/`, que la garde ci-dessous continue de lui interdire.
  'services/evidence-service.ts',
  // V4-S5 : la couture de fraicheur est un moteur natif minimal, en lecture
  // seule. Elle existe pour que la CLI n'ait JAMAIS a lire le snapshot natif :
  // elle obtient un snapshot stable et rend son `evidence_revision`, tel quel.
  // Elle n'ecrit rien, ne projette rien, et ne touche pas `rounds/`.
  'services/evidence-freshness.ts',
  // V4-S7-B : le dispatch gouverne d'une adduction assistee est un moteur natif,
  // exactement comme le detecteur V3. Il lit le snapshot natif sous DEUX verrous
  // courts — l'un pour etablir le perimetre, l'ensemble soumis et l'engagement,
  // l'autre pour relire, revalider et ecrire le lot — et l'appel fournisseur
  // tient entre les deux, hors verrou. Il n'ecrit que `evidence.jsonl` et les
  // journaux de gouvernance, jamais `rounds/`. La section 1/3 du meme fichier,
  // le parseur, reste pure : elle ne nomme aucun de ces modules.
  'services/evidence-adducer.ts',
  // V5-S10 : le detecteur de structures de reconciliation est un moteur natif au
  // meme titre que le detecteur V3. Il calcule les detections `D01`-`D08` sur un
  // snapshot stable qu'on lui passe, n'ouvre aucun fichier, n'ecrit rien.
  // Dependance de TYPE seule — mais un import de type reste une dependance, et
  // se declare ici comme les autres.
  'services/reconciliation-detector.ts',
  // V5-S3 : la couture de fraicheur V5, exactement la figure de
  // `evidence-freshness.ts` une generation plus loin. Elle obtient un snapshot
  // stable et rend son `reconciliation_revision`, tel quel. Elle n'ecrit rien.
  'services/reconciliation-freshness.ts',
  // V5-S13 : le dispatch gouverne d'une proposition assistee, meme figure que
  // `evidence-adducer.ts`. Il lit le snapshot natif sous deux verrous courts,
  // l'appel fournisseur tenant entre les deux, hors verrou. Il nomme un slot
  // d'expert et un fournisseur, d'ou la dependance de type a `core/expert.ts`.
  // Il n'ecrit que `reconciliations.jsonl` et les journaux de gouvernance.
  'services/reconciliation-proposer.ts',
  // V5.1 : le constructeur de contexte canonique d'une proposition assistee.
  // Il consomme DELIBEREMENT `NativeRunSnapshot` pour composer le contexte
  // V3/V4 autorise par l'addendum du 2026-08-21 — enonce des unites soumises,
  // evenements qu'elles ancrent, adductions qui les visent, materiaux de ces
  // adductions. C'est le meme moteur natif que `reconciliation-proposer.ts`,
  // dont il est le collaborateur direct : ce n'est pas un service historique.
  // Fonction pure — il n'ouvre aucun fichier, n'ecrit rien, et ne touche pas
  // `rounds/`, que la garde ci-dessous continue de lui interdire.
  'services/reconciliation-proposal-context.ts',
  // V5-S12 : projection derivee sur le snapshot, exactement comme
  // `controversy-read-model.ts`. Elle n'ecrit rien et ne decide rien.
  // Dependance de TYPE seule.
  'services/reconciliation-read-model.ts',
  // V5-S4 : le perimetre `WHOLE` est borne par l'instantane lu sous verrou —
  // c'est le snapshot qui dit ce que « tout » designait a cet instant.
  // Dependance de TYPE seule.
  'services/reconciliation-scope.ts',
  // V5-S5 : le service d'ecriture V5, figure de `evidence-service.ts`. Il relit
  // l'etat autoritaire sous verrou avant d'appendre, et n'ecrit que
  // `reconciliations.jsonl` — jamais `rounds/`, que la garde ci-dessous
  // continue de lui interdire.
  'services/reconciliation-service.ts',
  // V5-S14 : la CLI V5 compose l'instantane qu'elle affiche, comme
  // `cli/native-dispatch.ts` deja inscrit. Elle ne decide rien : elle rend.
  'cli/reconciliation-dispatch.ts',
];

test('28 · aucun service historique ne connaît les formats natifs, et personne n’écrit `rounds/`', async () => {
  const businessFiles = (
    await Promise.all(['services', 'cockpit', 'cli', 'runtime', 'adapters'].map(sourceFilesUnder))
  ).flat();
  assert.ok(businessFiles.length > 10, 'le balayage a bien trouvé les modules métier');

  let engineSeen = 0;
  for (const file of businessFiles) {
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    const isNativeEngine = NATIVE_ENGINE_FILES.includes(relative);
    if (isNativeEngine) engineSeen += 1;
    const code = await readFile(file, 'utf8');

    for (const module of NATIVE_MODULES) {
      const basename = path.posix.basename(module);
      const imported = code.includes(`/${basename}'`) || code.includes(`/${basename}"`);

      // `rounds/` natif n'est connu que du transfert et de sa reprise.
      if (basename === 'native-round-store.ts') {
        assert.equal(
          imported,
          ROUND_WRITER_FILES.includes(relative),
          `${relative} : seuls le transfert et sa reprise touchent rounds/`,
        );
        continue;
      }
      if (isNativeEngine) continue;
      assert.equal(
        imported,
        false,
        `${relative} importe ${basename} — aucun service historique n'est migré`,
      );
    }
  }
  assert.equal(engineSeen, NATIVE_ENGINE_FILES.length, 'le moteur natif a bien été balayé');
});

test('29 · le journal ouvert découle du manifest, jamais d’un événement', async () => {
  const dir = await makeTempDir('ccr-1b-dispatch-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    await materializeNativeRun(runsDir, {
      runId: 'CCR-20260808-002',
      bindings: { author: 'codex', challenger: 'claude' },
    });

    const legacy = await openRunEventStore(
      runPaths(runsDir, RUN_ID),
      await readPersistedManifest(runPaths(runsDir, RUN_ID)),
    );
    assert.equal(legacy.execution_mode, 'LEGACY_V2_EXECUTION');

    const nativePaths = runPaths(runsDir, 'CCR-20260808-002');
    const native = await openRunEventStore(nativePaths, await readPersistedManifest(nativePaths));
    assert.equal(native.execution_mode, 'NATIVE_V21_EXECUTION');

    // Le round suit la même autorité : un run natif écrit du v2, et refuse
    // d'écrire un artefact historique.
    assert.equal(roundSchemaVersionFor('LEGACY_V2_EXECUTION'), ROUND_SCHEMA_VERSION);
    assert.equal(roundSchemaVersionFor('NATIVE_V21_EXECUTION'), NATIVE_ROUND_SCHEMA_VERSION);
    await expectCcrRejection(
      writeRunRoundMetadata(nativePaths, 'NATIVE_V21_EXECUTION', {
        schema_version: ROUND_SCHEMA_VERSION,
        run_id: 'CCR-20260808-002',
        round: 1,
        started_at: FIXTURE_TIME,
        completed_at: null,
        workspace_cwd: 'E:/prog/exemple',
        turns: [],
      }),
      'SCHEMA_VERSION_UNSUPPORTED',
      'artefact v1 sur un run natif',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('30 · aucune provenance native n’est déduite d’un fournisseur', async () => {
  const dir = await makeTempDir('ccr-1b-derivation-');
  try {
    const runsDir = path.join(dir, 'runs');
    let ordinal = 0;

    for (const bindings of NATIVE_BINDING_PERMUTATIONS) {
      ordinal += 1;
      const runId = `CCR-20260808-00${ordinal}`;
      await materializeNativeRun(runsDir, { runId, bindings });
      const paths = runPaths(runsDir, runId);
      const manifest = nativeFixtureManifest(runId, bindings);
      const store = await openNativeEventStore(paths, manifest);

      for (const slot of EXPERT_SLOT_IDS) {
        await store.append({
          round: 1,
          actor: 'expert',
          type: 'assistant_response',
          expert_slot_id: slot,
          session_id: nativeSessionId(slot),
          content: `réponse ${slot}`,
        });
      }

      const events = await store.readAll();
      assert.deepEqual(
        events.map((event) => (event as { expert_slot_id?: ExpertSlotId }).expert_slot_id),
        ['author', 'challenger'],
        `${permutationLabel(bindings)} : les slots sont ceux demandés`,
      );
      // Le moteur ne figure nulle part comme identité, dans aucun record.
      for (const event of events) {
        assert.equal('actor' in event && event.actor, 'expert');
        assert.equal('target' in event, false);
      }
      const raw = await readFile(paths.events, 'utf8');
      assert.equal(raw.includes('"actor":"claude"'), false);
      assert.equal(raw.includes('"actor":"codex"'), false);
    }
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// Réparation ciblée après le micro-gate 1B.1
// ==========================================================================

const NEUTRAL_RUN_CREATED = {
  event_id: 'evt_000001',
  run_id: RUN_ID,
  round: 0,
  timestamp: FIXTURE_TIME,
  actor: 'system',
  type: 'run_created',
  content: 'titre',
  details: { workspace_cwd: 'E:/prog/exemple' },
};

test('8–9 · un événement neutre a le même contrat de fil dans les deux générations', async () => {
  // 8 · accepté par les deux contrats.
  assert.equal(validateNativeEventShape(NEUTRAL_RUN_CREATED, null).type, 'run_created');
  provenance.assertNoNativeProvenance(NEUTRAL_RUN_CREATED);
  provenance.assertNoLegacyProvenance(NEUTRAL_RUN_CREATED);

  // 9 · sa forme ne permet pas de déduire la génération. Les deux stores
  // l'écrivent, et les deux lecteurs le relisent, à l'octet près.
  const dir = await makeTempDir('ccr-1b1-neutral-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    await materializeNativeRun(runsDir, {
      runId: 'CCR-20260808-002',
      bindings: { author: 'codex', challenger: 'claude' },
    });

    const legacyPaths = runPaths(runsDir, RUN_ID);
    const nativePaths = runPaths(runsDir, 'CCR-20260808-002');
    const draft = { round: 0, actor: 'system', type: 'run_created', content: 'titre' } as const;

    const legacyLine = await (await openEventStore(legacyPaths, RUN_ID)).append(draft);
    const nativeLine = await (
      await openNativeEventStore(nativePaths, nativeManifest('codex', 'claude'))
    ).append(draft);

    const { run_id: _l, ...legacyRest } = legacyLine;
    const { run_id: _n, ...nativeRest } = nativeLine;
    assert.deepEqual(
      { ...legacyRest, timestamp: '' },
      { ...nativeRest, timestamp: '' },
      'même record, aux seuls identifiants de run et horodatage près',
    );

    // Et chaque lecteur relit le journal de l'autre sans rien détecter.
    assert.equal((await (await openEventStore(nativePaths, 'CCR-20260808-002')).readAll()).length, 1);
    assert.equal(
      (await (await openNativeEventStore(legacyPaths, nativeManifest('codex', 'claude'))).readAll()).length,
      1,
    );

    // 20 · c'est précisément pour cela qu'un record neutre ne prouve jamais une
    // génération. Seul le manifest la détermine.
    assert.equal(provenance.GENERATION_IS_NEVER_PROVEN_BY_A_NEUTRAL_RECORD, true);
    assert.equal(
      (await readPersistedManifest(legacyPaths)).execution_mode,
      'LEGACY_V2_EXECUTION',
      'la génération vient du manifest, pas du journal',
    );
    assert.equal((await readPersistedManifest(nativePaths)).execution_mode, 'NATIVE_V21_EXECUTION');
  } finally {
    await removeTempDir(dir);
  }
});

test('10–13 · un événement neutre ne porte ni session, ni fournisseur, ni slot', () => {
  // 1 · la forme neutre est celle où le champ n'existe pas.
  assert.equal(validateNativeEventShape(NEUTRAL_RUN_CREATED, null).type, 'run_created');
  assert.equal('session_id' in NEUTRAL_RUN_CREATED, false);

  // 2–3 · le champ est refusé quelle que soit sa valeur. Absence et `null` ne
  // doivent pas devenir deux écritures de fil du même fait.
  for (const session of [null, 'native-author-1'] as const) {
    expectCcrError(
      () => validateNativeEventShape({ ...NEUTRAL_RUN_CREATED, session_id: session }, null),
      'JOURNAL_INVALID',
      `10 · session_id = ${String(session)} sans slot`,
    );
  }

  for (const provider of PROVIDER_KINDS) {
    // 11 · acteur fournisseur.
    expectCcrError(
      () => validateNativeEventShape({ ...NEUTRAL_RUN_CREATED, actor: provider }, null),
      'JOURNAL_INVALID',
      `11 · actor = ${provider}`,
    );
    // 12 · cible legacy.
    expectCcrError(
      () => validateNativeEventShape({ ...NEUTRAL_RUN_CREATED, target: provider }, null),
      'JOURNAL_INVALID',
      `12 · target = ${provider}`,
    );
  }

  // 13 · provenance d'expert sur un type qui n'en a pas.
  for (const field of ['expert_slot_id', 'target_expert_slot_id', 'source_slot_id', 'target_slot_id']) {
    expectCcrError(
      () => validateNativeEventShape({ ...NEUTRAL_RUN_CREATED, [field]: 'author' }, null),
      'JOURNAL_INVALID',
      `13 · ${field}`,
    );
  }
});

test('14–16 · `round_started` natif nomme l’expert visé', () => {
  const base = {
    event_id: 'evt_000004',
    run_id: RUN_ID,
    round: 1,
    timestamp: FIXTURE_TIME,
    actor: 'system',
    type: 'round_started',
    based_on: ['evt_000002'],
  };

  // 14 · forme native attendue.
  for (const slot of EXPERT_SLOT_IDS) {
    const parsed = validateNativeEventShape({ ...base, target_expert_slot_id: slot }, null);
    assert.equal((parsed as { target_expert_slot_id: ExpertSlotId }).target_expert_slot_id, slot);
  }
  assert.equal(provenance.provenanceShapeOf('round_started'), 'EXPERT_TARGET');

  // 15 · la forme sans slot n'est pas tolérée : V2 savait dire quel agent un
  // round concernait, V2.1 ne peut pas savoir moins.
  expectCcrError(() => validateNativeEventShape(base, null), 'JOURNAL_INVALID', '15 · sans slot cible');

  // 16 · et la cible fournisseur historique reste refusée.
  expectCcrError(
    () => validateNativeEventShape({ ...base, target: 'codex' }, null),
    'JOURNAL_INVALID',
    '16 · target fournisseur',
  );
});

test('`state_changed` reste neutre, conformément à l’inventaire des émetteurs V2', () => {
  // Inventaire statique : six émetteurs, tous dans `run-service.ts`. Cinq sont
  // globaux au run ; le sixième (`PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER`,
  // ligne 806) porte `target` — mais il décrit un transfert **avorté**, donc
  // deux slots, et non une cible unique. Aucun fait canonique hors `details` ne
  // permet de discriminer les deux sémantiques ; `details` est un champ
  // diagnostique libre et ne peut pas faire autorité de schéma.
  //
  // La classe neutre est donc fondée sur l'inventaire, et non généralisée.
  assert.equal(provenance.provenanceShapeOf('state_changed'), 'GENERATION_NEUTRAL');

  const stateChanged = { ...NEUTRAL_RUN_CREATED, type: 'state_changed' };
  assert.equal(validateNativeEventShape(stateChanged, null).type, 'state_changed');

  for (const field of ['target_expert_slot_id', 'source_slot_id']) {
    expectCcrError(
      () => validateNativeEventShape({ ...stateChanged, [field]: 'author' }, null),
      'JOURNAL_INVALID',
      `${field} sur un state_changed natif`,
    );
  }
  expectCcrError(
    () => validateNativeEventShape({ ...stateChanged, target: 'claude' }, null),
    'JOURNAL_INVALID',
    'target fournisseur sur un state_changed natif',
  );
});

test('taxonomie · un transfert refuse porte deux slots et aucune reponse', async () => {
  const base = {
    event_id: 'evt_000004',
    run_id: RUN_ID,
    round: 0,
    timestamp: FIXTURE_TIME,
    actor: 'system',
    type: 'transfer_blocked',
    source_slot_id: 'author',
    target_slot_id: 'challenger',
    source_event_id: 'evt_000003',
    reason: 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
    details: { payload_bytes: 900_000, limit_bytes: 524_288 },
  };

  const parsed = validateNativeEventShape(base, null);
  assert.equal(parsed.type, 'transfer_blocked');
  assert.equal(provenance.provenanceShapeOf('transfer_blocked'), 'TRANSFER_BLOCKED');

  // Aucune reponse n'a existe : le champ est interdit, pas facultatif.
  expectCcrError(
    () => validateNativeEventShape({ ...base, response_event_id: 'evt_000005' }, null),
    'JOURNAL_INVALID',
    'response_event_id sur un transfert refuse',
  );
  expectCcrError(
    () => validateNativeEventShape({ ...base, target_slot_id: 'author' }, null),
    'JOURNAL_INVALID',
    'source et cible confondues',
  );
  for (const field of ['source_slot_id', 'target_slot_id', 'source_event_id', 'reason']) {
    const broken: Record<string, unknown> = { ...base };
    delete broken[field];
    expectCcrError(() => validateNativeEventShape(broken, null), 'JOURNAL_INVALID', `${field} absent`);
  }
  expectCcrError(
    () => validateNativeEventShape({ ...base, reason: 'PARCE_QUE' }, null),
    'JOURNAL_INVALID',
    'motif hors union',
  );

  // Type propre a la generation native : un journal historique le refuse dans
  // les deux sens.
  const dir = await makeTempDir('ccr-1b-blocked-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);
    const legacy = await openEventStore(paths, RUN_ID);
    const before = await journalBytes(paths.events);

    await expectCcrRejection(
      legacy.append({ round: 0, actor: 'system', type: 'transfer_blocked' } as unknown as Parameters<
        typeof legacy.append
      >[0]),
      'JOURNAL_INVALID',
      'type natif dans un journal historique',
    );
    assert.equal(await journalBytes(paths.events), before, 'journal intact');
  } finally {
    await removeTempDir(dir);
  }
});

test('taxonomie · une source quarantainée est distincte d’un transfert refusé', () => {
  const base = {
    event_id: 'evt_000004',
    run_id: RUN_ID,
    round: 1,
    timestamp: FIXTURE_TIME,
    actor: 'human',
    type: 'transfer_uncertainty_acknowledged',
    source_slot_id: 'author',
    target_slot_id: 'challenger',
    source_event_id: 'evt_000003',
    reason: 'IN_FLIGHT_UNCERTAIN',
    content: 'verifie',
  };

  assert.equal(validateNativeEventShape(base, null).type, 'transfer_uncertainty_acknowledged');
  assert.equal(
    provenance.provenanceShapeOf('transfer_uncertainty_acknowledged'),
    'TRANSFER_QUARANTINED',
  );

  // CCR ne sait pas si une reponse exploitable existe : le champ est interdit.
  expectCcrError(
    () => validateNativeEventShape({ ...base, response_event_id: 'evt_000005' }, null),
    'JOURNAL_INVALID',
    'response_event_id sur une quarantaine',
  );

  // Les deux motifs ne sont pas interchangeables : les semantiques different.
  expectCcrError(
    () => validateNativeEventShape({ ...base, reason: 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER' }, null),
    'JOURNAL_INVALID',
    'motif de refus sur une quarantaine',
  );
  expectCcrError(
    () =>
      validateNativeEventShape(
        { ...base, type: 'transfer_blocked', reason: 'IN_FLIGHT_UNCERTAIN' },
        null,
      ),
    'JOURNAL_INVALID',
    'motif de quarantaine sur un refus',
  );
  expectCcrError(
    () => validateNativeEventShape({ ...base, target_slot_id: 'author' }, null),
    'JOURNAL_INVALID',
    'source et cible confondues',
  );
});

test('taxonomie · les deux clôtures d’envoi nomment un slot et un message, jamais une réponse', async () => {
  const base = {
    event_id: 'evt_000005',
    run_id: RUN_ID,
    round: 0,
    timestamp: FIXTURE_TIME,
    actor: 'system',
    type: 'send_aborted_before_provider',
    target_expert_slot_id: 'challenger',
    prompt_event_id: 'evt_000004',
    reason: 'PRE_PROVIDER_ABORTED',
  };
  const acknowledged = {
    ...base,
    event_id: 'evt_000006',
    actor: 'human',
    type: 'send_uncertainty_acknowledged',
    reason: 'IN_FLIGHT_UNCERTAIN',
    content: 'issue inconnue, acquittee',
  };

  assert.equal(validateNativeEventShape(base, null).type, 'send_aborted_before_provider');
  assert.equal(validateNativeEventShape(acknowledged, null).type, 'send_uncertainty_acknowledged');
  for (const type of ['send_aborted_before_provider', 'send_uncertainty_acknowledged'] as const) {
    assert.equal(provenance.provenanceShapeOf(type), 'SEND_RESOLUTION');
  }

  // Les deux motifs ne sont pas interchangeables : « certainement pas appele »
  // et « peut-etre appele » sont deux affirmations differentes.
  expectCcrError(
    () => validateNativeEventShape({ ...base, reason: 'IN_FLIGHT_UNCERTAIN' }, null),
    'JOURNAL_INVALID',
    'motif d’incertitude sur un abandon avant appel',
  );
  expectCcrError(
    () => validateNativeEventShape({ ...acknowledged, reason: 'PRE_PROVIDER_ABORTED' }, null),
    'JOURNAL_INVALID',
    'motif d’abandon sur un acquittement',
  );

  // Aucune reponse n'est connue, dans aucun des deux cas.
  expectCcrError(
    () => validateNativeEventShape({ ...base, response_event_id: 'evt_000007' }, null),
    'JOURNAL_INVALID',
    'response_event_id sur une cloture d’envoi',
  );
  // Aucune session n'est nommee : la cloture ne pretend pas en avoir atteint une.
  expectCcrError(
    () => validateNativeEventShape({ ...base, session_id: 'claude-1' }, null),
    'JOURNAL_INVALID',
    'session_id sur une cloture d’envoi',
  );
  // Un envoi n'a ni source ni passage de temoin.
  expectCcrError(
    () => validateNativeEventShape({ ...base, source_slot_id: 'author' }, null),
    'JOURNAL_INVALID',
    'source_slot_id sur une cloture d’envoi',
  );
  for (const field of ['target_expert_slot_id', 'prompt_event_id', 'reason']) {
    const broken: Record<string, unknown> = { ...base };
    delete broken[field];
    expectCcrError(() => validateNativeEventShape(broken, null), 'JOURNAL_INVALID', `${field} absent`);
  }

  // Types propres a la generation native : un journal historique les refuse.
  const dir = await makeTempDir('ccr-2br-taxo-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);
    const legacy = await openEventStore(paths, RUN_ID);
    const before = await journalBytes(paths.events);

    for (const type of ['send_aborted_before_provider', 'send_uncertainty_acknowledged'] as const) {
      await expectCcrRejection(
        legacy.append({ round: 0, actor: 'system', type } as unknown as Parameters<typeof legacy.append>[0]),
        'JOURNAL_INVALID',
        `${type} dans un journal historique`,
      );
    }
    assert.equal(await journalBytes(paths.events), before, 'journal intact');
  } finally {
    await removeTempDir(dir);
  }
});

test('taxonomie · les deux clôtures de handoff nomment une ouverture, jamais une session', async () => {
  const base = {
    event_id: 'evt_000007',
    run_id: RUN_ID,
    round: 0,
    timestamp: FIXTURE_TIME,
    actor: 'system',
    type: 'handoff_aborted_before_interactive',
    target_expert_slot_id: 'challenger',
    started_event_id: 'evt_000006',
    reason: 'PRE_INTERACTIVE_ABORTED',
  };
  const acknowledged = {
    ...base,
    event_id: 'evt_000008',
    actor: 'human',
    type: 'handoff_uncertainty_acknowledged',
    reason: 'IN_FLIGHT_UNCERTAIN',
    content: 'etendue inconnue',
  };

  assert.equal(validateNativeEventShape(base, null).type, 'handoff_aborted_before_interactive');
  assert.equal(validateNativeEventShape(acknowledged, null).type, 'handoff_uncertainty_acknowledged');
  for (const type of ['handoff_aborted_before_interactive', 'handoff_uncertainty_acknowledged'] as const) {
    assert.equal(provenance.provenanceShapeOf(type), 'HANDOFF_RESOLUTION');
  }

  // « certainement pas lance » et « peut-etre lance » sont deux affirmations
  // differentes : leurs motifs ne migrent pas.
  expectCcrError(
    () => validateNativeEventShape({ ...base, reason: 'IN_FLIGHT_UNCERTAIN' }, null),
    'JOURNAL_INVALID',
    'motif d’incertitude sur un abandon avant lancement',
  );
  expectCcrError(
    () => validateNativeEventShape({ ...acknowledged, reason: 'PRE_INTERACTIVE_ABORTED' }, null),
    'JOURNAL_INVALID',
    'motif d’abandon sur un acquittement',
  );

  // Un handoff ne produit aucune reponse, et n'atteint aucune session prouvee.
  expectCcrError(
    () => validateNativeEventShape({ ...base, response_event_id: 'evt_000009' }, null),
    'JOURNAL_INVALID',
    'response_event_id sur une cloture de handoff',
  );
  expectCcrError(
    () => validateNativeEventShape({ ...base, session_id: 'claude-1' }, null),
    'JOURNAL_INVALID',
    'session_id sur une cloture de handoff',
  );
  // Ni source, ni passage de temoin.
  expectCcrError(
    () => validateNativeEventShape({ ...base, source_slot_id: 'author' }, null),
    'JOURNAL_INVALID',
    'source_slot_id sur une cloture de handoff',
  );
  // Une cloture d'envoi et une cloture de handoff ne nomment pas le meme fait.
  expectCcrError(
    () => validateNativeEventShape({ ...base, prompt_event_id: 'evt_000005' }, null),
    'JOURNAL_INVALID',
    'started_event_id absent, prompt_event_id a la place',
  );
  for (const field of ['target_expert_slot_id', 'started_event_id', 'reason']) {
    const broken: Record<string, unknown> = { ...base };
    delete broken[field];
    expectCcrError(() => validateNativeEventShape(broken, null), 'JOURNAL_INVALID', `${field} absent`);
  }

  // Types propres a la generation native : un journal historique les refuse.
  const dir = await makeTempDir('ccr-2cr-taxo-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);
    const legacy = await openEventStore(paths, RUN_ID);
    const before = await journalBytes(paths.events);

    for (const type of ['handoff_aborted_before_interactive', 'handoff_uncertainty_acknowledged'] as const) {
      await expectCcrRejection(
        legacy.append({ round: 0, actor: 'system', type } as unknown as Parameters<typeof legacy.append>[0]),
        'JOURNAL_INVALID',
        `${type} dans un journal historique`,
      );
    }
    assert.equal(await journalBytes(paths.events), before, 'journal intact');
  } finally {
    await removeTempDir(dir);
  }
});

test('taxonomie · un transfert abandonné avant appel est distinct d’un transfert refusé', async () => {
  const base = {
    event_id: 'evt_000009',
    run_id: RUN_ID,
    round: 1,
    timestamp: FIXTURE_TIME,
    actor: 'system',
    type: 'transfer_aborted_before_provider',
    source_slot_id: 'author',
    target_slot_id: 'challenger',
    source_event_id: 'evt_000003',
    reason: 'PRE_PROVIDER_ABORTED',
    based_on: ['evt_000008'],
  };

  assert.equal(validateNativeEventShape(base, null).type, 'transfer_aborted_before_provider');
  assert.equal(provenance.provenanceShapeOf('transfer_aborted_before_provider'), 'TRANSFER_ABORTED');

  // Trois issues sans reponse, trois vocabulaires : aucun motif ne migre.
  expectCcrError(
    () => validateNativeEventShape({ ...base, reason: 'IN_FLIGHT_UNCERTAIN' }, null),
    'JOURNAL_INVALID',
    'motif de quarantaine sur un abandon',
  );
  expectCcrError(
    () => validateNativeEventShape({ ...base, reason: 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER' }, null),
    'JOURNAL_INVALID',
    'motif de refus sur un abandon',
  );
  expectCcrError(
    () =>
      validateNativeEventShape(
        { ...base, type: 'transfer_blocked', reason: 'PRE_PROVIDER_ABORTED' },
        null,
      ),
    'JOURNAL_INVALID',
    'motif d’abandon sur un refus',
  );

  // Rien n'a repondu : le champ est interdit, pas facultatif.
  expectCcrError(
    () => validateNativeEventShape({ ...base, response_event_id: 'evt_000010' }, null),
    'JOURNAL_INVALID',
    'response_event_id sur un abandon',
  );
  expectCcrError(
    () => validateNativeEventShape({ ...base, target_slot_id: 'author' }, null),
    'JOURNAL_INVALID',
    'source et cible confondues',
  );
  for (const field of ['source_slot_id', 'target_slot_id', 'source_event_id', 'reason']) {
    const broken: Record<string, unknown> = { ...base };
    delete broken[field];
    expectCcrError(() => validateNativeEventShape(broken, null), 'JOURNAL_INVALID', `${field} absent`);
  }

  // Type propre a la generation native : un journal historique le refuse.
  const dir = await makeTempDir('ccr-1g2-taxo-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);
    const legacy = await openEventStore(paths, RUN_ID);
    const before = await journalBytes(paths.events);
    await expectCcrRejection(
      legacy.append({ round: 1, actor: 'system', type: 'transfer_aborted_before_provider' } as unknown as Parameters<
        typeof legacy.append
      >[0]),
      'JOURNAL_INVALID',
      'type natif dans un journal historique',
    );
    assert.equal(await journalBytes(paths.events), before, 'journal intact');
  } finally {
    await removeTempDir(dir);
  }
});

