/**
 * Reprise de l'initialisation d'un run **natif V2.1** (Slice 1D).
 *
 * Un `session_id` absent n'a pas une cause, il en a plusieurs — et elles
 * n'appellent pas les mêmes actions :
 *
 * ```text
 * le fournisseur a répondu, CCR possède déjà l'identité   → réconcilier, 0 appel
 * la session est liée, une étape postérieure manque       → finaliser, 0 appel
 * l'échec est terminé, déterministe                       → continuation humaine
 * le processus est mort pendant l'appel                   → incertitude, 0 appel
 * les faits se contredisent                               → échec fermé
 * ```
 *
 * Tout ce module procède d'une même règle : **CCR ne rappelle jamais un
 * fournisseur pour lever une incertitude.** Un appel qui a peut-être eu lieu ne
 * devient pas « non consommé » parce qu'on l'a oublié ; seule une décision
 * humaine explicite autorise une nouvelle tentative.
 *
 * Les invariants de sécurité de la reprise V2 sont repris tels quels : verrou de
 * run exact, `FAILED`/`CLOSED` diagnostiqués sans réactivation, acquittement
 * humain obligatoire avant toute nouvelle tentative ambiguë, et aucun rejeu
 * automatique. Ce module ne les reformule pas : il les applique au modèle par
 * slot.
 */

import { CcrError } from '../core/errors.ts';
import { EXPERT_SLOT_IDS } from '../core/expert.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type {
  NativeCcrEvent,
  NativeRunManifest,
  NativeRunStateDocument,
} from '../core/run-native.ts';
import { assessLiveness, clearStaleLock, readRunLock } from '../lock/run-lock.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import type { RunLockInfo } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import type { RunPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import type { NativeEventStore } from '../store/native-event-store.ts';
import {
  bindNativeSession,
  persistNativeStateUpdate,
  readPersistedManifest,
  readPersistedState,
} from '../store/native-store.ts';
import {
  initializeNativeSlot,
  runtimeSettingsOf,
} from './native-start-service.ts';
import type {
  ManifestRef,
  NativeContext,
  NativeInitialPosition,
  NativeStartCorrelation,
} from './native-start-service.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { openUsageLedger } from '../store/usage-ledger.ts';
import type { UsageGovernanceWarning } from './usage-governance-writer.ts';
import type { RunServiceDeps } from './run-service.ts';

// --------------------------------------------------------------------------
// Faits par slot
// --------------------------------------------------------------------------

/**
 * Ce que le disque affirme d'un slot, sans interprétation.
 *
 * Les trois faits sont séparés parce que l'ordre durable de 1C les écrit dans
 * cet ordre exact — réponse, puis liaison, puis `session_created`. Leur
 * combinaison dit précisément où le processus s'est arrêté.
 */
export interface NativeSlotRecoveryFacts {
  readonly slot: ExpertSlotId;
  readonly provider: ProviderKind;
  /** Session liée dans le manifest. */
  readonly manifestSession: string | null;
  /** Session portée par la réponse **d'initialisation** durable, s'il en existe une. */
  readonly initialResponseSession: string | null;
  readonly initialResponseEventId: string | null;
  /** Session affirmée par un `session_created` durable. */
  readonly createdSession: string | null;
  /**
   * Réponses satisfaisant causalement le contrat START, et elles seules.
   *
   * Le nom dit désormais ce que le champ compte. Il comptait auparavant toute
   * `assistant_response` du slot — hypothèse vraie tant que START était le seul
   * producteur natif, fausse dès l'arrivée de SEND et de STEP (repair 1D.2).
   */
  readonly initialResponseCount: number;
}

export type NativeSlotCondition =
  | 'COMPLETE'
  | 'LINKED_NEEDS_FINALIZATION'
  | 'RECONCILABLE_DURABLE_RESPONSE'
  | 'MISSING'
  | 'CONFLICT';

/**
 * Statut d'initialisation du run.
 *
 * Un seul label, ordonné par ce qu'il faut faire en premier : réparer
 * localement avant de constater ce qui manque réellement.
 */
export type NativeInitializationStatus =
  | 'NONE'
  | 'COMPLETE_NEEDS_FINALIZATION'
  | 'RECONCILABLE_DURABLE_RESPONSE'
  | 'LINKED_NEEDS_FINALIZATION'
  | 'CLEAN_MISSING'
  | 'IN_FLIGHT_UNCERTAIN'
  | 'EVIDENCE_CONFLICT';

