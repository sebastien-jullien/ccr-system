/**
 * Read model du cockpit (CCR V2 V0.2 §12 ; amendement V2-IMP-33).
 *
 * Couche **métier** de lecture. Aucune connaissance de HTTP, du navigateur, ni
 * d'un quelconque transport : le Slice 2 s'en servira, le Slice 1 s'arrête
 * ici.
 *
 * ## Ce qu'elle n'est pas
 *
 * Elle ne reconstruit **rien**. Snapshot, révision, capacités, vivacité,
 * évidence de verrou et plan de transfert viennent tous des primitives
 * validées au Slice 0. Le frontend ne reconstruira donc jamais la machine
 * d'état, les capacités, la recovery ni la précédence canonique — il n'aura
 * pas à le faire, et n'en aura pas les moyens.
 *
 * ## Coûts, dits honnêtement
 *
 * ```text
 * listRuns()        O(nombre de runs) · manifest + state UNIQUEMENT
 *                   n'ouvre jamais events.jsonl, decisions.jsonl ni rounds/
 * getRunView()      O(taille des journaux) · snapshot stable + révision
 * getTimeline()     O(taille des journaux) · projection, non incrémentale
 * getRecoveryView() O(taille des journaux) · même snapshot
 * ```
 *
 * La pagination de la timeline découpe une lecture complète : elle ne rend pas
 * la lecture sous-jacente incrémentale, et ce module ne prétend pas le
 * contraire.
 */

import { CcrError } from '../core/errors.ts';
import type { AgentKind, CcrDecision, CcrEvent, PendingOperation, RunManifest } from '../core/run.ts';
import type { ExpertSlotId } from '../store/run-directory.ts';
import type { ControlOwner, RunState } from '../core/state.ts';
import { classifyRunLiveness, needsHumanAttention } from '../core/run-liveness.ts';
import type { LivenessBasis, RunExecutionEvidence, RunLiveness } from '../core/run-liveness.ts';
import { handoffGuard } from '../core/run-guards.ts';
import { observeRunExecution } from '../lock/run-execution-evidence.ts';
import { pendingResponseJournaled, planRecovery } from './recovery-planner.ts';
import { readInvocationQuotaView } from './invocation-quota-read.ts';
import { readUsageReadModel } from './usage-read-model.ts';
import { readCostEstimateReadModel } from './cost-estimate-read-model.ts';
import type { CostEstimateReadModel } from './cost-estimate-read-model.ts';
import type { UsageReadModel } from './usage-read-model.ts';
import type { InvocationQuotaView } from './invocation-quota-read.ts';
import type { RecoveryCapabilityId } from './recovery-planner.ts';
import type { RunExecutionObservation, RunLockObservation } from '../lock/run-execution-evidence.ts';
import type { HostOperationRegistry } from '../lock/host-operation-registry.ts';
import { listRunIds, runPaths } from '../store/layout.ts';
import { listRunDirectory } from '../store/run-directory.ts';
import type { RunExecutionMode } from '../store/run-directory.ts';
import { readManifest, readState } from '../store/state-store.ts';
import { readStableRunSnapshot } from '../store/run-snapshot.ts';
import type { RunSnapshot } from '../store/run-snapshot.ts';
import { deriveRunCapabilities } from './run-capabilities.ts';
import type { RunCapabilities } from './run-capabilities.ts';
import type { RunExecutionSettings } from './run-execution-settings.ts';
import { isCcrError } from '../core/errors.ts';

// --------------------------------------------------------------------------
// Dépendances
// --------------------------------------------------------------------------

export interface CockpitReadModelDeps {
  readonly runsDir: string;
  /**
   * Réglages d'exécution **partagés avec le `RunService`**.
   *
   * Reçus, jamais résolus ici : c'est ce qui interdit structurellement que la
   * capacité `STEP` et le service qui l'exécutera divergent (limite L1).
   */
  readonly settings: RunExecutionSettings;
  /**
   * Registre d'un hôte long-lived. Absent au Slice 1 : la classification reste
   * alors prudente et peut valoir `UNDETERMINED`. Son instance appartient au
   * Slice 2.
   */
  readonly hostRegistry?: HostOperationRegistry;
}

