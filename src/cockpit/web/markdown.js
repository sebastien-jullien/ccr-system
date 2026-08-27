/**
 * `MarkdownContent` — rendu d'un Markdown **non fiable**, par nœuds DOM.
 *
 * ## La chaîne, et rien d'autre
 *
 * ```text
 * Markdown non fiable
 *   → lexer            arbre de jetons imbriqués
 *   → adaptation CCR   vocabulaire fermé
 *   → createElement / textContent
 *   → DOM
 * ```
 *
 * Aucune chaîne n'est jamais interprétée comme du balisage. Ce module n'emploie
 * ni `innerHTML`, ni `insertAdjacentHTML`, ni `eval`, ni aucun autre sink — et
 * il ne consomme **jamais** de sortie HTML de l'analyseur. Le renderer HTML de
 * la bibliothèque n'est pas configuré prudemment : il n'est pas appelé.
 *
 * ## Le lexer est injecté
 *
 * Ce module ne connaît pas la bibliothèque : il reçoit une fonction `lexer`. En
 * Node, les tests passent celle du paquet installé ; dans le navigateur, la
 * coquille passe celle du module servi localement. Une seule logique de rendu,
 * deux contextes de chargement — et aucune ruse de résolution de module.
 *
 * ## Vocabulaire fermé
 *
 * Chaque type de jeton connu a une correspondance directe. Un jeton `html` est
 * rendu **en texte**, jamais en DOM ; un `image` devient son texte de
 * remplacement, sans `img` ni `src` ; un type inconnu devient du texte sûr, et
 * n'est jamais ignoré en silence.
 *
 * Rien n'est ré-analysé : aucun `**`, aucun accent grave, aucune barre verticale
 * n'est cherché dans le contenu. La structure vient du lexer, une seule fois.
 */

import { safeHref, SAFE_LINK_ATTRIBUTES } from './link-safety.js';

/** Types de jetons traités comme des blocs. */
const BLOCK_TYPES = new Set([
  'heading',
  'paragraph',
  'list',
  'blockquote',
  'code',
  'table',
  'hr',
  'space',
  'html',
]);

/**
 * Fabrique un rendu Markdown lié à un document et à un lexer.
 *
 * `clipboard` est une couture : absent, aucun bouton de copie n'est proposé —
 * un bouton inerte mentirait sur ce que l'interface sait faire.
 */
