/**
 * Slice 2G — cockpit natif.
 *
 * Trois propriétés gouvernent ce fichier.
 *
 *  1. **La génération vient du serveur.** Le frontend ne la devine pas — ni
 *     depuis `sessions.claude`, ni depuis `active_agent`, ni depuis un
 *     fournisseur, ni depuis une erreur de lecture.
 *  2. **Aucune règle métier n'est recalculée.** Les verdicts affichés sont ceux
 *     de la projection 2D ; changer l'état d'une fixture sans changer ses
 *     capacités ne doit rien changer à l'écran.
 *  3. **La note d'acquittement est un fait de provenance.** Du `textarea` à la
 *     charge HTTP, elle voyage telle quelle — c'est le pendant navigateur du
 *     repair de fidélité posé dans les moteurs.
 *
 * Aucun serveur, aucun fournisseur, aucun navigateur : le contrôleur de
 * production est exercé avec une API injectée, et la vue DOM de production sur
 * un DOM factice sans sink HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

/** Témoin canonique : bordures significatives, Unicode, ponctuation. */
const NOTE = '  « décision humaine — élève / β »  ';

// --------------------------------------------------------------------------
// Fixtures natives
// --------------------------------------------------------------------------

interface Capability {
  allowed: boolean;
  noop?: boolean;
  reason_code?: string;
  conflicting_recovery_domains?: readonly string[];
}

function expert(provider: string, session: string): Record<string, unknown> {
  return { provider, session_id: session, session_status: 'BOUND' };
}

function recoveryDomain(status: string, actions: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return { status, available_actions: actions, conflicts: [] };
}

interface NativeOptions {
  readonly sameProvider?: boolean;
  readonly state?: string;
  readonly control?: string;
  readonly pause?: Capability;
  readonly resume?: Capability;
  readonly step?: Record<string, unknown>;
  readonly handoff?: Capability;
  readonly activeExpertSlot?: string | null;
  readonly quota?: Record<string, unknown>;
  readonly usage?: Record<string, unknown>;
  readonly cost?: Record<string, unknown>;
  readonly presentation?: Record<string, unknown>;
}

function nativeRunView(runId: string, options: NativeOptions = {}): Record<string, unknown> {
  const same = options.sameProvider === true;
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'a'.repeat(64)}`,
    run: {
      read_model_version: 1,
      identity: {
        run_id: runId,
        execution_mode: 'NATIVE_V21_EXECUTION',
        title: `Titre ${runId}`,
        created_at: '2026-08-11T00:00:00.000Z',
        workspace_cwd: 'E:/prog/x',
        manifest_schema_version: 2,
        state_schema_version: 3,
        runtime_schema_version: 2,
      },
      experts: {
        author: expert(same ? 'claude' : 'codex', same ? 'S1' : 'codex-1'),
        challenger: expert('claude', same ? 'S2' : 'claude-1'),
      },
      compatibility: {
        provider_aliases: same
          ? { claude: { resolution: 'AMBIGUOUS' }, codex: { resolution: 'NOT_BOUND' } }
          : {
              claude: { resolution: 'UNIQUE', expert_slot: 'challenger' },
              codex: { resolution: 'UNIQUE', expert_slot: 'author' },
            },
      },
      operational_state: {
        state: options.state ?? 'READY',
        control: options.control ?? 'AUTOMATION',
        round: 0,
        next_step_source_slot: 'author',
        active_expert_slot: options.activeExpertSlot ?? null,
        last_event_id: null,
        updated_at: '2026-08-11T00:00:00.000Z',
        pending_operation: null,
      },
      providers: null,
      recovery: {
        initialization: recoveryDomain('NONE'),
        step: recoveryDomain('NONE'),
        send: recoveryDomain('NONE'),
        handoff: recoveryDomain('NONE'),
      },
      operations: {
        step: options.step ?? {
          allowed: true,
          source_status: 'READY',
          source_slot: 'author',
          target_slot: 'challenger',
          source_event_id: 'evt_000002',
          next_round: 1,
          payload_bytes: 120,
          payload_limit_bytes: 262144,
        },
        pause: options.pause ?? { allowed: true, noop: false },
        resume: options.resume ?? { allowed: true, noop: true },
        experts: {
          author: {
            send: { allowed: true },
            handoff: options.handoff ?? { allowed: false, reason_code: 'HANDOFF_NOT_ALLOWED' },
          },
          challenger: {
            send: { allowed: true },
            handoff: options.handoff ?? { allowed: false, reason_code: 'HANDOFF_NOT_ALLOWED' },
          },
        },
      },
      // V2.2 : la projection native porte ces trois surfaces depuis IMP-09/10/12.
      // La fixture les portait pas encore ; sans elles, elle ne décrivait plus
      // une projection réelle.
      invocation_quota: options.quota ?? { kind: 'NONE', consumed: 0, coverage: 'PRE_LEDGER' },
      usage: options.usage ?? {
        coverage: 'PRE_LEDGER',
        invocations: { total: 0, provider_reported: { observed: 0, unobserved: 0, ambiguous: 0 } },
        providers: [],
        anomalies: { orphan_observations: [], duplicate_observations: [] },
      },
      cost_estimate: options.cost ?? {
        coverage: 'PRE_LEDGER',
        pricing: { kind: 'NONE' },
        by_invocation: [],
        providers: [],
      },
      counts: { events: 6 },
    },
  };
}

function nativeRecoveryView(domains: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'b'.repeat(64)}`,
    operational_state: { state: 'PAUSED', control: 'HUMAN' },
    recovery: {
      initialization: recoveryDomain('NONE'),
      step: recoveryDomain('NONE'),
      send: recoveryDomain('NONE'),
      handoff: recoveryDomain('NONE'),
      ...domains,
    },
  };
}

