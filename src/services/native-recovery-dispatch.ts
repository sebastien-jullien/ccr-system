/**
 * Aiguillage des reprises natives — matrice `domaine × geste` (Slice 2E-R).
 *
 * Déplacé de `src/cli/` en V2.1-IMP-17D : le transport HTTP pose exactement la
 * même question, et l'y faire dépendre de la CLI aurait inversé la dépendance.
 * Le module n'a jamais rien connu de la ligne de commande — il ne nomme que des
 * primitives de service.
 *
 * Le moteur historique n'a qu'une reprise ; le natif en a **quatre**, aux
 * statuts, aux gestes et aux conséquences différents — et plusieurs
 * diagnostics peuvent coexister sur le même run. Deviner lequel réparer serait
 * choisir à la place de l'humain.
 *
 * Toute mutation native nomme donc explicitement son domaine **et** son geste :
 *
 * ```text
 * ccr recover --run <id> --domain <domaine> --action <geste> [--note <texte>]
 * ```
 *
 * Ce module ne décide de rien d'autre que la validité **syntaxique** du couple.
 * La disponibilité réelle d'un geste appartient à la primitive appelée, qui
 * reprend le verrou, relit les faits et se reclassifie avant d'agir. Aucune
 * exécution ne s'appuie sur un instantané de lecture.
 */

import { CcrError } from '../core/errors.ts';
import {
  acknowledgeNativeUncertainty,
  continueNativeInitialization,
} from './native-recovery-service.ts';
import {
  acknowledgeNativeStepUncertainty,
  finalizeNativeStepRecovery,
} from './native-step-recovery-service.ts';
import {
  abortNativeSendBeforeProvider,
  acknowledgeNativeSendUncertainty,
  finalizeNativeSendRecovery,
} from './native-send-recovery-service.ts';
import {
  abortNativeHandoffBeforeInteractive,
  acknowledgeNativeHandoffUncertainty,
  finalizeNativeHandoffRecovery,
} from './native-handoff-recovery-service.ts';
import type { NativeRecoveryActionId } from './native-read-model.ts';
import type { RunServiceDeps } from './run-service.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import type { NativeStartCorrelation } from './native-start-service.ts';
import type { UsageGovernanceWarning } from './usage-governance-writer.ts';

export const NATIVE_RECOVERY_DOMAINS = ['initialization', 'step', 'send', 'handoff'] as const;
export type NativeRecoveryDomain = (typeof NATIVE_RECOVERY_DOMAINS)[number];

/**
 * Représentation CLI des identifiants gelés en 2D.
 *
 * Une seule taxonomie : ces slugs ne sont qu'une écriture en ligne de commande
 * des `NativeRecoveryActionId`, et la table ci-dessous est leur unique pont.
 */
export const NATIVE_RECOVERY_ACTION_SLUGS: Readonly<Record<string, NativeRecoveryActionId>> = {
  continue: 'CONTINUE',
  finalize: 'FINALIZE',
  'acknowledge-uncertainty': 'ACKNOWLEDGE_UNCERTAINTY',
  'abort-before-provider': 'ABORT_BEFORE_PROVIDER',
  'abort-before-interactive': 'ABORT_BEFORE_INTERACTIVE',
};

/**
 * Couples réellement servis par une primitive exportée.
 *
 * Cette matrice est le miroir des services de reprise, et non une déduction
 * depuis le nom d'un statut : un couple absent ici ne correspond à aucun code
 * exécutable, et son refus est donc une erreur d'usage — jamais une
 * approximation vers un geste voisin.
 */
const MATRIX: Readonly<Record<NativeRecoveryDomain, readonly NativeRecoveryActionId[]>> = {
  initialization: ['CONTINUE', 'ACKNOWLEDGE_UNCERTAINTY'],
  step: ['FINALIZE', 'ACKNOWLEDGE_UNCERTAINTY'],
  send: ['ABORT_BEFORE_PROVIDER', 'FINALIZE', 'ACKNOWLEDGE_UNCERTAINTY'],
  handoff: ['ABORT_BEFORE_INTERACTIVE', 'FINALIZE', 'ACKNOWLEDGE_UNCERTAINTY'],
};

/** Gestes exigeant une affirmation humaine écrite. */
export function requiresNote(action: NativeRecoveryActionId): boolean {
  return action === 'ACKNOWLEDGE_UNCERTAINTY';
}

/** Gestes susceptibles d'engager un fournisseur — un seul, et il est nommé. */
export function mayCallProvider(domain: NativeRecoveryDomain, action: NativeRecoveryActionId): boolean {
  return domain === 'initialization' && action === 'CONTINUE';
}

export function isNativeRecoveryDomain(value: string): value is NativeRecoveryDomain {
  return (NATIVE_RECOVERY_DOMAINS as readonly string[]).includes(value);
}

