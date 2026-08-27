/**
 * V2.1-IMP-17C — preuve HTTP locale des mutations natives.
 *
 * Une seule séquence, sur le **vrai** serveur, avec un socket réel : ce que ce
 * fichier éprouve n'est pas la logique — elle l'est ailleurs — mais que le
 * routeur, la session, l'origine canonique et l'aiguillage générationnel
 * fonctionnent réellement ensemble.
 *
 * ```text
 * POST /api/runs                → run natif
 * GET  /api/runs/:id            → revision R
 * POST /api/runs/:id/pause  R   → succès, PAUSED / HUMAN
 * GET  /api/runs/:id            → révision différente
 * POST /api/runs/:id/resume R   → STALE_REVISION
 * POST /api/runs/:id/send claude → AMBIGUOUS_PROVIDER_ALIAS
 * ```
 *
 * Le dernier appel est le plus important : il prouve que le vrai routeur
 * n'interprète pas « claude » avant de connaître la génération du run.
 *
 * Aucun fournisseur réel, aucun terminal, aucun navigateur : les adapters sont
 * des fixtures.
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
      headers['Idempotency-Key'] = options.key ?? 'idem-http-0000000001';
    }

    const req = request(
      { host: '127.0.0.1', port, path: requestPath, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const setCookie = res.headers['set-cookie']?.[0];
          // Le shell est du HTML : seule une réponse JSON est décodée.
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
  'HTTP local · le vrai serveur mute un run natif, et refuse une vue périmée',
  { timeout: 120_000 },
  async () => {
    const dir = await makeTempDir('ccr-17c-http-');
    let cockpit: CockpitInstance | undefined;
    try {
      // Same-provider : c'est la configuration qui rend l'alias ambigu, et donc
      // celle qui prouve qu'aucune traduction prématurée n'a lieu.
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

      // La session est posée par le shell, comme pour un navigateur.
      const shell = await http(port, '/');
      assert.equal(shell.status, 200);
      const cookie = shell.cookie;
      assert.ok(cookie?.startsWith(SESSION_COOKIE_NAME));

      // ---- Création : la surface V2.1 crée du natif.
      const created = await http(port, '/api/runs', {
        method: 'POST',
        cookie,
        key: 'idem-http-start-00001',
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
      assert.ok(runId !== undefined, 'le run alloué est nommable');

      // Le reçu devient terminal : un `202` n'est qu'une admission.
      const operationId = field<string>(created.body, 'operation_id');
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const receipt = await http(port, `/api/operations/${operationId}`, { cookie });
        if (field<string>(receipt.body, 'status') !== 'RUNNING') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // ---- Lecture : la vue native porte sa révision.
      const view = await http(port, `/api/runs/${runId}`, { cookie });
      assert.equal(view.status, 200);
      assert.equal(field<string>(view.body, 'generation'), 'NATIVE_V21_EXECUTION');
      const revision = field<string>(view.body, 'revision');
      assert.match(revision, /^sha256:[0-9a-f]{64}$/);

      // ---- Mutation : la révision lue est celle sur laquelle on agit.
      const paused = await http(port, `/api/runs/${runId}/pause`, {
        method: 'POST',
        cookie,
        key: 'idem-http-pause-00001',
        body: { expected_revision: revision },
      });
      assert.equal(paused.status, 200, JSON.stringify(paused.body));
      assert.equal(field<string>(paused.body, 'status'), 'SUCCEEDED');
      const after = field<string>(paused.body, 'revision_after');
      assert.notEqual(after, revision);

      const suspended = await http(port, `/api/runs/${runId}`, { cookie });
      const state = field<Record<string, unknown>>(
        field<Record<string, unknown>>(suspended.body, 'run'),
        'operational_state',
      );
      assert.equal(state['state'], 'PAUSED');
      assert.equal(state['control'], 'HUMAN');
      assert.equal(field<string>(suspended.body, 'revision'), after);

      // ---- Une vue périmée est refusée, sur le fil.
      const stale = await http(port, `/api/runs/${runId}/resume`, {
        method: 'POST',
        cookie,
        key: 'idem-http-stale-00001',
        body: { expected_revision: revision },
      });
      assert.equal(stale.status, 409);
      assert.equal(codeOf(stale.body), 'STALE_REVISION');

      // ---- Et le routeur n'interprète pas « claude » trop tôt : sur ce run,
      // les deux experts partagent le moteur, donc l'alias ne désigne personne.
      const ambiguous = await http(port, `/api/runs/${runId}/send`, {
        method: 'POST',
        cookie,
        key: 'idem-http-send-000001',
        body: {
          expected_revision: field<string>(
            (await http(port, `/api/runs/${runId}`, { cookie })).body,
            'revision',
          ),
          target: 'claude',
          content: 'via un alias devenu ambigu',
        },
      });
      assert.equal(ambiguous.status, 422, JSON.stringify(ambiguous.body));
      assert.equal(codeOf(ambiguous.body), 'AMBIGUOUS_PROVIDER_ALIAS');

      // Aucun terminal, aucun fournisseur réel : les seuls appels sont les deux
      // positions initiales du START, servies par les fixtures.
      assert.equal(adapters.claude.interactiveCalls.length, 0);
      assert.equal(adapters.codex.interactiveCalls.length, 0);
      assert.equal(adapters.claude.calls.length, 2, 'same-provider : deux positions initiales');
      assert.equal(adapters.codex.calls.length, 0);
    } finally {
      await cockpit?.stop();
      await removeTempDir(dir);
    }
  },
);
