/**
 * Plan de récupération — primitive **partagée** (V2-IMP-40).
 *
 * Deux consommateurs, un seul calcul :
 *
 * ```text
 * RecoveryView          ce que l'humain voit proposé
 * mutation Recovery     ce que le serveur accepte d'exécuter
 * ```
 *
 * Les faire diverger serait la faute la plus coûteuse de ce slice : la vue
 * annoncerait une capacité, et l'effet en exécuterait une autre. Un seul
 * `switch` existe donc, ici, et personne d'autre ne décide.
 *
 * Ce module ne connaît ni HTTP, ni cookie, ni code de statut, ni DOM. Il rend
 * des faits métier ; le transport les traduit.
 */

import { classifyRunLiveness } from '../core/run-liveness.ts';
import type { RunLiveness } from '../core/run-liveness.ts';
import { lockTokenFor } from '../lock/lock-token.ts';
import type { RunExecutionObservation, RunLockObservation } from '../lock/run-execution-evidence.ts';
import type { RunLockInfo } from '../lock/run-lock.ts';
import type { RunManifest, RunStateDocument } from '../core/run.ts';

/**
 * Identifiants d'invocation.
 *
 * Chacun nomme l'effet **exact** produit dans l'état observé — jamais une
 * action générique. `recoverRun` choisit lui-même sa branche à partir de
 * l'état : proposer deux invocations canoniques à la fois promettrait un choix
 * qui n'existe pas.
 */
export const RECOVERY_CAPABILITY_IDS = [
  'RECOVERY_FINALIZE_JOURNALED_RESPONSE',
  'RECOVERY_CONTINUE_INITIALIZATION',
  'RECOVERY_MATERIALIZE_AMBIGUITY',
  'RECOVERY_ACKNOWLEDGE_AMBIGUITY',
  'RECOVERY_CLEAR_STALE_LOCK',
] as const;

export type RecoveryCapabilityId = (typeof RECOVERY_CAPABILITY_IDS)[number];

/** Les quatre invocations servies par la primitive V1 `recoverRunLocked`. */
export type CanonicalRecoveryCapabilityId = Exclude<RecoveryCapabilityId, 'RECOVERY_CLEAR_STALE_LOCK'>;

/**
 * Observations depuis lesquelles une levée de verrou est **sûre**.
 *
 * `ORPHAN_SAME_PID_LOCK` ne signifie pas « le PID est vivant, donc supprimable ».
 * Il désigne un verrou portant le PID de ce processus qui, après l'analyse 0D
 * complète — aucune opération hôte ne correspondant exactement à ce `runId` et
 * à ce `lock_id`, puis reconfirmation du même `lock_id` sur deux observations
 * consécutives — est classé orphelin de façon **stable**.
 */
const CLEARABLE_OBSERVATIONS: readonly RunLockObservation[] = ['STALE_LOCK', 'ORPHAN_SAME_PID_LOCK'];

export interface ClearableLock {
  readonly lock: RunLockInfo;
  /** Identité opaque de ce verrou précis. Ni PID, ni nom d'hôte ne sortent. */
  readonly token: string;
}

export interface RecoveryPlan {
  readonly liveness: RunLiveness;
  readonly observation: RunLockObservation;
  readonly pendingResponseJournaled: boolean;
  /** Invocation canonique courante — au plus une, jamais un choix. */
  readonly canonical: CanonicalRecoveryCapabilityId | null;
  /** Présent seulement lorsque la levée est sûre à cet instant. */
  readonly clearable: ClearableLock | null;
}

/**
 * La réponse de l'opération pendante est-elle déjà journalisée ?
 *
 * Fait décisif : si CCR possède la réponse, l'opération est finalisable **sans
 * rappeler l'agent**. Il vit ici parce qu'il entre dans le plan, et qu'il ne
 * doit exister qu'une fois.
 */
export function pendingResponseJournaled(snapshot: {
  readonly state: RunStateDocument;
  readonly events: readonly { readonly type: string; readonly based_on?: readonly string[] }[];
}): boolean {
  const promptEventId = snapshot.state.pending_operation?.prompt_event_id ?? null;
  if (promptEventId === null) return false;
  return snapshot.events.some(
    (event) => event.type === 'assistant_response' && (event.based_on ?? []).includes(promptEventId),
  );
}

/** Faits canoniques suffisants pour dire ce que la primitive V1 ferait. */
export interface CanonicalRecoveryFacts {
  readonly manifest: RunManifest;
  readonly state: RunStateDocument;
  readonly pendingResponseJournaled: boolean;
}

