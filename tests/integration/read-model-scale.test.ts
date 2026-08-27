/**
 * IT-1 — read model sur corpus réel, propriétés **fonctionnelles**.
 *
 * Trois preuves, aucune n'ayant de seuil temporel — elles restent donc dans la
 * suite fonctionnelle, exécutée avec sa concurrence normale :
 *
 *  C. timeline multi-page sur du vrai JSONL
 *  D. mutation canonique entre deux pages → pagination périmée
 *  E. run legacy réel → toutes les projections, sans mutation
 *
 * Les budgets §38 sont mesurés séparément (`npm run test:performance`) : voir
 * `tests/performance/read-model-scale.perf.test.ts`.
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  getRecoveryView,
  getRunView,
  getTimeline,
  listCockpitRuns,
} from '../../src/services/cockpit-read-model.ts';
import { openDecisionStore } from '../../src/store/decision-store.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { demoteToLegacyManifest } from '../helpers/legacy-run.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { CORPUS_TIME as T, depsOf, makeRun, manifestOf, writeJournal } from '../helpers/large-corpus.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import { writeManifest, writeState, buildInitialState } from '../../src/store/state-store.ts';
import { writeFile, stat } from 'node:fs/promises';

// --------------------------------------------------------------------------

test('C. timeline multi-page sur du vrai JSONL', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir('ccr-rm-scale-c-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const runId = 'CCR-20260402-001';
    await makeRun(runsDir, runId, 1_000, 300);

    // Quelques décisions réelles, dont une orpheline.
    const paths = runPaths(runsDir, runId);
    const decisions = await openDecisionStore(paths, runId);
    for (let i = 0; i < 3; i += 1) {
      await decisions.append({
        round: 0,
        author: 'human',
        status: 'ACTIVE',
        content: `décision ${String(i)}`,
        timestamp: new Date(Date.parse(T) + 2_000_000 + i * 1000).toISOString(),
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let revision: string | undefined;

    for (;;) {
      const page = await getTimeline(depsOf(runsDir), runId, { pageSize: 250, ...(cursor === undefined ? {} : { cursor }) });
      pages += 1;
      revision ??= page.revision;
      assert.equal(page.revision, revision, 'toutes les pages appartiennent à la même vue');
      for (const entry of page.entries) seen.push(entry.kind === 'event' ? entry.event_id : entry.decision_id);
      if (page.cursor_next === null) break;
      cursor = page.cursor_next;
      assert.ok(pages < 20, 'pagination bornée');
    }

    t.diagnostic(`pages=${String(pages)} · entrées=${String(seen.length)} · décisions orphelines incluses`);
    assert.equal(seen.length, 1_003, 'tous les records projetés');
    assert.equal(new Set(seen).size, 1_003, 'aucun doublon, aucun trou');
  } finally {
    await removeTempDir(dir);
  }
});

test('D. mutation canonique entre deux pages → pagination périmée', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir('ccr-rm-scale-d-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const runId = 'CCR-20260402-001';
    await makeRun(runsDir, runId, 40, 100);

    const page1 = await getTimeline(depsOf(runsDir), runId, { pageSize: 10 });
    assert.ok(page1.cursor_next !== null);

    // Un autre acteur ajoute un événement réel.
    const store = await openEventStore(runPaths(runsDir, runId), runId);
    await store.append({ round: 0, actor: 'human', type: 'human_message', target: 'claude', content: 'm', timestamp: T });

    let code = '';
    try {
      await getTimeline(depsOf(runsDir), runId, { pageSize: 10, cursor: page1.cursor_next });
    } catch (error) {
      code = isCcrError(error) ? error.code : 'INATTENDU';
    }

    t.diagnostic(`suite de pagination après mutation → ${code}`);
    assert.equal(code, 'STALE_REVISION', 'refus explicite, jamais une fusion silencieuse');

    // Repartir de zéro fonctionne, sur la nouvelle révision.
    const fresh = await getTimeline(depsOf(runsDir), runId, { pageSize: 10 });
    assert.notEqual(fresh.revision, page1.revision);
    assert.equal(fresh.total, 41);
  } finally {
    await removeTempDir(dir);
  }
});

test('E. run legacy réel : toutes les projections, aucune mutation', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir('ccr-rm-scale-e-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const runId = 'CCR-20260402-001';
    await makeRun(runsDir, runId, 50, 200);
    await demoteToLegacyManifest(runsDir, runId);

    const paths = runPaths(runsDir, runId);
    const before = {
      manifest: await readFile(paths.manifest, 'utf8'),
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
      entries: (await readdir(paths.root)).sort(),
    };

    const [summary] = await listCockpitRuns(depsOf(runsDir));
    const view = await getRunView(depsOf(runsDir), runId);
    const timeline = await getTimeline(depsOf(runsDir), runId, { pageSize: 25 });
    const recovery = await getRecoveryView(depsOf(runsDir), runId);

    t.diagnostic(
      `legacy · pinné=${String(view.runtime_pinned)} · révision=${view.revision.slice(0, 16)}… · ` +
        `entrées=${String(timeline.total)} · vivacité=${recovery.liveness.liveness}`,
    );

    assert.equal(summary?.runtime_pinned, false);
    assert.equal(view.runtime_pinned, false);
    assert.equal(view.runtime, null, 'aucun snapshot synthétisé');
    assert.match(view.revision, /^sha256:[0-9a-f]{64}$/);
    assert.equal(timeline.total, 50);
    assert.equal(recovery.liveness.liveness, 'NONE');
    assert.ok(view.capabilities.capabilities.length > 0);

    // Lecture strictement passive.
    assert.equal(await readFile(paths.manifest, 'utf8'), before.manifest, 'manifest intact');
    assert.equal(await readFile(paths.state, 'utf8'), before.state, 'état intact');
    assert.equal(await readFile(paths.events, 'utf8'), before.events, 'journal intact');
    assert.deepEqual((await readdir(paths.root)).sort(), before.entries, 'aucun fichier créé');
  } finally {
    await removeTempDir(dir);
  }
});
