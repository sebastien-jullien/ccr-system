/**
 * Services CCR (spécification V0.2, §48).
 *
 * Les opérations fondamentales existent comme fonctions réutilisables. La CLI
 * n'est qu'un adaptateur utilisateur : elle n'écrit jamais elle-même le
 * manifest, l'état ou le journal, et ne connaît aucun format de sortie d'agent.
 *
 * Invariant central de reprise (§32, verrouillé par le lot V1.5) :
 *
 *   l'état `WAITING_AGENT` est **persisté avant** l'appel agent, et n'est
 *   quitté qu'**après** journalisation complète de la réponse.
 *
 * Si CCR meurt entre les deux, le rechargement détecte une ambiguïté réelle et
 * impose `RECOVERY_REQUIRED` — jamais un retour silencieux en `RUNNING`.
 */

import { CcrError, isCcrError } from '../core/errors.ts';
import { MANIFEST_SCHEMA_VERSION, ROUND_SCHEMA_VERSION } from '../core/run.ts';
import type {
  AgentKind,
  RunRuntimeConfig,
  AgentRole,
  CcrDecision,
  CcrEvent,
  EventActor,
  EventType,
  PendingOperation,
  PendingOperationKind,
  RunManifest,
  RunStateDocument,
} from '../core/run.ts';
import type { ControlOwner, RunState } from '../core/state.ts';
import { stateAfterTurnFrom } from '../core/state.ts';
// Préconditions métier : source unique, partagée avec la dérivation des
// capabilities (V2-IMP-30). Aucune règle n'est réécrite ici.
import {
  decideGuard,
  handoffGuard,
  pauseGuard,
  resumeGuard,
  sendGuard,
  stepGuard,
  stopGuard,
} from '../core/run-guards.ts';
import type { RunGuardFacts } from '../core/run-guards.ts';
import {
  assessLiveness,
  clearStaleLock,
  readRunLock,
  withRunLock,
} from '../lock/run-lock.ts';
import type { LockLiveness, RunLockHooks, RunLockInfo } from '../lock/run-lock.ts';
import type { HostOperationRegistry } from '../lock/host-operation-registry.ts';
import type { AgentAdapter, AgentTurnResult } from '../adapters/agent-adapter.ts';
import { createUsageRecorder, recordTurnUsage } from './usage-governance-writer.ts';
import type { UsageGovernanceWarning } from './usage-governance-writer.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { assertInvocationQuotaAvailable } from './invocation-quota.ts';
import { readInvocationQuotaView } from './invocation-quota-read.ts';
import { readUsageReadModel } from './usage-read-model.ts';
import { readCostEstimateReadModel } from './cost-estimate-read-model.ts';
import type { InvocationQuotaView } from './invocation-quota-read.ts';
import type { UsageReadModel } from './usage-read-model.ts';
import type { CostEstimateReadModel } from './cost-estimate-read-model.ts';
import { openUsageLedger } from '../store/usage-ledger.ts';
import { listRunIds } from '../store/layout.ts';
import type { RunPaths } from '../store/layout.ts';
import { openEventStore } from '../store/event-store.ts';
import type { EventStore } from '../store/event-store.ts';
import { openDecisionStore } from '../store/decision-store.ts';
import {
  assertRecoveryResolved,
  buildInitialState,
  buildRecoveryUpdate,
  createRunDirectory,
  loadRun,
  persistStateUpdate,
  readManifest,
  readState,
  setAgentSessionId,
  writeManifest,
  writeState,
} from '../store/state-store.ts';
import { runPaths } from '../store/layout.ts';
import { writeRoundMetadata, writeRoundTurnArtifacts } from '../store/round-store.ts';
import {
  DEFAULT_MAX_TRANSFER_BYTES,
  counterpartOf,
  findTransferSource,
  planStepTransfer,
} from './transfer.ts';
import type { TransferSource } from './transfer.ts';
// Point d'import historique conservé : `findTransferSource` reste accessible
// depuis le service, tout en vivant désormais avec l'enveloppe de transfert
// qu'elle sert (V2-IMP-30).
export { findTransferSource } from './transfer.ts';
export type { TransferSource } from './transfer.ts';

export interface AgentAdapters {
  readonly claude: AgentAdapter;
  readonly codex: AgentAdapter;
}

/**
 * Configuration d'exécution d'un run, lue depuis son snapshot (V1.1, §14.1).
 *
 * Transmise explicitement jusqu'à la fabrique d'adapters : la configuration ne
 * voyage jamais par une mutation de `process.env`, qui rendrait le
 * comportement du run dépendant du processus courant — exactement ce que le
 * snapshot a pour objet d'empêcher.
 *
 * Absente, la fabrique applique sa résolution héritée (run V1 non pinné).
 */
export interface RunRuntimeSettings {
  readonly codexSkipGitRepoCheck: boolean;
}

/** Dérive les réglages exécutables d'un manifest chargé **sous le run lock**. */
export function runtimeSettingsOf(manifest: RunManifest): RunRuntimeSettings | undefined {
  const snapshot = manifest.runtime_config;
  return snapshot === undefined
    ? undefined
    : { codexSkipGitRepoCheck: snapshot.codex.skip_git_repo_check };
}

export interface RunServiceDeps {
  readonly runsDir: string;
  /**
   * Fabrique les deux adapters pour un répertoire de travail donné.
   *
   * `runtime` provient du snapshot du run et fait autorité lorsqu'il est
   * présent. Il est toujours dérivé d'un manifest lu sous le run lock.
   */
  createAdapters(cwd: string, runtime?: RunRuntimeSettings): AgentAdapters;
  now(): Date;
  /** Garde-fou de transfert automatique en octets UTF-8 (§27). */
  readonly maxTransferBytes?: number;
  /**
   * Registre d'opérations d'un hôte long-lived (V2-IMP-31).
   *
   * **Facultatif.** Absent — cas de la CLI, un processus par commande — rien ne
   * change : ni syntaxe, ni sortie, ni code de sortie. Présent, chaque
   * acquisition de verrou est associée à l'opération qui l'a obtenue, ce qui
   * permet à un lecteur de distinguer un verrou vivant de ce processus d'un
   * verrou orphelin portant le même PID.
   */
  readonly hostRegistry?: HostOperationRegistry;
}

const AGENTS: readonly AgentKind[] = ['claude', 'codex'];

/**
 * Observateurs de verrou associant l'opération au `lock_id` réellement obtenu.
 *
 * L'entrée est créée **avant** l'acquisition et n'est liée qu'**après** : une
 * opération sans verrou ne prouve donc jamais rien, et un verrou ancien ne peut
 * pas être revendiqué par une opération nouvelle.
 */
export function hostLockHooks(
  deps: RunServiceDeps,
  runId: string,
  action: string,
): RunLockHooks | undefined {
  const registry = deps.hostRegistry;
  if (registry === undefined) return undefined;
  const hostOperationId = registry.begin(runId, action);
  return {
    // Association AVANT publication : c'est ce qui ferme la fenêtre de faux
    // orphelin (V2-IMP-31). Lier après coup laisserait un verrou observable
    // sans correspondance pendant quelques millisecondes.
    onIdentityPrepared: (info) => registry.bindLock(hostOperationId, info.lock_id),
    onAcquireFailed: () => registry.end(hostOperationId),
    onReleased: () => registry.end(hostOperationId),
  };
}

/** Faits de garde d'un run chargé, tels que les prédicats partagés les attendent. */
function guardFactsOf(loaded: { state: RunStateDocument; requiresRecovery: boolean }): RunGuardFacts {
  return {
    state: loaded.state.state,
    control: loaded.state.control,
    requiresRecovery: loaded.requiresRecovery,
  };
}

/**
 * Classement d'un échec de tour (amendement A-6).
 *
 * `FAILED` est réservé aux invariants brisés. Tout incident opérationnel —
 * timeout, code de sortie non nul, authentification indisponible, sortie
 * inexploitable — laisse le run reprenable en `PAUSED`.
 */
export function operationalFailureState(error: unknown): RunState {
  // Une session native ayant répondu sous un autre identifiant brise
  // l'invariant fondamental du run : poursuivre écrirait dans une
  // conversation qui n'est pas la sienne.
  return isCcrError(error) && error.code === 'AGENT_SESSION_MISMATCH' ? 'FAILED' : 'PAUSED';
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (isCcrError(error)) return { code: error.code, ...error.details };
  return { code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) };
}

// --------------------------------------------------------------------------
// Contexte mutable d'une opération
// --------------------------------------------------------------------------

interface OperationContext {
  readonly paths: RunPaths;
  readonly events: EventStore;
  readonly deps: RunServiceDeps;
  manifest: RunManifest;
  state: RunStateDocument;
}

/**
 * Coutures de gouvernance, réservées aux tests (`V2.2-IMP-06`).
 *
 * Éprouver une panne de journal sans corrompre un système de fichiers. Aucun
 * appelant de production n'en fournit.
 */
export interface LegacyGovernanceSeams {
  readonly openInvocationLedger?: typeof openInvocationLedger;
  readonly openUsageLedger?: typeof openUsageLedger;
}

/**
 * Contexte de gouvernance d'usage d'une opération legacy (`V2.2-IMP-06`).
 *
 * `operation_id` appartient à la couche qui a reçu la requête HTTP ; il voyage
 * explicitement jusqu'ici et n'est **jamais** requis — une opération lancée
 * depuis la CLI n'en a pas, et son autorité n'en dépend pas.
 */
export interface LegacyGovernanceContext {
  readonly operationId?: string;
  readonly seams?: LegacyGovernanceSeams;
}

/**
 * Ce que l'appelant **prouve** au moment de s'engager (`V2.2-IMP-06`).
 *
 * Le déclencheur est reçu, jamais déduit : `operationKind` vaut
 * `initialization` aussi bien pour la création d'un run que pour une reprise,
 * et confondre les deux nommerait mal l'engagement.
 *
 * Facultatif au niveau de `dispatchTurn` : le helper historique de création,
 * qu'aucune surface de production n'atteint plus, traverse ce goulot sans être
 * gouverné — la couverture V2.2 porte sur les surfaces exécutables.
 */
export interface LegacyDispatchGovernance extends LegacyGovernanceContext {
  readonly trigger: 'STEP' | 'SEND' | 'RECOVERY_CONTINUE';
  /** Round réellement corrélé à ce tour. Absent pour une reprise d'initialisation. */
  readonly round?: number;
  /** Événement source d'un passage de témoin. Absent ailleurs. */
  readonly sourceEventId?: string;
}

