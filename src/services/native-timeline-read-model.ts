/**
 * Chronologie d'un run **natif V2.1** (V2.1-IMP-19).
 *
 * C'est la première surface qui rend lisible la *matière* de la controverse :
 * ce que l'auteur a soutenu, ce que le challenger lui a opposé, et par quels
 * passages de témoin l'un est arrivé à l'autre.
 *
 * ## Pourquoi une projection propre
 *
 * `TimelineEventEntry` historique porte `target: AgentKind`. Y couler un
 * événement natif obligerait à répondre « claude » ou « codex » à la question
 * « qui ? » — et deux experts partageant un moteur deviendraient indiscernables
 * au moment précis où la chronologie sert à les distinguer. La provenance native
 * est donc **slot-first**, et le fournisseur n'est qu'un attribut dérivé.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il ne classifie rien de neuf : la forme de provenance de chaque type vient de
 * `provenanceShapeOf`, gelée en 1B. Une seconde taxonomie divergerait de celle
 * que les stores appliquent à l'écriture.
 *
 * Il ne trie pas : l'ordre rendu est l'ordre journalisé. Deux événements de même
 * horodatage — c'est courant, la milliseconde est grossière — ne doivent jamais
 * échanger leur place, sous peine d'inverser une cause et son effet.
 *
 * Il ne lit rien : ni disque, ni `rounds/`, ni verrou. Les événements lui sont
 * remis, et ils viennent d'un unique instantané canonique.
 */

import { provenanceShapeOf } from '../core/event-provenance.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type {
  NativeCcrEvent,
  NativeEventActor,
  NativeEventType,
  NativeExpertSessionEvent,
  NativeExpertTargetEvent,
  NativeRunManifest,
  NativeTransferEvent,
} from '../core/run-native.ts';

/**
 * Version de la **projection**, jamais d'un document.
 *
 * Aucun fichier ne la porte : elle décrit la forme rendue par cette couche et
 * son transport HTTP, exactement comme `read_model_version` en 2D. Elle
 * n'appartient à aucun schéma persisté, et ne se compare à aucun.
 */
export const NATIVE_TIMELINE_VERSION = 1;

// --------------------------------------------------------------------------
// Provenance rendue
// --------------------------------------------------------------------------

/**
 * Provenance d'une entrée — **union discriminée**, comme le journal.
 *
 * Chaque variante porte exactement les champs que la validation canonique exige
 * pour cette classe, et aucun autre. En particulier :
 *
 * ```text
 * TRANSFER              response_event_id présent — le transfert a abouti
 * TRANSFER_*            response_event_id ABSENT — rien n'a répondu
 * SEND_RESOLUTION       aucune session : la clôture ne prétend pas en avoir atteint une
 * HANDOFF_RESOLUTION    aucune session, aucun prompt : une ouverture, et c'est tout
 * GENERATION_NEUTRAL    aucune identité — ni slot, ni moteur, ni session
 * ```
 *
 * Un champ nul « pour uniformiser » donnerait à lire une absence de conclusion
 * comme une conclusion vide. La forme refuse donc de l'exprimer.
 */
