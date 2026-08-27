/**
 * Reprise d'un envoi humain natif interrompu (Slice 2B-R).
 *
 * L'ordre durable réparé en 2B a été conçu pour rendre ces fenêtres lisibles.
 * Ce module les lit, et rien de plus :
 *
 * ```text
 * message durable, aucun contexte engagé   le fournisseur n'a jamais été appelé
 * contexte engagé, sans réponse            l'issue est inconnue
 * réponse durable, non commitée            le fournisseur a répondu
 * échec terminal durable, non commité      le tour est conclu, l'état est en retard
 * marqueur durable, non commité            la reprise elle-même a été interrompue
 * faits contradictoires                    échec fermé
 * ```
 *
 * ## La reprise est elle-même interruptible
 *
 * Aucune transaction ne couvre `events.jsonl` **et** `state.json` : la preuve
 * durable est donc écrite en premier, et la sécurité vient du classifieur. Un
 * marqueur de clôture que l'état ne reflète pas encore n'est jamais `NONE` — ce
 * serait perdre la frontière humaine, et laisser un contexte engagé qu'un
 * second acquittement dupliquerait.
 *
 * ## La distinction qui porte tout
 *
 * `pending_operation` est persisté **avant** `adapter.resume` (2B, étape 5), et
 * `human_message` est écrit avant lui (réparation 2B.1). Un message durable sans
 * contexte engagé prouve donc qu'aucun appel n'a été lancé pour cet envoi — et
 * c'est exactement ce qui sépare un abandon avant appel d'une incertitude.
 *
 * ## Aucun rejeu, jamais
 *
 * Aucun fournisseur n'est appelé ici : ce module n'a **aucune** dépendance
 * d'adapter, et ne peut donc pas en résoudre un même par erreur. Il n'existe ni
 * `continueNativeSend`, ni `retryNativeSend`, ni `resumeNativeSend`.
 *
 * Si un humain veut réessayer, il appelle plus tard `sendNativeMessage` : cela
 * crée un **nouveau** `human_message`, avec un nouvel identifiant. Le même texte
 * n'est pas la même tentative.
 *
 * ## Ce que la reprise ne touche pas
 *
 * `next_step_source_slot` et `state.round` restent inchangés dans tous les
 * chemins : un envoi n'a jamais été un transfert, et son échec ne le devient
 * pas. Aucun `round_started`, aucun `round_completed`, aucun artefact `rounds/`
 * — ce module n'importe même pas le store de rounds.
 */