export interface DispatchOptions {
  readonly agent: AgentKind;
  readonly adapter: AgentAdapter;
  readonly prompt: string;
  /** `null` pour créer la session, sinon reprise explicite de cet identifiant. */
  readonly sessionId: string | null;
  readonly promptActor: EventActor;
  readonly promptEventType: Extract<EventType, 'prompt_sent' | 'human_message'>;
  /** Provenance : événements dont ce prompt dérive. */
  readonly basedOn?: readonly string[];
  /** État atteint après journalisation complète de la réponse. */
  readonly successState: RunState;
  /** État atteint en cas d'échec opérationnel (défaut : voir A-6). */
  readonly failureState?: RunState;
  /** Nature de l'opération, persistée pour la reprise (A-9). */
  readonly operationKind: PendingOperationKind;
  /** Événement source d'un passage de témoin, le cas échéant. */
  readonly sourceEventId?: string;
  /**
   * État de repos à restaurer si la reprise finalise l'opération après un
   * crash. Distinct de `successState`, qui peut être un état intermédiaire.
   */
  readonly recoveryReturnState: RunState;
  readonly recoveryReturnControl: ControlOwner;
  /** Gouvernance d'usage. Absente, ce tour n'engage et n'observe rien. */
  readonly governance?: LegacyDispatchGovernance;
}

/**
 * Résultat d'un tour, accompagné de la provenance exacte des événements
 * réellement écrits.
 *
 * Les identifiants sont retournés plutôt que reconstitués par l'appelant :
 * toute projection dérivée doit pointer vers l'événement effectif, jamais vers
 * un événement voisin.
 */
export interface DispatchOutcome {
  readonly turn: AgentTurnResult;
  /** Événement portant le prompt réellement envoyé (`prompt_sent`/`human_message`). */
  readonly promptEventId: string;
  /** Événement portant la réponse de l'agent (`assistant_response`). */
  readonly responseEventId: string;
  /**
   * Observations d'usage qui n'ont pas pu être écrites (`V2.2-IMP-06`).
   *
   * Diagnostic, jamais un événement métier : une réponse de modèle appartient
   * à la controverse et ne dépend pas d'un journal accessoire.
   */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
}

/**
 * Émet un tour agent en respectant l'invariant `WAITING_AGENT`.
 *
 * Ordre strict :
 *   1. journalisation de l'intention ;
 *   2. persistance de `WAITING_AGENT` ;
 *   3. appel de la CLI ;
 *   4. journalisation de la réponse ;
 *   5. sortie de `WAITING_AGENT`.
 */
async function dispatchTurn(ctx: OperationContext, options: DispatchOptions): Promise<DispatchOutcome> {
  const { deps } = ctx;

  const promptEvent = await ctx.events.append({
    round: ctx.state.round,
    actor: options.promptActor,
    type: options.promptEventType,
    target: options.agent,
    session_id: options.sessionId,
    content: options.prompt,
    ...(options.basedOn === undefined ? {} : { based_on: options.basedOn }),
    timestamp: deps.now().toISOString(),
  });

  /**
   * Engagement durable de CCR à tenter une production de modèle
   * (`V2.2-IMP-06`).
   *
   * Placé **après** le prompt métier durable et **avant** `WAITING_AGENT` —
   * l'inverse du natif, et pour une raison propre à ce moteur : le legacy n'a
   * aucun événement d'abandon pré-fournisseur. S'engager après `WAITING_AGENT`
   * ferait dire au disque « un tour a peut-être eu lieu » alors que CCR sait
   * que l'adapter n'a pas été atteint. En s'engageant avant, un échec de
   * journal laisse un état qui n'a jamais menti : le round reste ouvert sans
   * tour attribué, la source reste réutilisable, le slot reste manquant.
   *
   * Le journal est ouvert et écrit **sous le verrou de run** déjà détenu par
   * l'appelant : c'est lui qui sérialise l'allocation de `invocation_id`.
   */
  const governance = options.governance;
  let invocationId: string | undefined;
  if (governance !== undefined) {
    try {
      const invocations = await (governance.seams?.openInvocationLedger ?? openInvocationLedger)(
        ctx.paths,
        ctx.state.run_id,
      );
      const dispatch = await invocations.append(
        {
          identity: {
            generation: 'LEGACY_V2_EXECUTION',
            agent_kind: options.agent,
            // Ce moteur ne connaît pas l'aliasing : l'identité métier et le
            // moteur joint coïncident. Les deux concepts restent distincts.
            provider: options.agent,
          },
          trigger_kind: governance.trigger,
          prompt_event_id: promptEvent.event_id,
          ...(options.sessionId === null ? {} : { session_id: options.sessionId }),
          ...(governance.round === undefined ? {} : { round: governance.round }),
          ...(governance.sourceEventId === undefined
            ? {}
            : { source_event_id: governance.sourceEventId }),
          ...(governance.operationId === undefined ? {} : { operation_id: governance.operationId }),
        },
        deps.now(),
      );
      invocationId = dispatch.invocation_id;
    } catch (cause) {
      // Panne de CCR, jamais panne d'expert : aucun `process_failed`, aucun
      // contexte d'opération persisté, aucun agent sollicité.
      throw new CcrError(
        'INVOCATION_LEDGER_WRITE_FAILED',
        `Le journal d'invocations du run ${ctx.state.run_id} n'a pas pu être écrit. ` +
          "Aucun agent n'a été sollicité.",
        {
          details: {
            runId: ctx.state.run_id,
            trigger_kind: governance.trigger,
            agent: options.agent,
            ...errorDetails(cause),
          },
          cause,
        },
      );
    }
  }

  // Contexte de reprise persisté AVANT tout lancement de processus (A-9).
  const pending: PendingOperation = {
    kind: options.operationKind,
    agent: options.agent,
    round: ctx.state.round,
    prompt_event_id: promptEvent.event_id,
    source_event_id: options.sourceEventId ?? null,
    session_id: options.sessionId,
    return_state: options.recoveryReturnState,
    return_control: options.recoveryReturnControl,
    started_at: deps.now().toISOString(),
  };

  ctx.state = await persistStateUpdate(
    ctx.paths,
    ctx.state,
    {
      state: 'WAITING_AGENT',
      activeAgent: options.agent,
      lastEventId: promptEvent.event_id,
      pendingOperation: pending,
    },
    deps.now(),
  );

  let result: AgentTurnResult;
  try {
    result =
      options.sessionId === null
        ? await options.adapter.start(options.prompt)
        : await options.adapter.resume(options.sessionId, options.prompt);
  } catch (error) {
    const failureEvent = await ctx.events.append({
      round: ctx.state.round,
      actor: 'system',
      type: 'process_failed',
      target: options.agent,
      session_id: options.sessionId,
      content: error instanceof Error ? error.message : String(error),
      details: errorDetails(error),
      based_on: [promptEvent.event_id],
      timestamp: deps.now().toISOString(),
    });

    const nextState = options.failureState ?? operationalFailureState(error);
    ctx.state = await persistStateUpdate(
      ctx.paths,
      ctx.state,
      {
        state: nextState,
        activeAgent: null,
        lastEventId: failureEvent.event_id,
        control: 'HUMAN',
        pendingOperation: null,
      },
      deps.now(),
    );
    throw error;
  }

  const responseEvent = await ctx.events.append({
    round: ctx.state.round,
    actor: options.agent,
    type: 'assistant_response',
    session_id: result.sessionId,
    content: result.content,
    exit_code: result.exitCode,
    based_on: [promptEvent.event_id],
    timestamp: deps.now().toISOString(),
  });

  // La réponse est durable : la controverse est acquise, quoi qu'il advienne
  // de la gouvernance. L'écrire avant ferait dépendre la conservation d'un
  // tour modèle d'un journal accessoire.
  const warnings: UsageGovernanceWarning[] = [];
  if (governance !== undefined && invocationId !== undefined) {
    const id = invocationId;
    try {
      const recorder = createUsageRecorder(
        await (governance.seams?.openUsageLedger ?? openUsageLedger)(ctx.paths, ctx.state.run_id),
        id,
        deps.now,
      );
      await recordTurnUsage(recorder, result);
      warnings.push(...recorder.warnings);
    } catch (error) {
      // Le journal n'a même pas pu être **ouvert** — un fichier d'usage
      // corrompu suffit. Chaque observation qui aurait réellement été tentée
      // est déclarée manquante : rien n'est inventé, et rien n'est perdu en
      // silence. L'opération, elle, continue.
      const code = isCcrError(error) ? error.code : 'UNEXPECTED';
      if (result.usageObservation !== undefined) {
        warnings.push({ invocation_id: id, provenance: 'PROVIDER_REPORTED', error_code: code });
      }
      warnings.push({ invocation_id: id, provenance: 'CCR_MEASURED', error_code: code });
    }
  }

  ctx.state = await persistStateUpdate(
    ctx.paths,
    ctx.state,
    {
      state: options.successState,
      activeAgent: null,
      lastEventId: responseEvent.event_id,
      pendingOperation: null,
    },
    deps.now(),
  );

  return {
    turn: result,
    promptEventId: promptEvent.event_id,
    responseEventId: responseEvent.event_id,
    usageGovernanceWarnings: warnings,
  };
}

// --------------------------------------------------------------------------
// start_run
// --------------------------------------------------------------------------

export interface StartRunInput {
  readonly title: string;
  readonly cwd: string;
  /** Contexte initial envoyé aux deux agents pour créer leurs sessions. */
  readonly prompt: string;
  readonly claudeRole?: AgentRole;
  readonly codexRole?: AgentRole;
  /**
   * Snapshot runtime calculé par le preflight (V1.1, §14).
   *
   * **Obligatoire** (V2-IMP-28). Il l'était sémantiquement depuis V1.1 —
   * INV-11-07 exige que tout nouveau run porte son snapshot — mais son
   * caractère optionnel permettait à n'importe quel appelant de créer un run
   * non pinné sans la moindre erreur. La compatibilité V1 signifie *lire,
   * reprendre, inspecter et récupérer* un run historique dépourvu de
   * snapshot ; elle n'a jamais signifié en *créer* de nouveaux.
   */
  readonly runtimeConfig: RunRuntimeConfig;
}

export interface StartRunResult {
  readonly runId: string;
  readonly manifest: RunManifest;
  readonly state: RunStateDocument;
  readonly turns: ReadonlyArray<{ agent: AgentKind; result: AgentTurnResult }>;
  readonly failure?: { agent: AgentKind; error: unknown };
}

