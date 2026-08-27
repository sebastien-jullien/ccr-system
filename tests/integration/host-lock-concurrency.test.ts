/**
 * IT-0D — sémantique des verrous en hôte long-lived, sur processus réels.
 *
 * Ce que les seams ne prouvent pas : un vrai verrou posé par un vrai processus
 * Windows, observé par un vrai lecteur, produit la bonne évidence — et rien
 * n'est jamais supprimé.
 *
 * Quatre preuves :
 *
 *  A. CLI externe vivante détenant le verrou ;
 *  B. opération de l'hôte lui-même, verrou et registre liés ;
 *  C. verrou orphelin portant le PID courant ;
 *  D. registre et verrou désaccordés (identité différente).
 *
 * Plus un stress multi-run dans un unique processus hôte.
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';


import { createHostOperationRegistry } from '../../src/lock/host-operation-registry.ts';
import type { HostOperationRegistry } from '../../src/lock/host-operation-registry.ts';
import { observeRunExecution } from '../../src/lock/run-execution-evidence.ts';
import { lockFilePath, withRunLock } from '../../src/lock/run-lock.ts';
import type { RunLockInfo } from '../../src/lock/run-lock.ts';
import { classifyRunLiveness } from '../../src/core/run-liveness.ts';
import { STATE_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { PendingOperation, RunManifest, RunStateDocument } from '../../src/core/run.ts';
import { runPaths } from '../../src/store/layout.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260402-001';
const T0 = '2026-08-08T00:00:00.000Z';

/**
 * Horodatage d'opération postérieur au verrou réel.
 *
 * Les verrous posés ici portent l'heure réelle : une opération datée d'une
 * constante figée serait antérieure au verrou, et la correspondance de §13 la
 * rejetterait — à juste titre.
 */
function laterThanNow(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

/** URL `file://` : un chemin Windows brut n'est pas importable dynamiquement. */
const LOCK_MODULE = new URL('../../src/lock/run-lock.ts', import.meta.url).href;

function manifestOf(): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'T',
    created_at: T0,
    workspace: { cwd: 'E:/prog/exemple' },
    agents: {
      claude: { session_id: 'claude-1', role: 'challenger' },
      codex: { session_id: 'codex-1', role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
  };
}

function pendingOf(startedAt: string): PendingOperation {
  return {
    kind: 'step',
    agent: 'claude',
    round: 1,
    prompt_event_id: 'evt_000004',
    source_event_id: 'evt_000003',
    session_id: 'claude-1',
    return_state: 'READY',
    return_control: 'AUTOMATION',
    started_at: startedAt,
  };
}

function stateOf(pending: PendingOperation | null): RunStateDocument {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: RUN_ID,
    state: 'WAITING_AGENT',
    control: 'AUTOMATION',
    round: 1,
    active_agent: 'claude',
    last_event_id: 'evt_000004',
    pending_operation: pending,
    uncertainty: null,
    updated_at: T0,
  };
}

async function prepare(prefix: string, runId = RUN_ID): Promise<{ dir: string; paths: ReturnType<typeof runPaths> }> {
  const dir = await makeTempDir(prefix);
  const paths = runPaths(dir, runId);
  await mkdir(paths.root, { recursive: true });
  return { dir, paths };
}

/**
 * Processus externe : acquiert un VRAI run lock via le module de production,
 * signale qu'il le détient, puis attend avant de le libérer.
 */
const EXTERNAL_HOLDER = `
const [modulePath, runRoot, holdMs] = process.argv.slice(1);
import(modulePath).then(async (lock) => {
  const paths = { runId: 'X', root: runRoot };
  const handle = await lock.acquireRunLock(paths, 'step');
  process.stdout.write('LOCKED\\n');
  setTimeout(async () => {
    await handle.release();
    process.exit(0);
  }, Number(holdMs));
});
`;

interface Holder {
  readonly locked: Promise<void>;
  readonly done: Promise<void>;
  kill(): void;
}

function externalHolder(runRoot: string, holdMs: number): Holder {
  const child = spawn(process.execPath, ['--input-type=module', '-e', EXTERNAL_HOLDER, LOCK_MODULE, runRoot, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  const locked = new Promise<void>((resolve, reject) => {
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('LOCKED')) resolve();
    });
    child.once('close', () => reject(new Error('le détenteur externe est mort avant d’acquérir')));
    child.once('error', reject);
  });
  const done = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  return { locked, done, kill: () => child.kill() };
}

// --------------------------------------------------------------------------

