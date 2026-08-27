/**
 * Opérations longues — composition sous **un seul** run lock (V2-IMP-38).
 *
 * ## Ordre garanti
 *
 * ```text
 * acquisition du run lock
 * → révision courante
 * → expected_revision
 * → préconditions métier, sans effet
 * → admission cockpit                 ← le créneau se réserve ici
 * → effet V1 complet, fournisseur compris
 * → révision finale
 * → libération du verrou
 * ```
 *
 * Le verrou couvre l'appel fournisseur du début à la fin. C'est ce qui rend la
 * vivacité observable — `OPERATION_IN_FLIGHT` — et ce qui empêche tout autre
 * écrivain CCR de s'intercaler dans un effet long.
 *
 * ## Pourquoi les préconditions précèdent l'admission
 *
 * Un créneau est une ressource rare — deux pour tout le data root. Une requête
 * déjà condamnée par une vue périmée, une session absente ou une source
 * inexistante ne doit pas en immobiliser un. L'ordre de V0.2 §19 est donc
 * respecté à la lettre : claim → préconditions → admission → effet.
 *
 * ## Pourquoi les préconditions ne relisent pas les capacités
 *
 * Le verrou que cette opération vient d'acquérir produit lui-même une évidence
 * d'exécution. Relire la capacité du `RunView` ici serait circulaire : elle
 * verrait `OPERATION_IN_FLIGHT` — provoqué par nous — et refuserait. Les
 * préconditions viennent donc des **gardes métier partagées** avec V1.
 */

import { CcrError } from '../core/errors.ts';
import { withRunLock } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import { assertExpectedRevision, readStableRunSnapshot } from '../store/run-snapshot.ts';
import {
  hostLockHooks,
  precheckLongOperation,
  sendMessageLocked,
  stepRunLocked,
} from './run-service.ts';
import type { RunServiceDeps } from './run-service.ts';
import type { UsageGovernanceWarning } from './usage-governance-writer.ts';
import type { AgentKind } from '../core/run.ts';
import type { LongOperationManager } from '../cockpit/long-operations.ts';

export const LONG_MUTATION_ACTIONS = ['STEP', 'SEND'] as const;
export type LongMutationAction = (typeof LONG_MUTATION_ACTIONS)[number];

const LOCK_COMMAND: Readonly<Record<LongMutationAction, string>> = { STEP: 'step', SEND: 'send' };

export interface LongMutationInput {
  readonly runId: string;
  readonly action: LongMutationAction;
  readonly expectedRevision: string;
  /** `SEND` uniquement. */
  readonly target?: AgentKind;
  readonly content?: string;
}

export interface LongMutationOutcome {
  readonly runId: string;
  readonly action: LongMutationAction;
  readonly revisionBefore: string;
  readonly revisionAfter: string;
  /** Faux lorsque l'opération n'a atteint aucun fournisseur (garde-fou de taille). */
  readonly usedProvider: boolean;
  /**
   * Diagnostic de gouvernance d'usage (`V2.2-IMP-06`).
   *
   * Type de retour, jamais un schéma persisté : le reçu d'opération reste ce
   * qu'il était.
   */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
}

export interface LongMutationHooks {
  /** Appelé une fois le créneau réservé, avant l'effet. Déclenche le `202`. */
  onAdmitted?: (operationId: string) => void;
  /**
   * Couture de test : après le claim, **avant** l'acquisition du run lock.
   *
   * Sans elle, la fenêtre TOCTOU que cette composition referme ne serait
   * éprouvable que de façon probabiliste. Aucun appelant de production ne la
   * fournit.
   */
  beforeLock?: () => void | Promise<void>;
  /** Couture de test : juste avant l'appel fournisseur. */
  beforeProvider?: () => void | Promise<void>;
  /** Couture de test : après l'effet canonique, avant la révision finale. */
  afterEffect?: () => void | Promise<void>;
}

export interface LongMutationDeps {
  readonly runService: RunServiceDeps;
  readonly manager: LongOperationManager;
  readonly operationId: string;
}

export async function applyLongMutation(
  deps: LongMutationDeps,
  input: LongMutationInput,
  hooks: LongMutationHooks = {},
): Promise<LongMutationOutcome> {
  const { runId, action } = input;
  const paths = runPaths(deps.runService.runsDir, runId);

  await hooks.beforeLock?.();

  return withRunLock(
    paths,
    LOCK_COMMAND[action],
    async () => {
      const before = await readStableRunSnapshot(deps.runService.runsDir, runId);
      assertExpectedRevision(input.expectedRevision, before.revision);

      // Préconditions, sans le moindre effet : un refus ici ne consomme rien.
      const plan = await precheckLongOperation(deps.runService, runId, {
        action,
        ...(input.target === undefined ? {} : { agent: input.target }),
      });

      // Le garde-fou de taille produit un effet canonique sans appeler
      // personne : il ne consomme donc pas de créneau, dont l'objet est de
      // borner la concurrence fournisseur.
      const slot = plan.callsProvider ? deps.manager.admit(deps.operationId) : undefined;
      // L accusé 202 ne se déclenche QUE si un créneau a réellement été
      // réservé. Le garde-fou de taille n en prend pas : son verdict est
      // terminal, et l appelant doit le recevoir tel quel, pas un accusé.
      if (slot !== undefined) hooks.onAdmitted?.(deps.operationId);

      try {
        await hooks.beforeProvider?.();
        // Corrélation applicative : une opération HTTP, un identifiant, porté
        // par l'engagement. La CLI n'en a pas, et n'en a pas besoin.
        const correlation = { operationId: deps.operationId };
        let warnings: readonly UsageGovernanceWarning[] = [];
        if (action === 'STEP') {
          warnings = (await stepRunLocked(deps.runService, runId, correlation))
            .usageGovernanceWarnings;
        } else {
          const target = input.target;
          const content = input.content;
          if (target === undefined || content === undefined) {
            throw new CcrError('INVALID_ARGUMENT', 'Cible ou contenu manquant.');
          }
          warnings = (
            await sendMessageLocked(
              deps.runService,
              runId,
              { runId, agent: target, message: content },
              correlation,
            )
          ).usageGovernanceWarnings;
        }
        await hooks.afterEffect?.();

        const after = await readStableRunSnapshot(deps.runService.runsDir, runId);
        return {
          runId,
          action,
          revisionBefore: before.revision,
          revisionAfter: after.revision,
          usedProvider: plan.callsProvider,
          usageGovernanceWarnings: warnings,
        };
      } catch (error) {
        // Une intention qui échoue n implique pas un état inchangé : le
        // garde-fou de taille écrit son événement et passe en WAITING_HUMAN
        // avant de lever. La révision d après se capture donc ici, tant que le
        // verrou protège encore ce que l opération vient de produire.
        try {
          const after = await readStableRunSnapshot(deps.runService.runsDir, runId);
          (error as { revisionAfter?: string }).revisionAfter = after.revision;
        } catch {
          // Lecture impossible : on ne masque jamais l erreur d origine.
        }
        throw error;
      } finally {
        slot?.release();
      }
    },
    hostLockHooks(deps.runService, runId, LOCK_COMMAND[action]),
  );
}
