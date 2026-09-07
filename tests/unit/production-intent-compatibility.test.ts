/**
 * P3 — compatibilité, mesurée contre le binaire v1.1.0 réel.
 *
 * Question de preuve :
 *
 * > **Un binaire CCR antérieur peut-il, devant une invocation ou un journal
 * > qu'il ne connaît pas, rendre discrètement quelque chose de faux ?**
 *
 * La réponse est établie en exécutant la version publiée, extraite du commit
 * canonique par `git archive` — une opération strictement en lecture, qui ne
 * touche ni l'index, ni le worktree, ni aucun worktree git secondaire.
 *
 * ```text
 * COMPATIBILITÉ DE SYNTAXE D'INVOCATION   ≠   COMPATIBILITÉ DE DONNÉES
 * ```
 *
 * Les deux dimensions sont mesurées séparément, parce qu'elles ne se déduisent
 * pas l'une de l'autre.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../../src/core/run-native.ts';
import type { NativeRunManifest, NativeRunStateDocument } from '../../src/core/run-native.ts';
import { endNativeProduction } from '../../src/services/native-production-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { writeNativeManifest, writeNativeState } from '../../src/store/native-store.ts';
import { runCli } from '../../src/cli/main.ts';
import type { CliIo } from '../../src/cli/main.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const run = promisify(execFile);

/** Version publiée dont la compatibilité est mesurée. */
const RELEASED_COMMIT = 'c9de52b223ee13e79863e9747f08e88938d59579';

const RUN_ID = 'CCR-20260907-004';
const AT = '2026-09-07T00:00:00.000Z';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Executed {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Exécute le binaire publié, extrait du commit canonique.
 *
 * `git archive` écrit hors du dépôt : aucun `checkout`, aucun `reset`, aucun
 * `stash`, aucune mutation de worktree git.
 */
async function releasedBinary(dir: string): Promise<string> {
  const tree = path.join(dir, 'v110');
  await mkdir(tree, { recursive: true });
  // `--output` est absolu : `-C REPO` deplace le repertoire courant de git, et
  // un nom relatif ecrirait l_archive DANS le depot.
  await run('git', [
    '-C', REPO, 'archive', '--format=tar',
    `--output=${path.join(dir, 'v110.tar')}`, RELEASED_COMMIT,
  ]);
  // Noms relatifs pour tar, et depuis `dir` : un chemin Windows absolu porte un
  // deux-points, que GNU tar lirait comme un hote distant.
  await run('tar', ['-xf', 'v110.tar', '-C', 'v110'], { cwd: dir });
  return path.join(tree, 'bin', 'ccr.mjs');
}

async function execute(binary: string, argv: readonly string[]): Promise<Executed> {
  try {
    const { stdout, stderr } = await run(process.execPath, [binary, ...argv]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function manifestOf(): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Compatibilite',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: 'codex', session_id: 'codex-1' },
      challenger: { provider: 'claude', session_id: 'claude-1' },
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

/** Run natif dont la projection F2 est disponible, sans aucun fait P3. */
async function nativeRun(dir: string): Promise<string> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  const manifest = manifestOf();
  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, stateOf());

  const events = await openNativeEventStore(paths, manifest);
  await events.append({ round: 0, actor: 'human', type: 'run_created', timestamp: AT });
  for (const slot of ['author', 'challenger'] as const) {
    const session = slot === 'author' ? 'codex-1' : 'claude-1';
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
      session_id: session,
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
      session_id: session,
      timestamp: AT,
    });
  }
  return runsDir;
}

async function currentCli(runsDir: string, argv: readonly string[]): Promise<Executed> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const deps = { runsDir, now: () => new Date(AT) } as RunServiceDeps;
  const code = await runCli([...argv, '--runs-dir', runsDir], { io, deps });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

// --------------------------------------------------------------------------
// 1 · Syntaxe d_invocation
// --------------------------------------------------------------------------

test('C1 · nouveau selecteur + binaire v1.1.0 : option inconnue, sortie 2, aucun document', async (t) => {
  const dir = await makeTempDir('ccr-compat-selector-');
  t.after(() => removeTempDir(dir));
  const runsDir = await nativeRun(dir);
  const binary = await releasedBinary(dir);

  const observed = await execute(binary, [
    'run-activity', RUN_ID, '--format', 'json',
    '--machine-representation-version', '2',
    '--runs-dir', runsDir,
  ]);

  assert.equal(observed.code, 2, 'usage incorrect');
  assert.match(observed.stderr, /Option inconnue : --machine-representation-version/);
  assert.equal(observed.stdout, '', 'aucune charge utile JSON');

  // La propriete qui compte : AUCUNE DESCENTE SILENCIEUSE. Le binaire ancien ne
  // rend jamais discretement la representation 1 a qui demandait la 2.
  assert.ok(!observed.stdout.includes('durable_run_activity'), 'aucun document rendu');
});

