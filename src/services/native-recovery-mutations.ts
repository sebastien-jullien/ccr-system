/**
 * Composition HTTP des reprises natives (V2.1-IMP-17D).
 *
 * ## Ce que ce module n'est pas
 *
 * Ce n'est ni un cinquième moteur de reprise, ni une politique de réparation.
 * Les quatre moteurs restent l'autorité : ils reprennent le verrou, relisent les
 * faits, se reclassifient et décident. Ce module ne fait que composer la
 * précondition de vue et l'admission d'un créneau autour du geste que l'humain
 * a **nommé**.
 *
 * ## Aucune sélection automatique
 *
 * Le geste n'est jamais choisi. Ni « répare ce que tu peux », ni « une seule
 * action disponible, donc celle-là ». Quatre diagnostics peuvent coexister sur
 * le même run, aux conséquences opposées : un acquittement d'incertitude met une
 * source en quarantaine définitive, une clôture avant appel la laisse
 * transférable. Deviner reviendrait à décider à la place de l'humain.
 *
 * ## Le seul geste qui peut engager un fournisseur
 *
 * ```text
 * initialization × CONTINUE   et seulement pour un slot réellement manquant
 * ```
 *
 * Toutes les autres reprises sont locales. `CONTINUE` lui-même l'est souvent —
 * une réponse durable à réconcilier, une liaison à finaliser, un curseur à
 * poser n'appellent personne. Le créneau d'admission n'est donc réservé que
 * lorsque la vue, lue sous le verrou, déclare que ce geste précis appellera.
 */

import { CcrError } from '../core/errors.ts';
import { createExpectedRevisionBoundary } from './native-mutations.ts';
import { projectNativeRunReadModelFromSnapshot } from './native-read-model.ts';
import type { NativeRecoveryActionId } from './native-read-model.ts';
import { isSupportedPair, mayCallProvider, runNativeRecovery } from './native-recovery-dispatch.ts';
import type { NativeRecoveryDomain } from './native-recovery-dispatch.ts';
import type { RunServiceDeps } from './run-service.ts';
import type { LongOperationManager, LongOperationSlot } from '../cockpit/long-operations.ts';
import type { UsageGovernanceWarning } from './usage-governance-writer.ts';

export interface NativeRecoveryMutationDeps {
  readonly runService: RunServiceDeps;
  readonly manager: LongOperationManager;
  readonly operationId: string;
}

export interface NativeRecoveryMutationInput {
  readonly runId: string;
  readonly expectedRevision: string;
  readonly domain: NativeRecoveryDomain;
  readonly action: NativeRecoveryActionId;
  /** Affirmation humaine, transmise **bit pour bit**. Jamais normalisée. */
  readonly note?: string;
}

export interface NativeRecoveryMutationHooks {
  /** Appelé une fois le créneau réservé. Déclenche l'accusé `202`. */
  onAdmitted?: (operationId: string) => void;
}

export interface NativeRecoveryMutationOutcome {
  readonly runId: string;
  readonly domain: NativeRecoveryDomain;
  readonly action: NativeRecoveryActionId;
  readonly revisionBefore: string;
  readonly revisionAfter: string;
  readonly actions: readonly string[];
  /** Diagnostic de gouvernance, non bloquant (V2.2-IMP-05). */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
  /** Vrai lorsqu'un créneau d'admission a réellement été réservé. */
  readonly usedProvider: boolean;
}

/**
 * Applique une reprise native nommée.
 *
 * Ordre garanti, et c'est tout l'objet du module :
 *
 * ```text
 * verrou du moteur  →  snapshot  →  assert revision  →  may_call_provider ?
 *                   →  admit     →  geste            →  revision_after
 *                   →  release   →  unlock
 * ```
 *
 * Une requête dont la vue est périmée n'atteint donc ni classification, ni
 * marqueur, ni fournisseur, ni créneau.
 */
export async function applyNativeRecoveryMutation(
  deps: NativeRecoveryMutationDeps,
  input: NativeRecoveryMutationInput,
  hooks: NativeRecoveryMutationHooks = {},
): Promise<NativeRecoveryMutationOutcome> {
  if (!isSupportedPair(input.domain, input.action)) {
    // Inatteignable par la surface HTTP, qui valide la matrice avant le claim.
    throw new CcrError('INVALID_ARGUMENT', 'Couple domaine/geste inconnu.', {
      details: { domain: input.domain, action: input.action },
    });
  }

  let slot: LongOperationSlot | undefined;
  let usedProvider = false;

  const { boundary, revisions } = createExpectedRevisionBoundary({
    runsDir: deps.runService.runsDir,
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    onChecked: async (snapshot) => {
      // Un seul couple peut appeler ; inutile de projeter pour les autres.
      if (!mayCallProvider(input.domain, input.action)) return;
      // Lecture du **même** instantané, déjà capturé sous le verrou. Elle ne
      // sert qu'à l'admission : la primitive reste seule autorité sur ce que le
      // geste est autorisé à faire, et se reclassifie elle-même.
      const view = await projectNativeRunReadModelFromSnapshot(
        snapshot,
        deps.runService.maxTransferBytes,
      );
      const projected = view.recovery.initialization.available_actions.find(
        (candidate) => candidate.action === input.action,
      );
      if (projected?.may_call_provider !== true) return;
      usedProvider = true;
      slot = deps.manager.admit(deps.operationId);
      hooks.onAdmitted?.(deps.operationId);
    },
  });

  try {
    const summary = await runNativeRecovery(
      deps.runService,
      input.runId,
      input.domain,
      input.action,
      input.note,
      boundary,
      // Une opération de reprise vaut jusqu'à deux invocations : les deux
      // enregistrements portent le même identifiant (V2.2-IMP-05).
      { operationId: deps.operationId },
    );

    if (revisions.before === undefined || revisions.after === undefined) {
      throw new CcrError('STATE_INVALID', `Révision non observée pour le run ${input.runId}.`, {
        details: { runId: input.runId },
      });
    }
    return {
      runId: input.runId,
      domain: input.domain,
      action: input.action,
      revisionBefore: revisions.before,
      revisionAfter: revisions.after,
      actions: summary.actions,
      usageGovernanceWarnings: summary.usageGovernanceWarnings,
      usedProvider,
    };
  } catch (error) {
    // Une reprise peut écrire un marqueur puis lever : la révision d'après,
    // capturée sous le verrou par `SETTLED`, décrit alors l'état réellement
    // obtenu. Même contrat qu'en 2F.2.
    if (revisions.after !== undefined) {
      (error as { revisionAfter?: string }).revisionAfter = revisions.after;
    }
    throw error;
  } finally {
    slot?.release();
  }
}
