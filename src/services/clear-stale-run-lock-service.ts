/**
 * Levée d'un verrou de run périmé — primitive destructive (V2-IMP-40).
 *
 * La seule opération de CCR qui **supprime** quelque chose. Elle est donc la
 * plus étroite du produit : elle enlève un fichier de verrou, et rien d'autre.
 * Aucun fait canonique n'est touché — ni événement, ni décision, ni état, ni
 * manifest. La révision du run est identique avant et après.
 *
 * ## Ce qu'elle n'appelle jamais
 *
 * ```text
 * recoverRun · recoverRunLocked · applyCanonicalRecovery
 * LongOperationManager · adaptateur d'agent · withRunLock
 * ```
 *
 * Pas de `withRunLock` en particulier : on ne verrouille pas ce qu'on
 * s'apprête à lever. La sûreté ne vient pas de l'exclusion mais de l'identité,
 * revérifiée immédiatement avant la suppression.
 *
 * ## Deux conditions, jamais une seule
 *
 * ```text
 * classification robuste courante ∈ { STALE_LOCK, ORPHAN_SAME_PID_LOCK }
 * ET identité exactement égale à celle que l'humain a observée
 * ```
 *
 * La première dit que le verrou est mort ; la seconde, que c'est bien **ce**
 * verrou-là. Un jeton qui correspond ne prouve pas la mort ; une mort
 * démontrée ne prouve pas qu'il s'agit du même verrou. Une demande humaine
 * portait sur `L1`, jamais sur « n'importe quel verrou périmé à ce chemin ».
 *
 * ## Pourquoi une seconde relecture
 *
 * Entre la classification et le `unlink`, un verrou peut tourner : `L1`
 * disparaît, `L2` naît. Sans relecture, on supprimerait le verrou vivant d'une
 * opération qui vient de commencer. C'est la transposition exacte des six
 * conditions cumulatives déjà validées pour `server.lock`.
 */

import { unlink } from 'node:fs/promises';

import { CcrError } from '../core/errors.ts';
import { isRunId } from '../core/ids.ts';
import { isLockToken, lockTokenFor } from '../lock/lock-token.ts';
import { observeRunExecution } from '../lock/run-execution-evidence.ts';
import type { RunLockObservation } from '../lock/run-execution-evidence.ts';
import { lockFilePath, readRunLock } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import type { HostOperationRegistry } from '../lock/host-operation-registry.ts';

/**
 * Les deux seules observations depuis lesquelles une levée est sûre.
 *
 * `ORPHAN_SAME_PID_LOCK` n'est pas « le PID est vivant, donc supprimable ». Ce
 * verdict vient de l'analyse 0D complète : aucune opération hôte ne correspond
 * exactement à ce couple `(runId, lock_id)`, et le même `lock_id` a été
 * reconfirmé sur deux observations consécutives. Le service consomme ce
 * verdict ; il ne rejoue aucune règle de PID pour son compte.
 */
const CLEARABLE: readonly RunLockObservation[] = ['STALE_LOCK', 'ORPHAN_SAME_PID_LOCK'];

export interface ClearStaleRunLockDeps {
  readonly runsDir: string;
  /** Registre de l'hôte, lorsqu'il existe. Sa présence affine la classification. */
  readonly hostRegistry?: HostOperationRegistry;
}

export interface ClearStaleRunLockInput {
  readonly runId: string;
  /** Identité opaque du verrou observé — `lt1:…`, jamais un chemin ni un PID. */
  readonly observedLockToken: string;
}

export interface ClearStaleRunLockHooks {
  /**
   * Couture de test : classification faite et identité confirmée, avant la
   * relecture destructive.
   *
   * Elle existe pour rendre la rotation `L1 → L2` déterministe. Aucun appelant
   * de production ne la fournit.
   */
  readonly beforeUnlink?: () => void | Promise<void>;
  /**
   * Couture de test : le verrou vient d'être supprimé, et aucun reçu terminal
   * n'a encore été écrit.
   *
   * C'est le seul instant où un arrêt brutal laisse un effet accompli sans
   * trace de son verdict. Aucun appelant de production ne la fournit.
   */
  readonly afterCleared?: () => void | Promise<void>;
}

export interface ClearStaleRunLockOutcome {
  readonly runId: string;
  readonly cleared: true;
}

function notClearable(observation: RunLockObservation): CcrError {
  return new CcrError(
    'RECOVERY_LOCK_NOT_CLEARABLE',
    "Ce verrou n'est pas levable : il est vivant, étranger, indéterminé ou absent. " +
      'CCR ne supprime que ce dont il peut démontrer la mort.',
    { details: { observation } },
  );
}

function changed(reason: string): CcrError {
  return new CcrError(
    'RECOVERY_LOCK_CHANGED',
    "Le verrou présent n'est plus exactement celui qui a été observé. Rien n'a été supprimé : " +
      'rechargez la vue de reprise avant de recommencer.',
    { details: { reason } },
  );
}

export async function clearStaleRunLock(
  deps: ClearStaleRunLockDeps,
  input: ClearStaleRunLockInput,
  hooks: ClearStaleRunLockHooks = {},
): Promise<ClearStaleRunLockOutcome> {
  if (!isRunId(input.runId)) {
    throw new CcrError('INVALID_ARGUMENT', 'Identifiant de run non canonique.');
  }
  // Un jeton mal formé n'atteint jamais le système de fichiers.
  if (!isLockToken(input.observedLockToken)) {
    throw new CcrError('INVALID_ARGUMENT', "Jeton d'identité de verrou mal formé.");
  }

  // Le chemin dérive du `runId` validé et du layout — jamais de l'appelant.
  const paths = runPaths(deps.runsDir, input.runId);

  // Observation **robuste** : reconfirmation 0D comprise. `options.lock` n'est
  // jamais fourni — il court-circuiterait précisément cette reconfirmation.
  const observed = await observeRunExecution(paths, {
    ...(deps.hostRegistry === undefined ? {} : { registry: deps.hostRegistry }),
  });

  if (!CLEARABLE.includes(observed.observation) || observed.lock === undefined) {
    throw notClearable(observed.observation);
  }

  const currentToken = lockTokenFor(input.runId, observed.lock);
  if (currentToken !== input.observedLockToken) {
    throw changed('identité différente de celle observée');
  }

  await hooks.beforeUnlink?.();

  // Relecture destructive. Le verrou a pu tourner depuis la classification ;
  // se fier à l'instantané précédent reviendrait à supprimer le verrou vivant
  // d'une opération qui vient de commencer.
  let finalLock;
  try {
    finalLock = await readRunLock(paths);
  } catch {
    throw changed('verrou devenu illisible avant la suppression');
  }
  if (finalLock === undefined) throw changed('verrou disparu avant la suppression');
  if (lockTokenFor(input.runId, finalLock) !== input.observedLockToken) {
    throw changed('identité modifiée entre la vérification et la suppression');
  }

  await unlink(lockFilePath(paths));
  await hooks.afterCleared?.();
  return { runId: input.runId, cleared: true };
}
