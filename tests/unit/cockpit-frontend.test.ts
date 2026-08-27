/**
 * Frontend du cockpit (Slice 3) — comportement, pas seulement structure.
 *
 * Trois familles de preuves :
 *
 *  1. **flux réel** — l'orchestration de production est exercée avec une API et
 *     une vue injectées ; la course A/B et la pagination périmée sont testées
 *     sur le chemin qui tourne dans le navigateur ;
 *  2. **rendu réel** — la vue DOM de production est exécutée sur un DOM factice
 *     qui n'expose aucun sink HTML : un contenu hostile ne peut y devenir que
 *     du texte ;
 *  3. **gardes de source** — ce que le comportement ne peut pas prouver seul :
 *     l'absence de sinks, de mutations, de polling et de règles métier
 *     recopiées.
 *
 * Aucun fournisseur IA n'est sollicité, aucun serveur n'est démarré.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);

const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

const source = (name: string): Promise<string> => readFile(new URL(name, WEB), 'utf8');

/**
 * Retire commentaires et chaînes littérales avant une garde de source.
 *
 * Indispensable : la doctrine de ces modules **cite** les sinks qu'elle
 * interdit, et une garde naïve accuserait le commentaire qui protège le code.
 * Ce que l'on veut interdire, c'est l'appel — pas le mot.
 */
function executableCode(code: string): string {
  let out = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
  out = out
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//')) return '';
      const at = line.indexOf('//');
      if (at < 0) return line;
      const before = line.slice(0, at);
      const quotes = (before.match(/['"`]/g) ?? []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join('\n');
  return out;
}

/** Code exécutable d'un module livré au navigateur. */
const executable = async (name: string): Promise<string> => executableCode(await source(name));


// --------------------------------------------------------------------------
// Doubles
// --------------------------------------------------------------------------

interface Recorded {
  readonly kind: string;
  readonly payload?: unknown;
}

function recordingView(): { calls: Recorded[]; view: Record<string, (...args: unknown[]) => void> } {
  const calls: Recorded[] = [];
  const view = new Proxy(
    {},
    {
      get: (_target, property: string) => (payload: unknown) => {
        calls.push({ kind: property, payload });
      },
    },
  ) as Record<string, (...args: unknown[]) => void>;
  return { calls, view };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runViewFixture(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: `sha256:${'a'.repeat(64)}`,
    identity: { run_id: runId, title: `Titre ${runId}`, created_at: '2026-08-08T00:00:00.000Z', workspace_cwd: 'E:/prog/x' },
    sessions: { claude: 'claude-1', codex: 'codex-1' },
    runtime: null,
    runtime_pinned: false,
    state: { state: 'READY', control: 'AUTOMATION', round: 0, active_agent: null, updated_at: '2026-08-08T00:00:00.000Z' },
    last_activity_at: '2026-08-08T00:00:00.000Z',
    liveness: { liveness: 'NONE', basis: 'NO_PENDING_WORK', needs_human_attention: false, lock_observation: 'NO_LOCK', pending_operation: null },
    capabilities: { capabilities: [], handoff: { availableViaCli: false } },
    handoff_cli: { available: false, agents: [] },
    counts: { events: 0, decisions: 0 },
    ...overrides,
  };
}

function timelinePage(entries: unknown[], cursorNext: string | null): Record<string, unknown> {
  return { revision: `sha256:${'a'.repeat(64)}`, entries, cursor_next: cursorNext, truncated: cursorNext !== null, total: entries.length };
}

// --------------------------------------------------------------------------
// (F1) Course A/B
// --------------------------------------------------------------------------

test('(F1) une réponse lente pour A ne remplace jamais l’écran de B', async (t) => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { selectRun(id: string): Promise<void>; state: Record<string, unknown> };
  };
  const { calls, view } = recordingView();

  const slowA = deferred<Record<string, unknown>>();
  const api = {
    getRun: (runId: string) => (runId === 'A' ? slowA.promise : Promise.resolve(runViewFixture('B'))),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
    listRuns: () => Promise.resolve({ runs: [] }),
  };

  const cockpit = createCockpit({ api, view });
  const first = cockpit.selectRun('A');
  const second = cockpit.selectRun('B');
  await second;

  // A répond ensuite, avec un contenu parfaitement valide — mais périmé.
  slowA.resolve(runViewFixture('A'));
  await first;

  const shown = calls
    .filter((call) => call.kind === 'showRunView')
    .map((call) => (call.payload as { identity: { run_id: string } }).identity.run_id);

  t.diagnostic(`vues rendues : ${shown.join(' → ') || '<aucune>'}`);
  assert.deepEqual(shown, ['B'], 'seule la sélection courante est rendue');
  assert.equal(cockpit.state['selectedRunId'], 'B');
});

// --------------------------------------------------------------------------
// (F2) Timeline périmée
// --------------------------------------------------------------------------

test('(F2) STALE_REVISION en pagination : aucune entrée ajoutée, avis affiché', async (t) => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => {
      selectRun(id: string): Promise<void>;
      loadMoreTimeline(): Promise<void>;
      state: Record<string, unknown>;
    };
  };
  const { ApiError } = (await importWeb('api.js')) as { ApiError: new (status: number, code: string) => Error };
  const { calls, view } = recordingView();

  let timelineCalls = 0;
  const api = {
    getRun: () => Promise.resolve(runViewFixture('A')),
    getTimeline: () => {
      timelineCalls += 1;
      if (timelineCalls === 1) return Promise.resolve(timelinePage([{ kind: 'event', event_id: 'evt_000001' }], 'curseur'));
      return Promise.reject(new ApiError(409, 'STALE_REVISION'));
    },
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('A');
  await cockpit.loadMoreTimeline();

  const entries = cockpit.state['timelineEntries'] as unknown[];
  t.diagnostic(`entrées conservées=${String(entries.length)} · avis=${String(calls.some((c) => c.kind === 'showTimelineStale'))}`);

  assert.equal(entries.length, 1, 'la page refusée n’est pas fusionnée');
  assert.equal(cockpit.state['timelineStale'], true);
  assert.equal(cockpit.state['timelineCursorNext'], null, 'plus de pagination sur une vue périmée');
  assert.ok(calls.some((call) => call.kind === 'showTimelineStale'), 'l’utilisateur est averti');
  assert.equal(calls.filter((call) => call.kind === 'showTimeline').length, 1, 'aucun rendu supplémentaire');
});

// --------------------------------------------------------------------------
// (F3) Erreurs
// --------------------------------------------------------------------------

test('(F3) erreurs publiques : messages fermés, jamais de détail serveur', async (t) => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { refreshRuns(): Promise<void> };
  };
  const { ApiError } = (await importWeb('api.js')) as { ApiError: new (status: number, code: string) => Error };

  const cases: readonly { code: string; status: number; expect: RegExp; retryable: boolean; kind: string }[] = [
    // V5.1 : la formulation du 401 est fixée par la décision UX du 2026-08-21 —
    // état, remède, et surtout « la demande n'est pas relancée automatiquement ».
    // Tout le reste de cette garde est inchangé : ni le code, ni le statut HTTP
    // ne doivent apparaître, et le message n'est jamais réessayable.
    { code: 'UNAUTHENTICATED', status: 401, expect: /session cockpit a expiré/i, retryable: false, kind: 'showSessionExpired' },
    { code: 'RUN_NOT_FOUND', status: 404, expect: /n’existe pas/, retryable: false, kind: 'showRunsError' },
    { code: 'STALE_REVISION', status: 409, expect: /rechargez/i, retryable: false, kind: 'showRunsError' },
    { code: 'JOURNAL_INVALID', status: 422, expect: /réparation humaine/, retryable: false, kind: 'showRunsError' },
    { code: 'SNAPSHOT_UNSTABLE', status: 503, expect: /réessayez/i, retryable: true, kind: 'showRunsError' },
    { code: 'UN_CODE_INCONNU', status: 500, expect: /Erreur interne/, retryable: false, kind: 'showRunsError' },
  ];

  for (const testCase of cases) {
    const { calls, view } = recordingView();
    const api = { listRuns: () => Promise.reject(new ApiError(testCase.status, testCase.code)) };
    await createCockpit({ api, view }).refreshRuns();

    const call = calls.find((c) => c.kind === testCase.kind);
    assert.ok(call !== undefined, `${testCase.code} → ${testCase.kind}`);
    const described = testCase.kind === 'showSessionExpired'
      ? { message: call.payload as string, retryable: false }
      : (call.payload as { message: string; retryable: boolean });

    assert.match(described.message, testCase.expect, testCase.code);
    assert.equal(described.retryable, testCase.retryable, `${testCase.code} réessayable ?`);
    // Le message serveur brut ne ressort jamais.
    assert.equal(described.message.includes(testCase.code), false);
    assert.equal(described.message.includes(String(testCase.status)), false);
    t.diagnostic(`${testCase.code} → « ${described.message} »`);
  }
});

test('(F3 bis) une 401 n’enclenche aucune boucle de réamorçage', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { refreshRuns(): Promise<void> };
  };
  const { ApiError } = (await importWeb('api.js')) as { ApiError: new (status: number, code: string) => Error };

  let attempts = 0;
  const { calls, view } = recordingView();
  const api = {
    listRuns: () => {
      attempts += 1;
      return Promise.reject(new ApiError(401, 'UNAUTHENTICATED'));
    },
  };
  await createCockpit({ api, view }).refreshRuns();

  assert.equal(attempts, 1, 'un seul appel : le rechargement est une décision humaine');
  assert.equal(calls.filter((c) => c.kind === 'showSessionExpired').length, 1);
});

// --------------------------------------------------------------------------
// (F4) Libellés — aucune requalification
// --------------------------------------------------------------------------

test('(F4) UNDETERMINED est affiché honnêtement, ni erreur ni reprise', async (t) => {
  const { label } = (await importWeb('labels.js')) as { label: Record<string, (code: string) => string> };

  const text = label['liveness']?.('UNDETERMINED') ?? '';
  t.diagnostic(`UNDETERMINED → « ${text} »`);

  assert.match(text, /indéterminé/i);
  for (const forbidden of ['reprise', 'recovery', 'erreur', 'échec', 'en cours', 'abandon']) {
    assert.equal(text.toLowerCase().includes(forbidden), false, `« ${forbidden} » ne doit pas apparaître`);
  }
  // Chaque valeur de vivacité reçoit un libellé distinct : aucune fusion.
  const all = ['NONE', 'OPERATION_IN_FLIGHT', 'ORPHAN_LOCK', 'ABANDONED_OPERATION', 'EXTERNAL_ACTIVITY', 'AMBIGUOUS', 'UNDETERMINED']
    .map((code) => label['liveness']?.(code));
  assert.equal(new Set(all).size, all.length, 'sept situations, sept libellés');
});

test('(F4 bis) un code inconnu est rendu tel quel, jamais masqué', async () => {
  const { label } = (await importWeb('labels.js')) as { label: Record<string, (code: string) => string> };
  assert.equal(label['state']?.('ETAT_FUTUR'), 'ETAT_FUTUR');
  assert.equal(label['liveness']?.('NOUVEAU'), 'NOUVEAU');
});

// --------------------------------------------------------------------------
// (F5) Rendu : contenu hostile
// --------------------------------------------------------------------------