export interface NativeInitializationRecoveryView {
  readonly runId: string;
  readonly status: NativeInitializationStatus;
  readonly slots: Readonly<Record<ExpertSlotId, NativeSlotRecoveryFacts>>;
  readonly conditions: Readonly<Record<ExpertSlotId, NativeSlotCondition>>;
  /** Slots réellement dépourvus de session **et** de réponse adoptable. */
  readonly missingSlots: readonly ExpertSlotId[];
  /** Slots dont l'identité est connue mais pas encore liée ou finalisée. */
  readonly reconcilableSlots: readonly ExpertSlotId[];
  /** `unique(provider des missingSlots)` — jamais des slots réconciliables. */
  readonly requiredProviders: readonly ProviderKind[];
  readonly uncertainSlot: ExpertSlotId | null;
  readonly canFinalizeWithoutProvider: boolean;
  /**
   * `CONTINUE` peut-il **atteindre** un appel fournisseur pendant son exécution ?
   *
   * Capacité potentielle, employée par l'admission de concurrence — jamais une
   * certitude, et jamais un raccourci vers un statut.
   *
   * Repair V2.1 : cette valeur testait `status === 'CLEAN_MISSING'`. Or la
   * précédence des statuts place `RECONCILABLE_DURABLE_RESPONSE` avant lui : un
   * run dont un slot est réconciliable **et** l'autre manquant était donc
   * annoncé local, alors que `continueNativeInitialization` réconcilie le
   * premier puis appelle réellement le fournisseur pour le second. La question
   * posée est désormais celle que l'exécution pose : « restera-t-il un slot
   * manquant après la réconciliation locale ? »
   */
  readonly canContinueWithProvider: boolean;
  /** Contradictions persistées, en clair. Vide hors `EVIDENCE_CONFLICT`. */
  readonly conflicts: readonly string[];
}

// --------------------------------------------------------------------------
// Lecture des faits
// --------------------------------------------------------------------------

function slotOf(event: NativeCcrEvent): ExpertSlotId | null {
  const record = event as unknown as Record<string, unknown>;
  const value = record['expert_slot_id'];
  return value === 'author' || value === 'challenger' ? value : null;
}

/**
 * Signature canonique du `prompt_sent` d'une **initialisation**.
 *
 * Trois faits concordants, tous persistés par `initializeNativeSlot`, et aucun
 * d'eux reproductible par un transfert :
 *
 * ```text
 * actor      human      STEP écrit `system`
 * based_on   absent     STEP porte toujours [source_event_id]
 * session_id absent     STEP porte toujours la session de la cible
 * ```
 *
 * Les trois sont vérifiés, et non le seul plus commode : un critère à un fait
 * deviendrait faux dès qu'un chemin futur écrirait un prompt de forme voisine.
 * Le prompt doit en outre viser **le slot de la réponse** — une réponse ne
 * dérive pas de l'intention adressée à l'autre expert.
 */
function isInitializationPrompt(event: NativeCcrEvent | undefined, slot: ExpertSlotId): boolean {
  if (event === undefined || event.type !== 'prompt_sent' || event.actor !== 'human') return false;
  const record = event as unknown as Record<string, unknown>;
  if (record['target_expert_slot_id'] !== slot) return false;
  // Aucun antécédent causal : une initialisation ne dérive de rien.
  if ((event.based_on ?? []).length > 0) return false;
  // Aucune session : au moment du prompt initial, elle n'existe pas encore.
  const session = record['session_id'];
  return session === undefined || session === null;
}

/**
 * Cette réponse est-elle **la** réponse d'initialisation de ce slot ?
 *
 * Question causale, jamais positionnelle : ni « la première du slot », ni
 * « avant le premier round », ni un voisinage temporel. Un `send` vit en round
 * 0 et peut précéder tout transfert ; l'ordre ne prouve donc rien.
 *
 * Une chaîne invalide — `based_on` absent, multiple, pendant, ou désignant un
 * prompt d'un autre slot — ne fabrique aucune association : la réponse n'est
 * simplement pas retenue comme initiale, et le run apparaîtra dépourvu de
 * réponse initiale durable. C'est exactement ce que les conflits existants
 * savent déjà signaler.
 */
function isInitialResponse(
  response: NativeCcrEvent,
  slot: ExpertSlotId,
  index: ReadonlyMap<string, NativeCcrEvent>,
): boolean {
  const basedOn = response.based_on ?? [];
  if (basedOn.length !== 1) return false;
  const cause = basedOn[0];
  return cause !== undefined && isInitializationPrompt(index.get(cause), slot);
}