/**
 * Crée un run et ses deux sessions natives.
 *
 * En cas d'échec de la seconde création, la première session est conservée et
 * le run passe `FAILED_INITIALIZATION` (§30). Aucun état valide n'est détruit
 * pour rendre l'initialisation artificiellement atomique.
 *
 * **Primitive bas niveau.** Elle n'exécute aucun preflight et suppose le
 * snapshot déjà construit. La voie applicative de création d'un run est
 * `startRunWithPreflight` (`start-application-service.ts`) : c'est elle que la
 * CLI utilise, et c'est elle qu'un futur module HTTP devra utiliser. Appeler
 * `startRun` directement contourne le preflight V1.1 — mais ne peut plus
 * produire un run non pinné, `runtimeConfig` étant désormais obligatoire.
 */
/**
 * Couture d'allocation.
 *
 * Un appelant qui doit *associer durablement* le run qu'il vient de faire créer
 * — le cockpit et son reçu d'idempotence — a besoin d'un instant précis : le
 * run existe, il porte son manifest et son snapshot, et **aucun fournisseur
 * n'a encore été joint**. C'est le seul moment où l'association peut être
 * garantie avant le premier effet externe.
 *
 * La CLI n'en fournit aucune : son comportement est inchangé.
 */
export interface StartRunHooks {
  readonly onAllocated?: (runId: string) => void | Promise<void>;
}

export async function startRun(
  deps: RunServiceDeps,
  input: StartRunInput,
  hooks: StartRunHooks = {},
): Promise<StartRunResult> {
  const paths = await createRunDirectory(deps.runsDir, deps.now());
  // Le verrou est pris dès que le run existe sur disque.
  return withRunLock(
    paths,
    'start',
    () => initializeRun(deps, paths, input, hooks),
    hostLockHooks(deps, paths.runId, 'start'),
  );
}

async function initializeRun(
  deps: RunServiceDeps,
  paths: RunPaths,
  input: StartRunInput,
  hooks: StartRunHooks,
): Promise<StartRunResult> {
  const manifest: RunManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: paths.runId,
    title: input.title,
    created_at: deps.now().toISOString(),
    workspace: { cwd: input.cwd },
    agents: {
      claude: { session_id: null, role: input.claudeRole ?? 'challenger' },
      codex: { session_id: null, role: input.codexRole ?? 'author' },
    },
    // Toujours présent : un nouveau run sans snapshot n'est plus représentable.
    runtime_config: input.runtimeConfig,
  };
  // Ordre normatif (§14.0) : le manifest **complet**, snapshot compris, est
  // durablement écrit avant qu'aucun agent ne soit invoqué. Un crash entre
  // l'allocation et le snapshot produirait sinon un run dont la configuration
  // d'adapter serait indéterminée — précisément le cas où elle est nécessaire.
  await writeManifest(paths, manifest);
  await writeState(paths, buildInitialState(paths.runId, 'READY', deps.now()));

  const events = await openEventStore(paths, paths.runId);
  const ctx: OperationContext = { paths, events, deps, manifest, state: await readState(paths) };

  const created = await events.append({
    round: 0,
    actor: 'system',
    type: 'run_created',
    content: input.title,
    details: { workspace_cwd: input.cwd },
    timestamp: deps.now().toISOString(),
  });
  ctx.state = await persistStateUpdate(
    paths,
    ctx.state,
    { state: 'RUNNING', lastEventId: created.event_id },
    deps.now(),
  );

  // Dernier instant sans fournisseur. Le run est entièrement matérialisé —
  // répertoire, manifest, snapshot, état, événement de création — et rien
  // d'externe n'a encore été sollicité.
  await hooks.onAllocated?.(paths.runId);

  // Le manifest — snapshot compris — est déjà durablement écrit à ce stade.
  const adapters = deps.createAdapters(input.cwd, runtimeSettingsOf(manifest));
  const turns: Array<{ agent: AgentKind; result: AgentTurnResult }> = [];

  for (const agent of AGENTS) {
    let outcome: DispatchOutcome;
    try {
      outcome = await dispatchTurn(ctx, {
        agent,
        adapter: adapters[agent],
        prompt: input.prompt,
        sessionId: null,
        promptActor: 'human',
        promptEventType: 'prompt_sent',
        successState: 'RUNNING',
        failureState: 'FAILED_INITIALIZATION',
        operationKind: 'initialization',
        recoveryReturnState: 'FAILED_INITIALIZATION',
        recoveryReturnControl: 'AUTOMATION',
      });
    } catch (error) {
      return { runId: paths.runId, manifest: ctx.manifest, state: ctx.state, turns, failure: { agent, error } };
    }

    ctx.manifest = await setAgentSessionId(paths, ctx.manifest, agent, outcome.turn.sessionId);
    const sessionEvent = await events.append({
      round: 0,
      actor: 'system',
      type: 'session_created',
      target: agent,
      session_id: outcome.turn.sessionId,
      timestamp: deps.now().toISOString(),
    });
    ctx.state = await persistStateUpdate(paths, ctx.state, { lastEventId: sessionEvent.event_id }, deps.now());
    turns.push({ agent, result: outcome.turn });
  }

  ctx.state = await persistStateUpdate(paths, ctx.state, { state: 'READY' }, deps.now());
  return { runId: paths.runId, manifest: ctx.manifest, state: ctx.state, turns };
}


// --------------------------------------------------------------------------
// Préconditions d'une opération longue — sans aucun effet
// --------------------------------------------------------------------------

export interface LongOperationPrecheck {
  readonly agent: AgentKind;
  readonly sessionId: string | null;
  /**
   * Faux lorsque l'opération n'atteindra aucun fournisseur.
   *
   * Cas unique en V1 : un `step` dont le transfert dépasse le garde-fou de
   * taille. Il produit bien un effet canonique — événement de garde-fou et
   * passage en `WAITING_HUMAN` — mais n'appelle personne. Il ne doit donc pas
   * consommer un créneau d'admission, dont l'objet est de borner la
   * concurrence **fournisseur**.
   */
  readonly callsProvider: boolean;
}

/**
 * Évalue les préconditions d'un `step`/`send` **sans produire le moindre
 * effet**.
 *
 * Existe pour une raison précise : l'admission ne doit pas être consommée par
 * une requête déjà condamnée. Les vérifications sont exactement celles que la
 * primitive verrouillée refera — mêmes gardes partagées du Slice 0C, même
 * `planStepTransfer` — de sorte qu'aucune seconde logique métier n'apparaît.
 * Les rejouer est sans conséquence : ce sont des prédicats purs sur un état
 * déjà chargé.
 */
export async function precheckLongOperation(
  deps: RunServiceDeps,
  runId: string,
  input: { readonly action: 'STEP' | 'SEND'; readonly agent?: AgentKind },
): Promise<LongOperationPrecheck> {
  const loaded = await loadRun(deps.runsDir, runId);
  assertRecoveryResolved(loaded);

  if (input.action === 'SEND') {
    const agent = input.agent;
    if (agent !== 'claude' && agent !== 'codex') {
      throw new CcrError('INVALID_ARGUMENT', 'Agent cible inconnu.');
    }
    const sessionId = loaded.manifest.agents[agent].session_id;
    const verdict = sendGuard(guardFactsOf(loaded), sessionId !== null);
    if (verdict.kind === 'REFUSED' && verdict.reason === 'SESSION_MISSING') {
      throw new CcrError('SESSION_MISSING', `Le run ${runId} n'a pas de session ${agent}.`, {
        details: { runId, agent, state: loaded.state.state },
      });
    }
    return { agent, sessionId, callsProvider: true };
  }

  const verdict = stepGuard(guardFactsOf(loaded));
  if (verdict.kind === 'REFUSED' && verdict.reason === 'AUTOMATION_NOT_IN_CONTROL') {
    throw new CcrError(
      'AUTOMATION_NOT_IN_CONTROL',
      `Le run ${runId} est sous contrôle ${loaded.state.control}.`,
      { details: { runId, control: loaded.state.control, state: loaded.state.state } },
    );
  }

  const events = await openEventStore(loaded.paths, runId);
  const plan = planStepTransfer({
    runId,
    round: loaded.state.round + 1,
    events: await events.readAll(),
    sessions: {
      claude: loaded.manifest.agents.claude.session_id,
      codex: loaded.manifest.agents.codex.session_id,
    },
    state: loaded.state.state,
    ...(deps.maxTransferBytes === undefined ? {} : { maxTransferBytes: deps.maxTransferBytes }),
  });

  if (plan.kind === 'BLOCKED' && plan.reason !== 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER') {
    throw plan.error;
  }
  const agent = plan.targetAgent as AgentKind;
  return {
    agent,
    sessionId: loaded.manifest.agents[agent].session_id,
    callsProvider: plan.kind === 'READY',
  };
}

// --------------------------------------------------------------------------
// send_message
// --------------------------------------------------------------------------

export interface SendMessageInput {
  readonly runId?: string;
  readonly agent: AgentKind;
  readonly message: string;
}

export interface SendMessageResult {
  readonly runId: string;
  readonly agent: AgentKind;
  readonly sessionId: string;
  readonly response: string;
  readonly state: RunStateDocument;
  /** Diagnostic de gouvernance d'usage (`V2.2-IMP-06`). Vide en fonctionnement normal. */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
}

/**
 * Envoi humain vers une session native (§24.1).
 *
 * Reste utilisable lorsque le run est `PAUSED` ou `WAITING_HUMAN`, sans rendre
 * le contrôle à l'automatisation : le run revient exactement à l'état d'où
 * l'envoi est parti. Envoyer un message n'équivaut jamais à `ccr resume`.
 */
export async function sendMessage(deps: RunServiceDeps, input: SendMessageInput): Promise<SendMessageResult> {
  const runId = await resolveRunId(deps, input.runId);
  return withRunLock(runPaths(deps.runsDir, runId), 'send', () => sendMessageLocked(deps, runId, input), hostLockHooks(deps, runId, 'send'));
}