const HOSTILE = [
  '<script>globalThis.PWNED=true</script>',
  '<img src=x onerror="globalThis.PWNED=true">',
  '</textarea><script>globalThis.PWNED=true</script>',
  'javascript:alert(1)',
  '"><svg onload=globalThis.PWNED=true>',
  '& < > " \'',
];

test('(F5) contenu hostile : rendu comme texte, aucun nœud exécutable créé', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});

  const payload = HOSTILE.join(' ');
  view['showRuns']?.(
    [
      {
        run_id: 'CCR-20260402-001',
        title: payload,
        state: 'READY',
        control: 'AUTOMATION',
        round: 0,
        active_agent: null,
        created_at: '2026-08-08T00:00:00.000Z',
        updated_at: '2026-08-08T00:00:00.000Z',
        runtime_pinned: true,
        attention: 'NONE',
        unreadable: false,
      },
    ],
    null,
  );

  view['showRunView']?.(
    runViewFixture('CCR-20260402-001', {
      identity: { run_id: 'CCR-20260402-001', title: payload, created_at: '2026-08-08T00:00:00.000Z', workspace_cwd: payload },
      sessions: { claude: payload, codex: null },
      handoff_cli: { available: true, agents: [{ agent: 'claude', session_id: payload, command: payload }] },
    }),
  );

  view['showTimeline']?.(
    [
      { kind: 'event', event_id: 'evt_000001', round: 1, timestamp: '2026-08-08T00:00:00.000Z', actor: 'codex', type: 'assistant_response', target: null, session_id: null, content: payload, based_on: [], details: null },
      { kind: 'decision', decision_id: 'DEC-0001', round: 1, timestamp: '2026-08-08T00:00:00.000Z', author: 'human', status: 'ACTIVE', content: payload, event_id: null, orphan_decision: true },
    ],
    timelinePage([], null),
  );

  // 1. Aucun nœud exécutable ou chargeur de ressource n'a été créé.
  const dangerous = dom.created.filter((node) => ['SCRIPT', 'IMG', 'SVG', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'STYLE'].includes(node.tagName));
  t.diagnostic(`nœuds créés=${String(dom.created.length)} · dangereux=${String(dangerous.length)}`);
  assert.equal(dangerous.length, 0, `aucun nœud exécutable, vu : ${dangerous.map((n) => n.tagName).join(',')}`);

  // 2. Aucun attribut ne transporte l'entrée hostile — ni URL, ni gestionnaire.
  const attributes = dom.created.flatMap((node: FakeNode) => Object.entries(node.attributes));
  for (const [name, value] of attributes) {
    assert.equal(/^on/i.test(name), false, `attribut événementiel interdit : ${name}`);
    assert.equal(['href', 'src', 'action', 'formaction', 'data', 'srcdoc'].includes(name.toLowerCase()), false, `attribut d’URL interdit : ${name}`);
    assert.equal(value.includes('javascript:'), false);
    assert.equal(value.includes('<script'), false, `donnée injectée dans l’attribut ${name}`);
  }

  // 3. Le payload est bien présent — comme texte, donc lisible et inoffensif.
  assert.ok(dom.text().includes('<script>globalThis.PWNED=true</script>'), 'affiché tel quel');
  assert.equal((globalThis as Record<string, unknown>)['PWNED'], undefined, 'rien n’a été exécuté');
});

// --------------------------------------------------------------------------
// (F6) Gardes de source
// --------------------------------------------------------------------------

/**
 * Modules livrés au navigateur.
 *
 * `V2.3-S2` en ajoute deux : le rendu Markdown et la validation d'URL. Ils
 * entrent dans les gardes **dès leur naissance** — aucune n'est relâchée pour
 * les accueillir.
 */
const PRODUCTION_MODULES = [
  'app.js',
  'api.js',
  'cockpit.js',
  'render.js',
  'labels.js',
  'markdown.js',
  'link-safety.js',
];

/** Modules historiques, antérieurs au rendu Markdown. */
const PRE_MARKDOWN_MODULES = ['app.js', 'api.js', 'cockpit.js', 'render.js', 'labels.js'];