function legacyRunView(runId: string): Record<string, unknown> {
  return {
    revision: `sha256:${'c'.repeat(64)}`,
    identity: { run_id: runId, title: 'legacy', created_at: '2026-08-08T00:00:00.000Z', workspace_cwd: 'E:/x' },
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

// ==========================================================================
// A. Chargement générationnel
// ==========================================================================

/** Page native minimale — la forme rendue par `readNativeTimelineHttpView`. */
function nativeTimelinePage(): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    timeline_version: 1,
    run_id: 'N',
    revision: `sha256:${'d'.repeat(64)}`,
    entries: [],
    cursor_next: null,
    truncated: false,
    total: 0,
  };
}

test('1–3 · un run natif charge sa chronologie comme un run historique', async () => {
  // Depuis V2.1-IMP-19 la surface est portée : la génération ne décide plus
  // s'il faut demander la chronologie, seulement comment la rendre.
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { selectRun(id: string): Promise<void>; state: Record<string, unknown> };
  };
  const { calls, view } = recordingView();

  let timelineCalls = 0;
  const api = {
    getRun: () => Promise.resolve(nativeRunView('N')),
    getTimeline: () => {
      timelineCalls += 1;
      return Promise.resolve(nativeTimelinePage());
    },
    getRecovery: () => Promise.resolve(nativeRecoveryView()),
    listRuns: () => Promise.resolve({ runs: [] }),
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('N');

  // 1 · la chronologie native est bien demandée, une fois.
  assert.equal(timelineCalls, 1);
  // 2 · plus aucun panneau différé : la vue existe, et c'est elle qui s'affiche.
  assert.equal(calls.filter((call) => call.kind === 'showTimeline').length, 1);
  assert.equal(calls.some((call) => call.kind === 'showTimelineDeferred'), false);
  // 3 · statut et reprise sont bien chargés.
  assert.ok(calls.some((call) => call.kind === 'showRunView'));
  assert.ok(calls.some((call) => call.kind === 'showRecovery'));
  assert.equal(cockpit.state['native'], true);
});

test('4–5 · un run historique conserve exactement son chargement', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { selectRun(id: string): Promise<void>; state: Record<string, unknown> };
  };
  const { view } = recordingView();

  let timelineCalls = 0;
  const api = {
    getRun: (runId: string) => Promise.resolve(runId === 'N' ? nativeRunView('N') : legacyRunView('L')),
    getTimeline: (runId: string) => {
      timelineCalls += 1;
      return Promise.resolve(
        runId === 'N'
          ? { ...nativeTimelinePage(), entries: [{ kind: 'event', event_id: 'evt_n' }], total: 1 }
          : { revision: 'x', entries: [{ kind: 'event', event_id: 'evt_1' }], cursor_next: null },
      );
    },
    getRecovery: (runId: string) =>
      Promise.resolve(runId === 'N' ? nativeRecoveryView() : { capabilities: [], missing_primitives: [] }),
    listRuns: () => Promise.resolve({ runs: [] }),
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('L');
  assert.equal(timelineCalls, 1, 'la chronologie historique est bien demandée');
  assert.equal(cockpit.state['native'], false);
  assert.deepEqual(cockpit.state['timelineEntries'], [{ kind: 'event', event_id: 'evt_1' }]);

  // 5 · bascule historique → natif : aucune entrée du run précédent ne survit.
  await cockpit.selectRun('N');
  assert.equal(timelineCalls, 2);
  assert.deepEqual(cockpit.state['timelineEntries'], [{ kind: 'event', event_id: 'evt_n' }]);
  assert.equal(cockpit.state['native'], true);

  // Et retour : la chronologie historique se recharge normalement.
  await cockpit.selectRun('L');
  assert.equal(timelineCalls, 3);
  assert.deepEqual(cockpit.state['timelineEntries'], [{ kind: 'event', event_id: 'evt_1' }]);
  assert.equal(cockpit.state['native'], false);
});

