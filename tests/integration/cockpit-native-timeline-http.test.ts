/**
 * V2.1-IMP-19 — preuve HTTP locale de la chronologie native.
 *
 * Une seule séquence, sur le **vrai** serveur, avec un socket réel :
 *
 * ```text
 * POST /api/runs                                → run natif
 * GET  /api/runs/:id/timeline?limit=1           → 200, révision R, curseur
 * POST /api/runs/:id/pause                      → la révision change
 * GET  /api/runs/:id/timeline?cursor=<R>        → 409 STALE_REVISION
 * ```
 *
 * Ce que ce fichier éprouve n'est pas la projection — elle l'est ailleurs — mais
 * que le routeur, la session, l'origine canonique et l'aiguillage générationnel
 * servent réellement la chronologie native, et refusent réellement une page
 * issue d'une vue qui n'existe plus.
 *
 * Aucun fournisseur réel, aucun terminal, aucun navigateur : les adapters sont
 * des fixtures, et les seuls appels sont les deux positions initiales du START.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { SESSION_COOKIE_NAME } from '../../src/cockpit/session.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

interface Result {
  readonly status: number;
  readonly body: unknown;
  readonly cookie?: string;
}

function http(
  port: number,
  requestPath: string,
  options: { method?: string; cookie?: string; body?: unknown; key?: string } = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { Host: `127.0.0.1:${String(port)}` };
    if (options.cookie !== undefined) headers['Cookie'] = options.cookie;
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Origin'] = `http://127.0.0.1:${String(port)}`;
      headers['Idempotency-Key'] = options.key ?? 'idem-tl-00000000001';
    }

    const req = request(
      { host: '127.0.0.1', port, path: requestPath, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const setCookie = res.headers['set-cookie']?.[0];
          const isJson = (res.headers['content-type'] ?? '').includes('application/json');
          resolve({
            status: res.statusCode ?? 0,
            body: isJson && raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
            ...(setCookie === undefined ? {} : { cookie: setCookie.split(';')[0] }),
          });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function codeOf(body: unknown): string {
  const shaped = body as { error?: { code?: string }; error_code?: string };
  return shaped.error?.code ?? shaped.error_code ?? '';
}

function field<T>(body: unknown, key: string): T {
  return (body as Record<string, T>)[key] as T;
}

test(
  'HTTP local · le vrai serveur sert la chronologie native et refuse une page périmée',
  { timeout: 120_000 },
  async () => {
    const dir = await makeTempDir('ccr-19-http-');
    let cockpit: CockpitInstance | undefined;
    try {
      // Same-provider : la configuration où un fournisseur ne distingue plus
      // personne, et donc celle qui vaut la peine d'être servie.
      const adapters = {
        claude: createFakeAdapter({ kind: 'claude', startSessionIds: ['C1', 'C2'], sessionId: 'C1' }),
        codex: createFakeAdapter({ kind: 'codex', startSessionIds: ['X1', 'X2'], sessionId: 'X1' }),
      };
      const probe = (agent: 'claude' | 'codex'): AgentRuntimeProbe => ({
        agent,
        installed: true,
        version: '1.0.0',
        authStatus: 'AUTHENTICATED',
        launcherSource: 'path',
      });

      cockpit = await startCockpit({
        runsDir: path.join(dir, 'runs'),
        port: 0,
        depsOverrides: { createAdapters: () => adapters },
        preflightSeams: {
          configPath: path.join(dir, 'config-isole.json'),
          env: {},
          probes: { claude: async () => probe('claude'), codex: async () => probe('codex') },
        },
      });
      const port = cockpit.server.port;

      const shell = await http(port, '/');
      assert.equal(shell.status, 200);
      const cookie = shell.cookie;
      assert.ok(cookie?.startsWith(SESSION_COOKIE_NAME));

      const created = await http(port, '/api/runs', {
        method: 'POST',
        cookie,
        key: 'idem-tl-start-000001',
        body: {
          title: 'Contre-expertise',
          workspace_cwd: process.cwd(),
          prompt: 'mission initiale',
          author_provider: 'claude',
          challenger_provider: 'claude',
        },
      });
      assert.ok(created.status === 202 || created.status === 200, JSON.stringify(created.body));
      const runId = field<string>(created.body, 'created_run_id');
      const operationId = field<string>(created.body, 'operation_id');
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const receipt = await http(port, `/api/operations/${operationId}`, { cookie });
        if (field<string>(receipt.body, 'status') !== 'RUNNING') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // ---- La chronologie native est servie, et non plus refusée.
      const first = await http(port, `/api/runs/${runId}/timeline?limit=1`, { cookie });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(field<string>(first.body, 'generation'), 'NATIVE_V21_EXECUTION');
      assert.equal(field<number>(first.body, 'timeline_version'), 1);
      const revision = field<string>(first.body, 'revision');
      assert.match(revision, /^sha256:[0-9a-f]{64}$/);
      const cursor = field<string>(first.body, 'cursor_next');
      assert.ok(typeof cursor === 'string' && cursor.length > 0, 'le run a plus d’un événement');

      // Les deux positions initiales sont bien dans le journal servi.
      const whole = await http(port, `/api/runs/${runId}/timeline`, { cookie });
      const entries = field<Record<string, unknown>[]>(whole.body, 'entries');
      const responses = entries.filter((entry) => entry['type'] === 'assistant_response');
      assert.equal(responses.length, 2, 'auteur et challenger, séparément');
      const slots = responses.map(
        (entry) => (entry['provenance'] as Record<string, unknown>)['expert_slot_id'],
      );
      assert.deepEqual([...slots].sort(), ['author', 'challenger']);
      const sessions = responses.map(
        (entry) => (entry['provenance'] as Record<string, unknown>)['session_id'],
      );
      assert.equal(new Set(sessions).size, 2, 'same-provider : deux sessions distinctes');

      // ---- Une écriture locale, et la page suivante n'appartient plus à R.
      const paused = await http(port, `/api/runs/${runId}/pause`, {
        method: 'POST',
        cookie,
        key: 'idem-tl-pause-000001',
        body: { expected_revision: revision },
      });
      assert.equal(paused.status, 200, JSON.stringify(paused.body));

      const stale = await http(port, `/api/runs/${runId}/timeline?cursor=${encodeURIComponent(cursor)}`, {
        cookie,
      });
      assert.equal(stale.status, 409);
      assert.equal(codeOf(stale.body), 'STALE_REVISION');

      // Aucun terminal, aucun fournisseur réel au-delà du START.
      assert.equal(adapters.claude.interactiveCalls.length, 0);
      assert.equal(adapters.codex.interactiveCalls.length, 0);
      assert.equal(adapters.claude.calls.length, 2);
      assert.equal(adapters.codex.calls.length, 0);
    } finally {
      await cockpit?.stop();
      await removeTempDir(dir);
    }
  },
);
