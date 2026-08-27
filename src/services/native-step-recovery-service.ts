/**
 * Reprise d'un transfert natif interrompu (Slice 1G).
 *
 * L'ordre durable de 1F a été conçu pour rendre ces fenêtres lisibles. Ce
 * module les lit, et rien de plus :
 *
 * ```text
 * aucun contexte engagé          le fournisseur n'a jamais été appelé
 * contexte engagé, sans réponse  l'issue est inconnue
 * réponse durable, non finalisée le fournisseur a répondu
 * transfert finalisé, non commit l'état est en retard sur les faits
 * faits contradictoires          échec fermé
 * ```
 *
 * ## La distinction qui porte tout
 *
 * `pending_operation` est persisté **avant** `adapter.resume` (1F, étape 5).
 * Son absence prouve donc qu'aucun appel n'a été engagé par ce transfert — et
 * c'est ce qui sépare un abandon avant appel d'une incertitude. Sans cette
 * garantie d'ordre, les deux seraient indiscernables et tout devrait être
 * traité comme incertain.
 *
 * ## Deux règles absolues
 *
 * Aucun fournisseur n'est appelé ici : ce module n'a **aucune** dépendance
 * d'adapter, et ne peut donc pas en résoudre un même par erreur.
 *
 * `rounds/` n'est jamais une preuve. Un artefact absent, incomplet ou invalide
 * produit une attention diagnostique ; il ne contredit jamais `events.jsonl`,
 * et ne bloque jamais une finalisation que les faits canoniques établissent.
 */

import { CcrError } from '../core/errors.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import { NATIVE_ROUND_SCHEMA_VERSION } from '../core/run-native.ts';
import type {
  NativeCcrEvent,
  NativeRunManifest,
  NativeRunStateDocument,
  NativeStepOperation,
} from '../core/run-native.ts';
import { assessLiveness, clearStaleLock, readRunLock } from '../lock/run-lock.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import type { RunLockInfo } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import type { RunPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import type { NativeEventStore } from '../store/native-event-store.ts';
import { readNativeRoundMetadata, writeNativeRoundMetadata } from '../store/native-round-store.ts';
import { persistNativeStateUpdate, readPersistedManifest, readPersistedState } from '../store/native-store.ts';

// --------------------------------------------------------------------------
// Dépendances — volontairement sans fournisseur
// --------------------------------------------------------------------------

/**
 * Ce dont la reprise a besoin, et rien d'autre.
 *
 * Aucun `createAdapters` : la garantie « aucun appel fournisseur » n'est pas
 * une discipline de relecture, c'est l'absence du moyen de le faire.
 */
export interface NativeStepRecoveryDeps {
  readonly runsDir: string;
  now(): Date;
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

export type NativeStepRecoveryStatus =
  | 'NONE'
  | 'PRE_PROVIDER_ABORTED'
  | 'IN_FLIGHT_UNCERTAIN'
  | 'RESPONSE_NEEDS_FINALIZATION'
  | 'ROUND_COMPLETED_NEEDS_COMMIT'
  /**
   * Une preuve durable a déjà résolu l'issue de cette tentative, mais le commit
   * local n'est pas terminé (repair 1G.2).
   *
   * Ne signifie jamais qu'un fournisseur reste à rappeler, qu'une réponse est à
   * reconstruire, ni qu'un rejeu est possible : l'issue est arrêtée, seul
   * l'état est en retard.
   */
  | 'RESOLUTION_NEEDS_COMMIT'
  | 'EVIDENCE_CONFLICT';

/** État de l'artefact diagnostique. Il n'entre dans aucune décision canonique. */
export type DiagnosticRoundStatus = 'MATCHING' | 'MISSING' | 'INVALID' | 'NOT_APPLICABLE';

/** Ce qu'un `source_event_id` peut encore devenir. */
export type SourceReplayStatus = 'ELIGIBLE' | 'TRANSFERRED' | 'QUARANTINED' | 'NOT_APPLICABLE';

export interface NativeStepRecoveryView {
  readonly runId: string;
  readonly status: NativeStepRecoveryStatus;
  readonly sourceSlot?: ExpertSlotId;
  readonly targetSlot?: ExpertSlotId;
  readonly sourceEventId?: string;
  readonly responseEventId?: string;
  readonly round?: number;
  readonly roundCompletedEventId?: string;
  /** Ouverture de round de la tentative observée : son identité canonique. */
  readonly startedEventId?: string;
  /** Marqueur de résolution de cette tentative, s'il en existe un. */
  readonly resolutionEventId?: string;
  readonly diagnosticRound: DiagnosticRoundStatus;
  readonly canFinalizeWithoutProvider: boolean;
  readonly requiresHumanAcknowledgement: boolean;
  readonly sourceReplayStatus: SourceReplayStatus;
  readonly conflicts: readonly string[];
}

function field(event: NativeCcrEvent, name: string): unknown {
  return (event as unknown as Record<string, unknown>)[name];
}

function slotField(event: NativeCcrEvent, name: string): ExpertSlotId | null {
  const value = field(event, name);
  return value === 'author' || value === 'challenger' ? value : null;
}

function lastOfType(events: readonly NativeCcrEvent[], type: string): NativeCcrEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) return event;
  }
  return undefined;
}

