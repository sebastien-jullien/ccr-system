/**
 * Levée d'un verrou de run périmé — preuves sur processus et fichiers réels.
 *
 * C'est la seule opération destructive de CCR. Les preuves portent donc moins
 * sur ce qu'elle fait que sur tout ce qu'elle refuse de faire :
 *
 * ```text
 * un propriétaire vivant        jamais supprimé
 * un verrou d'un autre hôte     jamais supprimé
 * un verrou illisible           jamais supprimé
 * un verrou qui a tourné        jamais supprimé
 * ```
 *
 * Les verrous vivants et périmés viennent de **vrais** processus : un fichier
 * écrit à la main ne meurt jamais, et ne prouverait donc rien.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearStaleRunLock } from '../../src/services/clear-stale-run-lock-service.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { lockTokenFor } from '../../src/lock/lock-token.ts';
import { lockFilePath, readRunLock } from '../../src/lock/run-lock.ts';
import { observeRunExecution } from '../../src/lock/run-execution-evidence.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { RunLockInfo } from '../../src/lock/run-lock.ts';

const HOLDER = fileURLToPath(new URL('../fixtures/hold-run-lock.mjs', import.meta.url));
const RUN = 'CCR-20260402-001';

interface Holder {
  readonly child: ChildProcess;
  readonly lockId: string;
  readonly exited: Promise<void>;
  kill(): void;
}

/** Un vrai processus qui acquiert le verrou et le garde. */
function holdLock(runsDir: string, runId: string): Promise<Holder> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER, runsDir, runId], { stdio: 'pipe', shell: false });
    let out = '';
    let err = '';
    const exited = new Promise<void>((done) => child.on('close', () => done()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`détenteur non démarré : ${out} ${err}`));
    }, 60_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = /HELD (\S+)/.exec(out);
      if (match === null) return;
      clearTimeout(timer);
      resolve({
        child,
        lockId: match[1] ?? '',
        exited,
        kill: () => {
          child.kill('SIGKILL');
        },
      });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

interface Box {
  readonly dir: string;
  readonly runsDir: string;
  readonly deps: { runsDir: string };
  lockPath(): string;
  lock(): Promise<RunLockInfo | undefined>;
  lockExists(): boolean;
  observation(): Promise<string>;
  cleanup(): Promise<void>;
}

async function open(): Promise<Box> {
  const dir = await makeTempDir('ccr-clear-lock-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: RUN,
    events: [
      { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
      { round: 1, actor: 'codex', type: 'assistant_response', session_id: 'codex-1', content: 'réponse', timestamp: T },
    ],
  });
  const paths = runPaths(runsDir, RUN);
  return {
    dir,
    runsDir,
    deps: { runsDir },
    lockPath: () => lockFilePath(paths),
    lock: () => readRunLock(paths),
    lockExists: () => existsSync(lockFilePath(paths)),
    observation: async () => (await observeRunExecution(paths, {})).observation,
    cleanup: () => removeTempDir(dir),
  };
}

const codeOf = (error: unknown): string => (isCcrError(error) ? error.code : String(error));