test('(F6) aucun sink HTML dans le code livré au navigateur', async (t) => {
  const sinks = ['.innerHTML', '.outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'createContextualFragment'];
  for (const name of PRODUCTION_MODULES) {
    const code = await executable(name);
    for (const sink of sinks) {
      assert.equal(code.includes(sink), false, `${name} contient ${sink}`);
    }
    // `setTimeout`/`setInterval` avec une chaîne sont des `eval` déguisés.
    assert.equal(/set(Timeout|Interval)\s*\(\s*['"`]/.test(code), false, `${name} évalue une chaîne`);
  }
  t.diagnostic(`${String(PRODUCTION_MODULES.length)} modules vérifiés`);
});

test('(F6 ter) une seule exception de navigation, nommée et étroite', async (t) => {
  // V2.3-S2 précise l'invariant historique : « aucune donnée **non validée** ne
  // devient une URL ou un attribut de navigation ». L'exception est un chemin
  // unique — `link-safety.js` valide, `markdown.js` pose — et rien d'autre dans
  // le frontend ne gagne le droit de définir une URL dynamique.
  for (const name of PRE_MARKDOWN_MODULES) {
    const code = await executable(name);
    for (const attribute of ['href', 'src', 'formaction', 'srcdoc']) {
      assert.equal(code.includes(attribute), false, `${name} définit un attribut de navigation : ${attribute}`);
    }
  }

  // Le producteur : une liste blanche fermée, deux protocoles, rien de plus.
  const safety = await executable('link-safety.js');
  assert.ok(safety.includes("url.protocol !== 'http:'"), 'la validation porte sur le protocole analysé');
  assert.ok(safety.includes('new URL('), 'analyse d’URL réelle, jamais un préfixe');
  for (const scheme of ['javascript:', 'data:', 'file:']) {
    assert.equal(safety.includes(`'${scheme}'`), false, `liste noire au lieu d’une liste blanche : ${scheme}`);
  }

  // Le consommateur : une seule pose, et elle vient de la primitive.
  const markdown = await executable('markdown.js');
  assert.equal((markdown.match(/setAttribute\('href'/g) ?? []).length, 1, 'une seule pose de href');
  assert.ok(markdown.includes("from './link-safety.js'"));
  assert.equal(markdown.includes("setAttribute('src'"), false, 'aucune ressource distante');
  t.diagnostic(`${String(PRE_MARKDOWN_MODULES.length)} modules sans attribut de navigation`);
});

test('(F6 bis) surface mutante : onze routes exactement, et rien d’autre', async (t) => {
  // Le Slice 4 ouvre `POST`. La garde ne peut donc plus interdire le mot ; elle
  // interdit ce qui compte : une méthode mutante ailleurs que dans le client,
  // et une route de mutation hors des quatre autorisées.
  for (const name of PRODUCTION_MODULES) {
    const code = await executable(name);
    for (const method of ["'PUT'", '"PUT"', "'PATCH'", "'DELETE'", "'HEAD'"]) {
      assert.equal(code.includes(method), false, `${name} contient ${method}`);
    }
    if (name !== 'api.js') {
      assert.equal(code.includes("'POST'"), false, `${name} émet une requête mutante hors du client`);
    }
  }

  const api = await executable('api.js');
  assert.equal((api.match(/method: 'GET'/g) ?? []).length, 1, 'une seule lecture générique');
  // Slice 6 : un second point d'émission apparaît — la création. Il en existe
  // exactement deux, tous deux dans le client, et pas un de plus.
  // Slice 7 : un troisième point d'émission — la reprise. Il en existe
  // exactement trois, tous dans le client, et pas un de plus.
  // V5.1 : un quatrième — la réconciliation, contractée par l'addendum §17.
  // Puis un cinquième, qui n'ouvre AUCUNE surface nouvelle : l'émission
  // générique que `recoverNative` référençait déjà sans qu'elle existe. Le
  // compte disait quatre parce qu'un des cinq chemins était rompu.
  assert.equal((api.match(/method: 'POST'/g) ?? []).length, 5, 'cinq points d’émission mutants');
  // La création vise la route de collection elle-même, écrite littéralement.
  assert.ok(api.includes("fetchImpl('/api/runs', {"), 'la création vise /api/runs, sans interpolation');
  for (const alias of ['/api/start', '/api/runs/start', '/runs/start']) {
    assert.equal(api.includes(alias), false, `alias de création interdit : ${alias}`);
  }

  // La table de routes est close et littérale : aucune route ne se fabrique
  // depuis une chaîne arbitraire.
  const { RECOVERY_ROUTES } = (await importWeb('api.js')) as { RECOVERY_ROUTES: Record<string, string> };
  assert.deepEqual(RECOVERY_ROUTES, {
    RECOVERY_FINALIZE_JOURNALED_RESPONSE: 'finalize-journaled-response',
    RECOVERY_CONTINUE_INITIALIZATION: 'continue-initialization',
    RECOVERY_MATERIALIZE_AMBIGUITY: 'materialize-ambiguity',
    RECOVERY_ACKNOWLEDGE_AMBIGUITY: 'acknowledge-ambiguity',
    RECOVERY_CLEAR_STALE_LOCK: 'clear-stale-lock',
  });
  t.diagnostic(`routes de reprise : ${String(Object.keys(RECOVERY_ROUTES).length)}`);

  const { MUTATION_ROUTES } = (await importWeb('api.js')) as { MUTATION_ROUTES: Record<string, string> };
  assert.deepEqual(MUTATION_ROUTES, {
    PAUSE: 'pause',
    RESUME: 'resume',
    DECIDE: 'decide',
    STOP: 'stop',
    STEP: 'step',
    SEND: 'send',
  });
  assert.equal(Object.isFrozen(MUTATION_ROUTES), true);

  for (const forbidden of ['start', 'recover', 'handoff', 'config', 'clear-stale']) {
    assert.equal(
      Object.values(MUTATION_ROUTES).includes(forbidden),
      false,
      `route hors périmètre : ${forbidden}`,
    );
    assert.equal(api.includes(`/${forbidden}\``), false, `api.js construit une route ${forbidden}`);
  }
  t.diagnostic(`routes mutables : ${Object.values(MUTATION_ROUTES).join(', ')}`);
});

test('(F6 bis 2) la surface exécutable du navigateur est exactement celle du slice', async () => {
  const { SHORT_MUTATION_IDS } = (await importWeb('cockpit.js')) as { SHORT_MUTATION_IDS: readonly string[] };
  assert.deepEqual([...SHORT_MUTATION_IDS], ['PAUSE', 'RESUME', 'DECIDE', 'STOP']);
  assert.equal(Object.isFrozen(SHORT_MUTATION_IDS), true);

  // Le Slice 5 les rend exécutables — et rien d'autre ne l'est.
  const { LONG_MUTATION_IDS } = (await importWeb('cockpit.js')) as { LONG_MUTATION_IDS: readonly string[] };
  assert.deepEqual([...LONG_MUTATION_IDS], ['STEP', 'SEND']);
  assert.equal(Object.isFrozen(LONG_MUTATION_IDS), true);

  // Aucune route hors périmètre, même sous forme de chaîne.
  const api = await executable('api.js');
  for (const forbidden of ['start', 'recover', 'handoff', 'clear-stale']) {
    assert.equal(api.includes(`'${forbidden}'`), false, `route hors périmètre : ${forbidden}`);
  }
});

test('(F6 ter) aucun rafraîchissement périodique, aucune persistance navigateur', async (t) => {
  // `EventSource` apparaît au Slice 8 — mais il n'est pas un rafraîchissement
  // périodique : il ne se déclenche que lorsque le serveur a constaté un
  // changement. Ce qui reste interdit, c'est l'horloge locale qui recharge
  // sans raison, et tout stockage navigateur.
  const forbidden = ['setInterval', 'localStorage', 'sessionStorage', 'indexedDB', 'serviceWorker', 'caches.open'];
  for (const name of PRODUCTION_MODULES) {
    const code = await executable(name);
    for (const token of forbidden) {
      assert.equal(code.includes(token), false, `${name} contient ${token}`);
    }
    // Le flux n'est ouvert qu'au câblage : ni la vue, ni l'orchestration, ni le
    // client HTTP ne connaissent `EventSource`.
    if (name !== 'app.js') {
      assert.equal(code.includes('EventSource'), false, `${name} ouvre un flux hors du câblage`);
    }
    // Et personne n'inspecte le média du flux : le client ne le lit jamais.
    assert.equal(code.includes('text/event-stream'), false, `${name} inspecte le média du flux`);
  }

  const wiring = await executable('app.js');
  const openings = (wiring.match(/new EventSource\(/g) ?? []).length;
  t.diagnostic(`app.js : ${String(openings)} ouverture(s) de flux`);
  assert.equal(openings, 1, 'une seule façon d’ouvrir un flux');
  // Aucun secret dans l'URL : le cookie de session authentifie, et lui seul.
  for (const token of ['token=', 'secret=', 'session=']) {
    assert.equal(wiring.includes(token), false, `un jeton circulerait dans l’URL : ${token}`);
  }
});

test('(F6 quater) aucune règle métier reconstruite côté navigateur', async (t) => {
  // Les états et codes du cœur n'ont le droit d'apparaître **que** dans la
  // table de libellés, qui les traduit sans jamais les combiner.
  const decisionMakers = ['cockpit.js', 'render.js', 'app.js', 'api.js'];
  const coreVocabulary = [
    'WAITING_AGENT',
    'RECOVERY_REQUIRED',
    'FAILED_INITIALIZATION',
    'AUTOMATION_NOT_IN_CONTROL',
    'ORPHAN_LOCK',
    'ABANDONED_OPERATION',
  ];

  for (const name of decisionMakers) {
    const code = await executable(name);
    for (const token of coreVocabulary) {
      assert.equal(code.includes(token), false, `${name} raisonne sur ${token} — le cœur l’a déjà décidé`);
    }
    // Aucune valeur dérivée : ces noms n'ont de sens que si l'on recalcule.
    assert.equal(/\b(can|requires|needs)[A-Z]\w*\s*=[^=]/.test(code), false, `${name} affecte une valeur dérivée`);
  }

  const labels = await executable('labels.js');
  assert.ok(labels.includes('WAITING_AGENT'), 'la traduction, elle, reste autorisée');
  t.diagnostic('vocabulaire du cœur confiné à labels.js');
});

test('(F6 quinquies) l’état UI ne contient aucun booléen dérivé', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { state: Record<string, unknown> };
  };
  const { state } = createCockpit({ api: {}, view: recordingView().view });

  for (const key of Object.keys(state)) {
    assert.equal(/^(can|requires|needs|is)[A-Z]/.test(key), false, `clé dérivée interdite : ${key}`);
  }
  assert.deepEqual(Object.keys(state).sort(), [
    'attempt',
    'config',
    'doctor',
    // V5.1 : suivi d'une opération longue. Un identifiant de reçu, un genre et
    // deux compteurs de cadence — aucune vérité métier, et surtout aucun moyen
    // de rejouer quoi que ce soit : ni corps, ni clé d'idempotence, ni action.
    // C'est cette absence qui garantit structurellement qu'un suivi ne produit
    // pas un second appel fournisseur.
    'followUp',
    // Flux ouverts et rafraîchissements programmés : du transport, pas des
    // faits métier. Aucun n'est dérivé d'une vue.
    'listStream',
    // Génération du run affiché : un fait **reçu** du serveur, jamais dérivé
    // d'une heuristique — c'est précisément ce que le slice 2G interdit.
    'native',
    'pendingRefresh',
    'recoveryAttempt',
    'recoveryView',
    'runStream',
    'runView',
    'runs',
    'selectedRunId',
    // Tentative de création : une clé, un `operation_id`, un `created_run_id`.
    // Aucun booléen, aucun état dérivé — la vérité reste au serveur.
    'start',
    // V2.3-S4 : l'effet de START, **reçu** avec la liste des runs. Ni dérivé,
    // ni reconstruit, ni complété par défaut — son absence reste une absence.
    'startEffect',
    // A-N-P2-01 : une soumission de création est-elle en vol ? Garde de
    // transport, du même ordre que `pendingRefresh` — elle ne décrit aucun
    // état de run, n'est dérivée d'aucune vue, et rien ne s'en conclut sur le
    // monde. Elle empêche seulement deux clics de produire deux runs.
    'startInFlight',
    'timelineCursorNext',
    'timelineEntries',
    'timelineRevision',
    'timelineStale',
  ]);
});

test('(F6 sexies) le shell ne contient ni script ni style en ligne', async () => {
  const html = await readFile(new URL('index.html', WEB), 'utf8');
  assert.equal(/\son[a-z]+=/i.test(html), false, 'aucun gestionnaire en attribut');
  assert.equal(html.includes(' style="'), false);
  assert.equal(html.includes('<style'), false);
  assert.equal(html.toLowerCase().includes('javascript:'), false);
  // Une seule origine possible pour le code : /assets, servi par le cockpit.
  assert.equal((html.match(/src="/g) ?? []).length, (html.match(/src="\/assets\//g) ?? []).length);
  // Deux formes seulement pour un `href` : une ressource de /assets, ou une
  // ancre du MÊME document. Un fragment ne charge rien et ne peut donc pas
  // introduire une origine ; tout le reste — http:, //, chemin relatif — reste
  // refusé par cette assertion.
  const hrefs = html.match(/href="[^"]*"/g) ?? [];
  for (const href of hrefs) {
    const value = href.slice(6, -1);
    assert.ok(
      value.startsWith('/assets/') || /^#[A-Za-z][\w-]*$/.test(value),
      `href hors politique : ${value}`,
    );
  }
});

/**
 * Fabrique de vue de reprise — seules les capacités varient d'un cas à l'autre.
 */
function recoveryView(capabilities: unknown[], missing: unknown[] = []): Record<string, unknown> {
  return {
    revision: `sha256:${'a'.repeat(64)}`,
    liveness: { liveness: 'ORPHAN_LOCK', basis: 'ORPHAN_LOCK_OBSERVED', needs_human_attention: true, lock_observation: 'STALE_LOCK', pending_operation: null },
    known_facts: { state: 'RECOVERY_REQUIRED', control: 'HUMAN', runtime_pinned: true, pending_response_journaled: false, lock_observation: 'STALE_LOCK', lock_reference: 'abc' },
    ambiguity: { reason: 'AMBIGUITE', since: '2026-08-08T00:00:00.000Z' },
    sessions: { claude: 'PRESENT', codex: 'ABSENT' },
    capabilities,
    missing_primitives: missing,
  };
}

const ACKNOWLEDGE = {
  id: 'RECOVERY_ACKNOWLEDGE_AMBIGUITY',
  allowed: true,
  requires_confirmation: true,
  requires_acknowledgement_text: true,
  destructive: false,
  effect: 'ACK',
  invocation: { primitive: 'recoverRun', acknowledge: 'REQUIRED' },
  long_running: false,
};

const CLEAR = {
  id: 'RECOVERY_CLEAR_STALE_LOCK',
  allowed: true,
  requires_confirmation: true,
  requires_acknowledgement_text: false,
  destructive: true,
  effect: 'REMOVE_STALE_RUN_LOCK_WITHOUT_CANONICAL_EFFECT',
  invocation: { primitive: 'clearStaleRunLock', observed_lock_token: `lt1:${'A'.repeat(43)}` },
  long_running: false,
};

test('(F7) la reprise est actionnable, et exclusivement depuis les capacités reçues', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const invoked: unknown[] = [];
  const view = createDomView(dom.document, {
    onRecover: (id: string, options: unknown) => invoked.push({ id, options }),
  });

  const before = dom.created.length;
  view['showRecovery']?.(recoveryView([ACKNOWLEDGE]));
  const buttons = dom.created.slice(before).filter((node) => node.tagName === 'BUTTON');
  t.diagnostic(`boutons rendus=${String(buttons.length)}`);
  assert.equal(buttons.length, 1, 'une capacité autorisée, un contrôle');

  // Confirmation exigée : le premier clic arme, il n'exécute pas.
  const button = buttons[0] as FakeNode;
  button.click();
  assert.deepEqual(invoked, [], 'le premier clic ne déclenche rien');
  assert.ok(String(button.textContent).startsWith('Confirmer'), 'le bouton demande confirmation');

  // Le second clic transmet l'identifiant de capacité, et la note saisie.
  const textarea = dom.document.getElementById('recovery-acknowledgement') as FakeNode | null;
  assert.ok(textarea !== null, 'la note humaine est demandée quand le cœur l’exige');
  if (textarea !== null) textarea.value = 'Vérifié au terminal.';
  button.click();
  assert.equal(invoked.length, 1);
  assert.deepEqual(invoked[0], {
    id: 'RECOVERY_ACKNOWLEDGE_AMBIGUITY',
    options: { acknowledgementText: 'Vérifié au terminal.' },
  });
});

test('(F7 bis) aucune capacité, aucun bouton — et jamais « un verrou existe donc lever »', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };

  const cases = [
    ['aucune capacité', [] as unknown[]],
    ['capacité refusée', [{ ...CLEAR, allowed: false, reason_code: 'LOCK_ALIVE' }]],
  ] as const;

  for (const [labelText, capabilities] of cases) {
    const dom = createFakeDom([...SHELL_IDS]);
    const view = createDomView(dom.document, { onRecover: () => assert.fail('aucune action ne doit partir') });
    const before = dom.created.length;
    // La vue décrit pourtant un verrou observé : c'est exactement la situation
    // où une règle locale « si un verrou existe, proposer la levée » ferait
    // apparaître un bouton destructif que le cœur n'a pas autorisé.
    view['showRecovery']?.(recoveryView([...capabilities]));
    const buttons = dom.created.slice(before).filter((node) => node.tagName === 'BUTTON');
    t.diagnostic(`${labelText} → boutons=${String(buttons.length)}`);
    assert.equal(buttons.length, 0, `${labelText} : un contrôle destructif est apparu`);
  }

  // Et la source ne contient aucune règle de ce genre.
  const render = await executable('render.js');
  for (const forbidden of ['lock_observation ===', 'STALE_LOCK', 'ORPHAN_SAME_PID_LOCK', 'lock_reference !==']) {
    assert.equal(render.includes(forbidden), false, `render.js décide de la levée : ${forbidden}`);
  }
});

test('(F7 ter) un résultat UNKNOWN est dit, et rien ne repart tout seul', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  let checks = 0;
  const view = createDomView(dom.document, {
    onCheckRecovery: () => {
      checks += 1;
    },
    onRecover: () => assert.fail('aucun rejeu automatique'),
  });

  view['showRecoveryUndetermined']?.('RECOVERY_CLEAR_STALE_LOCK', {
    operation_id: `op_${'0'.repeat(64)}`,
    status: 'UNKNOWN',
  });

  const status = dom.document.getElementById('recovery-status') as FakeNode | null;
  const text = String(status?.textContent ?? '');
  t.diagnostic(text.slice(0, 120));
  assert.match(text, /résultat inconnu/, 'l’incertitude est nommée');
  assert.match(text, /Aucun rejeu n’est tenté/, 'et l’absence de rejeu aussi');

  // Le seul contrôle offert consulte ; il n'émet aucune reprise.
  const buttons = dom.created.filter((node) => node.tagName === 'BUTTON' && node.attributes?.['id'] === 'recovery-check');
  assert.equal(buttons.length, 1, 'un seul geste proposé : vérifier');
  (buttons[0] as FakeNode).click();
  assert.equal(checks, 1, 'et il consulte, sans réémettre');
});

// --------------------------------------------------------------------------
// Mutations courtes — comportement du navigateur (Slice 4)
// --------------------------------------------------------------------------

function capability(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    allowed: true,
    idempotentNoop: false,
    requiresConfirmation: false,
    destructive: false,
    effect: 'SUSPEND_AUTOMATION',
    longRunning: false,
    ...over,
  };
}

function mutableRunView(capabilities: Record<string, unknown>[]): Record<string, unknown> {
  return runViewFixture('CCR-20260402-001', {
    capabilities: { capabilities, handoff: { availableViaCli: false } },
  });
}

interface MutationCall {
  readonly action: string;
  readonly runId: string;
  readonly payload: Record<string, unknown>;
  readonly key: string;
}

test('(F8) un réessai réutilise la clé de la tentative — jamais une nouvelle', async (t) => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => {
      selectRun(id: string): Promise<void>;
      mutate(action: string): Promise<void>;
      retryMutation(): Promise<void>;
    };
  };
  const { ApiError } = (await importWeb('api.js')) as { ApiError: new (s: number, c: string) => Error };
  const { view } = recordingView();

  const calls: MutationCall[] = [];
  const api = {
    getRun: () => Promise.resolve(mutableRunView([capability('PAUSE')])),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
    listRuns: () => Promise.resolve({ runs: [] }),
    mutate: (action: string, runId: string, payload: Record<string, unknown>, key: string) => {
      calls.push({ action, runId, payload, key });
      // Panne réseau : la tentative n'a pas abouti, mais elle reste la même.
      return Promise.reject(new ApiError(0, 'NETWORK'));
    },
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('CCR-20260402-001');
  await cockpit.mutate('PAUSE');
  await cockpit.retryMutation();
  await cockpit.retryMutation();

  t.diagnostic(`envois=${String(calls.length)} · clés distinctes=${String(new Set(calls.map((c) => c.key)).size)}`);
  assert.equal(calls.length, 3, 'trois envois');
  assert.equal(new Set(calls.map((call) => call.key)).size, 1, 'une seule clé : une seule intention');
  assert.match(calls[0]?.key ?? '', /^ccr-/);

  // Une NOUVELLE intention obtient une nouvelle clé.
  await cockpit.mutate('PAUSE');
  assert.equal(new Set(calls.map((call) => call.key)).size, 2);
});

test('(F9) après un succès, la vérité revient du cœur — aucun état optimiste', async (t) => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => {
      selectRun(id: string): Promise<void>;
      mutate(action: string): Promise<void>;
      state: Record<string, unknown>;
    };
  };
  const { view } = recordingView();

  let reads = 0;
  const api = {
    getRun: () => {
      reads += 1;
      return Promise.resolve(mutableRunView([capability('PAUSE')]));
    },
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
    listRuns: () => Promise.resolve({ runs: [] }),
    mutate: () => Promise.resolve({ operation_id: 'op_a', status: 'SUCCEEDED', revision_after: 'sha256:zz' }),
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('CCR-20260402-001');
  const before = reads;
  const stateBefore = JSON.stringify((cockpit.state['runView'] as { state: unknown }).state);

  await cockpit.mutate('PAUSE');
  t.diagnostic(`lectures de RunView : ${String(before)} → ${String(reads)}`);

  assert.ok(reads > before, 'le run est relu après la mutation');
  // La vue affichée provient de la relecture, pas d'une écriture locale.
  assert.equal(JSON.stringify((cockpit.state['runView'] as { state: unknown }).state), stateBefore);
});