function stepPendingOf(state: NativeRunStateDocument): NativeStepOperation | null {
  const pending = state.pending_operation;
  return pending !== null && pending.kind === 'step' ? pending : null;
}

/**
 * Cohérence entre le contexte engagé, la réponse et la finalisation.
 *
 * Chaque contradiction listée ici est impossible dans l'ordre durable de 1F.
 * Les « réparer » reviendrait à choisir laquelle de deux affirmations est vraie.
 */
function collectConflicts(
  manifest: NativeRunManifest,
  events: readonly NativeCcrEvent[],
  pending: NativeStepOperation | null,
  completed: NativeCcrEvent | undefined,
  response: NativeCcrEvent | undefined,
  conflicts: string[],
): void {
  if (completed !== undefined) {
    const responseId = field(completed, 'response_event_id');
    const referenced = events.find((event) => event.event_id === responseId);
    if (referenced === undefined) {
      conflicts.push(
        `round_completed ${completed.event_id} désigne la réponse « ${String(responseId)} », absente du journal.`,
      );
    } else if (slotField(referenced, 'expert_slot_id') !== slotField(completed, 'target_slot_id')) {
      conflicts.push(
        `round_completed ${completed.event_id} attribue à « ${String(field(completed, 'target_slot_id'))} » ` +
          `une réponse du slot « ${String(slotField(referenced, 'expert_slot_id'))} ».`,
      );
    }

    const duplicates = events.filter(
      (event) => event.type === 'round_completed' && event.round === completed.round,
    );
    if (duplicates.length > 1) {
      conflicts.push(`Le round ${String(completed.round)} porte ${String(duplicates.length)} finalisations.`);
    }

    if (pending !== null) {
      if (pending.round !== completed.round) {
        conflicts.push(
          `Le transfert engagé vise le round ${String(pending.round)}, la finalisation le round ` +
            `${String(completed.round)}.`,
        );
      }
      if (pending.source_event_id !== field(completed, 'source_event_id')) {
        conflicts.push(
          `Le transfert engagé consomme « ${pending.source_event_id} », la finalisation ` +
            `« ${String(field(completed, 'source_event_id'))} ».`,
        );
      }
    }
  }

  if (response !== undefined && pending !== null) {
    const slot = slotField(response, 'expert_slot_id');
    if (slot !== pending.target_slot) {
      conflicts.push(
        `La réponse ${response.event_id} appartient à « ${String(slot)} » alors que le transfert vise ` +
          `« ${pending.target_slot} ».`,
      );
    } else if (field(response, 'session_id') !== manifest.experts[pending.target_slot].session_id) {
      conflicts.push(
        `La réponse ${response.event_id} porte la session « ${String(field(response, 'session_id'))} », ` +
          `qui n'est pas celle liée à « ${pending.target_slot} ».`,
      );
    }
  }
}

