/**
 * Préconditions métier des opérations de run — **source unique**
 * (CCR V2 V0.2 §13 ; amendement d'implémentation V2-IMP-30).
 *
 * ## Pourquoi ce module existe
 *
 * La contre-expertise a établi (`CLX2-A3`) qu'une table d'actions écrite à la
 * main diverge du code : la V0.1 proposait `Handoff` en `READY / AUTOMATION`,
 * alors que la primitive V1 exige conjointement le contrôle `HUMAN` et un état
 * `PAUSED` ou `WAITING_HUMAN`. Le document démontrait son propre défaut.
 *
 * La correction n'est pas d'écrire une meilleure table : c'est de n'en avoir
 * qu'une seule. Les fonctions ci-dessous sont **les** préconditions. Elles sont
 * appelées par les services mutateurs V1 *et* par la dérivation des
 * capabilities. Changer une règle ici change les deux ensemble ; il devient
 * impossible d'afficher une action que le service refusera.
 *
 * ## Ce que ce module n'est pas
 *
 * Il ne réimplémente pas la machine d'état (`core/state.ts`), n'ouvre aucun
 * fichier, n'écrit rien, et ne connaît ni verrou ni processus. Il ne contient
 * que des fonctions pures sur des faits déjà lus.
 *
 * Les préconditions **dynamiques** — existence d'une source transférable,
 * taille du transfert — restent hors d'ici : elles dépendent du journal et
 * sont évaluées par leurs services respectifs, puis reflétées par les
 * capabilities à partir des mêmes fonctions exportées.
 */

import type { CcrErrorCode } from './errors.ts';
import { isTransitionAllowed } from './state.ts';
import type { ControlOwner, RunState } from './state.ts';

/** États depuis lesquels une suspension volontaire a un sens (§20). */
export const PAUSABLE_STATES: readonly RunState[] = ['READY', 'RUNNING', 'PAUSED', 'WAITING_HUMAN'];

/** États depuis lesquels le contrôle peut revenir à l'automatisation (§21). */
export const RESUMABLE_STATES: readonly RunState[] = ['READY', 'RUNNING', 'PAUSED', 'WAITING_HUMAN'];

/** États depuis lesquels une intervention native est cohérente (§28, §29). */
export const HANDOFF_STATES: readonly RunState[] = ['PAUSED', 'WAITING_HUMAN'];

/**
 * Motif structuré d'un verdict. Union fermée.
 *
 * `ALREADY_SATISFIED` n'est pas une erreur : l'opération est idempotente et
 * n'écrit rien. Tous les autres motifs sont des codes CCR existants — aucun
 * code public n'est introduit par ce module.
 */
export type GuardReason =
  | 'ALREADY_SATISFIED'
  | Extract<
      CcrErrorCode,
      | 'RECOVERY_REQUIRED'
      | 'AUTOMATION_NOT_IN_CONTROL'
      | 'RUN_NOT_PAUSABLE'
      | 'RUN_NOT_RESUMABLE'
      | 'HANDOFF_NOT_ALLOWED'
      | 'SESSION_MISSING'
      | 'INVALID_ARGUMENT'
      | 'NO_TRANSFERABLE_SOURCE'
      | 'SOURCE_ALREADY_TRANSFERRED'
      | 'ILLEGAL_STATE_TRANSITION'
      | 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER'
    >;

export type GuardVerdict =
  /** L'opération peut s'exécuter et produira un effet. */
  | { readonly kind: 'ALLOWED' }
  /** L'opération est déjà satisfaite : succès sans effet ni événement. */
  | { readonly kind: 'NOOP'; readonly reason: 'ALREADY_SATISFIED' }
  /** L'opération est refusée. `reason` est le code CCR effectivement levé. */
  | { readonly kind: 'REFUSED'; readonly reason: GuardReason };

const ALLOWED: GuardVerdict = { kind: 'ALLOWED' };
const NOOP: GuardVerdict = { kind: 'NOOP', reason: 'ALREADY_SATISFIED' };

function refuse(reason: GuardReason): GuardVerdict {
  return { kind: 'REFUSED', reason };
}

/**
 * Faits canoniques nécessaires à toute précondition.
 *
 * `requiresRecovery` est le prédicat historique du state store
 * (`WAITING_AGENT` **ou** opération en vol persistée). Il gouverne l'accès aux
 * mutations et **rien d'autre** : il ne dit pas qu'une récupération est
 * nécessaire, seulement qu'aucune mutation ne peut être émise en l'état. La
 * question « faut-il intervenir ? » relève de la classification de vivacité,
 * qui exige des faits opérationnels externes (`run-liveness.ts`).
 */
export interface RunGuardFacts {
  readonly state: RunState;
  readonly control: ControlOwner;
  readonly requiresRecovery: boolean;
}

/** Barrière commune à toutes les mutations sauf `decide`. */
function recoveryBarrier(facts: RunGuardFacts): GuardVerdict | undefined {
  return facts.requiresRecovery ? refuse('RECOVERY_REQUIRED') : undefined;
}