test('A. une CLI externe vivante détient le verrou : ni stale, ni supprimé', { timeout: 60_000 }, async (t) => {
  const { dir, paths } = await prepare('ccr-0d-ext-');
  try {
    const holder = externalHolder(paths.root, 3_000);
    await holder.locked;

    const before = await readFile(lockFilePath(paths), 'utf8');
    const observed = await observeRunExecution(paths, {
      registry: createHostOperationRegistry(),
      pendingOperation: pendingOf(laterThanNow()),
    });

    t.diagnostic(
      `observation=${observed.observation} · pid verrou=${String(observed.lock?.pid)} · ` +
        `pid lecteur=${String(process.pid)}`,
    );

    assert.equal(observed.observation, 'ACTIVE_EXTERNAL_LOCK', 'jamais qualifié périmé');
    assert.equal(observed.evidence.lock, 'ALIVE_OTHER_PROCESS');
    assert.notEqual(observed.lock?.pid, process.pid, 'c’est bien un autre processus');

    // L'opération persistée est postérieure au verrou et de même nature :
    // la correspondance est établie, donc l'opération est en vol.
    const verdict = classifyRunLiveness(
      { manifest: manifestOf(), state: stateOf(pendingOf(laterThanNow())), pendingResponseJournaled: false },
      observed.evidence,
    );
    assert.equal(verdict.liveness, 'OPERATION_IN_FLIGHT');

    assert.equal(await readFile(lockFilePath(paths), 'utf8'), before, 'aucune suppression');

    holder.kill();
    await holder.done;
  } finally {
    await removeTempDir(dir);
  }
});

test('B. opération de l’hôte : verrou et registre liés → activité démontrée', { timeout: 60_000 }, async (t) => {
  const { dir, paths } = await prepare('ccr-0d-host-');
  try {
    const registry = createHostOperationRegistry();
    const hostOperationId = registry.begin(paths.runId, 'step');

    let observedDuring: Awaited<ReturnType<typeof observeRunExecution>> | undefined;

    await withRunLock(
      paths,
      'step',
      async () => {
        // Lecture PENDANT l'opération, comme le ferait un cockpit.
        observedDuring = await observeRunExecution(paths, {
          registry,
          pendingOperation: pendingOf(laterThanNow()),
        });
      },
      {
        onAcquired: (info) => registry.bindLock(hostOperationId, info.lock_id),
        onReleased: () => registry.end(hostOperationId),
      },
    );

    assert.ok(observedDuring !== undefined);
    t.diagnostic(`observation pendant l'opération = ${observedDuring.observation}`);
    assert.equal(observedDuring.observation, 'ACTIVE_HOST_OPERATION');
    assert.equal(observedDuring.evidence.hostOperation, 'ACTIVE');

    const verdict = classifyRunLiveness(
      { manifest: manifestOf(), state: stateOf(pendingOf(laterThanNow())), pendingResponseJournaled: false },
      observedDuring.evidence,
    );
    assert.equal(verdict.liveness, 'OPERATION_IN_FLIGHT');

    // Après completion : registre vide, verrou libéré.
    assert.equal(registry.size(), 0, 'aucune fuite');
    const after = await observeRunExecution(paths, { registry });
    assert.equal(after.observation, 'NO_LOCK');
  } finally {
    await removeTempDir(dir);
  }
});

test('C. verrou orphelin portant le PID courant : jamais actif, jamais supprimé', { timeout: 60_000 }, async (t) => {
  const { dir, paths } = await prepare('ccr-0d-orphan-');
  try {
    // Un verrou de CE processus qu'aucune opération ne revendique — exactement
    // ce que laisserait une libération manquée.
    const orphan: RunLockInfo = {
      lock_id: 'lock-abandonne',
      pid: process.pid,
      hostname: hostname(),
      started_at: T0,
      command: 'step',
    };
    await writeFile(lockFilePath(paths), `${JSON.stringify(orphan, null, 2)}\n`, 'utf8');
    const before = await readFile(lockFilePath(paths), 'utf8');

    const observed = await observeRunExecution(paths, {
      registry: createHostOperationRegistry(),
      pendingOperation: pendingOf(laterThanNow()),
    });

    t.diagnostic(`observation=${observed.observation} (PID identique au lecteur)`);
    assert.equal(observed.observation, 'ORPHAN_SAME_PID_LOCK');
    assert.notEqual(observed.evidence.hostOperation, 'ACTIVE', 'l’égalité de PID ne suffit jamais');

    const verdict = classifyRunLiveness(
      { manifest: manifestOf(), state: stateOf(pendingOf(laterThanNow())), pendingResponseJournaled: false },
      observed.evidence,
    );
    assert.equal(verdict.liveness, 'ORPHAN_LOCK');

    assert.equal(await readFile(lockFilePath(paths), 'utf8'), before, 'fichier inchangé');
  } finally {
    await removeTempDir(dir);
  }
});

