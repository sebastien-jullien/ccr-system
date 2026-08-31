/**
 * START natif V2.1 — première exécution réelle de la chaîne
 * `ExpertSlot → ProviderBinding → NativeSession`.
 *
 * Ce que ce module change par rapport au START historique tient en une phrase :
 * l'ordre des appels vient des **slots**, jamais des fournisseurs.
 *
 * ```text
 * 1. AUTHOR       →  son binding  →  l'adapter de ce fournisseur
 * 2. CHALLENGER   →  son binding  →  l'adapter de ce fournisseur
 * ```
 *
 * `Claude puis Codex` n'est plus une convention : c'est ce que produit
 * `author = claude, challenger = codex`, et rien d'autre.
 *
 * ## Ce qui est délibérément conservé
 *
 * L'ordre de durabilité du START V2 est repris tel quel — journaliser
 * l'intention, persister `WAITING_AGENT` avec le contexte de reprise, appeler,
 * journaliser la réponse, sortir de `WAITING_AGENT`, lier la session, journaliser
 * `session_created`. Il n'a pas été « amélioré » : il est éprouvé, et le Slice
 * Recovery s'appuiera dessus.
 *
 * ## Ce qui n'existe pas ici
 *
 * Aucun transfert, aucun `rounds/`, aucun curseur avancé au-delà de sa pose
 * initiale, aucune reprise. START produit honnêtement les états persistés que
 * le Slice Recovery traitera ; il ne les traite pas lui-même.
 */

import { CcrError } from '../core/errors.ts';
import { EXPERT_SLOT_IDS } from '../core/expert.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
} from '../core/run-native.ts';
import type {
  ExpertSlots,
  NativeCodexRuntime,
  NativeProviderRuntime,
  NativeRunManifest,
  NativeRunRuntimeConfig,
  NativeRunStateDocument,
} from '../core/run-native.ts';
import type { AgentTurnResult } from '../adapters/agent-adapter.ts';
import { runNativeStartPreflight } from '../runtime/preflight-service.ts';
import type {
  NativeStartPreflightResult,
  StartPreflightWarning,
} from '../runtime/preflight-service.ts';
import type { StartPreflightSeams } from './start-application-service.ts';
import { createRunDirectory } from '../store/state-store.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import type { NativeEventStore } from '../store/native-event-store.ts';
import {
  bindNativeSession,
  buildInitialNativeState,
  persistNativeStateUpdate,
  writeNativeManifest,
  writeNativeState,
} from '../store/native-store.ts';
import type { RunPaths } from '../store/layout.ts';
import type { AgentAdapters, RunRuntimeSettings, RunServiceDeps } from './run-service.ts';
import type { InvocationDispatchRecord } from '../core/usage-governance.ts';
import { initializeInvocationLedger, openInvocationLedger } from '../store/invocation-ledger.ts';
import { appendInvocationOutcome } from '../store/invocation-outcome-store.ts';
import { nativeProcessFailedOutcome } from '../core/invocation-outcome.ts';
import type { NativeFailureDetail } from '../core/invocation-outcome.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import { assertInvocationQuotaAvailable } from './invocation-quota.ts';
import { invocationPolicyDocument } from '../core/invocation-policy.ts';
import { openInvocationPolicyStore } from '../store/invocation-policy-store.ts';
import { openUsageLedger } from '../store/usage-ledger.ts';
import { createUsageRecorder, recordTurnUsage } from './usage-governance-writer.ts';
import type { UsageGovernanceWarning } from './usage-governance-writer.ts';

// --------------------------------------------------------------------------
// Bindings
// --------------------------------------------------------------------------

export interface NativeExpertBindings {
  readonly author: ProviderKind;
  readonly challenger: ProviderKind;
}

/**
 * Défaut produit.
 *
 * Il remplit les deux bindings ; il ne les rend pas facultatifs.
 *
 * C'est une **convention de liaison par défaut**, et rien d'autre : aucun
 * fournisseur n'est intrinsèquement auteur ou contradicteur.
 * `--author-provider` et `--challenger-provider` la remplacent entièrement, y
 * compris pour affecter le même fournisseur aux deux slots.
 */
export const DEFAULT_NATIVE_BINDINGS: NativeExpertBindings = {
  author: 'claude',
  challenger: 'codex',
};

/**
 * Fournisseurs réellement employés par le run (`INV-21-13`).
 *
 * `unique(author, challenger)` — un `Set` plutôt qu'un tableau, parce que la
 * question posée est « ce fournisseur est-il employé ? », jamais « combien de
 * fois ? ».
 */
