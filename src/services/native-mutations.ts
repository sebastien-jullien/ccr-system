/**
 * Composition des mutations natives pour une surface de transport
 * (V2.1-IMP-17C).
 *
 * ## Ce que ce module ajoute — et ce qu'il n'ajoute pas
 *
 * Il n'ajoute **aucune règle métier**. Les gardes, le planificateur, les
 * classifieurs de reprise et les transitions restent ceux des moteurs gelés. Ce
 * qu'il compose, c'est la précondition de vue et sa capture d'après, aux deux
 * seules positions où elles sont correctes :
 *
 * ```text
 * verrou du service  →  BEFORE  →  corps  →  SETTLED  →  release
 *                       snapshot           snapshot
 *                       assert revision    revision_after
 * ```
 *
 * C'est le contrat historique, mot pour mot — `applyShortMutation` et
 * `applyLongMutation` font exactement cela pour la génération V2 — transposé
 * par la couture de `2F.0`. Le run lock n'étant pas réentrant, il n'existe pas
 * d'autre position possible : vérifier hors verrou serait un TOCTOU, et prendre
 * le verrou avant d'appeler le service se solderait par `RUN_ALREADY_LOCKED`.
 *
 * ## Admission des opérations longues
 *
 * L'ordre est celui de V2, et il compte : une requête dont la vue est périmée
 * ne doit pas consommer un créneau d'admission.
 *
 * ```text
 * snapshot  →  assert revision  →  admit  →  fournisseur
 * ```
 *
 * Le créneau n'est réservé que si l'opération atteindrait réellement un
 * fournisseur — même règle que `plan.callsProvider` en historique — et il est
 * libéré dans un `finally`.
 */

import { CcrError } from '../core/errors.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import { assertExpectedRevision } from '../store/run-snapshot.ts';
import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { pauseNativeRun, resumeNativeRun } from './native-control-service.ts';
import { stepNativeRun } from './native-step-service.ts';
import { sendNativeMessage } from './native-send-service.ts';
import { planNativeStep } from './native-step-planner.ts';
import { evaluateNativeManualAction } from './native-target-resolver.ts';
import type { NativeExpertTargetRef } from './native-target-resolver.ts';
import type { RunRuntimeSettings, RunServiceDeps } from './run-service.ts';
import { canonicalizeWorkspace } from './start-mutation.ts';
import { startNativeRunWithPreflight } from './native-start-service.ts';
import type { NativeExpertBindings } from './native-start-service.ts';
import type { StartPreflightSeams } from './start-application-service.ts';
import type { LongOperationManager, LongOperationSlot } from '../cockpit/long-operations.ts';

// --------------------------------------------------------------------------
// Précondition de vue
// --------------------------------------------------------------------------

/** Révisions observées de part et d'autre du corps, sous le **même** verrou. */
export interface ObservedRevisions {
  before?: string;
  after?: string;
}

export interface ExpectedRevisionBoundary {
  readonly boundary: NativeMutationBoundary;
  readonly revisions: ObservedRevisions;
}

/**
 * Construit la couture d'une mutation soumise à `expected_revision`.
 *
 * Une seule logique, partagée par les quatre routes : la dupliquer dans chaque
 * handler créerait quatre occasions de la faire diverger.
 *
 * `onChecked` s'exécute **après** un contrôle réussi, et jamais avant : c'est
 * là, et nulle part ailleurs, qu'un créneau d'admission peut être réservé.
 */
export function createExpectedRevisionBoundary(input: {
  readonly runsDir: string;
  readonly runId: string;
  readonly expectedRevision: string;
  readonly onChecked?: (snapshot: NativeRunSnapshot) => void | Promise<void>;
}): ExpectedRevisionBoundary {
  const revisions: ObservedRevisions = {};
  return {
    revisions,
    boundary: {
      before: async () => {
        const snapshot = await readStableNativeRunSnapshot(input.runsDir, input.runId);
        assertExpectedRevision(input.expectedRevision, snapshot.revision);
        revisions.before = snapshot.revision;
        await input.onChecked?.(snapshot);
      },
      settled: async () => {
        // Sous le même verrou, avant la libération : c'est la seule façon que
        // cette empreinte décrive l'effet qui vient d'avoir lieu.
        revisions.after = (await readStableNativeRunSnapshot(input.runsDir, input.runId)).revision;
      },
    },
  };
}

// --------------------------------------------------------------------------
// Mutations courtes — `PAUSE`, `RESUME`
// --------------------------------------------------------------------------

export type NativeShortAction = 'PAUSE' | 'RESUME';

