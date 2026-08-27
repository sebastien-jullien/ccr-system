/**
 * V3-S8 — lecture des controverses dans le cockpit.
 *
 * Question de preuve :
 *
 * > **Le cockpit peut-il montrer une controverse sans rien décider à la place
 * > du cœur, et sans jamais promouvoir une attribution ?**
 *
 * Quatre propriétés.
 *
 *  1. **Une seule autorité.** Le navigateur présente `NativeRunHttpView
 *     .controversies` et rien d'autre : il ne relit aucun journal, ne regroupe
 *     rien, ne recompte rien, ne trie rien.
 *  2. **Le silence n'est pas la convergence.** Zéro controverse enregistrée ne
 *     dit pas que les experts sont d'accord.
 *  3. **L'histoire reste entière.** Un retrait n'efface pas, une contestation
 *     ne remplace pas, et aucun statut n'est fabriqué.
 *  4. **Lecture seule.** Aucun bouton, aucune mutation, aucun déclencheur de
 *     détection — la disponibilité publique du détecteur est basse.
 *
 * Le DOM factice ne connaît que `textContent` : une régression vers un sink
 * HTML n'y serait pas seulement détectée, elle serait inexprimable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

// --------------------------------------------------------------------------
// Fixtures — exactement la forme que S3 sérialise
// --------------------------------------------------------------------------

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    entry_id: 'ctve_000001',
    controversy_id: 'ctv_000001',
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-18T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
    ...over,
  };
}

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    controversy_id: 'ctv_000001',
    opening: entry({ entry_id: 'ctve_000001', kind: 'CONTROVERSY_RECORDED', content: 'Durée de vie du cache' }),
    entries: [entry({ entry_id: 'ctve_000001', kind: 'CONTROVERSY_RECORDED', content: 'Durée de vie du cache' })],
    authority_entries: [],
    unresolvable_anchors: [],
    ...over,
  };
}

function available(items: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { read_model_version: 1, availability: 'AVAILABLE', recorded_count: items.length, items };
}

const NOT_AVAILABLE = { read_model_version: 1, availability: 'NOT_AVAILABLE' };

function runView(controversies: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'a'.repeat(64)}`,
    ...(controversies === undefined ? {} : { controversies }),
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'CCR-20260818-002',
        execution_mode: 'NATIVE_V21_EXECUTION',
        title: 'S8',
        created_at: '2026-08-18T09:00:00.000Z',
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
        last_event_id: 'evt_000002',
        updated_at: '2026-08-18T09:00:00.000Z',
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
      counts: { events: 2 },
    },
  };
}

async function render(controversies: Record<string, unknown> | undefined): Promise<FakeNode | null> {
  return (await renderDom(controversies)).document.getElementById('section-runtime');
}

/** Le DOM entier — la section V3 vit dans le Dossier, les faits du run ailleurs. */
async function renderDom(
  controversies: Record<string, unknown> | undefined,
): Promise<ReturnType<typeof createFakeDom>> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  createDomView(dom.document, {})['showRunView']?.(runView(controversies));
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

/** Ordre d'apparition du texte : l'ordre du DOM, jamais un tri. */
function orderOf(haystack: string, needles: readonly string[]): number[] {
  return needles.map((needle) => haystack.indexOf(needle));
}

function isSorted(positions: readonly number[]): boolean {
  return positions.every((value, index) => value >= 0 && (index === 0 || value > (positions[index - 1] as number)));
}

// ==========================================================================
// A. Disponibilité, vide, compteur
// ==========================================================================

