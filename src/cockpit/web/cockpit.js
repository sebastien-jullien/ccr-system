/**
 * Orchestration du cockpit — lecture seule, sans logique métier.
 *
 * Ce module décide **quand** demander, jamais **ce qui est vrai**. Il ne
 * contient aucune règle d'état, de capacité, de vivacité ni de reprise : ces
 * décisions arrivent déjà prises dans les réponses de l'API, et les recopier
 * ici créerait une seconde autorité — exactement ce qu'INV-20-02 et INV-20-08
 * interdisent.
 *
 * L'état conservé est purement transitoire : ce que l'on a reçu, ce que l'on
 * affiche, ce que l'on charge. Aucun booléen dérivé (`canStep`,
 * `requiresRecovery`…) n'y figure, et une garde de source le vérifie.
 *
 * La vue est injectée : les tests exercent le vrai flux avec une vue factice,
 * et le navigateur utilise la vue DOM. Le chemin de production est donc celui
 * qui est éprouvé.
 */

import { ApiError, newIdempotencyKey } from './api.js';
import { isRetryable, label } from './labels.js';

/**
 * Surface mutable du Slice 4.
 *
 * Définir la *surface* côté client est légitime : c'est une frontière de
 * version, pas une règle métier. La **disponibilité**, elle, reste décidée par
 * le cœur — un identifiant présent ici et refusé par la capacité ne devient pas
 * exécutable.
 */
export const SHORT_MUTATION_IDS = Object.freeze(['PAUSE', 'RESUME', 'DECIDE', 'STOP']);

/**
 * Opérations longues du Slice 5.
 *
 * Elles atteignent un fournisseur : le cockpit en admet deux au plus, et rend
 * un accusé — jamais un résultat. C'est la seule différence de traitement côté
 * navigateur ; la disponibilité reste décidée par le cœur.
 */
export const LONG_MUTATION_IDS = Object.freeze(['STEP', 'SEND']);

const TIMELINE_PAGE_SIZE = 100;

/**
 * Cadence du suivi d'une opération longue.
 *
 * Deux rythmes, une seule boucle : la durée affichée avance chaque seconde
 * parce que c'est ce qui rend l'attente lisible, et le reçu n'est relu qu'une
 * fois sur cinq parce que le relire chaque seconde n'apprendrait rien de plus.
 */
const FOLLOW_UP_TICK_MS = 1000;
const FOLLOW_UP_POLL_TICKS = 5;

/**
 * Budget d'échecs de lecture avant abandon du suivi.
 *
 * Le suivi s'arrête sur une **issue terminale**, jamais sur un chronomètre :
 * l'initialisation réelle du run `CCR-20260404-001` a duré onze minutes et
 * demie, et un plafond de durée aurait rendu le silence exactement au moment
 * où l'information devenait utile. Ce qui est borné, c'est la cadence et
 * l'obstination — pas la patience.
 */
const FOLLOW_UP_ERROR_BUDGET = 3;

/**
 * Séquenceur « dernière demande gagne ».
 *
 * Une réponse lente pour A ne doit jamais écraser l'écran de B. Le compteur
 * tranche, et l'`AbortController` évite de payer une réponse dont on sait déjà
 * qu'elle sera ignorée.
 */
function createLatestOnly() {
  let generation = 0;
  let controller = null;
  return {
    begin() {
      generation += 1;
      if (controller !== null) controller.abort();
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      return { id: generation, signal: controller === null ? undefined : controller.signal };
    },
    isCurrent(token) {
      return token.id === generation;
    },
  };
}

function describe(error) {
  if (error instanceof ApiError) {
    return { code: error.code, message: label.error(error.code), retryable: isRetryable(error.code) };
  }
  return { code: 'INTERNAL_ERROR', message: label.error('INTERNAL_ERROR'), retryable: false };
}

function isAbort(error) {
  return Boolean(error) && error.name === 'AbortError';
}

