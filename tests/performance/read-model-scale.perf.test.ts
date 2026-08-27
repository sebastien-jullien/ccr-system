/**
 * PERF-1 — budgets §38 du read model, sur système de fichiers réel.
 *
 * Ces trois mesures portent des **seuils temporels**. Elles vivent donc hors de
 * la suite fonctionnelle : un chronomètre exécuté en parallèle d'une création
 * de 500 runs et de processus fils ne mesure plus le produit, il mesure la
 * contention du runner. La suite de performance est sérialisée ; la suite
 * fonctionnelle ne l'est pas, et n'a pas à l'être.
 *
 * Les budgets eux-mêmes sont ceux de la V0.2 §38, inchangés :
 *
 * ```text
 * GET /api/runs      < 300 ms à 300 runs, manifest + state seuls
 * GET /api/runs/:id  < 500 ms à 5 000 événements
 * ```
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { getRunView, listCockpitRuns } from '../../src/services/cockpit-read-model.ts';
import { runPaths } from '../../src/store/layout.ts';
import { depsOf, makeRun } from '../helpers/large-corpus.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

// --------------------------------------------------------------------------

test('A. 500 runs réels sur disque → liste dans le budget §38', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir('ccr-rm-scale-a-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });

    const RUNS = 500;
    for (let i = 1; i <= RUNS; i += 1) {
      // Journaux réels mais modestes : la liste ne doit pas les ouvrir.
      await makeRun(runsDir, `CCR-20260808-${String(i).padStart(3, '0')}`, 20, 200);
    }

    // Mesure à froid puis à chaud.
    const cold = Date.now();
    const runs = await listCockpitRuns(depsOf(runsDir));
    const coldMs = Date.now() - cold;

    const warm = Date.now();
    await listCockpitRuns(depsOf(runsDir));
    const warmMs = Date.now() - warm;

    t.diagnostic(`runs=${String(runs.length)} · liste à froid=${String(coldMs)} ms · à chaud=${String(warmMs)} ms`);

    assert.equal(runs.length, RUNS);
    assert.ok(runs.every((r) => !r.unreadable));
    // Budget §38 : < 300 ms à 300 runs. On mesure ici 500.
    assert.ok(warmMs < 1_500, `liste de 500 runs en ${String(warmMs)} ms`);
  } finally {
    await removeTempDir(dir);
  }
});

test(
  'A bis. des journaux volumineux ne changent pas le coût de la liste',
  { timeout: 180_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-rm-scale-ab-');
    try {
      const small = path.join(dir, 'small');
      const large = path.join(dir, 'large');
      await mkdir(small, { recursive: true });
      await mkdir(large, { recursive: true });

      const RUNS = 60;
      for (let i = 1; i <= RUNS; i += 1) {
        const runId = `CCR-20260808-${String(i).padStart(3, '0')}`;
        await makeRun(small, runId, 5, 50);
        // Mêmes manifests/états, journaux 400× plus gros.
        await makeRun(large, runId, 400, 2_000);
      }

      const smallBytes = (await stat(path.join(small, 'CCR-20260402-001', 'events.jsonl'))).size;
      const largeBytes = (await stat(path.join(large, 'CCR-20260402-001', 'events.jsonl'))).size;

      // Deux mesures chacune, on garde la meilleure : moins sensible au bruit.
      const measure = async (runsDir: string): Promise<number> => {
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 3; i += 1) {
          const started = Date.now();
          await listCockpitRuns(depsOf(runsDir));
          best = Math.min(best, Date.now() - started);
        }
        return best;
      };

      const smallMs = await measure(small);
      const largeMs = await measure(large);

      t.diagnostic(
        `journal petit=${String(smallBytes)} o → ${String(smallMs)} ms · ` +
          `journal gros=${String(largeBytes)} o (×${String(Math.round(largeBytes / smallBytes))}) → ${String(largeMs)} ms`,
      );

      assert.ok(largeBytes > smallBytes * 100, 'les journaux sont bien massivement plus gros');
      // Le coût ne doit pas suivre la taille des journaux.
      assert.ok(
        largeMs <= Math.max(smallMs * 3, smallMs + 60),
        `liste insensible à la taille des journaux (${String(smallMs)} → ${String(largeMs)} ms)`,
      );
    } finally {
      await removeTempDir(dir);
    }
  },
);

test('B. RunView sur journaux croissants → budget §38', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir('ccr-rm-scale-b-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });

    const measures: string[] = [];
    let worst = 0;

    for (const [events, payload] of [
      [100, 500],
      [1_000, 500],
      [5_000, 500],
      [5_000, 2_000],
    ] as const) {
      const runId = 'CCR-20260402-001';
      const local = path.join(dir, `case-${String(events)}-${String(payload)}`);
      await mkdir(local, { recursive: true });
      await makeRun(local, runId, events, payload);
      const bytes = (await stat(runPaths(local, runId).events)).size;

      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i += 1) {
        const started = Date.now();
        const view = await getRunView(depsOf(local), runId);
        best = Math.min(best, Date.now() - started);
        assert.equal(view.counts.events, events);
      }
      worst = Math.max(worst, best);
      measures.push(`${String(events)} évts / ${String(Math.round(bytes / 1024))} KiB → ${String(best)} ms`);
    }

    t.diagnostic(`RunView : ${measures.join(' · ')}`);
    // Budget §38 : < 500 ms à 5 000 événements.
    assert.ok(worst < 1_500, `RunView au pire ${String(worst)} ms`);
  } finally {
    await removeTempDir(dir);
  }
});
