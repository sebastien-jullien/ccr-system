/**
 * Projection opérationnelle d'un run **natif V2.1** (Slice 2D).
 *
 * Une seule lecture, une seule vérité : les surfaces futures — CLI, HTTP,
 * cockpit — consomment cette projection au lieu de recalculer les règles
 * métier depuis `state`, `pending_operation` ou le fournisseur d'un slot.
 *
 * ## Ce que cette couche n'est pas
 *
 * Ce n'est **pas une autorisation durable**. Une capacité est un *instantané
 * consultatif* : entre sa lecture et l'action, l'état peut changer. Toute
 * opération mutante reprend le verrou, relit les faits et réévalue sa propre
 * garde — c'est elle qui décide, jamais cette projection.
 *
 * Aucun jeton, aucun nonce, aucune réservation n'est donc émis. La projection
 * n'est pas persistée : `read_model_version` ne décrit que la forme de cet
 * objet en mémoire, et ne touche à aucun schéma de fichier.
 *
 * ## Ce qu'elle ne recalcule pas
 *
 * Rien. Chaque verdict provient du moteur qui fait autorité :
 *
 * ```text
 * transférabilité       planNativeStep            (1E, barrière 2C-R comprise)
 * envoi · handoff       evaluateNativeManualAction (2A)
 * alias                 resolveNativeProviderAlias (2A)
 * reprises              les quatre vues natives    (1D · 1G · 2B-R · 2C-R)
 * ```
 *
 * Dupliquer l'une de ces règles ici créerait une seconde sémantique portant le
 * même nom — exactement ce que ce slice existe pour empêcher.
 *
 * ## Snapshot observationnel
 *
 * Aucun verrou n'est pris. C'est délibéré : un `handoff` détient le verrou
 * pendant **toute** l'interaction native, et un cockpit doit pouvoir observer
 * `pending_operation` et `active_expert_slot` précisément pendant ce temps-là.
 * Les faits canoniques sont lus une seule fois, et les quatre classifieurs
 * reçoivent le **même** instantané — jamais quatre visions temporelles.
 */

import path from 'node:path';

import { CcrError } from '../core/errors.ts';
import type { CcrErrorCode } from '../core/errors.ts';
import { EXPERT_SLOT_IDS, PROVIDER_KINDS } from '../core/expert.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type {
  NativeCcrEvent,
  NativePendingOperation,
  NativeRunManifest,
  NativeRunRuntimeConfig,
  NativeRunStateDocument,
} from '../core/run-native.ts';
import type { ControlOwner, RunState } from '../core/state.ts';
import { runPaths } from '../store/layout.ts';
import { readInvocationQuotaView } from './invocation-quota-read.ts';
import { readUsageReadModel } from './usage-read-model.ts';
import { readCostEstimateReadModel } from './cost-estimate-read-model.ts';
import type { CostEstimateReadModel } from './cost-estimate-read-model.ts';
import type { UsageReadModel } from './usage-read-model.ts';
import type { InvocationQuotaView } from './invocation-quota-read.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { buildNativeInitializationView } from './native-recovery-service.ts';
import type {
  NativeInitializationRecoveryView,
  NativeInitializationStatus,
} from './native-recovery-service.ts';
import { buildNativeStepRecoveryView } from './native-step-recovery-service.ts';
import type { NativeStepRecoveryStatus, NativeStepRecoveryView } from './native-step-recovery-service.ts';
import { buildNativeSendRecoveryView } from './native-send-recovery-service.ts';
import type { NativeSendRecoveryStatus, NativeSendRecoveryView } from './native-send-recovery-service.ts';
import { buildNativeHandoffRecoveryView } from './native-handoff-recovery-service.ts';
import type {
  NativeHandoffRecoveryStatus,
  NativeHandoffRecoveryView,
} from './native-handoff-recovery-service.ts';
import { planNativeStep } from './native-step-planner.ts';
import type { NativeStepPlan } from './native-step-planner.ts';
import { evaluateNativeManualAction, expertSlotTarget, resolveNativeProviderAlias } from './native-target-resolver.ts';
import {
  evaluateNativePauseBarrier,
  evaluateNativeResumeBarrier,
} from './native-control-service.ts';
import type { NativeControlVerdict, NativeRecoveryDomain } from './native-control-service.ts';

