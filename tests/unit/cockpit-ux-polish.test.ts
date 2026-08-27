/**
 * V5.1 — les difficultés UX réellement observées, et leur levée.
 *
 * Question de preuve :
 *
 * > **Un humain peut-il porter une controverse, verser une preuve et lire une
 * > vraie proposition sans recopier un seul identifiant — et sans qu'une
 * > session expirée ne rejoue son geste ?**
 *
 * Quatre observations réelles motivent ce fichier, toutes datées du run
 * `CCR-20260404-001` :
 *
 *  1. les `evt_…` étaient recopiés à la main depuis la chronologie ;
 *  2. le `ctve_…` cible l'était aussi ;
 *  3. un `401` après redémarrage du cockpit n'a rien dit ;
 *  4. une proposition réelle porte six options, illisibles en liste plate.
 *
 * Aucune sémantique métier ne change ici : les mêmes champs partent vers les
 * mêmes services, et l'autorité reste au backend.
 *
 * ```text
 * REAL_PROVIDER_CALLS = 0
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);

const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

type View = Record<string, (...args: unknown[]) => unknown>;

function findAll(root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    if (predicate(node)) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

const hasClass = (node: FakeNode, name: string): boolean =>
  (node.attributes['class'] ?? '').split(' ').includes(name);

const INFRA =
  'Le premier point conditionne tout le reste : si le CPU est throttlé, six traitements '
  + 'de fond sont silencieusement à l’arrêt en production.';
const APPLI =
  'Le défaut le plus important est applicatif, pas infrastructurel : absence de bail et '
  + 'de reprise des jobs restés running.';
const STATEMENT = 'Les deux experts divergent sur la nature du défaut principal à traiter en priorité.';

function timelineEntry(
  eventId: string,
  type: string,
  content: string | null,
  provenance: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    kind: 'event',
    event_id: eventId,
    type,
    actor: 'expert',
    timestamp: '2026-08-21T02:36:19.448Z',
    round: 0,
    ...(content === null ? {} : { content }),
    ...(provenance === null ? {} : { provenance }),
  };
}

/** Enveloppe interne : du contenu, mais pas une contribution. */
const ENVELOPE = 'Contexte transmis automatiquement au challenger.';

const TIMELINE = [
  timelineEntry('evt_000001', 'run_created', null, { shape: 'GENERATION_NEUTRAL' }),
  timelineEntry('evt_000003', 'assistant_response', INFRA, {
    shape: 'EXPERT_SESSION', expert_slot_id: 'author', provider: 'claude', session_id: 'S1',
  }),
  timelineEntry('evt_000004', 'session_created', null, {
    shape: 'EXPERT_SESSION', expert_slot_id: 'author', provider: 'claude', session_id: 'S1',
  }),
  timelineEntry('evt_000006', 'assistant_response', APPLI, {
    shape: 'EXPERT_SESSION', expert_slot_id: 'challenger', provider: 'codex', session_id: 'S2',
  }),
  // Enveloppe de transport : elle PORTE du contenu, elle est donc sélectionnable
  // — et c'est précisément ce qui noyait le sélecteur avant le filtre.
  { ...timelineEntry('evt_000007', 'prompt_sent', ENVELOPE, {
    shape: 'EXPERT_TARGET', target_expert_slot_id: 'challenger', provider: 'codex', session_id: null,
  }), actor: 'system' },
];

function controversyProjection(): Record<string, unknown> {
  const opening = {
    schema_version: 1, entry_id: 'ctve_000001', controversy_id: 'ctv_000001',
    kind: 'CONTROVERSY_RECORDED', semantic_origin: { kind: 'HUMAN' }, recorded_by: 'HUMAN',
    recorded_at: '2026-08-21T02:52:30.478Z', round: 0, content: STATEMENT,
    anchors: { provenance: [{ event_id: 'evt_000003', round: 0 }, { event_id: 'evt_000006', round: 0 }] },
  };
  return {
    read_model_version: 1, availability: 'AVAILABLE', recorded_count: 1,
    items: [{ controversy_id: 'ctv_000001', opening, entries: [opening], authority_entries: [], unresolvable_anchors: [] }],
  };
}

function evidenceProjection(): Record<string, unknown> {
  return {
    read_model_version: 1, availability: 'AVAILABLE',
    recorded_material_count: 1, recorded_adduction_count: 0,
    evidence_revision: `ev-sha256:${'c'.repeat(64)}`,
    materials: [{
      entry: {
        schema_version: 1, entry_id: 'mat_000001', kind: 'MATERIAL_RECORDED', recorded_by: 'CCR',
        recorded_at: '2026-08-21T09:40:00.000Z', submitted_by: 'HUMAN', observed_by_ccr: true,
        representation: { form: 'RUN_EVENT', event_id: 'evt_000003' },
      },
      verifiability: { kind: 'VERIFIABLE' },
    }],
    adductions: [],
  };
}

function proposalWithOptions(count: number): Record<string, unknown> {
  const options = [];
  for (let index = 1; index <= count; index += 1) {
    options.push({
      option_id: `opt_00000${String(index)}`,
      content: `Reformulation numéro ${String(index)} — elle articule les deux positions sans les trancher.`,
    });
  }
  return { entry_id: 'rcn_000001', scope_kind: 'SUBSET', scope: ['ctve_000001'], options };
}

function reconciliationProjection(proposals: readonly unknown[]): Record<string, unknown> {
  return {
    read_model_version: 1, availability: 'AVAILABLE', recorded_count: proposals.length,
    reconciliation_revision: `rcn-sha256:${'d'.repeat(64)}`,
    items: [{
      controversy_id: 'ctv_000001',
      proposals, responses: [], recorded_acts: [],
      decision_currentness: [], closure_currentness: [],
      disagreement_view: [], detections: [],
      closure_declarations: [], closure_withdrawal_declarations: [], supersession_relations: [],
    }],
  };
}

function recoveryDomain(): Record<string, unknown> {
  return { status: 'NONE', available_actions: [], conflicts: [] };
}