import { CcrError } from '../core/errors.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import type {
  NativeCcrEvent,
  NativeRunManifest,
  NativeRunStateDocument,
  NativeSlotOperation,
} from '../core/run-native.ts';
import { SEND_RESOLUTION_EVENT_TYPES } from '../core/run-native.ts';
import { isTransitionAllowed } from '../core/state.ts';
import type { RunState } from '../core/state.ts';
import { assessLiveness, clearStaleLock, readRunLock } from '../lock/run-lock.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import type { RunLockInfo } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import type { RunPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import type { NativeEventStore } from '../store/native-event-store.ts';
import { persistNativeStateUpdate, readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import { buildNativeInitializationView } from './native-recovery-service.ts';

// --------------------------------------------------------------------------
// Dépendances — volontairement sans fournisseur
// --------------------------------------------------------------------------

/**
 * Ce dont la reprise a besoin, et rien d'autre.
 *
 * Aucun `createAdapters` : la garantie « aucun appel fournisseur » n'est pas une
 * discipline de relecture, c'est l'absence du moyen de le faire.
 */
export interface NativeSendRecoveryDeps {
  readonly runsDir: string;
  now(): Date;
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

export type NativeSendRecoveryStatus =
  | 'NONE'
  | 'PRE_PROVIDER_ABORTED'
  | 'IN_FLIGHT_UNCERTAIN'
  | 'RESPONSE_NEEDS_FINALIZATION'
  /**
   * Fenêtre **non énumérée par le gate**, et pourtant produite par 2B : son
   * chemin d'échec journalise `process_failed` avant de libérer le contexte.
   * Tué entre les deux, le run porte un échec terminal *et* un contexte engagé.
   *
   * Ce n'est pas une incertitude — l'issue est connue et journalisée — et ce
   * n'est pas `NONE` : le contexte engagé bloquerait tout envoi ultérieur. La
   * nommer était la seule option honnête.
   */
  | 'FAILURE_NEEDS_FINALIZATION'
  /**
   * Marqueur de clôture durable, commit d'état perdu.
   *
   * Le journal est append-only et le store n'offre aucune transaction couvrant
   * `events.jsonl` **et** `state.json` : la preuve durable est donc écrite en
   * premier, et la sécurité vient d'ici — d'un classifieur capable de voir un
   * marqueur que l'état ne reflète pas encore.
   *
   * ```text
   * marqueur durable  →  l'issue fournisseur est close pour CCR
   *                   →  0 appel, jamais de rejeu
   *                   →  l'état local peut rester à commiter
   * ```
   *
   * Répondre `NONE` ici perdait la frontière humaine — et, pour un
   * acquittement, laissait un contexte engagé qu'un second acquittement aurait
   * dupliqué.
   */
  | 'RESOLUTION_NEEDS_COMMIT'
  | 'EVIDENCE_CONFLICT';

export interface NativeSendRecoveryView {
  readonly runId: string;
  readonly status: NativeSendRecoveryStatus;
  readonly targetSlot?: ExpertSlotId;
  readonly promptEventId?: string;
  readonly responseEventId?: string;
  readonly failureEventId?: string;
  readonly round?: number;
  readonly canFinalizeWithoutProvider: boolean;
  readonly requiresHumanAcknowledgement: boolean;
  /**
   * Envois humains ne portant **aucune** issue journalisée : ni réponse, ni
   * échec terminal, ni marqueur de clôture.
   *
   * Ils peuvent être plusieurs. Après un crash en fenêtre S0, le run reste
   * parfaitement envoyable — les gardes ne voient ni contexte engagé, ni état
   * suspect — et un second envoi crée donc un second message orphelin. Les
   * masquer derrière « le dernier » ferait disparaître les précédents ; la
   * reprise les épuise un par un.
   */
  readonly orphanPromptEventIds: readonly string[];
  /** Marqueur de clôture dont le commit d'état reste à poser. */
  readonly resolutionEventId?: string;
  readonly conflicts: readonly string[];
}

function field(event: NativeCcrEvent, name: string): unknown {
  return (event as unknown as Record<string, unknown>)[name];
}

function slotField(event: NativeCcrEvent, name: string): ExpertSlotId | null {
  const value = field(event, name);
  return value === 'author' || value === 'challenger' ? value : null;
}

function sendPendingOf(state: NativeRunStateDocument): NativeSlotOperation | null {
  const pending = state.pending_operation;
  return pending !== null && pending.kind === 'send' ? pending : null;
}

/** Réponses dérivant explicitement de ce message. Jamais « par proximité ». */
function responsesTo(events: readonly NativeCcrEvent[], promptEventId: string): readonly NativeCcrEvent[] {
  return events.filter(
    (event) => event.type === 'assistant_response' && (event.based_on ?? []).includes(promptEventId),
  );
}

/**
 * Échecs terminaux de cette tentative.
 *
 * La causalité est **portée par le journal** : `send` écrit son `process_failed`
 * avec `based_on = [human_message]` (2B, chemin d'échec). Aucune heuristique de
 * proximité temporelle n'est employée — deux envois successifs au même expert
 * seraient indiscernables.
 */
function failuresTo(events: readonly NativeCcrEvent[], promptEventId: string): readonly NativeCcrEvent[] {
  return events.filter(
    (event) => event.type === 'process_failed' && (event.based_on ?? []).includes(promptEventId),
  );
}

/** Marqueurs de clôture désignant ce message. */
function resolutionsFor(events: readonly NativeCcrEvent[], promptEventId: string): readonly NativeCcrEvent[] {
  return events.filter(
    (event) =>
      (SEND_RESOLUTION_EVENT_TYPES as readonly string[]).includes(event.type) &&
      field(event, 'prompt_event_id') === promptEventId,
  );
}

/**
 * Marqueur de clôture durable dont le commit d'état manque encore.
 *
 * Deux résidus, et deux seulement, parce qu'ils sont les seuls que l'ordre
 * d'écriture puisse produire :
 *
 * ```text
 * contexte engagé désignant un envoi DÉJÀ clos
 *   → le commit de l'acquittement n'a pas eu lieu
 *
 * marqueur en toute fin de journal que `last_event_id` ne reflète pas
 *   → le commit de la clôture n'a pas eu lieu
 * ```
 *
 * La seconde condition exige que **rien** ne suive le marqueur : un run qui a
 * repris son cours depuis produit forcément des événements, et le forcer alors
 * sous contrôle humain serait une intrusion rétroactive. C'est une limite
 * assumée, non un oubli : après une clôture `S0` non commitée, le run reste
 * envoyable, et un nouvel envoi est lui-même un acte de contrôle humain.
 */
function resolutionAwaitingCommit(
  state: NativeRunStateDocument,
  events: readonly NativeCcrEvent[],
  pending: NativeSlotOperation | null,
): NativeCcrEvent | undefined {
  if (pending !== null && pending.prompt_event_id !== null) {
    const stale = resolutionsFor(events, pending.prompt_event_id)[0];
    if (stale !== undefined) return stale;
  }
  const last = events[events.length - 1];
  if (
    last !== undefined &&
    (SEND_RESOLUTION_EVENT_TYPES as readonly string[]).includes(last.type) &&
    state.last_event_id !== last.event_id
  ) {
    return last;
  }
  return undefined;
}

/**
 * Contradictions que l'ordre durable de 2B rend impossibles.
 *
 * Les « réparer » reviendrait à choisir laquelle de deux affirmations est vraie.
 */
function collectConflicts(
  manifest: NativeRunManifest,
  events: readonly NativeCcrEvent[],
  humanMessages: readonly NativeCcrEvent[],
  pending: NativeSlotOperation | null,
  subject: NativeCcrEvent | undefined,
  conflicts: string[],
): void {
  // ---- Contradictions lisibles sans le moindre contexte engagé.
  for (const message of humanMessages) {
    const responses = responsesTo(events, message.event_id);
    if (responses.length > 1) {
      conflicts.push(
        `L'envoi ${message.event_id} porte ${String(responses.length)} réponses : une tentative n'en a qu'une.`,
      );
    }
    if (responses.length > 0 && failuresTo(events, message.event_id).length > 0) {
      conflicts.push(
        `L'envoi ${message.event_id} porte à la fois une réponse et un échec terminal pour la même tentative.`,
      );
    }
  }

  if (pending === null) return;

  // ---- Contradictions entre le contexte engagé et les faits journalisés.
  if (subject === undefined) {
    conflicts.push(
      `Le contexte d'envoi désigne le message « ${String(pending.prompt_event_id)} », introuvable dans le journal.`,
    );
    return;
  }

  const targeted = slotField(subject, 'target_expert_slot_id');
  if (targeted !== pending.expert_slot) {
    conflicts.push(
      `Le contexte d'envoi vise « ${pending.expert_slot} » alors que le message ${subject.event_id} ` +
        `s'adresse à « ${String(targeted)} ».`,
    );
  }

  const response = responsesTo(events, subject.event_id)[0];
  if (response === undefined) return;

  const slot = slotField(response, 'expert_slot_id');
  if (slot !== pending.expert_slot) {
    conflicts.push(
      `La réponse ${response.event_id} appartient à « ${String(slot)} » alors que l'envoi vise ` +
        `« ${pending.expert_slot} ».`,
    );
    return;
  }
  const session = field(response, 'session_id');
  if (session !== pending.session_id) {
    conflicts.push(
      `La réponse ${response.event_id} porte la session « ${String(session)} », ` +
        `alors que « ${String(pending.session_id)} » était reprise.`,
    );
  } else if (session !== manifest.experts[pending.expert_slot].session_id) {
    conflicts.push(
      `La réponse ${response.event_id} porte la session « ${String(session)} », ` +
        `qui n'est pas celle liée à « ${pending.expert_slot} ».`,
    );
  }
}

/**
 * Établit ce que le disque affirme d'un envoi.
 *
 * Pure et synchrone : aucun fichier n'est lu ici, et `rounds/` n'est consulté
 * dans aucun chemin — un artefact diagnostique n'a jamais eu voix au chapitre
 * sur un envoi, qui n'en produit pas.
 */
export function buildNativeSendRecoveryView(
  runId: string,
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  events: readonly NativeCcrEvent[],
): NativeSendRecoveryView {
  const pending = sendPendingOf(state);
  const humanMessages = events.filter((event) => event.type === 'human_message');
  const orphans = humanMessages.filter(
    (message) =>
      responsesTo(events, message.event_id).length === 0 &&
      failuresTo(events, message.event_id).length === 0 &&
      resolutionsFor(events, message.event_id).length === 0,
  );

  // Le sujet est l'envoi engagé s'il y en a un ; sinon le plus ancien orphelin.
  const subject =
    pending === null
      ? orphans[0]
      : humanMessages.find((message) => message.event_id === pending.prompt_event_id);

  const conflicts: string[] = [];
  collectConflicts(manifest, events, humanMessages, pending, subject, conflicts);

  const orphanPromptEventIds = orphans.map((message) => message.event_id);
  const response = subject === undefined ? undefined : responsesTo(events, subject.event_id)[0];
  const failure = subject === undefined ? undefined : failuresTo(events, subject.event_id)[0];

  const base = {
    runId,
    orphanPromptEventIds,
    conflicts,
    ...(subject === undefined
      ? pending === null || pending.prompt_event_id === null
        ? {}
        : { promptEventId: pending.prompt_event_id }
      : {
          promptEventId: subject.event_id,
          round: subject.round,
          ...(slotField(subject, 'target_expert_slot_id') === null
            ? {}
            : { targetSlot: slotField(subject, 'target_expert_slot_id') as ExpertSlotId }),
        }),
    ...(response === undefined ? {} : { responseEventId: response.event_id }),
    ...(failure === undefined ? {} : { failureEventId: failure.event_id }),
  };

  if (conflicts.length > 0) {
    return {
      ...base,
      status: 'EVIDENCE_CONFLICT',
      canFinalizeWithoutProvider: false,
      requiresHumanAcknowledgement: false,
    };
  }

  // Un marqueur durable clôt l'issue fournisseur **définitivement**, et cela
  // prime sur tout le reste : un contexte encore engagé n'est plus une
  // incertitude à acquitter, c'est le résidu d'une reprise interrompue.
  const uncommitted = resolutionAwaitingCommit(state, events, pending);
  if (uncommitted !== undefined) {
    const closedPrompt = field(uncommitted, 'prompt_event_id');
    return {
      ...base,
      status: 'RESOLUTION_NEEDS_COMMIT',
      resolutionEventId: uncommitted.event_id,
      round: uncommitted.round,
      ...(typeof closedPrompt === 'string' ? { promptEventId: closedPrompt } : {}),
      ...(slotField(uncommitted, 'target_expert_slot_id') === null
        ? {}
        : { targetSlot: slotField(uncommitted, 'target_expert_slot_id') as ExpertSlotId }),
      canFinalizeWithoutProvider: true,
      requiresHumanAcknowledgement: false,
    };
  }

  if (pending !== null) {
    if (response !== undefined) {
      return {
        ...base,
        status: 'RESPONSE_NEEDS_FINALIZATION',
        canFinalizeWithoutProvider: true,
        requiresHumanAcknowledgement: false,
      };
    }
    if (failure !== undefined) {
      // L'issue est connue : le fournisseur a échoué, et CCR l'a journalisé.
      // Ce n'est donc jamais une incertitude.
      return {
        ...base,
        status: 'FAILURE_NEEDS_FINALIZATION',
        canFinalizeWithoutProvider: true,
        requiresHumanAcknowledgement: false,
      };
    }
    return {
      ...base,
      status: 'IN_FLIGHT_UNCERTAIN',
      canFinalizeWithoutProvider: false,
      requiresHumanAcknowledgement: true,
    };
  }

  // Aucun contexte engagé. L'ordre durable de 2B prouve qu'aucun appel n'a été
  // lancé pour un message resté sans issue.
  return {
    ...base,
    status: subject === undefined ? 'NONE' : 'PRE_PROVIDER_ABORTED',
    canFinalizeWithoutProvider: false,
    requiresHumanAcknowledgement: false,
  };
}

// --------------------------------------------------------------------------
// Chargement
// --------------------------------------------------------------------------

interface LoadedNativeRun {
  readonly paths: RunPaths;
  readonly manifest: NativeRunManifest;
  readonly state: NativeRunStateDocument;
  readonly events: NativeEventStore;
  readonly history: readonly NativeCcrEvent[];
}

async function loadNativeRun(deps: NativeSendRecoveryDeps, runId: string): Promise<LoadedNativeRun> {
  const paths = runPaths(deps.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Le run ${runId} est de génération ${persisted.execution_mode} : la reprise d'envoi native ne le ` +
        'traite pas, et ne le convertit pas.',
      { details: { runId, execution_mode: persisted.execution_mode } },
    );
  }
  const stateDoc = await readPersistedState(paths);
  if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
      details: { runId },
    });
  }
  const events = await openNativeEventStore(paths, persisted.manifest);
  return {
    paths,
    manifest: persisted.manifest,
    state: stateDoc.document,
    events,
    history: await events.readAll(),
  };
}