test('D. registre et verrou désaccordés : jamais considéré actif', { timeout: 60_000 }, async (t) => {
  const { dir, paths } = await prepare('ccr-0d-mismatch-');
  try {
    const registry = createHostOperationRegistry();
    // Le registre connaît une opération liée au verrou L2…
    const operation = registry.begin(paths.runId, 'step');
    registry.bindLock(operation, 'lock-L2');

    // …mais le disque porte L1, du même PID et du même run.
    const l1: RunLockInfo = {
      lock_id: 'lock-L1',
      pid: process.pid,
      hostname: hostname(),
      started_at: T0,
      command: 'step',
    };
    await writeFile(lockFilePath(paths), `${JSON.stringify(l1, null, 2)}\n`, 'utf8');

    const observed = await observeRunExecution(paths, {
      registry,
      pendingOperation: pendingOf(laterThanNow()),
    });
    t.diagnostic(`observation=${observed.observation} · registre lié à lock-L2, disque porte lock-L1`);
    assert.equal(observed.observation, 'ORPHAN_SAME_PID_LOCK');
    assert.notEqual(observed.evidence.hostOperation, 'ACTIVE');
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Stress multi-run dans un unique hôte
// --------------------------------------------------------------------------

test('stress borné — plusieurs runs, un seul processus hôte', { timeout: 120_000 }, async (t) => {
  const RUNS = 6;
  const OPERATIONS_PER_RUN = 20;

  const dir = await makeTempDir('ccr-0d-stress-');
  try {
    const registry = createHostOperationRegistry();
    const runIds = Array.from({ length: RUNS }, (_, i) => `CCR-20260808-${String(i + 1).padStart(3, '0')}`);
    for (const runId of runIds) await mkdir(runPaths(dir, runId).root, { recursive: true });

    let observations = 0;
    let falseActive = 0;
    let falseOrphan = 0;

    await Promise.all(
      runIds.map(async (runId) => {
        const paths = runPaths(dir, runId);
        for (let i = 0; i < OPERATIONS_PER_RUN; i += 1) {
          const hostOperationId = registry.begin(runId, 'step');
          await withRunLock(
            paths,
            'step',
            async () => {
              // Pendant l'opération : ce run doit être ACTIF…
              const self = await observeRunExecution(paths, { registry, pendingOperation: pendingOf(laterThanNow()) });
              observations += 1;
              if (self.observation !== 'ACTIVE_HOST_OPERATION') falseOrphan += 1;

              // …et un AUTRE run ne doit jamais hériter de cette évidence.
              const other = runPaths(dir, runIds[(runIds.indexOf(runId) + 1) % RUNS] as string);
              const cross = await observeRunExecution(other, { registry, pendingOperation: pendingOf(laterThanNow()) });
              observations += 1;
              if (cross.observation === 'ACTIVE_HOST_OPERATION' && cross.lock?.lock_id === self.lock?.lock_id) {
                falseActive += 1;
              }
            },
            {
              onAcquired: (info) => registry.bindLock(hostOperationId, info.lock_id),
              onReleased: () => registry.end(hostOperationId),
            },
          );
        }
      }),
    );

    t.diagnostic(
      `runs=${String(RUNS)} · opérations=${String(RUNS * OPERATIONS_PER_RUN)} · ` +
        `observations=${String(observations)} · false-active=${String(falseActive)} · ` +
        `false-orphan=${String(falseOrphan)} · registry leak=${String(registry.size())}`,
    );

    assert.equal(falseActive, 0, 'aucune évidence d’un run attribuée à un autre');
    assert.equal(falseOrphan, 0, 'aucune opération légitime déclarée orpheline');
    assert.equal(registry.size(), 0, 'aucune entrée résiduelle');
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Concurrence naturelle pendant acquisition et libération (mini-gate 0D)
//
// Complément aux seams déterministes : des observations réellement
// entrelacées par la boucle d'événements, sur un vrai fichier `.ccr.lock`.
// --------------------------------------------------------------------------

test(
  'E. observations entrelacées pendant acquisition et libération répétées',
  { timeout: 120_000 },
  async (t) => {
    const { dir, paths } = await prepare('ccr-0d-interleave-');
    try {
      const { createHostOperationRegistry: makeRegistry } = await import(
        '../../src/lock/host-operation-registry.ts'
      );
      const registry = makeRegistry();
      const pending = pendingOf(laterThanNow());

      let observations = 0;
      let falseOrphan = 0;
      let falseAbandoned = 0;
      let stop = false;

      // Lecteur concurrent : boucle serrée, sans coordination avec l'écrivain.
      const reader = (async () => {
        while (!stop) {
          const observed = await observeRunExecution(paths, { registry, pendingOperation: pending });
          observations += 1;
          // Pendant une acquisition/libération normale, aucune conclusion
          // d'incident ne doit être produite.
          if (observed.observation === 'ORPHAN_SAME_PID_LOCK') falseOrphan += 1;
          // `NO_LOCK` entre deux opérations est **factuel** : aucun verrou
          // n'est détenu à cet instant. Seule une observation hors du domaine
          // attendu serait un défaut.
          if (!['NO_LOCK', 'ACTIVE_HOST_OPERATION', 'INDETERMINATE_LOCK'].includes(observed.observation)) {
            falseAbandoned += 1;
          }
        }
      })();

      for (let i = 0; i < 60; i += 1) {
        const op = registry.begin(paths.runId, 'step');
        await withRunLock(paths, 'step', async () => undefined, {
          onIdentityPrepared: (info) => registry.bindLock(op, info.lock_id),
          onAcquireFailed: () => registry.end(op),
          onReleased: () => registry.end(op),
        });
      }

      stop = true;
      await reader;

      t.diagnostic(
        `acquisitions=60 · observations=${String(observations)} · ` +
          `faux orphelins=${String(falseOrphan)} · hors domaine=${String(falseAbandoned)} · ` +
          `registre résiduel=${String(registry.size())}`,
      );

      assert.ok(observations > 10, 'les observations ont bien été entrelacées');
      assert.equal(falseOrphan, 0, 'aucun faux orphelin pendant un cycle de vie normal');
      assert.equal(falseAbandoned, 0, 'aucune observation hors du domaine attendu');
      assert.equal(registry.size(), 0, 'aucune entrée résiduelle');
    } finally {
      await removeTempDir(dir);
    }
  },
);

/**
 * F. Rotation rapide du verrou — le verdict « orphelin » ne s'échappe pas.
 *
 * Régression du faux orphelin mesuré au gate pré-Slice 2 : la reconfirmation
 * relisait le verrou, constatait un `lock_id` différent, et **retournait
 * directement** la nouvelle classification. Ce reclassement pouvait à son tour
 * être périmé et publier `ORPHAN_SAME_PID_LOCK` sans avoir jamais été confirmé.
 *
 * La rotation est pilotée **par la lecture elle-même** : chaque consultation du
 * registre réécrit le verrou avec une identité neuve. Aucune fenêtre temporelle
 * n'est supposée — une première version de ce test faisait tourner un
 * réécrivain concurrent et échouait sous charge, parce que la toute première
 * observation précédait la rotation : le verrou était alors réellement stable
 * et non revendiqué, et `ORPHAN` était le bon verdict. La prémisse était
 * fausse, pas l'assertion.
 *
 * Registre volontairement vide : chaque lecture est donc « orpheline », et
 * aucune n'est jamais confirmée deux fois sur la même identité. Un verrou
 * réellement abandonné étant **stable**, l'instabilité doit interdire la
 * conclusion — pas la fabriquer.
 */
test('(F) verrou en rotation : jamais ORPHAN, jamais ACTIVE inventé', async (t) => {
  const dir = await makeTempDir('ccr-lock-churn-');
  try {
    const paths = runPaths(dir, RUN_ID);
    await mkdir(paths.root, { recursive: true });
    const file = lockFilePath(paths);

    let rewrites = 0;
    const rotate = (): void => {
      const info: RunLockInfo = {
        lock_id: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        started_at: new Date().toISOString(),
        command: 'step',
      };
      writeFileSync(file, `${JSON.stringify(info, null, 2)}
`, 'utf8');
      rewrites += 1;
    };
    rotate();

    /**
     * Registre vide dont la consultation fait tourner le verrou.
     *
     * Garantit l'instabilité que le scheduler ne peut pas garantir : le verrou
     * lu ne sera jamais celui relu.
     */
    const churningRegistry: HostOperationRegistry = {
      begin: () => randomUUID(),
      bindLock: () => undefined,
      end: () => undefined,
      find: () => {
        rotate();
        return undefined;
      },
      active: () => [],
      size: () => 0,
    };

    const seen: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const observation = await observeRunExecution(paths, { registry: churningRegistry });
      seen.push(observation.observation);
    }

    t.diagnostic(`réécritures=${rewrites} · verdicts=${[...new Set(seen)].join(',')}`);

    assert.equal(
      seen.filter((o) => o === 'ORPHAN_SAME_PID_LOCK').length,
      0,
      'aucun verrou instable ne doit être déclaré orphelin',
    );
    assert.equal(
      seen.filter((o) => o === 'ACTIVE_HOST_OPERATION').length,
      0,
      "et aucune activité ne doit être inventée : le registre est vide",
    );
    assert.ok(
      seen.every((o) => o === 'INDETERMINATE_LOCK'),
      `verdict honnête attendu, obtenu : ${[...new Set(seen)].join(',')}`,
    );
  } finally {
    await removeTempDir(dir);
  }
});
