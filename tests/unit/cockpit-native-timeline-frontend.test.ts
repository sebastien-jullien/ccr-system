/**
 * V2.1-IMP-19 — la controverse native, lue dans le cockpit.
 *
 * Ce fichier éprouve la seule chose qui compte ici : ce que l'humain voit.
 * L'argumentation de chaque expert doit être **lisible et intégrale**, les deux
 * rôles doivent rester distincts même lorsqu'ils partagent le moteur, et la
 * note d'acquittement doit arriver à l'écran telle qu'elle a été écrite.
 *
 * Le contrôleur de production est exercé avec une API injectée ; la vue DOM de
 * production sur un DOM factice, qui ne connaît aucun sink HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

/** Témoin de fidélité : bordures significatives, Unicode, ponctuation. */
const NOTE = '  « décision humaine — élève / β »  ';
const AUTHOR_POSITION = 'Position de l’auteur : la refonte est prématurée.';
const CHALLENGER_POSITION = 'Réfutation : le coût de report dépasse le risque.';
const HUMAN_MESSAGE = '  Précisez le coût de report.  ';
const HOSTILE = '<script>alert(1)</script>';

// --------------------------------------------------------------------------
// Fixtures — la forme rendue par `readNativeTimelineHttpView`
// --------------------------------------------------------------------------

type Entry = Record<string, unknown>;

function entry(over: Entry): Entry {
  return {
    kind: 'event',
    event_id: 'evt_000000',
    type: 'state_changed',
    actor: 'system',
    timestamp: '2026-08-11T00:00:00.000Z',
    round: 0,
    content: null,
    exit_code: null,
    based_on: [],
    reason: null,
    details: null,
    provenance: { shape: 'GENERATION_NEUTRAL' },
    ...over,
  };
}

/**
 * Un run same-provider : les deux experts emploient Claude, et doivent rester
 * parfaitement distinguables — c'est la configuration qui rend la propriété
 * réellement discriminante.
 */
function nativeEntries(): Entry[] {
  return [
    entry({
      event_id: 'evt_000002',
      type: 'assistant_response',
      actor: 'expert',
      content: AUTHOR_POSITION,
      based_on: ['evt_000001'],
      provenance: { shape: 'EXPERT_SESSION', expert_slot_id: 'author', provider: 'claude', session_id: 'S1' },
    }),
    entry({
      event_id: 'evt_000005',
      type: 'assistant_response',
      actor: 'expert',
      content: CHALLENGER_POSITION,
      provenance: { shape: 'EXPERT_SESSION', expert_slot_id: 'challenger', provider: 'claude', session_id: 'S2' },
    }),
    entry({
      event_id: 'evt_000009',
      type: 'round_completed',
      actor: 'system',
      round: 1,
      provenance: {
        shape: 'TRANSFER',
        source_slot_id: 'author',
        target_slot_id: 'challenger',
        source_provider: 'claude',
        target_provider: 'claude',
        source_event_id: 'evt_000002',
        response_event_id: 'evt_000008',
      },
    }),
    entry({
      event_id: 'evt_000010',
      type: 'human_message',
      actor: 'human',
      round: 1,
      content: HUMAN_MESSAGE,
      provenance: {
        shape: 'EXPERT_TARGET',
        target_expert_slot_id: 'author',
        provider: 'claude',
        session_id: null,
      },
    }),
    entry({
      event_id: 'evt_000013',
      type: 'send_uncertainty_acknowledged',
      actor: 'human',
      round: 1,
      content: NOTE,
      reason: 'IN_FLIGHT_UNCERTAIN',
      provenance: {
        shape: 'SEND_RESOLUTION',
        target_expert_slot_id: 'author',
        provider: 'claude',
        prompt_event_id: 'evt_000012',
      },
    }),
  ];
}

function nativePage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    timeline_version: 1,
    run_id: 'N',
    revision: `sha256:${'d'.repeat(64)}`,
    entries: [],
    cursor_next: null,
    truncated: false,
    total: 0,
    ...over,
  };
}

function legacyPage(entries: Entry[]): Record<string, unknown> {
  return { revision: `sha256:${'c'.repeat(64)}`, entries, cursor_next: null, truncated: false, total: entries.length };
}

