/**
 * Contrôle humain d'un run **natif V2.1** — `pause` et `resume`
 * (V2.1-IMP-16, Surface Completion Repair).
 *
 * ## Le défaut que ce module ferme
 *
 * Aucun écrivain natif ne rendait le contrôle à l'automatisation. Les dix-sept
 * sites qui écrivent `control` posent tous `HUMAN` ; la seule attribution
 * d'`AUTOMATION` de toute la génération native est la construction de l'état
 * initial. Le premier incident de fournisseur — un simple timeout —, comme
 * toute finalisation de reprise, laissait donc un run sain, complet, aux deux
 * sessions vivantes, **définitivement** incapable de produire un tour.
 *
 * Symétriquement, `handoff` exige un run suspendu sous contrôle humain : sans
 * `pause`, la seule façon d'ouvrir délibérément une session native était de
 * provoquer une panne.
 *
 * ## Ce que ce module n'est pas
 *
 * Ce n'est pas une seconde machine d'état, ni un cinquième moteur de reprise.
 * Les préconditions sont **exactement** `pauseGuard` et `resumeGuard`
 * (`core/run-guards.ts`), appelées sur les faits natifs par `nativeGuardFacts`
 * (2A). Aucune règle n'est reformulée ici.
 *
 * Une seule règle est nouvelle, et elle est étroite : des faits canoniques qui
 * se contredisent interdisent de **gagner** en autonomie.
 *
 * ```text
 * plus d'autonomie   HUMAN → AUTOMATION   fail-closed sur EVIDENCE_CONFLICT
 * moins d'autonomie  → HUMAN              toujours permis
 * ```
 *
 * Suspendre un run rend la main à l'humain : lui refuser cette suspension parce
 * que ses faits se contredisent l'immobiliserait au moment précis où il doit
 * reprendre la main. `pause` ne porte donc pas la barrière de conflit.
 *
 * ## Ce que la barrière n'est pas non plus
 *
 * Elle n'est **pas** « tous les statuts de reprise à `NONE` ». Cette règle a été
 * réfutée, statut par statut, par le micro-gate `Blocking Recovery vs
 * Diagnostic Recovery` : plusieurs diagnostics survivent légitimement à côté
 * d'une activité normale, et l'un d'eux — `PRE_INTERACTIVE_ABORTED` — est même
 * déclaré non bloquant par le contrat écrit de 2C-R. Les autres situations
 * réellement dangereuses sont déjà arrêtées ailleurs, et par des barrières que
 * `resume` ne franchit pas :
 *
 * ```text
 * contexte engagé · WAITING_AGENT      resumeGuard, via requiresRecovery
 * FAILED_INITIALIZATION · RECOVERY_    resumeGuard, via RESUMABLE_STATES
 *   REQUIRED · FAILED · CLOSED
 * session absente · curseur absent     planNativeStep, à chaque transfert
 * source consommée · quarantainée      planNativeStep
 * position périmée après handoff       planNativeStep
 * ```
 *
 * Toutes sont calculées depuis le journal et le manifest, indépendamment de
 * `control`, et réévaluées sous verrou à chaque mutation. Rendre le contrôle
 * n'en contourne aucune.
 */

import { CcrError } from '../core/errors.ts';
import type { CcrErrorCode } from '../core/errors.ts';
import type { NativeCcrEvent, NativeRunManifest, NativeRunStateDocument } from '../core/run-native.ts';
import { pauseGuard, resumeGuard } from '../core/run-guards.ts';
import type { GuardVerdict } from '../core/run-guards.ts';
import type { RunState } from '../core/state.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import { runPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import { persistNativeStateUpdate, readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import { buildNativeInitializationView } from './native-recovery-service.ts';
import type { NativeInitializationStatus } from './native-recovery-service.ts';
import { buildNativeStepRecoveryView } from './native-step-recovery-service.ts';
import type { NativeStepRecoveryStatus } from './native-step-recovery-service.ts';
import { buildNativeSendRecoveryView } from './native-send-recovery-service.ts';
import type { NativeSendRecoveryStatus } from './native-send-recovery-service.ts';
import { buildNativeHandoffRecoveryView } from './native-handoff-recovery-service.ts';
import type { NativeHandoffRecoveryStatus } from './native-handoff-recovery-service.ts';
import { nativeGuardFacts } from './native-target-resolver.ts';