export type NativeTimelineProvenance =
  | {
      readonly shape: 'EXPERT_SESSION';
      readonly expert_slot_id: ExpertSlotId;
      readonly provider: ProviderKind;
      readonly session_id: string;
    }
  | {
      readonly shape: 'EXPERT_TARGET';
      readonly target_expert_slot_id: ExpertSlotId;
      readonly provider: ProviderKind;
      /** `null` quand l'événement n'en porte pas. Jamais reconstruit ailleurs. */
      readonly session_id: string | null;
    }
  | {
      readonly shape: 'TRANSFER';
      readonly source_slot_id: ExpertSlotId;
      readonly target_slot_id: ExpertSlotId;
      readonly source_provider: ProviderKind;
      readonly target_provider: ProviderKind;
      readonly source_event_id: string;
      readonly response_event_id: string;
    }
  | {
      readonly shape: 'TRANSFER_BLOCKED' | 'TRANSFER_QUARANTINED' | 'TRANSFER_ABORTED';
      readonly source_slot_id: ExpertSlotId;
      readonly target_slot_id: ExpertSlotId;
      readonly source_provider: ProviderKind;
      readonly target_provider: ProviderKind;
      readonly source_event_id: string;
    }
  | {
      readonly shape: 'SEND_RESOLUTION';
      readonly target_expert_slot_id: ExpertSlotId;
      readonly provider: ProviderKind;
      readonly prompt_event_id: string;
    }
  | {
      readonly shape: 'HANDOFF_RESOLUTION';
      readonly target_expert_slot_id: ExpertSlotId;
      readonly provider: ProviderKind;
      readonly started_event_id: string;
    }
  | { readonly shape: 'GENERATION_NEUTRAL' };

/**
 * Une entrée de chronologie native.
 *
 * `kind` reste `'event'` : le journal natif n'a pas de second genre d'entrée en
 * V2.1 — aucun écrivain natif ne produit `decisions.jsonl`. Le champ est
 * conservé pour que le contrat externe reste celui de la chronologie
 * historique, et qu'une future entrée d'un autre genre n'ait pas à le
 * réintroduire.
 */
export interface NativeTimelineEntryV1 {
  readonly kind: 'event';
  readonly event_id: string;
  readonly type: NativeEventType;
  readonly actor: NativeEventActor;
  readonly timestamp: string;
  readonly round: number;
  /** Contenu **intégral**, tel que persisté. Jamais résumé, jamais rogné. */
  readonly content: string | null;
  readonly exit_code: number | null;
  readonly based_on: readonly string[];
  /** Motif fermé des marqueurs sans issue. `null` quand le fait n'existe pas. */
  readonly reason: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly provenance: NativeTimelineProvenance;
}

// --------------------------------------------------------------------------
// Projection
// --------------------------------------------------------------------------

/**
 * Fournisseur d'un slot — **dérivé du manifest, et de lui seul**.
 *
 * Jamais de l'acteur : `actor` vaut `expert`, catégorie et non identité. Jamais
 * d'une session : un identifiant natif ne dit pas quel moteur l'a émis. Le
 * binding du manifest est la seule autorité, et il reste un attribut de
 * présentation — l'identité, c'est le slot.
 */
function providerOf(manifest: NativeRunManifest, slot: ExpertSlotId): ProviderKind {
  return manifest.experts[slot].provider;
}

/**
 * Formes **structurelles** partagées par plusieurs types d'événements.
 *
 * Trois issues sans réponse partagent la forme bi-slot ; deux clôtures d'envoi
 * partagent la leur, deux clôtures de handoff également. Lire chacune par le
 * type d'une seule de ses variantes affirmerait un `type` et un `reason` faux —
 * le lecteur n'a besoin que des champs, pas de la variante.
 */
interface BiSlotWithoutResponse {
  readonly source_slot_id: ExpertSlotId;
  readonly target_slot_id: ExpertSlotId;
  readonly source_event_id: string;
}

interface SendResolutionFields {
  readonly target_expert_slot_id: ExpertSlotId;
  readonly prompt_event_id: string;
}

interface HandoffResolutionFields {
  readonly target_expert_slot_id: ExpertSlotId;
  readonly started_event_id: string;
}

/**
 * Provenance d'un événement, par sa classe canonique.
 *
 * Les conversions de type sont sûres par construction : le journal a été validé
 * par `validateNativeEventShape`, qui refuse à l'écriture comme à la relecture
 * tout événement dont la forme ne correspond pas à sa classe.
 */
