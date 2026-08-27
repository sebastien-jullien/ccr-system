/**
 * Projection de présentation du cockpit (`V2.3-S1`).
 *
 * ## Ce qu'elle est
 *
 * Une projection **additive**, **versionnée**, **non persistée**, composée
 * au-dessus des autorités existantes. Elle transporte des faits que la
 * projection native ne porte pas et dont l'interface a besoin :
 *
 * ```text
 * effets d'action        peut-elle appeler un fournisseur, et engager quoi
 * dernières contributions  où lire ce que chaque expert a produit
 * contexte initial       le texte exact soumis par l'humain
 * ```
 *
 * ## Ce qu'elle n'est pas
 *
 * Elle ne recalcule ni `allowed`, ni `reason_code`, ni un statut de reprise, ni
 * une transition d'état, ni une sémantique de session. Ces faits appartiennent
 * à `NativeRunReadModelV1`, et les rejouer ici créerait une seconde autorité
 * qui divergerait.
 *
 * Elle ne duplique pas non plus `operational_state` : chacun de ses champs est
 * déjà autoritaire à un seul endroit, et le recopier n'ajouterait qu'une copie
 * susceptible de vieillir. La projection **compose, contextualise, référence**
 * — elle ne redit pas.
 *
 * ## Le même instantané
 *
 * Elle reçoit le snapshot déjà lu par la vue HTTP native, jamais un second.
 * Deux lectures produiraient deux mondes sous une seule révision.
 *
 * ## Pure
 *
 * Aucune entrée/sortie, aucune horloge, aucune écriture. Tout lui est fourni.
 */

import { EXPERT_SLOT_IDS } from '../core/expert.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type { NativeCcrEvent } from '../core/run-native.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { operationEffect } from './invocation-effect.ts';
import type { CockpitOperationId, OperationEffect } from './invocation-effect.ts';

/** Version de la **projection**, indépendante de `read_model_version`. */
export const COCKPIT_PRESENTATION_VERSION = 1;

/**
 * Opérations transportées pour un run **existant**.
 *
 * `START` en est absent, et délibérément : un run déjà né ne se démarre pas.
 * L'effet de `START` reste disponible dans la primitive partagée, pour la
 * surface de création qui, elle, n'a pas encore de run à projeter.
 */
export const RUN_PRESENTED_OPERATIONS: readonly CockpitOperationId[] = [
  'STEP',
  'SEND',
  'PAUSE',
  'RESUME',
  'HANDOFF',
];

/**
 * Où lire une contribution — une **référence**, jamais une copie.
 *
 * Le contenu intégral appartient à la chronologie. Le dupliquer ici alourdirait
 * chaque lecture de run du poids de deux réponses de modèle, pour un écran qui
 * n'en affiche qu'un extrait.
 */
export interface ContributionRef {
  readonly event_id: string;
  readonly round: number;
  readonly timestamp: string;
  /** Depuis le binding du manifest. Jamais déduit de l'acteur d'un événement. */
  readonly provider: ProviderKind;
  readonly session_id: string;
  readonly content_bytes: number;
}

/**
 * Texte initial soumis par l'humain, ou la raison de son absence.
 *
 * `INCONSISTENT` n'est pas une panne : c'est le refus de choisir. Deux prompts
 * d'initialisation divergents décrivent un fait anormal, et en retenir un
 * arbitrairement présenterait une invention comme le contexte de l'humain.
 */
export type InitialContext =
  | {
      readonly status: 'AVAILABLE';
      readonly content: string;
      readonly event_ids: readonly string[];
    }
  | {
      readonly status: 'UNAVAILABLE';
      readonly reason: 'NOT_FOUND' | 'INCONSISTENT';
      readonly event_ids: readonly string[];
    };

export interface CockpitPresentationV1 {
  readonly presentation_version: number;
  /** Effets des opérations pertinentes pour ce run. Aucune capacité ici. */
  readonly actions: readonly OperationEffect[];
  readonly latest_contributions: Readonly<Record<ExpertSlotId, ContributionRef | null>>;
  readonly initial_context: InitialContext;
}