async function diagnosticRoundStatus(
  paths: RunPaths,
  round: number | undefined,
  completed: NativeCcrEvent | undefined,
): Promise<DiagnosticRoundStatus> {
  if (round === undefined || completed === undefined) return 'NOT_APPLICABLE';
  try {
    const metadata = await readNativeRoundMetadata(paths, round);
    return metadata.source_event_id === field(completed, 'source_event_id') &&
      metadata.response_event_id === field(completed, 'response_event_id')
      ? 'MATCHING'
      : 'INVALID';
  } catch (error) {
    // Un artefact absent est une lacune diagnostique, pas une contradiction ;
    // un artefact illisible non plus. Ni l'un ni l'autre n'invalide un fait
    // canonique établi par le journal.
    return error instanceof CcrError && error.code === 'RUN_NOT_FOUND' ? 'MISSING' : 'INVALID';
  }
}

function replayStatusOf(
  events: readonly NativeCcrEvent[],
  sourceEventId: string | undefined,
): SourceReplayStatus {
  if (sourceEventId === undefined) return 'NOT_APPLICABLE';
  if (events.some((e) => e.type === 'round_completed' && field(e, 'source_event_id') === sourceEventId)) {
    return 'TRANSFERRED';
  }
  if (
    events.some(
      (e) => e.type === 'transfer_uncertainty_acknowledged' && field(e, 'source_event_id') === sourceEventId,
    )
  ) {
    return 'QUARANTINED';
  }
  return 'ELIGIBLE';
}

/**
 * Marqueurs qui résolvent **cette tentative**, et elle seule.
 *
 * Deux identités, parce que les deux faits ne se rattachent pas de la même
 * façon :
 *
 * ```text
 * transfer_aborted_before_provider   based_on = [ round_started.event_id ]
 *   → identité de TENTATIVE. Une même source peut légitimement être réessayée
 *     après un abandon avant appel, dans le même round logique : la rattacher
 *     à `source_event_id + round` ferait passer la tentative suivante pour
 *     déjà close.
 *
 * transfer_uncertainty_acknowledged  source_event_id + round
 *   → identité de SOURCE. Elle suffit ici, et elle seule est disponible sur
 *     les marqueurs déjà écrits par 1G : un acquittement met la source en
 *     quarantaine définitive, donc aucune tentative ultérieure ne peut
 *     légitimement la reprendre. Les journaux existants restent lisibles, et
 *     aucun schéma n'est modifié.
 * ```
 */
function resolutionOfAttempt(
  events: readonly NativeCcrEvent[],
  started: NativeCcrEvent,
  sourceEventId: string | undefined,
): NativeCcrEvent | undefined {
  const acknowledged = events.find(
    (event) =>
      event.type === 'transfer_uncertainty_acknowledged' &&
      sourceEventId !== undefined &&
      field(event, 'source_event_id') === sourceEventId &&
      event.round === started.round,
  );
  if (acknowledged !== undefined) return acknowledged;

  return events.find(
    (event) =>
      event.type === 'transfer_aborted_before_provider' &&
      (event.based_on ?? []).includes(started.event_id),
  );
}

/**
 * Le commit local de cette résolution est-il terminé ?
 *
 * Deux résidus, parce que les deux gestes n'en laissent pas le même :
 *
 * ```text
 * acquittement   le contexte engagé survit à un commit perdu
 * abandon        aucun contexte n'existait ; le témoin est `last_event_id`,
 *                et le marqueur doit être le dernier fait du journal — un run
 *                qui a repris son cours depuis n'est pas à finaliser
 * ```
 */
function resolutionIsCommitted(
  state: NativeRunStateDocument,
  events: readonly NativeCcrEvent[],
  resolution: NativeCcrEvent,
): boolean {
  if (resolution.type === 'transfer_uncertainty_acknowledged') {
    return state.pending_operation === null && state.active_expert_slot === null;
  }
  const last = events[events.length - 1];
  const trailing = last !== undefined && last.event_id === resolution.event_id;
  return !trailing || state.last_event_id === resolution.event_id;
}