test('(F10) 409 STALE_REVISION : aucun réessai automatique, décision rendue à l’humain', async (t) => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { selectRun(id: string): Promise<void>; mutate(action: string): Promise<void> };
  };
  const { ApiError } = (await importWeb('api.js')) as { ApiError: new (s: number, c: string) => Error };
  const { calls, view } = recordingView();

  let sent = 0;
  const api = {
    getRun: () => Promise.resolve(mutableRunView([capability('PAUSE')])),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
    listRuns: () => Promise.resolve({ runs: [] }),
    mutate: () => {
      sent += 1;
      return Promise.reject(new ApiError(409, 'STALE_REVISION'));
    },
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('CCR-20260402-001');
  await cockpit.mutate('PAUSE');

  const error = calls.find((call) => call.kind === 'showMutationError');
  t.diagnostic(`envois=${String(sent)} · message=${String((error?.payload as { message?: string } | undefined)?.message)}`);

  assert.equal(sent, 1, 'un seul envoi : rien n’est rejoué sur la nouvelle révision');
  assert.ok(error !== undefined);
  assert.equal(calls.some((call) => call.kind === 'showMutationSucceeded'), false);
});

test('(F11) une capacité refusée par le cœur n’est jamais envoyée', async (t) => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => { selectRun(id: string): Promise<void>; mutate(action: string): Promise<void> };
  };
  const { view } = recordingView();

  let sent = 0;
  const api = {
    getRun: () => Promise.resolve(mutableRunView([capability('PAUSE', { allowed: false, reason: 'RUN_NOT_PAUSABLE' })])),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
    listRuns: () => Promise.resolve({ runs: [] }),
    mutate: () => {
      sent += 1;
      return Promise.resolve({ operation_id: 'op_a', status: 'SUCCEEDED' });
    },
  };

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('CCR-20260402-001');

  await cockpit.mutate('PAUSE');
  // Et une action hors périmètre du slice ne part pas davantage.
  await cockpit.mutate('STEP');
  await cockpit.mutate('SEND');

  t.diagnostic(`envois=${String(sent)}`);
  assert.equal(sent, 0, 'le transport ne rend pas exécutable ce que le cœur refuse');
});

test('(F12) confirmation : un premier clic arme, un second envoie', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const asked: string[] = [];
  const view = createDomView(dom.document, { onMutate: (action: string) => asked.push(action) });

  view['showRunView']?.(
    mutableRunView([
      capability('STOP', { requiresConfirmation: true, destructive: true, effect: 'CLOSE_RUN' }),
      capability('PAUSE'),
    ]),
  );

  const buttons = dom.find((node) => node.tagName === 'BUTTON' && node.attributes['data-action'] !== undefined);
  const stop = buttons.find((node) => node.attributes['data-action'] === 'STOP');
  const pause = buttons.find((node) => node.attributes['data-action'] === 'PAUSE');
  assert.ok(stop !== undefined && pause !== undefined, 'les deux contrôles existent');

  stop.click();
  t.diagnostic(`après le premier clic : « ${stop.textContent} »`);
  assert.deepEqual(asked, [], 'rien n’est envoyé sans confirmation');
  assert.match(stop.textContent, /Confirmer/);
  assert.equal(stop.attributes['aria-pressed'], 'true');

  stop.click();
  assert.deepEqual(asked, ['STOP']);
  assert.equal(stop.attributes['aria-pressed'], 'false');

  // Une capacité sans confirmation part au premier clic.
  pause.click();
  assert.deepEqual(asked, ['STOP', 'PAUSE']);
});

test('(F13) STEP et SEND sont exécutables, et SEND ne propose que les cibles reçues', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});

  view['showRunView']?.(
    mutableRunView([
      capability('STEP', { effect: 'TRANSFER_ONE_TURN', longRunning: true }),
      capability('SEND', { effect: 'SEND_HUMAN_MESSAGE', longRunning: true, targets: ['claude'] }),
    ]),
  );

  const actionable = dom.find(
    (node) => node.tagName === 'BUTTON' && node.attributes['data-action'] !== undefined,
  );
  const ids = actionable.map((node) => node.attributes['data-action']);
  t.diagnostic(`contrôles longs : ${ids.join(', ')}`);
  assert.deepEqual(ids.sort(), ['SEND', 'STEP']);

  // Les cibles proposées viennent de la capacité, jamais du manifeste.
  const options = dom.find((node) => node.tagName === 'OPTION');
  assert.deepEqual(options.map((node) => node.attributes['value']), ['claude']);

  const text = dom.document.getElementById('section-overview')?.textContent ?? '';
  assert.ok(text.includes('Passage de témoin'));
  assert.ok(text.includes('Message humain'));
});

// --------------------------------------------------------------------------
// (F14 / M16) Les cibles SEND viennent de la capacité, jamais des sessions
// --------------------------------------------------------------------------

function runViewWithSend(targets: readonly string[]): Record<string, unknown> {
  // Les DEUX sessions existent. Si le sélecteur les reflétait, il proposerait
  // toujours les deux — c'est exactement ce que ce test interdit.
  return runViewFixture('CCR-20260402-001', {
    sessions: { claude: 'claude-1', codex: 'codex-1' },
    capabilities: {
      capabilities: [
        {
          id: 'SEND',
          allowed: true,
          idempotentNoop: false,
          requiresConfirmation: false,
          destructive: false,
          effect: 'SEND_HUMAN_MESSAGE',
          longRunning: true,
          targets,
        },
      ],
      handoff: { availableViaCli: false },
    },
  });
}

test('(F14) le sélecteur SEND reflète SEND.targets, pas les sessions présentes', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };

  for (const [targets, expected] of [
    [['claude'], ['claude']],
    [['codex'], ['codex']],
    [['claude', 'codex'], ['claude', 'codex']],
    [[], []],
  ] as const) {
    const dom = createFakeDom([...SHELL_IDS]);
    createDomView(dom.document, {})['showRunView']?.(runViewWithSend(targets));

    const options = dom.find((node) => node.tagName === 'OPTION').map((node) => node.attributes['value']);
    t.diagnostic(`targets=[${targets.join(',')}] → sélecteur=[${options.join(',')}]`);
    assert.deepEqual(options, [...expected], `targets=[${targets.join(',')}]`);
  }
});

test('(F14 bis) garde de source : la construction du sélecteur SEND ne lit aucune session', async () => {
  const code = await executable('render.js');
  const start = code.indexOf('function sendControl(');
  assert.ok(start > 0, 'la fonction de construction du sélecteur est identifiable');
  const body = code.slice(start, code.indexOf('\n  }', start));

  // Elle consomme les cibles de la capacité…
  assert.ok(body.includes('capability.targets'), 'les cibles viennent de la capacité');
  // …et rien qui décrive les sessions natives du run.
  for (const forbidden of ['sessions', 'manifest', 'session_id', 'runView']) {
    assert.equal(body.includes(forbidden), false, `le sélecteur SEND lit « ${forbidden} »`);
  }
});

// --------------------------------------------------------------------------
// (F15 / M12) Un résultat indéterminé ne propose jamais de rejeu
// --------------------------------------------------------------------------

