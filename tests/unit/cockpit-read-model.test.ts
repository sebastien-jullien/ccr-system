/**
 * Read model du cockpit (V2-IMP-33, Slice 1).
 *
 * Trois exigences structurantes y sont éprouvées :
 *
 *  1. la **liste** n'ouvre jamais un journal — un journal énorme ou corrompu
 *     ne doit pas la ralentir ni la faire échouer ;
 *  2. aucune règle métier n'est reconstruite : révision, capacités, vivacité et
 *     plan de transfert viennent des primitives du Slice 0 ;
 *  3. `maxTransferBytes` est composé **une seule fois** et partagé — c'est la
 *     fermeture de la limite L1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_TIMELINE_PAGE_SIZE,
  decodeTimelineCursor,
  encodeTimelineCursor,
  getRecoveryView,
  getRunView,
  getTimeline,
  lastActivityOf,
  listCockpitRuns,
  projectTimeline,
  RECOVERY_CAPABILITY_IDS,
} from '../../src/services/cockpit-read-model.ts';
import type { CockpitReadModelDeps } from '../../src/services/cockpit-read-model.ts';
import { isLongRunningRecovery } from '../../src/services/recovery-planner.ts';
import { lockTokenFor } from '../../src/lock/lock-token.ts';
import { composeCcrApplication } from '../../src/cli/composition.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { DEFAULT_MAX_TRANSFER_BYTES } from '../../src/services/transfer.ts';
import { stepRun } from '../../src/services/run-service.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import { buildInitialState, writeManifest, writeState } from '../../src/store/state-store.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { openDecisionStore } from '../../src/store/decision-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { MANIFEST_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { NewCcrEvent, PendingOperation, RunManifest, RunStateDocument } from '../../src/core/run.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { demoteToLegacyManifest } from '../helpers/legacy-run.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const T = '2026-08-08T00:00:00.000Z';
const SETTINGS = { maxTransferBytes: DEFAULT_MAX_TRANSFER_BYTES };

function manifestOf(runId: string, claude: string | null = 'claude-1', codex: string | null = 'codex-1'): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    title: `Titre ${runId}`,
    created_at: T,
    workspace: { cwd: 'E:/prog/exemple' },
    agents: {
      claude: { session_id: claude, role: 'challenger' },
      codex: { session_id: codex, role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
  };
}

interface RunSpec {
  readonly runId: string;
  readonly state?: Partial<RunStateDocument>;
  readonly manifest?: RunManifest;
  readonly events?: readonly NewCcrEvent[];
  readonly decisions?: readonly { content: string; timestamp: string }[];
  /** Écrit tel quel, sans passer par les stores : fixtures pathologiques. */
  readonly rawEvents?: string;
  readonly rawDecisions?: string;
  readonly legacy?: boolean;
}

async function materialize(runsDir: string, spec: RunSpec): Promise<void> {
  const paths = runPaths(runsDir, spec.runId);
  await mkdir(paths.root, { recursive: true });
  await writeManifest(paths, spec.manifest ?? manifestOf(spec.runId));
  await writeState(paths, {
    ...buildInitialState(spec.runId, 'READY', new Date(T)),
    ...spec.state,
  });

  if (spec.events !== undefined) {
    const store = await openEventStore(paths, spec.runId);
    for (const event of spec.events) await store.append(event);
  }
  if (spec.decisions !== undefined) {
    const store = await openDecisionStore(paths, spec.runId);
    for (const decision of spec.decisions) {
      await store.append({ round: 0, author: 'human', status: 'ACTIVE', ...decision });
    }
  }
  if (spec.rawEvents !== undefined) await writeFile(paths.events, spec.rawEvents, 'utf8');
  if (spec.rawDecisions !== undefined) await writeFile(paths.decisions, spec.rawDecisions, 'utf8');
  if (spec.legacy === true) await demoteToLegacyManifest(runsDir, spec.runId);
}

async function box(prefix: string): Promise<{ dir: string; runsDir: string; deps: CockpitReadModelDeps; cleanup(): Promise<void> }> {
  const dir = await makeTempDir(prefix);
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  return { dir, runsDir, deps: { runsDir, settings: SETTINGS }, cleanup: () => removeTempDir(dir) };
}

const RUN_CREATED: NewCcrEvent = { round: 0, actor: 'system', type: 'run_created', content: 'T', timestamp: T };

function codexResponse(content: string, timestamp = T): NewCcrEvent {
  return { round: 0, actor: 'codex', type: 'assistant_response', session_id: 'codex-1', content, timestamp };
}

// --------------------------------------------------------------------------
// (1 à 12) Liste
// --------------------------------------------------------------------------

test('(1) data root vide', async () => {
  const b = await box('ccr-rm-empty-');
  try {
    assert.deepEqual(await listCockpitRuns(b.deps), []);
  } finally {
    await b.cleanup();
  }
});

test('(2/3/4/6) runs multiples, ordre déterministe, run fermé', async () => {
  const b = await box('ccr-rm-list-');
  try {
    await materialize(b.runsDir, { runId: 'CCR-20260808-003', state: { state: 'CLOSED', control: 'HUMAN' } });
    await materialize(b.runsDir, { runId: 'CCR-20260402-001' });
    await materialize(b.runsDir, { runId: 'CCR-20260808-002', state: { state: 'PAUSED', control: 'HUMAN' } });

    const first = await listCockpitRuns(b.deps);
    const second = await listCockpitRuns(b.deps);

    assert.deepEqual(
      first.map((r) => r.run_id),
      ['CCR-20260402-001', 'CCR-20260808-002', 'CCR-20260808-003'],
      'ordre canonique croissant',
    );
    assert.deepEqual(first, second, 'ordre déterministe entre deux appels');

    assert.equal(first[0]?.state, 'READY');
    assert.equal(first[0]?.attention, 'NONE');
    assert.equal(first[1]?.attention, 'HUMAN_INPUT', 'PAUSED/HUMAN appelle une intervention');
    assert.equal(first[2]?.state, 'CLOSED');
    assert.equal(first[0]?.runtime_pinned, true);
    assert.equal(first[0]?.created_at, T);
  } finally {
    await b.cleanup();
  }
});