// --------------------------------------------------------------------------
// Liste — faible coût
// --------------------------------------------------------------------------

/** Motif d'attention, dérivé de `state.json` seul (V0.2 §9.4). */
export type RunAttention = 'NONE' | 'HUMAN_INPUT' | 'RECOVERY' | 'INITIALIZATION' | 'FAILED';

/** Code fermé décrivant pourquoi un run n'est pas lisible. */
export type UnreadableReason = 'MANIFEST_INVALID' | 'STATE_INVALID' | 'RUN_NOT_FOUND' | 'UNREADABLE';

export interface CockpitRunSummary {
  readonly run_id: string;
  /**
   * Generation d'execution du run (V2.1-IMP-17B).
   *
   * `null` lorsque le run est illisible. C'est le discriminant qui permet a une
   * surface de lire les deux champs d'identite active sans les confondre.
   */
  readonly generation: RunExecutionMode | null;
  readonly title: string | null;
  readonly state: RunState | null;
  readonly control: ControlOwner | null;
  readonly round: number | null;
  /** Historique uniquement. Toujours `null` sur un run natif. */
  readonly active_agent: AgentKind | null;
  /**
   * Natif uniquement. Toujours `null` sur un run historique.
   *
   * Jamais traduit en `claude|codex` : deux experts peuvent partager le meme
   * moteur, et un slot n'est pas un fournisseur.
   */
  readonly active_expert_slot: ExpertSlotId | null;
  readonly created_at: string | null;
  /**
   * Horodatage **bon marché** issu de `state.json`.
   *
   * Ce n'est pas l'activité canonique : une mutation de runtime écrit un
   * événement sans toucher l'état. L'activité exacte appartient au `RunView`,
   * qui lit les journaux — la liste ne les ouvre jamais pour « être plus
   * juste ».
   */
  readonly updated_at: string | null;
  readonly runtime_pinned: boolean | null;
  readonly attention: RunAttention | null;
  readonly unreadable: boolean;
  readonly unreadable_reason?: UnreadableReason;
}

/**
 * Attention dérivable de l'**état canonique seul**, sans ouvrir un journal ni
 * observer un verrou.
 *
 * Règle normative (arbitrage pré-Slice 2) : la liste ne signale que ce qu'elle
 * peut démontrer sans read model complet. `RECOVERY` n'est donc autorisé que
 * pour un état qui **matérialise déjà** la situation — `RECOVERY_REQUIRED`.
 *
 * En particulier, `WAITING_AGENT` et une opération en vol persistée décrivent
 * aussi bien un tour parfaitement normal qu'une opération abandonnée : les
 * distinguer exige une évidence runtime que la liste n'a pas. Les qualifier
 * `RECOVERY` réintroduirait `CLX2-A1` par la porte de la liste.
 *
 * La signature interdit structurellement l'erreur : `pending_operation` n'est
 * pas un paramètre, et ne peut donc pas influencer le résultat.
 */
function attentionOf(state: RunState, control: ControlOwner): RunAttention {
  if (state === 'FAILED') return 'FAILED';
  if (state === 'FAILED_INITIALIZATION') return 'INITIALIZATION';
  if (state === 'RECOVERY_REQUIRED') return 'RECOVERY';
  if (state === 'WAITING_HUMAN' || (control === 'HUMAN' && state === 'PAUSED')) return 'HUMAN_INPUT';
  return 'NONE';
}

function unreadableReasonOf(code: string | undefined): UnreadableReason {
  if (code === 'MANIFEST_INVALID' || code === 'STATE_INVALID' || code === 'RUN_NOT_FOUND') return code;
  return 'UNREADABLE';
}