export function nativeRecoveryActionOf(slug: string): NativeRecoveryActionId | undefined {
  return NATIVE_RECOVERY_ACTION_SLUGS[slug];
}

export function isSupportedPair(domain: NativeRecoveryDomain, action: NativeRecoveryActionId): boolean {
  return MATRIX[domain].includes(action);
}

/** Gestes exécutables d'un domaine, en slugs, pour l'aide et les messages. */
export function slugsOf(domain: NativeRecoveryDomain): readonly string[] {
  return Object.entries(NATIVE_RECOVERY_ACTION_SLUGS)
    .filter(([, action]) => MATRIX[domain].includes(action))
    .map(([slug]) => slug);
}

export interface NativeRecoveryOutcomeSummary {
  readonly runId: string;
  readonly domain: NativeRecoveryDomain;
  readonly action: NativeRecoveryActionId;
  readonly actions: readonly string[];
  /**
   * Échecs de gouvernance d'usage (V2.2-IMP-05).
   *
   * Vide pour les gestes qui n'appellent aucun fournisseur — c'est-à-dire pour
   * tous, sauf la continuation d'initialisation.
   */
  readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
}

/**
 * Exécute le geste nommé, en déléguant à la primitive qui en est responsable.
 *
 * Les trois domaines autres que l'initialisation reçoivent des dépendances
 * **sans fabrique d'adapter** : ce n'est pas une convention de relecture, c'est
 * ce que leur contrat déclare, et la CLI ne leur en transmet donc aucune.
 */
export async function runNativeRecovery(
  deps: RunServiceDeps,
  runId: string,
  domain: NativeRecoveryDomain,
  action: NativeRecoveryActionId,
  note: string | undefined,
  boundary?: NativeMutationBoundary,
  correlation: NativeStartCorrelation = {},
): Promise<NativeRecoveryOutcomeSummary> {
  const local = { runsDir: deps.runsDir, now: deps.now };
  const summarize = (actions: readonly string[]): NativeRecoveryOutcomeSummary => ({
    runId,
    domain,
    action,
    actions: [...actions],
    usageGovernanceWarnings: [],
  });

  /** Même résumé, en conservant le diagnostic d'usage de la continuation. */
  const summarizeOutcome = (outcome: {
    readonly actions: readonly string[];
    readonly usageGovernanceWarnings: readonly UsageGovernanceWarning[];
  }): NativeRecoveryOutcomeSummary => ({
    ...summarize(outcome.actions),
    usageGovernanceWarnings: outcome.usageGovernanceWarnings,
  });

  if (domain === 'initialization') {
    if (action === 'CONTINUE') {
      // Seul geste de reprise pouvant engager un fournisseur, et seulement
      // pour les slots que 1D établit réellement manquants.
      // Corrélation, jamais autorité : elle voyage explicitement, et une
      // reprise lancée depuis la CLI n'en a aucune (V2.2-IMP-05).
      return summarizeOutcome(
        await continueNativeInitialization(deps, runId, { correlation }, boundary),
      );
    }
    return summarize((await acknowledgeNativeUncertainty(deps, runId, note ?? '', boundary)).actions);
  }

  if (domain === 'step') {
    if (action === 'FINALIZE') return summarize((await finalizeNativeStepRecovery(local, runId, {}, boundary)).actions);
    return summarize((await acknowledgeNativeStepUncertainty(local, runId, note ?? '', boundary)).actions);
  }

  if (domain === 'send') {
    if (action === 'ABORT_BEFORE_PROVIDER') {
      return summarize((await abortNativeSendBeforeProvider(local, runId, {}, boundary)).actions);
    }
    if (action === 'FINALIZE') return summarize((await finalizeNativeSendRecovery(local, runId, boundary)).actions);
    return summarize((await acknowledgeNativeSendUncertainty(local, runId, note ?? '', {}, boundary)).actions);
  }

  if (action === 'ABORT_BEFORE_INTERACTIVE') {
    return summarize((await abortNativeHandoffBeforeInteractive(local, runId, {}, boundary)).actions);
  }
  if (action === 'FINALIZE') return summarize((await finalizeNativeHandoffRecovery(local, runId, boundary)).actions);
  return summarize((await acknowledgeNativeHandoffUncertainty(local, runId, note ?? '', {}, boundary)).actions);
}

/** Couple inconnu : aucune primitive ne le sert, et rien n'est approché. */
export function unsupportedPairError(
  domain: NativeRecoveryDomain,
  action: NativeRecoveryActionId,
): CcrError {
  return new CcrError(
    'INVALID_ARGUMENT',
    `Le geste « ${action} » n'existe pas pour le domaine « ${domain} ». ` +
      `Gestes de ce domaine : ${slugsOf(domain).join(', ')}.`,
    { details: { domain, action, supported: [...MATRIX[domain]] } },
  );
}
