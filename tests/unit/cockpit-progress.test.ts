/**
 * V5.1 — l'écran dit qui travaille, depuis quand, et ce qui en est sorti.
 *
 * Question de preuve :
 *
 * > **Pendant une opération longue, l'humain peut-il savoir ce qui se passe
 * > sans lancer un observateur externe — et l'apprend-il sans cliquer ?**
 *
 * Le run réel `CCR-20260404-001` a répondu non aux deux. Onze minutes et demie
 * d'initialisation n'ont affiché qu'un identifiant opaque ; la fin d'une
 * proposition assistée n'est arrivée à l'écran qu'après un clic manuel, et sous
 * la forme d'un « effectuée » qui ne correspondait à aucun enregistrement.
 *
 * Quatre propriétés.
 *
 *  1. **Qui, et depuis quand.** Le slot appelé, son moteur et la durée écoulée
 *     sont rendus — pour l'initialisation comme pour la proposition.
 *  2. **La position quand elle est connue.** `étape 1/2` vient du serveur ;
 *     absente du serveur, elle n'est pas affichée.
 *  3. **La fin arrive seule.** Le suivi lit le reçu, s'arrête sur son issue
 *     terminale, et recharge la vue autoritaire.
 *  4. **Le suivi ne coûte rien.** Il n'émet que des `GET` et ne détient aucun
 *     moyen de rejouer une mutation.
 *
 * ```text
 * REAL_PROVIDER_CALLS = 0
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);

const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

type View = Record<string, (...args: unknown[]) => unknown>;

/** Vue enregistrant **tous** les arguments — le contexte est le troisième. */
function recordingView(): { calls: { kind: string; args: unknown[] }[]; view: View } {
  const calls: { kind: string; args: unknown[] }[] = [];
  const view = new Proxy(
    {},
    {
      get: (_target, property: string) => (...args: unknown[]) => {
        calls.push({ kind: property, args });
      },
    },
  ) as View;
  return { calls, view };
}

/** Texte visible d'un conteneur du shell. */
function textOf(dom: ReturnType<typeof createFakeDom>, id: string): string {
  const node = dom.document.getElementById(id);
  return node === null ? '' : node.textContent;
}

/**
 * Texte du **seul** bandeau d'attente.
 *
 * Portée volontairement étroite : l'écran contient par ailleurs une carte
 * « Prochaine étape » et un quota « restant », qui n'ont rien à voir avec une
 * progression. Une garde qui balayerait toute la vue accuserait ces deux-là.
 */
function inFlightText(dom: ReturnType<typeof createFakeDom>): string {
  const panel = dom.find((node) => node.attributes['data-inflight'] !== undefined);
  return panel.map((node) => node.textContent).join(' ');
}