// --------------------------------------------------------------------------
// Dépendances — volontairement sans fournisseur
// --------------------------------------------------------------------------

/**
 * Ce dont la projection a besoin, et rien d'autre.
 *
 * Aucun `createAdapters`, aucun `now()` : une lecture ne date rien et ne lance
 * rien. Aucun fournisseur n'est sondé pendant une lecture.
 */
export interface NativeReadModelDeps {
  readonly runsDir: string;
  /**
   * Garde-fou de transfert du run appelant.
   *
   * Fait de configuration, pas de disque — exactement comme en V2 : il doit
   * porter la même valeur que le service qui exécutera le transfert, faute de
   * quoi la taille projetée ne serait pas celle qui sera appliquée.
   */
  readonly maxTransferBytes?: number;
}

// --------------------------------------------------------------------------
// Forme de la projection
// --------------------------------------------------------------------------

export const NATIVE_READ_MODEL_VERSION = 1;

export type NativeSessionStatus = 'BOUND' | 'MISSING';

export interface NativeExpertProjection {
  readonly provider: ProviderKind;
  readonly session_id: string | null;
  readonly session_status: NativeSessionStatus;
}

/** Ce qu'un alias fournisseur désignerait, s'il était employé. */
export type NativeAliasResolution =
  | { readonly resolution: 'UNIQUE'; readonly expert_slot: ExpertSlotId }
  | { readonly resolution: 'AMBIGUOUS' }
  | { readonly resolution: 'NOT_BOUND' };

/**
 * Refus **métier** d'une action, en code stable.
 *
 * Jamais un texte d'interface : la formulation et la langue appartiennent aux
 * surfaces, jamais au moteur.
 */
export interface NativeOperationCapability {
  readonly allowed: boolean;
  readonly reason_code?: CcrErrorCode;
}

/**
 * Capacité d'une action de **contrôle** — `pause`, `resume`.
 *
 * Distincte de `NativeOperationCapability` par un seul champ, et il est
 * indispensable : ces deux actions sont idempotentes. Un `NOOP` est un succès
 * sans effet, jamais un refus, et les aplatir en `allowed: false` afficherait
 * « impossible » là où CCR répond « déjà fait ».
 */
export interface NativeControlCapability extends NativeOperationCapability {
  readonly noop: boolean;
  /** Domaines dont les faits se contredisent. Absent hors conflit. */
  readonly conflicting_recovery_domains?: readonly NativeRecoveryDomain[];
}

/** Ce que le planificateur dit de la source, sans jamais en copier le contenu. */
export type NativeStepSourceStatus =
  | 'READY'
  | 'MISSING'
  | 'ALREADY_TRANSFERRED'
  | 'NON_REPLAYABLE'
  | 'STALE_AFTER_HANDOFF'
  | 'PAYLOAD_TOO_LARGE'
  | 'BLOCKED';

export interface NativeStepCapability extends NativeOperationCapability {
  readonly source_status: NativeStepSourceStatus;
  readonly source_slot?: ExpertSlotId;
  readonly target_slot?: ExpertSlotId;
  readonly source_event_id?: string;
  readonly next_round?: number;
  /** Taille de l'enveloppe, jamais l'enveloppe elle-même. */
  readonly payload_bytes?: number;
  readonly payload_limit_bytes?: number;
}