// --------------------------------------------------------------------------
// Lecture des événements — ordre canonique, jamais retrié
// --------------------------------------------------------------------------

/**
 * Dernière contribution d'un slot.
 *
 * Parcours **à rebours de l'ordre canonique**, sans tri ni comparaison
 * d'horodatage : le journal est déjà ordonné, et le réordonner affirmerait une
 * chronologie qu'il détient seul.
 *
 * La sélection se fait par `expert_slot_id`, jamais par fournisseur : deux
 * experts peuvent partager le même moteur, et les distinguer par lui rendrait
 * la même contribution pour les deux.
 */
function latestContribution(
  events: readonly NativeCcrEvent[],
  slot: ExpertSlotId,
  provider: ProviderKind,
): ContributionRef | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type !== 'assistant_response') continue;
    if (!('expert_slot_id' in event) || event.expert_slot_id !== slot) continue;
    const content = typeof event.content === 'string' ? event.content : '';
    return {
      event_id: event.event_id,
      round: event.round,
      timestamp: event.timestamp,
      provider,
      session_id: event.session_id,
      content_bytes: Buffer.byteLength(content, 'utf8'),
    };
  }
  return null;
}

/**
 * Prompts d'initialisation — discriminés par un fait, pas par une heuristique.
 *
 * ```text
 * START   prompt_sent · actor human  · contenu = texte de l'humain, verbatim
 * STEP    prompt_sent · actor system · contenu = enveloppe de transfert
 * SEND    human_message              · type différent
 * ```
 *
 * `actor === 'human'` sur un `prompt_sent` est donc exact et sans ambiguïté :
 * aucun autre chemin natif n'en produit. Aucune expression régulière, aucune
 * analyse de contenu, aucune reconstruction.
 */
function initialContext(events: readonly NativeCcrEvent[]): InitialContext {
  const prompts = events.filter((event) => event.type === 'prompt_sent' && event.actor === 'human');
  const eventIds = prompts.map((event) => event.event_id);
  if (prompts.length === 0) return { status: 'UNAVAILABLE', reason: 'NOT_FOUND', event_ids: [] };

  const first = prompts[0];
  const content = first === undefined ? undefined : first.content;
  if (typeof content !== 'string') {
    return { status: 'UNAVAILABLE', reason: 'NOT_FOUND', event_ids: eventIds };
  }
  // Un run natif en produit normalement un par slot, porteurs du même texte.
  // Une divergence est un fait anormal : elle se dit, elle ne se tranche pas.
  const uniform = prompts.every((event) => event.content === content);
  if (!uniform) return { status: 'UNAVAILABLE', reason: 'INCONSISTENT', event_ids: eventIds };
  return { status: 'AVAILABLE', content, event_ids: eventIds };
}

// --------------------------------------------------------------------------
// Projection
// --------------------------------------------------------------------------

/**
 * Compose la présentation d'un run natif.
 *
 * Pure : le snapshot lui est fourni, elle n'en lit aucun second. Aucun champ de
 * la projection native n'est recopié ni réévalué.
 */
export function projectCockpitPresentation(snapshot: NativeRunSnapshot): CockpitPresentationV1 {
  const contributions: Record<ExpertSlotId, ContributionRef | null> = {
    author: null,
    challenger: null,
  };
  for (const slot of EXPERT_SLOT_IDS) {
    contributions[slot] = latestContribution(
      snapshot.events,
      slot,
      snapshot.manifest.experts[slot].provider,
    );
  }

  return {
    presentation_version: COCKPIT_PRESENTATION_VERSION,
    actions: RUN_PRESENTED_OPERATIONS.map((operation) => operationEffect(operation)),
    latest_contributions: contributions,
    initial_context: initialContext(snapshot.events),
  };
}