export function createMarkdownContent({ lexer, document: doc, clipboard }) {
  if (typeof lexer !== 'function') throw new TypeError('createMarkdownContent : lexer requis');
  if (doc === null || typeof doc !== 'object') throw new TypeError('createMarkdownContent : document requis');

  function el(tag, options = {}) {
    const node = doc.createElement(tag);
    if (typeof options.class === 'string') node.setAttribute('class', options.class);
    if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
    return node;
  }

  /** Texte brut d'un jeton, quelle que soit la forme qu'il emploie. */
  function rawText(token) {
    if (typeof token.text === 'string') return token.text;
    if (typeof token.raw === 'string') return token.raw;
    return '';
  }

  // ---- Inline ------------------------------------------------------------

  function link(token, parent) {
    const href = safeHref(token.href);
    if (href === null) {
      // Refusé : le contenu reste lisible, il cesse d'être cliquable.
      const inert = el('span', { class: 'md-link-inert' });
      inline(token.tokens, inert, rawText(token));
      parent.appendChild(inert);
      return;
    }
    const anchor = el('a', { class: 'md-link' });
    // Unique pose d'attribut de navigation du frontend, et seulement sur une
    // valeur qui vient de `safeHref`.
    anchor.setAttribute('href', href);
    for (const [name, value] of Object.entries(SAFE_LINK_ATTRIBUTES)) anchor.setAttribute(name, value);
    inline(token.tokens, anchor, rawText(token));
    parent.appendChild(anchor);
  }

  function inline(tokens, parent, fallback = '') {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      if (fallback.length > 0) parent.appendChild(el('span', { text: fallback }));
      return;
    }
    for (const token of tokens) {
      switch (token.type) {
        case 'text':
          if (Array.isArray(token.tokens) && token.tokens.length > 0) inline(token.tokens, parent);
          else parent.appendChild(el('span', { text: rawText(token) }));
          break;
        case 'escape':
          parent.appendChild(el('span', { text: rawText(token) }));
          break;
        case 'strong': {
          const node = el('strong');
          inline(token.tokens, node, rawText(token));
          parent.appendChild(node);
          break;
        }
        case 'em': {
          const node = el('em');
          inline(token.tokens, node, rawText(token));
          parent.appendChild(node);
          break;
        }
        case 'codespan':
          parent.appendChild(el('code', { class: 'md-code-inline', text: rawText(token) }));
          break;
        case 'br':
          parent.appendChild(el('br'));
          break;
        case 'del': {
          const node = el('s');
          inline(token.tokens, node, rawText(token));
          parent.appendChild(node);
          break;
        }
        case 'link':
          link(token, parent);
          break;
        case 'image':
          // Aucune ressource distante : le cockpit est local et n'émet rien.
          parent.appendChild(
            el('span', { class: 'md-image', text: rawText(token).length > 0 ? `[image : ${rawText(token)}]` : '[image]' }),
          );
          break;
        case 'html':
          parent.appendChild(el('span', { class: 'md-raw', text: rawText(token) }));
          break;
        default:
          parent.appendChild(el('span', { class: 'md-unknown', text: rawText(token) }));
      }
    }
  }

  // ---- Blocs -------------------------------------------------------------

  function codeBlock(token) {
    const figure = el('figure', { class: 'md-code' });
    const head = el('figcaption', { class: 'md-code-head' });
    const lang = typeof token.lang === 'string' && token.lang.length > 0 ? token.lang : 'texte';
    head.appendChild(el('span', { class: 'md-code-lang', text: lang }));
    if (clipboard !== undefined && clipboard !== null) {
      const button = el('button', { class: 'md-copy', text: 'Copier' });
      button.setAttribute('type', 'button');
      button.setAttribute('aria-label', `Copier le bloc de code ${lang}`);
      button.addEventListener('click', () => {
        // Échec local et explicite : le bouton dit lui-même ce qui s'est passé.
        Promise.resolve()
          .then(() => clipboard.writeText(rawText(token)))
          .then(
            () => {
              button.textContent = 'Copié';
            },
            () => {
              button.textContent = 'Copie impossible';
            },
          );
      });
      head.appendChild(button);
    }
    figure.appendChild(head);
    const pre = el('pre', { class: 'md-pre' });
    pre.appendChild(el('code', { text: rawText(token) }));
    figure.appendChild(pre);
    return figure;
  }

  function table(token) {
    const wrapper = el('div', { class: 'md-table-scroll' });
    const node = el('table', { class: 'md-table' });
    const head = el('thead');
    const headRow = el('tr');
    for (const cell of token.header ?? []) {
      const th = el('th');
      inline(cell.tokens, th, typeof cell.text === 'string' ? cell.text : '');
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    node.appendChild(head);

    const body = el('tbody');
    for (const row of token.rows ?? []) {
      const tr = el('tr');
      for (const cell of row) {
        const td = el('td');
        inline(cell.tokens, td, typeof cell.text === 'string' ? cell.text : '');
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    node.appendChild(body);
    wrapper.appendChild(node);
    return wrapper;
  }

  function list(token) {
    const node = el(token.ordered === true ? 'ol' : 'ul', { class: 'md-list' });
    for (const item of token.items ?? []) {
      const li = el('li');
      for (const child of item.tokens ?? []) {
        if (BLOCK_TYPES.has(child.type)) {
          const rendered = block(child);
          if (rendered !== null) li.appendChild(rendered);
        } else {
          inline([child], li);
        }
      }
      node.appendChild(li);
    }
    return node;
  }

  function block(token) {
    switch (token.type) {
      case 'space':
        return null;
      case 'heading': {
        const level = Number.isInteger(token.depth) ? Math.min(Math.max(token.depth, 1), 6) : 1;
        const node = el(`h${String(level)}`, { class: 'md-heading' });
        inline(token.tokens, node, rawText(token));
        return node;
      }
      case 'paragraph': {
        const node = el('p', { class: 'md-paragraph' });
        inline(token.tokens, node, rawText(token));
        return node;
      }
      case 'blockquote': {
        const node = el('blockquote', { class: 'md-quote' });
        for (const child of token.tokens ?? []) {
          const rendered = block(child);
          if (rendered !== null) node.appendChild(rendered);
        }
        return node;
      }
      case 'list':
        return list(token);
      case 'code':
        return codeBlock(token);
      case 'table':
        return table(token);
      case 'hr':
        return el('hr', { class: 'md-rule' });
      case 'html':
        // Le balisage brut est du texte. Il s'affiche, il ne s'exécute pas.
        return el('pre', { class: 'md-raw', text: rawText(token) });
      default: {
        const node = el('p', { class: 'md-unknown' });
        inline(token.tokens, node, rawText(token));
        return node;
      }
    }
  }

  /**
   * Rend un Markdown en un nœud unique.
   *
   * Le contenu est **intégral** : rien n'est résumé, rien n'est tronqué. Un
   * texte vide rend un conteneur vide plutôt qu'un silence ambigu.
   */
  return function markdownContent(markdown) {
    const root = el('div', { class: 'md' });
    if (typeof markdown !== 'string' || markdown.length === 0) return root;
    for (const token of lexer(markdown)) {
      const rendered = block(token);
      if (rendered !== null) root.appendChild(rendered);
    }
    return root;
  };
}
