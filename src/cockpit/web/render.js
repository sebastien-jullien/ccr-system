/**
 * Vue DOM — construction **exclusivement** par nœuds, jamais par chaînes.
 *
 * Frontière stored-XSS. Tout ce qui vient de CCR — titre, contenu d'agent,
 * message humain, décision, chemin de travail, identifiant de session — est du
 * texte non fiable. Il n'entre dans le document que par `textContent`, jamais
 * par une chaîne interprétée comme balisage.
 *
 * Ce module n'emploie donc aucun de ces sinks :
 * `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`,
 * `new Function`. Une garde de source le vérifie sur le code livré au
 * navigateur.
 *
 * Aucune valeur reçue ne devient une URL, un `href`, un `src` ni un nom
 * d'attribut : les seuls attributs posés ici portent des noms et des valeurs
 * décidés par ce fichier.
 */

import { LONG_MUTATION_IDS, SHORT_MUTATION_IDS } from './cockpit.js';
import {
  elapsedSince,
  formatCount,
  formatElapsed,
  formatInstant,
  formatMoney,
  label,
  pluralize,
  shortRevision,
} from './labels.js';
import { createMarkdownContent } from './markdown.js';
// Le sélecteur de provenance réutilise la classification FERMÉE du fil. Une
// seconde table « ceci est technique » deviendrait une seconde autorité, et les
// deux écrans finiraient par ne plus dire la même chose du même événement.
import { createConversationThread, classifyEntry, ENTRY_CLASSES } from './conversation.js';

