/**
 * Aiguillage des reprises natives — réexport (Slice 2E-R).
 *
 * La matrice `domaine × geste` a rejoint `src/services/` en V2.1-IMP-17D : le
 * transport HTTP pose la même question, et l'y faire dépendre de la CLI aurait
 * inversé la dépendance. Rien du comportement ne change.
 */

export {
  isNativeRecoveryDomain,
  isSupportedPair,
  mayCallProvider,
  nativeRecoveryActionOf,
  requiresNote,
  runNativeRecovery,
  slugsOf,
  unsupportedPairError,
  NATIVE_RECOVERY_ACTION_SLUGS,
  NATIVE_RECOVERY_DOMAINS,
} from '../services/native-recovery-dispatch.ts';
export type {
  NativeRecoveryDomain,
  NativeRecoveryOutcomeSummary,
} from '../services/native-recovery-dispatch.ts';