export async function listCockpitRuns(
  deps: CockpitReadModelDeps,
): Promise<readonly CockpitRunSummary[]> {
  // Enumeration bi-generation (V2.1-IMP-17B) : les scalaires viennent d'une
  // primitive neutre, et ce module n'apprend a lire aucun document natif.
  // Un run natif sain cessait ici d'etre lisible, faute de parseur.
  return (await listRunDirectory(deps.runsDir)).map((entry): CockpitRunSummary => {
    if (entry.generation === null) {
      return {
        run_id: entry.runId,
        generation: null,
        title: null,
        state: null,
        control: null,
        round: null,
        active_agent: null,
        active_expert_slot: null,
        created_at: null,
        updated_at: null,
        runtime_pinned: null,
        attention: null,
        unreadable: true,
        unreadable_reason: unreadableReasonOf(entry.error),
      };
    }
    return {
      run_id: entry.runId,
      generation: entry.generation,
      title: entry.title,
      state: entry.state,
      control: entry.control,
      round: entry.round,
      active_agent: entry.activeAgent,
      active_expert_slot: entry.activeExpertSlot,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      runtime_pinned: entry.runtimePinned,
      attention:
        entry.state === null || entry.control === null ? null : attentionOf(entry.state, entry.control),
      unreadable: false,
    };
  });
}

// --------------------------------------------------------------------------
// Vue d'un run
// --------------------------------------------------------------------------

export interface HandoffAdvice {
  readonly available: boolean;
  readonly reason?: string;
  readonly agents: readonly {
    readonly agent: AgentKind;
    readonly session_id: string;
    readonly command: string;
  }[];
}

export interface RunLivenessView {
  readonly liveness: RunLiveness;
  readonly basis: LivenessBasis;
  readonly needs_human_attention: boolean;
  readonly lock_observation: RunLockObservation;
  readonly pending_operation: PendingOperation | null;
}

export interface RunView {
  readonly revision: string;
  readonly identity: {
    readonly run_id: string;
    readonly title: string;
    readonly created_at: string;
    readonly workspace_cwd: string;
  };
  readonly sessions: Readonly<Record<AgentKind, string | null>>;
  readonly runtime: RunManifest['runtime_config'] | null;
  readonly runtime_pinned: boolean;
  readonly state: {
    readonly state: RunState;
    readonly control: ControlOwner;
    readonly round: number;
    readonly active_agent: AgentKind | null;
    readonly updated_at: string;
  };
  /** Maximum des horodatages canoniques réellement présents. */
  readonly last_activity_at: string;
  readonly liveness: RunLivenessView;
  readonly capabilities: RunCapabilities;
  /**
   * Politique d'invocations et sa consommation (`V2.2-IMP-09`).
   *
   * Gouvernance, jamais capacite : elle n'ajoute ni ne retire aucune action.
   */
  readonly invocation_quota: InvocationQuotaView;
  /**
   * Usage observé, par invocation (`V2.2-IMP-10`).
   *
   * Observation, jamais capacité ni politique : elle n'ajoute aucune action et
   * ne décide d'aucun refus.
   */
  readonly usage: UsageReadModel;
  /**
   * Estimations de coût, par invocation (`V2.2-IMP-12`).
   *
   * Projection dérivée, jamais une facture : elle vit à côté de l'usage et de
   * la politique, et ne se confond avec aucun des deux.
   */
  readonly cost_estimate: CostEstimateReadModel;
  readonly handoff_cli: HandoffAdvice;
  readonly counts: { readonly events: number; readonly decisions: number };
}

/**
 * Activité canonique.
 *
 * Maximum des horodatages présents dans les **quatre** sources canoniques.
 * `rounds/`, verrous, registre et `mtime` en sont exclus par construction.
 */