function makeDom(doc) {
  function el(tag, options = {}, children = []) {
    const node = doc.createElement(tag);
    if (typeof options.class === 'string') node.setAttribute('class', options.class);
    if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
    if (options.attrs) {
      for (const [name, value] of Object.entries(options.attrs)) node.setAttribute(name, String(value));
    }
    for (const child of children) {
      if (child !== null && child !== undefined) node.appendChild(child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild !== null) node.removeChild(node.firstChild);
  }

  /**
   * Une ligne de fait.
   *
   * `options.title` porte la valeur **exacte** lorsque la cellule en affiche une
   * forme abrégée — un condensat tronqué, un montant arrondi. L'abréviation vit
   * alors uniquement à l'écran : la valeur complète reste lisible au survol et
   * copiable, et rien de ce qui est persisté ou calculé n'en dépend.
   */
  function fact(term, value, options = {}) {
    const cell = el('dd', { class: options.mono === true ? 'mono' : undefined, text: value ?? '—' });
    if (typeof options.title === 'string' && options.title.length > 0) {
      cell.setAttribute('title', options.title);
    }
    return [el('dt', { text: term }), cell];
  }

  function facts(pairs) {
    const list = el('dl', { class: 'facts' });
    for (const [term, value, options] of pairs) {
      for (const node of fact(term, value, options ?? {})) list.appendChild(node);
    }
    return list;
  }

  function badge(text, tone) {
    return el('span', { class: tone === undefined ? 'badge' : `badge is-${tone}`, text });
  }

  return { el, clear, facts, badge };
}

/** Tonalité d'une pastille — présentation seule, jamais une conclusion métier. */
function attentionTone(attention) {
  if (attention === 'FAILED' || attention === 'RECOVERY') return 'error';
  if (attention === 'HUMAN_INPUT' || attention === 'INITIALIZATION') return 'attention';
  return undefined;
}

export function createDomView(doc, handlers = {}, options = {}) {
  const { el, clear, facts, badge } = makeDom(doc);
  const byId = (id) => doc.getElementById(id);

  /**
   * Rendu du contenu éditorial (`V2.3-S2`).
   *
   * Le lexer vient du câblage — le navigateur passe celui du module servi
   * localement. Sans lexer, le contenu reste du **texte intégral** dans un
   * `pre` : c'est la dégradation honnête, jamais une interprétation partielle.
   */
  const markdownContent =
    options.markdown !== undefined && typeof options.markdown.lexer === 'function'
      ? createMarkdownContent({
          lexer: options.markdown.lexer,
          document: doc,
          ...(options.markdown.clipboard === undefined ? {} : { clipboard: options.markdown.clipboard }),
        })
      : (text) => el('pre', { class: 'entry-content', text });

  const conversationThread = createConversationThread({
    document: doc,
    markdownContent,
    expertName: (slot, provider) => `${label.expertSlot(slot)} — ${label.actor(provider)}`,
    eventLabel: (type) => label.eventType(type),
    // Le rôle et le moteur sont donnés séparément : le fil les place à deux
    // rangs différents, et les recoller ici les remonterait au même.
    expertRole: (slot) => label.expertSlot(slot),
    actorLabel: (code) => label.actor(code),
    formatInstant: (value) => formatInstant(value),
  });

  /** Conteneur du fil, et fait de contexte initial déjà rendu par l'en-tête. */
  let threadNode = null;
  let initialContextShown = false;

  /**
   * Un statut de chargement n'est pas un message à préserver.
   *
   * La règle du rafraîchissement silencieux protège ce que l'humain vient de
   * provoquer — le reçu d'une mutation. Un indicateur de chargement, lui, n'a
   * personne à qui répondre : si un rafraîchissement silencieux supplante le
   * chargement initial, c'est lui qui rend l'écran, et le « Chargement… »
   * survivrait à son propre contenu.
   */
  let loadingStatusShown = false;

  /**
   * Horloge d'affichage, injectable.
   *
   * Elle ne sert qu'à soustraire un instant serveur d'un instant local. Deux
   * conséquences assumées : un décalage d'horloge décale la durée affichée, et
   * cette durée est **observée**, jamais prédite. Aucun temps restant n'en est
   * dérivé — CCR ne sait pas combien de temps un moteur va prendre.
   */
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();

  /**
   * Les deux seules durées qui vivent à l'écran.
   *
   * Une opération de run en vol, une opération longue du cockpit : jamais plus,
   * parce qu'il n'y a jamais plus d'un `pending_operation` ni plus d'une
   * tentative courante. Les garder nommées évite de balayer le document.
   */
  const progressTargets = { run: null, attempt: null, start: null };

  /**
   * Chronologie déjà reçue, et hôte du sélecteur d'événements V3.
   *
   * Le formulaire V3 vit dans Inspect, la chronologie arrive par un autre
   * transport : l'hôte est donc rempli quand elle arrive, sans reconstruire la
   * section — ce qui emporterait le motif que l'humain est en train d'écrire.
   *
   * Aucun modèle parallèle n'est construit ici : `entries` est la page rendue
   * par le serveur, dans son ordre, telle quelle.
   */
  let timelineEntries = [];
  let provenancePicker = null;
  /**
   * Filtre d'affichage de l'Historique (V-12).
   *
   * Purement présentationnel : il ne change ni la liste rendue, ni son ordre,
   * ni aucune classification. Il survit à un re-rendu pour ne pas se refermer
   * sous les doigts de l'utilisateur à chaque invalidation.
   */
  let historyShowTechnical = false;
  /** Dernière vue rendue. Sert la lecture croisée V3 → présentation V4. */
  let lastRunView = null;

  function paintElapsed(target, at) {
    const milliseconds = elapsedSince(target.startedAt, at);
    // Un instant de départ illisible ne devient pas une durée nulle : la phrase
    // dit qu'on ne sait pas depuis quand, pas qu'on vient de commencer.
    target.node.textContent =
      milliseconds === null ? 'depuis un instant inconnu' : `depuis ${formatElapsed(milliseconds)}`;
  }

  /** Nœud de durée, enregistré pour être repeint sans reconstruire l'écran. */
  function elapsedNode(startedAt, slot) {
    const target = { node: el('span', { class: 'elapsed' }), startedAt };
    paintElapsed(target, clock());
    progressTargets[slot] = target;
    return target.node;
  }

  function clearLoadingStatus(silent) {
    if (silent !== true || loadingStatusShown) setStatus(nodes.runStatus, '');
    loadingStatusShown = false;
  }

  const nodes = {
    banner: byId('banner'),
    runsStatus: byId('runs-status'),
    runsList: byId('runs-list'),
    runPanel: byId('run-panel'),
    runTitle: byId('run-title'),
    runStatus: byId('run-status'),
    overview: byId('section-overview'),
    timeline: byId('section-timeline'),
    recovery: byId('recovery-body'),
    recoveryStatus: byId('recovery-status'),
    runtime: byId('section-runtime'),
    // Les faits techniques du run vivent sous « État & reprise », pas dans le
    // Dossier : le Dossier porte le travail, celui-ci porte la machine.
    runFacts: byId('run-facts'),
    doctorStatus: byId('doctor-status'),
    doctorBody: byId('doctor-body'),
    configStatus: byId('config-status'),
    configBody: byId('config-body'),
    emptyDetail: byId('empty-detail'),
    startStatus: byId('start-status'),
    startTitle: byId('start-title'),
    startWorkspace: byId('start-workspace'),
    startPrompt: byId('start-prompt'),
    startAuthor: byId('start-author'),
    startChallenger: byId('start-challenger'),
    startMaxInvocations: byId('start-max-invocations'),
    startSummary: byId('start-summary'),
    startSubmit: byId('start-submit'),
    startCancel: byId('start-cancel'),
    runsSearch: byId('runs-search'),
  };

  /**
   * Filtre de navigation — **local**, et jamais un tri (`V2.3-S5P1`).
   *
   * Il masque des runs déjà reçus ; il ne les réordonne pas, n'en demande pas
   * d'autres et n'en modifie aucun. L'ordre du serveur reste l'ordre affiché.
   */
  let runFilter = '';
  let lastRuns = null;
  let lastSelectedId = null;

  /**
   * Effet de START, **transporté**, jamais reconstruit (`V2.3-S4`).
   *
   * `null` signifie « le serveur ne l'a pas dit ». Le résumé le dit alors, et
   * n'invente aucun nombre : un compte par défaut serait une affirmation que
   * rien n'appuie.
   */
  let startEffect = null;

  /**
   * Gel du formulaire de création pendant qu'une création est engagée.
   *
   * Le formulaire restait offert à l'identique alors que la demande était
   * partie : rien ne disait que les valeurs affichées n'étaient plus
   * modifiables, et le bouton pouvait engager un second run et jusqu'à deux
   * invocations fournisseur de plus.
   *
   * Les valeurs restent **visibles** — les geler, ce n'est pas les effacer :
   * l'humain doit pouvoir relire ce qu'il a demandé pendant que cela s'exécute.
   */
  const START_IDLE_LABEL = 'Démarrer la contre-expertise';
  const startFields = () => [
    nodes.startTitle, nodes.startWorkspace, nodes.startPrompt,
    nodes.startAuthor, nodes.startChallenger, nodes.startMaxInvocations,
  ].filter((node) => node !== null);

  function freezeStartForm(frozen) {
    if (nodes.startSubmit !== null) {
      nodes.startSubmit.disabled = frozen;
      nodes.startSubmit.setAttribute('aria-busy', frozen ? 'true' : 'false');
      nodes.startSubmit.textContent = frozen ? 'Démarrage en cours…' : START_IDLE_LABEL;
    }
    for (const field of startFields()) field.disabled = frozen;
  }

  // `Annuler` ne rend PAS la main. Le geste est purement local — il change de
  // vue, il n'annule aucune opération serveur, n'abandonne aucune requête et
  // ne touche pas à la tentative en cours. Réarmer ici laisserait créer un
  // second run pendant qu'un premier s'initialise. La tentative se résout par
  // « Vérifier le résultat », pas en quittant l'écran.

  // Création : le navigateur transmet une intention, il n'en juge rien. Ni
  // authentification, ni disponibilité d'agent, ni validité de répertoire, ni
  // quota — ce sont des verdicts du cœur, et il les rend en clair.
  if (nodes.startSubmit !== null) {
    nodes.startSubmit.addEventListener('click', () => {
      if (typeof handlers.onCreateRun !== 'function') return;
      // Seconde barrière, après celle du cockpit : un bouton déjà désarmé ne
      // réémet rien, même si l'événement parvient encore jusqu'ici.
      if (nodes.startSubmit.disabled === true) return;
      freezeStartForm(true);
      const optional = (node) => {
        const raw = node === null ? '' : String(node.value ?? '').trim();
        return raw.length === 0 ? undefined : raw;
      };
      // `0` est une limite explicite, pas une absence : la comparer à la
      // vérité JS la ferait disparaître silencieusement.
      const rawMax = nodes.startMaxInvocations === null ? '' : String(nodes.startMaxInvocations.value ?? '').trim();
      const maxInvocations = rawMax.length === 0 ? undefined : Number(rawMax);
      handlers.onCreateRun({
        title: nodes.startTitle === null ? '' : (nodes.startTitle.value ?? ''),
        workspace_cwd: nodes.startWorkspace === null ? '' : (nodes.startWorkspace.value ?? ''),
        prompt: nodes.startPrompt === null ? '' : (nodes.startPrompt.value ?? ''),
        ...(optional(nodes.startAuthor) === undefined ? {} : { author_provider: optional(nodes.startAuthor) }),
        ...(optional(nodes.startChallenger) === undefined
          ? {}
          : { challenger_provider: optional(nodes.startChallenger) }),
        ...(maxInvocations === undefined || Number.isNaN(maxInvocations) ? {} : { max_invocations: maxInvocations }),
      });
    });
  }

  /**
   * Conséquence d'une action, en français — **depuis les faits reçus**.
   *
   * Les quatre formulations sont gelées par le contrat, et aucune ne comble un
   * trou : un effet inconnu ne devient jamais zéro, un `AT_MOST` jamais un
   * `EXACT`. Le nombre affiché est celui qui a été transporté.
   */
  function effectSentence(effect) {
    if (effect === null || typeof effect !== 'object') return null;
    const invocation = effect.invocation_effect;
    const calls = effect.may_call_provider;
    if (invocation !== undefined && invocation !== null && invocation.kind === 'EXACT') {
      if (invocation.count === 0) return 'N’appelle aucun fournisseur.';
      const plural = invocation.count > 1 ? 's' : '';
      return `Engage ${String(invocation.count)} invocation${plural} CCR.`;
    }
    if (invocation !== undefined && invocation !== null && invocation.kind === 'AT_MOST') {
      const plural = invocation.count > 1 ? 's' : '';
      return `Peut engager jusqu’à ${String(invocation.count)} invocation${plural} CCR.`;
    }
    if (calls === 'YES') return 'Peut appeler un fournisseur.';
    if (calls === 'NOT_AVAILABLE') return 'Non exécutable depuis le cockpit.';
    return null;
  }

  /** Résumé de création — alimenté par le seul transport autoritaire. */
  function startSummaryNodes() {
    const author = nodes.startAuthor === null ? '' : String(nodes.startAuthor.value ?? '');
    const challenger = nodes.startChallenger === null ? '' : String(nodes.startChallenger.value ?? '');
    const name = (provider) => (provider.length === 0 ? 'le fournisseur par défaut' : label.actor(provider));
    // Le rôle nomme, le fournisseur affecte : « Auteur : Claude » se lit, là où
    // « Claude — Auteur, puis … — Challenger, seront initialisés » soudait deux
    // étiquettes par un tiret et commençait la phrase en minuscule.
    const out = [
      el('p', {
        class: 'card-note',
        text: `Auteur : ${name(author)}. Challenger : ${name(challenger)}.`,
      }),
      el('p', {
        class: 'card-note',
        text: 'Les deux experts sont initialisés l’un après l’autre, à partir du même contexte.',
      }),
    ];
    const sentence = effectSentence(startEffect);
    out.push(
      el('p', {
        class: 'card-note',
        text:
          sentence === null
            ? 'Effet du démarrage : non transporté par le serveur — aucun compte n’est affiché.'
            : `Le démarrage ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`,
      }),
    );
    return out;
  }

  // La recherche ne demande rien au serveur et ne change aucune sélection :
  // elle relit la liste déjà reçue. Un run sélectionné mais filtré hors de la
  // vue le reste — masquer n'est pas désélectionner.
  if (nodes.runsSearch !== null) {
    const applyFilter = () => {
      runFilter = String(nodes.runsSearch.value ?? '');
      if (lastRuns !== null) viewApi.showRuns(lastRuns, lastSelectedId);
    };
    nodes.runsSearch.addEventListener('input', applyFilter);
    nodes.runsSearch.addEventListener('search', applyFilter);
  }

  /** Rafraîchit le résumé de création depuis les valeurs **courantes**. */
  function refreshStartSummary() {
    if (nodes.startSummary === null) return;
    replace(nodes.startSummary, startSummaryNodes());
  }

  // Le résumé décrit ce que l'humain a sélectionné à l'instant. Un résumé qui
  // resterait sur les valeurs précédentes affirmerait un lancement qui n'aura
  // pas lieu — un défaut de vérité, pas d'ergonomie.
  for (const node of [nodes.startAuthor, nodes.startChallenger]) {
    if (node === null) continue;
    node.addEventListener('change', refreshStartSummary);
    node.addEventListener('input', refreshStartSummary);
  }

  /** Bouton de vérification — un geste humain, jamais une boucle. */
  function startCheck() {
    if (nodes.startStatus === null) return;
    const check = el('button', { attrs: { type: 'button', id: 'start-check' }, text: 'Vérifier le résultat' });
    check.addEventListener('click', () => {
      if (typeof handlers.onCheckStart === 'function') handlers.onCheckStart();
    });
    nodes.startStatus.appendChild(check);
  }

  /** Ouverture du run créé, lorsqu'il est connu. Jamais deviné. */
  function startOpen(runId) {
    if (nodes.startStatus === null || typeof runId !== 'string' || runId.length === 0) return;
    const open = el('button', { attrs: { type: 'button', id: 'start-open' }, text: 'Ouvrir le run ' + runId });
    open.addEventListener('click', () => {
      if (typeof handlers.onOpenRun === 'function') handlers.onOpenRun(runId);
    });
    nodes.startStatus.appendChild(open);
  }

  function setStatus(node, message, tone) {
    if (node === null) return;
    node.textContent = message;
    node.setAttribute('class', tone === 'error' ? 'status is-error' : 'status');
  }

  function replace(node, children) {
    if (node === null) return;
    clear(node);
    for (const child of children) node.appendChild(child);
  }

  // ------------------------------------------------------------------------
  // Liste des runs
  // ------------------------------------------------------------------------

  /**
   * Un run dans le navigateur — l'identité utile d'abord.
   *
   * Le titre humain prend le premier rang ; l'identifiant CCR descend au
   * second, sans disparaître. La génération, le runtime et les détails
   * techniques quittent la navigation : ils vivent dans Inspect, où on les
   * cherche quand on en a besoin.
   *
   * Aucun titre n'est fabriqué : sans titre, l'identifiant prend sa place, et
   * le dit.
   */
  function runItem(summary, selectedId) {
    const meta = el('span', { class: 'run-meta' });

    if (summary.unreadable === true) {
      meta.appendChild(badge(label.unreadable(summary.unreadable_reason ?? 'UNREADABLE'), 'error'));
    } else {
      meta.appendChild(badge(label.state(summary.state)));
      meta.appendChild(badge(`tour ${formatCount(summary.round)}`));
      if (summary.attention !== 'NONE') {
        meta.appendChild(badge(label.attention(summary.attention), attentionTone(summary.attention)));
      }
    }

    const hasTitle = typeof summary.title === 'string' && summary.title.length > 0;
    const selected = summary.run_id === selectedId;
    const button = el(
      'button',
      {
        class: selected ? 'run-button is-selected' : 'run-button',
        attrs: {
          type: 'button',
          'aria-pressed': selected ? 'true' : 'false',
          ...(selected ? { 'aria-current': 'true' } : {}),
        },
      },
      [
        el('span', { class: 'run-name', text: hasTitle ? summary.title : summary.run_id }),
        // La sélection porte un mot, pas seulement une teinte : un pseudo-élément
        // CSS ne serait ni lisible sans style, ni annoncé de façon fiable.
        ...(selected ? [el('span', { class: 'run-selected-mark', text: 'sélectionné' })] : []),
        meta,
        el('span', { class: 'run-id', text: hasTitle ? summary.run_id : 'titre indisponible' }),
      ],
    );
    button.addEventListener('click', () => {
      if (typeof handlers.onSelectRun === 'function') handlers.onSelectRun(summary.run_id);
    });
    return el('li', {}, [button]);
  }

  // ------------------------------------------------------------------------
  // Overview
  // ------------------------------------------------------------------------

  /**
   * Contrôle d'une mutation courte.
   *
   * Piloté **entièrement** par la capacité reçue : disponibilité, motif de refus
   * et exigence de confirmation viennent du cœur. Aucun test sur l'état du run
   * n'apparaît ici.
   *
   * La confirmation est un second clic sur le même bouton plutôt qu'une boîte de
   * dialogue : déterministe, accessible au clavier, et sans dépendance.
   */
  function mutationControl(capability) {
    const button = el('button', {
      class: 'action',
      attrs: { type: 'button', 'data-action': capability.id, 'aria-pressed': 'false' },
      text: label.capability(capability.id),
    });
    let armed = false;

    button.addEventListener('click', () => {
      if (capability.requiresConfirmation === true && !armed) {
        armed = true;
        button.textContent = 'Confirmer : ' + label.capability(capability.id);
        button.setAttribute('aria-pressed', 'true');
        return;
      }
      armed = false;
      button.textContent = label.capability(capability.id);
      button.setAttribute('aria-pressed', 'false');
      if (typeof handlers.onMutate === 'function') handlers.onMutate(capability.id);
    });
    return button;
  }

  /** Saisie d'une décision humaine. Aucun formulaire : rien n'est soumis. */
  function decisionControl() {
    const input = el('textarea', {
      class: 'decision-input',
      attrs: { id: 'decision-content', rows: '3', 'aria-label': 'Texte de la décision humaine' },
    });
    const submit = el('button', {
      class: 'action',
      attrs: { type: 'button', 'data-action': 'DECIDE' },
      text: label.capability('DECIDE'),
    });
    submit.addEventListener('click', () => {
      if (typeof handlers.onDecide === 'function') handlers.onDecide(input.value ?? '');
    });
    return el('div', { class: 'decision' }, [input, submit]);
  }

  /** Envoi d'un message humain à un agent. Cibles issues de la capacité seule. */
  function sendControl(capability) {
    const targets = Array.isArray(capability.targets) ? capability.targets : [];
    const select = el('select', {
      class: 'send-target',
      attrs: { id: 'send-target', 'aria-label': 'Agent destinataire' },
    });
    for (const target of targets) {
      select.appendChild(el('option', { attrs: { value: target }, text: label.actor(target) }));
    }
    const input = el('textarea', {
      class: 'decision-input',
      attrs: { id: 'send-content', rows: '3', 'aria-label': 'Message adressé à l agent' },
    });
    const submit = el('button', {
      class: 'action',
      attrs: { type: 'button', 'data-action': 'SEND' },
      text: label.capability('SEND'),
    });
    submit.addEventListener('click', () => {
      if (typeof handlers.onSend === 'function') handlers.onSend(select.value ?? targets[0], input.value ?? '');
    });
    return el('div', { class: 'decision' }, [select, input, submit]);
  }

  function capabilityCard(capability) {
    const head = el('div', { class: 'card-head' }, [
      el('strong', { text: label.capability(capability.id) }),
      badge(capability.allowed === true ? 'disponible' : 'indisponible', capability.allowed === true ? 'ok' : undefined),
    ]);
    if (Array.isArray(capability.targets)) {
      head.appendChild(badge(`cibles : ${capability.targets.map((t) => label.actor(t)).join(', ') || 'aucune'}`));
    }
    if (capability.longRunning === true) head.appendChild(badge('opération longue'));
    if (capability.destructive === true) head.appendChild(badge('destructive', 'attention'));

    const notes = [el('p', { class: 'card-note', text: `Effet : ${label.capabilityEffect(capability.effect)}.` })];
    if (typeof capability.reason === 'string') {
      notes.push(el('p', { class: 'card-note', text: `Motif : ${label.reason(capability.reason)}.` }));
    }
    if (capability.idempotentNoop === true) {
      notes.push(el('p', { class: 'card-note', text: 'Sans effet dans l’état actuel.' }));
    }

    // Seules les mutations courtes deviennent exécutables. `STEP` et `SEND`
    // restent purement diagnostiques : ce sont des opérations longues, dont le
    // modèle appartient au slice suivant.
    if (SHORT_MUTATION_IDS.includes(capability.id) && capability.allowed === true) {
      notes.push(capability.id === 'DECIDE' ? decisionControl() : mutationControl(capability));
    }
    // Opérations longues : mêmes règles de disponibilité, réponse différente.
    // `SEND` réclame une cible, prise **uniquement** dans `capability.targets`.
    if (LONG_MUTATION_IDS.includes(capability.id) && capability.allowed === true) {
      notes.push(capability.id === 'SEND' ? sendControl(capability) : mutationControl(capability));
    }
    return el('div', { class: 'card' }, [head, ...notes]);
  }

  function handoffCard(handoff) {
    const children = [
      el('div', { class: 'card-head' }, [
        el('strong', { text: 'Handoff interactif' }),
        badge(handoff.available === true ? 'disponible via CLI' : 'indisponible', handoff.available === true ? 'ok' : undefined),
      ]),
      el('p', {
        class: 'card-note',
        text: 'Le handoff reste hors du serveur : le cockpit affiche la commande, il ne la lance pas.',
      }),
    ];
    if (typeof handoff.reason === 'string') {
      children.push(el('p', { class: 'card-note', text: `Motif : ${label.reason(handoff.reason)}.` }));
    }
    for (const agent of handoff.agents ?? []) {
      const command = el('code', { text: agent.command });
      const line = el('div', { class: 'command' }, [
        el('span', { text: `${label.actor(agent.agent)} · session ` }),
        el('span', { class: 'mono', text: agent.session_id }),
      ]);
      const copy = el('button', { attrs: { type: 'button' }, text: 'Copier la commande' });
      copy.addEventListener('click', () => {
        if (typeof handlers.onCopy === 'function') handlers.onCopy(agent.command);
      });
      children.push(el('div', { class: 'card' }, [line, el('div', { class: 'command' }, [command, copy])]));
    }
    return el('div', { class: 'card' }, children);
  }

  function overviewNodes(runView) {
    const pending = runView.liveness.pending_operation;
    const blocks = [
      el('h3', { text: 'Identité' }),
      facts([
        ['Run', runView.identity.run_id, { mono: true }],
        ['Titre', runView.identity.title],
        ['Créé le', formatInstant(runView.identity.created_at)],
        ['Dernière activité', formatInstant(runView.last_activity_at)],
        ['Répertoire de travail', runView.identity.workspace_cwd, { mono: true }],
        ['Révision', shortRevision(runView.revision), { mono: true, title: runView.revision }],
        ['Révision complète', runView.revision, { mono: true }],
      ]),
      el('h3', { text: 'État' }),
      facts([
        ['État', label.state(runView.state.state)],
        ['Contrôle', label.control(runView.state.control)],
        ['Round', formatCount(runView.state.round)],
        ['Agent actif', runView.state.active_agent === null ? '—' : label.actor(runView.state.active_agent)],
        ['Mis à jour', formatInstant(runView.state.updated_at)],
        ['Événements', formatCount(runView.counts.events)],
        ['Décisions', formatCount(runView.counts.decisions)],
      ]),
      el('h3', { text: 'Vivacité' }),
      facts([
        ['Situation', label.liveness(runView.liveness.liveness)],
        ['Fondement', label.livenessBasis(runView.liveness.basis)],
        ['Verrou observé', label.lockObservation(runView.liveness.lock_observation)],
        ['Attention humaine', runView.liveness.needs_human_attention === true ? 'oui' : 'non'],
        ['Opération persistée', pending === null ? 'aucune' : `${pending.kind} · ${label.actor(pending.agent)} · ${formatInstant(pending.started_at)}`],
      ]),
      el('h3', { text: 'Sessions natives' }),
      facts([
        ['Claude', runView.sessions.claude ?? 'aucune', { mono: true }],
        ['Codex', runView.sessions.codex ?? 'aucune', { mono: true }],
      ]),
      el('h3', { text: 'Capacités (diagnostic — aucune action dans ce slice)' }),
    ];

    const cards = el('div', { class: 'cards' });
    for (const capability of runView.capabilities.capabilities) cards.appendChild(capabilityCard(capability));
    cards.appendChild(handoffCard(runView.handoff_cli));
    blocks.push(cards);
    return blocks;
  }

  // ------------------------------------------------------------------------
  // Timeline
  // ------------------------------------------------------------------------

  function timelineEntry(entry) {
    const head = el('div', { class: 'entry-head' }, [
      el('span', { class: 'mono', text: entry.kind === 'event' ? entry.event_id : entry.decision_id }),
      el('span', { text: formatInstant(entry.timestamp) }),
      el('span', { text: `round ${formatCount(entry.round)}` }),
    ]);

    if (entry.kind === 'event') {
      head.appendChild(badge(label.actor(entry.actor)));
      head.appendChild(badge(label.eventType(entry.type)));
      if (typeof entry.target === 'string') head.appendChild(badge(`vers ${label.actor(entry.target)}`));
      if (typeof entry.session_id === 'string') head.appendChild(el('span', { class: 'mono', text: entry.session_id }));
    } else {
      head.appendChild(badge('décision'));
      head.appendChild(badge(label.actor(entry.author)));
      head.appendChild(badge(entry.status));
      if (entry.orphan_decision === true) head.appendChild(badge('sans événement associé', 'attention'));
    }

    const children = [head];
    if (typeof entry.content === 'string' && entry.content.length > 0) {
      // `textContent` : le contenu d'agent reste une donnée, jamais du balisage.
      children.push(el('pre', { class: 'entry-content', text: entry.content }));
    }
    return el('article', { class: 'entry' }, children);
  }

  function timelineNodes(entries, page) {
    const nodesOut = [
      el('h3', { text: 'Chronologie' }),
      facts([
        ['Entrées affichées', String(entries.length)],
        ['Total de la vue', formatCount(page.total)],
        ['Révision', shortRevision(page.revision), { mono: true, title: page.revision }],
      ]),
    ];
    if (entries.length === 0) {
      nodesOut.push(el('p', { class: 'empty', text: 'Aucune entrée dans cette chronologie.' }));
      return nodesOut;
    }
    for (const entry of entries) nodesOut.push(timelineEntry(entry));
    if (typeof page.cursor_next === 'string' && page.cursor_next.length > 0) {
      const more = el('button', { attrs: { type: 'button', id: 'timeline-more' }, text: 'Charger la suite' });
      more.addEventListener('click', () => {
        if (typeof handlers.onLoadMore === 'function') handlers.onLoadMore();
      });
      nodesOut.push(more);
    }
    return nodesOut;
  }

  // ------------------------------------------------------------------------
  // Recovery
  // ------------------------------------------------------------------------

  /**
   * Contrôle d'une reprise.
   *
   * Piloté **entièrement** par la capacité reçue. Le navigateur ne teste ni
   * l'état du run, ni la vivacité du verrou, ni la présence d'un fichier : il
   * n'y a pas de règle du genre « un verrou existe, donc proposer la levée ».
   * Ce que le cœur n'a pas annoncé n'apparaît pas.
   */
  function recoveryControl(recovery, capability) {
    const button = el('button', {
      class: capability.destructive === true ? 'action is-destructive' : 'action',
      attrs: { type: 'button', 'data-recovery': capability.id, 'aria-pressed': 'false' },
      text: label.recoveryCapability(capability.id),
    });

    // L'acquittement exige un texte humain : le cœur le dit, la vue l'affiche.
    const note = capability.requires_acknowledgement_text === true
      ? el('textarea', {
          class: 'decision-input',
          attrs: {
            id: 'recovery-acknowledgement',
            rows: '3',
            'aria-label': 'Note d’acquittement de l’ambiguïté',
          },
        })
      : null;

    let armed = false;
    const disarm = () => {
      armed = false;
      button.textContent = label.recoveryCapability(capability.id);
      button.setAttribute('aria-pressed', 'false');
    };

    button.addEventListener('click', () => {
      if (capability.requires_confirmation === true && !armed) {
        armed = true;
        button.textContent = 'Confirmer : ' + label.recoveryCapability(capability.id);
        button.setAttribute('aria-pressed', 'true');
        return;
      }
      disarm();
      if (typeof handlers.onRecover !== 'function') return;
      handlers.onRecover(capability.id, {
        acknowledgementText: note === null ? undefined : note.value ?? '',
      });
    });

    return note === null ? el('div', { class: 'recovery-actions' }, [button]) : el('div', { class: 'recovery-actions' }, [note, button]);
  }

  function recoveryCard(recovery, capability) {
    const head = el('div', { class: 'card-head' }, [
      el('strong', { text: label.recoveryCapability(capability.id) }),
      badge(capability.allowed === true ? 'disponible' : 'indisponible', capability.allowed === true ? 'ok' : undefined),
    ]);
    if (capability.destructive === true) head.appendChild(badge('destructive', 'attention'));
    if (capability.requires_acknowledgement_text === true) head.appendChild(badge('acquittement requis'));

    const body = [head, el('p', { class: 'card-note', text: `Effet : ${capability.effect}` })];
    if (typeof capability.reason_code === 'string') {
      body.push(el('p', { class: 'card-note', text: `Motif : ${label.reason(capability.reason_code)}.` }));
    }
    if (capability.destructive === true) {
      body.push(el('p', {
        class: 'card-note',
        text: 'Action destructive : elle supprime un fichier de verrou et ne modifie aucun fait canonique.',
      }));
    }
    // Une capacité non autorisée reste décrite, jamais actionnable.
    if (capability.allowed === true) body.push(recoveryControl(recovery, capability));
    return el('div', { class: 'card' }, body);
  }

  /** Saisies en cours dans la vue d'ensemble, par identifiant. */
  const TYPED_IDS = ['decision-content', 'send-content', 'send-target'];

  function captureTyped() {
    const values = {};
    for (const id of TYPED_IDS) {
      const node = doc.getElementById(id);
      if (node !== null && typeof node.value === 'string' && node.value.length > 0) values[id] = node.value;
    }
    return values;
  }

  function restoreTyped(values) {
    for (const id of Object.keys(values)) {
      const node = doc.getElementById(id);
      if (node !== null) node.value = values[id];
    }
  }


  // ------------------------------------------------------------------------
  // Rendu natif V2.1 (Slice 2G)
  //
  // Une branche dediee, jamais une conversion : le modele natif est indexe par
  // ExpertSlot la ou l'historique l'est par fournisseur, et les couler l'un
  // dans l'autre fabriquerait exactement l'identite que V2.1 supprime.
  //
  // Aucune regle metier n'est recalculee ici. Chaque verdict — autorise, sans
  // effet, motif de refus, geste de reprise — vient de la projection recue.
  // ------------------------------------------------------------------------

  /** Un run natif se reconnait a la generation que le serveur declare. */
  function isNative(view) {
    return view !== null && typeof view === 'object' && view.generation === 'NATIVE_V21_EXECUTION';
  }

  /** Capacite de controle : trois issues, pas deux. */
  function controlNote(name, capability) {
    if (capability === undefined) return el('p', { class: 'card-note', text: `${name} : non exposé.` });
    if (capability.allowed !== true) {
      return el('p', { class: 'card-note', text: `${name} : refusé (${label.reason(capability.reason_code)}).` });
    }
    // Un geste deja satisfait n'est pas une interdiction.
    return el('p', {
      class: 'card-note',
      text: capability.noop === true ? `${name} : sans effet dans l’état actuel.` : `${name} : disponible.`,
    });
  }

  /**
   * Un geste autorisé est-il SANS EFFET dans l'état courant ?
   *
   * `allowed` et `noop` simultanément vrais décrivent un état DÉJÀ atteint.
   * L'autorisation du cœur n'est pas discutée ici : seule la place du geste à
   * l'écran en dépend.
   */
  function settledCapability(capability) {
    return capability !== undefined
      && capability !== null
      && capability.allowed === true
      && capability.noop === true;
  }

  /**
   * Carte d'un geste de controle natif : `PAUSE`, `RESUME`, `STEP`.
   *
   * `options.primary` dit si la carte occupe le rang d'une action principale.
   * Au rang principal, un geste sans effet n'expose PAS de bouton : proposer
   * « Rendre à l'automatisation » quand l'automatisation est déjà active offre
   * une action dont l'effet utilisateur est nul. L'état est dit à la place.
   *
   * `presentation ≠ business authority` : la capacité reste accordée par le
   * cœur, et la carte reste rendue avec son bouton dans les surfaces
   * secondaires — « Autres actions et limites » — où elle demeure découvrable.
   */
  function nativeControlCard(action, capability, extra = [], options = {}) {
    const allowed = capability !== undefined && capability.allowed === true;
    const settledPrimary = options.primary === true && settledCapability(capability);
    // `allowed` et `noop` simultanément vrais ne décrivent pas un refus : ils
    // décrivent un état DÉJÀ atteint. L'écran affichait la pastille
    // « disponible » et la phrase « sans effet dans l'état actuel » côte à
    // côte, ce qui se lisait comme une contradiction. Les deux disent le même
    // fait depuis, et au rang principal le bouton s'efface derrière lui.
    const settled = settledCapability(capability);
    const head = el('div', { class: 'card-head' }, [
      el('strong', { text: label.capability(action) }),
      settled
        ? badge('état déjà atteint')
        : badge(allowed ? 'disponible' : 'indisponible', allowed ? 'ok' : undefined),
    ]);
    const body = [head];
    if (settled) {
      body.push(el('p', {
        class: 'control-state',
        text: `${label.capabilitySettled(action)} — aucune action nécessaire.`,
      }));
    } else if (!allowed) {
      // Non exposé, ou refusé avec son motif : deux faits que rien d'autre sur
      // la carte ne porte. La pastille seule dirait « indisponible » sans dire
      // pourquoi.
      body.push(controlNote(label.capability(action), capability));
    }
    // Reste le cas `allowed` sans `noop` : la pastille dit « disponible » et le
    // bouton porte le nom du geste. Une troisième formulation n'ajouterait rien.
    for (const node of extra) body.push(node);
    if (allowed && !settledPrimary) {
      const button = el('button', {
        class: 'mutate',
        attrs: { type: 'button', 'data-action': action },
        text: label.capability(action),
      });
      button.addEventListener('click', () => {
        if (typeof handlers.onMutate === 'function') handlers.onMutate(action);
      });
      body.push(button);
    }
    return el('div', { class: 'card' }, body);
  }

  /**
   * Envoi natif : la cible est un **ExpertSlot**.
   *
   * `claude` et `codex` restent des alias de compatibilite, jamais l'interface
   * principale : deux experts peuvent partager un moteur, et l'alias ne
   * designerait alors personne.
   */
  function nativeSendCard(runView) {
    const experts = runView.run.experts;
    const options = [];
    for (const slot of ['author', 'challenger']) {
      const capability = runView.run.operations.experts[slot].send;
      if (capability.allowed !== true) continue;
      options.push({ slot, provider: experts[slot].provider });
    }

    const head = el('div', { class: 'card-head' }, [
      el('strong', { text: label.capability('SEND') }),
      badge(options.length > 0 ? 'disponible' : 'indisponible', options.length > 0 ? 'ok' : undefined),
    ]);
    const body = [head];
    for (const slot of ['author', 'challenger']) {
      body.push(controlNote(`${label.expertSlot(slot)} — ${label.actor(experts[slot].provider)}`,
        runView.run.operations.experts[slot].send));
    }
    if (options.length === 0) return el('div', { class: 'card' }, body);

    const select = el('select', { class: 'send-target', attrs: { id: 'send-target', 'aria-label': 'Expert destinataire' } });
    for (const option of options) {
      select.appendChild(el('option', {
        attrs: { value: option.slot },
        // La valeur envoyee est le slot ; le moteur n'est qu'un attribut lu.
        text: `${label.expertSlot(option.slot)} — ${label.actor(option.provider)}`,
      }));
    }
    const input = el('textarea', {
      class: 'send-content',
      attrs: { id: 'send-content', rows: '3', 'aria-label': 'Message à transmettre' },
    });
    const button = el('button', { class: 'mutate', attrs: { type: 'button', 'data-action': 'SEND' }, text: label.capability('SEND') });
    button.addEventListener('click', () => {
      if (typeof handlers.onSend === 'function') handlers.onSend(select.value ?? options[0].slot, input.value ?? '');
    });
    body.push(select, input, button);
    return el('div', { class: 'card' }, body);
  }

  /**
   * Handoff natif : capacite metier visible, transport CLI uniquement.
   *
   * Aucun bouton n'emet de requete. `openInteractive` attache un terminal au
   * processus CCR ; une page web n'en est pas un, et pretendre le contraire
   * serait promettre une action que rien ne sait executer.
   */
  function nativeHandoffCard(runView) {
    const children = [
      el('div', { class: 'card-head' }, [el('strong', { text: 'Handoff' }), badge('via CLI uniquement')]),
      el('p', {
        class: 'card-note',
        text: 'Le handoff ouvre une session native dans un terminal local : le cockpit l’indique, il ne le lance pas.',
      }),
    ];
    for (const slot of ['author', 'challenger']) {
      const capability = runView.run.operations.experts[slot].handoff;
      const name = `${label.expertSlot(slot)} — ${label.actor(runView.run.experts[slot].provider)}`;
      children.push(controlNote(name, capability));
      if (capability.allowed === true) {
        children.push(el('p', {
          class: 'card-note mono',
          text: `ccr handoff ${slot} --run ${runView.run.identity.run_id}`,
        }));
      }
    }
    return el('div', { class: 'card' }, children);
  }

  /** Gestes differes : dits, plutot que tus. */
  function deferredCard(title, note) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('strong', { text: title }), badge('non portée', 'attention')]),
      el('p', { class: 'card-note', text: note }),
    ]);
  }

  /**
   * Inspect natif (`V2.3-S3`) — le niveau technique, rassemblé et accessible.
   *
   * Il absorbe ce que la vue d'ensemble portait en premier rang : identité,
   * révision, workspace, sessions, alias de compatibilité, comptes — et le
   * snapshot runtime, qui avait son propre onglet. Rien n'a été supprimé ;
   * tout a changé de rang.
   */
  /**
   * Controverses V3 — **lecture seule**, et rien d'autre.
   *
   * La chaîne d'autorité s'arrête avant ce module :
   *
   * ```text
   * controversies.jsonl → snapshot stable → projection S3
   *   → NativeRunHttpView.controversies → ces noeuds
   * ```
   *
   * Le navigateur ne relit aucun journal, ne regroupe rien, ne recompte rien,
   * ne résout aucun ancrage et ne trie rien. Il **présente** ce que la
   * projection a décidé, dans l'ordre où elle l'a décidé.
   *
   * ## Ce qui n'est pas affiché, parce que cela n'existe pas
   *
   * Aucun statut, aucune clôture, aucun gagnant, aucun score, aucune position
   * courante. Un `WITHDRAWS` ne fait pas disparaître l'assertion visée ; une
   * confirmation puis une contestation restent deux faits, tous deux visibles.
   *
   * ## Aucun contrôle
   *
   * Aucun bouton, aucune mutation, aucun déclencheur de détection — la
   * disponibilité publique du détecteur est basse, et un contrôle grisé
   * promettrait une capacité que personne n'a autorisée.
   */
  function controversyNodes(runView) {
    const projection = runView.controversies;
    if (projection === null || projection === undefined) return [];

    // `tabindex="-1"` : cible focalisable par la navigation locale du Dossier,
    // sans entrer dans l'ordre de tabulation du clavier.
    const blocks = [el('h3', {
      text: 'Controverses',
      attrs: { id: 'controversy-anchor', tabindex: '-1' },
    })];

    if (projection.availability !== 'AVAILABLE') {
      // `NOT_AVAILABLE` n'est pas zéro : ce run n'a pas été regardé par V3.
      blocks.push(el('p', { class: 'empty', text: label.controversyAvailability(projection.availability) }));
      return blocks;
    }

    const items = Array.isArray(projection.items) ? projection.items : [];
    blocks.push(facts([['Controverses enregistrées', formatCount(projection.recorded_count)]]));
    // V5.1 : le geste humain d'enregistrement. Il vient AVANT la liste, parce
    // qu'un run sans controverse est précisément celui où l'on en ouvre une.
    blocks.push(controversyControl());

    if (items.length === 0) {
      // Le silence n'est pas la convergence : aucune détection n'a
      // nécessairement eu lieu, et personne n'a affirmé un accord.
      blocks.push(el('p', {
        class: 'empty',
        text: 'Aucune controverse enregistrée. Cela ne dit pas que les experts sont d’accord, '
          + 'ni qu’aucun désaccord n’existe : rien n’a été enregistré, voilà tout.',
      }));
      return blocks;
    }

    // Ordre serveur : première apparition dans le journal. Aucun tri.
    for (const item of items) blocks.push(controversyCard(item));
    return blocks;
  }

  /**
   * Enregistrer une controverse — geste HUMAIN (`V5.1`).
   *
   * Porter un désaccord dans le CCR, ce n'est pas affirmer qu'un expert a tort,
   * et ce n'est pas davantage une détection : rien ici n'appelle un modèle.
   * L'humain nomme les événements dont l'entrée tire sa provenance — leurs
   * identifiants sont lisibles dans la chronologie — et écrit son motif.
   *
   * Les champs demandés sont exactement ceux que le service V3 exige.
   * `textual_anchor` est optionnel dans cette forme : il n'est donc pas réclamé.
   */
  function controversyControl() {
    const wrapper = el('div', { class: 'controversy-record' }, [
      el('h4', { text: 'Enregistrer une controverse' }),
    ]);

    const picker = el('div', { class: 'event-picker', attrs: { role: 'group', 'aria-label': 'Événements dont provient cette controverse' } });
    provenancePicker = { node: picker, choices: [], showTechnical: false, selected: new Set() };
    fillProvenancePicker();

    // VIS-04 — un vrai label visible, associé au champ.
    //
    // « Ce que vous voulez porter dans le débat » n'était qu'un placeholder :
    // il disparaissait à la première frappe, et n'était donc pas une consigne.
    // Le label reste à l'écran, l'aide dit ce qu'on attend, et la note rappelle
    // ce que l'enregistrement ne fait pas.
    const statementId = 'controversy-statement';
    const statementLabel = el('label', {
      class: 'field-label',
      attrs: { for: statementId },
      text: 'Formulez le point de désaccord',
    });
    const statementHelp = el('p', {
      class: 'field-hint',
      attrs: { id: 'controversy-statement-help' },
      text: 'Décrivez précisément ce qui oppose les positions sélectionnées. '
        + 'Cet enregistrement ne désigne ni vainqueur ni décision.',
    });
    const statement = el('textarea', {
      class: 'controversy-statement-input',
      attrs: {
        id: statementId,
        rows: '3',
        'aria-describedby': 'controversy-statement-help',
      },
    });
    const button = el('button', {
      class: 'action',
      attrs: { type: 'button', 'data-controversy': 'RECORD' },
      text: 'Enregistrer la controverse',
    });
    button.addEventListener('click', () => {
      if (typeof handlers.onRecordControversy !== 'function') return;
      handlers.onRecordControversy({
        // Les identifiants viennent de ce que l'humain a coché, jamais d'une
        // saisie. Ce que le service reçoit reste `provenance_event_ids`.
        eventIds: selectedProvenanceEventIds(),
        statement: statement.value ?? '',
      });
    });

    wrapper.appendChild(el('p', {
      class: 'field-hint',
      text: 'Choisissez les échanges dont provient ce désaccord :',
    }));
    wrapper.appendChild(picker);
    wrapper.appendChild(statementLabel);
    wrapper.appendChild(statementHelp);
    wrapper.appendChild(statement);
    wrapper.appendChild(button);
    wrapper.appendChild(el('p', {
      class: 'card-note',
      text: 'Enregistrer une controverse porte un désaccord dans le débat. Cela ne dit '
        + 'pas qu’un expert a tort, et rien n’est demandé à un modèle.',
    }));
    return wrapper;
  }

  /**
   * Ce que l'humain a coché, dans l'ordre du serveur. Jamais un tri local.
   *
   * La sélection est **persistante**, et non lue sur les seules cases rendues :
   * le filtre technique reconstruit la liste, et un choix déjà fait ne doit pas
   * disparaître parce qu'il n'est momentanément plus affiché. Un enregistrement
   * amputé d'une provenance cochée serait un mensonge silencieux.
   *
   * L'ordre reste celui de la chronologie reçue : aucune comparaison, aucun
   * tri, aucune date consultée.
   */
  function selectedProvenanceEventIds() {
    if (provenancePicker === null) return [];
    syncProvenanceSelection();
    const chosen = [];
    for (const entry of timelineEntries) {
      if (entry === null || entry === undefined || entry.kind !== 'event') continue;
      const id = String(entry.event_id);
      if (provenancePicker.selected.has(id)) chosen.push(id);
    }
    return chosen;
  }

  /** Reporte l'état des cases actuellement rendues dans la sélection durable. */
  function syncProvenanceSelection() {
    if (provenancePicker === null) return;
    for (const choice of provenancePicker.choices) {
      if (choice.input.checked === true) provenancePicker.selected.add(choice.eventId);
      else provenancePicker.selected.delete(choice.eventId);
    }
  }

  /**
   * Aperçu d'un contenu, pour le choisir — jamais pour le lire.
   *
   * Le contenu intégral vit dans la Conversation et dans la chronologie. Ce
   * fragment sert à reconnaître un échange, et le dit.
   */
  function excerptOf(content) {
    const flat = String(content).replace(/\s+/g, ' ').trim();
    return flat.length <= 160 ? flat : `${flat.slice(0, 160)}…`;
  }

  /**
   * Remplit le sélecteur d'événements V3.
   *
   * **Règle de sélection, déterministe.** Est proposé tout événement de la page
   * qui porte un contenu. Le service V3, lui, accepte comme provenance
   * n'importe quel événement existant du run — un événement sans contenu reste
   * donc un ancrage valide, il n'est simplement pas offert ici : le choisir
   * reviendrait à cocher un identifiant sans rien pouvoir en juger, c'est-à-dire
   * exactement ce que ce sélecteur existe pour supprimer.
   *
   * Rien n'est pré-coché, rien n'est trié, rien n'est classé par pertinence, et
   * aucune détection n'est appelée. Le système présente ; l'humain choisit.
   */
  /**
   * Remplit le sélecteur de provenance.
   *
   * La sélection vit dans `provenancePicker.selected`, pas dans les cases : le
   * filtre technique reconstruit la liste, et un choix déjà fait lui survit.
   */
  function fillProvenancePicker() {
    if (provenancePicker === null) return;
    const host = provenancePicker.node;
    clear(host);
    provenancePicker.choices = [];

    const usable = [];
    for (const entry of timelineEntries) {
      if (entry === null || entry === undefined) continue;
      if (entry.kind !== 'event') continue;
      if (typeof entry.content !== 'string' || entry.content.length === 0) continue;
      usable.push(entry);
    }

    if (usable.length === 0) {
      host.appendChild(el('p', {
        class: 'empty',
        text: 'Aucun échange n’est encore disponible — ouvrez la Conversation.',
      }));
      return;
    }

    // Deux listes, une seule classification — celle du fil. Un événement
    // technique n'est ni caché ni retiré : il est compté, annoncé, et un
    // interrupteur l'affiche. Ce que l'humain peut choisir ne change pas ; ce
    // qu'il voit d'abord, oui.
    const shown = [];
    const technical = [];
    for (const entry of usable) {
      const target = classifyEntry(entry) === ENTRY_CLASSES.TECHNICAL ? technical : shown;
      target.push(entry);
    }
    const showTechnical = provenancePicker.showTechnical === true;
    if (technical.length > 0) {
      const toggleId = 'provenance-show-technical';
      // Classes propres : ce n'est pas un échange sélectionnable, et rien qui
      // compte les échanges proposés ne doit le compter parmi eux.
      const toggle = el('input', {
        class: 'event-filter',
        attrs: { type: 'checkbox', id: toggleId },
      });
      toggle.checked = showTechnical;
      toggle.addEventListener('change', () => {
        // La sélection en cours est reportée AVANT de reconstruire la liste :
        // les cases sur le point d'être détruites portent l'intention humaine.
        syncProvenanceSelection();
        provenancePicker.showTechnical = toggle.checked === true;
        fillProvenancePicker();
      });
      const suffix = technical.length > 1 ? 's' : '';
      host.appendChild(el('div', { class: 'event-filter-row' }, [
        toggle,
        el('label', { class: 'event-filter-label', attrs: { for: toggleId } }, [
          el('strong', {
            text: `Afficher les événements techniques (${formatCount(technical.length)})`,
          }),
          el('span', {
            class: 'muted',
            text: `${formatCount(technical.length)} enveloppe${suffix} de transport et marqueur${suffix} `
              + 'interne — ils restent sélectionnables.',
          }),
        ]),
      ]));
    }

    // Un choix masqué reste un choix. S'il en existe, l'écran le dit : il sera
    // enregistré, et l'humain doit pouvoir le savoir sans rouvrir le filtre.
    if (!showTechnical) {
      let hiddenSelected = 0;
      for (const entry of technical) {
        if (provenancePicker.selected.has(String(entry.event_id))) hiddenSelected += 1;
      }
      if (hiddenSelected > 0) {
        const plural = hiddenSelected > 1 ? 's' : '';
        host.appendChild(el('p', {
          class: 'card-note',
          text: `${formatCount(hiddenSelected)} événement${plural} technique${plural} `
            + `sélectionné${plural} n’${hiddenSelected > 1 ? 'apparaissent' : 'apparaît'} pas ci-dessous, `
            + `et rest${hiddenSelected > 1 ? 'ent' : 'e'} dans l’enregistrement.`,
        }));
      }
    }

    const listed = showTechnical ? usable : shown;
    if (listed.length === 0) {
      host.appendChild(el('p', {
        class: 'empty',
        text: 'Aucune contribution d’expert ou d’humain dans cette page — les événements techniques sont au-dessus.',
      }));
      return;
    }

    // V-07 — on reconnaît un échange à QUI l'a dit et à CE QU'IL A DIT.
    //
    // Rang primaire : rôle, tour, extrait. Rang secondaire, sous divulgation :
    // identifiant, type journalisé, session, acteur enregistré. Le type interne
    // et l'`evt_` restaient au premier plan alors qu'ils ne servent qu'à
    // l'audit — ils y restent accessibles, sans plus disputer la lecture.
    //
    // Aucune identité n'est déduite : le rôle vient de la PROVENANCE, et à
    // défaut l'acteur enregistré est nommé comme tel.
    for (const entry of listed) {
      const inputId = `provenance-${String(entry.event_id)}`;
      const input = el('input', {
        class: 'event-choice',
        attrs: { type: 'checkbox', id: inputId, value: String(entry.event_id) },
      });
      const provenance = entry.provenance ?? null;
      const identified = provenance !== null && provenance.shape === 'EXPERT_SESSION';
      const who = identified
        ? label.expertSlot(provenance.expert_slot_id).toUpperCase()
        : label.actor(entry.actor).toUpperCase();

      const line = el('label', { class: 'event-choice-label', attrs: { for: inputId } }, [
        el('span', { class: 'event-choice-head' }, [
          el('strong', {
            class: identified ? `entry-role is-${provenance.expert_slot_id}` : 'entry-role is-system',
            text: who,
          }),
          el('span', { class: 'muted', text: `Tour ${formatCount(entry.round)}` }),
        ]),
        el('span', { class: 'event-excerpt', text: excerptOf(entry.content) }),
      ]);

      // La provenance descend d'un rang ; elle n'est pas retirée.
      const technicalRows = [
        ['Événement', String(entry.event_id), true],
        ['Type journalisé', label.eventType(entry.type)],
        ['Acteur enregistré', label.actor(entry.actor)],
        ['Tour', formatCount(entry.round)],
      ];
      if (identified && typeof provenance.session_id === 'string' && provenance.session_id.length > 0) {
        technicalRows.push(['Session native', provenance.session_id, true]);
      }
      if (identified) technicalRows.push(['Moteur', label.actor(provenance.provider)]);
      const disclosure = el('details', { class: 'tech-details' });
      disclosure.appendChild(el('summary', { text: 'Détails techniques' }));
      disclosure.appendChild(facts(technicalRows.map(([term, value, mono]) => (
        mono === true ? [term, value, { mono: true }] : [term, value]
      ))));
      line.appendChild(disclosure);

      if (provencePickerSelected(entry)) input.checked = true;
      const row = el('div', { class: 'event-choice-row' }, [input, line]);
      host.appendChild(row);
      provenancePicker.choices.push({ eventId: String(entry.event_id), input });
    }
  }

  /** La sélection durable porte-t-elle cette entrée ? */
  function provencePickerSelected(entry) {
    return provenancePicker !== null && provenancePicker.selected.has(String(entry.event_id));
  }

  function controversyCard(item) {
    const card = el('article', { class: 'controversy' }, [
      el('h4', { class: 'mono', text: item.controversy_id }),
    ]);

    if (item.opening === null || item.opening === undefined) {
      // Le fait est rendu tel quel plutôt que masqué.
      card.appendChild(el('p', { class: 'card-note', text: 'Aucun enregistrement d’ouverture sous cette identité.' }));
    } else if (typeof item.opening.content === 'string' && item.opening.content.length > 0) {
      card.appendChild(el('p', { class: 'controversy-opening', text: item.opening.content }));
    }

    const entries = Array.isArray(item.entries) ? item.entries : [];
    const list = el('ol', { class: 'controversy-entries' });
    // Ordre d'append autoritaire. Aucun `.sort()`, aucun horodatage consulté.
    for (const entry of entries) list.appendChild(controversyEntry(entry));
    card.appendChild(list);

    const unresolvable = Array.isArray(item.unresolvable_anchors) ? item.unresolvable_anchors : [];
    if (unresolvable.length > 0) {
      card.appendChild(el('p', {
        class: 'card-note',
        text: 'Ancrages non résolus — information de vérifiabilité, jamais un verdict :',
      }));
      const notes = el('ul', { class: 'controversy-anchors' });
      for (const anchor of unresolvable) {
        notes.appendChild(el('li', {
          class: 'mono',
          text: `${anchor.entry_id} · ${anchor.event_id} · occurrence ${formatCount(anchor.occurrence)} · `
            + label.unresolvableAnchor(anchor.reason),
        }));
      }
      card.appendChild(notes);
    }
    return card;
  }

  /**
   * Attribution d'une entrée — le point où une falsification serait la plus
   * facile, et la plus grave.
   *
   * Une transcription humaine porte `kind = HUMAN` et `about_actor`. Elle est
   * donc annoncée « Humain — à propos de : … », jamais « Auteur : … » : la
   * seconde forme prêterait à l'expert une déclaration qu'il n'a pas faite.
   * `AUDITABLE ≠ SOURCE-AUTHORED`.
   */
  function originText(origin) {
    if (origin === null || origin === undefined) return '—';
    const base = label.semanticOrigin(origin.kind);
    if (typeof origin.about_actor === 'string' && origin.about_actor.length > 0) {
      return `${base} — à propos de : ${label.expertSlot(origin.about_actor)}`;
    }
    if (typeof origin.actor === 'string' && origin.actor.length > 0) {
      return `${base} — ${label.expertSlot(origin.actor)}`;
    }
    return base;
  }

  function controversyEntry(entry) {
    const item = el('li', { class: 'controversy-entry' });

    const head = el('p', { class: 'controversy-entry-head' });
    // Deux pastilles, et un texte qui les redit : le sens ne repose jamais sur
    // la seule couleur.
    head.appendChild(badge(label.controversyEntryKind(entry.kind)));
    head.appendChild(badge(originText(entry.semantic_origin)));
    head.appendChild(el('span', { class: 'mono', text: entry.entry_id }));
    item.appendChild(head);

    if (entry.derivation !== null && entry.derivation !== undefined) {
      const rows = [['Dérivation', label.derivationMethod(entry.derivation.method)]];
      if (typeof entry.derivation.invocation_id === 'string') {
        // Référence d'audit, et rien de plus : aucune jointure vers le ledger,
        // aucun fournisseur, aucun coût n'est lu ici.
        rows.push(['Invocation', entry.derivation.invocation_id, { mono: true }]);
      }
      if (Array.isArray(entry.derivation.inputs) && entry.derivation.inputs.length > 0) {
        rows.push(['Éléments fournis', entry.derivation.inputs.join(' · '), { mono: true }]);
      }
      item.appendChild(facts(rows));
    }

    if (entry.relation !== null && entry.relation !== undefined) {
      item.appendChild(facts([[
        'Relation',
        `${entry.relation.from_entry_id} ${label.relationAct(entry.relation.act)} ${entry.relation.to_entry_id}`,
        { mono: true },
      ]]));
    }

    if (entry.authority !== null && entry.authority !== undefined) {
      const rows = [['Acte', label.authorityAct(entry.authority.act)]];
      if (typeof entry.authority.target_entry_id === 'string') {
        rows.push(['Cible', entry.authority.target_entry_id, { mono: true }]);
      }
      if (typeof entry.authority.scope === 'string') rows.push(['Périmètre', entry.authority.scope]);
      item.appendChild(facts(rows));
    }

    const semantic = entry.anchors?.semantic;
    if (semantic !== null && semantic !== undefined && typeof semantic.text === 'string') {
      item.appendChild(el('p', { class: 'controversy-statement', text: semantic.text }));
    }
    if (typeof entry.content === 'string' && entry.content.length > 0) {
      item.appendChild(el('p', { class: 'controversy-content', text: entry.content }));
    }

    const textual = entry.anchors?.textual;
    if (textual !== null && textual !== undefined) {
      // La citation et son rang, tels qu'ils sont enregistrés. Aucun décalage
      // n'est fabriqué, aucun surlignage n'est tenté dans un contenu rendu.
      item.appendChild(facts([
        ['Citation', textual.quoted_text],
        ['Événement', `${textual.event_id} · occurrence ${formatCount(textual.occurrence)}`, { mono: true }],
      ]));
    }

    const provenance = entry.anchors?.provenance;
    if (Array.isArray(provenance) && provenance.length > 0) {
      item.appendChild(facts([[
        'Provenance',
        provenance.map((anchor) => anchor.event_id).join(' · '),
        { mono: true },
      ]]));
    }
    return item;
  }

  /**
   * Éléments probatoires V4 — **lecture seule**, et rien d'autre.
   *
   * La chaîne d'autorité s'arrête avant ce module :
   *
   * ```text
   * evidence.jsonl → snapshot stable → projection S3
   *   → NativeRunHttpView.evidence → ces noeuds
   * ```
   *
   * Le navigateur ne relit aucun journal, ne joint pas les deux listes, ne
   * recompte rien, ne résout aucune citation, ne trie rien et ne regroupe rien.
   * Il **présente** ce que la projection a décidé, dans l'ordre où elle l'a
   * décidé.
   *
   * ## Les deux listes restent deux listes
   *
   * ```text
   * RÉTENTION   ≠   ADDUCTION
   * ```
   *
   * Un matériau enregistré sans aucune adduction reste **visible** : l'avoir
   * enregistré est un fait, et ne l'avoir pas encore versé au débat en est un
   * autre. Aucune carte de matériau ne porte le nombre d'adductions qui le
   * visent — ce compte n'existe pas dans la projection, et le fabriquer ici
   * créerait une autorité de présentation que personne n'a écrite.
   *
   * ## Ce qui n'est pas affiché, parce que cela n'existe pas
   *
   * Aucune force, aucune crédibilité, aucune fiabilité, aucune suffisance,
   * aucun score, aucun gagnant, aucune convergence, aucune preuve préférée,
   * aucun classement, aucune majorité. Deux adductions contraires sur le même
   * matériau restent deux faits, tous deux visibles, et aucun des deux n'est
   * préféré.
   *
   * ## Aucun contrôle
   *
   * Aucun bouton, aucune mutation, aucun déclencheur d'adduction assistée. Les
   * gestes humains existent en CLI ; les exposer ici serait créer une surface
   * de mutation que le contrat n'a pas ouverte. Et la disponibilité publique du
   * chemin assisté est basse : un contrôle grisé promettrait une capacité que
   * personne n'a autorisée.
   */
  function evidenceNodes(runView) {
    const projection = runView.evidence;
    if (projection === null || projection === undefined) return [];

    // Un conteneur nomme, plutot qu'une suite de blocs libres : il delimite ce
    // qui appartient a V4, et rend verifiable qu'aucun controle ne s'y glisse.
    //
    // Il ne porte plus de titre utilisateur. « Éléments probatoires » réunissait
    // sous UN SEUL niveau deux notions que le contrat sépare — `RETENTION ≠
    // ADDUCTION` — et cette réunion rendait la distinction invisible à qui lit
    // l'écran. Le conteneur reste un groupement technique ; les deux notions
    // sont désormais deux sections de plein rang.
    const section = el('section', { class: 'evidence' });
    const blocks = [section];

    if (projection.availability !== 'AVAILABLE') {
      // `NOT_AVAILABLE` n'est pas zéro : ce run n'a pas été regardé par V4.
      //
      // Les deux titres restent distincts, et aucun compte n'est affiché : sans
      // projection, il n'y a rien à compter — et « 0 » affirmerait le contraire.
      const unavailable = label.evidenceAvailability(projection.availability);
      section.appendChild(el('h3', { text: 'Matériaux', attrs: { id: 'materials-anchor', tabindex: '-1' } }));
      section.appendChild(el('p', { class: 'empty', text: unavailable }));
      section.appendChild(el('h3', { text: 'Adductions', attrs: { id: 'adductions-anchor', tabindex: '-1' } }));
      section.appendChild(el('p', { class: 'empty', text: unavailable }));
      return blocks;
    }

    // ---- Matériaux : ce qui est retenu au dossier.
    const materials = Array.isArray(projection.materials) ? projection.materials : [];
    section.appendChild(el('h3', { text: 'Matériaux', attrs: { id: 'materials-anchor', tabindex: '-1' } }));
    // Glose du vocabulaire, décidée par l'humain (D4). Elle dit ce que le geste
    // FAIT, et se garde des deux effets qu'il n'a pas : rien n'est établi, rien
    // n'est opposé à personne.
    section.appendChild(el('p', {
      class: 'term-gloss',
      text: 'Un matériau est un élément que vous retenez pour le dossier : un échange du run, '
        + 'un texte, une référence externe. Le retenir l’enregistre ; cela ne le verse pas au débat.',
    }));
    // Compte **du serveur**, repris tel quel. Aucun `.length` n'est calculé
    // ici : un compte dérivé côté client deviendrait une seconde vérité.
    section.appendChild(facts([
      ['Matériaux enregistrés', formatCount(projection.recorded_material_count)],
    ]));
    if (materials.length === 0) {
      section.appendChild(el('p', {
        class: 'empty',
        text: 'Aucun matériau V4 enregistré. Cela ne dit pas qu’aucun élément pertinent '
          + 'n’existe, ni que rien n’a été produit : rien n’a été enregistré ici, voilà tout.',
      }));
    } else {
      const list = el('ol', { class: 'evidence-materials' });
      // Ordre d'append autoritaire. Aucun tri, aucun regroupement, aucune fusion.
      for (const item of materials) list.appendChild(materialItem(item));
      section.appendChild(list);
    }
    // V5.1 : le geste humain de retenue, avec ce qu'il produit.
    section.appendChild(materialControl());

    // ---- Adductions : l'usage d'un matériau dans une controverse.
    //
    // Section distincte, et non un sous-titre de la précédente : retenir n'est
    // pas verser, et un écran qui les empile sous un même en-tête laisse croire
    // qu'enregistrer un matériau l'a mis au débat.
    const adductions = Array.isArray(projection.adductions) ? projection.adductions : [];
    section.appendChild(el('h3', { text: 'Adductions', attrs: { id: 'adductions-anchor', tabindex: '-1' } }));
    section.appendChild(el('p', {
      class: 'term-gloss',
      text: 'Une adduction verse un matériau déjà retenu dans une controverse déjà enregistrée. '
        + 'Elle inscrit ce rapprochement au dossier ; elle ne dit pas que l’élément donne raison à quelqu’un.',
    }));
    section.appendChild(facts([
      ['Adductions enregistrées', formatCount(projection.recorded_adduction_count)],
      ['Révision V4', shortRevision(projection.evidence_revision),
        { mono: true, title: projection.evidence_revision }],
    ]));
    if (adductions.length === 0) {
      section.appendChild(el('p', {
        class: 'empty',
        text: 'Aucune adduction V4 enregistrée. Un matériau enregistré n’a pas pour autant '
          + 'été versé au débat, et ne pas l’avoir versé ne dit rien de lui.',
      }));
    } else {
      const list = el('ol', { class: 'evidence-adductions' });
      for (const item of adductions) list.appendChild(adductionItem(item));
      section.appendChild(list);
    }
    section.appendChild(adductionControl(projection));

    return blocks;
  }

  /**
   * Retenir un matériau — geste HUMAIN (`V5.1`).
   *
   * Retenir n'est pas verser. Un matériau enregistré et jamais adduit reste un
   * fait, et ne pas l'avoir versé ne dit rien de lui.
   *
   * ```text
   * RETENTION  ≠  ADDUCTION
   * ```
   *
   * Les trois formes proposées sont exactement celles du contrat V4 : un
   * événement du run, un texte en ligne, une référence externe. Aucune
   * quatrième n'est inventée pour les besoins d'un cas d'usage.
   */
  function materialControl() {
    const wrapper = el('div', { class: 'evidence-register' }, [
      el('h4', { text: 'Ajouter un matériau' }),
    ]);

    const form = el('select', {
      class: 'evidence-form',
      attrs: { 'aria-label': 'Forme du matériau' },
    }, [
      el('option', { attrs: { value: 'INLINE_TEXT' }, text: 'texte en ligne' }),
      el('option', { attrs: { value: 'RUN_EVENT' }, text: 'événement du run' }),
      el('option', { attrs: { value: 'EXTERNAL_REFERENCE' }, text: 'référence externe' }),
    ]);
    const value = el('textarea', {
      class: 'evidence-value',
      attrs: {
        rows: '2',
        'aria-label': 'Contenu, identifiant d’événement ou localisateur',
        placeholder: 'Le texte, l’identifiant evt_… ou le localisateur',
      },
    });
    const labelInput = el('input', {
      class: 'evidence-label',
      attrs: { type: 'text', 'aria-label': 'Étiquette libre (facultative)', placeholder: 'Étiquette (facultative)' },
    });
    const button = el('button', {
      class: 'action',
      attrs: { type: 'button', 'data-evidence': 'REGISTER_MATERIAL' },
      // V-10 : le GESTE utilisateur se nomme « Ajouter un matériau ». Le verbe
      // « retenir » reste dans la note ci-dessous, où il décrit la sémantique
      // CCR : ajouter au dossier n'est pas verser au débat.
      text: 'Ajouter un matériau',
    });
    button.addEventListener('click', () => {
      if (typeof handlers.onRegisterMaterial !== 'function') return;
      handlers.onRegisterMaterial({
        form: form.value ?? '',
        value: value.value ?? '',
        label: labelInput.value ?? '',
      });
    });

    wrapper.appendChild(form);
    wrapper.appendChild(value);
    wrapper.appendChild(labelInput);
    wrapper.appendChild(button);
    wrapper.appendChild(el('p', {
      class: 'card-note',
      text: 'Retenir un matériau ne le verse pas au débat, et ne dit rien de son contenu.',
    }));
    return wrapper;
  }

  /**
   * Verser un matériau au débat — geste HUMAIN (`V5.1`).
   *
   * L'adduction mobilise un matériau **existant** contre une entrée de
   * controverse existante, avec une orientation déclarée. Elle ne crée pas le
   * matériau, ne le certifie pas vrai, et ne valide pas l'argument.
   *
   * La liste des matériaux vient de `runView.evidence`, et **d'elle seule** :
   * cette section n'a qu'une source. L'entrée de controverse visée est saisie
   * par l'humain — son identifiant est lisible dans la section V3 — plutôt que
   * lue dans une seconde projection.
   *
   * Les intitulés du choix nomment un **geste** — « à l'appui », « en
   * objection » — là où l'affichage d'une adduction nomme un **état déclaré**.
   * Choisir n'est pas constater, et les deux ne se confondent pas à l'écran.
   */
  /**
   * État d'un prérequis — **trois valeurs, jamais deux**.
   *
   * ```text
   * KNOWN_ZERO      le compte canonique existe et vaut 0
   * KNOWN_PRESENT   le compte canonique existe et vaut plus de 0
   * UNKNOWN         aucun compte canonique : projection absente, non lue,
   *                 ou compte non numérique
   * ```
   *
   * `UNKNOWN ≠ ZERO`. Une projection que le serveur n'a pas produite ne dit pas
   * qu'il n'y a rien : elle ne dit rien. Écrire « aucun matériau » dans ce cas
   * fabriquerait un fait, et la divulgation progressive s'appuierait alors sur
   * une invention plutôt que sur une observation.
   */
  const PREREQUISITE = { KNOWN_ZERO: 'KNOWN_ZERO', KNOWN_PRESENT: 'KNOWN_PRESENT', UNKNOWN: 'UNKNOWN' };

  /** Traduit un compte canonique en état de prérequis, sans jamais deviner. */
  function prerequisiteFromCount(count) {
    if (typeof count !== 'number' || !Number.isFinite(count)) return PREREQUISITE.UNKNOWN;
    return count === 0 ? PREREQUISITE.KNOWN_ZERO : PREREQUISITE.KNOWN_PRESENT;
  }

  /**
   * Prérequis « au moins un matériau retenu », lu sur la projection V4.
   *
   * Le compte vient du serveur (`recorded_material_count`). La longueur de la
   * liste rendue n'est pas consultée : une page peut être partielle, et son
   * `.length` deviendrait un second compte — donc une seconde autorité.
   */
  function materialPrerequisite(projection) {
    if (projection === null || projection === undefined) return PREREQUISITE.UNKNOWN;
    if (projection.availability !== 'AVAILABLE') return PREREQUISITE.UNKNOWN;
    return prerequisiteFromCount(projection.recorded_material_count);
  }

  /**
   * Prérequis « au moins une controverse enregistrée », lu sur la projection V3.
   *
   * `controversyUnits()` rend `[]` aussi bien pour une projection absente que
   * pour une projection vide : sa longueur ne distingue donc pas l'ignorance de
   * l'absence. Le compte canonique, lui, le fait.
   */
  function controversyPrerequisite() {
    const projection = lastRunView === null || lastRunView === undefined ? null : lastRunView.controversies;
    if (projection === null || projection === undefined) return PREREQUISITE.UNKNOWN;
    if (projection.availability !== 'AVAILABLE') return PREREQUISITE.UNKNOWN;
    return prerequisiteFromCount(projection.recorded_count);
  }

  /**
   * Verser un matériau dans une controverse — geste HUMAIN (`V5.1`).
   *
   * ## Divulgation progressive
   *
   * Ce geste suppose DEUX enregistrements antérieurs. Lorsqu'au moins l'un
   * d'eux est **connu absent**, le formulaire complet n'est pas présenté comme
   * une action normale : l'écran nomme les prérequis, et c'est tout. Les listes
   * seraient vides, et proposer des menus vides avec un bouton actif inviterait
   * à un geste que rien ne peut satisfaire.
   *
   * Replier une présentation inapplicable **n'est pas** retirer une capacité :
   * le cœur reste seul juge de ce qu'il accepte, et le geste redevient offert
   * dès que ses prérequis sont satisfaits.
   *
   * ## Ignorance
   *
   * Un prérequis `UNKNOWN` ne déclenche RIEN. L'écran n'annonce aucune absence
   * qu'il n'a pas constatée, et rend le formulaire tel qu'il le rendait — une
   * restitution neutre de ce qui est réellement disponible.
   */
  function adductionControl(projection) {
    // La glose du terme est portée par la section « Adductions » juste au-dessus.
    // La répéter ici ferait lire deux fois la même phrase à trois lignes d'écart.
    const wrapper = el('div', { class: 'evidence-adduce' }, [
      el('h4', { text: 'Associer un matériau à une controverse' }),
    ]);

    const materialState = materialPrerequisite(projection);
    const controversyState = controversyPrerequisite();
    const unmet = [];
    if (materialState === PREREQUISITE.KNOWN_ZERO) unmet.push('ajoutez au moins un matériau');
    if (controversyState === PREREQUISITE.KNOWN_ZERO) unmet.push('enregistrez au moins une controverse');

    if (unmet.length > 0) {
      // Un prérequis CONNU ABSENT, et rien d'autre : ni menu vide, ni bouton
      // actif. Ce que l'écran affirme ici, il l'a lu.
      const guide = el('div', { class: 'empty-guide' }, [
        el('h5', { text: 'Pour utiliser cette action :' }),
      ]);
      const list = el('ul', { class: 'prerequisites' });
      for (const item of unmet) list.appendChild(el('li', { text: item }));
      guide.appendChild(list);
      wrapper.appendChild(guide);
      return wrapper;
    }

    const materials = Array.isArray(projection.materials) ? projection.materials : [];
    const materialSelect = el('select', {
      class: 'evidence-material-select',
      attrs: { 'aria-label': 'Matériau à associer' },
    });
    for (const item of materials) {
      const entry = item.entry ?? {};
      materialSelect.appendChild(el('option', {
        attrs: { value: entry.entry_id ?? '' },
        text: entry.entry_id ?? '',
      }));
    }

    // Cible : les unités que la projection V3 rend réellement, dans son ordre.
    // Lecture croisée autorisée pour PRÉSENTER un choix ; la validation reste
    // au service, qui refuse une cible qu'il n'accepte pas.
    const target = el('select', {
      class: 'evidence-target',
      attrs: { 'aria-label': 'Entrée de controverse visée' },
    });
    const units = controversyUnits();
    if (units.length === 0) {
      target.appendChild(el('option', { attrs: { value: '' }, text: 'aucune entrée de controverse disponible' }));
    }
    for (const unit of units) {
      target.appendChild(el('option', {
        attrs: { value: unit.entryId },
        // L'énoncé d'abord — c'est lui qu'on reconnaît. L'identifiant suit.
        text: `${unit.excerpt} — ${unit.entryId}`,
      }));
    }

    const orientation = el('select', {
      class: 'evidence-orientation',
      attrs: { 'aria-label': 'Comment associez-vous ce matériau' },
    }, [
      el('option', { attrs: { value: 'NONE' }, text: 'sans orientation' }),
      el('option', { attrs: { value: 'SUPPORTS' }, text: 'à l’appui' }),
      el('option', { attrs: { value: 'OBJECTS_TO' }, text: 'en objection' }),
    ]);

    const button = el('button', {
      class: 'action',
      attrs: { type: 'button', 'data-evidence': 'ADDUCE_MATERIAL' },
      text: 'Associer à une controverse',
    });
    button.addEventListener('click', () => {
      if (typeof handlers.onAdduceMaterial !== 'function') return;
      handlers.onAdduceMaterial({
        materialId: materialSelect.value ?? '',
        targetEntryId: target.value ?? '',
        orientation: orientation.value ?? '',
      });
    });

    wrapper.appendChild(materialSelect);
    wrapper.appendChild(el('p', { class: 'field-hint', text: 'Entrée de controverse visée :' }));
    wrapper.appendChild(target);
    wrapper.appendChild(orientation);
    wrapper.appendChild(button);
    wrapper.appendChild(el('p', {
      class: 'card-note',
      text: 'Associer un matériau à une controverse le rattache à une entrée précise, avec '
        + 'l’orientation que vous choisissez. Cela ne certifie pas son contenu, et ne décide de rien.',
    }));
    return wrapper;
  }

  /**
   * Unités de controverse proposables comme cible V4.
   *
   * **Lecture croisée, et rien de plus.** Elle sert à présenter un choix à
   * l'humain ; elle ne valide aucune cible, n'en juge la pertinence, ne crée
   * aucune controverse et n'infère aucune relation. Le service V4 reste seul
   * propriétaire de la validation, et refusera ce qu'il n'accepte pas.
   *
   * Aucun modèle parallèle : les unités viennent de la projection serveur, dans
   * son ordre. Une entrée vue deux fois — ouverture puis journal — n'est
   * proposée qu'une fois.
   */
  function controversyUnits() {
    const projection = lastRunView === null ? null : lastRunView.controversies;
    if (projection === null || projection === undefined) return [];
    if (projection.availability !== 'AVAILABLE') return [];

    const units = [];
    for (const item of Array.isArray(projection.items) ? projection.items : []) {
      // `entries` est la liste du serveur, ouverture comprise. Fusionner
      // `opening` avec elle obligerait à dédoublonner ici — donc à décider,
      // dans le navigateur, que deux faits n'en sont qu'un. On lit une liste,
      // celle que la projection rend, dans son ordre.
      const entries = Array.isArray(item.entries) ? item.entries : [];
      for (const entry of entries) {
        if (entry === null || entry === undefined) continue;
        const entryId = entry.entry_id;
        if (typeof entryId !== 'string' || entryId.length === 0) continue;
        units.push({
          entryId,
          controversyId: typeof entry.controversy_id === 'string' ? entry.controversy_id : '',
          excerpt:
            typeof entry.content === 'string' && entry.content.length > 0
              ? excerptOf(entry.content)
              : label.controversyEntryKind(entry.kind),
        });
      }
    }
    return units;
  }

  /** Vérifiabilité dérivée, avec son motif quand il y en a un. */
  function verifiabilityText(verifiability) {
    if (verifiability === null || verifiability === undefined) return '—';
    const base = label.materialVerifiability(verifiability.kind);
    if (typeof verifiability.reason === 'string' && verifiability.reason.length > 0) {
      return `${base} — ${label.evidenceUnresolvable(verifiability.reason)}`;
    }
    return base;
  }

  function materialItem(item) {
    const node = el('li', { class: 'evidence-material' });
    const entry = item.entry ?? {};
    const representation = entry.representation ?? {};

    const head = el('p', { class: 'evidence-head' });
    // Deux pastilles, et un texte qui les redit : le sens ne repose jamais sur
    // la seule couleur, et aucune tonalité ne suggère « bon » ou « mauvais ».
    head.appendChild(badge(label.materialForm(representation.form)));
    head.appendChild(badge(verifiabilityText(item.verifiability)));
    head.appendChild(el('span', { class: 'mono', text: entry.entry_id }));
    node.appendChild(head);

    if (typeof entry.label === 'string' && entry.label.length > 0) {
      // Texte libre destiné à l'humain — jamais une catégorie, jamais un titre
      // d'autorité. Inerte, comme tout ce qui vient d'un journal.
      node.appendChild(el('p', { class: 'evidence-label', text: entry.label }));
    }

    const rows = [
      ['Origine du matériau', label.materialSubmission(entry.submitted_by)],
      ['Enregistré par', entry.recorded_by],
      ['Enregistré le', formatInstant(entry.recorded_at)],
    ];
    node.appendChild(facts(rows));

    if (representation.form === 'RUN_EVENT') {
      node.appendChild(facts([['Événement', representation.event_id, { mono: true }]]));
    } else if (representation.form === 'INLINE_TEXT') {
      // `textContent`, comme partout : aucune interprétation Markdown, aucun
      // balisage, aucune exécution.
      node.appendChild(el('p', { class: 'evidence-text', text: representation.text }));
    } else if (representation.form === 'EXTERNAL_REFERENCE') {
      // Rendu en TEXTE, jamais en lien, jamais en ressource chargée. Aucune
      // valeur reçue ne devient un `href`, un `src` ni une requête.
      node.appendChild(facts([
        ['Localisateur (texte, jamais un lien)', representation.locator, { mono: true }],
      ]));
      if (typeof representation.declared_digest === 'string' && representation.declared_digest.length > 0) {
        node.appendChild(facts([[
          'Empreinte DÉCLARÉE par l’appelant — jamais calculée, jamais vérifiée',
          representation.declared_digest,
          { mono: true },
        ]]));
      }
    }

    return node;
  }

  /**
   * Une adduction — le point où une falsification serait la plus facile.
   *
   * ```text
   * ORIGINE SÉMANTIQUE   qui prend la position        HUMAN | CCR
   * ENREGISTRÉ PAR       qui a écrit la ligne         toujours CCR
   * ```
   *
   * Les deux faits sont affichés **séparément** et ne sont jamais fusionnés :
   * une adduction humaine est enregistrée par CCR sans que CCR en soit
   * l'origine, et lire l'un pour l'autre attribuerait à CCR une position qu'un
   * humain a prise.
   */
  function adductionItem(item) {
    const node = el('li', { class: 'evidence-adduction' });
    const entry = item.entry ?? {};
    const target = entry.target ?? {};

    const head = el('p', { class: 'evidence-head' });
    head.appendChild(badge(label.orientation(entry.orientation)));
    head.appendChild(badge(`origine : ${label.semanticOrigin(entry.semantic_origin)}`));
    head.appendChild(el('span', { class: 'mono', text: entry.entry_id }));
    node.appendChild(head);

    // Les deux objets restent désignés par leurs identifiants. Aucun lookup
    // dans `materials[]`, aucune recopie du matériau, aucune jointure vers les
    // entrées de controverse : une seconde vérité pourrait diverger.
    node.appendChild(facts([
      ['Matériau', entry.material_id, { mono: true }],
      ['Cible', `${label.evidenceTargetKind(target.kind)} · ${target.entry_id ?? '—'}`, { mono: true }],
      ['Enregistré par', entry.recorded_by],
      ['Enregistré le', formatInstant(entry.recorded_at)],
    ]));

    if (entry.derivation !== null && entry.derivation !== undefined) {
      const rows = [['Dérivation', label.derivationMethod(entry.derivation.method)]];
      if (typeof entry.derivation.invocation_id === 'string') {
        // Référence d'audit, et rien de plus : aucune jointure vers le ledger,
        // aucun fournisseur, aucun modèle, aucun coût n'est lu ici.
        rows.push(['Invocation', entry.derivation.invocation_id, { mono: true }]);
      }
      if (Array.isArray(entry.derivation.inputs) && entry.derivation.inputs.length > 0) {
        rows.push(['Éléments soumis', entry.derivation.inputs.join(' · '), { mono: true }]);
      }
      node.appendChild(facts(rows));
    }

    if (entry.citation !== null && entry.citation !== undefined) {
      // La citation et son rang, tels qu'ils sont enregistrés. Aucun décalage
      // n'est fabriqué, aucune recherche n'est tentée dans le matériau : la
      // résolution vient du serveur, telle quelle.
      const rows = [
        ['Citation', entry.citation.quoted_text],
        ['Rang', formatCount(entry.citation.occurrence)],
      ];
      const resolution = item.citation_resolution;
      if (resolution !== null && resolution !== undefined) {
        rows.push(['Résolution', citationText(resolution)]);
      }
      node.appendChild(facts(rows));
    }

    return node;
  }

  /** Résolution de citation, avec son motif quand il y en a un. */
  function citationText(resolution) {
    const base = label.citationResolution(resolution.kind);
    if (typeof resolution.reason === 'string' && resolution.reason.length > 0) {
      return `${base} — ${label.evidenceUnresolvable(resolution.reason)}`;
    }
    return base;
  }

  /**
   * Faits techniques du run — identité, état, sessions, alias, runtime.
   *
   * Ils vivaient au sommet du Dossier, devant les objets de débat. Le Dossier
   * répond désormais à « qu'a produit cette contre-expertise ? » ; ces faits
   * répondent à « quel est l'état de la machine ? ». Deux questions, deux
   * emplacements — et aucune ligne supprimée au passage : ce qui était
   * auditable ici l'est toujours, sous « État & reprise ».
   */
  function nativeRunFactNodes(runView) {
    const run = runView.run;
    const operational = run.operational_state;
    const aliases = run.compatibility.provider_aliases;
    // V-13 — l'état utilisateur d'abord, les faits techniques ensuite.
    //
    // Identité, workspace, SHA, sessions natives, révisions et runtime
    // occupaient le premier niveau de « État & reprise ». Ils descendent tous
    // sous une divulgation : rien n'est supprimé, tout est déplacé d'un rang.
    // Restent au premier niveau les seuls faits que l'utilisateur lit pour
    // savoir où en est son run — et ils viennent de la projection, pas d'un
    // calcul local.
    const blocks = [
      el('h3', { class: 'run-facts-title', text: 'État du run' }),
      facts([
        ['État', label.state(operational.state)],
        ['Contrôle', label.control(operational.control)],
        ['Tour', formatCount(operational.round)],
      ]),
    ];

    const technicalHost = el('details', { class: 'tech-details run-facts-technical' });
    technicalHost.appendChild(el('summary', { text: 'Détails techniques du run' }));
    blocks.push(technicalHost);

    // `push` remplace l'accumulation directe : tout ce qui suit vit désormais
    // sous la divulgation, et une ligne oubliée resterait visible — donc
    // repérable — plutôt que perdue.
    const push = (node) => technicalHost.appendChild(node);

    const technicalBlocks = [
      el('h4', { text: 'Identité' }),
      facts([
        ['Run', run.identity.run_id, { mono: true }],
        ['Titre', run.identity.title],
        ['Génération', label.generation(run.identity.execution_mode)],
        ['Créé le', formatInstant(run.identity.created_at)],
        ['Workspace', run.identity.workspace_cwd, { mono: true }],
        ['Révision', runView.revision, { mono: true }],
      ]),
      el('h4', { text: 'État opérationnel' }),
      facts([
        ['État', label.state(operational.state)],
        ['Contrôle', label.control(operational.control)],
        ['Round', formatCount(operational.round)],
        ['Expert actif', operational.active_expert_slot === null ? '—' : label.expertSlot(operational.active_expert_slot)],
        ['Prochaine source', operational.next_step_source_slot === null ? '—' : label.expertSlot(operational.next_step_source_slot)],
        ['Opération engagée', operational.pending_operation === null ? 'aucune' : operational.pending_operation.kind],
        ['Dernier événement', operational.last_event_id ?? '—', { mono: true }],
        ['Mis à jour le', formatInstant(operational.updated_at)],
        ['Événements', formatCount(run.counts.events)],
      ]),
      // La vivacite et l'observation de verrou n'appartiennent pas a cette
      // projection : les calculer ici en ferait une seconde autorite.
      el('p', { class: 'card-note', text: 'Vivacité et observation de verrou ne sont pas exposées par cette projection.' }),
      el('h4', { text: 'Sessions natives' }),
    ];
    for (const node of technicalBlocks) push(node);
    for (const slot of ['author', 'challenger']) {
      const expert = run.experts[slot];
      push(facts([
        [label.expertSlot(slot), label.actor(expert.provider)],
        ['Session', expert.session_id ?? 'aucune', { mono: true }],
        ['État de session', expert.session_status === 'BOUND' ? 'liée' : 'absente'],
      ]));
    }
    // Densité : deux blocs purement techniques se replient. Ni l'un ni l'autre
    // ne porte de provenance ou de fait de débat — un alias est une
    // compatibilité, un runtime épinglé est une version d'outil. Ils restent
    // intégralement lisibles d'un clic, et rien n'est retiré de l'audit.
    const technical = el('details', { class: 'inspect-technical' });
    technical.appendChild(el('summary', { text: 'Alias de compatibilité et runtime épinglé' }));
    technical.appendChild(el('h4', { text: 'Alias de compatibilité' }));
    technical.appendChild(facts(Object.keys(aliases).map((provider) => [
      label.actor(provider),
      aliases[provider].resolution === 'UNIQUE'
        ? label.expertSlot(aliases[provider].expert_slot)
        : label.aliasResolution(aliases[provider].resolution),
    ])));
    technical.appendChild(el('p', {
      class: 'card-note',
      text: 'Les alias restent une compatibilité : l’identité d’un expert est son rôle.',
    }));
    technical.appendChild(el('h4', { text: 'Runtime épinglé' }));
    const runtime = run.providers;
    if (runtime === null || runtime === undefined) {
      technical.appendChild(el('p', { class: 'empty', text: 'Aucun snapshot runtime épinglé.' }));
    } else {
      technical.appendChild(facts([
        ['Capturé le', formatInstant(runtime.captured_at)],
        ['Claude — requis', runtime.claude.required === true ? 'oui' : 'non'],
        ['Claude — version', runtime.claude.cli_version ?? '—'],
        ['Codex — requis', runtime.codex.required === true ? 'oui' : 'non'],
        ['Codex — version', runtime.codex.cli_version ?? '—'],
      ]));
    }
    push(technical);
    return blocks;
  }

  /**
   * Dossier — ce que la contre-expertise a produit.
   *
   * Trois objets de débat, dans l'ordre de la chaîne :
   *
   * ```text
   * controverse V3  →  matériaux V4  →  réconciliation V5
   * ```
   *
   * Cet ordre est celui de la doctrine, et il n'est pas réordonnable par
   * l'écran. Seule une navigation locale est ajoutée : elle amène à un bloc,
   * elle n'en déplace aucun et n'en masque aucun.
   */
  function nativeDossierNodes(runView) {
    const controversy = controversyNodes(runView);
    const evidence = evidenceNodes(runView);
    const reconciliation = reconciliationNodes(runView);
    const blocks = [];
    const nav = dossierNav(runView, {
      controversy: controversy.length > 0,
      evidence: evidence.length > 0,
      reconciliation: reconciliation.length > 0,
    });
    if (nav !== null) blocks.push(nav);
    for (const node of controversy) blocks.push(node);
    for (const node of evidence) blocks.push(node);
    for (const node of reconciliation) blocks.push(node);
    if (blocks.length === 0) {
      blocks.push(el('p', {
        class: 'empty',
        text: 'Aucun objet de dossier sur ce run : ni controverse enregistrée, ni matériau retenu, ni proposition de réconciliation.',
      }));
    }
    return blocks;
  }

  /**
   * Navigation locale du Dossier.
   *
   * Chaque puce porte un **compte reçu**, jamais recalculé : les projections
   * publient déjà ces totaux, et en dériver un second ici en ferait une seconde
   * autorité. Une section absente n'a pas de puce — annoncer « 0 » dirait qu'on
   * a compté, alors que la projection n'est pas là.
   */
  function dossierNav(runView, present) {
    const chips = [];
    const add = (anchor, text) => {
      const chip = el('button', {
        class: 'secondary dossier-chip',
        attrs: { type: 'button', 'data-goto-anchor': anchor },
        text,
      });
      chip.addEventListener('click', () => {
        const target = doc.getElementById(anchor);
        if (target === null) return;
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView();
        if (typeof target.focus === 'function') target.focus();
      });
      chips.push(chip);
    };

    // Un compte n'accompagne le nom que si la projection est DISPONIBLE.
    // `NOT_AVAILABLE` veut dire « ce run n'a pas été regardé » : y afficher un
    // nombre — fût-il 0 — affirmerait qu'on a compté.
    const counted = (projection, value) =>
      projection !== null && projection !== undefined
        && projection.availability === 'AVAILABLE'
        && typeof value === 'number';

    if (present.controversy === true) {
      const projection = runView.controversies;
      add('controversy-anchor', counted(projection, projection.recorded_count)
        ? `Controverses ${formatCount(projection.recorded_count)}`
        : 'Controverses');
    }
    // Deux notions, deux puces. Les réunir sous une seule — et lui donner le
    // compte des matériaux — rendait `RETENTION ≠ ADDUCTION` invisible dès la
    // navigation, et affichait le compte de l'une sous le nom des deux.
    //
    // Le libellé reste distinct même sans compte : un nombre absent n'efface
    // pas la notion, et n'autorise pas à écrire « 0 ».
    if (present.evidence === true) {
      const projection = runView.evidence;
      add('materials-anchor', counted(projection, projection.recorded_material_count)
        ? `Matériaux ${formatCount(projection.recorded_material_count)}`
        : 'Matériaux');
      add('adductions-anchor', counted(projection, projection.recorded_adduction_count)
        ? `Adductions ${formatCount(projection.recorded_adduction_count)}`
        : 'Adductions');
    }
    if (present.reconciliation === true) {
      const projection = runView.reconciliations;
      add('reconciliation-anchor', counted(projection, projection.recorded_count)
        ? `Réconciliation ${formatCount(projection.recorded_count)}`
        : 'Réconciliation');
    }
    if (chips.length === 0) return null;
    return el('nav', { class: 'dossier-nav', attrs: { 'aria-label': 'Sections du dossier' } }, chips);
  }

  // ------------------------------------------------------------------------
  // Réconciliation V5 (V5.1) — lecture, puis gestes humains
  // ------------------------------------------------------------------------

  /**
   * Section V5 — la troisième marche de la chaîne.
   *
   * ```text
   * controverse V3  →  preuves V4  →  réconciliation V5  →  décision humaine
   * ```
   *
   * Tout ce qui est montré vient de `NativeRunHttpView.reconciliations`. Le
   * navigateur ne relit aucun journal, ne recompte rien, ne dérive aucune
   * actualité et ne trie rien : une seconde autorité de lecture serait une
   * seconde vérité.
   *
   * Les quatre interdits de l'addendum §14 gouvernent chaque libellé.
   */
  function reconciliationNodes(runView) {
    const projection = runView.reconciliations;
    if (projection === null || projection === undefined) return [];

    // `tabindex="-1"` rend le titre focalisable par programme sans l'insérer
    // dans l'ordre de tabulation : l'accès direct peut y poser le focus, et le
    // clavier continue de parcourir la page comme avant.
    const heading = el('h3', {
      text: 'Réconciliation',
      attrs: { id: 'reconciliation-anchor', tabindex: '-1' },
    });
    const section = el('section', { class: 'reconciliation' }, [heading]);

    // Retour local, à l'endroit exact où l'accès direct dépose l'utilisateur —
    // plusieurs écrans sous les onglets. Ce raccourci ne navigue nulle part
    // ailleurs et ne touche à aucune donnée.
    //
    // V-11 / VIS-01 : le retour est CONTEXTUEL, à deux conditions cumulatives.
    //
    //   1. une proposition existe réellement — sans elle, il n'y a pas d'aller
    //      depuis U-01, donc pas de retour à offrir. Le bouton n'est alors même
    //      pas rendu : une réconciliation vide ouverte normalement ne doit pas
    //      être dominée par une invitation à repartir ;
    //   2. l'utilisateur est arrivé PAR ce signal — sinon il reste masqué, et
    //      `app.js` le révèle au moment de l'accès direct.
    //
    // La condition 1 lit exactement le compte qui décide du signal lui-même.
    if (reconciliationProposalCount(runView) > 0) {
      const back = el('button', {
        class: 'action back-to-conversation',
        attrs: {
          type: 'button',
          'data-goto': 'conversation',
          id: 'back-to-conversation',
          hidden: '',
        },
        text: 'Retour à Conversation',
      });
      back.addEventListener('click', () => {
        if (typeof handlers.onShowConversation === 'function') handlers.onShowConversation();
      });
      section.appendChild(back);
    }

    const blocks = [section];

    if (projection.availability !== 'AVAILABLE') {
      // `NOT_AVAILABLE` n'est pas zéro : ce run n'a pas été regardé par V5.
      section.appendChild(el('p', {
        class: 'empty',
        text: label.reconciliationAvailability(projection.availability),
      }));
      return blocks;
    }

    section.appendChild(facts([
      ['Enregistrements V5', formatCount(projection.recorded_count)],
      ['Révision V5', shortRevision(projection.reconciliation_revision),
        { mono: true, title: projection.reconciliation_revision }],
    ]));
    section.appendChild(el('p', {
      class: 'card-note',
      text: 'Une proposition n’est pas une décision. Seuls les actes humains portent '
        + 'une autorité, et aucune option n’est recommandée.',
    }));

    const items = Array.isArray(projection.items) ? projection.items : [];
    if (items.length === 0) {
      section.appendChild(el('p', {
        class: 'empty',
        text: 'Aucune controverse observée. Cela ne dit pas que les experts sont d’accord.',
      }));
      return blocks;
    }

    for (const item of items) section.appendChild(reconciliationCard(item, runView));
    return blocks;
  }

  /** Une controverse, et tout ce que V5 a enregistré à son sujet. */
  function reconciliationCard(item, runView) {
    const card = el('article', { class: 'reconciliation-card' }, [
      el('h4', { class: 'mono', text: item.controversy_id }),
    ]);

    card.appendChild(proposeControl(item, runView));

    const proposals = Array.isArray(item.proposals) ? item.proposals : [];
    card.appendChild(el('h5', { text: 'Propositions CCR' }));
    if (proposals.length === 0) {
      card.appendChild(el('p', {
        class: 'empty',
        text: 'Aucune proposition enregistrée. Rien n’a été demandé, ou rien n’a été produit.',
      }));
    } else {
      const list = el('ol', { class: 'reconciliation-proposals' });
      for (const proposal of proposals) list.appendChild(proposalItem(proposal, item));
      card.appendChild(list);
    }

    const acts = Array.isArray(item.recorded_acts) ? item.recorded_acts : [];
    card.appendChild(el('h5', { text: 'Actes humains' }));
    if (acts.length === 0) {
      card.appendChild(el('p', { class: 'empty', text: 'Aucun acte humain enregistré.' }));
    } else {
      const list = el('ol', { class: 'reconciliation-acts' });
      for (const act of acts) list.appendChild(recordedActItem(act));
      card.appendChild(list);
    }

    const responses = Array.isArray(item.responses) ? item.responses : [];
    if (responses.length > 0) {
      card.appendChild(el('h5', { text: 'Réponses humaines' }));
      const list = el('ol', { class: 'reconciliation-responses' });
      for (const response of responses) {
        const line = el('li', { class: 'reconciliation-response' }, [
          el('span', { class: 'mono', text: response.entry_id }),
          badge(label.responseMode(response.mode)),
          el('span', { text: `à ${response.proposal_id}` }),
        ]);
        // L'option désignée, lorsqu'elle existe. Elle est facultative : une
        // réponse peut porter sur la proposition entière, et son absence est
        // alors le fait exact — jamais une option manquante.
        if (typeof response.responded_option_id === 'string' && response.responded_option_id.length > 0) {
          line.appendChild(el('span', {
            class: 'mono muted',
            text: `option ${response.responded_option_id}`,
          }));
        }
        // La justification déclarée par l'humain, relue telle qu'il l'a écrite.
        // Elle était enregistrée sans être jamais réaffichée : l'interface la
        // demandait, puis la perdait de vue.
        const declared = provenanceText(item, response.entry_id);
        if (declared !== null) {
          line.appendChild(el('span', { class: 'reconciliation-response-detail', text: declared }));
        }
        list.appendChild(line);
      }
      card.appendChild(list);
      card.appendChild(el('p', {
        class: 'card-note',
        text: 'Une réponse est un fait historique : elle ne clôt rien, ne supersède rien, '
          + 'et ne vaut pas adoption.',
      }));
    }

    card.appendChild(currentnessNodes(item));

    const closures = Array.isArray(item.closure_declarations) ? item.closure_declarations : [];
    if (closures.length > 0) {
      card.appendChild(el('h5', { text: 'Déclarations de clôture' }));
      const list = el('ul', { class: 'reconciliation-closures' });
      for (const closure of closures) {
        list.appendChild(el('li', {}, [
          el('span', { class: 'mono', text: closure.entry_id }),
          el('span', { text: closure.statement }),
        ]));
      }
      card.appendChild(list);
      card.appendChild(el('p', {
        class: 'card-note',
        text: 'Une clôture déclare qu’un périmètre est traité. Elle ne dit pas que les '
          + 'experts se sont accordés.',
      }));
    }

    const withdrawals = Array.isArray(item.closure_withdrawal_declarations)
      ? item.closure_withdrawal_declarations
      : [];
    if (withdrawals.length > 0) {
      card.appendChild(el('h5', { text: 'Retraits de clôture' }));
      const list = el('ul', { class: 'reconciliation-withdrawals' });
      for (const withdrawal of withdrawals) {
        list.appendChild(el('li', {}, [
          el('span', { class: 'mono', text: withdrawal.entry_id }),
          el('span', { text: withdrawal.statement }),
        ]));
      }
      card.appendChild(list);
    }

    const supersessions = Array.isArray(item.supersession_relations)
      ? item.supersession_relations
      : [];
    if (supersessions.length > 0) {
      card.appendChild(el('h5', { text: 'Supersessions' }));
      const list = el('ul', { class: 'reconciliation-supersessions' });
      for (const relation of supersessions) {
        list.appendChild(el('li', {}, [
          el('span', { class: 'mono', text: relation.entry_id }),
          el('span', { text: `supersède ${relation.superseded_act_id}` }),
        ]));
      }
      card.appendChild(list);
      card.appendChild(el('p', {
        class: 'card-note',
        text: 'Un acte supersédé reste enregistré : superséder n’efface rien.',
      }));
    }

    const signals = Array.isArray(item.disagreement_view) ? item.disagreement_view : [];
    if (signals.length > 0) {
      card.appendChild(el('h5', { text: 'Signaux de désaccord' }));
      const list = el('ul', { class: 'reconciliation-signals' });
      for (const signal of signals) {
        list.appendChild(el('li', { text: label.disagreementSignal(signal.signal) }));
      }
      card.appendChild(list);
    }

    const detections = Array.isArray(item.detections) ? item.detections : [];
    if (detections.length > 0) {
      card.appendChild(el('h5', { text: 'Formes observées' }));
      const list = el('ul', { class: 'reconciliation-detections' });
      for (const detection of detections) {
        list.appendChild(el('li', {}, [
          badge(detection.category),
          el('span', { text: label.reconciliationDetection(detection.category) }),
        ]));
      }
      card.appendChild(list);
      card.appendChild(el('p', {
        class: 'card-note',
        text: 'Ces constats portent sur la forme des enregistrements. Ils ne disent pas '
          + 'qu’un expert s’est trompé, ni qu’un acte est mauvais.',
      }));
    }

    return card;
  }

  /**
   * Les deux actualités, côte à côte et jamais confondues (`CR5-01`).
   *
   * Une décision qui n'est plus courante n'a pas perdu son effet de clôture. Les
   * deux listes viennent de deux projections distinctes du serveur, et rien ici
   * ne dérive l'une de l'autre.
   */
  function currentnessNodes(item) {
    const wrapper = el('div', { class: 'reconciliation-currentness' }, [
      el('h5', { text: 'Actualité' }),
    ]);

    const decisions = Array.isArray(item.current_decisions) ? item.current_decisions : [];
    const effects = Array.isArray(item.closure_effect_currentness)
      ? item.closure_effect_currentness
      : [];

    wrapper.appendChild(el('h6', { text: 'Actualité de décision' }));
    if (decisions.length === 0) {
      wrapper.appendChild(el('p', { class: 'empty', text: 'Aucune décision courante projetée.' }));
    } else {
      const list = el('ul', { class: 'reconciliation-current-decisions' });
      for (const entry of decisions) {
        list.appendChild(el('li', {}, [
          el('span', { class: 'mono', text: entry.unit }),
          el('span', { text: entry.act_ids.join(', ') }),
        ]));
      }
      wrapper.appendChild(list);
    }

    wrapper.appendChild(el('h6', { text: 'Actualité d’effet de clôture' }));
    if (effects.length === 0) {
      wrapper.appendChild(el('p', { class: 'empty', text: 'Aucun effet de clôture courant projeté.' }));
    } else {
      const list = el('ul', { class: 'reconciliation-closure-effects' });
      for (const entry of effects) {
        list.appendChild(el('li', {}, [
          el('span', { class: 'mono', text: entry.unit }),
          el('span', { text: entry.act_ids.join(', ') }),
        ]));
      }
      wrapper.appendChild(list);
    }

    wrapper.appendChild(el('p', {
      class: 'card-note',
      text: 'Ce sont deux faits distincts : superséder une décision ne retire pas '
        + 'automatiquement l’effet de clôture qu’elle portait.',
    }));
    return wrapper;
  }

  /** Un acte humain, avec sa relation à une proposition lorsqu'il en a une. */
  function recordedActItem(act) {
    const node = el('li', { class: 'reconciliation-act' }, [
      el('p', { class: 'mono', text: act.entry_id }),
      el('p', { class: 'reconciliation-act-content', text: act.content }),
    ]);
    if (act.responds_to !== null && act.responds_to !== undefined) {
      node.appendChild(el('p', {
        class: 'reconciliation-act-relation',
        text: `${act.responds_to.proposal_id} — ${label.proposalRelation(act.responds_to.relation)}`,
      }));
    }
    return node;
  }

  /** Une proposition CCR, ses options, et les quatre gestes humains. */
  function proposalItem(proposal, item) {
    const node = el('li', { class: 'reconciliation-proposal' }, [
      el('p', { class: 'mono', text: proposal.entry_id }),
      badge(label.reconciliationEntryKind('RECONCILIATION_PROPOSED')),
    ]);

    const options = Array.isArray(proposal.options) ? proposal.options : [];
    if (options.length === 0) {
      node.appendChild(el('p', { class: 'empty', text: 'Aucune option.' }));
    } else {
      // `PROPOSITION ≠ DÉCISION`, dit au-dessus du contenu et non en note de
      // bas de bloc : c'est la première chose à lire quand six options
      // apparaissent d'un coup.
      node.appendChild(el('p', {
        class: 'proposal-banner',
        text: 'Proposition CCR — elle ne décide rien. Aucune option n’est recommandée, '
          + 'et les choisir n’est pas prévu : seuls les gestes humains ci-dessous portent une autorité.',
      }));
      const list = el('div', { class: 'reconciliation-options' });
      // Ordre du serveur, tel quel. Une position n'est ni un rang, ni une
      // préférence, ni une recommandation — le compteur dit « sur combien »,
      // jamais « à quel rang ».
      let index = 0;
      for (const option of options) {
        index += 1;
        const block = el('section', {
          class: 'reconciliation-option',
          attrs: { 'data-option': String(option.option_id) },
        }, [
          el('p', { class: 'option-head' }, [
            el('strong', { text: `Option ${formatCount(index)} sur ${formatCount(options.length)}` }),
            el('span', { class: 'mono muted', text: String(option.option_id) }),
          ]),
          // Contenu intégral, jamais résumé, jamais titré : le modèle de
          // données ne porte pas de titre, et en fabriquer un ajouterait un
          // champ métier que personne n'a enregistré.
          el('p', { class: 'option-content', text: option.content }),
        ]);
        list.appendChild(block);
      }
      node.appendChild(list);
      node.appendChild(el('p', {
        class: 'card-note',
        text: 'Les options ne sont pas classées : leur ordre est celui de l’enregistrement, '
          + 'et le numéro ci-dessus ne dit que la position dans cette liste.',
      }));
    }

    node.appendChild(humanControls(proposal, item, options));
    return node;
  }

  /**
   * Les quatre gestes humains — et leurs DEUX opérations réelles.
   *
   * ```text
   * ACCEPT · REJECT    une RÉPONSE, sans effet
   * MODIFY · REPLACE   un ACTE humain, qui porte son propre contenu
   * ```
   *
   * `ACCEPT` n'est pas `ADOPTS` : l'interface ne les confond pas, parce que le
   * contrat ne les confond pas.
   */
  function humanControls(proposal, item, options) {
    const wrapper = el('div', { class: 'reconciliation-controls' });

    const statement = el('input', {
      class: 'reconciliation-provenance',
      attrs: {
        type: 'text',
        'aria-label': 'Justification de votre geste (provenance déclarée)',
        placeholder: 'Pourquoi ce geste — provenance déclarée',
      },
    });
    wrapper.appendChild(statement);

    // `reconciliation-response-option`, et non `reconciliation-option` : ce
    // sélecteur désigne l'option **concernée par la réponse**, il n'est pas une
    // option de la proposition. Partager leur nom laissait croire que choisir
    // ici revenait à élire une option — ce que le contrat exclut.
    // Deux groupes, jamais une hiérarchie.
    //
    // Les quatre gestes se lisaient en file, tous du même poids visuel, alors
    // qu'ils relèvent de DEUX opérations aux effets différents. Les regrouper
    // rend cette différence lisible avant le clic. Aucun des deux groupes n'est
    // promu : ni ordre de préférence, ni bouton principal, ni recommandation —
    // `PROPOSITION ≠ DÉCISION` vaut aussi pour la mise en page.
    const responseGroup = el('fieldset', { class: 'gesture-group' }, [
      el('legend', { text: 'Réponse' }),
      el('p', {
        class: 'group-note',
        text: 'Enregistre un fait historique. Sans effet : ne clôt rien, ne supersède rien, '
          + 'et ne vaut pas adoption.',
      }),
    ]);
    const actGroup = el('fieldset', { class: 'gesture-group' }, [
      el('legend', { text: 'Acte humain' }),
      el('p', {
        class: 'group-note',
        text: 'Enregistre votre propre formulation, sous votre autorité. Exige que vous '
          + 'écriviez ce que vous portez.',
      }),
    ]);

    const optionSelect = el('select', {
      class: 'reconciliation-response-option',
      attrs: { 'aria-label': 'Option concernée (facultative)' },
    }, [el('option', { attrs: { value: '' }, text: 'aucune option désignée' })]);
    // Le rang lu à l'écran, puis l'identifiant. L'utilisateur vient de lire
    // « Option 3 sur 6 » ; lui demander de retrouver seul `opt_000003` faisait
    // reposer un geste qui porte autorité sur une correspondance de mémoire.
    //
    // Le rang reste ce que l'affichage en dit — une position dans l'ordre du
    // serveur, jamais un classement — et la valeur soumise demeure exactement
    // l'identifiant canonique.
    let rank = 0;
    for (const option of options) {
      rank += 1;
      optionSelect.appendChild(el('option', {
        attrs: { value: option.option_id },
        text: `Option ${formatCount(rank)} sur ${formatCount(options.length)} — ${option.option_id}`,
      }));
    }
    responseGroup.appendChild(optionSelect);

    const content = el('textarea', {
      class: 'reconciliation-content',
      attrs: {
        rows: '3',
        'aria-label': 'Votre formulation, pour modifier ou remplacer',
        placeholder: 'Votre formulation — exigée pour modifier ou remplacer',
      },
    });
    actGroup.appendChild(content);

    const scope = scopeOfProposal(proposal, item);

    /**
     * Retour visuel pendant le geste.
     *
     * L'intégrité, elle, était déjà acquise : la clé d'idempotence empêche un
     * second clic de produire un second enregistrement. Ce qui manquait était
     * le signe, à l'endroit du clic, que le premier avait été pris. Rien ici ne
     * réessaie, ne rejoue, ni ne décide — le bouton dit seulement qu'il attend.
     */
    // Seul le bouton actionné change d'état. Neutraliser ses voisins aurait
    // introduit une règle d'interaction que personne n'a demandée — et rien ne
    // l'exige : l'intégrité tient déjà par la clé d'idempotence, pas par
    // l'écran.
    function setBusy(active, acting, idleText) {
      acting.disabled = active;
      acting.setAttribute('aria-busy', active ? 'true' : 'false');
      acting.textContent = active ? `${idleText} — en cours…` : idleText;
    }

    for (const geste of [
      { id: 'ACCEPT', text: 'Accepter (réponse)', host: responseGroup },
      { id: 'REJECT', text: 'Rejeter (réponse)', host: responseGroup },
      { id: 'MODIFIES', text: 'Modifier (acte humain)', host: actGroup },
      { id: 'REPLACES', text: 'Remplacer (acte humain)', host: actGroup },
    ]) {
      const button = el('button', {
        class: 'action',
        attrs: {
          type: 'button',
          'data-reconcile': geste.id,
          'data-proposal': proposal.entry_id,
          'aria-busy': 'false',
        },
        text: geste.text,
      });
      button.addEventListener('click', () => {
        if (typeof handlers.onReconcile !== 'function') return;
        if (button.disabled === true) return;
        setBusy(true, button, geste.text);
        const outcome = handlers.onReconcile({
          geste: geste.id,
          controversyId: item.controversy_id,
          proposalId: proposal.entry_id,
          statement: statement.value ?? '',
          optionId: optionSelect.value ?? '',
          content: content.value ?? '',
          scope,
        });
        // Un succès reconstruit la section : ces nœuds disparaissent avant
        // d'être réactivés. Le rétablissement sert le cas contraire — refus,
        // erreur réseau, issue indéterminée — où l'écran reste en place et doit
        // redevenir utilisable.
        Promise.resolve(outcome).then(
          () => setBusy(false, button, geste.text),
          () => setBusy(false, button, geste.text),
        );
      });
      geste.host.appendChild(button);
    }

    // Les deux groupes dans l'ordre du contrat — réponse, puis acte — et rien
    // dans cet ordre ne dit qu'il faudrait commencer par l'un.
    wrapper.appendChild(responseGroup);
    wrapper.appendChild(actGroup);
    wrapper.appendChild(el('p', {
      class: 'card-note',
      text: 'Accepter enregistre une réponse : c’est un fait historique, sans effet. '
        + 'Modifier ou remplacer enregistre un acte humain, qui porte votre formulation.',
    }));
    return wrapper;
  }

  /**
   * Provenance déclarée d'une entrée, lue dans la projection `attribution`.
   *
   * `PROVENANCE ≠ AUTHORITY` (§10.4) : ce texte dit d'où l'humain fait venir son
   * geste, il ne le rend ni fondé, ni vrai. Les trois formes du contrat sont
   * rendues distinctement — une référence n'est pas un énoncé.
   *
   * Rend `null` lorsque l'entrée n'en porte aucune : l'absence est le fait
   * exact, et aucune formule ne vient la combler.
   */
  function provenanceText(item, entryId) {
    const attributions = Array.isArray(item.attribution) ? item.attribution : [];
    const found = attributions.find((entry) => entry.entry_id === entryId);
    if (found === undefined) return null;
    const provenance = found.provenance;
    if (provenance === undefined || provenance === null) return null;
    if (provenance.kind === 'DECLARED') return `« ${provenance.statement} »`;
    if (provenance.kind === 'CONTROVERSY_AUTHORITY') {
      return `autorité de controverse ${provenance.entry_id}`;
    }
    if (provenance.kind === 'LEGACY_DECISION') {
      return `décision antérieure ${provenance.decision_id}`;
    }
    return null;
  }

  /**
   * Périmètre d'une proposition, tel que le serveur l'a enregistré.
   *
   * Repris depuis la projection, jamais reconstruit : un périmètre inventé par
   * le navigateur serait soumis au service comme s'il venait de l'humain.
   */
  function scopeOfProposal(proposal, item) {
    const scopes = Array.isArray(item.scopes) ? item.scopes : [];
    const found = scopes.find((entry) => entry.entry_id === proposal.entry_id);
    if (found === undefined) return null;
    return { scope_kind: found.scope_kind, scope: found.scope };
  }

  /**
   * Demande d'une proposition assistée.
   *
   * La disponibilité vient du serveur — le navigateur n'en décide pas, et n'en
   * code aucune valeur. Tant que la projection V5 est `AVAILABLE`, le geste est
   * offert ; c'est le service qui refusera, avec son motif, s'il le doit.
   */
  function proposeControl(item, runView) {
    const wrapper = el('div', { class: 'reconciliation-propose' });

    const slotSelect = el('select', {
      class: 'reconciliation-expert',
      attrs: { 'aria-label': 'Expert qui produira la proposition' },
    });
    const experts = runView.run && runView.run.experts ? runView.run.experts : {};
    for (const slot of Object.keys(experts)) {
      slotSelect.appendChild(el('option', {
        attrs: { value: slot },
        text: `${label.expertSlot(slot)} (${label.actor(experts[slot].provider)})`,
      }));
    }
    wrapper.appendChild(slotSelect);

    const button = el('button', {
      class: 'action',
      attrs: { type: 'button', 'data-reconcile': 'PROPOSE', 'data-controversy': item.controversy_id },
      text: 'Proposer une réconciliation',
    });
    button.addEventListener('click', () => {
      if (typeof handlers.onReconcile !== 'function') return;
      handlers.onReconcile({
        geste: 'PROPOSE',
        controversyId: item.controversy_id,
        expertSlot: slotSelect.value ?? '',
      });
    });
    wrapper.appendChild(button);

    wrapper.appendChild(el('p', {
      class: 'card-note',
      text: 'Demander une proposition n’engage aucune décision : ce qui reviendra sera '
        + 'une proposition d’origine CCR, sans autorité.',
    }));
    return wrapper;
  }

  /**
   * Ce qui travaille en ce moment, et depuis quand.
   *
   * Rend `null` quand rien n'est en vol — un bandeau vide serait pire que pas
   * de bandeau. Tous les faits viennent de `in_flight`, calculé par le serveur :
   * cette fonction n'en déduit aucun, et n'affiche ni pourcentage, ni barre, ni
   * temps restant.
   *
   * Ce bandeau existe parce que le run réel `CCR-20260404-001` a passé dix-huit
   * minutes en initialisation sans que l'écran ne dise qui était appelé.
   */
  function inFlightNodes(runView) {
    const flight = runView.in_flight;
    if (flight === null || flight === undefined) return null;

    const panel = el('p', { class: 'run-inflight', attrs: { 'data-inflight': flight.kind } });
    const named = `${label.expertSlot(flight.expert_slot)} — ${label.actor(flight.provider)}`;
    panel.appendChild(el('strong', { text: `${label.operationKind(flight.kind)} · ${named}` }));

    // La position n'est affichée que si le serveur l'a établie. Un `null` reste
    // un `null` : mieux vaut ne rien dire que d'inventer « étape 1/2 ».
    if (flight.sequence !== null && flight.sequence !== undefined) {
      panel.appendChild(el('span', {
        class: 'muted',
        text: ` · étape ${formatCount(flight.sequence.position)}/${formatCount(flight.sequence.total)}`,
      }));
    }
    panel.appendChild(el('span', { text: ' · ' }));
    panel.appendChild(elapsedNode(flight.started_at, 'run'));
    panel.appendChild(el('span', {
      class: 'muted',
      text: ` · engagée à ${formatInstant(flight.started_at)}`,
    }));
    return panel;
  }

  /**
   * Issue **métier** d'une opération — la phrase, puis le code.
   *
   * Le contrat l'exige dans cet ordre : « Le code technique exact reste
   * disponible dans un niveau de détail, jamais à la place de la phrase. »
   *
   * Rend un tableau vide lorsque le reçu ne porte pas d'issue. Une absence
   * n'est pas un succès, et n'est donc pas traduite en « effectuée ».
   */
  function outcomeNodes(receipt) {
    const domain = receipt === null || receipt === undefined ? null : receipt.domain_outcome;
    if (domain === null || domain === undefined || typeof domain.outcome !== 'string') return [];

    const nodes = [el('span', {
      class: 'outcome-sentence',
      text: label.proposalOutcome(domain.outcome),
    })];

    // Détail technique : la cause telle que le domaine l'a nommée, jamais une
    // cause reconstruite depuis le nom de l'issue.
    const details = [];
    if (typeof domain.reason === 'string' && domain.reason.length > 0) {
      // Le **code exact** d'abord — c'est lui qu'on cite dans un rapport — puis
      // sa traduction. Garder la seule glose rendrait le diagnostic public du
      // moteur introuvable, ce que le §7 interdit explicitement.
      const translated =
        domain.outcome === 'INVALID_OUTPUT' ? label.proposerRefusal(domain.reason)
          : domain.outcome === 'REVALIDATION_REFUSED' ? label.revalidationCheck(domain.reason)
            : domain.reason;
      details.push(translated === domain.reason ? domain.reason : `${domain.reason} — ${translated}`);
    }
    if (typeof domain.detail === 'string' && domain.detail.length > 0) details.push(domain.detail);

    if (details.length > 0) {
      const technical = el('details', { class: 'outcome-detail' });
      technical.appendChild(el('summary', { text: 'Détail technique' }));
      technical.appendChild(el('p', { class: 'mono', text: `${domain.outcome} · ${details.join(' · ')}` }));
      if (typeof domain.invocation_id === 'string' && domain.invocation_id.length > 0) {
        // L'engagement reste inscrit même quand rien n'a été enregistré : le
        // dire sans donner sa référence rendrait l'affirmation invérifiable.
        technical.appendChild(el('p', { class: 'mono', text: `invocation ${domain.invocation_id}` }));
      }
      nodes.push(technical);
    }
    return nodes;
  }

  /**
   * Situation du run, en une phrase composée de faits déjà autoritaires.
   *
   * Composer n'est pas décider : `state`, `round` et `next_step_source_slot`
   * viennent de la projection, et la phrase changerait toute seule si elle
   * changeait d'avis. Aucune recommandation n'est formulée — la priorité d'une
   * action appartient à une frontière que ce slice n'ouvre pas.
   */
  function situationSentence(run) {
    const operational = run.operational_state;
    const named = (slot) => `${label.expertSlot(slot)} (${label.actor(run.experts[slot].provider)})`;
    const parts = [`Tour ${formatCount(operational.round)}`];

    // Une phrase riche seulement lorsqu'un fait la porte. Sinon, le libellé
    // autoritaire, en vocabulaire utilisateur — jamais une supposition sur ce
    // que l'expert « fait » : CCR ne l'observe pas.
    if (operational.active_expert_slot !== null) {
      parts.push(`au tour de ${named(operational.active_expert_slot)}`);
    } else if (operational.next_step_source_slot !== null) {
      // `next_step_source_slot` est la SOURCE du prochain transfert : l'expert
      // dont la réponse sera transmise, donc celui qui vient de parler. Le
      // nommer « prochain intervenant » disait le contraire du champ, et
      // contredisait la carte de transmission juste en dessous.
      parts.push(`dernière réponse : ${named(operational.next_step_source_slot)}`);
    } else {
      parts.push(label.state(operational.state));
    }
    if (operational.pending_operation !== null) {
      parts.push(`opération ${operational.pending_operation.kind} engagée`);
    }
    return parts.join(' · ');
  }

  /** Faits d'état, en second rang — le mode n'est plus le cœur de la phrase. */
  function situationBadges(run) {
    const operational = run.operational_state;
    const row = el('p', { class: 'run-situation-meta' });
    row.appendChild(badge(label.state(operational.state)));
    // Le vocabulaire vient de `labels.js` : aucune comparaison d'état ici.
    row.appendChild(badge(label.control(operational.control)));
    return row;
  }

  /**
   * Carte d'expert — le rôle d'abord, le moteur ensuite.
   *
   * Deux experts peuvent partager un fournisseur : c'est le rôle qui les
   * distingue, et il porte donc le titre. La session complète descend dans
   * Inspect ; ce qui reste ici est ce qu'on lit d'un coup d'œil.
   */
  function nativeExpertCard(runView, slot) {
    const expert = runView.run.experts[slot];
    const contribution = runView.presentation?.latest_contributions?.[slot] ?? null;
    // Le RÔLE d'abord, le fournisseur ensuite : deux slots peuvent partager un
    // moteur, et c'est le rôle qui les distingue. La couleur soutient la
    // distinction, elle ne la porte jamais seule — le mot est toujours écrit.
    const head = el('h4', { class: 'expert-name expert-line' });
    head.appendChild(el('span', {
      class: `expert-role is-${slot}`,
      text: label.expertSlot(slot),
    }));
    head.appendChild(el('span', { class: 'expert-provider', text: label.actor(expert.provider) }));
    const card = el('article', { class: `expert-card role-${slot}` }, [
      head,
      el('p', {
        class: 'expert-session',
        text: expert.session_status === 'BOUND' ? 'session liée' : 'aucune session',
      }),
    ]);
    if (contribution === null) {
      card.appendChild(el('p', { class: 'card-note', text: 'Aucune contribution journalisée.' }));
      return card;
    }
    card.appendChild(el('p', {
      class: 'card-note',
      text: `Dernière contribution · round ${formatCount(contribution.round)} · ${formatInstant(contribution.timestamp)}`,
    }));
    return card;
  }

  /**
   * Effet publié pour une opération, ou `null`.
   *
   * Lu sur la projection de présentation. Absent, la carte ne dit rien de la
   * conséquence — elle ne la devine pas.
   */
  function effectOf(runView, operation) {
    const actions = runView.presentation?.actions;
    if (!Array.isArray(actions)) return null;
    for (const action of actions) {
      if (action.operation === operation) return action;
    }
    return null;
  }

  /**
   * Signal d'existence d'une proposition, dans le parcours principal.
   *
   * Il dit **qu'une proposition existe et peut être consultée**. Rien de plus.
   *
   * ```text
   * PROPOSITION DISPONIBLE   ≠   obligation d'agir
   *                          ≠   priorité sur le passage de témoin
   *                          ≠   suspension du débat
   *                          ≠   décision
   * ```
   *
   * Il ne crée aucun état : la condition se lit sur la projection V5 déjà
   * servie avec le run, et aucun champ n'est ajouté pour lui. Il ne dérive
   * aucune actualité, ne compte pas les réponses et ne conclut pas de leur
   * absence — une proposition déjà répondue reste une proposition consultable,
   * et l'inverse aurait fabriqué un « en attente » que le contrat ne connaît
   * pas.
   *
   * Il ne duplique pas la proposition : il donne le chemin vers la seule
   * surface qui la porte.
   */
  /**
   * Combien de propositions la projection V5 porte-t-elle réellement ?
   *
   * Une seule lecture, partagée par le signal U-01 et par le retour contextuel
   * qui le raccompagne. Deux comptes séparés finiraient par diverger, et
   * l'écran offrirait un chemin de retour vers un aller qui n'existe pas.
   */
  function reconciliationProposalCount(runView) {
    const projection = runView.reconciliations;
    if (projection === null || projection === undefined) return 0;
    if (projection.availability !== 'AVAILABLE') return 0;
    let proposals = 0;
    for (const item of Array.isArray(projection.items) ? projection.items : []) {
      proposals += Array.isArray(item.proposals) ? item.proposals.length : 0;
    }
    return proposals;
  }

  function reconciliationSignalNodes(runView) {
    const proposals = reconciliationProposalCount(runView);
    if (proposals === 0) return [];

    const card = el('div', { class: 'card proposal-signal' });
    card.appendChild(el('div', { class: 'card-head' }, [
      el('strong', { text: 'Réconciliation' }),
    ]));
    card.appendChild(el('p', {
      class: 'card-note',
      text: proposals === 1
        ? 'Une proposition de réconciliation est disponible.'
        : `${formatCount(proposals)} propositions de réconciliation sont disponibles.`,
    }));
    // Reprise mot pour mot de ce que dit la section elle-même : l'écran ne
    // doit pas tenir deux discours sur ce qu'est une proposition.
    card.appendChild(el('p', {
      class: 'card-note',
      text: 'Une proposition n’est pas une décision.',
    }));

    const button = el('button', {
      class: 'action',
      attrs: { type: 'button', 'data-goto': 'reconciliation' },
      text: proposals === 1 ? 'Voir la proposition' : 'Voir les propositions',
    });
    button.addEventListener('click', () => {
      if (typeof handlers.onShowReconciliation === 'function') handlers.onShowReconciliation();
    });
    card.appendChild(button);
    return [card];
  }

  /**
   * Prochaine action — **priorité visuelle**, jamais une capacité.
   *
   * L'ordre est fixé par le contrat : une reprise disponible prime, puis un
   * transfert autorisé, puis un envoi autorisé. Aucune de ces branches
   * n'accorde quoi que ce soit : chacune se contente de lire `allowed` et
   * `available_actions`, et de choisir ce qu'on regarde d'abord.
   */
  function nextActionNodes(runView) {
    const run = runView.run;
    const domains = ['initialization', 'step', 'send', 'handoff'];
    // Une reprise **matérialisée**, pas la simple existence de l'onglet.
    //
    // Un domaine sain n'offre aucun geste et ne signale aucun conflit : il ne
    // promeut rien. Un domaine qui propose un geste, ou qui rapporte des faits
    // contradictoires, exige une attention humaine — et c'est cela, une reprise
    // nécessaire. Aucun statut n'est comparé ici : ce sont deux présences de
    // données, produites par le classifieur du cœur.
    const pending = domains.filter((domain) => {
      const view = run.recovery[domain];
      return (view.available_actions ?? []).length > 0 || (view.conflicts ?? []).length > 0;
    });
    const step = run.operations.step;
    const sendSlot = ['author', 'challenger'].find(
      (slot) => run.operations.experts[slot].send.allowed === true,
    );

    const card = el('div', { class: 'next-action' });
    card.appendChild(el('h3', { text: 'Prochaine étape' }));

    if (pending.length > 0) {
      // Deux situations, deux phrases. Un domaine peut exiger une attention
      // **sans** offrir le moindre geste — c'est le cas d'un conflit de faits.
      // Annoncer « une reprise est disponible » y promettrait une action qui
      // n'existe pas : la carte dit ce que les faits reçus permettent de dire,
      // et rien de plus.
      const actionable = pending.filter((domain) => (run.recovery[domain].available_actions ?? []).length > 0);
      const named = (domains) => domains.map((domain) => label.recoveryDomain(domain)).join(', ');
      if (actionable.length > 0) {
        card.appendChild(el('p', {
          class: 'next-action-line',
          text: `Une reprise est disponible : ${named(actionable)}.`,
        }));
        card.appendChild(el('p', {
          class: 'card-note',
          text: 'Les gestes de reprise et leurs conséquences sont dans l’onglet Recovery.',
        }));
      } else {
        card.appendChild(el('p', {
          class: 'next-action-line',
          text: `Une reprise requiert votre attention : ${named(pending)}.`,
        }));
        card.appendChild(el('p', {
          class: 'card-note',
          text:
            'Aucun geste de reprise n’est proposé dans cet état — les faits en cause ' +
            'sont détaillés dans l’onglet Recovery.',
        }));
      }
      return card;
    }

    if (step.allowed === true) {
      const source = `${label.expertSlot(step.source_slot)} — ${label.actor(run.experts[step.source_slot].provider)}`;
      const targetSlot = step.target_slot;
      const target = `${label.expertSlot(targetSlot)} — ${label.actor(run.experts[targetSlot].provider)}`;
      // Une carte d'action énonce un verbe : c'est ce que le bouton fera.
      // L'ambiguïté que cette ligne semblait porter — « prochain intervenant :
      // Challenger » suivi de « transmettre la réponse de Challenger » — ne
      // venait pas d'elle mais de l'en-tête, qui nommait « intervenant » la
      // SOURCE du prochain transfert. C'est l'en-tête qui a été corrigé.
      card.appendChild(el('p', {
        class: 'next-action-line',
        text: `Transmettre la réponse de ${source} à ${target}.`,
      }));
      // V-04 : le tour ouvert reste au premier rang — il dit où l'on va. Le
      // volume transmis est une mesure de transport : vraie, utile au
      // diagnostic, sans effet sur la décision de cliquer. Il descend sous la
      // divulgation, il n'est pas retiré.
      card.appendChild(el('p', {
        class: 'card-note',
        text: `Ouvre le tour ${formatCount(step.next_round)}.`,
      }));
      const technical = el('details', { class: 'tech-details' });
      technical.appendChild(el('summary', { text: 'Détails techniques' }));
      technical.appendChild(facts([
        ['Octets transmis', formatCount(step.payload_bytes)],
        ['Réponse source', step.source_event_id ?? '—', { mono: true }],
        ['Tour ouvert', formatCount(step.next_round)],
      ]));
      card.appendChild(technical);
      const consequence = effectSentence(effectOf(runView, 'STEP'));
      if (consequence !== null) card.appendChild(el('p', { class: 'next-action-effect', text: consequence }));
      card.appendChild(nativeControlCard('STEP', step));
      return card;
    }

    if (sendSlot !== undefined) {
      card.appendChild(el('p', {
        class: 'next-action-line',
        text: `Écrire à ${label.expertSlot(sendSlot)} — ${label.actor(run.experts[sendSlot].provider)}.`,
      }));
      const consequence = effectSentence(effectOf(runView, 'SEND'));
      if (consequence !== null) card.appendChild(el('p', { class: 'next-action-effect', text: consequence }));
      const jump = el('button', { class: 'secondary', attrs: { type: 'button', id: 'goto-compose' }, text: 'Aller au composeur' });
      jump.addEventListener('click', () => {
        const target = doc.getElementById('human-compose');
        if (target === null) return;
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView();
        const field = doc.getElementById('send-content');
        if (field !== null && typeof field.focus === 'function') field.focus();
      });
      card.appendChild(jump);
      return card;
    }

    card.appendChild(el('p', {
      class: 'empty',
      text: 'Aucune action n’est proposée dans cet état.',
    }));
    card.appendChild(el('p', {
      class: 'card-note',
      text: `Transfert : ${label.stepSource(step.source_status)}.`,
    }));
    return card;
  }

  /**
   * Gouvernance — trois faits compacts, aucun tableau de bord.
   *
   * Aucune valeur n'est fabriquée : une couverture partielle se dit, un usage
   * absent se dit, et une estimation indisponible se dit. Rien ne devient zéro
   * pour remplir une ligne.
   */
  /**
   * Gouvernance en grille : un fait par cellule, lisible d'un coup d'œil.
   *
   * Chaque cellule sépare une **valeur de tête** et une **précision**. Aucun mot
   * n'est retiré au passage : le découpage est typographique, et les
   * formulations qui distinguent une absence d'un zéro restent intégrales.
   *
   * `unknown` grise la valeur lorsqu'elle énonce une ignorance plutôt qu'un
   * chiffre. La couleur ne remplace pas la phrase, elle la double.
   */
  function govGrid(cells) {
    const list = el('dl', { class: 'gov-grid' });
    for (const cell of cells) {
      const value = el('span', {
        class: cell.unknown === true ? 'gov-value is-unknown' : 'gov-value',
        text: cell.value,
      });
      if (typeof cell.title === 'string') value.setAttribute('title', cell.title);
      const dd = el('dd', {}, [value]);
      if (typeof cell.note === 'string' && cell.note.length > 0) {
        dd.appendChild(el('span', { class: 'gov-note', text: cell.note }));
      }
      list.appendChild(el('div', { class: 'gov-cell' }, [
        el('dt', { class: 'gov-label', text: cell.label }),
        dd,
      ]));
    }
    return list;
  }

  function governanceNodes(runView) {
    const run = runView.run;
    const quota = run.invocation_quota;
    const usage = run.usage;
    const cost = run.cost_estimate;
    const rows = [];

    // Couverture partielle : le compte n'est PAS un total du run.
    //
    // Sur un run antérieur au journal d'invocations, `consumed` ne dit rien de
    // l'activité passée. L'afficher comme « 0 invocation engagée » en ferait un total,
    // et ce total serait faux : c'est le mensonge par omission que le contrat
    // interdit. Le nombre disparaît donc, et la couverture prend sa place.
    const preLedger = quota.coverage === 'PRE_LEDGER';
    if (preLedger) {
      const limit =
        quota.kind === 'NONE'
          ? 'aucune limite CCR'
          : `limite CCR ${formatCount(quota.limit)}`;
      rows.push({
        label: 'Invocations',
        value: limit,
        note: 'aucun journal d’invocations sur ce run — l’activité antérieure n’est pas comptée',
        unknown: true,
      });
    } else if (quota.kind === 'NONE') {
      rows.push({
        label: 'Invocations',
        value: pluralize(quota.consumed, 'invocation engagée', 'invocations engagées'),
        note: 'aucune limite CCR',
      });
    } else {
      // « ÉPUISÉ » reste en capitales : c'est une limite atteinte, dite
      // explicitement plutôt que laissée à déduire d'un « 0 restant ».
      const exhausted = quota.exhausted === true ? ' · ÉPUISÉ : plus aucune invocation ne sera admise' : '';
      rows.push({
        label: 'Invocations',
        value: `${formatCount(quota.consumed)} engagées sur ${formatCount(quota.limit)}`,
        note: `${pluralize(quota.remaining, 'restante', 'restantes')}${exhausted}`,
      });
    }

    const counts = usage.invocations;
    const observed = counts.provider_reported.observed;
    const unobserved = counts.provider_reported.unobserved;
    // « sans observation » n'est pas « zéro usage » : ces invocations ont eu
    // lieu, et ce que le fournisseur en a consommé n'est pas connu. La
    // formulation dit l'ignorance, jamais une valeur nulle.
    if (observed === 0) {
      rows.push({
        label: 'Usage',
        value: 'aucune observation fournisseur',
        note: `sur ${pluralize(counts.total, 'invocation', 'invocations')}`,
        unknown: true,
      });
    } else {
      rows.push({
        label: 'Usage',
        value: pluralize(observed, 'invocation observée', 'invocations observées'),
        note:
          unobserved === 0
            ? 'aucune observation manquante'
            : pluralize(unobserved, 'invocation sans observation', 'invocations sans observation'),
      });
    }

    if (cost.pricing.kind === 'NONE') {
      rows.push({
        label: 'Estimation',
        value: 'indisponible',
        note: 'aucun catalogue tarifaire n’est configuré, il n’existe donc aucun prix à appliquer',
        unknown: true,
      });
    } else {
      const amounts = [];
      for (const provider of cost.providers) {
        for (const bucket of provider.amounts_by_currency) {
          const approx = bucket.rounded_amount_invocations > 0 ? '≈' : '';
          amounts.push(`${label.actor(provider.provider)} ${approx}${bucket.estimated_amount_sum} ${bucket.currency}`);
        }
      }
      rows.push({
        label: 'Estimation',
        value: amounts.length === 0 ? 'aucune invocation estimable' : amounts.join(' · '),
        note: `catalogue ${cost.pricing.catalog_version}`,
        unknown: amounts.length === 0,
      });
    }

    // Observation monétaire du fournisseur — **à côté**, jamais à la place.
    //
    // Elle est lue sur `usage.providers[].provider_reported_money`, et porte
    // son propre nom. Une estimation absente ne s'en trouve jamais comblée :
    // ce sont deux affirmations d'origines différentes, et aucune ne valide
    // l'autre.
    // L'arrondi n'existe qu'à l'affichage. La somme rapportée par le fournisseur
    // n'est ni recalculée, ni réécrite, ni arrondie en mémoire : `exact` conserve
    // la valeur reçue, telle quelle, et la porte au survol.
    const reported = [];
    const exact = [];
    for (const provider of usage.providers ?? []) {
      const money = provider.provider_reported_money;
      if (money === undefined || money === null) continue;
      for (const bucket of money.by_currency ?? []) {
        const who = label.actor(provider.provider);
        const invocations = pluralize(bucket.covered_invocations, 'invocation', 'invocations');
        reported.push(
          `${who} ${formatMoney(bucket.observed_amount_sum, bucket.currency)} sur ${invocations}`,
        );
        exact.push(
          `${who} ${String(bucket.observed_amount_sum)} ${bucket.currency} sur ${invocations}`,
        );
      }
    }
    if (reported.length > 0) {
      rows.push({
        label: 'Montant rapporté par le fournisseur',
        value: reported.join(' · '),
        title: `Montant exact rapporté : ${exact.join(' · ')}`,
      });
    }

    return [el('h3', { text: 'Gouvernance' }), govGrid(rows), el('p', {
      class: 'card-note',
      text:
        'Ce que CCR s’autorise, ce qui a été observé, ce qui s’en dérive — et, le cas ' +
        'échéant, ce qu’un fournisseur a lui-même publié. Des faits distincts, jamais ' +
        'l’un à la place de l’autre.',
    })];
  }

  /**
   * Espace de travail natif : comprendre, puis lire, puis agir.
   *
   * L'identité technique, les alias et le runtime sont descendus dans Inspect.
   * Le fil occupe le corps de l'écran, et les actions existantes gardent leur
   * sémantique — leur enrichissement appartient à la frontière suivante.
   */
  function nativeOverviewNodes(runView) {
    const run = runView.run;
    const blocks = [
      el('p', { class: 'run-situation', text: situationSentence(run) }),
      situationBadges(run),
    ];

    // Ce qui est en vol passe avant tout le reste : c'est la question qu'on se
    // pose en arrivant sur l'écran, et la seule à laquelle l'attente répond mal.
    const flight = inFlightNodes(runView);
    if (flight !== null) blocks.push(flight);

    const experts = el('div', { class: 'expert-cards' });
    for (const slot of ['author', 'challenger']) experts.appendChild(nativeExpertCard(runView, slot));
    blocks.push(experts);

    // Contexte initial : un objet unique lorsque la projection S1 le démontre
    // exact. Sa présence décide du rendu des `prompt_sent` humains dans le fil.
    const context = runView.presentation?.initial_context ?? null;
    initialContextShown = context !== null && context.status === 'AVAILABLE';
    if (initialContextShown) {
      const details = el('details', { class: 'initial-context' });
      details.appendChild(el('summary', { text: 'Contexte initial' }));
      details.appendChild(markdownContent(context.content));
      blocks.push(details);
    } else if (context !== null && context.reason === 'INCONSISTENT') {
      blocks.push(el('p', {
        class: 'card-note attention',
        text: 'Les prompts d’initialisation diffèrent : aucun n’est retenu comme contexte initial.',
      }));
    }

    // Le fil, rempli par la chronologie déjà chargée par la sélection du run.
    threadNode = el('div', { class: 'thread-host' }, [
      el('p', { class: 'empty', text: 'Chargement des contributions…' }),
    ]);
    const step = run.operations.step;
    blocks.push(nextActionNodes(runView));
    // À côté de la zone qui répond à « que puis-je faire maintenant ? », et non
    // à sa place : le passage de témoin garde son rang, le signal ajoute une
    // possibilité sans en retirer aucune.
    for (const node of reconciliationSignalNodes(runView)) blocks.push(node);
    blocks.push(el('h3', { text: 'Conversation' }), threadNode);

    // ---- Intervenir : le geste humain, à portée immédiate.
    blocks.push(el('h3', { class: 'actions-title', text: 'Intervenir', attrs: { id: 'human-compose' } }));
    const compose = el('div', { class: 'cards compact' });
    compose.appendChild(nativeSendCard(runView));
    blocks.push(compose);

    // ---- Contrôles locaux : présents, mais plus au rang de l'action
    // principale. Ils ne partent pas, ils cessent de concurrencer.
    blocks.push(el('h3', { class: 'actions-title', text: 'Contrôles' }));
    const controls = el('div', { class: 'cards compact' });
    controls.appendChild(nativeControlCard('PAUSE', run.operations.pause, [], { primary: true }));
    controls.appendChild(nativeControlCard('RESUME', run.operations.resume,
      resumeConflictNotes(run.operations.resume), { primary: true }));
    blocks.push(controls);

    // ---- Le reste : ce qui n'est pas exécutable ici, et ce qui n'est pas
    // porté. Replié, jamais retiré — chaque motif reste lisible.
    const advanced = el('details', { class: 'actions-unavailable' });
    advanced.appendChild(el('summary', { text: 'Autres actions et limites' }));
    // V-06 : un geste autorisé mais sans effet a quitté le rang principal. Il
    // ne disparaît pas pour autant — le cœur l'accorde, et il reste offert ici,
    // avec son bouton, dans la surface secondaire qui existait déjà.
    for (const action of ['PAUSE', 'RESUME']) {
      const capability = action === 'PAUSE' ? run.operations.pause : run.operations.resume;
      if (!settledCapability(capability)) continue;
      advanced.appendChild(nativeControlCard(action, capability,
        action === 'RESUME' ? resumeConflictNotes(capability) : []));
    }
    advanced.appendChild(nativeHandoffCard(runView));
    // Le transfert garde une trace ici lorsqu'il n'est PAS l'action
    // principale : son motif de refus doit rester consultable.
    if (step.allowed !== true) {
      advanced.appendChild(nativeControlCard('STEP', step, [
        el('p', { class: 'card-note', text: `Source : ${label.stepSource(step.source_status)}.` }),
      ]));
    }
    advanced.appendChild(deferredCard('Décision', 'Non portée pour cette génération dans cette version.'));
    advanced.appendChild(deferredCard('Arrêt', 'Non porté pour cette génération dans cette version.'));
    blocks.push(advanced);

    // ---- V-03 : consommation et gouvernance en dernier.
    //
    // Elles se lisaient entre la prochaine étape et la conversation, donc avant
    // le travail lui-même. Ce sont des faits de consommation : on les consulte,
    // on ne commence pas par eux. Aucun calcul ni aucune donnée n'est touché —
    // seul leur rang dans la page change.
    for (const node of governanceNodes(runView)) blocks.push(node);
    return blocks;
  }

  /** Domaines en conflit, tels que la capacite les nomme — sans les relire. */
  function resumeConflictNotes(resume) {
    const domains = resume.conflicting_recovery_domains;
    if (!Array.isArray(domains) || domains.length === 0) return [];
    return [el('p', {
      class: 'card-note',
      text: `Faits contradictoires : ${domains.map((domain) => label.recoveryDomain(domain)).join(', ')}.`,
    })];
  }

  /**
   * Reprise native : quatre domaines, jamais fusionnes.
   *
   * Un bouton par geste **recu**. Aucune action absente n'apparait, et aucune
   * n'est declenchee par le rendu : seul un clic humain emet une requete.
   */
  function nativeRecoveryNodes(recovery) {
    // VIS-03 — le bloc « Faits connus » ne portait plus rien de distinct.
    //
    // Il répétait État et Contrôle, déjà donnés par « État du run » quelques
    // lignes plus bas, et exposait au premier niveau utilisateur la révision
    // SHA de la projection de reprise. Il disparaît comme BLOC VISUEL ; sa
    // seule donnée propre — cette révision, distincte de celle de la vue de
    // run — descend sous une divulgation, où elle reste vérifiable.
    //
    // Aucune projection Recovery n'est touchée : seule sa présentation change.
    const blocks = [];
    const revision = el('details', { class: 'tech-details' });
    revision.appendChild(el('summary', { text: 'Détails techniques de la reprise' }));
    revision.appendChild(facts([
      ['Révision de la projection de reprise', recovery.revision, { mono: true }],
    ]));

    // Un run sain n'a pas besoin de le répéter quatre fois. Le détail reste
    // entier, derrière un repli — MOVE/COLLAPSE, jamais DELETE.
    const domains = ['initialization', 'step', 'send', 'handoff'];
    const quiet = domains.every(
      (domain) =>
        (recovery.recovery[domain].available_actions ?? []).length === 0 &&
        (recovery.recovery[domain].conflicts ?? []).length === 0,
    );
    // Ce qui est dit ici est EXACTEMENT ce qui a été constaté : quatre domaines
    // de reprise, aucun geste proposé, aucun conflit signalé. Rien de plus.
    //
    // « Aucune reprise nécessaire » se lit vite comme « tout va bien ». CCR n'a
    // pas ce verdict à donner : la vivacité peut rester indéterminée, un
    // processus externe peut travailler, et l'absence d'ambiguïté ENREGISTRÉE
    // n'est pas une bonne santé constatée. La seconde phrase refuse ce saut.
    const attention = domains.filter(
      (domain) =>
        (recovery.recovery[domain].available_actions ?? []).length > 0 ||
        (recovery.recovery[domain].conflicts ?? []).length > 0,
    );
    const summary = el('div', { class: quiet ? 'health-summary' : 'health-summary is-attention' });
    if (quiet) {
      // Microcopy humaine approuvée, mot pour mot.
      //
      // Elle porte sur UN fait, et sur lui seul : aucun besoin de reprise n'est
      // signalé en ce moment. Elle n'affirme ni que le run est sain, ni que les
      // sessions répondent, ni que tout fonctionne — aucun champ canonique ne
      // l'établirait. Les faits techniques restent sous « Faits techniques du
      // run » et sous les divulgations, où ils sont vérifiables.
      summary.appendChild(el('h3', { text: 'Aucune reprise nécessaire' }));
      summary.appendChild(el('p', {
        text: 'Aucun besoin de reprise n’est actuellement signalé pour ce run.',
      }));
    } else {
      summary.appendChild(el('h3', { text: 'Une reprise attend votre décision' }));
      summary.appendChild(el('p', {
        text: `${pluralize(attention.length, 'domaine demande', 'domaines demandent')} votre `
          + `attention : ${attention.map((domain) => label.recoveryDomain(domain)).join(', ')}. `
          + 'Les gestes proposés ci-dessous viennent du cœur ; aucun n’est recommandé ici.',
      }));
    }
    blocks.push(summary);

    const host = quiet ? el('details', { class: 'recovery-quiet' }) : null;
    if (host !== null) {
      host.appendChild(el('summary', { text: 'Voir le détail des 4 domaines' }));
      blocks.push(host);
    }
    // La révision technique ferme la section, sous les domaines de reprise.
    blocks.push(revision);
    const push = (node) => (host === null ? blocks.push(node) : host.appendChild(node));

    for (const domain of domains) {
      const view = recovery.recovery[domain];
      push(el('h3', { text: label.recoveryDomain(domain) }));
      const head = el('div', { class: 'card-head' }, [
        el('strong', { text: label.recoveryStatus(view.status) }),
        badge(view.available_actions.length === 0 ? 'aucun geste' : `${String(view.available_actions.length)} geste(s)`),
      ]);
      const body = [head];
      for (const conflict of view.conflicts ?? []) {
        body.push(el('p', { class: 'card-note', text: conflict }));
      }
      for (const action of view.available_actions) {
        body.push(nativeRecoveryControl(domain, action));
      }
      push(el('div', { class: 'cards' }, [el('div', { class: 'card' }, body)]));
    }
    return blocks;
  }

  function nativeRecoveryControl(domain, action) {
    const children = [
      el('p', {
        class: 'card-note',
        text: `${label.recoveryAction(action.action)}${action.may_call_provider === true ? ' — peut appeler un fournisseur.' : '.'}`,
      }),
    ];
    let input = null;
    if (action.requires_note === true) {
      input = el('textarea', {
        class: 'recovery-note',
        attrs: {
          id: `recovery-note-${domain}-${action.action}`,
          rows: '2',
          'aria-label': 'Note humaine d’acquittement',
        },
      });
      children.push(
        el('p', { class: 'card-note', text: 'Une note explicite est obligatoire : elle est enregistrée telle quelle.' }),
        input,
      );
    }
    const button = el('button', {
      class: 'mutate',
      attrs: { type: 'button', 'data-recovery': `${domain}:${action.action}` },
      text: label.recoveryAction(action.action),
    });
    button.addEventListener('click', () => {
      if (typeof handlers.onRecover !== 'function') return;
      // Le geste est nomme : domaine ET action. Rien n'est choisi a la place
      // de l'humain, pas meme lorsqu'un seul geste est disponible.
      handlers.onRecover(
        { domain, action: action.action },
        input === null ? {} : { acknowledgementText: input.value ?? '' },
      );
    });
    children.push(button);
    return el('div', { class: 'card' }, children);
  }

  // ------------------------------------------------------------------------
  // Chronologie native (V2.1-IMP-19)
  // ------------------------------------------------------------------------

  /** Un expert se nomme par son rôle ; son moteur n'est qu'un attribut affiché. */
  function expertName(slot, provider) {
    return `${label.expertSlot(slot)} — ${label.actor(provider)}`;
  }

  /**
   * Provenance d'une entrée, rendue **par sa forme reçue**.
   *
   * Le discriminant vient du serveur, qui le tient de la classification gelée du
   * journal. Le navigateur ne le déduit ni du type d'événement, ni de l'acteur,
   * ni des champs présents.
   */
  function nativeProvenanceNodes(provenance) {
    if (provenance === null || typeof provenance !== 'object') return [];
    const shape = provenance.shape;

    if (shape === 'EXPERT_SESSION') {
      return [
        badge(expertName(provenance.expert_slot_id, provenance.provider)),
        el('span', { class: 'mono', text: provenance.session_id }),
      ];
    }
    if (shape === 'EXPERT_TARGET') {
      const out = [badge(`vers ${expertName(provenance.target_expert_slot_id, provenance.provider)}`)];
      // Une session absente n'est pas cherchée ailleurs : elle est simplement
      // tue. La reconstruire depuis un autre événement inventerait un fait.
      if (typeof provenance.session_id === 'string') {
        out.push(el('span', { class: 'mono', text: provenance.session_id }));
      }
      return out;
    }
    if (shape === 'SEND_RESOLUTION') {
      return [
        badge(`vers ${expertName(provenance.target_expert_slot_id, provenance.provider)}`),
        el('span', { class: 'mono', text: provenance.prompt_event_id }),
      ];
    }
    if (shape === 'HANDOFF_RESOLUTION') {
      return [
        badge(`vers ${expertName(provenance.target_expert_slot_id, provenance.provider)}`),
        el('span', { class: 'mono', text: provenance.started_event_id }),
      ];
    }
    if (shape === 'GENERATION_NEUTRAL') {
      // Aucun slot, aucun moteur, aucune session : l'événement n'en porte pas,
      // et l'écran n'en affiche donc aucun.
      return [];
    }

    // Les quatre formes bi-slot. Le sens de la passe se lit sur les rôles, et
    // jamais sur les moteurs — qui peuvent être identiques des deux côtés.
    const out = [
      badge(
        `${expertName(provenance.source_slot_id, provenance.source_provider)}` +
          ` → ${expertName(provenance.target_slot_id, provenance.target_provider)}`,
      ),
      el('span', { class: 'mono', text: provenance.source_event_id }),
    ];
    if (typeof provenance.response_event_id === 'string') {
      out.push(el('span', { class: 'mono', text: provenance.response_event_id }));
    }
    return out;
  }

  function nativeTimelineEntry(entry) {
    const head = el('div', { class: 'entry-head' }, [
      el('span', { class: 'mono', text: entry.event_id }),
      el('span', { text: formatInstant(entry.timestamp) }),
      el('span', { text: `round ${formatCount(entry.round)}` }),
      badge(label.actor(entry.actor)),
      badge(label.eventType(entry.type)),
    ]);
    for (const node of nativeProvenanceNodes(entry.provenance)) head.appendChild(node);
    if (typeof entry.reason === 'string') head.appendChild(badge(label.reason(entry.reason), 'attention'));

    const children = [head];
    if (typeof entry.content === 'string' && entry.content.length > 0) {
      // `textContent` : argumentation d'expert, message humain et note
      // d'acquittement sont des données. Intégrales, et jamais du balisage.
      //
      // Un contenu volumineux se replie plutôt que de saturer le journal. Il
      // n'est ni résumé, ni tronqué : le repli conserve la chaîne entière, et
      // un contenu court reste visible d'emblée.
      const body = el('pre', { class: 'entry-content', text: entry.content });
      if (entry.content.length > 400) {
        const details = el('details', { class: 'entry-payload' });
        details.appendChild(
          el('summary', { text: `Voir le contenu brut (${formatCount(entry.content.length)} caractères)` }),
        );
        details.appendChild(body);
        children.push(details);
      } else {
        children.push(body);
      }
    }
    if (Array.isArray(entry.based_on) && entry.based_on.length > 0) {
      children.push(el('p', { class: 'card-note mono', text: `d’après ${entry.based_on.join(', ')}` }));
    }
    return el('article', { class: 'entry' }, children);
  }

  /**
   * Une ligne d'historique — ce qui s'est passé, dit en français.
   *
   * La phrase vient d'une table FERMÉE indexée par `type`. L'attribution
   * humaine vient de `label.isHumanAct`, qui lit deux champs de l'événement et
   * n'en déduit aucun troisième. Ni `recorded_by`, ni fournisseur, ni voisin,
   * ni horodatage n'entrent ici.
   *
   * Le nom de l'expert, lorsqu'il existe, vient de la PROVENANCE — jamais de
   * `actor`, qui est une catégorie d'écriture et non une identité.
   */
  function historyEntry(entry) {
    const line = el('p', { class: 'history-line' });
    if (label.isHumanAct(entry)) {
      // Marque textuelle, jamais une seule couleur : l'écran doit rester vrai
      // pour qui ne distingue pas les teintes.
      line.appendChild(el('span', { class: 'entry-role is-human', text: 'Humain' }));
    }
    line.appendChild(el('span', { text: label.historyLine(entry.type) }));

    const who = historyActorName(entry.provenance);
    if (who !== null) line.appendChild(el('span', { class: 'history-who', text: who }));

    const body = el('div', {}, [line]);
    // V-17 · le tour reste lisible — il aide à situer. L'identifiant descend
    // sous la divulgation : il sert l'audit, pas la lecture.
    body.appendChild(el('p', { class: 'history-sub', text: `Tour ${formatCount(entry.round)}` }));

    const disclosure = el('details', { class: 'tech-details' });
    disclosure.appendChild(el('summary', { text: 'Détails techniques' }));
    const rows = [
      ['Événement', String(entry.event_id), { mono: true }],
      ['Type journalisé', label.eventType(entry.type)],
      ['Acteur enregistré', label.actor(entry.actor)],
      ['Horodatage', String(entry.timestamp), { mono: true }],
    ];
    const provenance = entry.provenance;
    if (provenance !== null && provenance !== undefined && typeof provenance === 'object') {
      rows.push(['Forme de provenance', String(provenance.shape), { mono: true }]);
      if (typeof provenance.session_id === 'string' && provenance.session_id.length > 0) {
        rows.push(['Session native', provenance.session_id, { mono: true }]);
      }
    }
    disclosure.appendChild(facts(rows));
    body.appendChild(disclosure);

    // La classe porte le verdict de la table FERMÉE de l'Historique, indexée par
    // TYPE canonique. Distincte de celle du fil : la technicité
    // conversationnelle n'est pas la visibilité par défaut d'un historique, et
    // « Run créé » relève du cycle de vie normal du run.
    const technical = label.isHistoryTechnical(entry.type);
    return el('li', {
      class: technical ? 'history-entry is-technical' : 'history-entry',
    }, [
      el('span', { class: 'history-time', text: formatInstant(entry.timestamp) }),
      body,
    ]);
  }

  /**
   * Qui, d'après la provenance seule.
   *
   * Rend `null` quand l'événement n'en porte aucune : l'absence est le fait
   * exact, et aucun nom n'est emprunté ailleurs pour la combler.
   */
  function historyActorName(provenance) {
    if (provenance === null || provenance === undefined || typeof provenance !== 'object') return null;
    const shape = provenance.shape;
    if (shape === 'EXPERT_SESSION') return expertName(provenance.expert_slot_id, provenance.provider);
    if (shape === 'EXPERT_TARGET' || shape === 'SEND_RESOLUTION' || shape === 'HANDOFF_RESOLUTION') {
      return `vers ${expertName(provenance.target_expert_slot_id, provenance.provider)}`;
    }
    if (shape === 'GENERATION_NEUTRAL') return null;
    if (typeof provenance.source_slot_id === 'string' && typeof provenance.target_slot_id === 'string') {
      return `${expertName(provenance.source_slot_id, provenance.source_provider)}`
        + ` → ${expertName(provenance.target_slot_id, provenance.target_provider)}`;
    }
    return null;
  }

  /**
   * Historique : la lecture humaine d'abord, le journal brut ensuite.
   *
   * Le journal n'est ni retiré ni résumé — il descend sous une divulgation, avec
   * la totalité de ses champs et sa pagination. Ce qui change est l'ordre de
   * lecture : ce qui s'est passé, puis comment c'est écrit sur le disque.
   */
  function nativeTimelineNodes(entries, page) {
    const nodesOut = [el('h3', { text: 'Historique' })];

    if (entries.length === 0) {
      nodesOut.push(el('p', { class: 'empty', text: 'Aucune entrée dans ce journal.' }));
      return nodesOut;
    }

    // V-12 — les événements techniques sont repliés par défaut, jamais retirés.
    //
    // **Toutes** les entrées sont rendues, dans l'ordre reçu. Le filtre agit sur
    // la VISIBILITÉ d'une classe CSS, pas sur la composition de la liste : les
    // révéler ne peut donc pas les réordonner ni les regrouper, puisqu'ils n'ont
    // jamais quitté leur place. `filtered ≠ reordered`, garanti par construction.
    //
    // La visibilité vient d'une table fermée indexée par TYPE — jamais du
    // contenu, du fournisseur, de l'acteur enregistré, de l'heure ni du voisin.
    const history = el('ol', { class: 'history' });
    let technicalCount = 0;
    for (const entry of entries) {
      if (label.isHistoryTechnical(entry.type)) technicalCount += 1;
      history.appendChild(historyEntry(entry));
    }
    if (historyShowTechnical !== true) history.setAttribute('data-hide-technical', '');

    if (technicalCount > 0) {
      const toggleId = 'history-show-technical';
      const toggle = el('input', {
        class: 'event-filter',
        attrs: { type: 'checkbox', id: toggleId },
      });
      toggle.checked = historyShowTechnical === true;
      toggle.addEventListener('change', () => {
        historyShowTechnical = toggle.checked === true;
        // Le même nœud, la même liste, le même ordre : seul un attribut change.
        if (historyShowTechnical) history.removeAttribute('data-hide-technical');
        else history.setAttribute('data-hide-technical', '');
        updateCounter();
      });
      const suffix = technicalCount > 1 ? 's' : '';
      nodesOut.push(el('div', { class: 'event-filter-row' }, [
        toggle,
        el('label', { class: 'event-filter-label', attrs: { for: toggleId } }, [
          el('strong', {
            text: `Afficher les événements techniques (${formatCount(technicalCount)})`,
          }),
          el('span', {
            class: 'muted',
            text: `${formatCount(technicalCount)} événement${suffix} de session, de transport `
              + 'ou de tour — repliés, jamais retirés, et à leur place chronologique.',
          }),
        ]),
      ]));
    }

    nodesOut.push(history);

    // VIS-02 — le compteur dit ce qui est RÉELLEMENT visible.
    //
    // Il annonçait `entries.length` sur `page.total`, soit « 11 sur 11 » alors
    // que trois entrées étaient repliées juste au-dessus. Le nombre affiché est
    // désormais celui des entrées effectivement rendues à l'écran, et le repli
    // est dit à côté plutôt que passé sous silence.
    //
    // `page.total` reste le total du run : une page n'est pas un run, et
    // masquer trois lignes n'en retire aucune du journal.
    const counter = el('p', { class: 'card-note', attrs: { id: 'history-count' } });
    const updateCounter = () => {
      const visibles = historyShowTechnical === true ? entries.length : entries.length - technicalCount;
      const masques = historyShowTechnical === true ? 0 : technicalCount;
      // `pluralize` porte DÉJÀ le nombre : le préfixer à nouveau écrivait
      // « 8 8 entrées affichées ».
      const base = `${pluralize(visibles, 'entrée affichée', 'entrées affichées')}`
        + ` sur ${formatCount(page.total)}`;
      counter.textContent = masques === 0
        ? `${base}.`
        : `${base} · ${pluralize(masques, 'événement technique masqué', 'événements techniques masqués')}.`;
    };
    updateCounter();
    nodesOut.push(counter);

    const raw = el('details', { class: 'tech-details' });
    raw.appendChild(el('summary', { text: 'Journal des événements — champs bruts' }));
    raw.appendChild(facts([
      ['Génération', label.generation(page.generation)],
      ['Entrées affichées', String(entries.length)],
      ['Total de la vue', formatCount(page.total)],
      ['Révision', shortRevision(page.revision), { mono: true, title: page.revision }],
    ]));
    for (const entry of entries) raw.appendChild(nativeTimelineEntry(entry));
    nodesOut.push(raw);

    if (typeof page.cursor_next === 'string' && page.cursor_next.length > 0) {
      const more = el('button', { attrs: { type: 'button', id: 'timeline-more' }, text: 'Charger la suite' });
      more.addEventListener('click', () => {
        if (typeof handlers.onLoadMore === 'function') handlers.onLoadMore();
      });
      nodesOut.push(more);
    }
    return nodesOut;
  }

  function recoveryNodes(recovery) {
    const blocks = [
      el('h3', { text: 'Vivacité' }),
      facts([
        ['Situation', label.liveness(recovery.liveness.liveness)],
        ['Fondement', label.livenessBasis(recovery.liveness.basis)],
        ['Attention humaine', recovery.liveness.needs_human_attention === true ? 'oui' : 'non'],
      ]),
      el('h3', { text: 'Faits connus' }),
      facts([
        ['État', label.state(recovery.known_facts.state)],
        ['Contrôle', label.control(recovery.known_facts.control)],
        ['Runtime pinné', recovery.known_facts.runtime_pinned === true ? 'oui' : 'non'],
        ['Réponse déjà journalisée', recovery.known_facts.pending_response_journaled === true ? 'oui' : 'non'],
        ['Verrou observé', label.lockObservation(recovery.known_facts.lock_observation)],
        ['Référence de verrou', recovery.known_facts.lock_reference ?? '—', { mono: true }],
        ['Session Claude', recovery.sessions.claude],
        ['Session Codex', recovery.sessions.codex],
      ]),
      el('h3', { text: 'Ambiguïté' }),
    ];

    blocks.push(
      recovery.ambiguity === null
        ? el('p', { class: 'empty', text: 'Aucune ambiguïté matérialisée.' })
        : facts([
            ['Motif', recovery.ambiguity.reason],
            ['Depuis', formatInstant(recovery.ambiguity.since)],
          ]),
    );

    blocks.push(el('h3', { text: 'Capacités de reprise' }));
    if (recovery.capabilities.length === 0) {
      blocks.push(el('p', { class: 'empty', text: 'Aucune capacité de reprise proposée.' }));
    } else {
      const cards = el('div', { class: 'cards' });
      for (const capability of recovery.capabilities) {
        cards.appendChild(recoveryCard(recovery, capability));
      }
      blocks.push(cards);
    }

    blocks.push(el('h3', { text: 'Primitives manquantes' }));
    if (recovery.missing_primitives.length === 0) {
      blocks.push(el('p', { class: 'empty', text: 'Aucune primitive manquante signalée.' }));
    } else {
      const cards = el('div', { class: 'cards' });
      for (const missing of recovery.missing_primitives) {
        cards.appendChild(
          el('div', { class: 'card' }, [
            el('div', { class: 'card-head' }, [
              el('strong', { text: label.recoveryCapability(missing.id) }),
              badge('non disponible dans le cockpit', 'attention'),
            ]),
            el('p', { class: 'card-note', text: `Raison : ${label.missingPrimitiveReason(missing.reason)}.` }),
            el('p', { class: 'card-note', text: missing.note }),
            el('p', { class: 'card-note', text: 'Différée à un slice ultérieur ; aucune action n’est proposée ici.' }),
          ]),
        );
      }
      blocks.push(cards);
    }
    return blocks;
  }

  // ------------------------------------------------------------------------
  // Runtime, doctor, configuration
  // ------------------------------------------------------------------------

  function runtimeNodes(runView) {
    const runtime = runView.runtime;
    const blocks = [
      el('h3', { text: 'Snapshot runtime du run' }),
      facts([['Runtime pinné', runView.runtime_pinned === true ? 'oui' : 'non (run legacy)']]),
    ];
    if (runtime === null) {
      blocks.push(el('p', { class: 'empty', text: 'Ce run ne porte aucun snapshot runtime.' }));
      return blocks;
    }
    blocks.push(
      facts([
        ['Capturé le', formatInstant(runtime.captured_at)],
        ['Claude — version', runtime.claude.cli_version ?? '—'],
        ['Claude — auth au démarrage', runtime.claude.auth_preflight],
        ['Codex — version', runtime.codex.cli_version ?? '—'],
        ['Codex — auth au démarrage', runtime.codex.auth_preflight],
        ['Codex — skip_git_repo_check', runtime.codex.skip_git_repo_check === true ? 'oui' : 'non'],
        ['Codex — origine', runtime.codex.source_at_capture],
      ]),
    );
    return blocks;
  }

  function doctorNodes(report) {
    const blocks = [
      el('div', { class: 'card-head' }, [
        el('strong', { text: `Statut : ${label.doctorStatus(report.status)}` }),
        badge(`Node ${report.runtime.node}`),
      ]),
      el('p', {
        class: 'card-note',
        text: 'Le cockpit affiche les constats du doctor sans les recalculer. Une actualisation peut exécuter les probes CLI existantes.',
      }),
      el('h3', { text: 'Agents' }),
      facts([
        ['Claude — installé', report.agents.claude.installed === true ? 'oui' : 'non'],
        ['Claude — version', report.agents.claude.version ?? '—'],
        ['Claude — authentification', report.agents.claude.authStatus],
        ['Codex — installé', report.agents.codex.installed === true ? 'oui' : 'non'],
        ['Codex — version', report.agents.codex.version ?? '—'],
        ['Codex — authentification', report.agents.codex.authStatus],
      ]),
      el('h3', { text: 'Configuration' }),
      facts([
        ['Fichier', report.config.path, { mono: true }],
        ['Origine', report.config.origin],
        ['Verrou de configuration', report.configLock.presence],
      ]),
      el('h3', { text: 'Constats' }),
    ];

    if (report.findings.length === 0) {
      blocks.push(el('p', { class: 'empty', text: 'Aucun constat.' }));
      return blocks;
    }
    const cards = el('div', { class: 'cards' });
    for (const finding of report.findings) {
      cards.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('strong', { text: finding.code }),
            badge(label.doctorSeverity(finding.severity), finding.severity === 'BLOCKER' ? 'error' : 'attention'),
          ]),
          el('p', { class: 'card-note', text: label.doctorFinding(finding.code) }),
        ]),
      );
    }
    blocks.push(cards);
    return blocks;
  }

  function configNodes(config) {
    return [
      el('p', { class: 'card-note', text: 'Lecture seule. La configuration se modifie avec `ccr setup`.' }),
      facts([
        ['Node', config.node_version],
        ['Fichier de configuration', config.config_path, { mono: true }],
        ['Origine', config.config_origin],
        ['Connexion interactive proposée', config.preflight.offer_interactive_login === true ? 'oui' : 'non'],
        ['— source', label.configSource(config.preflight.source)],
        ['Codex — skip_git_repo_check', config.codex.skip_git_repo_check === true ? 'oui' : 'non'],
        ['— source', label.configSource(config.codex.source)],
        ['Variable héritée', config.legacy_env.variable, { mono: true }],
        ['— présente', config.legacy_env.present === true ? 'oui' : 'non'],
        ['— canonique', config.legacy_env.canonical === true ? 'oui' : 'non'],
      ]),
    ];
  }

  // ------------------------------------------------------------------------
  // Interface consommée par l'orchestration
  // ------------------------------------------------------------------------

  const viewApi = {
    showBanner(message) {
      if (nodes.banner === null) return;
      nodes.banner.textContent = message;
      nodes.banner.removeAttribute('hidden');
    },
    /**
     * Session expirée — dite là où le geste a eu lieu.
     *
     * La bannière et la liste ne suffisaient pas : un humain qui vient de
     * cliquer dans un run regarde la ligne de statut du run. Le message y est
     * donc écrit aussi, et la tentative en cours est oubliée — il n'y a rien à
     * consulter, et surtout rien à rejouer.
     */
    showSessionExpired(message) {
      this.showBanner(message);
      setStatus(nodes.runsStatus, message, 'error');
      setStatus(nodes.runStatus, message, 'error');
      progressTargets.attempt = null;
    },
    showRunsLoading() {
      setStatus(nodes.runsStatus, 'Chargement de la liste…');
    },
    /**
     * Effet de START reçu du serveur (`V2.3-S4`).
     *
     * Conservé tel quel, et rendu dans le résumé de création. Sans lui, le
     * résumé le dit — il n'affiche aucun compte.
     */
    showStartEffect(effect) {
      startEffect = effect ?? null;
      refreshStartSummary();
    },
    showRuns(runs, selectedId) {
      lastRuns = runs;
      lastSelectedId = selectedId;
      if (nodes.runsList === null) return;
      clear(nodes.runsList);
      if (runs === null) return;
      if (runs.length === 0) {
        setStatus(nodes.runsStatus, 'Aucune contre-expertise enregistrée pour l’instant.');
        return;
      }
      // Filtrage, jamais tri : `filter` conserve l'ordre reçu du serveur.
      const needle = runFilter.trim().toLowerCase();
      const visible =
        needle.length === 0
          ? runs
          : runs.filter((summary) => {
              const title = typeof summary.title === 'string' ? summary.title.toLowerCase() : '';
              return title.includes(needle) || summary.run_id.toLowerCase().includes(needle);
            });
      if (visible.length === 0) {
        setStatus(nodes.runsStatus, `Aucun run ne correspond à « ${runFilter.trim()} ».`);
        return;
      }
      setStatus(
        nodes.runsStatus,
        needle.length === 0
          ? `${pluralize(runs.length, 'run', 'runs')}.`
          : `${String(visible.length)} sur ${pluralize(runs.length, 'run', 'runs')}.`,
      );
      for (const summary of visible) nodes.runsList.appendChild(runItem(summary, selectedId));
    },
    showRunsError(described) {
      setStatus(nodes.runsStatus, described.message, 'error');
    },
    showRunLoading(runId) {
      if (nodes.emptyDetail !== null) nodes.emptyDetail.setAttribute('hidden', '');
      if (nodes.runPanel !== null) nodes.runPanel.removeAttribute('hidden');
      if (nodes.runTitle !== null) nodes.runTitle.textContent = runId;
      setStatus(nodes.runStatus, 'Chargement du run…');
      loadingStatusShown = true;
      // Le fil du run précédent ne survit pas à la sélection d'un autre.
      threadNode = null;
      initialContextShown = false;
      replace(nodes.overview, []);
      replace(nodes.timeline, []);
      replace(nodes.recovery, []);
      replace(nodes.runtime, []);
      replace(nodes.runFacts, []);
    },
    /**
     * Affiche le run.
     *
     * `silent` marque un rafraîchissement **provoqué** par une écriture
     * extérieure : le contenu se met à jour, mais la ligne de statut n'est pas
     * effacée. Sans cela, une invalidation arrivant juste après une mutation
     * humaine emporterait le message qui lui répond.
     */
    showRunView(runView, options = {}) {
      clearLoadingStatus(options.silent);
      // Mémorisée AVANT le rendu : la présentation V4 lit la projection V3 de
      // la même vue, donc du même instantané serveur.
      lastRunView = runView;
      const identity = isNative(runView) ? runView.run.identity : runView.identity;
      // Le sujet d'abord, l'identifiant ensuite — même ordre que dans la liste.
      // L'en-tête n'affichait que `run_id` : le travail se faisait alors sous un
      // titre qui ne rappelait plus de quoi il s'agissait, alors que le run
      // porte son sujet depuis sa création.
      if (nodes.runTitle !== null) {
        const subject = typeof identity.title === 'string' && identity.title.length > 0
          ? identity.title
          : null;
        clear(nodes.runTitle);
        if (subject === null) {
          // Aucun sujet enregistré : l'identifiant reste le seul nom honnête.
          nodes.runTitle.appendChild(el('span', { class: 'run-heading-id mono', text: identity.run_id }));
        } else {
          nodes.runTitle.appendChild(el('span', { class: 'run-heading-name', text: subject }));
          nodes.runTitle.appendChild(el('span', { class: 'run-heading-id mono', text: identity.run_id }));
        }
      }
      // Ce que l'humain est en train d'écrire lui appartient. Un
      // rafraîchissement provoqué par une écriture extérieure remplace les
      // nœuds ; sans ceci, il emporterait une décision à moitié tapée.
      const typed = options.silent === true ? captureTyped() : null;
      // Le bandeau d'attente précédent disparaît avec les nœuds qui le
      // portaient : le garder ferait vieillir une durée qui n'est plus à
      // l'écran, et qui décrit peut-être une opération déjà terminée.
      progressTargets.run = null;
      // La generation decide du rendu, et elle vient du serveur.
      replace(nodes.overview, isNative(runView) ? nativeOverviewNodes(runView) : overviewNodes(runView));
      if (typed !== null) restoreTyped(typed);
      if (!isNative(runView)) {
        replace(nodes.runtime, runtimeNodes(runView));
        // Un run historique n'a ni Dossier ni faits natifs : la zone reste vide
        // plutôt que d'accueillir une projection qui n'existe pas pour lui.
        replace(nodes.runFacts, []);
      } else {
        replace(nodes.runtime, nativeDossierNodes(runView));
        replace(nodes.runFacts, nativeRunFactNodes(runView));
      }
    },
    showMutationPending(action) {
      progressTargets.attempt = null;
      setStatus(nodes.runStatus, label.capability(action) + ' — opération en cours…');
    },
    /**
     * Opération terminée — et **ce qu'elle a répondu**.
     *
     * « Effectuée » ne subsiste que pour les opérations dont le domaine ne rend
     * pas d'issue nommée. Dès qu'une issue existe, c'est elle qui est dite : le
     * run réel a montré qu'annoncer un succès générique après un refus est un
     * mensonge que rien à l'écran ne rattrape.
     */
    showMutationSucceeded(action, receipt) {
      progressTargets.attempt = null;
      const outcome = outcomeNodes(receipt);
      if (outcome.length === 0) {
        setStatus(nodes.runStatus, label.capability(action) + ' — effectuée. La vue a été relue depuis les journaux CCR.');
        return;
      }
      if (nodes.runStatus === null) return;
      clear(nodes.runStatus);
      // Une issue sans enregistrement n'est pas une erreur de transport : elle
      // est signalée comme un résultat qui demande lecture, pas comme une panne.
      const recorded = receipt.domain_outcome.outcome === 'RECORDED';
      nodes.runStatus.setAttribute('class', recorded ? 'status' : 'status is-attention');
      nodes.runStatus.appendChild(el('span', { text: label.capability(action) + ' — ' }));
      for (const node of outcome) nodes.runStatus.appendChild(node);
    },
    /**
     * Résultat indéterminé — `RUNNING` ou `UNKNOWN`.
     *
     * Aucune conclusion n'est prise à la place du serveur. Le bouton demeure —
     * un humain doit pouvoir demander — mais il n'est plus le **seul** moyen
     * d'apprendre la fin : le suivi automatique s'en charge, et ce bandeau dit
     * désormais qui travaille et depuis quand.
     */
    showMutationUndetermined(action, receipt, context) {
      if (nodes.runStatus === null) return;
      progressTargets.attempt = null;
      clear(nodes.runStatus);
      const unknown = receipt.status === 'UNKNOWN';
      nodes.runStatus.setAttribute('class', unknown ? 'status is-error' : 'status');
      if (unknown) {
        nodes.runStatus.appendChild(el('span', {
          text: label.capability(action)
            + ' — résultat inconnu : le cockpit ne peut pas dire si l’action a eu lieu.',
        }));
      } else {
        // Qui travaille, et depuis quand. Le slot vient de la demande que
        // l'humain vient de faire ; le moteur, du manifeste ; l'instant de
        // départ, du reçu durable — aucun des trois n'est supposé.
        const who = context === undefined || context === null || context.expertSlot === undefined
          ? ''
          : ` — ${label.expertSlot(context.expertSlot)}`
            + (context.provider === undefined ? '' : ` · ${label.actor(context.provider)}`);
        // « en cours » reste dit : une durée qui avance ne suffit pas à
        // affirmer que l'opération n'est pas terminée.
        nodes.runStatus.appendChild(el('span', { text: `${label.capability(action)}${who} · en cours ` }));
        nodes.runStatus.appendChild(elapsedNode(receipt.created_at, 'attempt'));
      }
      const check = el('button', { attrs: { type: 'button', id: 'operation-check' }, text: 'Vérifier le résultat' });
      check.addEventListener('click', () => {
        if (typeof handlers.onCheckOperation === 'function') handlers.onCheckOperation();
      });
      nodes.runStatus.appendChild(check);
    },
    /**
     * Repeint les durées affichées, sans reconstruire l'écran.
     *
     * N'émet aucune requête et ne conclut rien : une durée qui avance n'est pas
     * une progression, c'est une attente qui dure.
     */
    tickElapsed() {
      const at = clock();
      for (const target of Object.values(progressTargets)) {
        if (target !== null) paintElapsed(target, at);
      }
    },
    /** `202` reçu : le run existe déjà, son initialisation se poursuit. */
    showStartPending(receipt) {
      if (nodes.startStatus === null) return;
      clear(nodes.startStatus);
      nodes.startStatus.setAttribute('class', 'status');
      progressTargets.start = null;
      const created = typeof receipt.created_run_id === 'string' ? receipt.created_run_id : null;
      nodes.startStatus.appendChild(
        el('span', {
          text: created === null
            ? 'Création du run en cours… '
            : 'Création du run ' + created + ' en cours… ',
        }),
      );
      // La durée avant l'identifiant : c'est elle qu'on regarde pendant onze
      // minutes, pas `op_c8a7de…`.
      nodes.startStatus.appendChild(elapsedNode(receipt.created_at, 'start'));
      nodes.startStatus.appendChild(el('span', { class: 'muted', text: ' · opération ' + String(receipt.operation_id) }));
      startCheck();
    },
    showStartSucceeded(runId) {
      // La création est terminée : le formulaire redevient utilisable.
      freezeStartForm(false);
      setStatus(nodes.startStatus, 'Run ' + runId + ' créé. La vue a été relue depuis les journaux CCR.');
    },
    /**
     * Résultat indéterminé — `RUNNING` ou `UNKNOWN`.
     *
     * Aucun rejeu n'est proposé : recréer un run dont on ignore s'il existe
     * serait exactement la faute que l'idempotence durable empêche.
     */
    showStartUndetermined(receipt) {
      // Le formulaire RESTE gelé : une issue inconnue n'est pas un échec, et la
      // création a pu aboutir sans que le client en obtienne la confirmation.
      // « Vérifier le résultat » porte sur CETTE tentative ; composer une
      // nouvelle intention ici produirait un second run.
      if (nodes.startStatus === null) return;
      clear(nodes.startStatus);
      nodes.startStatus.setAttribute('class', 'status is-error');
      progressTargets.start = null;
      const unknown = receipt.status === 'UNKNOWN';
      nodes.startStatus.setAttribute('class', unknown ? 'status is-error' : 'status');
      nodes.startStatus.appendChild(
        el('span', {
          text: unknown
            ? 'Résultat de la création inconnu : CCR ne la rejouera pas automatiquement.'
            : 'Création toujours en cours · ',
        }),
      );
      // Une attente qui dure doit se voir durer. `UNKNOWN` n'en reçoit pas :
      // sa durée ne mesurerait plus rien qui avance.
      if (!unknown) nodes.startStatus.appendChild(elapsedNode(receipt.created_at, 'start'));
      startCheck();
      startOpen(receipt.created_run_id);
    },
    /** Échec : le run peut exister malgré tout, et doit rester inspectable. */
    showStartFailed(described, createdRunId) {
      // Le formulaire ne se réarme que sur une tentative RÉSOLUE : verdict du
      // serveur, ou run déjà alloué. Une panne sans réponse laisse l'issue
      // inconnue, et rendre la main y autoriserait un second run.
      //
      // L'absence du marqueur vaut résolution : les appelants qui n'ont rien à
      // dire décrivent un refus certain.
      if (described.attempt_resolved !== false) freezeStartForm(false);
      if (nodes.startStatus === null) return;
      clear(nodes.startStatus);
      nodes.startStatus.setAttribute('class', 'status is-error');
      const text = typeof createdRunId === 'string'
        ? 'Le run a été créé mais son initialisation a échoué. ' + described.message
        : described.message;
      nodes.startStatus.appendChild(el('span', { text }));
      startOpen(createdRunId);
    },
    showMutationError(action, described) {
      if (nodes.runStatus === null) return;
      clear(nodes.runStatus);
      nodes.runStatus.setAttribute('class', 'status is-error');
      nodes.runStatus.appendChild(el('span', { text: label.capability(action) + ' — ' + described.message }));

      if (described.code === 'STALE_REVISION') {
        // Aucun réessai automatique sur la nouvelle révision : l'action avait été
        // décidée sur une vue qui n'existe plus. L'humain reconsidère.
        nodes.runStatus.appendChild(
          el('span', { text: ' Le run a changé depuis votre dernière lecture — rechargez, puis reconsidérez l’action.' }),
        );
        const reload = el('button', { attrs: { type: 'button', id: 'mutation-reload' }, text: 'Recharger le run' });
        reload.addEventListener('click', () => {
          if (typeof handlers.onRefreshRun === 'function') handlers.onRefreshRun();
        });
        nodes.runStatus.appendChild(reload);
        return;
      }
      if (described.retryable === true) {
        // Le même essai, avec la même clé : jamais une nouvelle intention.
        const retry = el('button', { attrs: { type: 'button', id: 'mutation-retry' }, text: 'Réessayer' });
        retry.addEventListener('click', () => {
          if (typeof handlers.onRetryMutation === 'function') handlers.onRetryMutation();
        });
        nodes.runStatus.appendChild(retry);
      }
    },
    showRunError(described) {
      setStatus(nodes.runStatus, described.message, 'error');
      replace(nodes.overview, described.retryable === true
        ? [el('p', { class: 'empty', text: 'Vue temporairement indisponible.' })]
        : []);
    },
    showTimelineLoading() {
      setStatus(nodes.runStatus, 'Chargement de la chronologie…');
    },
    /**
     * Affiche la chronologie.
     *
     * Même règle que pour la vue d'ensemble : un rafraîchissement **provoqué**
     * met à jour le contenu sans effacer la ligne de statut. Elle répond au
     * dernier geste de l'humain, pas à ce qu'un autre processus vient d'écrire.
     */
    showTimeline(entries, page, options = {}) {
      clearLoadingStatus(options.silent);
      // La même page alimente le sélecteur de provenance V3. Seul son contenu
      // est remplacé : la section Inspect n'est pas reconstruite, et le motif
      // en cours de rédaction survit.
      timelineEntries = Array.isArray(entries) ? entries : [];
      fillProvenancePicker();
      // La generation est portee par la page elle-meme : le rendu suit le DTO
      // recu, jamais un etat memorise ailleurs.
      replace(nodes.timeline, isNative(page) ? nativeTimelineNodes(entries, page) : timelineNodes(entries, page));
      // Le fil consomme la MÊME page, dans le MÊME ordre. Aucune seconde
      // lecture, aucun second transport, aucune chronologie parallèle.
      if (isNative(page) && threadNode !== null) {
        const rendered = [conversationThread(entries, { initialContextShown })];
        // Le fil doit dire qu'il est incomplet. Sans cela, cent entrées sur mille
        // se lisent comme la conversation entière — et le seul contrôle vivrait
        // dans un autre onglet. Même curseur, même transport, même ordre : c'est
        // le geste existant, exposé là où le fil se lit.
        if (typeof page.cursor_next === 'string' && page.cursor_next.length > 0) {
          rendered.push(el('p', {
            class: 'thread-technical',
            text:
              `${formatCount(entries.length)} entrée(s) affichée(s) sur ${formatCount(page.total)} — ` +
              'le fil n’est pas complet.',
          }));
          const more = el('button', {
            attrs: { type: 'button', id: 'conversation-more' },
            text: 'Charger la suite du fil',
          });
          more.addEventListener('click', () => {
            if (typeof handlers.onLoadMore === 'function') handlers.onLoadMore();
          });
          rendered.push(more);
        }
        replace(threadNode, rendered);
      }
    },
    showTimelineStale(message) {
      if (nodes.timeline === null) return;
      const reload = el('button', { attrs: { type: 'button', id: 'timeline-reload' }, text: 'Recharger depuis le début' });
      reload.addEventListener('click', () => {
        if (typeof handlers.onReloadTimeline === 'function') handlers.onReloadTimeline();
      });
      const notice = el('div', { class: 'stale', attrs: { id: 'timeline-stale' } }, [
        el('p', { text: `${message} La chronologie a changé — les entrées ci-dessous appartiennent à l’ancienne vue.` }),
        reload,
      ]);
      // Aucune entrée n'est ajoutée : la page refusée n'est pas fusionnée.
      nodes.timeline.insertBefore(notice, nodes.timeline.firstChild);
      const more = doc.getElementById('timeline-more');
      if (more !== null && more.parentNode !== null) more.parentNode.removeChild(more);
      setStatus(nodes.runStatus, '');
    },
    showTimelineError(described) {
      setStatus(nodes.runStatus, described.message, 'error');
    },
    showRecovery(recovery) {
      replace(nodes.recovery, isNative(recovery) ? nativeRecoveryNodes(recovery) : recoveryNodes(recovery));
    },
    showRecoveryError(described) {
      replace(nodes.recovery, [el('p', { class: 'status is-error', text: described.message })]);
    },
    showRecoveryPending(capabilityId) {
      setStatus(nodes.recoveryStatus, label.recoveryCapability(capabilityId) + ' — opération en cours…');
    },
    showRecoverySucceeded(capabilityId) {
      setStatus(nodes.recoveryStatus, label.recoveryCapability(capabilityId) + ' — effectuée. La vue a été relue depuis les journaux CCR.');
    },
    showRecoveryActionError(capabilityId, described) {
      setStatus(nodes.recoveryStatus, label.recoveryCapability(capabilityId) + ' — ' + described.message, 'error');
    },
    /**
     * Résultat indéterminé d'une reprise — `RUNNING` ou `UNKNOWN`.
     *
     * `UNKNOWN` est dit explicitement, et rien ne se déclenche seul : ni
     * réessai, ni nouvelle clé, ni nouvelle levée. Un unique bouton propose de
     * **consulter** le reçu — un geste humain, borné, sans effet.
     */
    showRecoveryUndetermined(capabilityId, receipt) {
      if (nodes.recoveryStatus === null) return;
      clear(nodes.recoveryStatus);
      nodes.recoveryStatus.setAttribute('class', 'status is-error');
      nodes.recoveryStatus.appendChild(
        el('span', {
          attrs: { 'data-recovery-outcome': receipt.status },
          text: receipt.status === 'UNKNOWN'
            ? label.recoveryCapability(capabilityId) +
              ' — résultat inconnu : le cockpit ne peut pas dire si l’action a eu lieu. Aucun rejeu n’est tenté ; à vous de décider de la suite.'
            : label.recoveryCapability(capabilityId) + ' — opération toujours en cours.',
        }),
      );
      nodes.recoveryStatus.appendChild(el('span', { class: 'muted', text: ' Opération ' + String(receipt.operation_id) }));
      const check = el('button', { attrs: { type: 'button', id: 'recovery-check' }, text: 'Vérifier le résultat' });
      check.addEventListener('click', () => {
        if (typeof handlers.onCheckRecovery === 'function') handlers.onCheckRecovery();
      });
      nodes.recoveryStatus.appendChild(check);
    },
    showDoctorLoading() {
      setStatus(nodes.doctorStatus, 'Diagnostic en cours…');
    },
    showDoctor(report) {
      setStatus(nodes.doctorStatus, '');
      replace(nodes.doctorBody, doctorNodes(report));
    },
    showDoctorError(described) {
      setStatus(nodes.doctorStatus, described.message, 'error');
    },
    showConfigLoading() {
      setStatus(nodes.configStatus, 'Chargement de la configuration…');
    },
    showConfig(config) {
      setStatus(nodes.configStatus, '');
      replace(nodes.configBody, configNodes(config));
    },
    showConfigError(described) {
      setStatus(nodes.configStatus, described.message, 'error');
    },
  };

  return viewApi;
}