// --------------------------------------------------------------------------
// Inspection
// --------------------------------------------------------------------------

/** Établit ce que le disque affirme. N'écrit rien, ne verrouille rien. */
export async function inspectNativeSendRecovery(
  deps: NativeSendRecoveryDeps,
  runId: string,
): Promise<NativeSendRecoveryView> {
  const loaded = await loadNativeRun(deps, runId);
  return buildNativeSendRecoveryView(runId, loaded.manifest, loaded.state, loaded.history);
}

// --------------------------------------------------------------------------
// Verrou
// --------------------------------------------------------------------------

export interface NativeSendRecoveryOutcome {
  readonly runId: string;
  readonly view: NativeSendRecoveryView;
  readonly state: NativeRunStateDocument;
  readonly actions: readonly string[];
  readonly staleLock?: RunLockInfo;
}

/**
 * Point d'observation de la frontière durable d'une reprise.
 *
 * Il rend interruptible l'instant exact où le marqueur est écrit et l'état ne
 * l'est pas encore — la fenêtre que le classifieur doit savoir lire. Il
 * observe, il ne décide de rien : aucune branche n'en dépend.
 */
export interface NativeSendRecoverySeams {
  /** Après le marqueur de clôture, avant le commit d'état. */
  readonly afterResolutionJournaled?: () => void | Promise<void>;
}