export function lastActivityOf(snapshot: RunSnapshot): string {
  const candidates = [
    snapshot.manifest.created_at,
    snapshot.state.updated_at,
    ...snapshot.events.map((event) => event.timestamp),
    ...snapshot.decisions.map((decision) => decision.timestamp),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return candidates.reduce((best, value) => (Date.parse(value) > Date.parse(best) ? value : best));
}

function handoffAdviceOf(snapshot: RunSnapshot, requiresRecovery: boolean): HandoffAdvice {
  const sessions: { agent: AgentKind; session_id: string }[] = [];
  for (const agent of ['claude', 'codex'] as const) {
    const sessionId = snapshot.manifest.agents[agent].session_id;
    if (sessionId !== null) sessions.push({ agent, session_id: sessionId });
  }

  // Mêmes préconditions que la primitive V1 : aucune table réécrite.
  const verdict = handoffGuard(
    {
      state: snapshot.state.state,
      control: snapshot.state.control,
      requiresRecovery,
    },
    sessions.length > 0,
  );

  return {
    available: verdict.kind === 'ALLOWED',
    ...(verdict.kind === 'REFUSED' ? { reason: verdict.reason } : {}),
    agents: sessions.map((entry) => ({
      ...entry,
      command: `ccr handoff ${entry.agent} --run ${snapshot.runId}`,
    })),
  };
}

/** Prédicat historique du state store, reproduit sans être réinterprété. */
function requiresRecoveryOf(snapshot: RunSnapshot): boolean {
  return snapshot.state.state === 'WAITING_AGENT' || snapshot.state.pending_operation !== null;
}

/** Une réponse est-elle déjà journalisée pour l'opération en vol ? */
async function evidenceOf(
  deps: CockpitReadModelDeps,
  snapshot: RunSnapshot,
): Promise<RunExecutionObservation> {
  return observeRunExecution(snapshot.paths, {
    ...(deps.hostRegistry === undefined ? {} : { registry: deps.hostRegistry }),
    pendingOperation: snapshot.state.pending_operation,
  });
}

/**
 * Compose la vue d'un run.
 *
 * `SNAPSHOT_UNSTABLE` remonte tel quel : une vue temporairement instable n'est
 * ni masquée, ni transformée en run corrompu, ni contournée par une reprise
 * supplémentaire — `readStableRunSnapshot` a déjà son budget.
 */
export async function getRunView(deps: CockpitReadModelDeps, runId: string): Promise<RunView> {
  const snapshot = await readStableRunSnapshot(deps.runsDir, runId);
  const { evidence, observation } = await evidenceOf(deps, snapshot);

  const liveness = classifyRunLiveness(
    {
      manifest: snapshot.manifest,
      state: snapshot.state,
      pendingResponseJournaled: pendingResponseJournaled(snapshot),
    },
    evidence,
  );

  const requiresRecovery = requiresRecoveryOf(snapshot);
  const capabilities = deriveRunCapabilities(
    {
      manifest: snapshot.manifest,
      state: snapshot.state,
      events: snapshot.events,
      decisions: snapshot.decisions,
      requiresRecovery,
      // Valeur partagée avec le service : c'est tout l'objet de L1.
      maxTransferBytes: deps.settings.maxTransferBytes,
    },
    liveness.liveness,
  );

  return {
    // Exactement la révision du snapshot 0C. Aucune seconde révision.
    revision: snapshot.revision,
    identity: {
      run_id: snapshot.runId,
      title: snapshot.manifest.title,
      created_at: snapshot.manifest.created_at,
      workspace_cwd: snapshot.manifest.workspace.cwd,
    },
    sessions: {
      claude: snapshot.manifest.agents.claude.session_id,
      codex: snapshot.manifest.agents.codex.session_id,
    },
    runtime: snapshot.manifest.runtime_config ?? null,
    runtime_pinned: snapshot.manifest.runtime_config !== undefined,
    state: {
      state: snapshot.state.state,
      control: snapshot.state.control,
      round: snapshot.state.round,
      active_agent: snapshot.state.active_agent,
      updated_at: snapshot.state.updated_at,
    },
    last_activity_at: lastActivityOf(snapshot),
    liveness: {
      liveness: liveness.liveness,
      basis: liveness.basis,
      needs_human_attention: needsHumanAttention(liveness.liveness),
      lock_observation: observation,
      pending_operation: liveness.pendingOperation,
    },
    capabilities,
    invocation_quota: await readInvocationQuotaView(runPaths(deps.runsDir, runId)),
    usage: await readUsageReadModel(runPaths(deps.runsDir, runId)),
    cost_estimate: await readCostEstimateReadModel(runPaths(deps.runsDir, runId)),
    handoff_cli: handoffAdviceOf(snapshot, requiresRecovery),
    counts: { events: snapshot.events.length, decisions: snapshot.decisions.length },
  };
}

// --------------------------------------------------------------------------
// Timeline
// --------------------------------------------------------------------------

export interface TimelineEventEntry {
  readonly kind: 'event';
  readonly event_id: string;
  readonly round: number;
  readonly timestamp: string;
  readonly actor: CcrEvent['actor'];
  readonly type: CcrEvent['type'];
  readonly target: AgentKind | null;
  readonly session_id: string | null;
  readonly content: string | null;
  readonly based_on: readonly string[];
  readonly details: Readonly<Record<string, unknown>> | null;
}

export interface TimelineDecisionEntry {
  readonly kind: 'decision';
  readonly decision_id: string;
  readonly round: number;
  readonly timestamp: string;
  readonly author: CcrDecision['author'];
  readonly status: CcrDecision['status'];
  readonly content: string;
  /** Événement `decision_recorded` correspondant, lorsqu'il existe. */
  readonly event_id: string | null;
  /**
   * Décision canonique sans événement associé.
   *
   * Se produit lorsqu'un arrêt survient entre l'écriture de `decisions.jsonl`
   * et celle de `events.jsonl` : la décision est canonique et ne doit jamais
   * être supprimée, mais la chronologie ne la porte pas.
   */
  readonly orphan_decision: boolean;
}

export type TimelineEntry = TimelineEventEntry | TimelineDecisionEntry;

export interface TimelinePage {
  /** Révision de la vue à laquelle cette page appartient. */
  readonly revision: string;
  readonly entries: readonly TimelineEntry[];
  readonly cursor_next: string | null;
  readonly truncated: boolean;
  readonly total: number;
}

export const DEFAULT_TIMELINE_PAGE_SIZE = 200;

/**
 * Projette événements et décisions en une chronologie unique.
 *
 * **Aucune fusion heuristique.** Le lien décision ↔ événement est structurel :
 * l'événement `decision_recorded` porte `details.decision_id`. Aucune
 * comparaison de texte, d'horodatage ou d'auteur n'est employée.
 *
 * Une décision liée absorbe son événement — elle apparaît **une fois**, en
 * conservant la référence à l'événement canonique. Une décision orpheline est
 * exposée telle quelle.
 */
export function projectTimeline(
  events: readonly CcrEvent[],
  decisions: readonly CcrDecision[],
): readonly TimelineEntry[] {
  const decisionEventByDecisionId = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'decision_recorded') continue;
    const decisionId = event.details?.['decision_id'];
    if (typeof decisionId === 'string' && decisionId.length > 0) {
      decisionEventByDecisionId.set(decisionId, event.event_id);
    }
  }
  const absorbed = new Set(decisionEventByDecisionId.values());

  const entries: TimelineEntry[] = [];

  for (const event of events) {
    // L'événement d'une décision liée est représenté par l'entrée décision.
    if (absorbed.has(event.event_id)) continue;
    entries.push({
      kind: 'event',
      event_id: event.event_id,
      round: event.round,
      timestamp: event.timestamp,
      actor: event.actor,
      type: event.type,
      target: event.target ?? null,
      session_id: event.session_id ?? null,
      content: event.content ?? null,
      based_on: event.based_on ?? [],
      details: event.details ?? null,
    });
  }

  for (const decision of decisions) {
    const eventId = decisionEventByDecisionId.get(decision.decision_id) ?? null;
    entries.push({
      kind: 'decision',
      decision_id: decision.decision_id,
      round: decision.round,
      timestamp: decision.timestamp,
      author: decision.author,
      status: decision.status,
      content: decision.content,
      event_id: eventId,
      orphan_decision: eventId === null,
    });
  }

  return sortTimeline(entries);
}

