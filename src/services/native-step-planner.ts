/**
 * Décision de transfert d'un run **natif V2.1** (Slice 1E).
 *
 * Ce module décide, il n'exécute pas. Il ne lance aucun expert, n'écrit aucun
 * fichier, n'avance aucun curseur : il calcule ce qu'un transfert serait, à
 * partir des seuls faits canoniques.
 *
 * ## La règle que tout le reste sert
 *
 * ```text
 * state.next_step_source_slot   est l'autorité de direction
 * target = otherExpertSlot(source)
 * ```
 *
 * La direction ne se déduit **jamais** du dernier événement, du fournisseur qui
 * l'a produit, de la parité de `state.round`, de l'ordre de création des
 * sessions ni d'une règle « l'autre moteur ». C'est exactement le couplage que
 * V2.1 supprime : `counterpartOf` n'apparaît nulle part ici, et ne peut pas y
 * apparaître — il répond « l'autre fournisseur », ce qui n'a pas de cible
 * lorsque les deux experts partagent le même moteur.
 *
 * ## Conséquence immédiate, et contre-intuitive
 *
 * Après un START, la réponse du CHALLENGER est la plus récente du journal.
 * Le premier transfert part pourtant de l'AUTHOR : les deux positions initiales
 * sont indépendantes, et la plus récente n'est pas la source attendue.
 *
 * ## Ce qui est repris tel quel de V2
 *
 * La sémantique de source consommée, le garde-fou de taille et les gardes de
 * contrôle/état sont ceux de `planStepTransfer` et de `stepGuard`. Ils ne sont
 * pas reformulés : seule leur clé d'identité change — un slot, plus un moteur.
 */