/**
 * Verrou de run, précédé du nettoyage d'un verrou périmé.
 *
 * Volontairement local : une reprise d'envoi n'emprunte rien à une reprise de
 * transfert, et en dépendre créerait un couplage entre deux gates fermés.
 */
async function withNativeRunLock<T>(
  deps: NativeSendRecoveryDeps,
  runId: string,
  command: string,
  boundary: NativeMutationBoundary | undefined,
  body: (staleLock: RunLockInfo | undefined, actions: string[]) => Promise<T>,
): Promise<T> {
  const paths = runPaths(deps.runsDir, runId);
  const actions: string[] = [];

  let staleLock: RunLockInfo | undefined;
  const existing = await readRunLock(paths);
  if (existing !== undefined && assessLiveness(existing) === 'STALE') {
    staleLock = await clearStaleLock(paths);
    actions.push(`Verrou périmé supprimé (pid ${String(existing.pid)}, posé le ${existing.started_at}).`);
  }

  return withNativeMutation(
    { runsDir: deps.runsDir, runId, command, ...(boundary === undefined ? {} : { boundary }) },
    () => body(staleLock, actions),
  );
}

function requiredFacts(view: NativeSendRecoveryView, runId: string): {
  promptEventId: string;
  targetSlot: ExpertSlotId;
  round: number;
} {
  const { promptEventId, targetSlot, round } = view;
  if (promptEventId === undefined || targetSlot === undefined || round === undefined) {
    throw new CcrError('STATE_INVALID', `Faits d'envoi incomplets pour le run ${runId}.`, {
      details: { runId, status: view.status },
    });
  }
  return { promptEventId, targetSlot, round };
}