/**
 * Gestes de reprise réellement exécutables.
 *
 * Chaque identifiant correspond à une primitive **exportée** d'un moteur de
 * reprise natif. Aucune capacité ne promet un bouton qu'aucun code ne sait
 * exécuter.
 *
 * ```text
 * CONTINUE                    continueNativeInitialization        (1D)
 * ACKNOWLEDGE_UNCERTAINTY     acknowledgeNative*Uncertainty       (1D · 1G · 2B-R · 2C-R)
 * FINALIZE                    finalizeNative*Recovery             (1G · 2B-R · 2C-R)
 * ABORT_BEFORE_PROVIDER       abortNativeSendBeforeProvider       (2B-R)
 * ABORT_BEFORE_INTERACTIVE    abortNativeHandoffBeforeInteractive (2C-R)
 * ```
 */
export const NATIVE_RECOVERY_ACTION_IDS = [
  'CONTINUE',
  'FINALIZE',
  'ACKNOWLEDGE_UNCERTAINTY',
  'ABORT_BEFORE_PROVIDER',
  'ABORT_BEFORE_INTERACTIVE',
] as const;
export type NativeRecoveryActionId = (typeof NATIVE_RECOVERY_ACTION_IDS)[number];

export interface NativeRecoveryAction {
  readonly action: NativeRecoveryActionId;
  /** Vrai lorsque l'exécution peut lancer un fournisseur (1D uniquement). */
  readonly may_call_provider: boolean;
  /** Note libre exigée par la primitive. */
  readonly requires_note: boolean;
  /**
   * Contrôle garanti par le contrat de la primitive, lorsqu'elle en garantit
   * un. Absent quand elle ne touche pas l'état — c'est le cas de la clôture
   * d'une ouverture de handoff jamais lancée.
   */
  readonly resulting_control?: ControlOwner;
}

interface NativeRecoveryDomainBase {
  readonly available_actions: readonly NativeRecoveryAction[];
  /** Renseigné uniquement en `EVIDENCE_CONFLICT`. */
  readonly conflicts: readonly string[];
}

export interface NativeInitializationRecoveryProjection extends NativeRecoveryDomainBase {
  readonly status: NativeInitializationStatus;
  readonly missing_slots: readonly ExpertSlotId[];
  readonly reconcilable_slots: readonly ExpertSlotId[];
  readonly uncertain_slot: ExpertSlotId | null;
}

export interface NativeStepRecoveryProjection extends NativeRecoveryDomainBase {
  readonly status: NativeStepRecoveryStatus;
  readonly source_slot?: ExpertSlotId;
  readonly target_slot?: ExpertSlotId;
  readonly source_event_id?: string;
  readonly response_event_id?: string;
  readonly round?: number;
  readonly source_replay_status: NativeStepRecoveryView['sourceReplayStatus'];
  readonly diagnostic_round: NativeStepRecoveryView['diagnosticRound'];
}

export interface NativeSendRecoveryProjection extends NativeRecoveryDomainBase {
  readonly status: NativeSendRecoveryStatus;
  readonly target_slot?: ExpertSlotId;
  readonly prompt_event_id?: string;
  readonly response_event_id?: string;
  readonly failure_event_id?: string;
  readonly resolution_event_id?: string;
  readonly orphan_prompt_event_ids: readonly string[];
}

export interface NativeHandoffRecoveryProjection extends NativeRecoveryDomainBase {
  readonly status: NativeHandoffRecoveryStatus;
  readonly target_slot?: ExpertSlotId;
  readonly started_event_id?: string;
  readonly finished_event_id?: string;
  readonly failure_event_id?: string;
  readonly resolution_event_id?: string;
  readonly orphan_started_event_ids: readonly string[];
}