function collectSlotFacts(
  manifest: NativeRunManifest,
  history: readonly NativeCcrEvent[],
  slot: ExpertSlotId,
  index: ReadonlyMap<string, NativeCcrEvent>,
): NativeSlotRecoveryFacts {
  const responses = history.filter(
    (event) =>
      event.type === 'assistant_response' && slotOf(event) === slot && isInitialResponse(event, slot, index),
  );
  const created = history.filter((event) => event.type === 'session_created' && slotOf(event) === slot);
  const lastResponse = responses[responses.length - 1];
  const lastCreated = created[created.length - 1];

  return {
    slot,
    provider: manifest.experts[slot].provider,
    manifestSession: manifest.experts[slot].session_id,
    initialResponseSession: (lastResponse as { session_id?: string } | undefined)?.session_id ?? null,
    initialResponseEventId: lastResponse?.event_id ?? null,
    createdSession: (lastCreated as { session_id?: string } | undefined)?.session_id ?? null,
    initialResponseCount: responses.length,
  };
}

/**
 * Classe un slot **sans jamais préférer une lecture à une autre**.
 *
 * Chaque contradiction listée ici est une séquence que l'ordre durable de 1C
 * rend impossible. Une session liée sans réponse journalisée, par exemple, ne
 * peut pas résulter d'un crash : 1C journalise la réponse avant de lier.
 * « Réparer » un tel run reviendrait à choisir laquelle de deux affirmations
 * incompatibles est la vraie.
 */
function classifySlot(facts: NativeSlotRecoveryFacts, conflicts: string[]): NativeSlotCondition {
  const { slot, manifestSession, createdSession } = facts;
  const responseSession = facts.initialResponseSession;
  const responseCount = facts.initialResponseCount;

  // Deux réponses satisfaisant **réellement** le contrat START restent une
  // contradiction : le repair 1D.2 rend le compte exact, il ne le désarme pas.
  if (responseCount > 1) {
    conflicts.push(`${slot} : ${String(responseCount)} réponses initiales durables ; une seule peut être canonique.`);
    return 'CONFLICT';
  }
  if (manifestSession !== null && responseSession !== null && manifestSession !== responseSession) {
    conflicts.push(
      `${slot} : le manifest lie « ${manifestSession} » alors que la réponse durable porte « ${responseSession} ».`,
    );
    return 'CONFLICT';
  }
  if (manifestSession !== null && responseSession === null) {
    conflicts.push(
      `${slot} : session « ${manifestSession} » liée sans réponse initiale durable ; ` +
        "l'ordre d'écriture journalise la réponse avant la liaison.",
    );
    return 'CONFLICT';
  }
  if (createdSession !== null && createdSession !== manifestSession) {
    conflicts.push(
      `${slot} : session_created affirme « ${createdSession} », le manifest « ${String(manifestSession)} ».`,
    );
    return 'CONFLICT';
  }

  if (manifestSession !== null) {
    return createdSession === null ? 'LINKED_NEEDS_FINALIZATION' : 'COMPLETE';
  }
  return responseSession !== null ? 'RECONCILABLE_DURABLE_RESPONSE' : 'MISSING';
}

function crossSlotConflicts(
  manifest: NativeRunManifest,
  facts: Record<ExpertSlotId, NativeSlotRecoveryFacts>,
  conflicts: string[],
): void {
  const author = facts.author;
  const challenger = facts.challenger;
  if (
    author.manifestSession !== null &&
    author.manifestSession === challenger.manifestSession &&
    author.provider === challenger.provider
  ) {
    conflicts.push(
      `Les deux slots partagent l'identité native (${author.provider}, ${author.manifestSession}) : ` +
        'deux experts ne peuvent pas être la même conversation.',
    );
  }
  void manifest;
}

/**
 * Une opération d'initialisation était-elle en vol sans réponse journalisée ?
 *
 * C'est la seule situation où CCR ignore franchement ce qui s'est passé : le
 * fournisseur peut n'avoir rien reçu, ou avoir répondu juste avant que le
 * processus disparaisse.
 */
function inFlightSlot(
  state: NativeRunStateDocument,
  history: readonly NativeCcrEvent[],
): ExpertSlotId | null {
  const pending = state.pending_operation;
  if (pending === null || pending.kind !== 'initialization') return null;
  const promptEventId = pending.prompt_event_id;
  if (promptEventId === null) return pending.expert_slot;
  const answered = history.some(
    (event) => event.type === 'assistant_response' && (event.based_on ?? []).includes(promptEventId),
  );
  return answered ? null : pending.expert_slot;
}