test('(F15) UNKNOWN : message explicite, vérification manuelle, aucun rejeu offert', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };

  for (const status of ['UNKNOWN', 'RUNNING'] as const) {
    const dom = createFakeDom([...SHELL_IDS]);
    let retried = 0;
    const view = createDomView(dom.document, {
      onRetryMutation: () => {
        retried += 1;
      },
      onCheckOperation: () => {},
    });
    view['showMutationUndetermined']?.('STEP', { status });

    const buttons = dom.find((node) => node.tagName === 'BUTTON').map((node) => node.attributes['id']);
    const text = dom.find((node) => node.tagName === 'SPAN').map((node) => node.textContent).join(' ');
    t.diagnostic(`${status} → boutons=[${buttons.join(',')}] · texte=« ${text.trim()} »`);

    // Le seul geste offert consulte ; il ne réémet rien.
    assert.deepEqual(buttons, ['operation-check'], `${status} : un seul contrôle, la vérification`);
    assert.equal(buttons.includes('mutation-retry'), false, `${status} : aucun rejeu`);
    assert.equal(retried, 0);
    // Le cockpit dit ce qu'il ne sait pas, il ne le déguise pas en échec.
    if (status === 'UNKNOWN') assert.match(text, /inconnu/i);
    else assert.match(text, /en cours/i);
  }
});

// --------------------------------------------------------------------------
// (F16 → F19) Création : les quatre issues, et ce qu'elles n'offrent jamais
// --------------------------------------------------------------------------

async function startView(): Promise<{
  dom: ReturnType<typeof createFakeDom>;
  view: Record<string, (...args: unknown[]) => void>;
  retried: () => number;
  opened: () => string[];
}> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  let retried = 0;
  const opened: string[] = [];
  const view = createDomView(dom.document, {
    onRetryMutation: () => {
      retried += 1;
    },
    onCreateRun: () => {
      retried += 1;
    },
    onCheckStart: () => {},
    onOpenRun: (runId: string) => opened.push(runId),
  });
  return { dom, view, retried: () => retried, opened: () => opened };
}

const startButtons = (dom: ReturnType<typeof createFakeDom>): string[] =>
  dom
    .find((node) => node.tagName === 'BUTTON')
    .map((node) => node.attributes['id'] ?? '')
    .filter((id) => id.length > 0);

test('(F16) UNKNOWN de création : aucun rejeu, jamais', async (t) => {
  for (const [label, receipt] of [
    ['sans run connu', { operation_id: 'op_a', status: 'UNKNOWN' }],
    ['avec run connu', { operation_id: 'op_a', status: 'UNKNOWN', created_run_id: 'CCR-20260402-001' }],
  ] as const) {
    const { dom, view, retried, opened } = await startView();
    view['showStartUndetermined']?.(receipt);

    const buttons = startButtons(dom);
    const text = dom.find((node) => node.tagName === 'SPAN').map((node) => node.textContent).join(' ');
    t.diagnostic(`${label} → boutons=[${buttons.join(',')}] · texte=« ${text.trim()} »`);

    assert.match(text, /inconnu/i, `${label} : le cockpit dit ce qu’il ne sait pas`);
    assert.equal(buttons.includes('mutation-retry'), false, `${label} : aucun rejeu`);
    assert.equal(buttons.includes('start-submit'), false, `${label} : aucune recréation`);
    assert.equal(retried(), 0);

    // Le run n'est ouvrable que s'il est connu — jamais deviné.
    if (receipt.created_run_id === undefined) {
      assert.deepEqual(buttons, ['start-check'], `${label} : un seul geste, la vérification`);
      assert.deepEqual(opened(), [], 'aucune recherche d’un run correspondant');
    } else {
      assert.deepEqual(buttons, ['start-check', 'start-open'], `${label} : vérifier, ou ouvrir`);
      dom.find((node) => node.attributes['id'] === 'start-open')[0]?.click();
      assert.deepEqual(opened(), ['CCR-20260402-001'], 'ouverture du run réellement nommé');
    }
  }
});

test('(F17) AUTH_REQUIRED : la commande est du texte, pas une action', async (t) => {
  const { label } = (await importWeb('labels.js')) as { label: Record<string, (code: string) => string> };
  const message = label['error']?.('AUTH_REQUIRED') ?? '';
  t.diagnostic(`AUTH_REQUIRED → « ${message} »`);

  assert.match(message, /terminal/i, 'le geste appartient au terminal');
  assert.match(message, /ccr setup/, 'la commande exacte est nommée');
  for (const forbidden of ['http://', 'https://', 'javascript:', 'claude login', 'codex login']) {
    assert.equal(message.includes(forbidden), false, `le message contient ${forbidden}`);
  }

  const { dom, view, retried } = await startView();
  view['showStartFailed']?.({ code: 'AUTH_REQUIRED', message, retryable: false }, undefined);
  const buttons = startButtons(dom);
  const text = dom.find((node) => node.tagName === 'SPAN').map((node) => node.textContent).join(' ');
  t.diagnostic(`écran → boutons=[${buttons.join(',') || '<aucun>'}]`);

  assert.ok(text.includes('ccr setup'), 'la commande est affichée telle quelle');
  assert.deepEqual(buttons, [], 'aucun contrôle : la remédiation est humaine et externe');
  assert.equal(retried(), 0, 'aucune nouvelle tentative automatique');
  // Aucun lien : un `ccr setup` cliquable serait une exécution déguisée.
  assert.deepEqual(dom.find((node) => node.tagName === 'A'), []);
});

test('(F18) échec après allocation : le run reste ouvrable, sans reprise', async (t) => {
  const { dom, view, opened, retried } = await startView();
  view['showStartFailed']?.(
    { code: 'INTERNAL_ERROR', message: 'Erreur interne.', retryable: false },
    'CCR-20260808-002',
  );

  const buttons = startButtons(dom);
  const text = dom.find((node) => node.tagName === 'SPAN').map((node) => node.textContent).join(' ');
  t.diagnostic(`échec après allocation → « ${text.trim()} » · boutons=[${buttons.join(',')}]`);

  assert.match(text, /créé mais son initialisation a échoué/i);
  assert.deepEqual(buttons, ['start-open'], 'ouvrir le run, et rien d’autre');
  for (const forbidden of ['RECOVER', 'CLEAR_STALE_LOCK', 'mutation-retry']) {
    assert.equal(buttons.includes(forbidden), false, `contrôle interdit : ${forbidden}`);
  }
  dom.find((node) => node.attributes['id'] === 'start-open')[0]?.click();
  assert.deepEqual(opened(), ['CCR-20260808-002']);
  assert.equal(retried(), 0);
});

test('(F19) le message d’erreur de création ne fuit jamais l’interne', async () => {
  const { dom, view } = await startView();
  view['showStartFailed']?.(
    { code: 'INTERNAL_ERROR', message: 'Erreur interne.', retryable: false },
    undefined,
  );
  const text = dom.find((node) => node.tagName === 'SPAN').map((node) => node.textContent).join(' ');
  for (const leak of ['Error:', 'at ', 'stack', 'ENOENT', 'stderr', 'cause']) {
    assert.equal(text.includes(leak), false, `fuite : ${leak}`);
  }
});

test('(F6 quater) tout module importé par un module servi est lui-même servi', async (t) => {
  // Défaut réellement observé en V2.3-S3 : `render.js` importait
  // `conversation.js`, absent de l'allowlist. Les tests unitaires importaient
  // le fichier depuis le disque et ne voyaient rien ; le navigateur, lui,
  // recevait un 404 et l'application ne démarrait pas.
  const { COCKPIT_ASSETS } = await import('../../src/cockpit/assets.ts');
  // Nos modules uniquement : le module tiers vit sous une autre racine, et S2
  // a déjà prouvé qu'il n'a aucun import à résoudre.
  const servedFiles = new Set(
    [...COCKPIT_ASSETS.values()]
      .filter((asset) => asset.root === 'web' && asset.file.endsWith('.js'))
      .map((asset) => asset.file),
  );
  const servedRoutes = new Set(COCKPIT_ASSETS.keys());

  let checked = 0;
  for (const file of servedFiles) {
    const code = await executable(file);
    for (const match of code.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1] ?? '';
      checked += 1;
      if (specifier.startsWith('./')) {
        assert.ok(
          servedFiles.has(specifier.slice(2)),
          `${file} importe ${specifier}, qui n'est pas servi par l'allowlist`,
        );
      } else if (specifier.startsWith('/')) {
        assert.ok(servedRoutes.has(specifier), `${file} importe la route ${specifier}, absente de l'allowlist`);
      } else {
        // Un spécificateur nu ne se résout pas dans un navigateur sans import
        // map — et nous n'en avons pas.
        assert.fail(`${file} importe le spécificateur nu « ${specifier} »`);
      }
    }
  }
  t.diagnostic(`${String(servedFiles.size)} modules servis · ${String(checked)} imports vérifiés`);
});

// --------------------------------------------------------------------------
// A-P0-01 · Les mutations de run sur la forme NATIVE du read model
//
// Découvert en conditions réelles : sur un run natif, STEP / SEND / PAUSE /
// RESUME étaient offerts par le cockpit et sans effet. Le client lisait
// `runView.capabilities.capabilities`, absent de la projection native, et la
// `TypeError` disparaissait derrière `void cockpit.mutate(action)`.
//
//   forme historique   identity.run_id · capabilities.capabilities[]
//   forme native       run.identity.run_id · run.operations.{step,pause,resume}
//                                          · run.operations.experts[slot].send
//
// Les deux formes coexistent réellement dans un même data root. Ces fixtures
// reproduisent la charge utile native EXACTE relevée sur CCR-20260405-001.
// --------------------------------------------------------------------------