export function createCockpit(deps) {
  const { api, view } = deps;

  /** État strictement transitoire. Aucune valeur dérivée n'y est admise. */
  const state = {
    runs: null,
    selectedRunId: null,
    runView: null,
    timelineEntries: [],
    timelineRevision: null,
    timelineCursorNext: null,
    timelineStale: false,
    recoveryView: null,
    /** Generation du run affiche, telle que le serveur la declare. */
    native: false,
    /** Tentative de création courante : une action humaine, une clé. */
    start: null,
    /**
     * Une tentative de création est-elle encore **non résolue** ?
     *
     * Transitoire et purement défensif : ne décrit aucun état de run, et n'est
     * jamais lu pour conclure quoi que ce soit sur le monde.
     *
     * Sa durée n'est PAS celle de la requête HTTP. Un `202` rend la main au
     * client alors que la création se poursuit, et une issue inconnue laisse
     * ouverte la possibilité qu'un run existe déjà. Dans ces deux cas, la
     * tentative n'est pas résolue, et composer une seconde intention
     * produirait un second run avec une clé neuve.
     *
     * ```text
     * RÉSOLU AVEC CERTITUDE   SUCCEEDED · FAILED rendu par le serveur
     * NON RÉSOLU              202 en cours · issue inconnue · sans réponse
     * ```
     */
    startInFlight: false,
    /**
     * Effet de START, transporté par la collection (`V2.3-S4`).
     *
     * `null` tant que la liste n'a pas été lue, ou si le serveur ne le porte
     * pas. Aucune valeur de repli : un fait absent reste absent.
     */
    startEffect: null,
    config: null,
    doctor: null,
    /**
     * Tentative en cours ou dernière tentative.
     *
     * Porte la clé d'idempotence **de la tentative**, pas de l'envoi : un
     * nouvel essai réutilise la même, sans quoi il produirait un second effet.
     */
    attempt: null,
    /** Tentative de reprise courante. Même discipline : une action, une clé. */
    recoveryAttempt: null,
    /** Flux d'invalidation ouverts. Transport, jamais métier. */
    listStream: null,
    runStream: null,
    /** Rafraîchissements déjà programmés, par ressource. */
    pendingRefresh: { list: false, run: false },
    /**
     * Suivi d'une opération longue — **lecture seule**.
     *
     * Ne porte ni corps de requête, ni clé d'idempotence, ni action : il n'y a
     * rien ici avec quoi rejouer une mutation, et c'est délibéré. Une seule
     * opération est suivie à la fois.
     */
    followUp: null,
  };

  const runSequence = createLatestOnly();
  const timelineSequence = createLatestOnly();

  /** Une 401 signifie que la session du serveur a été renouvelée. */
  function handleFailure(error, show) {
    if (isAbort(error)) return;
    const described = describe(error);
    if (described.code === 'UNAUTHENTICATED') {
      // Aucun réamorçage automatique : un rechargement humain suffit, et une
      // boucle de bootstrap masquerait la cause.
      view.showSessionExpired(described.message);
      return;
    }
    show(described);
  }

  /**
   * Recharge la liste.
   *
   * `silent` distingue un rechargement **demandé** d'un rechargement
   * **provoqué** par une écriture extérieure. Le second ne doit pas se
   * raconter : annoncer « chargement… » effacerait le message de l'action que
   * l'humain vient de faire, alors qu'il n'a rien demandé.
   */
  async function refreshRuns(options = {}) {
    if (options.silent !== true) view.showRunsLoading();
    try {
      const payload = await api.listRuns();
      // L'ordre de l'API fait foi : aucun tri client.
      state.runs = payload.runs;
      // Fait autoritaire, transporté tel quel. Le frontend ne le reconstruit
      // jamais — son absence est un fait, pas un défaut à combler.
      state.startEffect = payload.start_effect ?? null;
      view.showRuns(state.runs, state.selectedRunId);
      view.showStartEffect(state.startEffect);
    } catch (error) {
      state.runs = null;
      handleFailure(error, (described) => view.showRunsError(described));
    }
  }

  /**
   * Generation d'une vue de run, **telle que le serveur la declare**.
   *
   * Jamais devinee : ni depuis `sessions.claude`, ni depuis `active_agent`, ni
   * depuis un fournisseur, ni depuis une erreur de lecture. La surface HTTP
   * l'etablit depuis les faits persistes du run, et c'est la seule autorite.
   */
  function isNativeView(runView) {
    return runView !== null && typeof runView === 'object'
      && runView.generation === 'NATIVE_V21_EXECUTION';
  }

  async function loadRun(runId, options = {}) {
    // Le flux suit l'écran : on n'écoute que ce qui est affiché.
    if (runId !== state.selectedRunId) followRun(runId);
    const token = runSequence.begin();
    state.selectedRunId = runId;
    if (options.silent !== true) {
      // Ouvrir un run vide l'écran : on ne montre pas les faits d'un autre run
      // pendant le chargement. Un rafraîchissement **provoqué** par une
      // écriture extérieure, lui, ne démonte rien : l'humain regarde peut-être
      // cet écran, et une capacité effacée le temps d'un aller-retour ferait
      // disparaître un bouton sous son curseur — ou perdre son clic.
      state.runView = null;
      state.recoveryView = null;
      // La generation du run precedent ne doit rien decider du suivant.
      state.native = false;
      state.timelineEntries = [];
      state.timelineRevision = null;
      state.timelineCursorNext = null;
      state.timelineStale = false;
      view.showRunLoading(runId);
    }
    view.showRuns(state.runs, runId);

    try {
      const runView = await api.getRun(runId, token.signal);
      if (!runSequence.isCurrent(token)) return;
      state.runView = runView;
      state.native = isNativeView(runView);
      view.showRunView(runView, { silent: options.silent === true });
    } catch (error) {
      if (!runSequence.isCurrent(token)) return;
      handleFailure(error, (described) => view.showRunError(described));
      return;
    }

    // Une seule route, deux projections (V2.1-IMP-19). La generation ne decide
    // plus s'il faut demander la chronologie — elle decide seulement comment la
    // reponse est rendue, et c'est la reponse elle-meme qui la porte.
    //
    // Un echec ici reste local au panneau : le statut et la reprise ci-dessous
    // se chargent quand meme.
    try {
      const page = await api.getTimeline(runId, { limit: TIMELINE_PAGE_SIZE }, token.signal);
      if (!runSequence.isCurrent(token)) return;
      state.timelineEntries = page.entries.slice();
      state.timelineRevision = page.revision;
      state.timelineCursorNext = page.cursor_next;
      view.showTimeline(state.timelineEntries, page, { silent: options.silent === true });
    } catch (error) {
      if (!runSequence.isCurrent(token)) return;
      handleFailure(error, (described) => view.showTimelineError(described));
    }

    try {
      const recovery = await api.getRecovery(runId, token.signal);
      if (!runSequence.isCurrent(token)) return;
      state.recoveryView = recovery;
      view.showRecovery(recovery);
    } catch (error) {
      if (!runSequence.isCurrent(token)) return;
      handleFailure(error, (described) => view.showRecoveryError(described));
    }
  }

  async function loadMoreTimeline() {
    const cursor = state.timelineCursorNext;
    if (typeof cursor !== 'string' || cursor.length === 0) return;
    const runId = state.selectedRunId;
    const token = timelineSequence.begin();
    view.showTimelineLoading();

    try {
      const page = await api.getTimeline(runId, { limit: TIMELINE_PAGE_SIZE, cursor }, token.signal);
      if (!timelineSequence.isCurrent(token)) return;
      state.timelineEntries = state.timelineEntries.concat(page.entries);
      state.timelineCursorNext = page.cursor_next;
      view.showTimeline(state.timelineEntries, page);
    } catch (error) {
      if (!timelineSequence.isCurrent(token)) return;
      if (error instanceof ApiError && error.code === 'STALE_REVISION') {
        // Le run a changé sous la pagination. Fusionner deux révisions
        // produirait une chronologie qui n'a jamais existé : on s'arrête, on le
        // dit, et le rechargement complet reste une décision humaine.
        state.timelineStale = true;
        state.timelineCursorNext = null;
        view.showTimelineStale(label.error('STALE_REVISION'));
        return;
      }
      handleFailure(error, (described) => view.showTimelineError(described));
    }
  }

  async function reloadTimeline() {
    const runId = state.selectedRunId;
    if (typeof runId !== 'string') return;
    const token = timelineSequence.begin();
    state.timelineStale = false;
    view.showTimelineLoading();
    try {
      const page = await api.getTimeline(runId, { limit: TIMELINE_PAGE_SIZE }, token.signal);
      if (!timelineSequence.isCurrent(token)) return;
      state.timelineEntries = page.entries.slice();
      state.timelineRevision = page.revision;
      state.timelineCursorNext = page.cursor_next;
      view.showTimeline(state.timelineEntries, page);
    } catch (error) {
      if (!timelineSequence.isCurrent(token)) return;
      handleFailure(error, (described) => view.showTimelineError(described));
    }
  }

  async function refreshRun() {
    if (typeof state.selectedRunId === 'string') await loadRun(state.selectedRunId);
  }

  async function refreshDoctor() {
    view.showDoctorLoading();
    try {
      state.doctor = await api.getDoctor();
      view.showDoctor(state.doctor);
    } catch (error) {
      state.doctor = null;
      handleFailure(error, (described) => view.showDoctorError(described));
    }
  }

  async function refreshConfig() {
    view.showConfigLoading();
    try {
      state.config = await api.getConfig();
      view.showConfig(state.config);
    } catch (error) {
      state.config = null;
      handleFailure(error, (described) => view.showConfigError(described));
    }
  }

  /**
   * Autorisation d'une mutation de run, **lue dans la projection reçue**.
   *
   * Deux formes de vue coexistent réellement dans un même data root, et le
   * serveur les distingue par `generation` :
   *
   * ```text
   * historique   identity.run_id          capabilities.capabilities[] { id, allowed, targets }
   * native       run.identity.run_id      run.operations.{step,pause,resume}
   *                                       run.operations.experts[slot].send
   * ```
   *
   * La forme native ne porte NI `identity` NI `capabilities` à la racine. Lire
   * la première sur un run natif jetait une `TypeError` avant tout envoi, et le
   * bouton restait sans effet — c'est le défaut `A-P0-01`.
   *
   * Aucune autorisation n'est recalculée ici : chaque branche relit `allowed`
   * là où le serveur l'a écrit. Rend `null` lorsque la vue ne permet pas de
   * composer le geste — l'appelant le rend visible plutôt que de l'avaler.
   */
  function runMutationGrant(runView, action) {
    if (!isNativeView(runView)) {
      const table = runView.capabilities;
      const entries = table === undefined || table === null ? null : table.capabilities;
      if (!Array.isArray(entries)) return null;
      const capability = entries.find((entry) => entry.id === action);
      if (capability === undefined) return null;
      const identity = runView.identity;
      if (identity === undefined || identity === null || typeof identity.run_id !== 'string') return null;
      return {
        runId: identity.run_id,
        allowed: capability.allowed === true,
        // Les cibles viennent de la capacité reçue : le navigateur ne déduit
        // jamais une cible des sessions du manifeste.
        allowsTarget: (target) => Array.isArray(capability.targets) && capability.targets.includes(target),
      };
    }

    const run = runView.run;
    if (run === undefined || run === null) return null;
    const identity = run.identity;
    if (identity === undefined || identity === null || typeof identity.run_id !== 'string') return null;
    const operations = run.operations;
    if (operations === undefined || operations === null) return null;
    const runId = identity.run_id;
    const refuse = { runId, allowed: false, allowsTarget: () => false };

    if (action === 'STEP') {
      const step = operations.step;
      if (step === undefined || step === null) return null;
      return { runId, allowed: step.allowed === true, allowsTarget: () => false };
    }
    if (action === 'PAUSE' || action === 'RESUME') {
      const control = action === 'PAUSE' ? operations.pause : operations.resume;
      if (control === undefined || control === null) return null;
      return { runId, allowed: control.allowed === true, allowsTarget: () => false };
    }
    if (action === 'SEND') {
      const experts = operations.experts;
      if (experts === undefined || experts === null) return null;
      // Un envoi natif vise un ExpertSlot, et son autorisation est portée par
      // ce slot — jamais par une liste globale de cibles.
      const allowsTarget = (target) => {
        const slot = typeof target === 'string' ? experts[target] : undefined;
        return slot !== undefined && slot !== null && slot.send !== undefined
          && slot.send !== null && slot.send.allowed === true;
      };
      const anyAllowed = Object.keys(experts).some((slot) => allowsTarget(slot));
      return { runId, allowed: anyAllowed, allowsTarget };
    }
    // `DECIDE` et `STOP` appartiennent à la forme historique : la projection
    // native ne les porte pas, et le rendu natif ne les offre pas.
    return refuse;
  }

  /**
   * Exécute une mutation courte.
   *
   * Trois refus possibles avant tout envoi, et aucun n'est une règle métier
   * réinventée : l'action doit appartenir à la surface du slice, la capacité
   * reçue doit l'autoriser, et une vue doit exister.
   *
   * Un quatrième cas existe désormais, et il n'est pas un refus : la vue ne
   * permet pas de composer le geste. Il est **rendu visible**, parce qu'un
   * bouton offert puis inerte est le pire des trois.
   */
  async function mutate(action, options = {}) {
    try {
      const runView = state.runView;
      const known = SHORT_MUTATION_IDS.includes(action) || LONG_MUTATION_IDS.includes(action);
      if (runView === null || !known) return;

      const grant = runMutationGrant(runView, action);
      if (grant === null) {
        view.showMutationError(action, {
          code: 'CLIENT_CANNOT_COMPOSE',
          message: label.error('CLIENT_CANNOT_COMPOSE'),
          retryable: false,
        });
        return;
      }
      // Refus de capacité : inchangé, et silencieux comme auparavant. Le rendu
      // n'offre pas le geste dans ce cas.
      if (!grant.allowed) return;

      const payload = { expected_revision: runView.revision };
      if (action === 'SEND') {
        const target = options.target;
        if (!grant.allowsTarget(target)) {
          view.showMutationError(action, { code: 'INVALID_ARGUMENT', message: label.error('INVALID_ARGUMENT'), retryable: false });
          return;
        }
        const message = typeof options.content === 'string' ? options.content.trim() : '';
        if (message.length === 0) {
          view.showMutationError(action, { code: 'INVALID_ARGUMENT', message: label.error('INVALID_ARGUMENT'), retryable: false });
          return;
        }
        payload.target = target;
        payload.content = message;
      }
      if (action === 'DECIDE') {
        const content = typeof options.content === 'string' ? options.content.trim() : '';
        if (content.length === 0) {
          view.showMutationError(action, { code: 'INVALID_ARGUMENT', message: label.error('INVALID_ARGUMENT'), retryable: false });
          return;
        }
        payload.content = content;
      }

      // Une tentative, une clé. Le réessai la réutilise.
      const attempt = { action, runId: grant.runId, key: newIdempotencyKey(), payload };
      state.attempt = attempt;
      await sendAttempt(attempt);
    } catch (error) {
      // Un défaut du navigateur ne doit pas se terminer en bouton mort : il
      // s'affiche. Aucun réessai, aucun rejeu, aucune mutation annoncée.
      if (isAbort(error)) return;
      view.showMutationError(action, {
        code: 'CLIENT_CANNOT_COMPOSE',
        message: label.error('CLIENT_CANNOT_COMPOSE'),
        retryable: false,
      });
    }
  }

  /** Réémet la tentative courante **sans** régénérer sa clé. */
  async function retryMutation() {
    if (state.attempt === null) return;
    // Quatre surfaces, quatre émetteurs : réémettre une tentative de domaine
    // par la route des mutations de run l'enverrait à la mauvaise autorité.
    if (state.attempt.kind === 'RECONCILE') {
      await sendReconciliation(state.attempt);
      return;
    }
    if (state.attempt.kind === 'CONTROVERSY' || state.attempt.kind === 'EVIDENCE') {
      await sendDomainMutation(state.attempt);
      return;
    }
    await sendAttempt(state.attempt);
  }

  /**
   * Enregistre une controverse V3 depuis l'écran (`V5.1`).
   *
   * Le navigateur assemble ce que l'humain a saisi et le transmet. Il ne décide
   * pas qu'un désaccord existe, n'alloue aucun identifiant métier, et n'appelle
   * aucun modèle : `RECORD_CONTROVERSY` est un acte humain.
   */
  async function recordControversy(request = {}) {
    const runView = state.runView;
    if (runView === null) return;
    const projection = runView.controversies;
    if (projection === null || projection === undefined) return;
    if (projection.availability !== 'AVAILABLE') return;

    const runId = state.selectedRunId;
    if (typeof runId !== 'string' || runId.length === 0) return;

    const revision = runView.controversy_revision;
    const statement = typeof request.statement === 'string' ? request.statement.trim() : '';
    const eventIds = splitIdentifiers(request.eventIds);
    if (typeof revision !== 'string' || revision.length === 0
      || statement.length === 0 || eventIds.length === 0) {
      view.showMutationError('CONTROVERSY_RECORD', {
        code: 'INVALID_ARGUMENT',
        message: label.error('INVALID_ARGUMENT'),
        retryable: false,
      });
      return;
    }

    await startDomainMutation({
      kind: 'CONTROVERSY',
      action: 'CONTROVERSY_RECORD',
      runId,
      payload: {
        operation: 'RECORD_CONTROVERSY',
        expected_controversy_revision: revision,
        provenance_event_ids: eventIds,
        statement,
      },
    });
  }

  /** Retient un matériau V4 — retenir n'est pas verser. */
  async function registerMaterial(request = {}) {
    const context = evidenceContext();
    if (context === null) return;

    const value = typeof request.value === 'string' ? request.value.trim() : '';
    const form = typeof request.form === 'string' ? request.form : '';
    const representation = representationOf(form, value);
    if (representation === null) {
      view.showMutationError('EVIDENCE_REGISTER_MATERIAL', {
        code: 'INVALID_ARGUMENT',
        message: label.error('INVALID_ARGUMENT'),
        retryable: false,
      });
      return;
    }

    const labelText = typeof request.label === 'string' ? request.label.trim() : '';
    await startDomainMutation({
      kind: 'EVIDENCE',
      action: 'EVIDENCE_REGISTER_MATERIAL',
      runId: context.runId,
      payload: {
        operation: 'REGISTER_MATERIAL',
        expected_evidence_revision: context.revision,
        representation,
        ...(labelText.length === 0 ? {} : { label: labelText }),
      },
    });
  }

  /** Verse un matériau existant au débat, contre une entrée de controverse. */
  async function adduceMaterial(request = {}) {
    const context = evidenceContext();
    if (context === null) return;

    const materialId = typeof request.materialId === 'string' ? request.materialId : '';
    const targetEntryId = typeof request.targetEntryId === 'string' ? request.targetEntryId : '';
    const orientation = typeof request.orientation === 'string' ? request.orientation : '';
    if (materialId.length === 0 || targetEntryId.length === 0 || orientation.length === 0) {
      view.showMutationError('EVIDENCE_ADDUCE_MATERIAL', {
        code: 'INVALID_ARGUMENT',
        message: label.error('INVALID_ARGUMENT'),
        retryable: false,
      });
      return;
    }

    await startDomainMutation({
      kind: 'EVIDENCE',
      action: 'EVIDENCE_ADDUCE_MATERIAL',
      runId: context.runId,
      payload: {
        operation: 'ADDUCE_MATERIAL',
        expected_evidence_revision: context.revision,
        material_id: materialId,
        target_entry_id: targetEntryId,
        // Fournie explicitement : le service n'applique aucun défaut, et le
        // navigateur n'en invente pas un à sa place.
        orientation,
      },
    });
  }

  /** Contexte V4 : run affiché et jeton de fraîcheur, ou rien. */
  function evidenceContext() {
    const runView = state.runView;
    if (runView === null) return null;
    const projection = runView.evidence;
    if (projection === null || projection === undefined) return null;
    if (projection.availability !== 'AVAILABLE') return null;
    const runId = state.selectedRunId;
    if (typeof runId !== 'string' || runId.length === 0) return null;
    const revision = projection.evidence_revision;
    if (typeof revision !== 'string' || revision.length === 0) return null;
    return { runId, revision };
  }

  /**
   * Représentation V4, telle que le contrat la nomme — trois formes, pas une
   * quatrième. Rend `null` si l'humain n'a rien saisi.
   */
  function representationOf(form, value) {
    if (value.length === 0) return null;
    if (form === 'INLINE_TEXT') return { form, text: value };
    if (form === 'RUN_EVENT') return { form, event_id: value };
    if (form === 'EXTERNAL_REFERENCE') return { form, locator: value };
    return null;
  }

  /** Identifiants saisis à la main : séparés par virgule ou espace. */
  /**
   * Identifiants d'une intention humaine.
   *
   * Depuis `V5.1`, le parcours normal fournit un **tableau** — ce que l'humain a
   * coché dans le sélecteur. La forme chaîne reste acceptée : elle ne coûte
   * rien, et retirer un chemin d'entrée n'était pas l'objet de cette tranche.
   */
  function splitIdentifiers(raw) {
    if (Array.isArray(raw)) {
      return raw.filter((token) => typeof token === 'string' && token.length > 0);
    }
    if (typeof raw !== 'string') return [];
    return raw.split(/[\s,]+/).filter((token) => token.length > 0);
  }

  /**
   * Une intention, une clé — pour V3 comme pour V4.
   *
   * Le réessai la réutilise : c'est ce qui rend une retransmission inoffensive,
   * et c'est la doctrine d'idempotence durable que le §20.3 du contrat V4 exige
   * de cette surface, sans altération.
   */
  async function startDomainMutation(attempt) {
    const complete = { ...attempt, key: newIdempotencyKey() };
    state.attempt = complete;
    await sendDomainMutation(complete);
  }

  async function sendDomainMutation(attempt) {
    view.showMutationPending(attempt.action);
    try {
      const receipt = attempt.kind === 'CONTROVERSY'
        ? await api.recordControversy(attempt.runId, attempt.payload, attempt.key)
        : await api.recordEvidence(attempt.runId, attempt.payload, attempt.key);
      state.attempt = { ...attempt, operationId: receipt.operation_id };

      if (receipt.status === 'SUCCEEDED') {
        // Aucune mise à jour optimiste : la vérité revient du read model, et
        // rien n'est affiché avant que le serveur ne l'ait confirmé.
        await loadRun(attempt.runId);
        view.showMutationSucceeded(attempt.action, receipt);
        return;
      }
      view.showMutationUndetermined(attempt.action, receipt);
    } catch (error) {
      if (isAbort(error)) return;
      const described = describe(error);
      if (described.code === 'UNAUTHENTICATED') {
        view.showSessionExpired(described.message);
        return;
      }
      if (error instanceof ApiError && typeof error.operationId === 'string') {
        state.attempt = { ...attempt, operationId: error.operationId };
      }
      view.showMutationError(attempt.action, described);
    }
  }

  /**
   * Geste de réconciliation V5, depuis l'écran (V5.1).
   *
   * Le navigateur ne décide de rien : il assemble ce que l'humain a saisi et le
   * transmet. La disponibilité vient de la projection du serveur, jamais d'une
   * valeur codée ici ; les motifs de refus viennent du service.
   */
  async function reconcile(request = {}) {
    const runView = state.runView;
    if (runView === null) return;
    const projection = runView.reconciliations;
    if (projection === null || projection === undefined) return;
    if (projection.availability !== 'AVAILABLE') return;

    // Le run affiché, comme les autres flux natifs. `runView.identity` appartient
    // à la forme historique, et un run natif ne la porte pas.
    const runId = state.selectedRunId;
    if (typeof runId !== 'string' || runId.length === 0) return;

    const payload = reconciliationPayload(request, projection);
    if (payload === null) {
      view.showMutationError(reconcileAction(request.geste), {
        code: 'INVALID_ARGUMENT',
        message: label.error('INVALID_ARGUMENT'),
        retryable: false,
      });
      return;
    }

    // Une intention, une clé. Le réessai la réutilise — c'est ce qui empêche un
    // second clic de produire un second appel fournisseur.
    const attempt = {
      kind: 'RECONCILE',
      action: reconcileAction(request.geste),
      runId,
      key: newIdempotencyKey(),
      payload,
    };
    state.attempt = attempt;
    await sendReconciliation(attempt);
  }

  /** Nom d'affichage du geste — jamais l'opération technique. */
  function reconcileAction(geste) {
    return `RECONCILE_${typeof geste === 'string' ? geste : 'PROPOSE'}`;
  }

  /**
   * Assemble le corps V5 attendu par la route.
   *
   * Rend `null` lorsque l'humain n'a pas fourni ce que le geste exige — une
   * justification, une formulation. Ce n'est pas une validation métier : le
   * service reste seul juge de ce qu'il accepte.
   */
  function reconciliationPayload(request, projection) {
    const controversy = request.controversyId;
    if (typeof controversy !== 'string' || controversy.length === 0) return null;

    if (request.geste === 'PROPOSE') {
      const slot = request.expertSlot;
      if (typeof slot !== 'string' || slot.length === 0) return null;
      // Aucune révision attendue : le chemin assisté capture lui-même sa
      // référence de fraîcheur sous verrou, avant le dispatch.
      return {
        operation: 'PROPOSE_BY_MODEL',
        target_controversy_id: controversy,
        scope_kind: 'WHOLE',
        expert_slot: slot,
      };
    }

    const statement = typeof request.statement === 'string' ? request.statement.trim() : '';
    if (statement.length === 0) return null;
    const proposalId = request.proposalId;
    if (typeof proposalId !== 'string' || proposalId.length === 0) return null;
    const provenance = { kind: 'DECLARED', statement };
    const expected = projection.reconciliation_revision;

    if (request.geste === 'ACCEPT' || request.geste === 'REJECT') {
      const payload = {
        operation: 'RESPOND',
        expected_revision: expected,
        target_controversy_id: controversy,
        proposal_id: proposalId,
        mode: request.geste,
        provenance,
      };
      const option = typeof request.optionId === 'string' ? request.optionId : '';
      // Une option désignée dans une réponse ne vaut PAS adoption : le contrat
      // l'admet pour les deux modes, et elle ne produit aucun effet.
      if (option.length > 0) payload.responded_option_id = option;
      return payload;
    }

    if (request.geste === 'MODIFIES' || request.geste === 'REPLACES') {
      const content = typeof request.content === 'string' ? request.content.trim() : '';
      if (content.length === 0) return null;
      const scope = request.scope;
      // Le périmètre vient de la proposition telle que le serveur l'a
      // enregistrée. En inventer un le soumettrait comme s'il venait de l'humain.
      if (scope === null || scope === undefined) return null;
      return {
        operation: 'RECORD_ACT',
        expected_revision: expected,
        target_controversy_id: controversy,
        scope_kind: scope.scope_kind,
        scope: scope.scope,
        content,
        provenance,
        responds_to: { proposal_id: proposalId, relation: request.geste },
      };
    }

    return null;
  }

  /**
   * Émet une tentative V5.
   *
   * Un `202` est une réponse normale : la proposition assistée est une opération
   * longue, et son reçu reste `RUNNING` jusqu'à ce que le serveur le termine.
   * Aucune conclusion n'est prise à sa place.
   */
  async function sendReconciliation(attempt) {
    view.showMutationPending(attempt.action);
    try {
      const receipt = await api.reconcile(attempt.runId, attempt.payload, attempt.key);
      state.attempt = { ...attempt, operationId: receipt.operation_id };

      if (receipt.status === 'SUCCEEDED') {
        // Aucune mise à jour optimiste : la vérité revient du read model.
        stopFollowUp();
        await loadRun(attempt.runId);
        view.showMutationSucceeded(attempt.action, receipt);
        return;
      }
      view.showMutationUndetermined(attempt.action, receipt, attemptContext(attempt));
      // L'humain n'a plus à cliquer pour apprendre la fin : une proposition
      // assistée peut ne rien enregistrer, et rien n'invaliderait alors la vue.
      if (receipt.status === 'RUNNING') beginFollowUp('operation', receipt.operation_id);
    } catch (error) {
      if (isAbort(error)) return;
      const described = describe(error);
      if (described.code === 'UNAUTHENTICATED') {
        view.showSessionExpired(described.message);
        return;
      }
      if (error instanceof ApiError && typeof error.operationId === 'string') {
        state.attempt = { ...attempt, operationId: error.operationId };
      }
      view.showMutationError(attempt.action, described);
    }
  }

  async function sendAttempt(attempt) {
    view.showMutationPending(attempt.action);
    try {
      const receipt = await api.mutate(attempt.action, attempt.runId, attempt.payload, attempt.key);
      state.attempt = { ...attempt, operationId: receipt.operation_id };

      if (receipt.status === 'SUCCEEDED') {
        // Aucune mise à jour optimiste : la vérité revient du read model, et
        // la confirmation ne s affiche qu une fois la vue rechargée — sans
        // quoi elle annoncerait un état que l écran ne montre pas encore.
        stopFollowUp();
        await loadRun(attempt.runId);
        await refreshRuns();
        view.showMutationSucceeded(attempt.action, receipt);
        return;
      }
      // `RUNNING` ou `UNKNOWN` : on ne conclut pas à la place du serveur.
      view.showMutationUndetermined(attempt.action, receipt, attemptContext(attempt));
      if (receipt.status === 'RUNNING') beginFollowUp('operation', receipt.operation_id);
    } catch (error) {
      if (isAbort(error)) return;
      const described = describe(error);
      if (described.code === 'UNAUTHENTICATED') {
        view.showSessionExpired(described.message);
        return;
      }
      if (error instanceof ApiError && typeof error.operationId === 'string') {
        state.attempt = { ...attempt, operationId: error.operationId };
      }
      // Une vue périmée exige une décision humaine, pas un réessai automatique
      // sur la nouvelle révision : l'action avait été décidée sur l'ancienne.
      view.showMutationError(attempt.action, described);
    }
  }

  /**
   * Qui l'humain a demandé, et sur quel moteur.
   *
   * Le slot vient de la requête que le navigateur vient d'émettre — ce n'est
   * pas une déduction. Le moteur vient du manifeste, par la vue du run. Si l'un
   * des deux manque, rien n'est rendu plutôt qu'un nom approximatif.
   */
  function attemptContext(attempt) {
    const slot = attempt.payload === null || attempt.payload === undefined
      ? undefined
      : attempt.payload.expert_slot;
    if (typeof slot !== 'string' || slot.length === 0) return undefined;
    const experts = state.runView?.run?.experts;
    const expert = experts === undefined || experts === null ? undefined : experts[slot];
    return expert === undefined || expert === null
      ? { expertSlot: slot }
      : { expertSlot: slot, provider: expert.provider };
  }

  /**
   * Applique un reçu à l'écran, et dit si l'opération est **terminée**.
   *
   * `SUCCEEDED` ne veut pas dire « enregistré » : le reçu porte désormais son
   * issue métier, et c'est la vue qui la traduit. Le cockpit ne l'interprète
   * pas — il ne fait que constater que plus rien n'est à attendre.
   */
  async function applyOperationReceipt(attempt, receipt) {
    if (receipt.status === 'SUCCEEDED') {
      await loadRun(attempt.runId);
      await refreshRuns();
      view.showMutationSucceeded(attempt.action, receipt);
      return true;
    }
    if (receipt.status === 'FAILED') {
      const code = typeof receipt.error_code === 'string' ? receipt.error_code : 'INTERNAL_ERROR';
      view.showMutationError(attempt.action, {
        code,
        message: label.error(code),
        retryable: isRetryable(code),
      });
      return true;
    }
    view.showMutationUndetermined(attempt.action, receipt, attemptContext(attempt));
    // `UNKNOWN` ne redeviendra pas connu : le reçu terminal n'a pas pu être
    // écrit, et le relire ne l'écrira pas davantage.
    return receipt.status === 'UNKNOWN';
  }

  /** Consulte le reçu d'une tentative indéterminée. Geste explicite, borné. */
  async function checkOperation() {
    const attempt = state.attempt;
    if (attempt === null || typeof attempt.operationId !== 'string') return;
    try {
      const receipt = await api.getOperation(attempt.operationId);
      // Un geste manuel relance le suivi lorsqu'il reste quelque chose à
      // attendre : demander ne doit pas priver de la suite.
      if (await applyOperationReceipt(attempt, receipt)) stopFollowUp();
      else beginFollowUp('operation', receipt.operation_id);
    } catch (error) {
      handleFailure(error, (described) => view.showMutationError(attempt.action, described));
    }
  }

  // ------------------------------------------------------------------------
  // Suivi automatique d'une opération longue (`V5.1`) — lecture seule
  // ------------------------------------------------------------------------

  /**
   * Ordonnanceur du suivi, injectable.
   *
   * Sans lui, aucun suivi n'est installé — un contexte de test qui ne le
   * fournit pas obtient exactement le comportement d'avant, et les tests qui le
   * fournissent pilotent le temps sans horloge réelle.
   */
  const scheduleFollowUp = typeof deps.scheduleFollowUp === 'function' ? deps.scheduleFollowUp : null;

  function stopFollowUp() {
    state.followUp = null;
  }

  /**
   * Démarre le suivi d'une opération.
   *
   * Ne transporte que l'identifiant du reçu : il n'existe ici **aucun moyen**
   * de réémettre la mutation, et c'est la garantie structurelle qu'un suivi ne
   * peut pas produire un second appel fournisseur.
   */
  function beginFollowUp(kind, operationId) {
    if (scheduleFollowUp === null) return;
    if (typeof operationId !== 'string' || operationId.length === 0) return;
    if (state.followUp !== null && state.followUp.operationId === operationId) return;
    state.followUp = { kind, operationId, ticks: 0, errors: 0 };
    scheduleFollowUp(runFollowUpTick, FOLLOW_UP_TICK_MS);
  }

  /**
   * Un battement : repeindre la durée, et parfois relire le reçu.
   *
   * `GET /api/operations/:id` est la seule requête émise, et elle est en
   * lecture seule. Aucune clé d'idempotence, aucun corps, aucune mutation.
   */
  async function runFollowUpTick() {
    const current = state.followUp;
    if (current === null || scheduleFollowUp === null) return;

    view.tickElapsed();
    current.ticks += 1;

    if (current.ticks % FOLLOW_UP_POLL_TICKS === 0) {
      let finished = false;
      try {
        const receipt = await api.getOperation(current.operationId);
        current.errors = 0;
        finished = current.kind === 'start'
          ? await applyStartReceipt(receipt)
          : await applyFollowUpOperation(current, receipt);
      } catch (error) {
        if (isAbort(error)) return;
        current.errors += 1;
        // Une lecture qui échoue n'est pas une issue : on n'affiche rien de
        // nouveau, on réessaie, et on renonce plutôt que d'insister sans fin.
        if (current.errors >= FOLLOW_UP_ERROR_BUDGET) {
          stopFollowUp();
          return;
        }
      }
      if (finished) {
        stopFollowUp();
        return;
      }
    }

    // Le suivi a pu être remplacé ou arrêté pendant l'attente de la lecture.
    if (state.followUp === current) scheduleFollowUp(runFollowUpTick, FOLLOW_UP_TICK_MS);
  }

  async function applyFollowUpOperation(current, receipt) {
    const attempt = state.attempt;
    // La tentative suivie n'est plus celle affichée : le suivi s'efface, il ne
    // s'impose pas à un écran qui parle d'autre chose.
    if (attempt === null || attempt.operationId !== current.operationId) return true;
    return applyOperationReceipt(attempt, receipt);
  }

  /**
   * Crée un run.
   *
   * Une action humaine, une clé. Après une remédiation externe — `ccr setup`
   * dans un terminal — c'est un **nouveau** clic qui produit une nouvelle clé :
   * requalifier silencieusement l'ancien reçu reviendrait à prétendre qu'une
   * tentative condamnée a réussi.
   */
  async function createRun(payload) {
    // Garde d'in-flight : une soumission active, une requête de création au
    // plus. Elle ne remplace pas l'idempotence — elle la protège en amont.
    //
    // Chaque appel alloue une clé NEUVE, donc une intention neuve : deux clics
    // avant le premier rendu auraient produit deux runs réels et jusqu'à
    // quatre invocations fournisseur. Le désarmement visuel du bouton ne
    // suffisait pas, puisqu'il arrive après le gestionnaire.
    if (state.startInFlight === true) return;
    state.startInFlight = true;
    // Aucune levée en `finally` : le retour de la requête ne prouve pas que la
    // tentative soit résolue. Seul un verdict du serveur la libère.
    const attempt = { action: 'START', key: newIdempotencyKey(), payload };
    state.start = attempt;
    await sendStart(attempt);
  }

  /**
   * Libère la garde — **uniquement sur une issue certaine**.
   *
   * Appelée là où le serveur a rendu un verdict : création aboutie, ou création
   * refusée. Jamais sur un `202`, jamais sur une issue inconnue, jamais parce
   * qu'un appel s'est terminé.
   */
  function resolveStartAttempt() {
    state.startInFlight = false;
  }

  /**
   * Refus **antérieur à toute réclamation d'opération**.
   *
   * Une réponse HTTP d'erreur ne prouve rien par elle-même : le serveur rend un
   * reçu terminal `FAILED` — donc postérieur au claim, et parfois postérieur à
   * l'allocation d'un run — sous un statut d'erreur lui aussi. Un tel reçu porte
   * alors `operation_id` dans le corps, et l'`ApiError` le transporte.
   *
   * ```text
   * operation_id ABSENT   aucune opération n'a été réclamée
   * operation_id PRÉSENT  une opération existe, et un run peut exister
   * ```
   *
   * La liste est close et tirée des seuls refus que `POST /api/runs` émet avant
   * `store.claim` : type de contenu, corps, clé d'idempotence, et les refus de
   * transport tranchés avant même d'entrer dans le gestionnaire. Tout le reste
   * — `INTERNAL_ERROR` en tête, qui est le repli de tout ce que personne n'a
   * énuméré — reste d'origine indécidable.
   */
  const PRE_CREATION_REFUSALS = new Set([
    'UNSUPPORTED_MEDIA_TYPE',
    'INVALID_ARGUMENT',
    'UNAUTHENTICATED',
    'INVALID_HOST',
    'METHOD_NOT_ALLOWED',
    'NOT_FOUND',
  ]);

  function preCreationRefusal(error) {
    return error instanceof ApiError
      && typeof error.operationId !== 'string'
      && PRE_CREATION_REFUSALS.has(error.code);
  }

  async function sendStart(attempt) {
    try {
      const receipt = await api.createRun(attempt.payload, attempt.key);
      state.start = { ...attempt, operationId: receipt.operation_id, createdRunId: receipt.created_run_id };
      if (receipt.status === 'SUCCEEDED') {
        await openCreatedRun(receipt.created_run_id);
        resolveStartAttempt();
        return;
      }
      // Un `UNKNOWN` rendu dès l'accusé décrit une exécution qui a cessé sans
      // pouvoir être représentée. L'afficher comme « en cours » laisserait
      // l'humain attendre un verdict qui ne viendra jamais.
      if (receipt.status === 'UNKNOWN') {
        view.showStartUndetermined(receipt);
        return;
      }
      view.showStartPending(receipt);
      // Onze minutes et demie sans savoir : c'est ce que le run réel a coûté.
      beginFollowUp('start', receipt.operation_id);
    } catch (error) {
      if (isAbort(error)) return;
      const described = describe(error);
      if (described.code === 'UNAUTHENTICATED') {
        view.showSessionExpired(described.message);
        return;
      }
      let createdRunId;
      let settledStatus;
      if (error instanceof ApiError && typeof error.operationId === 'string') {
        state.start = { ...attempt, operationId: error.operationId };
        // Un échec peut être postérieur à l'allocation : le reçu, lui, sait.
        try {
          const receipt = await api.getOperation(error.operationId);
          createdRunId = receipt.created_run_id;
          settledStatus = receipt.status;
          state.start = { ...state.start, createdRunId };
        } catch {
          createdRunId = undefined;
        }
      }
      // Trois façons — et trois seulement — d'établir qu'une tentative ne peut
      // plus rien matérialiser :
      //
      //   un run est connu        la création a eu lieu, et il est inspectable
      //   le reçu est terminal    le serveur a tranché, lu sur le reçu lui-même
      //   refus pré-création      aucune opération n'a même été réclamée
      //
      // Le statut HTTP n'en fait pas partie : il ne dit pas à quel moment la
      // réponse a été produite.
      const resolved = typeof createdRunId === 'string'
        || settledStatus === 'FAILED'
        || preCreationRefusal(error);
      if (resolved) resolveStartAttempt();
      view.showStartFailed({ ...described, attempt_resolved: resolved }, createdRunId);
    }
  }

  /**
   * Applique un reçu de création, et dit si la création est **terminée**.
   *
   * `showStartPending` reste le cas non terminal : c'est lui qui porte la durée
   * écoulée, et c'est lui que le suivi repeint pendant les onze minutes d'une
   * initialisation réelle.
   */
  async function applyStartReceipt(receipt) {
    const attempt = state.start;
    if (attempt === null || attempt.operationId !== receipt.operation_id) return true;
    state.start = { ...attempt, createdRunId: receipt.created_run_id };
    if (receipt.status === 'SUCCEEDED') {
      await openCreatedRun(receipt.created_run_id);
      resolveStartAttempt();
      return true;
    }
    if (receipt.status === 'FAILED') {
      const code = typeof receipt.error_code === 'string' ? receipt.error_code : 'INTERNAL_ERROR';
      // Verdict du serveur : la tentative est résolue, quelle qu'ait été son
      // issue. C'est le seul cas d'échec qui rend la main.
      resolveStartAttempt();
      view.showStartFailed(
        { code, message: label.error(code), retryable: false, attempt_resolved: true },
        receipt.created_run_id,
      );
      return true;
    }
    // `RUNNING` et `UNKNOWN` partagent leur rendu depuis toujours ; seul le
    // premier vaut la peine d'être suivi, le second ne redeviendra pas connu.
    view.showStartUndetermined(receipt);
    return receipt.status === 'UNKNOWN';
  }

  /** Consulte le reçu de création. Geste explicite, borné. */
  async function checkStart() {
    const attempt = state.start;
    if (attempt === null || typeof attempt.operationId !== 'string') return;
    try {
      const receipt = await api.getOperation(attempt.operationId);
      if (await applyStartReceipt(receipt)) stopFollowUp();
      else beginFollowUp('start', receipt.operation_id);
    } catch (error) {
      handleFailure(error, (described) => view.showStartFailed(described, attempt.createdRunId));
    }
  }

  // ------------------------------------------------------------------------
  // Reprise
  // ------------------------------------------------------------------------

  /** Recharge la seule vue de reprise, sans toucher au reste de l'écran. */
  async function reloadRecovery() {
    const runId = state.selectedRunId;
    if (typeof runId !== 'string' || runId.length === 0) return;
    try {
      const recovery = await api.getRecovery(runId);
      state.recoveryView = recovery;
      view.showRecovery(recovery);
    } catch (error) {
      if (isAbort(error)) return;
      handleFailure(error, (described) => view.showRecoveryError(described));
    }
  }

  /**
   * Déclenche une reprise.
   *
   * La capacité est cherchée dans la vue reçue, et son autorisation vérifiée
   * là — jamais déduite d'un état affiché. Le corps est construit à partir de
   * l'`invocation` que le cœur a jointe : `expected_revision` pour une reprise
   * canonique, `observed_lock_token` pour la levée. Le navigateur n'invente
   * aucune des deux.
   */
  async function recover(capabilityId, options = {}) {
    const recovery = state.recoveryView;
    const runId = state.selectedRunId;
    if (recovery === null || typeof runId !== 'string' || runId.length === 0) return;

    // Reprise **native** : le geste est nomme par l'humain — domaine et action
    // — et rien n'est choisi a sa place, pas meme lorsqu'une seule action est
    // disponible.
    if (state.native) {
      await recoverNative(capabilityId, options);
      return;
    }

    const capability = recovery.capabilities.find((entry) => entry.id === capabilityId);
    if (capability === undefined || capability.allowed !== true) return;

    const invocation = capability.invocation ?? {};
    let payload;
    if (invocation.primitive === 'clearStaleRunLock') {
      const token = invocation.observed_lock_token;
      if (typeof token !== 'string' || token.length === 0) return;
      payload = { observed_lock_token: token };
    } else {
      payload = { expected_revision: recovery.revision };
      if (capability.requires_acknowledgement_text === true) {
        const note = typeof options.acknowledgementText === 'string' ? options.acknowledgementText.trim() : '';
        if (note.length === 0) {
          view.showRecoveryActionError(capabilityId, {
            code: 'INVALID_ARGUMENT',
            message: label.error('INVALID_ARGUMENT'),
            retryable: false,
          });
          return;
        }
        payload.acknowledgement_text = note;
      }
    }

    // `primitive` vient de l'invocation reçue : une chaîne du serveur, pas un
    // booléen calculé ici. Elle dit ce qu'il faudra recharger après succès.
    const attempt = {
      capabilityId,
      runId,
      key: newIdempotencyKey(),
      payload,
      primitive: invocation.primitive,
    };
    state.recoveryAttempt = attempt;
    await sendRecovery(attempt);
  }

  /**
   * Reprise **native** : `domaine x geste`, nommes par l'humain.
   *
   * `capabilityId` porte ici la paire choisie, jamais une capacite V1. Aucune
   * action n'est selectionnee automatiquement : un identifiant absent des
   * gestes disponibles n'est pas remplace par un autre, et l'appel n'a lieu
   * que sur un clic.
   *
   * ## Fidelite de la note
   *
   * Le `trim` **valide**, il ne transforme pas. La chaine envoyee est celle que
   * l'humain a saisie — espaces de bordure et Unicode compris. Rogner ici
   * annulerait, depuis le navigateur, la fidelite de provenance que les moteurs
   * garantissent desormais.
   */
  async function recoverNative(pair, options = {}) {
    const recovery = state.recoveryView;
    const runId = state.selectedRunId;
    if (recovery === null || typeof runId !== 'string' || runId.length === 0) return;
    if (pair === null || typeof pair !== 'object') return;

    const domain = pair.domain;
    const action = pair.action;
    const domainView = recovery.recovery === undefined ? undefined : recovery.recovery[domain];
    if (domainView === undefined) return;
    const chosen = (domainView.available_actions ?? []).find((entry) => entry.action === action);
    if (chosen === undefined) return;

    const payload = { expected_revision: recovery.revision, domain, action };
    if (chosen.requires_note === true) {
      const original = typeof options.acknowledgementText === 'string' ? options.acknowledgementText : '';
      if (original.trim().length === 0) {
        view.showRecoveryActionError(action, {
          code: 'INVALID_ARGUMENT',
          message: label.error('INVALID_ARGUMENT'),
          retryable: false,
        });
        return;
      }
      // La chaine ORIGINALE, jamais `original.trim()`.
      payload.note = original;
    }

    const attempt = {
      capabilityId: action,
      runId,
      key: newIdempotencyKey(),
      payload,
      primitive: 'nativeRecovery',
      native: true,
    };
    state.recoveryAttempt = attempt;
    await sendRecovery(attempt);
  }

  async function sendRecovery(attempt) {
    view.showRecoveryPending(attempt.capabilityId);
    try {
      const receipt = attempt.native === true
        ? await api.recoverNative(attempt.runId, attempt.payload, attempt.key)
        : await api.recover(attempt.capabilityId, attempt.runId, attempt.payload, attempt.key);
      state.recoveryAttempt = { ...attempt, operationId: receipt.operation_id };
      await settleRecoveryOutcome(attempt, receipt);
    } catch (error) {
      if (isAbort(error)) return;
      const described = describe(error);
      if (described.code === 'UNAUTHENTICATED') {
        view.showSessionExpired(described.message);
        return;
      }
      if (error instanceof ApiError && typeof error.operationId === 'string') {
        state.recoveryAttempt = { ...attempt, operationId: error.operationId };
      }
      // Une vue périmée ou une capacité qui ne l'est plus se rechargent, mais
      // rien n'est réémis : la décision de recommencer appartient à l'humain.
      await reloadRecovery();
      view.showRecoveryActionError(attempt.capabilityId, described);
    }
  }

  async function settleRecoveryOutcome(attempt, receipt) {
    if (receipt.status !== 'SUCCEEDED') {
      // `RUNNING` ou `UNKNOWN` : aucune conclusion, aucun rejeu, aucune
      // nouvelle clé. La vue le dit, et s'arrête là.
      view.showRecoveryUndetermined(attempt.capabilityId, receipt);
      return;
    }
    if (attempt.primitive === 'nativeRecovery') {
      await loadRun(attempt.runId);
      await refreshRuns();
    } else if (attempt.primitive === 'clearStaleRunLock') {
      // La levée ne touche aucun fait canonique : seule la vue de reprise a
      // changé, et recharger le reste laisserait croire le contraire.
      await reloadRecovery();
    } else {
      await loadRun(attempt.runId);
      await refreshRuns();
    }
    view.showRecoverySucceeded(attempt.capabilityId);
  }

  /** Consulte le reçu d'une reprise indéterminée. Aucun envoi, aucun effet. */
  async function checkRecovery() {
    const attempt = state.recoveryAttempt;
    if (attempt === null || typeof attempt.operationId !== 'string') return;
    try {
      const receipt = await api.getOperation(attempt.operationId);
      await settleRecoveryOutcome(attempt, receipt);
    } catch (error) {
      if (isAbort(error)) return;
      view.showRecoveryActionError(attempt.capabilityId, describe(error));
    }
  }

  // ------------------------------------------------------------------------
  // Invalidation externe
  // ------------------------------------------------------------------------

  /**
   * Ouvre les flux d'invalidation.
   *
   * Le message reçu n'est jamais interprété comme une donnée : il ne contient
   * qu'une ressource et un instant. Le navigateur ne fait qu'une chose en le
   * recevant — relire le read model canonique correspondant. Aucune écriture
   * locale, aucune fusion, aucune supposition sur ce qui a changé.
   *
   * Une invalidation surnuméraire est sans danger : le refetch est idempotent.
   * C'est pourquoi rien n'essaie de dédupliquer avec le flux des mutations du
   * cockpit lui-même.
   */
  function connectStreams() {
    if (typeof deps.openStream !== 'function') return;
    closeStreams();
    state.listStream = deps.openStream(api.listStreamUrl(), () => scheduleRefresh('list'));
  }

  function closeStreams() {
    if (state.listStream !== null) {
      state.listStream.close();
      state.listStream = null;
    }
    closeRunStream();
  }

  function closeRunStream() {
    if (state.runStream !== null) {
      state.runStream.close();
      state.runStream = null;
    }
  }

  /** Suit le run affiché : un seul flux de run à la fois. */
  function followRun(runId) {
    if (typeof deps.openStream !== 'function') return;
    closeRunStream();
    if (typeof runId !== 'string' || runId.length === 0) return;
    state.runStream = deps.openStream(api.runStreamUrl(runId), (message) => {
      // La seule information exploitée est l'identité de la ressource — et
      // encore, uniquement pour ignorer ce qui ne concerne pas l'écran.
      if (message !== null && typeof message === 'object' && typeof message.run_id === 'string') {
        if (message.run_id !== state.selectedRunId) return;
      }
      scheduleRefresh('run');
    });
  }

  /**
   * Coalescence légère.
   *
   * Plusieurs indices rapprochés pour la même ressource ne doivent pas
   * déclencher plusieurs séries de `GET`. Une minuterie courte suffit : ce
   * n'est ni une file durable, ni un ordonnanceur — perdre une invalidation
   * n'a d'autre effet qu'un rafraîchissement retardé.
   */
  function scheduleRefresh(kind) {
    if (state.pendingRefresh[kind] === true) return;
    state.pendingRefresh[kind] = true;
    deps.scheduleCoalesced(() => {
      state.pendingRefresh[kind] = false;
      if (kind === 'list') {
        void refreshRuns({ silent: true });
        return;
      }
      const runId = state.selectedRunId;
      if (typeof runId === 'string' && runId.length > 0) void loadRun(runId, { silent: true });
    });
  }

  async function openCreatedRun(runId) {
    if (typeof runId !== 'string' || runId.length === 0) return;
    await refreshRuns();
    await loadRun(runId);
    view.showStartSucceeded(runId);
  }

  return {
    connectStreams,
    closeStreams,
    mutate,
    recordControversy,
    registerMaterial,
    adduceMaterial,
    reconcile,
    recover,
    recoverNative,
    checkRecovery,
    reloadRecovery,
    createRun,
    checkStart,
    openRun: openCreatedRun,
    retryMutation,
    checkOperation,
    state,
    refreshRuns,
    selectRun: loadRun,
    refreshRun,
    loadMoreTimeline,
    reloadTimeline,
    refreshDoctor,
    refreshConfig,
  };
}