/** Écrit un verrou arbitraire — pour les cas qu'aucun processus ne produit. */
async function writeLock(box: Box, info: Record<string, unknown>): Promise<void> {
  await writeFile(box.lockPath(), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

// --------------------------------------------------------------------------
// P1 — propriétaire local vivant
// --------------------------------------------------------------------------

test('(P1) un propriétaire vivant n’est jamais levé', { timeout: 180_000 }, async (t) => {
  const b = await open();
  let holder: Holder | undefined;
  try {
    holder = await holdLock(b.runsDir, RUN);
    const lock = await b.lock();
    assert.ok(lock !== undefined, 'le verrou est bien posé par le processus');
    const token = lockTokenFor(RUN, lock);
    const observation = await b.observation();
    t.diagnostic(`propriétaire vivant pid=${String(lock.pid)} · observation=${observation}`);

    await assert.rejects(
      clearStaleRunLock(b.deps, { runId: RUN, observedLockToken: token }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'RECOVERY_LOCK_NOT_CLEARABLE');
        return true;
      },
    );

    // Le processus est toujours vivant au moment de l'assertion.
    assert.equal(holder.child.exitCode, null, 'le détenteur vit encore');
    assert.equal(b.lockExists(), true, 'le verrou est intact');
    assert.equal((await b.lock())?.lock_id, lock.lock_id);
  } finally {
    holder?.kill();
    await holder?.exited;
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// P2 — propriétaire réellement mort
// --------------------------------------------------------------------------

test('(P2) un propriétaire mort rend le verrou levable, et il est levé', { timeout: 180_000 }, async (t) => {
  const b = await open();
  try {
    const holder = await holdLock(b.runsDir, RUN);
    const observedLock = await b.lock();
    assert.ok(observedLock !== undefined);
    const token = lockTokenFor(RUN, observedLock);

    holder.kill();
    await holder.exited;

    const observation = await b.observation();
    t.diagnostic(`propriétaire mort pid=${String(observedLock.pid)} · observation=${observation}`);
    assert.equal(observation, 'STALE_LOCK', 'la discipline 0D le classe périmé');
    assert.equal(b.lockExists(), true, 'le fichier survit à son processus');

    const outcome = await clearStaleRunLock(b.deps, { runId: RUN, observedLockToken: token });
    assert.deepEqual(outcome, { runId: RUN, cleared: true });
    assert.equal(b.lockExists(), false, 'le verrou est levé');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// P3 — verrou d'un autre hôte
// --------------------------------------------------------------------------

test('(P3) un verrou étranger n’est jamais levé, même avec un PID mort', async (t) => {
  const b = await open();
  try {
    const info = {
      lock_id: 'lock-etranger-0001',
      // PID certainement mort sur cette machine : le nom d'hôte doit primer.
      pid: 2 ** 30,
      hostname: `${hostname()}-autre-poste`,
      started_at: T,
      command: 'step',
    };
    await writeLock(b, info);
    const token = lockTokenFor(RUN, info as RunLockInfo);
    const observation = await b.observation();
    t.diagnostic(`verrou étranger → observation=${observation}`);
    assert.equal(observation, 'FOREIGN_LOCK');

    await assert.rejects(
      clearStaleRunLock(b.deps, { runId: RUN, observedLockToken: token }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'RECOVERY_LOCK_NOT_CLEARABLE');
        return true;
      },
    );
    assert.equal(b.lockExists(), true, 'le verrou étranger est intact');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// P4 — verrou illisible
// --------------------------------------------------------------------------

test('(P4) un verrou illisible est fermé, jamais forcé', async (t) => {
  const b = await open();
  try {
    await writeFile(b.lockPath(), '{ ceci n’est pas du JSON', 'utf8');
    const before = await readFile(b.lockPath(), 'utf8');
    const observation = await b.observation();
    t.diagnostic(`verrou illisible → observation=${observation}`);

    // Le parseur échoue ; l'observateur 0D ne confond pas illisible et absent.
    assert.equal(observation, 'INDETERMINATE_LOCK');

    await assert.rejects(
      clearStaleRunLock(b.deps, { runId: RUN, observedLockToken: `lt1:${'A'.repeat(43)}` }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'RECOVERY_LOCK_NOT_CLEARABLE');
        return true;
      },
    );
    assert.equal(await readFile(b.lockPath(), 'utf8'), before, 'le fichier est intact, octet pour octet');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// P5 — rotation entre la vérification et la suppression
// --------------------------------------------------------------------------

test('(P5) rotation L1 → L2 pendant l’opération : L2 survit', { timeout: 180_000 }, async (t) => {
  const b = await open();
  try {
    const holder = await holdLock(b.runsDir, RUN);
    const l1 = await b.lock();
    assert.ok(l1 !== undefined);
    const t1 = lockTokenFor(RUN, l1);
    holder.kill();
    await holder.exited;
    assert.equal(await b.observation(), 'STALE_LOCK');

    // L1 est classé, son identité confirmée. Puis il tourne — exactement dans
    // la fenêtre que la relecture destructive existe pour fermer.
    const l2 = {
      lock_id: 'lock-successeur-002',
      pid: process.pid,
      hostname: hostname(),
      started_at: new Date().toISOString(),
      command: 'send',
    };
    let rotated = false;

    await assert.rejects(
      clearStaleRunLock(
        b.deps,
        { runId: RUN, observedLockToken: t1 },
        {
          beforeUnlink: async () => {
            await writeLock(b, l2);
            rotated = true;
          },
        },
      ),
      (error: unknown) => {
        assert.equal(codeOf(error), 'RECOVERY_LOCK_CHANGED');
        return true;
      },
    );

    const survivor = await b.lock();
    t.diagnostic(`rotation effectuée=${String(rotated)} · survivant=${String(survivor?.lock_id)}`);
    assert.equal(rotated, true, 'la couture a bien tourné le verrou');
    assert.equal(b.lockExists(), true, 'L2 est intact');
    assert.equal(survivor?.lock_id, l2.lock_id, 'c’est bien L2 qui survit, pas L1');
  } finally {
    await b.cleanup();
  }
});

test('(P5b) un jeton qui ne correspond plus est refusé avant toute suppression', { timeout: 180_000 }, async (t) => {
  const b = await open();
  try {
    // L1 observé puis mort : le jeton T1 est légitime… mais périmé.
    const holder = await holdLock(b.runsDir, RUN);
    const l1 = await b.lock();
    assert.ok(l1 !== undefined);
    const t1 = lockTokenFor(RUN, l1);
    holder.kill();
    await holder.exited;

    // L2 remplace L1 **avant** l'appel, et il est lui-même périmé.
    const l2 = {
      lock_id: 'lock-successeur-003',
      pid: 2 ** 30,
      hostname: hostname(),
      started_at: new Date().toISOString(),
      command: 'step',
    };
    await writeLock(b, l2);
    const observation = await b.observation();
    t.diagnostic(`L2 en place → observation=${observation} · jeton présenté = celui de L1`);
    assert.equal(observation, 'STALE_LOCK', 'L2 est lui-même levable — et pourtant');

    let reachedDestructiveStage = 0;
    await assert.rejects(
      clearStaleRunLock(
        b.deps,
        { runId: RUN, observedLockToken: t1 },
        {
          beforeUnlink: () => {
            reachedDestructiveStage += 1;
          },
        },
      ),
      (error: unknown) => {
        assert.equal(codeOf(error), 'RECOVERY_LOCK_CHANGED');
        return true;
      },
    );
    // La demande portait sur L1. Un verrou périmé n'est pas interchangeable
    // avec un autre verrou périmé.
    assert.equal((await b.lock())?.lock_id, l2.lock_id, 'L2 est intact');
    // Et le refus arrive AVANT la phase destructive : une identité qui ne
    // correspond plus est tranchée d'emblée, sans que rien ne se prépare.
    t.diagnostic(`phase destructive atteinte ${String(reachedDestructiveStage)} fois`);
    assert.equal(reachedDestructiveStage, 0, 'une demande condamnée n’atteint pas la préparation');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// P6 — aucun fait canonique n'est touché
// --------------------------------------------------------------------------

test('(P6) une levée réussie ne modifie aucun fait canonique', { timeout: 180_000 }, async (t) => {
  const b = await open();
  try {
    const paths = runPaths(b.runsDir, RUN);
    const digest = async (file: string): Promise<string> =>
      createHash('sha256').update(await readFile(file, 'utf8'), 'utf8').digest('hex').slice(0, 16);

    const holder = await holdLock(b.runsDir, RUN);
    const lock = await b.lock();
    assert.ok(lock !== undefined);
    const token = lockTokenFor(RUN, lock);
    holder.kill();
    await holder.exited;

    const before = {
      revision: (await readStableRunSnapshot(b.runsDir, RUN)).revision,
      events: (await (await openEventStore(paths, RUN)).readAll()).length,
      state: await digest(paths.state),
      manifest: await digest(paths.manifest),
      entries: (await readdir(paths.root)).sort(),
    };

    await clearStaleRunLock(b.deps, { runId: RUN, observedLockToken: token });

    const after = {
      revision: (await readStableRunSnapshot(b.runsDir, RUN)).revision,
      events: (await (await openEventStore(paths, RUN)).readAll()).length,
      state: await digest(paths.state),
      manifest: await digest(paths.manifest),
      entries: (await readdir(paths.root)).sort(),
    };

    t.diagnostic(`révision ${before.revision.slice(0, 20)}… → ${after.revision.slice(0, 20)}…`);
    t.diagnostic(`entrées : ${before.entries.join(',')} → ${after.entries.join(',')}`);

    assert.equal(after.revision, before.revision, 'la révision canonique est identique');
    assert.equal(after.events, before.events, 'aucun événement synthétique');
    assert.equal(after.state, before.state, 'state.json inchangé, octet pour octet');
    assert.equal(after.manifest, before.manifest, 'manifest.json inchangé');

    // Le seul changement autorisé : le fichier de verrou a disparu.
    assert.deepEqual(
      before.entries.filter((entry) => entry !== '.ccr.lock'),
      after.entries,
      'seul .ccr.lock a disparu',
    );
  } finally {
    await b.cleanup();
  }
});