test('1 · T1 — zéro enregistrée, dit sans conclure à un accord', async () => {
  const text = textOf(await render(available([])));

  assert.match(text, /Controverses/);
  assert.match(text, /Aucune controverse enregistrée/);
  // Le silence n'est pas la convergence.
  assert.match(text, /ne dit pas que les experts sont d’accord/);
  // La phrase NIE l'accord ; on cherche donc les formes AFFIRMATIVES, pas des
  // fragments qui apparaissent légitimement dans une négation.
  for (const forbidden of [
    'Aucun désaccord',
    'Les experts sont d’accord',
    'Aucune contradiction',
    'Analyse terminée',
    'Rien à signaler',
    'convergence',
    'résolu',
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('2 · NOT_AVAILABLE n’est jamais rendu comme zéro', async () => {
  const text = textOf(await render(NOT_AVAILABLE));

  assert.match(text, /ne s’applique pas à cette génération/);
  assert.equal(text.includes('Aucune controverse enregistrée'), false);
  assert.equal(text.includes('Controverses enregistrées'), false, 'aucun compteur sur un run non couvert');
});

test('3 · T2/T11 — recorded_count compte des CONTROVERSES, pas des entrées', async () => {
  const first = item({
    controversy_id: 'ctv_000001',
    entries: [
      entry({ entry_id: 'ctve_000001', kind: 'CONTROVERSY_RECORDED', content: 'Première' }),
      entry({ entry_id: 'ctve_000002', anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }], semantic: { text: 'A1', semantic_origin: { kind: 'HUMAN' } } } }),
      entry({ entry_id: 'ctve_000003', anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }], semantic: { text: 'A2', semantic_origin: { kind: 'HUMAN' } } } }),
    ],
    opening: entry({ entry_id: 'ctve_000001', kind: 'CONTROVERSY_RECORDED', content: 'Première' }),
  });
  const second = item({
    controversy_id: 'ctv_000002',
    entries: [entry({ entry_id: 'ctve_000004', controversy_id: 'ctv_000002', kind: 'CONTROVERSY_RECORDED', content: 'Seconde' })],
    opening: entry({ entry_id: 'ctve_000004', controversy_id: 'ctv_000002', kind: 'CONTROVERSY_RECORDED', content: 'Seconde' }),
  });

  const section = await render(available([first, second]));
  const text = textOf(section);

  // Deux controverses, cinq entrées : c'est bien deux qui est affiché.
  assert.match(text, /Controverses enregistrées2/);
  assert.equal(findAll(section, (node) => node.attributes['class'] === 'controversy').length, 2);
  assert.match(text, /Première/);
  assert.match(text, /Seconde/);
});

// ==========================================================================
// B. Ordre serveur
// ==========================================================================

test('4 · T3/T4/T18 — l’ordre du serveur est celui du DOM, sans aucun tri', async () => {
  // Identifiants et horodatages volontairement ANTI-CHRONOLOGIQUES : un tri
  // frontend, quel qu'il soit, réordonnerait et le test tomberait.
  const late = item({
    controversy_id: 'ctv_000009',
    opening: entry({ entry_id: 'ctve_000009', controversy_id: 'ctv_000009', kind: 'CONTROVERSY_RECORDED', content: 'CONTROVERSE-PREMIÈRE' }),
    entries: [
      entry({ entry_id: 'ctve_000009', controversy_id: 'ctv_000009', kind: 'CONTROVERSY_RECORDED', content: 'ENTREE-C', recorded_at: '2026-08-18T23:00:00.000Z' }),
      entry({ entry_id: 'ctve_000002', controversy_id: 'ctv_000009', content: 'ENTREE-A', recorded_at: '2026-08-18T01:00:00.000Z' }),
      entry({ entry_id: 'ctve_000005', controversy_id: 'ctv_000009', content: 'ENTREE-B', recorded_at: '2026-08-18T12:00:00.000Z' }),
    ],
  });
  const early = item({
    controversy_id: 'ctv_000001',
    opening: entry({ entry_id: 'ctve_000001', kind: 'CONTROVERSY_RECORDED', content: 'CONTROVERSE-SECONDE' }),
    entries: [entry({ entry_id: 'ctve_000001', kind: 'CONTROVERSY_RECORDED', content: 'CONTROVERSE-SECONDE' })],
  });

  const text = textOf(await render(available([late, early])));

  assert.ok(isSorted(orderOf(text, ['CONTROVERSE-PREMIÈRE', 'CONTROVERSE-SECONDE'])), 'ordre des controverses');
  assert.ok(isSorted(orderOf(text, ['ENTREE-C', 'ENTREE-A', 'ENTREE-B'])), 'ordre des entrées');
});

// ==========================================================================
// C. Attribution
// ==========================================================================

test('5 · T5/T6 — une transcription humaine n’est jamais rendue comme une SOURCE', async () => {
  const transcription = entry({
    entry_id: 'ctve_000002',
    semantic_origin: { kind: 'HUMAN', about_actor: 'challenger' },
    anchors: {
      provenance: [{ event_id: 'evt_000002', round: 1, expert_slot_id: 'challenger' }],
      textual: { event_id: 'evt_000002', quoted_text: 'le cache reste valide', occurrence: 1 },
      semantic: { text: 'Challenger affirme que le cache reste valide', semantic_origin: { kind: 'HUMAN', about_actor: 'challenger' } },
    },
  });
  const source = entry({
    entry_id: 'ctve_000003',
    semantic_origin: { kind: 'SOURCE', actor: 'author' },
  });

  const text = textOf(await render(available([item({ entries: [transcription, source] })])));

  // L'origine est annoncée « à propos de », jamais comme une déclaration.
  assert.match(text, /Humain — à propos de : Challenger/);
  assert.equal(text.includes('Challenger : Challenger affirme'), false);
  // Et une vraie origine SOURCE reste distincte, en toutes lettres.
  assert.match(text, /Source — produit par l’expert/);
});