export async function buildNativeStepRecoveryView(
  paths: RunPaths,
  runId: string,
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  events: readonly NativeCcrEvent[],
): Promise<NativeStepRecoveryView> {
  const pending = stepPendingOf(state);
  const started = lastOfType(events, 'round_started');

  // Aucune tentative de transfert n'a jamais commencé : rien à reprendre ici.
  // Une initialisation engagée relève du Slice 1D, pas de celui-ci.
  if (started === undefined) {
    return {
      runId,
      status: 'NONE',
      diagnosticRound: 'NOT_APPLICABLE',
      canFinalizeWithoutProvider: false,
      requiresHumanAcknowledgement: false,
      sourceReplayStatus: 'NOT_APPLICABLE',
      conflicts: [],
    };
  }

  const round = started.round;
  const completed = events.find((event) => event.type === 'round_completed' && event.round === round);

  // La reponse de CETTE tentative est celle qui derive de son prompt, jamais
  // « une reponse du bon slot dans le meme round » : chercher par slot ferait
  // disparaitre une reponse mal attribuee au lieu de la signaler.
  const response =
    pending !== null && pending.prompt_event_id !== null
      ? events.find(
          (event) =>
            event.type === 'assistant_response' &&
            (event.based_on ?? []).includes(pending.prompt_event_id as string),
        )
      : completed === undefined
        ? undefined
        : events.find((event) => event.event_id === field(completed, 'response_event_id'));

  const conflicts: string[] = [];
  collectConflicts(manifest, events, pending, completed, response, conflicts);

  // Chaine de derivation : le contexte engage d'abord, la finalisation ensuite,
  // et a defaut les details de `round_started` — le seul endroit ou les parties
  // survivent quand un transfert a ete abandonne avant tout appel.
  const startedDetails = (started.details ?? {}) as Record<string, unknown>;
  const detailSlot = (name: string): ExpertSlotId | undefined => {
    const value = startedDetails[name];
    return value === 'author' || value === 'challenger' ? value : undefined;
  };
  const parties = {
    sourceSlot:
      pending?.source_slot ??
      (completed === undefined ? undefined : (slotField(completed, 'source_slot_id') ?? undefined)) ??
      detailSlot('source_slot'),
    targetSlot:
      pending?.target_slot ??
      (completed === undefined
        ? (slotField(started, 'target_expert_slot_id') ?? undefined)
        : (slotField(completed, 'target_slot_id') ?? undefined)) ??
      detailSlot('target_slot'),
    sourceEventId:
      pending?.source_event_id ??
      (completed === undefined ? undefined : (field(completed, 'source_event_id') as string | undefined)) ??
      (typeof startedDetails['source_event_id'] === 'string'
        ? (startedDetails['source_event_id'] as string)
        : undefined),
    responseEventId:
      response?.event_id ??
      (completed === undefined ? undefined : (field(completed, 'response_event_id') as string | undefined)),
  };

  const diagnosticRound = await diagnosticRoundStatus(paths, completed === undefined ? undefined : round, completed);

  const base = {
    runId,
    round,
    diagnosticRound,
    sourceReplayStatus: replayStatusOf(events, parties.sourceEventId),
    conflicts,
    ...(parties.sourceSlot === undefined ? {} : { sourceSlot: parties.sourceSlot }),
    ...(parties.targetSlot === undefined ? {} : { targetSlot: parties.targetSlot }),
    ...(parties.sourceEventId === undefined ? {} : { sourceEventId: parties.sourceEventId }),
    ...(parties.responseEventId === undefined ? {} : { responseEventId: parties.responseEventId }),
    ...(completed === undefined ? {} : { roundCompletedEventId: completed.event_id }),
    startedEventId: started.event_id,
  };

  if (conflicts.length > 0) {
    return {
      ...base,
      status: 'EVIDENCE_CONFLICT',
      canFinalizeWithoutProvider: false,
      requiresHumanAcknowledgement: false,
    };
  }

  if (completed !== undefined) {
    const committed =
      state.round === round &&
      state.next_step_source_slot === slotField(completed, 'target_slot_id') &&
      state.pending_operation === null;
    return {
      ...base,
      status: committed ? 'NONE' : 'ROUND_COMPLETED_NEEDS_COMMIT',
      canFinalizeWithoutProvider: !committed,
      requiresHumanAcknowledgement: false,
    };
  }

  // Une résolution durable de CETTE tentative prime sur tout ce qui suit : son
  // issue est arrêtée, et ni un contexte survivant ni des faits préparatoires
  // ne peuvent la rouvrir. Sans cette règle, un acquittement déjà écrit
  // pouvait être redemandé — et dupliqué —, et un abandon finalisé se
  // rediagnostiquait indéfiniment (repair 1G.2).
  const resolution = resolutionOfAttempt(events, started, parties.sourceEventId);
  if (resolution !== undefined) {
    const committed = resolutionIsCommitted(state, events, resolution);
    return {
      ...base,
      resolutionEventId: resolution.event_id,
      status: committed ? 'NONE' : 'RESOLUTION_NEEDS_COMMIT',
      canFinalizeWithoutProvider: !committed,
      requiresHumanAcknowledgement: false,
    };
  }

  if (pending !== null) {
    const finalizable = response !== undefined;
    return {
      ...base,
      status: finalizable ? 'RESPONSE_NEEDS_FINALIZATION' : 'IN_FLIGHT_UNCERTAIN',
      canFinalizeWithoutProvider: finalizable,
      requiresHumanAcknowledgement: !finalizable,
    };
  }

  // Aucun contexte engagé. L'ordre durable prouve qu'aucun appel n'a eu lieu —
  // sauf si un échec déterministe l'a déjà conclu, auquel cas le run est stable.
  const settled = events.some(
    (event) => (event.type === 'process_failed' || event.type === 'transfer_blocked') && event.round >= round,
  );
  return {
    ...base,
    status: settled ? 'NONE' : 'PRE_PROVIDER_ABORTED',
    canFinalizeWithoutProvider: !settled,
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

async function loadNativeRun(deps: NativeStepRecoveryDeps, runId: string): Promise<LoadedNativeRun> {
  const paths = runPaths(deps.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Le run ${runId} est de génération ${persisted.execution_mode} : la reprise de transfert native ` +
        'ne le traite pas, et ne le convertit pas.',
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
export async function inspectNativeStepRecovery(
  deps: NativeStepRecoveryDeps,
  runId: string,
): Promise<NativeStepRecoveryView> {
  const loaded = await loadNativeRun(deps, runId);
  return buildNativeStepRecoveryView(loaded.paths, runId, loaded.manifest, loaded.state, loaded.history);
}

// --------------------------------------------------------------------------
// Verrou
// --------------------------------------------------------------------------

export interface NativeStepRecoveryOutcome {
  readonly runId: string;
  readonly view: NativeStepRecoveryView;
  readonly state: NativeRunStateDocument;
  readonly actions: readonly string[];
  readonly staleLock?: RunLockInfo;
}

async function withNativeRunLock<T>(
  deps: NativeStepRecoveryDeps,
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

// --------------------------------------------------------------------------
// Finalisation locale
// --------------------------------------------------------------------------

/**
 * Termine un transfert que les faits canoniques établissent déjà.
 *
 * Ne rappelle jamais un fournisseur — c'est structurellement impossible ici — et
 * n'écrit jamais deux fois le même fait : la classification est refaite **sous
 * le verrou**, et une seconde exécution retombe sur `NONE`.
 */
export interface NativeStepRecoverySeams {
  /** Après le marqueur de clôture, avant le commit d'état. */
  readonly afterResolutionJournaled?: () => void | Promise<void>;
}

export async function finalizeNativeStepRecovery(
  deps: NativeStepRecoveryDeps,
  runId: string,
  seams: NativeStepRecoverySeams = {},
  boundary?: NativeMutationBoundary,
): Promise<NativeStepRecoveryOutcome> {
  return withNativeRunLock(deps, runId, 'native-step-recover', boundary, async (staleLock, actions) => {
    const loaded = await loadNativeRun(deps, runId);
    let state = loaded.state;
    const view = await buildNativeStepRecoveryView(
      loaded.paths,
      runId,
      loaded.manifest,
      state,
      loaded.history,
    );

    if (view.status === 'EVIDENCE_CONFLICT') {
      throw new CcrError(
        'STATE_INVALID',
        `Le transfert du run ${runId} porte des faits contradictoires que l'ordre d'écriture rend ` +
          "impossibles. Aucune réparation n'est tentée : elle reviendrait à choisir entre deux affirmations.",
        { details: { runId, conflicts: [...view.conflicts] } },
      );
    }

    if (view.status === 'IN_FLIGHT_UNCERTAIN') {
      throw new CcrError(
        'RECOVERY_REQUIRED',
        `Un transfert vers « ${String(view.targetSlot)} » a été engagé sans réponse journalisée. ` +
          "CCR ne sait pas si l'appel a eu lieu : acquittez explicitement cette incertitude.",
        { details: { runId, source_event_id: view.sourceEventId ?? null } },
      );
    }

    if (view.status === 'NONE') {
      actions.push('Aucune reprise de transfert nécessaire.');
      return { runId, view, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
    }

    // ---- Résolution déjà durable : seul l'état restait à poser. Aucun
    // événement n'est ajouté, et surtout aucun second marqueur.
    if (view.status === 'RESOLUTION_NEEDS_COMMIT') {
      state = await persistNativeStateUpdate(
        loaded.paths,
        state,
        {
          state: 'PAUSED',
          control: 'HUMAN',
          activeExpertSlot: null,
          pendingOperation: null,
          uncertainty: null,
          ...(view.resolutionEventId === undefined ? {} : { lastEventId: view.resolutionEventId }),
        },
        deps.now(),
      );
      actions.push(
        `Résolution ${String(view.resolutionEventId)} déjà durable : seul l'état restait à poser. ` +
          'Run rendu en PAUSED / HUMAN.',
      );
      const settled = await buildNativeStepRecoveryView(
        loaded.paths,
        runId,
        loaded.manifest,
        state,
        await loaded.events.readAll(),
      );
      return { runId, view: settled, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
    }

    if (view.status === 'PRE_PROVIDER_ABORTED') {
      // Le contexte d'engagement est absent : l'ordre durable prouve qu'aucun
      // appel n'a été lancé. La source reste transférable ; seul le contrôle
      // revient à l'humain.
      //
      // La clôture est **durable** depuis le repair 1G.2 : sans preuve écrite,
      // les mêmes faits préparatoires rediagnostiquaient éternellement le même
      // abandon. Le marqueur nomme la tentative — l'ouverture de round qu'il
      // clôt — et non la seule source, qui peut être réessayée.
      const round = view.round;
      const sourceSlot = view.sourceSlot;
      const targetSlot = view.targetSlot;
      const sourceEventId = view.sourceEventId;
      const startedEventId = view.startedEventId;
      if (
        round === undefined ||
        sourceSlot === undefined ||
        targetSlot === undefined ||
        sourceEventId === undefined ||
        startedEventId === undefined
      ) {
        throw new CcrError('STATE_INVALID', `Faits de transfert incomplets pour le run ${runId}.`, {
          details: { runId, status: view.status },
        });
      }

      const aborted = await loaded.events.append({
        round,
        actor: 'system',
        type: 'transfer_aborted_before_provider',
        source_slot_id: sourceSlot,
        target_slot_id: targetSlot,
        source_event_id: sourceEventId,
        reason: 'PRE_PROVIDER_ABORTED',
        // Identité de la tentative close, et d'elle seule.
        based_on: [startedEventId],
        content: "Transfert abandonné : aucun appel fournisseur n'avait été engagé.",
        details: {
          basis: "Le contexte de reprise n'était pas persisté, or 1F le persiste avant tout appel.",
          provider_calls: 0,
          note: 'La source reste transférable : rien ne l’a consommée ni mise en quarantaine.',
        },
        timestamp: deps.now().toISOString(),
      });
      await seams.afterResolutionJournaled?.();

      state = await persistNativeStateUpdate(
        loaded.paths,
        state,
        {
          state: 'PAUSED',
          control: 'HUMAN',
          activeExpertSlot: null,
          pendingOperation: null,
          lastEventId: aborted.event_id,
        },
        deps.now(),
      );
      actions.push(
        `Transfert abandonné avant tout appel fournisseur (round ${String(round)}). ` +
          'Run rendu en PAUSED / HUMAN, source non consommée.',
      );
      const after = await buildNativeStepRecoveryView(
        loaded.paths,
        runId,
        loaded.manifest,
        state,
        await loaded.events.readAll(),
      );
      return { runId, view: after, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
    }

    const round = view.round;
    const sourceSlot = view.sourceSlot;
    const targetSlot = view.targetSlot;
    const sourceEventId = view.sourceEventId;
    const responseEventId = view.responseEventId;
    if (
      round === undefined ||
      sourceSlot === undefined ||
      targetSlot === undefined ||
      sourceEventId === undefined ||
      responseEventId === undefined
    ) {
      throw new CcrError('STATE_INVALID', `Faits de transfert incomplets pour le run ${runId}.`, {
        details: { runId, status: view.status },
      });
    }

    // ---- Finalisation canonique, écrite une seule fois.
    let completedEventId = view.roundCompletedEventId;
    if (completedEventId === undefined) {
      const completed = await loaded.events.append({
        round,
        actor: 'system',
        type: 'round_completed',
        source_slot_id: sourceSlot,
        target_slot_id: targetSlot,
        source_event_id: sourceEventId,
        response_event_id: responseEventId,
        based_on: [sourceEventId, responseEventId],
        timestamp: deps.now().toISOString(),
      });
      completedEventId = completed.event_id;
      actions.push(`Transfert finalisé depuis la réponse déjà journalisée ${responseEventId}.`);
    } else {
      actions.push(`Transfert déjà finalisé (${completedEventId}) : seul l'état restait à commiter.`);
    }

    // ---- Projection diagnostique, reconstruite seulement si elle est dérivable.
    if (view.diagnosticRound !== 'MATCHING') {
      const history = await loaded.events.readAll();
      const prompt = history.find(
        (event) => event.type === 'prompt_sent' && event.round === round,
      );
      const response = history.find((event) => event.event_id === responseEventId);
      if (prompt !== undefined && response !== undefined) {
        await writeNativeRoundMetadata(loaded.paths, {
          schema_version: NATIVE_ROUND_SCHEMA_VERSION,
          run_id: runId,
          round,
          started_at: prompt.timestamp,
          completed_at: response.timestamp,
          workspace_cwd: loaded.manifest.workspace.cwd,
          source_slot: sourceSlot,
          target_slot: targetSlot,
          source_event_id: sourceEventId,
          response_event_id: responseEventId,
          turns: [
            {
              expert_slot: targetSlot,
              prompt_event_id: prompt.event_id,
              response_event_id: responseEventId,
              started_at: prompt.timestamp,
              completed_at: response.timestamp,
              provider: loaded.manifest.experts[targetSlot].provider,
            },
          ],
        });
        // Les sorties brutes du processus ne sont nulle part dans le journal :
        // elles sont perdues, et ne sont pas inventées.
        actions.push('Métadonnées de round reconstruites ; sorties brutes non recréées (perdues).');
      } else {
        actions.push('ROUND_ARTIFACT_INCOMPLETE : diagnostic non reconstructible, état finalisé quand même.');
      }
    }

    // ---- Commit. L'humain garde la main.
    state = await persistNativeStateUpdate(
      loaded.paths,
      state,
      {
        state: 'READY',
        control: 'HUMAN',
        round,
        nextStepSourceSlot: targetSlot,
        activeExpertSlot: null,
        pendingOperation: null,
        lastEventId: completedEventId,
      },
      deps.now(),
    );
    actions.push(`Round ${String(round)} commité, curseur sur « ${targetSlot} ». Run en READY / HUMAN.`);

    const after = await buildNativeStepRecoveryView(
      loaded.paths,
      runId,
      loaded.manifest,
      state,
      await loaded.events.readAll(),
    );
    return { runId, view: after, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
  });
}

// --------------------------------------------------------------------------
// Acquittement et quarantaine
// --------------------------------------------------------------------------

/**
 * Acquitte l'incertitude d'un transfert engagé, et met sa source en quarantaine.
 *
 * Effacer simplement le contexte rendrait la source à nouveau planifiable — et
 * le prochain transfert la rejouerait, présentant un appel peut-être consommé
 * comme s'il n'avait pas eu lieu. La quarantaine est donc **durable**, portée
 * par un événement canonique que le planificateur consulte.
 *
 * Ce que l'événement ne dit pas : que le fournisseur n'a pas répondu, que
 * l'appel n'a pas été consommé, ou que le transfert a réussi.
 */
export async function acknowledgeNativeStepUncertainty(
  deps: NativeStepRecoveryDeps,
  runId: string,
  note: string,
  boundary?: NativeMutationBoundary,
): Promise<NativeStepRecoveryOutcome> {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new CcrError('INVALID_ARGUMENT', "L'acquittement d'une incertitude exige une note explicite.", {
      details: { runId },
    });
  }

  return withNativeRunLock(deps, runId, 'native-step-acknowledge', boundary, async (staleLock, actions) => {
    const loaded = await loadNativeRun(deps, runId);
    let state = loaded.state;
    const view = await buildNativeStepRecoveryView(
      loaded.paths,
      runId,
      loaded.manifest,
      state,
      loaded.history,
    );

    if (view.status !== 'IN_FLIGHT_UNCERTAIN') {
      throw new CcrError(
        'INVALID_ARGUMENT',
        `Le run ${runId} n'a aucun transfert d'issue inconnue à acquitter (statut ${view.status}).`,
        { details: { runId, status: view.status } },
      );
    }

    const pending = stepPendingOf(state);
    if (pending === null) {
      throw new CcrError('STATE_INVALID', `Le contexte de transfert du run ${runId} a disparu.`, {
        details: { runId },
      });
    }

    const event = await loaded.events.append({
      round: pending.round,
      actor: 'human',
      type: 'transfer_uncertainty_acknowledged',
      source_slot_id: pending.source_slot,
      target_slot_id: pending.target_slot,
      source_event_id: pending.source_event_id,
      reason: 'IN_FLIGHT_UNCERTAIN',
      // Fidélité de provenance (repair IMP-15.1) : `trimmed` **valide**, il ne
      // transforme pas. Une affirmation humaine est persistée telle qu'elle a
      // été écrite — bordures comprises. Rogner reviendrait à réécrire un fait
      // de provenance pour une raison purement cosmétique.
      content: note,
      based_on: [pending.source_event_id],
      details: {
        conclusion: "Aucune : CCR n'a pas déterminé si l'appel a eu lieu.",
        note: "L'acquittement ne prétend ni que l'appel a eu lieu, ni le contraire.",
        operation_started_at: pending.started_at,
        operation_prompt_event_id: pending.prompt_event_id,
      },
      timestamp: deps.now().toISOString(),
    });

    // Ni `round` ni curseur ne bougent : aucun transfert n'a abouti.
    state = await persistNativeStateUpdate(
      loaded.paths,
      state,
      {
        state: 'PAUSED',
        control: 'HUMAN',
        activeExpertSlot: null,
        pendingOperation: null,
        uncertainty: null,
        lastEventId: event.event_id,
      },
      deps.now(),
    );
    actions.push(
      `Incertitude acquittée. La source ${pending.source_event_id} est mise en quarantaine : ` +
        'elle ne sera pas rejouée.',
    );

    const after = await buildNativeStepRecoveryView(
      loaded.paths,
      runId,
      loaded.manifest,
      state,
      await loaded.events.readAll(),
    );
    return { runId, view: after, state, actions, ...(staleLock === undefined ? {} : { staleLock }) };
  });
}
