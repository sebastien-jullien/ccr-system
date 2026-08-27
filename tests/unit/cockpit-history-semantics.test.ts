/**
 * Historique lisible — sémantique de l'attribution humaine.
 *
 * Question de preuve :
 *
 * > **L'historique attribue-t-il un acte à un humain uniquement lorsque
 * > l'événement le dit, et jamais parce que quelque chose y ressemble ?**
 *
 * Quatre inférences sont interdites, et chacune a son test :
 *
 * ```text
 * recorded_by   ≠  origine sémantique
 * provider      ≠  origine sémantique
 * adjacence     ≠  causalité
 * chronologie   ≠  agentivité
 * ```
 *
 * Un événement écrit par CCR à la demande d'un humain porte `recorded_by: CCR`.
 * Un événement voisin d'un message humain reste ce qu'il est. Un événement plus
 * récent qu'un geste humain n'en découle pas. Aucune de ces trois proximités ne
 * fabrique une attribution.
 *
 * La cinquième propriété est symétrique et tout aussi nécessaire : un événement
 * qui SE DÉCLARE humain doit être lu comme tel. Perdre ce fait serait l'erreur
 * inverse, et un historique qui n'attribue jamais rien n'est pas plus vrai.
 *
 * Le rendu tourne sur le DOM factice, qui n'expose aucun sink HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

type View = Record<string, (...args: unknown[]) => void>;

const AT = '2026-08-23T09:15:00.000Z';

/**
 * Une entrée de chronologie native.
 *
 * `extra` permet d'ajouter des champs que la projection ne porte PAS — c'est
 * ainsi qu'on vérifie qu'ils ne sont pas lus.
 */
function entry(
  eventId: string,
  type: string,
  actor: string,
  provenance: Record<string, unknown> | null = null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'event',
    event_id: eventId,
    type,
    actor,
    timestamp: AT,
    round: 1,
    content: null,
    exit_code: null,
    based_on: [],
    reason: null,
    details: null,
    ...(provenance === null ? {} : { provenance }),
    ...extra,
  };
}

const session = (slot: string, provider: string): Record<string, unknown> => ({
  shape: 'EXPERT_SESSION', expert_slot_id: slot, provider, session_id: 'S1',
});

