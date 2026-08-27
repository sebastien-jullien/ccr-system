/**
 * Performance des opérations longues — §38.
 *
 * La question n'est pas « le cockpit est-il rapide ? » mais une propriété
 * structurelle : **le `202` ne doit pas dépendre de la durée du fournisseur**.
 * Un accusé qui traîne quand l'agent traîne signifierait que l'appelant attend
 * la réponse — c'est-à-dire que la promesse du Slice 5 n'est pas tenue.
 *
 * On mesure donc le même geste avec un fournisseur bloqué ~100 ms puis ~2 s.
 * L'écart doit rester du bruit de mesure, pas un ordre de grandeur.
 *
 * Aucun fournisseur réel, aucun appel payant : la durée est simulée.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';

const RUN = 'CCR-20260402-001';

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

function ms(from: bigint): number {
  return Number(process.hrtime.bigint() - from) / 1e6;
}

/** Un cockpit dont le fournisseur met exactement `delayMs` à répondre. */
async function openWithProviderDelay(delayMs: number): Promise<{
  post(route: string, payload: unknown, key: string): Promise<Result>;
  get(target: string): Promise<Result>;
  revision(): Promise<string>;
  cleanup(): Promise<void>;
}> {
  const dir = await makeTempDir('ccr-perf-long-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: RUN,
    events: [
      { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
      { round: 1, actor: 'codex', type: 'assistant_response', session_id: 'codex-1', content: 'réponse', timestamp: T },
    ],
  });

  const slow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', onCall: slow }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', onCall: slow }),
  };

  const instance = await startCockpit({ runsDir, port: 0, depsOverrides: { createAdapters: () => adapters } });
  const port = instance.server.port;
  const cookie = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
    });
    req.on('error', reject);
    req.end();
  });

  return {
    post(route, payload, key) {
      const body = JSON.stringify(payload);
      return send(port, 'POST', route, {
        Host: `127.0.0.1:${String(port)}`,
        Origin: `http://127.0.0.1:${String(port)}`,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Idempotency-Key': key,
      }, body);
    },
    get: (target) => send(port, 'GET', target, { Host: `127.0.0.1:${String(port)}`, Cookie: cookie }),
    revision: async () => (await readStableRunSnapshot(runsDir, RUN)).revision,
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

/** Un `202`, le reçu consulté pendant l'exécution, puis le verdict. */
async function measure(delayMs: number): Promise<{ accept: number; poll: number; terminal: number }> {
  const b = await openWithProviderDelay(delayMs);
  try {
    const revision = await b.revision();
    const start = process.hrtime.bigint();
    const accepted = await b.post(`/api/runs/${RUN}/step`, { expected_revision: revision }, `cle-perf-${String(delayMs)}`.padEnd(16, '0'));
    const accept = ms(start);
    assert.equal(accepted.status, 202, accepted.raw);

    const operationId = String(accepted.body['operation_id']);
    const pollStart = process.hrtime.bigint();
    const running = await b.get(`/api/operations/${operationId}`);
    const poll = ms(pollStart);
    assert.equal(running.status, 200, running.raw);
    assert.equal(running.body['status'], 'RUNNING', running.raw);

    let status = 'RUNNING';
    while (status === 'RUNNING') {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = String((await b.get(`/api/operations/${operationId}`)).body['status']);
    }
    const terminal = ms(start);
    assert.equal(status, 'SUCCEEDED');
    return { accept, poll, terminal };
  } finally {
    await b.cleanup();
  }
}

test('(PL) le 202 ne dépend pas de la durée du fournisseur', { timeout: 180_000 }, async (t) => {
  const fast = await measure(100);
  const slow = await measure(2_000);

  t.diagnostic(`fournisseur 100 ms  → 202 en ${fast.accept.toFixed(1)} ms · reçu RUNNING en ${fast.poll.toFixed(2)} ms · verdict à ${fast.terminal.toFixed(0)} ms`);
  t.diagnostic(`fournisseur 2 000 ms → 202 en ${slow.accept.toFixed(1)} ms · reçu RUNNING en ${slow.poll.toFixed(2)} ms · verdict à ${slow.terminal.toFixed(0)} ms`);

  // Propriété centrale : l'accusé précède le fournisseur dans les deux cas.
  assert.ok(fast.accept < 100, `202 rapide : ${fast.accept.toFixed(1)} ms`);
  assert.ok(slow.accept < 100, `202 lent : ${slow.accept.toFixed(1)} ms`);
  // Et l'écart entre les deux reste du bruit, pas la durée du fournisseur.
  assert.ok(
    Math.abs(slow.accept - fast.accept) < 200,
    `le 202 suit la durée du fournisseur : ${fast.accept.toFixed(1)} → ${slow.accept.toFixed(1)} ms`,
  );

  // Consulter un reçu en cours reste une lecture, pas une attente.
  assert.ok(fast.poll < 50, `reçu RUNNING : ${fast.poll.toFixed(2)} ms`);
  assert.ok(slow.poll < 50, `reçu RUNNING : ${slow.poll.toFixed(2)} ms`);

  // Le verdict, lui, arrive bien après le fournisseur : il n'est pas anticipé.
  assert.ok(fast.terminal >= 100, `verdict trop tôt : ${fast.terminal.toFixed(0)} ms`);
  assert.ok(slow.terminal >= 2_000, `verdict trop tôt : ${slow.terminal.toFixed(0)} ms`);
});