export interface NativeMutationOutcome {
  readonly runId: string;
  readonly action: string;
  readonly revisionBefore: string;
  readonly revisionAfter: string;
  /** Faux lorsque la primitive était déjà satisfaite : aucun événement. */
  readonly changed: boolean;
  /** Vrai lorsque l'opération a réellement atteint un fournisseur. */
  readonly usedProvider: boolean;
}

function missingRevision(runId: string, phase: string): CcrError {
  // Inatteignable : la couture pose les deux révisions sous le verrou. Le dire
  // plutôt que d'inventer une empreinte vide.
  return new CcrError('STATE_INVALID', `Révision ${phase} non observée pour le run ${runId}.`, {
    details: { runId, phase },
  });
}

export async function applyNativeShortMutation(
  deps: RunServiceDeps,
  input: { readonly runId: string; readonly action: NativeShortAction; readonly expectedRevision: string },
): Promise<NativeMutationOutcome> {
  const { boundary, revisions } = createExpectedRevisionBoundary({
    runsDir: deps.runsDir,
    runId: input.runId,
    expectedRevision: input.expectedRevision,
  });

  const result =
    input.action === 'PAUSE'
      ? await pauseNativeRun(deps, input.runId, boundary)
      : await resumeNativeRun(deps, input.runId, boundary);

  if (revisions.before === undefined) throw missingRevision(input.runId, 'avant');
  if (revisions.after === undefined) throw missingRevision(input.runId, 'après');
  return {
    runId: input.runId,
    action: input.action,
    revisionBefore: revisions.before,
    revisionAfter: revisions.after,
    changed: result.changed,
    usedProvider: false,
  };
}

// --------------------------------------------------------------------------
// Opérations longues — `STEP`, `SEND`
// --------------------------------------------------------------------------

export type NativeLongAction = 'STEP' | 'SEND';

export interface NativeLongMutationDeps {
  readonly runService: RunServiceDeps;
  readonly manager: LongOperationManager;
  readonly operationId: string;
}

export interface NativeLongMutationHooks {
  /** Appelé une fois le créneau réservé, avant l'effet. Déclenche le `202`. */
  onAdmitted?: (operationId: string) => void;
}

/**
 * Un fournisseur sera-t-il réellement atteint ?
 *
 * Même question que `precheckLongOperation` côté historique, posée aux mêmes
 * autorités : le planificateur pour un transfert, la garde d'action manuelle
 * pour un envoi. Aucune règle n'est réécrite — la réponse ne sert qu'à décider
 * si un créneau d'admission a un sens, et le service la réévaluera lui-même.
 */
function willCallProvider(
  snapshot: NativeRunSnapshot,
  input: { readonly action: NativeLongAction; readonly ref?: NativeExpertTargetRef },
  maxTransferBytes: number | undefined,
): boolean {
  if (input.action === 'STEP') {
    return (
      planNativeStep({
        runId: snapshot.runId,
        manifest: snapshot.manifest,
        state: snapshot.state,
        events: snapshot.events,
        ...(maxTransferBytes === undefined ? {} : { maxTransferBytes }),
      }).kind === 'READY'
    );
  }
  if (input.ref === undefined) return false;
  return (
    evaluateNativeManualAction(snapshot.manifest, snapshot.state, { action: 'SEND', ref: input.ref })
      .verdict.kind !== 'REFUSED'
  );
}

export async function applyNativeLongMutation(
  deps: NativeLongMutationDeps,
  input: {
    readonly runId: string;
    readonly action: NativeLongAction;
    readonly expectedRevision: string;
    readonly ref?: NativeExpertTargetRef;
    readonly content?: string;
  },
  hooks: NativeLongMutationHooks = {},
): Promise<NativeMutationOutcome> {
  let slot: LongOperationSlot | undefined;
  let usedProvider = false;

  const { boundary, revisions } = createExpectedRevisionBoundary({
    runsDir: deps.runService.runsDir,
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    // Après un contrôle réussi, et jamais avant : une vue périmée ne consomme
    // aucune capacité d'admission.
    onChecked: (snapshot) => {
      usedProvider = willCallProvider(snapshot, input, deps.runService.maxTransferBytes);
      if (!usedProvider) return;
      slot = deps.manager.admit(deps.operationId);
      hooks.onAdmitted?.(deps.operationId);
    },
  });

  try {
    if (input.action === 'STEP') {
      // Corrélation, jamais autorité (V2.2-IMP-02) : l'identifiant d'opération
      // appartient à la couche qui a reçu la requête, et voyage explicitement.
      // Une invocation lancée depuis la CLI n'en a pas, et n'en a pas besoin.
      await stepNativeRun(deps.runService, input.runId, {}, boundary, {
        operationId: deps.operationId,
      });
    } else {
      const ref = input.ref;
      const content = input.content;
      if (ref === undefined || content === undefined) {
        throw new CcrError('INVALID_ARGUMENT', 'Cible ou contenu manquant.');
      }
      await sendNativeMessage(deps.runService, input.runId, ref, content, {}, boundary, {
        operationId: deps.operationId,
      });
    }

    if (revisions.before === undefined) throw missingRevision(input.runId, 'avant');
    if (revisions.after === undefined) throw missingRevision(input.runId, 'après');
    return {
      runId: input.runId,
      action: input.action,
      revisionBefore: revisions.before,
      revisionAfter: revisions.after,
      changed: true,
      usedProvider,
    };
  } catch (error) {
    // Une intention qui échoue n'implique pas un état inchangé : le garde-fou
    // de taille journalise et transitionne avant de lever. `SETTLED` a déjà
    // capturé la révision d'après, sous le verrou — on la transporte telle
    // quelle, exactement comme la composition historique.
    if (revisions.after !== undefined) {
      (error as { revisionAfter?: string }).revisionAfter = revisions.after;
    }
    throw error;
  } finally {
    slot?.release();
  }
}