export async function sendMessageLocked(
  deps: RunServiceDeps,
  runId: string,
  input: SendMessageInput,
  governance: LegacyGovernanceContext = {},
): Promise<SendMessageResult> {
  const loaded = await loadRun(deps.runsDir, runId);

  // Un `WAITING_AGENT` lu sur disque signifie qu'un tour est en vol — soit
  // maintenant dans un autre processus, soit au moment d'un crash. L'état
  // persisté seul ne permet pas de trancher : les deux cas interdisent
  // d'émettre un second tour. Le verrou de run (lot V1.8) distinguera un
  // propriétaire vivant d'un verrou périmé.
  assertRecoveryResolved(loaded);

  const sessionId = loaded.manifest.agents[input.agent].session_id;
  // Seule l'absence de session est court-circuitée ici : la barrière de
  // transition reste appliquée par `persistStateUpdate`, comme en V1, afin que
  // le code public levé demeure exactement le même.
  const sendVerdict = sendGuard(guardFactsOf(loaded), sessionId !== null);
  if (sendVerdict.kind === 'REFUSED' && sendVerdict.reason === 'SESSION_MISSING') {
    throw new CcrError('SESSION_MISSING', `Le run ${runId} n'a pas de session ${input.agent}.`, {
      details: { runId, agent: input.agent, state: loaded.state.state },
    });
  }

  // Politique de quota (V2.2-IMP-08), avant la transition et avant le
  // `human_message` : celui-ci est le prompt de l'invocation, pas une décision
  // canonique autonome — `ccr decide` tient ce rôle-là.
  await assertInvocationQuotaAvailable(loaded.paths, runId);

  const origin = loaded.state.state;
  const events = await openEventStore(loaded.paths, runId);
  const ctx: OperationContext = {
    paths: loaded.paths,
    events,
    deps,
    manifest: loaded.manifest,
    state: loaded.state,
  };

  // Sous contrôle automatisé, un tour n'est atteint qu'après RUNNING.
  if (origin !== 'PAUSED' && origin !== 'WAITING_HUMAN') {
    ctx.state = await persistStateUpdate(loaded.paths, ctx.state, { state: 'RUNNING' }, deps.now());
  }

  const adapters = deps.createAdapters(loaded.manifest.workspace.cwd, runtimeSettingsOf(loaded.manifest));
  const humanOrigin = origin === 'PAUSED' || origin === 'WAITING_HUMAN';
  const outcome = await dispatchTurn(ctx, {
    agent: input.agent,
    adapter: adapters[input.agent],
    prompt: input.message,
    sessionId,
    promptActor: 'human',
    promptEventType: 'human_message',
    successState: stateAfterTurnFrom(origin),
    operationKind: 'send',
    recoveryReturnState: humanOrigin ? origin : 'READY',
    recoveryReturnControl: loaded.state.control,
    // Un envoi n'est pas un transfert : ni source, ni round consommé. Le round
    // rapporté est celui auquel le message est adressé.
    governance: { ...governance, trigger: 'SEND', round: ctx.state.round },
  });

  // Retour à l'état d'origine sans toucher au propriétaire du contrôle.
  if (origin !== 'PAUSED' && origin !== 'WAITING_HUMAN' && ctx.state.state === 'RUNNING') {
    ctx.state = await persistStateUpdate(loaded.paths, ctx.state, { state: 'READY' }, deps.now());
  }

  return {
    runId,
    agent: input.agent,
    sessionId: outcome.turn.sessionId,
    response: outcome.turn.content,
    state: ctx.state,
    usageGovernanceWarnings: outcome.usageGovernanceWarnings,
  };
}

// --------------------------------------------------------------------------
// step_run — passage de témoin
// --------------------------------------------------------------------------

export interface StepRunInput {
  readonly runId?: string;
}

export interface StepRunResult {
  readonly runId: string;
  readonly round: number;
  readonly sourceAgent: AgentKind;
  readonly sourceEventId: string;
  readonly targetAgent: AgentKind;
  readonly targetSessionId: string;
  readonly transferredBytes: number;
  readonly response: string;
  readonly state: RunStateDocument;
  /** Diagnostic de gouvernance d'usage (`V2.2-IMP-06`). Vide en fonctionnement normal. */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
}

/**
 * Effectue **un seul** passage de témoin (§25).
 *
 *   dernière réponse Claude → Codex
 *   dernière réponse Codex  → Claude
 *
 * `step` ne déclenche jamais d'enchaînement automatique : la boucle
 * multi-rounds résulte de plusieurs appels, ce qui laisse un point de contrôle
 * humain entre chaque tour.
 *
 * Un round CCR = un passage de témoin vers un agent cible et sa réponse.
 * `Claude → Codex` est le round N, `Codex → Claude` le round N+1.
 */
export async function stepRun(deps: RunServiceDeps, input: StepRunInput = {}): Promise<StepRunResult> {
  const runId = await resolveRunId(deps, input.runId);
  return withRunLock(runPaths(deps.runsDir, runId), 'step', () => stepRunLocked(deps, runId), hostLockHooks(deps, runId, 'step'));
}

export async function stepRunLocked(
  deps: RunServiceDeps,
  runId: string,
  governance: LegacyGovernanceContext = {},
): Promise<StepRunResult> {
  const loaded = await loadRun(deps.runsDir, runId);
  assertRecoveryResolved(loaded);

  // `step` est l'automatisation. Sous contrôle humain, elle ne produit pas de
  // nouveau tour ; c'est `send` qui reste disponible.
  const stepVerdict = stepGuard(guardFactsOf(loaded));
  if (stepVerdict.kind === 'REFUSED' && stepVerdict.reason === 'AUTOMATION_NOT_IN_CONTROL') {
    throw new CcrError(
      'AUTOMATION_NOT_IN_CONTROL',
      `Le run ${runId} est sous contrôle ${loaded.state.control}. Utilisez \`ccr resume\` ou \`ccr send\`.`,
      { details: { runId, control: loaded.state.control, state: loaded.state.state } },
    );
  }

  const events = await openEventStore(loaded.paths, runId);
  const history = await events.readAll();
  const round = loaded.state.round + 1;

  // Source, agent cible, session cible, enveloppe et garde-fou de taille sont
  // déterminés par la MÊME primitive que celle qui alimente les capacités
  // (V2-IMP-30) : le service et la capacité ne peuvent pas diverger.
  const plan = planStepTransfer({
    runId,
    round,
    events: history,
    sessions: {
      claude: loaded.manifest.agents.claude.session_id,
      codex: loaded.manifest.agents.codex.session_id,
    },
    state: loaded.state.state,
    ...(deps.maxTransferBytes === undefined ? {} : { maxTransferBytes: deps.maxTransferBytes }),
  });

  if (plan.kind === 'BLOCKED' && plan.reason !== 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER') {
    throw plan.error;
  }

  // Politique de quota (V2.2-IMP-08), avant le garde-fou de taille comme avant
  // toute mutation : un run dont la politique est épuisée ne change pas d'état
  // pour un transfert qui n'aurait joint personne.
  await assertInvocationQuotaAvailable(loaded.paths, runId);

  const source = plan.source as TransferSource;
  const targetAgent = plan.targetAgent as AgentKind;
  const prompt = plan.kind === 'READY' ? plan.prompt : '';
  const limit = plan.limit ?? DEFAULT_MAX_TRANSFER_BYTES;
  const transferredBytes = plan.bytes ?? 0;

  const ctx: OperationContext = {
    paths: loaded.paths,
    events,
    deps,
    manifest: loaded.manifest,
    state: loaded.state,
  };

  if (plan.kind === 'BLOCKED') {
    // Garde-fou : aucun appel agent, aucune troncature, aucun résumé.
    // Le contenu source reste intact et l'humain décide de la suite.
    const guardEvent = await events.append({
      round: loaded.state.round,
      actor: 'system',
      type: 'state_changed',
      target: targetAgent,
      based_on: [source.event.event_id],
      details: {
        reason: 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
        bytes: transferredBytes,
        limit,
        source_event_id: source.event.event_id,
        source_agent: source.agent,
        from: loaded.state.state,
        to: 'WAITING_HUMAN',
      },
      timestamp: deps.now().toISOString(),
    });

    await persistStateUpdate(
      loaded.paths,
      loaded.state,
      { state: 'WAITING_HUMAN', control: 'HUMAN', lastEventId: guardEvent.event_id },
      deps.now(),
    );

    throw plan.error;
  }

  const targetSessionId = plan.targetSessionId;

  ctx.state = await persistStateUpdate(loaded.paths, ctx.state, { state: 'RUNNING', round }, deps.now());

  const startedEvent = await events.append({
    round,
    actor: 'system',
    type: 'round_started',
    target: targetAgent,
    based_on: [source.event.event_id],
    details: {
      source_agent: source.agent,
      source_event_id: source.event.event_id,
      target_agent: targetAgent,
      transferred_bytes: transferredBytes,
    },
    timestamp: deps.now().toISOString(),
  });
  ctx.state = await persistStateUpdate(loaded.paths, ctx.state, { lastEventId: startedEvent.event_id }, deps.now());

  const adapters = deps.createAdapters(loaded.manifest.workspace.cwd, runtimeSettingsOf(loaded.manifest));
  const outcome = await dispatchTurn(ctx, {
    agent: targetAgent,
    adapter: adapters[targetAgent],
    prompt,
    sessionId: targetSessionId,
    promptActor: 'system',
    promptEventType: 'prompt_sent',
    basedOn: [source.event.event_id],
    successState: 'RUNNING',
    operationKind: 'step',
    sourceEventId: source.event.event_id,
    recoveryReturnState: 'READY',
    recoveryReturnControl: 'AUTOMATION',
    governance: {
      ...governance,
      trigger: 'STEP',
      round,
      sourceEventId: source.event.event_id,
    },
  });

  const completedEvent = await events.append({
    round,
    actor: 'system',
    type: 'round_completed',
    target: targetAgent,
    based_on: [source.event.event_id, outcome.responseEventId],
    details: {
      source_agent: source.agent,
      source_event_id: source.event.event_id,
      target_agent: targetAgent,
      target_session_id: outcome.turn.sessionId,
    },
    timestamp: deps.now().toISOString(),
  });

  await writeRoundTurnArtifacts(loaded.paths, round, targetAgent, {
    prompt,
    response: outcome.turn.content,
    stdoutRaw: outcome.turn.stdoutRaw,
    stderrRaw: outcome.turn.stderrRaw,
  });
  await writeRoundMetadata(loaded.paths, {
    schema_version: ROUND_SCHEMA_VERSION,
    run_id: runId,
    round,
    started_at: startedEvent.timestamp,
    completed_at: completedEvent.timestamp,
    workspace_cwd: loaded.manifest.workspace.cwd,
    turns: [
      {
        agent: targetAgent,
        // Événement réellement porteur du prompt transmis, et non l'événement
        // `round_started` qui le précède.
        prompt_event_id: outcome.promptEventId,
        response_event_id: outcome.responseEventId,
        started_at: outcome.turn.startedAt,
        completed_at: outcome.turn.completedAt,
      },
    ],
  });

  ctx.state = await persistStateUpdate(
    loaded.paths,
    ctx.state,
    { state: 'READY', lastEventId: completedEvent.event_id },
    deps.now(),
  );

  return {
    runId,
    round,
    sourceAgent: source.agent,
    sourceEventId: source.event.event_id,
    targetAgent,
    targetSessionId: outcome.turn.sessionId,
    transferredBytes,
    response: outcome.turn.content,
    state: ctx.state,
    usageGovernanceWarnings: outcome.usageGovernanceWarnings,
  };
}

