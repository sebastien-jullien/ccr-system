/**
 * Normalisation « faits internes → activité durable publique » (F2).
 *
 * Ce module est la **couche de normalisation** exigée par le contrat, et il
 * n'est rien d'autre : il ne lit aucun fichier, n'ouvre aucun verrou, ne sonde
 * aucun fournisseur, et ne persiste rien.
 *
 * ```text
 * ÉVÉNEMENT INTERNE   ≠   ACTIVITÉ F2 PUBLIQUE
 * ```
 *
 * Aucun événement ne devient automatiquement une activité. Une activité
 * logique agrège **plusieurs** faits durables — sa demande, sa réponse, ses
 * marqueurs de clôture, et les tentatives qui l'ont précédée — et conserve la
 * même identité publique à travers toutes.
 *
 * ## Les trois familles sélectionnées, et elles seules
 *
 * ```text
 * RUN_START     l'initialisation native du run, prise comme UNE activité
 * NATIVE_STEP   un passage de témoin logique, identifié par son round
 * HUMAN_SEND    un envoi humain vers un expert, qui ne consomme aucun round
 * ```
 *
 * Un handoff n'appartient à aucune de ces familles : ses faits sont
 * explicitement hors périmètre, et leur présence n'entame pas la complétude.
 *
 * ## Ce que ce module n'expose jamais
 *
 * ```text
 * evt_*                    aucun identifiant d'événement interne ne sort
 * charges utiles           aucun contenu, aucun `details`, aucun `reason`
 * reprises                 aucun détail de recovery
 * fournisseur / session    aucun moteur, aucun identifiant natif
 * invocation_id            aucune identité d'invocation
 * ```
 *
 * ## Jamais de devinette
 *
 * Un rôle, un ordre ou un rattachement qui ne peut pas être établi depuis les
 * faits durables rend la projection **indisponible**. Il n'est jamais déduit
 * d'un fournisseur, jamais reconstitué par proximité, jamais complété par
 * défaut. Une reconstruction partielle n'existe pas.
 */

import { createHash } from 'node:crypto';

import { isExpertSlotId } from '../core/expert.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import type { NativeCcrEvent, NativeRunStateDocument } from '../core/run-native.ts';

// --------------------------------------------------------------------------
// Contrat public de la projection
// --------------------------------------------------------------------------

/** Vocabulaire fermé de disposition procédurale. Aucune valeur hors liste. */
export const PROCEDURAL_DISPOSITIONS = [
  'IN_PROGRESS',
  'COMPLETED',
  'NOT_COMPLETED',
  'UNCERTAIN',
] as const;

export type ProceduralDisposition = (typeof PROCEDURAL_DISPOSITIONS)[number];

/** Genres d'activité publiés par F2 v1. */
export const ACTIVITY_KINDS = ['RUN_START', 'NATIVE_STEP', 'HUMAN_SEND'] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Une activité durable publique — **union discriminée**, jamais un sac de
 * champs nullables.
 *
 * Un champ non applicable est structurellement **absent** de sa variante :
 * `RUN_START` n'a ni rôle ni round, `HUMAN_SEND` n'a ni source ni round.
 * Les rendre nuls donnerait à lire « pas de source » comme une source vide.
 */
export type RunActivity =
  | {
      readonly activity_id: string;
      readonly sequence: number;
      readonly activity_kind: 'RUN_START';
      readonly procedural_disposition: ProceduralDisposition;
    }
  | {
      readonly activity_id: string;
      readonly sequence: number;
      readonly activity_kind: 'NATIVE_STEP';
      readonly procedural_disposition: ProceduralDisposition;
      readonly source_role: ExpertSlotId;
      readonly target_role: ExpertSlotId;
      readonly round: number;
    }
  | {
      readonly activity_id: string;
      readonly sequence: number;
      readonly activity_kind: 'HUMAN_SEND';
      readonly procedural_disposition: ProceduralDisposition;
      readonly target_role: ExpertSlotId;
    };

