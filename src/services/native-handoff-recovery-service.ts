/**
 * Reprise d'un handoff natif interrompu (Slice 2C-R).
 *
 * L'ordre durable de 2C a été conçu pour rendre ces fenêtres lisibles :
 *
 * ```text
 * ouverture durable, aucun contexte     le client interactif n'a jamais été lancé
 * contexte engagé, aucune fin           l'étendue de l'interaction est inconnue
 * fin durable, contexte engagé          l'état local est en retard sur les faits
 * échec terminal durable, contexte      le lancement a échoué, l'état est en retard
 * marqueur durable, contexte engagé     la reprise elle-même a été interrompue
 * faits contradictoires                 échec fermé
 * ```
 *
 * ## Le principe qui gouverne tout
 *
 * `handoff` n'est pas `send`. CCR sait qu'une interaction a été **ouverte**, et
 * peut-être engagée, peut-être terminée. Il ne possède ni les messages saisis,
 * ni les réponses natives, ni le nombre de tours, ni les tokens, ni le coût, ni
 * l'état conversationnel résultant.
 *
 * En conséquence, **aucune reprise ne relance jamais `openInteractive`**. Ce
 * module n'a aucune dépendance d'adapter, et ne peut donc pas en résoudre un
 * même par erreur. Un nouveau handoff est toujours une nouvelle action humaine
 * explicite.
 *
 * ## La distinction qui porte tout
 *
 * `pending_operation` est persisté **avant** `openInteractive` (2C, étape 3), et
 * `human_handoff_started` avant lui. Un contexte absent prouve donc qu'aucun
 * client interactif n'a été lancé pour cette ouverture.
 *
 * ## Ce que la reprise ne touche pas
 *
 * `next_step_source_slot`, `state.round`, le manifest et `rounds/` — qu'un
 * handoff ne produit pas.
 */

import { CcrError } from '../core/errors.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import type {
  NativeCcrEvent,
  NativeRunManifest,
  NativeRunStateDocument,
  NativeSlotOperation,
} from '../core/run-native.ts';
import { HANDOFF_RESOLUTION_EVENT_TYPES } from '../core/run-native.ts';
import { assessLiveness, clearStaleLock, readRunLock } from '../lock/run-lock.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import type { RunLockInfo } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import type { RunPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import type { NativeEventStore } from '../store/native-event-store.ts';
import { persistNativeStateUpdate, readPersistedManifest, readPersistedState } from '../store/native-store.ts';

// --------------------------------------------------------------------------
// Dépendances — volontairement sans fournisseur
// --------------------------------------------------------------------------

/**
 * Ce dont la reprise a besoin, et rien d'autre.
 *
 * Aucun `createAdapters` : la garantie « aucune réouverture interactive » n'est
 * pas une discipline de relecture, c'est l'absence du moyen de le faire.
 */