export function requiredProviders(bindings: NativeExpertBindings): ReadonlySet<ProviderKind> {
  return new Set<ProviderKind>([bindings.author, bindings.challenger]);
}

// --------------------------------------------------------------------------
// Snapshot runtime natif
// --------------------------------------------------------------------------

/**
 * Fige les faits observés par le preflight natif.
 *
 * Un fournisseur non requis n'a pas été sondé : le document le dit, et n'a
 * aucun emplacement où loger une version ou un état d'authentification. Il ne
 * peut donc rien inventer, même par distraction.
 */
export function buildNativeRuntimeConfig(
  preflight: NativeStartPreflightResult,
  capturedAt: Date,
): NativeRunRuntimeConfig {
  const claude: NativeProviderRuntime = preflight.claude.required
    ? {
        required: true,
        probe_status: 'OBSERVED',
        cli_version: preflight.claude.probe.version,
        auth_preflight: preflight.claude.probe.authStatus,
      }
    : { required: false, probe_status: 'NOT_REQUIRED' };

  const codex: NativeCodexRuntime = preflight.codex.required
    ? {
        required: true,
        probe_status: 'OBSERVED',
        cli_version: preflight.codex.probe.version,
        auth_preflight: preflight.codex.probe.authStatus,
        skip_git_repo_check: preflight.effectiveConfig.codex.skipGitRepoCheck,
        source_at_capture: preflight.effectiveConfig.codex.source,
      }
    : { required: false, probe_status: 'NOT_REQUIRED' };

  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: capturedAt.toISOString(),
    claude,
    codex,
  };
}

// --------------------------------------------------------------------------
// Contrat de la façade
// --------------------------------------------------------------------------

export interface NativeStartInput {
  readonly title: string;
  readonly cwd: string;
  /** Forme donnée par l'humain, avant canonicalisation. Diagnostic seul. */
  readonly declaredCwd?: string;
  /** Mission initiale, envoyée **indépendamment** à chacun des deux experts. */
  readonly prompt: string;
  readonly bindings?: Partial<NativeExpertBindings>;
  readonly runtimeConfig: NativeRunRuntimeConfig;
  /**
   * Politique de quota d'invocations du run (`V2.2-IMP-09`).
   *
   * **À la naissance, ou jamais.** Absent, le run n'a aucune politique — et
   * aucune surface V0.1 ne permettra de lui en attacher une plus tard : le
   * schéma ne porte ni date d'effet ni consommation de référence, si bien
   * qu'une pose tardive perdrait la vérité même que le choix per-run persistant
   * doit préserver.
   *
   * Zéro est une valeur valide : elle interdit toute invocation.
   */
  readonly maxInvocations?: number;
}

export interface NativeStartHooks {
  /** Appelé une fois le run matérialisé, avant tout fournisseur. */
  readonly onAllocated?: (runId: string) => void | Promise<void>;
  /**
   * Fabriques des journaux de gouvernance (V2.2-IMP-04).
   *
   * Injectables pour éprouver un échec de persistance sans corrompre un système
   * de fichiers. Absentes, les fabriques réelles s'appliquent.
   */
  readonly openInvocationLedger?: typeof openInvocationLedger;
  readonly openUsageLedger?: typeof openUsageLedger;
}

/**
 * Corrélation applicative facultative (V2.2-IMP-04).
 *
 * Une opération HTTP de création vaut **deux** invocations : les deux
 * enregistrements portent donc le même identifiant d'opération. En CLI, il n'y
 * en a aucun, et l'autorité du journal n'en dépend pas.
 */
export interface NativeStartCorrelation {
  readonly operationId?: string;
}

export type { UsageGovernanceWarning };

/** Position initiale d'un expert : une réponse, indépendante de l'autre. */
export interface NativeInitialPosition {
  readonly slot: ExpertSlotId;
  readonly provider: ProviderKind;
  readonly turn: AgentTurnResult;
  readonly promptEventId: string;
  readonly responseEventId: string;
}

export interface NativeStartResult {
  readonly runId: string;
  readonly manifest: NativeRunManifest;
  readonly state: NativeRunStateDocument;
  readonly positions: readonly NativeInitialPosition[];
  /** Présent lorsque l'initialisation s'est arrêtée sur un slot. */
  readonly failure?: { readonly slot: ExpertSlotId; readonly error: unknown };
  /**
   * Échecs de gouvernance, agrégés sur les deux slots.
   *
   * Ils coexistent avec `failure` sans jamais le masquer : un avertissement
   * d'usage de l'auteur et un échec du challenger décrivent deux faits
   * différents, et le second reste la cause de l'arrêt.
   */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
}