/**
 * Issue de la normalisation.
 *
 * `UNAVAILABLE` dit une chose exacte : l'histoire durable requise par F2 ne
 * peut pas être reconstruite **complètement**. Ce n'est ni une histoire vide,
 * ni un échec de lecture.
 *
 * `PROJECTION_FAILURE` en dit une autre, et n'en est pas un synonyme :
 * l'histoire logique **est** connue, mais aucune représentation publique
 * valide et complète ne peut en être produite de façon fiable.
 */
export type RunActivityProjection =
  | { readonly status: 'AVAILABLE'; readonly activities: readonly RunActivity[] }
  | { readonly status: 'UNAVAILABLE' }
  | { readonly status: 'PROJECTION_FAILURE' };

/**
 * Couture interne de dérivation d'identité.
 *
 * Elle n'existe que pour rendre la garantie d'unicité **démontrable** : sans
 * elle, la seule façon de prouver le comportement en collision serait de
 * chercher une collision de SHA-256, ce qui ne se fait pas.
 *
 * ```text
 * SURFACE PUBLIQUE    aucune — ni CLI, ni document machine, ni HTTP
 * SÉMANTIQUE          inchangée — le défaut est la dérivation réelle
 * OPACITÉ             inchangée — la couture ne rend rien de plus lisible
 * ```
 *
 * Aucun chemin de production ne la renseigne.
 */
export interface RunActivityProjectionSeams {
  readonly deriveActivityId?: (runId: string, logicalKey: string) => string;
}

// --------------------------------------------------------------------------
// Identité publique
// --------------------------------------------------------------------------

/**
 * Espace de nommage de l'identité publique.
 *
 * Il fait partie du calcul : deux versions de la normalisation ne doivent pas
 * pouvoir produire par accident la même identité pour deux notions
 * différentes.
 */
const ACTIVITY_ID_NAMESPACE = 'ccr.run-activity.v1';

/**
 * Identité publique **opaque** d'une activité logique.
 *
 * Dérivée d'une **clé logique** — le genre d'activité et ce qui l'individualise
 * durablement — jamais d'un identifiant interne :
 *
 * ```text
 * RUN_START     « il n'y en a qu'une »
 * NATIVE_STEP   son round logique
 * HUMAN_SEND    son rang parmi les envois humains du run
 * ```
 *
 * Conséquences voulues :
 *
 * ```text
 * STABLE      la clé logique ne bouge pas d'une lecture à l'autre
 * STABLE      une tentative, une reprise ou une résolution rejoint la même clé
 * UNIQUE      deux activités logiques distinctes ont deux clés distinctes
 * OPAQUE      ce n'est ni un `evt_*`, ni un `invocation_id`, ni une session
 * ```
 *
 * Le `run_id` entre dans le calcul : deux runs ne partagent aucune identité
 * d'activité, même à round égal.
 */
function activityIdFor(runId: string, logicalKey: string): string {
  const digest = createHash('sha256')
    .update(`${ACTIVITY_ID_NAMESPACE}|${runId}|${logicalKey}`)
    .digest('hex');
  return `act_${digest.slice(0, 24)}`;
}

// --------------------------------------------------------------------------
// Lecture prudente des faits d'événement
// --------------------------------------------------------------------------

/**
 * Champ de slot, lu sans présumer de la variante d'événement.
 *
 * Le journal a déjà été validé par sa forme canonique ; cette lecture ne
 * revalide pas, elle **refuse** simplement de traiter une valeur qui n'est pas
 * un slot connu. Rendre `null` ici mène à l'indisponibilité, jamais à une
 * valeur inventée.
 */
function slotField(event: NativeCcrEvent, field: string): ExpertSlotId | null {
  const value = (event as unknown as Record<string, unknown>)[field];
  return isExpertSlotId(value) ? value : null;
}