function runView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'a'.repeat(64)}`,
    in_flight: null,
    presentation: {
      presentation_version: 1, actions: [],
      latest_contributions: { author: null, challenger: null },
      initial_context: { status: 'MISSING', reason: 'NO_PROMPT' },
    },
    controversies: controversyProjection(),
    controversy_revision: `ctv-sha256:${'b'.repeat(64)}`,
    evidence: evidenceProjection(),
    reconciliations: reconciliationProjection([]),
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'CCR-20260404-001', execution_mode: 'NATIVE_V21_EXECUTION', title: 'Cloud Run vs GKE',
        created_at: '2026-08-21T02:29:10.000Z', workspace_cwd: 'E:/prog/x',
        manifest_schema_version: 2, state_schema_version: 3, runtime_schema_version: 2,
      },
      experts: {
        author: { provider: 'claude', session_id: 'S1', session_status: 'BOUND' },
        challenger: { provider: 'codex', session_id: 'S2', session_status: 'BOUND' },
      },
      compatibility: {
        provider_aliases: {
          claude: { resolution: 'UNIQUE', expert_slot: 'author' },
          codex: { resolution: 'UNIQUE', expert_slot: 'challenger' },
        },
      },
      operational_state: {
        state: 'READY', control: 'AUTOMATION', round: 0, next_step_source_slot: 'author',
        active_expert_slot: null, last_event_id: 'evt_000007',
        updated_at: '2026-08-21T02:48:04.000Z', pending_operation: null,
      },
      providers: null,
      recovery: {
        initialization: recoveryDomain(), step: recoveryDomain(),
        send: recoveryDomain(), handoff: recoveryDomain(),
      },
      operations: {
        step: { allowed: false, source_status: 'MISSING' },
        pause: { allowed: true, noop: false }, resume: { allowed: true, noop: true },
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
      counts: { events: 7 },
    },
    ...overrides,
  };
}

interface Harness {
  dom: ReturnType<typeof createFakeDom>;
  view: View;
  emitted: { kind: string; payload: unknown }[];
}

async function harness(withTimeline = true): Promise<Harness> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const emitted: { kind: string; payload: unknown }[] = [];
  const view = createDomView(dom.document, {
    onRecordControversy: (payload: unknown) => emitted.push({ kind: 'CONTROVERSY', payload }),
    onAdduceMaterial: (payload: unknown) => emitted.push({ kind: 'ADDUCE', payload }),
    onRegisterMaterial: (payload: unknown) => emitted.push({ kind: 'MATERIAL', payload }),
    onReconcile: (payload: unknown) => emitted.push({ kind: 'RECONCILE', payload }),
  }, { now: () => Date.parse('2026-08-21T03:00:00.000Z') });

  view['showRunView']?.(runView());
  if (withTimeline) {
    view['showTimeline']?.(TIMELINE, { generation: 'NATIVE_V21_EXECUTION', total: TIMELINE.length });
  }
  return { dom, view, emitted };
}

const runtimeRoot = (h: Harness): FakeNode => h.dom.document.getElementById('section-runtime') as FakeNode;
/** Faits techniques du run : ils vivent sous « État & reprise », pas au Dossier. */
const runFactsRoot = (h: Harness): FakeNode => h.dom.document.getElementById('run-facts') as FakeNode;

// --------------------------------------------------------------------------
// A. V3 — choisir des échanges, pas recopier des identifiants
// --------------------------------------------------------------------------

test('V5.1 UX — les échanges sont proposés, avec rôle, moteur et extrait', async () => {
  const h = await harness();
  const rows = findAll(runtimeRoot(h), (n) => hasClass(n, 'event-choice-row'));
  assert.equal(rows.length, 2, 'les deux réponses d’expert, et elles seules');

  const text = rows.map((row) => row.textContent).join(' | ');
  // V-07 · rang primaire : le rôle, le tour et l'extrait humain.
  assert.match(text, /AUTEUR/);
  assert.match(text, /CHALLENGER/);
  assert.match(text, /Tour 0/);
  assert.match(text, /throttlé/, 'un extrait lisible de la position');
  assert.match(text, /applicatif/);

  // V-07 · rang secondaire : identifiant, type et moteur descendent sous la
  // divulgation. Rien n'est retiré — la provenance reste consultable.
  for (const row of rows) {
    const disclosure = findAll(row, (n) => n.tagName === 'DETAILS')[0];
    assert.ok(disclosure !== undefined, 'chaque échange porte sa divulgation');
    assert.match(disclosure.textContent, /Détails techniques/);
  }
  const disclosed = rows
    .map((row) => findAll(row, (n) => n.tagName === 'DETAILS')[0]?.textContent ?? '')
    .join(' | ');
  assert.match(disclosed, /evt_000003/);
  assert.match(disclosed, /evt_000006/);
  assert.match(disclosed, /Claude/i, 'le moteur reste lisible, au second rang');
  assert.match(disclosed, /Codex/i);

  // Et l'identifiant n'occupe plus le rang primaire.
  const primary = rows
    .map((row) => {
      const head = findAll(row, (n) => hasClass(n, 'event-choice-head'))[0];
      const excerpt = findAll(row, (n) => hasClass(n, 'event-excerpt'))[0];
      return `${head?.textContent ?? ''} ${excerpt?.textContent ?? ''}`;
    })
    .join(' | ');
  assert.equal(/evt_/.test(primary), false, `identifiant au premier rang : ${primary}`);
});

test('V5.1 UX — plus aucun champ de saisie d’identifiants d’événements', async () => {
  const h = await harness();
  const inputs = findAll(runtimeRoot(h), (n) => n.tagName === 'INPUT' && n.attributes['type'] === 'text');
  const placeholders = inputs.map((n) => n.attributes['placeholder'] ?? '');
  for (const placeholder of placeholders) {
    assert.equal(/evt_/.test(placeholder), false, `saisie manuelle résiduelle : ${placeholder}`);
  }
  assert.equal(findAll(runtimeRoot(h), (n) => hasClass(n, 'controversy-events')).length, 0);
});

test('V5.1 UX — un événement sans contenu n’est pas proposé', async () => {
  const h = await harness();
  const text = findAll(runtimeRoot(h), (n) => hasClass(n, 'event-picker'))
    .map((n) => n.textContent).join(' ');
  assert.equal(text.includes('evt_000001'), false, 'run_created : rien à juger');
  assert.equal(text.includes('evt_000004'), false, 'session_created : rien à juger');
});

test('V5.1 UX — rien n’est pré-coché, et aucune détection n’est appelée', async () => {
  const h = await harness();
  const boxes = findAll(runtimeRoot(h), (n) => hasClass(n, 'event-choice'));
  assert.equal(boxes.length, 2);
  for (const box of boxes) {
    assert.notEqual(box.attributes['checked'], '', 'aucune présélection');
    assert.equal((box as unknown as { checked?: boolean }).checked === true, false);
  }
  assert.deepEqual(h.emitted, [], 'aucun geste émis par le seul affichage');
});

test('V5.1 UX — cocher deux échanges émet exactement leurs deux identifiants', async () => {
  const h = await harness();
  const boxes = findAll(runtimeRoot(h), (n) => hasClass(n, 'event-choice'));
  for (const box of boxes) (box as unknown as { checked: boolean }).checked = true;

  const statement = findAll(runtimeRoot(h), (n) => hasClass(n, 'controversy-statement-input'))[0];
  assert.ok(statement);
  (statement as unknown as { value: string }).value = STATEMENT;

  const button = findAll(runtimeRoot(h), (n) => n.attributes['data-controversy'] === 'RECORD')[0];
  assert.ok(button);
  button.click();

  assert.equal(h.emitted.length, 1);
  const payload = h.emitted[0]?.payload as { eventIds: string[]; statement: string };
  // Ordre du serveur, exactement les deux cochés, et le motif intact.
  assert.deepEqual(payload.eventIds, ['evt_000003', 'evt_000006']);
  assert.equal(payload.statement, STATEMENT);
});

test('V5.1 UX — un seul échange coché n’en émet qu’un', async () => {
  const h = await harness();
  const boxes = findAll(runtimeRoot(h), (n) => hasClass(n, 'event-choice'));
  (boxes[1] as unknown as { checked: boolean }).checked = true;
  const statement = findAll(runtimeRoot(h), (n) => hasClass(n, 'controversy-statement-input'))[0];
  (statement as unknown as { value: string }).value = 'un motif';
  findAll(runtimeRoot(h), (n) => n.attributes['data-controversy'] === 'RECORD')[0]?.click();

  const payload = h.emitted[0]?.payload as { eventIds: string[] };
  assert.deepEqual(payload.eventIds, ['evt_000006']);
});

test('V5.1 UX — sans chronologie, le sélecteur le dit au lieu de mentir', async () => {
  const h = await harness(false);
  const picker = findAll(runtimeRoot(h), (n) => hasClass(n, 'event-picker'))[0];
  assert.ok(picker);
  assert.match(picker.textContent, /Conversation/);
  assert.equal(findAll(picker, (n) => hasClass(n, 'event-choice')).length, 0);
});

// --------------------------------------------------------------------------
// A-bis. Le filtre technique — moins de bruit, jamais moins de choix
// --------------------------------------------------------------------------

/** Les cases d'échange, sans l'interrupteur de filtre. */
const choiceBoxes = (h: Harness): FakeNode[] =>
  findAll(runtimeRoot(h), (n) => hasClass(n, 'event-choice'));

const filterToggle = (h: Harness): FakeNode =>
  findAll(runtimeRoot(h), (n) => hasClass(n, 'event-filter'))[0] as FakeNode;

const setChecked = (node: FakeNode, value: boolean): void => {
  (node as unknown as { checked: boolean }).checked = value;
};

/** Bascule réellement le filtre, comme le ferait un clic. */
const toggleFilter = (h: Harness, value: boolean): void => {
  const toggle = filterToggle(h);
  setChecked(toggle, value);
  for (const fn of toggle.listeners['change'] ?? []) fn();
};

const pickerText = (h: Harness): string =>
  (findAll(runtimeRoot(h), (n) => hasClass(n, 'event-picker'))[0] as FakeNode).textContent;

test('LOT B — par défaut, les enveloppes techniques ne sont pas proposées', async () => {
  const h = await harness();

  // Les deux contributions sont là ; l'enveloppe de transport ne l'est pas.
  assert.equal(choiceBoxes(h).length, 2);
  assert.match(pickerText(h), /throttlé/);
  assert.equal(pickerText(h).includes('Contexte transmis automatiquement'), false);

  // Et elle n'est pas escamotée : son existence est annoncée, avec son compte.
  assert.match(pickerText(h), /Afficher les événements techniques \(1\)/);
});

test('LOT B — l’interrupteur les ajoute, sans rien retirer', async () => {
  const h = await harness();
  toggleFilter(h, true);

  assert.equal(choiceBoxes(h).length, 3, 'les trois événements porteurs de contenu');
  assert.match(pickerText(h), /Contexte transmis automatiquement/);
  // Les contributions ne disparaissent pas au passage.
  assert.match(pickerText(h), /throttlé/);
  assert.match(pickerText(h), /applicatif/);
});

test('LOT B — le fil et le sélecteur classent le MÊME événement pareil', async () => {
  // Falsification : deux tables de classification finiraient par diverger, et
  // un événement serait « une contribution » ici et « du transport » là. Les
  // deux écrans sont donc interrogés sur les mêmes entrées, dans le même DOM.
  const h = await harness();
  const conversation = (h.dom.document.getElementById('section-overview') as FakeNode).textContent;

  // L'enveloppe : absente des deux.
  assert.equal(conversation.includes('Contexte transmis automatiquement'), false, 'le fil l’écarte');
  assert.equal(pickerText(h).includes('Contexte transmis automatiquement'), false, 'le sélecteur aussi');
  // Et le fil la compte comme technique plutôt que de la perdre.
  assert.match(conversation, /1 événement technique/);

  // Une contribution : présente dans les deux.
  assert.match(conversation, /throttlé/);
  assert.match(pickerText(h), /throttlé/);
});

test('LOT B — un choix masqué reste enregistré, et l’écran le dit', async () => {
  const h = await harness();
  // Afficher les techniques, cocher l'enveloppe, puis les remasquer.
  toggleFilter(h, true);

  const envelope = choiceBoxes(h).find((box) => box.attributes['value'] === 'evt_000007');
  assert.ok(envelope !== undefined, 'l’enveloppe est proposée quand le filtre est ouvert');
  setChecked(envelope, true);

  toggleFilter(h, false);

  // Elle n'est plus affichée…
  assert.equal(choiceBoxes(h).length, 2);
  // …mais l'écran ne laisse pas croire qu'elle a été désélectionnée…
  assert.match(pickerText(h), /1 événement technique sélectionné/);

  // …et elle part réellement dans l'enregistrement, à sa place chronologique.
  const statement = findAll(runtimeRoot(h), (n) => hasClass(n, 'controversy-statement-input'))[0];
  (statement as unknown as { value: string }).value = 'un motif';
  setChecked(choiceBoxes(h)[0] as FakeNode, true);
  findAll(runtimeRoot(h), (n) => n.attributes['data-controversy'] === 'RECORD')[0]?.click();

  const payload = h.emitted[0]?.payload as { eventIds: string[] };
  assert.deepEqual(payload.eventIds, ['evt_000003', 'evt_000007'], 'ordre du serveur, rien de perdu');
});

test('LOT B — décocher pendant que la case est visible désélectionne bien', async () => {
  // Le pendant du test précédent : la sélection durable ne doit pas devenir une
  // sélection collante dont on ne peut plus sortir.
  const h = await harness();
  const boxes = choiceBoxes(h);
  setChecked(boxes[0] as FakeNode, true);
  setChecked(boxes[1] as FakeNode, true);

  toggleFilter(h, true);
  // Après reconstruction, les deux contributions restent cochées.
  const afterOpen = choiceBoxes(h);
  assert.equal((afterOpen[0] as unknown as { checked?: boolean }).checked, true);
  assert.equal((afterOpen[1] as unknown as { checked?: boolean }).checked, true);

  // On en décoche une, puis on remasque.
  setChecked(choiceBoxes(h)[1] as FakeNode, false);
  toggleFilter(h, false);

  const statement = findAll(runtimeRoot(h), (n) => hasClass(n, 'controversy-statement-input'))[0];
  (statement as unknown as { value: string }).value = 'un motif';
  findAll(runtimeRoot(h), (n) => n.attributes['data-controversy'] === 'RECORD')[0]?.click();
  const payload = h.emitted[0]?.payload as { eventIds: string[] };
  assert.deepEqual(payload.eventIds, ['evt_000003']);
});

// --------------------------------------------------------------------------
// A-ter. Garde de feuille de style — la direction d'un conteneur flex
// --------------------------------------------------------------------------

test('LOT A — `.cards.compact` déclare sa direction, sinon la base impose une colonne', async () => {
  // Défaut observé au navigateur, invisible au DOM factice qui n'a pas de
  // moteur de mise en page :
  //
  //   .cards          { display: flex; flex-direction: column; }
  //   .cards.compact  { display: flex; flex-wrap: wrap; }        ← hérite column
  //   .cards.compact .card { flex: 1 1 20rem; }                  ← 20rem de HAUT
  //
  // Dans une colonne, `flex-basis` s'applique à la hauteur : chaque carte de
  // contrôle mesurait 320 px, quel que soit son contenu. Une carte à deux
  // lignes occupait la surface d'un formulaire.
  //
  // Cette garde tient tant que `.cards` reste une colonne ET que
  // `.cards.compact` porte un `flex-basis` sur ses enfants.
  const css = await readFile(new URL('styles.css', WEB), 'utf8');

  const base = /\.cards\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  const compact = /\.cards\.compact\s*\{[^}]*flex-wrap[^}]*\}/.exec(css)?.[0] ?? '';
  assert.ok(base.length > 0, 'la règle .cards est trouvable');
  assert.ok(compact.length > 0, 'la règle .cards.compact est trouvable');

  if (base.includes('flex-direction: column')) {
    assert.match(
      compact,
      /flex-direction:\s*row/,
      '.cards.compact hérite d’une colonne : `flex: 1 1 20rem` y fixerait la HAUTEUR des cartes',
    );
  }

  // Et les cartes ne s'étirent pas à la hauteur de leur voisine.
  assert.match(css, /\.cards\.compact\s*\{[^}]*align-items:\s*flex-start/);
});

// --------------------------------------------------------------------------
// B. V4 — choisir une unité, pas recopier un ctve_
// --------------------------------------------------------------------------

test('V5.1 UX — la cible V4 est un choix d’unités, énoncé d’abord', async () => {
  const h = await harness();
  const target = findAll(runtimeRoot(h), (n) => hasClass(n, 'evidence-target'))[0];
  assert.ok(target, 'le sélecteur de cible existe');
  assert.equal(target.tagName, 'SELECT', 'ce n’est plus une saisie libre');

  const options = findAll(target, (n) => n.tagName === 'OPTION');
  assert.equal(options.length, 1);
  assert.equal(options[0]?.attributes['value'], 'ctve_000001', 'la valeur envoyée reste l’identifiant');
  assert.match(options[0]?.textContent ?? '', /divergent sur la nature du défaut/, 'l’énoncé, lisible');
  assert.match(options[0]?.textContent ?? '', /ctve_000001/, 'l’identifiant, en second');
});

test('V5.1 UX — verser au débat émet le bon target.entry_id, sans saisie', async () => {
  const h = await harness();
  // Le DOM factice ne présélectionne pas la première option d'un `select` — un
  // vrai navigateur le fait. On pose donc les deux choix comme l'humain le
  // ferait, ce qui est aussi ce que le test doit prouver : deux choix, aucune
  // saisie.
  const material = findAll(runtimeRoot(h), (n) => hasClass(n, 'evidence-material-select'))[0];
  (material as unknown as { value: string }).value = 'mat_000001';
  const target = findAll(runtimeRoot(h), (n) => hasClass(n, 'evidence-target'))[0];
  (target as unknown as { value: string }).value = 'ctve_000001';
  const orientation = findAll(runtimeRoot(h), (n) => hasClass(n, 'evidence-orientation'))[0];
  (orientation as unknown as { value: string }).value = 'NONE';
  findAll(runtimeRoot(h), (n) => n.attributes['data-evidence'] === 'ADDUCE_MATERIAL')[0]?.click();

  const payload = h.emitted.find((e) => e.kind === 'ADDUCE')?.payload as {
    materialId: string; targetEntryId: string; orientation: string;
  };
  assert.equal(payload.targetEntryId, 'ctve_000001');
  assert.equal(payload.materialId, 'mat_000001');
  assert.equal(payload.orientation, 'NONE');
});


// --------------------------------------------------------------------------
// B-bis. GAP-01 — divulgation progressive des prérequis d'adduction
//
// L'action « Associer un matériau à une controverse » suppose DEUX
// enregistrements antérieurs. Trois états par prérequis, jamais deux :
//
//   KNOWN_ZERO      le compte canonique existe et vaut 0
//   KNOWN_PRESENT   le compte canonique existe et vaut plus de 0
//   UNKNOWN         aucun compte canonique — projection absente ou non lue
//
// `UNKNOWN ≠ ZERO` : une projection que le serveur n'a pas produite ne dit pas
// qu'il n'y a rien. La divulgation ne se déclenche donc QUE sur du connu.
// --------------------------------------------------------------------------

/** Rend une vue et renvoie le bloc d'adduction du Dossier. */
async function adductionBlock(over: Record<string, unknown>): Promise<FakeNode | null> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  createDomView(dom.document, {}, {})['showRunView']?.(runView(over));
  const root = dom.document.getElementById('section-runtime') as FakeNode;
  return findAll(root, (n) => hasClass(n, 'evidence-adduce'))[0] ?? null;
}

/** Le formulaire complet est-il présenté comme une action normale ? */
function fullFormPresent(block: FakeNode | null): boolean {
  if (block === null) return false;
  const has = (cls: string): boolean => findAll(block, (n) => hasClass(n, cls)).length > 0;
  const button = findAll(block, (n) => n.attributes['data-evidence'] === 'ADDUCE_MATERIAL').length > 0;
  return has('evidence-material-select') && has('evidence-target') && has('evidence-orientation') && button;
}

/** Projection V3 avec un compte canonique donné. */
const controversies = (count: number, items: unknown[] = []): Record<string, unknown> => ({
  read_model_version: 1, availability: 'AVAILABLE', recorded_count: count, items,
});

/** Projection V4 avec des comptes canoniques donnés. */
function evidenceWith(materialCount: number, materials: unknown[]): Record<string, unknown> {
  return {
    ...evidenceProjection(),
    recorded_material_count: materialCount,
    materials,
  };
}

test('GAP-01 · A — matériau connu absent : pas de formulaire complet', async () => {
  const block = await adductionBlock({
    evidence: evidenceWith(0, []),
    controversies: controversies(1, (controversyProjection() as { items: unknown[] }).items),
  });
  assert.ok(block !== null, 'le bloc d’adduction existe toujours');
  assert.equal(fullFormPresent(block), false, 'formulaire complet présenté malgré un prérequis absent');
  assert.match(block.textContent, /Pour utiliser cette action/);
  assert.match(block.textContent, /ajoutez au moins un matériau/);
  // La glose de la notion reste lisible dans la section qui l'entoure.
  assert.match(block.textContent, /Associer un matériau à une controverse/);
});

test('GAP-01 · B — controverse connue absente : pas de formulaire complet', async () => {
  const block = await adductionBlock({
    evidence: evidenceProjection(),
    controversies: controversies(0, []),
  });
  assert.equal(fullFormPresent(block), false);
  assert.match((block as FakeNode).textContent, /enregistrez au moins une controverse/);
  // Et le prérequis SATISFAIT n'est pas réclamé : un seul manque, un seul dit.
  assert.equal((block as FakeNode).textContent.includes('ajoutez au moins un matériau'), false);
});

test('GAP-01 · C — les deux connus absents : les deux prérequis sont expliqués', async () => {
  const block = await adductionBlock({
    evidence: evidenceWith(0, []),
    controversies: controversies(0, []),
  });
  assert.equal(fullFormPresent(block), false);
  assert.match((block as FakeNode).textContent, /ajoutez au moins un matériau/);
  assert.match((block as FakeNode).textContent, /enregistrez au moins une controverse/);
});

test('GAP-01 · D — prérequis satisfaits : formulaire complet disponible', async () => {
  const block = await adductionBlock({
    evidence: evidenceProjection(),
    controversies: controversies(1, (controversyProjection() as { items: unknown[] }).items),
  });
  assert.equal(fullFormPresent(block), true, 'le geste doit redevenir pleinement offert');
  // Aucune capacité perdue au passage : la cible et l'orientation sont là.
  const orientations = findAll(block as FakeNode, (n) => hasClass(n, 'evidence-orientation'))[0];
  const values = findAll(orientations as FakeNode, (n) => n.tagName === 'OPTION')
    .map((o) => o.attributes['value']);
  assert.deepEqual(values, ['NONE', 'SUPPORTS', 'OBJECTS_TO']);
  // Et aucun prérequis n'est réclamé.
  assert.equal((block as FakeNode).textContent.includes('Pour utiliser cette action'), false);
});

test('GAP-01 · E — UNKNOWN n’est jamais rendu comme un zéro', async () => {
  // (a) Projection V3 NON DISPONIBLE : ce run n'a pas été regardé par V3. Le
  //     nombre de controverses est INCONNU, pas nul.
  const v3Unknown = await adductionBlock({
    evidence: evidenceProjection(),
    controversies: { read_model_version: 1, availability: 'NOT_AVAILABLE' },
  });
  assert.equal(
    (v3Unknown as FakeNode).textContent.includes('enregistrez au moins une controverse'),
    false,
    'une absence non constatée a été affirmée',
  );
  assert.equal(fullFormPresent(v3Unknown), true, 'l’ignorance ne doit rien replier');

  // (b) Projection V3 ABSENTE du DTO : même conclusion, autre chemin.
  const v3Missing = await adductionBlock({ evidence: evidenceProjection() });
  assert.equal(
    (v3Missing as FakeNode).textContent.includes('enregistrez au moins une controverse'),
    false,
  );
  assert.equal(fullFormPresent(v3Missing), true);

  // (c) Compte V4 non numérique : inconnu, donc silencieux.
  const countUnknown = await adductionBlock({
    evidence: { ...evidenceProjection(), recorded_material_count: null },
    controversies: controversies(1, (controversyProjection() as { items: unknown[] }).items),
  });
  assert.equal(
    (countUnknown as FakeNode).textContent.includes('ajoutez au moins un matériau'),
    false,
    'un compte illisible a été lu comme zéro',
  );
  assert.equal(fullFormPresent(countUnknown), true);
});

test('GAP-01 · F — aucune cible n’est inventée hors de la projection', async () => {
  // Propriété d'origine, conservée et renforcée : avec une projection V3 vide,
  // il n'existe plus AUCUN sélecteur de cible — donc rien à inventer. Avec une
  // projection V3 inconnue, le sélecteur existe et ne porte aucune valeur.
  const vide = await adductionBlock({
    evidence: evidenceProjection(),
    controversies: controversies(0, []),
  });
  assert.equal(findAll(vide as FakeNode, (n) => hasClass(n, 'evidence-target')).length, 0);

  const inconnu = await adductionBlock({
    evidence: evidenceProjection(),
    controversies: { read_model_version: 1, availability: 'NOT_AVAILABLE' },
  });
  const target = findAll(inconnu as FakeNode, (n) => hasClass(n, 'evidence-target'))[0] as FakeNode;
  const options = findAll(target, (n) => n.tagName === 'OPTION');
  assert.equal(options.length, 1);
  assert.equal(options[0]?.attributes['value'], '', 'aucune valeur inventée');
  assert.match(options[0]?.textContent ?? '', /aucune entrée/);
});

// --------------------------------------------------------------------------
// B-ter. GAP-02 — Matériaux et Adductions restent deux notions distinctes
// --------------------------------------------------------------------------

test('GAP-02 · A — le Dossier expose Matériaux et Adductions distinctement', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  createDomView(dom.document, {}, {})['showRunView']?.(runView());
  const root = dom.document.getElementById('section-runtime') as FakeNode;

  // Deux titres de plein rang, et deux ancres.
  const titres = findAll(root, (n) => n.tagName === 'H3').map((h) => h.textContent);
  assert.ok(titres.includes('Matériaux'), titres.join(' | '));
  assert.ok(titres.includes('Adductions'), titres.join(' | '));
  assert.equal(findAll(root, (n) => n.attributes['id'] === 'materials-anchor').length, 1);
  assert.equal(findAll(root, (n) => n.attributes['id'] === 'adductions-anchor').length, 1);

  // Deux puces de navigation, et non une seule qui les réunirait.
  const puces = findAll(root, (n) => hasClass(n, 'dossier-chip')).map((c) => c.textContent);
  assert.ok(puces.some((p) => p.startsWith('Matériaux')), puces.join(' | '));
  assert.ok(puces.some((p) => p.startsWith('Adductions')), puces.join(' | '));

  // « Éléments probatoires » ne remplace plus la distinction utilisateur.
  assert.equal(root.textContent.includes('Éléments probatoires'), false);
});

test('GAP-02 · B — les deux comptes sont distincts, jamais confondus', async () => {
  // La fixture porte 1 matériau et 0 adduction : si l'écran servait un seul
  // compte sous les deux noms, les deux puces afficheraient le même nombre.
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  createDomView(dom.document, {}, {})['showRunView']?.(runView());
  const root = dom.document.getElementById('section-runtime') as FakeNode;
  const puces = findAll(root, (n) => hasClass(n, 'dossier-chip')).map((c) => c.textContent);

  assert.ok(puces.includes('Matériaux 1'), puces.join(' | '));
  assert.ok(puces.includes('Adductions 0'), puces.join(' | '));
  // Et les faits canoniques restent nommés séparément dans les sections.
  assert.match(root.textContent, /Matériaux enregistrés/);
  assert.match(root.textContent, /Adductions enregistrées/);
});

test('GAP-02 · C — sans projection V4, les notions restent nommées sans compte', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  createDomView(dom.document, {}, {})['showRunView']?.(
    runView({ evidence: { read_model_version: 1, availability: 'NOT_AVAILABLE' } }),
  );
  const root = dom.document.getElementById('section-runtime') as FakeNode;
  const puces = findAll(root, (n) => hasClass(n, 'dossier-chip')).map((c) => c.textContent);

  // Les deux libellés survivent à l'absence de compte…
  assert.ok(puces.includes('Matériaux'), puces.join(' | '));
  assert.ok(puces.includes('Adductions'), puces.join(' | '));
  // …et aucun zéro n'est fabriqué, ni sur les puces, ni dans les sections.
  assert.equal(puces.some((p) => /\d/.test(p) && /Matériaux|Adductions/.test(p)), false);
  assert.equal(root.textContent.includes('Matériaux enregistrés'), false);
  assert.equal(root.textContent.includes('Adductions enregistrées'), false);
});

// --------------------------------------------------------------------------
// B-quater. Finition visuelle V-02 / V-03 / V-06 / V-10 / V-13 / V-14
// --------------------------------------------------------------------------

/**
 * Fusion PROFONDE des surcharges de fixture.
 *
 * `runView` étale ses surcharges au premier niveau : surcharger `run` y
 * remplacerait le run entier, et la vue rendue ne décrirait plus une projection
 * réelle. La fusion préserve le reste de la fixture.
 */
function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  if (typeof over !== 'object' || over === null || Array.isArray(over)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over as Record<string, unknown>)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out;
}

/** Rend une vue complète et renvoie le DOM. */
async function renderDom(over: Record<string, unknown> = {}): Promise<ReturnType<typeof createFakeDom>> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = deepMerge(runView(), over) as Record<string, unknown>;
  createDomView(dom.document, {}, {})['showRunView']?.(view);
  return dom;
}

const sectionText = (dom: ReturnType<typeof createFakeDom>, id: string): string =>
  (dom.document.getElementById(id) as FakeNode | null)?.textContent ?? '';

test('V-02 · le sujet humain est le titre principal, l’identifiant reste second', async () => {
  const dom = await renderDom();
  const title = dom.document.getElementById('run-title') as FakeNode;
  const name = findAll(title, (n) => hasClass(n, 'run-heading-name'))[0];
  const id = findAll(title, (n) => hasClass(n, 'run-heading-id'))[0];

  // Le sujet vient de `identity.title` — le SEUL libellé canonique, celui que
  // l'humain a fourni à la création. Rien n'est reconstruit depuis le prompt,
  // un message, un événement ou une controverse.
  assert.ok(name !== undefined, 'le sujet occupe le premier rang');
  assert.equal(name.textContent, 'Cloud Run vs GKE');
  assert.ok(id !== undefined, 'l’identifiant reste présent');
  assert.match(id.textContent, /^CCR-/);
  assert.ok(hasClass(id, 'mono'), 'et il reste technique');
});

test('V-02 · sans sujet canonique, rien n’est inventé', async () => {
  const dom = await renderDom({ run: { identity: { title: '' } } });
  const title = dom.document.getElementById('run-title') as FakeNode;
  assert.equal(findAll(title, (n) => hasClass(n, 'run-heading-name')).length, 0);
  // L'identifiant devient le seul nom honnête — aucun sujet n'est fabriqué.
  assert.match(findAll(title, (n) => hasClass(n, 'run-heading-id'))[0]?.textContent ?? '', /^CCR-/);
});

test('V-03 · la gouvernance vient APRÈS la conversation et les contrôles', async () => {
  const text = sectionText(await renderDom(), 'section-overview');
  const conversation = text.indexOf('Conversation');
  const intervenir = text.indexOf('Intervenir');
  const controles = text.indexOf('Contrôles');
  const gouvernance = text.indexOf('Gouvernance');

  for (const [nom, position] of [['Conversation', conversation], ['Intervenir', intervenir],
    ['Contrôles', controles], ['Gouvernance', gouvernance]] as const) {
    assert.ok(position >= 0, `${nom} est rendu`);
  }
  assert.ok(conversation < intervenir, 'Conversation avant Intervenir');
  assert.ok(intervenir < controles, 'Intervenir avant Contrôles');
  assert.ok(controles < gouvernance, 'Contrôles avant Gouvernance');
});

test('V-04 · le volume transmis quitte le rang principal de la prochaine étape', async () => {
  const dom = await renderDom({
    run: {
      operations: {
        step: {
          allowed: true, source_status: 'AVAILABLE', source_slot: 'author',
          target_slot: 'challenger', source_event_id: 'evt_000010',
          next_round: 2, payload_bytes: 1674,
        },
      },
    },
  });
  const card = findAll(dom.document.getElementById('section-overview') as FakeNode,
    (n) => hasClass(n, 'next-action'))[0] as FakeNode;

  // Le verbe et le tour ouvert restent au premier rang.
  assert.match(card.textContent, /Transmettre la réponse/);
  assert.match(card.textContent, /Ouvre le tour 2/);

  // Le volume descend sous la divulgation — il n'est pas retiré.
  const disclosure = findAll(card, (n) => n.tagName === 'DETAILS')[0];
  assert.ok(disclosure !== undefined);
  assert.match(disclosure.textContent, /Octets transmis/);
  assert.match(disclosure.textContent, /1\s?674/);

  const primary = card.children
    .filter((n) => n.tagName !== 'DETAILS')
    .map((n) => n.textContent).join(' ');
  assert.equal(/octets/.test(primary), false, `octets au premier rang : ${primary}`);
});

test('V-06 · un geste sans effet n’occupe pas le rang d’une action principale', async () => {
  // `resume` est `allowed` ET `noop` : l'état demandé est déjà celui du run.
  const dom = await renderDom({ run: { operations: { resume: { allowed: true, noop: true } } } });
  const overview = dom.document.getElementById('section-overview') as FakeNode;

  // Aucun bouton RESUME au rang principal — c'est-à-dire hors du repli.
  const advanced = findAll(overview, (n) => hasClass(n, 'actions-unavailable'))[0] as FakeNode;
  const inAdvanced = new Set(findAll(advanced, () => true));
  const resumeButtons = findAll(overview, (n) => n.attributes['data-action'] === 'RESUME');
  const primaires = resumeButtons.filter((b) => !inAdvanced.has(b));
  assert.equal(primaires.length, 0, 'une action sans effet est proposée au premier rang');

  // L'état, lui, est dit.
  assert.match(overview.textContent, /Mode automatisé déjà actif/);
  assert.match(overview.textContent, /aucune action nécessaire/);

  // Et la capacité reste DÉCOUVRABLE : le cœur l'accorde, le repli l'offre.
  assert.equal(resumeButtons.length - primaires.length, 1, 'la capacité a disparu de l’écran');

  // Le contraste : un geste autorisé AVEC effet garde son bouton principal.
  const actif = await renderDom({ run: { operations: { pause: { allowed: true, noop: false } } } });
  const overviewActif = actif.document.getElementById('section-overview') as FakeNode;
  const advancedActif = findAll(overviewActif, (n) => hasClass(n, 'actions-unavailable'))[0] as FakeNode;
  const dansRepli = new Set(findAll(advancedActif, () => true));
  const pause = findAll(overviewActif, (n) => n.attributes['data-action'] === 'PAUSE')
    .filter((b) => !dansRepli.has(b));
  assert.equal(pause.length, 1, 'un geste utile doit rester au premier rang');
});

test('V-10 · le geste matériau se nomme « Ajouter un matériau »', async () => {
  const text = sectionText(await renderDom(), 'section-runtime');
  assert.match(text, /Ajouter un matériau/);
  assert.equal(text.includes('Retenir ce matériau'), false, 'ancien libellé de geste');
  // La sémantique reste dite : ajouter au dossier n'est pas verser au débat.
  assert.match(text, /Retenir un matériau ne le verse pas au débat/);
});

test('V-13 · les faits techniques du run vivent sous une divulgation', async () => {
  const dom = await renderDom();
  const facts = dom.document.getElementById('run-facts') as FakeNode;

  // Premier niveau : l'état utilisateur, et rien de technique.
  const disclosure = findAll(facts, (n) => hasClass(n, 'run-facts-technical'))[0] as FakeNode;
  assert.ok(disclosure !== undefined, 'la divulgation existe');
  const dansDivulgation = new Set(findAll(disclosure, () => true));
  const premierNiveau = findAll(facts, (n) => !dansDivulgation.has(n) && n !== disclosure)
    .map((n) => n.ownText).join(' ');

  for (const technique of ['Workspace', 'Session', 'Révision', 'Génération', 'Runtime', 'Alias']) {
    assert.equal(premierNiveau.includes(technique), false,
      `« ${technique} » reste au premier niveau`);
  }
  assert.match(premierNiveau, /État du run/);

  // Rien n'est supprimé : tout se retrouve sous la divulgation.
  for (const technique of ['Workspace', 'Session', 'Révision', 'Génération', 'Runtime', 'Alias']) {
    assert.ok(disclosure.textContent.includes(technique), `« ${technique} » a été perdu`);
  }
});

test('V-14 · la navigation globale est en français', async () => {
  const html = await readFile(new URL('index.html', WEB), 'utf8');
  assert.match(html, />Contre-expertises</);
  assert.match(html, />Diagnostic</);
  // Les anciens libellés anglais ne subsistent pas comme texte visible.
  assert.equal(/>Runs</.test(html), false, 'libellé « Runs » résiduel');
  assert.equal(/>Doctor</.test(html), false, 'libellé « Doctor » résiduel');
  // Les identifiants techniques, eux, ne sont pas renommés : ce sont des ancres
  // de câblage, pas du texte utilisateur.
  assert.match(html, /id="view-runs"/);
  assert.match(html, /id="view-doctor"/);
});

// --------------------------------------------------------------------------
// B-quinquies. VIS-01 / VIS-03 / VIS-04 — défauts rendus de la revue humaine
// --------------------------------------------------------------------------

/** Projection V5 avec `n` propositions réelles. */
function reconciliationWith(proposals: number): Record<string, unknown> {
  const items = proposals === 0 ? [] : [{
    controversy_id: 'ctv_000001',
    proposals: Array.from({ length: proposals }, (_unused, i) => ({
      entry_id: `rcn_prop_${String(i)}`,
      options: [{ option_id: `opt_${String(i)}`, content: 'Une option de fixture.' }],
    })),
    responses: [], recorded_acts: [], attribution: [],
    current_decisions: [], closure_effect_currentness: [],
    closure_declarations: [], closure_withdrawal_declarations: [],
    supersession_relations: [], disagreement_view: [], detections: [],
  }];
  return {
    read_model_version: 1, availability: 'AVAILABLE',
    recorded_count: proposals === 0 ? 0 : 1,
    reconciliation_revision: `rcn-sha256:${'f'.repeat(64)}`,
    items,
  };
}

const backButton = (dom: ReturnType<typeof createFakeDom>): FakeNode | undefined =>
  findAll(dom.document.getElementById('section-runtime') as FakeNode,
    (n) => n.attributes['id'] === 'back-to-conversation')[0];

test('VIS-01 · une réconciliation vide n’offre AUCUN retour contextuel', async () => {
  const dom = await renderDom({ reconciliations: reconciliationWith(0) });
  const sec = dom.document.getElementById('section-runtime') as FakeNode;

  // La section existe et dit son compte…
  assert.match(sec.textContent, /Réconciliation/);
  assert.match(sec.textContent, /Enregistrements V5/);
  // …mais le retour n'est même pas rendu : il n'y a pas d'aller à raccompagner.
  assert.equal(backButton(dom), undefined, 'un retour est offert sans proposition');
  assert.equal(sec.textContent.includes('Retour à Conversation'), false);
});

test('VIS-01 · une proposition réelle rend le retour, masqué jusqu’à l’accès direct', async () => {
  const dom = await renderDom({ reconciliations: reconciliationWith(1) });
  const back = backButton(dom);
  assert.ok(back !== undefined, 'le retour doit exister quand une proposition existe');
  // Rendu, mais masqué : `app.js` le révèle au moment de l'accès direct U-01.
  assert.equal(back.attributes['hidden'], '', 'le retour ne doit pas s’afficher d’emblée');

  // Et le signal U-01 est bien là, en Discussion, pour y mener.
  const overview = dom.document.getElementById('section-overview') as FakeNode;
  const signal = findAll(overview, (n) => n.attributes['data-goto'] === 'reconciliation')[0];
  assert.ok(signal !== undefined, 'le signal U-01 doit rester offert');
  assert.match(overview.textContent, /Une proposition de réconciliation est disponible/);
});

test('VIS-01 · le retour et le signal lisent le MÊME compte de propositions', async () => {
  // Falsification : deux comptes séparés finiraient par diverger, et l'écran
  // offrirait un retour vers un aller qui n'existe pas — ou l'inverse.
  for (const proposals of [0, 1, 2]) {
    const dom = await renderDom({ reconciliations: reconciliationWith(proposals) });
    const overview = dom.document.getElementById('section-overview') as FakeNode;
    const signal = findAll(overview, (n) => n.attributes['data-goto'] === 'reconciliation').length > 0;
    const retour = backButton(dom) !== undefined;
    assert.equal(signal, retour, `désaccord signal/retour pour ${String(proposals)} proposition(s)`);
    assert.equal(signal, proposals > 0);
  }
});

test('VIS-03 · le premier niveau de reprise ne duplique rien et n’expose aucun SHA', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const view = createDomView(dom.document, {});
  view['showRecovery']?.({
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'e'.repeat(64)}`,
    operational_state: { state: 'READY', control: 'AUTOMATION' },
    recovery: {
      initialization: { status: 'NONE', available_actions: [], conflicts: [] },
      step: { status: 'NONE', available_actions: [], conflicts: [] },
      send: { status: 'NONE', available_actions: [], conflicts: [] },
      handoff: { status: 'NONE', available_actions: [], conflicts: [] },
    },
  });

  const body = dom.document.getElementById('recovery-body') as FakeNode;
  const disclosure = findAll(body, (n) => n.tagName === 'DETAILS'
    && hasClass(n, 'tech-details'))[0] as FakeNode;
  assert.ok(disclosure !== undefined, 'la divulgation technique existe');

  const sousDivulgation = new Set(findAll(disclosure, () => true));
  const premierNiveau = findAll(body, (n) => !sousDivulgation.has(n) && n !== disclosure)
    .map((n) => n.ownText).join(' ');

  // Ni SHA, ni bloc « Faits connus », ni duplication de État / Contrôle.
  assert.equal(/sha256:/.test(premierNiveau), false, `SHA au premier niveau : ${premierNiveau}`);
  assert.equal(premierNiveau.includes('Faits connus'), false, 'le bloc dupliqué subsiste');
  assert.equal(premierNiveau.includes('Contrôle'), false, 'Contrôle dupliqué au premier niveau');

  // La microcopy approuvée est intacte.
  assert.match(body.textContent, /Aucune reprise nécessaire/);
  assert.match(body.textContent, /Aucun besoin de reprise n’est actuellement signalé pour ce run\./);

  // Et la donnée propre du bloc supprimé n'est PAS perdue.
  assert.match(disclosure.textContent, /Révision de la projection de reprise/);
  assert.match(disclosure.textContent, /sha256:/);
});