// --------------------------------------------------------------------------
// Vue
// --------------------------------------------------------------------------

export function buildNativeInitializationView(
  runId: string,
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  history: readonly NativeCcrEvent[],
): NativeInitializationRecoveryView {
  const conflicts: string[] = [];
  // Index local, construit une fois : suivre `based_on` sur deux slots sans lui
  // reparcourrait le journal pour chaque réponse. Rien n'est persisté, rien
  // n'est mis en cache au-delà de cet appel.
  const index = new Map(history.map((event) => [event.event_id, event]));
  const slots = {
    author: collectSlotFacts(manifest, history, 'author', index),
    challenger: collectSlotFacts(manifest, history, 'challenger', index),
  };
  const conditions = {
    author: classifySlot(slots.author, conflicts),
    challenger: classifySlot(slots.challenger, conflicts),
  };
  crossSlotConflicts(manifest, slots, conflicts);

  const missingSlots = EXPERT_SLOT_IDS.filter((slot) => conditions[slot] === 'MISSING');
  const reconcilableSlots = EXPERT_SLOT_IDS.filter(
    (slot) =>
      conditions[slot] === 'RECONCILABLE_DURABLE_RESPONSE' ||
      conditions[slot] === 'LINKED_NEEDS_FINALIZATION',
  );
  const uncertainSlot =
    state.state === 'RECOVERY_REQUIRED' && state.uncertainty !== null
      ? state.uncertainty.expert_slot
      : inFlightSlot(state, history);

  const status = ((): NativeInitializationStatus => {
    if (conflicts.length > 0) return 'EVIDENCE_CONFLICT';
    if (uncertainSlot !== null) return 'IN_FLIGHT_UNCERTAIN';
    if (reconcilableSlots.some((slot) => conditions[slot] === 'RECONCILABLE_DURABLE_RESPONSE')) {
      return 'RECONCILABLE_DURABLE_RESPONSE';
    }
    if (reconcilableSlots.length > 0) return 'LINKED_NEEDS_FINALIZATION';
    if (missingSlots.length > 0) return 'CLEAN_MISSING';
    // Les deux slots sont complets : reste à savoir si START a pu poser son
    // état de repos et son curseur.
    //
    // Le curseur est le témoin, et lui seul (repair 1D.2). Il naît `null`, est
    // posé une fois par START, puis n'est plus écrit que par un transfert ou sa
    // reprise — jamais remis à `null`. Exiger en plus `« author » et READY`
    // revenait à déclarer inachevé tout run ayant simplement vécu : un round
    // abouti déplace le curseur, une pause déplace l'état.
    return state.next_step_source_slot === null ? 'COMPLETE_NEEDS_FINALIZATION' : 'NONE';
  })();

  return {
    runId,
    status,
    slots,
    conditions,
    missingSlots,
    reconcilableSlots,
    // Un fournisseur n'est requis que pour un slot réellement manquant. Un
    // manifest en retard sur une réponse durable n'exige aucun appel.
    requiredProviders: [...new Set(missingSlots.map((slot) => slots[slot].provider))],
    uncertainSlot,
    canFinalizeWithoutProvider:
      status === 'RECONCILABLE_DURABLE_RESPONSE' ||
      status === 'LINKED_NEEDS_FINALIZATION' ||
      status === 'COMPLETE_NEEDS_FINALIZATION',
    // La réconciliation locale ne touche **que** les slots réconciliables : un
    // slot `MISSING` le reste après elle, et elle n'en crée aucun. L'ensemble
    // calculé ici est donc exactement celui que la boucle d'initialisation
    // parcourra — c'est ce qui rend cette prédiction exacte sans rejouer le
    // service ni toucher le disque.
    //
    // Les trois refus antérieurs à tout appel sont exclus explicitement :
    // faits contradictoires et incertitude font lever la reprise, un run
    // terminal la fait revenir sans effet.
    canContinueWithProvider:
      missingSlots.length > 0 &&
      conflicts.length === 0 &&
      uncertainSlot === null &&
      state.state !== 'CLOSED' &&
      state.state !== 'FAILED',
    conflicts,
  };
}

// --------------------------------------------------------------------------
// Chargement d'un run natif
// --------------------------------------------------------------------------