function stringField(event: NativeCcrEvent, field: string): string | null {
  const value = (event as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

function basedOnOf(event: NativeCcrEvent): readonly string[] {
  const value = (event as unknown as Record<string, unknown>)['based_on'];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// --------------------------------------------------------------------------
// Familles d'événements
// --------------------------------------------------------------------------

/**
 * Faits durables **hors des trois familles F2**.
 *
 * Leur présence ne rend jamais la projection incomplète : ils ne décrivent
 * aucune des trois activités sélectionnées. Les nommer explicitement évite de
 * confondre « hors périmètre » et « non rattaché », qui n'ont pas la même
 * conséquence.
 */
const OUT_OF_FAMILY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'human_handoff_started',
  'human_handoff_finished',
  'handoff_aborted_before_interactive',
  'handoff_uncertainty_acknowledged',
  'control_changed',
  'state_changed',
  'run_paused',
  'run_resumed',
  'run_completed',
  'decision_recorded',
  'runtime_config_changed',
]);

// --------------------------------------------------------------------------
// Brouillons d'activité
// --------------------------------------------------------------------------

/**
 * Marqueur qu'un fait durable apporte à l'activité qu'il concerne.
 *
 * La normalisation ne transporte que ce vocabulaire, jamais le type d'événement
 * ni son motif : `NOT_COMPLETED` n'est pas `NATIVE_PROCESS_FAILED`, et F2
 * n'importe aucune raison détaillée d'échec.
 */
type Marker =
  | 'ENGAGED'
  | 'NORMAL_COMPLETION'
  | 'TERMINAL_WITHOUT_COMPLETION'
  | 'UNRESOLVABLE_ENGAGEMENT';

interface ActivityDraft {
  readonly kind: ActivityKind;
  /** Position durable de l'ancre dans le journal. Sert l'ordre, jamais la sortie. */
  readonly anchorIndex: number;
  readonly logicalKey: string;
  /** Marqueurs, dans l'ordre du journal. */
  readonly markers: Marker[];
  /** `NATIVE_STEP` seulement. */
  round?: number;
  sourceRole?: ExpertSlotId;
  stepTargetRole?: ExpertSlotId;
  /** `HUMAN_SEND` seulement. */
  sendTargetRole?: ExpertSlotId;
  /** `RUN_START` seulement — slots dont une session a été créée. */
  readonly sessionSlots?: Set<ExpertSlotId>;
}

/** Sentinelle d'indisponibilité, propagée sans exception ni code d'erreur. */
const UNAVAILABLE: RunActivityProjection = { status: 'UNAVAILABLE' };

/**
 * Sentinelle d'échec de projection.
 *
 * Elle ne porte ni motif, ni détail, ni identité : ce que la projection n'a pas
 * pu produire, elle ne le décrit pas non plus.
 */
const PROJECTION_FAILURE: RunActivityProjection = { status: 'PROJECTION_FAILURE' };

const RUN_START_KEY = 'RUN_START';

function nativeStepKey(round: number): string {
  return `NATIVE_STEP:${String(round)}`;
}

function humanSendKey(ordinal: number): string {
  return `HUMAN_SEND:${String(ordinal)}`;
}

/**
 * Brouillon d'un passage de témoin, créé une seule fois par round logique.
 *
 * L'ancre est fixée à la **première** fois que le round apparaît. Une reprise
 * ultérieure du même round rejoint ce brouillon : même identité, même position
 * dans l'ordre public.
 */
function ensureStepDraft(
  drafts: Map<string, ActivityDraft>,
  key: string,
  round: number,
  index: number,
): ActivityDraft {
  const existing = drafts.get(key);
  if (existing !== undefined) return existing;
  const created: ActivityDraft = {
    kind: 'NATIVE_STEP',
    anchorIndex: index,
    logicalKey: key,
    markers: [],
    round,
  };
  drafts.set(key, created);
  return created;
}

// --------------------------------------------------------------------------
// Normalisation
// --------------------------------------------------------------------------

/**
 * Projette les faits durables d'un run natif en activités publiques.
 *
 * L'algorithme ne fait **aucune** hypothèse d'ordonnancement autre que celle
 * que le journal garantit déjà : il est append-only et sa séquence est
 * strictement croissante. Tout le reste — rattachement, rôle, disposition — est
 * lu dans les faits, ou déclaré indisponible.
 */
export function projectRunActivity(
  runId: string,
  state: NativeRunStateDocument,
  events: readonly NativeCcrEvent[],
  seams: RunActivityProjectionSeams = {},
): RunActivityProjection {
  // Aucun court-circuit sur un journal vide. `RUN_START` est une activité F2
  // **sélectionnée** : un run natif résolu dont la base autoritative de
  // création manque n'a pas « zéro activité », il a une histoire absente. Un
  // journal absent et un journal vide passent donc par le même chemin que
  // n'importe quelle histoire incomplète, et y trouvent `UNAVAILABLE`.
  const deriveActivityId = seams.deriveActivityId ?? activityIdFor;

  const eventById = new Map<string, NativeCcrEvent>();
  const indexById = new Map<string, number>();
  events.forEach((event, index) => {
    eventById.set(event.event_id, event);
    indexById.set(event.event_id, index);
  });

  /** Clé logique propriétaire d'un fait, une fois rattaché. */
  const ownerOfEvent = new Map<string, string>();
  /** Faits dérivés d'une famille hors périmètre : rattachés à personne, et c'est correct. */
  const outOfFamilyDerived = new Set<string>();

  const drafts = new Map<string, ActivityDraft>();

  // --- Passe 1 : ancres et rattachements directs --------------------------
  //
  // Un seul parcours, dans l'ordre du journal. Les faits dont le rattachement
  // dépend d'une provenance sont laissés à la passe 2 : leur cible peut se
  // trouver n'importe où en amont.

  let humanSendOrdinal = 0;

  for (const [index, event] of events.entries()) {
    switch (event.type) {
      case 'run_created': {
        // Deux naissances rendraient l'initialisation indécidable.
        if (drafts.has(RUN_START_KEY)) return UNAVAILABLE;
        drafts.set(RUN_START_KEY, {
          kind: 'RUN_START',
          anchorIndex: index,
          logicalKey: RUN_START_KEY,
          markers: ['ENGAGED'],
          sessionSlots: new Set<ExpertSlotId>(),
        });
        ownerOfEvent.set(event.event_id, RUN_START_KEY);
        break;
      }

      case 'session_created': {
        const draft = drafts.get(RUN_START_KEY);
        const slot = slotField(event, 'expert_slot_id');
        if (draft?.sessionSlots === undefined || slot === null) return UNAVAILABLE;
        draft.sessionSlots.add(slot);
        ownerOfEvent.set(event.event_id, RUN_START_KEY);
        break;
      }

      case 'prompt_sent': {
        // Round 0 : la demande d'initialisation. Round ≥ 1 : la demande d'un
        // passage de témoin. Le round est un fait de l'événement, pas une
        // inférence.
        if (event.round === 0) {
          if (drafts.get(RUN_START_KEY) === undefined) return UNAVAILABLE;
          ownerOfEvent.set(event.event_id, RUN_START_KEY);
          break;
        }
        const key = nativeStepKey(event.round);
        ensureStepDraft(drafts, key, event.round, index);
        ownerOfEvent.set(event.event_id, key);
        break;
      }

      case 'human_message': {
        const slot = slotField(event, 'target_expert_slot_id');
        if (slot === null) return UNAVAILABLE;
        humanSendOrdinal += 1;
        const key = humanSendKey(humanSendOrdinal);
        drafts.set(key, {
          kind: 'HUMAN_SEND',
          anchorIndex: index,
          logicalKey: key,
          markers: ['ENGAGED'],
          sendTargetRole: slot,
        });
        ownerOfEvent.set(event.event_id, key);
        break;
      }

      case 'round_started': {
        if (event.round < 1) return UNAVAILABLE;
        const key = nativeStepKey(event.round);
        const draft = ensureStepDraft(drafts, key, event.round, index);
        // Une nouvelle tentative ré-engage la MÊME activité logique : même clé,
        // donc même identité publique, et l'ancre ne bouge pas.
        draft.markers.push('ENGAGED');
        const target = slotField(event, 'target_expert_slot_id');
        if (target !== null) draft.stepTargetRole = target;
        ownerOfEvent.set(event.event_id, key);
        break;
      }

      case 'round_completed':
      case 'transfer_blocked':
      case 'transfer_aborted_before_provider':
      case 'transfer_uncertainty_acknowledged': {
        if (event.round < 1) return UNAVAILABLE;
        const key = nativeStepKey(event.round);
        const draft = ensureStepDraft(drafts, key, event.round, index);
        const source = slotField(event, 'source_slot_id');
        const target = slotField(event, 'target_slot_id');
        if (source === null || target === null) return UNAVAILABLE;
        draft.sourceRole = source;
        draft.stepTargetRole = target;
        draft.markers.push(markerForStepEvent(event.type));
        ownerOfEvent.set(event.event_id, key);
        break;
      }

      default:
        // `assistant_response`, `process_failed` et les clôtures d'envoi
        // dépendent d'une provenance : passe 2.
        break;
    }
  }

  // Sans naissance journalisée, l'initialisation n'est pas établie, et rien ne
  // permet d'affirmer que le reste de l'histoire est complet.
  if (drafts.get(RUN_START_KEY) === undefined) return UNAVAILABLE;

  // --- Passe 2 : rattachements par provenance -----------------------------

  for (const event of events) {
    const isSendResolution =
      event.type === 'send_aborted_before_provider' ||
      event.type === 'send_uncertainty_acknowledged';
    const isProvenanceDerived =
      event.type === 'assistant_response' || event.type === 'process_failed';
    if (!isSendResolution && !isProvenanceDerived) continue;

    if (isSendResolution) {
      const promptEventId = stringField(event, 'prompt_event_id');
      const owner = promptEventId === null ? undefined : ownerOfEvent.get(promptEventId);
      const draft = owner === undefined ? undefined : drafts.get(owner);
      if (owner === undefined || draft === undefined || draft.kind !== 'HUMAN_SEND') {
        return UNAVAILABLE;
      }
      draft.markers.push(
        event.type === 'send_uncertainty_acknowledged'
          ? 'UNRESOLVABLE_ENGAGEMENT'
          : 'TERMINAL_WITHOUT_COMPLETION',
      );
      ownerOfEvent.set(event.event_id, owner);
      continue;
    }

    const resolved = ownerByProvenance(event, ownerOfEvent, eventById);
    if (resolved === 'OUT_OF_FAMILY') {
      outOfFamilyDerived.add(event.event_id);
      continue;
    }
    if (resolved === null) return UNAVAILABLE; // Provenance absente ou pendante.

    const draft = drafts.get(resolved);
    if (draft === undefined) return UNAVAILABLE;

    // Une réponse d'expert clôt normalement un envoi humain ; elle ne clôt ni
    // un passage de témoin — que seul `round_completed` referme — ni une
    // initialisation, que seules les sessions liées referment.
    if (event.type === 'assistant_response') {
      if (draft.kind === 'HUMAN_SEND') draft.markers.push('NORMAL_COMPLETION');
    } else {
      draft.markers.push('TERMINAL_WITHOUT_COMPLETION');
    }
    ownerOfEvent.set(event.event_id, resolved);
  }

  // --- Complétude : tout fait des trois familles est rattaché -------------

  for (const event of events) {
    if (OUT_OF_FAMILY_EVENT_TYPES.has(event.type)) continue;
    if (outOfFamilyDerived.has(event.event_id)) continue;
    if (!ownerOfEvent.has(event.event_id)) return UNAVAILABLE;
  }

  // --- Rôles des passages de témoin ---------------------------------------

  for (const draft of drafts.values()) {
    if (draft.kind !== 'NATIVE_STEP') continue;
    if (draft.sourceRole === undefined) {
      const resolved = sourceRoleFromProvenance(draft, events, indexById);
      if (resolved === null) return UNAVAILABLE; // Jamais deviné.
      draft.sourceRole = resolved;
    }
    if (draft.stepTargetRole === undefined || draft.round === undefined) return UNAVAILABLE;
    // Invariant public : un passage de témoin va d'un expert vers l'autre.
    if (draft.sourceRole === draft.stepTargetRole) return UNAVAILABLE;
  }

  // --- Ordre public et dispositions ---------------------------------------

  const ordered = [...drafts.values()].sort((a, b) => a.anchorIndex - b.anchorIndex);
  const activities: RunActivity[] = [];
  // Unicité **vérifiée**, jamais présumée. Deux activités logiques distinctes
  // qui recevraient la même identité publique rendraient le document faux au
  // moment précis où un consommateur s'en sert pour les distinguer.
  const emittedIds = new Set<string>();

  for (const [rank, draft] of ordered.entries()) {
    const activityId = deriveActivityId(runId, draft.logicalKey);
    if (emittedIds.has(activityId)) {
      // L'applicabilité est établie et l'histoire logique est connue ; c'est la
      // représentation publique qui ne peut pas être produite. Aucune activité
      // n'est écartée, aucune n'est renommée, aucune n'est élue : le document
      // entier est refusé, et rien de la clé logique ne transparaît.
      return PROJECTION_FAILURE;
    }
    emittedIds.add(activityId);
    // L'ordre durable public est un RANG, jamais un décalage interne : il ne
    // révèle ni la position de l'ancre dans le journal, ni sa séquence. Le pas
    // de 10 rend visible que les trous ne portent aucune sémantique.
    const sequence = (rank + 1) * 10;
    const procedural = dispositionOf(draft, state);

    if (draft.kind === 'RUN_START') {
      activities.push({
        activity_id: activityId,
        sequence,
        activity_kind: 'RUN_START',
        procedural_disposition: procedural,
      });
      continue;
    }

    if (draft.kind === 'NATIVE_STEP') {
      const source = draft.sourceRole;
      const target = draft.stepTargetRole;
      const round = draft.round;
      if (source === undefined || target === undefined || round === undefined) return UNAVAILABLE;
      activities.push({
        activity_id: activityId,
        sequence,
        activity_kind: 'NATIVE_STEP',
        procedural_disposition: procedural,
        source_role: source,
        target_role: target,
        round,
      });
      continue;
    }

    const target = draft.sendTargetRole;
    if (target === undefined) return UNAVAILABLE;
    activities.push({
      activity_id: activityId,
      sequence,
      activity_kind: 'HUMAN_SEND',
      procedural_disposition: procedural,
      target_role: target,
    });
  }

  return { status: 'AVAILABLE', activities };
}

// --------------------------------------------------------------------------
// Marqueurs
// --------------------------------------------------------------------------

/**
 * Marqueur d'un fait bi-slot de transfert.
 *
 * `transfer_blocked` et `transfer_aborted_before_provider` restent deux faits
 * distincts dans le journal ; F2 ne les distingue pas, parce que leur
 * différence est une **raison**, et que le contrat interdit d'importer une
 * raison détaillée d'échec.
 */
function markerForStepEvent(type: string): Marker {
  if (type === 'round_completed') return 'NORMAL_COMPLETION';
  if (type === 'transfer_uncertainty_acknowledged') return 'UNRESOLVABLE_ENGAGEMENT';
  return 'TERMINAL_WITHOUT_COMPLETION';
}

// --------------------------------------------------------------------------
// Provenance
// --------------------------------------------------------------------------

/**
 * Propriétaire d'un fait dérivé, par sa provenance journalisée.
 *
 * `based_on` est un fait durable : le suivre n'est pas une inférence. Un
 * `based_on` vide, ou pointant vers un événement inconnu, n'est pas complété —
 * il rend l'histoire incomplète.
 *
 * Un fait dérivé d'une ouverture de handoff est **hors périmètre** : il ne
 * décrit aucune des trois familles, et son existence n'entame pas la
 * complétude.
 */
function ownerByProvenance(
  event: NativeCcrEvent,
  ownerOfEvent: ReadonlyMap<string, string>,
  eventById: ReadonlyMap<string, NativeCcrEvent>,
): string | null | 'OUT_OF_FAMILY' {
  const basedOn = basedOnOf(event);
  if (basedOn.length === 0) return null;

  for (const candidate of basedOn) {
    const owner = ownerOfEvent.get(candidate);
    if (owner !== undefined) return owner;
  }

  for (const candidate of basedOn) {
    const referenced = eventById.get(candidate);
    if (referenced !== undefined && OUT_OF_FAMILY_EVENT_TYPES.has(referenced.type)) {
      return 'OUT_OF_FAMILY';
    }
  }

  return null;
}

/**
 * Rôle source d'un passage de témoin, quand aucun fait bi-slot ne l'a fixé.
 *
 * Dernière autorité admise : la provenance de l'ancre. Le `round_started` d'un
 * transfert nomme l'événement source dont il procède, et cet événement porte
 * canoniquement le slot de l'expert qui l'a produit.
 *
 * ```text
 * AUTORISÉ   round_started.based_on → assistant_response.expert_slot_id
 * INTERDIT   fournisseur → rôle
 * INTERDIT   alternance supposée → rôle
 * INTERDIT   ordre deviné → rôle
 * ```
 */
function sourceRoleFromProvenance(
  draft: ActivityDraft,
  events: readonly NativeCcrEvent[],
  indexById: ReadonlyMap<string, number>,
): ExpertSlotId | null {
  const anchor = events[draft.anchorIndex];
  if (anchor === undefined) return null;

  for (const candidate of basedOnOf(anchor)) {
    const index = indexById.get(candidate);
    if (index === undefined) continue;
    const source = events[index];
    if (source === undefined) continue;
    const slot = slotField(source, 'expert_slot_id');
    if (slot !== null) return slot;
  }
  return null;
}

// --------------------------------------------------------------------------
// Disposition procédurale
// --------------------------------------------------------------------------

/**
 * Disposition d'une activité, depuis ses marqueurs puis, à défaut, l'état
 * canonique du run.
 *
 * Ordre d'autorité, strict :
 *
 * ```text
 * 1. la frontière de complétion normale de la famille, si elle est atteinte
 * 2. un engagement devenu irrésolvable, acquitté durablement
 * 3. une résolution terminale sans complétion normale
 * 4. l'état canonique du run, pour une activité engagée et non résolue
 * ```
 *
 * Aucune de ces valeurs ne parle de succès substantiel, de justesse d'expert,
 * d'acceptation humaine ni d'issue d'invocation.
 */
function dispositionOf(draft: ActivityDraft, state: NativeRunStateDocument): ProceduralDisposition {
  if (draft.kind === 'RUN_START') {
    // Frontière de complétion normale d'une initialisation native : les deux
    // experts ont une session. Elle survit aux tentatives échouées reprises,
    // parce qu'une initialisation reprise a bel et bien abouti.
    if ((draft.sessionSlots?.size ?? 0) >= 2) return 'COMPLETED';
    return fallbackDisposition(state);
  }

  // Repli sur les marqueurs, dans l'ordre du journal. `COMPLETED` et
  // `UNCERTAIN` sont terminaux ; une résolution sans complétion ne l'est pas,
  // puisqu'une reprise peut ré-engager la même activité logique.
  let current: ProceduralDisposition | null = null;
  for (const marker of draft.markers) {
    switch (marker) {
      case 'NORMAL_COMPLETION':
        return 'COMPLETED';
      case 'UNRESOLVABLE_ENGAGEMENT':
        return 'UNCERTAIN';
      case 'TERMINAL_WITHOUT_COMPLETION':
        current = 'NOT_COMPLETED';
        break;
      case 'ENGAGED':
        current = 'IN_PROGRESS';
        break;
    }
  }

  if (current === 'NOT_COMPLETED') return 'NOT_COMPLETED';
  return fallbackDisposition(state);
}

/**
 * Disposition d'une activité durablement engagée qu'aucun marqueur ne résout.
 *
 * L'état canonique du run est alors la seule autorité disponible, et elle ne
 * dit que deux choses : « CCR ne peut pas établir » — une incertitude
 * acquittée — ou « plus aucune progression n'est possible ».
 */
function fallbackDisposition(state: NativeRunStateDocument): ProceduralDisposition {
  if (state.uncertainty !== null) return 'UNCERTAIN';
  if (
    state.state === 'FAILED_INITIALIZATION' ||
    state.state === 'FAILED' ||
    state.state === 'CLOSED'
  ) {
    return 'NOT_COMPLETED';
  }
  return 'IN_PROGRESS';
}