/**
 * État humain sûr, tel que l'état **courant** permet de l'établir.
 *
 * Ne conserve un signalement que s'il est encore lisible dans `state.json`. Ce
 * n'est pas suffisant seul : au moment d'un crash, l'état visible peut être
 * l'état transitoire de l'envoi.
 */
function safeHumanState(current: RunState): RunState {
  return current === 'PAUSED' || current === 'WAITING_HUMAN' || current === 'FAILED_INITIALIZATION'
    ? current
    : 'PAUSED';
}

/**
 * État où la reprise d'un envoi rend le run.
 *
 * `safeHumanState` seul ne suffit pas, et le micro-gate final l'a démontré : en
 * fenêtre `S0b` l'état visible est `RUNNING`, l'état d'origine n'existe plus
 * nulle part, et la clôture rendait donc `PAUSED` — effaçant le fait qu'un run
 * partiellement initialisé l'était toujours.
 *
 * L'origine n'est pas reconstruite par intuition : elle ne peut pas l'être. Ce
 * sont les **faits canoniques persistés** qui sont interrogés, par la
 * classification d'initialisation native de 1D — manifest, `session_created` et
 * réponses initiales durables.
 *
 * ```text
 * initialisation native toujours incomplète  →  FAILED_INITIALIZATION
 * sinon                                      →  politique humaine sûre
 * ```
 *
 * Deux précisions honnêtes :
 *
 * - seuls `missingSlots` et `reconcilableSlots` sont consultés, jamais le
 *   `status` global. Ce dernier compte **toute** `assistant_response` d'un slot
 *   comme une réponse initiale : après le moindre envoi, il rapporte un
 *   `EVIDENCE_CONFLICT` qui ne dit rien de l'initialisation. Les deux listes,
 *   elles, restent exactes — un slot sans session ni réponse adoptable le reste,
 *   quel que soit le nombre d'envois reçus par l'autre ;
 * - la transition est vérifiée plutôt que forcée. Un run déjà rendu `READY`
 *   n'est pas ramené de force en `FAILED_INITIALIZATION` : la reprise d'un
 *   envoi n'a pas à requalifier un état qu'elle n'a pas produit. Elle doit
 *   seulement ne rien effacer.
 */