interface LoadedNativeRun {
  readonly paths: RunPaths;
  readonly manifest: NativeRunManifest;
  readonly state: NativeRunStateDocument;
  readonly events: NativeEventStore;
  readonly history: readonly NativeCcrEvent[];
}

/**
 * Charge un run **natif**, ou refuse explicitement.
 *
 * Un run historique n'est pas traité ici et n'est pas non plus converti : la
 * reprise legacy existe, elle est inchangée, et c'est elle qui s'applique.
 */
async function loadNativeRun(
  deps: RunServiceDeps,
  runId: string,
  manifestRef?: ManifestRef,
): Promise<LoadedNativeRun> {
  const paths = runPaths(deps.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Le run ${runId} est de génération ${persisted.execution_mode} : la reprise d'initialisation ` +
        'native ne le traite pas, et ne le convertit pas. Utilisez la reprise historique.',
      { details: { runId, execution_mode: persisted.execution_mode } },
    );
  }
  const stateDoc = await readPersistedState(paths);
  if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
      details: { runId },
    });
  }

  const ref = manifestRef ?? { manifest: persisted.manifest };
  ref.manifest = persisted.manifest;
  const events = await openNativeEventStore(paths, () => ref.manifest);
  return {
    paths,
    manifest: persisted.manifest,
    state: stateDoc.document,
    events,
    history: await events.readAll(),
  };
}

// --------------------------------------------------------------------------
// Inspection — strictement sans effet
// --------------------------------------------------------------------------

/**
 * Établit ce que le disque affirme, et rien d'autre.
 *
 * N'écrit aucun fichier, n'acquiert aucun verrou, n'appelle aucun fournisseur.
 * Observer un run ambigu ne doit jamais le modifier — c'est ce qui rend
 * l'inspection utilisable avant de décider.
 */
export async function inspectNativeInitialization(
  deps: RunServiceDeps,
  runId: string,
): Promise<NativeInitializationRecoveryView> {
  const loaded = await loadNativeRun(deps, runId);
  return buildNativeInitializationView(runId, loaded.manifest, loaded.state, loaded.history);
}

// --------------------------------------------------------------------------
// Acquittement d'une incertitude
// --------------------------------------------------------------------------

export interface NativeRecoveryOutcome {
  readonly runId: string;
  readonly view: NativeInitializationRecoveryView;
  readonly state: NativeRunStateDocument;
  readonly actions: readonly string[];
  readonly staleLock?: RunLockInfo;
  readonly positions: readonly NativeInitialPosition[];
  /**
   * Cause exacte d'un slot non repris (`V2.2-IMP-08`).
   *
   * La reprise rapporte plutôt qu'elle ne lève, et ce contrat est conservé. Le
   * motif reste néanmoins nommable, à côté des positions déjà acquises.
   */
  readonly failure?: { readonly slot: ExpertSlotId; readonly error: unknown };
  /**
   * Échecs de gouvernance d'usage, agrégés sur les slots repris (V2.2-IMP-05).
   *
   * Ils coexistent avec un échec de slot sans le masquer : un avertissement
   * d'usage et une tentative interrompue décrivent deux faits différents.
   */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
}

/** Fabriques de gouvernance, injectables pour éprouver une panne d'écriture. */
export interface NativeRecoveryGovernanceSeams {
  readonly openInvocationLedger?: typeof openInvocationLedger;
  readonly openUsageLedger?: typeof openUsageLedger;
}

async function withNativeRunLock<T>(
  deps: RunServiceDeps,
  runId: string,
  command: string,
  boundary: NativeMutationBoundary | undefined,
  body: (paths: RunPaths, staleLock: RunLockInfo | undefined, actions: string[]) => Promise<T>,
): Promise<T> {
  const paths = runPaths(deps.runsDir, runId);
  const actions: string[] = [];

  // Hygiène du verrou, reprise telle quelle de la reprise V2 : un propriétaire
  // vivant, ou un verrou venu d'un autre hôte, fait échouer l'acquisition.
  let staleLock: RunLockInfo | undefined;
  const existing = await readRunLock(paths);
  if (existing !== undefined && assessLiveness(existing) === 'STALE') {
    staleLock = await clearStaleLock(paths);
    actions.push(`Verrou périmé supprimé (pid ${String(existing.pid)}, posé le ${existing.started_at}).`);
  }

  return withNativeMutation(
    { runsDir: deps.runsDir, runId, command, ...(boundary === undefined ? {} : { boundary }) },
    () => body(paths, staleLock, actions),
  );
}

