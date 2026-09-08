/**
 * Lecture de l'état opérationnel public d'un run natif (contrat R2).
 *
 * Projection **courante** : elle rend un état à l'instant de la lecture, jamais
 * une histoire. Aucun horodatage de transition, aucun journal, aucune agrégation
 * d'autres autorités.
 *
 * ## Trois étages, trois issues distinctes
 *
 * ```text
 * S1  résolution d'identité      découvrable ?
 *       échec  →  RUN_NOT_FOUND traverse · aucun document
 * S2  applicabilité              génération native, ou non ?
 *       établie native      →  S3
 *       établie non native  →  NOT_APPLICABLE
 *       INDÉTERMINABLE      →  NATIVE_APPLICABILITY_NOT_ESTABLISHED traverse
 *                              aucun document
 * S3  projection                 état établi de façon fiable ?
 *       échec  →  PROJECTION_FAILURE
 * ```
 *
 * Les deux étages du haut ne se replient jamais l'un sur l'autre. Un run
 * découvrable dont la génération reste indéterminée n'est **pas** un run
 * introuvable : le sujet existe, c'est la question qui n'a pas encore de sens
 * établi. Et `PROJECTION_FAILURE` présuppose S2 franchi — l'employer pour rendre
 * compte de l'échec de S2 affirmerait précisément ce que S2 n'a pas pu établir.
 *
 * En sens inverse, une fois S2 franchi, l'échec appartient bien à S3 et reste un
 * fait rendu : un état absent ou illisible garde son `PROJECTION_FAILURE`, et
 * n'est jamais converti en échec de commande.
 *
 * ## Trois autorités lues, séparées
 *
 * ```text
 * état natif + contrôle      state.json         document d'état natif
 * génération                 manifest           NATIVE_V21_EXECUTION ou non
 * plan de transfert          planNativeStep     décide, n'exécute pas
 * ```
 *
 * ## Ce que la projection n'ajoute pas
 *
 * Le plan de transfert est rendu **tel que le planificateur le calcule**. Aucune
 * garde supplémentaire n'est ajoutée ici : y filtrer le quota ferait de
 * `available` une capacité d'exécution, ce que le contrat interdit explicitement.
 *
 * ```text
 * available = true   ≠  pas admissible
 *                    ≠  quota disponible
 *                    ≠  invocation engageable maintenant
 * ```
 *
 * ## Vocabulaire public
 *
 * L'état public n'est pas la sérialisation accidentelle d'un identifiant interne :
 * la correspondance est explicite, et son autorité est la sémantique publique
 * ratifiée. Une valeur interne inconnue de la table ne se replie sur rien.
 */