// --------------------------------------------------------------------------
// Contexte interne
// --------------------------------------------------------------------------

/**
 * Le manifest vit dans une référence partagée plutôt que directement dans le
 * contexte : le journal natif doit lire le manifest **courant** au moment où il
 * valide, alors qu'il est ouvert avant la première liaison de session.
 */
export interface ManifestRef {
  manifest: NativeRunManifest;
}

/**
 * Sérialisation durable **possédée par l'appelant**.
 *
 * `initializeNativeSlot` est partagé par `START`, qui ne détient aucun verrou de
 * run, et par la reprise d'initialisation, qui en détient déjà un. Le verrou
 * n'étant **pas réentrant** — publication par lien dur exclusif, aucun compteur
 * de récursion —, la fonction partagée ne peut pas trancher elle-même : elle
 * l'imbriquerait chez l'un des deux et échouerait en `RUN_ALREADY_LOCKED`.
 *
 * La décision appartient donc à l'appelant, seul à savoir ce qu'il détient :
 *
 * ```text
 * START     ouvre une frontière de mutation COURTE autour du corps
 * REPRISE   exécute le corps directement, sous le verrou déjà tenu
 * ```
 *
 * `initializeNativeSlot` reste **agnostique au verrou** : il n'en acquiert
 * aucun, n'en teste aucun, et ne connaît pas la différence entre ses appelants.
 */
export type NativeSerialize = <T>(command: string, body: () => Promise<T>) => Promise<T>;

export interface NativeContext {
  readonly paths: RunPaths;
  readonly events: NativeEventStore;
  readonly adapters: AgentAdapters;
  readonly now: () => Date;
  readonly manifestRef: ManifestRef;
  state: NativeRunStateDocument;
  /**
   * Sérialisation possédée par l'appelant.
   *
   * Champ **obligatoire** : un défaut implicite laisserait `START` écrire son
   * engagement hors de toute sérialisation — précisément le défaut que cette
   * capacité existe pour corriger.
   */
  readonly serialize: NativeSerialize;
  /** Gouvernance d'usage (V2.2-IMP-04). Absente, aucun journal n'est écrit. */
  readonly governance?: NativeStartGovernance;
}

/** Ce dont l'initialisation d'un slot a besoin pour être gouvernée. */
export interface NativeStartGovernance {
  readonly runId: string;
  /**
   * Ce qui a **engagé** cette tentative (V2.2-IMP-05).
   *
   * `initializeNativeSlot` est partagé par START et par la reprise
   * d'initialisation. Le déclencheur est donc reçu, jamais déduit : une nouvelle
   * tentative explicite n'est pas la poursuite de l'ancienne, et son
   * enregistrement doit le dire.
   *
   * Un seul champ, et rien d'autre : cette fonction ne devient pas un moteur
   * générique d'invocations.
   */
  readonly trigger: 'START' | 'RECOVERY_CONTINUE';
  readonly openInvocations: typeof openInvocationLedger;
  readonly openUsage: typeof openUsageLedger;
  readonly correlation: NativeStartCorrelation;
  readonly warnings: UsageGovernanceWarning[];
}

export function boundNativeSessions(
  manifest: NativeRunManifest,
  provider: ProviderKind,
): readonly string[] {
  return boundSessionsOf(manifest, provider);
}

function initialSlots(bindings: NativeExpertBindings): ExpertSlots {
  return {
    author: { provider: bindings.author, session_id: null },
    challenger: { provider: bindings.challenger, session_id: null },
  };
}

/**
 * Identités natives déjà liées, par fournisseur.
 *
 * L'unicité porte sur le couple `(provider, session_id)` : deux fournisseurs
 * différents peuvent en principe émettre la même chaîne sans que rien ne soit
 * ambigu. C'est le partage du moteur qui rend la collision possible.
 */
function boundSessionsOf(manifest: NativeRunManifest, provider: ProviderKind): readonly string[] {
  return EXPERT_SLOT_IDS.map((slot) => manifest.experts[slot])
    .filter((binding) => binding.provider === provider && binding.session_id !== null)
    .map((binding) => binding.session_id as string);
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof CcrError) return { code: error.code, ...error.details };
  return {};
}


