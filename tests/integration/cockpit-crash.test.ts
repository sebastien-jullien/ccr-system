/**
 * IT-4B — incertitude après crash : `UNKNOWN`, jamais un rejeu.
 *
 * Trois situations, sur des **processus réels** tués sans préavis :
 *
 * ```text
 * C1  crash après le claim, avant l'effet   → on ne sait pas s'il a eu lieu
 * C2  crash après l'effet, avant le reçu    → on ne sait pas s'il a eu lieu
 * C3  succès normal                         → SUCCEEDED, durable
 * ```
 *
 * Dans les deux premiers cas, la réponse honnête est la même : `UNKNOWN`. CCR
 * n'essaie pas de deviner depuis les événements — un tour peut avoir produit
 * son effet sans que le reçu ait été écrit, et l'inverse est vrai aussi.
 *
 * L'`operation_id` étant dérivé du condensat de la clé, le test peut le
 * recalculer sans jamais avoir reçu la réponse du processus mort. C'est une
 * propriété du format, pas un artifice de test.
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCockpit, clearStaleCockpitLock } from '../../src/cockpit/cockpit-service.ts';
import { inspectServerLock } from '../../src/cockpit/server-lock.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { openEventStore } from '../../src/store/event-store.ts';
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

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function call(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
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

/** Lance le cockpit suicidaire et attend qu'il annonce son port. */
function launchCrasher(runsDir: string, port: number, point: string): Promise<{ port: number; exited: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASHER, runsDir, String(port), point], { stdio: 'pipe', shell: false });
    let out = '';
    let err = '';
    const exited = new Promise<void>((done) => child.on('close', () => done()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cockpit suicidaire non démarré : ${out} ${err}`));
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

async function eventCount(runsDir: string): Promise<number> {
  const events = await openEventStore(runPaths(runsDir, RUN), RUN);
  return (await events.readAll()).length;
}

/** Lève le verrou de serveur laissé par le processus mort. */
async function clearCrashedLock(runsDir: string): Promise<void> {
  const dataRoot = resolveCockpitDataRoot(runsDir);
  const observed = await inspectServerLock(dataRoot.serverLock);
  if (observed.observation === 'NONE') return;
  assert.equal(observed.observation, 'LOCAL_STALE', 'le verrou du processus mort survit — comportement attendu');
  await clearStaleCockpitLock(runsDir, observed.info?.instance_id ?? '');
}

interface CrashCase {
  readonly label: string;
  readonly point: string;
  /** Nombre d'événements attendu après le crash. */
  readonly effectApplied: boolean;
}

const CASES: readonly CrashCase[] = [
  { label: 'C1 — crash après le claim, avant l’effet', point: 'before-lock', effectApplied: false },
  { label: 'C2 — crash après l’effet, avant le reçu terminal', point: 'after-effect', effectApplied: true },
];

for (const testCase of CASES) {
  test(`(${testCase.label}) → UNKNOWN, aucun rejeu`, { timeout: 180_000 }, async (t) => {
    const dir = await makeTempDir('ccr-crash-');
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    await materializeRun(runsDir, {
      runId: RUN,
      events: [{ round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T }],
    });

    const key = 'cle-crash-000000001';
    const operationId = operationIdFor(key);
    const port = await freePort();

    try {
      const before = await eventCount(runsDir);
      const revision = (await readStableRunSnapshot(runsDir, RUN)).revision;

      // 1. Le cockpit suicidaire reçoit la mutation et meurt en plein vol.
      const crasher = await launchCrasher(runsDir, port, testCase.point);
      const cookie = await cookieOf(crasher.port);
      const body = JSON.stringify({ expected_revision: revision });
      await call(crasher.port, 'POST', `/api/runs/${RUN}/pause`, mutationHeaders(crasher.port, cookie, key, Buffer.byteLength(body)), body)
        .then(
          () => assert.fail('le processus aurait dû mourir avant de répondre'),
          () => undefined,
        );
      await crasher.exited;

      const afterCrash = await eventCount(runsDir);
      t.diagnostic(`événements ${String(before)} → ${String(afterCrash)} (effet ${testCase.effectApplied ? 'appliqué' : 'absent'})`);
      assert.equal(afterCrash, testCase.effectApplied ? before + 1 : before, 'effet canonique conforme au point de crash');

      // 2. Redémarrage : le verrou du mort est levé explicitement, jamais seul.
      await clearCrashedLock(runsDir);
      const revived = await startCockpit({ runsDir, port: 0 });
      try {
        const cookie2 = await cookieOf(revived.server.port);

        // 3. Le reçu appartient à une instance disparue : verdict honnête.
        const receipt = await call(revived.server.port, 'GET', `/api/operations/${operationId}`, {
          Host: `127.0.0.1:${String(revived.server.port)}`,
          Cookie: cookie2,
        });
        assert.equal(receipt.status, 200);
        assert.equal(receipt.body['status'], 'UNKNOWN', 'ni succès, ni échec : on ne sait pas');

        // 4. Retransmission : le même verdict, et surtout aucun rejeu.
        const replayBody = JSON.stringify({ expected_revision: revision });
        const replay = await call(
          revived.server.port,
          'POST',
          `/api/runs/${RUN}/pause`,
          mutationHeaders(revived.server.port, cookie2, key, Buffer.byteLength(replayBody)),
          replayBody,
        );
        assert.equal(replay.status, 200);
        assert.equal(replay.body['status'], 'UNKNOWN');
        assert.equal(replay.body['operation_id'], operationId);
        assert.equal(await eventCount(runsDir), afterCrash, 'aucun effet supplémentaire');
      } finally {
        await revived.stop();
      }
    } finally {
      await removeTempDir(dir);
    }
  });
}

test('(C3) succès normal : SUCCEEDED durable, retransmis à l’identique', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir('ccr-crash-ok-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: RUN,
    events: [{ round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T }],
  });

  const key = 'cle-succes-00000001';
  const operationId = operationIdFor(key);

  try {
    const first = await startCockpit({ runsDir, port: 0 });
    let revisionAfter: unknown;
    try {
      const cookie = await cookieOf(first.server.port);
      const revision = (await readStableRunSnapshot(runsDir, RUN)).revision;
      const body = JSON.stringify({ expected_revision: revision });
      const result = await call(
        first.server.port,
        'POST',
        `/api/runs/${RUN}/pause`,
        mutationHeaders(first.server.port, cookie, key, Buffer.byteLength(body)),
        body,
      );
      assert.equal(result.status, 200);
      assert.equal(result.body['status'], 'SUCCEEDED');
      revisionAfter = result.body['revision_after'];
    } finally {
      await first.stop();
    }

    // Redémarrage propre : le reçu survit et garde son verdict.
    const second = await startCockpit({ runsDir, port: 0 });
    try {
      const cookie = await cookieOf(second.server.port);
      const receipt = await call(second.server.port, 'GET', `/api/operations/${operationId}`, {
        Host: `127.0.0.1:${String(second.server.port)}`,
        Cookie: cookie,
      });
      t.diagnostic(`après redémarrage : ${String(receipt.body['status'])}`);
      assert.equal(receipt.body['status'], 'SUCCEEDED', 'un succès terminal ne devient pas UNKNOWN');
      assert.equal(receipt.body['revision_after'], revisionAfter);

      const events = await eventCount(runsDir);
      const replayBody = JSON.stringify({ expected_revision: `sha256:${'e'.repeat(64)}` });
      // Même clé, autre intention : refus, et surtout aucun effet.
      const replay = await call(
        second.server.port,
        'POST',
        `/api/runs/${RUN}/pause`,
        mutationHeaders(second.server.port, cookie, key, Buffer.byteLength(replayBody)),
        replayBody,
      );
      assert.equal(replay.status, 409);
      assert.equal(await eventCount(runsDir), events);
    } finally {
      await second.stop();
    }
  } finally {
    await removeTempDir(dir);
  }
});
