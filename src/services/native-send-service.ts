/**
 * Message humain vers un expert d'un run natif V2.1 (Slice 2B).
 *
 * `send` n'est pas un transfert. Aucune enveloppe de contre-expertise, aucune
 * source consommée, aucun round : un humain parle directement à un expert, dans
 * sa session native, et le run revient exactement d'où il partait.
 *
 * ## Ce qui est repris de V2, sans le reformuler
 *
 * ```text
 * origine ∈ { PAUSED, WAITING_HUMAN }  →  le run y retourne
 * origine = FAILED_INITIALIZATION      →  le run y retourne (divergence 2B-R)
 * toute autre origine autorisée        →  le run revient à READY
 * succès                               →  le contrôle est inchangé
 * échec fournisseur                    →  le contrôle passe à HUMAN
 * ```
 *
 * Envoyer un message n'équivaut jamais à `ccr resume` : c'est précisément
 * pourquoi `send` reste disponible sous contrôle humain sans le lui reprendre.
 *
 * ## La divergence volontaire
 *
 * V2 libère son contexte d'opération dès l'écriture de la réponse. Le natif le
 * conserve jusqu'au commit, exactement comme le transfert (IMP-06) : sans lui,
 * une reprise ne pourrait pas établir que la réponse durable correspond au
 * `send` engagé, et rappellerait un fournisseur qui a déjà répondu.
 *
 * ## L'ordre durable, corrigé après le micro-gate 2B.1
 *
 * `human_message` est le **premier fait durable spécifique à l'envoi**. Aucune
 * mutation d'état ne le précède, exactement comme `round_started` précède la
 * transition dans le transfert (IMP-06).
 */

import { CcrError } from '../core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type { NativeRunManifest, NativeRunStateDocument } from '../core/run-native.ts';
import type { RunState } from '../core/state.ts';
import type { AgentTurnResult } from '../adapters/agent-adapter.ts';
import { assertInvocationQuotaAvailable } from './invocation-quota.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import { runPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import { persistNativeStateUpdate, readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import { runtimeSettingsOf } from './native-start-service.ts';
import { nativeGuardFacts, requireNativeSessionTarget } from './native-target-resolver.ts';
import type { NativeExpertTargetRef } from './native-target-resolver.ts';
import { sendGuard } from '../core/run-guards.ts';
import type { InvocationDispatchRecord } from '../core/usage-governance.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { appendInvocationOutcome } from '../store/invocation-outcome-store.ts';
import { nativeProcessFailedOutcome } from '../core/invocation-outcome.ts';
import type { NativeFailureDetail } from '../core/invocation-outcome.ts';
import { openUsageLedger } from '../store/usage-ledger.ts';
import { safeNativeSendRecoveryState } from './native-send-recovery-service.ts';
import { createUsageRecorder, recordTurnUsage } from './usage-governance-writer.ts';
import type { UsageGovernanceWarning } from './usage-governance-writer.ts';
import { operationalFailureState } from './run-service.ts';
import type { RunServiceDeps } from './run-service.ts';

/**
 * Points d'observation, pour rendre l'ordre durable vérifiable.
 *
 * Ils observent, ils ne décident de rien : aucune branche du service n'en
 * dépend.
 */
export interface NativeSendSeams {
  /** Après `human_message`, avant toute mutation d'état. */
  readonly afterHumanMessageJournaled?: () => void | Promise<void>;
  /**
   * Après la transition transitoire vers `RUNNING`, avant le contexte de
   * reprise. N'est appelé que lorsque cette transition a réellement lieu —
   * une origine humaine n'en produit aucune.
   */
  readonly afterTransientStatePersisted?: () => void | Promise<void>;
  /** Après `assistant_response`, avant la restauration de l'état d'origine. */
  readonly afterResponseJournaled?: () => void | Promise<void>;
  /**
   * Fabriques des journaux de gouvernance (V2.2-IMP-03).
   *
   * Injectables pour rendre un échec de persistance éprouvable sans corrompre
   * un système de fichiers. Absentes, les fabriques réelles s'appliquent.
   */
  readonly openInvocationLedger?: typeof openInvocationLedger;
  readonly openUsageLedger?: typeof openUsageLedger;
  /** Après le marqueur d'abandon, avant sa finalisation d'état. */
  readonly afterPreProviderAbortJournaled?: () => void | Promise<void>;
}