// --------------------------------------------------------------------------
// Contrôle humain — pause / resume / handoff / decide
// --------------------------------------------------------------------------

export interface ControlRunInput {
  readonly runId?: string;
}

export interface ControlResult {
  readonly runId: string;
  readonly state: RunStateDocument;
  /** Faux lorsque l'opération était déjà satisfaite : aucun événement produit. */
  readonly changed: boolean;
}

/**
 * Suspend volontairement l'automatisation (§20).
 *
 * Postcondition : l'automatisation ne détient plus le contrôle. Si elle est
 * déjà satisfaite, l'opération est idempotente et ne produit aucun événement.
 *
 * `WAITING_HUMAN` n'est jamais requalifié en `PAUSED` : les deux états ne
 * disent pas la même chose (impossibilité constatée par CCR d'un côté,
 * décision humaine de l'autre), et écraser le premier perdrait son motif.
 *
 * `RECOVERY_REQUIRED`, `FAILED`, `FAILED_INITIALIZATION` et `CLOSED` ont leurs
 * propres chemins : `pause` ne les transforme pas.
 */
export async function pauseRun(deps: RunServiceDeps, input: ControlRunInput = {}): Promise<ControlResult> {
  const runId = await resolveRunId(deps, input.runId);
  return withRunLock(runPaths(deps.runsDir, runId), 'pause', () => pauseRunLocked(deps, runId), hostLockHooks(deps, runId, 'pause'));
}

export async function pauseRunLocked(deps: RunServiceDeps, runId: string): Promise<ControlResult> {
  const loaded = await loadRun(deps.runsDir, runId);

  // Un tour potentiellement en vol ne peut pas être suspendu proprement.
  assertRecoveryResolved(loaded);

  const current = loaded.state;
  const verdict = pauseGuard(guardFactsOf(loaded));
  if (verdict.kind === 'NOOP') return { runId, state: current, changed: false };
  if (verdict.kind === 'REFUSED') {
    throw new CcrError(
      'RUN_NOT_PAUSABLE',
      `Le run ${runId} est en ${current.state} : cet état possède son propre chemin, \`pause\` ne le transforme pas.`,
      { details: { runId, state: current.state, control: current.control } },
    );
  }

  const targetState: RunState = current.state === 'WAITING_HUMAN' ? 'WAITING_HUMAN' : 'PAUSED';
  const events = await openEventStore(loaded.paths, runId);
  const event = await events.append({
    round: current.round,
    actor: 'human',
    type: 'run_paused',
    details: {
      state_from: current.state,
      state_to: targetState,
      control_from: current.control,
      control_to: 'HUMAN',
    },
    timestamp: deps.now().toISOString(),
  });

  const next = await persistStateUpdate(
    loaded.paths,
    current,
    { state: targetState, control: 'HUMAN', lastEventId: event.event_id },
    deps.now(),
  );
  return { runId, state: next, changed: true };
}

/**
 * Rend le run disponible pour l'automatisation (§21).
 *
 * `resume` ne lance aucun agent et n'effectue aucun `step` implicite : il ne
 * change que l'état et le propriétaire du contrôle. L'état atteint est `READY`
 * — « initialisé et exécutable, aucun travail en cours » — car aucune commande
 * ne s'exécute plus une fois `ccr resume` terminé.
 *
 * Idempotent lorsque l'automatisation détient déjà un run exécutable.
 *
 * Ne permet jamais de sortir de `WAITING_AGENT`, `RECOVERY_REQUIRED`,
 * `FAILED`, `FAILED_INITIALIZATION` ou `CLOSED` : ces états ont leur propre
 * mécanisme.
 */
export async function resumeRun(deps: RunServiceDeps, input: ControlRunInput = {}): Promise<ControlResult> {
  const runId = await resolveRunId(deps, input.runId);
  return withRunLock(runPaths(deps.runsDir, runId), 'resume', () => resumeRunLocked(deps, runId), hostLockHooks(deps, runId, 'resume'));
}

export async function resumeRunLocked(deps: RunServiceDeps, runId: string): Promise<ControlResult> {
  const loaded = await loadRun(deps.runsDir, runId);
  assertRecoveryResolved(loaded);

  const current = loaded.state;
  const verdict = resumeGuard(guardFactsOf(loaded));
  if (verdict.kind === 'NOOP') return { runId, state: current, changed: false };
  if (verdict.kind === 'REFUSED') {
    throw new CcrError(
      'RUN_NOT_RESUMABLE',
      `Le run ${runId} est en ${current.state} : cet état exige son mécanisme propre avant toute reprise.`,
      { details: { runId, state: current.state, control: current.control } },
    );
  }

  const events = await openEventStore(loaded.paths, runId);
  const event = await events.append({
    round: current.round,
    actor: 'human',
    type: 'run_resumed',
    details: {
      state_from: current.state,
      state_to: 'READY',
      control_from: current.control,
      control_to: 'AUTOMATION',
    },
    timestamp: deps.now().toISOString(),
  });

  const next = await persistStateUpdate(
    loaded.paths,
    current,
    { state: 'READY', control: 'AUTOMATION', lastEventId: event.event_id },
    deps.now(),
  );
  return { runId, state: next, changed: true };
}

export interface HandoffRunInput extends ControlRunInput {
  readonly agent: AgentKind;
}

export interface HandoffResult {
  readonly runId: string;
  readonly agent: AgentKind;
  readonly sessionId: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly state: RunStateDocument;
}

/**
 * Ouvre la session native dans la CLI officielle (§28, §29).
 *
 * L'humain dialogue directement avec l'agent ; CCR n'observe que la fenêtre
 * d'intervention. Il ne tente pas d'importer les messages échangés depuis les
 * transcripts privés (§16) — la V1 assume cette limite.
 *
 * Fermer l'interface interactive ne relance jamais l'automatisation : l'état
 * et le contrôle humains sont conservés, et c'est `ccr resume` qui décide.
 */
export async function handoffRun(deps: RunServiceDeps, input: HandoffRunInput): Promise<HandoffResult> {
  const runId = await resolveRunId(deps, input.runId);
  // Le verrou couvre toute la durée de l'interaction native.
  return withRunLock(runPaths(deps.runsDir, runId), 'handoff', () => handoffRunLocked(deps, runId, input), hostLockHooks(deps, runId, 'handoff'));
}

async function handoffRunLocked(
  deps: RunServiceDeps,
  runId: string,
  input: HandoffRunInput,
): Promise<HandoffResult> {
  const loaded = await loadRun(deps.runsDir, runId);
  assertRecoveryResolved(loaded);

  const current = loaded.state;
  const handoffVerdict = handoffGuard(guardFactsOf(loaded), true);
  if (handoffVerdict.kind === 'REFUSED' && handoffVerdict.reason === 'HANDOFF_NOT_ALLOWED') {
    throw new CcrError(
      'HANDOFF_NOT_ALLOWED',
      `Le handoff exige un run sous contrôle humain en PAUSED ou WAITING_HUMAN ; ` +
        `le run ${runId} est en ${current.state} / ${current.control}. Utilisez \`ccr pause\`.`,
      { details: { runId, state: current.state, control: current.control } },
    );
  }

  // Aucune session n'est jamais créée par un handoff.
  const sessionId = loaded.manifest.agents[input.agent].session_id;
  if (sessionId === null) {
    throw new CcrError(
      'SESSION_MISSING',
      `Le run ${runId} n'a pas de session ${input.agent} : le handoff n'en crée pas.`,
      { details: { runId, agent: input.agent, state: current.state } },
    );
  }

  const events = await openEventStore(loaded.paths, runId);
  const startedAt = deps.now().toISOString();
  const startedEvent = await events.append({
    round: current.round,
    actor: 'human',
    type: 'human_handoff_started',
    target: input.agent,
    session_id: sessionId,
    details: { state: current.state, control: current.control },
    timestamp: startedAt,
  });
  // Le contexte est persisté avant le lancement : un handoff commencé mais
  // non terminé est une ambiguïté, même si l'état reste PAUSED. La mort du
  // processus CCR parent ne prouve pas que le client interactif est fermé.
  let state = await persistStateUpdate(
    loaded.paths,
    current,
    {
      lastEventId: startedEvent.event_id,
      pendingOperation: {
        kind: 'handoff',
        agent: input.agent,
        round: current.round,
        prompt_event_id: startedEvent.event_id,
        source_event_id: null,
        session_id: sessionId,
        return_state: current.state,
        return_control: current.control,
        started_at: startedAt,
      },
    },
    deps.now(),
  );

  const adapters = deps.createAdapters(loaded.manifest.workspace.cwd, runtimeSettingsOf(loaded.manifest));
  let interactive;
  try {
    interactive = await adapters[input.agent].openInteractive(sessionId);
  } catch (error) {
    // Échec de lancement : non destructif. L'identifiant natif est intact et
    // le run reste sous contrôle humain, dans son état précédent.
    const failureEvent = await events.append({
      round: current.round,
      actor: 'system',
      type: 'process_failed',
      target: input.agent,
      session_id: sessionId,
      content: error instanceof Error ? error.message : String(error),
      details: { ...errorDetails(error), phase: 'handoff' },
      based_on: [startedEvent.event_id],
      timestamp: deps.now().toISOString(),
    });
    await persistStateUpdate(
      loaded.paths,
      state,
      { lastEventId: failureEvent.event_id, pendingOperation: null },
      deps.now(),
    );
    throw error;
  }

  const finishedEvent = await events.append({
    round: current.round,
    actor: 'human',
    type: 'human_handoff_finished',
    target: input.agent,
    session_id: sessionId,
    exit_code: interactive.exitCode,
    based_on: [startedEvent.event_id],
    details: {
      started_at: interactive.startedAt,
      completed_at: interactive.completedAt,
      duration_ms: interactive.durationMs,
      note: 'Intervention native externe possible : CCR ne connaît pas le détail des messages échangés.',
    },
    timestamp: deps.now().toISOString(),
  });

  // État et contrôle inchangés : la reprise reste une décision explicite.
  state = await persistStateUpdate(
    loaded.paths,
    state,
    { lastEventId: finishedEvent.event_id, pendingOperation: null },
    deps.now(),
  );

  return {
    runId,
    agent: input.agent,
    sessionId,
    exitCode: interactive.exitCode,
    durationMs: interactive.durationMs,
    state,
  };
}

