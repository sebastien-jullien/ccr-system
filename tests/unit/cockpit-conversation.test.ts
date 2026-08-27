/**
 * V2.3-S3 — `ConversationThread`.
 *
 * Question de preuve :
 *
 * > **L'interface présente-t-elle les faits existants dans le bon ordre, sans
 * > modifier leur sémantique ni l'ordre canonique du journal ?**
 *
 * Trois propriétés.
 *
 *  1. **L'ordre reçu est l'ordre rendu.** Aucun tri, aucune reconstruction,
 *     aucune déduplication. Le journal détient la chronologie.
 *  2. **La classification est fermée.** Par type d'événement, jamais par
 *     analyse du contenu — et surtout aucune notion d'accord ou de désaccord.
 *  3. **Rien n'est perdu.** Ce que le fil ne rend pas comme contribution reste
 *     compté, et reste entier dans la chronologie.
 *
 * Le rendu tourne sur le DOM factice, qui n'expose aucun sink HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lexer } from 'marked';

import { createFakeDom } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

interface Entry {
  readonly event_id: string;
  readonly type: string;
  readonly actor: string;
  readonly round: number;
  readonly timestamp: string;
  readonly content?: string | null;
  readonly provenance?: unknown;
}

const AT = '2026-08-11T00:00:00.000Z';

function session(slot: string, provider: string, id = 'sess-1'): unknown {
  return { shape: 'EXPERT_SESSION', expert_slot_id: slot, provider, session_id: id };
}
function target(slot: string, provider: string): unknown {
  return { shape: 'EXPERT_TARGET', target_expert_slot_id: slot, provider, session_id: null };
}
function transfer(source: string, sourceProvider: string, to: string, toProvider: string): unknown {
  return {
    shape: 'TRANSFER',
    source_slot_id: source,
    source_provider: sourceProvider,
    target_slot_id: to,
    target_provider: toProvider,
    source_event_id: 'evt_000003',
    response_event_id: 'evt_000010',
  };
}

async function thread(entries: readonly Entry[], options: Record<string, unknown> = {}): Promise<{
  root: FakeNode;
  dom: ReturnType<typeof createFakeDom>;
}> {
  const dom = createFakeDom([]);
  const markdown = (await importWeb('markdown.js')) as {
    createMarkdownContent: (options: unknown) => (markdown: string) => FakeNode;
  };
  const conversation = (await importWeb('conversation.js')) as {
    createConversationThread: (options: unknown) => (entries: unknown, options?: unknown) => FakeNode;
  };
  const build = conversation.createConversationThread({
    document: dom.document,
    markdownContent: markdown.createMarkdownContent({ lexer, document: dom.document }),
    expertName: (slot: string, provider: string) => `${slot}/${provider}`,
    eventLabel: (type: string) => `label:${type}`,
    // Rôle et moteur sont injectés séparément : le fil les place à deux rangs
    // différents, et une assertion sur la chaîne recollée ne dirait plus lequel.
    expertRole: (slot: string) => `role:${slot}`,
    actorLabel: (code: string) => `acteur:${code}`,
    formatInstant: (value: string) => `heure:${value}`,
  });
  return { root: build(entries, options), dom };
}

/** Texte du fil, dans l'ordre de rendu. */
const flat = (root: FakeNode): string => root.textContent;

// ==========================================================================
// A. Ordre et marqueurs de round
// ==========================================================================