import { CcrError } from '../core/errors.ts';
import { otherExpertSlot } from '../core/expert.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type { NativeCcrEvent, NativeRunManifest, NativeRunStateDocument } from '../core/run-native.ts';
import { stepGuard } from '../core/run-guards.ts';
import type { RunGuardFacts } from '../core/run-guards.ts';
import { runPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import {
  CROSS_REVIEW_INSTRUCTION,
  DEFAULT_MAX_TRANSFER_BYTES,
  beginMarker,
  endMarker,
  utf8ByteLength,
} from './transfer.ts';
import type { RunServiceDeps } from './run-service.ts';

// --------------------------------------------------------------------------
// Enveloppe cognitive
// --------------------------------------------------------------------------

export interface NativeTransferEnvelopeInput {
  readonly runId: string;
  readonly round: number;
  readonly sourceSlot: ExpertSlotId;
  readonly sourceProvider: ProviderKind;
  readonly targetSlot: ExpertSlotId;
  readonly targetProvider: ProviderKind;
  readonly sourceEventId: string;
  readonly content: string;
}

/**
 * Construit le message transmis à l'expert cible.
 *
 * L'enveloppe V2 annonçait `SOURCE: CLAUDE`. En same-provider, les deux experts
 * s'annonçaient identiquement : la provenance était corrigée partout **sauf**
 * là où elle agit, dans le texte que le modèle lit.
 *
 * L'identité épistémique vient donc en premier, et le moteur reste un fait
 * technique complémentaire — un expert peut légitimement savoir avec quel
 * moteur son contradicteur a répondu.
 *
 * Aucun `session_id` n'est injecté : c'est un identifiant d'orchestration, sans
 * valeur cognitive, dont l'exposition n'apporterait rien au raisonnement.
 *
 * Le contenu source est transmis **verbatim**, comme en V1 : CCR n'a pas le
 * droit de résumer, corriger ni extraire ce qu'il juge pertinent.
 */
export function buildNativeTransferEnvelope(input: NativeTransferEnvelopeInput): string {
  return [
    `SOURCE_EXPERT: ${input.sourceSlot.toUpperCase()}`,
    `SOURCE_PROVIDER: ${input.sourceProvider.toUpperCase()}`,
    `TARGET_EXPERT: ${input.targetSlot.toUpperCase()}`,
    `TARGET_PROVIDER: ${input.targetProvider.toUpperCase()}`,
    `RUN: ${input.runId}`,
    `ROUND: ${String(input.round)}`,
    `SOURCE_EVENT_ID: ${input.sourceEventId}`,
    `CONTENT_BYTES: ${String(utf8ByteLength(input.content))}`,
    '',
    beginMarker(input.sourceEventId),
    input.content,
    endMarker(input.sourceEventId),
    '',
    CROSS_REVIEW_INSTRUCTION,
  ].join('\n');
}

// --------------------------------------------------------------------------
// Plan
// --------------------------------------------------------------------------

/** Faits communs aux deux issues où source et cible sont déterminées. */
export interface NativeTransferParties {
  readonly runId: string;
  readonly sourceSlot: ExpertSlotId;
  readonly targetSlot: ExpertSlotId;
  readonly sourceProvider: ProviderKind;
  readonly targetProvider: ProviderKind;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly sourceEventId: string;
  readonly sourceContent: string;
  readonly nextRoundNumber: number;
  readonly payloadBytes: number;
  readonly limitBytes: number;
}

export type NativeStepRefusalReason =
  | 'RECOVERY_REQUIRED'
  | 'SOURCE_NOT_REPLAYABLE'
  | 'SESSION_MISSING'
  | 'SESSION_ID_COLLISION'
  | 'AUTOMATION_NOT_IN_CONTROL'
  | 'ILLEGAL_STATE_TRANSITION'
  | 'NO_TRANSFERABLE_SOURCE'
  | 'SOURCE_ALREADY_TRANSFERRED'
  | 'SOURCE_STALE_AFTER_HANDOFF';

/**
 * Union discriminée plutôt qu'accumulation de champs optionnels.
 *
 * Un refus survenu avant la détermination des parties n'a pas de source à
 * exposer ; lui donner des champs vides laisserait un lecteur les interpréter.
 */
export type NativeStepPlan =
  | ({ readonly kind: 'READY'; readonly envelope: string } & NativeTransferParties)
  | ({ readonly kind: 'PAYLOAD_TOO_LARGE'; readonly error: CcrError } & NativeTransferParties)
  | {
      readonly kind: 'REFUSED';
      readonly reason: NativeStepRefusalReason;
      /** Erreur exacte que le service d'exécution lèvera, inchangée. */
      readonly error: CcrError;
    };

export interface NativeStepPlanInput {
  readonly runId: string;
  readonly manifest: NativeRunManifest;
  readonly state: NativeRunStateDocument;
  readonly events: readonly NativeCcrEvent[];
  readonly maxTransferBytes?: number;
}

function refuse(reason: NativeStepRefusalReason, error: CcrError): NativeStepPlan {
  return { kind: 'REFUSED', reason, error };
}

function slotOf(event: NativeCcrEvent, field: string): ExpertSlotId | null {
  const value = (event as unknown as Record<string, unknown>)[field];
  return value === 'author' || value === 'challenger' ? value : null;
}

/**
 * Dernière réponse transférable **du slot attendu**.
 *
 * Jamais la dernière réponse du journal : c'est la faute exacte que le premier
 * transfert d'un run révèle, puisque la position initiale du CHALLENGER y est
 * toujours la plus récente.
 *
 * Un candidat doit porter le slot source, un contenu non vide, et la session
 * réellement liée à ce slot — une réponse dont la session ne correspond plus au
 * binding n'est pas une source, c'est une incohérence.
 */
function findNativeSource(
  events: readonly NativeCcrEvent[],
  slot: ExpertSlotId,
  boundSession: string,
): NativeCcrEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== 'assistant_response') continue;
    if (slotOf(event, 'expert_slot_id') !== slot) continue;
    if (typeof event.content !== 'string' || event.content.length === 0) continue;
    if ((event as { session_id?: string }).session_id !== boundSession) continue;
    return event;
  }
  return undefined;
}

/**
 * Faits qui périment la dernière position connue d'un expert (Slice 2C-R).
 *
 * Une interaction native a pu être engagée hors du journal CCR. À partir de là,
 * la session du slot **peut** avoir avancé, et CCR ne prétend pas savoir où elle
 * en est : il n'a jamais lu le transcript.
 *
 * ```text
 * human_handoff_finished             l'interaction a eu lieu, contenu inconnu
 * handoff_uncertainty_acknowledged   elle a peut-être eu lieu, contenu inconnu
 * ```
 *
 * N'en font **pas** partie, et c'est aussi important :
 *
 * ```text
 * handoff_aborted_before_interactive   le client n'a certainement pas été lancé
 * process_failed (phase handoff)       le lancement a échoué, rien n'a vécu
 * ```
 *
 * Périmer une source alors que CCR **sait** qu'aucune interaction n'a eu lieu
 * serait aussi faux que l'inverse.
 */