test('C2 · invocation historique + binaire v1.1.0 : la representation 1 est celle du binaire courant', async (t) => {
  const dir = await makeTempDir('ccr-compat-rep1-');
  t.after(() => removeTempDir(dir));
  const runsDir = await nativeRun(dir);
  const binary = await releasedBinary(dir);

  const released = await execute(binary, ['run-activity', RUN_ID, '--format', 'json', '--runs-dir', runsDir]);
  const current = await currentCli(runsDir, ['run-activity', RUN_ID, '--format', 'json']);

  assert.equal(released.code, 0);
  assert.equal(current.code, 0);
  assert.deepEqual(
    JSON.parse(released.stdout),
    JSON.parse(current.stdout),
    'representation 1 identique de part et d_autre',
  );
});

// --------------------------------------------------------------------------
// 2 · Donnees du journal
// --------------------------------------------------------------------------

test('C3 · journal porteur d_un fait P3 + binaire v1.1.0 : jamais saute en silence', async (t) => {
  const dir = await makeTempDir('ccr-compat-journal-');
  t.after(() => removeTempDir(dir));
  const runsDir = await nativeRun(dir);
  const binary = await releasedBinary(dir);

  await endNativeProduction({ runsDir, now: () => new Date(AT) }, RUN_ID, {
    note: 'fin',
    acknowledgeDowngrade: RUN_ID,
  });

  // Le validateur historique refuse le type qu_il ne connait pas. Une commande
  // qui relit le journal sans enveloppe d_issue echoue franchement.
  const status = await execute(binary, ['status', RUN_ID, '--runs-dir', runsDir]);
  assert.equal(status.code, 1, 'echec franc');
  assert.match(status.stderr, /JOURNAL_INVALID/);
  assert.match(status.stderr, /production_ended/, 'le type inconnu est nomme');

  // F2 possede sa propre enveloppe, anterieure a P3 : une matiere inexploitable
  // se rend `PROJECTION_FAILURE`, en sortie 0. Ce n_est pas un saut silencieux —
  // le binaire ancien ne pretend a AUCUNE histoire, et ne rend rien de partiel.
  const activity = await execute(binary, [
    'run-activity', RUN_ID, '--format', 'json', '--runs-dir', runsDir,
  ]);
  assert.equal(activity.code, 0);
  const document = JSON.parse(activity.stdout) as Record<string, unknown>;
  assert.equal(document['projection_status'], 'PROJECTION_FAILURE');
  assert.ok(!('activities' in document), 'aucune histoire partielle rendue');
  assert.ok(!('production_intent' in document), 'aucun champ P3 devine');
});

test('C4 · nouveau binaire + journal anterieur : lisible, sans migration', async (t) => {
  const dir = await makeTempDir('ccr-compat-old-journal-');
  t.after(() => removeTempDir(dir));
  const runsDir = await nativeRun(dir);
  const binary = await releasedBinary(dir);

  // Le journal a ete ecrit ici par les stores courants, sans aucun fait P3 :
  // c_est exactement la forme qu_un run anterieur possede.
  const released = await execute(binary, ['run-activity', RUN_ID, '--format', 'json', '--runs-dir', runsDir]);
  assert.equal(released.code, 0, 'le binaire publie le lit');

  const rep1 = await currentCli(runsDir, ['run-activity', RUN_ID, '--format', 'json']);
  const rep2 = await currentCli(runsDir, [
    'run-activity', RUN_ID, '--format', 'json', '--machine-representation-version', '2',
  ]);

  assert.equal(rep1.code, 0);
  assert.equal(rep2.code, 0);
  assert.deepEqual(JSON.parse(rep1.stdout), JSON.parse(released.stdout), 'aucune migration');
  assert.equal(
    (JSON.parse(rep2.stdout) as { production_intent: string }).production_intent,
    'STEPS_INTENDED',
    'un journal sans fait P3 ne declare rien, et se lit STEPS_INTENDED',
  );
});