/** Charge utile native, telle que le serveur la sert réellement. */
function nativeRunView(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'a'.repeat(64)}`,
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'CCR-20260405-001',
        execution_mode: 'NATIVE_V21_EXECUTION',
        title: 'Recette réelle',
        created_at: '2026-08-22T19:50:00.000Z',
        workspace_cwd: 'E:/prog/exemple',
      },
      experts: {
        author: { provider: 'claude', session_id: 'c-1', session_status: 'BOUND' },
        challenger: { provider: 'codex', session_id: 'x-1', session_status: 'BOUND' },
      },
      operational_state: {
        state: 'READY', control: 'AUTOMATION', round: 0,
        active_expert_slot: null, next_step_source_slot: 'author',
        last_event_id: 'evt_000007', updated_at: '2026-08-22T19:57:00.000Z',
        pending_operation: null,
      },
      operations: {
        step: {
          allowed: true, source_status: 'READY', source_slot: 'author',
          target_slot: 'challenger', source_event_id: 'evt_000003',
          next_round: 1, payload_bytes: 14224, payload_limit_bytes: 524288,
        },
        pause: { allowed: true, noop: false },
        resume: { allowed: true, noop: true },
        experts: {
          author: { send: { allowed: true } },
          challenger: { send: { allowed: true } },
        },
      },
      recovery: {
        initialization: { status: 'NONE', available_actions: [], conflicts: [] },
        step: { status: 'NONE', available_actions: [], conflicts: [] },
        send: { status: 'NONE', available_actions: [], conflicts: [] },
        handoff: { status: 'NONE', available_actions: [], conflicts: [] },
      },
      providers: null,
      invocation_quota: { kind: 'CONFIGURED', consumed: 2, limit: 8, remaining: 6, exhausted: false, coverage: 'SINCE_LEDGER_START' },
      usage: {
        coverage: 'SINCE_LEDGER_START',
        invocations: { total: 2, provider_reported: { observed: 2, unobserved: 0, ambiguous: 0 } },
        providers: [], anomalies: { orphan_observations: [], duplicate_observations: [] },
      },
      cost_estimate: { coverage: 'SINCE_LEDGER_START', pricing: { kind: 'NONE' }, by_invocation: [], providers: [] },
      counts: { events: 7 },
      compatibility: { provider_aliases: {} },
    },
    presentation: { presentation_version: 1, actions: [], latest_contributions: { author: null, challenger: null }, initial_context: { status: 'UNAVAILABLE', reason: 'NOT_FOUND', event_ids: [] } },
  };
  return deepMergeNative(base, over);
}

function deepMergeNative(base: unknown, over: unknown): Record<string, unknown> {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over as Record<string, unknown>;
  if (typeof over !== 'object' || over === null || Array.isArray(over)) return over as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over as Record<string, unknown>)) {
    out[key] = deepMergeNative((base as Record<string, unknown>)[key], value);
  }
  return out;
}

interface NativeHarness {
  readonly cockpit: {
    selectRun(id: string): Promise<void>;
    mutate(action: string, options?: Record<string, unknown>): Promise<void>;
  };
  readonly calls: MutationCall[];
  readonly viewCalls: Recorded[];
}

async function nativeHarness(view$: Record<string, unknown>): Promise<NativeHarness> {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => NativeHarness['cockpit'];
  };
  const { calls: viewCalls, view } = recordingView();
  const calls: MutationCall[] = [];
  const api = {
    getRun: () => Promise.resolve(view$),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
    listRuns: () => Promise.resolve({ runs: [] }),
    mutate: (action: string, runId: string, payload: Record<string, unknown>, key: string) => {
      calls.push({ action, runId, payload, key });
      return Promise.resolve({ operation_id: 'op-1', status: 'SUCCEEDED' });
    },
  };
  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('CCR-20260405-001');
  return { cockpit, calls, viewCalls };
}

test('(A-P0-01/A) STEP autorisé sur la forme native déclenche la mutation', async (t) => {
  const h = await nativeHarness(nativeRunView());
  await h.cockpit.mutate('STEP');
  t.diagnostic(`envois=${String(h.calls.length)}`);
  assert.equal(h.calls.length, 1, 'la mutation part');
  assert.equal(h.calls[0]?.action, 'STEP');
  assert.equal(h.calls[0]?.runId, 'CCR-20260405-001', 'identifiant lu sous run.identity');
  assert.equal(h.calls[0]?.payload['expected_revision'], `sha256:${'a'.repeat(64)}`);
});

test('(A-P0-01/B) SEND autorisé sur la forme native vise un ExpertSlot', async () => {
  const h = await nativeHarness(nativeRunView());
  await h.cockpit.mutate('SEND', { target: 'challenger', content: 'question humaine' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.payload['target'], 'challenger');
  assert.equal(h.calls[0]?.payload['content'], 'question humaine');

  // Un slot dont l'envoi n'est pas autorisé est refusé, sans envoi.
  const closed = await nativeHarness(nativeRunView({
    run: { operations: { experts: { challenger: { send: { allowed: false } } } } },
  }));
  await closed.cockpit.mutate('SEND', { target: 'challenger', content: 'question' });
  assert.equal(closed.calls.length, 0, 'slot fermé : aucun envoi');
});

test('(A-P0-01/C) PAUSE autorisé sur la forme native déclenche la mutation', async () => {
  const h = await nativeHarness(nativeRunView());
  await h.cockpit.mutate('PAUSE');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.action, 'PAUSE');
  assert.equal(h.calls[0]?.runId, 'CCR-20260405-001');
});

test('(A-P0-01/D) RESUME autorisé sur la forme native déclenche la mutation', async () => {
  const h = await nativeHarness(nativeRunView());
  await h.cockpit.mutate('RESUME');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.action, 'RESUME');
});

test('(A-P0-01/E) l’absence de `capabilities` ne provoque aucune TypeError', async (t) => {
  const view$ = nativeRunView();
  // La garantie porte sur la forme réellement servie : ni `identity` ni
  // `capabilities` à la racine.
  assert.equal(view$['identity'], undefined, 'la fixture reproduit bien la forme native');
  assert.equal(view$['capabilities'], undefined);

  const h = await nativeHarness(view$);
  for (const action of ['STEP', 'SEND', 'PAUSE', 'RESUME']) {
    await h.cockpit.mutate(action, { target: 'author', content: 'x' });
  }
  t.diagnostic(`envois=${String(h.calls.length)}`);
  assert.equal(h.calls.length, 4, 'les quatre gestes atteignent le transport');
  // Aucun geste ne s'est terminé en échec de composition.
  assert.equal(
    h.viewCalls.filter((c) => c.kind === 'showMutationError').length,
    0,
    'aucune erreur de composition sur une vue native complète',
  );
});

test('(A-P0-01/F) une opération refusée par le cœur reste refusée, sans envoi', async () => {
  const refused = await nativeHarness(nativeRunView({
    run: { operations: { step: { allowed: false, source_status: 'MISSING' }, pause: { allowed: false, noop: false } } },
  }));
  await refused.cockpit.mutate('STEP');
  await refused.cockpit.mutate('PAUSE');
  assert.equal(refused.calls.length, 0, 'un refus du cœur n’envoie rien');
  // Un refus n'est pas une panne : il reste silencieux, comme avant.
  assert.equal(refused.viewCalls.filter((c) => c.kind === 'showMutationError').length, 0);
});

test('(A-P0-01/G+H) une vue incomposable est signalée, jamais annoncée comme un succès', async (t) => {
  // Vue mutilée : la projection ne porte pas les opérations. C'est exactement
  // la situation qui produisait un bouton mort.
  const broken = await nativeHarness(nativeRunView({ run: { operations: null } }));
  await broken.cockpit.mutate('STEP');

  t.diagnostic(`retours=${broken.viewCalls.map((c) => c.kind).join(',')}`);
  assert.equal(broken.calls.length, 0, 'rien n’est envoyé');
  assert.equal(
    broken.viewCalls.filter((c) => c.kind === 'showMutationError').length,
    1,
    'l’échec est rendu visible',
  );
  // H · aucun succès n'est annoncé.
  assert.equal(broken.viewCalls.filter((c) => c.kind === 'showMutationSucceeded').length, 0);

  // Le motif exact, capté avec les DEUX arguments de `showMutationError`.
  const reported: { action?: unknown; described?: Record<string, unknown> } = {};
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => NativeHarness['cockpit'];
  };
  const view = {
    showMutationError: (action: unknown, described: Record<string, unknown>) => {
      reported.action = action;
      reported.described = described;
    },
  } as unknown as Record<string, (...args: unknown[]) => void>;
  const api = {
    getRun: () => Promise.resolve(nativeRunView({ run: { operations: null } })),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
    listRuns: () => Promise.resolve({ runs: [] }),
    mutate: () => Promise.reject(new Error('aucun envoi attendu')),
  };
  const cockpit = createCockpit({ api, view: new Proxy(view, {
    get: (target, property: string) => (target as Record<string, unknown>)[property] ?? (() => {}),
  }) });
  await cockpit.selectRun('CCR-20260405-001');
  await cockpit.mutate('STEP');
  assert.equal(reported.action, 'STEP', 'l’erreur nomme le geste');
  assert.equal(reported.described?.['code'], 'CLIENT_CANNOT_COMPOSE');
  assert.equal(reported.described?.['retryable'], false, 'aucun réessai proposé');
});

test('(A-P0-01/I) un échec de composition ne rejoue rien et ne réessaie rien', async () => {
  const broken = await nativeHarness(nativeRunView({ run: { operations: null } }));
  await broken.cockpit.mutate('STEP');
  await broken.cockpit.mutate('STEP');
  assert.equal(broken.calls.length, 0, 'aucun envoi, même après un second geste humain');
  // Deux gestes humains, deux messages : aucun réessai automatique entre eux.
  assert.equal(broken.viewCalls.filter((c) => c.kind === 'showMutationError').length, 2);
});

test('(A-P0-01/J) la forme historique continue de fonctionner à l’identique', async () => {
  // La régression ne doit pas se déplacer : les runs antérieurs vivent encore
  // dans le même data root, sous la forme `capabilities` + `identity`.
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => NativeHarness['cockpit'];
  };
  const { view } = recordingView();
  const calls: MutationCall[] = [];
  const api = {
    getRun: () => Promise.resolve(mutableRunView([capability('PAUSE'), capability('SEND', { targets: ['claude'] })])),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
    listRuns: () => Promise.resolve({ runs: [] }),
    mutate: (action: string, runId: string, payload: Record<string, unknown>, key: string) => {
      calls.push({ action, runId, payload, key });
      return Promise.resolve({ operation_id: 'op-2', status: 'SUCCEEDED' });
    },
  };
  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('CCR-20260402-001');
  await cockpit.mutate('PAUSE');
  await cockpit.mutate('SEND', { target: 'claude', content: 'bonjour' });
  assert.equal(calls.length, 2, 'les deux gestes historiques partent');
  assert.equal(calls[0]?.runId, 'CCR-20260402-001', 'identifiant lu sous identity');
  assert.equal(calls[1]?.payload['target'], 'claude', 'cible lue dans capability.targets');
});

// --------------------------------------------------------------------------
// A-N-P2-01 · Une soumission de création, une requête de création
//
// Observé en conditions réelles : la création partait, le suivi s'affichait,
// mais le formulaire restait offert à l'identique et le bouton restait armé.
// Chaque appel alloue une clé d'idempotence NEUVE — donc une intention neuve :
// deux clics auraient produit deux runs réels et jusqu'à quatre invocations
// fournisseur de plus.
//
//   RISQUE DÉMONTRÉ PAR L'ÉTAT DE L'INTERFACE  ≠  DOUBLON RÉELLEMENT OBSERVÉ
//
// La garde vit dans le cockpit, pas seulement dans le rendu : désarmer un
// bouton n'empêche pas un gestionnaire d'être invoqué deux fois avant que le
// rendu n'ait eu lieu.
// --------------------------------------------------------------------------

interface StartHarness {
  readonly cockpit: {
    createRun(payload: Record<string, unknown>): Promise<void>;
    state: Record<string, unknown>;
  };
  readonly creates: { payload: Record<string, unknown>; key: string }[];
  readonly viewCalls: Recorded[];
  readonly settle: (receipt: Record<string, unknown>) => void;
  readonly fail: (error: unknown) => void;
}

/** Transport de création dont la promesse reste volontairement pendante. */
async function startHarness(): Promise<StartHarness> {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => StartHarness['cockpit'];
  };
  const { calls: viewCalls, view } = recordingView();
  const creates: { payload: Record<string, unknown>; key: string }[] = [];
  const pending = deferred<Record<string, unknown>>();
  const api = {
    createRun: (payload: Record<string, unknown>, key: string) => {
      creates.push({ payload, key });
      return pending.promise;
    },
    listRuns: () => Promise.resolve({ runs: [] }),
    getRun: () => Promise.resolve({}),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
    getOperation: () => Promise.reject(new Error('non sollicité')),
  };
  const cockpit = createCockpit({ api, view });
  return { cockpit, creates, viewCalls, settle: pending.resolve, fail: pending.reject };
}

test('(A-N-P2-01/A) pendant une création en vol, une seconde soumission n’émet rien', async (t) => {
  const h = await startHarness();
  const payload = { title: 'Sujet', workspace_cwd: 'E:/prog/x', prompt: 'Contexte' };

  // Premier envoi : la promesse de création reste pendante.
  const first = h.cockpit.createRun(payload);
  assert.equal(h.creates.length, 1, 'la première demande part');
  assert.equal(h.cockpit.state['startInFlight'], true, 'une soumission est en vol');

  // Second clic, double-clic, soumission clavier : trois tentatives pendant
  // la même fenêtre. Aucune ne doit atteindre le transport.
  //
  // Elles ne sont volontairement PAS attendues : sans garde, chacune se met en
  // attente de la même promesse pendante et le test ne rendrait jamais la main.
  // On mesure ce qui est parti, immédiatement.
  void h.cockpit.createRun(payload);
  void h.cockpit.createRun(payload);
  void h.cockpit.createRun({ ...payload, title: 'Autre sujet' });
  await Promise.resolve();

  t.diagnostic(`créations émises=${String(h.creates.length)}`);
  assert.equal(h.creates.length, 1, 'create request count = 1');

  // Le `202` retombe : la requête est terminée, la TENTATIVE ne l'est pas.
  // La garde tient, sans quoi la création suivante partirait pendant que la
  // première s'initialise encore.
  h.settle({ operation_id: 'op-1', status: 'RUNNING', created_run_id: 'CCR-X', created_at: '2026-08-23T00:00:00.000Z' });
  await first;
  assert.equal(h.cockpit.state['startInFlight'], true, 'un 202 ne résout pas la tentative');
  await h.cockpit.createRun({ title: 'encore un', workspace_cwd: 'E:/prog/x', prompt: 'p' });
  assert.equal(h.creates.length, 1, 'aucune seconde requête après un 202');
});

test('(A-N-P2-01/B) le formulaire est gelé dès le premier clic, et le dit', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const payloads: Record<string, unknown>[] = [];
  createDomView(dom.document, { onCreateRun: (p: Record<string, unknown>) => payloads.push(p) });

  const field = (id: string) => dom.document.getElementById(id);
  const submitButton = field('start-submit');
  for (const id of ['start-title', 'start-workspace', 'start-prompt']) {
    const node = field(id);
    if (node !== null) node.value = 'x';
  }

  assert.equal(submitButton?.disabled, undefined, 'armé avant le geste');
  submitButton?.click();

  t.diagnostic(`libellé=${String(submitButton?.textContent)}`);
  assert.equal(payloads.length, 1, 'la demande part une fois');
  assert.equal(submitButton?.disabled, true, 'le bouton est immédiatement désarmé');
  assert.equal(submitButton?.attributes['aria-busy'], 'true', 'l’état occupé est annoncé');
  assert.equal(submitButton?.textContent, 'Démarrage en cours…', 'l’attente est visible');

  // Les champs sont gelés, mais leurs valeurs restent lisibles : geler n'est
  // pas vider — l'humain doit pouvoir relire ce qu'il a demandé.
  for (const id of ['start-title', 'start-workspace', 'start-prompt', 'start-author', 'start-challenger', 'start-max-invocations']) {
    assert.equal(field(id)?.disabled, true, `champ non gelé : ${id}`);
  }
  assert.equal(field('start-title')?.value, 'x', 'la valeur soumise reste visible');

  // Deuxième et troisième clics pendant le gel : rien de plus n'est émis.
  submitButton?.click();
  submitButton?.click();
  assert.equal(payloads.length, 1, 'aucune seconde intention émise par le rendu');
});

test('(A-N-P2-01/C) un échec réarme le formulaire, sans rien rejouer', async (t) => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const payloads: Record<string, unknown>[] = [];
  const api = createDomView(dom.document, { onCreateRun: (p: Record<string, unknown>) => payloads.push(p) });

  const field = (id: string) => dom.document.getElementById(id);
  for (const [id, value] of [['start-title', 'Sujet'], ['start-workspace', 'E:/prog/x'], ['start-prompt', 'Contexte']]) {
    const node = field(id ?? '');
    if (node !== null) node.value = value ?? '';
  }
  field('start-submit')?.click();
  assert.equal(payloads.length, 1);

  api['showStartFailed']?.({ code: 'AGENT_CLI_NOT_FOUND', message: 'Une CLI d agent est absente.', retryable: false }, undefined);

  t.diagnostic(`libellé après échec=${String(field('start-submit')?.textContent)}`);
  assert.equal(field('start-submit')?.disabled, false, 'le bouton est réarmé');
  assert.equal(field('start-submit')?.attributes['aria-busy'], 'false');
  assert.equal(field('start-submit')?.textContent, 'Démarrer la contre-expertise', 'libellé rendu');
  for (const id of ['start-title', 'start-workspace', 'start-prompt']) {
    assert.equal(field(id)?.disabled, false, `champ resté gelé : ${id}`);
  }
  // Valeurs conservées : l'humain corrige, il ne ressaisit pas tout.
  assert.equal(field('start-title')?.value, 'Sujet');
  assert.equal(field('start-prompt')?.value, 'Contexte');
  // Aucun rejeu automatique : rien n'est reparti tout seul.
  assert.equal(payloads.length, 1, 'aucun réessai automatique');

  // Une relance VOLONTAIRE repart normalement.
  field('start-submit')?.click();
  assert.equal(payloads.length, 2, 'un nouveau geste humain repart');
});

test('(A-N-P2-01/D) un succès rend la main, et une incertitude aussi', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const start = async (): Promise<{ dom: ReturnType<typeof createFakeDom>; api: Record<string, (...args: unknown[]) => void> }> => {
    const dom = createFakeDom([...SHELL_IDS]);
    const api = createDomView(dom.document, { onCreateRun: () => {} });
    for (const id of ['start-title', 'start-workspace', 'start-prompt']) {
      const node = dom.document.getElementById(id);
      if (node !== null) node.value = 'x';
    }
    dom.document.getElementById('start-submit')?.click();
    assert.equal(dom.document.getElementById('start-submit')?.disabled, true);
    return { dom, api };
  };

  const ok = await start();
  ok.api['showStartSucceeded']?.('CCR-20260823-002');
  assert.equal(ok.dom.document.getElementById('start-submit')?.disabled, false, 'succès : main rendue');

  // Une issue INCONNUE ne rend PAS la main : la création a pu aboutir sans que
  // le client en obtienne la confirmation. `UNKNOWN` n'est pas `FAILED`.
  const unknown = await start();
  unknown.api['showStartUndetermined']?.({ status: 'UNKNOWN', operation_id: 'op-2', created_at: '2026-08-23T00:00:00.000Z' });
  assert.equal(unknown.dom.document.getElementById('start-submit')?.disabled, true, 'incertitude : formulaire maintenu gelé');

  // Un `202` laisse au contraire le formulaire gelé : l'initialisation
  // continue, et réarmer ici permettrait de créer un second run pendant
  // qu'un premier s'initialise.
  const pending = await start();
  pending.api['showStartPending']?.({ status: 'RUNNING', operation_id: 'op-3', created_run_id: 'CCR-20260823-003', created_at: '2026-08-23T00:00:00.000Z' });
  assert.equal(pending.dom.document.getElementById('start-submit')?.disabled, true, '202 : le formulaire reste gelé');
});

// --------------------------------------------------------------------------
// A-N-P2-01 · Cycle de vie complet d'une tentative de création
//
// La garde ne dure pas le temps de la requête, mais le temps de la TENTATIVE.
// Un `202` rend la main au client alors que la création se poursuit ; une issue
// inconnue laisse ouverte la possibilité qu'un run existe déjà.
//
//   RÉSOLU AVEC CERTITUDE   SUCCEEDED · verdict FAILED du serveur
//   NON RÉSOLU              202 · UNKNOWN · aucune réponse
//
//   UNKNOWN  ≠  FAILED          VÉRIFIER LE RÉSULTAT  ≠  NOUVELLE INTENTION
// --------------------------------------------------------------------------

interface LifecycleHarness {
  readonly cockpit: {
    createRun(payload: Record<string, unknown>): Promise<void>;
    checkStart(): Promise<void>;
    state: Record<string, unknown>;
  };
  readonly creates: { key: string }[];
  readonly operationReads: string[];
}

async function lifecycle(
  first: () => Promise<Record<string, unknown>>,
  operation: () => Record<string, unknown>,
): Promise<LifecycleHarness> {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => LifecycleHarness['cockpit'];
  };
  const { view } = recordingView();
  const creates: { key: string }[] = [];
  const operationReads: string[] = [];
  const api = {
    createRun: (_payload: Record<string, unknown>, key: string) => {
      creates.push({ key });
      return first();
    },
    getOperation: (id: string) => {
      operationReads.push(id);
      return Promise.resolve({ ...operation(), operation_id: id });
    },
    listRuns: () => Promise.resolve({ runs: [] }),
    getRun: () => Promise.resolve({}),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
  };
  const cockpit = createCockpit({ api, view });
  return { cockpit, creates, operationReads };
}

const PAYLOAD = { title: 'Sujet', workspace_cwd: 'E:/prog/x', prompt: 'Contexte' };

test('(A-N-P2-01/L-A) échec CERTAIN du serveur : la main revient, la relance est volontaire', async (t) => {
  const { ApiError } = (await importWeb('api.js')) as { ApiError: new (s: number, c: string) => Error };
  const h = await lifecycle(
    () => Promise.reject(new ApiError(400, 'INVALID_ARGUMENT')),
    () => ({ status: 'FAILED' }),
  );

  await h.cockpit.createRun(PAYLOAD);
  t.diagnostic(`garde=${String(h.cockpit.state['startInFlight'])}`);
  assert.equal(h.creates.length, 1, 'une requête');
  assert.equal(h.cockpit.state['startInFlight'], false, 'un verdict du serveur résout la tentative');

  // Aucun réessai automatique : c'est un geste humain qui relance.
  await h.cockpit.createRun(PAYLOAD);
  assert.equal(h.creates.length, 2, 'la relance volontaire est autorisée');
  assert.notEqual(h.creates[0]?.key, h.creates[1]?.key, 'une nouvelle intention, une nouvelle clé');
});

test('(A-N-P2-01/L-B) 202 : la création continue, aucune seconde intention', async (t) => {
  const h = await lifecycle(
    () => Promise.resolve({ operation_id: 'op-1', status: 'RUNNING', created_run_id: 'CCR-X', created_at: '2026-08-23T00:00:00.000Z' }),
    () => ({ status: 'RUNNING' }),
  );

  await h.cockpit.createRun(PAYLOAD);
  t.diagnostic(`garde=${String(h.cockpit.state['startInFlight'])}`);
  assert.equal(h.cockpit.state['startInFlight'], true, 'un 202 ne résout rien');

  // Clic, invocation directe, soumission clavier : trois voies, aucune ne passe.
  await h.cockpit.createRun(PAYLOAD);
  await h.cockpit.createRun({ ...PAYLOAD, title: 'Autre' });
  await h.cockpit.createRun(PAYLOAD);
  assert.equal(h.creates.length, 1, 'create request count = 1');
});

test('(A-N-P2-01/L-C) issue inconnue : rien de nouveau ne part, et la vérification porte sur LA tentative', async (t) => {
  let status = 'UNKNOWN';
  const h = await lifecycle(
    () => Promise.resolve({ operation_id: 'op-7', status: 'UNKNOWN', created_at: '2026-08-23T00:00:00.000Z' }),
    () => ({ status }),
  );

  await h.cockpit.createRun(PAYLOAD);
  assert.equal(h.cockpit.state['startInFlight'], true, 'UNKNOWN n’est pas FAILED');
  const key = h.creates[0]?.key;

  // Une nouvelle intention est refusée tant que l'issue reste inconnue.
  await h.cockpit.createRun(PAYLOAD);
  assert.equal(h.creates.length, 1, 'aucune création concurrente');

  // « Vérifier le résultat » interroge l'opération existante — et rien d'autre.
  await h.cockpit.checkStart();
  t.diagnostic(`lectures d'opération=${h.operationReads.join(',')}`);
  assert.deepEqual(h.operationReads, ['op-7'], 'la vérification porte sur la tentative existante');
  assert.equal(h.creates.length, 1, 'vérifier n’est pas créer');
  assert.equal((h.cockpit.state['start'] as Record<string, unknown>)['key'], key, 'aucune nouvelle clé d’idempotence');
  assert.equal(h.cockpit.state['startInFlight'], true, 'toujours inconnu : la garde tient');

  // L'opération finit par rendre un verdict : la tentative se résout.
  status = 'FAILED';
  await h.cockpit.checkStart();
  assert.equal(h.cockpit.state['startInFlight'], false, 'un verdict résout enfin la tentative');
  assert.equal(h.creates.length, 1, 'toujours une seule création');

  // Et seulement alors une relance volontaire repart.
  await h.cockpit.createRun(PAYLOAD);
  assert.equal(h.creates.length, 2);
});