/**
 * Un tour d'initialisation, pour un slot.
 *
 * Ordre de durabilité repris du START V2, sans réordonnancement :
 *
 * ```text
 * 1. prompt_sent                       intention journalisée
 * 2. WAITING_AGENT + pending_operation persistés AVANT tout lancement
 * 3. adapter.start(prompt)
 * 4. contrôle de collision              AVANT toute journalisation de réponse
 * 5. assistant_response                 réponse journalisée
 * 6. RUNNING, pending libéré
 * 7. manifest : session liée au slot
 * 8. session_created
 * ```
 *
 * Le contrôle de collision s'intercale en 4 et nulle part ailleurs : plus tôt,
 * la session n'existe pas ; plus tard, une réponse aurait déjà été attribuée à
 * une identité que CCR ne sait pas distinguer.
 */
/**
 * Rend un slot à son état manquant, sans qu'aucune tentative n'ait eu lieu
 * (`V2.2-IMP-04`, généralisé par `V2.2-IMP-08`).
 *
 * **Aucun événement neuf.** La classification d'initialisation ne consulte que
 * la session du manifest, le `session_created` et la réponse initiale durable :
 * libérer le contexte suffit à rendre le slot `MISSING`, donc `CLEAN_MISSING`.
 *
 * `lastEventId` n'est fourni que lorsqu'un fait de cette tentative existe déjà.
 * Un refus de politique survient **avant** le `prompt_sent` : il n'a aucun
 * événement à désigner, et n'en fabrique pas.
 */
async function releaseSlotWithoutAttempt(ctx: NativeContext, lastEventId?: string): Promise<void> {
  ctx.state = await persistNativeStateUpdate(
    ctx.paths,
    ctx.state,
    {
      state: 'FAILED_INITIALIZATION',
      control: 'HUMAN',
      activeExpertSlot: null,
      pendingOperation: null,
      ...(lastEventId === undefined ? {} : { lastEventId }),
    },
    ctx.now(),
  );
}

