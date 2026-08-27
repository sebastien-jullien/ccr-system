/**
 * `ConversationThread` — le fil de la contre-expertise (`V2.3-S3`).
 *
 * ## Une lecture, pas une seconde chronologie
 *
 * Le fil consomme les entrées de la chronologie native **dans l'ordre exact où
 * le serveur les rend**. Il n'ordonne rien, ne fusionne rien, n'écarte aucune
 * entrée du journal : il choisit seulement ce qu'il *rend*, et comment.
 *
 * ```text
 * pour chaque entrée, dans l'ordre reçu
 *   si le round change      → marqueur de round
 *   classer par TYPE        → rendre selon la classe
 * ```
 *
 * Aucun tri, aucune comparaison d'horodatage, aucune déduplication, aucun round
 * calculé. Le journal détient la chronologie ; la relire autrement serait
 * affirmer une seconde vérité.
 *
 * ## Classification fermée
 *
 * Par **type d'événement**, et par lui seul. Aucune analyse du contenu, aucune
 * expression régulière, aucune détection d'accord ou de désaccord — la
 * controverse comme objet appartient à une version que le moteur ne porte pas.
 *
 * ## Ce que « technique » veut dire ici
 *
 * Un événement technique n'est pas caché : il reste intégralement dans la
 * chronologie, et le fil annonce combien il en a laissés de côté. Il n'est
 * simplement pas une contribution, et le présenter comme telle inventerait une
 * conversation qui n'a pas eu lieu.
 */

/** Classes de rendu. Fermées. */
export const ENTRY_CLASSES = Object.freeze({
  CONTRIBUTION: 'VISIBLE_CONTRIBUTION',
  HUMAN: 'HUMAN_CONTRIBUTION',
  INITIAL_CONTEXT: 'INITIAL_CONTEXT',
  TRANSFER: 'VISIBLE_TRANSFER_MARKER',
  TECHNICAL: 'TECHNICAL_ONLY',
});

/**
 * Classe d'une entrée — depuis son `type`, et son `actor` pour un seul cas.
 *
 * `prompt_sent` est le seul type ambigu, et il se lève sans heuristique :
 * l'initialisation l'écrit avec `actor: 'human'` et le contenu de l'humain ;
 * un transfert l'écrit avec `actor: 'system'` et une enveloppe. Le fait est
 * porté par l'événement, il n'est pas deviné.
 */
export function classifyEntry(entry) {
  switch (entry.type) {
    case 'assistant_response':
      return ENTRY_CLASSES.CONTRIBUTION;
    case 'human_message':
      return ENTRY_CLASSES.HUMAN;
    case 'prompt_sent':
      return entry.actor === 'human' ? ENTRY_CLASSES.INITIAL_CONTEXT : ENTRY_CLASSES.TECHNICAL;
    case 'round_completed':
      return ENTRY_CLASSES.TRANSFER;
    case 'human_handoff_started':
    case 'human_handoff_finished':
      return ENTRY_CLASSES.HUMAN;
    default:
      return ENTRY_CLASSES.TECHNICAL;
  }
}

/**
 * Fabrique un rendu de fil.
 *
 * `markdownContent` rend le contenu éditorial ; `expertName`, `expertRole`,
 * `actorLabel`, `eventLabel` et `formatInstant` viennent des libellés existants.
 * Aucun d'eux n'est décidé ici.
 *
 * Les trois derniers sont facultatifs : sans eux, le fil rend la valeur brute
 * plutôt que de se rompre. Un identifiant affiché tel quel reste vrai ; une
 * exception effacerait le fil entier.
 */