/**
 * Corrélation applicative facultative (V2.2-IMP-03).
 *
 * Même doctrine que le transfert : `operation_id` appartient à la couche qui a
 * reçu la requête, voyage explicitement, et n'est jamais requis.
 */
export interface NativeSendCorrelation {
  readonly operationId?: string;
}

export type { UsageGovernanceWarning };

export interface NativeSendResult {
  readonly runId: string;
  readonly expertSlot: ExpertSlotId;
  readonly provider: ProviderKind;
  readonly sessionId: string;
  readonly promptEventId: string;
  readonly responseEventId: string;
  readonly response: string;
  readonly state: NativeRunStateDocument;
  /** Invocation engagée pour ce tour. Toujours présente après un envoi abouti. */
  readonly invocationId: string;
  /** Vide lorsque la gouvernance d'usage a tout persisté. */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof CcrError) return { code: error.code, ...error.details };
  return { code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) };
}

/**
 * État où le run revient après un `send` réussi.
 *
 * ```text
 * READY                  → READY
 * RUNNING                → READY
 * PAUSED                 → PAUSED
 * WAITING_HUMAN          → WAITING_HUMAN
 * FAILED_INITIALIZATION  → FAILED_INITIALIZATION      divergence native
 * ```
 *
 * Les quatre premières lignes sont le chemin V2, repris tel quel : un `send`
 * depuis `RUNNING` rend bien un run `READY`, et la règle historique est
 * conservée plutôt que corrigée.
 *
 * La cinquième **diverge délibérément** du moteur historique (Slice 2B-R). V2
 * rendait `READY` un run parti de `FAILED_INITIALIZATION`, ce qui revenait à
 * déclarer l'initialisation terminée parce qu'un expert **déjà disponible**
 * avait répondu. Or le fait canonique n'a pas bougé : la session de l'autre
 * slot manque toujours, et `classifyRunLiveness` cessait pourtant de le
 * signaler.
 *
 * `send` ne possède aucune autorité pour conclure une initialisation
 * incomplète — c'est le travail de la reprise d'initialisation (1D). Il rend
 * donc le run exactement là où il l'a pris. Le moteur legacy est inchangé.
 */
function returnStateFor(origin: RunState): RunState {
  if (origin === 'PAUSED' || origin === 'WAITING_HUMAN') return origin;
  return origin === 'FAILED_INITIALIZATION' ? 'FAILED_INITIALIZATION' : 'READY';
}

function pinnedRuntime(manifest: NativeRunManifest, runId: string): NonNullable<NativeRunManifest['runtime_config']> {
  const runtime = manifest.runtime_config;
  if (runtime === undefined) {
    throw new CcrError(
      'MANIFEST_INVALID',
      `Le run natif ${runId} n'a aucun snapshot runtime épinglé : sa configuration d'exécution est indéterminée.`,
      { details: { runId } },
    );
  }
  return runtime;
}

/**
 * Envoie un message humain à un expert.
 *
 * La cible est résolue **sous le verrou** par le résolveur de 2A : un alias
 * ambigu ou non lié est refusé avant le moindre événement, la moindre mutation
 * et le moindre appel.
 */
