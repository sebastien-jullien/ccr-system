/**
 * V2.3-S2 — `MarkdownContent`, liens sûrs, fondation d'interface.
 *
 * Question de preuve unique :
 *
 * > **Peut-on rendre du Markdown non fiable sans jamais introduire de chaîne
 * > HTML exécutable ?**
 *
 * Trois familles de preuves.
 *
 *  1. **Rendu réel** — l'adaptateur de production tourne sur un DOM factice qui
 *     n'expose aucun sink HTML. Ce qui n'est pas un nœud créé explicitement
 *     n'existe pas.
 *  2. **Sécurité** — script, `javascript:`, faux HTML, ressources distantes, et
 *     la matrice complète des protocoles refusés.
 *  3. **Garde structurelle** — tout `href` créé doit resurvivre à `safeHref`.
 *     C'est elle qui meurt si quelqu'un contourne la primitive.
 *
 * Le lexer est celui du paquet installé : les tests éprouvent la vraie forme de
 * jetons, jamais une imitation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lexer } from 'marked';

import { createFakeDom } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);

const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

type Rendered = { readonly root: FakeNode; readonly dom: ReturnType<typeof createFakeDom> };

interface Clipboard {
  readonly writes: string[];
  writeText(text: string): Promise<void>;
}

function clipboardOf(fail = false): Clipboard {
  const writes: string[] = [];
  return {
    writes,
    writeText(text: string): Promise<void> {
      if (fail) return Promise.reject(new Error('refusé'));
      writes.push(text);
      return Promise.resolve();
    },
  };
}

async function render(markdown: string, clipboard?: Clipboard): Promise<Rendered> {
  const dom = createFakeDom([]);
  const module = (await importWeb('markdown.js')) as {
    createMarkdownContent: (options: unknown) => (markdown: string) => FakeNode;
  };
  const content = module.createMarkdownContent({
    lexer,
    document: dom.document,
    ...(clipboard === undefined ? {} : { clipboard }),
  });
  return { root: content(markdown), dom };
}

const tags = (dom: Rendered['dom']): string[] => dom.created.map((node) => node.tagName);

async function safeHrefOf(): Promise<(raw: unknown) => string | null> {
  const module = (await importWeb('link-safety.js')) as { safeHref: (raw: unknown) => string | null };
  return module.safeHref;
}

// ==========================================================================
// A. Structure — le contrat de syntaxe
// ==========================================================================

test('1–6 · titres, paragraphes, emphase, listes, citation, code, tableau, règle', async () => {
  const { root, dom } = await render(
    [
      '# Un',
      '',
      '###### Six',
      '',
      'para **fort** et *doux* et `bref`.',
      '',
      '- a',
      '- b',
      '  - imbriqué',
      '',
      '1. un',
      '2. deux',
      '',
      '> cité',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '---',
      '',
    ].join('\n'),
  );

  const created = tags(dom);
  // 1 · les six niveaux de titre sont possibles, et bornés.
  assert.ok(created.includes('H1'));
  assert.ok(created.includes('H6'));
  // 2 · emphase et code en ligne portent leurs balises sémantiques.
  for (const tag of ['P', 'STRONG', 'EM', 'CODE', 'BLOCKQUOTE', 'HR']) {
    assert.ok(created.includes(tag), `${tag} attendu`);
  }
  // 3 · listes ordonnées, non ordonnées, et imbriquées.
  assert.ok(created.includes('UL'));
  assert.ok(created.includes('OL'));
  assert.ok(created.filter((tag) => tag === 'UL').length >= 2, 'la liste imbriquée existe');
  assert.ok(created.includes('LI'));
  // 4 · le bloc de code porte son langage déclaré.
  assert.ok(created.includes('PRE'));
  assert.ok(root.textContent.includes('ts'), 'le langage est annoncé');
  assert.ok(root.textContent.includes('const x = 1;'));
  // 5 · le tableau a un en-tête et un corps, dans un conteneur défilable.
  for (const tag of ['TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']) {
    assert.ok(created.includes(tag), `${tag} attendu`);
  }
  const scroll = dom.created.filter((node) => node.attributes['class'] === 'md-table-scroll');
  assert.equal(scroll.length, 1, 'le débordement reste dans son conteneur');
  // 6 · le contenu est intégral : rien n'est résumé ni tronqué.
  for (const fragment of ['Un', 'Six', 'fort', 'doux', 'bref', 'imbriqué', 'cité', 'deux']) {
    assert.ok(root.textContent.includes(fragment), `${fragment} conservé`);
  }
});

test('7 · un contenu vide ou non textuel rend un conteneur vide, jamais une erreur', async () => {
  for (const input of ['', '   ']) {
    const { root } = await render(input);
    assert.equal(root.tagName, 'DIV');
    assert.equal(root.textContent.trim(), '');
  }
});

// ==========================================================================
// B. Sécurité — les quatre cas obligatoires
// ==========================================================================

test('8 · (A) un script Markdown ne devient jamais un script DOM', async () => {
  delete (globalThis as Record<string, unknown>)['PWNED'];
  const payload = '<script>globalThis.PWNED = true</script>';
  const { root, dom } = await render(`Avant\n\n${payload}\n\nAprès`);

  assert.equal(tags(dom).includes('SCRIPT'), false, 'aucun nœud script créé');
  assert.equal((globalThis as Record<string, unknown>)['PWNED'], undefined, 'rien n’a été exécuté');
  // Le payload reste visible — lisible et inoffensif.
  assert.ok(root.textContent.includes('globalThis.PWNED = true'), 'affiché tel quel');
  assert.ok(root.textContent.includes('Avant') && root.textContent.includes('Après'));
});

test('9 · (B) un lien javascript: n’est jamais cliquable', async () => {
  const { root, dom } = await render('[attaque](javascript:alert(1))');
  const anchors = dom.created.filter((node) => node.tagName === 'A');
  assert.equal(anchors.length, 0, 'aucun lien créé pour un protocole refusé');
  assert.ok(root.textContent.includes('attaque'), 'le contenu reste visible');
  for (const node of dom.created) {
    assert.equal('href' in node.attributes, false);
  }
});

test('10 · (C) un lien https passe par le seam autorisé, avec ses trois attributs', async () => {
  const { dom } = await render('[docs](https://example.com/path?q=1)');
  const anchors = dom.created.filter((node) => node.tagName === 'A');
  assert.equal(anchors.length, 1);
  const anchor = anchors[0] as FakeNode;
  const safeHref = await safeHrefOf();
  assert.equal(anchor.attributes['href'], safeHref('https://example.com/path?q=1'));
  assert.equal(anchor.attributes['target'], '_blank');
  assert.equal(anchor.attributes['rel'], 'noopener noreferrer');
  assert.equal(anchor.attributes['referrerpolicy'], 'no-referrer');
  assert.ok(anchor.textContent.includes('docs'));
});

test('11 · (D) un faux HTML complexe ne produit ni DOM arbitraire ni ressource distante', async () => {
  const { root, dom } = await render(
    '<div onclick="globalThis.PWNED=true"><img src="https://ailleurs.example/pixel.png"></div>',
  );

  const created = tags(dom);
  for (const forbidden of ['IMG', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'LINK', 'STYLE', 'SCRIPT']) {
    assert.equal(created.includes(forbidden), false, `${forbidden} interdit`);
  }
  for (const node of dom.created) {
    for (const [name, value] of Object.entries(node.attributes)) {
      assert.equal(/^on/i.test(name), false, `attribut événementiel : ${name}`);
      assert.equal(['src', 'action', 'formaction', 'data', 'srcdoc'].includes(name.toLowerCase()), false);
      assert.equal(value.includes('javascript:'), false);
    }
  }
  // Le balisage est affiché comme texte, jamais interprété.
  assert.ok(root.textContent.includes('onclick'), 'le balisage brut reste lisible');
});

test('12 · une image Markdown devient un texte de remplacement, sans img ni src', async () => {
  const { root, dom } = await render('![une figure](https://ailleurs.example/i.png)');
  assert.equal(tags(dom).includes('IMG'), false);
  assert.ok(root.textContent.includes('une figure'));
  for (const node of dom.created) assert.equal('src' in node.attributes, false);
});

// ==========================================================================
// C. `safeHref` — la règle, protocole par protocole
// ==========================================================================

test('13–14 · seuls http et https survivent à safeHref', async () => {
  const safeHref = await safeHrefOf();

  // 13 · acceptés, et normalisés par une analyse d'URL réelle.
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('http://example.com'), 'http://example.com/');
  assert.equal(safeHref('  https://example.com/b  '), 'https://example.com/b');

  // 14 · refusés — protocoles, formes relatives, entrées non textuelles.
  const refused = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'mailto:a@b.c',
    'vbscript:msgbox(1)',
    'blob:https://example.com/x',
    '/api/runs',
    './relatif',
    '//example.com/protocole-relatif',
    '',
    '   ',
  ];
  for (const raw of refused) {
    assert.equal(safeHref(raw), null, `refusé : ${JSON.stringify(raw)}`);
  }
  for (const raw of [null, undefined, 42, {}]) {
    assert.equal(safeHref(raw), null, 'une entrée non textuelle est refusée');
  }
});

test('15 · les protocoles refusés ne produisent aucun lien, un par un', async () => {
  for (const scheme of ['data:text/html,x', 'file:///c/x', 'mailto:a@b.c', '/local', '//example.com']) {
    const { dom, root } = await render(`[texte](${scheme})`);
    assert.equal(
      dom.created.filter((node) => node.tagName === 'A').length,
      0,
      `aucun lien pour ${scheme}`,
    );
    assert.ok(root.textContent.includes('texte'));
  }
});

// ==========================================================================
// D. Garde structurelle — la cible de la falsification
// ==========================================================================

test('16 · tout href créé resurvit à safeHref', async () => {
  const safeHref = await safeHrefOf();
  const corpus = [
    '[a](https://example.com/ok)',
    '[b](javascript:alert(1))',
    '[c](data:text/html,x)',
    '[d](//example.com)',
    '[e](/interne)',
    '<a href="javascript:alert(1)">brut</a>',
    '![f](https://example.com/i.png)',
    'https://autolien.example/page',
  ].join('\n\n');

  const { dom } = await render(corpus);
  let anchors = 0;
  for (const node of dom.created) {
    const href = node.attributes['href'];
    if (href === undefined) continue;
    anchors += 1;
    // La propriété centrale : un href posé est un href que safeHref rendrait
    // à l'identique. Contourner la primitive tue cette assertion.
    assert.equal(safeHref(href), href, `href non validé : ${href}`);
    assert.equal(node.tagName, 'A', 'seul un lien porte une destination');
    assert.equal(node.attributes['rel'], 'noopener noreferrer');
  }
  assert.ok(anchors >= 1, 'le corpus contient au moins un lien légitime');
});

test('17 · gardes de source du chemin Markdown', async () => {
  const read = async (name: string): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(new URL(name, WEB), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  const markdown = await read('markdown.js');
  const safety = await read('link-safety.js');

  // Aucun sink, et aucun usage du renderer HTML de la bibliothèque.
  for (const sink of [
    '.innerHTML',
    '.outerHTML',
    'insertAdjacentHTML',
    'document.write',
    'eval(',
    'new Function',
    'createContextualFragment',
    'marked.parse',
    'marked.parser',
    'Renderer',
  ]) {
    assert.equal(markdown.includes(sink), false, `markdown.js contient ${sink}`);
    assert.equal(safety.includes(sink), false, `link-safety.js contient ${sink}`);
  }

  // Le module de rendu n'importe pas la bibliothèque : le lexer lui est fourni.
  assert.equal(markdown.includes("from 'marked'"), false, 'le lexer est injecté, jamais importé');
  assert.ok(markdown.includes("from './link-safety.js'"), 'la validation vient de la primitive');

  // Aucune ré-analyse des marqueurs Markdown : la structure vient du lexer.
  for (const remnant of ['**', '```', 'split(\'|\')', 'RegExp(']) {
    assert.equal(markdown.includes(remnant), false, `markdown.js ré-analyse ${remnant}`);
  }

  // `safeHref` est le seul producteur d'URL, et n'est employé que sur un lien.
  assert.equal((markdown.match(/setAttribute\('href'/g) ?? []).length, 1, 'une seule pose de href');
  assert.ok(markdown.includes('safeHref('), 'la pose est précédée de la validation');
  assert.equal((safety.match(/protocol !== 'http:'/g) ?? []).length, 1);
});

// ==========================================================================
// E. Copie d'un bloc de code
// ==========================================================================

test('18–19 · le bouton de copie écrit le code, et dit son échec', async () => {
  const clipboard = clipboardOf();
  const { dom } = await render('```js\nconst a = 1;\n```', clipboard);
  const buttons = dom.created.filter((node) => node.tagName === 'BUTTON');
  assert.equal(buttons.length, 1);
  const button = buttons[0] as FakeNode;
  assert.equal(button.attributes['type'], 'button');
  assert.ok(String(button.attributes['aria-label']).length > 0, 'le bouton est nommé');

  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clipboard.writes, ['const a = 1;'], 'le code exact est copié');
  assert.equal(button.textContent, 'Copié');

  // 19 · un presse-papiers qui refuse le dit sur place, sans infrastructure.
  const failing = clipboardOf(true);
  const second = await render('```\nx\n```', failing);
  const failingButton = second.dom.created.filter((node) => node.tagName === 'BUTTON')[0] as FakeNode;
  failingButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failingButton.textContent, 'Copie impossible');
});

test('20 · sans presse-papiers, aucun bouton inerte n’est proposé', async () => {
  const { dom } = await render('```\nx\n```');
  assert.equal(dom.created.filter((node) => node.tagName === 'BUTTON').length, 0);
});

// ==========================================================================
// F. Livraison au navigateur
// ==========================================================================

test('21–22 · les trois modules du rendu sont servis depuis l’origine locale', async () => {
  const { COCKPIT_ASSETS, loadCockpitAsset } = await import('../../src/cockpit/assets.ts');

  for (const route of ['/assets/markdown.js', '/assets/link-safety.js', '/assets/vendor/marked.esm.js']) {
    const asset = COCKPIT_ASSETS.get(route);
    assert.ok(asset !== undefined, `${route} déclaré`);
    const loaded = await loadCockpitAsset(route);
    assert.ok(loaded !== undefined, `${route} servi`);
    assert.equal(loaded.contentType, 'text/javascript; charset=utf-8');
    assert.ok(loaded.body.length > 0);
  }

  // 22 · le module tiers est autonome : aucun import à résoudre, donc ni import
  //      map, ni bundler, ni CDN.
  const marked = await loadCockpitAsset('/assets/vendor/marked.esm.js');
  assert.ok(marked !== undefined);
  assert.equal(/^\s*import\s/m.test(marked.body), false, 'aucun import à résoudre');
  assert.ok(marked.body.includes('as lexer'), 'le lexer est exporté');

  // Aucune route générique : une route inconnue reste inconnue.
  for (const route of ['/assets/vendor/', '/assets/vendor/../../package.json', '/assets/marked.esm.js']) {
    assert.equal(await loadCockpitAsset(route), undefined, `${route} refusé`);
  }
});