test('6 · une invalidation d’un run natif recharge la chronologie, sans 422', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { selectRun(id: string): Promise<void>; refreshRun(): Promise<void> };
  };
  const { calls, view } = recordingView();
  let timelineCalls = 0;
  const api = {
    getRun: () => Promise.resolve(nativeRunView('N')),
    getTimeline: () => {
      timelineCalls += 1;
      return Promise.resolve(nativeTimelinePage());
    },
    getRecovery: () => Promise.resolve(nativeRecoveryView()),
    listRuns: () => Promise.resolve({ runs: [] }),
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('N');
  for (let i = 0; i < 5; i += 1) await cockpit.refreshRun();
  // La surface est portée : chaque invalidation relit, et aucune n'échoue.
  assert.equal(timelineCalls, 6);
  assert.equal(calls.some((call) => call.kind === 'showTimelineError'), false);
});

// ==========================================================================
// B. Reprise native — le geste est nommé
// ==========================================================================

test('7–9 · la note d’acquittement voyage bit pour bit, et le vide est refusé', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => {
      selectRun(id: string): Promise<void>;
      recover(pair: unknown, options?: unknown): Promise<void>;
    };
  };
  const { calls, view } = recordingView();

  const sent: { runId: string; payload: Record<string, unknown> }[] = [];
  const api = {
    getRun: () => Promise.resolve(nativeRunView('N')),
    getRecovery: () =>
      Promise.resolve(
        nativeRecoveryView({
          send: recoveryDomain('IN_FLIGHT_UNCERTAIN', [
            { action: 'ACKNOWLEDGE_UNCERTAINTY', requires_note: true, may_call_provider: false },
          ]),
        }),
      ),
    listRuns: () => Promise.resolve({ runs: [] }),
    recoverNative: (runId: string, payload: Record<string, unknown>) => {
      sent.push({ runId, payload });
      return Promise.resolve({ operation_id: 'op_1', status: 'SUCCEEDED' });
    },
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('N');

  // 7 · une note faite d'espaces est refusée côté client, sans requête.
  await cockpit.recover({ domain: 'send', action: 'ACKNOWLEDGE_UNCERTAINTY' }, { acknowledgementText: '   ' });
  assert.equal(sent.length, 0, 'aucun POST sur une note vide');
  assert.ok(calls.some((call) => call.kind === 'showRecoveryActionError'));

  // 8 · la note valide part **telle quelle**.
  await cockpit.recover({ domain: 'send', action: 'ACKNOWLEDGE_UNCERTAINTY' }, { acknowledgementText: NOTE });
  assert.equal(sent.length, 1);
  const payload = sent[0]?.payload ?? {};
  assert.equal(payload['note'], NOTE, 'note transmise bit pour bit');
  assert.notEqual(payload['note'], NOTE.trim(), 'le témoin distingue les deux comportements');
  assert.deepEqual([...String(payload['note'])], [...NOTE], 'aucune normalisation Unicode');

  // 9 · le contrat natif : domaine, geste et révision de la vue de reprise.
  assert.equal(payload['domain'], 'send');
  assert.equal(payload['action'], 'ACKNOWLEDGE_UNCERTAINTY');
  assert.equal(payload['expected_revision'], `sha256:${'b'.repeat(64)}`);
});

test('10–11 · aucun geste n’est choisi automatiquement', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => {
      selectRun(id: string): Promise<void>;
      recover(pair: unknown, options?: unknown): Promise<void>;
    };
  };
  const { view } = recordingView();
  let posts = 0;
  const api = {
    getRun: () => Promise.resolve(nativeRunView('N')),
    getRecovery: () =>
      Promise.resolve(
        nativeRecoveryView({
          send: recoveryDomain('PRE_PROVIDER_ABORTED', [
            { action: 'ABORT_BEFORE_PROVIDER', requires_note: false, may_call_provider: false },
          ]),
        }),
      ),
    listRuns: () => Promise.resolve({ runs: [] }),
    recoverNative: () => {
      posts += 1;
      return Promise.resolve({ operation_id: 'op_1', status: 'SUCCEEDED' });
    },
  };

  const cockpit = createCockpit({ api, view });
  // 10 · un seul geste disponible, et pourtant le rendu n'émet rien.
  await cockpit.selectRun('N');
  assert.equal(posts, 0, 'le chargement ne mute jamais');

  // 11 · un geste absent des actions disponibles n'est jamais remplacé.
  await cockpit.recover({ domain: 'step', action: 'FINALIZE' });
  assert.equal(posts, 0, 'aucune substitution vers l’unique geste disponible');
});