export interface RecordDecisionInput extends ControlRunInput {
  readonly content: string;
}

export interface RecordDecisionResult {
  readonly runId: string;
  readonly decision: CcrDecision;
  readonly state: RunStateDocument;
}

/**
 * Enregistre une décision humaine normative (§17).
 *
 * Une décision **n'est pas un message** : `human_message` oriente une
 * conversation, une décision est une information canonique normative. Les deux
 * restent des enregistrements distincts.
 *
 * La V1 enregistre ; elle ne diffuse pas. Aucune session native n'est appelée,
 * ni l'état ni le contrôle ne changent. Pour expliquer une décision à un
 * agent, l'humain utilise ensuite `ccr send`. Diffuser implicitement
 * mélangerait mémoire canonique et communication conversationnelle.
 *
 * Journal append-only : une décision ne s'édite ni ne se supprime. La corriger
 * consiste à en écrire une nouvelle.
 */
export async function recordDecision(
  deps: RunServiceDeps,
  input: RecordDecisionInput,
): Promise<RecordDecisionResult> {
  const content = input.content.trim();
  if (decideGuard(content.length > 0).kind === 'REFUSED') {
    throw new CcrError('INVALID_ARGUMENT', 'Une décision ne peut pas être vide.');
  }

  const runId = await resolveRunId(deps, input.runId);
  return withRunLock(runPaths(deps.runsDir, runId), 'decide', () => recordDecisionLocked(deps, runId, content), hostLockHooks(deps, runId, 'decide'));
}

export async function recordDecisionLocked(
  deps: RunServiceDeps,
  runId: string,
  content: string,
): Promise<RecordDecisionResult> {
  const loaded = await loadRun(deps.runsDir, runId);

  const decisions = await openDecisionStore(loaded.paths, runId);
  const decision = await decisions.append({
    round: loaded.state.round,
    author: 'human',
    status: 'ACTIVE',
    content,
    timestamp: deps.now().toISOString(),
  });

  const events = await openEventStore(loaded.paths, runId);
  const event = await events.append({
    round: loaded.state.round,
    actor: 'human',
    type: 'decision_recorded',
    content,
    details: { decision_id: decision.decision_id, status: decision.status },
    timestamp: deps.now().toISOString(),
  });

  const state = await persistStateUpdate(
    loaded.paths,
    loaded.state,
    { lastEventId: event.event_id },
    deps.now(),
  );

  return { runId, decision, state };
}

export async function listDecisions(deps: RunServiceDeps, runId?: string): Promise<CcrDecision[]> {
  const resolved = await resolveRunId(deps, runId);
  const loaded = await loadRun(deps.runsDir, resolved);
  return (await openDecisionStore(loaded.paths, resolved)).readAll();
}

/**
 * Clôt un run (§44).
 *
 * Ne supprime jamais les sessions natives : elles restent accessibles
 * manuellement. `stop` signifie uniquement que ce run ne sera plus poursuivi
 * automatiquement.
 */
export async function stopRun(deps: RunServiceDeps, input: ControlRunInput = {}): Promise<ControlResult> {
  const runId = await resolveRunId(deps, input.runId);
  return withRunLock(runPaths(deps.runsDir, runId), 'stop', () => stopRunLocked(deps, runId), hostLockHooks(deps, runId, 'stop'));
}

/**
 * Corps de `stop`, **verrou déjà détenu**.
 *
 * Extrait sans modification de comportement : mêmes gardes, mêmes transitions,
 * mêmes événements. La forme rejoint celle de `pause`, `resume` et `decide`,
 * pour que le transport HTTP puisse composer une section critique unique
 * couvrant à la fois la précondition de révision et l'effet.
 */
export async function stopRunLocked(deps: RunServiceDeps, runId: string): Promise<ControlResult> {
  const loaded = await loadRun(deps.runsDir, runId);
  assertRecoveryResolved(loaded);

  if (stopGuard(guardFactsOf(loaded)).kind === 'NOOP') {
    return { runId, state: loaded.state, changed: false };
  }

  const events = await openEventStore(loaded.paths, runId);
  const event = await events.append({
    round: loaded.state.round,
    actor: 'human',
    type: 'run_completed',
    details: { state_from: loaded.state.state, state_to: 'CLOSED' },
    timestamp: deps.now().toISOString(),
  });
  const state = await persistStateUpdate(
    loaded.paths,
    loaded.state,
    { state: 'CLOSED', control: 'HUMAN', lastEventId: event.event_id },
    deps.now(),
  );
  return { runId, state, changed: true };
}

// --------------------------------------------------------------------------
// recover_run
// --------------------------------------------------------------------------

export interface RecoverRunInput extends ControlRunInput {
  /**
   * Note humaine acquittant une ambiguïté que CCR ne peut pas trancher.
   * Ne prétend ni que le tour a eu lieu, ni le contraire.
   */
  readonly acknowledge?: string;
}

export interface RecoverAmbiguity {
  readonly reason: string;
  readonly operation: PendingOperation | null;
  readonly lastEventId: string | null;
}

export interface RecoverResult {
  readonly runId: string;
  readonly state: RunStateDocument;
  /** Ce que la reprise a effectivement fait, en clair. */
  readonly actions: readonly string[];
  readonly staleLock: RunLockInfo | undefined;
  readonly ambiguity: RecoverAmbiguity | undefined;
  readonly sessionsCreated: readonly AgentKind[];
  /** Diagnostic de gouvernance d'usage (`V2.2-IMP-06`). Vide en fonctionnement normal. */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
  /**
   * Cause exacte d'un slot non repris (`V2.2-IMP-08`).
   *
   * La reprise historique rapporte plutôt qu'elle ne lève, et ce contrat est
   * conservé. Mais un refus de politique doit rester **nommable** : le motif
   * voyage ici, à côté des sessions déjà acquises, plutôt que de se dissoudre
   * dans un texte d'action.
   */
  readonly failure?: { readonly agent: AgentKind; readonly error: unknown };
}

/**
 * Reprise explicite d'un run (§22, §30, §32).
 *
 * Seule commande autorisée à supprimer un verrou périmé, et seule à pouvoir
 * compléter une initialisation partielle.
 *
 * Elle ne relance jamais automatiquement un tour ambigu, n'invente aucune
 * réponse, ne réécrit pas le journal, et ne lit aucun transcript natif privé
 * pour deviner ce qu'un agent a fait.
 */
export async function recoverRun(deps: RunServiceDeps, input: RecoverRunInput = {}): Promise<RecoverResult> {
  const runId = await resolveRunId(deps, input.runId);
  const paths = runPaths(deps.runsDir, runId);
  const actions: string[] = [];

  // Hygiène du verrou. Un propriétaire vivant, ou un verrou venu d'un autre
  // hôte, fait échouer l'acquisition ci-dessous — c'est le comportement voulu.
  let staleLock: RunLockInfo | undefined;
  const existing = await readRunLock(paths);
  if (existing !== undefined && assessLiveness(existing) === 'STALE') {
    staleLock = await clearStaleLock(paths);
    actions.push(
      `Verrou périmé supprimé (pid ${String(existing.pid)}, commande « ${existing.command} », posé le ${existing.started_at}).`,
    );
  }

  return withRunLock(paths, 'recover', () => recoverRunLocked(deps, runId, input, actions, staleLock), hostLockHooks(deps, runId, 'recover'));
}

/**
 * Cœur de la reprise, **sous verrou déjà acquis**.
 *
 * Exporté pour que le cockpit compose sa propre section critique — révision
 * vérifiée puis effet, dans un seul verrou — sans passer par la façade
 * publique `recoverRun`, dont le pré-nettoyage de verrou périmé appartient au
 * comportement V1 et non à la doctrine V2 (V2-IMP-40A §1B).
 *
 * Aucune branche n'est dupliquée : c'est exactement la logique que la CLI
 * exécute. L'appelant est responsable du verrou, de la révision et du plan.
 */