test('1–3 · l’ordre reçu est l’ordre rendu, et le round marque au changement', async () => {
  const entries: Entry[] = [
    { event_id: 'e1', type: 'assistant_response', actor: 'expert', round: 0, timestamp: AT, content: 'AAA', provenance: session('author', 'codex') },
    { event_id: 'e2', type: 'assistant_response', actor: 'expert', round: 0, timestamp: AT, content: 'BBB', provenance: session('challenger', 'claude') },
    { event_id: 'e3', type: 'round_completed', actor: 'system', round: 1, timestamp: AT, provenance: transfer('author', 'codex', 'challenger', 'claude') },
    { event_id: 'e4', type: 'assistant_response', actor: 'expert', round: 1, timestamp: AT, content: 'CCC', provenance: session('challenger', 'claude') },
  ];
  const { root } = await thread(entries);
  const text = flat(root);

  // 1 · l'ordre du journal est conservé, tel quel.
  assert.ok(text.indexOf('AAA') < text.indexOf('BBB'), 'AAA avant BBB');
  assert.ok(text.indexOf('BBB') < text.indexOf('CCC'), 'BBB avant CCC');

  // 2 · un marqueur par changement de round, et pas un de plus.
  const markers = root.children.filter((node) => node.attributes['class'] === 'thread-round');
  assert.equal(markers.length, 2, 'round 0 puis round 1');
  assert.ok(markers[0]?.textContent.includes('0'));
  assert.ok(markers[1]?.textContent.includes('1'));

  // 3 · deux entrées d'un même round ne produisent qu'un marqueur.
  assert.equal(text.split('Round 0').length - 1, 1);
});

test('4 · des rounds non monotones sont rendus tels quels, jamais réordonnés', async () => {
  // Le journal fait autorité. S'il rend 2 puis 1, l'écran rend 2 puis 1 — et
  // c'est un fait à voir, pas une anomalie à corriger localement.
  const entries: Entry[] = [
    { event_id: 'e1', type: 'assistant_response', actor: 'expert', round: 2, timestamp: '2026-08-11T09:00:00.000Z', content: 'TARD', provenance: session('author', 'codex') },
    { event_id: 'e2', type: 'assistant_response', actor: 'expert', round: 1, timestamp: '2026-08-11T08:00:00.000Z', content: 'TOT', provenance: session('challenger', 'claude') },
  ];
  const { root } = await thread(entries);
  const text = flat(root);
  assert.ok(text.indexOf('TARD') < text.indexOf('TOT'), 'aucun tri par round ni par horodatage');
  const markers = root.children.filter((node) => node.attributes['class'] === 'thread-round');
  assert.equal(markers.length, 2);
});

// ==========================================================================
// B. Classification fermée
// ==========================================================================

test('5–9 · chaque type reçoit sa classe, sans regarder le contenu', async () => {
  const conversation = (await importWeb('conversation.js')) as {
    classifyEntry: (entry: unknown) => string;
  };
  const of = (type: string, actor = 'system'): string => conversation.classifyEntry({ type, actor });

  assert.equal(of('assistant_response', 'expert'), 'VISIBLE_CONTRIBUTION');
  assert.equal(of('human_message', 'human'), 'HUMAN_CONTRIBUTION');
  assert.equal(of('round_completed'), 'VISIBLE_TRANSFER_MARKER');
  assert.equal(of('human_handoff_started', 'human'), 'HUMAN_CONTRIBUTION');
  assert.equal(of('human_handoff_finished', 'human'), 'HUMAN_CONTRIBUTION');

  // Le seul type ambigu se lève sur l'acteur, un fait porté par l'événement.
  assert.equal(of('prompt_sent', 'human'), 'INITIAL_CONTEXT');
  assert.equal(of('prompt_sent', 'system'), 'TECHNICAL_ONLY');

  for (const type of [
    'session_created',
    'round_started',
    'process_failed',
    'transfer_blocked',
    'transfer_quarantine',
    'transfer_aborted',
    'send_aborted_before_provider',
    'type_inconnu_du_futur',
  ]) {
    assert.equal(of(type), 'TECHNICAL_ONLY', `${type} reste technique`);
  }
});