// ==========================================================================
// C. Rendu DOM natif
// ==========================================================================

async function renderNative(runView: Record<string, unknown>): Promise<{ dom: ReturnType<typeof createFakeDom>; view: Record<string, (...args: unknown[]) => void> }> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  view['showRunView']?.(runView);
  return { dom, view };
}

function textOf(node: FakeNode | null): string {
  return node === null ? '' : node.textContent;
}

/** Parcours en profondeur : le DOM factice n'expose aucun sélecteur. */
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

test('12–15 · deux experts distincts sous un moteur partagé, et rien de perdu', async () => {
  // V2.3-S3 a inversé la hiérarchie : le rôle occupe l'espace de travail, et
  // l'identité technique descend dans Inspect. Rien ne disparaît — la preuve
  // porte désormais sur les DEUX destinations.
  const { dom } = await renderNative(nativeRunView('N', { sameProvider: true }));
  const conversation = textOf(dom.document.getElementById('section-overview'));
  // Les faits techniques ont une DEUXIÈME destination depuis que le Dossier ne
  // porte plus que les objets de débat. « Rien n'est perdu » se vérifie donc
  // sur les deux, jamais sur la seule qui existait avant.
  const inspect = textOf(dom.document.getElementById('run-facts'));
  const dossier = textOf(dom.document.getElementById('section-runtime'));

  // 12 · l'espace de travail nomme les deux rôles ; le moteur n'est qu'un
  //      attribut, et il est le même des deux côtés.
  assert.ok(conversation.includes('Auteur'), 'le rôle author est nommé');
  assert.ok(conversation.includes('Challenger'));
  assert.ok(conversation.includes('Claude'));
  // Et il ne porte plus l'identifiant de session au premier rang.
  assert.equal(conversation.includes('S1'), false, 'l’UUID n’est plus l’information dominante');

  // 13 · aucune fusion : les deux sessions distinctes restent lisibles, dans
  //      Inspect. Un run à moteur unique garde donc deux experts distincts.
  assert.ok(inspect.includes('S1'));
  assert.ok(inspect.includes('S2'));
  // 14 · l'alias devient ambigu, et c'est dit — au niveau technique.
  assert.ok(inspect.includes('ambigu'));
  assert.ok(inspect.includes('aucun expert'));
  // 15 · la génération est explicite, et conservée.
  assert.ok(inspect.includes('natif V2.1'));
  // Et le déplacement est un déplacement, pas une copie : le Dossier ne
  // réaffiche aucune de ces identités techniques.
  assert.equal(dossier.includes('S1'), false, 'la session ne vit qu’à un endroit');
  assert.equal(dossier.includes('natif V2.1'), false);
});

test('16–18 · les capacités affichées sont celles reçues, jamais recalculées', async () => {
  // `state` et `control` décrivent un run suspendu, mais les capacités disent
  // l'inverse. Un frontend qui recalculerait trancherait contre le backend :
  // celui-ci doit afficher ce qu'il a reçu.
  const contradictory = nativeRunView('N', {
    state: 'PAUSED',
    control: 'HUMAN',
    pause: { allowed: true, noop: true },
    resume: { allowed: false, reason_code: 'RECOVERY_EVIDENCE_CONFLICT', conflicting_recovery_domains: ['send'] },
  });
  const { dom } = await renderNative(contradictory);
  const overview = textOf(dom.document.getElementById('section-overview'));

  // 16 · un `noop` est un succès sans effet, pas une interdiction.
  //
  //      L'écran l'énonce comme un état DÉJÀ ATTEINT. Il n'oppose plus, sur la
  //      même carte, une pastille « disponible » à une phrase « sans effet » :
  //      les deux disaient le même fait canonique et se lisaient comme une
  //      contradiction.
  assert.ok(overview.includes('Automatisation déjà suspendue'), overview);
  assert.ok(overview.includes('aucune action nécessaire'));
  assert.equal(overview.includes('sans effet dans l’état actuel'), false);
  // Et ce n'est toujours pas une interdiction : ni motif de refus sur ce geste,
  // ni retrait du bouton. L'autorisation reçue est rendue telle quelle.
  assert.equal(overview.includes('Suspendre : refusé'), false, 'un noop n’est pas un refus');
  const pauseButton = findAll(
    dom.document.getElementById('section-overview'),
    (node) => node.attributes['data-action'] === 'PAUSE',
  )[0];
  assert.ok(pauseButton !== undefined, 'le geste autorisé reste offert');
  // 17 · le refus porte le code du backend, et son domaine.
  assert.ok(overview.includes('faits canoniques se contredisent'));
  assert.ok(overview.includes('Envoi'), 'le domaine en conflit est nommé');
  // 18 · aucun bouton n'est proposé pour une capacité refusée.
  assert.equal(dom.document.getElementById('recovery-note-send-ACKNOWLEDGE_UNCERTAINTY'), null);
});