export async function recoverRunLocked(
  deps: RunServiceDeps,
  runId: string,
  input: RecoverRunInput,
  actions: string[] = [],
  staleLock: RunLockInfo | undefined = undefined,
  governance: LegacyGovernanceContext = {},
): Promise<RecoverResult> {
  const loaded = await loadRun(deps.runsDir, runId);
  const events = await openEventStore(loaded.paths, runId);
  const history = await events.readAll();

  let state = loaded.state;
  let ambiguity: RecoverAmbiguity | undefined;
  const sessionsCreated: AgentKind[] = [];
  const usageGovernanceWarnings: UsageGovernanceWarning[] = [];
  /**
   * Cette invocation a-t-elle finalisé une réponse déjà journalisée ?
   *
   * Le drapeau ne décrit pas un mode : il nomme la **capacité** que
   * `planCanonicalRecovery` a rendue pour ces mêmes faits. Une opération
   * d'initialisation finalisée revient en `FAILED_INITIALIZATION`, où vit aussi
   * la boucle de création des sessions manquantes ; sans lui, les deux gestes
   * se rejoignent et `FINALIZE_WITHOUT_AGENT_CALL` joint un fournisseur.
   */
  let finalizedJournaledResponse = false;

  let failure: { agent: AgentKind; error: unknown } | undefined;
  const done = (): RecoverResult => ({
    runId,
    state,
    actions,
    staleLock,
    ambiguity,
    sessionsCreated,
    usageGovernanceWarnings,
    ...(failure === undefined ? {} : { failure }),
  });

  // `FAILED` et `CLOSED` sont diagnostiqués, jamais réactivés.
  if (state.state === 'FAILED' || state.state === 'CLOSED') {
    actions.push(`État ${state.state} : terminal en V1. \`ccr recover\` ne le transforme pas en run actif.`);
    return done();
  }

  /**
   * Instantané de l'opération abandonnée, écrit dans le journal append-only.
   *
   * `state.json` pourra être nettoyé par l'acquittement ; la preuve historique
   * de ce qui a été abandonné, elle, ne doit jamais disparaître.
   */
  const operationSnapshot = (): Record<string, unknown> => {
    const operation = state.pending_operation;
    if (operation === null) return { operation: null };
    return {
      operation: operation.kind,
      operation_agent: operation.agent,
      operation_round: operation.round,
      operation_prompt_event_id: operation.prompt_event_id,
      operation_source_event_id: operation.source_event_id,
      operation_session_id: operation.session_id,
      operation_return_state: operation.return_state,
      operation_return_control: operation.return_control,
      operation_started_at: operation.started_at,
    };
  };

  const markAmbiguous = async (reason: string): Promise<void> => {
    ambiguity = { reason, operation: state.pending_operation, lastEventId: state.last_event_id };
    if (state.state !== 'RECOVERY_REQUIRED') {
      const event = await events.append({
        round: state.round,
        actor: 'system',
        type: 'state_changed',
        details: {
          reason: 'RECOVERY_REQUIRED',
          detail: reason,
          from: state.state,
          to: 'RECOVERY_REQUIRED',
          conclusion: "Aucune : CCR n'a pas déterminé si le tour a eu lieu.",
          ...operationSnapshot(),
        },
        timestamp: deps.now().toISOString(),
      });
      state = await persistStateUpdate(
        loaded.paths,
        state,
        { ...buildRecoveryUpdate(state, reason), lastEventId: event.event_id },
        deps.now(),
      );
    }
    actions.push(`Ambiguïté matérialisée : ${reason}`);
  };

  // Un run déjà marqué ambigu ne se finalise plus tout seul : la seule sortie
  // est un acquittement humain explicite. Une opération finalisable de façon
  // déterministe l'aurait été lors de la reprise qui a posé ce marqueur.
  if (state.state === 'RECOVERY_REQUIRED') {
    if (input.acknowledge === undefined || input.acknowledge.trim().length === 0) {
      ambiguity = {
        reason: state.uncertainty?.reason ?? 'Ambiguïté enregistrée sans motif.',
        operation: state.pending_operation,
        lastEventId: state.last_event_id,
      };
      actions.push(
        'Ambiguïté non résolue. Acquittez-la explicitement avec `ccr recover --acknowledge "..."` ' +
          'pour revenir en PAUSED / HUMAN.',
      );
      return done();
    }

    const note = input.acknowledge.trim();
    const event = await events.append({
      round: state.round,
      actor: 'human',
      type: 'state_changed',
      content: note,
      details: {
        reason: 'RECOVERY_ACKNOWLEDGED',
        from: 'RECOVERY_REQUIRED',
        to: 'PAUSED',
        ambiguity_reason: state.uncertainty?.reason ?? null,
        conclusion: "Aucune : CCR n'a pas déterminé si le tour a eu lieu.",
        note: "L'acquittement ne prétend ni que le tour a eu lieu, ni le contraire.",
        ...operationSnapshot(),
      },
      timestamp: deps.now().toISOString(),
    });
    state = await persistStateUpdate(
      loaded.paths,
      state,
      {
        state: 'PAUSED',
        control: 'HUMAN',
        uncertainty: null,
        pendingOperation: null,
        lastEventId: event.event_id,
      },
      deps.now(),
    );
    actions.push("Ambiguïté acquittée par l'humain. Run rendu en PAUSED / HUMAN.");
    return done();
  }

  const pending = state.pending_operation;

  if (pending !== null && pending.kind === 'handoff') {
    // Un handoff commencé sans fin n'est pas un simple verrou à nettoyer : la
    // mort du processus CCR ne prouve pas que le client interactif est fermé.
    await markAmbiguous(
      `Un handoff ${pending.agent} a commencé le ${pending.started_at} sans être conclu. ` +
        "La session interactive native peut encore être ouverte : CCR ne peut pas l'affirmer.",
    );
    return done();
  }

  if (pending !== null) {
    const promptEventId = pending.prompt_event_id;
    const response =
      promptEventId === null
        ? undefined
        : history.find(
            (event) =>
              event.type === 'assistant_response' && (event.based_on ?? []).includes(promptEventId),
          );

    if (response === undefined) {
      // Cas B : l'agent a pu ne rien recevoir, ne pas finir, ou finir sans que
      // CCR capture. Impossible de trancher — aucun retry, aucune synthèse.
      await markAmbiguous(
        `Un tour ${pending.kind} vers ${pending.agent} a été engagé le ${pending.started_at} ` +
          "sans qu'aucune réponse ne soit journalisée. CCR ne peut pas savoir si l'agent l'a traité.",
      );
      return done();
    }

    // Cas A : la réponse est durablement journalisée. Le contenu externe n'est
    // plus ambigu — CCR le possède. L'opération est finalisable sans rappeler
    // l'agent et sans inventer la moindre information.
    actions.push(
      `Réponse ${response.event_id} déjà journalisée pour l'opération ${pending.kind} (${pending.agent}) : finalisation sans nouvel appel agent.`,
    );

    if (pending.kind === 'initialization' && typeof response.session_id === 'string') {
      if (loaded.manifest.agents[pending.agent].session_id === null) {
        await setAgentSessionId(loaded.paths, loaded.manifest, pending.agent, response.session_id);
        actions.push(`Session ${pending.agent} enregistrée : ${response.session_id}.`);
      }
      const alreadyRecorded = history.some(
        (event) => event.type === 'session_created' && event.target === pending.agent,
      );
      if (!alreadyRecorded) {
        await events.append({
          round: pending.round,
          actor: 'system',
          type: 'session_created',
          target: pending.agent,
          session_id: response.session_id,
          timestamp: deps.now().toISOString(),
        });
      }
    }

    if (pending.kind === 'step' && pending.source_event_id !== null) {
      const alreadyCompleted = history.some(
        (event) =>
          event.type === 'round_completed' && event.details?.['source_event_id'] === pending.source_event_id,
      );
      if (!alreadyCompleted) {
        await events.append({
          round: pending.round,
          actor: 'system',
          type: 'round_completed',
          target: pending.agent,
          based_on: [pending.source_event_id, response.event_id],
          details: {
            source_event_id: pending.source_event_id,
            target_agent: pending.agent,
            target_session_id: response.session_id ?? null,
            recovered: true,
          },
          timestamp: deps.now().toISOString(),
        });
        actions.push(`Round ${String(pending.round)} clôturé à partir du journal.`);
      }
    }

    const finalEvent = await events.append({
      round: pending.round,
      actor: 'system',
      type: 'state_changed',
      details: {
        reason: 'RECOVERY_FINALIZED',
        operation: pending.kind,
        agent: pending.agent,
        response_event_id: response.event_id,
        from: state.state,
        to: pending.return_state,
      },
      timestamp: deps.now().toISOString(),
    });

    state = await persistStateUpdate(
      loaded.paths,
      state,
      {
        state: pending.return_state,
        control: pending.return_control,
        activeAgent: null,
        pendingOperation: null,
        uncertainty: null,
        lastEventId: finalEvent.event_id,
      },
      deps.now(),
    );
    actions.push(`État restauré : ${state.state} / ${state.control}.`);
    finalizedJournaledResponse = true;
  } else if (state.state === 'WAITING_AGENT') {
    // `state.json` en schéma 1 ne pouvait pas porter de contexte d'opération.
    // L'absence de `pending_operation` n'autorise donc AUCUNE conclusion : un
    // `WAITING_AGENT` persisté signifie toujours qu'un tour a pu avoir lieu.
    await markAmbiguous(
      "Un tour agent était engagé sans contexte d'opération persisté : `state.json` a été écrit " +
        "par un schéma antérieur, incapable de le stocker. L'absence de contexte n'autorise donc " +
        "aucune conclusion — CCR ne dispose d'aucune information permettant de savoir si le tour a été traité.",
    );
    return done();
  } else if (state.state === 'RUNNING') {
    // Invariant d'ordre : `WAITING_AGENT` est écrit avant tout lancement de
    // processus agent. Un `RUNNING` persisté sans opération en vol démontre
    // donc qu'aucun agent n'a été appelé.
    //
    // Deux effets durables peuvent néanmoins précéder ce point : une
    // initialisation incomplète, et un round ouvert dont la réponse est déjà
    // journalisée. Restaurer aveuglément `READY` raconterait alors une
    // histoire fausse.
    const manifest = await readManifest(loaded.paths);
    const missingSessions = AGENTS.filter((agent) => manifest.agents[agent].session_id === null);
    const target: RunState = missingSessions.length > 0 ? 'FAILED_INITIALIZATION' : 'READY';

    if (target === 'READY') {
      const closed = new Set(
        history
          .filter((event) => event.type === 'round_completed')
          .map((event) => String(event.details?.['source_event_id'] ?? '')),
      );
      const openRound = [...history]
        .reverse()
        .find(
          (event) =>
            event.type === 'round_started' &&
            !closed.has(String(event.details?.['source_event_id'] ?? '')),
        );

      if (openRound !== undefined) {
        const startedIndex = history.indexOf(openRound);
        const response = history
          .slice(startedIndex + 1)
          .find((event) => event.type === 'assistant_response');

        if (response !== undefined) {
          // Le tour a bien eu lieu et sa réponse est durablement journalisée :
          // seule la clôture du round manque.
          await events.append({
            round: openRound.round,
            actor: 'system',
            type: 'round_completed',
            target: openRound.target ?? null,
            based_on: [String(openRound.details?.['source_event_id'] ?? ''), response.event_id],
            details: {
              source_event_id: openRound.details?.['source_event_id'] ?? null,
              target_agent: openRound.details?.['target_agent'] ?? null,
              target_session_id: response.session_id ?? null,
              recovered: true,
            },
            timestamp: deps.now().toISOString(),
          });
          actions.push(`Round ${String(openRound.round)} clôturé à partir du journal.`);
        } else {
          actions.push(
            `Round ${String(openRound.round)} ouvert sans réponse journalisée : laissé incomplet, ` +
              'aucun tour ne lui est attribué.',
          );
        }
      }
    } else {
      actions.push(
        `Sessions natives manquantes (${missingSessions.join(', ')}) : le run n'était pas initialisé.`,
      );
    }

    const event = await events.append({
      round: state.round,
      actor: 'system',
      type: 'state_changed',
      details: {
        reason: 'RECOVERY_RUNNING_WITHOUT_PENDING_OPERATION',
        detail:
          "Aucun contexte d'opération persisté : WAITING_AGENT aurait été écrit avant tout appel agent.",
        missing_sessions: missingSessions,
        from: 'RUNNING',
        to: target,
      },
      timestamp: deps.now().toISOString(),
    });
    state = await persistStateUpdate(
      loaded.paths,
      state,
      { state: target, control: 'AUTOMATION', activeAgent: null, lastEventId: event.event_id },
      deps.now(),
    );
    actions.push(`Aucun appel agent n'avait été engagé : run restauré en ${target} / AUTOMATION.`);
  }

  // Initialisation partielle : ne recrée jamais une session déjà valide.
  if (state.state === 'FAILED_INITIALIZATION') {
    const manifest = await readManifest(loaded.paths);
    const missing = AGENTS.filter((agent) => manifest.agents[agent].session_id === null);

    if (missing.length === 0) {
      const event = await events.append({
        round: state.round,
        actor: 'system',
        type: 'state_changed',
        details: { reason: 'RECOVERY_INITIALIZATION_COMPLETE', from: state.state, to: 'READY' },
        timestamp: deps.now().toISOString(),
      });
      state = await persistStateUpdate(
        loaded.paths,
        state,
        { state: 'READY', control: 'AUTOMATION', lastEventId: event.event_id },
        deps.now(),
      );
      actions.push('Les deux sessions natives existent : run restauré en READY / AUTOMATION.');
      return done();
    }

    // Finaliser une réponse déjà journalisée est un geste **local**, et la
    // capacité que l'humain a vue le dit : `FINALIZE_WITHOUT_AGENT_CALL`,
    // `long_running` faux, sans confirmation. Enchaîner ici sur la création
    // d'une session manquante joindrait un fournisseur au nom d'une action
    // annoncée sans agent — une seconde intention que personne n'a formée.
    //
    // La tentative reste possible : elle porte un autre nom, elle est
    // confirmée, et elle passe par la garde des opérations longues.
    if (finalizedJournaledResponse) {
      actions.push(
        `Session${missing.length > 1 ? 's' : ''} ${missing.join(', ')} toujours manquante${missing.length > 1 ? 's' : ''} : ` +
          'la finalisation est locale et ne rappelle aucun agent. Relancez `ccr recover` pour ' +
          "créer la session manquante — c'est une nouvelle tentative, et elle se demande.",
      );
      return done();
    }

    const initialPrompt = history.find(
      (event) => event.type === 'prompt_sent' && event.round === 0 && typeof event.content === 'string',
    )?.content;
    if (typeof initialPrompt !== 'string') {
      throw new CcrError(
        'NO_TRANSFERABLE_SOURCE',
        `Le run ${runId} ne conserve aucun contexte initial : impossible de créer la session manquante sans inventer un prompt.`,
        { details: { runId, missing } },
      );
    }

    const adapters = deps.createAdapters(manifest.workspace.cwd, runtimeSettingsOf(manifest));
    const ctx: OperationContext = { paths: loaded.paths, events, deps, manifest, state };

    for (const agent of missing) {
      // Politique de quota (V2.2-IMP-08), juste-à-temps pour **cet** agent : le
      // compte vient du journal réel, et une reprise précédente a donc déjà
      // consommé son unité. Le refus précède la transition, si bien que le run
      // reste `FAILED_INITIALIZATION` et l'agent reste sans session.
      try {
        await assertInvocationQuotaAvailable(loaded.paths, runId);
      } catch (refusal) {
        // Un `RUNNING` résiduel proviendrait d'un slot précédent déjà repris :
        // aucun tour n'étant engagé pour celui-ci, le run redevient ce qu'il
        // était — récupérable, et annoncé comme tel.
        if (ctx.state.state === 'RUNNING') {
          state = await persistStateUpdate(
            loaded.paths,
            ctx.state,
            { state: 'FAILED_INITIALIZATION', control: 'AUTOMATION', activeAgent: null },
            deps.now(),
          );
        } else {
          state = ctx.state;
        }
        failure = { agent, error: refusal };
        actions.push(
          `Reprise de la session ${agent} refusée par la politique d'invocations du run : ` +
            "aucun agent n'a été sollicité.",
        );
        return done();
      }

      actions.push(`Création de la session ${agent} manquante (la session partenaire n'est pas recréée).`);
      let outcome: DispatchOutcome;
      try {
        ctx.state = await persistStateUpdate(loaded.paths, ctx.state, { state: 'RUNNING' }, deps.now());
        outcome = await dispatchTurn(ctx, {
          agent,
          adapter: adapters[agent],
          prompt: initialPrompt,
          sessionId: null,
          promptActor: 'human',
          promptEventType: 'prompt_sent',
          successState: 'RUNNING',
          failureState: 'FAILED_INITIALIZATION',
          operationKind: 'initialization',
          recoveryReturnState: 'FAILED_INITIALIZATION',
          recoveryReturnControl: 'AUTOMATION',
          // Une reprise est une **nouvelle tentative** : prompt frais, session
          // à créer, aucun round et aucune source. Elle ne se rattache jamais
          // à l'engagement d'une tentative antérieure.
          governance: { ...governance, trigger: 'RECOVERY_CONTINUE' },
        });
      } catch (error) {
        state = await readState(loaded.paths);
        // Un `RUNNING` encore présent démontre qu'aucun tour n'a été engagé :
        // `dispatchTurn` quitte toujours cet état dès qu'il atteint l'agent,
        // succès comme échec. La tentative a donc échoué **avant** le
        // fournisseur — un engagement de gouvernance impossible, par exemple.
        // Le run redevient alors exactement ce qu'il était : récupérable, et
        // annoncé comme tel.
        if (state.state === 'RUNNING') {
          state = await persistStateUpdate(
            loaded.paths,
            state,
            { state: 'FAILED_INITIALIZATION', control: 'AUTOMATION', activeAgent: null },
            deps.now(),
          );
        }
        actions.push(
          `Échec de création de la session ${agent} : ${error instanceof Error ? error.message : String(error)}.`,
        );
        actions.push(`Le run reste ${state.state} ; les sessions déjà valides sont conservées.`);
        return done();
      }

      ctx.manifest = await setAgentSessionId(loaded.paths, ctx.manifest, agent, outcome.turn.sessionId);
      const sessionEvent = await events.append({
        round: ctx.state.round,
        actor: 'system',
        type: 'session_created',
        target: agent,
        session_id: outcome.turn.sessionId,
        timestamp: deps.now().toISOString(),
      });
      ctx.state = await persistStateUpdate(
        loaded.paths,
        ctx.state,
        { lastEventId: sessionEvent.event_id },
        deps.now(),
      );
      usageGovernanceWarnings.push(...outcome.usageGovernanceWarnings);
      sessionsCreated.push(agent);
    }

    state = await persistStateUpdate(
      loaded.paths,
      ctx.state,
      { state: 'READY', control: 'AUTOMATION' },
      deps.now(),
    );
    actions.push('Initialisation complétée : run restauré en READY / AUTOMATION.');
  }

  if (actions.length === 0) {
    actions.push(`Aucune reprise nécessaire : run en ${state.state} / ${state.control}.`);
  }
  return done();
}