test('10–11 · un événement technique n’est jamais rendu en contribution, et reste compté', async () => {
  const entries: Entry[] = [
    { event_id: 'e1', type: 'round_started', actor: 'system', round: 1, timestamp: AT, provenance: target('challenger', 'claude') },
    { event_id: 'e2', type: 'prompt_sent', actor: 'system', round: 1, timestamp: AT, content: 'ENVELOPPE INTERNE', provenance: target('challenger', 'claude') },
    { event_id: 'e3', type: 'assistant_response', actor: 'expert', round: 1, timestamp: AT, content: 'REPONSE', provenance: session('challenger', 'claude') },
  ];
  const { root } = await thread(entries);
  const text = flat(root);

  // 10 · l'enveloppe de transfert n'est pas une contribution, et n'apparaît pas.
  assert.equal(text.includes('ENVELOPPE INTERNE'), false);
  assert.ok(text.includes('REPONSE'));
  // 11 · mais elle est comptée, à sa place chronologique. Le repère a été
  //      ramené au rang qui est le sien (V-04) : il porte le compte et la
  //      position, sans occuper une ligne pleine entre chaque message.
  assert.ok(text.includes('2 événements techniques'), text);
  const marker = root.children.find(
    (node) => node.attributes['class'] === 'thread-technical-marker',
  );
  assert.ok(marker !== undefined, 'le repère existe et porte sa propre classe');
});

// ==========================================================================
// C. Rendu des contributions
// ==========================================================================

test('12–14 · une réponse d’expert est rendue en Markdown, nommée par son rôle', async () => {
  const entries: Entry[] = [
    {
      event_id: 'e1',
      type: 'assistant_response',
      actor: 'expert',
      round: 0,
      timestamp: AT,
      content: '## Analyse\n\nUn **point** et `du code`.\n\n- a\n- b\n',
      provenance: session('author', 'codex'),
    },
  ];
  const { root, dom } = await thread(entries);

  // 12 · le rôle porte le titre, le moteur n'est qu'un attribut. Les deux sont
  //      désormais rendus séparément, et à deux rangs distincts : c'est
  //      exactement ce que cette assertion demandait.
  const article = root.children.find((node) => (node.attributes['class'] ?? '').includes('thread-entry'));
  assert.ok(article !== undefined, 'une contribution est rendue');
  const header = article.children[0];
  assert.equal(header?.tagName, 'HEADER');
  assert.equal(header?.textContent, 'role:author', 'le rang 1 ne porte QUE le rôle');
  // Le moteur descend au rang 3, attaché au message et non à son titre.
  const leadNode = article.children.find((node) => node.attributes['class'] === 'entry-lead');
  assert.ok(leadNode?.textContent.includes('acteur:codex'), leadNode?.textContent);

  // 13 · le Markdown est réellement structuré — pas un bloc de texte brut.
  const created = dom.created.map((node) => node.tagName);
  for (const tag of ['H2', 'STRONG', 'CODE', 'UL', 'LI']) {
    assert.ok(created.includes(tag), `${tag} attendu dans la contribution`);
  }
  // 14 · l'identifiant technique reste accessible, sans dominer : il descend
  //      sous la divulgation, il ne disparaît pas.
  const details = article.children.find((node) => node.tagName === 'DETAILS');
  assert.ok(details?.textContent.includes('e1'), 'l’identifiant reste consultable');
  assert.equal(header?.textContent.includes('e1'), false, 'et n’occupe plus le premier rang');
});

test('15 · same-provider : deux contributions restent distinctes par le rôle', async () => {
  const entries: Entry[] = [
    { event_id: 'e1', type: 'assistant_response', actor: 'expert', round: 0, timestamp: AT, content: 'position A', provenance: session('author', 'claude', 'S1') },
    { event_id: 'e2', type: 'assistant_response', actor: 'expert', round: 0, timestamp: AT, content: 'position B', provenance: session('challenger', 'claude', 'S2') },
  ];
  const { root } = await thread(entries);
  const text = flat(root);
  // Le moteur est identique des deux côtés : seul le rôle distingue, et il est
  // désormais le rang 1 du message. Une lecture par moteur ne pourrait pas.
  assert.ok(text.includes('role:author'));
  assert.ok(text.includes('role:challenger'));
  assert.equal(text.split('acteur:claude').length - 1, 2, 'le même moteur des deux côtés');
  assert.ok(text.indexOf('position A') < text.indexOf('position B'));
});