// --------------------------------------------------------------------------
// Creation — `START`
// --------------------------------------------------------------------------

export interface NativeStartMutationDeps {
  createRunServiceDeps(runtime: RunRuntimeSettings): RunServiceDeps;
  readonly manager: LongOperationManager;
  readonly operationId: string;
  readonly preflightSeams?: StartPreflightSeams;
}

export interface NativeStartMutationInput {
  readonly title: string;
  readonly workspaceCwd: string;
  readonly prompt: string;
  readonly bindings?: Partial<NativeExpertBindings>;
  /** Limite CCR d'invocations, posée à la naissance du run (`V2.2-IMP-09`). */
  readonly maxInvocations?: number;
}

export interface NativeStartMutationHooks {
  onAdmitted?: (operationId: string) => void;
  beforeAllocation?: () => void | Promise<void>;
  afterAllocation?: (runId: string) => void | Promise<void>;
  onRunAllocated?: (runId: string) => void | Promise<void>;
}

/**
 * Cree un run **natif** depuis une surface de transport.
 *
 * Meme composition que la creation historique, et pour les memes raisons : la
 * canonicalisation du workspace precede tout effet et ne consomme aucun
 * creneau ; le creneau est reserve exactement quand le preflight a reussi et
 * qu'il reste quelque chose a lancer ; une initialisation partielle **conserve**
 * le run et la session deja obtenue, et l'erreur porte son `runId` afin que
 * l'appelant puisse le nommer.
 *
 * Aucune revision : aucun run n'existe au moment du claim, donc aucune vue ne
 * peut etre perimee.
 */
export async function applyNativeStartMutation(
  deps: NativeStartMutationDeps,
  input: NativeStartMutationInput,
  hooks: NativeStartMutationHooks = {},
): Promise<{ runId: string; canonicalCwd: string }> {
  const canonicalCwd = await canonicalizeWorkspace(input.workspaceCwd);

  let slot: LongOperationSlot | undefined;
  try {
    const result = await startNativeRunWithPreflight(
      {
        createRunServiceDeps: deps.createRunServiceDeps,
        ...(deps.preflightSeams === undefined ? {} : { preflight: deps.preflightSeams }),
        onPreflight: async () => {
          slot = deps.manager.admit(deps.operationId);
          hooks.onAdmitted?.(deps.operationId);
          await hooks.beforeAllocation?.();
        },
        onRunAllocated: async (runId) => {
          await hooks.afterAllocation?.(runId);
          await hooks.onRunAllocated?.(runId);
        },
      },
      {
        title: input.title,
        cwd: canonicalCwd,
        prompt: input.prompt,
        ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
        ...(input.maxInvocations === undefined ? {} : { maxInvocations: input.maxInvocations }),
      },
      // Une operation de creation vaut deux invocations : les deux
      // enregistrements portent le meme identifiant (V2.2-IMP-04).
      { operationId: deps.operationId },
    );

    if (result.failure !== undefined) {
      // Initialisation partielle : le run existe, la session deja obtenue est
      // conservee, l'etat est `FAILED_INITIALIZATION`. Rien n'est detruit pour
      // rendre l'echec atomique — la doctrine V1 est integralement preservee.
      const error = result.failure.error;
      (error as { runId?: string }).runId = result.runId;
      throw error;
    }

    return { runId: result.runId, canonicalCwd };
  } finally {
    slot?.release();
  }
}

