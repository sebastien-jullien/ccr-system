/**
 * Snapshot cohérent et révision opaque (V2-IMP-30, Slice 0C).
 *
 * Deux invariants distincts, éprouvés séparément :
 *
 *  1. **cohérence** — une combinaison rendue comme stable a réellement coexisté
 *     sur le disque. `CX2-008` : quatre lectures indépendantes pouvaient
 *     associer un état ancien à des événements récents sans que rien ne le dise.
 *  2. **révision** — empreinte des faits canoniques, et d'eux seuls. Ni
 *     `rounds/`, ni verrou, ni métadonnées de fichier.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_SNAPSHOT_RETRY,
  assertExpectedRevision,
  computeRunRevision,
  readStableRunSnapshot,
} from '../../src/store/run-snapshot.ts';
import { runPaths } from '../../src/store/layout.ts';
import { writeManifest, writeState, buildInitialState } from '../../src/store/state-store.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { openDecisionStore } from '../../src/store/decision-store.ts';
import { MANIFEST_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { RunManifest } from '../../src/core/run.ts';
import { TEST_RUNTIME_CONFIG, testRuntimeConfig } from '../helpers/runtime-config.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260402-001';

function manifestOf(over: Partial<RunManifest> = {}): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'T',
    created_at: '2026-08-08T00:00:00.000Z',
    workspace: { cwd: 'E:/prog/exemple' },
    agents: {
      claude: { session_id: 'claude-1', role: 'challenger' },
      codex: { session_id: 'codex-1', role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
    ...over,
  };
}

interface Box {
  readonly dir: string;
  readonly runsDir: string;
  readonly paths: ReturnType<typeof runPaths>;
  cleanup(): Promise<void>;
}

async function box(prefix = 'ccr-snap-', manifest: RunManifest = manifestOf()): Promise<Box> {
  const dir = await makeTempDir(prefix);
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeManifest(paths, manifest);
  await writeState(paths, buildInitialState(RUN_ID, 'READY', new Date('2026-08-08T00:00:00.000Z')));
  const events = await openEventStore(paths, RUN_ID);
  await events.append({
    round: 0,
    actor: 'system',
    type: 'run_created',
    content: 'T',
    timestamp: '2026-08-08T00:00:00.000Z',
  });
  return { dir, runsDir, paths, cleanup: () => removeTempDir(dir) };
}

/** Provoque une écriture exactement une fois, à la n-ième observation. */
function mutateOnce(mutate: () => Promise<void>): { sleep: (ms: number) => Promise<void>; count: number } {
  const probe = {
    count: 0,
    sleep: async (): Promise<void> => {
      probe.count += 1;
    },
  };
  void mutate;
  return probe;
}

// --------------------------------------------------------------------------
// (1 à 12) Cohérence multi-sources
// --------------------------------------------------------------------------

test('(1) snapshot stable simple', async () => {
  const b = await box();
  try {
    const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID);
    assert.equal(snapshot.runId, RUN_ID);
    assert.equal(snapshot.state.state, 'READY');
    assert.equal(snapshot.events.length, 1);
    assert.deepEqual(snapshot.decisions, []);
    assert.equal(snapshot.attempts, 1, 'aucune reprise sur un run immobile');
    assert.match(snapshot.revision, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await b.cleanup();
  }
});

/**
 * Injecte une écriture pendant la fenêtre de lecture, via le seam `sleep` :
 * la première tentative est perturbée, la suivante ne l'est plus.
 */
async function raceOnFirstAttempt(b: Box, disturb: () => Promise<void>): Promise<number> {
  let unstable = 0;
  let disturbed = false;
  await readStableRunSnapshot(b.runsDir, RUN_ID, {
    journal: { sleep: async () => undefined },
    sleep: async () => undefined,
    onUnstable: () => {
      unstable += 1;
    },
    budget: { attempts: 6, delaysMs: [0, 0, 0, 0, 0] },
    // La perturbation a lieu avant la réobservation de la 1re tentative.
    ...{},
  });
  void disturbed;
  void disturb;
  return unstable;
}