export interface NativeRunReadModelV1 {
  readonly read_model_version: number;
  readonly identity: {
    readonly run_id: string;
    readonly execution_mode: 'NATIVE_V21_EXECUTION';
    readonly title: string;
    readonly created_at: string;
    readonly workspace_cwd: string;
    readonly manifest_schema_version: number;
    readonly state_schema_version: number;
    readonly runtime_schema_version: number | null;
  };
  readonly experts: Readonly<Record<ExpertSlotId, NativeExpertProjection>>;
  /**
   * Compatibilité **secondaire**, jamais une identité.
   *
   * Les surfaces futures peuvent avoir à accepter un alias historique ; elles
   * doivent savoir ce qu'il désignerait, sans jamais présenter un moteur comme
   * un expert.
   */
  readonly compatibility: {
    readonly provider_aliases: Readonly<Record<ProviderKind, NativeAliasResolution>>;
  };
  readonly operational_state: {
    readonly state: RunState;
    readonly control: ControlOwner;
    readonly round: number;
    readonly next_step_source_slot: ExpertSlotId | null;
    readonly active_expert_slot: ExpertSlotId | null;
    readonly last_event_id: string | null;
    readonly updated_at: string;
    /** Faits déjà persistés, jamais réinterprétés en langage métier. */
    readonly pending_operation: NativePendingOperation | null;
  };
  /** Snapshot runtime **persisté**, tel quel. Aucun fournisseur n'est sondé. */
  readonly providers: NativeRunRuntimeConfig | null;
  /**
   * Politique d'invocations et sa consommation (`V2.2-IMP-09`).
   *
   * Gouvernance, jamais capacité : les quatre classifieurs de reprise ne la
   * consultent pas, et elle ne retire aucune action. Une reprise reste
   * métier-disponible alors même que la politique refusera son exécution — les
   * deux faits se lisent côte à côte, et c'est la séparation gelée par 2B.
   */
  readonly invocation_quota: InvocationQuotaView;
  /**
   * Usage observé, par invocation (`V2.2-IMP-10`).
   *
   * Observation, jamais capacité : les quatre classifieurs de reprise ne la
   * consultent pas, et elle ne retire aucune action.
   */
  readonly usage: UsageReadModel;
  /**
   * Estimations de coût, par invocation (`V2.2-IMP-12`).
   *
   * Projection dérivée, jamais une facture : elle vit à côté de l'usage et de
   * la politique, et ne se confond avec aucun des deux.
   */
  readonly cost_estimate: CostEstimateReadModel;
  readonly recovery: {
    readonly initialization: NativeInitializationRecoveryProjection;
    readonly step: NativeStepRecoveryProjection;
    readonly send: NativeSendRecoveryProjection;
    readonly handoff: NativeHandoffRecoveryProjection;
  };
  readonly operations: {
    readonly step: NativeStepCapability;
    /**
     * Contrôle humain.
     *
     * `decide` et `stop` en sont **absents**, et délibérément : ils n'ont pas
     * de service natif en V2.1. Une capacité qu'aucun code ne saurait exécuter
     * serait un bouton menteur.
     */
    readonly pause: NativeControlCapability;
    readonly resume: NativeControlCapability;
    readonly experts: Readonly<
      Record<
        ExpertSlotId,
        { readonly send: NativeOperationCapability; readonly handoff: NativeOperationCapability }
      >
    >;
  };
  readonly counts: { readonly events: number };
}

// --------------------------------------------------------------------------
// Projections élémentaires
// --------------------------------------------------------------------------

function projectExperts(manifest: NativeRunManifest): Record<ExpertSlotId, NativeExpertProjection> {
  const project = (slot: ExpertSlotId): NativeExpertProjection => {
    const binding = manifest.experts[slot];
    return {
      provider: binding.provider,
      session_id: binding.session_id,
      // Une session absente n'est pas une conclusion d'indisponibilité : elle
      // dit seulement ce que le manifest porte. Ce que le run **accepte** est
      // l'affaire des capacités.
      session_status: binding.session_id === null ? 'MISSING' : 'BOUND',
    };
  };
  return { author: project('author'), challenger: project('challenger') };
}