test('VIS-04 · le champ de formulation porte un vrai label visible', async () => {
  const dom = await renderDom();
  const sec = dom.document.getElementById('section-runtime') as FakeNode;

  const field = findAll(sec, (n) => hasClass(n, 'controversy-statement-input'))[0] as FakeNode;
  assert.ok(field !== undefined);
  const id = field.attributes['id'];
  assert.ok(typeof id === 'string' && id.length > 0, 'le champ doit porter un id');

  // Un label visible, associé au champ — pas un placeholder qui s'efface.
  const lab = findAll(sec, (n) => n.tagName === 'LABEL' && n.attributes['for'] === id)[0];
  assert.ok(lab !== undefined, 'le champ n’a pas de label associé');
  assert.equal(lab.textContent, 'Formulez le point de désaccord');

  // L'aide approuvée, et son association au champ.
  assert.match(sec.textContent, /Décrivez précisément ce qui oppose les positions sélectionnées\./);
  assert.match(sec.textContent, /Cet enregistrement ne désigne ni vainqueur ni décision\./);
  assert.equal(field.attributes['aria-describedby'], 'controversy-statement-help');

  // L'ancienne consigne ne subsiste nulle part, ni comme label ni comme
  // placeholder : elle avait été retenue comme instruction principale.
  assert.equal(sec.textContent.includes('Ce que vous voulez porter dans le débat'), false);
  assert.equal(field.attributes['placeholder'], undefined);
});