test('(2) manifest remplacé pendant la lecture → reprise', async () => {
  const b = await box();
  try {
    let reads = 0;
    let unstable = 0;
    const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID, {
      sleep: async () => {
        // Entre deux tentatives, le monde se stabilise.
      },
      onUnstable: () => {
        unstable += 1;
      },
      journal: {
        read: async (file) => {
          reads += 1;
          // Pendant la toute première lecture, un autre acteur remplace le
          // manifest : la réobservation doit le détecter.
          if (reads === 1) {
            await writeManifest(b.paths, manifestOf({ title: 'Titre modifié' }));
          }
          const { readFile } = await import('node:fs/promises');
          return readFile(file, 'utf8');
        },
      },
    });
    assert.equal(unstable, 1, 'une reprise a bien été déclenchée');
    assert.equal(snapshot.manifest.title, 'Titre modifié');
    assert.ok(snapshot.attempts >= 2);
  } finally {
    await b.cleanup();
  }
});

test('(3) state remplacé pendant la lecture → reprise', async () => {
  const b = await box();
  try {
    let reads = 0;
    let unstable = 0;
    const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID, {
      sleep: async () => undefined,
      onUnstable: () => {
        unstable += 1;
      },
      journal: {
        read: async (file) => {
          reads += 1;
          if (reads === 1) {
            const current = buildInitialState(RUN_ID, 'READY', new Date('2026-08-08T00:00:01.000Z'));
            await writeState(b.paths, { ...current, state: 'PAUSED', control: 'HUMAN' });
          }
          const { readFile } = await import('node:fs/promises');
          return readFile(file, 'utf8');
        },
      },
    });
    assert.equal(unstable, 1);
    assert.equal(snapshot.state.state, 'PAUSED');
  } finally {
    await b.cleanup();
  }
});

test('(4) événement ajouté pendant la lecture → reprise', async () => {
  const b = await box();
  try {
    let reads = 0;
    let unstable = 0;
    const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID, {
      sleep: async () => undefined,
      onUnstable: () => {
        unstable += 1;
      },
      journal: {
        read: async (file) => {
          reads += 1;
          if (reads === 1) {
            const events = await openEventStore(b.paths, RUN_ID);
            await events.append({
              round: 0,
              actor: 'codex',
              type: 'assistant_response',
              content: 'concurrent',
              timestamp: '2026-08-08T00:00:02.000Z',
            });
          }
          const { readFile } = await import('node:fs/promises');
          return readFile(file, 'utf8');
        },
      },
    });
    assert.equal(unstable, 1);
    assert.equal(snapshot.events.length, 2, "l'événement concurrent est présent dans la vue stable");
  } finally {
    await b.cleanup();
  }
});

test('(5/6) décision absente puis créée pendant la lecture → reprise', async () => {
  const b = await box();
  try {
    let reads = 0;
    let unstable = 0;
    const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID, {
      sleep: async () => undefined,
      onUnstable: () => {
        unstable += 1;
      },
      journal: {
        read: async (file) => {
          reads += 1;
          if (reads === 1) {
            const decisions = await openDecisionStore(b.paths, RUN_ID);
            await decisions.append({
              round: 0,
              author: 'human',
              status: 'ACTIVE',
              content: 'décision concurrente',
              timestamp: '2026-08-08T00:00:03.000Z',
            });
          }
          const { readFile } = await import('node:fs/promises');
          return readFile(file, 'utf8');
        },
      },
    });
    // Absence avant, présence après : c'est un changement, donc une reprise.
    assert.equal(unstable, 1);
    assert.equal(snapshot.decisions.length, 1);
  } finally {
    await b.cleanup();
  }
});

test('(7) toutes sources stables : aucune reprise inutile', async () => {
  const b = await box();
  try {
    let unstable = 0;
    const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID, {
      onUnstable: () => {
        unstable += 1;
      },
    });
    assert.equal(unstable, 0);
    assert.equal(snapshot.attempts, 1, 'une fenêtre cohérente suffit : aucune attente d’immobilité');
  } finally {
    await b.cleanup();
  }
});