test('19–20 · le handoff natif est visible et reste hors du serveur', async () => {
  const { dom } = await renderNative(
    nativeRunView('N', { state: 'PAUSED', control: 'HUMAN', handoff: { allowed: true } }),
  );
  const overview = textOf(dom.document.getElementById('section-overview'));
  assert.ok(overview.includes('via CLI uniquement'));
  assert.ok(overview.includes('ccr handoff author'));
  assert.ok(overview.includes('ccr handoff challenger'));
  // La cible reste canonique : jamais `ccr handoff claude`.
  assert.equal(overview.includes('ccr handoff claude'), false);
  assert.equal(overview.includes('ccr handoff codex'), false);
});

test('21 · décision et arrêt sont déclarés non portés, pas tus', async () => {
  const { dom } = await renderNative(nativeRunView('N'));
  const overview = textOf(dom.document.getElementById('section-overview'));
  assert.ok(overview.includes('Décision'));
  assert.ok(overview.includes('Arrêt'));
  assert.ok(overview.includes('non portée'));
});

test('22 · le panneau différé a disparu avec la surface qu’il annonçait', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});

  // V2.1-IMP-19 : conserver le message à côté d'une chronologie réelle
  // laisserait deux affirmations contradictoires à l'écran.
  assert.equal(view['showTimelineDeferred'], undefined);
  const renderer = await readFile(new URL('render.js', WEB), 'utf8');
  assert.equal(renderer.includes('non disponible dans cette version'), false);
});

test('23–25 · la reprise native rend quatre domaines et exactement les gestes reçus', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const chosen: unknown[] = [];
  const view = createDomView(dom.document, {
    onRecover: (pair: unknown, options: unknown) => chosen.push([pair, options]),
  });

  view['showRecovery']?.(
    nativeRecoveryView({
      step: recoveryDomain('IN_FLIGHT_UNCERTAIN', [
        { action: 'ACKNOWLEDGE_UNCERTAINTY', requires_note: true, may_call_provider: false },
      ]),
      initialization: recoveryDomain('CLEAN_MISSING', [
        { action: 'CONTINUE', requires_note: false, may_call_provider: true },
      ]),
    }),
  );

  const recovery = textOf(dom.document.getElementById('recovery-body'));
  // 23 · quatre domaines, nommés séparément.
  for (const domain of ['Initialisation', 'Transfert', 'Envoi', 'Handoff']) {
    assert.ok(recovery.includes(domain), domain);
  }
  // 24 · les statuts reçus, jamais inventés.
  assert.ok(recovery.includes('issue inconnue'));
  assert.ok(recovery.includes('session manquante'));
  assert.ok(recovery.includes('aucune reprise nécessaire'));
  assert.ok(recovery.includes('peut appeler un fournisseur'));
  // 25 · un geste par action reçue, et aucun autre.
  assert.ok(dom.document.getElementById('recovery-note-step-ACKNOWLEDGE_UNCERTAINTY') !== null);
  assert.equal(dom.document.getElementById('recovery-note-send-ACKNOWLEDGE_UNCERTAINTY'), null);

  // Le clic nomme le domaine ET le geste.
  const target = findAll(
    dom.document.getElementById('recovery-body'),
    (node) => node.attributes['data-recovery'] === 'step:ACKNOWLEDGE_UNCERTAINTY',
  )[0];
  assert.ok(target !== undefined, 'le bouton porte sa paire');
  target.click();
  assert.deepEqual((chosen[0] as unknown[])[0], { domain: 'step', action: 'ACKNOWLEDGE_UNCERTAINTY' });
});