/**
 * Ordre total déterministe.
 *
 * ```text
 * 1. horodatage canonique croissant
 * 2. à égalité : les événements avant les décisions
 * 3. à égalité : identifiant canonique croissant (evt_NNNNNN / DEC-NNNN)
 * ```
 *
 * Aucune dépendance à l'ordre des accès disque, au `mtime`, ni à la stabilité
 * de `Array.sort`.
 */
function sortTimeline(entries: readonly TimelineEntry[]): readonly TimelineEntry[] {
  const idOf = (entry: TimelineEntry): string =>
    entry.kind === 'event' ? entry.event_id : entry.decision_id;
  const rankOf = (entry: TimelineEntry): number => (entry.kind === 'event' ? 0 : 1);

  return [...entries].sort((a, b) => {
    const at = Date.parse(a.timestamp);
    const bt = Date.parse(b.timestamp);
    if (at !== bt) return at - bt;
    if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
    return idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0;
  });
}

interface CursorPayload {
  readonly r: string;
  readonly o: number;
}

/** Curseur opaque, lié à la révision de la vue. */
export function encodeTimelineCursor(revision: string, offset: number): string {
  return Buffer.from(JSON.stringify({ r: revision, o: offset } satisfies CursorPayload), 'utf8').toString(
    'base64url',
  );
}