test('(5) un run legacy est listé sans être pinné ni migré', async () => {
  const b = await box('ccr-rm-legacy-list-');
  try {
    await materialize(b.runsDir, { runId: 'CCR-20260402-001', legacy: true });
    const before = await readFile(runPaths(b.runsDir, 'CCR-20260402-001').manifest, 'utf8');

    const [summary] = await listCockpitRuns(b.deps);
    assert.equal(summary?.runtime_pinned, false);
    assert.equal(summary?.unreadable, false);

    assert.equal(await readFile(runPaths(b.runsDir, 'CCR-20260402-001').manifest, 'utf8'), before);
  } finally {
    await b.cleanup();
  }
});

test('(7) un run illisible n’empêche pas de lister les autres', async () => {
  const b = await box('ccr-rm-broken-');
  try {
    await materialize(b.runsDir, { runId: 'CCR-20260402-001' });
    await materialize(b.runsDir, { runId: 'CCR-20260808-002' });
    await materialize(b.runsDir, { runId: 'CCR-20260808-003' });
    // Le run B est corrompu.
    await writeFile(runPaths(b.runsDir, 'CCR-20260808-002').state, '{ "schema_version": 2,', 'utf8');

    const runs = await listCockpitRuns(b.deps);
    assert.equal(runs.length, 3, 'les runs valides restent listés');
    assert.equal(runs[0]?.unreadable, false);
    assert.equal(runs[2]?.unreadable, false);

    const broken = runs[1];
    assert.equal(broken?.run_id, 'CCR-20260808-002');
    assert.equal(broken?.unreadable, true);
    assert.equal(broken?.unreadable_reason, 'STATE_INVALID', 'code fermé');

    // Aucune fuite : ni contenu corrompu, ni pile, ni chemin interne.
    const serialized = JSON.stringify(broken);
    assert.ok(!serialized.includes('schema_version'), 'aucun contenu corrompu');
    assert.ok(!serialized.toLowerCase().includes('temp'), 'aucun chemin interne');
    assert.ok(!serialized.includes('at Object'), 'aucune pile');
  } finally {
    await b.cleanup();
  }
});

test('(8/9/10) la liste n’ouvre jamais events, decisions ni rounds', async (t) => {
  const b = await box('ccr-rm-nojournal-');
  try {
    // Journaux **corrompus et volumineux** : les ouvrir échouerait bruyamment.
    const huge = `${'{"bidon":true}\n'.repeat(20_000)}CORROMPU-PAS-DU-JSON\n`;
    for (const runId of ['CCR-20260402-001', 'CCR-20260808-002']) {
      await materialize(b.runsDir, { runId, rawEvents: huge, rawDecisions: huge });
      const roundDir = path.join(runPaths(b.runsDir, runId).roundsDir, '001', 'raw');
      await mkdir(roundDir, { recursive: true });
      await writeFile(path.join(roundDir, 'claude.stdout'), 'x'.repeat(200_000), 'utf8');
    }

    const started = Date.now();
    const runs = await listCockpitRuns(b.deps);
    const elapsed = Date.now() - started;

    t.diagnostic(`2 runs à journaux corrompus de ~300 KiB · liste en ${String(elapsed)} ms`);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => !r.unreadable), 'un journal corrompu n’affecte pas la liste');

    // Preuve structurelle complémentaire : la liste n'importe pas les stores.
    const source = await readFile(new URL('../../src/services/cockpit-read-model.ts', import.meta.url), 'utf8');
    const listBody = source.slice(
      source.indexOf('export async function listCockpitRuns'),
      source.indexOf('export interface HandoffAdvice'),
    );
    assert.ok(listBody.length > 200 && listBody.length < 3_000, 'découpe du corps de la liste valide');
    for (const forbidden of ['openEventStore', 'openDecisionStore', 'readStableRunSnapshot', 'roundsDir']) {
      assert.ok(!listBody.includes(forbidden), `la liste n’utilise pas ${forbidden}`);
    }
  } finally {
    await b.cleanup();
  }
});

test('(12) lister ne modifie aucun fichier', async () => {
  const b = await box('ccr-rm-immutable-');
  try {
    await materialize(b.runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED] });
    const paths = runPaths(b.runsDir, 'CCR-20260402-001');
    const before = {
      manifest: await readFile(paths.manifest, 'utf8'),
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
      entries: await readdir(paths.root),
    };

    await listCockpitRuns(b.deps);

    assert.equal(await readFile(paths.manifest, 'utf8'), before.manifest);
    assert.equal(await readFile(paths.state, 'utf8'), before.state);
    assert.equal(await readFile(paths.events, 'utf8'), before.events);
    assert.deepEqual(await readdir(paths.root), before.entries);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (13 à 25) RunView
// --------------------------------------------------------------------------

test('(13/14/16/18/20/22) vue d’un run moderne', async () => {
  const b = await box('ccr-rm-view-');
  try {
    await materialize(b.runsDir, {
      runId: 'CCR-20260402-001',
      events: [RUN_CREATED, codexResponse('réponse')],
    });

    const view = await getRunView(b.deps, 'CCR-20260402-001');
    const snapshot = await readStableRunSnapshot(b.runsDir, 'CCR-20260402-001');

    assert.equal(view.revision, snapshot.revision, 'exactement la révision 0C');
    assert.equal(view.runtime_pinned, true);
    assert.deepEqual(view.runtime, TEST_RUNTIME_CONFIG);
    assert.deepEqual(view.sessions, { claude: 'claude-1', codex: 'codex-1' });
    assert.equal(view.state.state, 'READY');
    assert.equal(view.counts.events, 2);

    const step = view.capabilities.capabilities.find((c) => c.id === 'STEP');
    assert.equal(step?.allowed, true, 'source transférable disponible');
    const send = view.capabilities.capabilities.find((c) => c.id === 'SEND');
    assert.deepEqual(send?.targets, ['claude', 'codex']);
  } finally {
    await b.cleanup();
  }
});

test('(15) vue d’un run legacy : non pinné, aucun snapshot synthétisé', async () => {
  const b = await box('ccr-rm-view-legacy-');
  try {
    await materialize(b.runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED], legacy: true });
    const paths = runPaths(b.runsDir, 'CCR-20260402-001');
    const before = await readFile(paths.manifest, 'utf8');

    const view = await getRunView(b.deps, 'CCR-20260402-001');
    assert.equal(view.runtime_pinned, false);
    assert.equal(view.runtime, null, 'aucun snapshot fabriqué');
    assert.equal(await readFile(paths.manifest, 'utf8'), before, 'aucune migration');
  } finally {
    await b.cleanup();
  }
});