// --------------------------------------------------------------------------
// C. 401 — dire, et surtout ne rien rejouer
// --------------------------------------------------------------------------

interface Client {
  cockpit: Record<string, (...args: unknown[]) => unknown> & { state: Record<string, unknown> };
  posts: string[];
  gets: string[];
  calls: { kind: string; args: unknown[] }[];
}

async function client(): Promise<Client> {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => Client['cockpit'];
  };
  const { ApiError } = (await importWeb('api.js')) as {
    ApiError: new (status: number, code: string) => Error;
  };
  const posts: string[] = [];
  const gets: string[] = [];
  const calls: { kind: string; args: unknown[] }[] = [];
  const view = new Proxy({}, {
    get: (_t, property: string) => (...args: unknown[]) => {
      calls.push({ kind: property, args });
    },
  }) as View;

  const reject = (name: string) => (): Promise<never> => {
    posts.push(name);
    return Promise.reject(new ApiError(401, 'UNAUTHENTICATED'));
  };

  const cockpit = createCockpit({
    api: {
      recordControversy: reject('POST controversy'),
      recordEvidence: reject('POST evidence'),
      reconcile: reject('POST reconcile'),
      mutate: reject('POST mutate'),
      getOperation: (id: string) => {
        gets.push(id);
        return Promise.resolve({ operation_id: id, status: 'RUNNING', created_at: '2026-08-21T03:00:00.000Z' });
      },
      getRun: () => Promise.resolve(runView()),
      getNativeRun: () => Promise.resolve(runView()),
      listRuns: () => Promise.resolve({ runs: [] }),
      getTimeline: () => Promise.resolve({ entries: [], revision: 'sha256:aa' }),
    },
    view,
  });
  cockpit.state['runView'] = runView();
  cockpit.state['selectedRunId'] = 'CCR-20260404-001';
  return { cockpit, posts, gets, calls };
}