const HANDOFF_BARRIER_EVENT_TYPES: readonly string[] = [
  'human_handoff_finished',
  'handoff_uncertainty_acknowledged',
];

/**
 * Position canonique de la dernière barrière externe d'un slot, ou `-1`.
 *
 * « Postérieure » se lit dans l'**ordre append-only du journal**, et nulle part
 * ailleurs : ni horodatage, ni identifiant lexical, ni round, ni date de
 * fichier. Les opérations sont sérialisées par le verrou de run ; l'ordre du
 * journal est la preuve.
 *
 * La barrière est strictement **par slot** : un handoff sur le contradicteur ne
 * périme pas la position de l'auteur. En same-provider non plus — l'identité
 * est le slot, jamais le moteur.
 */
function latestHandoffBarrierIndex(events: readonly NativeCcrEvent[], slot: ExpertSlotId): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || !HANDOFF_BARRIER_EVENT_TYPES.includes(event.type)) continue;
    if (slotOf(event, 'target_expert_slot_id') !== slot) continue;
    return index;
  }
  return -1;
}

/**
 * Une source déjà consommée par un transfert **finalisé**.
 *
 * La preuve canonique est `round_completed.source_event_id`, champ de premier
 * niveau depuis 1B. `rounds/` n'est jamais consulté : il reste diagnostique et
 * non canonique, et le faire arbitrer une décision d'état reviendrait à lui
 * donner une autorité qu'il n'a pas.
 */
function isConsumed(events: readonly NativeCcrEvent[], sourceEventId: string): boolean {
  return events.some(
    (event) =>
      event.type === 'round_completed' &&
      (event as { source_event_id?: string }).source_event_id === sourceEventId,
  );
}

/**
 * Une source mise en quarantaine après une incertitude acquittée.
 *
 * Distincte d'une source consommée : celle-ci a produit un round abouti,
 * celle-là a été engagée dans un transfert dont l'issue reste inconnue. Les
 * rejouer serait faux pour deux raisons différentes, et le refus doit le dire.
 */
function isQuarantined(events: readonly NativeCcrEvent[], sourceEventId: string): boolean {
  return events.some(
    (event) =>
      event.type === 'transfer_uncertainty_acknowledged' &&
      (event as { source_event_id?: string }).source_event_id === sourceEventId,
  );
}

/**
 * Calcule le transfert que `step` engagerait, sans rien engager.
 *
 * Fonction pure : même instantané, même plan.
 */