test('26–27 · l’envoi natif cible des ExpertSlots, jamais un moteur', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const sent: unknown[] = [];
  const view = createDomView(dom.document, {
    onSend: (target: unknown, content: unknown) => sent.push([target, content]),
  });
  view['showRunView']?.(nativeRunView('N', { sameProvider: true }));

  const select = dom.document.getElementById('send-target');
  assert.ok(select !== null);
  const options = select.children.map((node) => node.attributes['value']);
  // 26 · deux cibles, canoniques.
  assert.deepEqual(options, ['author', 'challenger']);
  assert.ok(textOf(select).includes('Claude'), 'le moteur est affiché comme attribut');

  select.value = 'challenger';
  const content = dom.document.getElementById('send-content');
  if (content !== null) content.value = 'précision';
  const button = findAll(
    dom.document.getElementById('section-overview'),
    (node) => node.attributes['data-action'] === 'SEND',
  )[0];
  assert.ok(button !== undefined);
  button.click();

  // 27 · la valeur envoyée est le slot, jamais l'alias.
  assert.deepEqual(sent[0], ['challenger', 'précision']);
});

test('28 · la liste affiche la génération et le slot actif, sans jamais les traduire', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  view['showRuns']?.(
    [
      {
        run_id: 'CCR-1',
        generation: 'NATIVE_V21_EXECUTION',
        title: 'natif',
        state: 'RUNNING',
        active_agent: null,
        active_expert_slot: 'challenger',
        attention: 'NONE',
        unreadable: false,
      },
      {
        run_id: 'CCR-2',
        generation: 'LEGACY_V2_EXECUTION',
        title: 'historique',
        state: 'READY',
        active_agent: 'claude',
        active_expert_slot: null,
        attention: 'NONE',
        unreadable: false,
      },
    ],
    null,
  );
  const list = textOf(dom.document.getElementById('runs-list'));

  // V2.3-S5P1 : le navigateur donne le premier rang au titre humain, et
  // l'identifiant au second. La génération, l'agent actif et le slot actif
  // quittent la navigation — ils restent intégralement dans Inspect.
  assert.ok(list.includes('natif'), 'le titre humain est présent');
  assert.ok(list.includes('historique'));
  assert.ok(list.includes('CCR-1') && list.includes('CCR-2'), 'l’identifiant reste lisible');
  assert.equal(list.includes('natif V2.1'), false, 'la génération a quitté la navigation');

  // L'invariant qui, lui, ne bouge pas : un slot n'est jamais rendu comme un
  // moteur. Le run natif a `challenger` pour slot actif — aucun nom de
  // fournisseur ne doit apparaître à sa place.
  assert.equal(list.includes('Claude'), false, 'aucun slot traduit en fournisseur');
  assert.equal(list.includes('Codex'), false);
});

// ==========================================================================
// D. Gardes de source
// ==========================================================================

test('29–30 · le frontend natif ne recalcule aucune règle, et ne normalise aucune note', async () => {
  const controller = await readFile(new URL('cockpit.js', WEB), 'utf8');
  const renderer = await readFile(new URL('render.js', WEB), 'utf8');
  const executable = (code: string): string =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');

  const code = executable(controller) + executable(renderer);

  // La garde porte sur la **région native** : le rendu historique conserve ses
  // propres filtres de présentation, qui ne sont pas en cause ici.
  const nativeRegion = executable(renderer).slice(
    executable(renderer).indexOf('function isNative('),
    executable(renderer).indexOf('function recoveryNodes('),
  );
  assert.ok(nativeRegion.length > 2000, 'la région native a bien été isolée');

  // Aucune règle métier recopiée : ces comparaisons appartiennent au backend.
  for (const forbidden of [
    "=== 'READY'",
    "=== 'AUTOMATION'",
    "=== 'WAITING_AGENT'",
    "!== 'NONE'",
    "status === 'NONE'",
    'recovery.step.status',
  ]) {
    assert.equal(nativeRegion.includes(forbidden), false, `règle métier recopiée : ${forbidden}`);
  }

  // La note native part telle quelle : `trim` valide, il ne transforme pas.
  assert.equal(
    /payload\.note\s*=\s*[A-Za-z_$][\w$]*\.trim\(\)/.test(code),
    false,
    'la note native ne doit jamais être rognée avant l’envoi',
  );
  assert.ok(code.includes('payload.note = original'), 'la chaîne originale est celle qui part');
});

// ==========================================================================
// V2.3-S3 — un indicateur de chargement ne survit pas à son contenu
// ==========================================================================