export async function initializeNativeSlot(
  ctx: NativeContext,
  slot: ExpertSlotId,
  prompt: string,
): Promise<NativeInitialPosition> {
  const binding = ctx.manifestRef.manifest.experts[slot];
  const adapter = ctx.adapters[binding.provider];

  // ---- Politique de quota (V2.2-IMP-08).
  //
  // Juste-à-temps, pour **ce** slot : le compte est relu du journal réel, si
  // bien qu'une tentative précédente réussie a déjà consommé son unité. Rien
  // n'est réservé d'avance, et un refus survient avant le moindre fait durable
  // — pas de prompt, pas de contexte de reprise, aucun agent.
  try {
    await assertInvocationQuotaAvailable(ctx.paths, ctx.manifestRef.manifest.run_id);
  } catch (refusal) {
    // Le slot reste manquant, et le run redevient honnêtement récupérable.
    // Aucun `process_failed` : la décision est celle de CCR, pas une panne de
    // l'expert.
    await releaseSlotWithoutAttempt(ctx);
    throw refusal;
  }

  /**
   * Fermeture d'une tentative dont CCR sait qu'aucun fournisseur n'a été appelé
   * (`V2.2-IMP-04`).
   *
   * `process_failed` serait un mensonge : il porte le slot visé, et
   * attribuerait à l'expert une panne de stockage de CCR.
   *
   * Exécutée **sous la même sérialisation** que les faits qu'elle referme : la
   * sortir du verrou rouvrirait la fenêtre que celui-ci existe pour fermer.
   */
  const abortBeforeProvider = async (cause: unknown, lastEventId: string): Promise<never> => {
    let cleanup: Record<string, unknown> | undefined;
    try {
      await releaseSlotWithoutAttempt(ctx, lastEventId);
    } catch (cleanupError) {
      cleanup = errorDetails(cleanupError);
    }
    throw new CcrError(
      'INVOCATION_LEDGER_WRITE_FAILED',
      `Le journal d'invocations du run ${ctx.manifestRef.manifest.run_id} n'a pas pu être écrit. ` +
        `Aucun agent n'a été sollicité pour « ${slot} ».`,
      {
        details: {
          runId: ctx.manifestRef.manifest.run_id,
          expert_slot: slot,
          ...errorDetails(cause),
          ...(cleanup === undefined ? {} : { cleanup_error: cleanup }),
        },
        cause,
      },
    );
  };

  // ---- Mutation courte AVANT fournisseur.
  //
  // Intention, contexte de reprise et engagement durable forment **une seule**
  // mutation sérialisée. Auparavant, ces trois écritures traversaient une
  // fenêtre non sérialisée : deux handles de ledger ouverts concurremment
  // dérivent la même séquence à l'ouverture, l'incrémentent localement sans
  // relire le disque, et allouent alors le même `invocation_id`. Le doublon
  // n'était détecté qu'à la relecture suivante, qui déclarait le journal
  // entier invalide.
  //
  // La garantie d'unicité vient de la sérialisation de l'opération, jamais de
  // la variable de séquence locale du handle ni du format du journal.
  //
  // L'appel fournisseur reste **hors** de cette section : le verrou ne couvre
  // pas une latence de fournisseur.
  const { promptEvent, dispatch } = await ctx.serialize('native-start-dispatch', async () => {
    const promptEventInner = await ctx.events.append({
      round: ctx.state.round,
      actor: 'human',
      type: 'prompt_sent',
      target_expert_slot_id: slot,
      content: prompt,
      timestamp: ctx.now().toISOString(),
    });

    ctx.state = await persistNativeStateUpdate(
      ctx.paths,
      ctx.state,
      {
        state: 'WAITING_AGENT',
        activeExpertSlot: slot,
        lastEventId: promptEventInner.event_id,
        pendingOperation: {
          kind: 'initialization',
          expert_slot: slot,
          round: ctx.state.round,
          prompt_event_id: promptEventInner.event_id,
          session_id: null,
          return_state: 'FAILED_INITIALIZATION',
          return_control: 'AUTOMATION',
          started_at: ctx.now().toISOString(),
        },
      },
      ctx.now(),
    );

    // ---- Frontière autoritaire (V2.2-IMP-04).
    //
    // `session_id` est **absent** : c'est `adapter.start` qui crée la session,
    // et retarder l'engagement pour l'attendre reviendrait à écrire le fait
    // après l'appel qu'il est censé précéder. Ni `round` ni `source_event_id`
    // non plus : une position initiale n'est pas un transfert.
    const governanceInner = ctx.governance;
    let dispatchInner: InvocationDispatchRecord | undefined;
    if (governanceInner !== undefined) {
      try {
        const invocations = await governanceInner.openInvocations(ctx.paths, governanceInner.runId);
        dispatchInner = await invocations.append(
          {
            identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: slot, provider: binding.provider },
            trigger_kind: governanceInner.trigger,
            prompt_event_id: promptEventInner.event_id,
            ...(governanceInner.correlation.operationId === undefined
              ? {}
              : { operation_id: governanceInner.correlation.operationId }),
          },
          ctx.now(),
        );
      } catch (error) {
        return abortBeforeProvider(error, promptEventInner.event_id);
      }
    }

    return { promptEvent: promptEventInner, dispatch: dispatchInner };
  });

  /**
   * Ferme une tentative après un échec déterministe **postérieur** à
   * l'engagement.
   *
   * Trois faits durables, dans une seule mutation sérialisée : l'événement
   * `process_failed`, la libération du contexte, et l'issue négative
   * d'invocation. L'ordre n'est pas indifférent — l'issue est commitée
   * **avant** que l'erreur ne soit relancée vers la surface produit, ce qu'exige
   * le contrat de durabilité.
   *
   * Si le commit de l'issue échoue, c'est la défaillance de persistance qui
   * remonte, et non l'erreur d'origine : rendre celle-ci laisserait croire que
   * la garantie a tenu.
   *
   * `detail` n'est fourni que par le site qui **construit** le fait natif :
   * CCR en connaît alors la structure parce qu'il l'a écrite. Une erreur venue
   * de l'adaptateur n'en reçoit aucun — son sac de diagnostic est propre au
   * fournisseur, et reste dans `process_failed.details`.
   */
  const fail = async (error: unknown, detail?: NativeFailureDetail): Promise<never> => {
    await ctx.serialize('native-start-failure', async () => {
      const failureEvent = await ctx.events.append({
        round: ctx.state.round,
        actor: 'system',
        type: 'process_failed',
        target_expert_slot_id: slot,
        content: error instanceof Error ? error.message : String(error),
        details: errorDetails(error),
        based_on: [promptEvent.event_id],
        timestamp: ctx.now().toISOString(),
      });
      ctx.state = await persistNativeStateUpdate(
        ctx.paths,
        ctx.state,
        {
          state: 'FAILED_INITIALIZATION',
          activeExpertSlot: null,
          lastEventId: failureEvent.event_id,
          control: 'HUMAN',
          pendingOperation: null,
        },
        ctx.now(),
      );

      // Sans engagement, il n'y a aucune invocation à laquelle rattacher une
      // issue : le fait n'existe pas, et rien n'est inventé pour le combler.
      if (dispatch !== undefined) {
        await appendInvocationOutcome(
          ctx.paths,
          dispatch.invocation_id,
          nativeProcessFailedOutcome(error, detail),
          ctx.now().toISOString(),
        );
      }
    });
    throw error;
  };

  let turn: AgentTurnResult;
  try {
    // Aucun retry : une seule tentative, et son issue est un fait.
    turn = await adapter.start(prompt);
  } catch (error) {
    return fail(error);
  }

  if (boundSessionsOf(ctx.manifestRef.manifest, binding.provider).includes(turn.sessionId)) {
    return fail(
      new CcrError(
        'SESSION_ID_COLLISION',
        `Le slot « ${slot} » a reçu la session « ${turn.sessionId} », déjà liée à l'autre expert ` +
          `sur le fournisseur « ${binding.provider} ». CCR ne peut pas savoir laquelle des deux ` +
          "conversations vient d'être ouverte : la session n'est attribuée à personne.",
        { details: { slot, provider: binding.provider, session_id: turn.sessionId } },
      ),
      // Le fait durable conserve ce que l'événement natif porte déjà : quel
      // slot, quel moteur, et **quelle** session est en cause. Réduire cette
      // collision à son seul code perdrait l'identité du conflit.
      {
        code: 'SESSION_ID_COLLISION',
        expert_slot: slot,
        provider: binding.provider,
        session_id: turn.sessionId,
      },
    );
  }

  const responseEvent = await ctx.events.append({
    round: ctx.state.round,
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: slot,
    session_id: turn.sessionId,
    content: turn.content,
    exit_code: turn.exitCode,
    based_on: [promptEvent.event_id],
    timestamp: ctx.now().toISOString(),
  });

  ctx.state = await persistNativeStateUpdate(
    ctx.paths,
    ctx.state,
    {
      state: 'RUNNING',
      activeExpertSlot: null,
      lastEventId: responseEvent.event_id,
      pendingOperation: null,
    },
    ctx.now(),
  );

  ctx.manifestRef.manifest = await bindNativeSession(ctx.paths, ctx.manifestRef.manifest, slot, turn.sessionId);

  const sessionEvent = await ctx.events.append({
    round: ctx.state.round,
    actor: 'system',
    type: 'session_created',
    expert_slot_id: slot,
    session_id: turn.sessionId,
    timestamp: ctx.now().toISOString(),
  });
  ctx.state = await persistNativeStateUpdate(
    ctx.paths,
    ctx.state,
    { lastEventId: sessionEvent.event_id },
    ctx.now(),
  );

  // ---- Gouvernance d'usage, APRÈS acquisition **complète** du slot.
  //
  // Plus strict que STEP et SEND, et délibérément : entre la réponse et
  // `session_created` se trouve la liaison de la session au manifest, l'écriture
  // la plus critique du chemin. Rien d'accessoire ne s'intercale devant elle.
  const usageGovernance = ctx.governance;
  if (usageGovernance !== undefined && dispatch !== undefined) {
    const recorder = createUsageRecorder(
      await usageGovernance.openUsage(ctx.paths, usageGovernance.runId),
      dispatch.invocation_id,
      ctx.now,
    );
    await recordTurnUsage(recorder, turn);
    usageGovernance.warnings.push(...recorder.warnings);
  }

  return {
    slot,
    provider: binding.provider,
    turn,
    promptEventId: promptEvent.event_id,
    responseEventId: responseEvent.event_id,
  };
}