export function decodeTimelineCursor(cursor: string): CursorPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CcrError('INVALID_ARGUMENT', 'Curseur de timeline illisible.');
  }
  if (payload === null || typeof payload !== 'object') {
    throw new CcrError('INVALID_ARGUMENT', 'Curseur de timeline invalide.');
  }
  const record = payload as Record<string, unknown>;
  const revision = record['r'];
  const offset = record['o'];
  if (typeof revision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(revision)) {
    throw new CcrError('INVALID_ARGUMENT', 'Curseur de timeline invalide.');
  }
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new CcrError('INVALID_ARGUMENT', 'Curseur de timeline invalide.');
  }
  return { r: revision, o: offset };
}

export interface TimelineOptions {
  readonly cursor?: string;
  readonly pageSize?: number;
}

/**
 * Rend une page de timeline.
 *
 * La pagination découpe une lecture complète : elle ne rend pas la lecture
 * sous-jacente incrémentale. Une page appartient à une **révision** ; si celle
 * du run a changé depuis l'émission du curseur, la suite est refusée plutôt
 * que fusionnée silencieusement avec une vue différente.
 */
export async function getTimeline(
  deps: CockpitReadModelDeps,
  runId: string,
  options: TimelineOptions = {},
): Promise<TimelinePage> {
  const snapshot = await readStableRunSnapshot(deps.runsDir, runId);
  const pageSize = options.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new CcrError('INVALID_ARGUMENT', 'Taille de page invalide.');
  }

  let offset = 0;
  if (options.cursor !== undefined) {
    const decoded = decodeTimelineCursor(options.cursor);
    if (decoded.r !== snapshot.revision) {
      throw new CcrError(
        'STALE_REVISION',
        "La timeline a changé depuis l'émission de ce curseur. Rechargez la vue : " +
          'CCR ne fusionne pas deux pages issues de vues différentes.',
        { details: { expected: decoded.r, actual: snapshot.revision, at: 'timeline' } },
      );
    }
    offset = decoded.o;
  }

  const all = projectTimeline(snapshot.events, snapshot.decisions);
  const entries = all.slice(offset, offset + pageSize);
  const nextOffset = offset + entries.length;
  const truncated = nextOffset < all.length;

  return {
    revision: snapshot.revision,
    entries,
    cursor_next: truncated ? encodeTimelineCursor(snapshot.revision, nextOffset) : null,
    truncated,
    total: all.length,
  };
}

// --------------------------------------------------------------------------
// Vue de récupération
// --------------------------------------------------------------------------

/**
 * Intentions de récupération **réellement sélectionnables**.
 *
 * `recoverRun` possède un unique point d'entrée, dont le seul paramètre
 * discriminant est `acknowledge`. Un appelant peut donc choisir entre deux
 * invocations, et deux seulement. Les identifiants ci-dessous nomment l'effet
 * exact que cette invocation produira **dans l'état observé** — jamais une
 * action générique.
 */
export { RECOVERY_CAPABILITY_IDS } from './recovery-planner.ts';
export type { RecoveryCapabilityId } from './recovery-planner.ts';