function projectAliases(manifest: NativeRunManifest): Record<ProviderKind, NativeAliasResolution> {
  const resolve = (provider: ProviderKind): NativeAliasResolution => {
    try {
      // La règle 0/1/2 appartient au résolveur de 2A, et n'est pas réécrite ici.
      return { resolution: 'UNIQUE', expert_slot: resolveNativeProviderAlias(manifest, provider) };
    } catch (error) {
      if (error instanceof CcrError && error.code === 'AMBIGUOUS_PROVIDER_ALIAS') {
        return { resolution: 'AMBIGUOUS' };
      }
      if (error instanceof CcrError && error.code === 'PROVIDER_ALIAS_NOT_BOUND') {
        return { resolution: 'NOT_BOUND' };
      }
      throw error;
    }
  };
  const aliases = {} as Record<ProviderKind, NativeAliasResolution>;
  for (const provider of PROVIDER_KINDS) aliases[provider] = resolve(provider);
  return aliases;
}

/**
 * Capacité d'une action manuelle, depuis la garde réelle de 2A.
 *
 * Un refus métier — session absente, run non suspendu, opération engagée — est
 * une **valeur**, jamais une exception : il ne doit pas faire échouer la
 * projection entière. Une corruption structurale, elle, remonte.
 */
function projectManualAction(
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  action: 'SEND' | 'HANDOFF',
  slot: ExpertSlotId,
): NativeOperationCapability {
  const evaluation = evaluateNativeManualAction(manifest, state, {
    action,
    ref: expertSlotTarget(slot),
  });
  if (evaluation.verdict.kind !== 'REFUSED') return { allowed: true };
  return {
    allowed: false,
    ...(evaluation.error === undefined ? {} : { reason_code: evaluation.error.code }),
  };
}

/**
 * Capacité de transfert, depuis le plan réel.
 *
 * Aucune règle n'est réimplémentée : sélection du slot source, consommation,
 * quarantaine, barrière de fraîcheur post-handoff, garde-fou de taille, session
 * cible et same-provider viennent tous du planificateur.
 *
 * Le contenu de la source n'est **jamais** recopié : l'identifiant, les slots
 * et la taille suffisent, et dupliquer une réponse entière dans une projection
 * de lecture serait un coût pur.
 */
function projectStepCapability(plan: NativeStepPlan): NativeStepCapability {
  if (plan.kind === 'READY') {
    return {
      allowed: true,
      source_status: 'READY',
      source_slot: plan.sourceSlot,
      target_slot: plan.targetSlot,
      source_event_id: plan.sourceEventId,
      next_round: plan.nextRoundNumber,
      payload_bytes: plan.payloadBytes,
      payload_limit_bytes: plan.limitBytes,
    };
  }
  if (plan.kind === 'PAYLOAD_TOO_LARGE') {
    return {
      allowed: false,
      reason_code: plan.error.code,
      source_status: 'PAYLOAD_TOO_LARGE',
      source_slot: plan.sourceSlot,
      target_slot: plan.targetSlot,
      source_event_id: plan.sourceEventId,
      next_round: plan.nextRoundNumber,
      payload_bytes: plan.payloadBytes,
      payload_limit_bytes: plan.limitBytes,
    };
  }

  // Traduction de forme, jamais un second moteur de fraîcheur : le code du
  // planificateur reste l'autorité, et `source_status` n'en est qu'une lecture.
  const status: NativeStepSourceStatus =
    plan.reason === 'NO_TRANSFERABLE_SOURCE'
      ? 'MISSING'
      : plan.reason === 'SOURCE_ALREADY_TRANSFERRED'
        ? 'ALREADY_TRANSFERRED'
        : plan.reason === 'SOURCE_NOT_REPLAYABLE'
          ? 'NON_REPLAYABLE'
          : plan.reason === 'SOURCE_STALE_AFTER_HANDOFF'
            ? 'STALE_AFTER_HANDOFF'
            : 'BLOCKED';
  return { allowed: false, reason_code: plan.error.code, source_status: status };
}

/**
 * Projette un verdict de contrôle.
 *
 * Aucune règle n'est réévaluée : le verdict vient de la primitive partagée avec
 * la mutation, si bien que la capacité affichée et le service refusent — ou
 * acceptent — toujours ensemble.
 */
