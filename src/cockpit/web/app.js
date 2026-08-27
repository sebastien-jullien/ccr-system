/**
 * Amorçage du cockpit dans le navigateur.
 *
 * Ce fichier ne contient que du câblage : il assemble le client HTTP, la vue
 * DOM et l'orchestration, puis branche les interactions. Toute la logique
 * testable vit dans `cockpit.js` et `render.js`, qui sont importables hors
 * navigateur — ce module est le seul qui touche `document` au chargement.
 *
 * Aucun rafraîchissement périodique **de la vue** n'est installé : ni
 * `setInterval` global, ni long polling. Depuis le Slice 8, deux `EventSource`
 * écoutent des invalidations — qui ne transportent aucune donnée. Ce qu'elles
 * déclenchent est toujours la même chose : relire le read model canonique.
 *
 * Une exception nommée existe depuis `V5.1` : le **suivi d'une opération
 * longue**. Elle est nécessaire parce qu'une opération peut se terminer sans
 * rien écrire — une proposition assistée refusée par le parseur strict
 * n'invalide aucune vue, et n'émet donc aucune invalidation. Sans suivi, son
 * issue n'arriverait jamais à l'écran, ce que le run réel `CCR-20260404-001` a
 * démontré. Ce suivi ne vit que pendant une opération, s'arrête sur son issue
 * terminale, et ne fait que des `GET`.
 */

import { lexer } from '/assets/vendor/marked.esm.js';

import { createApi } from './api.js';
import { createCockpit } from './cockpit.js';
import { createDomView } from './render.js';