export interface RecoveryCapability {
  readonly id: RecoveryCapabilityId;
  readonly allowed: boolean;
  readonly reason_code?: string;
  readonly requires_confirmation: boolean;
  readonly requires_acknowledgement_text: boolean;
  readonly destructive: boolean;
  /** Effet en code stable, jamais un texte d'interface. */
  readonly effect: string;
  /**
   * Invocation exacte que l'appelant devra produire.
   *
   * Deux primitives, et deux seulement : la reprise canonique V1, et la levée
   * de verrou — qui n'est pas une reprise et ne touche aucun fait canonique.
   * `observed_lock_token` n'apparaît que pour la seconde, et seulement quand
   * la levée est sûre à cet instant.
   */
  readonly invocation:
    | { readonly primitive: 'recoverRun'; readonly acknowledge: 'REQUIRED' | 'FORBIDDEN' }
    | { readonly primitive: 'clearStaleRunLock'; readonly observed_lock_token: string };
  /** Vrai lorsque l'effet lance un processus fournisseur. */
  readonly long_running: boolean;
}

/** Intention décrite par la V0.2 mais non sélectionnable avec les primitives V1. */
export interface MissingRecoveryPrimitive {
  readonly id: string;
  readonly reason: 'NOT_SELECTABLE_IN_V1';
  readonly note: string;
}

export interface RecoveryView {
  readonly revision: string;
  readonly liveness: RunLivenessView;
  readonly known_facts: {
    readonly state: RunState;
    readonly control: ControlOwner;
    readonly runtime_pinned: boolean;
    readonly pending_response_journaled: boolean;
    readonly lock_observation: RunLockObservation;
    /** Référence opaque du verrou observé, suffisante à une future précondition. */
    readonly lock_reference: string | null;
  };
  readonly ambiguity: { readonly reason: string; readonly since: string | null } | null;
  readonly sessions: Readonly<Record<AgentKind, 'PRESENT' | 'ABSENT'>>;
  readonly capabilities: readonly RecoveryCapability[];
  readonly missing_primitives: readonly MissingRecoveryPrimitive[];
  /**
   * Politique d'invocations et sa consommation (`V2.2-IMP-09`).
   *
   * Présente **à côté** des capacités, jamais à leur place : une reprise reste
   * métier-disponible alors même que la politique refusera son exécution, et
   * les deux faits se lisent simultanément.
   */
  readonly invocation_quota: InvocationQuotaView;
}

function capability(
  id: RecoveryCapabilityId,
  over: Partial<RecoveryCapability> = {},
): RecoveryCapability {
  const base: Record<RecoveryCapabilityId, Omit<RecoveryCapability, 'id' | 'allowed'>> = {
    RECOVERY_FINALIZE_JOURNALED_RESPONSE: {
      requires_confirmation: false,
      requires_acknowledgement_text: false,
      destructive: false,
      effect: 'FINALIZE_WITHOUT_AGENT_CALL',
      invocation: { primitive: 'recoverRun', acknowledge: 'FORBIDDEN' },
      long_running: false,
    },
    RECOVERY_CONTINUE_INITIALIZATION: {
      requires_confirmation: true,
      requires_acknowledgement_text: false,
      destructive: false,
      effect: 'CREATE_MISSING_NATIVE_SESSION',
      invocation: { primitive: 'recoverRun', acknowledge: 'FORBIDDEN' },
      long_running: true,
    },
    RECOVERY_MATERIALIZE_AMBIGUITY: {
      requires_confirmation: false,
      requires_acknowledgement_text: false,
      destructive: false,
      effect: 'RECORD_AMBIGUITY_WITHOUT_CONCLUSION',
      invocation: { primitive: 'recoverRun', acknowledge: 'FORBIDDEN' },
      long_running: false,
    },
    RECOVERY_ACKNOWLEDGE_AMBIGUITY: {
      requires_confirmation: true,
      requires_acknowledgement_text: true,
      destructive: false,
      effect: 'HUMAN_ACKNOWLEDGEMENT_RETURNS_TO_PAUSED',
      invocation: { primitive: 'recoverRun', acknowledge: 'REQUIRED' },
      long_running: false,
    },
    RECOVERY_CLEAR_STALE_LOCK: {
      // Seule capacité destructive du produit, et seule qui ne touche aucun
      // fait canonique : elle supprime un fichier de verrou, rien d'autre.
      requires_confirmation: true,
      requires_acknowledgement_text: false,
      destructive: true,
      effect: 'REMOVE_STALE_RUN_LOCK_WITHOUT_CANONICAL_EFFECT',
      // Remplacé à l'émission par le jeton du verrou réellement observé.
      invocation: { primitive: 'clearStaleRunLock', observed_lock_token: '' },
      long_running: false,
    },
  };
  return { id, allowed: true, ...base[id], ...over };
}