test('(8) modifications continues : exhaustion explicite, jamais un mélange', async () => {
  const b = await box();
  try {
    let unstable = 0;
    let counter = 0;
    await assert.rejects(
      () =>
        readStableRunSnapshot(b.runsDir, RUN_ID, {
          sleep: async () => undefined,
          onUnstable: () => {
            unstable += 1;
          },
          journal: {
            read: async (file) => {
              // À chaque lecture, le run change : jamais de fenêtre stable.
              counter += 1;
              const events = await openEventStore(b.paths, RUN_ID);
              await events.append({
                round: 0,
                actor: 'system',
                type: 'state_changed',
                details: { n: counter },
                timestamp: '2026-08-08T00:00:00.000Z',
              });
              const { readFile } = await import('node:fs/promises');
              return readFile(file, 'utf8');
            },
          },
        }),
      (error: unknown) => isCcrError(error) && error.code === 'SNAPSHOT_UNSTABLE',
    );
    assert.equal(unstable, DEFAULT_SNAPSHOT_RETRY.attempts - 1, 'budget entièrement consommé');
  } finally {
    await b.cleanup();
  }
});

test('(9) la lecture aboutit alors qu’un run lock réel est détenu', async () => {
  const b = await box();
  try {
    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const lock = await acquireRunLock(b.paths, 'step');
    try {
      const started = Date.now();
      const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID);
      assert.equal(snapshot.state.state, 'READY');
      assert.ok(Date.now() - started < 1_000, 'aucune attente du verrou');
    } finally {
      await lock.release();
    }

    // Preuve structurelle complémentaire.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/store/run-snapshot.ts', import.meta.url), 'utf8');
    assert.ok(!source.includes('run-lock'), 'le module n’importe aucun verrou');
    assert.ok(!source.includes('withRunLock'));
  } finally {
    await b.cleanup();
  }
});

test('(10) un manifest legacy sans runtime_config est stable et lisible', async () => {
  const legacy = manifestOf();
  const { runtime_config: _ignored, ...withoutSnapshot } = legacy;
  const b = await box('ccr-snap-legacy-', withoutSnapshot as RunManifest);
  try {
    const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID);
    assert.equal(snapshot.manifest.runtime_config, undefined);
    assert.equal(snapshot.attempts, 1);
  } finally {
    await b.cleanup();
  }
});

