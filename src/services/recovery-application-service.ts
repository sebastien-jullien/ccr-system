/**
 * Reprise canonique — voie applicative V2 (V2-IMP-40).
 *
 * ## Ce que ce module ajoute à V1
 *
 * Rien, sur l'effet. La logique de reprise vit dans `recoverRunLocked` et n'y
 * est pas dupliquée. Ce module ajoute deux garanties que la façade publique
 * `recoverRun` ne peut pas offrir :
 *
 * ```text
 * la vue sur laquelle l'humain a décidé est encore la vue courante
 * la capacité qu'il a choisie est encore celle que les faits produisent
 * ```
 *
 * ## Pourquoi le plan est **canonique**, et pas complet
 *
 * `planCanonicalRecovery` ne consulte aucun verrou. C'est délibéré, et cela
 * vient d'un défaut observé : un service qui détient déjà le run lock et qui
 * rejouerait le plan **complet** verrait son propre `.ccr.lock`, basculerait en
 * `ORPHAN_LOCK` ou `UNDETERMINED`, et refuserait l'action à cause de
 * l'exclusion qui la rend précisément possible.
 *
 * La séparation est nette : les faits canoniques disent *ce que* la primitive
 * ferait ; les faits d'exécution disent *si on peut le faire maintenant*. Ici,
 * la seconde question a déjà sa réponse — nous détenons le verrou.
 *
 * ## Pourquoi cela reste sûr
 *
 * `withRunLock` doit d'abord réussir. Un verrou détenu ailleurs fait échouer
 * l'acquisition, sans effet. Un verrou périmé bloque aussi — et n'est **jamais**
 * levé automatiquement : c'est l'objet d'une action humaine distincte.
 *
 * ## Une seule section critique
 *
 * ```text
 * acquisition du run lock
 * → révision courante
 * → expected_revision
 * → plan canonique, sur les faits canoniques courants
 * → capacité demandée == capacité courante
 * → couture de préparation          ← l'admission viendra s'y greffer
 * → recoverRunLocked
 * → révision finale
 * ```
 *
 * Ce module ne connaît ni `Idempotency-Key`, ni `operation_id`, ni reçu, ni
 * statut HTTP, ni `LongOperationManager`. Le transport traduit son résultat.
 */

import { CcrError } from '../core/errors.ts';
import { withRunLock } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import { assertExpectedRevision, readStableRunSnapshot } from '../store/run-snapshot.ts';
import { hostLockHooks, recoverRunLocked } from './run-service.ts';
import type { LegacyGovernanceContext, RecoverResult, RunServiceDeps } from './run-service.ts';
import { pendingResponseJournaled, planCanonicalRecovery } from './recovery-planner.ts';
import type { CanonicalRecoveryCapabilityId } from './recovery-planner.ts';

/** Commande inscrite dans le verrou : la même que la voie V1. */
const LOCK_COMMAND = 'recover';

export interface CanonicalRecoveryInput {
  readonly runId: string;
  readonly expectedRevision: string;
  readonly capability: CanonicalRecoveryCapabilityId;
  /** Note humaine — exigée par `RECOVERY_ACKNOWLEDGE_AMBIGUITY`, interdite ailleurs. */
  readonly acknowledgementText?: string;
}

export interface CanonicalRecoveryHooks {
  /**
   * Appelée **sous le verrou**, après la révision et la capacité, avant tout
   * effet.
   *
   * C'est l'instant exact où le transport pourra réserver un créneau et rendre
   * son `202` sans refaire les préconditions hors verrou. Sur une intention
   * déjà condamnée, elle n'est jamais appelée — c'est ce qui garantit un
   * `admitAttempts` à zéro.
   */
  readonly onReadyForEffect?: (capability: CanonicalRecoveryCapabilityId) => void | Promise<void>;
  /** Couture de test : avant l'acquisition du verrou. Aucun appelant de production. */
  readonly beforeLock?: () => void | Promise<void>;
}

export interface CanonicalRecoveryOutcome {
  readonly runId: string;
  readonly capability: CanonicalRecoveryCapabilityId;
  readonly revisionBefore: string;
  readonly revisionAfter: string;
  /** Résultat V1 tel quel : actions, ambiguïté, sessions créées. */
  readonly result: RecoverResult;
}

/**
 * Cohérence de l'intention, avant toute acquisition.
 *
 * V1 ignore silencieusement un `acknowledge` fourni hors de sa branche
 * (`run-service.ts:1471`). Le chemin V2 ne reprend pas cette tolérance : une
 * note qui n'aura aucun effet est une intention mal formée, pas une intention
 * inoffensive.
 */
function assertCoherent(input: CanonicalRecoveryInput): void {
  const note = input.acknowledgementText;
  if (input.capability === 'RECOVERY_ACKNOWLEDGE_AMBIGUITY') {
    if (note === undefined || note.trim().length === 0) {
      throw new CcrError(
        'INVALID_ARGUMENT',
        "Acquitter une ambiguïté exige une note humaine : CCR n'en rédige pas à votre place.",
      );
    }
    return;
  }
  if (note !== undefined) {
    throw new CcrError(
      'INVALID_ARGUMENT',
      "Une note d'acquittement n'a de sens que pour l'acquittement d'une ambiguïté.",
    );
  }
}

export async function applyCanonicalRecovery(
  deps: RunServiceDeps,
  input: CanonicalRecoveryInput,
  hooks: CanonicalRecoveryHooks = {},
  /**
   * Corrélation applicative facultative (`V2.2-IMP-06`).
   *
   * Seule `RECOVERY_CONTINUE_INITIALIZATION` joint un fournisseur ; les autres
   * capacités n'engagent rien, et ce contexte reste alors sans effet.
   */
  governance: LegacyGovernanceContext = {},
): Promise<CanonicalRecoveryOutcome> {
  assertCoherent(input);

  const { runId } = input;
  const paths = runPaths(deps.runsDir, runId);
  await hooks.beforeLock?.();

  return withRunLock(
    paths,
    LOCK_COMMAND,
    async () => {
      const before = await readStableRunSnapshot(deps.runsDir, runId);
      assertExpectedRevision(input.expectedRevision, before.revision);

      // Faits canoniques courants, et eux seuls. Même primitive que la vue.
      const current = planCanonicalRecovery({
        manifest: before.manifest,
        state: before.state,
        pendingResponseJournaled: pendingResponseJournaled(before),
      });

      if (current !== input.capability) {
        throw new CcrError(
          'RECOVERY_CAPABILITY_STALE',
          "Les faits du run ont changé depuis votre lecture : l'action demandée n'est plus celle " +
            'que CCR produirait. Rechargez la vue de reprise, puis reconsidérez.',
          { details: { requested: input.capability, current } },
        );
      }

      await hooks.onReadyForEffect?.(input.capability);

      const result = await recoverRunLocked(
        deps,
        runId,
        {
          runId,
          ...(input.acknowledgementText === undefined ? {} : { acknowledge: input.acknowledgementText }),
        },
        [],
        undefined,
        governance,
      );

      const after = await readStableRunSnapshot(deps.runsDir, runId);
      return {
        runId,
        capability: input.capability,
        revisionBefore: before.revision,
        revisionAfter: after.revision,
        result,
      };
    },
    hostLockHooks(deps, runId, LOCK_COMMAND),
  );
}
