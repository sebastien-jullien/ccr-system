/**
 * `server.lock` — unicité, refus, et non-suppression (Slice 2, §6, §8, §9, §36).
 *
 * La propriété centrale n'est pas « le verrou fonctionne » mais « le verrou
 * n'est **jamais** supprimé automatiquement ». Chaque refus est donc vérifié
 * avec la survie du fichier, pas seulement avec le code d'erreur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import type { CockpitDataRoot } from '../../src/cockpit/data-root.ts';
import {
  SERVER_LOCK_SCHEMA_VERSION,
  acquireServerLock,
  clearStaleServerLock,
  inspectServerLock,
} from '../../src/cockpit/server-lock.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

/** PID libre avec une probabilité écrasante : sert de propriétaire disparu. */
const DEAD_PID = 999_998;

async function box(): Promise<{ root: CockpitDataRoot; cleanup(): Promise<void> }> {
  const dir = await makeTempDir('ccr-slock-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  return { root: resolveCockpitDataRoot(runsDir), cleanup: () => removeTempDir(dir) };
}

async function writeLock(root: CockpitDataRoot, patch: Record<string, unknown>): Promise<string> {
  await mkdir(root.controlDir, { recursive: true });
  const instanceId = String(patch['instance_id'] ?? randomUUID());
  const info = {
    schema_version: SERVER_LOCK_SCHEMA_VERSION,
    instance_id: instanceId,
    pid: DEAD_PID,
    hostname: hostname(),
    created_at: new Date().toISOString(),
    ...patch,
  };
  await writeFile(root.serverLock, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  return instanceId;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isCcrError(error), `CcrError attendue, reçu ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

// --------------------------------------------------------------------------
// Acquisition
// --------------------------------------------------------------------------

test('(L1) acquisition : schéma versionné et identité complète', async () => {
  const b = await box();
  try {
    const lock = await acquireServerLock(b.root);
    const raw: unknown = JSON.parse(await readFile(b.root.serverLock, 'utf8'));

    assert.deepEqual(raw, {
      schema_version: SERVER_LOCK_SCHEMA_VERSION,
      instance_id: lock.info.instance_id,
      pid: process.pid,
      hostname: hostname(),
      created_at: lock.info.created_at,
    });
    // Le port n'entre pas dans l'identité : l'unicité porte sur le data root.
    assert.equal(Object.keys(raw as object).includes('port'), false);

    assert.equal(await lock.release(), 'RELEASED');
    assert.equal(await exists(b.root.serverLock), false);
  } finally {
    await b.cleanup();
  }
});

test('(L2) seconde acquisition : COCKPIT_ALREADY_RUNNING, verrou intact', async () => {
  const b = await box();
  try {
    const first = await acquireServerLock(b.root);
    const before = await readFile(b.root.serverLock, 'utf8');

    await expectCode(acquireServerLock(b.root), 'COCKPIT_ALREADY_RUNNING');

    assert.equal(await readFile(b.root.serverLock, 'utf8'), before, 'verrou inchangé');
    await first.release();
  } finally {
    await b.cleanup();
  }
});

test('(L3) verrou périmé : refus, et surtout aucune suppression', async () => {
  const b = await box();
  try {
    await writeLock(b.root, {});
    const before = await readFile(b.root.serverLock, 'utf8');

    await expectCode(acquireServerLock(b.root), 'COCKPIT_SERVER_LOCK_STALE');

    assert.equal(await readFile(b.root.serverLock, 'utf8'), before, 'un stale démontré ne s’auto-supprime pas');
  } finally {
    await b.cleanup();
  }
});

test('(L4) verrou étranger et verrou illisible : refus, jamais supprimés', async () => {
  const b = await box();
  try {
    await writeLock(b.root, { hostname: 'AUTRE-HOTE', pid: process.pid });
    await expectCode(acquireServerLock(b.root), 'COCKPIT_SERVER_LOCK_FOREIGN');
    assert.equal(await exists(b.root.serverLock), true);

    await writeFile(b.root.serverLock, '{ pas du json', 'utf8');
    await expectCode(acquireServerLock(b.root), 'COCKPIT_SERVER_LOCK_INDETERMINATE');
    assert.equal(await exists(b.root.serverLock), true);

    // Schéma futur : indéterminable, donc refusé sans suppression.
    await writeLock(b.root, { schema_version: 99 });
    await expectCode(acquireServerLock(b.root), 'COCKPIT_SERVER_LOCK_INDETERMINATE');
    assert.equal(await exists(b.root.serverLock), true);
  } finally {
    await b.cleanup();
  }
});

test('(L5) inspection : cinq situations distinguées', async () => {
  const b = await box();
  try {
    assert.equal((await inspectServerLock(b.root.serverLock)).observation, 'NONE');

    const live = await acquireServerLock(b.root);
    assert.equal((await inspectServerLock(b.root.serverLock)).observation, 'LOCAL_LIVE');
    await live.release();

    await writeLock(b.root, {});
    assert.equal((await inspectServerLock(b.root.serverLock)).observation, 'LOCAL_STALE');

    await writeLock(b.root, { hostname: 'AUTRE-HOTE' });
    assert.equal((await inspectServerLock(b.root.serverLock)).observation, 'FOREIGN');

    await writeFile(b.root.serverLock, 'nawak', 'utf8');
    assert.equal((await inspectServerLock(b.root.serverLock)).observation, 'INDETERMINATE');
  } finally {
    await b.cleanup();
  }
});

test('(L6) libération : seul le propriétaire supprime', async () => {
  const b = await box();
  try {
    const mine = await acquireServerLock(b.root);
    // Un autre processus a remplacé le verrou entre-temps.
    await writeLock(b.root, { pid: process.pid });

    assert.equal(await mine.release(), 'NOT_OWNER');
    assert.equal(await exists(b.root.serverLock), true, 'le verrou d’autrui survit');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Levée humaine explicite
// --------------------------------------------------------------------------

test('(L7) levée : identité exacte + local + périmé → suppression', async () => {
  const b = await box();
  try {
    const instanceId = await writeLock(b.root, {});
    const removed = await clearStaleServerLock(b.root, instanceId);

    assert.equal(removed.instance_id, instanceId);
    assert.equal(await exists(b.root.serverLock), false);
  } finally {
    await b.cleanup();
  }
});

test('(L8) levée refusée : identité fausse, verrou vivant, étranger, absent', async () => {
  const b = await box();
  try {
    // Identité fausse.
    await writeLock(b.root, {});
    await expectCode(clearStaleServerLock(b.root, randomUUID()), 'COCKPIT_SERVER_LOCK_IDENTITY_MISMATCH');
    assert.equal(await exists(b.root.serverLock), true);

    // Vivant, même avec la bonne identité.
    const liveId = await writeLock(b.root, { pid: process.pid });
    await expectCode(clearStaleServerLock(b.root, liveId), 'COCKPIT_ALREADY_RUNNING');
    assert.equal(await exists(b.root.serverLock), true);

    // Étranger, même avec la bonne identité.
    const foreignId = await writeLock(b.root, { hostname: 'AUTRE-HOTE' });
    await expectCode(clearStaleServerLock(b.root, foreignId), 'COCKPIT_SERVER_LOCK_FOREIGN');
    assert.equal(await exists(b.root.serverLock), true);

    // Illisible : aucune identité ne peut être « la bonne ».
    await writeFile(b.root.serverLock, '???', 'utf8');
    await expectCode(clearStaleServerLock(b.root, randomUUID()), 'COCKPIT_SERVER_LOCK_INDETERMINATE');
    assert.equal(await exists(b.root.serverLock), true);
  } finally {
    await b.cleanup();
  }
});

test('(L9) levée : verrou absent → refus explicite, pas un succès silencieux', async () => {
  const b = await box();
  try {
    await expectCode(clearStaleServerLock(b.root, randomUUID()), 'COCKPIT_SERVER_LOCK_NOT_FOUND');
  } finally {
    await b.cleanup();
  }
});

test('(L10) TOCTOU : un cockpit démarre entre le constat et la levée → aucune suppression', async () => {
  const b = await box();
  try {
    const staleId = await writeLock(b.root, {});
    let replacement: string | undefined;

    await expectCode(
      clearStaleServerLock(b.root, staleId, {
        // Exactement la fenêtre visée : le verrou périmé disparaît et un
        // cockpit vivant prend sa place.
        onObserved: async () => {
          replacement = await writeLock(b.root, { pid: process.pid });
        },
      }),
      'COCKPIT_SERVER_LOCK_CHANGED',
    );

    const after = await inspectServerLock(b.root.serverLock);
    assert.equal(after.observation, 'LOCAL_LIVE');
    assert.equal(after.info?.instance_id, replacement, 'le verrou vivant est intact');
  } finally {
    await b.cleanup();
  }
});

test('(L11) TOCTOU : même identité mais verrou réécrit → aucune suppression', async () => {
  const b = await box();
  try {
    const staleId = await writeLock(b.root, {});

    await expectCode(
      clearStaleServerLock(b.root, staleId, {
        // Identité conservée, propriétaire différent : ce n'est plus le même
        // verrou, et un PID seul ne l'autorise pas.
        onObserved: async () => {
          await writeLock(b.root, { instance_id: staleId, pid: DEAD_PID - 1 });
        },
      }),
      'COCKPIT_SERVER_LOCK_CHANGED',
    );

    assert.equal(await exists(b.root.serverLock), true);
  } finally {
    await b.cleanup();
  }
});