/**
 * Dépendances du contrôle natif — volontairement sans fabrique d'adapter.
 *
 * `pause` et `resume` ne lancent rien. L'absence de `createAdapters` n'est pas
 * une omission : c'est la preuve, au niveau du type, qu'aucun fournisseur ne
 * peut être invoqué depuis ce module.
 */
export interface NativeControlDeps {
  readonly runsDir: string;
  now(): Date;
}

// --------------------------------------------------------------------------
// Verdicts
// --------------------------------------------------------------------------

/**
 * Statuts des quatre reprises natives, tels que leurs classifieurs les rendent.
 *
 * Des **statuts**, pas des vues : la barrière n'a besoin de rien d'autre, et
 * dépendre des vues entières l'exposerait à leurs évolutions de forme.
 */
export interface NativeRecoveryStatuses {
  readonly initialization: NativeInitializationStatus;
  readonly step: NativeStepRecoveryStatus;
  readonly send: NativeSendRecoveryStatus;
  readonly handoff: NativeHandoffRecoveryStatus;
}

export type NativeRecoveryDomain = keyof NativeRecoveryStatuses;

export const NATIVE_RECOVERY_DOMAIN_IDS: readonly NativeRecoveryDomain[] = [
  'initialization',
  'step',
  'send',
  'handoff',
];

/**
 * Verdict d'une action de contrôle.
 *
 * `NOOP` n'est pas un refus : l'action est déjà satisfaite, elle réussit sans
 * écrire. Les confondre transformerait une idempotence en erreur.
 */
export type NativeControlVerdict =
  | { readonly kind: 'ALLOWED' }
  | { readonly kind: 'NOOP' }
  | {
      readonly kind: 'REFUSED';
      readonly code: CcrErrorCode;
      /** Domaines dont les faits se contredisent. Vide hors conflit. */
      readonly conflictingDomains: readonly NativeRecoveryDomain[];
    };

/** Faits nécessaires à la barrière de reprise, et rien de plus. */
export interface NativeResumeFacts {
  readonly state: NativeRunStateDocument;
  readonly recovery: NativeRecoveryStatuses;
}

function refused(code: CcrErrorCode, domains: readonly NativeRecoveryDomain[] = []): NativeControlVerdict {
  return { kind: 'REFUSED', code, conflictingDomains: domains };
}

/**
 * Traduit un verdict de garde partagée.
 *
 * `ALREADY_SATISFIED` ne remonte jamais ici : la garde le porte sur `NOOP`, pas
 * sur `REFUSED`.
 */
function fromGuard(verdict: GuardVerdict, fallback: CcrErrorCode): NativeControlVerdict {
  if (verdict.kind === 'ALLOWED') return { kind: 'ALLOWED' };
  if (verdict.kind === 'NOOP') return { kind: 'NOOP' };
  return refused(verdict.reason === 'ALREADY_SATISFIED' ? fallback : verdict.reason);
}

/**
 * Barrière de `pause` — la garde historique, et elle seule.
 *
 * Aucune barrière de conflit n'y est ajoutée : voir l'en-tête du module.
 */
export function evaluateNativePauseBarrier(state: NativeRunStateDocument): NativeControlVerdict {
  return fromGuard(pauseGuard(nativeGuardFacts(state)), 'RUN_NOT_PAUSABLE');
}

/**
 * Barrière de `resume`, en deux couches et dans cet ordre.
 *
 * ```text
 * A  resumeGuard(nativeGuardFacts(state))     refus  → refus
 * B  un domaine quelconque EVIDENCE_CONFLICT  → refus
 * C  resumeGuard NOOP                         → NOOP
 * ```
 *
 * La couche B précède délibérément le `NOOP` : un run déjà `READY /
 * AUTOMATION` dont les faits se contredisent ne doit pas répondre « déjà
 * repris ». Il doit exposer le conflit.
 *
 * Fonction pure : aucune lecture, aucune écriture, aucun verrou, aucun
 * fournisseur. C'est ce qui permet à la projection 2D et à la mutation de
 * partager exactement le même verdict.
 */
