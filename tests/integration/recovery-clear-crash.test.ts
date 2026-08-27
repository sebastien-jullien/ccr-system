/**
 * Crash pendant une levée de verrou périmé — la preuve la plus sensible.
 *
 * `RECOVERY_CLEAR_STALE_LOCK` est la seule opération destructive du produit, et
 * la seule dont l'effet ne laisse aucune trace canonique : ni événement, ni
 * révision. Un arrêt brutal entre la suppression et le reçu terminal produit
 * donc l'unique situation où CCR a détruit quelque chose sans pouvoir dire
 * qu'il l'a fait.
 *
 * Ce qui doit tenir après redémarrage :
 *
 * ```text
 * reçu   → UNKNOWN, jamais SUCCEEDED inventé, jamais RUNNING éternel
 * verrou → absent : l'effet a bien eu lieu
 * clé    → même UNKNOWN, aucune seconde levée, aucune reprise automatique
 * ```
 *
 * Le crash est réel : `SIGKILL` sur soi-même, aucun `finally`, aucun reçu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearStaleCockpitLock, startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { inspectServerLock } from '../../src/cockpit/server-lock.ts';
import { lockFilePath, readRunLock } from '../../src/lock/run-lock.ts';
import { lockTokenFor } from '../../src/lock/lock-token.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const CRASHER = fileURLToPath(new URL('../helpers/crash-cockpit.ts', import.meta.url));
const RUN = 'CCR-20260402-001';
const KEY = 'cle-crash-levee01';
const OPERATION = `op_${createHash('sha256').update(KEY, 'utf8').digest('hex')}`;
/** PID hors de portée : son propriétaire ne peut pas être vivant. */
const DEAD_PID = 2 ** 30;

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

function http(port: number, method: string, target: string, headers: Record<string, string>, body?: string): Promise<Result> {
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
  const res = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (r) => {
      r.resume();
      r.on('end', () => resolve((r.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
    });
    req.on('error', reject);
    req.end();
  });
  return res;
}

function postClear(port: number, cookie: string, token: string): Promise<Result> {
  const body = JSON.stringify({ observed_lock_token: token });
  return http(port, 'POST', `/api/runs/${RUN}/recovery/clear-stale-lock`, {
    Host: `127.0.0.1:${String(port)}`,
    Origin: `http://127.0.0.1:${String(port)}`,
    Cookie: cookie,
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'Idempotency-Key': KEY,
  }, body);
}