/**
 * Compose la vue de récupération.
 *
 * Aucune capacité générique : chaque identifiant décrit l'effet exact que
 * `recoverRun` produira dans l'état observé. Une seule invocation sans
 * acquittement est proposée à la fois — la primitive choisissant elle-même son
 * effet à partir de l'état, en offrir deux serait promettre un choix qui
 * n'existe pas.
 */
export async function getRecoveryView(
  deps: CockpitReadModelDeps,
  runId: string,
): Promise<RecoveryView> {
  const snapshot = await readStableRunSnapshot(deps.runsDir, runId);
  const observed = await evidenceOf(deps, snapshot);
  const journaled = pendingResponseJournaled(snapshot);

  // Un seul calcul, partagé avec le chemin de mutation : la vue ne peut pas
  // annoncer une capacité que l'effet refuserait, ni l'inverse.
  const plan = planRecovery({
    runId,
    manifest: snapshot.manifest,
    state: snapshot.state,
    pendingResponseJournaled: journaled,
    observed,
  });
  const liveness = classifyRunLiveness(
    { manifest: snapshot.manifest, state: snapshot.state, pendingResponseJournaled: journaled },
    observed.evidence,
  );
  const observation = plan.observation;

  const capabilities: RecoveryCapability[] = [];
  if (plan.canonical !== null) capabilities.push(capability(plan.canonical));

  /**
   * `RECOVERY_CLEAR_STALE_LOCK` devient annonçable — l'endpoint existe.
   *
   * Elle n'est annoncée que lorsque `plan.clearable` la porte, c'est-à-dire
   * quand la classification 0D a démontré la mort de **ce** verrou-là. Le jeton
   * émis est celui du verrou réellement observé : la vue ne promet donc jamais
   * une levée que le serveur refuserait pour cause d'identité.
   *
   * Elle reste absente de `capabilities` dans tous les autres cas — verrou
   * vivant, étranger, indéterminé ou absent — et aucune primitive ne manque
   * plus : la liste est vide, non par omission mais par complétude.
   */
  const missing: MissingRecoveryPrimitive[] = [];
  if (plan.clearable !== null) {
    capabilities.push(
      capability('RECOVERY_CLEAR_STALE_LOCK', {
        invocation: { primitive: 'clearStaleRunLock', observed_lock_token: plan.clearable.token },
      }),
    );
  }

  return {
    revision: snapshot.revision,
    liveness: {
      liveness: liveness.liveness,
      basis: liveness.basis,
      needs_human_attention: needsHumanAttention(liveness.liveness),
      lock_observation: observation,
      pending_operation: liveness.pendingOperation,
    },
    known_facts: {
      state: snapshot.state.state,
      control: snapshot.state.control,
      runtime_pinned: snapshot.manifest.runtime_config !== undefined,
      pending_response_journaled: journaled,
      lock_observation: observation,
      // Référence opaque : ni PID, ni nom d'hôte. Suffisante à la précondition
      // d'identité exacte du verrou, sans divulguer la topologie du poste.
      lock_reference: snapshot.state.pending_operation === null ? null : observation,
    },
    ambiguity:
      snapshot.state.uncertainty === null
        ? null
        : {
            reason: snapshot.state.uncertainty.reason,
            since: snapshot.state.uncertainty.since,
          },
    sessions: {
      claude: snapshot.manifest.agents.claude.session_id === null ? 'ABSENT' : 'PRESENT',
      codex: snapshot.manifest.agents.codex.session_id === null ? 'ABSENT' : 'PRESENT',
    },
    capabilities,
    missing_primitives: missing,
    invocation_quota: await readInvocationQuotaView(runPaths(deps.runsDir, runId)),
  };
}