/**
 * Acquitte une incertitude d'initialisation.
 *
 * Ce que cet acquittement dit :
 *
 * > un humain a constaté qu'un appel avait été engagé sans réponse journalisée,
 * > et prend la responsabilité de la suite.
 *
 * Ce qu'il ne dit **jamais** : que l'appel n'a pas eu lieu. Le tour précédent
 * n'est pas rendu, aucun budget n'est restauré, et rien n'est rejoué. Il ouvre
 * seulement la possibilité d'une nouvelle tentative explicite.
 */
export async function acknowledgeNativeUncertainty(
  deps: RunServiceDeps,
  runId: string,
  note: string,
  boundary?: NativeMutationBoundary,
): Promise<NativeRecoveryOutcome> {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new CcrError('INVALID_ARGUMENT', "L'acquittement d'une incertitude exige une note explicite.", {
      details: { runId },
    });
  }

  return withNativeRunLock(deps, runId, 'native-acknowledge', boundary, async (_paths, staleLock, actions) => {
    const loaded = await loadNativeRun(deps, runId);
    const view = buildNativeInitializationView(runId, loaded.manifest, loaded.state, loaded.history);

    if (view.status !== 'IN_FLIGHT_UNCERTAIN') {
      throw new CcrError(
        'INVALID_ARGUMENT',
        `Le run ${runId} n'a aucune incertitude d'initialisation à acquitter (statut ${view.status}).`,
        { details: { runId, status: view.status } },
      );
    }

    const pending = loaded.state.pending_operation;
    const event = await loaded.events.append({
      round: loaded.state.round,
      actor: 'human',
      type: 'state_changed',
      // Fidélité de provenance (repair IMP-15.1) : `trimmed` **valide**, il ne
      // transforme pas. Une affirmation humaine est persistée telle qu'elle a
      // été écrite — bordures comprises. Rogner reviendrait à réécrire un fait
      // de provenance pour une raison purement cosmétique.
      content: note,
      details: {
        reason: 'NATIVE_INITIALIZATION_UNCERTAINTY_ACKNOWLEDGED',
        uncertain_slot: view.uncertainSlot,
        from: loaded.state.state,
        to: 'PAUSED',
        conclusion: "Aucune : CCR n'a pas déterminé si l'appel a eu lieu.",
        note: "L'acquittement ne prétend ni que l'appel a eu lieu, ni le contraire.",
        operation: pending?.kind ?? null,
        operation_started_at: pending?.started_at ?? null,
        operation_prompt_event_id: pending?.prompt_event_id ?? null,
      },
      timestamp: deps.now().toISOString(),
    });

    const state = await persistNativeStateUpdate(
      loaded.paths,
      loaded.state,
      {
        state: 'PAUSED',
        control: 'HUMAN',
        activeExpertSlot: null,
        uncertainty: null,
        pendingOperation: null,
        lastEventId: event.event_id,
      },
      deps.now(),
    );
    actions.push(
      `Incertitude sur « ${String(view.uncertainSlot)} » acquittée. Run rendu en PAUSED / HUMAN, sans rejeu.`,
    );

    const after = buildNativeInitializationView(runId, loaded.manifest, state, await loaded.events.readAll());
    return {
      runId,
      view: after,
      state,
      actions,
      positions: [], usageGovernanceWarnings: [],
      ...(staleLock === undefined ? {} : { staleLock }),
    };
  });
}

// --------------------------------------------------------------------------
// Réconciliation locale + continuation
// --------------------------------------------------------------------------

export interface ContinueNativeInitializationInput {
  /**
   * Mission initiale à réenvoyer aux slots réellement manquants.
   *
   * Absente, elle est relue depuis le premier `prompt_sent` durable du run :
   * un expert manquant doit recevoir la même mission que son contradicteur.
   */
  readonly prompt?: string;
  /** Interdit tout appel fournisseur : réconciliation locale seulement. */
  readonly localOnly?: boolean;
  /** Corrélation applicative facultative (V2.2-IMP-05). */
  readonly correlation?: NativeStartCorrelation;
  /** Fabriques de gouvernance, pour les tests. */
  readonly governanceSeams?: NativeRecoveryGovernanceSeams;
}

function initialPromptOf(history: readonly NativeCcrEvent[]): string | null {
  const prompt = history.find((event) => event.type === 'prompt_sent' && typeof event.content === 'string');
  return (prompt?.content as string | undefined) ?? null;
}