// --------------------------------------------------------------------------
// Façade
// --------------------------------------------------------------------------

/**
 * Crée un run natif V2.1 et initialise ses deux experts.
 *
 * Exige un snapshot runtime : la voie basse ne permet pas de créer un run natif
 * non pinné, exactement comme `startRun` côté historique.
 */
export async function startNativeRun(
  deps: RunServiceDeps,
  input: NativeStartInput,
  hooks: NativeStartHooks = {},
  correlation: NativeStartCorrelation = {},
): Promise<NativeStartResult> {
  const warnings: UsageGovernanceWarning[] = [];
  const bindings: NativeExpertBindings = { ...DEFAULT_NATIVE_BINDINGS, ...input.bindings };

  // Validée AVANT l'allocation : une limite mal formée ne doit pas laisser
  // derrière elle un répertoire de run que personne n'a demandé.
  if (input.maxInvocations !== undefined) invocationPolicyDocument(input.maxInvocations);

  const paths = await createRunDirectory(deps.runsDir, deps.now());

  const manifest: NativeRunManifest = {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: paths.runId,
    title: input.title,
    created_at: deps.now().toISOString(),
    workspace: {
      cwd: input.cwd,
      ...(input.declaredCwd === undefined || input.declaredCwd === input.cwd
        ? {}
        : { declared_cwd: input.declaredCwd }),
    },
    experts: initialSlots(bindings),
    runtime_config: input.runtimeConfig,
  };

  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, buildInitialNativeState(paths.runId, 'READY', deps.now()));

  // ---- Activation de l'autorité d'invocations (V2.2-IMP-09R).
  //
  // Un journal **vide**, écrit ici et pas plus tard. C'est ce qui distingue,
  // pour toujours, un run neuf sans engagement d'un run antérieur dont
  // l'histoire n'est pas démontrable : le premier porte la marque, le second
  // non. Elle précède `createAdapters`, donc aussi le seul échec déterministe
  // capable de laisser un run matérialisé sans la moindre tentative.
  await initializeInvocationLedger(paths);

  // La politique la suit immédiatement, avant tout ce qui peut échouer
  // au-dehors : ce qui gouverne le run est ainsi entièrement établi pendant
  // qu'aucun fournisseur n'est joignable. Elle reste durable bien avant le
  // premier contrôle de quota, exigence d'IMP-09 inchangée.
  if (input.maxInvocations !== undefined) {
    await openInvocationPolicyStore(paths).create(input.maxInvocations);
  }

  const manifestRef: ManifestRef = { manifest };
  const ctx: NativeContext = {
    paths,
    // Le journal valide contre le manifest **courant**, qui change à chaque
    // session liée. La référence est déclarée avant le contexte : la résoudre
    // depuis `ctx` la lirait pendant sa propre construction.
    events: await openNativeEventStore(paths, () => manifestRef.manifest),
    adapters: deps.createAdapters(input.cwd, runtimeSettingsOf(input.runtimeConfig)),
    now: () => deps.now(),
    manifestRef,
    state: buildInitialNativeState(paths.runId, 'READY', deps.now()),
    // ---- Propriété de sérialisation — `START`.
    //
    // `startNativeRun` ne détient aucun verrou de run : `createRunDirectory`
    // n'assure l'exclusivité que du **nom**, et le run est adressable dès
    // l'écriture du manifest, donc bien avant la fin de l'initialisation.
    // C'est donc ici, et nulle part ailleurs, que la frontière de mutation
    // courte s'ouvre — autour du corps que le primitif partagé lui remet.
    serialize: <T>(command: string, body: () => Promise<T>): Promise<T> =>
      withNativeMutation({ runsDir: deps.runsDir, runId: paths.runId, command }, body),
    // Le run possède déjà son identité canonique : répertoire, manifest et
    // état sont écrits. Aucun journal de gouvernance n'existe avant ce point.
    governance: {
      runId: paths.runId,
      trigger: 'START',
      openInvocations: hooks.openInvocationLedger ?? openInvocationLedger,
      openUsage: hooks.openUsageLedger ?? openUsageLedger,
      correlation,
      warnings,
    },
  };

  const created = await ctx.events.append({
    round: 0,
    actor: 'system',
    type: 'run_created',
    content: input.title,
    details: { workspace_cwd: input.cwd },
    timestamp: deps.now().toISOString(),
  });
  ctx.state = await persistNativeStateUpdate(
    paths,
    ctx.state,
    { state: 'RUNNING', lastEventId: created.event_id },
    deps.now(),
  );

  // Dernier instant sans fournisseur : le run est entièrement matérialisé.
  await hooks.onAllocated?.(paths.runId);

  const positions: NativeInitialPosition[] = [];

  // L'ordre vient des slots. AUTHOR d'abord, quel que soit son moteur.
  for (const slot of EXPERT_SLOT_IDS) {
    try {
      // Chaque expert reçoit la **même mission**, sans jamais voir la réponse de
      // l'autre : ce sont deux positions initiales indépendantes, pas un
      // transfert.
      positions.push(await initializeNativeSlot(ctx, slot, input.prompt));
    } catch (error) {
      return {
        runId: paths.runId,
        manifest: ctx.manifestRef.manifest,
        state: ctx.state,
        positions,
        failure: { slot, error },
        // Un avertissement d'usage de l'auteur survit à l'échec du challenger :
        // ce sont deux faits distincts, et le second reste la cause de l'arrêt.
        usageGovernanceWarnings: warnings,
      };
    }
  }

  // Le curseur n'est posé qu'ici : deux sessions, deux positions initiales.
  ctx.state = await persistNativeStateUpdate(
    paths,
    ctx.state,
    { state: 'READY', nextStepSourceSlot: 'author' },
    deps.now(),
  );

  return {
    runId: paths.runId,
    manifest: ctx.manifestRef.manifest,
    state: ctx.state,
    positions,
    usageGovernanceWarnings: warnings,
  };
}

