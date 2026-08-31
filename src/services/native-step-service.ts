/**
 * Exécution d'un transfert natif V2.1 (Slice 1F).
 *
 * Premier passage de témoin réellement dirigé par les slots : l'expert cible
 * reçoit la position de son contradicteur, dans **sa** session native, quel que
 * soit le moteur des deux côtés.
 *
 * ## Deux divergences volontaires avec le STEP historique
 *
 * Elles ne sont pas des améliorations de style : sans elles, la reprise d'un
 * transfert interrompu serait impossible sans rappeler un fournisseur.
 *
 * ```text
 * V2   state.round est incrémenté AVANT l'appel
 * V2.1 state.round n'avance qu'au commit du transfert finalisé
 *
 * V2   pending_operation est libéré dès l'écriture de la réponse
 * V2.1 pending_operation reste durable jusqu'après `round_completed`
 * ```
 *
 * La seconde crée délibérément une fenêtre observable :
 *
 * ```text
 * réponse cible durable  +  transfert engagé durable  +  round_completed absent
 * ```
 *
 * Un futur slice de reprise doit pouvoir y lire « le fournisseur a répondu, la
 * finalisation manque » et terminer localement. Libérer le contexte plus tôt
 * effacerait précisément le fait qui rend cette lecture possible.
 *
 * ## Ce qui n'est pas ici
 *
 * Aucune reprise, aucun `SEND`, aucun alias, aucune surface. 1F produit des
 * états persistés interprétables ; il ne les interprète pas.
 */

import { CcrError } from '../core/errors.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import { NATIVE_ROUND_SCHEMA_VERSION } from '../core/run-native.ts';
import type {
  NativeRunManifest,
  NativeRunStateDocument,
  NativeTransferBlockedEvent,
} from '../core/run-native.ts';
import type { AgentTurnResult } from '../adapters/agent-adapter.ts';
import { createUsageRecorder, recordTurnUsage } from './usage-governance-writer.ts';
import type { UsageGovernanceWarning } from './usage-governance-writer.ts';
import type { InvocationDispatchRecord } from '../core/usage-governance.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { appendInvocationOutcome } from '../store/invocation-outcome-store.ts';
import { nativeProcessFailedOutcome } from '../core/invocation-outcome.ts';
import type { NativeFailureDetail } from '../core/invocation-outcome.ts';
import { openUsageLedger } from '../store/usage-ledger.ts';
import { assertInvocationQuotaAvailable } from './invocation-quota.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import { runPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import { persistNativeStateUpdate, readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import { writeNativeRoundMetadata, writeNativeRoundTurnArtifacts } from '../store/native-round-store.ts';
import { planNativeStep } from './native-step-planner.ts';
import type { NativeStepPlan } from './native-step-planner.ts';
import { runtimeSettingsOf } from './native-start-service.ts';
import { operationalFailureState } from './run-service.ts';
import type { RunServiceDeps } from './run-service.ts';

/**
 * Points d'observation, pour rendre l'ordre durable verifiable.
 *
 * Ils observent, ils ne decident de rien : aucune branche du service ne depend
 * de leur presence. La fenetre entre la reponse journalisee et la finalisation
 * est precisement celle que le slice de reprise devra savoir lire — sans seam,
 * elle ne serait constatable qu'en tuant un processus.
 */