test('(17) l’activité canonique inclut une décision plus récente que l’état', async () => {
  const b = await box('ccr-rm-activity-');
  try {
    const later = '2026-08-09T12:00:00.000Z';
    await materialize(b.runsDir, {
      runId: 'CCR-20260402-001',
      events: [RUN_CREATED],
      decisions: [{ content: 'décision tardive', timestamp: later }],
    });

    const view = await getRunView(b.deps, 'CCR-20260402-001');
    assert.equal(view.state.updated_at, T, 'l’état est resté au timestamp initial');
    assert.equal(view.last_activity_at, later, 'l’activité canonique voit la décision');

    const snapshot = await readStableRunSnapshot(b.runsDir, 'CCR-20260402-001');
    assert.equal(lastActivityOf(snapshot), later);
  } finally {
    await b.cleanup();
  }
});

test('(19) une évidence runtime différente ne change jamais la révision', async () => {
  const b = await box('ccr-rm-evidence-');
  try {
    await materialize(b.runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED] });
    const paths = runPaths(b.runsDir, 'CCR-20260402-001');

    const withoutLock = await getRunView(b.deps, 'CCR-20260402-001');

    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const lock = await acquireRunLock(paths, 'step');
    try {
      const withLock = await getRunView(b.deps, 'CCR-20260402-001');
      assert.equal(withLock.revision, withoutLock.revision, 'même révision');
      assert.notEqual(
        withLock.liveness.lock_observation,
        withoutLock.liveness.lock_observation,
        'mais une observation différente',
      );
    } finally {
      await lock.release();
    }
  } finally {
    await b.cleanup();
  }
});

test('(23) le handoff est informatif, jamais une capacité', async () => {
  const b = await box('ccr-rm-handoff-');
  try {
    await materialize(b.runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED] });
    const ready = await getRunView(b.deps, 'CCR-20260402-001');

    assert.ok(
      !ready.capabilities.capabilities.some((c) => String(c.id).includes('HANDOFF')),
      'aucune capacité de handoff',
    );
    // En READY/AUTOMATION la primitive V1 refuse : la V0.1 disait l'inverse.
    assert.equal(ready.handoff_cli.available, false);
    assert.equal(ready.handoff_cli.reason, 'HANDOFF_NOT_ALLOWED');
    assert.deepEqual(
      ready.handoff_cli.agents.map((a) => a.command),
      [
        'ccr handoff claude --run CCR-20260402-001',
        'ccr handoff codex --run CCR-20260402-001',
      ],
    );

    await materialize(b.runsDir, {
      runId: 'CCR-20260808-002',
      events: [RUN_CREATED],
      state: { state: 'PAUSED', control: 'HUMAN' },
    });
    const paused = await getRunView(b.deps, 'CCR-20260808-002');
    assert.equal(paused.handoff_cli.available, true);
  } finally {
    await b.cleanup();
  }
});

