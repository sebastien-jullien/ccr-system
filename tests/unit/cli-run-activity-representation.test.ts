/**
 * F2 — deux représentations machine, et une frontière qui ne bouge pas.
 *
 * Question de preuve :
 *
 * > **Un consommateur de la représentation 1 reçoit-il exactement le document
 * > qu'il lisait en v1.1.0, y compris sur un run porteur de faits P3 — et la
 * > représentation 2 n'ajoute-t-elle rien d'autre que `production_intent`, au
 * > seul endroit où il a un sens ?**
 *
 * Quatre propriétés.
 *
 *  1. **Aucune montée implicite.** Sélecteur absent et sélecteur explicite 1
 *     rendent le même document, octet pour octet.
 *  2. **Additif et borné.** La représentation 2 n'ajoute qu'un champ, et ses
 *     deux axes de version montent ensemble à 2.
 *  3. **Dérivation normative.** Le dernier fait applicable décide, et son
 *     absence vaut `STEPS_INTENDED`.
 *  4. **Omission structurelle.** Hors `AVAILABLE`, le champ est absent — jamais
 *     nul, jamais deviné.
 *
 * F1 est vérifié inchangé dans le même mouvement : un run porteur de faits P3
 * ne fait apparaître aucun champ dans son descripteur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../../src/core/run-native.ts';
import type { NativeRunManifest, NativeRunStateDocument } from '../../src/core/run-native.ts';
import {
  endNativeProduction,
  reactivateNativeProduction,
} from '../../src/services/native-production-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { writeNativeManifest, writeNativeState } from '../../src/store/native-store.ts';
import { serializeRunActivity } from '../../src/cli/run-activity-machine.ts';
import { runCli } from '../../src/cli/main.ts';
import type { CliIo } from '../../src/cli/main.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260907-002';
const AT = '2026-09-07T00:00:00.000Z';
const SESSIONS = { author: 'codex-1', challenger: 'claude-1' } as const;

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(runsDir: string, argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const deps = { runsDir, now: () => new Date(AT) } as RunServiceDeps;
  const code = await runCli([...argv, '--runs-dir', runsDir], { io, deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function manifestOf(): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Contre-expertise',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: 'codex', session_id: SESSIONS.author },
      challenger: { provider: 'claude', session_id: SESSIONS.challenger },
    },
  };
}

function stateOf(): NativeRunStateDocument {
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
  };
}

/** Run natif dont la projection F2 est disponible. */
async function availableRun(dir: string): Promise<string> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  const manifest = manifestOf();
  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, stateOf());

  const events = await openNativeEventStore(paths, manifest);
  await events.append({ round: 0, actor: 'human', type: 'run_created', timestamp: AT });
  for (const slot of ['author', 'challenger'] as const) {
    const prompt = await events.append({
      round: 0,
      actor: 'human',
      type: 'prompt_sent',
      target_expert_slot_id: slot,
      content: 'mission',
      timestamp: AT,
    });
    await events.append({
      round: 0,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: slot,
      session_id: SESSIONS[slot],
      content: `position de ${slot}`,
      exit_code: 0,
      based_on: [prompt.event_id],
      timestamp: AT,
    });
    await events.append({
      round: 0,
      actor: 'system',
      type: 'session_created',
      expert_slot_id: slot,
      session_id: SESSIONS[slot],
      timestamp: AT,
    });
  }
  return runsDir;
}

/** Run natif dont l_histoire F2 requise ne peut pas etre etablie. */
async function unavailableRun(dir: string): Promise<string> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  const manifest = manifestOf();
  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, stateOf());
  // Aucun `run_created` : la base autoritative de creation manque.
  const events = await openNativeEventStore(paths, manifest);
  await events.append({
    round: 0,
    actor: 'human',
    type: 'prompt_sent',
    target_expert_slot_id: 'author',
    content: 'mission',
    timestamp: AT,
  });
  return runsDir;
}

function deps(runsDir: string) {
  return { runsDir, now: () => new Date(AT) };
}

// --------------------------------------------------------------------------
// 1 · Aucune montee implicite
// --------------------------------------------------------------------------

