/**
 * DOM factice minimal — juste assez pour exécuter la vue réelle du cockpit.
 *
 * Il n'imite pas un navigateur : il fournit exactement les primitives que
 * `render.js` utilise, et **rien d'autre**. C'est délibéré. Un faux DOM riche
 * accepterait `innerHTML` et laisserait passer la faute qu'on cherche à
 * interdire ; celui-ci ne connaît que `textContent`, `createElement`,
 * `setAttribute` et l'insertion de nœuds. Une régression vers un sink HTML y
 * échouerait immédiatement, faute d'API pour l'exprimer.
 *
 * La preuve de rendu réelle reste le navigateur ; ce module sert à éprouver de
 * façon déterministe ce qu'un navigateur rendrait coûteux à observer.
 */

export interface FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[];
  readonly attributes: Record<string, string>;
  readonly listeners: Record<string, (() => void)[]>;
  parentNode: FakeNode | null;
  ownText: string;
  textContent: string;
  /** Valeur de saisie. Absente du vrai DOM sur les nœuds non éditables. */
  value?: string;
  /**
   * Désarmement d'un contrôle. Le rendu l'écrit réellement — sur les boutons de
   * geste comme sur les champs de création gelés pendant une opération — et le
   * faux DOM doit donc pouvoir le porter, faute de quoi une garde d'interface
   * serait exercée à l'exécution sans jamais être vérifiable au typage.
   */
  disabled?: boolean;
  /**
   * État d'une case à cocher. Le sélecteur de provenance l'écrit réellement —
   * il réaffiche une sélection durable lorsque le filtre technique reconstruit
   * la liste — et le faux DOM doit donc pouvoir le porter.
   */
  checked?: boolean;
  readonly firstChild: FakeNode | null;
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): FakeNode;
  insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, handler: () => void): void;
  click(): void;
}

export interface FakeDocument {
  createElement(tag: string): FakeNode;
  getElementById(id: string): FakeNode | null;
  readonly body: FakeNode;
}

function createNode(tag: string, register: (node: FakeNode) => void): FakeNode {
  const node: FakeNode = {
    tagName: tag.toUpperCase(),
    children: [],
    attributes: {},
    listeners: {},
    parentNode: null,
    ownText: '',
    get textContent(): string {
      return this.ownText + this.children.map((child) => child.textContent).join('');
    },
    set textContent(value: string) {
      this.children.length = 0;
      this.ownText = value;
    },
    get firstChild(): FakeNode | null {
      return this.children[0] ?? null;
    },
    appendChild(child: FakeNode): FakeNode {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child: FakeNode): FakeNode {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
      const index = reference === null ? this.children.length : this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      child.parentNode = this;
      return child;
    },
    setAttribute(name: string, value: string): void {
      this.attributes[name] = value;
      if (name === 'id') register(this);
    },
    removeAttribute(name: string): void {
      delete this.attributes[name];
    },
    addEventListener(type: string, handler: () => void): void {
      (this.listeners[type] ??= []).push(handler);
    },
    click(): void {
      for (const handler of this.listeners['click'] ?? []) handler();
    },
  };
  return node;
}

export interface FakeDom {
  readonly document: FakeDocument;
  /** Tous les nœuds créés, dans l'ordre de création. */
  readonly created: readonly FakeNode[];
  find(predicate: (node: FakeNode) => boolean): FakeNode[];
  text(): string;
}

/** `ids` : identifiants du shell que la vue va chercher. */
export function createFakeDom(ids: readonly string[]): FakeDom {
  const created: FakeNode[] = [];
  const byId = new Map<string, FakeNode>();

  const register = (node: FakeNode): void => {
    const id = node.attributes['id'];
    if (id !== undefined) byId.set(id, node);
  };

  const document: FakeDocument = {
    createElement(tag: string): FakeNode {
      const node = createNode(tag, register);
      created.push(node);
      return node;
    },
    getElementById(id: string): FakeNode | null {
      return byId.get(id) ?? null;
    },
    get body(): FakeNode {
      return root;
    },
  };

  const root = createNode('body', register);
  for (const id of ids) {
    const node = createNode('div', register);
    node.setAttribute('id', id);
    root.appendChild(node);
  }

  return {
    document,
    created,
    find(predicate) {
      const found: FakeNode[] = [];
      const walk = (node: FakeNode): void => {
        if (predicate(node)) found.push(node);
        for (const child of node.children) walk(child);
      };
      walk(root);
      return found;
    },
    text() {
      return root.textContent;
    },
  };
}

/** Identifiants réellement présents dans le shell `index.html`. */
export const SHELL_IDS = [
  'banner',
  'runs-status',
  'runs-list',
  'run-panel',
  'run-title',
  'run-status',
  'section-overview',
  'section-timeline',
  'section-recovery',
  'recovery-status',
  'recovery-body',
  // Les faits techniques du run vivent sous « État & reprise » ; le Dossier
  // (`section-runtime`) ne porte plus que les objets de débat.
  'run-facts',
  'section-runtime',
  'doctor-status',
  'doctor-body',
  'config-status',
  'config-body',
  'empty-detail',
  'start-status',
  'start-title',
  'start-workspace',
  // V2.3-S5P1 : le navigateur porte son entrée de création et sa recherche.
  'runs-panel',
  'open-new-run',
  'runs-search',
  'newrun-panel',
  'start-cancel',
  'toggle-runs',
  // V2.3-S4 : la création expose les six champs que l'API accepte déjà.
  'start-author',
  'start-challenger',
  'start-max-invocations',
  'start-summary',
  'start-prompt',
  'start-submit',
] as const;
