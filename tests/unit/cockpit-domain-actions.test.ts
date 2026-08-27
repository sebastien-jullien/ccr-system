/**
 * V5.1 — les gestes V3 et V4 depuis l'écran, jusqu'au corps émis.
 *
 * Question de preuve :
 *
 * > **Le navigateur traduit-il l'intention humaine sans l'interpréter — et sans
 * > jamais devenir l'auteur de ce qu'il transmet ?**
 *
 * Quatre propriétés.
 *
 *  1. **Deux gestes V4, deux corps.** Retenir et verser ne se confondent pas
 *     davantage dans le client que dans le service.
 *  2. **Les jetons de fraîcheur viennent du serveur.** V3 depuis l'enveloppe,
 *     V4 depuis sa projection. Aucun n'est fabriqué.
 *  3. **Une intention, une clé.** Le réessai la réutilise ; un geste incomplet
 *     n'est pas envoyé.
 *  4. **Aucun fournisseur.** Ces surfaces sont humaines : le client double ne
 *     porte aucun adaptateur, et rien n'en réclame.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

const CTV_REVISION = `ctv-sha256:${'d'.repeat(64)}`;
const EV_REVISION = `ev-sha256:${'e'.repeat(64)}`;

function runView(): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'a'.repeat(64)}`,
    controversy_revision: CTV_REVISION,
    controversies: {
      read_model_version: 1,
      availability: 'AVAILABLE',
      recorded_count: 1,
      items: [{
        controversy_id: 'ctv_000001',
        opening: null,
        entries: [],
        authority_entries: [],
        unresolvable_anchors: [],
      }],
    },
    evidence: {
      read_model_version: 1,
      availability: 'AVAILABLE',
      evidence_revision: EV_REVISION,
      materials: [{ entry: { entry_id: 'mat_000001' }, verifiability: { kind: 'HELD_AND_RESOLVABLE' } }],
      adductions: [],
      recorded_material_count: 1,
      recorded_adduction_count: 0,
    },
    reconciliations: { read_model_version: 1, availability: 'AVAILABLE', recorded_count: 0, reconciliation_revision: `rcn-sha256:${'f'.repeat(64)}`, items: [] },
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'CCR-20260821-701',
        execution_mode: 'NATIVE_V21_EXECUTION',
        title: 'V5.1 domaine',
        created_at: '2026-08-21T09:00:00.000Z',
        workspace_cwd: 'E:/prog/x',
        manifest_schema_version: 2,
        state_schema_version: 3,
        runtime_schema_version: 2,
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

interface Sent {
  readonly surface: 'CONTROVERSY' | 'EVIDENCE';
  readonly runId: string;
  readonly payload: Record<string, unknown>;
  readonly key: string;
}

interface CockpitUnderTest {
  selectRun(runId: string): Promise<void>;
  recordControversy(request: Record<string, unknown>): Promise<void>;
  registerMaterial(request: Record<string, unknown>): Promise<void>;
  adduceMaterial(request: Record<string, unknown>): Promise<void>;
  retryMutation(): Promise<void>;
}

async function cockpitUnderTest(): Promise<{ cockpit: CockpitUnderTest; sent: Sent[] }> {
  const { createCockpit } = (await importWeb('cockpit.js')) as {
    createCockpit: (deps: unknown) => CockpitUnderTest;
  };
  const sent: Sent[] = [];
  const api = {
    getRun: () => Promise.resolve(runView()),
    getTimeline: () => Promise.resolve({ entries: [], cursor_next: null, truncated: false, total: 0 }),
    getRecovery: () => Promise.resolve({ recovery: {} }),
    listRuns: () => Promise.resolve({ runs: [] }),
    recordControversy: (runId: string, payload: Record<string, unknown>, key: string) => {
      sent.push({ surface: 'CONTROVERSY', runId, payload, key });
      return Promise.resolve({ operation_id: 'op_c', status: 'SUCCEEDED' });
    },
    recordEvidence: (runId: string, payload: Record<string, unknown>, key: string) => {
      sent.push({ surface: 'EVIDENCE', runId, payload, key });
      return Promise.resolve({ operation_id: 'op_e', status: 'SUCCEEDED' });
    },
  };
  const view = new Proxy({}, {
    get: () => (): void => undefined,
  }) as Record<string, unknown>;

  const cockpit = createCockpit({ api, view });
  await cockpit.selectRun('CCR-20260821-701');
  return { cockpit, sent };
}

// --------------------------------------------------------------------------
// A. V3 — enregistrer une controverse
// --------------------------------------------------------------------------

test('V5.1 — le geste V3 émet `RECORD_CONTROVERSY` avec le jeton de l’enveloppe', async () => {
  const { cockpit, sent } = await cockpitUnderTest();

  await cockpit.recordControversy({
    eventIds: 'evt_000001, evt_000002',
    statement: '  Les deux experts divergent sur le cache.  ',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.surface, 'CONTROVERSY');
  assert.equal(sent[0]?.payload['operation'], 'RECORD_CONTROVERSY');
  // Le jeton V3 vient du serveur, pas d'une valeur fabriquée ici.
  assert.equal(sent[0]?.payload['expected_controversy_revision'], CTV_REVISION);
  assert.deepEqual(sent[0]?.payload['provenance_event_ids'], ['evt_000001', 'evt_000002']);
  assert.equal(sent[0]?.payload['statement'], 'Les deux experts divergent sur le cache.');
  // Aucun identifiant métier n'est alloué par le navigateur.
  assert.equal('controversy_id' in (sent[0]?.payload ?? {}), false);
  assert.equal('entry_id' in (sent[0]?.payload ?? {}), false);
});

test('V5.1 — un geste V3 incomplet n’est pas envoyé', async () => {
  const { cockpit, sent } = await cockpitUnderTest();
  await cockpit.recordControversy({ eventIds: '', statement: 'un motif' });
  await cockpit.recordControversy({ eventIds: 'evt_000001', statement: '   ' });
  assert.equal(sent.length, 0);
});

// --------------------------------------------------------------------------
// B. V4 — retenir, puis verser
// --------------------------------------------------------------------------

test('V5.1 — les trois formes de matériau sont celles du contrat, et rien d’autre', async () => {
  const { cockpit, sent } = await cockpitUnderTest();

  await cockpit.registerMaterial({ form: 'INLINE_TEXT', value: 'un extrait', label: 'note' });
  await cockpit.registerMaterial({ form: 'RUN_EVENT', value: 'evt_000001', label: '' });
  await cockpit.registerMaterial({ form: 'EXTERNAL_REFERENCE', value: 'https://exemple/doc', label: '' });
  // Une quatrième forme n'existe pas : rien n'est envoyé.
  await cockpit.registerMaterial({ form: 'SCREENSHOT', value: 'x', label: '' });

  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0]?.payload['representation'], { form: 'INLINE_TEXT', text: 'un extrait' });
  assert.equal(sent[0]?.payload['label'], 'note');
  assert.deepEqual(sent[1]?.payload['representation'], { form: 'RUN_EVENT', event_id: 'evt_000001' });
  // Étiquette vide : le champ est ABSENT, jamais une chaîne vide inventée.
  assert.equal('label' in (sent[1]?.payload ?? {}), false);
  assert.deepEqual(sent[2]?.payload['representation'], { form: 'EXTERNAL_REFERENCE', locator: 'https://exemple/doc' });

  for (const call of sent) {
    assert.equal(call.surface, 'EVIDENCE');
    assert.equal(call.payload['operation'], 'REGISTER_MATERIAL');
    assert.equal(call.payload['expected_evidence_revision'], EV_REVISION);
    // Retenir n'est pas verser : aucune orientation, aucune cible.
    assert.equal('orientation' in call.payload, false);
    assert.equal('target_entry_id' in call.payload, false);
  }
});

test('V5.1 — verser au débat porte cible et orientation, explicitement', async () => {
  const { cockpit, sent } = await cockpitUnderTest();

  await cockpit.adduceMaterial({
    materialId: 'mat_000001',
    targetEntryId: 'ctve_000001',
    orientation: 'OBJECTS_TO',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.payload['operation'], 'ADDUCE_MATERIAL');
  assert.equal(sent[0]?.payload['material_id'], 'mat_000001');
  assert.equal(sent[0]?.payload['target_entry_id'], 'ctve_000001');
  assert.equal(sent[0]?.payload['orientation'], 'OBJECTS_TO');
  // L'adduction ne crée pas le matériau : aucune représentation ne l'accompagne.
  assert.equal('representation' in (sent[0]?.payload ?? {}), false);
});

test('V5.1 — une adduction incomplète n’est pas envoyée, et rien n’est deviné', async () => {
  const { cockpit, sent } = await cockpitUnderTest();
  // Orientation absente : le service n'applique aucun défaut, et le navigateur
  // n'en invente pas un à sa place.
  await cockpit.adduceMaterial({ materialId: 'mat_000001', targetEntryId: 'ctve_000001', orientation: '' });
  await cockpit.adduceMaterial({ materialId: '', targetEntryId: 'ctve_000001', orientation: 'NONE' });
  await cockpit.adduceMaterial({ materialId: 'mat_000001', targetEntryId: '', orientation: 'NONE' });
  assert.equal(sent.length, 0);
});

// --------------------------------------------------------------------------
// C. Une intention, une clé
// --------------------------------------------------------------------------

test('V5.1 — le réessai réutilise la clé, pour V3 comme pour V4', async () => {
  const { cockpit, sent } = await cockpitUnderTest();

  await cockpit.recordControversy({ eventIds: 'evt_000001', statement: 'un motif' });
  await cockpit.retryMutation();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.key, sent[0]?.key, 'la clé V3 est réutilisée');
  assert.equal(sent[1]?.surface, 'CONTROVERSY', 'et la bonne surface est réémise');

  await cockpit.registerMaterial({ form: 'INLINE_TEXT', value: 'un extrait', label: '' });
  await cockpit.retryMutation();
  assert.equal(sent.length, 4);
  assert.equal(sent[3]?.key, sent[2]?.key, 'la clé V4 est réutilisée');
  assert.equal(sent[3]?.surface, 'EVIDENCE');

  // Deux intentions distinctes : deux clés distinctes.
  assert.notEqual(sent[2]?.key, sent[0]?.key);
});

// --------------------------------------------------------------------------
// D. L'écran émet bien l'intention — les trois contrôles sont branchés
// --------------------------------------------------------------------------

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

test('V5.1 — les trois contrôles de l’écran appellent leur handler, chacun sous son nom', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const gestures: string[] = [];
  const view = createDomView(dom.document, {
    onRecordControversy: () => gestures.push('CONTROVERSY_RECORD'),
    onRegisterMaterial: () => gestures.push('REGISTER_MATERIAL'),
    onAdduceMaterial: () => gestures.push('ADDUCE_MATERIAL'),
  });
  view['showRunView']?.(runView());

  const root = dom.document.getElementById('section-runtime');
  const controversy = findAll(root, (node) => node.attributes['data-controversy'] === 'RECORD');
  const evidence = findAll(root, (node) => node.attributes['data-evidence'] !== undefined);

  assert.equal(controversy.length, 1, 'un geste V3');
  assert.equal(evidence.length, 2, 'deux gestes V4');

  controversy[0]?.click();
  evidence[0]?.click();
  evidence[1]?.click();

  // L'ordre est celui de l'écran : retenir avant verser, comme la chaîne.
  assert.deepEqual(gestures, ['CONTROVERSY_RECORD', 'REGISTER_MATERIAL', 'ADDUCE_MATERIAL']);
});