export interface NativeHandoffRecoveryDeps {
  readonly runsDir: string;
  now(): Date;
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

export type NativeHandoffRecoveryStatus =
  | 'NONE'
  | 'PRE_INTERACTIVE_ABORTED'
  | 'IN_FLIGHT_UNCERTAIN'
  | 'FINISHED_NEEDS_COMMIT'
  | 'FAILURE_NEEDS_FINALIZATION'
  | 'RESOLUTION_NEEDS_COMMIT'
  | 'EVIDENCE_CONFLICT';

export interface NativeHandoffRecoveryView {
  readonly runId: string;
  readonly status: NativeHandoffRecoveryStatus;
  readonly targetSlot?: ExpertSlotId;
  readonly startedEventId?: string;
  readonly finishedEventId?: string;
  readonly failureEventId?: string;
  readonly resolutionEventId?: string;
  readonly round?: number;
  readonly canFinalizeWithoutInteractive: boolean;
  readonly requiresHumanAcknowledgement: boolean;
  /**
   * Ouvertures ne portant **aucune** issue journalisée : ni fin, ni échec
   * terminal, ni marqueur de clôture.
   *
   * Elles peuvent être plusieurs. Une ouverture abandonnée avant le contexte ne
   * bloque rien — le run reste utilisable, et peut légitimement continuer —, si
   * bien qu'une seconde ouverture orpheline est parfaitement possible. La
   * reprise les épuise une par une, dans l'ordre du journal.
   */
  readonly orphanStartedEventIds: readonly string[];
  readonly conflicts: readonly string[];
}

function field(event: NativeCcrEvent, name: string): unknown {
  return (event as unknown as Record<string, unknown>)[name];
}

function slotField(event: NativeCcrEvent, name: string): ExpertSlotId | null {
  const value = field(event, name);
  return value === 'author' || value === 'challenger' ? value : null;
}

function handoffPendingOf(state: NativeRunStateDocument): NativeSlotOperation | null {
  const pending = state.pending_operation;
  return pending !== null && pending.kind === 'handoff' ? pending : null;
}

function isResolution(event: NativeCcrEvent): boolean {
  return (HANDOFF_RESOLUTION_EVENT_TYPES as readonly string[]).includes(event.type);
}

/** Événements dérivant explicitement de cette ouverture. Jamais « par proximité ». */
function derivedFrom(
  events: readonly NativeCcrEvent[],
  startedEventId: string,
  type: string,
): readonly NativeCcrEvent[] {
  return events.filter(
    (event) => event.type === type && (event.based_on ?? []).includes(startedEventId),
  );
}

/** Marqueurs de clôture désignant cette ouverture. */
function resolutionsFor(
  events: readonly NativeCcrEvent[],
  startedEventId: string,
): readonly NativeCcrEvent[] {
  return events.filter((event) => isResolution(event) && field(event, 'started_event_id') === startedEventId);
}

/**
 * Contradictions que l'ordre durable de 2C rend impossibles.
 *
 * Les « réparer » reviendrait à choisir laquelle de deux affirmations est vraie.
 */
function collectConflicts(
  events: readonly NativeCcrEvent[],
  openings: readonly NativeCcrEvent[],
  pending: NativeSlotOperation | null,
  subject: NativeCcrEvent | undefined,
  conflicts: string[],
): void {
  // ---- Contradictions lisibles sans le moindre contexte engagé.
  for (const opening of openings) {
    const finished = derivedFrom(events, opening.event_id, 'human_handoff_finished');
    const failed = derivedFrom(events, opening.event_id, 'process_failed');
    const slot = slotField(opening, 'target_expert_slot_id');

    if (finished.length > 1) {
      conflicts.push(
        `L'ouverture ${opening.event_id} porte ${String(finished.length)} fins : une tentative n'en a qu'une.`,
      );
    }
    if (finished.length > 0 && failed.length > 0) {
      conflicts.push(
        `L'ouverture ${opening.event_id} porte à la fois une fin et un échec terminal.`,
      );
    }
    for (const terminal of [...finished, ...failed]) {
      if (slotField(terminal, 'target_expert_slot_id') !== slot) {
        conflicts.push(
          `${terminal.event_id} attribue à « ${String(slotField(terminal, 'target_expert_slot_id'))} » ` +
            `une opération ouverte pour « ${String(slot)} ».`,
        );
      }
      if (field(terminal, 'session_id') !== field(opening, 'session_id')) {
        conflicts.push(
          `${terminal.event_id} porte la session « ${String(field(terminal, 'session_id'))} », ` +
            `alors que l'ouverture nommait « ${String(field(opening, 'session_id'))} ».`,
        );
      }
    }

    const markers = resolutionsFor(events, opening.event_id);
    if (markers.length > 1) {
      conflicts.push(
        `L'ouverture ${opening.event_id} porte ${String(markers.length)} marqueurs de clôture.`,
      );
    }
    // Acquitter une incertitude alors qu'un terminal existe déjà revient à
    // déclarer inconnu ce que le journal établit.
    if (
      markers.some((marker) => marker.type === 'handoff_uncertainty_acknowledged') &&
      finished.length + failed.length > 0
    ) {
      conflicts.push(
        `L'ouverture ${opening.event_id} porte un acquittement d'incertitude alors que son issue est ` +
          'journalisée.',
      );
    }
  }

  if (pending === null) return;

  // ---- Contradictions entre le contexte engagé et les faits journalisés.
  if (subject === undefined) {
    conflicts.push(
      `Le contexte de handoff désigne l'ouverture « ${String(pending.prompt_event_id)} », introuvable ` +
        'dans le journal.',
    );
    return;
  }
  if (slotField(subject, 'target_expert_slot_id') !== pending.expert_slot) {
    conflicts.push(
      `Le contexte de handoff vise « ${pending.expert_slot} » alors que l'ouverture ${subject.event_id} ` +
        `concerne « ${String(slotField(subject, 'target_expert_slot_id'))} ».`,
    );
  }
  if (field(subject, 'session_id') !== pending.session_id) {
    conflicts.push(
      `Le contexte de handoff nomme la session « ${String(pending.session_id)} », l'ouverture ` +
        `« ${String(field(subject, 'session_id'))} ».`,
    );
  }
}

/**
 * Établit ce que le disque affirme d'un handoff.
 *
 * Pure et synchrone : aucun fichier n'est lu ici, et `rounds/` n'est consulté
 * dans aucun chemin — un handoff n'en produit pas.
 */
export function buildNativeHandoffRecoveryView(
  runId: string,
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  events: readonly NativeCcrEvent[],
): NativeHandoffRecoveryView {
  void manifest;
  const pending = handoffPendingOf(state);
  const openings = events.filter((event) => event.type === 'human_handoff_started');
  const orphans = openings.filter(
    (opening) =>
      derivedFrom(events, opening.event_id, 'human_handoff_finished').length === 0 &&
      derivedFrom(events, opening.event_id, 'process_failed').length === 0 &&
      resolutionsFor(events, opening.event_id).length === 0,
  );

  // Le sujet est l'ouverture engagée s'il y en a une ; sinon la plus ancienne
  // ouverture restée sans issue. Jamais « la dernière du journal ».
  const subject =
    pending === null
      ? orphans[0]
      : openings.find((opening) => opening.event_id === pending.prompt_event_id);

  const conflicts: string[] = [];
  collectConflicts(events, openings, pending, subject, conflicts);

  const finished = subject === undefined
    ? undefined
    : derivedFrom(events, subject.event_id, 'human_handoff_finished')[0];
  const failure = subject === undefined
    ? undefined
    : derivedFrom(events, subject.event_id, 'process_failed')[0];
  // Un contexte engagé désignant une ouverture DÉJÀ close est le résidu d'une
  // reprise interrompue : l'issue est arrêtée, l'état ne l'est pas.
  const staleMarker =
    pending === null || pending.prompt_event_id === null
      ? undefined
      : resolutionsFor(events, pending.prompt_event_id)[0];

  const base = {
    runId,
    orphanStartedEventIds: orphans.map((opening) => opening.event_id),
    conflicts,
    ...(subject === undefined
      ? pending === null || pending.prompt_event_id === null
        ? {}
        : { startedEventId: pending.prompt_event_id }
      : {
          startedEventId: subject.event_id,
          round: subject.round,
          ...(slotField(subject, 'target_expert_slot_id') === null
            ? {}
            : { targetSlot: slotField(subject, 'target_expert_slot_id') as ExpertSlotId }),
        }),
    ...(finished === undefined ? {} : { finishedEventId: finished.event_id }),
    ...(failure === undefined ? {} : { failureEventId: failure.event_id }),
  };

  if (conflicts.length > 0) {
    return {
      ...base,
      status: 'EVIDENCE_CONFLICT',
      canFinalizeWithoutInteractive: false,
      requiresHumanAcknowledgement: false,
    };
  }

  if (staleMarker !== undefined) {
    return {
      ...base,
      status: 'RESOLUTION_NEEDS_COMMIT',
      resolutionEventId: staleMarker.event_id,
      canFinalizeWithoutInteractive: true,
      requiresHumanAcknowledgement: false,
    };
  }

  if (pending !== null) {
    if (finished !== undefined) {
      return {
        ...base,
        status: 'FINISHED_NEEDS_COMMIT',
        canFinalizeWithoutInteractive: true,
        requiresHumanAcknowledgement: false,
      };
    }
    if (failure !== undefined) {
      // L'issue est connue : le lancement a échoué, et CCR l'a journalisé.
      return {
        ...base,
        status: 'FAILURE_NEEDS_FINALIZATION',
        canFinalizeWithoutInteractive: true,
        requiresHumanAcknowledgement: false,
      };
    }
    return {
      ...base,
      status: 'IN_FLIGHT_UNCERTAIN',
      canFinalizeWithoutInteractive: false,
      requiresHumanAcknowledgement: true,
    };
  }

  // Aucun contexte engagé. L'ordre durable de 2C prouve qu'aucun client
  // interactif n'a été lancé pour une ouverture restée sans issue.
  return {
    ...base,
    status: subject === undefined ? 'NONE' : 'PRE_INTERACTIVE_ABORTED',
    canFinalizeWithoutInteractive: false,
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

async function loadNativeRun(deps: NativeHandoffRecoveryDeps, runId: string): Promise<LoadedNativeRun> {
  const paths = runPaths(deps.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Le run ${runId} est de génération ${persisted.execution_mode} : la reprise de handoff native ne le ` +
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
export async function inspectNativeHandoffRecovery(
  deps: NativeHandoffRecoveryDeps,
  runId: string,
): Promise<NativeHandoffRecoveryView> {
  const loaded = await loadNativeRun(deps, runId);
  return buildNativeHandoffRecoveryView(runId, loaded.manifest, loaded.state, loaded.history);
}

// --------------------------------------------------------------------------
// Verrou
// --------------------------------------------------------------------------

export interface NativeHandoffRecoveryOutcome {
  readonly runId: string;
  readonly view: NativeHandoffRecoveryView;
  readonly state: NativeRunStateDocument;
  readonly actions: readonly string[];
  readonly staleLock?: RunLockInfo;
}

/** Point d'observation de la frontière durable d'une reprise. */
export interface NativeHandoffRecoverySeams {
  /** Après le marqueur de clôture, avant le commit d'état. */
  readonly afterResolutionJournaled?: () => void | Promise<void>;
}

async function withNativeRunLock<T>(
  deps: NativeHandoffRecoveryDeps,
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

function requiredFacts(view: NativeHandoffRecoveryView, runId: string): {
  startedEventId: string;
  targetSlot: ExpertSlotId;
  round: number;
} {
  const { startedEventId, targetSlot, round } = view;
  if (startedEventId === undefined || targetSlot === undefined || round === undefined) {
    throw new CcrError('STATE_INVALID', `Faits de handoff incomplets pour le run ${runId}.`, {
      details: { runId, status: view.status },
    });
  }
  return { startedEventId, targetSlot, round };
}

// --------------------------------------------------------------------------
// Clôture d'une ouverture jamais engagée
// --------------------------------------------------------------------------

/**
 * Clôt durablement une ouverture dont l'ordre 2C prouve qu'aucun client
 * interactif n'a été lancé.
 *
 * **Marqueur seul** : aucun état n'est touché. C'est délibéré. Une ouverture
 * sans contexte n'a jamais rien bloqué — le run a pu continuer légitimement, et
 * son état actuel peut être bien postérieur. Le normaliser en `PAUSED / HUMAN`,
 * ou même y réécrire `last_event_id`, reviendrait à faire reculer un run qui a
 * progressé.
 *
 * Le marqueur ne dit qu'une chose : cette ouverture précise est close, et n'a
 * jamais engagé le client interactif.
 */
export async function abortNativeHandoffBeforeInteractive(
  deps: NativeHandoffRecoveryDeps,
  runId: string,
  seams: NativeHandoffRecoverySeams = {},
  boundary?: NativeMutationBoundary,
): Promise<NativeHandoffRecoveryOutcome> {
  return withNativeRunLock(deps, runId, 'native-handoff-abort', boundary, async (staleLock, actions) => {
    // Reclassification **sous le verrou** : c'est elle qui rend une double
    // invocation inoffensive.
    const loaded = await loadNativeRun(deps, runId);
    const state = loaded.state;
    const view = buildNativeHandoffRecoveryView(runId, loaded.manifest, state, loaded.history);

    if (view.status === 'NONE') {
      actions.push("Aucune ouverture de handoff à clore : rien n'a été écrit.");
      return { runId, view, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
    }
    if (view.status !== 'PRE_INTERACTIVE_ABORTED') {
      throw new CcrError(
        'INVALID_ARGUMENT',
        `Le run ${runId} n'a aucune ouverture de handoff abandonnée avant lancement (statut ${view.status}).`,
        { details: { runId, status: view.status, conflicts: [...view.conflicts] } },
      );
    }

    const facts = requiredFacts(view, runId);
    await loaded.events.append({
      round: facts.round,
      actor: 'system',
      type: 'handoff_aborted_before_interactive',
      target_expert_slot_id: facts.targetSlot,
      started_event_id: facts.startedEventId,
      reason: 'PRE_INTERACTIVE_ABORTED',
      content: "Ouverture close : aucun client interactif n'avait été lancé.",
      based_on: [facts.startedEventId],
      details: {
        basis: "Le contexte de reprise n'était pas persisté, or 2C le persiste avant tout lancement.",
        interactive_calls: 0,
        note: "Aucune session native n'a été atteinte : la position connue de cet expert reste valable.",
      },
      timestamp: deps.now().toISOString(),
    });

    await seams.afterResolutionJournaled?.();

    // Aucune mutation d'état, volontairement : voir l'en-tête de cette fonction.
    actions.push(
      `Ouverture ${facts.startedEventId} vers « ${facts.targetSlot} » close avant tout lancement. ` +
        "L'état du run n'est pas touché : il a pu progresser depuis.",
    );

    const after = buildNativeHandoffRecoveryView(
      runId,
      loaded.manifest,
      state,
      await loaded.events.readAll(),
    );
    return { runId, view: after, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
  });
}

// --------------------------------------------------------------------------
// Finalisation locale
// --------------------------------------------------------------------------

/**
 * Termine un handoff que les faits canoniques établissent déjà.
 *
 * Ne rouvre jamais de client interactif — c'est structurellement impossible
 * ici — et n'écrit **aucun** événement : la fin durable est le fait, et la
 * dupliquer n'ajouterait qu'une seconde vérité.
 *
 * Le contrôle revient à l'humain, comme en 1D, 1G et 2B-R. `return_control`
 * reste une preuve historique du contexte d'origine, jamais une autorisation à
 * reprendre l'automatisation après un crash.
 */
export async function finalizeNativeHandoffRecovery(
  deps: NativeHandoffRecoveryDeps,
  runId: string,
  boundary?: NativeMutationBoundary,
): Promise<NativeHandoffRecoveryOutcome> {
  return withNativeRunLock(deps, runId, 'native-handoff-recover', boundary, async (staleLock, actions) => {
    const loaded = await loadNativeRun(deps, runId);
    let state = loaded.state;
    const view = buildNativeHandoffRecoveryView(runId, loaded.manifest, state, loaded.history);

    if (view.status === 'EVIDENCE_CONFLICT') {
      throw new CcrError(
        'STATE_INVALID',
        `Le handoff du run ${runId} porte des faits contradictoires que l'ordre d'écriture rend ` +
          "impossibles. Aucune réparation n'est tentée : elle reviendrait à choisir entre deux affirmations.",
        { details: { runId, conflicts: [...view.conflicts] } },
      );
    }

    if (view.status === 'IN_FLIGHT_UNCERTAIN') {
      throw new CcrError(
        'RECOVERY_REQUIRED',
        `Une interaction native vers « ${String(view.targetSlot)} » a été engagée sans fin journalisée. ` +
          "CCR ignore ce qu'elle a produit : acquittez explicitement cette incertitude.",
        { details: { runId, started_event_id: view.startedEventId ?? null } },
      );
    }

    if (view.status === 'PRE_INTERACTIVE_ABORTED') {
      throw new CcrError(
        'INVALID_ARGUMENT',
        `L'ouverture ${String(view.startedEventId)} n'a jamais atteint un client interactif : elle se ` +
          'clôt, elle ne se finalise pas.',
        { details: { runId, status: view.status } },
      );
    }

    if (view.status === 'NONE') {
      actions.push("Aucune reprise de handoff nécessaire.");
      return { runId, view, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
    }

    const pending = handoffPendingOf(state);
    if (pending === null) {
      throw new CcrError('STATE_INVALID', `Le contexte de handoff du run ${runId} a disparu.`, {
        details: { runId },
      });
    }

    // Trois statuts, un seul commit : la fin, l'échec et le marqueur établissent
    // tous que l'opération est arrêtée. Seul l'état local restait à poser.
    const anchor =
      view.status === 'RESOLUTION_NEEDS_COMMIT'
        ? view.resolutionEventId
        : view.status === 'FINISHED_NEEDS_COMMIT'
          ? view.finishedEventId
          : view.failureEventId;

    state = await persistNativeStateUpdate(
      loaded.paths,
      state,
      {
        state: pending.return_state,
        control: 'HUMAN',
        activeExpertSlot: null,
        pendingOperation: null,
        uncertainty: null,
        ...(anchor === undefined ? {} : { lastEventId: anchor }),
      },
      deps.now(),
    );
    actions.push(
      `Handoff finalisé localement depuis ${String(anchor)} (${view.status}). ` +
        `Run rendu en ${state.state} / HUMAN — l'automatisation ne reprend pas d'elle-même.`,
    );

    const after = buildNativeHandoffRecoveryView(
      runId,
      loaded.manifest,
      state,
      await loaded.events.readAll(),
    );
    return { runId, view: after, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
  });
}

// --------------------------------------------------------------------------
// Acquittement d'une étendue inconnue
// --------------------------------------------------------------------------

/**
 * Acquitte l'incertitude d'un handoff engagé.
 *
 * Ce que l'événement ne dit **pas** : que l'interaction n'a pas démarré,
 * qu'elle s'est terminée, qu'aucun message n'a été échangé, que la session
 * native est inchangée, qu'un client externe survivant est arrêté, ou que le
 * coût est connu.
 *
 * Ce qu'il dit, et seulement : un humain reconnaît que CCR ignore l'étendue de
 * l'interaction native, et renonce à toute réouverture automatique de cette
 * tentative.
 */
export async function acknowledgeNativeHandoffUncertainty(
  deps: NativeHandoffRecoveryDeps,
  runId: string,
  note: string,
  seams: NativeHandoffRecoverySeams = {},
  boundary?: NativeMutationBoundary,
): Promise<NativeHandoffRecoveryOutcome> {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new CcrError('INVALID_ARGUMENT', "L'acquittement d'une incertitude exige une note explicite.", {
      details: { runId },
    });
  }

  return withNativeRunLock(deps, runId, 'native-handoff-acknowledge', boundary, async (staleLock, actions) => {
    const loaded = await loadNativeRun(deps, runId);
    let state = loaded.state;
    const view = buildNativeHandoffRecoveryView(runId, loaded.manifest, state, loaded.history);

    if (view.status !== 'IN_FLIGHT_UNCERTAIN') {
      throw new CcrError(
        'INVALID_ARGUMENT',
        `Le run ${runId} n'a aucun handoff d'étendue inconnue à acquitter (statut ${view.status}).`,
        { details: { runId, status: view.status } },
      );
    }

    const pending = handoffPendingOf(state);
    if (pending === null) {
      throw new CcrError('STATE_INVALID', `Le contexte de handoff du run ${runId} a disparu.`, {
        details: { runId },
      });
    }
    const facts = requiredFacts(view, runId);

    const event = await loaded.events.append({
      round: facts.round,
      actor: 'human',
      type: 'handoff_uncertainty_acknowledged',
      target_expert_slot_id: facts.targetSlot,
      started_event_id: facts.startedEventId,
      reason: 'IN_FLIGHT_UNCERTAIN',
      // Fidélité de provenance (repair IMP-15.1) : `trimmed` **valide**, il ne
      // transforme pas. Une affirmation humaine est persistée telle qu'elle a
      // été écrite — bordures comprises. Rogner reviendrait à réécrire un fait
      // de provenance pour une raison purement cosmétique.
      content: note,
      based_on: [facts.startedEventId],
      details: {
        conclusion: "Aucune : CCR ignore l'étendue de l'interaction native.",
        note:
          "L'acquittement ne prétend ni que l'interaction a eu lieu, ni le contraire, ni que la " +
          'session est inchangée, ni qu\'un client externe survivant est arrêté.',
        cost: 'NOT CONTROLLED / NOT MEASURED',
        operation_started_at: pending.started_at,
      },
      timestamp: deps.now().toISOString(),
    });

    await seams.afterResolutionJournaled?.();

    // Ni round, ni curseur : un handoff n'a jamais été un transfert.
    state = await persistNativeStateUpdate(
      loaded.paths,
      state,
      {
        state: pending.return_state,
        control: 'HUMAN',
        activeExpertSlot: null,
        pendingOperation: null,
        uncertainty: null,
        lastEventId: event.event_id,
      },
      deps.now(),
    );
    actions.push(
      `Incertitude acquittée pour l'ouverture ${facts.startedEventId}. Aucune réouverture : un nouveau ` +
        'handoff serait une nouvelle action humaine.',
    );

    const after = buildNativeHandoffRecoveryView(
      runId,
      loaded.manifest,
      state,
      await loaded.events.readAll(),
    );
    return { runId, view: after, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
  });
}