function nativeRunView(): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'a'.repeat(64)}`,
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'N',
        execution_mode: 'NATIVE_V21_EXECUTION',
        title: 'Contre-expertise',
        created_at: '2026-08-11T00:00:00.000Z',
        workspace_cwd: 'E:/prog/x',
        manifest_schema_version: 2,
        state_schema_version: 3,
        runtime_schema_version: 2,
      },
      experts: {
        author: { provider: 'claude', session_id: 'S1', session_status: 'BOUND' },
        challenger: { provider: 'claude', session_id: 'S2', session_status: 'BOUND' },
      },
      compatibility: {
        provider_aliases: { claude: { resolution: 'AMBIGUOUS' }, codex: { resolution: 'NOT_BOUND' } },
      },
      operational_state: {
        state: 'PAUSED', control: 'HUMAN', round: 1, next_step_source_slot: 'challenger',
        active_expert_slot: null, last_event_id: null, updated_at: '2026-08-11T00:00:00.000Z',
        pending_operation: null,
      },
      providers: null,
      recovery: {
        initialization: { status: 'NONE', available_actions: [], conflicts: [] },
        step: { status: 'NONE', available_actions: [], conflicts: [] },
        send: { status: 'NONE', available_actions: [], conflicts: [] },
        handoff: { status: 'NONE', available_actions: [], conflicts: [] },
      },
      operations: {
        step: { allowed: false, source_status: 'MISSING' },
        pause: { allowed: true, noop: true },
        resume: { allowed: true, noop: false },
        experts: {
          author: { send: { allowed: true }, handoff: { allowed: false, reason_code: 'HANDOFF_NOT_ALLOWED' } },
          challenger: { send: { allowed: true }, handoff: { allowed: false, reason_code: 'HANDOFF_NOT_ALLOWED' } },
        },
      },
      counts: { events: 5 },
    },
  };
}

function legacyRunView(): Record<string, unknown> {
  return {
    revision: `sha256:${'c'.repeat(64)}`,
    identity: { run_id: 'L', title: 'legacy', created_at: '2026-08-08T00:00:00.000Z', workspace_cwd: 'E:/x' },
    sessions: { claude: 'claude-1', codex: 'codex-1' },
    runtime: null,
    runtime_pinned: false,
    state: { state: 'READY', control: 'AUTOMATION', round: 0, active_agent: null, updated_at: '2026-08-08T00:00:00.000Z' },
    last_activity_at: '2026-08-08T00:00:00.000Z',
    liveness: { liveness: 'NONE', basis: 'NO_PENDING_WORK', needs_human_attention: false, lock_observation: 'NO_LOCK', pending_operation: null },
    capabilities: { capabilities: [], handoff: { availableViaCli: false } },
    handoff_cli: { available: false, agents: [] },
    counts: { events: 0, decisions: 0 },
  };
}

function recordingView(): { calls: { kind: string; payload?: unknown }[]; view: Record<string, unknown> } {
  const calls: { kind: string; payload?: unknown }[] = [];
  const view = new Proxy(
    {},
    { get: (_t, property: string) => (payload: unknown) => calls.push({ kind: property, payload }) },
  ) as Record<string, unknown>;
  return { calls, view };
}

// --------------------------------------------------------------------------
// Rendu
// --------------------------------------------------------------------------

async function renderTimeline(
  entries: Entry[],
  page: Record<string, unknown>,
): Promise<ReturnType<typeof createFakeDom>> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  view['showTimeline']?.(entries, page);
  return dom;
}

function textOf(node: FakeNode | null): string {
  return node === null ? '' : node.textContent;
}

function findAll(root: FakeNode | null, predicate: (node: FakeNode) => boolean): FakeNode[] {
  if (root === null) return [];
  const found: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    if (predicate(node)) found.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return found;
}

function contents(dom: ReturnType<typeof createFakeDom>): string[] {
  return findAll(
    dom.document.getElementById('section-timeline'),
    (node) => node.attributes['class'] === 'entry-content',
  ).map((node) => node.textContent);
}

// ==========================================================================
// A. La controverse est réellement à l'écran
// ==========================================================================

test('31–33 · la chronologie native est chargée, rendue, et nomme ses deux experts', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { selectRun(id: string): Promise<void> };
  };
  const { calls, view } = recordingView();
  let asked = 0;
  const api = {
    getRun: () => Promise.resolve(nativeRunView()),
    getTimeline: () => {
      asked += 1;
      return Promise.resolve(nativePage({ entries: nativeEntries(), total: nativeEntries().length }));
    },
    getRecovery: () => Promise.resolve({ generation: 'NATIVE_V21_EXECUTION', revision: 'r', operational_state: { state: 'PAUSED', control: 'HUMAN' }, recovery: {} }),
    listRuns: () => Promise.resolve({ runs: [] }),
  };

  // 31 · la surface est réellement demandée pour un run natif.
  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('N');
  assert.equal(asked, 1);
  const shown = calls.find((call) => call.kind === 'showTimeline');
  assert.ok(shown !== undefined, 'la chronologie native est rendue');

  // 32 · aucun panneau différé ne subsiste, ni dans l'API de la vue, ni dans le
  // code livré au navigateur.
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, unknown>;
  };
  const probe = createDomView(createFakeDom([...SHELL_IDS]).document, {});
  assert.equal(probe['showTimelineDeferred'], undefined);
  const renderer = await readFile(new URL('render.js', WEB), 'utf8');
  assert.equal(renderer.includes('non disponible dans cette version'), false);

  // 33 · les deux rôles apparaissent, nommés par leur rôle.
  const dom = await renderTimeline(nativeEntries(), nativePage({ total: 5 }));
  const timeline = textOf(dom.document.getElementById('section-timeline'));
  assert.ok(timeline.includes('Auteur'));
  assert.ok(timeline.includes('Challenger'));
  assert.ok(timeline.includes('natif V2.1'), 'la génération de la page est affichée');
});

test('34–36 · same-provider reste distinct, et les contenus sont intégraux', async () => {
  const dom = await renderTimeline(nativeEntries(), nativePage({ total: 5 }));
  const timeline = textOf(dom.document.getElementById('section-timeline'));

  // 34 · même moteur des deux côtés, deux identités et deux sessions distinctes.
  assert.ok(timeline.includes('Auteur — Claude'));
  assert.ok(timeline.includes('Challenger — Claude'));
  assert.ok(timeline.includes('S1'));
  assert.ok(timeline.includes('S2'));

  // 35 · l'argumentation d'expert est lisible en entier, jamais remplacée par
  // une étiquette du genre « Réponse de l'auteur ».
  const bodies = contents(dom);
  assert.ok(bodies.includes(AUTHOR_POSITION));
  assert.ok(bodies.includes(CHALLENGER_POSITION));

  // 36 · le message humain aussi, bordures comprises.
  assert.ok(bodies.includes(HUMAN_MESSAGE));
  assert.equal(bodies.includes(HUMAN_MESSAGE.trim()), false, 'aucun rognage à l’affichage');
});

test('37 · la note d’acquittement s’affiche exactement telle qu’elle a été écrite', async () => {
  const dom = await renderTimeline(nativeEntries(), nativePage({ total: 5 }));
  const bodies = contents(dom);
  assert.ok(bodies.includes(NOTE), 'la note humaine est rendue bit pour bit');
  assert.equal(bodies.includes(NOTE.trim()), false, 'le témoin distingue les deux comportements');
  const exact = bodies.find((body) => body.includes('décision humaine'));
  assert.deepEqual([...String(exact)], [...NOTE], 'aucune normalisation Unicode');
});

test('38 · un transfert se lit par ses rôles, jamais par ses moteurs', async () => {
  const dom = await renderTimeline(nativeEntries(), nativePage({ total: 5 }));
  const timeline = textOf(dom.document.getElementById('section-timeline'));
  // Les deux experts partagent Claude : seul le sens des rôles fait le sens du
  // transfert. « Claude → Claude » ne dirait rien.
  assert.ok(timeline.includes('Auteur — Claude → Challenger — Claude'));
  assert.ok(timeline.includes('passage de témoin'));
});

test('39 · un événement sans identité n’en reçoit aucune', async () => {
  const neutral = entry({ event_id: 'evt_000020', type: 'run_paused', actor: 'system', round: 1 });
  const dom = await renderTimeline([neutral], nativePage({ entries: [neutral], total: 1 }));
  const articles = findAll(
    dom.document.getElementById('section-timeline'),
    (node) => node.attributes['class'] === 'entry',
  );
  assert.equal(articles.length, 1);
  const text = textOf(articles[0] ?? null);
  assert.ok(text.includes('run suspendu'));
  for (const forbidden of ['Claude', 'Codex', 'Auteur', 'Challenger', 'S1', 'S2']) {
    assert.equal(text.includes(forbidden), false, `aucun ${forbidden} fabriqué`);
  }
});

// ==========================================================================
// B. Sécurité DOM
// ==========================================================================

test('40 · un contenu hostile reste du texte, jamais du balisage', async () => {
  const hostile = entry({
    event_id: 'evt_000030',
    type: 'assistant_response',
    actor: 'expert',
    content: HOSTILE,
    provenance: { shape: 'EXPERT_SESSION', expert_slot_id: 'author', provider: 'claude', session_id: HOSTILE },
  });
  const dom = await renderTimeline([hostile], nativePage({ entries: [hostile], total: 1 }));

  // Le contenu est visible, intégralement, et rien n'a été interprété : le DOM
  // factice ne possède aucun sink HTML, et aucun nœud script n'a été créé.
  assert.ok(contents(dom).includes(HOSTILE));
  assert.equal(dom.created.some((node) => node.tagName === 'SCRIPT'), false);
  const renderer = await readFile(new URL('render.js', WEB), 'utf8');
  const executable = renderer
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.equal(executable.includes(sink), false, `aucun ${sink} dans la vue livrée`);
  }
});

// ==========================================================================
// C. Isolation, invalidation, bascule
// ==========================================================================

test('41 · un échec de chronologie reste local au panneau', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { selectRun(id: string): Promise<void> };
  };
  const { ApiError } = (await importWeb('api.js')) as { ApiError: new (code: string, message: string) => Error };
  const { calls, view } = recordingView();
  const api = {
    getRun: () => Promise.resolve(nativeRunView()),
    getTimeline: () => Promise.reject(new ApiError('SNAPSHOT_UNSTABLE', 'x')),
    getRecovery: () => Promise.resolve({ generation: 'NATIVE_V21_EXECUTION', revision: 'r', operational_state: { state: 'PAUSED', control: 'HUMAN' }, recovery: {} }),
    listRuns: () => Promise.resolve({ runs: [] }),
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('N');

  // Le panneau dit son erreur ; le statut et la reprise sont chargés quand même.
  assert.ok(calls.some((call) => call.kind === 'showTimelineError'));
  assert.ok(calls.some((call) => call.kind === 'showRunView'));
  assert.ok(calls.some((call) => call.kind === 'showRecovery'));
});

test('42 · invalidations et bascule : chaque run affiche sa propre chronologie', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => {
      selectRun(id: string): Promise<void>;
      refreshRun(): Promise<void>;
      state: Record<string, unknown>;
    };
  };
  const { calls, view } = recordingView();
  let asked = 0;
  const api = {
    getRun: (runId: string) => Promise.resolve(runId === 'N' ? nativeRunView() : legacyRunView()),
    getTimeline: (runId: string) => {
      asked += 1;
      return Promise.resolve(
        runId === 'N'
          ? nativePage({ entries: nativeEntries(), total: nativeEntries().length })
          : legacyPage([{ kind: 'event', event_id: 'evt_legacy', target: 'claude' }]),
      );
    },
    getRecovery: (runId: string) =>
      Promise.resolve(
        runId === 'N'
          ? { generation: 'NATIVE_V21_EXECUTION', revision: 'r', operational_state: { state: 'PAUSED', control: 'HUMAN' }, recovery: {} }
          : { capabilities: [], missing_primitives: [] },
      ),
    listRuns: () => Promise.resolve({ runs: [] }),
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('N');
  // Trois invalidations : la chronologie se relit, et aucune n'échoue.
  for (let i = 0; i < 3; i += 1) await cockpit.refreshRun();
  assert.equal(asked, 4);
  assert.equal(calls.some((call) => call.kind === 'showTimelineError'), false);

  // Bascule : aucune entrée du run précédent ne survit, dans les deux sens.
  await cockpit.selectRun('L');
  const legacyEntries = cockpit.state['timelineEntries'] as Entry[];
  assert.deepEqual(legacyEntries.map((item) => item['event_id']), ['evt_legacy']);
  await cockpit.selectRun('N');
  const nativeAgain = cockpit.state['timelineEntries'] as Entry[];
  assert.equal(nativeAgain.some((item) => item['event_id'] === 'evt_legacy'), false);
  assert.equal(nativeAgain.length, nativeEntries().length);
});