test('V5.1 UX — un 401 dit ce qui se passe, dans les mots décidés', async () => {
  const { label } = (await importWeb('labels.js')) as { label: { error(code: string): string } };
  const message = label.error('UNAUTHENTICATED');
  assert.match(message, /session cockpit a expiré/i);
  assert.match(message, /[Rr]echargez/);
  assert.match(message, /n’est pas relancée automatiquement/);
  // Ni le code, ni le statut : un message fermé.
  assert.equal(message.includes('UNAUTHENTICATED'), false);
  assert.equal(message.includes('401'), false);
});

test('V5.1 UX — un 401 sur une mutation V3 ne rejoue jamais le POST', async () => {
  const c = await client();
  await c.cockpit['recordControversy']?.({ eventIds: ['evt_000003'], statement: 'un motif' });

  assert.deepEqual(c.posts, ['POST controversy'], 'un seul POST, jamais deux');
  const kinds = c.calls.map((call) => call.kind);
  assert.ok(kinds.includes('showSessionExpired'), 'la session expirée est annoncée');
  assert.equal(kinds.includes('showMutationError'), false, 'aucun contrôle de réessai offert');
  assert.equal(c.cockpit.state['followUp'], null, 'aucun suivi installé');
});

test('V5.1 UX — un 401 sur une mutation V4 puis V5 : toujours un seul POST chacun', async () => {
  const c = await client();
  await c.cockpit['adduceMaterial']?.({
    materialId: 'mat_000001', targetEntryId: 'ctve_000001', orientation: 'NONE',
  });
  await c.cockpit['reconcile']?.({ geste: 'PROPOSE', controversyId: 'ctv_000001', expertSlot: 'author' });

  assert.deepEqual(c.posts, ['POST evidence', 'POST reconcile']);
  assert.equal(c.gets.length, 0, 'aucune lecture d’opération : rien n’a été engagé');
});