export function evaluateNativeResumeBarrier(facts: NativeResumeFacts): NativeControlVerdict {
  const guard = resumeGuard(nativeGuardFacts(facts.state));
  if (guard.kind === 'REFUSED') return fromGuard(guard, 'RUN_NOT_RESUMABLE');

  const conflicting = NATIVE_RECOVERY_DOMAIN_IDS.filter(
    (domain) => facts.recovery[domain] === 'EVIDENCE_CONFLICT',
  );
  if (conflicting.length > 0) return refused('RECOVERY_EVIDENCE_CONFLICT', conflicting);

  return guard.kind === 'NOOP' ? { kind: 'NOOP' } : { kind: 'ALLOWED' };
}

// --------------------------------------------------------------------------
// Chargement
// --------------------------------------------------------------------------

export interface NativeControlResult {
  readonly runId: string;
  readonly state: NativeRunStateDocument;
  /** Faux lorsque l'opération était déjà satisfaite : aucun événement produit. */
  readonly changed: boolean;
}

interface LoadedNativeRun {
  readonly manifest: NativeRunManifest;
  readonly state: NativeRunStateDocument;
}

async function loadNativeRun(runsDir: string, runId: string): Promise<LoadedNativeRun> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Le run ${runId} est de génération ${persisted.execution_mode} : le contrôle natif ne le traite pas, ` +
        'et ne convertit rien.',
      { details: { runId, execution_mode: persisted.execution_mode } },
    );
  }
  const stateDoc = await readPersistedState(paths);
  if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
      details: { runId },
    });
  }
  return { manifest: persisted.manifest, state: stateDoc.document };
}

function refusalError(
  runId: string,
  action: 'pause' | 'resume',
  state: NativeRunStateDocument,
  verdict: Extract<NativeControlVerdict, { kind: 'REFUSED' }>,
): CcrError {
  const details = {
    runId,
    action,
    state: state.state,
    control: state.control,
    ...(verdict.conflictingDomains.length === 0
      ? {}
      : { recovery_domains: [...verdict.conflictingDomains] }),
  };

  switch (verdict.code) {
    case 'RECOVERY_REQUIRED':
      return new CcrError(
        'RECOVERY_REQUIRED',
        `Le run ${runId} porte une opération engagée : son issue doit être établie avant tout ` +
          'changement de contrôle.',
        { details },
      );
    case 'RECOVERY_EVIDENCE_CONFLICT':
      return new CcrError(
        'RECOVERY_EVIDENCE_CONFLICT',
        `Des faits canoniques du run ${runId} se contredisent (${verdict.conflictingDomains.join(', ')}). ` +
          "CCR ne choisit pas lequel est vrai, et ne rend pas l'automatisation d'un run dont il ne " +
          "peut pas établir l'histoire.",
        { details },
      );
    case 'RUN_NOT_PAUSABLE':
      return new CcrError(
        'RUN_NOT_PAUSABLE',
        `Le run ${runId} est en ${state.state} : cet état possède son propre chemin, ` +
          '`pause` ne le transforme pas.',
        { details },
      );
    default:
      return new CcrError(
        verdict.code,
        `Le run ${runId} est en ${state.state} : cet état exige son mécanisme propre avant toute reprise.`,
        { details },
      );
  }
}

// --------------------------------------------------------------------------
// `pause`
// --------------------------------------------------------------------------

/**
 * Suspend volontairement l'automatisation d'un run natif.
 *
 * Contrat identique à celui de V2, y compris ses deux subtilités :
 * `WAITING_HUMAN` n'est jamais requalifié en `PAUSED` — impossibilité constatée
 * et suspension délibérée ne disent pas la même chose —, et l'opération est
 * idempotente sous contrôle humain.
 *
 * Aucun champ natif n'est touché hors de ceux du contrat : le round, le
 * curseur d'alternance, le slot actif et le contexte engagé traversent la
 * suspension intacts. `persistStateUpdate` historique n'est jamais employé — il
 * écrirait `active_agent` et perdrait `next_step_source_slot`.
 */
export async function pauseNativeRun(
  deps: NativeControlDeps,
  runId: string,
  boundary?: NativeMutationBoundary,
): Promise<NativeControlResult> {
  const paths = runPaths(deps.runsDir, runId);

  return withNativeMutation(
    {
      runsDir: deps.runsDir,
      runId,
      command: 'native-pause',
      ...(boundary === undefined ? {} : { boundary }),
    },
    async () => {
    const loaded = await loadNativeRun(deps.runsDir, runId);
    const state = loaded.state;

    const verdict = evaluateNativePauseBarrier(state);
    if (verdict.kind === 'NOOP') return { runId, state, changed: false };
    if (verdict.kind === 'REFUSED') throw refusalError(runId, 'pause', state, verdict);

    const target: RunState = state.state === 'WAITING_HUMAN' ? 'WAITING_HUMAN' : 'PAUSED';
    const events = await openNativeEventStore(paths, loaded.manifest);
    const event = await events.append({
      round: state.round,
      actor: 'human',
      type: 'run_paused',
      details: {
        state_from: state.state,
        state_to: target,
        control_from: state.control,
        control_to: 'HUMAN',
      },
      timestamp: deps.now().toISOString(),
    });

    const next = await persistNativeStateUpdate(
      paths,
      state,
      { state: target, control: 'HUMAN', lastEventId: event.event_id },
      deps.now(),
    );
    return { runId, state: next, changed: true };
  });
}

// --------------------------------------------------------------------------
// `resume`
// --------------------------------------------------------------------------

/**
 * Rend un run natif à l'automatisation.
 *
 * Ne lance aucun agent, n'effectue aucun transfert implicite, n'envoie aucun
 * message : la commande ne change que l'état et le propriétaire du contrôle.
 *
 * Ne résout et n'efface aucune reprise. Un diagnostic non bloquant reste
 * visible après le retour à l'automatisation, et les moteurs réévaluent leurs
 * propres barrières au tour suivant.
 */
export async function resumeNativeRun(
  deps: NativeControlDeps,
  runId: string,
  boundary?: NativeMutationBoundary,
): Promise<NativeControlResult> {
  const paths = runPaths(deps.runsDir, runId);

  return withNativeMutation(
    {
      runsDir: deps.runsDir,
      runId,
      command: 'native-resume',
      ...(boundary === undefined ? {} : { boundary }),
    },
    async () => {
    const loaded = await loadNativeRun(deps.runsDir, runId);
    const state = loaded.state;
    const store = await openNativeEventStore(paths, loaded.manifest);
    const history = await store.readAll();

    const verdict = evaluateNativeResumeBarrier({
      state,
      recovery: await nativeRecoveryStatuses(deps.runsDir, runId, loaded.manifest, state, history),
    });
    if (verdict.kind === 'NOOP') return { runId, state, changed: false };
    if (verdict.kind === 'REFUSED') throw refusalError(runId, 'resume', state, verdict);

    const event = await store.append({
      round: state.round,
      actor: 'human',
      type: 'run_resumed',
      details: {
        state_from: state.state,
        state_to: 'READY',
        control_from: state.control,
        control_to: 'AUTOMATION',
      },
      timestamp: deps.now().toISOString(),
    });

    const next = await persistNativeStateUpdate(
      paths,
      state,
      { state: 'READY', control: 'AUTOMATION', lastEventId: event.event_id },
      deps.now(),
    );
    return { runId, state: next, changed: true };
  });
}

/**
 * Classifie les quatre reprises sur un instantané **déjà lu**.
 *
 * Les quatre classifieurs reçoivent le même journal et le même état : quatre
 * lectures distinctes donneraient quatre visions temporelles d'un run qui
 * n'existe qu'une fois.
 */
export async function nativeRecoveryStatuses(
  runsDir: string,
  runId: string,
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  history: readonly NativeCcrEvent[],
): Promise<NativeRecoveryStatuses> {
  const step = await buildNativeStepRecoveryView(runPaths(runsDir, runId), runId, manifest, state, history);
  return {
    initialization: buildNativeInitializationView(runId, manifest, state, history).status,
    step: step.status,
    send: buildNativeSendRecoveryView(runId, manifest, state, history).status,
    handoff: buildNativeHandoffRecoveryView(runId, manifest, state, history).status,
  };
}