function start(doc) {
  const api = createApi();

  const view = createDomView(doc, {
    onSelectRun: (runId) => {
      mainMode = 'RUN_SELECTED';
      showSection('overview');
      showView('runs');
      void cockpit.selectRun(runId);
    },
    onLoadMore: () => void cockpit.loadMoreTimeline(),
    onReloadTimeline: () => void cockpit.reloadTimeline(),
    onMutate: (action) => void cockpit.mutate(action),
    onRecover: (capabilityId, options) => void cockpit.recover(capabilityId, options),
    onCheckRecovery: () => void cockpit.checkRecovery(),
    onDecide: (content) => void cockpit.mutate('DECIDE', { content }),
    onSend: (target, content) => void cockpit.mutate('SEND', { target, content }),
    // V5.1 — gestes de domaine. Le rendu émet une intention ; le cockpit
    // l'assemble et l'envoie à la surface propriétaire, jamais l'inverse.
    onRecordControversy: (request) => void cockpit.recordControversy(request),
    onRegisterMaterial: (request) => void cockpit.registerMaterial(request),
    onAdduceMaterial: (request) => void cockpit.adduceMaterial(request),
    // Seul geste dont la promesse est rendue : le bouton s'affiche « en cours »
    // et doit savoir quand l'opération est retombée. `reconcile` traite ses
    // propres erreurs — rien n'est relancé ni rejoué ici.
    onReconcile: (request) => cockpit.reconcile(request),
    // Accès direct et retour : de la navigation locale, et rien d'autre. Aucune
    // route, aucun onglet nouveau, aucune donnée touchée — la section de
    // réconciliation reste l'unique surface, on s'y rend au lieu de la chercher.
    onShowReconciliation: () => {
      showSection('runtime');
      focusAnchor('reconciliation-anchor');
      // Arrivée par le signal de proposition : le chemin du retour est offert.
      setBackToConversation(true);
    },
    onShowConversation: () => {
      showSection('overview');
      focusAnchor('run-title');
    },
    onRetryMutation: () => void cockpit.retryMutation(),
    onCheckOperation: () => void cockpit.checkOperation(),
    onCreateRun: (payload) => void cockpit.createRun(payload),
    onCheckStart: () => void cockpit.checkStart(),
    onOpenRun: (runId) => void cockpit.openRun(runId),
    onRefreshRun: () => void cockpit.refreshRun(),
    onCopy: (command) => {
      // Copier n'est pas une mutation CCR : rien n'est lancé, rien n'est ouvert.
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard && typeof clipboard.writeText === 'function') void clipboard.writeText(command);
    },
  }, {
    /*
     * Seule dépendance du rendu Markdown, injectée ici et nulle part ailleurs.
     *
     * Le module tiers est servi par l'allowlist locale ; `render.js` ne
     * l'importe pas, ce qui le laisse importable hors navigateur. Une logique
     * de rendu, deux contextes de chargement.
     */
    markdown: { lexer, clipboard: globalThis.navigator?.clipboard },
  });

  /**
   * Ouverture d'un flux d'invalidation.
   *
   * `EventSource` porte le cookie de session de lui-même en `same-origin`, et
   * se reconnecte seul après une coupure. À chaque (re)connexion, le serveur
   * émet une invalidation inconditionnelle : le client ne cherche jamais à
   * reprendre où il s'était arrêté, il relit.
   */
  const openStream = (url, onInvalidate) => {
    const source = new EventSource(url, { withCredentials: true });
    source.addEventListener('message', (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch {
        message = null;
      }
      onInvalidate(message);
    });
    return { close: () => source.close() };
  };

  const cockpit = createCockpit({
    api,
    view,
    openStream,
    // Coalescence : une rafale d'indices, une seule série de `GET`.
    scheduleCoalesced: (run) => {
      globalThis.setTimeout(run, 60);
    },
    // Suivi d'une opération longue. Un battement à la fois, jamais réarmé
    // ailleurs que par la boucle elle-même, et jamais pendant qu'aucune
    // opération n'est en cours.
    scheduleFollowUp: (run, delay) => {
      globalThis.setTimeout(run, delay);
    },
  });

  const panels = {
    runs: doc.getElementById('run-panel'),
    newrun: doc.getElementById('newrun-panel'),
    doctor: doc.getElementById('doctor-panel'),
    config: doc.getElementById('config-panel'),
  };

  /**
   * Mode du panneau principal (`V2.3-S5P1`).
   *
   * Purement local : ce n'est ni un état de run, ni une route. Le cockpit
   * affiche soit le run sélectionné, soit l'espace de création — et la liste
   * reste utilisable dans les deux cas.
   */
  let mainMode = 'RUN_SELECTED';
  const viewTabs = {
    runs: doc.getElementById('view-runs'),
    doctor: doc.getElementById('view-doctor'),
    config: doc.getElementById('view-config'),
  };
  const sections = {
    overview: doc.getElementById('section-overview'),
    timeline: doc.getElementById('section-timeline'),
    recovery: doc.getElementById('section-recovery'),
    runtime: doc.getElementById('section-runtime'),
  };
  const sectionTabs = {
    overview: doc.getElementById('tab-overview'),
    timeline: doc.getElementById('tab-timeline'),
    recovery: doc.getElementById('tab-recovery'),
    runtime: doc.getElementById('tab-runtime'),
  };

  function toggle(node, visible) {
    if (node === null) return;
    if (visible) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }

  function showSection(name) {
    for (const [key, node] of Object.entries(sections)) toggle(node, key === name);
    for (const [key, tab] of Object.entries(sectionTabs)) {
      if (tab !== null) tab.setAttribute('aria-pressed', key === name ? 'true' : 'false');
    }
    // V-11 : le retour contextuel appartient à l'ACCÈS DIRECT, pas à la
    // section. Toute navigation ordinaire le remasque ; seul
    // `onShowReconciliation` le révèle, juste après.
    setBackToConversation(false);
  }

  /** Révèle ou masque le retour contextuel vers la Discussion. */
  function setBackToConversation(visible) {
    const node = doc.getElementById('back-to-conversation');
    if (node === null) return;
    if (visible) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }

  /**
   * Amène une ancre existante à l'écran, et y pose le focus.
   *
   * Appelée après `showSection`, donc sur un nœud déjà démasqué. Le focus sert
   * le clavier et les lecteurs d'écran ; le défilement sert la souris. Aucune
   * ancre n'est créée ici, aucune n'est inventée : la cible appartient au
   * rendu, et son absence est simplement sans effet.
   */
  function focusAnchor(id) {
    const node = doc.getElementById(id);
    if (node === null) return;
    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'start' });
    }
    if (typeof node.focus === 'function') node.focus({ preventScroll: true });
  }

  function showView(name) {
    const selected = cockpit.state.selectedRunId !== null;
    const creating = name === 'runs' && mainMode === 'NEW_RUN';
    toggle(panels.runs, name === 'runs' && selected && !creating);
    toggle(panels.newrun, creating);
    toggle(panels.doctor, name === 'doctor');
    toggle(panels.config, name === 'config');
    toggle(doc.getElementById('empty-detail'), name === 'runs' && !selected && !creating);
    for (const [key, tab] of Object.entries(viewTabs)) {
      if (tab !== null) tab.setAttribute('aria-pressed', key === name ? 'true' : 'false');
    }
    if (name === 'doctor' && cockpit.state.doctor === null) void cockpit.refreshDoctor();
    if (name === 'config' && cockpit.state.config === null) void cockpit.refreshConfig();
  }

  const on = (id, handler) => {
    const node = doc.getElementById(id);
    if (node !== null) node.addEventListener('click', handler);
  };

  /** Ouvre l'espace de création sans quitter le navigateur de runs. */
  on('open-new-run', () => {
    mainMode = 'NEW_RUN';
    showView('runs');
  });
  // Annuler retrouve le run précédemment sélectionné — jamais un autre, et
  // jamais le premier de la liste par défaut.
  on('start-cancel', () => {
    mainMode = 'RUN_SELECTED';
    showView('runs');
  });

  /** Repli du navigateur — utile lorsque la largeur devient rare. */
  const runsPanel = doc.getElementById('runs-panel');
  const toggleRuns = doc.getElementById('toggle-runs');
  if (toggleRuns !== null && runsPanel !== null) {
    toggleRuns.addEventListener('click', () => {
      const open = toggleRuns.getAttribute('aria-expanded') !== 'false';
      toggleRuns.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (open) runsPanel.setAttribute('data-collapsed', 'true');
      else runsPanel.removeAttribute('data-collapsed');
    });
  }

  on('view-runs', () => showView('runs'));
  on('view-doctor', () => showView('doctor'));
  on('view-config', () => showView('config'));
  on('tab-overview', () => showSection('overview'));
  on('tab-timeline', () => showSection('timeline'));
  on('tab-recovery', () => showSection('recovery'));
  on('tab-runtime', () => showSection('runtime'));
  on('refresh-runs', () => void cockpit.refreshRuns());
  on('refresh-run', () => void cockpit.refreshRun());
  on('refresh-doctor', () => void cockpit.refreshDoctor());
  on('refresh-config', () => void cockpit.refreshConfig());

  showSection('overview');
  showView('runs');
  void cockpit.refreshRuns();
  // Les écritures extérieures au cockpit — CLI, autre processus CCR — ne
  // passent par aucune mémoire partagée. On les apprend par invalidation.
  cockpit.connectStreams();

  return cockpit;
}

start(document);