test('V5.1 UX — après un 401, seul un nouveau geste humain peut réémettre', async () => {
  const c = await client();
  await c.cockpit['recordControversy']?.({ eventIds: ['evt_000003'], statement: 'un motif' });
  assert.equal(c.posts.length, 1);

  // Le geste explicite de réessai reste disponible — et c'est bien un GESTE :
  // rien ne l'a déclenché tout seul entre les deux appels.
  await c.cockpit['retryMutation']?.();
  assert.equal(c.posts.length, 2, 'le second POST vient du geste, pas d’un rejeu');
});

// --------------------------------------------------------------------------
// D. V5 — six options lisibles, et jamais un bulletin de vote
// --------------------------------------------------------------------------

async function withProposal(): Promise<Harness> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const emitted: { kind: string; payload: unknown }[] = [];
  const view = createDomView(dom.document, {
    onReconcile: (payload: unknown) => emitted.push({ kind: 'RECONCILE', payload }),
  }, {});
  view['showRunView']?.(runView({ reconciliations: reconciliationProjection([proposalWithOptions(6)]) }));
  return { dom, view, emitted };
}

test('V5.1 UX — les six options sont six blocs distincts et numérotés', async () => {
  const h = await withProposal();
  const blocks = findAll(runtimeRoot(h), (n) => hasClass(n, 'reconciliation-option'));
  assert.equal(blocks.length, 6, 'six blocs, pas une liste plate');

  for (let index = 1; index <= 6; index += 1) {
    const block = blocks[index - 1] as FakeNode;
    assert.equal(block.attributes['data-option'], `opt_00000${String(index)}`);
    assert.match(block.textContent, new RegExp(`Option ${String(index)} sur 6`));
    assert.match(block.textContent, new RegExp(`Reformulation numéro ${String(index)}`), 'contenu intégral');
    assert.match(block.textContent, /opt_00000/, 'identifiant en second');
  }
});