function runView(): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'d'.repeat(64)}`,
    presentation: {
      presentation_version: 1, actions: [],
      latest_contributions: { author: null, challenger: null },
      initial_context: { status: 'MISSING', reason: 'NO_PROMPT' },
    },
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'CCR-20260823-777', execution_mode: 'NATIVE_V21_EXECUTION', title: 'Historique',
        created_at: AT, workspace_cwd: 'E:/prog/x',
        manifest_schema_version: 2, state_schema_version: 3, runtime_schema_version: 2,
      },
      experts: {
        author: { provider: 'codex', session_id: 'S1', session_status: 'BOUND' },
        challenger: { provider: 'claude', session_id: 'S2', session_status: 'BOUND' },
      },
      compatibility: {
        provider_aliases: {
          claude: { resolution: 'UNIQUE', expert_slot: 'challenger' },
          codex: { resolution: 'UNIQUE', expert_slot: 'author' },
        },
      },
      operational_state: {
        state: 'READY', control: 'AUTOMATION', round: 1, next_step_source_slot: 'author',
        active_expert_slot: null, last_event_id: 'evt_000009',
        updated_at: AT, pending_operation: null,
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
        pause: { allowed: true, noop: false },
        resume: { allowed: false, reason_code: 'RUN_NOT_PAUSED' },
        experts: {
          author: { send: { allowed: false }, handoff: { allowed: false } },
          challenger: { send: { allowed: false }, handoff: { allowed: false } },
        },
      },
      invocation_quota: { kind: 'NONE', consumed: 0, coverage: 'PRE_LEDGER' },
      usage: {
        coverage: 'PRE_LEDGER',
        invocations: { total: 0, provider_reported: { observed: 0, unobserved: 0, ambiguous: 0 } },
        providers: [], anomalies: { orphan_observations: [], duplicate_observations: [] },
      },
      cost_estimate: { coverage: 'PRE_LEDGER', pricing: { kind: 'NONE' }, by_invocation: [], providers: [] },
      counts: { events: 9 },
    },
  };
}

/** Rend l'historique pour une liste d'entrées, et renvoie ses lignes. */
async function history(entries: readonly Record<string, unknown>[]): Promise<FakeNode[]> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  view['showRunView']?.(runView());
  view['showTimeline']?.(entries, { generation: 'NATIVE_V21_EXECUTION', total: entries.length });

  const root = dom.document.getElementById('section-timeline') as FakeNode;
  const found: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    if ((node.attributes['class'] ?? '').split(' ').includes('history-entry')) found.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return found;
}

/** Une ligne porte-t-elle la marque d'attribution humaine ? */
function marked(line: FakeNode): boolean {
  let found = false;
  const walk = (node: FakeNode): void => {
    if ((node.attributes['class'] ?? '').includes('is-human')) found = true;
    for (const child of node.children) walk(child);
  };
  walk(line);
  return found;
}

// ==========================================================================
// A. Ce que l'historique DOIT dire
// ==========================================================================

test('1 · un événement qui se déclare humain est attribué à un humain', async () => {
  const lines = await history([entry('evt_000001', 'human_message', 'human')]);
  assert.equal(lines.length, 1);
  assert.equal(marked(lines[0] as FakeNode), true);
  assert.match((lines[0] as FakeNode).textContent, /Message humain transmis/);
});

test('2 · un type humain par définition l’est même écrit par une catégorie', async () => {
  // `human_handoff_started` n'existe que parce qu'une personne a ouvert un
  // terminal. L'acteur écrit peut être `system` — le type, lui, est sans
  // ambiguïté.
  const lines = await history([entry('evt_000002', 'human_handoff_started', 'system')]);
  assert.equal(marked(lines[0] as FakeNode), true);
});

test('3 · chaque type reçoit sa phrase, depuis la table fermée', async () => {
  const labels = (await importWeb('labels.js')) as {
    historyLine: (type: string) => string;
  };
  assert.equal(labels.historyLine('round_completed'), 'Passage de témoin');
  assert.equal(labels.historyLine('assistant_response'), 'Réponse d’expert');
  assert.equal(labels.historyLine('run_paused'), 'Automatisation suspendue');
  // Un type inconnu est rendu TEL QUEL plutôt que masqué ou deviné.
  assert.equal(labels.historyLine('type_inconnu_du_futur'), 'type_inconnu_du_futur');
});

// ==========================================================================
// B. Les quatre inférences interdites
// ==========================================================================

test('4 · `recorded_by` ne fabrique aucune attribution, dans aucun sens', async () => {
  // (a) `recorded_by: HUMAN` sur un type qui n'est pas un acte humain, et dont
  //     l'acteur ne l'est pas non plus : l'historique n'attribue rien.
  const inflating = await history([
    entry('evt_000003', 'state_changed', 'system', null, { recorded_by: 'HUMAN' }),
  ]);
  assert.equal(marked(inflating[0] as FakeNode), false, 'recorded_by a fabriqué un humain');

  // (b) Symétrique : `recorded_by: CCR` sur un message humain. CCR écrit
  //     l'événement, un humain l'a produit — l'attribution reste.
  const deflating = await history([
    entry('evt_000004', 'human_message', 'human', null, { recorded_by: 'CCR' }),
  ]);
  assert.equal(marked(deflating[0] as FakeNode), true, 'recorded_by a effacé un humain');
});

test('5 · le fournisseur ne fabrique aucune attribution', async () => {
  // Une réponse d'expert reste une réponse d'expert, quel que soit le moteur —
  // et « claude » comme « codex » sont des attributs techniques, pas des
  // origines sémantiques.
  for (const provider of ['claude', 'codex']) {
    const lines = await history([
      entry('evt_000005', 'assistant_response', 'expert', session('author', provider)),
    ]);
    assert.equal(marked(lines[0] as FakeNode), false, `le moteur ${provider} a fabriqué un humain`);
    assert.match((lines[0] as FakeNode).textContent, /Réponse d’expert/);
  }
});

test('6 · l’adjacence ne propage aucune attribution', async () => {
  // Un message humain, puis trois événements machine qui le suivent
  // immédiatement. Aucun des trois n'hérite de son voisin.
  const lines = await history([
    entry('evt_000006', 'human_message', 'human'),
    entry('evt_000007', 'prompt_sent', 'system'),
    entry('evt_000008', 'assistant_response', 'expert', session('challenger', 'claude')),
    entry('evt_000009', 'round_completed', 'system'),
  ]);
  assert.equal(lines.length, 4);
  assert.equal(marked(lines[0] as FakeNode), true, 'le message humain');
  assert.equal(marked(lines[1] as FakeNode), false, 'le voisin immédiat n’hérite pas');
  assert.equal(marked(lines[2] as FakeNode), false);
  assert.equal(marked(lines[3] as FakeNode), false);
});

test('7 · la chronologie ne fabrique aucune attribution', async () => {
  // Même type, même acteur, deux positions et deux horodatages différents. Si
  // la position ou l'heure entrait dans la décision, les deux lignes
  // divergeraient. Elles ne doivent pas.
  const early = entry('evt_000010', 'run_paused', 'system');
  const late = { ...entry('evt_000011', 'run_paused', 'system'), timestamp: '2026-08-23T23:59:59.000Z' };
  const lines = await history([
    entry('evt_000009', 'human_message', 'human'),
    early,
    late,
  ]);
  assert.equal(marked(lines[1] as FakeNode), false, 'la suspension juste après le geste humain');
  assert.equal(marked(lines[2] as FakeNode), false, 'la suspension bien plus tard');
  // Et l'inverse : placer l'humain en dernier ne change rien non plus.
  const reversed = await history([early, late, entry('evt_000012', 'human_message', 'human')]);
  assert.equal(marked(reversed[0] as FakeNode), false);
  assert.equal(marked(reversed[1] as FakeNode), false);
  assert.equal(marked(reversed[2] as FakeNode), true);
});

test('8 · `prompt_sent` se lève sur l’acteur porté, jamais autrement', async () => {
  // Le seul type ambigu. L'initialisation l'écrit avec l'acteur humain et le
  // texte de l'humain ; un transfert l'écrit avec `system` et une enveloppe.
  const initial = await history([entry('evt_000013', 'prompt_sent', 'human')]);
  assert.equal(marked(initial[0] as FakeNode), true);
  const relay = await history([entry('evt_000014', 'prompt_sent', 'system')]);
  assert.equal(marked(relay[0] as FakeNode), false);
});

// ==========================================================================
// C. Ordre, identité et intégralité
// ==========================================================================

test('9 · l’ordre reçu est l’ordre rendu, sans tri ni round recalculé', async () => {
  const lines = await history([
    { ...entry('evt_000020', 'assistant_response', 'expert', session('author', 'codex')), round: 5 },
    { ...entry('evt_000021', 'assistant_response', 'expert', session('challenger', 'claude')), round: 2 },
  ]);
  assert.match((lines[0] as FakeNode).textContent, /evt_000020/);
  assert.match((lines[1] as FakeNode).textContent, /evt_000021/);
  // Les rounds sont rendus tels quels, y compris non monotones.
  assert.match((lines[0] as FakeNode).textContent, /Tour 5/);
  assert.match((lines[1] as FakeNode).textContent, /Tour 2/);
});

test('10 · le nom d’un expert vient de la provenance, jamais de l’acteur', async () => {
  // `actor: 'expert'` est une catégorie : elle ne dit pas QUEL expert. Sans
  // provenance, aucun nom n'est emprunté ailleurs pour combler le vide.
  const named = await history([
    entry('evt_000022', 'assistant_response', 'expert', session('challenger', 'claude')),
  ]);
  assert.match((named[0] as FakeNode).textContent, /Challenger/);

  const anonymous = await history([entry('evt_000023', 'assistant_response', 'expert', null)]);
  const text = (anonymous[0] as FakeNode).textContent;
  assert.equal(text.includes('Challenger'), false, 'un nom a été inventé');
  assert.equal(text.includes('Auteur'), false, 'un nom a été inventé');
  assert.match(text, /Réponse d’expert/, 'le fait connu reste dit');
});

test('11 · le journal brut reste intégralement accessible sous l’historique', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  view['showRunView']?.(runView());
  const entries = [entry('evt_000030', 'assistant_response', 'expert', session('author', 'codex'))];
  view['showTimeline']?.(entries, {
    generation: 'NATIVE_V21_EXECUTION',
    total: 1,
    revision: `sha256:${'e'.repeat(64)}`,
  });

  const root = dom.document.getElementById('section-timeline') as FakeNode;
  let raw: FakeNode | null = null;
  const walk = (node: FakeNode): void => {
    if (node.tagName === 'DETAILS') raw = node;
    for (const child of node.children) walk(child);
  };
  walk(root);
  assert.ok(raw !== null, 'le journal brut est présent');
  // Rien n'a été retiré : la révision, la génération et l'entrée y sont.
  assert.match((raw as FakeNode).textContent, /evt_000030/);
  assert.match((raw as FakeNode).textContent, /natif V2\.1/);
});

// ==========================================================================
// D. V-12 — repli des événements techniques, sans réordonnancement
// ==========================================================================

/** Rend l'historique et renvoie la liste ainsi que ses lignes. */
async function historyDom(entries: readonly Record<string, unknown>[]): Promise<{
  dom: ReturnType<typeof createFakeDom>;
  list: FakeNode;
  lines: FakeNode[];
}> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  view['showRunView']?.(runView());
  view['showTimeline']?.(entries, { generation: 'NATIVE_V21_EXECUTION', total: entries.length });

  const root = dom.document.getElementById('section-timeline') as FakeNode;
  let list: FakeNode | null = null;
  const lines: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    const cls = (node.attributes['class'] ?? '').split(' ');
    if (cls.includes('history')) list = node;
    if (cls.includes('history-entry')) lines.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  assert.ok(list !== null, 'la liste existe');
  return { dom, list: list as FakeNode, lines };
}

const isTechnical = (line: FakeNode): boolean =>
  (line.attributes['class'] ?? '').split(' ').includes('is-technical');

/** Le mélange canonique employé par les tests V-12. */
const MIXED = [
  entry('evt_000001', 'human_message', 'human'),
  entry('evt_000002', 'session_created', 'system', session('author', 'codex')),
  entry('evt_000003', 'assistant_response', 'expert', session('author', 'codex')),
  entry('evt_000004', 'round_started', 'system'),
  entry('evt_000005', 'assistant_response', 'expert', session('challenger', 'claude')),
];

test('V-12 · A — les événements techniques sont repliés par défaut', async () => {
  const { list, lines } = await historyDom(MIXED);

  // Toutes les entrées sont RENDUES — aucune n'est retirée de la liste.
  assert.equal(lines.length, 5, 'le journal reste entier dans le DOM');
  // Le repli est porté par la liste, et il est actif d'entrée de jeu.
  assert.equal(list.attributes['data-hide-technical'], '', 'repli inactif par défaut');
  // Et il vise exactement les entrées que la classification FERMÉE dit techniques.
  assert.deepEqual(lines.map(isTechnical), [false, true, false, true, false]);
});

test('V-12 · B — l’interrupteur existe, avec son compte', async () => {
  const { dom } = await historyDom(MIXED);
  const toggle = dom.document.getElementById('history-show-technical');
  assert.ok(toggle !== null, 'l’interrupteur est offert');
  const root = dom.document.getElementById('section-timeline') as FakeNode;
  assert.match(root.textContent, /Afficher les événements techniques \(2\)/);
  // Il ne promet pas de les supprimer : il dit qu'ils sont repliés.
  assert.match(root.textContent, /repliés, jamais retirés/);
});

test('V-12 · C — révéler ne réordonne rien : la chronologie est préservée', async () => {
  const { dom, list, lines } = await historyDom(MIXED);
  const ordreAvant = lines.map((l) => l.textContent);

  const toggle = dom.document.getElementById('history-show-technical') as FakeNode;
  (toggle as unknown as { checked: boolean }).checked = true;
  for (const fn of toggle.listeners['change'] ?? []) fn();

  // Le repli est levé…
  assert.equal(list.attributes['data-hide-technical'], undefined);
  // …et la liste est le MÊME nœud, avec les MÊMES enfants dans le MÊME ordre.
  const apres = list.children.map((l) => l.textContent);
  assert.deepEqual(apres, ordreAvant, 'la révélation a réordonné le journal');

  // Falsification directe : les techniques ne sont pas regroupés à la fin.
  const positions = list.children
    .map((l, i) => (isTechnical(l) ? i : -1))
    .filter((i) => i >= 0);
  assert.deepEqual(positions, [1, 3], 'les techniques ont quitté leur place');
});

test('V-12 · D — refermer le filtre ne réordonne rien non plus', async () => {
  const { dom, list } = await historyDom(MIXED);
  const toggle = dom.document.getElementById('history-show-technical') as FakeNode;
  const ordre = list.children.map((l) => l.textContent);

  for (const value of [true, false, true, false]) {
    (toggle as unknown as { checked: boolean }).checked = value;
    for (const fn of toggle.listeners['change'] ?? []) fn();
  }
  assert.deepEqual(list.children.map((l) => l.textContent), ordre);
});

test('V-12 · E — l’identifiant descend sous la divulgation', async () => {
  const { lines } = await historyDom(MIXED);
  const first = lines[0] as FakeNode;

  const disclosure = ((): FakeNode | null => {
    let found: FakeNode | null = null;
    const walk = (n: FakeNode): void => {
      if (n.tagName === 'DETAILS') found = n;
      for (const c of n.children) walk(c);
    };
    walk(first);
    return found;
  })();
  assert.ok(disclosure !== null, 'chaque entrée porte sa divulgation');
  assert.match((disclosure as FakeNode).textContent, /evt_000001/, 'l’identifiant reste consultable');

  // Le rang principal garde le tour, et perd l'identifiant.
  const line = first.children[1]?.children[0] as FakeNode;
  const sub = first.children[1]?.children[1] as FakeNode;
  assert.equal(`${line.textContent} ${sub.textContent}`.includes('evt_'), false);
  assert.match(sub.textContent, /Tour 1/);
});

test('V-12 · F — la visibilité suit la table fermée de l’Historique', async () => {
  // Cette garde affirmait auparavant une IDENTITÉ avec `classifyEntry`. Elle ne
  // passait que parce que sa fixture ne contenait aucun `run_created` — le seul
  // type sur lequel les deux règles divergent légitimement. Elle interroge
  // désormais la table qui décide réellement.
  const labels = (await importWeb('labels.js')) as {
    isHistoryTechnical: (type: string) => boolean;
  };
  const { lines } = await historyDom(MIXED);
  for (const [index, item] of MIXED.entries()) {
    assert.equal(isTechnical(lines[index] as FakeNode), labels.isHistoryTechnical(item['type'] as string),
      `divergence sur ${String(item['event_id'])}`);
  }
});

test('V-12 · G — l’attribution humaine est intacte sous le filtre', async () => {
  // Le repli ne touche à aucune règle sémantique : un message humain reste
  // attribué, un événement système ne le devient pas parce qu'il est masqué.
  const { lines } = await historyDom(MIXED);
  assert.equal(marked(lines[0] as FakeNode), true, 'le message humain');
  assert.equal(marked(lines[1] as FakeNode), false, 'la session ouverte');
  assert.equal(marked(lines[3] as FakeNode), false, 'le tour ouvert');
});

// ==========================================================================
// E. V-12 — visibilité par défaut : une table FERMÉE, indexée par TYPE
//
// L'Historique ne répond pas à la même question que le fil :
//
//   fil          « est-ce une contribution à la conversation ? »
//   Historique   « ce fait appartient-il au flux normal du run ? »
//
// `technicité conversationnelle ≠ visibilité par défaut de l'Historique`.
// ==========================================================================

