/**
 * Résolution d'une cible d'expert dans un run natif V2.1 (Slice 2A).
 *
 * Une seule chaîne, et jamais l'inverse :
 *
 * ```text
 * ExpertSlot  →  ProviderBinding  →  NativeSession
 * ```
 *
 * La **cible canonique** est un slot. Le fournisseur n'est jamais une identité
 * métier : il ne sert qu'à retrouver l'adapter et la session. Les syntaxes
 * `claude` / `codex` survivent comme **alias de compatibilité**, résolus contre
 * les bindings réels du run — et elles cèdent quand elles deviennent
 * ambiguës. C'est l'alias qui devient inutilisable, jamais la configuration :
 * un run Claude/Claude reste parfaitement adressable par ses deux slots.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il n'écrit rien, ne verrouille rien, ne construit aucun adapter et ne lance
 * aucun processus. Il ne modifie jamais un binding : une cible indisponible est
 * un refus, jamais une substitution.
 */

import { CcrError } from '../core/errors.ts';
import { EXPERT_SLOT_IDS, isExpertSlotId, isProviderKind } from '../core/expert.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type { NativeRunManifest, NativeRunStateDocument } from '../core/run-native.ts';
import { handoffGuard, sendGuard } from '../core/run-guards.ts';
import type { GuardReason, GuardVerdict, RunGuardFacts } from '../core/run-guards.ts';
import { runPaths } from '../store/layout.ts';
import { readPersistedManifest, readPersistedState } from '../store/native-store.ts';

// --------------------------------------------------------------------------
// Référence de cible
// --------------------------------------------------------------------------

/**
 * Ce qu'un appelant peut désigner.
 *
 * Deux formes **discriminées**, et non une union plate
 * `'author' | 'challenger' | 'claude' | 'codex'` : la seconde laisserait un
 * lecteur croire que les quatre valeurs sont de même nature. Elles ne le sont
 * pas — l'une nomme un acteur du protocole, l'autre un moteur.
 */
export type NativeExpertTargetRef =
  | { readonly kind: 'expert_slot'; readonly value: ExpertSlotId }
  | { readonly kind: 'provider_alias'; readonly value: ProviderKind };

export function expertSlotTarget(slot: ExpertSlotId): NativeExpertTargetRef {
  return { kind: 'expert_slot', value: slot };
}

export function providerAliasTarget(provider: ProviderKind): NativeExpertTargetRef {
  return { kind: 'provider_alias', value: provider };
}

/**
 * Traduit un argument textuel en référence typée.
 *
 * Une seule porte d'entrée pour les surfaces futures — CLI, HTTP, cockpit —
 * afin qu'aucune d'elles ne réinvente la distinction.
 */
export function parseNativeExpertTargetRef(value: string): NativeExpertTargetRef {
  if (isExpertSlotId(value)) return expertSlotTarget(value);
  if (isProviderKind(value)) return providerAliasTarget(value);
  throw new CcrError(
    'INVALID_ARGUMENT',
    `Cible inconnue « ${value} ». Attendu : author, challenger, ou un alias de fournisseur.`,
    { details: { value, expected: [...EXPERT_SLOT_IDS] } },
  );
}

// --------------------------------------------------------------------------
// Résolution
// --------------------------------------------------------------------------

export interface ResolvedNativeExpertTarget {
  readonly expertSlot: ExpertSlotId;
  readonly provider: ProviderKind;
  /** `null` tant qu'aucune session native n'est liée à ce slot. */
  readonly sessionId: string | null;
}

/** Cible exécutable : la session existe. */
export interface ExecutableNativeExpertTarget extends ResolvedNativeExpertTarget {
  readonly sessionId: string;
}

/**
 * Résout un alias de fournisseur contre les bindings réels du run.
 *
 * Trois issues, fermées, sans aucune préférence implicite :
 *
 * ```text
 * exactement 1 slot   → ce slot
 * 0 slot              → PROVIDER_ALIAS_NOT_BOUND
 * 2 slots             → AMBIGUOUS_PROVIDER_ALIAS
 * ```
 *
 * Aucun choix par premier slot, dernier slot, `author` par défaut, ni session
 * la plus récente : toutes ces règles reviendraient à deviner.
 */