/**
 * Répare localement ce qui est réparable, puis n'appelle que ce qui manque.
 *
 * L'ordre compte : calculer les slots manquants **avant** la réconciliation
 * ferait relancer un fournisseur dont CCR possède déjà la réponse.
 */
export async function continueNativeInitialization(
  deps: RunServiceDeps,
  runId: string,
  input: ContinueNativeInitializationInput = {},
  boundary?: NativeMutationBoundary,
): Promise<NativeRecoveryOutcome> {
  return withNativeRunLock(deps, runId, 'native-recover', boundary, async (_paths, staleLock, actions) => {
    const manifestRef: ManifestRef = { manifest: undefined as unknown as NativeRunManifest };
    const loaded = await loadNativeRun(deps, runId, manifestRef);
    let state = loaded.state;

    const warnings: UsageGovernanceWarning[] = [];
    const before = buildNativeInitializationView(runId, loaded.manifest, state, loaded.history);

    if (before.status === 'EVIDENCE_CONFLICT') {
      throw new CcrError(
        'STATE_INVALID',
        `Le run ${runId} porte des faits contradictoires que l'ordre d'écriture rend impossibles. ` +
          'Aucune réparation n\'est tentée : elle reviendrait à choisir entre deux affirmations.',
        { details: { runId, conflicts: [...before.conflicts] } },
      );
    }

    if (before.status === 'IN_FLIGHT_UNCERTAIN') {
      throw new CcrError(
        'RECOVERY_REQUIRED',
        `Une initialisation vers « ${String(before.uncertainSlot)} » a été engagée sans réponse ` +
          "journalisée. CCR ne sait pas si l'appel a eu lieu : acquittez explicitement " +
          'cette incertitude avant toute nouvelle tentative.',
        { details: { runId, slot: before.uncertainSlot } },
      );
    }

    if (state.state === 'FAILED' || state.state === 'CLOSED') {
      actions.push(`État ${state.state} : terminal. La reprise ne le réactive pas.`);
      return {
        runId,
        view: before,
        state,
        actions,
        positions: [],
        usageGovernanceWarnings: warnings,
        ...(staleLock === undefined ? {} : { staleLock }),
      };
    }

    // ---- 1. Réconciliation locale, sans le moindre appel fournisseur.
    for (const slot of EXPERT_SLOT_IDS) {
      const facts = before.slots[slot];
      const condition = before.conditions[slot];

      if (condition === 'RECONCILABLE_DURABLE_RESPONSE' && facts.initialResponseSession !== null) {
        // L'identité est déjà dans le journal : la lier ne l'invente pas.
        const other = slot === 'author' ? before.slots.challenger : before.slots.author;
        if (other.provider === facts.provider && other.manifestSession === facts.initialResponseSession) {
          throw new CcrError(
            'SESSION_ID_COLLISION',
            `La réponse durable de « ${slot} » porte la session « ${facts.initialResponseSession} », ` +
              `déjà liée à « ${other.slot} » sur le fournisseur « ${facts.provider} ».`,
            { details: { runId, slot, provider: facts.provider, session_id: facts.initialResponseSession } },
          );
        }
        manifestRef.manifest = await bindNativeSession(
          loaded.paths,
          manifestRef.manifest,
          slot,
          facts.initialResponseSession,
        );
        actions.push(
          `Session « ${facts.initialResponseSession} » liée à « ${slot} » depuis sa réponse initiale durable.`,
        );
      }

      // `session_created` manquant : complété seulement si la session est
      // désormais liée, et jamais en double.
      const bound = manifestRef.manifest.experts[slot].session_id;
      if (
        bound !== null &&
        facts.createdSession === null &&
        (condition === 'RECONCILABLE_DURABLE_RESPONSE' || condition === 'LINKED_NEEDS_FINALIZATION')
      ) {
        const event = await loaded.events.append({
          round: state.round,
          actor: 'system',
          type: 'session_created',
          expert_slot_id: slot,
          session_id: bound,
          timestamp: deps.now().toISOString(),
        });
        state = await persistNativeStateUpdate(
          loaded.paths,
          state,
          { lastEventId: event.event_id },
          deps.now(),
        );
        actions.push(`Création de session journalisée pour « ${slot} » : ${bound}.`);
      }
    }

    // ---- 2. Ce qui manque réellement, une fois la réparation faite.
    const reconciled = buildNativeInitializationView(
      runId,
      manifestRef.manifest,
      state,
      await loaded.events.readAll(),
    );
    const missing = reconciled.missingSlots;

    const positions: NativeInitialPosition[] = [];

    if (missing.length > 0 && input.localOnly !== true) {
      const prompt = input.prompt ?? initialPromptOf(loaded.history);
      if (prompt === null) {
        throw new CcrError(
          'INVALID_ARGUMENT',
          `Aucune mission initiale n'est retrouvable dans le journal du run ${runId}, et aucune n'a été fournie.`,
          { details: { runId, missing: [...missing] } },
        );
      }

      // Un run en echec d'initialisation doit repasser par RUNNING avant de
      // reengager un tour : `WAITING_AGENT` n'est pas atteignable depuis
      // `FAILED_INITIALIZATION`. C'est exactement le chemin que la reprise V2
      // emprunte deja (amendement A-10) ; il n'est pas reinvente ici.
      if (state.state === 'FAILED_INITIALIZATION') {
        state = await persistNativeStateUpdate(loaded.paths, state, { state: 'RUNNING' }, deps.now());
      }

      const ctx: NativeContext = {
        paths: loaded.paths,
        events: loaded.events,
        // Bindings et snapshot **épinglés** : la reprise n'en relit aucun depuis
        // la configuration globale, et ne fabrique aucune observation.
        adapters: deps.createAdapters(
          manifestRef.manifest.workspace.cwd,
          runtimeSettingsOf(pinnedRuntime(manifestRef.manifest, runId)),
        ),
        now: () => deps.now(),
        manifestRef,
        state,
        // Chaque slot repris engage une **nouvelle** tentative : elle reçoit son
        // propre identifiant, et ne modifie jamais l'ancienne (V2.2-IMP-05).
        governance: {
          runId,
          trigger: 'RECOVERY_CONTINUE',
          openInvocations: input.governanceSeams?.openInvocationLedger ?? openInvocationLedger,
          openUsage: input.governanceSeams?.openUsageLedger ?? openUsageLedger,
          correlation: input.correlation ?? {},
          warnings,
        },
      };

      // AUTHOR puis CHALLENGER, et jamais un slot déjà durable.
      for (const slot of missing) {
        try {
          positions.push(await initializeNativeSlot(ctx, slot, prompt));
          actions.push(`Slot « ${slot} » initialisé.`);
        } catch (error) {
          state = ctx.state;
          const failedView = buildNativeInitializationView(
            runId,
            manifestRef.manifest,
            state,
            await loaded.events.readAll(),
          );
          return {
            runId,
            view: failedView,
            state,
            actions,
            positions,
            usageGovernanceWarnings: warnings,
            // Le motif du slot non repris — refus de politique compris — voyage
            // à côté des positions déjà acquises, plutôt que d'être perdu
            // (V2.2-IMP-08).
            failure: { slot, error },
            ...(staleLock === undefined ? {} : { staleLock }),
          };
        }
      }
      state = ctx.state;
    }

    // ---- 3. Finalisation : l'humain garde la main.
    const finalFacts = buildNativeInitializationView(
      runId,
      manifestRef.manifest,
      state,
      await loaded.events.readAll(),
    );
    if (finalFacts.missingSlots.length === 0 && finalFacts.conflicts.length === 0) {
      // Uniquement si START n'a jamais posé son curseur. Le reposer sur
      // « author » alors qu'un transfert l'a fait avancer rembobinerait la
      // seule autorité d'alternance du run — et réveillerait au passage un run
      // délibérément suspendu.
      if (state.next_step_source_slot === null) {
        state = await persistNativeStateUpdate(
          loaded.paths,
          state,
          // Jamais `AUTOMATION` implicitement : une reprise rend un run
          // utilisable, elle ne décide pas de le relancer.
          { state: 'READY', control: 'HUMAN', nextStepSourceSlot: 'author', activeExpertSlot: null },
          deps.now(),
        );
        actions.push('Initialisation complète : run en READY / HUMAN, curseur posé sur AUTHOR.');
      }
    }

    const view = buildNativeInitializationView(
      runId,
      manifestRef.manifest,
      state,
      await loaded.events.readAll(),
    );
    return {
      runId,
      view,
      state,
      actions,
      positions,
      usageGovernanceWarnings: warnings,
      ...(staleLock === undefined ? {} : { staleLock }),
    };
  });
}

/**
 * Snapshot runtime épinglé du run.
 *
 * La reprise n'en construit jamais un nouveau : les bindings, le drapeau
 * exécutable de Codex et les observations d'origine sont ceux du manifest. Un
 * run sans snapshot serait un run natif que rien n'aurait dû créer.
 */
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