test('le « Chargement du run… » disparaît même si un rafraîchissement silencieux rend l’écran', async () => {
  // Reproduit dans le cockpit réel : un rafraîchissement silencieux, déclenché
  // par une invalidation, supplante le chargement initial et rend l'écran.
  // Seul le chemin non silencieux effaçait le statut — le placeholder
  // survivait donc au contenu qu'il annonçait.
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  const status = (): string => textOf(dom.document.getElementById('run-status'));

  view['showRunLoading']?.('CCR-20260811-002');
  assert.ok(status().includes('Chargement'), 'le chargement est annoncé');

  view['showRunView']?.(nativeRunView('N'), { silent: true });
  assert.equal(status(), '', 'le placeholder ne survit pas au rendu');

  // La règle qu'il ne fallait pas casser : un rafraîchissement silencieux
  // n'efface toujours pas le reçu d'une mutation humaine.
  view['showMutationSucceeded']?.('PAUSE');
  const receipt = status();
  assert.ok(receipt.length > 0);
  view['showRunView']?.(nativeRunView('N'), { silent: true });
  assert.equal(status(), receipt, 'le message de l’humain est préservé');
});

// ==========================================================================
// V2.3-S5A — un fil incomplet ne se présente pas comme complet
// ==========================================================================

test('la Conversation dit qu’il reste des entrées, et réutilise le geste existant', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  let loadMore = 0;
  const view = createDomView(dom.document, { onLoadMore: () => { loadMore += 1; } });
  view['showRunView']?.(nativeRunView('N'));

  const entry = (index: number): Record<string, unknown> => ({
    kind: 'event',
    event_id: `evt_${String(index).padStart(6, '0')}`,
    type: 'assistant_response',
    actor: 'expert',
    timestamp: '2026-08-11T00:00:00.000Z',
    round: 0,
    content: `réponse ${String(index)}`,
    exit_code: 0,
    based_on: [],
    reason: null,
    details: null,
    provenance: { shape: 'EXPERT_SESSION', expert_slot_id: 'author', provider: 'codex', session_id: 'S1' },
  });
  const entries = Array.from({ length: 100 }, (_, index) => entry(index));
  const conversation = (): string => textOf(dom.document.getElementById('section-overview'));

  // Page complète : rien ne suggère un ailleurs.
  view['showTimeline']?.(entries, {
    generation: 'NATIVE_V21_EXECUTION',
    timeline_version: 1,
    revision: `sha256:${'a'.repeat(64)}`,
    total: 100,
    cursor_next: null,
    entries,
  });
  assert.equal(conversation().includes('le fil n’est pas complet'), false);
  assert.equal(dom.document.getElementById('conversation-more'), null);

  // Page partielle : le fil le dit, et propose le geste — celui qui existe.
  view['showTimeline']?.(entries, {
    generation: 'NATIVE_V21_EXECUTION',
    timeline_version: 1,
    revision: `sha256:${'a'.repeat(64)}`,
    total: 250,
    cursor_next: 'curseur-opaque',
    entries,
  });
  const text = conversation();
  assert.ok(text.includes('100 entrée(s) affichée(s) sur 250'), text.slice(-200));
  assert.ok(text.includes('le fil n’est pas complet'));

  const button = dom.document.getElementById('conversation-more');
  assert.ok(button !== null, 'le contrôle est atteignable depuis la Conversation');
  button?.click();
  assert.equal(loadMore, 1, 'c’est le seam existant qui est appelé, pas une seconde pagination');
});

// ==========================================================================
// V2.3-S5P2 — reprise calme, journal progressif
// ==========================================================================

test('un run sain rend un état calme, sans perdre les quatre domaines', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  view['showRecovery']?.(nativeRecoveryView({}));

  const body = dom.document.getElementById('recovery-body');
  const text = textOf(body);
  // Un message principal, et un seul.
  assert.equal(text.includes('Aucune reprise nécessaire'), true);
  const quiet = dom.created.find((node) => node.attributes['class'] === 'recovery-quiet');
  assert.ok(quiet !== undefined, 'le détail existe');
  assert.equal(quiet?.tagName, 'DETAILS', 'repli natif, accessible au clavier');
  assert.ok(textOf(quiet ?? null).includes('Voir le détail des 4 domaines'));
  // MOVE/COLLAPSE, jamais DELETE : les quatre domaines restent là.
  for (const domain of ['Initialisation', 'Transfert', 'Envoi', 'Handoff']) {
    assert.ok(textOf(quiet ?? null).includes(domain), `${domain} conservé`);
  }
});