export function resolveNativeProviderAlias(
  manifest: NativeRunManifest,
  provider: ProviderKind,
): ExpertSlotId {
  const matches = EXPERT_SLOT_IDS.filter((slot) => manifest.experts[slot].provider === provider);

  if (matches.length === 0) {
    throw new CcrError(
      'PROVIDER_ALIAS_NOT_BOUND',
      `Aucun expert de ce run n'emploie « ${provider} ». Désignez « author » ou « challenger ».`,
      {
        details: {
          runId: manifest.run_id,
          provider,
          bindings: EXPERT_SLOT_IDS.map((slot) => `${slot}=${manifest.experts[slot].provider}`),
        },
      },
    );
  }

  if (matches.length > 1) {
    throw new CcrError(
      'AMBIGUOUS_PROVIDER_ALIAS',
      `Les deux experts de ce run emploient « ${provider} » : l'alias ne désigne personne. ` +
        'Désignez « author » ou « challenger ».',
      { details: { runId: manifest.run_id, provider, slots: [...matches] } },
    );
  }

  return matches[0] as ExpertSlotId;
}

/**
 * Résout une cible, quelle que soit sa forme.
 *
 * Réussit même sans session : connaître le binding d'un slot est une question
 * distincte de savoir s'il est joignable.
 */
export function resolveNativeExpertTarget(
  manifest: NativeRunManifest,
  ref: NativeExpertTargetRef,
): ResolvedNativeExpertTarget {
  const expertSlot = ref.kind === 'expert_slot' ? ref.value : resolveNativeProviderAlias(manifest, ref.value);
  const binding = manifest.experts[expertSlot];
  return { expertSlot, provider: binding.provider, sessionId: binding.session_id };
}

/**
 * Résout une cible **joignable**.
 *
 * Distingue deux refus que rien ne doit confondre :
 *
 * ```text
 * PROVIDER_ALIAS_NOT_BOUND   aucun expert n'emploie ce moteur
 * SESSION_MISSING            l'expert existe, sa session native n'existe pas
 * ```
 *
 * Aucune substitution n'est jamais tentée : un `author` injoignable ne devient
 * pas un `challenger`.
 */
export function requireNativeSessionTarget(
  manifest: NativeRunManifest,
  ref: NativeExpertTargetRef,
): ExecutableNativeExpertTarget {
  const resolved = resolveNativeExpertTarget(manifest, ref);
  if (resolved.sessionId === null) {
    throw new CcrError(
      'SESSION_MISSING',
      `Le run ${manifest.run_id} n'a pas de session native pour « ${resolved.expertSlot} ».`,
      {
        details: {
          runId: manifest.run_id,
          expert_slot: resolved.expertSlot,
          provider: resolved.provider,
        },
      },
    );
  }
  return { ...resolved, sessionId: resolved.sessionId };
}

// --------------------------------------------------------------------------
// Gardes des actions manuelles
// --------------------------------------------------------------------------

export type NativeManualAction = 'SEND' | 'HANDOFF';

export interface NativeManualActionEvaluation {
  readonly action: NativeManualAction;
  readonly verdict: GuardVerdict;
  /** Absente lorsque la cible elle-même n'a pas pu être résolue. */
  readonly target?: ResolvedNativeExpertTarget;
  /** Erreur exacte que le service d'exécution lèvera, inchangée. */
  readonly error?: CcrError;
}

/**
 * Faits de garde d'un run natif.
 *
 * `requiresRecovery` est le prédicat historique du state store —
 * `WAITING_AGENT` **ou** opération en vol persistée. Il n'est ni élargi ni
 * réinterprété : les règles de V2 sont celles qui s'appliquent.
 */
export function nativeGuardFacts(state: NativeRunStateDocument): RunGuardFacts {
  return {
    state: state.state,
    control: state.control,
    requiresRecovery: state.state === 'WAITING_AGENT' || state.pending_operation !== null,
  };
}

