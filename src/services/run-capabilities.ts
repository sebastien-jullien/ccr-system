/**
 * Dérivation des capacités d'un run
 * (CCR V2 V0.2 §13 ; amendement d'implémentation V2-IMP-30).
 *
 * ## Défaut corrigé — `CLX2-A3` et `CX2-003`
 *
 * Une liste d'actions écrite à la main diverge du code. Ce module ne contient
 * donc **aucune** règle : il appelle les mêmes prédicats que les services
 * mutateurs (`core/run-guards.ts`) et la même recherche de source que `step`
 * (`services/transfer` via `findTransferSource`). Si une règle change, la
 * capacité affichée et le service changent ensemble, par construction.
 *
 * Le frontend consomme ce résultat. Il n'écrit jamais `if (state === …)`.
 *
 * ## `handoff` n'est pas une capacité V2
 *
 * La primitive V1 existe et la CLI l'utilise, mais elle lance un processus
 * interactif attaché au terminal, sans timeout, en détenant le run lock : elle
 * ne peut pas être une action du cockpit (V0.2 §18). Elle est donc exposée
 * séparément, comme **information orientée CLI**, jamais dans les capacités
 * mutables.
 */

import { planStepTransfer } from './transfer.ts';
import type { StepTransferPlan } from './transfer.ts';
import type { AgentKind, CcrDecision, CcrEvent, RunManifest, RunStateDocument } from '../core/run.ts';
import {
  decideGuard,
  handoffGuard,
  pauseGuard,
  resumeGuard,
  sendGuard,
  stepGuard,
  stopGuard,
} from '../core/run-guards.ts';
import type { GuardReason, GuardVerdict, RunGuardFacts } from '../core/run-guards.ts';
import type { RunLiveness } from '../core/run-liveness.ts';

/** Actions mutables exposables par le cockpit. `HANDOFF` en est absent. */
export const CAPABILITY_IDS = ['STEP', 'SEND', 'PAUSE', 'RESUME', 'DECIDE', 'STOP'] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * Motif structuré d'indisponibilité.
 *
 * Reprend les motifs des gardes, plus deux motifs propres à la lecture :
 * `OPERATION_IN_FLIGHT` remplace `RECOVERY_REQUIRED` lorsqu'une opération est
 * démontrée active — dire « récupération requise » pendant un tour normal
 * serait faux (`CLX2-A1`).
 */
export type CapabilityReason = GuardReason | 'OPERATION_IN_FLIGHT';

/**
 * Effet d'une action, en code stable.
 *
 * Ni texte d'interface, ni traduction : le frontend décide de sa formulation,
 * jamais de sa sémantique.
 */
export type CapabilityEffect =
  | 'TRANSFER_ONE_TURN'
  | 'SEND_HUMAN_MESSAGE'
  | 'SUSPEND_AUTOMATION'
  | 'RETURN_TO_AUTOMATION'
  | 'RECORD_HUMAN_DECISION'
  | 'CLOSE_RUN';

export interface RunCapability {
  readonly id: CapabilityId;
  readonly allowed: boolean;
  /** Renseigné si et seulement si `allowed` est faux. */
  readonly reason?: CapabilityReason;
  /** Vrai lorsque l'action aboutirait sans produire aucun effet. */
  readonly idempotentNoop: boolean;
  readonly requiresConfirmation: boolean;
  readonly destructive: boolean;
  readonly effect: CapabilityEffect;
  /** Vrai lorsque l'action lance un processus fournisseur (admission V0.2 §20). */
  readonly longRunning: boolean;
  /**
   * Cibles réellement disponibles, pour une action paramétrée.
   *
   * Renseigné pour `SEND` uniquement. Une capacité booléenne y serait
   * trompeuse : « `SEND` autorisé » ne dit pas *vers qui*, et le read model ne
   * doit jamais annoncer une cible dépourvue de session native.
   */
  readonly targets?: readonly AgentKind[];
}

/** Information sur le handoff — jamais une capacité HTTP (V0.2 §18). */
export interface HandoffAdvice {
  readonly availableViaCli: boolean;
  readonly reason?: CapabilityReason;
}

export interface RunCapabilities {
  readonly capabilities: readonly RunCapability[];
  readonly handoff: HandoffAdvice;
}

export interface CapabilityFacts {
  readonly manifest: RunManifest;
  readonly state: RunStateDocument;
  readonly events: readonly CcrEvent[];
  readonly decisions: readonly CcrDecision[];
  /** Prédicat historique du state store, tel que les services l'appliquent. */
  readonly requiresRecovery: boolean;
  /**
   * Garde-fou de transfert effectif du run.
   *
   * Fait de catégorie **C** — il provient de la configuration d'exécution
   * (`RunServiceDeps.maxTransferBytes`), pas du snapshot. Il doit donc être
   * transmis explicitement par l'appelant, avec la même valeur que le service.
   * À défaut, la constante partagée s'applique, comme dans le service.
   */
  readonly maxTransferBytes?: number;
}

interface Descriptor {
  readonly id: CapabilityId;
  readonly effect: CapabilityEffect;
  readonly destructive: boolean;
  readonly requiresConfirmation: boolean;
  readonly longRunning: boolean;
}