test('(A-N-P2-01/L-D) sans réponse du serveur, l’issue reste inconnue', async (t) => {
  const { ApiError } = (await importWeb('api.js')) as { ApiError: new (s: number, c: string) => Error };
  // `status = 0` : aucune réponse n'est parvenue. La requête a pu être reçue et
  // honorée — le client ne le sait pas, et ne doit pas le supposer.
  const h = await lifecycle(
    () => Promise.reject(new ApiError(0, 'NETWORK')),
    () => ({ status: 'RUNNING' }),
  );

  await h.cockpit.createRun(PAYLOAD);
  t.diagnostic(`garde=${String(h.cockpit.state['startInFlight'])}`);
  assert.equal(h.cockpit.state['startInFlight'], true, 'sans réponse, rien n’est résolu');

  await h.cockpit.createRun(PAYLOAD);
  assert.equal(h.creates.length, 1, 'aucune seconde intention sur une issue inconnue');
});

test('(A-N-P2-01/L-E) « Annuler » est local : il ne résout aucune tentative', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const payloads: unknown[] = [];
  createDomView(dom.document, { onCreateRun: (p: unknown) => payloads.push(p) });
  for (const id of ['start-title', 'start-workspace', 'start-prompt']) {
    const node = dom.document.getElementById(id);
    if (node !== null) node.value = 'x';
  }
  dom.document.getElementById('start-submit')?.click();
  assert.equal(dom.document.getElementById('start-submit')?.disabled, true);

  // Le geste ne touche à aucune opération serveur : il change de vue. Réarmer
  // ici laisserait créer un second run pendant qu'un premier s'initialise.
  dom.document.getElementById('start-cancel')?.click();
  assert.equal(
    dom.document.getElementById('start-submit')?.disabled,
    true,
    'quitter l’écran ne résout pas la tentative',
  );
  assert.equal(payloads.length, 1, 'aucune création supplémentaire');
});