export interface NativeStepSeams {
  /** Apres `assistant_response`, avant `round_completed`. */
  readonly afterResponseJournaled?: () => void | Promise<void>;
  /**
   * Fabriques des journaux de gouvernance (V2.2-IMP-02).
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
 * Corrélation applicative facultative (V2.2-IMP-02).
 *
 * `operation_id` appartient à la couche qui a reçu la requête HTTP. Il voyage
 * explicitement jusqu'ici, et n'est **jamais** requis : une invocation lancée
 * depuis la CLI n'en a pas, et son autorité n'en dépend pas.
 */
export interface NativeStepCorrelation {
  readonly operationId?: string;
}

export type { UsageGovernanceWarning };

export interface NativeStepResult {
  readonly runId: string;
  readonly round: number;
  readonly sourceSlot: ExpertSlotId;
  readonly targetSlot: ExpertSlotId;
  readonly sourceEventId: string;
  readonly responseEventId: string;
  readonly targetSessionId: string;
  readonly transferredBytes: number;
  readonly response: string;
  readonly state: NativeRunStateDocument;
  /** Invocation engagée pour ce tour. Toujours présente après un STEP abouti. */
  readonly invocationId: string;
  /** Vide lorsque la gouvernance d'usage a tout persisté. */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof CcrError) return { code: error.code, ...error.details };
  return { code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Exécute exactement le transfert que le planificateur décide.
 *
 * Le plan est calculé **sous le verrou**, jamais avant : le calculer d'abord
 * pour l'exécuter ensuite laisserait une fenêtre pendant laquelle la source, le
 * curseur ou l'état auraient pu changer entre la décision et la mutation.
 */
export async function stepNativeRun(
  deps: RunServiceDeps,
  runId: string,
  seams: NativeStepSeams = {},
  boundary?: NativeMutationBoundary,
  correlation: NativeStepCorrelation = {},
): Promise<NativeStepResult> {
  const paths = runPaths(deps.runsDir, runId);

  return withNativeMutation(
    {
      runsDir: deps.runsDir,
      runId,
      command: 'native-step',
      ...(boundary === undefined ? {} : { boundary }),
    },
    async () => {
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
      throw new CcrError(
        'SCHEMA_VERSION_UNSUPPORTED',
        `Le run ${runId} est de génération ${persisted.execution_mode} : le transfert natif ne le ` +
          "traite pas, et ne projette pas son STEP dans le protocole par slot.",
        { details: { runId, execution_mode: persisted.execution_mode } },
      );
    }
    const stateDoc = await readPersistedState(paths);
    if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
      throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
        details: { runId },
      });
    }

    const manifest: NativeRunManifest = persisted.manifest;
    const events = await openNativeEventStore(paths, manifest);
    let state = stateDoc.document;

    // ---- 1. Décision, sous le verrou, par la primitive de 1E et elle seule.
    const plan: NativeStepPlan = planNativeStep({
      runId,
      manifest,
      state,
      events: await events.readAll(),
      ...(deps.maxTransferBytes === undefined ? {} : { maxTransferBytes: deps.maxTransferBytes }),
    });

    if (plan.kind === 'REFUSED') throw plan.error;

    // ---- 1 bis. Politique de quota (V2.2-IMP-08).
    //
    // Avant le garde-fou de taille, et pour une raison de précédence : celui-ci
    // produit un fait durable et bascule le run en `WAITING_HUMAN`. Un run dont
    // la politique est épuisée ne doit pas voir son état changer pour un
    // transfert qui n'aurait de toute façon joint personne.
    await assertInvocationQuotaAvailable(paths, runId);

    // ---- 2. Transfert refusé avant tout appel : le fait est journalisé.
    if (plan.kind === 'PAYLOAD_TOO_LARGE') {
      const blocked: Omit<NativeTransferBlockedEvent, 'event_id' | 'run_id' | 'timestamp'> = {
        round: state.round,
        actor: 'system',
        type: 'transfer_blocked',
        source_slot_id: plan.sourceSlot,
        target_slot_id: plan.targetSlot,
        source_event_id: plan.sourceEventId,
        reason: 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
        based_on: [plan.sourceEventId],
        details: { payload_bytes: plan.payloadBytes, limit_bytes: plan.limitBytes },
      };
      const event = await events.append({ ...blocked, timestamp: deps.now().toISOString() });

      // Même intention que le garde-fou V2 : le contenu source reste intact, et
      // la décision revient à l'humain. Ni le round ni le curseur ne bougent,
      // et la source n'est pas consommée — elle n'a été transférée à personne.
      state = await persistNativeStateUpdate(
        paths,
        state,
        { state: 'WAITING_HUMAN', control: 'HUMAN', lastEventId: event.event_id },
        deps.now(),
      );
      throw plan.error;
    }