/**
 * Évalue les préconditions d'une action manuelle, sans le moindre effet.
 *
 * `SEND` et `HANDOFF` ne partagent pas leurs règles, et ne sont donc pas
 * généralisés : `send` reste disponible sous contrôle humain — envoyer un
 * message n'équivaut jamais à rendre le run à l'automatisation — tandis que
 * `handoff` **exige** le contrôle humain et un état suspendu.
 *
 * Aucune évaluation ne modifie le contrôle : elle constate, elle n'arbitre pas.
 */
export function evaluateNativeManualAction(
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  input: { readonly action: NativeManualAction; readonly ref: NativeExpertTargetRef },
): NativeManualActionEvaluation {
  let target: ResolvedNativeExpertTarget;
  try {
    target = resolveNativeExpertTarget(manifest, input.ref);
  } catch (error) {
    if (!(error instanceof CcrError)) throw error;
    return {
      action: input.action,
      verdict: { kind: 'REFUSED', reason: 'INVALID_ARGUMENT' },
      error,
    };
  }

  const facts = nativeGuardFacts(state);
  const sessionPresent = target.sessionId !== null;
  const verdict =
    input.action === 'SEND' ? sendGuard(facts, sessionPresent) : handoffGuard(facts, sessionPresent);

  if (verdict.kind !== 'REFUSED') return { action: input.action, verdict, target };

  return {
    action: input.action,
    verdict,
    target,
    error: refusalError(manifest.run_id, state, target, input.action, verdict.reason),
  };
}

function refusalError(
  runId: string,
  state: NativeRunStateDocument,
  target: ResolvedNativeExpertTarget,
  action: NativeManualAction,
  reason: GuardReason,
): CcrError {
  const details = {
    runId,
    action,
    expert_slot: target.expertSlot,
    provider: target.provider,
    state: state.state,
    control: state.control,
  };

  switch (reason) {
    case 'SESSION_MISSING':
      return new CcrError(
        'SESSION_MISSING',
        `Le run ${runId} n'a pas de session native pour « ${target.expertSlot} ».`,
        { details },
      );
    case 'HANDOFF_NOT_ALLOWED':
      return new CcrError(
        'HANDOFF_NOT_ALLOWED',
        `Le handoff exige un run sous contrôle humain, suspendu ; le run ${runId} est en ` +
          `${state.state} / ${state.control}.`,
        { details },
      );
    case 'RECOVERY_REQUIRED':
      return new CcrError(
        'RECOVERY_REQUIRED',
        `Le run ${runId} porte une opération engagée : aucune action manuelle avant sa résolution.`,
        { details },
      );
    case 'ILLEGAL_STATE_TRANSITION':
      return new CcrError(
        'ILLEGAL_STATE_TRANSITION',
        `Le run ${runId} est en ${state.state} : aucune action manuelle ne peut en partir.`,
        { details },
      );
    default:
      return new CcrError('INVALID_ARGUMENT', `Action ${action} refusée sur le run ${runId}.`, {
        details: { ...details, reason },
      });
  }
}

// --------------------------------------------------------------------------
// Entrée au niveau du run — lecture seule
// --------------------------------------------------------------------------

export interface NativeTargetResolverDeps {
  readonly runsDir: string;
}

/**
 * Charge un run **natif** et évalue une action manuelle, sans rien écrire.
 *
 * Un run historique est refusé : `send claude` y reste provider-canonique, et
 * V2.1 ne réinterprète pas rétroactivement une commande qui avait un autre
 * sens quand elle a été écrite.
 */
export async function evaluateNativeManualActionForRun(
  deps: NativeTargetResolverDeps,
  runId: string,
  input: { readonly action: NativeManualAction; readonly ref: NativeExpertTargetRef },
): Promise<NativeManualActionEvaluation> {
  const paths = runPaths(deps.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Le run ${runId} est de génération ${persisted.execution_mode} : la résolution native ne le ` +
        'traite pas, et ne réinterprète pas ses commandes historiques.',
      { details: { runId, execution_mode: persisted.execution_mode } },
    );
  }
  const stateDoc = await readPersistedState(paths);
  if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
      details: { runId },
    });
  }
  return evaluateNativeManualAction(persisted.manifest, stateDoc.document, input);
}