test('6 · T7 — une relation CCR assistée par modèle, sans claim de vérité', async () => {
  const inferred = entry({
    entry_id: 'ctve_000004',
    kind: 'RELATION_RECORDED',
    semantic_origin: { kind: 'CCR' },
    recorded_by: 'CCR',
    derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000001', inputs: ['ctve_000002', 'ctve_000003'] },
    relation: { from_entry_id: 'ctve_000003', to_entry_id: 'ctve_000002', act: 'CONTESTS' },
  });

  const section = await render(available([item({ entries: [inferred] })]));
  const text = textOf(section);

  assert.match(text, /Inférence CCR/);
  assert.match(text, /assistée par modèle/);
  assert.match(text, /inv_000001/);

  // Référence d'audit seule. La portée est la CARTE : le reste d'Inspect nomme
  // légitimement les moteurs — ce sont les sessions du run, pas une jointure.
  const card = findAll(section, (node) => node.attributes['class'] === 'controversy')[0] ?? null;
  const cardText = textOf(card).toLowerCase();
  for (const forbidden of ['claude', 'codex', 'coût', 'tokens', 'provider']) {
    assert.equal(cardText.includes(forbidden.toLowerCase()), false, forbidden);
  }
  // Aucune promotion en vérité.
  for (const forbidden of ['a confirmé que', 'contradiction prouvée', 'désaccord certain', 'prouve', 'vrai']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

// ==========================================================================
// D. Histoire append-only
// ==========================================================================

test('7 · T8/T9 — confirmation puis contestation, et l’inverse : les deux restent', async () => {
  for (const sequence of [
    ['CONFIRM_RELATION', 'CONTEST_RELATION'],
    ['CONTEST_RELATION', 'CONFIRM_RELATION'],
  ] as const) {
    const entries = sequence.map((act, index) =>
      entry({
        entry_id: `ctve_00001${String(index)}`,
        kind: 'HUMAN_AUTHORITY_RECORDED',
        authority: { act, target_entry_id: 'ctve_000004' },
      }),
    );
    const text = textOf(await render(available([item({ entries, authority_entries: entries })])));

    assert.match(text, /confirme la relation inférée/, sequence.join('→'));
    assert.match(text, /conteste la relation inférée/, sequence.join('→'));
    // Ordre serveur préservé, et aucun « dernier état » projeté.
    const positions = orderOf(text, sequence.map((act) =>
      act === 'CONFIRM_RELATION' ? 'confirme la relation inférée' : 'conteste la relation inférée'));
    assert.ok(isSorted(positions), sequence.join('→'));
    for (const forbidden of ['confirmée', 'contestée', 'statut', 'résolu', 'clos']) {
      assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  }
});

test('8 · T10/T15 — un retrait n’efface rien, et les actes ne sont pas renommés', async () => {
  const assertion = entry({
    entry_id: 'ctve_000002',
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }], semantic: { text: 'POSITION-RETIRÉE', semantic_origin: { kind: 'HUMAN' } } },
  });
  const withdrawal = entry({
    entry_id: 'ctve_000003',
    kind: 'RELATION_RECORDED',
    relation: { from_entry_id: 'ctve_000004', to_entry_id: 'ctve_000002', act: 'WITHDRAWS' },
  });

  const text = textOf(await render(available([item({ entries: [assertion, withdrawal] })])));

  assert.match(text, /POSITION-RETIRÉE/, 'l’assertion visée reste visible');
  assert.match(text, /ctve_000004 retire ctve_000002/);
  // Les actes gardent leur niveau : un fait attribué, pas une conclusion.
  for (const forbidden of ['supprimé', 'prouve faux', 'remplace définitivement', 'annulé', 'invalide']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('9 · T11/T12/T13 — nature libre, ancrages préservés, non-résolus honnêtes', async () => {
  const nature = entry({ entry_id: 'ctve_000005', kind: 'NATURE_RECORDED', content: 'ᚦ désaccord de méthode inédit' });
  const anchored = entry({
    entry_id: 'ctve_000006',
    anchors: {
      provenance: [{ event_id: 'evt_000002', round: 1 }],
      textual: { event_id: 'evt_000002', quoted_text: 'aa le cache', occurrence: 2 },
    },
  });

  const text = textOf(await render(available([item({
    entries: [nature, anchored],
    unresolvable_anchors: [{ entry_id: 'ctve_000007', event_id: 'evt_000099', occurrence: 3, reason: 'EVENT_NOT_FOUND' }],
  })])));

  // Nature : texte enregistré, aucune énumération frontend.
  assert.match(text, /ᚦ désaccord de méthode inédit/);
  for (const forbidden of ['FACTUAL', 'NORMATIVE', 'SEMANTIC', 'TAXONOMIE']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }

  // Ancrage : citation et rang, sans décalage inventé.
  assert.match(text, /aa le cache/);
  assert.match(text, /evt_000002 · occurrence 2/);
  for (const forbidden of ['offset', 'char', 'ligne 1', 'colonne']) {
    assert.equal(text.toLowerCase().includes(forbidden), false, forbidden);
  }

  // Non résolu : vérifiabilité, jamais un verdict.
  assert.match(text, /Ancrages non résolus/);
  assert.match(text, /événement introuvable/);
  for (const forbidden of ['invalide', 'faux', 'fabriqué', 'erreur']) {
    assert.equal(text.toLowerCase().includes(forbidden), false, forbidden);
  }
});

// ==========================================================================
// E. Sécurité, erreurs, absence de contrôle
// ==========================================================================

test('10 · T14/T15 — un contenu non fiable reste inerte', async () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>[lien](javascript:alert(3))';
  const section = await render(available([item({
    opening: entry({ entry_id: 'ctve_000001', kind: 'CONTROVERSY_RECORDED', content: hostile }),
    entries: [
      entry({ entry_id: 'ctve_000001', kind: 'CONTROVERSY_RECORDED', content: hostile }),
      entry({ entry_id: 'ctve_000002', kind: 'NATURE_RECORDED', content: hostile }),
    ],
  })]));

  // Le contenu est présent — il n'est pas censuré — mais comme du TEXTE.
  assert.match(textOf(section), /<script>alert\(1\)<\/script>/);

  // Aucun noeud script/img/a n'a été créé : le DOM factice ne connaît que
  // `textContent`, et le rendu n'a produit aucune balise exécutable.
  for (const tag of ['script', 'img', 'iframe', 'a']) {
    assert.equal(
      findAll(section, (node) => node.tagName.toLowerCase() === tag).length,
      0,
      `aucun <${tag}> créé`,
    );
  }
  // Et aucun attribut d'événement nulle part.
  const withHandlers = findAll(section, (node) =>
    Object.keys(node.attributes).some((name) => name.toLowerCase().startsWith('on')));
  assert.equal(withHandlers.length, 0);
});

test('11 · T16 — une erreur de lecture n’est jamais rendue comme zéro', async () => {
  // Le champ absent — une vue que la projection n'a pas produite — ne fabrique
  // ni « zéro », ni « non disponible ».
  const dom = await renderDom(undefined);
  const text = textOf(dom.document.getElementById('section-runtime'));

  assert.equal(text.includes('Controverses'), false);
  assert.equal(text.includes('Aucune controverse enregistrée'), false);
  assert.equal(text.includes('Controverses enregistrées'), false);
  // Le reste de la vue est rendu normalement : rien n'est cassé. Les faits
  // techniques ont quitté le Dossier pour « État & reprise » — ils sont donc
  // vérifiés là où ils vivent, pas là où ils vivaient.
  assert.match(textOf(dom.document.getElementById('run-facts')), /Identité/);
});

test('12 · T17/T19/T20 — aucune mutation, aucun contrôle de détection', async () => {
  const section = await render(available([item({
    entries: [
      entry({ entry_id: 'ctve_000002' }),
      entry({
        entry_id: 'ctve_000003',
        kind: 'RELATION_RECORDED',
        semantic_origin: { kind: 'CCR' },
        recorded_by: 'CCR',
        derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000001', inputs: [] },
        relation: { from_entry_id: 'ctve_000002', to_entry_id: 'ctve_000001', act: 'CONTESTS' },
      }),
    ],
  })]));

  // Aucun élément interactif dans une CARTE de controverse : ce qui est
  // enregistré se lit, et ne se modifie pas depuis son propre affichage.
  //
  // V5.1 : la section porte désormais UN geste humain — enregistrer une
  // controverse — autorisé par l'addendum V3/V4 du 2026-08-21. Il vit hors des
  // cartes, et la garde le vérifie plutôt que d'interdire tout contrôle.
  const controversies = findAll(section, (node) => node.attributes['class'] === 'controversy');
  assert.equal(controversies.length, 1);
  for (const card of controversies) {
    assert.equal(findAll(card, (node) => node.tagName.toLowerCase() === 'button').length, 0);
    assert.equal(findAll(card, (node) => Object.keys(node.listeners).length > 0).length, 0);
  }

  // Un seul GESTE dans toute la section, et c'est celui-là.
  //
  // Le Dossier porte en tête une navigation locale : des puces qui amènent à un
  // bloc de la même page. Elles ne mutent rien et ne nomment aucune capacité —
  // la garde les admet donc nommément, et refuse tout le reste. Un bouton qui
  // ne serait ni l'enregistrement ni une puce de navigation fait échouer ce
  // test, ce qui est exactement ce qu'il a pour objet d'empêcher.
  const buttons = findAll(section, (node) => node.tagName.toLowerCase() === 'button');
  const gestures = buttons.filter((node) => node.attributes['data-goto-anchor'] === undefined);
  assert.equal(gestures.length, 1, 'un seul geste V3');
  assert.equal(gestures[0]?.attributes['data-controversy'], 'RECORD');
  for (const chip of buttons) {
    if (chip.attributes['data-goto-anchor'] === undefined) continue;
    assert.equal(chip.attributes['data-controversy'], undefined, 'une puce ne porte aucune capacité');
  }

  const text = textOf(section);
  // La détection assistée reste FERMÉE au cockpit : aucun geste ne la nomme,
  // et aucun ne la déclenche. C'est la frontière que l'addendum a maintenue.
  for (const forbidden of ['Détecter', 'Lancer', 'Analyser', 'Confirmer', 'Contester', 'Retirer']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  // Et ce que le geste autorisé affirme, il l'affirme sans juger personne.
  assert.ok(text.includes('Enregistrer une controverse'));
  assert.ok(text.includes('Cela ne dit pas qu’un expert a tort'));
});

test('13 · garde de source : la présentation n’introduit aucune autorité', async () => {
  const render = await readFile(new URL('render.js', WEB), 'utf8');
  const start = render.indexOf('function controversyNodes');
  // Borne resserree en V4-S8 : la section V3 s'arretait « jusqu'a
  // nativeInspectNodes », ce qui etait exact tant qu'aucune autre section ne
  // s'inserait entre les deux. `evidenceNodes` s'y trouve desormais, et la
  // garde balayait du code V4 qu'elle n'a jamais eu pour objet de garder. La
  // nouvelle borne delimite EXACTEMENT la section V3, donc plus etroitement.
  const end = render.indexOf('function evidenceNodes');
  assert.ok(start > 0 && end > start, 'la section V3 est délimitée');
  const section = render
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // Aucune autorité métier, aucun tri, aucun état fabriqué.
  for (const forbidden of [
    '.sort(',
    'localeCompare',
    'recorded_at',
    'timestamp',
    'position_id',
    'same_position',
    'status',
    'closed',
    'resolved',
    'winner',
    'confidence',
    'score',
    'converged',
  ]) {
    assert.equal(section.includes(forbidden), false, forbidden);
  }

  // Aucune source parallèle, aucune jointure ledger, aucune mutation.
  for (const forbidden of [
    'controversies.jsonl',
    'readControversyJournal',
    'invocations',
    'usage',
    'cost',
    'fetch(',
    'POST',
    'Idempotency-Key',
    'expected_controversy_revision',
    'innerHTML',
    'insertAdjacentHTML',
  ]) {
    assert.equal(section.includes(forbidden), false, forbidden);
  }

  // Le compteur est LU, jamais recalculé.
  assert.equal(section.includes('projection.recorded_count'), true);
  assert.equal(section.includes('items.length'), true, 'seule la présence de la liste est testée');
  assert.equal(/recorded_count\s*=/.test(section), false, 'jamais réécrit');
});

test('14 · aucun sink de rendu n’est introduit dans tout le frontend', async () => {
  for (const name of ['render.js', 'labels.js']) {
    // Commentaires retirés : l'en-tête doctrinal de `render.js` ÉNUMÈRE les
    // sinks pour les interdire, et une garde qui lirait cette phrase
    // interdirait d'énoncer l'interdit.
    const code = (await readFile(new URL(name, WEB), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
      assert.equal(code.includes(sink), false, `${name} : ${sink}`);
    }
  }
});