export function planNativeStep(input: NativeStepPlanInput): NativeStepPlan {
  const { runId, manifest, state, events } = input;

  // ---- 1. Aucune opération en vol, aucune ambiguïté persistée.
  //
  // Une source engagée dans une opération dont CCR ignore l'issue ne doit
  // surtout pas être resélectionnée : ce serait présenter un appel peut-être
  // consommé comme s'il n'avait pas eu lieu (doctrine 1D).
  if (state.pending_operation !== null) {
    const pending = state.pending_operation;
    return refuse(
      'RECOVERY_REQUIRED',
      new CcrError(
        'RECOVERY_REQUIRED',
        `Une opération « ${pending.kind} » est engagée sur le run ${runId}. Aucun transfert n'est ` +
          "planifiable tant que son issue n'est pas établie.",
        {
          details: {
            runId,
            operation: pending.kind,
            source_event_id: pending.kind === 'step' ? pending.source_event_id : null,
          },
        },
      ),
    );
  }
  if (state.uncertainty !== null) {
    return refuse(
      'RECOVERY_REQUIRED',
      new CcrError(
        'RECOVERY_REQUIRED',
        `Le run ${runId} porte une incertitude non acquittée. Un transfert la contournerait.`,
        { details: { runId, expert_slot: state.uncertainty.expert_slot } },
      ),
    );
  }

  // ---- 2. Les deux experts existent réellement.
  const author = manifest.experts.author;
  const challenger = manifest.experts.challenger;
  const missing = (author.session_id === null ? ['author'] : []).concat(
    challenger.session_id === null ? ['challenger'] : [],
  );
  if (missing.length > 0) {
    return refuse(
      'SESSION_MISSING',
      new CcrError(
        'SESSION_MISSING',
        `Le run ${runId} n'a pas de session native pour ${missing.join(' et ')}.`,
        { details: { runId, missing_slots: missing } },
      ),
    );
  }
  if (author.provider === challenger.provider && author.session_id === challenger.session_id) {
    return refuse(
      'SESSION_ID_COLLISION',
      new CcrError(
        'SESSION_ID_COLLISION',
        `Les deux experts du run ${runId} partagent l'identité native ` +
          `(${author.provider}, ${String(author.session_id)}) : aucun transfert n'a de sens entre eux.`,
        { details: { runId, provider: author.provider, session_id: author.session_id } },
      ),
    );
  }

  // ---- 3. Le curseur, seule autorité de direction.
  const sourceSlot = state.next_step_source_slot;
  if (sourceSlot === null) {
    return refuse(
      'RECOVERY_REQUIRED',
      new CcrError(
        'RECOVERY_REQUIRED',
        `Le run ${runId} n'a pas de curseur d'alternance : son initialisation n'a jamais été ` +
          'finalisée. Aucune direction ne peut en être déduite.',
        { details: { runId, state: state.state } },
      ),
    );
  }
  const targetSlot = otherExpertSlot(sourceSlot);

  // ---- 4. Gardes de contrôle et d'état, celles de V2, inchangées.
  const facts: RunGuardFacts = {
    state: state.state,
    control: state.control,
    requiresRecovery: false,
  };
  const verdict = stepGuard(facts);
  if (verdict.kind === 'REFUSED') {
    const reason = verdict.reason === 'AUTOMATION_NOT_IN_CONTROL'
      ? 'AUTOMATION_NOT_IN_CONTROL'
      : 'ILLEGAL_STATE_TRANSITION';
    return refuse(
      reason,
      new CcrError(
        reason,
        reason === 'AUTOMATION_NOT_IN_CONTROL'
          ? `Le run ${runId} est sous contrôle ${state.control} : l'automatisation ne produit pas de tour.`
          : `Le run ${runId} est en ${state.state} : aucun tour ne peut en partir.`,
        { details: { runId, state: state.state, control: state.control } },
      ),
    );
  }

  // ---- 5. La source, dans le slot attendu et nulle part ailleurs.
  const sourceSessionId = manifest.experts[sourceSlot].session_id as string;
  const candidate = findNativeSource(events, sourceSlot, sourceSessionId);
  if (candidate === undefined) {
    return refuse(
      'NO_TRANSFERABLE_SOURCE',
      new CcrError(
        'NO_TRANSFERABLE_SOURCE',
        `Aucune réponse transférable de « ${sourceSlot} » dans le journal du run ${runId}. ` +
          "Aucun prompt n'est inventé, et la réponse de l'autre expert n'est pas une source.",
        { details: { runId, source_slot: sourceSlot, event_count: events.length } },
      ),
    );
  }

  // Une source quarantainée n'est pas une source consommée : elle a été engagée
  // dans un transfert dont l'issue est inconnue. Comme pour une source
  // consommée, la recherche ne remonte pas vers une réponse plus ancienne — il
  // faut une **nouvelle** réponse de cet expert.
  if (isQuarantined(events, candidate.event_id)) {
    return refuse(
      'SOURCE_NOT_REPLAYABLE',
      new CcrError(
        'SOURCE_NOT_REPLAYABLE',
        `La réponse ${candidate.event_id} de « ${sourceSlot} » a été engagée dans un transfert dont ` +
          "l'issue est inconnue, puis mise en quarantaine. CCR ne la rejoue pas : une nouvelle " +
          'réponse de cet expert est nécessaire.',
        { details: { runId, source_event_id: candidate.event_id, source_slot: sourceSlot } },
      ),
    );
  }

  // Sémantique V2, appliquée par slot : seule la dernière réponse du slot est
  // considérée. Consommée, la recherche ne remonte pas — transférer une réponse
  // plus ancienne après une plus récente serait un ping-pong involontaire.
  if (isConsumed(events, candidate.event_id)) {
    return refuse(
      'SOURCE_ALREADY_TRANSFERRED',
      new CcrError(
        'SOURCE_ALREADY_TRANSFERRED',
        `La réponse ${candidate.event_id} de « ${sourceSlot} » a déjà été transférée. ` +
          'Attendez une nouvelle réponse de cet expert.',
        { details: { runId, source_event_id: candidate.event_id, source_slot: sourceSlot } },
      ),
    );
  }

  // Une interaction native postérieure périme la position : elle n'a pas été
  // consommée, elle n'a pas été quarantainée, elle n'est simplement plus une
  // preuve suffisante de ce que l'expert pense maintenant. La recherche ne
  // remonte pas vers une réponse plus ancienne : elle précède la même
  // divergence externe. Seule une **nouvelle** réponse canonique rétablit
  // l'ancrage.
  const barrierIndex = latestHandoffBarrierIndex(events, sourceSlot);
  const candidateIndex = events.findIndex((event) => event.event_id === candidate.event_id);
  if (barrierIndex > candidateIndex) {
    const barrier = events[barrierIndex];
    return refuse(
      'SOURCE_STALE_AFTER_HANDOFF',
      new CcrError(
        'SOURCE_STALE_AFTER_HANDOFF',
        `La réponse ${candidate.event_id} de « ${sourceSlot} » précède une interaction native externe ` +
          `(${String(barrier?.type)} ${String(barrier?.event_id)}). La session de cet expert a pu avancer ` +
          "hors du journal CCR : CCR ne transfère pas une position qu'il ne peut plus garantir. Une " +
          'nouvelle réponse de cet expert est nécessaire.',
        {
          details: {
            runId,
            source_event_id: candidate.event_id,
            source_slot: sourceSlot,
            barrier_event_id: barrier?.event_id ?? null,
            barrier_type: barrier?.type ?? null,
          },
        },
      ),
    );
  }

  // ---- 6. Parties, enveloppe et garde-fou de taille.
  const nextRoundNumber = state.round + 1;
  const sourceContent = candidate.content as string;
  const envelope = buildNativeTransferEnvelope({
    runId,
    round: nextRoundNumber,
    sourceSlot,
    sourceProvider: manifest.experts[sourceSlot].provider,
    targetSlot,
    targetProvider: manifest.experts[targetSlot].provider,
    sourceEventId: candidate.event_id,
    content: sourceContent,
  });
  const limitBytes = input.maxTransferBytes ?? DEFAULT_MAX_TRANSFER_BYTES;
  const payloadBytes = utf8ByteLength(envelope);

  const parties: NativeTransferParties = {
    runId,
    sourceSlot,
    targetSlot,
    sourceProvider: manifest.experts[sourceSlot].provider,
    targetProvider: manifest.experts[targetSlot].provider,
    sourceSessionId,
    targetSessionId: manifest.experts[targetSlot].session_id as string,
    sourceEventId: candidate.event_id,
    sourceContent,
    nextRoundNumber,
    payloadBytes,
    limitBytes,
  };

  if (payloadBytes > limitBytes) {
    return {
      kind: 'PAYLOAD_TOO_LARGE',
      ...parties,
      error: new CcrError(
        'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
        `Transfert de ${String(payloadBytes)} octets refusé (limite ${String(limitBytes)}). ` +
          "Le contenu source est conservé intact ; la décision revient à l'humain.",
        {
          details: {
            runId,
            bytes: payloadBytes,
            limit: limitBytes,
            source_slot: sourceSlot,
            target_slot: targetSlot,
            source_event_id: candidate.event_id,
          },
        },
      ),
    };
  }

  return { kind: 'READY', ...parties, envelope };
}