test('V-12 · H — « Run créé » est visible par défaut', async () => {
  // Le défaut trouvé sur le ledger réel : la première entrée du run — sa
  // création — était repliée, parce que la règle réutilisée venait du fil, dont
  // le `default:` renvoie « technique » pour tout ce qui n'est pas une
  // contribution. La création d'un run appartient à son cycle de vie normal.
  const { list, lines } = await historyDom([
    entry('evt_000001', 'run_created', 'system'),
    entry('evt_000002', 'session_created', 'system', session('author', 'codex')),
  ]);
  assert.equal(isTechnical(lines[0] as FakeNode), false, '« Run créé » est replié');
  assert.match((lines[0] as FakeNode).textContent, /Run créé/);
  // Et la mécanique de session, elle, reste repliée.
  assert.equal(isTechnical(lines[1] as FakeNode), true);
  assert.equal(list.attributes['data-hide-technical'], '');
});

test('V-12 · I — la table est fermée, explicite et indexée par type', async () => {
  const labels = (await importWeb('labels.js')) as {
    isHistoryTechnical: (type: string) => boolean;
    HISTORY_TECHNICAL_TYPES: readonly string[];
  };

  // Exactement deux types repliés : ouverture de session native, ouverture de
  // tour. Le repli est l'exception, pas la règle.
  assert.deepEqual([...labels.HISTORY_TECHNICAL_TYPES].sort(), ['round_started', 'session_created']);

  // Les faits du flux normal restent visibles — y compris les issues sans
  // réponse, qu'il serait fautif de masquer.
  for (const type of [
    'run_created', 'prompt_sent', 'assistant_response', 'human_message',
    'human_handoff_started', 'human_handoff_finished', 'round_completed',
    'decision_recorded', 'process_failed', 'run_paused', 'run_resumed',
    'run_completed', 'runtime_config_changed', 'transfer_blocked',
    'transfer_uncertainty_acknowledged', 'send_uncertainty_acknowledged',
  ]) {
    assert.equal(labels.isHistoryTechnical(type), false, `${type} ne doit pas être replié`);
  }

  // Un type inconnu est VISIBLE : on n'escamote pas ce qu'on ne sait pas nommer.
  assert.equal(labels.isHistoryTechnical('type_inconnu_du_futur'), false);
});