export function safeNativeSendRecoveryState(
  runId: string,
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  events: readonly NativeCcrEvent[],
): RunState {
  const initialization = buildNativeInitializationView(runId, manifest, state, events);
  const incomplete =
    initialization.missingSlots.length > 0 || initialization.reconcilableSlots.length > 0;
  return incomplete && isTransitionAllowed(state.state, 'FAILED_INITIALIZATION')
    ? 'FAILED_INITIALIZATION'
    : safeHumanState(state.state);
}

// --------------------------------------------------------------------------
// Clôture d'un envoi abandonné avant tout appel
// --------------------------------------------------------------------------

/**
 * Clôt durablement un envoi dont l'ordre 2B prouve qu'aucun appel n'a été
 * engagé.
 *
 * Remettre simplement le run en état ne suffirait pas : au prochain diagnostic,
 * le même `human_message` paraîtrait encore sans issue, indéfiniment. La clôture
 * est donc un **fait canonique**, portant l'identifiant du message clos.
 *
 * Ce que l'événement ne dit pas : qu'un fournisseur a été appelé, qu'une réponse
 * existe, ou que le message sera renvoyé. Il ne sera **pas** rejoué.
 */
export async function abortNativeSendBeforeProvider(
  deps: NativeSendRecoveryDeps,
  runId: string,
  seams: NativeSendRecoverySeams = {},
  boundary?: NativeMutationBoundary,
): Promise<NativeSendRecoveryOutcome> {
  return withNativeRunLock(deps, runId, 'native-send-abort', boundary, async (staleLock, actions) => {
    // Reclassification **sous le verrou** : c'est elle qui rend une double
    // invocation inoffensive, et non une garde posée par l'appelant.
    const loaded = await loadNativeRun(deps, runId);
    let state = loaded.state;
    const view = buildNativeSendRecoveryView(runId, loaded.manifest, state, loaded.history);

    if (view.status === 'NONE') {
      actions.push("Aucun envoi à clore : rien n'a été écrit.");
      return { runId, view, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
    }
    if (view.status !== 'PRE_PROVIDER_ABORTED') {
      throw new CcrError(
        'INVALID_ARGUMENT',
        `Le run ${runId} n'a aucun envoi abandonné avant appel à clore (statut ${view.status}).`,
        { details: { runId, status: view.status, conflicts: [...view.conflicts] } },
      );
    }

    const facts = requiredFacts(view, runId);
    const event = await loaded.events.append({
      round: facts.round,
      actor: 'system',
      type: 'send_aborted_before_provider',
      target_expert_slot_id: facts.targetSlot,
      prompt_event_id: facts.promptEventId,
      reason: 'PRE_PROVIDER_ABORTED',
      content: "Envoi abandonné : aucun appel fournisseur n'avait été engagé.",
      based_on: [facts.promptEventId],
      details: {
        basis: "Le contexte de reprise n'était pas persisté, or 2B le persiste avant tout appel.",
        provider_calls: 0,
        note: "Cette tentative est close. Un nouvel envoi serait une nouvelle tentative, jamais celle-ci.",
      },
      timestamp: deps.now().toISOString(),
    });

    // La preuve durable existe desormais. Si l'on s'arrete ici, le classifieur
    // le verra : `RESOLUTION_NEEDS_COMMIT`, jamais `NONE`.
    await seams.afterResolutionJournaled?.();

    // Ni round, ni curseur : un envoi n'a jamais été un transfert.
    state = await persistNativeStateUpdate(
      loaded.paths,
      state,
      {
        state: safeNativeSendRecoveryState(runId, loaded.manifest, state, loaded.history),
        control: 'HUMAN',
        activeExpertSlot: null,
        pendingOperation: null,
        lastEventId: event.event_id,
      },
      deps.now(),
    );
    actions.push(
      `Envoi ${facts.promptEventId} vers « ${facts.targetSlot} » clos avant tout appel fournisseur. ` +
        `Run rendu en ${state.state} / HUMAN.`,
    );

    const after = buildNativeSendRecoveryView(runId, loaded.manifest, state, await loaded.events.readAll());
    return { runId, view: after, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
  });
}

// --------------------------------------------------------------------------
// Finalisation locale
// --------------------------------------------------------------------------

/**
 * État d'échec tel que 2B l'aurait persisté, reconstruit depuis le code
 * réellement journalisé — jamais depuis une supposition.
 *
 * Même règle que `operationalFailureState` : une session ayant répondu sous un
 * autre identifiant brise un invariant, tout le reste est un incident.
 */
function stateAfterRecordedFailure(failure: NativeCcrEvent): RunState {
  const code = (failure.details ?? {})['code'];
  return code === 'AGENT_SESSION_MISMATCH' ? 'FAILED' : 'PAUSED';
}

/**
 * Termine un envoi que les faits canoniques établissent déjà.
 *
 * Ne rappelle jamais un fournisseur — c'est structurellement impossible ici — et
 * n'écrit **aucun** événement : la réponse durable est le fait, et la dupliquer
 * n'ajouterait rien qu'une seconde vérité.
 *
 * Le contrôle revient à l'humain, comme en 1D et 1G. `return_control` reste une
 * preuve historique du contexte d'origine, jamais une autorisation à reprendre
 * l'automatisation après un crash.
 */
export async function finalizeNativeSendRecovery(
  deps: NativeSendRecoveryDeps,
  runId: string,
  boundary?: NativeMutationBoundary,
): Promise<NativeSendRecoveryOutcome> {
  return withNativeRunLock(deps, runId, 'native-send-recover', boundary, async (staleLock, actions) => {
    const loaded = await loadNativeRun(deps, runId);
    let state = loaded.state;
    const view = buildNativeSendRecoveryView(runId, loaded.manifest, state, loaded.history);

    if (view.status === 'EVIDENCE_CONFLICT') {
      throw new CcrError(
        'STATE_INVALID',
        `L'envoi du run ${runId} porte des faits contradictoires que l'ordre d'écriture rend impossibles. ` +
          "Aucune réparation n'est tentée : elle reviendrait à choisir entre deux affirmations.",
        { details: { runId, conflicts: [...view.conflicts] } },
      );
    }

    if (view.status === 'IN_FLIGHT_UNCERTAIN') {
      throw new CcrError(
        'RECOVERY_REQUIRED',
        `Un envoi vers « ${String(view.targetSlot)} » a été engagé sans réponse journalisée. CCR ne sait ` +
          "pas si l'appel a eu lieu : acquittez explicitement cette incertitude.",
        { details: { runId, prompt_event_id: view.promptEventId ?? null } },
      );
    }

    if (view.status === 'PRE_PROVIDER_ABORTED') {
      throw new CcrError(
        'INVALID_ARGUMENT',
        `L'envoi ${String(view.promptEventId)} n'a jamais atteint un fournisseur : il se clôt, il ne se ` +
          'finalise pas.',
        { details: { runId, status: view.status } },
      );
    }

    if (view.status === 'NONE') {
      actions.push("Aucune reprise d'envoi nécessaire.");
      return { runId, view, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
    }

    // ---- Marqueur durable, commit perdu. Le marqueur n'est **pas** réécrit,
    // et aucun second n'est créé : seul l'état local est posé.
    if (view.status === 'RESOLUTION_NEEDS_COMMIT') {
      state = await persistNativeStateUpdate(
        loaded.paths,
        state,
        {
          state: safeNativeSendRecoveryState(runId, loaded.manifest, state, loaded.history),
          control: 'HUMAN',
          activeExpertSlot: null,
          pendingOperation: null,
          uncertainty: null,
          ...(view.resolutionEventId === undefined ? {} : { lastEventId: view.resolutionEventId }),
        },
        deps.now(),
      );
      actions.push(
        `Clôture ${String(view.resolutionEventId)} déjà durable : seul l'état restait à poser. ` +
          `Run rendu en ${state.state} / HUMAN.`,
      );
      const settled = buildNativeSendRecoveryView(
        runId,
        loaded.manifest,
        state,
        await loaded.events.readAll(),
      );
      return { runId, view: settled, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
    }

    const pending = sendPendingOf(state);
    if (pending === null) {
      throw new CcrError('STATE_INVALID', `Le contexte d'envoi du run ${runId} a disparu.`, {
        details: { runId },
      });
    }

    if (view.status === 'FAILURE_NEEDS_FINALIZATION') {
      const failure = loaded.history.find((event) => event.event_id === view.failureEventId);
      if (failure === undefined) {
        throw new CcrError('STATE_INVALID', `L'échec terminal du run ${runId} a disparu.`, {
          details: { runId },
        });
      }
      state = await persistNativeStateUpdate(
        loaded.paths,
        state,
        {
          state: stateAfterRecordedFailure(failure),
          control: 'HUMAN',
          activeExpertSlot: null,
          pendingOperation: null,
          lastEventId: failure.event_id,
        },
        deps.now(),
      );
      actions.push(
        `Échec terminal déjà journalisé (${failure.event_id}) : seul le contexte restait engagé. ` +
          `Run rendu en ${state.state} / HUMAN.`,
      );
    } else {
      // La réponse existe déjà : rien n'est appendé, et l'état d'origine
      // persisté avant l'appel est restauré tel quel.
      state = await persistNativeStateUpdate(
        loaded.paths,
        state,
        {
          state: pending.return_state,
          control: 'HUMAN',
          activeExpertSlot: null,
          pendingOperation: null,
          ...(view.responseEventId === undefined ? {} : { lastEventId: view.responseEventId }),
        },
        deps.now(),
      );
      actions.push(
        `Envoi finalisé depuis la réponse déjà journalisée ${String(view.responseEventId)}. ` +
          `Run rendu en ${state.state} / HUMAN — l'automatisation ne reprend pas d'elle-même.`,
      );
    }

    const after = buildNativeSendRecoveryView(runId, loaded.manifest, state, await loaded.events.readAll());
    return { runId, view: after, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
  });
}

// --------------------------------------------------------------------------
// Acquittement d'une issue inconnue
// --------------------------------------------------------------------------

/**
 * Acquitte l'incertitude d'un envoi engagé.
 *
 * Effacer simplement le contexte laisserait un `human_message` sans issue, que
 * le diagnostic suivant présenterait comme abandonné avant appel — c'est-à-dire
 * en affirmant, à tort, qu'aucun fournisseur n'a été sollicité. Le marqueur est
 * donc durable, et **distinct** de celui d'un abandon avant appel.
 *
 * Ce que l'événement ne dit pas : que le fournisseur a répondu, qu'il n'a pas
 * répondu, que l'appel n'a pas été facturé, ou que le message peut être rejoué.
 */
export async function acknowledgeNativeSendUncertainty(
  deps: NativeSendRecoveryDeps,
  runId: string,
  note: string,
  seams: NativeSendRecoverySeams = {},
  boundary?: NativeMutationBoundary,
): Promise<NativeSendRecoveryOutcome> {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new CcrError('INVALID_ARGUMENT', "L'acquittement d'une incertitude exige une note explicite.", {
      details: { runId },
    });
  }

  return withNativeRunLock(deps, runId, 'native-send-acknowledge', boundary, async (staleLock, actions) => {
    const loaded = await loadNativeRun(deps, runId);
    let state = loaded.state;
    const view = buildNativeSendRecoveryView(runId, loaded.manifest, state, loaded.history);

    if (view.status !== 'IN_FLIGHT_UNCERTAIN') {
      throw new CcrError(
        'INVALID_ARGUMENT',
        `Le run ${runId} n'a aucun envoi d'issue inconnue à acquitter (statut ${view.status}).`,
        { details: { runId, status: view.status } },
      );
    }

    const pending = sendPendingOf(state);
    if (pending === null) {
      throw new CcrError('STATE_INVALID', `Le contexte d'envoi du run ${runId} a disparu.`, {
        details: { runId },
      });
    }
    const facts = requiredFacts(view, runId);

    const event = await loaded.events.append({
      round: facts.round,
      actor: 'human',
      type: 'send_uncertainty_acknowledged',
      target_expert_slot_id: facts.targetSlot,
      prompt_event_id: facts.promptEventId,
      reason: 'IN_FLIGHT_UNCERTAIN',
      // Fidélité de provenance (repair IMP-15.1) : `trimmed` **valide**, il ne
      // transforme pas. Une affirmation humaine est persistée telle qu'elle a
      // été écrite — bordures comprises. Rogner reviendrait à réécrire un fait
      // de provenance pour une raison purement cosmétique.
      content: note,
      based_on: [facts.promptEventId],
      details: {
        conclusion: "Aucune : CCR n'a pas déterminé si l'appel a eu lieu.",
        note: "L'acquittement ne prétend ni que l'appel a eu lieu, ni le contraire.",
        operation_started_at: pending.started_at,
      },
      timestamp: deps.now().toISOString(),
    });

    // Meme frontiere que pour la cloture : le marqueur d'abord, le commit
    // ensuite, et un classifieur capable de lire l'entre-deux.
    await seams.afterResolutionJournaled?.();

    // Ni round, ni curseur : aucun transfert n'a eu lieu, et aucun n'a échoué.
    state = await persistNativeStateUpdate(
      loaded.paths,
      state,
      {
        state: safeNativeSendRecoveryState(runId, loaded.manifest, state, loaded.history),
        control: 'HUMAN',
        activeExpertSlot: null,
        pendingOperation: null,
        uncertainty: null,
        lastEventId: event.event_id,
      },
      deps.now(),
    );
    actions.push(
      `Incertitude acquittée pour l'envoi ${facts.promptEventId}. Il ne sera pas rejoué : un nouvel ` +
        'envoi serait une nouvelle tentative.',
    );

    const after = buildNativeSendRecoveryView(runId, loaded.manifest, state, await loaded.events.readAll());
    return { runId, view: after, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
  });
}