/** Code exécutable — les commentaires citent les interdits qu'ils protègent. */
function executableCode(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

const STARTED = '2026-08-21T02:55:41.000Z';
/** Neuf secondes plus tard — la durée réelle de `inv_000003`, au millième près. */
const NOW = Date.parse(STARTED) + 9_004;

function recoveryDomain(): Record<string, unknown> {
  return { status: 'NONE', available_actions: [], conflicts: [] };
}

/**
 * Vue native minimale mais **complète** — la forme que le serveur rend
 * réellement, `in_flight` compris.
 */
function runViewWithFlight(flight: unknown): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'a'.repeat(64)}`,
    in_flight: flight,
    presentation: {
      presentation_version: 1, actions: [],
      latest_contributions: { author: null, challenger: null },
      initial_context: { status: 'MISSING', reason: 'NO_PROMPT' },
    },
    controversies: { availability: 'NOT_AVAILABLE', reason: 'LEGACY_RUN' },
    controversy_revision: `ctv-sha256:${'b'.repeat(64)}`,
    evidence: { availability: 'NOT_AVAILABLE', reason: 'LEGACY_RUN' },
    reconciliations: { availability: 'NOT_AVAILABLE', reason: 'LEGACY_RUN' },
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'CCR-20260404-001', execution_mode: 'NATIVE_V21_EXECUTION',
        title: 'Cloud Run vs GKE', created_at: STARTED,
        workspace_cwd: 'E:/prog/exemple',
        manifest_schema_version: 2, state_schema_version: 3, runtime_schema_version: 2,
      },
      experts: {
        author: { provider: 'claude', session_id: null, session_status: 'MISSING' },
        challenger: { provider: 'codex', session_id: null, session_status: 'MISSING' },
      },
      compatibility: {
        provider_aliases: {
          claude: { resolution: 'UNIQUE', expert_slot: 'author' },
          codex: { resolution: 'UNIQUE', expert_slot: 'challenger' },
        },
      },
      operational_state: {
        state: 'WAITING_AGENT', control: 'AUTOMATION', round: 0,
        next_step_source_slot: null, active_expert_slot: 'author',
        last_event_id: null, updated_at: STARTED,
        pending_operation: { kind: 'initialization', expert_slot: 'author', started_at: STARTED },
      },
      providers: null,
      recovery: {
        initialization: recoveryDomain(), step: recoveryDomain(),
        send: recoveryDomain(), handoff: recoveryDomain(),
      },
      operations: {
        step: { allowed: false, source_status: 'MISSING' },
        pause: { allowed: true, noop: false },
        resume: { allowed: true, noop: true },
        experts: {
          author: { send: { allowed: false }, handoff: { allowed: false, reason_code: 'HANDOFF_NOT_ALLOWED' } },
          challenger: { send: { allowed: false }, handoff: { allowed: false, reason_code: 'HANDOFF_NOT_ALLOWED' } },
        },
      },
      invocation_quota: { kind: 'NONE', consumed: 0, coverage: 'PRE_LEDGER' },
      usage: {
        coverage: 'PRE_LEDGER',
        invocations: { total: 0, provider_reported: { observed: 0, unobserved: 0, ambiguous: 0 } },
        providers: [], anomalies: { orphan_observations: [], duplicate_observations: [] },
      },
      cost_estimate: { coverage: 'PRE_LEDGER', pricing: { kind: 'NONE' }, by_invocation: [], providers: [] },
      counts: { events: 0 },
    },
  };
}

async function domView(handlers: Record<string, unknown> = {}): Promise<{
  dom: ReturnType<typeof createFakeDom>;
  view: View;
}> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  // Horloge injectée : la durée affichée est une soustraction, pas une mesure.
  const view = createDomView(dom.document, handlers, { now: () => NOW });
  return { dom, view };
}

// --------------------------------------------------------------------------
// A. Qui travaille, et depuis quand
// --------------------------------------------------------------------------

test('V5.1 — initialisation de l’auteur : le slot, le moteur, l’étape et la durée', async () => {
  const { dom, view } = await domView();
  view['showRunView']?.(runViewWithFlight({
    kind: 'initialization', expert_slot: 'author', provider: 'claude',
    started_at: STARTED, sequence: { position: 1, total: 2 },
  }));

  const text = textOf(dom, 'section-overview');
  assert.match(text, /Initialisation/);
  assert.match(text, /Auteur/, 'le rôle, pas seulement le moteur');
  assert.match(text, /Claude/i, 'le moteur réellement lié à ce slot');
  assert.match(text, /étape 1\/2/, 'la position, telle que le serveur l’a établie');
  assert.match(text, /depuis 9 s/, 'une durée observée, jamais estimée');
  // Ce que le run réel n'affichait pas : rien de tout cela.
  assert.equal(/op_[0-9a-f]/.test(text), false, 'aucun identifiant opaque à la place du sens');
});

test('V5.1 — initialisation du challenger : deuxième étape, autre moteur', async () => {
  const { dom, view } = await domView();
  view['showRunView']?.(runViewWithFlight({
    kind: 'initialization', expert_slot: 'challenger', provider: 'codex',
    started_at: STARTED, sequence: { position: 2, total: 2 },
  }));

  const text = textOf(dom, 'section-overview');
  assert.match(text, /Challenger/);
  assert.match(text, /Codex/i);
  assert.match(text, /étape 2\/2/);
  assert.match(text, /depuis 9 s/);
});

test('V5.1 — sans séquence connue, aucune étape n’est affichée', async () => {
  const { dom, view } = await domView();
  // Un transfert n'a pas de position : le serveur rend `null`, et l'écran se
  // tait plutôt que d'inventer « 1/2 ».
  view['showRunView']?.(runViewWithFlight({
    kind: 'step', expert_slot: 'challenger', provider: 'codex',
    started_at: STARTED, sequence: null,
  }));

  const text = inFlightText(dom);
  assert.match(text, /Transfert/);
  assert.match(text, /depuis 9 s/);
  assert.equal(/étape/.test(text), false, 'aucune position inventée côté client');
});

test('V5.1 — rien en vol : aucun bandeau, et surtout aucune barre vide', async () => {
  const { dom, view } = await domView();
  view['showRunView']?.(runViewWithFlight(null));

  // Pas de bandeau du tout — ni vide, ni « en attente », ni à zéro.
  assert.deepEqual(dom.find((node) => node.attributes['data-inflight'] !== undefined), []);
  assert.equal(inFlightText(dom), '');
});

test('V5.1 — aucune progression fabriquée : ni pourcentage, ni temps restant', async () => {
  const code = executableCode(await readFile(new URL('render.js', WEB), 'utf8'));
  // Garde de source, sur le code seul : la doctrine **cite** ces interdits dans
  // ses commentaires, et une garde naïve accuserait la phrase qui les interdit.
  for (const forbidden of ['temps restant', 'progress-bar', 'estimation', 'ETA(']) {
    assert.equal(code.includes(forbidden), false, `terme interdit : ${forbidden}`);
  }
  const { dom, view } = await domView();
  view['showRunView']?.(runViewWithFlight({
    kind: 'initialization', expert_slot: 'author', provider: 'claude',
    started_at: STARTED, sequence: { position: 1, total: 2 },
  }));
  // Une position n'est pas un pourcentage : « 1/2 » dit où l'on en est dans une
  // séquence connue, jamais quelle fraction du travail est faite.
  assert.equal(/%/.test(inFlightText(dom)), false, 'aucun pourcentage rendu');
});

test('V5.1 — la durée avance sans reconstruire l’écran', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  let clock = Date.parse(STARTED) + 1_000;
  const view = createDomView(dom.document, {}, { now: () => clock });

  view['showRunView']?.(runViewWithFlight({
    kind: 'initialization', expert_slot: 'author', provider: 'claude',
    started_at: STARTED, sequence: { position: 1, total: 2 },
  }));
  assert.match(textOf(dom, 'section-overview'), /depuis 1 s/);

  // Onze minutes et demie plus tard — la durée réelle de l'initialisation du
  // challenger sur le run `CCR-20260404-001`.
  clock = Date.parse(STARTED) + 690_000;
  view['tickElapsed']?.();
  assert.match(textOf(dom, 'section-overview'), /depuis 11 min 30 s/);
});

// --------------------------------------------------------------------------
// B. L'issue métier, à la place de « effectuée »
// --------------------------------------------------------------------------

test('V5.1 — une proposition refusée n’est plus annoncée comme effectuée', async () => {
  const { dom, view } = await domView();
  view['showMutationSucceeded']?.('RECONCILE_PROPOSE', {
    operation_id: 'op_a', status: 'SUCCEEDED',
    domain_outcome: {
      outcome: 'INVALID_OUTPUT', reason: 'OUTPUT_UNPARSABLE',
      detail: '$', invocation_id: 'inv_000003',
    },
  });

  const text = textOf(dom, 'run-status');
  assert.equal(/effectuée/.test(text), false, 'le mensonge du run réel');
  assert.match(text, /inexploitable/, 'la phrase du §18, en français');
  assert.match(text, /rien n’a été enregistré/);
  // Le code exact reste disponible — en détail, jamais à la place de la phrase.
  assert.match(text, /OUTPUT_UNPARSABLE/);
  assert.match(text, /inv_000003/, 'l’engagement reste référencé');
});

test('V5.1 — les cinq issues reçoivent cinq phrases distinctes', async () => {
  const outcomes = ['RECORDED', 'VALID_ZERO', 'INVALID_OUTPUT', 'REVALIDATION_REFUSED', 'PROVIDER_FAILED'];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    const { dom, view } = await domView();
    view['showMutationSucceeded']?.('RECONCILE_PROPOSE', {
      operation_id: 'op_a', status: 'SUCCEEDED', domain_outcome: { outcome },
    });
    const text = textOf(dom, 'run-status');
    assert.equal(/effectuée/.test(text), false, `${outcome} : jamais « effectuée »`);
    seen.add(text);
  }
  assert.equal(seen.size, 5, 'aucune issue n’est absorbée par une autre');
});

test('V5.1 — une opération sans issue métier garde son message d’origine', async () => {
  const { dom, view } = await domView();
  // Les mutations courtes ne rendent pas d'issue nommée : rien ne change pour
  // elles, et l'absence n'est pas traduite en refus.
  view['showMutationSucceeded']?.('PAUSE', { operation_id: 'op_b', status: 'SUCCEEDED' });
  assert.match(textOf(dom, 'run-status'), /effectuée/);
});

test('V5.1 — pendant l’appel, l’écran nomme l’expert et compte le temps', async () => {
  const { dom, view } = await domView();
  view['showMutationUndetermined']?.(
    'RECONCILE_PROPOSE',
    { operation_id: 'op_c', status: 'RUNNING', created_at: STARTED },
    { expertSlot: 'author', provider: 'claude' },
  );

  const text = textOf(dom, 'run-status');
  assert.match(text, /Demande de proposition/);
  assert.match(text, /Auteur/);
  assert.match(text, /Claude/i);
  assert.match(text, /en cours/, 'une durée qui avance ne dit pas à elle seule « en cours »');
  assert.match(text, /depuis 9 s/);
});

// --------------------------------------------------------------------------
// C. La fin arrive seule — suivi automatique, borné, en lecture seule
// --------------------------------------------------------------------------

interface Harness {
  cockpit: Record<string, (...args: unknown[]) => unknown> & { state: Record<string, unknown> };
  calls: { kind: string; args: unknown[] }[];
  gets: string[];
  writes: string[];
  drain(max?: number): Promise<number>;
}

async function cockpitHarness(receipts: Record<string, unknown>[]): Promise<Harness> {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => Harness['cockpit'];
  };
  const { calls, view } = recordingView();
  const gets: string[] = [];
  const writes: string[] = [];
  const queue: (() => void | Promise<void>)[] = [];
  let index = 0;

  const api = {
    getOperation: (operationId: string) => {
      gets.push(operationId);
      const receipt = receipts[Math.min(index, receipts.length - 1)];
      index += 1;
      return Promise.resolve(receipt);
    },
    reconcile: (...args: unknown[]) => {
      writes.push('POST reconcile');
      return Promise.resolve(args);
    },
    mutate: () => {
      writes.push('POST mutate');
      return Promise.resolve({});
    },
    createRun: () => {
      writes.push('POST createRun');
      return Promise.resolve({});
    },
    getRun: () => Promise.resolve(runViewWithFlight(null)),
    getNativeRun: () => Promise.resolve(runViewWithFlight(null)),
    listRuns: () => Promise.resolve({ runs: [] }),
    getTimeline: () => Promise.resolve({ entries: [], revision: 'sha256:aa' }),
  };

  const cockpit = createCockpit({
    api,
    view,
    scheduleCoalesced: (run: () => void) => queue.push(run),
    scheduleFollowUp: (run: () => void) => queue.push(run),
  });

  return {
    cockpit,
    calls,
    gets,
    writes,
    // Fait tourner le temps sans horloge : chaque battement est exécuté à la
    // main, et la boucle se réarme d'elle-même tant qu'elle n'a pas conclu.
    async drain(max = 60): Promise<number> {
      let ticks = 0;
      while (queue.length > 0 && ticks < max) {
        const next = queue.shift();
        if (next !== undefined) await next();
        ticks += 1;
      }
      return ticks;
    },
  };
}

test('V5.1 — le suivi s’arrête sur l’issue terminale, et recharge la vue autoritaire', async () => {
  const terminal = {
    operation_id: 'op_d', status: 'SUCCEEDED', created_at: STARTED,
    domain_outcome: { outcome: 'VALID_ZERO', invocation_id: 'inv_000004' },
  };
  const h = await cockpitHarness([
    { operation_id: 'op_d', status: 'RUNNING', created_at: STARTED },
    terminal,
  ]);

  h.cockpit.state['attempt'] = {
    action: 'RECONCILE_PROPOSE', runId: 'CCR-20260404-001',
    key: 'k1', operationId: 'op_d', payload: { expert_slot: 'challenger' },
  };
  h.cockpit.state['selectedRunId'] = 'CCR-20260404-001';

  // Un premier geste manuel amorce le suivi ; ensuite, plus personne ne clique.
  await h.cockpit['checkOperation']?.();
  const ticks = await h.drain();

  assert.ok(ticks > 0, 'la boucle a bien battu');
  assert.equal(h.cockpit.state['followUp'], null, 'le suivi s’est arrêté de lui-même');
  // La vérité est revenue du read model, pas d'une mise à jour optimiste.
  const kinds = h.calls.map((call) => call.kind);
  assert.ok(kinds.includes('showMutationSucceeded'), 'l’issue a été rendue sans clic');
  const rendered = h.calls.filter((call) => call.kind === 'showMutationSucceeded').at(-1);
  assert.equal(
    (rendered?.args[1] as { domain_outcome?: { outcome?: string } } | undefined)?.domain_outcome?.outcome,
    'VALID_ZERO',
    'l’issue exacte est parvenue jusqu’à la vue',
  );
});

test('V5.1 — le suivi n’émet que des lectures, et ne peut rien rejouer', async () => {
  const h = await cockpitHarness([
    { operation_id: 'op_e', status: 'RUNNING', created_at: STARTED },
    { operation_id: 'op_e', status: 'RUNNING', created_at: STARTED },
    { operation_id: 'op_e', status: 'SUCCEEDED', created_at: STARTED, domain_outcome: { outcome: 'RECORDED' } },
  ]);

  h.cockpit.state['attempt'] = {
    action: 'RECONCILE_PROPOSE', runId: 'CCR-20260404-001',
    key: 'k2', operationId: 'op_e', payload: { expert_slot: 'author' },
  };
  h.cockpit.state['selectedRunId'] = 'CCR-20260404-001';

  await h.cockpit['checkOperation']?.();
  await h.drain();

  // La propriété qui protège un quota réel : aucune écriture, jamais.
  assert.deepEqual(h.writes, [], 'aucun POST émis par le suivi');
  assert.ok(h.gets.length >= 2, 'plusieurs lectures, comme attendu d’un suivi');
  assert.deepEqual(new Set(h.gets), new Set(['op_e']), 'toujours la même opération');

  // Structurel : l'état de suivi ne contient rien avec quoi rejouer.
  const followUpKeys = Object.keys(
    (h.cockpit.state['followUp'] as Record<string, unknown> | null) ?? { kind: 0, operationId: 0, ticks: 0, errors: 0 },
  ).sort();
  assert.deepEqual(followUpKeys, ['errors', 'kind', 'operationId', 'ticks']);
});

test('V5.1 — sans ordonnanceur injecté, aucun suivi n’est installé', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => Harness['cockpit'];
  };
  const { view } = recordingView();
  const gets: string[] = [];
  const cockpit = createCockpit({
    api: {
      getOperation: (id: string) => {
        gets.push(id);
        return Promise.resolve({ operation_id: id, status: 'RUNNING', created_at: STARTED });
      },
      getRun: () => Promise.resolve(runViewWithFlight(null)),
      listRuns: () => Promise.resolve({ runs: [] }),
    },
    view,
  });

  cockpit.state['attempt'] = {
    action: 'RECONCILE_PROPOSE', runId: 'CCR-20260404-001', key: 'k3', operationId: 'op_f', payload: {},
  };
  await cockpit['checkOperation']?.();

  // Le comportement d'avant la réparation, à l'identique : une lecture, celle
  // que l'humain a demandée, et rien de plus.
  assert.deepEqual(gets, ['op_f']);
  assert.equal(cockpit.state['followUp'], null);
});

test('V5.1 — un reçu inconnu arrête le suivi : relire n’y changera rien', async () => {
  const h = await cockpitHarness([{ operation_id: 'op_g', status: 'UNKNOWN', created_at: STARTED }]);
  h.cockpit.state['attempt'] = {
    action: 'RECONCILE_PROPOSE', runId: 'CCR-20260404-001', key: 'k4', operationId: 'op_g', payload: {},
  };

  await h.cockpit['checkOperation']?.();
  await h.drain();

  assert.equal(h.cockpit.state['followUp'], null);
  const kinds = h.calls.map((call) => call.kind);
  assert.ok(kinds.includes('showMutationUndetermined'));
  assert.equal(kinds.includes('showMutationSucceeded'), false, 'un inconnu ne devient pas un succès');
});

test('V5.1 — le suivi renonce après trois lectures en échec, sans rien affirmer', async () => {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => Harness['cockpit'];
  };
  const { calls, view } = recordingView();
  const queue: (() => void | Promise<void>)[] = [];
  let reads = 0;
  const cockpit = createCockpit({
    api: {
      getOperation: (operationId: string) => {
        reads += 1;
        // La première lecture réussit — c'est elle qui arme le suivi. Toutes
        // les suivantes échouent, comme un serveur devenu injoignable.
        if (reads === 1) {
          return Promise.resolve({ operation_id: operationId, status: 'RUNNING', created_at: STARTED });
        }
        return Promise.reject(new Error('réseau'));
      },
      getRun: () => Promise.resolve(runViewWithFlight(null)),
      listRuns: () => Promise.resolve({ runs: [] }),
    },
    view,
    scheduleCoalesced: (run: () => void) => queue.push(run),
    scheduleFollowUp: (run: () => void) => queue.push(run),
  });

  cockpit.state['attempt'] = {
    action: 'RECONCILE_PROPOSE', runId: 'CCR-20260404-001', key: 'k5', operationId: 'op_h', payload: {},
  };
  await cockpit['checkOperation']?.();
  assert.notEqual(cockpit.state['followUp'], null, 'le suivi est bien armé');

  for (let guard = 0; guard < 200 && queue.length > 0; guard += 1) {
    const next = queue.shift();
    if (next !== undefined) await next();
  }

  assert.equal(cockpit.state['followUp'], null, 'le suivi a renoncé');
  // Une lecture réussie, puis trois échecs : le budget, et pas une de plus.
  assert.equal(reads, 4, `budget d’échecs respecté (${String(reads)} lectures)`);
  // Renoncer n'est pas conclure : aucune issue n'a été rendue.
  assert.equal(calls.some((call) => call.kind === 'showMutationSucceeded'), false);
});