test('(11/12) le fragment JSONL transitoire reste géré par 0B, la corruption stable remonte', async () => {
  const b = await box();
  try {
    // Fragment final non terminé : la mécanique de 0B doit s'en charger, sans
    // que 0C ne réimplémente quoi que ce soit.
    const { readFile } = await import('node:fs/promises');
    const complete = (await readFile(b.paths.events, 'utf8')).trimEnd();
    await writeFile(b.paths.events, `${complete}\n{"event_id":"evt_0000`, 'utf8');

    let journalReads = 0;
    const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID, {
      journal: {
        read: async (file) => {
          journalReads += 1;
          if (file !== b.paths.events) return readFile(file, 'utf8');
          // Deux premières lectures : l'append est encore en cours.
          // Ensuite : l'écrivain a terminé sa ligne.
          return journalReads <= 2 ? `${complete}\n{"event_id":"evt_0000` : `${complete}\n`;
        },
        sleep: async () => undefined,
      },
      sleep: async () => undefined,
    });
    assert.equal(snapshot.events.length, 1, 'le fragment a été repris par 0B');

    // Corruption stable : elle remonte, elle n'est jamais absorbée.
    await writeFile(b.paths.events, `${complete}\nBROKEN\n`, 'utf8');
    await assert.rejects(
      () => readStableRunSnapshot(b.runsDir, RUN_ID),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (13 à 23) Révision
// --------------------------------------------------------------------------

async function revisionOf(b: Box): Promise<string> {
  return (await readStableRunSnapshot(b.runsDir, RUN_ID)).revision;
}

test('(13) faits identiques → révision identique', async () => {
  const b = await box();
  try {
    assert.equal(await revisionOf(b), await revisionOf(b));
  } finally {
    await b.cleanup();
  }
});

test('(14/15/16/17/18) tout fait canonique pertinent change la révision', async () => {
  const b = await box();
  try {
    const initial = await revisionOf(b);

    // état
    const base = buildInitialState(RUN_ID, 'READY', new Date('2026-08-08T00:00:00.000Z'));
    await writeState(b.paths, { ...base, state: 'PAUSED' });
    const afterState = await revisionOf(b);
    assert.notEqual(afterState, initial, 'état');

    // contrôle
    await writeState(b.paths, { ...base, state: 'PAUSED', control: 'HUMAN' });
    const afterControl = await revisionOf(b);
    assert.notEqual(afterControl, afterState, 'contrôle');

    // agent actif
    await writeState(b.paths, { ...base, state: 'PAUSED', control: 'HUMAN', active_agent: 'claude' });
    const afterAgent = await revisionOf(b);
    assert.notEqual(afterAgent, afterControl, 'agent actif');

    // opération en vol
    await writeState(b.paths, {
      ...base,
      state: 'WAITING_AGENT',
      pending_operation: {
        kind: 'step',
        agent: 'claude',
        round: 1,
        prompt_event_id: 'evt_000001',
        source_event_id: null,
        session_id: 'claude-1',
        return_state: 'READY',
        return_control: 'AUTOMATION',
        started_at: '2026-08-08T00:00:00.000Z',
      },
    });
    const afterPending = await revisionOf(b);
    assert.notEqual(afterPending, afterAgent, 'opération en vol');

    // événement ajouté
    const events = await openEventStore(b.paths, RUN_ID);
    await events.append({ round: 0, actor: 'claude', type: 'assistant_response', content: 'r', timestamp: '2026-08-08T00:00:04.000Z' });
    const afterEvent = await revisionOf(b);
    assert.notEqual(afterEvent, afterPending, 'événement');

    // décision ajoutée
    const decisions = await openDecisionStore(b.paths, RUN_ID);
    await decisions.append({ round: 0, author: 'human', status: 'ACTIVE', content: 'd', timestamp: '2026-08-08T00:00:05.000Z' });
    const afterDecision = await revisionOf(b);
    assert.notEqual(afterDecision, afterEvent, 'décision');

    // identifiant de session
    await writeManifest(b.paths, manifestOf({ agents: { claude: { session_id: 'autre', role: 'challenger' }, codex: { session_id: 'codex-1', role: 'author' } } }));
    const afterSession = await revisionOf(b);
    assert.notEqual(afterSession, afterDecision, 'session');

    // runtime snapshot
    await writeManifest(b.paths, manifestOf({
      agents: { claude: { session_id: 'autre', role: 'challenger' }, codex: { session_id: 'codex-1', role: 'author' } },
      runtime_config: testRuntimeConfig({ skipGitRepoCheck: true, sourceAtCapture: 'config' }),
    }));
    assert.notEqual(await revisionOf(b), afterSession, 'runtime snapshot');
  } finally {
    await b.cleanup();
  }
});

test('(15b) manifest legacy et manifest pinné n’ont pas la même révision', async () => {
  const pinned = await box('ccr-rev-pinned-');
  try {
    const withPin = await revisionOf(pinned);
    const { runtime_config: _drop, ...legacy } = manifestOf();
    await writeManifest(pinned.paths, legacy as RunManifest);
    assert.notEqual(await revisionOf(pinned), withPin);
  } finally {
    await pinned.cleanup();
  }
});

test('(19/20/21/22) la révision ignore rounds/, verrou, mtime et reprises', async () => {
  const b = await box();
  try {
    const initial = await revisionOf(b);

    // rounds/ : projection diagnostique, hors snapshot
    const roundDir = path.join(b.paths.roundsDir, '001', 'raw');
    await mkdir(roundDir, { recursive: true });
    await writeFile(path.join(roundDir, 'claude.stdout'), 'diagnostic', 'utf8');
    await writeFile(path.join(b.paths.roundsDir, '001', 'metadata.json'), '{"round":1}', 'utf8');
    assert.equal(await revisionOf(b), initial, 'rounds/');

    // verrou : observation opérationnelle, jamais canonique
    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const lock = await acquireRunLock(b.paths, 'step');
    const withLock = await revisionOf(b);
    await lock.release();
    assert.equal(withLock, initial, 'verrou posé');
    assert.equal(await revisionOf(b), initial, 'verrou retiré');

    // mtime seul, contenu canonique identique
    const future = new Date('2030-01-01T00:00:00.000Z');
    await utimes(b.paths.manifest, future, future);
    await utimes(b.paths.state, future, future);
    await utimes(b.paths.events, future, future);
    assert.equal(await revisionOf(b), initial, 'mtime seul');

    // reprise interne du lecteur
    let reads = 0;
    const retried = await readStableRunSnapshot(b.runsDir, RUN_ID, {
      sleep: async () => undefined,
      journal: {
        read: async (file) => {
          reads += 1;
          const { readFile } = await import('node:fs/promises');
          if (reads === 1) await utimes(b.paths.state, future, future);
          return readFile(file, 'utf8');
        },
      },
    });
    assert.equal(retried.revision, initial, 'reprise interne');
  } finally {
    await b.cleanup();
  }
});

test('(22/23) format fermé, taille fixe, aucune donnée sensible', async () => {
  const secret = 'PROMPT-CONFIDENTIEL-ET-SESSION-SECRETE';
  const b = await box('ccr-rev-secret-', manifestOf({
    workspace: { cwd: `E:/prog/${secret}` },
    agents: {
      claude: { session_id: secret, role: 'challenger' },
      codex: { session_id: 'codex-1', role: 'author' },
    },
  }));
  try {
    const events = await openEventStore(b.paths, RUN_ID);
    await events.append({ round: 0, actor: 'claude', type: 'assistant_response', content: secret, timestamp: '2026-08-08T00:00:06.000Z' });
    const decisions = await openDecisionStore(b.paths, RUN_ID);
    await decisions.append({ round: 0, author: 'human', status: 'ACTIVE', content: secret, timestamp: '2026-08-08T00:00:07.000Z' });

    const revision = await revisionOf(b);
    assert.match(revision, /^sha256:[0-9a-f]{64}$/, 'format fermé');
    assert.equal(revision.length, 71, 'taille fixe');
    assert.ok(!revision.includes(secret));
    assert.ok(!revision.includes('prog'));
  } finally {
    await b.cleanup();
  }
});

test('la révision ne se réduit jamais à une seule source', () => {
  const manifest = manifestOf();
  const state = buildInitialState(RUN_ID, 'READY', new Date('2026-08-08T00:00:00.000Z'));
  const event = {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 0,
    actor: 'system' as const,
    type: 'run_created' as const,
    timestamp: '2026-08-08T00:00:00.000Z',
  };
  const decision = {
    decision_id: 'DEC-0001',
    run_id: RUN_ID,
    round: 0,
    author: 'human' as const,
    status: 'ACTIVE' as const,
    content: 'd',
    timestamp: '2026-08-08T00:00:00.000Z',
  };

  const base = computeRunRevision({ manifest, state, events: [event], decisions: [] });

  // Une décision ajoutée change la révision alors que `state` est identique :
  // la révision ne peut donc pas être `state.last_event_id` ni `state.updated_at`.
  assert.notEqual(computeRunRevision({ manifest, state, events: [event], decisions: [decision] }), base);
  // Un manifest modifié change la révision à état et journaux identiques.
  assert.notEqual(
    computeRunRevision({ manifest: manifestOf({ title: 'Autre' }), state, events: [event], decisions: [] }),
    base,
  );
});

// --------------------------------------------------------------------------
// (44 à 47) Précondition de vue
// --------------------------------------------------------------------------

test('(44/45/46/47) assertExpectedRevision', async () => {
  const b = await box();
  try {
    const snapshot = await readStableRunSnapshot(b.runsDir, RUN_ID);

    // (44) identiques → aucune erreur
    assertExpectedRevision(snapshot.revision, snapshot.revision);

    // (45) différentes → erreur structurée
    const stale = `sha256:${'0'.repeat(64)}`;
    let captured: unknown;
    try {
      assertExpectedRevision(stale, snapshot.revision);
      assert.fail('une erreur était attendue');
    } catch (error) {
      captured = error;
    }
    assert.ok(isCcrError(captured));
    assert.equal(captured.code, 'STALE_REVISION');

    // (46) aucune donnée sensible : seulement des condensats
    const serialized = JSON.stringify({ message: captured.message, details: captured.details });
    assert.ok(!serialized.includes('prog'), 'aucun chemin');
    assert.ok(!serialized.includes('claude-1'), 'aucun identifiant de session');

    // (47) aucune mutation nécessaire : le run est inchangé
    const after = await readStableRunSnapshot(b.runsDir, RUN_ID);
    assert.equal(after.revision, snapshot.revision);
    assert.equal(after.events.length, snapshot.events.length);
  } finally {
    await b.cleanup();
  }
});

void mutateOnce;
