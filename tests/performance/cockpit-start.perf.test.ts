/**
 * Performance de la création — §38.
 *
 * Une seule question : **le `202` dépend-il de la durée d'initialisation ?**
 * Il ne doit pas. Un accusé qui traînerait quand les agents traînent
 * signifierait que l'appelant attend l'initialisation — c'est-à-dire que la
 * promesse du slice n'est pas tenue.
 *
 * Et au moment précis où le client tient son accusé, aucun fournisseur n'a été
 * joint : c'est ce qui rend `created_run_id` fiable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

function send(port: number, method: string, target: string, headers: Record<string, string>, body?: string): Promise<Result> {
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

const ms = (from: bigint): number => Number(process.hrtime.bigint() - from) / 1e6;

const probeOf = (agent: 'claude' | 'codex'): Promise<AgentRuntimeProbe> =>
  Promise.resolve({ agent, installed: true, version: '1.0.0', authStatus: 'AUTHENTICATED', launcherSource: 'explicit' });

interface Measure {
  readonly accept: number;
  readonly poll: number;
  readonly terminal: number;
  readonly providersAt202: number;
  readonly createdAt202: string;
}

/** Une création complète, avec des agents qui mettent `delayMs` à répondre. */
async function measure(delayMs: number): Promise<Measure> {
  const dir = await makeTempDir('ccr-perf-start-');
  const runsDir = path.join(dir, 'runs');
  const workspace = path.join(dir, 'workspace');
  for (const target of [runsDir, workspace]) await mkdir(target, { recursive: true });

  let providers = 0;
  const slow = async (): Promise<void> => {
    providers += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  };
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', onCall: slow }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', onCall: slow }),
  };

  const instance = await startCockpit({
    runsDir,
    port: 0,
    depsOverrides: { createAdapters: () => adapters },
    preflightSeams: {
      configPath: path.join(dir, 'absente.json'),
      env: {},
      probes: { claude: () => probeOf('claude'), codex: () => probeOf('codex') },
    },
  });

  try {
    const port = instance.server.port;
    const cookie = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (res) => {
        res.resume();
        res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
      });
      req.on('error', reject);
      req.end();
    });

    const body = JSON.stringify({ title: 'Mesure', workspace_cwd: workspace, prompt: 'Contexte.' });
    const start = process.hrtime.bigint();
    const accepted = await send(port, 'POST', '/api/runs', {
      Host: `127.0.0.1:${String(port)}`,
      Origin: `http://127.0.0.1:${String(port)}`,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      'Idempotency-Key': `cle-perf-${String(delayMs)}`.padEnd(16, '0'),
    }, body);
    const accept = ms(start);
    const providersAt202 = providers;
    assert.equal(accepted.status, 202, accepted.raw);

    const operationId = String(accepted.body['operation_id']);
    const pollStart = process.hrtime.bigint();
    const running = await send(port, 'GET', `/api/operations/${operationId}`, {
      Host: `127.0.0.1:${String(port)}`,
      Cookie: cookie,
    });
    const poll = ms(pollStart);
    assert.equal(running.body['status'], 'RUNNING', running.raw);

    let status = 'RUNNING';
    while (status === 'RUNNING') {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = String(
        (await send(port, 'GET', `/api/operations/${operationId}`, { Host: `127.0.0.1:${String(port)}`, Cookie: cookie }))
          .body['status'],
      );
    }
    assert.equal(status, 'SUCCEEDED');

    return { accept, poll, terminal: ms(start), providersAt202, createdAt202: String(accepted.body['created_run_id']) };
  } finally {
    await instance.stop();
    await removeTempDir(dir);
  }
}

test('(PS) le 202 de création ne dépend pas de la durée d’initialisation', { timeout: 180_000 }, async (t) => {
  const fast = await measure(100);
  const slow = await measure(2_000);

  t.diagnostic(
    `agents 100 ms  → 202 en ${fast.accept.toFixed(1)} ms · run=${fast.createdAt202} · ` +
      `fournisseurs au 202 = ${String(fast.providersAt202)} · reçu RUNNING en ${fast.poll.toFixed(2)} ms · verdict à ${fast.terminal.toFixed(0)} ms`,
  );
  t.diagnostic(
    `agents 2 000 ms → 202 en ${slow.accept.toFixed(1)} ms · run=${slow.createdAt202} · ` +
      `fournisseurs au 202 = ${String(slow.providersAt202)} · reçu RUNNING en ${slow.poll.toFixed(2)} ms · verdict à ${slow.terminal.toFixed(0)} ms`,
  );

  // Propriété centrale : l'accusé précède l'initialisation, dans les deux cas.
  assert.equal(fast.providersAt202, 0, 'aucun fournisseur joint quand le client tient son 202');
  assert.equal(slow.providersAt202, 0);
  assert.match(fast.createdAt202, /^CCR-\d{8}-\d{3}$/, 'created_run_id est déjà connu');
  assert.match(slow.createdAt202, /^CCR-\d{8}-\d{3}$/);

  assert.ok(fast.accept < 500, `202 rapide : ${fast.accept.toFixed(1)} ms`);
  assert.ok(slow.accept < 500, `202 lent : ${slow.accept.toFixed(1)} ms`);
  assert.ok(
    Math.abs(slow.accept - fast.accept) < 400,
    `le 202 suit la durée d’initialisation : ${fast.accept.toFixed(1)} → ${slow.accept.toFixed(1)} ms`,
  );

  // Consulter un reçu en cours reste une lecture, pas une attente.
  assert.ok(fast.poll < 100, `reçu RUNNING : ${fast.poll.toFixed(2)} ms`);
  assert.ok(slow.poll < 100, `reçu RUNNING : ${slow.poll.toFixed(2)} ms`);

  // Le verdict, lui, arrive bien après les deux sessions : il n'est pas anticipé.
  assert.ok(fast.terminal >= 200, `verdict trop tôt : ${fast.terminal.toFixed(0)} ms`);
  assert.ok(slow.terminal >= 4_000, `verdict trop tôt : ${slow.terminal.toFixed(0)} ms`);
});