test('V5.1 UX — aucun titre sémantique n’est fabriqué pour une option', async () => {
  const h = await withProposal();
  const blocks = findAll(runtimeRoot(h), (n) => hasClass(n, 'reconciliation-option'));
  for (const block of blocks) {
    // Les seuls en-têtes sont le compteur et l'identifiant : rien n'est extrait
    // du contenu pour en faire un titre que personne n'a enregistré.
    const heads = findAll(block, (n) => hasClass(n, 'option-head'));
    assert.equal(heads.length, 1);
    assert.match(heads[0]?.textContent ?? '', /^Option \d sur 6opt_00000\d$/);
  }
});

test('V5.1 UX — proposition ≠ décision, dit avant les options', async () => {
  const h = await withProposal();
  const banner = findAll(runtimeRoot(h), (n) => hasClass(n, 'proposal-banner'))[0];
  assert.ok(banner, 'la phrase est présente');
  assert.match(banner.textContent, /elle ne décide rien/);
  assert.match(banner.textContent, /Aucune option n’est recommandée/);
  assert.match(banner.textContent, /seuls les gestes humains/);
});

test('V5.1 UX — une option n’est jamais un contrôle, ni un bulletin', async () => {
  const h = await withProposal();
  const blocks = findAll(runtimeRoot(h), (n) => hasClass(n, 'reconciliation-option'));
  for (const block of blocks) {
    assert.equal(findAll(block, (n) => n.tagName === 'BUTTON').length, 0, 'aucune option cliquable');
    assert.equal(findAll(block, (n) => n.tagName === 'INPUT').length, 0, 'aucun bulletin de vote');
  }
  const text = runtimeRoot(h).textContent;
  for (const forbidden of ['option gagnante', 'meilleure option', 'choisir une option', 'option retenue']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }

  // Le seul sélecteur d'option qui existe appartient à la RÉPONSE humaine —
  // « option concernée », facultative — et porte son propre nom, distinct des
  // blocs de la proposition.
  const responseSelects = findAll(runtimeRoot(h), (n) => hasClass(n, 'reconciliation-response-option'));
  assert.equal(responseSelects.length, 1);
  assert.equal(responseSelects[0]?.attributes['aria-label'], 'Option concernée (facultative)');
  assert.match(responseSelects[0]?.textContent ?? '', /aucune option désignée/);
});