function projectControl(verdict: NativeControlVerdict): NativeControlCapability {
  if (verdict.kind === 'REFUSED') {
    return {
      allowed: false,
      noop: false,
      reason_code: verdict.code,
      ...(verdict.conflictingDomains.length === 0
        ? {}
        : { conflicting_recovery_domains: [...verdict.conflictingDomains] }),
    };
  }
  return { allowed: true, noop: verdict.kind === 'NOOP' };
}

// --------------------------------------------------------------------------
// Gestes de reprise disponibles
// --------------------------------------------------------------------------

function action(
  id: NativeRecoveryActionId,
  over: Partial<NativeRecoveryAction> = {},
): NativeRecoveryAction {
  return {
    action: id,
    may_call_provider: false,
    requires_note: id === 'ACKNOWLEDGE_UNCERTAINTY',
    resulting_control: 'HUMAN',
    ...over,
  };
}

/** Miroir exact des statuts que `continueNativeInitialization` accepte (1D). */
function initializationActions(view: NativeInitializationRecoveryView): NativeRecoveryAction[] {
  if (view.status === 'IN_FLIGHT_UNCERTAIN') return [action('ACKNOWLEDGE_UNCERTAINTY')];
  if (view.status === 'NONE' || view.status === 'EVIDENCE_CONFLICT') return [];
  // La continuation répare d'abord localement, puis n'appelle que ce qui manque
  // réellement : c'est la vue elle-même qui dit si un fournisseur sera engagé.
  return [action('CONTINUE', { may_call_provider: view.canContinueWithProvider })];
}

/** Miroir exact de `finalizeNativeStepRecovery` / `acknowledgeNativeStepUncertainty` (1G). */
function stepActions(view: NativeStepRecoveryView): NativeRecoveryAction[] {
  if (view.status === 'IN_FLIGHT_UNCERTAIN') return [action('ACKNOWLEDGE_UNCERTAINTY')];
  if (view.status === 'NONE' || view.status === 'EVIDENCE_CONFLICT') return [];
  return [action('FINALIZE')];
}

/** Miroir exact des trois primitives de 2B-R. */
function sendActions(view: NativeSendRecoveryView): NativeRecoveryAction[] {
  switch (view.status) {
    case 'PRE_PROVIDER_ABORTED':
      return [action('ABORT_BEFORE_PROVIDER')];
    case 'IN_FLIGHT_UNCERTAIN':
      return [action('ACKNOWLEDGE_UNCERTAINTY')];
    case 'RESPONSE_NEEDS_FINALIZATION':
    case 'FAILURE_NEEDS_FINALIZATION':
    case 'RESOLUTION_NEEDS_COMMIT':
      return [action('FINALIZE')];
    default:
      return [];
  }
}

/** Miroir exact des trois primitives de 2C-R. */
function handoffActions(view: NativeHandoffRecoveryView): NativeRecoveryAction[] {
  switch (view.status) {
    case 'PRE_INTERACTIVE_ABORTED':
      // Clôture par marqueur seul : elle ne touche pas l'état, donc elle ne
      // garantit aucun contrôle résultant. L'annoncer serait faux.
      return [
        {
          action: 'ABORT_BEFORE_INTERACTIVE',
          may_call_provider: false,
          requires_note: false,
        },
      ];
    case 'IN_FLIGHT_UNCERTAIN':
      return [action('ACKNOWLEDGE_UNCERTAINTY')];
    case 'FINISHED_NEEDS_COMMIT':
    case 'FAILURE_NEEDS_FINALIZATION':
    case 'RESOLUTION_NEEDS_COMMIT':
      return [action('FINALIZE')];
    default:
      return [];
  }
}

// --------------------------------------------------------------------------
// Projection complète
// --------------------------------------------------------------------------

