/**
 * V2.3-S5P1 — navigateur de runs et espace de création.
 *
 * Question de preuve :
 *
 * > **La coquille peut-elle devenir scalable et la création devenir un vrai
 * > espace de travail, sans changer aucune vérité CCR ?**
 *
 * Trois propriétés.
 *
 *  1. **Filtrer n'est pas trier.** La recherche masque des runs déjà reçus et
 *     conserve strictement l'ordre du serveur.
 *  2. **Cent runs ne font pas grandir l'application.** La liste défile dans sa
 *     propre zone ; le panneau principal ne bouge pas.
 *  3. **La création n'invente rien.** Six champs, le zéro préservé, et l'effet
 *     de START toujours issu du transport.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';
import { operationEffect } from '../../src/services/invocation-effect.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

type View = Record<string, (...args: unknown[]) => void>;

const textOf = (node: FakeNode | null): string => (node === null ? '' : node.textContent);

function summary(index: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: `CCR-2026081${String(index % 10)}-${String(index).padStart(3, '0')}`,
    generation: 'NATIVE_V21_EXECUTION',
    title: `Contre-expertise ${String(index)}`,
    state: 'READY',
    control: 'AUTOMATION',
    round: index % 5,
    active_agent: null,
    active_expert_slot: null,
    created_at: '2026-08-11T00:00:00.000Z',
    updated_at: '2026-08-11T00:00:00.000Z',
    runtime_pinned: true,
    attention: 'NONE',
    unreadable: false,
    ...over,
  };
}

async function shell(handlers: Record<string, unknown> = {}): Promise<{
  dom: ReturnType<typeof createFakeDom>;
  view: View;
}> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  return { dom, view: createDomView(dom.document, handlers) };
}

const items = (dom: ReturnType<typeof createFakeDom>): FakeNode[] => {
  const list = dom.document.getElementById('runs-list');
  return list === null ? [] : list.children.map((li) => li.children[0] as FakeNode);
};
const names = (dom: ReturnType<typeof createFakeDom>): string[] =>
  items(dom).map((button) => textOf(button.children[0] ?? null));

function search(dom: ReturnType<typeof createFakeDom>, value: string): void {
  const field = dom.document.getElementById('runs-search');
  assert.ok(field !== null, 'le champ de recherche existe');
  if (field === null) return;
  field.value = value;
  for (const handler of field.listeners['input'] ?? []) handler();
}

// ==========================================================================
// A. Échelle
// ==========================================================================

test('1–3 · 4, 20 puis 100 runs restent navigables et dans l’ordre reçu', async () => {
  for (const count of [4, 20, 100]) {
    const { dom, view } = await shell();
    const runs = Array.from({ length: count }, (_, index) => summary(index));
    view['showRuns']?.(runs, null);

    const rendered = items(dom);
    assert.equal(rendered.length, count, `${String(count)} runs rendus`);
    // L'ordre d'entrée est l'ordre de sortie, sans exception.
    assert.deepEqual(names(dom), runs.map((run) => run.title));
    assert.ok(textOf(dom.document.getElementById('runs-status')).includes(String(count)));
  }
});

test('4 · le titre prime, l’identifiant reste au second rang', async () => {
  const { dom, view } = await shell();
  view['showRuns']?.([summary(1, { title: 'Refonte du cockpit' })], null);
  const button = items(dom)[0] as FakeNode;

  assert.equal(textOf(button.children[0] ?? null), 'Refonte du cockpit', 'le nom vient en premier');
  const identity = button.children[button.children.length - 1] as FakeNode;
  assert.ok(identity.textContent.startsWith('CCR-'), 'l’identifiant est le dernier élément');
  assert.equal(identity.attributes['class'], 'run-id');
});

test('5 · sans titre, l’identifiant prend sa place et le dit — aucun titre fabriqué', async () => {
  const { dom, view } = await shell();
  view['showRuns']?.([summary(2, { title: null })], null);
  const button = items(dom)[0] as FakeNode;
  assert.ok(textOf(button.children[0] ?? null).startsWith('CCR-'));
  assert.ok(button.textContent.includes('titre indisponible'));
});

// ==========================================================================
// B. Recherche
// ==========================================================================

test('6–9 · la recherche filtre, ne trie jamais, et dit quand rien ne correspond', async () => {
  const { dom, view } = await shell();
  const runs = [
    summary(1, { run_id: 'CCR-A', title: 'Alpha' }),
    summary(2, { run_id: 'CCR-B', title: 'Beta' }),
    summary(3, { run_id: 'CCR-C', title: 'Gamma' }),
    summary(4, { run_id: 'CCR-D', title: 'Beta bis' }),
  ];
  view['showRuns']?.(runs, null);
  assert.deepEqual(names(dom), ['Alpha', 'Beta', 'Gamma', 'Beta bis']);

  // 6 · filtre par titre — l'ordre relatif d'origine est conservé.
  search(dom, 'beta');
  assert.deepEqual(names(dom), ['Beta', 'Beta bis'], 'B puis D, jamais D puis B');

  // 7 · filtre par identifiant.
  search(dom, 'CCR-C');
  assert.deepEqual(names(dom), ['Gamma']);

  // 8 · aucun résultat : l'état vide est explicite et cite la recherche.
  search(dom, 'zzz');
  assert.equal(items(dom).length, 0);
  const status = textOf(dom.document.getElementById('runs-status'));
  assert.ok(status.includes('Aucun run ne correspond'));
  assert.ok(status.includes('zzz'));

  // 9 · vider la recherche restitue la liste entière, dans le même ordre.
  search(dom, '');
  assert.deepEqual(names(dom), ['Alpha', 'Beta', 'Gamma', 'Beta bis']);
});

test('10 · un run sélectionné masqué par la recherche n’est pas désélectionné', async () => {
  const selected: string[] = [];
  const { dom, view } = await shell({ onSelectRun: (id: string) => selected.push(id) });
  view['showRuns']?.([summary(1, { run_id: 'CCR-A', title: 'Alpha' }), summary(2, { run_id: 'CCR-B', title: 'Beta' })], 'CCR-A');
  assert.equal((items(dom)[0] as FakeNode).attributes['aria-current'], 'true');

  search(dom, 'beta');
  assert.deepEqual(names(dom), ['Beta']);
  assert.deepEqual(selected, [], 'masquer n’est pas choisir un autre run');
});

test('11 · la sélection ne repose pas sur la seule couleur', async () => {
  const { dom, view } = await shell();
  view['showRuns']?.([summary(1, { run_id: 'CCR-A', title: 'Alpha' })], 'CCR-A');
  const button = items(dom)[0] as FakeNode;
  assert.equal(button.attributes['aria-current'], 'true');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.ok(String(button.attributes['class']).includes('is-selected'));
  assert.ok(button.textContent.includes('sélectionné'), 'un mot, pas seulement une teinte');
});

// ==========================================================================
// C. Coquille et création
// ==========================================================================

test('12–13 · la sidebar ne contient plus le formulaire, et la création vit dans le panneau principal', async () => {
  const html = await readFile(new URL('index.html', WEB), 'utf8');
  const navStart = html.indexOf('<nav id="runs-panel"');
  const sidebar = html.slice(navStart, html.indexOf('</nav>', navStart));
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));

  // 12 · le navigateur ne porte que ce qui sert à naviguer.
  for (const field of ['start-title', 'start-prompt', 'start-workspace', 'start-author', 'start-challenger', 'start-max-invocations', 'start-submit']) {
    assert.equal(sidebar.includes(field), false, `${field} ne doit plus vivre dans la sidebar`);
  }
  assert.ok(sidebar.includes('open-new-run'), 'l’entrée de création reste dans le navigateur');
  assert.ok(sidebar.includes('runs-search'));

  // 13 · les six champs vivent dans le panneau principal, plus l'annulation.
  for (const field of ['start-title', 'start-prompt', 'start-workspace', 'start-author', 'start-challenger', 'start-max-invocations', 'start-cancel', 'start-summary']) {
    assert.ok(main.includes(field), `${field} attendu dans le panneau principal`);
  }
  // Le contexte initial dispose d'une vraie zone éditoriale.
  assert.ok(/id="start-prompt"[^>]*rows="1\d"/.test(main), 'le contexte initial est éditorial');
});

test('14–16 · le formulaire conserve exactement les six champs, et le zéro', async () => {
  const payloads: Record<string, unknown>[] = [];
  const { dom, view } = await shell({ onCreateRun: (payload: Record<string, unknown>) => payloads.push(payload) });
  const set = (id: string, value: string): void => {
    const node = dom.document.getElementById(id);
    if (node !== null) node.value = value;
  };
  // Depuis A-N-P2-01, une soumission gèle le formulaire jusqu'à son issue :
  // chaque soumission de ce test est une demande distincte, et l'issue est
  // rendue entre deux comme le fait la production.
  const submit = (): void => {
    dom.document.getElementById('start-submit')?.click();
    view['showStartFailed']?.({ code: 'INTERNAL_ERROR', message: 'issue simulée', retryable: false }, undefined);
  };

  set('start-title', 'Sujet');
  set('start-workspace', 'E:/prog/x');
  set('start-prompt', 'Contexte');
  submit();
  assert.deepEqual(payloads[0], { title: 'Sujet', workspace_cwd: 'E:/prog/x', prompt: 'Contexte' });

  // 15 · same-provider accepté, et les deux rôles restent nommés.
  set('start-author', 'claude');
  set('start-challenger', 'claude');
  submit();
  assert.equal(payloads[1]?.['author_provider'], 'claude');
  assert.equal(payloads[1]?.['challenger_provider'], 'claude');

  // 16 · zéro est une limite, pas une absence.
  set('start-max-invocations', '0');
  submit();
  assert.equal(payloads[2]?.['max_invocations'], 0);
  set('start-max-invocations', '');
  submit();
  assert.equal('max_invocations' in (payloads[3] ?? {}), false);

  for (const payload of payloads) {
    for (const key of Object.keys(payload)) {
      assert.ok(
        ['title', 'workspace_cwd', 'prompt', 'author_provider', 'challenger_provider', 'max_invocations'].includes(key),
        `champ inventé : ${key}`,
      );
    }
  }
});

test('17 · le récapitulatif suit les sélections et l’effet transporté', async () => {
  const { dom, view } = await shell();
  view['showStartEffect']?.(operationEffect('START'));
  const select = (id: string, value: string): void => {
    const node = dom.document.getElementById(id);
    if (node === null) return;
    node.value = value;
    for (const handler of node.listeners['change'] ?? []) handler();
  };
  const summaryText = (): string => textOf(dom.document.getElementById('start-summary'));

  select('start-author', 'claude');
  select('start-challenger', 'claude');
  assert.ok(summaryText().includes('Auteur : Claude'));
  assert.ok(summaryText().includes('Challenger : Claude'));
  assert.ok(summaryText().includes('jusqu’à 2 invocations CCR'));

  // Sans transport, aucun chiffre n'est inventé.
  view['showStartEffect']?.(null);
  assert.ok(summaryText().includes('non transporté'));
  assert.equal(summaryText().includes('2 invocations'), false);
});

// ==========================================================================
// D. Gardes de source
// ==========================================================================

test('18 · le chemin de liste ne trie ni ne réordonne', async () => {
  const raw = await readFile(new URL('render.js', WEB), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const start = code.indexOf('showRuns(runs, selectedId)');
  const end = code.indexOf('showRunsError');
  assert.ok(start >= 0 && end > start);
  const region = code.slice(start, end);

  for (const forbidden of ['.sort(', '.reverse(', 'localeCompare', 'onSelectRun']) {
    assert.equal(region.includes(forbidden), false, `le rendu de liste contient ${forbidden}`);
  }
  assert.ok(region.includes('.filter('), 'le filtre masque, il ne réordonne pas');

  // Aucune requête n'est émise par la recherche.
  const searchStart = code.indexOf('if (nodes.runsSearch !== null)');
  const searchRegion = code.slice(searchStart, searchStart + 600);
  assert.ok(searchStart >= 0);
  for (const forbidden of ['fetch(', 'api.', 'listRuns']) {
    assert.equal(searchRegion.includes(forbidden), false, `la recherche appelle ${forbidden}`);
  }
});

test('19 · le mode de coquille est local, et ne devient jamais un état de run', async () => {
  const raw = await readFile(new URL('app.js', WEB), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  assert.ok(code.includes("mainMode = 'NEW_RUN'"));
  assert.ok(code.includes("mainMode = 'RUN_SELECTED'"));
  // Aucun mode n'est envoyé au serveur ni mêlé à l'état d'un run.
  for (const forbidden of ['state.mainMode', 'mode:', 'api.setMode']) {
    assert.equal(code.includes(forbidden), false, `le mode fuit vers ${forbidden}`);
  }
});