export function runtimeSettingsOf(runtimeConfig: NativeRunRuntimeConfig): RunRuntimeSettings {
  return {
    codexSkipGitRepoCheck: runtimeConfig.codex.required ? runtimeConfig.codex.skip_git_repo_check : false,
  };
}

export interface NativeStartApplicationDeps {
  createRunServiceDeps(runtime: RunRuntimeSettings): RunServiceDeps;
  readonly preflight?: StartPreflightSeams;
  readonly onPreflight?: (result: NativeStartPreflightResult) => void | Promise<void>;
  readonly onRunAllocated?: NativeStartHooks['onAllocated'];
  readonly now?: () => Date;
  /** Fabriques de gouvernance, transmises telles quelles (V2.2-IMP-04). */
  readonly governanceSeams?: Pick<NativeStartHooks, 'openInvocationLedger' | 'openUsageLedger'>;
}

export interface NativeStartApplicationInput {
  readonly title: string;
  readonly cwd: string;
  readonly declaredCwd?: string;
  readonly prompt: string;
  readonly bindings?: Partial<NativeExpertBindings>;
  /** Politique de quota, posée à la naissance du run (`V2.2-IMP-09`). */
  readonly maxInvocations?: number;
}

export interface NativeStartApplicationResult extends NativeStartResult {
  readonly warnings: readonly StartPreflightWarning[];
  readonly runtimeConfig: NativeRunRuntimeConfig;
  readonly requiredProviders: readonly ProviderKind[];
}