/**
 * Assemble la projection à partir d'un instantané **déjà chargé**.
 *
 * Pure, hors la vue de reprise de transfert qui consulte `rounds/` — artefact
 * diagnostique, et lecture seule.
 */
export async function projectNativeRunReadModel(
  runsDir: string,
  runId: string,
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  events: readonly NativeCcrEvent[],
  maxTransferBytes?: number,
): Promise<NativeRunReadModelV1> {
  const initialization = buildNativeInitializationView(runId, manifest, state, events);
  const step = await buildNativeStepRecoveryView(
    runPaths(runsDir, runId),
    runId,
    manifest,
    state,
    events,
  );
  const send = buildNativeSendRecoveryView(runId, manifest, state, events);
  const handoff = buildNativeHandoffRecoveryView(runId, manifest, state, events);
  const plan = planNativeStep({
    runId,
    manifest,
    state,
    events,
    ...(maxTransferBytes === undefined ? {} : { maxTransferBytes }),
  });

  const experts = {} as Record<
    ExpertSlotId,
    { send: NativeOperationCapability; handoff: NativeOperationCapability }
  >;
  for (const slot of EXPERT_SLOT_IDS) {
    experts[slot] = {
      send: projectManualAction(manifest, state, 'SEND', slot),
      handoff: projectManualAction(manifest, state, 'HANDOFF', slot),
    };
  }

  return {
    read_model_version: NATIVE_READ_MODEL_VERSION,
    identity: {
      run_id: manifest.run_id,
      execution_mode: 'NATIVE_V21_EXECUTION',
      title: manifest.title,
      created_at: manifest.created_at,
      workspace_cwd: manifest.workspace.cwd,
      manifest_schema_version: manifest.schema_version,
      state_schema_version: state.schema_version,
      runtime_schema_version: manifest.runtime_config?.schema_version ?? null,
    },
    experts: projectExperts(manifest),
    compatibility: { provider_aliases: projectAliases(manifest) },
    operational_state: {
      state: state.state,
      control: state.control,
      round: state.round,
      next_step_source_slot: state.next_step_source_slot,
      active_expert_slot: state.active_expert_slot,
      last_event_id: state.last_event_id,
      updated_at: state.updated_at,
      pending_operation: state.pending_operation,
    },
    providers: manifest.runtime_config ?? null,
    invocation_quota: await readInvocationQuotaView(runPaths(runsDir, runId)),
    usage: await readUsageReadModel(runPaths(runsDir, runId)),
    cost_estimate: await readCostEstimateReadModel(runPaths(runsDir, runId)),
    recovery: {
      initialization: {
        status: initialization.status,
        missing_slots: [...initialization.missingSlots],
        reconcilable_slots: [...initialization.reconcilableSlots],
        uncertain_slot: initialization.uncertainSlot,
        available_actions: initializationActions(initialization),
        conflicts: [...initialization.conflicts],
      },
      step: {
        status: step.status,
        ...(step.sourceSlot === undefined ? {} : { source_slot: step.sourceSlot }),
        ...(step.targetSlot === undefined ? {} : { target_slot: step.targetSlot }),
        ...(step.sourceEventId === undefined ? {} : { source_event_id: step.sourceEventId }),
        ...(step.responseEventId === undefined ? {} : { response_event_id: step.responseEventId }),
        ...(step.round === undefined ? {} : { round: step.round }),
        source_replay_status: step.sourceReplayStatus,
        diagnostic_round: step.diagnosticRound,
        available_actions: stepActions(step),
        conflicts: [...step.conflicts],
      },
      send: {
        status: send.status,
        ...(send.targetSlot === undefined ? {} : { target_slot: send.targetSlot }),
        ...(send.promptEventId === undefined ? {} : { prompt_event_id: send.promptEventId }),
        ...(send.responseEventId === undefined ? {} : { response_event_id: send.responseEventId }),
        ...(send.failureEventId === undefined ? {} : { failure_event_id: send.failureEventId }),
        ...(send.resolutionEventId === undefined ? {} : { resolution_event_id: send.resolutionEventId }),
        orphan_prompt_event_ids: [...send.orphanPromptEventIds],
        available_actions: sendActions(send),
        conflicts: [...send.conflicts],
      },
      handoff: {
        status: handoff.status,
        ...(handoff.targetSlot === undefined ? {} : { target_slot: handoff.targetSlot }),
        ...(handoff.startedEventId === undefined ? {} : { started_event_id: handoff.startedEventId }),
        ...(handoff.finishedEventId === undefined ? {} : { finished_event_id: handoff.finishedEventId }),
        ...(handoff.failureEventId === undefined ? {} : { failure_event_id: handoff.failureEventId }),
        ...(handoff.resolutionEventId === undefined
          ? {}
          : { resolution_event_id: handoff.resolutionEventId }),
        orphan_started_event_ids: [...handoff.orphanStartedEventIds],
        available_actions: handoffActions(handoff),
        conflicts: [...handoff.conflicts],
      },
    },
    operations: {
      step: projectStepCapability(plan),
      pause: projectControl(evaluateNativePauseBarrier(state)),
      // Même instantané que les quatre reprises ci-dessus : les statuts ne sont
      // pas reclassifiés, ils sont relus de vues déjà construites.
      resume: projectControl(
        evaluateNativeResumeBarrier({
          state,
          recovery: {
            initialization: initialization.status,
            step: step.status,
            send: send.status,
            handoff: handoff.status,
          },
        }),
      ),
      experts,
    },
    counts: { events: events.length },
  };
}