// --------------------------------------------------------------------------
// Lecture d'un run
// --------------------------------------------------------------------------

/**
 * Planifie depuis les fichiers du run, **sans rien écrire**.
 *
 * Aucun verrou n'est pris : la lecture d'un journal append-only tolère déjà un
 * append concurrent, et prendre un verrou pour une décision sans effet le
 * retiendrait sans raison.
 */
export async function planNativeStepForRun(
  deps: RunServiceDeps,
  runId: string,
  options: { readonly maxTransferBytes?: number } = {},
): Promise<NativeStepPlan> {
  const paths = runPaths(deps.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Le run ${runId} est de génération ${persisted.execution_mode} : le planificateur natif ne le ` +
        'traite pas, et ne projette pas son transfert dans le protocole par slot.',
      { details: { runId, execution_mode: persisted.execution_mode } },
    );
  }
  const stateDoc = await readPersistedState(paths);
  if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
      details: { runId },
    });
  }

  const events = await (await openNativeEventStore(paths, persisted.manifest)).readAll();
  return planNativeStep({
    runId,
    manifest: persisted.manifest,
    state: stateDoc.document,
    events,
    ...(options.maxTransferBytes === undefined
      ? deps.maxTransferBytes === undefined
        ? {}
        : { maxTransferBytes: deps.maxTransferBytes }
      : { maxTransferBytes: options.maxTransferBytes }),
  });
}