function provenanceOf(manifest: NativeRunManifest, event: NativeCcrEvent): NativeTimelineProvenance {
  const shape = provenanceShapeOf(event.type as NativeEventType);
  switch (shape) {
    case 'EXPERT_SESSION': {
      const typed = event as NativeExpertSessionEvent;
      return {
        shape,
        expert_slot_id: typed.expert_slot_id,
        provider: providerOf(manifest, typed.expert_slot_id),
        session_id: typed.session_id,
      };
    }
    case 'EXPERT_TARGET': {
      const typed = event as NativeExpertTargetEvent;
      return {
        shape,
        target_expert_slot_id: typed.target_expert_slot_id,
        provider: providerOf(manifest, typed.target_expert_slot_id),
        session_id: typed.session_id ?? null,
      };
    }
    case 'TRANSFER': {
      const typed = event as NativeTransferEvent;
      return {
        shape,
        source_slot_id: typed.source_slot_id,
        target_slot_id: typed.target_slot_id,
        source_provider: providerOf(manifest, typed.source_slot_id),
        target_provider: providerOf(manifest, typed.target_slot_id),
        source_event_id: typed.source_event_id,
        response_event_id: typed.response_event_id,
      };
    }
    case 'TRANSFER_BLOCKED':
    case 'TRANSFER_QUARANTINED':
    case 'TRANSFER_ABORTED': {
      const typed = event as unknown as BiSlotWithoutResponse;
      return {
        shape,
        source_slot_id: typed.source_slot_id,
        target_slot_id: typed.target_slot_id,
        source_provider: providerOf(manifest, typed.source_slot_id),
        target_provider: providerOf(manifest, typed.target_slot_id),
        source_event_id: typed.source_event_id,
      };
    }
    case 'SEND_RESOLUTION': {
      const typed = event as unknown as SendResolutionFields;
      return {
        shape,
        target_expert_slot_id: typed.target_expert_slot_id,
        provider: providerOf(manifest, typed.target_expert_slot_id),
        prompt_event_id: typed.prompt_event_id,
      };
    }
    case 'HANDOFF_RESOLUTION': {
      const typed = event as unknown as HandoffResolutionFields;
      return {
        shape,
        target_expert_slot_id: typed.target_expert_slot_id,
        provider: providerOf(manifest, typed.target_expert_slot_id),
        started_event_id: typed.started_event_id,
      };
    }
    case 'GENERATION_NEUTRAL':
      // Aucune identité inventée : ce que l'événement ne porte pas, la
      // chronologie ne le porte pas non plus.
      return { shape };
  }
}

/** Motif fermé, lorsqu'il existe. Aucun défaut, aucune traduction. */
function reasonOf(event: NativeCcrEvent): string | null {
  const value = (event as { readonly reason?: unknown }).reason;
  return typeof value === 'string' ? value : null;
}

/** Projette un événement canonique en une entrée de chronologie. */
export function projectNativeTimelineEntry(
  manifest: NativeRunManifest,
  event: NativeCcrEvent,
): NativeTimelineEntryV1 {
  return {
    kind: 'event',
    event_id: event.event_id,
    type: event.type,
    actor: event.actor,
    timestamp: event.timestamp,
    round: event.round,
    content: event.content ?? null,
    exit_code: event.exit_code ?? null,
    based_on: event.based_on ?? [],
    reason: reasonOf(event),
    details: event.details ?? null,
    provenance: provenanceOf(manifest, event),
  };
}

/**
 * Projette une suite d'événements, **dans l'ordre où ils ont été journalisés**.
 *
 * Aucun tri : ni par horodatage, ni par round, ni par slot, ni par fournisseur.
 * `events.jsonl` est le seul ordre canonique du run, et le seul qui garantisse
 * qu'une réponse suive la demande qui l'a produite.
 */
export function projectNativeTimeline(
  manifest: NativeRunManifest,
  events: readonly NativeCcrEvent[],
): readonly NativeTimelineEntryV1[] {
  return events.map((event) => projectNativeTimelineEntry(manifest, event));
}