// --------------------------------------------------------------------------
// list_runs / run_status
// --------------------------------------------------------------------------

// L'énumération des runs a quitté ce module : elle doit lire les **deux**
// générations, et un service historique ne connaît pas les formats natifs.
// Elle vit désormais avec la résolution générationnelle, dans
// `cli/native-dispatch.ts`, qui répond déjà à « de quel run parle-t-on, et de
// quelle génération ». Le lecteur historique employé ici refusait un manifest
// schema 2 et rapportait « (illisible) » un run parfaitement sain.

export interface RunStatus {
  readonly manifest: RunManifest;
  readonly state: RunStateDocument;
  readonly requiresRecovery: boolean;
  readonly lastEvent: CcrEvent | undefined;
  readonly eventCount: number;
  /** Verrou présent, le cas échéant. `status` ne le prend jamais. */
  readonly lock: RunLockInfo | undefined;
  readonly lockLiveness: LockLiveness | undefined;
  /** Politique d'invocations et sa consommation (`V2.2-IMP-09`). */
  readonly invocationQuota: InvocationQuotaView;
  /** Usage observé, par invocation (`V2.2-IMP-10`). */
  readonly usage: UsageReadModel;
  /** Estimations de coût, par invocation (`V2.2-IMP-12`). */
  readonly costEstimate: CostEstimateReadModel;
}

/**
 * Consultation pure : ne prend aucun verrou et n'écrit rien.
 *
 * `status` doit rester lisible pendant qu'une autre commande détient le run.
 */
export async function getRunStatus(deps: RunServiceDeps, runId?: string): Promise<RunStatus> {
  const resolved = await resolveRunId(deps, runId);
  const loaded = await loadRun(deps.runsDir, resolved);
  const events = await (await openEventStore(loaded.paths, resolved)).readAll();
  const lock = await readRunLock(loaded.paths).catch(() => undefined);

  return {
    manifest: loaded.manifest,
    state: loaded.state,
    requiresRecovery: loaded.requiresRecovery,
    lastEvent: events.at(-1),
    eventCount: events.length,
    lock,
    lockLiveness: lock === undefined ? undefined : assessLiveness(lock),
    invocationQuota: await readInvocationQuotaView(loaded.paths),
    usage: await readUsageReadModel(loaded.paths),
    costEstimate: await readCostEstimateReadModel(loaded.paths),
  };
}

/**
 * Détermine le run visé.
 *
 * Sans identifiant explicite : le `run_id` le plus élevé n'étant pas `CLOSED`.
 * Les identifiants étant `CCR-YYYYMMDD-NNN`, l'ordre lexicographique est
 * l'ordre chronologique de création — la résolution est donc déterministe.
 */
export async function resolveRunId(deps: RunServiceDeps, explicit?: string): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const runIds = [...(await listRunIds(deps.runsDir))].reverse();
  for (const runId of runIds) {
    try {
      const state = await readState(runPaths(deps.runsDir, runId));
      if (state.state !== 'CLOSED') return runId;
    } catch {
      // Run illisible : il ne peut pas être le run actif implicite.
    }
  }

  throw new CcrError('NO_ACTIVE_RUN', "Aucun run actif. Précisez un identifiant ou lancez `ccr start`.", {
    details: { runsDir: deps.runsDir, candidates: runIds.length },
  });
}