test('GAP-03 · la microcopy « Aucune reprise nécessaire » est celle approuvée, sans surenchère', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  createDomView(dom.document, {})['showRecovery']?.(nativeRecoveryView({}));
  const text = textOf(dom.document.getElementById('recovery-body'));

  // Les deux phrases exactes, et rien d'autre à leur place.
  assert.ok(text.includes('Aucune reprise nécessaire'), text);
  assert.ok(
    text.includes('Aucun besoin de reprise n’est actuellement signalé pour ce run.'),
    'la phrase approuvée doit être rendue mot pour mot',
  );

  // Aucune affirmation que rien n'établit. CCR ne dispose d'aucun champ
  // canonique disant qu'un run « va bien » : la formulation porte sur le
  // BESOIN DE REPRISE, et sur lui seul.
  for (const surenchere of [
    'Tout fonctionne normalement',
    'Le run est sain',
    'Les sessions répondent',
    'Aucun problème',
    'tout va bien',
    'se porte bien',
  ]) {
    assert.equal(text.includes(surenchere), false, `surenchère : « ${surenchere} »`);
  }

  // Et pas davantage de disclaimer technique à la place de la microcopy.
  assert.equal(text.includes('absence d’ambiguïté enregistrée'), false, 'ton de disclaimer réintroduit');
});

test('une reprise réellement nécessaire n’est jamais repliée', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };

  // Geste disponible.
  const withAction = createFakeDom([...SHELL_IDS]);
  createDomView(withAction.document, {})['showRecovery']?.(
    nativeRecoveryView({
      step: recoveryDomain('RESPONSE_NEEDS_FINALIZATION', [
        { action: 'FINALIZE', requires_note: false, may_call_provider: false },
      ]),
    }),
  );
  assert.equal(
    withAction.created.some((node) => node.attributes['class'] === 'recovery-quiet'),
    false,
    'aucun repli lorsqu’un geste attend',
  );
  assert.equal(textOf(withAction.document.getElementById('recovery-body')).includes('Aucune reprise nécessaire'), false);

  // Conflit sans geste : la richesse est conservée elle aussi.
  const withConflict = createFakeDom([...SHELL_IDS]);
  const conflicted = nativeRecoveryView({}) as Record<string, Record<string, Record<string, unknown>>>;
  conflicted['recovery']!['send'] = { status: 'EVIDENCE_CONFLICT', available_actions: [], conflicts: ['contradiction'] };
  createDomView(withConflict.document, {})['showRecovery']?.(conflicted);
  const conflictText = textOf(withConflict.document.getElementById('recovery-body'));
  assert.equal(conflictText.includes('Aucune reprise nécessaire'), false);
  assert.ok(conflictText.includes('contradiction'), 'le conflit reste visible');
});

test('le journal des événements : titre sans V3, ordre intact, gros contenu replié', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  const entry = (id: string, content: string, round: number): Record<string, unknown> => ({
    kind: 'event',
    event_id: id,
    type: 'assistant_response',
    actor: 'expert',
    timestamp: '2026-08-11T00:00:00.000Z',
    round,
    content,
    exit_code: 0,
    based_on: [],
    reason: null,
    details: null,
    provenance: { shape: 'EXPERT_SESSION', expert_slot_id: 'author', provider: 'codex', session_id: 'S1' },
  });
  const long = 'x'.repeat(1200);
  const entries = [entry('evt_1', 'court', 1), entry('evt_2', long, 0)];
  view['showTimeline']?.(entries, {
    generation: 'NATIVE_V21_EXECUTION',
    timeline_version: 1,
    revision: `sha256:${'a'.repeat(64)}`,
    total: 2,
    cursor_next: null,
    entries,
  });

  const timeline = textOf(dom.document.getElementById('section-timeline'));
  // Aucun vocabulaire réservé à V3.
  assert.ok(timeline.includes('Journal des événements'));
  assert.equal(timeline.toLowerCase().includes('controverse'), false);

  // Ordre reçu conservé — evt_1 (round 1) avant evt_2 (round 0).
  assert.ok(timeline.indexOf('evt_1') < timeline.indexOf('evt_2'), 'aucun tri par round');

  // Le contenu court reste visible ; le volumineux se replie, entier.
  const payloads = dom.created.filter((node) => node.attributes['class'] === 'entry-payload');
  assert.equal(payloads.length, 1, 'seul le gros contenu se replie');
  assert.equal(payloads[0]?.tagName, 'DETAILS');
  assert.ok(textOf(payloads[0] ?? null).includes('1 200 caractères') || textOf(payloads[0] ?? null).includes('1200'));
  assert.ok(timeline.includes(long), 'le contenu reste intégral, jamais tronqué');
  assert.ok(timeline.includes('court'), 'un contenu court reste visible');
});