/**
 * Voie applicative complète : preflight borné, snapshot, allocation, sessions.
 *
 * La frontière V1.1/V2 est conservée à l'identique : tout ce qui est
 * connaissable avant l'engagement l'est **avant** l'allocation. Un blocage de
 * preflight ne laisse aucun run derrière lui — pas de `run_id`, pas de
 * répertoire, pas d'événement, pas un appel d'adapter.
 */
export async function startNativeRunWithPreflight(
  deps: NativeStartApplicationDeps,
  input: NativeStartApplicationInput,
  correlation: NativeStartCorrelation = {},
): Promise<NativeStartApplicationResult> {
  const now = deps.now ?? ((): Date => new Date());
  const bindings: NativeExpertBindings = { ...DEFAULT_NATIVE_BINDINGS, ...input.bindings };
  const required = requiredProviders(bindings);

  // La facade native de 1C n'expose aucune capacite d'interaction : ni CLI, ni
  // HTTP, ni cockpit ne la branche encore. Elle declare donc un terminal absent,
  // ce qui rend toute remediation interactive structurellement impossible plutot
  // que dependante du terminal du processus appelant. Claude non authentifie
  // produit `AUTH_REQUIRED` avant allocation, conformement a la politique V1.1
  // non interactive.
  const preflight = await runNativeStartPreflight(required, {
    ...deps.preflight,
    tty: { stdin: false, stdout: false },
  });
  const runtimeConfig = buildNativeRuntimeConfig(preflight, now());
  await deps.onPreflight?.(preflight);

  const runServiceDeps = deps.createRunServiceDeps(runtimeSettingsOf(runtimeConfig));

  const result = await startNativeRun(
    runServiceDeps,
    {
      title: input.title,
      cwd: input.cwd,
      prompt: input.prompt,
      bindings,
      runtimeConfig,
      ...(input.maxInvocations === undefined ? {} : { maxInvocations: input.maxInvocations }),
    },
    {
      ...(deps.onRunAllocated === undefined ? {} : { onAllocated: deps.onRunAllocated }),
      ...(deps.governanceSeams ?? {}),
    },
    correlation,
  );

  return { ...result, warnings: preflight.warnings, runtimeConfig, requiredProviders: [...required] };
}