const DESCRIPTORS: readonly Descriptor[] = [
  { id: 'STEP', effect: 'TRANSFER_ONE_TURN', destructive: false, requiresConfirmation: false, longRunning: true },
  { id: 'SEND', effect: 'SEND_HUMAN_MESSAGE', destructive: false, requiresConfirmation: false, longRunning: true },
  { id: 'PAUSE', effect: 'SUSPEND_AUTOMATION', destructive: false, requiresConfirmation: false, longRunning: false },
  { id: 'RESUME', effect: 'RETURN_TO_AUTOMATION', destructive: false, requiresConfirmation: false, longRunning: false },
  { id: 'DECIDE', effect: 'RECORD_HUMAN_DECISION', destructive: false, requiresConfirmation: false, longRunning: false },
  // `stop` clôt le run : irréversible en V1, donc confirmé.
  { id: 'STOP', effect: 'CLOSE_RUN', destructive: true, requiresConfirmation: true, longRunning: false },
];

/**
 * Préconditions de `step` connaissables depuis le snapshot.
 *
 * Source transférable, agent cible, session cible et garde-fou de taille sont
 * évalués par `planStepTransfer` — la primitive **du service**. Aucune
 * réimplémentation, aucune constante de taille dupliquée : les deux répondent
 * toujours la même chose.
 */
function stepPlanOf(facts: CapabilityFacts): StepTransferPlan {
  return planStepTransfer({
    runId: facts.state.run_id,
    round: facts.state.round + 1,
    events: facts.events,
    sessions: {
      claude: facts.manifest.agents.claude.session_id,
      codex: facts.manifest.agents.codex.session_id,
    },
    state: facts.state.state,
    ...(facts.maxTransferBytes === undefined ? {} : { maxTransferBytes: facts.maxTransferBytes }),
  });
}

/** Agents disposant réellement d'une session native. */
function availableTargets(manifest: RunManifest): readonly AgentKind[] {
  const targets: AgentKind[] = [];
  if (manifest.agents.claude.session_id !== null) targets.push('claude');
  if (manifest.agents.codex.session_id !== null) targets.push('codex');
  return targets;
}

/**
 * Requalifie un refus `RECOVERY_REQUIRED` lorsqu'une opération est démontrée
 * active. L'action reste indisponible — le run lock la refuserait de toute
 * façon — mais le motif devient exact.
 */
function reasonFor(reason: GuardReason, liveness: RunLiveness): CapabilityReason {
  return reason === 'RECOVERY_REQUIRED' && liveness === 'OPERATION_IN_FLIGHT'
    ? 'OPERATION_IN_FLIGHT'
    : reason;
}

function verdictFor(id: CapabilityId, facts: CapabilityFacts, guard: RunGuardFacts): GuardVerdict {
  switch (id) {
    case 'STEP': {
      const base = stepGuard(guard);
      // Les préconditions dynamiques ne sont examinées que si les statiques
      // passent : c'est l'ordre exact du service.
      if (base.kind !== 'ALLOWED') return base;
      const plan = stepPlanOf(facts);
      return plan.kind === 'READY' ? { kind: 'ALLOWED' } : { kind: 'REFUSED', reason: plan.reason };
    }
    case 'SEND':
      // Au moins une cible doit posséder une session native ; le détail des
      // cibles est exposé séparément par `targets`.
      return sendGuard(guard, availableTargets(facts.manifest).length > 0);
    case 'PAUSE':
      return pauseGuard(guard);
    case 'RESUME':
      return resumeGuard(guard);
    case 'DECIDE':
      // Le contenu n'existe pas encore au moment de la dérivation : seule
      // l'absence de barrière est évaluée. `decide` n'en a aucune.
      return decideGuard(true);
    case 'STOP':
      return stopGuard(guard);
  }
}

/**
 * Dérive les capacités d'un run à partir de ses faits canoniques et de sa
 * classification de vivacité.
 *
 * Fonction pure : aucune lecture, aucune écriture, aucun verrou.
 */
export function deriveRunCapabilities(
  facts: CapabilityFacts,
  liveness: RunLiveness,
): RunCapabilities {
  const guard: RunGuardFacts = {
    state: facts.state.state,
    control: facts.state.control,
    requiresRecovery: facts.requiresRecovery,
  };

  const capabilities = DESCRIPTORS.map((descriptor): RunCapability => {
    const verdict = verdictFor(descriptor.id, facts, guard);
    // Une capacité n'est jamais autorisée « par défaut » : seul un verdict
    // explicitement ALLOWED ou NOOP l'autorise.
    const allowed = verdict.kind === 'ALLOWED' || verdict.kind === 'NOOP';
    return {
      id: descriptor.id,
      allowed,
      ...(verdict.kind === 'REFUSED' ? { reason: reasonFor(verdict.reason, liveness) } : {}),
      idempotentNoop: verdict.kind === 'NOOP',
      requiresConfirmation: descriptor.requiresConfirmation,
      destructive: descriptor.destructive,
      effect: descriptor.effect,
      longRunning: descriptor.longRunning,
      // Une cible n'est annoncée que si sa session native existe ET si les
      // barrières générales de `send` sont franchies.
      ...(descriptor.id === 'SEND'
        ? { targets: allowed ? availableTargets(facts.manifest) : [] }
        : {}),
    };
  });

  const handoffVerdict = handoffGuard(guard, availableTargets(facts.manifest).length > 0);

  return {
    capabilities,
    handoff: {
      availableViaCli: handoffVerdict.kind === 'ALLOWED',
      ...(handoffVerdict.kind === 'REFUSED'
        ? { reason: reasonFor(handoffVerdict.reason, liveness) }
        : {}),
    },
  };
}
