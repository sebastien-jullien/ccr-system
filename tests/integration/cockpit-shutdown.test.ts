/**
 * IT-5B — arrêt gracieux et incertitude des opérations longues.
 *
 * L'invariant central de ce fichier est un ordre :
 *
 * ```text
 * cesser d'admettre → fermer l'écoute → DRAINER → libérer server.lock
 * ```
 *
 * Relâcher `server.lock` pendant qu'une opération admise peut encore muter un
 * run autoriserait un second cockpit à démarrer, à déclarer l'ancienne
 * opération `UNKNOWN`, puis à voir arriver son effet. Le verrou reste donc
 * détenu tant qu'un effet canonique reste possible — même si l'agent tarde.
 *
 * Aucun fournisseur réel n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { createServer, connect } from 'node:net';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCockpit, clearStaleCockpitLock } from '../../src/cockpit/cockpit-service.ts';
import { inspectServerLock } from '../../src/cockpit/server-lock.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const CRASHER = fileURLToPath(new URL('../helpers/crash-cockpit.ts', import.meta.url));
const RUN = 'CCR-20260402-001';

function operationIdFor(key: string): string {
  return `op_${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

function call(port: number, method: string, target: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function cookieOf(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
    });
    req.on('error', reject);
    req.end();
  });
}

function mutationHeaders(port: number, cookie: string, key: string, length: number): Record<string, string> {
  return {
    Host: `127.0.0.1:${String(port)}`,
    Origin: `http://127.0.0.1:${String(port)}`,
    Cookie: cookie,
    'Content-Type': 'application/json',
    'Content-Length': String(length),
    'Idempotency-Key': key,
  };
}

async function seedRun(runsDir: string): Promise<void> {
  await materializeRun(runsDir, {
    runId: RUN,
    events: [
      { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
      { round: 1, actor: 'codex', type: 'assistant_response', session_id: 'codex-1', content: 'réponse', timestamp: T },
    ],
  });
}

async function eventCount(runsDir: string): Promise<number> {
  return (await (await openEventStore(runPaths(runsDir, RUN), RUN)).readAll()).length;
}

// --------------------------------------------------------------------------
// Arrêt gracieux
// --------------------------------------------------------------------------

test('(D1) l’arrêt draine avant de rendre le verrou de serveur', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir('ccr-drain-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await seedRun(runsDir);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', onCall: () => gate }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', onCall: () => gate }),
  };

  const port = await freePort();
  const cockpit = await startCockpit({ runsDir, port, depsOverrides: { createAdapters: () => adapters } });
  const dataRoot = resolveCockpitDataRoot(runsDir);

  try {
    const cookie = await cookieOf(port);
    const revision = (await readStableRunSnapshot(runsDir, RUN)).revision;
    const body = JSON.stringify({ expected_revision: revision });
    const accepted = await call(port, 'POST', `/api/runs/${RUN}/step`, mutationHeaders(port, cookie, 'cle-drain-000001', Buffer.byteLength(body)), body);
    assert.equal(accepted.status, 202, accepted.raw);

    // Arrêt demandé pendant que l'agent est bloqué.
    let finished = false;
    const stopping = cockpit.stop().then((outcome) => {
      finished = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    t.diagnostic(`pendant le drain : écoute=${String(await isListening(port))} · arrêt terminé=${String(finished)}`);
    assert.equal(finished, false, 'l’arrêt attend l’opération admise');
    assert.equal(await isListening(port), false, 'plus aucun client accepté');
    assert.equal((await inspectServerLock(dataRoot.serverLock)).observation, 'LOCAL_LIVE', 'le verrou reste détenu');

    // Un second cockpit ne peut pas démarrer pendant le drain.
    await assert.rejects(startCockpit({ runsDir, port: 0 }), (error: unknown) => {
      assert.ok(isCcrError(error));
      assert.equal(error.code, 'COCKPIT_ALREADY_RUNNING');
      return true;
    });

    // L'agent répond : le drain se termine, et alors seulement le verrou part.
    release();
    assert.equal(await stopping, 'RELEASED');
    assert.equal((await inspectServerLock(dataRoot.serverLock)).observation, 'NONE');
    assert.equal(cockpit.manager.activeCount(), 0);
    // L'effet canonique a bien eu lieu, et une seule fois.
    assert.ok((await eventCount(runsDir)) > 2, 'le tour s est bien déroulé');
  } finally {
    release();
    await removeTempDir(dir);
  }
});

test('(D2) pendant l’arrêt, aucune nouvelle opération longue n’est admise', async () => {
  const dir = await makeTempDir('ccr-drain-admit-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await seedRun(runsDir);

  const cockpit = await startCockpit({ runsDir, port: 0 });
  try {
    cockpit.manager.beginShutdown();
    assert.throws(() => cockpit.manager.admit('op_test'), (error: unknown) => {
      assert.ok(isCcrError(error));
      assert.equal(error.code, 'COCKPIT_SHUTTING_DOWN');
      return true;
    });
    // Le drain d'un manager sans opération active est immédiat.
    await cockpit.manager.drain();
  } finally {
    await cockpit.stop();
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Crash pendant une opération longue
// --------------------------------------------------------------------------

function launchCrasher(runsDir: string, port: number, point: string): Promise<{ port: number; exited: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASHER, runsDir, String(port), point], { stdio: 'pipe', shell: false });
    let out = '';
    let err = '';
    const exited = new Promise<void>((done) => child.on('close', () => done()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cockpit non démarré : ${out} ${err}`));
    }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = /READY (\d+)/.exec(out);
      if (match === null) return;
      clearTimeout(timer);
      resolve({ port: Number.parseInt(match[1] ?? '0', 10), exited });
    });
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function clearCrashedLock(runsDir: string): Promise<void> {
  const dataRoot = resolveCockpitDataRoot(runsDir);
  const observed = await inspectServerLock(dataRoot.serverLock);
  if (observed.observation === 'NONE') return;
  assert.equal(observed.observation, 'LOCAL_STALE');
  await clearStaleCockpitLock(runsDir, observed.info?.instance_id ?? '');
}

const CRASH_CASES = [
  { label: 'C1 — avant l’appel agent', point: 'long-before', expectEffect: false },
  { label: 'C2 — après l’effet, avant le reçu terminal', point: 'long-after', expectEffect: true },
] as const;

for (const testCase of CRASH_CASES) {
  test(`(${testCase.label}) opération longue → UNKNOWN, aucun rejeu`, { timeout: 180_000 }, async (t) => {
    const dir = await makeTempDir('ccr-long-crash-');
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    await seedRun(runsDir);

    const key = 'cle-long-crash-0001';
    const operationId = operationIdFor(key);
    const port = await freePort();

    try {
      const before = await eventCount(runsDir);
      const revision = (await readStableRunSnapshot(runsDir, RUN)).revision;

      const crasher = await launchCrasher(runsDir, port, testCase.point);
      const cookie = await cookieOf(crasher.port);
      const body = JSON.stringify({ expected_revision: revision });
      await call(crasher.port, 'POST', `/api/runs/${RUN}/step`, mutationHeaders(crasher.port, cookie, key, Buffer.byteLength(body)), body)
        .then(() => undefined, () => undefined);
      await crasher.exited;

      const afterCrash = await eventCount(runsDir);
      t.diagnostic(`événements ${String(before)} → ${String(afterCrash)} (effet attendu : ${testCase.expectEffect ? 'oui' : 'non'})`);
      if (testCase.expectEffect) {
        assert.ok(afterCrash > before, 'le tour a bien produit son effet avant le crash');
      } else {
        assert.equal(afterCrash, before, 'aucun effet : le crash précède l appel agent');
      }

      await clearCrashedLock(runsDir);
      const revived = await startCockpit({ runsDir, port: 0 });
      try {
        const cookie2 = await cookieOf(revived.server.port);
        const receipt = await call(revived.server.port, 'GET', `/api/operations/${operationId}`, {
          Host: `127.0.0.1:${String(revived.server.port)}`,
          Cookie: cookie2,
        });
        assert.equal(receipt.body['status'], 'UNKNOWN', receipt.raw);

        // Retransmission : le même verdict, aucun second appel, aucun effet.
        const replayBody = JSON.stringify({ expected_revision: revision });
        const replay = await call(
          revived.server.port,
          'POST',
          `/api/runs/${RUN}/step`,
          mutationHeaders(revived.server.port, cookie2, key, Buffer.byteLength(replayBody)),
          replayBody,
        );
        assert.equal(replay.body['status'], 'UNKNOWN');
        assert.equal(replay.body['operation_id'], operationId);
        assert.equal(await eventCount(runsDir), afterCrash, 'aucun effet supplémentaire');
        assert.equal(revived.manager.activeCount(), 0, 'aucun créneau consommé par la retransmission');
      } finally {
        await revived.stop();
      }
    } finally {
      await removeTempDir(dir);
    }
  });
}

test('(C4) réponse HTTP perdue : l’opération continue, la retransmission ne rejoue rien', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir('ccr-lost-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await seedRun(runsDir);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({
      kind: 'claude',
      sessionId: 'claude-1',
      onCall: () => {
        calls += 1;
        return gate;
      },
    }),
    codex: createFakeAdapter({
      kind: 'codex',
      sessionId: 'codex-1',
      onCall: () => {
        calls += 1;
        return gate;
      },
    }),
  };

  const cockpit = await startCockpit({ runsDir, port: 0, depsOverrides: { createAdapters: () => adapters } });
  const port = cockpit.server.port;
  try {
    const cookie = await cookieOf(port);
    const revision = (await readStableRunSnapshot(runsDir, RUN)).revision;
    const key = 'cle-perdue-000001';
    const body = JSON.stringify({ expected_revision: revision });

    // Connexion coupée avant la réception de la réponse : le client ne saura
    // jamais que son opération a été admise.
    await new Promise<void>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port, path: `/api/runs/${RUN}/step`, method: 'POST', headers: mutationHeaders(port, cookie, key, Buffer.byteLength(body)) },
        () => undefined,
      );
      req.on('error', () => resolve());
      req.write(body);
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 120);
    });

    // Le serveur, lui, poursuit.
    for (let i = 0; i < 200 && calls === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    t.diagnostic(`appels agent après perte de la réponse : ${String(calls)} · créneaux=${String(cockpit.manager.activeCount())}`);
    assert.equal(calls, 1, 'l’opération continue malgré la connexion perdue');

    // Retransmission : jamais une seconde admission, jamais un second agent.
    const replay = await call(port, 'POST', `/api/runs/${RUN}/step`, mutationHeaders(port, cookie, key, Buffer.byteLength(body)), body);
    assert.equal(replay.body['operation_id'], operationIdFor(key));
    assert.equal(replay.body['status'], 'RUNNING');
    assert.equal(cockpit.manager.activeCount(), 1, 'toujours un seul créneau');
    assert.equal(calls, 1, 'toujours un seul appel agent');

    release();
    for (let i = 0; i < 400 && cockpit.manager.activeCount() > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(cockpit.manager.activeCount(), 0);
  } finally {
    release();
    await cockpit.stop();
    await removeTempDir(dir);
  }
});