test('(R-C) crash après la levée, avant le reçu : UNKNOWN, aucune seconde levée', async (t) => {
  const dir = await makeTempDir('ccr-clear-crash-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: RUN,
    events: [{ round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T }],
  });
  const paths = runPaths(runsDir, RUN);
  const manifestPath = paths.manifest;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { workspace: { cwd: string } };
  manifest.workspace.cwd = dir;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // Verrou périmé : hôte local, propriétaire mort. Le seul cas levable.
  const staleLock = { lock_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pid: DEAD_PID, hostname: hostname(), started_at: T, command: 'step' };
  await writeFile(lockFilePath(paths), `${JSON.stringify(staleLock, null, 2)}\n`, 'utf8');
  const token = lockTokenFor(RUN, staleLock);

  const before = await readStableRunSnapshot(runsDir, RUN);
  const eventsBefore = (await (await openEventStore(paths, RUN)).readAll()).length;

  // 1. Cockpit suicidaire : il mourra après le `unlink`, avant le reçu terminal.
  const crashed = await new Promise<{ port: number; exited: Promise<void>; kill: () => void }>((resolve, reject) => {
    const child = spawn(process.execPath, [CRASHER, runsDir, '0', 'clear-after-unlink'], { stdio: 'pipe', shell: false });
    let out = '';
    let err = '';
    const exited = new Promise<void>((done) => child.on('close', () => done()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cockpit suicidaire non démarré : ${out} ${err}`));
    }, 60_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = /READY (\d+)/.exec(out);
      if (match === null) return;
      clearTimeout(timer);
      resolve({ port: Number.parseInt(match[1] ?? '0', 10), exited, kill: () => child.kill('SIGKILL') });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  try {
    const cookie = await cookieOf(crashed.port);
    // La réponse ne reviendra jamais : le processus meurt en pleine requête.
    await postClear(crashed.port, cookie, token).catch(() => undefined);
    await crashed.exited;
    t.diagnostic('cockpit mort après la suppression du verrou, avant tout reçu terminal');

    // L'effet a bien eu lieu, et rien d'autre.
    assert.equal(existsSync(lockFilePath(paths)), false, 'le verrou périmé a été supprimé');
    assert.equal(await readRunLock(paths), undefined);
    const afterCrash = await readStableRunSnapshot(runsDir, RUN);
    assert.equal(afterCrash.revision, before.revision, 'la levée ne touche aucun fait canonique');
  } finally {
    crashed.kill();
  }

  // 2. Le verrou de serveur du mort subsiste — CCR ne le lève jamais seul.
  const dataRoot = resolveCockpitDataRoot(runsDir);
  const serverLock = await inspectServerLock(dataRoot.serverLock);
  t.diagnostic(`verrou de serveur après crash : ${serverLock.observation}`);
  assert.equal(serverLock.observation, 'LOCAL_STALE');
  await clearStaleCockpitLock(runsDir, serverLock.info?.instance_id ?? '');

  // 3. Redémarrage : nouvelle instance, même racine.
  const instance = await startCockpit({ runsDir, port: 0 });
  try {
    const port = instance.server.port;
    const cookie = await cookieOf(port);

    const receipt = await http(port, 'GET', `/api/operations/${OPERATION}`, {
      Host: `127.0.0.1:${String(port)}`,
      Cookie: cookie,
    });
    t.diagnostic(`reçu après redémarrage → ${String(receipt.body['status'])} · action=${String(receipt.body['action'])}`);

    // Le reçu ne ment ni dans un sens, ni dans l'autre.
    assert.equal(receipt.status, 200, receipt.raw);
    assert.equal(receipt.body['status'], 'UNKNOWN');
    assert.notEqual(receipt.body['status'], 'SUCCEEDED');
    assert.notEqual(receipt.body['status'], 'RUNNING');
    assert.equal(receipt.body['action'], 'RECOVERY_CLEAR_STALE_LOCK');
    assert.equal(receipt.body['revision_after'], undefined);
    assert.equal(receipt.body['error_code'], undefined);

    // La même clé rend le même verdict, sans réévaluer le monde.
    const replay = await postClear(port, cookie, token);
    t.diagnostic(`même clé après redémarrage → ${String(replay.status)} ${String(replay.body['status'])}`);
    assert.equal(replay.status, 200, replay.raw);
    assert.equal(replay.body['status'], 'UNKNOWN');
    assert.equal(replay.body['operation_id'], OPERATION);

    // Aucune seconde levée : il n'y avait plus rien à lever, et rien n'a été
    // tenté. Aucune reprise automatique non plus.
    assert.equal(existsSync(lockFilePath(paths)), false);
    const afterRestart = await readStableRunSnapshot(runsDir, RUN);
    assert.equal(afterRestart.revision, before.revision, 'aucune reprise automatique au redémarrage');
    assert.equal(afterRestart.state.state, before.state.state);
    assert.equal((await (await openEventStore(paths, RUN)).readAll()).length, eventsBefore, 'aucun événement ajouté');

    // Et une clé neuve, elle, constate honnêtement qu'il n'y a plus de verrou.
    const fresh = JSON.stringify({ observed_lock_token: token });
    const other = await http(port, 'POST', `/api/runs/${RUN}/recovery/clear-stale-lock`, {
      Host: `127.0.0.1:${String(port)}`,
      Origin: `http://127.0.0.1:${String(port)}`,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(fresh, 'utf8')),
      'Idempotency-Key': 'cle-crash-apres01',
    }, fresh);
    t.diagnostic(`clé neuve → ${String(other.status)} ${String((other.body['error'] as { code?: string } | undefined)?.code)}`);
    assert.equal(other.status, 422, other.raw);
    assert.equal((other.body['error'] as { code?: string } | undefined)?.code, 'RECOVERY_LOCK_NOT_CLEARABLE');
  } finally {
    await instance.stop();
    await removeTempDir(dir);
  }
});
