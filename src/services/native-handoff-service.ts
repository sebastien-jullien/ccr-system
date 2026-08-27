/**
 * Attachement humain à la session native d'un expert (Slice 2C).
 *
 * `handoff` n'envoie rien. Il n'y a ni prompt CCR, ni enveloppe, ni message :
 * l'humain est rattaché à une conversation native **qui existe déjà**, et CCR
 * n'observe que la frontière de cette intervention.
 *
 * ## Frontière épistémique
 *
 * CCR sait qu'une période d'interaction externe a été **ouverte** puis
 * **terminée**. Il ne prétend pas connaître le contenu des tours échangés dans
 * l'interface interactive : les transcripts natifs sont privés, et CCR ne les
 * lit pas.
 *
 * En conséquence, un handoff n'écrit jamais de `human_message`, jamais
 * d'`assistant_response`, jamais de `round_completed` — inventer ces faits
 * reviendrait à fabriquer une conversation que CCR n'a pas vue. La continuité
 * cognitive vit dans la session native ; le journal CCR ne conserve que la
 * frontière.
 *
 * Corollaire assumé : un handoff seul ne crée **aucune** source transférable.
 * Le planificateur continue de raisonner sur la dernière `assistant_response`
 * réellement journalisée du slot attendu.
 *
 * ## Frontière de coût
 *
 * ```text
 * HANDOFF interactive native  →  COST = NOT CONTROLLED / NOT MEASURED
 * ```
 *
 * Doctrine inchangée (`V2-IMP-45`) : ni prompts, ni réponses, ni tokens, ni
 * facturation ne sont comptés. Ce n'est pas une invocation orchestrée par CCR.
 *
 * ## La divergence volontaire
 *
 * V2 libère son contexte d'opération **dans la même écriture** que
 * l'événement de fin. Le natif le conserve jusqu'à un commit distinct, comme le
 * transfert (IMP-06) et l'envoi (IMP-09) : sans cela, la fenêtre « interaction
 * terminée, état non finalisé » n'existerait pas sur disque, et une reprise ne
 * pourrait pas la distinguer d'une interaction jamais conclue.
 */

import { CcrError } from '../core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type { NativeRunManifest, NativeRunStateDocument } from '../core/run-native.ts';
import type { InteractiveResult } from '../process/process-runner.ts';
import { withRunLock } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import { persistNativeStateUpdate, readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import { runtimeSettingsOf } from './native-start-service.ts';
import { evaluateNativeManualAction } from './native-target-resolver.ts';
import type { NativeExpertTargetRef } from './native-target-resolver.ts';
import type { RunServiceDeps } from './run-service.ts';

/**
 * Points d'observation, pour rendre l'ordre durable vérifiable.
 *
 * Ils observent, ils ne décident de rien : aucune branche du service n'en
 * dépend.
 */
export interface NativeHandoffSeams {
  /** Après `human_handoff_started`, avant toute mutation d'état. */
  readonly afterStartedJournaled?: () => void | Promise<void>;
  /** Après le contexte de reprise, avant tout lancement interactif. */
  readonly afterPendingPersisted?: () => void | Promise<void>;
  /** Au retour du client interactif, avant l'événement de fin. */
  readonly afterInteractiveReturned?: () => void | Promise<void>;
  /** Après `human_handoff_finished`, avant le commit local. */
  readonly afterFinishedJournaled?: () => void | Promise<void>;
}

export interface NativeHandoffResult {
  readonly runId: string;
  readonly expertSlot: ExpertSlotId;
  readonly provider: ProviderKind;
  readonly sessionId: string;
  readonly startedEventId: string;
  readonly finishedEventId: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly state: NativeRunStateDocument;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof CcrError) return { code: error.code, ...error.details };
  return { code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) };
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
 * Rattache l'humain à la session native d'un expert.
 *
 * La cible est résolue **sous le verrou** par le résolveur de 2A, et les gardes
 * sont celles de V2 : un alias ambigu, un run non suspendu ou une session
 * absente sont refusés avant le moindre événement, la moindre mutation et le
 * moindre lancement.
 *
 * Aucune session n'est jamais créée : `start()` n'est pas appelé, et un slot
 * injoignable ne devient jamais l'autre.
 */