export function createConversationThread({
  document: doc,
  markdownContent,
  expertName,
  eventLabel,
  expertRole,
  actorLabel,
  formatInstant,
}) {
  const roleOf = typeof expertRole === 'function' ? expertRole : (slot) => String(slot);
  const actorOf = typeof actorLabel === 'function' ? actorLabel : (code) => String(code);
  const instantOf = typeof formatInstant === 'function' ? formatInstant : (value) => String(value);

  function el(tag, options = {}, children = []) {
    const node = doc.createElement(tag);
    if (typeof options.class === 'string') node.setAttribute('class', options.class);
    if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
    if (options.attrs !== undefined) {
      for (const [name, value] of Object.entries(options.attrs)) node.setAttribute(name, String(value));
    }
    for (const child of children) node.appendChild(child);
    return node;
  }

  /** Slot et fournisseur d'une entrée — depuis la provenance, jamais l'acteur. */
  function slotOf(entry) {
    const provenance = entry.provenance;
    if (provenance === null || typeof provenance !== 'object') return null;
    if (provenance.shape === 'EXPERT_SESSION') {
      return { slot: provenance.expert_slot_id, provider: provenance.provider };
    }
    if (provenance.shape === 'EXPERT_TARGET') {
      return { slot: provenance.target_expert_slot_id, provider: provenance.provider };
    }
    return null;
  }

  /**
   * Rang 1 — **le rôle**, et lui seul.
   *
   * Le moteur, le tour, l'heure et l'identifiant descendent d'un rang : ils
   * qualifient une contribution qu'il faut d'abord pouvoir lire. L'ordre
   * d'apparition à l'écran devient rôle → contenu → provenance → technique.
   */
  function head(title, role) {
    const node = el('header', { class: 'thread-head' });
    node.appendChild(el('span', { class: `thread-role entry-role is-${role} role-${role}`, text: title }));
    return node;
  }

  function body(entry) {
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (content.length === 0) return el('p', { class: 'thread-empty', text: 'Aucun contenu journalisé.' });
    const holder = el('div', { class: 'md-body' });
    holder.appendChild(markdownContent(content));
    return holder;
  }

  /** Rang 3 — moteur, tour, heure. Attaché au message, jamais dans une autre vue. */
  function lead(entry, identity) {
    const engine = identity === null ? '' : `${actorOf(identity.provider)} · `;
    return el('p', {
      class: 'entry-lead',
      text: `${engine}round ${String(entry.round)} · ${instantOf(entry.timestamp)}`,
    });
  }

  /**
   * Rang 4 — les faits techniques, repliés sous le message qu'ils qualifient.
   *
   * Chaque ligne n'est écrite que si le fait existe **canoniquement** sur
   * l'entrée. Aucune ligne nulle « pour uniformiser » : une session absente et
   * une session vide ne sont pas la même chose, et le journal ne porte que la
   * première. La provenance reste ici, avec son message : la retrouver dans une
   * autre vue serait la détacher de ce qu'elle qualifie.
   */
  function technical(entry) {
    const list = el('dl', { class: 'facts' });
    const row = (term, value, mono) => {
      list.appendChild(el('dt', { text: term }));
      list.appendChild(el('dd', mono === true ? { class: 'mono', text: value } : { text: value }));
    };

    row('Événement', entry.event_id, true);
    row('Type journalisé', eventLabel(entry.type));
    // `actor` est une CATÉGORIE d'écriture, pas une identité : le nommer
    // « auteur » laisserait croire que le journal désigne qui a parlé.
    row('Acteur enregistré', actorOf(entry.actor));
    row('Tour', String(entry.round));
    row('Horodatage', String(entry.timestamp), true);

    const provenance = entry.provenance;
    if (provenance !== null && typeof provenance === 'object') {
      row('Forme de provenance', String(provenance.shape), true);
      if (typeof provenance.session_id === 'string' && provenance.session_id.length > 0) {
        row('Session native', provenance.session_id, true);
      }
      if (typeof provenance.source_event_id === 'string') row('Événement source', provenance.source_event_id, true);
      if (typeof provenance.response_event_id === 'string') row('Événement de réponse', provenance.response_event_id, true);
      if (typeof provenance.prompt_event_id === 'string') row('Événement de demande', provenance.prompt_event_id, true);
      if (typeof provenance.started_event_id === 'string') row('Événement d’ouverture', provenance.started_event_id, true);
    }
    if (Array.isArray(entry.based_on) && entry.based_on.length > 0) {
      row('Relations', entry.based_on.join(', '), true);
    }
    if (typeof entry.exit_code === 'number') row('Code de sortie', String(entry.exit_code));
    if (typeof entry.reason === 'string' && entry.reason.length > 0) row('Motif', entry.reason, true);

    const details = el('details', { class: 'tech-details' });
    details.appendChild(el('summary', { text: 'Détails techniques' }));
    details.appendChild(list);
    return details;
  }

  function contribution(entry, className, role) {
    const identity = slotOf(entry);
    const title = identity === null ? 'Contribution' : roleOf(identity.slot);
    const article = el('article', { class: `thread-entry ${className}` });
    article.appendChild(head(title, role));
    article.appendChild(body(entry));
    article.appendChild(lead(entry, identity));
    article.appendChild(technical(entry));
    return article;
  }

  function humanEntry(entry) {
    const identity = slotOf(entry);
    const target = identity === null ? '' : ` → ${expertName(identity.slot, identity.provider)}`;
    const article = el('article', { class: 'thread-entry thread-human' });
    article.appendChild(head(`Intervention humaine${target}`, 'human'));
    if (entry.type === 'human_message') article.appendChild(body(entry));
    else article.appendChild(el('p', { class: 'thread-marker-note', text: eventLabel(entry.type) }));
    article.appendChild(lead(entry, null));
    article.appendChild(technical(entry));
    return article;
  }

  function transfer(entry) {
    const provenance = entry.provenance;
    const readable =
      provenance !== null && typeof provenance === 'object' && provenance.shape !== 'GENERATION_NEUTRAL'
        ? `${expertName(provenance.source_slot_id, provenance.source_provider)} → ${expertName(provenance.target_slot_id, provenance.target_provider)}`
        : eventLabel(entry.type);
    return el('p', { class: 'thread-transfer', text: `↳ transmis · ${readable}` });
  }

  function roundMarker(round) {
    return el('p', { class: 'thread-round', text: `Round ${String(round)}` });
  }

  /**
   * Marqueur d'événements techniques — compact, et à sa place chronologique.
   *
   * Il occupait une ligne pleine entre chaque message, avec un renvoi répété
   * vers la chronologie. Le compte et sa POSITION restent — ils disent où le
   * transport s'est intercalé — mais sous la forme d'un repère discret, au rang
   * qui est le sien. Rien n'est retiré : la chronologie porte le détail, et
   * l'Historique permet de l'afficher.
   */
  function technicalNote(count) {
    const suffix = count > 1 ? 's' : '';
    return el('p', {
      class: 'thread-technical-marker',
      text: `${String(count)} événement${suffix} technique${suffix}`,
    });
  }

  /**
   * Rend le fil.
   *
   * `initialContextShown` dit si l'en-tête a déjà rendu le contexte initial à
   * partir de la projection S1. Le cas échéant, les `prompt_sent` humains — un
   * par slot, porteurs du même texte — ne sont pas re-rendus comme deux
   * interventions distinctes. Ils restent dans la chronologie, et sont comptés
   * parmi les événements techniques : rien n'est retiré du journal.
   */
  return function conversationThread(entries, options = {}) {
    const root = el('section', { class: 'thread', attrs: { 'aria-label': 'Conversation' } });
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) {
      root.appendChild(el('p', { class: 'empty', text: 'Aucune contribution journalisée pour ce run.' }));
      return root;
    }

    const initialShown = options.initialContextShown === true;
    let currentRound = null;
    let technical = 0;

    const flushTechnical = () => {
      if (technical > 0) root.appendChild(technicalNote(technical));
      technical = 0;
    };

    // Ordre reçu, strictement. Aucun tri, aucune réorganisation.
    for (const entry of list) {
      if (entry.round !== currentRound) {
        flushTechnical();
        root.appendChild(roundMarker(entry.round));
        currentRound = entry.round;
      }
      const kind = classifyEntry(entry);
      if (kind === ENTRY_CLASSES.TECHNICAL) {
        technical += 1;
        continue;
      }
      if (kind === ENTRY_CLASSES.INITIAL_CONTEXT && initialShown) {
        technical += 1;
        continue;
      }
      flushTechnical();
      if (kind === ENTRY_CLASSES.CONTRIBUTION) {
        const identity = slotOf(entry);
        const role = identity === null ? 'system' : identity.slot;
        root.appendChild(contribution(entry, 'thread-contribution', role));
      } else if (kind === ENTRY_CLASSES.HUMAN) {
        root.appendChild(humanEntry(entry));
      } else if (kind === ENTRY_CLASSES.INITIAL_CONTEXT) {
        root.appendChild(contribution(entry, 'thread-human', 'human'));
      } else {
        root.appendChild(transfer(entry));
      }
    }
    flushTechnical();
    return root;
  };
}