import { CcrError } from '../core/errors.ts';
import { TERMINAL_STATES } from '../core/state.ts';
import type { ControlOwner, RunState } from '../core/state.ts';
import { runPaths } from '../store/layout.ts';
import { readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import { planNativeStep } from './native-step-planner.ts';
import { requireDiscoverableRun } from './run-existence.ts';
import type { RunServiceDeps } from './run-service.ts';

/** Statuts de projection du contrat R2. */
export const RUN_OPERATIONAL_STATE_PROJECTION_STATUSES = [
  'AVAILABLE',
  'NOT_APPLICABLE',
  'PROJECTION_FAILURE',
] as const;

export type RunOperationalStateProjectionStatus =
  (typeof RUN_OPERATIONAL_STATE_PROJECTION_STATUSES)[number];

/** Vocabulaire d'état **public**, fermé et versionné pour lui-même. */
export const PUBLIC_NATIVE_STATES = [
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

export type PublicNativeState = (typeof PUBLIC_NATIVE_STATES)[number];

/** Vocabulaire public de la propriété du contrôle, dimension distincte de l'état. */
export const PUBLIC_CONTROL_OWNERS = ['AUTOMATION', 'HUMAN'] as const;
export type PublicControlOwner = (typeof PUBLIC_CONTROL_OWNERS)[number];

/**
 * Correspondance explicite entre l'état interne et l'état public.
 *
 * Écrite en toutes lettres pour que le contrat public ne dépende pas de
 * l'identifiant interne : un renommage interne se répercute ici, et nulle part
 * dans le document rendu.
 */
const PUBLIC_STATE_BY_INTERNAL: Readonly<Record<RunState, PublicNativeState>> = {
  READY: 'READY',
  RUNNING: 'RUNNING',
  WAITING_AGENT: 'WAITING_AGENT',
  WAITING_HUMAN: 'WAITING_HUMAN',
  PAUSED: 'PAUSED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  FAILED_INITIALIZATION: 'FAILED_INITIALIZATION',
  FAILED: 'FAILED',
  CLOSED: 'CLOSED',
};

const PUBLIC_CONTROL_BY_INTERNAL: Readonly<Record<ControlOwner, PublicControlOwner>> = {
  AUTOMATION: 'AUTOMATION',
  HUMAN: 'HUMAN',
};

/** Plan de transfert suivant, dans sa forme publique minimale. */
export type PublicNextTransferPlan =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly source_role: string;
      readonly target_role: string;
      readonly next_round: number;
    };

export type RunOperationalStateView =
  | {
      readonly run_id: string;
      readonly projection_status: 'NOT_APPLICABLE' | 'PROJECTION_FAILURE';
    }
  | {
      readonly run_id: string;
      readonly projection_status: 'AVAILABLE';
      readonly native_state: PublicNativeState;
      readonly terminal: boolean;
      readonly control_owner: PublicControlOwner;
      readonly next_transfer_plan: PublicNextTransferPlan;
    };

/** `CLOSED` est le seul état terminal ; la propriété est dérivée, jamais recopiée. */
function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Rend l'état opérationnel public du run.
 *
 * Un run découvrable dont la génération est **établie** non native rend
 * `NOT_APPLICABLE` : la question a un sujet, et n'a pas de sens pour lui. Aucun
 * état natif n'est fabriqué.
 *
 * Un run découvrable dont la génération ne peut pas être établie ne rend rien du
 * tout : l'erreur traverse, et la commande échoue. C'est le seul moyen de ne pas
 * affirmer, par le choix d'un statut, ce que la lecture n'a pas établi.
 *
 * Une fois la génération établie native, tout empêchement appartient à S3 et
 * rend `PROJECTION_FAILURE` — y compris un état absent, qui atteste d'un run
 * bien réel dont l'état n'est pas lisible.
 */
export async function readRunOperationalState(
  deps: RunServiceDeps,
  runId: string,
): Promise<RunOperationalStateView> {
  // S1 — résolution d'identité, avant l'applicabilité comme avant la projection.
  await requireDiscoverableRun(deps.runsDir, runId);

  const paths = runPaths(deps.runsDir, runId);

  // S2 — applicabilité. L'échec de lecture n'est pas un fait de projection : il
  // laisse la question sans sens établi, et cette indétermination traverse.
  let persisted;
  try {
    persisted = await readPersistedManifest(paths);
  } catch (error) {
    throw new CcrError(
      'NATIVE_APPLICABILITY_NOT_ESTABLISHED',
      `La génération du run ${runId} n'a pas pu être établie.`,
      { details: { runId }, cause: error },
    );
  }

  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    return { run_id: runId, projection_status: 'NOT_APPLICABLE' };
  }

  // S3 — projection. Ici, et seulement ici, un empêchement est un fait rendu.
  try {
    const stateDoc = await readPersistedState(paths);
    if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
      return { run_id: runId, projection_status: 'PROJECTION_FAILURE' };
    }

    const events = await (await openNativeEventStore(paths, persisted.manifest)).readAll();
    const plan = planNativeStep({
      runId,
      manifest: persisted.manifest,
      state: stateDoc.document,
      events,
      ...(deps.maxTransferBytes === undefined ? {} : { maxTransferBytes: deps.maxTransferBytes }),
    });

    // Seul `READY` désigne un plan composable. `PAYLOAD_TOO_LARGE` et `REFUSED`
    // sont des indisponibilités : le contrat v1 n'en publie pas la raison.
    const next_transfer_plan: PublicNextTransferPlan =
      plan.kind === 'READY'
        ? {
            available: true,
            source_role: plan.sourceSlot,
            target_role: plan.targetSlot,
            next_round: plan.nextRoundNumber,
          }
        : { available: false };

    const internalState = stateDoc.document.state;
    return {
      run_id: runId,
      projection_status: 'AVAILABLE',
      native_state: PUBLIC_STATE_BY_INTERNAL[internalState],
      terminal: isTerminal(internalState),
      control_owner: PUBLIC_CONTROL_BY_INTERNAL[stateDoc.document.control],
      next_transfer_plan,
    };
  } catch {
    return { run_id: runId, projection_status: 'PROJECTION_FAILURE' };
  }
}