export async function handoffNativeExpert(
  deps: RunServiceDeps,
  runId: string,
  ref: NativeExpertTargetRef,
  seams: NativeHandoffSeams = {},
): Promise<NativeHandoffResult> {
  const paths = runPaths(deps.runsDir, runId);

  // Le verrou couvre toute la durée de l'interaction native, comme en V2.
  return withRunLock(paths, 'native-handoff', async () => {
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
      throw new CcrError(
        'SCHEMA_VERSION_UNSUPPORTED',
        `Le run ${runId} est de génération ${persisted.execution_mode} : le handoff natif ne le traite pas, ` +
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

    // ---- 1–2. Cible et gardes, par l'évaluation pure de 2A : même ordre de
    // refus qu'elle, et aucune seconde logique de résolution.
    const evaluation = evaluateNativeManualAction(manifest, state, { action: 'HANDOFF', ref });
    if (evaluation.verdict.kind === 'REFUSED') {
      throw (
        evaluation.error ??
        new CcrError('INVALID_ARGUMENT', `Handoff refusé sur le run ${runId}.`, { details: { runId } })
      );
    }
    const target = evaluation.target;
    if (target === undefined || target.sessionId === null) {
      // Inatteignable : la garde refuse `SESSION_MISSING` avant d'autoriser.
      throw new CcrError('STATE_INVALID', `Cible de handoff incomplète pour le run ${runId}.`, {
        details: { runId },
      });
    }
    const sessionId = target.sessionId;

    const events = await openNativeEventStore(paths, manifest);
    const startedAt = deps.now().toISOString();

    // ---- 3. Premier fait durable spécifique au handoff. Aucune mutation
    // d'état ne le précède : un arrêt brutal avant cet append ne laisse rien,
    // et le run est exactement celui d'avant l'action (règle de 2B.1, et ordre
    // déjà appliqué par V2 sur ce chemin).
    const startedEvent = await events.append({
      round: state.round,
      actor: 'human',
      type: 'human_handoff_started',
      target_expert_slot_id: target.expertSlot,
      session_id: sessionId,
      details: { state: state.state, control: state.control, provider: target.provider },
      timestamp: startedAt,
    });

    await seams.afterStartedJournaled?.();

    // ---- 4. Contexte de reprise, durable AVANT tout lancement. Son absence
    // prouvera qu'aucun client interactif n'a été engagé.
    //
    // Aucune transition d'état : le handoff part d'un run déjà suspendu, et
    // l'y laisse. `control` n'est jamais écrit — c'est la forme la plus forte
    // de « le handoff ne rend jamais la main à l'automatisation ».
    state = await persistNativeStateUpdate(
      paths,
      state,
      {
        activeExpertSlot: target.expertSlot,
        lastEventId: startedEvent.event_id,
        pendingOperation: {
          kind: 'handoff',
          expert_slot: target.expertSlot,
          round: state.round,
          // Champ générique du schéma 3 : l'événement qui a ouvert l'opération.
          // Pour un handoff, c'est `human_handoff_started` — exactement ce que
          // V2 y place déjà. Aucun schema 4 n'a donc été nécessaire.
          prompt_event_id: startedEvent.event_id,
          session_id: sessionId,
          return_state: state.state,
          return_control: state.control,
          started_at: startedAt,
        },
      },
      deps.now(),
    );

    await seams.afterPendingPersisted?.();

    const fail = async (error: unknown): Promise<never> => {
      const failureEvent = await events.append({
        round: state.round,
        actor: 'system',
        type: 'process_failed',
        target_expert_slot_id: target.expertSlot,
        session_id: sessionId,
        content: error instanceof Error ? error.message : String(error),
        details: { ...errorDetails(error), phase: 'handoff' },
        based_on: [startedEvent.event_id],
        timestamp: deps.now().toISOString(),
      });
      // Échec de lancement : non destructif, et déterministe. L'identifiant
      // natif est intact, le run reste dans son état suspendu sous contrôle
      // humain, et le contexte est libéré — le conserver suggérerait une
      // ambiguïté qui n'existe pas. Aucun `human_handoff_finished` n'est
      // écrit : aucune interaction n'a eu lieu.
      state = await persistNativeStateUpdate(
        paths,
        state,
        { activeExpertSlot: null, pendingOperation: null, lastEventId: failureEvent.event_id },
        deps.now(),
      );
      throw error;
    };

    // ---- 5. Attachement à la session **existante** de la cible. Jamais
    // `start()`, jamais `resume()`, et aucun prompt.
    let interactive: InteractiveResult;
    try {
      // La construction des adapters est **dans** la frontière déterministe.
      // Elle en était sortie, et c'était un défaut : un exécutable
      // introuvable, ou un snapshot runtime absent, laissait un contexte
      // engagé sans fait terminal. Après un redémarrage, le run ressemblait
      // alors à une interaction d'issue inconnue — donc un acquittement, donc
      // une barrière épistémique — alors que rien n'avait été lancé.
      //
      // Une défaillance locale d'avant le lancement ne doit jamais faire
      // croire que la session native a pu évoluer.
      const adapters = deps.createAdapters(
        manifest.workspace.cwd,
        runtimeSettingsOf(pinnedRuntime(manifest, runId)),
      );
      // Une seule tentative : aucun retry.
      interactive = await adapters[target.provider].openInteractive(sessionId);
    } catch (error) {
      return fail(error);
    }

    await seams.afterInteractiveReturned?.();

    // ---- 6. Fin de la fenêtre d'intervention. Le contexte reste **durable**.
    //
    // Un code de sortie non nul n'est pas requalifié en échec : l'adapter ne
    // distingue pas « lanceur en échec » de « client interactif terminé
    // anormalement » autrement que par une exception, et fabriquer cette
    // distinction reviendrait à inventer un fait.
    const finishedEvent = await events.append({
      round: state.round,
      actor: 'human',
      type: 'human_handoff_finished',
      target_expert_slot_id: target.expertSlot,
      session_id: sessionId,
      exit_code: interactive.exitCode,
      // Causalité explicite vers l'ouverture, jamais une proximité temporelle.
      based_on: [startedEvent.event_id],
      details: {
        started_at: interactive.startedAt,
        completed_at: interactive.completedAt,
        duration_ms: interactive.durationMs,
        signal: interactive.signal,
        cost: 'NOT CONTROLLED / NOT MEASURED',
        note:
          "Intervention native externe : CCR ne connaît pas le détail des messages échangés, " +
          "et n'en journalise aucun.",
      },
      timestamp: deps.now().toISOString(),
    });

    await seams.afterFinishedJournaled?.();

    // ---- 7. Commit local. Ni round, ni curseur, ni manifest : un handoff
    // n'est pas un tour.
    state = await persistNativeStateUpdate(
      paths,
      state,
      { activeExpertSlot: null, pendingOperation: null, lastEventId: finishedEvent.event_id },
      deps.now(),
    );

    return {
      runId,
      expertSlot: target.expertSlot,
      provider: target.provider,
      sessionId,
      startedEventId: startedEvent.event_id,
      finishedEventId: finishedEvent.event_id,
      exitCode: interactive.exitCode,
      durationMs: interactive.durationMs,
      state,
    };
  });
}