/**
 * Barrière de machine d'état.
 *
 * Précondition **implicite** mais bien réelle : `step` et `send` persistent un
 * changement d'état avant d'appeler l'agent, et `persistStateUpdate` refuse une
 * transition interdite. Un run `PAUSED`, `FAILED`, `CLOSED` ou
 * `RECOVERY_REQUIRED` ne peut donc pas émettre de tour, même quand aucune garde
 * explicite ne le dit.
 *
 * Elle a été découverte par la matrice de parité exhaustive du Slice 0C : les
 * gardes explicites seules annonçaient dix capacités que les services
 * refusaient en `ILLEGAL_STATE_TRANSITION`. C'est exactement le genre d'écart
 * qu'une table écrite à la main ne voit jamais.
 */
function transitionBarrier(from: RunState, to: RunState): GuardVerdict | undefined {
  return isTransitionAllowed(from, to) ? undefined : refuse('ILLEGAL_STATE_TRANSITION');
}

/**
 * `step` — passage de témoin.
 *
 * Ne couvre que les préconditions **statiques**. La disponibilité d'une source
 * transférable est évaluée séparément par `findTransferSource`, que les
 * capabilities appellent sur le même journal que le service.
 */
export function stepGuard(facts: RunGuardFacts): GuardVerdict {
  const barrier = recoveryBarrier(facts);
  if (barrier !== undefined) return barrier;
  if (facts.control !== 'AUTOMATION') return refuse('AUTOMATION_NOT_IN_CONTROL');
  // `step` passe par RUNNING avant d'appeler l'agent.
  return transitionBarrier(facts.state, 'RUNNING') ?? ALLOWED;
}

/**
 * `send` — message humain vers une session native.
 *
 * Reste utilisable sous contrôle humain : envoyer un message n'équivaut jamais
 * à rendre le run à l'automatisation.
 */
export function sendGuard(facts: RunGuardFacts, sessionPresent: boolean): GuardVerdict {
  const barrier = recoveryBarrier(facts);
  if (barrier !== undefined) return barrier;
  if (!sessionPresent) return refuse('SESSION_MISSING');
  // Depuis un état humain, `send` n'emprunte pas RUNNING (amendement A-7) ;
  // sinon il y passe. Dans les deux cas le tour traverse WAITING_AGENT.
  const humanOrigin = facts.state === 'PAUSED' || facts.state === 'WAITING_HUMAN';
  const intermediate = humanOrigin ? undefined : transitionBarrier(facts.state, 'RUNNING');
  if (intermediate !== undefined) return intermediate;
  return transitionBarrier(humanOrigin ? facts.state : 'RUNNING', 'WAITING_AGENT') ?? ALLOWED;
}

/** `pause` — suspension volontaire. Idempotente sous contrôle humain. */
export function pauseGuard(facts: RunGuardFacts): GuardVerdict {
  const barrier = recoveryBarrier(facts);
  if (barrier !== undefined) return barrier;
  if (facts.control === 'HUMAN' && (facts.state === 'PAUSED' || facts.state === 'WAITING_HUMAN')) {
    return NOOP;
  }
  return PAUSABLE_STATES.includes(facts.state) ? ALLOWED : refuse('RUN_NOT_PAUSABLE');
}

/** `resume` — retour à l'automatisation. Idempotent, ne lance aucun agent. */
export function resumeGuard(facts: RunGuardFacts): GuardVerdict {
  const barrier = recoveryBarrier(facts);
  if (barrier !== undefined) return barrier;
  if (facts.control === 'AUTOMATION' && (facts.state === 'READY' || facts.state === 'RUNNING')) {
    return NOOP;
  }
  return RESUMABLE_STATES.includes(facts.state) ? ALLOWED : refuse('RUN_NOT_RESUMABLE');
}

/**
 * `decide` — enregistrement d'une décision humaine normative.
 *
 * **Seule mutation dépourvue de barrière de reprise**, et c'est délibéré : une
 * décision humaine est une information canonique, pas une progression du run.
 * Elle reste enregistrable quel que soit l'état, y compris pendant un tour
 * agent. Seul un contenu vide la refuse.
 */
export function decideGuard(contentNonEmpty: boolean): GuardVerdict {
  return contentNonEmpty ? ALLOWED : refuse('INVALID_ARGUMENT');
}

/** `stop` — clôture d'un run au repos. Idempotent. Jamais une annulation. */
export function stopGuard(facts: RunGuardFacts): GuardVerdict {
  return recoveryBarrier(facts) ?? (facts.state === 'CLOSED' ? NOOP : ALLOWED);
}

/**
 * `handoff` — ouverture d'une session native interactive.
 *
 * Conservé ici parce que la primitive V1 existe et que la CLI l'utilise. Il
 * n'est **pas** une capacité HTTP de V2 (V0.2 §18) : le read model l'expose
 * comme information orientée CLI, jamais comme action du cockpit.
 */
export function handoffGuard(facts: RunGuardFacts, sessionPresent: boolean): GuardVerdict {
  const barrier = recoveryBarrier(facts);
  if (barrier !== undefined) return barrier;
  if (facts.control !== 'HUMAN' || !HANDOFF_STATES.includes(facts.state)) {
    return refuse('HANDOFF_NOT_ALLOWED');
  }
  return sessionPresent ? ALLOWED : refuse('SESSION_MISSING');
}
