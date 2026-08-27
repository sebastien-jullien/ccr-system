/**
 * PERF-2 — coût du **transport**, et de lui seul (Slice 2, §41).
 *
 * L'étude de performance du read model appartient au Slice 1 et n'est pas
 * refaite. La seule question posée ici : le serveur ajoute-t-il un coût
 * disproportionné à ce que coûte déjà la lecture ?
 *
 * Aucune de ces mesures ne justifierait un cache : un cache aurait sa propre
 * notion de fraîcheur à côté de la révision, c'est-à-dire une seconde autorité.
 *
 * Mesure chronométrée, donc hors de la suite fonctionnelle : elle est exécutée
 * en série par `npm run test:performance`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { getRunView, listCockpitRuns } from '../../src/services/cockpit-read-model.ts';
import type { NewCcrEvent } from '../../src/core/run.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

function get(port: number, target: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: target, headers: { Host: `127.0.0.1:${String(port)}`, Cookie: cookie } },
      (res) => {
        let bytes = 0;
        res.on('data', (chunk: Buffer) => (bytes += chunk.byteLength));
        res.on('end', () => resolve(res.statusCode === 200 ? bytes : -1));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function median(times: number, task: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const start = process.hrtime.bigint();
    await task();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;
}

test('(PF) surcoût de transport : liste de 500 runs et vue de 5 000 événements', async (t) => {
  const dir = await makeTempDir('ccr-cockpit-perf-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });

    for (let i = 1; i <= 500; i += 1) {
      await materializeRun(runsDir, { runId: `CCR-20260808-${String(i).padStart(3, '0')}` });
    }
    const heavy = 'CCR-20260402-001';
    const events: NewCcrEvent[] = Array.from({ length: 5000 }, (_, i) => ({
      round: 0,
      actor: 'codex',
      type: 'assistant_response',
      session_id: 'codex-1',
      content: `réponse ${String(i)}`,
      timestamp: new Date(Date.parse(T) + i * 1000).toISOString(),
    }));
    await materializeRun(runsDir, { runId: heavy, events });

    const instance = await startCockpit({ runsDir, port: 0 });
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

      const deps = instance.application.readModel;
      const directList = await median(5, () => listCockpitRuns(deps));
      const httpList = await median(5, () => get(port, '/api/runs', cookie));
      const directView = await median(5, () => getRunView(deps, heavy));
      const httpView = await median(5, () => get(port, `/api/runs/${heavy}`, cookie));

      const listBytes = await get(port, '/api/runs', cookie);
      const viewBytes = await get(port, `/api/runs/${heavy}`, cookie);
      assert.ok(listBytes > 0 && viewBytes > 0, 'les deux réponses aboutissent');

      t.diagnostic(
        `liste 500 runs : direct ${directList.toFixed(1)} ms → HTTP ${httpList.toFixed(1)} ms ` +
          `(+${(httpList - directList).toFixed(1)} ms, ${String(listBytes)} o)`,
      );
      t.diagnostic(
        `vue 5 000 événements : direct ${directView.toFixed(1)} ms → HTTP ${httpView.toFixed(1)} ms ` +
          `(+${(httpView - directView).toFixed(1)} ms, ${String(viewBytes)} o)`,
      );

      // Borne large et volontairement grossière : elle ne cherche pas à fixer
      // une performance, seulement à faire échouer une explosion.
      assert.ok(
        httpList <= directList * 3 + 250,
        `surcoût de transport anormal sur la liste : ${httpList.toFixed(1)} ms contre ${directList.toFixed(1)} ms`,
      );
      assert.ok(
        httpView <= directView * 3 + 250,
        `surcoût de transport anormal sur la vue : ${httpView.toFixed(1)} ms contre ${directView.toFixed(1)} ms`,
      );
    } finally {
      await instance.stop();
    }
  } finally {
    await removeTempDir(dir);
  }
});