test('V5.1 UX — les quatre gestes humains restent présents et distincts', async () => {
  const h = await withProposal();
  const buttons = findAll(runtimeRoot(h), (n) => n.tagName === 'BUTTON')
    .map((n) => n.textContent)
    .filter((t) => /Accepter|Rejeter|Modifier|Remplacer/.test(t));
  assert.equal(buttons.length, 4);
  // Deux réponses, deux actes : la distinction du contrat reste lisible.
  assert.ok(buttons.some((t) => /Accepter \(réponse\)/.test(t)));
  assert.ok(buttons.some((t) => /Rejeter \(réponse\)/.test(t)));
  assert.ok(buttons.some((t) => /Modifier \(acte humain\)/.test(t)));
  assert.ok(buttons.some((t) => /Remplacer \(acte humain\)/.test(t)));
});

// --------------------------------------------------------------------------
// E. Densité — replier le technique, jamais la provenance
// --------------------------------------------------------------------------

test('V5.1 UX — alias et runtime se replient ; la provenance reste visible', async () => {
  const h = await harness();
  // Le repli vit avec les autres faits techniques, sous « État & reprise ».
  const folded = findAll(runFactsRoot(h), (n) => hasClass(n, 'inspect-technical'));
  assert.equal(folded.length, 1);
  // Et il n'a pas été dupliqué au Dossier au passage.
  assert.equal(findAll(runtimeRoot(h), (n) => hasClass(n, 'inspect-technical')).length, 0);
  assert.match(folded[0]?.textContent ?? '', /Alias de compatibilité/);
  assert.match(folded[0]?.textContent ?? '', /Runtime épinglé/);

  // Ce qui porte le débat n'est jamais replié.
  const visible = runtimeRoot(h).textContent;
  assert.match(visible, /Controverses/);
  assert.match(visible, /divergent sur la nature du défaut/);
  assert.match(visible, /evt_000003/, 'la provenance demeure lisible');
});