/**
 * Projette un run natif depuis un **snapshot stable déjà lu** (V2.1-IMP-17A).
 *
 * C'est le point d'entrée dont la surface HTTP aura besoin : une même fenêtre
 * de lecture doit produire **à la fois** la révision et la vue, sans quoi le
 * client verrait un état dont l'empreinte décrit un autre.
 *
 * ```text
 * snapshot S  →  S.revision
 *             →  NativeRunReadModelV1(S)     mêmes octets, même instant
 * ```
 *
 * Les trois faits canoniques ne sont **pas** relus : ce sont ceux du snapshot.
 * Seul `rounds/` est encore consulté, par la vue de reprise de transfert — et
 * c'est délibéré. Cet artefact diagnostique ne participe pas à la révision,
 * exactement comme l'observation du verrou n'y participe pas côté historique :
 *
 * ```text
 * rounds/ change  →  recovery.step.diagnostic_round peut changer
 *                 →  la révision, elle, ne change pas
 * ```
 *
 * Aucune capacité mutable ne dépend de cette donnée.
 */
export async function projectNativeRunReadModelFromSnapshot(
  snapshot: NativeRunSnapshot,
  maxTransferBytes?: number,
): Promise<NativeRunReadModelV1> {
  return projectNativeRunReadModel(
    // Le répertoire de runs ne sert qu'à retrouver `rounds/` : aucun fait
    // canonique n'est relu depuis le disque.
    path.dirname(snapshot.paths.root),
    snapshot.runId,
    snapshot.manifest,
    snapshot.state,
    snapshot.events,
    maxTransferBytes,
  );
}

/**
 * Lit un run natif et en produit la projection opérationnelle.
 *
 * Aucun verrou, aucune écriture, aucun fournisseur : les faits canoniques sont
 * lus **une fois**, et les quatre classifieurs reçoivent le même instantané.
 */
export async function buildNativeRunReadModel(
  deps: NativeReadModelDeps,
  runId: string,
): Promise<NativeRunReadModelV1> {
  const paths = runPaths(deps.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Le run ${runId} est de génération ${persisted.execution_mode} : la projection native ne le lit pas, ` +
        'et les vues historiques restent les siennes.',
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

  return projectNativeRunReadModel(
    deps.runsDir,
    runId,
    persisted.manifest,
    stateDoc.document,
    events,
    deps.maxTransferBytes,
  );
}