test('V-12 · J — l’Historique et le fil sont DEUX règles, et divergent là où ils doivent', async () => {
  const conversation = (await importWeb('conversation.js')) as {
    classifyEntry: (entry: unknown) => string;
  };
  const labels = (await importWeb('labels.js')) as {
    isHistoryTechnical: (type: string) => boolean;
  };

  // Divergence VOULUE : le fil écarte « Run créé » — ce n'est pas une
  // contribution — mais l'Historique le montre.
  assert.equal(conversation.classifyEntry({ type: 'run_created', actor: 'system' }), 'TECHNICAL_ONLY');
  assert.equal(labels.isHistoryTechnical('run_created'), false);

  // Accord là où les deux disent la même chose.
  assert.equal(conversation.classifyEntry({ type: 'session_created', actor: 'system' }), 'TECHNICAL_ONLY');
  assert.equal(labels.isHistoryTechnical('session_created'), true);

  // Et le fil n'a pas changé : sa classification reste celle qui était testée.
  assert.equal(conversation.classifyEntry({ type: 'assistant_response', actor: 'expert' }), 'VISIBLE_CONTRIBUTION');
  assert.equal(conversation.classifyEntry({ type: 'prompt_sent', actor: 'human' }), 'INITIAL_CONTEXT');
});

