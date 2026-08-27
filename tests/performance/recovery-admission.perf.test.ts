/**
 * T202-R — latence du `202` de reprise longue.
 *
 * Une seule chose est mesurée, et c'est la seule qui compte pour l'humain : le
 * temps entre la requête et l'accusé. Il doit être borné par l'admission, pas
 * par le fournisseur — sinon la poignée de main ne prouve rien, elle attend.
 *
 * Le fournisseur est délibérément tenu bloqué pendant toute la mesure. Un `202`
 * rendu dans ces conditions ne peut pas l'avoir attendu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';

const RUN = 'CCR-20260402-001';
/** Borne large : on cherche à exclure une attente du fournisseur, pas à chronométrer un socket. */
const BUDGET_MS = 1_500;

test('(T202-R) le 202 de continuation part sans attendre le fournisseur', async (t) => {
  const dir = await makeTempDir('ccr-perf-recovery-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: RUN,
    state: { state: 'FAILED_INITIALIZATION' },
    events: [
      { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
      { round: 0, actor: 'human', type: 'prompt_sent', content: 'contexte initial', timestamp: T },
    ],
  });
  const manifestPath = runPaths(runsDir, RUN).manifest;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    agents: Record<string, { session_id: string | null }>;
    workspace: { cwd: string };
  };
  const codex = manifest.agents['codex'];
  if (codex !== undefined) codex.session_id = null;
  manifest.workspace.cwd = dir;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let joined = 0;
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
    codex: createFakeAdapter({
      kind: 'codex',
      sessionId: 'codex-1',
      onCall: async () => {
        joined += 1;
        await blocked;
      },
    }),
  };

  const instance = await startCockpit({ runsDir, port: 0, depsOverrides: { createAdapters: () => adapters } });
  const port = instance.server.port;
  try {
    const cookie = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (res) => {
        res.resume();
        res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
      });
      req.on('error', reject);
      req.end();
    });

    const body = JSON.stringify({ expected_revision: (await readStableRunSnapshot(runsDir, RUN)).revision });
    const started = process.hrtime.bigint();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/runs/${RUN}/recovery/continue-initialization`,
          method: 'POST',
          headers: {
            Host: `127.0.0.1:${String(port)}`,
            Origin: `http://127.0.0.1:${String(port)}`,
            Cookie: cookie,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body, 'utf8')),
            'Idempotency-Key': 'cle-perf-recovery1',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    t.diagnostic(`202 rendu en ${elapsed.toFixed(1)} ms · fournisseur bloqué, ${String(joined)} appel(s) en cours`);

    assert.equal(status, 202);
    assert.ok(elapsed < BUDGET_MS, `accusé rendu en ${elapsed.toFixed(1)} ms (budget ${String(BUDGET_MS)} ms)`);
  } finally {
    release();
    await instance.stop();
    await removeTempDir(dir);
  }
});
