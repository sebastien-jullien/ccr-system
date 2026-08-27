/**
 * Tests unitaires du verrou de run (lot V1.8, spécification §22).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';

import {
  acquireRunLock,
  assessLiveness,
  clearStaleLock,
  isProcessAlive,
  lockFilePath,
  readRunLock,
  withRunLock,
} from '../../src/lock/run-lock.ts';
import type { RunLockInfo } from '../../src/lock/run-lock.ts';
import { createRunDirectory } from '../../src/store/state-store.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const NOW = new Date(2026, 7, 7, 17, 50, 0);

/** PID libre avec quasi-certitude : il n'existe aucun processus 0x7FFFFFFF. */
const DEAD_PID = 0x7fff_fffe;

async function newRunPaths(): Promise<{ paths: RunPaths; cleanup(): Promise<void> }> {
  const runsDir = await makeTempDir('ccr-lock-');
  const paths = await createRunDirectory(runsDir, NOW);
  return { paths, cleanup: () => removeTempDir(runsDir) };
}

async function writeLock(paths: RunPaths, info: Partial<RunLockInfo>): Promise<void> {
  const complete: RunLockInfo = {
    lock_id: 'lock-fixture',
    pid: DEAD_PID,
    hostname: hostname(),
    started_at: NOW.toISOString(),
    command: 'send',
    ...info,
  };
  await writeFile(lockFilePath(paths), JSON.stringify(complete, null, 2), 'utf8');
}

async function expectCcrError(promise: Promise<unknown>, code: CcrErrorCode): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isCcrError(error), `attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`attendu une CcrError ${code}, aucune erreur levée`);
}

test('le verrou est créé avec les informations de son propriétaire', async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    const lock = await acquireRunLock(paths, 'send');

    const persisted = await readRunLock(paths);
    assert.equal(persisted?.pid, process.pid);
    assert.equal(persisted?.hostname, hostname());
    assert.equal(persisted?.command, 'send');
    assert.equal(persisted?.lock_id, lock.info.lock_id);
    assert.ok(Date.parse(persisted?.started_at ?? '') > 0);

    await lock.release();
    assert.equal(await readRunLock(paths), undefined);
  } finally {
    await cleanup();
  }
});

test("l'acquisition est atomique : un seul concurrent l'emporte", async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () => acquireRunLock(paths, 'step')),
    );
    const acquired = attempts.filter((attempt) => attempt.status === 'fulfilled');

    assert.equal(acquired.length, 1, 'un seul propriétaire simultané');
    for (const rejected of attempts.filter((attempt) => attempt.status === 'rejected')) {
      const error = (rejected as PromiseRejectedResult).reason as unknown;
      assert.ok(isCcrError(error));
      assert.equal(error.code, 'RUN_ALREADY_LOCKED');
    }

    await (acquired[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRunLock>>>).value.release();
  } finally {
    await cleanup();
  }
});

test('un second propriétaire est refusé tant que le premier est vivant', async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    const lock = await acquireRunLock(paths, 'send');
    await expectCcrError(acquireRunLock(paths, 'step'), 'RUN_ALREADY_LOCKED');
    await lock.release();

    // Une fois libéré, le run redevient acquérable.
    const second = await acquireRunLock(paths, 'step');
    await second.release();
  } finally {
    await cleanup();
  }
});

test("un processus ne supprime jamais le verrou d'un autre", async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    const lock = await acquireRunLock(paths, 'send');

    // Un autre propriétaire écrase le fichier entre-temps.
    await writeLock(paths, { lock_id: 'autre-proprietaire', pid: process.pid });
    await lock.release();

    const survivor = await readRunLock(paths);
    assert.equal(survivor?.lock_id, 'autre-proprietaire', "le verrou d'autrui est intact");
  } finally {
    await cleanup();
  }
});

test('un verrou dont le propriétaire a disparu est détecté comme périmé', async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    await writeLock(paths, { pid: DEAD_PID });
    const info = await readRunLock(paths);
    assert.ok(info);
    assert.equal(assessLiveness(info), 'STALE');

    // Aucune commande métier ne le supprime : elle échoue explicitement.
    await expectCcrError(acquireRunLock(paths, 'send'), 'STALE_LOCK');
    assert.notEqual(await readRunLock(paths), undefined, 'le verrou périmé subsiste');
  } finally {
    await cleanup();
  }
});

test("un verrou posé depuis un autre hôte n'est jamais déclaré périmé", async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    await writeLock(paths, { pid: DEAD_PID, hostname: 'une-autre-machine' });
    const info = await readRunLock(paths);
    assert.ok(info);
    assert.equal(assessLiveness(info), 'FOREIGN_HOST');

    await expectCcrError(acquireRunLock(paths, 'send'), 'RUN_ALREADY_LOCKED');
    await expectCcrError(clearStaleLock(paths), 'RUN_ALREADY_LOCKED');
    assert.notEqual(await readRunLock(paths), undefined);
  } finally {
    await cleanup();
  }
});

test('clearStaleLock refuse de supprimer un verrou vivant', async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    const lock = await acquireRunLock(paths, 'send');
    await expectCcrError(clearStaleLock(paths), 'RUN_ALREADY_LOCKED');
    assert.notEqual(await readRunLock(paths), undefined);
    await lock.release();
  } finally {
    await cleanup();
  }
});

test('clearStaleLock supprime un verrou réellement périmé', async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    await writeLock(paths, { pid: DEAD_PID, command: 'step' });
    const removed = await clearStaleLock(paths);

    assert.equal(removed?.pid, DEAD_PID);
    assert.equal(removed?.command, 'step');
    assert.equal(await readRunLock(paths), undefined);
  } finally {
    await cleanup();
  }
});

test('un fichier de verrou illisible est signalé explicitement', async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    await writeFile(lockFilePath(paths), '{"pid": ', 'utf8');
    await expectCcrError(readRunLock(paths), 'LOCK_INVALID');

    await writeFile(lockFilePath(paths), '{"pid": 12}', 'utf8');
    await expectCcrError(readRunLock(paths), 'LOCK_INVALID');
  } finally {
    await cleanup();
  }
});

test('withRunLock libère le verrou même en cas d\'échec', async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    await assert.rejects(
      withRunLock(paths, 'send', async () => {
        assert.notEqual(await readRunLock(paths), undefined, 'le verrou est tenu pendant l\'opération');
        throw new Error('échec métier');
      }),
      /échec métier/,
    );
    assert.equal(await readRunLock(paths), undefined, 'le verrou est libéré');
  } finally {
    await cleanup();
  }
});

test('isProcessAlive reconnaît le processus courant et rejette les PID absurdes', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(DEAD_PID), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});

test('le verrou reste hors des données canoniques du run', async () => {
  const { paths, cleanup } = await newRunPaths();
  try {
    const lock = await acquireRunLock(paths, 'send');
    const raw = await readFile(lockFilePath(paths), 'utf8');

    // Donnée de liveness : ni manifest, ni état, ni journal.
    assert.ok(raw.includes('"pid"'));
    assert.ok(!raw.includes('session_id'));
    assert.ok(lockFilePath(paths).endsWith('.ccr.lock'));
    await lock.release();
  } finally {
    await cleanup();
  }
});