test('V-12 · K — ordre A / T / B : jamais A, B, T', async () => {
  const { dom, list, lines } = await historyDom([
    entry('evt_A', 'assistant_response', 'expert', session('author', 'codex')),
    entry('evt_T', 'round_started', 'system'),
    entry('evt_B', 'assistant_response', 'expert', session('challenger', 'claude')),
  ]);

  const ids = (nodes: readonly FakeNode[]): string[] =>
    nodes.map((n) => {
      const found = /evt_[A-Z]/.exec(n.textContent);
      return found === null ? '?' : found[0];
    });

  // Par défaut : A et B visibles, T replié — mais T est TOUJOURS dans la liste.
  assert.deepEqual(ids(lines), ['evt_A', 'evt_T', 'evt_B']);
  assert.deepEqual(lines.map(isTechnical), [false, true, false]);

  // Révélation : la position exacte de T est conservée.
  const toggle = dom.document.getElementById('history-show-technical') as FakeNode;
  (toggle as unknown as { checked: boolean }).checked = true;
  for (const fn of toggle.listeners['change'] ?? []) fn();

  const apres = ids(list.children);
  assert.deepEqual(apres, ['evt_A', 'evt_T', 'evt_B']);
  assert.notDeepEqual(apres, ['evt_A', 'evt_B', 'evt_T'], 'les techniques ont été rejetés à la fin');
});