    // ---- 3. Ouverture du round. Il ne consomme pas la source et n'avance rien.
    const round = plan.nextRoundNumber;
    const startedEvent = await events.append({
      round,
      actor: 'system',
      type: 'round_started',
      target_expert_slot_id: plan.targetSlot,
      based_on: [plan.sourceEventId],
      details: {
        round,
        source_slot: plan.sourceSlot,
        target_slot: plan.targetSlot,
        source_event_id: plan.sourceEventId,
        transferred_bytes: plan.payloadBytes,
      },
      timestamp: deps.now().toISOString(),
    });
    state = await persistNativeStateUpdate(
      paths,
      state,
      { state: 'RUNNING', lastEventId: startedEvent.event_id },
      deps.now(),
    );

    // ---- 4. Intention, puis contexte de reprise, avant tout lancement.
    const promptEvent = await events.append({
      round,
      actor: 'system',
      type: 'prompt_sent',
      target_expert_slot_id: plan.targetSlot,
      session_id: plan.targetSessionId,
      content: plan.envelope,
      based_on: [plan.sourceEventId],
      timestamp: deps.now().toISOString(),
    });
    state = await persistNativeStateUpdate(
      paths,
      state,
      {
        state: 'WAITING_AGENT',
        // La session en cours d'exécution est celle de la **cible** : c'est
        // elle qui produit le tour.
        activeExpertSlot: plan.targetSlot,
        lastEventId: promptEvent.event_id,
        pendingOperation: {
          kind: 'step',
          source_slot: plan.sourceSlot,
          target_slot: plan.targetSlot,
          source_event_id: plan.sourceEventId,
          round,
          prompt_event_id: promptEvent.event_id,
          session_id: plan.targetSessionId,
          return_state: 'READY',
          return_control: 'AUTOMATION',
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
        round,
        actor: 'system',
        type: 'process_failed',
        target_expert_slot_id: plan.targetSlot,
        session_id: plan.targetSessionId,
        content: error instanceof Error ? error.message : String(error),
        details: errorDetails(error),
        based_on: [promptEvent.event_id],
        timestamp: deps.now().toISOString(),
      });
      // Échec déterministe : CCR sait que le tour n'a pas abouti. Le contexte
      // est libéré — le conserver suggérerait une ambiguïté qui n'existe pas.
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
     * Ferme une tentative dont CCR sait qu'aucun fournisseur n'a été appelé.
     *
     * `process_failed` serait un mensonge : il porte la session et le slot de
     * la cible, et attribuerait à l'expert une panne de stockage de CCR. Le
     * type honnête existe déjà en V2.1 — `transfer_aborted_before_provider`,
     * motif `PRE_PROVIDER_ABORTED` : faits préparatoires écrits, aucun appel,
     * source réutilisable.
     *
     * La fermeture est menée jusqu'au bout ici même. `RESOLUTION_NEEDS_COMMIT`
     * reste réservé à une interruption **pendant** cette fermeture ; le laisser
     * derrière soi alors que le processus pouvait finir demanderait une reprise
     * pour rien.
     */
    const abortBeforeProvider = async (cause: unknown): Promise<never> => {
      let cleanup: Record<string, unknown> | undefined;
      try {
        const aborted = await events.append({
          round,
          actor: 'system',
          type: 'transfer_aborted_before_provider',
          source_slot_id: plan.sourceSlot,
          target_slot_id: plan.targetSlot,
          source_event_id: plan.sourceEventId,
          reason: 'PRE_PROVIDER_ABORTED',
          // La causalité porte sur la **tentative**, nommée par son ouverture.
          based_on: [startedEvent.event_id],
          timestamp: deps.now().toISOString(),
        });
        await seams.afterPreProviderAbortJournaled?.();
        state = await persistNativeStateUpdate(
          paths,
          state,
          {
            // Ni round, ni curseur : rien n'a été transféré, et la source
            // reste exactement là où le planificateur l'a trouvée.
            state: 'PAUSED',
            control: 'HUMAN',
            activeExpertSlot: null,
            pendingOperation: null,
            lastEventId: aborted.event_id,
          },
          deps.now(),
        );
      } catch (cleanupError) {
        // La cause première reste celle-ci : la panne de persistance qui a
        // empêché l'engagement. L'échec de fermeture l'accompagne en
        // diagnostic, sans jamais la masquer — et rien n'est réessayé.
        cleanup = errorDetails(cleanupError);
      }
      throw new CcrError(
        'INVOCATION_LEDGER_WRITE_FAILED',
        `Le journal d'invocations du run ${runId} n'a pas pu être écrit. Aucun agent n'a été ` +
          'sollicité, et la source reste réutilisable.',
        {
          details: {
            runId,
            round,
            target_slot: plan.targetSlot,
            ...errorDetails(cause),
            ...(cleanup === undefined ? {} : { cleanup_error: cleanup }),
          },
          cause,
        },
      );
    };

    // ---- 5. Seule la session **cible** est reprise. Jamais celle de la source.
    //
    // Runtime et lanceurs sont résolus AVANT l'engagement : un exécutable
    // introuvable ou un runtime non épinglé se décide sans appeler personne, et
    // ne doit donc consommer aucune invocation.
    const adapters = deps.createAdapters(
      manifest.workspace.cwd,
      runtimeSettingsOf(pinnedRuntime(manifest, runId)),
    );

    // ---- 5 bis. Frontière autoritaire (V2.2-IMP-02).
    //
    // `DISPATCH_COMMITTED` est le dernier fait durable avant l'entrée dans
    // l'adapter. Il n'affirme ni un processus lancé, ni une requête réseau, ni
    // une unité facturée : il affirme que CCR s'est engagé. Rien du retour de
    // l'adapter n'est nécessaire pour le construire.
    const invocations = await (seams.openInvocationLedger ?? openInvocationLedger)(paths, runId);
    let dispatch: InvocationDispatchRecord;
    try {
      dispatch = await invocations.append(
        {
          identity: {
            generation: 'NATIVE_V21_EXECUTION',
            expert_slot: plan.targetSlot,
            provider: plan.targetProvider,
          },
          trigger_kind: 'STEP',
          session_id: plan.targetSessionId,
          round,
          prompt_event_id: promptEvent.event_id,
          source_event_id: plan.sourceEventId,
          ...(correlation.operationId === undefined ? {} : { operation_id: correlation.operationId }),
        },
        deps.now(),
      );
    } catch (error) {
      // Aucun engagement durable ⇒ aucun appel. La tentative est fermée comme
      // ce qu'elle est : un abandon **avant** tout fournisseur.
      return abortBeforeProvider(error);
    }

    let turn: AgentTurnResult;
    try {
      // Une seule tentative : aucun retry.
      turn = await adapters[plan.targetProvider].resume(plan.targetSessionId, plan.envelope);
    } catch (error) {
      return fail(error);
    }

    // ---- 6. Continuité : la réponse doit venir de la session visée.
    if (turn.sessionId !== plan.targetSessionId) {
      return fail(
        new CcrError(
          'AGENT_SESSION_MISMATCH',
          `Le slot « ${plan.targetSlot} » a répondu sous la session « ${turn.sessionId} » alors que ` +
            `« ${plan.targetSessionId} » était reprise. Poursuivre écrirait dans une conversation ` +
            "qui n'est pas celle de cet expert.",
          {
            details: {
              runId,
              slot: plan.targetSlot,
              provider: plan.targetProvider,
              expected: plan.targetSessionId,
              found: turn.sessionId,
            },
          },
        ),
        // Le fait durable conserve les deux sessions : sans elles, « dérive de
        // session » ne nomme plus de quelle conversation il s'agit.
        {
          code: 'AGENT_SESSION_MISMATCH',
          expert_slot: plan.targetSlot,
          provider: plan.targetProvider,
          expected_session_id: plan.targetSessionId,
          found_session_id: turn.sessionId,
        },
      );
    }

    // ---- 7. Réponse cible. Le contexte de reprise reste **durable**.
    const responseEvent = await events.append({
      round,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: plan.targetSlot,
      session_id: turn.sessionId,
      content: turn.content,
      exit_code: turn.exitCode,
      based_on: [promptEvent.event_id],
      timestamp: deps.now().toISOString(),
    });
    // ---- 7 bis. Gouvernance d'usage, APRÈS la réponse durable (V2.2-IMP-02).
    //
    // L'ordre importe plus qu'il n'y paraît : une réponse obtenue appartient à
    // la controverse, même si la gouvernance tombe en panne. Écrire l'usage
    // avant `assistant_response` ferait dépendre la conservation d'un tour
    // modèle d'un journal accessoire.
    const recorder = createUsageRecorder(
      await (seams.openUsageLedger ?? openUsageLedger)(paths, runId),
      dispatch.invocation_id,
      deps.now,
    );
    await recordTurnUsage(recorder, turn);

    state = await persistNativeStateUpdate(
      paths,
      state,
      // `pendingOperation` volontairement omis : le transfert n'est pas encore
      // finalisé, et son contexte est ce qui rendra la reprise locale possible.
      { state: 'RUNNING', activeExpertSlot: null, lastEventId: responseEvent.event_id },
      deps.now(),
    );

    await seams.afterResponseJournaled?.();

    // ---- 8. Finalisation canonique : c'est elle qui consomme la source.
    const completedEvent = await events.append({
      round,
      actor: 'system',
      type: 'round_completed',
      source_slot_id: plan.sourceSlot,
      target_slot_id: plan.targetSlot,
      source_event_id: plan.sourceEventId,
      response_event_id: responseEvent.event_id,
      based_on: [plan.sourceEventId, responseEvent.event_id],
      timestamp: deps.now().toISOString(),
    });

    // ---- 9. Projection diagnostique. Elle n'arbitre rien.
    await writeNativeRoundTurnArtifacts(paths, round, plan.targetSlot, {
      prompt: plan.envelope,
      response: turn.content,
      stdoutRaw: turn.stdoutRaw,
      stderrRaw: turn.stderrRaw,
    });
    await writeNativeRoundMetadata(paths, {
      schema_version: NATIVE_ROUND_SCHEMA_VERSION,
      run_id: runId,
      round,
      started_at: startedEvent.timestamp,
      completed_at: completedEvent.timestamp,
      workspace_cwd: manifest.workspace.cwd,
      source_slot: plan.sourceSlot,
      target_slot: plan.targetSlot,
      source_event_id: plan.sourceEventId,
      response_event_id: responseEvent.event_id,
      turns: [
        {
          expert_slot: plan.targetSlot,
          prompt_event_id: promptEvent.event_id,
          response_event_id: responseEvent.event_id,
          started_at: turn.startedAt,
          completed_at: turn.completedAt,
          provider: plan.targetProvider,
          session_id: turn.sessionId,
        },
      ],
    });

    // ---- 10. Commit. Le curseur passe à la cible : c'est sa réponse qui sera
    // la prochaine source.
    state = await persistNativeStateUpdate(
      paths,
      state,
      {
        state: 'READY',
        round,
        nextStepSourceSlot: plan.targetSlot,
        activeExpertSlot: null,
        pendingOperation: null,
        lastEventId: completedEvent.event_id,
      },
      deps.now(),
    );

    return {
      runId,
      round,
      sourceSlot: plan.sourceSlot,
      targetSlot: plan.targetSlot,
      sourceEventId: plan.sourceEventId,
      responseEventId: responseEvent.event_id,
      targetSessionId: turn.sessionId,
      transferredBytes: plan.payloadBytes,
      response: turn.content,
      state,
      invocationId: dispatch.invocation_id,
      usageGovernanceWarnings: recorder.warnings,
    };
  });
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