test('(A-N-P2-01/L-F) un verdict d’échec réarme, une panne sans réponse non', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const armed = async (): Promise<{ dom: ReturnType<typeof createFakeDom>; api: Record<string, (...args: unknown[]) => void> }> => {
    const dom = createFakeDom([...SHELL_IDS]);
    const api = createDomView(dom.document, { onCreateRun: () => {} });
    for (const id of ['start-title', 'start-workspace', 'start-prompt']) {
      const node = dom.document.getElementById(id);
      if (node !== null) node.value = 'x';
    }
    dom.document.getElementById('start-submit')?.click();
    return { dom, api };
  };

  // Verdict du serveur : la main revient.
  const verdict = await armed();
  verdict.api['showStartFailed']?.({ code: 'INVALID_ARGUMENT', message: 'Requête invalide.', retryable: false, attempt_resolved: true }, undefined);
  assert.equal(verdict.dom.document.getElementById('start-submit')?.disabled, false, 'verdict : main rendue');

  // Aucune réponse : l'issue reste inconnue, le formulaire reste gelé.
  const silence = await armed();
  silence.api['showStartFailed']?.({ code: 'INTERNAL_ERROR', message: 'panne', retryable: false, attempt_resolved: false }, undefined);
  assert.equal(silence.dom.document.getElementById('start-submit')?.disabled, true, 'sans réponse : formulaire gelé');
});

// --------------------------------------------------------------------------
// A-N-P2-01 · Terminalité d'une réponse HTTP d'erreur
//
// Une réponse d'erreur ne prouve rien par elle-même. `respondFor` rend un reçu
// terminal `FAILED` — donc postérieur à `store.claim`, et parfois postérieur à
// l'allocation d'un run — sous un statut d'erreur lui aussi, en y joignant
// `operation_id`. Et `INTERNAL_ERROR → 500` est le repli de tout ce que
// personne n'a énuméré : son point d'émission n'est pas contraint.
//
//   HTTP ERROR  ≠  CERTAIN TERMINAL FAILURE
//
// Trois établissements de terminalité, et trois seulement :
//   un run connu · un reçu terminal · un refus antérieur à toute réclamation.
// --------------------------------------------------------------------------

interface TerminalityCase {
  readonly creates: number;
  readonly guardAfter: boolean;
  readonly secondAllowed: boolean;
}

async function terminality(
  makeError: () => Error,
  receipt: Record<string, unknown> | null,
): Promise<TerminalityCase> {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => {
      createRun(payload: Record<string, unknown>): Promise<void>;
      state: Record<string, unknown>;
    };
  };
  const { view } = recordingView();
  const creates: string[] = [];
  const api = {
    createRun: (_p: unknown, key: string) => {
      creates.push(key);
      return Promise.reject(makeError());
    },
    getOperation: (id: string) =>
      receipt === null
        ? Promise.reject(new Error('reçu illisible'))
        : Promise.resolve({ ...receipt, operation_id: id }),
    listRuns: () => Promise.resolve({ runs: [] }),
    getRun: () => Promise.resolve({}),
    getTimeline: () => Promise.resolve(timelinePage([], null)),
    getRecovery: () => Promise.resolve({ capabilities: [], missing_primitives: [] }),
  };
  const cockpit = createCockpit({ api, view });
  const payload = { title: 'Sujet', workspace_cwd: 'E:/prog/x', prompt: 'Contexte' };
  await cockpit.createRun(payload);
  const guardAfter = cockpit.state['startInFlight'] === true;
  await cockpit.createRun(payload);
  return { creates: creates.length, guardAfter, secondAllowed: creates.length > 1 };
}

async function apiError(status: number, code: string, operationId?: string): Promise<Error> {
  const { ApiError } = (await importWeb('api.js')) as { ApiError: new (s: number, c: string) => Error };
  const error = new ApiError(status, code) as Error & { operationId?: string };
  if (operationId !== undefined) error.operationId = operationId;
  return error;
}

test('(A-N-P2-01/T-A) un refus antérieur à toute réclamation résout la tentative', async (t) => {
  // `respondFor` n'ajoute `operation_id` qu'à un reçu réglé. Son absence, sur
  // un code que START n'émet qu'avant `store.claim`, établit qu'aucune
  // opération n'a été réclamée — donc qu'aucun run ne peut apparaître.
  const refusal = await terminality(() => {
    const e = new Error('400 INVALID_ARGUMENT') as Error & { name: string; status: number; code: string };
    e.name = 'ApiError'; e.status = 400; e.code = 'INVALID_ARGUMENT';
    return e;
  }, null);
  t.diagnostic(`garde=${String(refusal.guardAfter)}`);
  // Une valeur qui n'est pas une vraie `ApiError` n'est jamais tenue pour
  // résolue : la classification lit le type, pas une forme approchante.
  assert.equal(refusal.secondAllowed, false, 'un objet ressemblant n’établit rien');
  assert.equal(refusal.guardAfter, true, 'la garde tient sur une forme non reconnue');
});

test('(A-N-P2-01/T-B) 400 pré-création : la main revient', async () => {
  const error = await apiError(400, 'INVALID_ARGUMENT');
  const c = await terminality(() => error, null);
  assert.equal(c.guardAfter, false, 'aucune opération réclamée : tentative résolue');
  assert.equal(c.secondAllowed, true, 'relance volontaire autorisée');
});

test('(A-N-P2-01/T-C) 5xx sans reçu : origine indécidable, la garde tient', async (t) => {
  // `INTERNAL_ERROR` est le repli de la table publique : rien n'établit qu'il
  // ait été émis avant `store.claim`. Le traiter comme un échec certain
  // autoriserait une seconde création alors qu'un run peut exister.
  const c = await terminality(await apiError(500, 'INTERNAL_ERROR').then((e) => () => e), null);
  t.diagnostic(`garde=${String(c.guardAfter)} · créations=${String(c.creates)}`);
  assert.equal(c.guardAfter, true, '5xx ne résout rien');
  assert.equal(c.creates, 1, 'aucune seconde intention');

  // Un statut non répertorié suit le même régime.
  const gateway = await terminality(await apiError(502, 'INTERNAL_ERROR').then((e) => () => e), null);
  assert.equal(gateway.creates, 1, '502 : même régime');
});

test('(A-N-P2-01/T-D) un reçu terminal résout, un reçu encore en cours non', async () => {
  // Le serveur a tranché : le reçu porte `FAILED`. C'est LE reçu qui l'établit,
  // pas le statut HTTP sous lequel il voyage.
  const settled = await terminality(
    await apiError(400, 'INVALID_ARGUMENT', 'op-1').then((e) => () => e),
    { status: 'FAILED' },
  );
  assert.equal(settled.guardAfter, false, 'reçu terminal : tentative résolue');
  assert.equal(settled.secondAllowed, true);

  // Le reçu dit `RUNNING` : la création se poursuit malgré l'erreur reçue.
  const running = await terminality(
    await apiError(500, 'INTERNAL_ERROR', 'op-2').then((e) => () => e),
    { status: 'RUNNING' },
  );
  assert.equal(running.guardAfter, true, 'opération encore en cours');
  assert.equal(running.creates, 1);

  // Reçu illisible : on ne sait pas, donc on ne libère pas.
  const unreadable = await terminality(
    await apiError(500, 'INTERNAL_ERROR', 'op-3').then((e) => () => e),
    null,
  );
  assert.equal(unreadable.guardAfter, true, 'reçu illisible : rien n’est établi');
  assert.equal(unreadable.creates, 1);
});

test('(A-N-P2-01/T-E) un run déjà alloué résout la tentative', async () => {
  // Cas documenté par le serveur lui-même : « un échec peut être postérieur à
  // l'allocation ». Le run existe et reste inspectable ; une création suivante
  // est une intention neuve, pas un doublon fantôme.
  const allocated = await terminality(
    await apiError(500, 'INTERNAL_ERROR', 'op-4').then((e) => () => e),
    { status: 'FAILED', created_run_id: 'CCR-20260823-009' },
  );
  assert.equal(allocated.guardAfter, false, 'un run connu résout la tentative');
  assert.equal(allocated.secondAllowed, true);
});
