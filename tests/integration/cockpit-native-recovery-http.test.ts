/**
 * V2.1-IMP-17D — preuve HTTP locale d'une reprise native.
 *
 * Une seule séquence, sur le vrai serveur et un socket réel :
 *
 * ```text
 * GET  /api/runs/:id/recovery          → revision R, send PRE_PROVIDER_ABORTED
 * POST /api/runs/:id/recovery  R       → succès, revision_after ≠ R
 * GET  /api/runs/:id/recovery          → send NONE, handoff inchangé
 * POST même clé, même intention        → même reçu, aucun second marqueur
 * POST nouvelle clé, ancienne R        → STALE_REVISION
 * ```
 *
 * Aucun fournisseur, aucun terminal, aucun navigateur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readPersistedManifest } from '../../src/store/native-store.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { nativeFixtureManifest } from '../helpers/run-fixture.ts';
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
      headers['Idempotency-Key'] = options.key ?? 'idem-http-rec-000001';
    }
    const req = request(
      { host: '127.0.0.1', port, path: requestPath, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const isJson = (res.headers['content-type'] ?? '').includes('application/json');
          const setCookie = res.headers['set-cookie']?.[0];
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

function field<T>(body: unknown, key: string): T {
  return (body as Record<string, T>)[key] as T;
}

function statusOf(body: unknown, domain: string): string {
  const recovery = field<Record<string, { status: string }>>(body, 'recovery');
  return recovery[domain]?.status ?? '';
}

test(
  'HTTP local · une reprise native nommée s’applique, et elle seule',
  { timeout: 120_000 },
  async () => {
    const dir = await makeTempDir('ccr-17d-http-');
    let cockpit: CockpitInstance | undefined;
    try {
      const runsDir = path.join(dir, 'runs');
      const adapters = {
        claude: createFakeAdapter({ kind: 'claude', startSessionIds: ['claude-1'], sessionId: 'claude-1' }),
        codex: createFakeAdapter({ kind: 'codex', startSessionIds: ['codex-1'], sessionId: 'codex-1' }),
      };

      // Un run natif sain, puis deux diagnostics de deux domaines différents.
      const started = await startNativeRun(
        { runsDir, now: () => new Date(), createAdapters: (): AgentAdapters => adapters },
        {
          title: 'T',
          cwd: process.cwd(),
          prompt: 'mission',
          runtimeConfig: nativeFixtureManifest('CCR-20260811-001', {
            author: 'codex',
            challenger: 'claude',
          }).runtime_config!,
        },
      );
      assert.equal(started.failure, undefined);
      const runId = started.runId;

      const paths = runPaths(runsDir, runId);
      const persisted = await readPersistedManifest(paths);
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('natif attendu');
      const events = await openNativeEventStore(paths, persisted.manifest);
      await events.append({
        round: 0,
        actor: 'human',
        type: 'human_message',
        target_expert_slot_id: 'author',
        session_id: 'codex-1',
        content: 'envoi resté sans issue',
      });
      await events.append({
        round: 0,
        actor: 'human',
        type: 'human_handoff_started',
        target_expert_slot_id: 'challenger',
        session_id: 'claude-1',
        details: { state: 'READY', control: 'AUTOMATION' },
      });

      cockpit = await startCockpit({
        runsDir,
        port: 0,
        depsOverrides: { createAdapters: (): AgentAdapters => adapters },
      });
      const port = cockpit.server.port;

      const shell = await http(port, '/');
      const cookie = shell.cookie;
      assert.ok(cookie !== undefined);

      // ---- Lecture consultative : deux domaines, une révision.
      const view = await http(port, `/api/runs/${runId}/recovery`, { cookie });
      assert.equal(view.status, 200);
      assert.equal(field<string>(view.body, 'generation'), 'NATIVE_V21_EXECUTION');
      assert.equal(statusOf(view.body, 'send'), 'PRE_PROVIDER_ABORTED');
      assert.equal(statusOf(view.body, 'handoff'), 'PRE_INTERACTIVE_ABORTED');
      const revision = field<string>(view.body, 'revision');

      // ---- Le geste nommé, et lui seul.
      const applied = await http(port, `/api/runs/${runId}/recovery`, {
        method: 'POST',
        cookie,
        key: 'idem-http-rec-abort1',
        body: { expected_revision: revision, domain: 'send', action: 'abort-before-provider' },
      });
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.equal(field<string>(applied.body, 'status'), 'SUCCEEDED');
      const after = field<string>(applied.body, 'revision_after');
      assert.notEqual(after, revision);

      const settled = await http(port, `/api/runs/${runId}/recovery`, { cookie });
      assert.equal(statusOf(settled.body, 'send'), 'NONE');
      assert.equal(statusOf(settled.body, 'handoff'), 'PRE_INTERACTIVE_ABORTED', 'aucune purge globale');

      // ---- Rejeu de l'intention identique : même reçu, aucun second marqueur.
      const journalBefore = await readFile(paths.events, 'utf8');
      const replay = await http(port, `/api/runs/${runId}/recovery`, {
        method: 'POST',
        cookie,
        key: 'idem-http-rec-abort1',
        body: { expected_revision: revision, domain: 'send', action: 'abort-before-provider' },
      });
      assert.equal(
        field<string>(replay.body, 'operation_id'),
        field<string>(applied.body, 'operation_id'),
      );
      assert.equal(await readFile(paths.events, 'utf8'), journalBefore);

      // ---- Nouvelle clé, ancienne révision : la vue périmée l'emporte.
      const stale = await http(port, `/api/runs/${runId}/recovery`, {
        method: 'POST',
        cookie,
        key: 'idem-http-rec-stale1',
        body: {
          expected_revision: revision,
          domain: 'handoff',
          action: 'abort-before-interactive',
        },
      });
      assert.equal(stale.status, 409);
      assert.equal(
        (stale.body as { error?: { code?: string } }).error?.code ??
          (stale.body as { error_code?: string }).error_code,
        'STALE_REVISION',
      );
      assert.equal(await readFile(paths.events, 'utf8'), journalBefore, 'un refus n’écrit rien');

      // Aucun terminal n'a été rouvert par une reprise de handoff.
      assert.equal(adapters.claude.interactiveCalls.length, 0);
      assert.equal(adapters.codex.interactiveCalls.length, 0);
    } finally {
      await cockpit?.stop();
      await removeTempDir(dir);
    }
  },
);
