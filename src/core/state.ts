/**
 * Machine d'état exécutable de CCR V1 (spécification V0.2, §18).
 *
 * Règle de composition (§18.3) : cette énumération ne décrit que des
 * situations réellement produites ou récupérées par la V1.
 *
 * `CONVERGED` en est volontairement absent (amendement A-3) : aucune commande
 * V1 ne le produit, la mesure de convergence appartient à V5, et un état mort
 * dans un modèle exécutable finit par être employé parce qu'il existe.
 */

import { CcrError } from './errors.ts';

export const RUN_STATES = [
  'READY',
  'RUNNING',
  'WAITING_AGENT',
  'WAITING_HUMAN',
  'PAUSED',
  'RECOVERY_REQUIRED',
  'FAILED_INITIALIZATION',
  'FAILED',
  'CLOSED',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/**
 * Propriété du droit d'émettre automatiquement un nouveau tour.
 * Dimension distincte de l'état (§19) ; elle ne se déduit jamais de la
 * présence ou non d'un processus enfant.
 */
export const CONTROL_OWNERS = ['AUTOMATION', 'HUMAN'] as const;
export type ControlOwner = (typeof CONTROL_OWNERS)[number];

/** États dans lesquels un run peut naître (§30). */
export const INITIAL_STATES: readonly RunState[] = ['READY', 'FAILED_INITIALIZATION'];

/** États terminaux : plus aucune progression automatique. */
export const TERMINAL_STATES: readonly RunState[] = ['CLOSED'];

/**
 * Transitions autorisées.
 *
 * `WAITING_AGENT → RUNNING` correspond à l'enregistrement d'un tour par le
 * processus qui l'a émis. Elle n'autorise pas un redémarrage à requalifier un
 * `WAITING_AGENT` persisté : ce chemin passe obligatoirement par
 * `RECOVERY_REQUIRED` (§32, et `loadRun` dans le state store).
 */
const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  READY: ['RUNNING', 'WAITING_HUMAN', 'PAUSED', 'FAILED', 'CLOSED'],
  RUNNING: ['READY', 'WAITING_AGENT', 'WAITING_HUMAN', 'PAUSED', 'FAILED_INITIALIZATION', 'FAILED', 'CLOSED'],
  WAITING_AGENT: [
    'RUNNING',
    // Amendement A-10 : finalisation par `ccr recover` lorsque la réponse est
    // déjà durablement journalisée — le chemin nominal passe par RUNNING.
    'READY',
    'WAITING_HUMAN',
    'PAUSED',
    'RECOVERY_REQUIRED',
    'FAILED_INITIALIZATION',
    'FAILED',
  ],
  // Amendement A-7 : un envoi humain depuis un run bloqué ou suspendu doit
  // pouvoir emprunter WAITING_AGENT sans requalifier le run en RUNNING.
  // Amendement A-10 : un handoff interrompu rend ambigu un run par ailleurs
  // suspendu — la mort du processus CCR ne prouve pas que le client natif
  // interactif est fermé.
  WAITING_HUMAN: ['READY', 'RUNNING', 'WAITING_AGENT', 'PAUSED', 'RECOVERY_REQUIRED', 'FAILED', 'CLOSED'],
  PAUSED: ['READY', 'WAITING_AGENT', 'RECOVERY_REQUIRED', 'FAILED', 'CLOSED'],
  RECOVERY_REQUIRED: ['READY', 'PAUSED', 'FAILED', 'CLOSED'],
  // Amendement A-10 : `ccr recover` reprend le travail d'initialisation, ce
  // qui exige de repasser par RUNNING pour créer la session manquante.
  FAILED_INITIALIZATION: ['READY', 'RUNNING', 'FAILED', 'CLOSED'],
  // Amendement A-6 : `FAILED` désigne un invariant brisé, jamais un incident
  // opérationnel. Il n'offre donc que la clôture explicite.
  FAILED: ['CLOSED'],
  CLOSED: [],
};

/**
 * Détermine l'état vers lequel revenir après un tour agent réussi lancé depuis
 * `origin`.
 *
 * Amendement A-7 : un envoi humain rend le run exactement à l'état d'où il
 * partait. Envoyer un message n'équivaut jamais à `ccr resume`.
 */
export function stateAfterTurnFrom(origin: RunState): RunState {
  return origin === 'PAUSED' || origin === 'WAITING_HUMAN' ? origin : 'RUNNING';
}

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value);
}

export function isControlOwner(value: unknown): value is ControlOwner {
  return typeof value === 'string' && (CONTROL_OWNERS as readonly string[]).includes(value);
}

/** Une transition vers le même état est un non-événement, pas une erreur. */
export function isTransitionAllowed(from: RunState, to: RunState): boolean {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (isTransitionAllowed(from, to)) return;
  throw new CcrError('ILLEGAL_STATE_TRANSITION', `Transition interdite : ${from} → ${to}.`, {
    details: { from, to, allowed: ALLOWED_TRANSITIONS[from] ?? [] },
  });
}

export function allowedTransitionsFrom(from: RunState): readonly RunState[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}