test('16 · un message humain est une contribution humaine, rendue en Markdown', async () => {
  const entries: Entry[] = [
    { event_id: 'e1', type: 'human_message', actor: 'human', round: 1, timestamp: AT, content: 'Précisez **le point 2**.', provenance: target('author', 'codex') },
  ];
  const { root, dom } = await thread(entries);
  assert.ok(flat(root).includes('Intervention humaine'));
  assert.ok(flat(root).includes('author/codex'));
  assert.ok(dom.created.map((node) => node.tagName).includes('STRONG'));
});

test('17 · un transfert est un marqueur, avec ses deux rôles', async () => {
  const entries: Entry[] = [
    { event_id: 'e1', type: 'round_completed', actor: 'system', round: 1, timestamp: AT, provenance: transfer('author', 'codex', 'challenger', 'claude') },
  ];
  const { root } = await thread(entries);
  const text = flat(root);
  assert.ok(text.includes('author/codex'));
  assert.ok(text.includes('challenger/claude'));
  assert.ok(text.includes('transmis'));
});

// ==========================================================================
// D. Contexte initial
// ==========================================================================

test('18–19 · le contexte initial n’est pas rendu deux fois, et rien n’est retiré', async () => {
  const entries: Entry[] = [
    { event_id: 'e1', type: 'prompt_sent', actor: 'human', round: 0, timestamp: AT, content: 'MISSION', provenance: target('author', 'codex') },
    { event_id: 'e2', type: 'prompt_sent', actor: 'human', round: 0, timestamp: AT, content: 'MISSION', provenance: target('challenger', 'claude') },
    { event_id: 'e3', type: 'assistant_response', actor: 'expert', round: 0, timestamp: AT, content: 'REPONSE', provenance: session('author', 'codex') },
  ];

  // 18 · l'en-tête a déjà rendu le contexte depuis la projection S1 : les deux
  //      prompts ne deviennent pas deux interventions humaines distinctes.
  const shown = await thread(entries, { initialContextShown: true });
  assert.equal(flat(shown.root).includes('MISSION'), false);
  // Rien n'est retiré du journal : les deux entrées sont comptées.
  assert.ok(flat(shown.root).includes('2 événements techniques'));

  // 19 · sans contexte unifié — cas d'une divergence — ils sont rendus.
  const hidden = await thread(entries, { initialContextShown: false });
  assert.equal(flat(hidden.root).split('MISSION').length - 1, 2, 'les deux faits divergents restent visibles');
});

// ==========================================================================
// E. Vide et gardes de source
// ==========================================================================

test('20 · un fil vide se dit, il ne se devine pas', async () => {
  const { root } = await thread([]);
  assert.ok(flat(root).includes('Aucune contribution'));
});

test('21–23 · gardes de source du fil', async () => {
  const raw = await readFile(new URL('conversation.js', WEB), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  // 21 · aucune reconstruction de chronologie. C'est la cible de la
  //      falsification de cette slice.
  for (const forbidden of ['.sort(', '.reverse(', 'Date.parse', 'new Date', 'localeCompare']) {
    assert.equal(code.includes(forbidden), false, `conversation.js contient ${forbidden}`);
  }
  // Ni déduplication, ni ensemble d'événements déjà vus.
  for (const forbidden of ['new Set(', 'new Map(', 'filter(', 'indexOf(']) {
    assert.equal(code.includes(forbidden), false, `conversation.js contient ${forbidden}`);
  }

  // 22 · aucun sink HTML, aucune analyse de contenu.
  for (const forbidden of ['.innerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'RegExp(', '.match(']) {
    assert.equal(code.includes(forbidden), false, `conversation.js contient ${forbidden}`);
  }

  // 23 · aucun vocabulaire de version future : pas de controverse, pas
  //      d'accord, pas de désaccord — le moteur ne les porte pas.
  for (const forbidden of ['controvers', 'Controvers', 'disagree', 'consensus', 'evidence', 'Evidence']) {
    assert.equal(code.includes(forbidden), false, `conversation.js nomme ${forbidden}`);
  }
});