test('F2-R1 · selecteur absent et selecteur explicite 1 rendent le meme document', async (t) => {
  const dir = await makeTempDir('ccr-f2-rep1-');
  t.after(() => removeTempDir(dir));
  const runsDir = await availableRun(dir);

  const implicit = await cli(runsDir, ['run-activity', RUN_ID, '--format', 'json']);
  const explicit = await cli(runsDir, [
    'run-activity', RUN_ID, '--format', 'json', '--machine-representation-version', '1',
  ]);

  assert.equal(implicit.code, 0);
  assert.equal(explicit.code, 0);
  assert.equal(implicit.out, explicit.out, 'octet pour octet');

  const document = JSON.parse(implicit.out) as Record<string, unknown>;
  assert.deepEqual(Object.keys(document).sort(), [
    'activities',
    'durable_run_activity_contract_version',
    'durable_run_activity_machine_representation_version',
    'projection_status',
    'run_id',
  ]);
  assert.equal(document['durable_run_activity_contract_version'], 1);
  assert.equal(document['durable_run_activity_machine_representation_version'], 1);
  assert.equal(document['projection_status'], 'AVAILABLE');
});

test('F2-R2 · un journal porteur de faits P3 ne change rien a la representation 1', async (t) => {
  const dir = await makeTempDir('ccr-f2-rep1-p3-');
  t.after(() => removeTempDir(dir));
  const runsDir = await availableRun(dir);

  const before = await cli(runsDir, ['run-activity', RUN_ID, '--format', 'json']);

  await endNativeProduction(deps(runsDir), RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  await reactivateNativeProduction(deps(runsDir), RUN_ID, { note: 'reprise' });
  await endNativeProduction(deps(runsDir), RUN_ID, { note: 'de nouveau' });

  const after = await cli(runsDir, ['run-activity', RUN_ID, '--format', 'json']);

  assert.equal(after.code, 0);
  assert.equal(after.out, before.out, 'representation 1 jamais enrichie en silence');
  const document = JSON.parse(after.out) as Record<string, unknown>;
  assert.ok(!('production_intent' in document), 'aucun champ P3 en representation 1');
});

// --------------------------------------------------------------------------
// 2 · Representation 2 : un champ, et un seul
// --------------------------------------------------------------------------

test('F2-R3 · la representation 2 ajoute production_intent, et rien d_autre', async (t) => {
  const dir = await makeTempDir('ccr-f2-rep2-');
  t.after(() => removeTempDir(dir));
  const runsDir = await availableRun(dir);

  const rep1 = JSON.parse(
    (await cli(runsDir, ['run-activity', RUN_ID, '--format', 'json'])).out,
  ) as Record<string, unknown>;
  const result = await cli(runsDir, [
    'run-activity', RUN_ID, '--format', 'json', '--machine-representation-version', '2',
  ]);
  assert.equal(result.code, 0);
  const rep2 = JSON.parse(result.out) as Record<string, unknown>;

  assert.deepEqual(Object.keys(rep2).sort(), [
    'activities',
    'durable_run_activity_contract_version',
    'durable_run_activity_machine_representation_version',
    'production_intent',
    'projection_status',
    'run_id',
  ]);
  assert.equal(rep2['durable_run_activity_contract_version'], 2);
  assert.equal(rep2['durable_run_activity_machine_representation_version'], 2);
  assert.equal(rep2['run_id'], rep1['run_id']);
  assert.equal(rep2['projection_status'], rep1['projection_status']);
  assert.deepEqual(rep2['activities'], rep1['activities'], 'les activites sont identiques');
  assert.equal(rep2['production_intent'], 'STEPS_INTENDED');
});

test('F2-R4 · derivation normative : le dernier fait applicable decide', async (t) => {
  const dir = await makeTempDir('ccr-f2-derivation-');
  t.after(() => removeTempDir(dir));
  const runsDir = await availableRun(dir);

  const read = async (): Promise<string> => {
    const result = await cli(runsDir, [
      'run-activity', RUN_ID, '--format', 'json', '--machine-representation-version', '2',
    ]);
    assert.equal(result.code, 0);
    return (JSON.parse(result.out) as { production_intent: string }).production_intent;
  };

  assert.equal(await read(), 'STEPS_INTENDED', 'aucun fait applicable');

  await endNativeProduction(deps(runsDir), RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  assert.equal(await read(), 'NO_STEPS_INTENDED', 'dernier fait : fin de production');

  await reactivateNativeProduction(deps(runsDir), RUN_ID);
  assert.equal(await read(), 'STEPS_INTENDED', 'dernier fait : reactivation');

  await endNativeProduction(deps(runsDir), RUN_ID, { note: 'de nouveau' });
  assert.equal(await read(), 'NO_STEPS_INTENDED', 'le dernier fait decide, pas le premier');
});

test('F2-R5 · hors AVAILABLE, production_intent est absent des deux representations', async (t) => {
  const dir = await makeTempDir('ccr-f2-unavailable-');
  t.after(() => removeTempDir(dir));
  const runsDir = await unavailableRun(dir);

  // Un fait P3 existe pourtant : l_absence n_est pas « pas de declaration »,
  // c_est « CCR ne reconstruit pas cette histoire ».
  await endNativeProduction(deps(runsDir), RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });

  for (const argv of [
    ['run-activity', RUN_ID, '--format', 'json'],
    ['run-activity', RUN_ID, '--format', 'json', '--machine-representation-version', '2'],
  ]) {
    const result = await cli(runsDir, argv);
    assert.equal(result.code, 0, 'les trois statuts restent des succes de commande');
    const document = JSON.parse(result.out) as Record<string, unknown>;
    assert.equal(document['projection_status'], 'UNAVAILABLE');
    assert.ok(!('production_intent' in document), 'cle omise, jamais nulle');
    assert.ok(!('activities' in document), 'cle omise, jamais vide');
  }
});

test('F2-R5b · PROJECTION_FAILURE omet lui aussi production_intent', () => {
  // Eprouve sur le serialiseur, seul responsable de la frontiere publique :
  // les deux statuts non disponibles empruntent la meme branche, et le type
  // rend le champ inatteignable hors de la variante disponible.
  for (const status of ['UNAVAILABLE', 'PROJECTION_FAILURE'] as const) {
    for (const representation of [1, 2] as const) {
      const document = JSON.parse(
        serializeRunActivity({ run_id: RUN_ID, projection_status: status }, representation),
      ) as Record<string, unknown>;
      assert.deepEqual(Object.keys(document).sort(), [
        'durable_run_activity_contract_version',
        'durable_run_activity_machine_representation_version',
        'projection_status',
        'run_id',
      ]);
      assert.equal(document['projection_status'], status);
    }
  }
});

// --------------------------------------------------------------------------
// 3 · Selecteur : refus avant toute lecture
// --------------------------------------------------------------------------

test('F2-R6 · une representation non supportee sort en 2, sans aucun document', async (t) => {
  const dir = await makeTempDir('ccr-f2-unsupported-');
  t.after(() => removeTempDir(dir));
  const runsDir = await availableRun(dir);

  for (const value of ['3', '0', '2.0', 'deux', '-1']) {
    const result = await cli(runsDir, [
      'run-activity', RUN_ID, '--format', 'json', '--machine-representation-version', value,
    ]);
    assert.equal(result.code, 2, `« ${value} » refuse`);
    assert.equal(result.out, '', 'aucune charge utile JSON sur stdout');
  }

  // Et le format reste une dimension distincte : son refus est inchange.
  const badFormat = await cli(runsDir, [
    'run-activity', RUN_ID, '--format', 'yaml', '--machine-representation-version', '2',
  ]);
  assert.equal(badFormat.code, 2);
  assert.equal(badFormat.out, '');
});

// --------------------------------------------------------------------------
// 4 · F1 inchange
// --------------------------------------------------------------------------

test('F1-R1 · le descripteur de run ne porte aucun champ P3', async (t) => {
  const dir = await makeTempDir('ccr-f1-');
  t.after(() => removeTempDir(dir));
  const runsDir = await availableRun(dir);

  const before = await cli(runsDir, ['run-descriptors', '--format', 'json']);
  await endNativeProduction(deps(runsDir), RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  const after = await cli(runsDir, ['run-descriptors', '--format', 'json']);

  assert.equal(after.code, 0);
  assert.equal(after.out, before.out, 'F1 byte-identique avant et apres un fait P3');

  const document = JSON.parse(after.out) as Record<string, unknown>;
  assert.deepEqual(Object.keys(document).sort(), [
    'runs',
    'semantic_run_discovery_contract_version',
    'semantic_run_discovery_machine_representation_version',
  ]);
  assert.equal(document['semantic_run_discovery_contract_version'], 1);
  assert.equal(document['semantic_run_discovery_machine_representation_version'], 1);
  const runs = document['runs'] as readonly Record<string, unknown>[];
  assert.equal(runs.length, 1);
  assert.deepEqual(Object.keys(runs[0] ?? {}).sort(), ['run_id', 'title']);
});