test('V-12 · L — à type constant, rien d’autre ne change la visibilité', async () => {
  // Falsification directe de §4 : on fait varier TOUT sauf le type canonique.
  // Si la visibilité bougeait, c'est qu'une inférence se serait glissée.
  const variantes = [
    entry('evt_v1', 'session_created', 'system', session('author', 'codex')),
    entry('evt_v2', 'session_created', 'human', session('challenger', 'claude'), { recorded_by: 'HUMAN' }),
    { ...entry('evt_v3', 'session_created', 'expert', session('author', 'claude')),
      timestamp: '2026-12-31T23:59:59.000Z', content: 'un texte quelconque' },
  ];
  const { lines } = await historyDom(variantes);
  assert.deepEqual(lines.map(isTechnical), [true, true, true], 'la visibilité a suivi autre chose que le type');

  // Symétrique : un type visible le reste, quels que soient ses autres champs.
  const visibles = await historyDom([
    entry('evt_w1', 'run_created', 'system'),
    entry('evt_w2', 'run_created', 'human', null, { recorded_by: 'CCR', provider: 'claude' }),
    { ...entry('evt_w3', 'run_created', 'expert'), timestamp: '2020-01-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(visibles.lines.map(isTechnical), [false, false, false]);

  // Et le voisinage n'y change rien non plus : même type, deux entourages.
  const entoure = await historyDom([
    entry('evt_x1', 'human_message', 'human'),
    entry('evt_x2', 'session_created', 'system', session('author', 'codex')),
    entry('evt_x3', 'run_created', 'system'),
  ]);
  assert.deepEqual(entoure.lines.map(isTechnical), [false, true, false]);
});

test('VIS-02 · le compteur dit ce qui est RÉELLEMENT visible', async () => {
  // Le compteur annonçait `entries.length` sur `page.total` — « 11 sur 11 » —
  // alors que trois entrées étaient repliées juste au-dessus. Il dérive
  // désormais de ce qui est effectivement rendu, et nomme ce qui ne l'est pas.
  const { dom } = await historyDom(MIXED);
  const counter = dom.document.getElementById('history-count') as FakeNode;
  assert.ok(counter !== null, 'le compteur existe');

  // Chaque lecture est capturée dans une constante : asserter deux fois sur la
  // MÊME expression la restreindrait successivement à deux littéraux
  // incompatibles, dont l'intersection est `never`.
  //
  // MIXED : 5 entrées, dont 2 techniques (session_created, round_started).
  const replie = counter.textContent;
  assert.equal(replie, '3 entrées affichées sur 5 · 2 événements techniques masqués.',
    'le compteur doit être exact au caractère près — un nombre dupliqué passait les regex partielles');

  // Révélation : le compteur suit, et le total ne bouge pas.
  const toggle = dom.document.getElementById('history-show-technical') as FakeNode;
  (toggle as unknown as { checked: boolean }).checked = true;
  for (const fn of toggle.listeners['change'] ?? []) fn();
  const revele = counter.textContent;
  assert.equal(revele, '5 entrées affichées sur 5.');
  assert.equal(revele.includes('masqué'), false, 'plus rien n’est masqué');

  // Et il revient exactement quand on referme.
  (toggle as unknown as { checked: boolean }).checked = false;
  for (const fn of toggle.listeners['change'] ?? []) fn();
  assert.equal(counter.textContent, '3 entrées affichées sur 5 · 2 événements techniques masqués.');
});

test('VIS-02 · sans aucun événement technique, le compteur ne parle pas de masquage', async () => {
  const { dom } = await historyDom([
    entry('evt_000001', 'run_created', 'system'),
    entry('evt_000002', 'assistant_response', 'expert', session('author', 'codex')),
  ]);
  const counter = dom.document.getElementById('history-count') as FakeNode;
  assert.equal(counter.textContent, '2 entrées affichées sur 2.');
  assert.equal(counter.textContent.includes('masqué'), false);
  // Et aucun interrupteur n'est offert : il n'y aurait rien à révéler.
  assert.equal(dom.document.getElementById('history-show-technical'), null);
});

test('VIS-02 · le singulier est respecté', async () => {
  const { dom } = await historyDom([
    entry('evt_000001', 'run_created', 'system'),
    entry('evt_000002', 'session_created', 'system', session('author', 'codex')),
  ]);
  const counter = dom.document.getElementById('history-count') as FakeNode;
  assert.equal(counter.textContent, '1 entrée affichée sur 2 · 1 événement technique masqué.');
});
