/**
 * V5.1 — lecture et gestes de réconciliation dans le cockpit.
 *
 * Question de preuve :
 *
 * > **Le cockpit peut-il montrer la réconciliation et offrir les gestes humains
 * > sans décider à la place du cœur, et sans introduire une des quatre
 * > confusions que l'addendum §14 interdit ?**
 *
 * Cinq propriétés.
 *
 *  1. **Une seule autorité.** L'écran présente `NativeRunHttpView.reconciliations`
 *     et rien d'autre : il ne relit aucun journal, ne recompte rien, ne dérive
 *     aucune actualité, ne trie rien.
 *  2. **`NOT_AVAILABLE` n'est pas zéro.** Un run que V5 ne regarde pas n'a pas
 *     « zéro proposition » : il n'a pas été regardé.
 *  3. **Les quatre interdits.** Proposition ≠ décision · actualité de décision ≠
 *     actualité d'effet · clôture ≠ consensus · détection ≠ erreur d'expert.
 *  4. **Les gestes sont câblés, et distincts.** `ACCEPT` enregistre une réponse,
 *     `MODIFIES` un acte humain. L'écran ne les confond pas.
 *  5. **La disponibilité vient du serveur.** Aucune valeur n'est codée dans le
 *     navigateur.
 *
 * Le DOM factice ne connaît que `textContent` : une régression vers un sink HTML
 * n'y serait pas seulement détectée, elle serait inexprimable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

const REVISION = `rcn-sha256:${'c'.repeat(64)}`;
const PROPOSAL = 'rcn_000001';
const ACT = 'rcn_000002';

// --------------------------------------------------------------------------
// Fixtures — exactement la forme que S12 sérialise
// --------------------------------------------------------------------------

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    controversy_id: 'ctv_000001',
    recorded_acts: [
      { entry_id: ACT, content: 'ce que la personne a décidé' },
    ],
    proposals: [
      {
        entry_id: PROPOSAL,
        options: [
          { option_id: 'oa', content: 'première formulation' },
          { option_id: 'ob', content: 'seconde formulation' },
        ],
      },
    ],
    responses: [
      { entry_id: 'rcn_000003', proposal_id: PROPOSAL, mode: 'ACCEPT' },
    ],
    scopes: [
      { entry_id: PROPOSAL, scope_kind: 'SUBSET', scope: ['ctve_000001'] },
    ],
    closure_declarations: [],
    closure_withdrawal_declarations: [],
    supersession_relations: [],
    decision_currentness: [{ act_id: ACT, unit: 'ctve_000001', current: false }],
    closure_effect_currentness: [{ unit: 'ctve_000001', act_ids: [ACT] }],
    current_decisions: [],
    historical_explicit_whole_scope_closure_declaration: false,
    current_all_entries_closure_coverage: false,
    disagreement_view: [],
    detections: [{ category: 'D05', controversy_id: 'ctv_000001' }],
    attribution: [],
    ...over,
  };
}

function available(items: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    read_model_version: 1,
    availability: 'AVAILABLE',
    recorded_count: 3,
    reconciliation_revision: REVISION,
    items,
  };
}

const NOT_AVAILABLE = { read_model_version: 1, availability: 'NOT_AVAILABLE' };

function runView(reconciliations: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'a'.repeat(64)}`,
    ...(reconciliations === undefined ? {} : { reconciliations }),
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'CCR-20260821-003',
        execution_mode: 'NATIVE_V21_EXECUTION',
        title: 'V5.1',
        created_at: '2026-08-21T09:00:00.000Z',
        workspace_cwd: 'E:/prog/x',
        manifest_schema_version: 2,
        state_schema_version: 3,
        runtime_schema_version: 2,
      },
      experts: {
        author: { provider: 'codex', session_id: 'codex-1', session_status: 'BOUND' },
        challenger: { provider: 'claude', session_id: 'claude-1', session_status: 'BOUND' },
      },
      compatibility: {
        provider_aliases: {
          claude: { resolution: 'UNIQUE', expert_slot: 'challenger' },
          codex: { resolution: 'UNIQUE', expert_slot: 'author' },
        },
      },
      operational_state: {
        state: 'READY',
        control: 'AUTOMATION',
        round: 1,
        next_step_source_slot: 'author',
        active_expert_slot: null,
        last_event_id: 'evt_000001',
        updated_at: '2026-08-21T09:00:00.000Z',
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
        step: { allowed: false },
        pause: { allowed: true, noop: false },
        resume: { allowed: true, noop: true },
        experts: {
          author: { send: { allowed: true }, handoff: { allowed: false } },
          challenger: { send: { allowed: true }, handoff: { allowed: false } },
        },
      },
      invocation_quota: { kind: 'NONE', consumed: 0, coverage: 'PRE_LEDGER' },
      usage: {
        coverage: 'PRE_LEDGER',
        invocations: { total: 0, provider_reported: { observed: 0, unobserved: 0, ambiguous: 0 } },
        providers: [],
        anomalies: { orphan_observations: [], duplicate_observations: [] },
      },
      cost_estimate: { coverage: 'PRE_LEDGER', pricing: { kind: 'NONE' }, by_invocation: [], providers: [] },
      counts: { events: 1 },
    },
  };
}

interface Rendered {
  readonly root: FakeNode | null;
  readonly gestures: Record<string, unknown>[];
}

async function render(
  reconciliations: Record<string, unknown> | undefined,
): Promise<Rendered> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const gestures: Record<string, unknown>[] = [];
  const view = createDomView(dom.document, {
    onReconcile: (request: unknown) => {
      gestures.push(request as Record<string, unknown>);
    },
  });
  view['showRunView']?.(runView(reconciliations));
  return { root: dom.document.getElementById('section-runtime'), gestures };
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

/** La section V5 du module de rendu, commentaires retirés. */
async function reconciliationSection(): Promise<string> {
  const raw = await readFile(new URL('render.js', WEB), 'utf8');
  const start = raw.indexOf('function reconciliationNodes');
  const end = raw.indexOf('function situationSentence');
  assert.ok(start > 0 && end > start, 'la section V5 est délimitée');
  return raw
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// --------------------------------------------------------------------------
// A. Disponibilité — et le zéro qui n'en est pas un
// --------------------------------------------------------------------------

test('V5.1 — `NOT_AVAILABLE` dit que le run n’a pas été regardé, sans compteur', async () => {
  const { root, gestures } = await render(NOT_AVAILABLE);
  const text = textOf(root);

  assert.ok(text.includes('V5 ne s’applique pas'));
  // Aucun compteur, aucune liste, aucun geste : la forme fermée ne porte rien.
  assert.equal(text.includes('Enregistrements V5'), false);
  assert.equal(findAll(root, (node) => node.attributes['data-reconcile'] !== undefined).length, 0);
  assert.equal(gestures.length, 0);
});

test('V5.1 — une projection absente ne rend rien, et ne fabrique aucun vide', async () => {
  const { root } = await render(undefined);
  assert.equal(textOf(root).includes('Réconciliation'), false);
});

// --------------------------------------------------------------------------
// B. Lecture — ce que le serveur projette, et rien de plus
// --------------------------------------------------------------------------

test('V5.1 — la section rend les comptes du serveur, les propositions et les actes', async () => {
  const { root } = await render(available([item()]));
  const text = textOf(root);

  assert.ok(text.includes('Réconciliation'));
  assert.ok(text.includes('Enregistrements V5'));
  assert.ok(text.includes('ctv_000001'));
  assert.ok(text.includes(PROPOSAL));
  assert.ok(text.includes(ACT));
  assert.ok(text.includes('première formulation'));
  assert.ok(text.includes('ce que la personne a décidé'));
});

test('V5.1 — les deux actualités sont rendues séparément (`CR5-01`)', async () => {
  const { root } = await render(available([item()]));
  const text = textOf(root);

  assert.ok(text.includes('Actualité de décision'));
  assert.ok(text.includes('Actualité d’effet de clôture'));
  // La fixture porte le cas exact du CR5-01 : la décision n'est plus courante,
  // et son effet de clôture l'est encore. L'écran doit pouvoir le montrer.
  assert.ok(text.includes('superséder une décision ne retire pas'));
});

test('V5.1 — une détection nomme une FORME, jamais une erreur d’expert', async () => {
  const { root } = await render(available([item()]));
  const text = textOf(root);

  assert.ok(text.includes('Formes observées'));
  assert.ok(text.includes('une proposition n’a reçu aucune réponse'));
  assert.ok(text.includes('Ils ne disent pas'));
  for (const forbidden of ['erreur', 'faute', 'incohérence de l’expert', 'mauvais raisonnement']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

// --------------------------------------------------------------------------
// C. Les quatre interdits de l'addendum §14
// --------------------------------------------------------------------------

test('V5.1 — aucun libellé ne transforme une proposition en décision, ni une clôture en consensus', async () => {
  const { root } = await render(available([item({
    closure_declarations: [{ entry_id: ACT, statement: 'clos sur ce périmètre', scope: ['ctve_000001'] }],
  })]));
  const text = textOf(root);

  assert.ok(text.includes('Une proposition n’est pas une décision'));
  assert.ok(text.includes('Elle ne dit pas que les'));
  // L'audit porte sur des AFFIRMATIONS. L'écran nomme la recommandation pour la
  // NIER — « aucune option n'est recommandée » — et un audit par sous-chaîne
  // confondrait la dénégation avec ce qu'elle dénie.
  assert.ok(text.includes('aucune option n’est recommandée'));
  assert.ok(text.includes('leur ordre est celui de l’enregistrement'));
  for (const forbidden of [
    'consensus', 'accord trouvé', 'décision du modèle', 'proposition adoptée',
    'gagnant', 'meilleure option', 'score', 'classement', 'convergence',
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('V5.1 — une réponse est présentée comme un fait sans effet, jamais comme une adoption', async () => {
  const { root } = await render(available([item()]));
  const text = textOf(root);

  assert.ok(text.includes('réponse : acceptation'));
  assert.ok(text.includes('ne vaut pas adoption'));
});

/**
 * Chaque réponse porte SA désignation et SA justification.
 *
 * Le rendu lit l'option sur la réponse elle-même et la provenance dans la
 * projection `attribution`, où elle est indexée par `entry_id`. Deux sources,
 * donc un appariement à démontrer : une jointure fautive croiserait la
 * justification d'une personne avec la désignation d'une autre, et l'écran
 * attribuerait un geste à qui ne l'a pas posé.
 *
 * Les deux réponses sont volontairement dissemblables — modes opposés, options
 * opposées, textes distincts — pour qu'aucun croisement ne puisse passer pour
 * une coïncidence.
 */
test('V5.1 — chaque réponse garde son option et sa provenance, sans croisement', async () => {
  const { root } = await render(available([item({
    responses: [
      { entry_id: 'rcn_000010', proposal_id: PROPOSAL, mode: 'ACCEPT', responded_option_id: 'oa' },
      { entry_id: 'rcn_000011', proposal_id: PROPOSAL, mode: 'REJECT', responded_option_id: 'ob' },
    ],
    attribution: [
      {
        entry_id: 'rcn_000010',
        kind: 'PROPOSAL_RESPONSE_RECORDED',
        semantic_origin: 'HUMAN',
        recorded_by: 'CCR',
        provenance: { kind: 'DECLARED', statement: 'justification alpha' },
      },
      {
        entry_id: 'rcn_000011',
        kind: 'PROPOSAL_RESPONSE_RECORDED',
        semantic_origin: 'HUMAN',
        recorded_by: 'CCR',
        provenance: { kind: 'DECLARED', statement: 'justification beta' },
      },
    ],
  })]));

  const lines = findAll(root, (node) => node.attributes['class'] === 'reconciliation-response');
  assert.equal(lines.length, 2, 'les deux réponses sont rendues');

  const a = lines.find((node) => node.textContent.includes('rcn_000010'));
  const b = lines.find((node) => node.textContent.includes('rcn_000011'));
  assert.ok(a !== undefined && b !== undefined, 'chaque réponse a sa ligne');

  // A garde ce qui est à A…
  assert.ok(a.textContent.includes('option oa'), a.textContent);
  assert.ok(a.textContent.includes('justification alpha'), a.textContent);
  assert.ok(a.textContent.includes('acceptation'), a.textContent);

  // …B garde ce qui est à B…
  assert.ok(b.textContent.includes('option ob'), b.textContent);
  assert.ok(b.textContent.includes('justification beta'), b.textContent);
  assert.ok(b.textContent.includes('rejet'), b.textContent);

  // …et aucune ligne ne porte ce qui appartient à l'autre.
  assert.equal(a.textContent.includes('option ob'), false, 'A ne porte pas l’option de B');
  assert.equal(a.textContent.includes('justification beta'), false, 'A ne porte pas la provenance de B');
  assert.equal(b.textContent.includes('option oa'), false, 'B ne porte pas l’option de A');
  assert.equal(b.textContent.includes('justification alpha'), false, 'B ne porte pas la provenance de A');
});

/**
 * Une réponse sans provenance ni option enregistrées n'en reçoit aucune.
 *
 * L'absence est le fait exact. Emprunter la justification d'une autre réponse
 * — ou en fabriquer une — donnerait à lire un geste que personne n'a motivé.
 */
test('V5.1 — une réponse sans désignation ni provenance n’en emprunte aucune', async () => {
  const { root } = await render(available([item({
    responses: [
      { entry_id: 'rcn_000010', proposal_id: PROPOSAL, mode: 'ACCEPT', responded_option_id: 'oa' },
      { entry_id: 'rcn_000012', proposal_id: PROPOSAL, mode: 'REJECT' },
    ],
    attribution: [
      {
        entry_id: 'rcn_000010',
        kind: 'PROPOSAL_RESPONSE_RECORDED',
        semantic_origin: 'HUMAN',
        recorded_by: 'CCR',
        provenance: { kind: 'DECLARED', statement: 'justification alpha' },
      },
    ],
  })]));

  const lines = findAll(root, (node) => node.attributes['class'] === 'reconciliation-response');
  const bare = lines.find((node) => node.textContent.includes('rcn_000012'));
  assert.ok(bare !== undefined, 'la réponse dépourvue est tout de même rendue');

  assert.equal(bare.textContent.includes('option'), false, 'aucune option désignée n’est affichée');
  assert.equal(bare.textContent.includes('justification alpha'), false, 'aucune provenance empruntée');
});

// --------------------------------------------------------------------------
// D. Les gestes humains — câblés, et distincts
// --------------------------------------------------------------------------

test('V5.1 — les quatre gestes appellent le cockpit, chacun sous son nom', async () => {
  const { root, gestures } = await render(available([item()]));

  for (const geste of ['ACCEPT', 'REJECT', 'MODIFIES', 'REPLACES']) {
    const buttons = findAll(root, (node) => node.attributes['data-reconcile'] === geste);
    assert.equal(buttons.length, 1, geste);
    buttons[0]?.click();
  }

  assert.deepEqual(gestures.map((request) => request['geste']), [
    'ACCEPT', 'REJECT', 'MODIFIES', 'REPLACES',
  ]);
  for (const request of gestures) {
    assert.equal(request['proposalId'], PROPOSAL);
    assert.equal(request['controversyId'], 'ctv_000001');
  }
  // Le périmètre transmis est celui que le SERVEUR a enregistré pour cette
  // proposition. Le navigateur ne le reconstruit pas.
  assert.deepEqual(gestures[2]?.['scope'], { scope_kind: 'SUBSET', scope: ['ctve_000001'] });
});

test('V5.1 — la demande de proposition nomme l’expert choisi, et rien d’autre', async () => {
  const { root, gestures } = await render(available([item()]));
  const buttons = findAll(root, (node) => node.attributes['data-reconcile'] === 'PROPOSE');
  assert.equal(buttons.length, 1);
  buttons[0]?.click();

  assert.equal(gestures.length, 1);
  assert.equal(gestures[0]?.['geste'], 'PROPOSE');
  assert.equal(gestures[0]?.['controversyId'], 'ctv_000001');
  // Aucune décision n'accompagne la demande : ni option, ni contenu, ni relation.
  assert.equal(gestures[0]?.['optionId'], undefined);
  assert.equal(gestures[0]?.['content'], undefined);
});

// --------------------------------------------------------------------------
// E. Le navigateur n'est pas une autorité
// --------------------------------------------------------------------------

test('V5.1 — la section ne code aucune disponibilité, et ne dérive aucune actualité', async () => {
  const section = await reconciliationSection();

  // La disponibilité vient du serveur : le navigateur la LIT sur la projection,
  // et ne la calcule jamais. Comparer une valeur reçue n'est pas la décider —
  // l'audit porte donc sur l'AFFECTATION, pas sur la comparaison.
  assert.ok(section.includes('projection.availability'), 'la disponibilité est lue');
  assert.equal(section.includes('availability = '), false, 'la disponibilité est affectée');

  // Aucun calcul dérivé : ni actualité, ni couverture, ni tri, ni compte client.
  for (const forbidden of [
    '.sort(', 'toSorted', 'localeCompare', '.reduce(', 'groupBy',
    'current =', 'is_closed', 'converged', 'CONVERGED',
    'items.length)', 'proposals.length)',
  ]) {
    assert.equal(section.includes(forbidden), false, `section V5 : « ${forbidden} »`);
  }

  // Aucune écriture directe : le rendu émet une intention, il n'appelle aucun
  // service ni aucune route.
  for (const forbidden of ['fetch(', '/api/', 'recordReconciliation', 'JSON.stringify']) {
    assert.equal(section.includes(forbidden), false, `section V5 : « ${forbidden} »`);
  }
});

// --------------------------------------------------------------------------
// F. Assemblage du corps — le cockpit traduit l'intention, sans l'interpréter
// --------------------------------------------------------------------------

interface CockpitUnderTest {
  selectRun(runId: string): Promise<void>;
  reconcile(request: Record<string, unknown>): Promise<void>;
  retryMutation(): Promise<void>;
}

interface SentCall {
  readonly runId: string;
  readonly payload: Record<string, unknown>;
  readonly key: string;
}

async function cockpitUnderTest(): Promise<{
  cockpit: CockpitUnderTest;
  sent: SentCall[];
  errors: string[];
}> {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => CockpitUnderTest;
  };
  const sent: SentCall[] = [];
  const errors: string[] = [];
  const api = {
    getRun: () => Promise.resolve(runView(available([item()]))),
    getTimeline: () => Promise.resolve({ entries: [], cursor_next: null, truncated: false, total: 0 }),
    getRecovery: () => Promise.resolve({ recovery: {} }),
    listRuns: () => Promise.resolve({ runs: [] }),
    reconcile: (runId: string, payload: Record<string, unknown>, key: string) => {
      sent.push({ runId, payload, key });
      return Promise.resolve({ operation_id: 'op_1', status: 'SUCCEEDED' });
    },
  };
  const view = new Proxy({}, {
    get: (_target, property: string) => (...args: unknown[]): void => {
      if (property === 'showMutationError') errors.push(String(property));
      void args;
    },
  }) as Record<string, unknown>;

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('CCR-20260821-003');
  return { cockpit, sent, errors };
}

test('V5.1 — `ACCEPT` devient une RÉPONSE, `MODIFIES` un ACTE humain', async () => {
  const { cockpit, sent } = await cockpitUnderTest();

  await cockpit.reconcile({
    geste: 'ACCEPT',
    controversyId: 'ctv_000001',
    proposalId: PROPOSAL,
    statement: 'discuté en revue',
    optionId: 'oa',
  });
  await cockpit.reconcile({
    geste: 'MODIFIES',
    controversyId: 'ctv_000001',
    proposalId: PROPOSAL,
    statement: 'discuté en revue',
    content: 'ma formulation',
    scope: { scope_kind: 'SUBSET', scope: ['ctve_000001'] },
  });

  assert.equal(sent.length, 2);
  // Deux opérations distinctes, parce que le contrat en connaît deux.
  assert.equal(sent[0]?.payload['operation'], 'RESPOND');
  assert.equal(sent[0]?.payload['mode'], 'ACCEPT');
  assert.equal(sent[0]?.payload['responded_option_id'], 'oa');
  assert.equal(sent[0]?.payload['expected_revision'], REVISION);

  assert.equal(sent[1]?.payload['operation'], 'RECORD_ACT');
  assert.deepEqual(sent[1]?.payload['responds_to'], {
    proposal_id: PROPOSAL,
    relation: 'MODIFIES',
  });
  assert.equal(sent[1]?.payload['content'], 'ma formulation');
  // `ACCEPT` n'a jamais produit `ADOPTS` : ce sont deux surfaces différentes.
  assert.equal(JSON.stringify(sent).includes('ADOPTS'), false);
});

test('V5.1 — la demande de proposition ne porte aucune révision, et nomme l’expert', async () => {
  const { cockpit, sent } = await cockpitUnderTest();

  await cockpit.reconcile({
    geste: 'PROPOSE',
    controversyId: 'ctv_000001',
    expertSlot: 'challenger',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.payload['operation'], 'PROPOSE_BY_MODEL');
  assert.equal(sent[0]?.payload['expert_slot'], 'challenger');
  // Le chemin assisté capture lui-même sa référence de fraîcheur sous verrou :
  // en exiger une ici aurait été une garantie fictive.
  assert.equal(sent[0]?.payload['expected_revision'], undefined);
});

test('V5.1 — un geste incomplet n’est pas envoyé, et le réessai réutilise la clé', async () => {
  const { cockpit, sent } = await cockpitUnderTest();

  // Sans justification, rien ne part : ce n'est pas une validation métier, mais
  // le refus d'envoyer un geste que l'humain n'a pas fini de formuler.
  await cockpit.reconcile({ geste: 'ACCEPT', controversyId: 'ctv_000001', proposalId: PROPOSAL });
  // Sans formulation, un acte humain n'a rien à porter.
  await cockpit.reconcile({
    geste: 'REPLACES',
    controversyId: 'ctv_000001',
    proposalId: PROPOSAL,
    statement: 'x',
    scope: { scope_kind: 'SUBSET', scope: ['ctve_000001'] },
  });
  assert.equal(sent.length, 0);

  await cockpit.reconcile({
    geste: 'REJECT',
    controversyId: 'ctv_000001',
    proposalId: PROPOSAL,
    statement: 'motivé',
  });
  assert.equal(sent.length, 1);

  // Une intention, une clé : le réessai la RÉUTILISE, sinon chaque essai
  // deviendrait un nouvel effet.
  await cockpit.retryMutation();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.key, sent[0]?.key);
});