export async function sendNativeMessage(
  deps: RunServiceDeps,
  runId: string,
  ref: NativeExpertTargetRef,
  message: string,
  seams: NativeSendSeams = {},
  boundary?: NativeMutationBoundary,
  correlation: NativeSendCorrelation = {},
): Promise<NativeSendResult> {
  const paths = runPaths(deps.runsDir, runId);

  return withNativeMutation(
    {
      runsDir: deps.runsDir,
      runId,
      command: 'native-send',
      ...(boundary === undefined ? {} : { boundary }),
    },
    async () => {
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
      throw new CcrError(
        'SCHEMA_VERSION_UNSUPPORTED',
        `Le run ${runId} est de génération ${persisted.execution_mode} : l'envoi natif ne le traite pas, ` +
          'et ne réinterprète pas ses commandes historiques.',
        { details: { runId, execution_mode: persisted.execution_mode } },
      );
    }
    const stateDoc = await readPersistedState(paths);
    if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
      throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
        details: { runId },
      });
    }

    const manifest = persisted.manifest;
    let state = stateDoc.document;

    // ---- 1. Cible. Un refus d'alias survient ici, avant tout effet.
    const target = requireNativeSessionTarget(manifest, ref);

    // ---- 2. Gardes de V2, inchangées.
    const verdict = sendGuard(nativeGuardFacts(state), true);
    if (verdict.kind === 'REFUSED') {
      throw new CcrError(
        verdict.reason === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'ILLEGAL_STATE_TRANSITION',
        verdict.reason === 'RECOVERY_REQUIRED'
          ? `Le run ${runId} porte une opération engagée : aucun envoi avant sa résolution.`
          : `Le run ${runId} est en ${state.state} : aucun envoi ne peut en partir.`,
        { details: { runId, expert_slot: target.expertSlot, state: state.state, control: state.control } },
      );
    }

    const origin = state.state;
    const humanOrigin = origin === 'PAUSED' || origin === 'WAITING_HUMAN';
    const returnState = returnStateFor(origin);

    const events = await openNativeEventStore(paths, manifest);

    // ---- 2 bis. Politique de quota (V2.2-IMP-08).
    //
    // Avant le message humain, qui est le **prompt** de l'invocation et non une
    // décision canonique autonome : l'écrire pour un envoi refusé laisserait
    // croire qu'un message a été adressé à un expert qui ne l'a jamais reçu.
    await assertInvocationQuotaAvailable(paths, runId);

    // ---- 3. Le message humain, tel quel. Ce n'est pas une enveloppe de
    // transfert : aucun `SOURCE_EXPERT`, aucun `SOURCE_EVENT_ID`.
    //
    // Il est écrit **avant toute mutation d'état** (micro-gate 2B.1). La
    // première version transitait par `RUNNING` d'abord : un arrêt brutal entre
    // les deux laissait alors un run muté sans qu'aucun fait ne nomme
    // l'opération — indiscernable d'un `RUNNING` légitime. Pire, une origine
    // `FAILED_INITIALIZATION` perdait son étiquette, et un run partiellement
    // initialisé cessait d'être signalé comme tel.
    //
    // Désormais, un crash avant cet append ne laisse **rien** : le run est
    // exactement celui d'avant l'envoi.
    const promptEvent = await events.append({
      round: state.round,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: target.expertSlot,
      session_id: target.sessionId,
      content: message,
      timestamp: deps.now().toISOString(),
    });

    await seams.afterHumanMessageJournaled?.();

    // ---- 4. Sous automatisation, un tour n'est atteint qu'après RUNNING
    // (règle V2, inchangée). L'origine réelle reste lisible jusqu'ici.
    if (!humanOrigin) {
      state = await persistNativeStateUpdate(
        paths,
        state,
        { state: 'RUNNING', lastEventId: promptEvent.event_id },
        deps.now(),
      );
      await seams.afterTransientStatePersisted?.();
    }

    // ---- 5. Contexte de reprise, durable AVANT tout lancement.
    state = await persistNativeStateUpdate(
      paths,
      state,
      {
        state: 'WAITING_AGENT',
        activeExpertSlot: target.expertSlot,
        lastEventId: promptEvent.event_id,
        pendingOperation: {
          kind: 'send',
          expert_slot: target.expertSlot,
          round: state.round,
          prompt_event_id: promptEvent.event_id,
          session_id: target.sessionId,
          // C'est ici que l'état à restaurer devient durable : sans lui, une
          // reprise ne saurait pas où rendre le run.
          return_state: returnState,
          return_control: state.control,
          started_at: deps.now().toISOString(),
        },
      },
      deps.now(),
    );

    // `detail` n'est fourni que par le site qui **construit** le fait natif :
    // CCR en connaît alors la structure parce qu'il l'a écrite. Une erreur
    // venue de l'adaptateur n'en reçoit aucun — son sac de diagnostic est
    // propre au fournisseur, et reste dans `process_failed.details`.
    const fail = async (error: unknown, detail?: NativeFailureDetail): Promise<never> => {
      const failureEvent = await events.append({
        round: state.round,
        actor: 'system',
        type: 'process_failed',
        target_expert_slot_id: target.expertSlot,
        session_id: target.sessionId,
        content: error instanceof Error ? error.message : String(error),
        details: errorDetails(error),
        based_on: [promptEvent.event_id],
        timestamp: deps.now().toISOString(),
      });
      // Échec déterministe : CCR sait que le tour n'a pas abouti. Le contexte
      // est libéré — le conserver suggérerait une ambiguïté qui n'existe pas.
      // Le passage sous contrôle humain est le comportement V2, conservé.
      state = await persistNativeStateUpdate(
        paths,
        state,
        {
          state: operationalFailureState(error),
          control: 'HUMAN',
          activeExpertSlot: null,
          pendingOperation: null,
          lastEventId: failureEvent.event_id,
        },
        deps.now(),
      );
      // Issue négative durable, **avant** que l'erreur n'atteigne la surface
      // produit. Ce corps s'exécute déjà sous le verrou de run : aucune reprise
      // de verrou, qui échouerait — il n'est pas réentrant.
      //
      // L'événement `process_failed` demeure : transcript natif et issue
      // d'invocation sont deux autorités distinctes, et la seconde ne remplace
      // pas le premier.
      await appendInvocationOutcome(
        paths,
        dispatch.invocation_id,
        nativeProcessFailedOutcome(error, detail),
        deps.now().toISOString(),
      );
      throw error;
    };

    /**
     * Clôt un envoi dont CCR sait qu'aucun appel n'a été engagé (V2.2-IMP-03).
     *
     * `process_failed` serait un mensonge : il porte le slot et la session de la
     * cible, et attribuerait à l'expert une panne de stockage de CCR. Le fait
     * honnête existe déjà — `send_aborted_before_provider`, motif
     * `PRE_PROVIDER_ABORTED`, gelé en 2B-R — et l'état final est celui que la
     * reprise produirait, obtenu de **sa** primitive plutôt qu'imité.
     */
    const abortBeforeProvider = async (cause: unknown): Promise<never> => {
      let cleanup: Record<string, unknown> | undefined;
      try {
        const aborted = await events.append({
          round: state.round,
          actor: 'system',
          type: 'send_aborted_before_provider',
          target_expert_slot_id: target.expertSlot,
          prompt_event_id: promptEvent.event_id,
          reason: 'PRE_PROVIDER_ABORTED',
          content: "Envoi abandonné : aucun appel fournisseur n'avait été engagé.",
          based_on: [promptEvent.event_id],
          details: {
            basis: "L'engagement d'invocation n'a pas pu être persisté, avant tout appel.",
            provider_calls: 0,
            note: "Cette tentative est close. Un nouvel envoi serait une nouvelle tentative, jamais celle-ci.",
          },
          timestamp: deps.now().toISOString(),
        });
        await seams.afterPreProviderAbortJournaled?.();
        state = await persistNativeStateUpdate(
          paths,
          state,
          {
            // Ni round, ni curseur : un envoi n'a jamais été un transfert.
            state: safeNativeSendRecoveryState(runId, manifest, state, await events.readAll()),
            control: 'HUMAN',
            activeExpertSlot: null,
            pendingOperation: null,
            lastEventId: aborted.event_id,
          },
          deps.now(),
        );
      } catch (cleanupError) {
        cleanup = errorDetails(cleanupError);
      }
      throw new CcrError(
        'INVOCATION_LEDGER_WRITE_FAILED',
        `Le journal d'invocations du run ${runId} n'a pas pu être écrit. Aucun agent n'a été ` +
          'sollicité, et ce message n’a été transmis à personne.',
        {
          details: {
            runId,
            expert_slot: target.expertSlot,
            ...errorDetails(cause),
            ...(cleanup === undefined ? {} : { cleanup_error: cleanup }),
          },
          cause,
        },
      );
    };

    // ---- 6. Seule la session de la cible est reprise. Jamais `start()`.
    //
    // Runtime et lanceurs sont résolus AVANT l'engagement : ils se décident
    // sans appeler personne, et ne consomment donc aucune invocation.
    const adapters = deps.createAdapters(
      manifest.workspace.cwd,
      runtimeSettingsOf(pinnedRuntime(manifest, runId)),
    );

    // ---- 6 bis. Frontière autoritaire (V2.2-IMP-03).
    //
    // Dernier fait durable avant l'entrée dans l'adapter. Un envoi n'a ni round
    // consommé ni source : `round` et `source_event_id` sont donc absents de
    // l'enregistrement, et n'y sont pas fabriqués.
    const invocations = await (seams.openInvocationLedger ?? openInvocationLedger)(paths, runId);
    let dispatch: InvocationDispatchRecord;
    try {
      dispatch = await invocations.append(
        {
          identity: {
            generation: 'NATIVE_V21_EXECUTION',
            expert_slot: target.expertSlot,
            provider: target.provider,
          },
          trigger_kind: 'SEND',
          session_id: target.sessionId,
          prompt_event_id: promptEvent.event_id,
          ...(correlation.operationId === undefined ? {} : { operation_id: correlation.operationId }),
        },
        deps.now(),
      );
    } catch (error) {
      return abortBeforeProvider(error);
    }

    let turn: AgentTurnResult;
    try {
      // Une seule tentative : aucun retry.
      turn = await adapters[target.provider].resume(target.sessionId, message);
    } catch (error) {
      return fail(error);
    }

    // ---- 7. Continuité : la réponse doit venir de la session visée.
    if (turn.sessionId !== target.sessionId) {
      return fail(
        new CcrError(
          'AGENT_SESSION_MISMATCH',
          `Le slot « ${target.expertSlot} » a répondu sous la session « ${turn.sessionId} » alors que ` +
            `« ${target.sessionId} » était reprise. Poursuivre écrirait dans une conversation qui n'est ` +
            'pas celle de cet expert.',
          {
            details: {
              runId,
              slot: target.expertSlot,
              provider: target.provider,
              expected: target.sessionId,
              found: turn.sessionId,
            },
          },
        ),
        // Le fait durable conserve les deux sessions : sans elles, « dérive de
        // session » ne nomme plus de quelle conversation il s'agit.
        {
          code: 'AGENT_SESSION_MISMATCH',
          expert_slot: target.expertSlot,
          provider: target.provider,
          expected_session_id: target.sessionId,
          found_session_id: turn.sessionId,
        },
      );
    }

    // ---- 8. Réponse. Le contexte de reprise reste **durable**.
    const responseEvent = await events.append({
      round: state.round,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: target.expertSlot,
      session_id: turn.sessionId,
      content: turn.content,
      exit_code: turn.exitCode,
      // Causalité unique, celle de V2 : la réponse dérive du message.
      based_on: [promptEvent.event_id],
      timestamp: deps.now().toISOString(),
    });
    state = await persistNativeStateUpdate(
      paths,
      state,
      // `pendingOperation` volontairement omis : l'envoi n'est pas finalisé, et
      // son contexte est ce qui rendra une reprise locale possible.
      { activeExpertSlot: null, lastEventId: responseEvent.event_id },
      deps.now(),
    );

    await seams.afterResponseJournaled?.();

    // ---- 8 bis. Gouvernance d'usage, APRÈS la réponse durable (V2.2-IMP-03).
    //
    // Même invariant que STEP : une réponse obtenue appartient à la
    // controverse, même si la gouvernance tombe en panne.
    const recorder = createUsageRecorder(
      await (seams.openUsageLedger ?? openUsageLedger)(paths, runId),
      dispatch.invocation_id,
      deps.now,
    );
    await recordTurnUsage(recorder, turn);

    // ---- 9. Retour à l'état prévu. Le contrôle n'est pas touché.
    state = await persistNativeStateUpdate(
      paths,
      state,
      { state: returnState, activeExpertSlot: null, pendingOperation: null },
      deps.now(),
    );

    return {
      runId,
      expertSlot: target.expertSlot,
      provider: target.provider,
      sessionId: turn.sessionId,
      promptEventId: promptEvent.event_id,
      responseEventId: responseEvent.event_id,
      response: turn.content,
      state,
      invocationId: dispatch.invocation_id,
      usageGovernanceWarnings: recorder.warnings,
    };
  });
}