/**
 * Ce que `recoverRunLocked` ferait, sur ces faits.
 *
 * **Aucun verrou n'entre ici.** Ni `.ccr.lock`, ni `lock_id`, ni PID, ni nom
 * d'hôte, ni registre hôte, ni observation d'exécution. La raison est apparue
 * en éprouvant le service : un appelant qui détient déjà le run lock verrait
 * son propre verrou dans les faits, et la capacité s'évanouirait — le plan
 * refuserait l'action à cause de l'exclusion qui la rend précisément possible.
 *
 * L'ordre des branches reproduit exactement celui de `recoverRunLocked`
 * (`run-service.ts:1413` et suivantes). Une seule fonction décide, pour la vue
 * comme pour l'effet.
 */
export function planCanonicalRecovery(
  facts: CanonicalRecoveryFacts,
): CanonicalRecoveryCapabilityId | null {
  const { state } = facts;

  // Terminal en V1 : diagnostiqué, jamais réactivé.
  if (state.state === 'FAILED' || state.state === 'CLOSED') return null;

  // Ambiguïté déjà matérialisée : seul l'acquittement humain la résout.
  if (state.state === 'RECOVERY_REQUIRED') return 'RECOVERY_ACKNOWLEDGE_AMBIGUITY';

  if (state.pending_operation !== null) {
    // La réponse est là : finalisable sans rappeler personne.
    return facts.pendingResponseJournaled
      ? 'RECOVERY_FINALIZE_JOURNALED_RESPONSE'
      : 'RECOVERY_MATERIALIZE_AMBIGUITY';
  }

  // Une session native manque : l'initialisation peut être complétée.
  const missing = (['claude', 'codex'] as const).some(
    (agent) => facts.manifest.agents[agent].session_id === null,
  );
  return missing ? 'RECOVERY_CONTINUE_INITIALIZATION' : null;
}

/**
 * Une capacité canonique est-elle **actionnable à cet instant** ?
 *
 * Question distincte de la précédente, et qui a ses propres critères : un
 * verrou vivant, étranger ou indéterminé n'invalide pas le plan — il interdit
 * de l'exécuter maintenant. C'est pourquoi ce prédicat porte sur la vivacité,
 * pas sur l'état métier.
 */
function actionableNow(liveness: RunLiveness): boolean {
  return liveness === 'PARTIAL_INITIALIZATION' || liveness === 'ABANDONED_OPERATION' || liveness === 'AMBIGUOUS';
}

export interface RecoveryPlanInput {
  readonly runId: string;
  readonly manifest: RunManifest;
  readonly state: RunStateDocument;
  readonly pendingResponseJournaled: boolean;
  readonly observed: RunExecutionObservation;
}

/**
 * Calcule le plan de récupération à partir des faits observés.
 *
 * Fonction pure : les mêmes faits produisent le même plan. C'est ce qui permet
 * de la rejouer sous le run lock et de comparer honnêtement à ce que l'humain
 * avait sous les yeux.
 */
export function planRecovery(input: RecoveryPlanInput): RecoveryPlan {
  const liveness = classifyRunLiveness(
    {
      manifest: input.manifest,
      state: input.state,
      pendingResponseJournaled: input.pendingResponseJournaled,
    },
    input.observed.evidence,
  );

  // Deux questions, deux réponses. Ce que la primitive ferait — et si les
  // faits d'exécution permettent de le faire maintenant. `NONE`,
  // `OPERATION_IN_FLIGHT`, `ORPHAN_LOCK` et `UNDETERMINED` n'exposent rien :
  // `UNDETERMINED` en particulier n'est ni une erreur, ni une preuve de
  // reprise, et ne rend donc rien exécutable.
  const candidate = planCanonicalRecovery({
    manifest: input.manifest,
    state: input.state,
    pendingResponseJournaled: input.pendingResponseJournaled,
  });
  const canonical = actionableNow(liveness.liveness) ? candidate : null;

  const lock = input.observed.lock;
  const clearable =
    lock !== undefined && CLEARABLE_OBSERVATIONS.includes(input.observed.observation)
      ? { lock, token: lockTokenFor(input.runId, lock) }
      : null;

  return {
    liveness: liveness.liveness,
    observation: input.observed.observation,
    pendingResponseJournaled: input.pendingResponseJournaled,
    canonical,
    clearable,
  };
}

/** Vrai pour la seule invocation qui joint un fournisseur (V2-IMP-40A §1). */
export function isLongRunningRecovery(id: RecoveryCapabilityId): boolean {
  return id === 'RECOVERY_CONTINUE_INITIALIZATION';
}