test('(24/25) instabilité et corruption ne sont pas confondues', async () => {
  const b = await box('ccr-rm-unstable-');
  try {
    // Corruption stable : elle reste une corruption.
    await materialize(b.runsDir, {
      runId: 'CCR-20260402-001',
      rawEvents: '{"event_id":"evt_000001","run_id":"x","round":0,"actor":"system","type":"run_created","timestamp":"' + T + '"}\nCASSE\n',
    });
    await assert.rejects(
      () => getRunView(b.deps, 'CCR-20260402-001'),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );

    // Instabilité : code distinct, remonté tel quel.
    await materialize(b.runsDir, { runId: 'CCR-20260808-002', events: [RUN_CREATED] });
    const paths = runPaths(b.runsDir, 'CCR-20260808-002');
    let writes = 0;
    await assert.rejects(
      async () => {
        const { readStableRunSnapshot: read } = await import('../../src/store/run-snapshot.ts');
        await read(b.runsDir, 'CCR-20260808-002', {
          sleep: async () => undefined,
          journal: {
            read: async (file) => {
              writes += 1;
              const store = await openEventStore(paths, 'CCR-20260808-002');
              await store.append({ round: 0, actor: 'system', type: 'state_changed', details: { n: writes }, timestamp: T });
              return readFile(file, 'utf8');
            },
          },
        });
      },
      (error: unknown) => isCcrError(error) && error.code === 'SNAPSHOT_UNSTABLE',
    );
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (26 à 38) Timeline
// --------------------------------------------------------------------------

test('(26/27/28/29/31/32/33) projection, ordre, lien structurel, orpheline', async () => {
  const b = await box('ccr-rm-timeline-');
  try {
    const paths = runPaths(b.runsDir, 'CCR-20260402-001');
    await materialize(b.runsDir, {
      runId: 'CCR-20260402-001',
      events: [RUN_CREATED, codexResponse('réponse', '2026-08-08T00:00:02.000Z')],
    });

    // Décision liée : store + événement portant `details.decision_id`.
    const decisions = await openDecisionStore(paths, 'CCR-20260402-001');
    const linked = await decisions.append({
      round: 0,
      author: 'human',
      status: 'ACTIVE',
      content: 'décision liée',
      timestamp: '2026-08-08T00:00:03.000Z',
    });
    const events = await openEventStore(paths, 'CCR-20260402-001');
    await events.append({
      round: 0,
      actor: 'human',
      type: 'decision_recorded',
      content: 'décision liée',
      details: { decision_id: linked.decision_id, status: 'ACTIVE' },
      timestamp: '2026-08-08T00:00:03.000Z',
    });

    // Décision orpheline : écrite sans son événement.
    await decisions.append({
      round: 0,
      author: 'human',
      status: 'ACTIVE',
      content: 'décision orpheline',
      timestamp: '2026-08-08T00:00:04.000Z',
    });

    const page = await getTimeline(b.deps, 'CCR-20260402-001');

    const kinds = page.entries.map((e) => `${e.kind}:${e.kind === 'event' ? e.type : e.decision_id}`);
    assert.deepEqual(kinds, [
      'event:run_created',
      'event:assistant_response',
      'decision:DEC-0001',
      'decision:DEC-0002',
    ]);

    // La décision liée apparaît UNE fois, en conservant sa provenance.
    const linkedEntry = page.entries[2];
    assert.ok(linkedEntry?.kind === 'decision');
    assert.equal(linkedEntry.orphan_decision, false);
    assert.match(String(linkedEntry.event_id), /^evt_/);
    assert.equal(
      page.entries.filter((e) => e.kind === 'event' && e.type === 'decision_recorded').length,
      0,
      'l’événement lié est absorbé, jamais dupliqué',
    );

    // L'orpheline est exposée, jamais supprimée.
    const orphan = page.entries[3];
    assert.ok(orphan?.kind === 'decision');
    assert.equal(orphan.orphan_decision, true);
    assert.equal(orphan.event_id, null);
  } finally {
    await b.cleanup();
  }
});

test('(30) horodatages égaux : départage déterministe et documenté', () => {
  const same = '2026-08-08T00:00:00.000Z';
  const entries = projectTimeline(
    [
      { event_id: 'evt_000002', run_id: 'r', round: 0, actor: 'system', type: 'state_changed', timestamp: same },
      { event_id: 'evt_000001', run_id: 'r', round: 0, actor: 'system', type: 'run_created', timestamp: same },
    ],
    [
      { decision_id: 'DEC-0002', run_id: 'r', round: 0, author: 'human', status: 'ACTIVE', content: 'b', timestamp: same },
      { decision_id: 'DEC-0001', run_id: 'r', round: 0, author: 'human', status: 'ACTIVE', content: 'a', timestamp: same },
    ],
  );

  assert.deepEqual(
    entries.map((e) => (e.kind === 'event' ? e.event_id : e.decision_id)),
    ['evt_000001', 'evt_000002', 'DEC-0001', 'DEC-0002'],
    'événements avant décisions, puis identifiant croissant',
  );

  // Déterminisme : l'ordre d'entrée ne change rien.
  const reversed = projectTimeline(
    [
      { event_id: 'evt_000001', run_id: 'r', round: 0, actor: 'system', type: 'run_created', timestamp: same },
      { event_id: 'evt_000002', run_id: 'r', round: 0, actor: 'system', type: 'state_changed', timestamp: same },
    ],
    [
      { decision_id: 'DEC-0001', run_id: 'r', round: 0, author: 'human', status: 'ACTIVE', content: 'a', timestamp: same },
      { decision_id: 'DEC-0002', run_id: 'r', round: 0, author: 'human', status: 'ACTIVE', content: 'b', timestamp: same },
    ],
  );
  assert.deepEqual(entries, reversed);
});

test('(33 bis) aucune déduplication heuristique sur texte, auteur ou horodatage', () => {
  const same = '2026-08-08T00:00:00.000Z';
  // Deux décisions identiques en tout sauf leur identifiant : elles restent deux.
  const entries = projectTimeline(
    [],
    [
      { decision_id: 'DEC-0001', run_id: 'r', round: 0, author: 'human', status: 'ACTIVE', content: 'même texte', timestamp: same },
      { decision_id: 'DEC-0002', run_id: 'r', round: 0, author: 'human', status: 'ACTIVE', content: 'même texte', timestamp: same },
    ],
  );
  assert.equal(entries.length, 2);
});

test('(34/35/36/37/38) pagination, curseur et révision', async () => {
  const b = await box('ccr-rm-pagination-');
  try {
    const events: NewCcrEvent[] = [RUN_CREATED];
    for (let i = 0; i < 9; i += 1) {
      events.push({
        round: 0,
        actor: 'system',
        type: 'state_changed',
        details: { n: i },
        timestamp: new Date(Date.parse(T) + (i + 1) * 1000).toISOString(),
      });
    }
    await materialize(b.runsDir, { runId: 'CCR-20260402-001', events });
    const paths = runPaths(b.runsDir, 'CCR-20260402-001');
    const before = await readFile(paths.events, 'utf8');

    // (36) pagination multi-page
    const page1 = await getTimeline(b.deps, 'CCR-20260402-001', { pageSize: 4 });
    assert.equal(page1.entries.length, 4);
    assert.equal(page1.truncated, true);
    assert.equal(page1.total, 10);
    assert.ok(page1.cursor_next !== null);

    const page2 = await getTimeline(b.deps, 'CCR-20260402-001', { pageSize: 4, cursor: page1.cursor_next });
    assert.equal(page2.entries.length, 4);
    assert.equal(page2.revision, page1.revision);

    const page3 = await getTimeline(b.deps, 'CCR-20260402-001', { pageSize: 4, cursor: page2.cursor_next ?? undefined });
    assert.equal(page3.entries.length, 2);
    assert.equal(page3.truncated, false);
    assert.equal(page3.cursor_next, null);

    // Aucun recouvrement, aucun trou.
    const ids = [...page1.entries, ...page2.entries, ...page3.entries].map((e) =>
      e.kind === 'event' ? e.event_id : e.decision_id,
    );
    assert.equal(new Set(ids).size, 10);

    // (34/35) curseur valide / invalide
    assert.deepEqual(decodeTimelineCursor(encodeTimelineCursor(page1.revision, 4)), {
      r: page1.revision,
      o: 4,
    });
    for (const bad of ['pas-du-base64!!', Buffer.from('{"r":"x","o":1}').toString('base64url'), Buffer.from('{"r":"' + page1.revision + '","o":-1}').toString('base64url')]) {
      assert.throws(
        () => decodeTimelineCursor(bad),
        (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
      );
    }

    // (37) la révision change entre deux pages → refus, jamais fusion
    const store = await openEventStore(paths, 'CCR-20260402-001');
    await store.append({ round: 0, actor: 'system', type: 'state_changed', details: { n: 99 }, timestamp: T });
    await assert.rejects(
      () => getTimeline(b.deps, 'CCR-20260402-001', { pageSize: 4, cursor: page1.cursor_next ?? undefined }),
      (error: unknown) => isCcrError(error) && error.code === 'STALE_REVISION',
    );

    // (38) lire ne modifie rien — hors l'append volontaire ci-dessus
    assert.ok((await readFile(paths.events, 'utf8')).startsWith(before));
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (39 à 50) RecoveryView
// --------------------------------------------------------------------------

const PENDING_STEP: PendingOperation = {
  kind: 'step',
  agent: 'claude',
  round: 1,
  prompt_event_id: 'evt_000002',
  source_event_id: null,
  session_id: 'claude-1',
  return_state: 'READY',
  return_control: 'AUTOMATION',
  started_at: T,
};

test('(39/40/41) run normal, opération en vol et indétermination n’ouvrent aucune recovery', async () => {
  const b = await box('ccr-rm-recovery-none-');
  try {
    await materialize(b.runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED] });
    const normal = await getRecoveryView(b.deps, 'CCR-20260402-001');
    assert.equal(normal.liveness.liveness, 'NONE');
    assert.deepEqual(normal.capabilities, []);
    assert.equal(normal.liveness.needs_human_attention, false);

    // (40) Opération réellement en vol : verrou détenu ET registre lié.
    await materialize(b.runsDir, {
      runId: 'CCR-20260808-002',
      events: [RUN_CREATED],
      state: {
        state: 'WAITING_AGENT',
        pending_operation: { ...PENDING_STEP, started_at: new Date(Date.now() + 60_000).toISOString() },
      },
    });
    const paths = runPaths(b.runsDir, 'CCR-20260808-002');
    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const { createHostOperationRegistry } = await import('../../src/lock/host-operation-registry.ts');
    const registry = createHostOperationRegistry();
    const op = registry.begin('CCR-20260808-002', 'step');
    const lock = await acquireRunLock(paths, 'step', {
      onIdentityPrepared: (info) => registry.bindLock(op, info.lock_id),
    });
    try {
      const inFlight = await getRecoveryView(
        { runsDir: b.runsDir, settings: SETTINGS, hostRegistry: registry },
        'CCR-20260808-002',
      );
      assert.equal(inFlight.liveness.liveness, 'OPERATION_IN_FLIGHT');
      assert.deepEqual(inFlight.capabilities, [], 'une opération vivante n’ouvre aucune recovery');
      assert.equal(inFlight.liveness.needs_human_attention, false);

      // (41) Même verrou, SANS registre : indétermination, et toujours rien.
      const undetermined = await getRecoveryView(b.deps, 'CCR-20260808-002');
      assert.equal(undetermined.liveness.liveness, 'UNDETERMINED');
      assert.deepEqual(undetermined.capabilities, [], 'ne pas savoir n’ouvre rien non plus');
      assert.equal(undetermined.liveness.needs_human_attention, false);
    } finally {
      await lock.release();
      registry.end(op);
    }
  } finally {
    await b.cleanup();
  }
});

test('(42) initialisation partielle → continuation, et elle seule', async () => {
  const b = await box('ccr-rm-recovery-partial-');
  try {
    await materialize(b.runsDir, {
      runId: 'CCR-20260402-001',
      manifest: manifestOf('CCR-20260402-001', 'claude-1', null),
      events: [RUN_CREATED],
      state: { state: 'FAILED_INITIALIZATION' },
    });

    const view = await getRecoveryView(b.deps, 'CCR-20260402-001');
    assert.equal(view.liveness.liveness, 'PARTIAL_INITIALIZATION');
    assert.deepEqual(
      view.capabilities.map((c) => c.id),
      ['RECOVERY_CONTINUE_INITIALIZATION'],
    );
    assert.equal(view.capabilities[0]?.long_running, true, 'lance un appel fournisseur');
    assert.equal(view.capabilities[0]?.requires_confirmation, true);
    assert.deepEqual(view.sessions, { claude: 'PRESENT', codex: 'ABSENT' });
  } finally {
    await b.cleanup();
  }
});

test('(43/44/45) ambiguïté, finalisation déterministe et acquittement', async () => {
  const b = await box('ccr-rm-recovery-amb-');
  try {
    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    void acquireRunLock;

    // (44) réponse déjà journalisée + aucun verrou → finalisation déterministe
    await materialize(b.runsDir, {
      runId: 'CCR-20260402-001',
      events: [
        RUN_CREATED,
        { round: 1, actor: 'system', type: 'prompt_sent', target: 'claude', content: 'p', timestamp: T },
        { round: 1, actor: 'claude', type: 'assistant_response', content: 'r', based_on: ['evt_000002'], timestamp: T },
      ],
      state: { state: 'WAITING_AGENT', pending_operation: PENDING_STEP },
    });
    const finalizable = await getRecoveryView(b.deps, 'CCR-20260402-001');
    assert.equal(finalizable.known_facts.pending_response_journaled, true);
    assert.equal(finalizable.liveness.liveness, 'ABANDONED_OPERATION');
    assert.deepEqual(
      finalizable.capabilities.map((c) => c.id),
      ['RECOVERY_FINALIZE_JOURNALED_RESPONSE'],
    );
    assert.equal(finalizable.capabilities[0]?.long_running, false, 'aucun appel agent');

    // (43) pending sans réponse → ambiguïté à matérialiser
    await materialize(b.runsDir, {
      runId: 'CCR-20260808-002',
      events: [RUN_CREATED],
      state: { state: 'WAITING_AGENT', pending_operation: PENDING_STEP },
    });
    const ambiguous = await getRecoveryView(b.deps, 'CCR-20260808-002');
    assert.equal(ambiguous.known_facts.pending_response_journaled, false);

    // (45) RECOVERY_REQUIRED → acquittement humain, texte obligatoire
    await materialize(b.runsDir, {
      runId: 'CCR-20260808-003',
      events: [RUN_CREATED],
      state: {
        state: 'RECOVERY_REQUIRED',
        control: 'HUMAN',
        pending_operation: PENDING_STEP,
        uncertainty: { reason: 'tour engagé sans réponse', since: T, agent: 'claude', last_event_id: 'evt_000001' },
      },
    });
    const required = await getRecoveryView(b.deps, 'CCR-20260808-003');
    assert.equal(required.liveness.liveness, 'AMBIGUOUS');
    assert.deepEqual(
      required.capabilities.map((c) => c.id),
      ['RECOVERY_ACKNOWLEDGE_AMBIGUITY'],
    );
    assert.equal(required.capabilities[0]?.requires_acknowledgement_text, true);
    const invocation = required.capabilities[0]?.invocation;
    assert.ok(invocation !== undefined && invocation.primitive === 'recoverRun');
    assert.equal(invocation.acknowledge, 'REQUIRED');
    assert.equal(required.ambiguity?.reason, 'tour engagé sans réponse');
    assert.equal(required.ambiguity?.since, T);
  } finally {
    await b.cleanup();
  }
});

test('(46) verrou orphelin : la levée est annoncée, et aucune capacité canonique inventée', async () => {
  const b = await box('ccr-rm-recovery-lock-');
  try {
    await materialize(b.runsDir, {
      runId: 'CCR-20260402-001',
      events: [RUN_CREATED],
      state: { state: 'WAITING_AGENT', pending_operation: PENDING_STEP },
    });
    const paths = runPaths(b.runsDir, 'CCR-20260402-001');
    const { hostname } = await import('node:os');
    await writeFile(
      path.join(paths.root, '.ccr.lock'),
      JSON.stringify({ lock_id: 'l', pid: 2 ** 30, hostname: hostname(), started_at: T, command: 'step' }, null, 2),
      'utf8',
    );
    const before = await readFile(path.join(paths.root, '.ccr.lock'), 'utf8');

    const view = await getRecoveryView(b.deps, 'CCR-20260402-001');
    assert.equal(view.liveness.liveness, 'ORPHAN_LOCK');

    // L'endpoint existe désormais : la vue peut annoncer la levée, et elle
    // porte le jeton du verrou réellement observé — pas un identifiant générique
    // qui laisserait au client le soin de désigner « un verrou périmé ».
    assert.deepEqual(view.capabilities.map((c) => c.id), ['RECOVERY_CLEAR_STALE_LOCK']);
    const clear = view.capabilities[0];
    assert.equal(clear?.destructive, true);
    assert.equal(clear?.requires_confirmation, true);
    assert.equal(clear?.long_running, false);
    assert.equal(clear?.invocation.primitive, 'clearStaleRunLock');
    assert.match(
      clear?.invocation.primitive === 'clearStaleRunLock' ? clear.invocation.observed_lock_token : '',
      /^lt1:[A-Za-z0-9_-]{43}$/,
    );

    // Plus rien ne manque : la liste est vide par complétude, non par omission.
    assert.deepEqual(view.missing_primitives, []);

    // Aucune capacité canonique n'est inventée au passage : un verrou orphelin
    // n'autorise pas une reprise, il autorise seulement sa propre levée.
    assert.equal(
      view.capabilities.some((c) => c.id.startsWith('RECOVERY_') && c.id !== 'RECOVERY_CLEAR_STALE_LOCK'),
      false,
    );

    // (50) lecture strictement passive
    assert.equal(await readFile(path.join(paths.root, '.ccr.lock'), 'utf8'), before);
  } finally {
    await b.cleanup();
  }
});

test('(48/49) chaque capacité correspond à une invocation réelle, aucune générique', () => {
  assert.deepEqual([...RECOVERY_CAPABILITY_IDS], [
    'RECOVERY_FINALIZE_JOURNALED_RESPONSE',
    'RECOVERY_CONTINUE_INITIALIZATION',
    'RECOVERY_MATERIALIZE_AMBIGUITY',
    'RECOVERY_ACKNOWLEDGE_AMBIGUITY',
    'RECOVERY_CLEAR_STALE_LOCK',
  ]);
  for (const id of RECOVERY_CAPABILITY_IDS) {
    assert.ok(!['RECOVER', 'FIX', 'CONTINUE'].includes(id), `identifiant générique interdit : ${id}`);
  }
  // Une seule invocation joint un fournisseur, et le cœur le déclare lui-même.
  assert.deepEqual(
    RECOVERY_CAPABILITY_IDS.filter((id) => isLongRunningRecovery(id)),
    ['RECOVERY_CONTINUE_INITIALIZATION'],
  );
});

// --------------------------------------------------------------------------
// (21) Composition unique de `maxTransferBytes`
// --------------------------------------------------------------------------

test('(21) le read model et le service partagent la MÊME limite effective', async (t) => {
  const b = await box('ccr-rm-limit-');
  try {
    const app = composeCcrApplication({ runsDir: b.runsDir, env: { CCR_MAX_TRANSFER_BYTES: '4096' } });

    // Une seule valeur effective, partagée par les deux couches.
    assert.equal(app.settings.maxTransferBytes, 4096);
    assert.equal(app.runService.maxTransferBytes, 4096);
    assert.equal(app.readModel.settings.maxTransferBytes, 4096);
    assert.equal(app.readModel.settings, app.settings, 'le MÊME objet, pas une copie');

    // Preuve comportementale : sous, à, et au-dessus de la limite.
    const deps = (runsDir: string): RunServiceDeps => ({
      ...app.runService,
      runsDir,
      createAdapters: () => ({
        claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
        codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
      }),
    });

    for (const [label, size, expected] of [
      ['sous la limite', 1_000, true],
      ['au-delà de la limite', 8_000, false],
    ] as const) {
      const runId = 'CCR-20260402-001';
      const local = await box(`ccr-rm-limit-${String(size)}-`);
      try {
        await materialize(local.runsDir, { runId, events: [RUN_CREATED, codexResponse('x'.repeat(size))] });
        const readModel = { runsDir: local.runsDir, settings: app.settings };

        const view = await getRunView(readModel, runId);
        const step = view.capabilities.capabilities.find((c) => c.id === 'STEP');

        let serviceOk = true;
        let serviceCode = '';
        try {
          await stepRun(deps(local.runsDir), { runId });
        } catch (error) {
          serviceOk = false;
          serviceCode = isCcrError(error) ? error.code : 'INATTENDU';
        }

        t.diagnostic(`${label} : capacité=${String(step?.allowed)} · service=${String(serviceOk)} ${serviceCode}`);
        assert.equal(step?.allowed, expected, `${label} : capacité`);
        assert.equal(serviceOk, expected, `${label} : service`);
        if (!expected) {
          assert.equal(step?.reason, 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
          assert.equal(serviceCode, 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
        }
      } finally {
        await local.cleanup();
      }
    }
  } finally {
    await b.cleanup();
  }
});

test('la limite n’est résolue qu’à un seul endroit dans tout CCR', async () => {
  const { readFile: read } = await import('node:fs/promises');
  const { glob } = await import('node:fs/promises');
  const offenders: string[] = [];
  for await (const entry of glob('src/**/*.ts')) {
    if (entry.endsWith('run-execution-settings.ts')) continue;
    const source = await read(entry, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (code.includes('CCR_MAX_TRANSFER_BYTES')) offenders.push(entry);
  }
  assert.deepEqual(offenders, [], 'une seule résolution de la variable');

  // Et le read model ne fabrique aucune valeur par défaut de son côté.
  const readModel = await read(new URL('../../src/services/cockpit-read-model.ts', import.meta.url), 'utf8');
  assert.ok(!readModel.includes('DEFAULT_MAX_TRANSFER_BYTES'), 'la limite vient des settings partagés');
  assert.ok(!/\b512\s*\*\s*1024\b/.test(readModel), 'aucune constante recopiée');
  assert.equal(DEFAULT_TIMELINE_PAGE_SIZE, 200);
});

// --------------------------------------------------------------------------
// Sémantique de `attention` — la liste ne fabrique pas une précision qu'elle
// n'a pas (arbitrage pré-Slice 2)
// --------------------------------------------------------------------------

test('(A1-A8) matrice attention : dérivée du seul état canonique', async (t) => {
  const b = await box('ccr-rm-attention-');
  try {
    const cases: readonly {
      readonly label: string;
      readonly state: Partial<RunStateDocument>;
      readonly expected: string;
    }[] = [
      { label: '(1) READY / AUTOMATION', state: { state: 'READY', control: 'AUTOMATION' }, expected: 'NONE' },
      {
        label: '(2) WAITING_AGENT + opération en vol',
        state: { state: 'WAITING_AGENT', control: 'AUTOMATION', pending_operation: PENDING_STEP },
        expected: 'NONE',
      },
      {
        label: '(3) WAITING_AGENT legacy, sans contexte d’opération',
        state: { state: 'WAITING_AGENT', control: 'AUTOMATION', pending_operation: null },
        expected: 'NONE',
      },
      {
        label: '(4) RECOVERY_REQUIRED',
        state: { state: 'RECOVERY_REQUIRED', control: 'HUMAN', pending_operation: PENDING_STEP },
        expected: 'RECOVERY',
      },
      { label: '(5) FAILED_INITIALIZATION', state: { state: 'FAILED_INITIALIZATION' }, expected: 'INITIALIZATION' },
      { label: '(6) FAILED', state: { state: 'FAILED', control: 'HUMAN' }, expected: 'FAILED' },
      { label: '(7) PAUSED / HUMAN', state: { state: 'PAUSED', control: 'HUMAN' }, expected: 'HUMAN_INPUT' },
      { label: '(8) WAITING_HUMAN / HUMAN', state: { state: 'WAITING_HUMAN', control: 'HUMAN' }, expected: 'HUMAN_INPUT' },
    ];

    const observed: string[] = [];
    for (const [index, testCase] of cases.entries()) {
      const runId = `CCR-20260808-${String(index + 1).padStart(3, '0')}`;
      await materialize(b.runsDir, { runId, state: testCase.state });
      const summary = (await listCockpitRuns(b.deps)).find((r) => r.run_id === runId);
      observed.push(`${testCase.label} → ${String(summary?.attention)}`);
      assert.equal(summary?.attention, testCase.expected, testCase.label);
    }

    t.diagnostic(observed.join(' · '));
  } finally {
    await b.cleanup();
  }
});

test('(A4 bis) preuve structurelle : ni requiresRecovery, ni WAITING_AGENT ⇒ RECOVERY', async () => {
  const source = await readFile(new URL('../../src/services/cockpit-read-model.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function attentionOf');
  const body = source.slice(start, source.indexOf('}', source.indexOf('return \'NONE\';', start)));

  assert.ok(!body.includes('requiresRecovery'), 'aucune lecture de requiresRecovery');
  assert.ok(!body.includes('WAITING_AGENT'), 'aucune règle WAITING_AGENT ⇒ RECOVERY');
  assert.ok(!body.includes('pending_operation'), 'aucune règle pending_operation ⇒ RECOVERY');
  // `RECOVERY` n'est produit que par l'état qui matérialise déjà la situation.
  assert.match(body, /state === 'RECOVERY_REQUIRED'\) return 'RECOVERY'/);
  // Et la signature rend l'erreur non représentable.
  assert.match(source.slice(start, start + 120), /attentionOf\(state: RunState, control: ControlOwner\)/);
});

test('(A9/A10) evidence runtime différente : même attention, vivacité différente', async (t) => {
  const b = await box('ccr-rm-attention-evidence-');
  try {
    const runId = 'CCR-20260402-001';
    await materialize(b.runsDir, {
      runId,
      events: [RUN_CREATED],
      state: {
        state: 'WAITING_AGENT',
        control: 'AUTOMATION',
        pending_operation: { ...PENDING_STEP, started_at: new Date(Date.now() + 60_000).toISOString() },
      },
    });

    const paths = runPaths(b.runsDir, runId);
    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const { createHostOperationRegistry } = await import('../../src/lock/host-operation-registry.ts');

    // (A9) sans aucune évidence
    const attentionBefore = (await listCockpitRuns(b.deps))[0]?.attention;
    const livenessBefore = (await getRunView(b.deps, runId)).liveness.liveness;

    // Avec une opération de l'hôte réellement active
    const registry = createHostOperationRegistry();
    const op = registry.begin(runId, 'step');
    const lock = await acquireRunLock(paths, 'step', {
      onIdentityPrepared: (info) => registry.bindLock(op, info.lock_id),
    });
    try {
      const attentionDuring = (await listCockpitRuns(b.deps))[0]?.attention;
      const livenessDuring = (
        await getRunView({ runsDir: b.runsDir, settings: SETTINGS, hostRegistry: registry }, runId)
      ).liveness.liveness;

      t.diagnostic(
        `attention: ${String(attentionBefore)} → ${String(attentionDuring)} · ` +
          `liveness: ${livenessBefore} → ${livenessDuring}`,
      );

      // (A9) la liste ne bouge pas : elle ne voit pas l'évidence.
      assert.equal(attentionDuring, attentionBefore, 'même attention');
      assert.equal(attentionDuring, 'NONE', 'et jamais RECOVERY');

      // (A10) la vue détaillée, elle, distingue réellement les deux situations.
      assert.notEqual(livenessDuring, livenessBefore, 'la vivacité, elle, change');
      assert.equal(livenessDuring, 'OPERATION_IN_FLIGHT');
      assert.equal(livenessBefore, 'AMBIGUOUS');
    } finally {
      await lock.release();
      registry.end(op);
    }
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (51) Jeton d'identité de verrou — forme gelée (V2-IMP-40A §5)
// --------------------------------------------------------------------------

test('(51) le jeton de verrou est stable, discriminant, et ne divulgue rien', () => {
  const base = { lock_id: 'l-1', pid: 4242, hostname: 'poste-a', started_at: T, command: 'step' };
  const token = lockTokenFor('CCR-20260402-001', base);

  assert.match(token, /^lt1:[A-Za-z0-9_-]{43}$/, 'forme externe gelée');
  assert.equal(token.length, 47);
  assert.equal(lockTokenFor('CCR-20260402-001', base), token, 'stable : aucun sel, aucune horloge');

  // Chaque composante discrimine — une concaténation ambiguë ne le ferait pas.
  const variants = [
    ['run', () => lockTokenFor('CCR-20260808-002', base)],
    ['lock_id', () => lockTokenFor('CCR-20260402-001', { ...base, lock_id: 'l-2' })],
    ['pid', () => lockTokenFor('CCR-20260402-001', { ...base, pid: 4243 })],
    ['hostname', () => lockTokenFor('CCR-20260402-001', { ...base, hostname: 'poste-b' })],
    ['started_at', () => lockTokenFor('CCR-20260402-001', { ...base, started_at: '2026-08-09T00:00:00.000Z' })],
    ['command', () => lockTokenFor('CCR-20260402-001', { ...base, command: 'send' })],
  ] as const;
  for (const [what, produce] of variants) {
    assert.notEqual(produce(), token, `${what} ne discrimine pas`);
  }

  // Le déplacement d'une frontière entre deux champs doit changer le jeton :
  // c'est exactement ce qu'une concaténation sans encodage ne garantirait pas.
  assert.notEqual(
    lockTokenFor('CCR-20260402-001', { ...base, lock_id: 'l-14242', pid: 42 }),
    lockTokenFor('CCR-20260402-001', { ...base, lock_id: 'l-1', pid: 4242 }),
  );

  // Rien de l'hôte ne transparaît dans la forme rendue au navigateur.
  for (const secret of ['poste-a', '4242', 'l-1', 'step']) {
    assert.equal(token.includes(secret), false, `le jeton laisse fuir ${secret}`);
  }
});
