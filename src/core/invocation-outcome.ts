/**
 * Domaine — issue négative terminale d'une invocation engagée.
 *
 * Formes et validations **pures**. Aucune IO, aucun accès disque, aucun
 * service, aucun fournisseur.
 *
 * ## L'autorité de cette source, et elle seule
 *
 * ```text
 * ce que CCR a établi DÉTERMINISTEMENT comme issue terminale NÉGATIVE
 * d'une invocation DÉJÀ ENGAGÉE
 * ```
 *
 * Distincte des trois autorités voisines, qu'elle ne remplace ni ne duplique :
 *
 * ```text
 * invocations.jsonl   ce que CCR s'est engagé à TENTER
 * usage.jsonl         ce qu'un tiers a OBSERVÉ d'une exécution
 * events.jsonl        le transcript natif et ses événements d'exécution
 * ```
 *
 * Les deux derniers axes sont **orthogonaux** au présent : une invocation peut
 * porter `RESPONSE_RECEIVED` côté usage — le fournisseur a répondu, le
 * processus est sorti en 0 — et une issue de domaine négative ici. Les
 * confondre effacerait cette orthogonalité.
 *
 * ## Aucune taxonomie universelle d'échec
 *
 * `terminal_negative_outcome` est une **union discriminée fermée** qui préserve
 * la sémantique native de l'opération d'origine. Les vocabulaires de motif de
 * V3, V4 et V5 diffèrent réellement — 5, 6 et 15 valeurs — et ne sont pas
 * fusionnés parce que certains noms coïncident.
 *
 * ```text
 * V5 OUTPUT_UNPARSABLE      le JSON demandé au modèle est illisible
 * AGENT_OUTPUT_UNPARSABLE   l'enveloppe de la CLI fournisseur est illisible
 * ```
 *
 * Deux faits différents portant un nom voisin. Aucun code de ce module ne les
 * rapproche.
 *
 * ## Ce que ce module n'affirme jamais
 *
 * ```text
 * aucune origine sémantique      ce fait est une observation de procédure CCR
 * aucune autorité humaine        ni adoption, ni clôture, ni vainqueur
 * aucun contenu fournisseur      ni prompt, ni réponse, ni sortie brute
 * aucune cause inventée          un motif inconnu reste ABSENT
 * ```
 *
 * ## `trigger_kind` n'est pas dupliqué
 *
 * `InvocationDispatchRecord.trigger_kind` en fait autorité, et `invocation_id`
 * en est la clé. Le recopier ici créerait une seconde source pour un fait déjà
 * établi ailleurs.
 */

import { CcrError } from './errors.ts';
import { EXPERT_SLOT_IDS, PROVIDER_KINDS } from './expert.ts';
import type { ExpertSlotId, ProviderKind } from './expert.ts';
import { parseInvocationSequence } from './usage-governance.ts';

/** Version du document d'issues. Sans rapport avec celle des autres journaux. */
export const INVOCATION_OUTCOME_SCHEMA_VERSION = 1;

// --------------------------------------------------------------------------
// Vocabulaires natifs — recopiés en tant que valeurs, jamais fusionnés
// --------------------------------------------------------------------------

/**
 * Motifs de refus du parseur V3, tels que `controversy-detector.ts` les nomme.
 *
 * Déclarés ici en **valeur littérale** plutôt qu'importés du service : ce
 * module est du domaine pur et ne dépend d'aucun service. Un test de conformité
 * croisée les épingle l'un à l'autre.
 */
export const V3_DETECTION_REASONS = [
  'OUTPUT_TOO_LARGE',
  'INVALID_JSON',
  'UNSUPPORTED_OUTPUT_VERSION',
  'INVALID_OUTPUT_SHAPE',
  'INVALID_PROPOSAL',
] as const;
export type V3DetectionReason = (typeof V3_DETECTION_REASONS)[number];

/** Motifs de refus du parseur V4. Six valeurs — le sur-ensemble de V3. */
export const V4_ADDUCTION_REASONS = [
  'OUTPUT_TOO_LARGE',
  'INVALID_JSON',
  'UNSUPPORTED_OUTPUT_VERSION',
  'INVALID_OUTPUT_SHAPE',
  'INVALID_PROPOSAL',
  'DUPLICATE_PROPOSAL',
] as const;
export type V4AdductionReason = (typeof V4_ADDUCTION_REASONS)[number];

/** Motifs de refus du parseur V5. Quinze valeurs, dans l'ordre du contrat. */
export const V5_PROPOSAL_REASONS = [
  'OUTPUT_TOO_LARGE',
  'OUTPUT_UNPARSABLE',
  'UNSUPPORTED_VERSION',
  'INVALID_ENVELOPE',
  'INVALID_PROPOSAL',
  'DUPLICATE_PROPOSAL',
  'UNKNOWN_TARGET',
  'INVALID_SCOPE',
  'RANKED_OPTIONS',
  'SCORE_FIELD_PRESENT',
  'CLOSURE_CLAIMED',
  'CLOSURE_WITHDRAWAL_CLAIMED',
  'SUPERSESSION_CLAIMED',
  'HUMAN_DECISION_CLAIMED',
  'AUTHORITATIVE_EFFECT_CLAIMED',
] as const;
export type V5ProposalReason = (typeof V5_PROPOSAL_REASONS)[number];

/** Contrôles de revalidation V5. */
export const V5_REVALIDATION_CHECKS = ['R0', 'SCOPE', 'SUBMITTED_SET', 'CANONICAL_FORM'] as const;
export type V5RevalidationCheck = (typeof V5_REVALIDATION_CHECKS)[number];

// --------------------------------------------------------------------------
// Union discriminée fermée
// --------------------------------------------------------------------------

/**
 * Discriminants de l'union.
 *
 * `NATIVE_PROCESS_FAILED` est une **représentation de stockage**, introduite
 * par ce module. Les flux natifs — `START`, `SEND`, `STEP`,
 * `RECOVERY_CONTINUE` — n'ont jamais rendu d'union produit portant ce nom : ils
 * **lèvent**, après avoir journalisé un événement `process_failed` dont
 * `details.code` porte le code `CcrError`, ou `UNEXPECTED`. Ce discriminant
 * nomme ce fait natif pour le rendre stockable ; il ne prétend pas qu'il ait
 * jamais existé comme membre d'union dans le produit.
 */
export const TERMINAL_NEGATIVE_OUTCOME_KINDS = [
  'V3_INVALID_OUTPUT',
  'V3_PROVIDER_FAILED',
  'V4_INVALID_OUTPUT',
  'V4_REVALIDATION_REFUSED',
  'V4_PROVIDER_FAILED',
  'V5_INVALID_OUTPUT',
  'V5_REVALIDATION_REFUSED',
  'V5_PROVIDER_FAILED',
  'NATIVE_PROCESS_FAILED',
] as const;
export type TerminalNegativeOutcomeKind = (typeof TERMINAL_NEGATIVE_OUTCOME_KINDS)[number];

/**
 * Détail typé d'un échec natif que **CCR construit lui-même**.
 *
 * ## Pourquoi une union fermée, et pourquoi si peu de membres
 *
 * Les flux natifs voient deux familles d'erreurs, qui n'ont pas le même statut
 * épistémique :
 *
 * ```text
 * levée par l'ADAPTATEUR   AGENT_TIMEOUT, AGENT_EXIT_NONZERO,
 *                          AGENT_OUTPUT_UNPARSABLE, AGENT_REPORTED_ERROR,
 *                          AGENT_SESSION_ID_MISSING, AGENT_RESULT_MISSING,
 *                          AGENT_OUTPUT_INCOMPLETE, AGENT_EXECUTABLE_UNRESOLVED
 *
 * construite par CCR       SESSION_ID_COLLISION      (START, RECOVERY_CONTINUE)
 *                          AGENT_SESSION_MISMATCH    (SEND, STEP)
 * ```
 *
 * Les premières portent un sac de diagnostic **propre au fournisseur** —
 * `command`, `stderrTail`, `preview`, `subtype`, `agentMessage`. Le recopier
 * ici ferait apprendre au domaine la forme de sortie des CLI, exactement ce que
 * la frontière d'adaptateur interdit, et exigerait le sac générique que ce
 * module refuse. Ce matériau reste où il appartient : dans
 * `process_failed.details`, comme preuve de diagnostic.
 *
 * Les secondes sont des faits que **CCR a établis**, dont il connaît la
 * structure exacte parce qu'il l'a écrite. Les réduire à leur seul code
 * perdrait l'information que CCR possède réellement.
 *
 * Le discriminant `code` est le code `CcrError` de l'erreur d'origine : le
 * détail n'introduit aucune classification concurrente, il précise le fait
 * natif sans le reclasser.
 */
export type NativeFailureDetail =
  | {
      readonly code: 'SESSION_ID_COLLISION';
      readonly expert_slot: ExpertSlotId;
      readonly provider: ProviderKind;
      /** La session que le fournisseur a rendue, déjà liée à l'autre expert. */
      readonly session_id: string;
    }
  | {
      readonly code: 'AGENT_SESSION_MISMATCH';
      readonly expert_slot: ExpertSlotId;
      readonly provider: ProviderKind;
      /** La session que CCR reprenait. */
      readonly expected_session_id: string;
      /** Celle sous laquelle la réponse est arrivée. */
      readonly found_session_id: string;
    };

/** Codes natifs pour lesquels un détail typé existe. */
export const NATIVE_FAILURE_DETAIL_CODES = ['SESSION_ID_COLLISION', 'AGENT_SESSION_MISMATCH'] as const;
export type NativeFailureDetailCode = (typeof NATIVE_FAILURE_DETAIL_CODES)[number];

/**
 * Issue négative terminale, telle que l'opération d'origine l'a produite.
 *
 * Chaque variante porte ses champs **typés**. Aucun sac générique : ni
 * `detail: unknown`, ni `metadata`, ni motif en chaîne libre.
 *
 * `error_code` est **facultatif partout**, et son absence a un sens exact :
 * CCR n'a pas de code natif significatif. `UNEXPECTED` — le littéral de repli
 * de `errorDetails` et du dispatch assisté — n'est jamais recopié ici : ce
 * n'est pas une cause, c'est un aveu d'ignorance, et l'omission le dit mieux.
 *
 * `native_detail` précise un fait natif **sans jamais le reclasser** : le
 * discriminant de premier niveau reste `NATIVE_PROCESS_FAILED`. Quand il est
 * présent, `error_code` vaut son `code` — l'égalité est vérifiée à la
 * validation, et garantie par construction côté écriture, si bien que les deux
 * ne peuvent pas diverger. Un lecteur qui ne veut que le code n'a donc jamais
 * à brancher.
 */
export type TerminalNegativeOutcome =
  | { readonly kind: 'V3_INVALID_OUTPUT'; readonly reason: V3DetectionReason; readonly at: string }
  | { readonly kind: 'V3_PROVIDER_FAILED'; readonly error_code?: string }
  | { readonly kind: 'V4_INVALID_OUTPUT'; readonly reason: V4AdductionReason; readonly at: string }
  | { readonly kind: 'V4_REVALIDATION_REFUSED'; readonly check: string; readonly detail: string }
  | { readonly kind: 'V4_PROVIDER_FAILED'; readonly error_code?: string }
  | { readonly kind: 'V5_INVALID_OUTPUT'; readonly reason: V5ProposalReason; readonly at: string }
  | {
      readonly kind: 'V5_REVALIDATION_REFUSED';
      readonly check: V5RevalidationCheck;
      readonly detail: string;
    }
  | { readonly kind: 'V5_PROVIDER_FAILED'; readonly error_code?: string }
  | {
      readonly kind: 'NATIVE_PROCESS_FAILED';
      readonly error_code?: string;
      readonly native_detail?: NativeFailureDetail;
    };

/**
 * Représentation stockable du fait négatif que les flux natifs produisent.
 *
 * `START`, `SEND`, `STEP` et `RECOVERY_CONTINUE` ne rendent **aucune** union de
 * résultat : ils lèvent, après avoir journalisé `process_failed` dont
 * `details.code` porte le code `CcrError` lorsqu'il en existe un.
 * `NATIVE_PROCESS_FAILED` nomme ce fait pour le rendre stockable ; il ne
 * prétend pas avoir jamais existé comme membre d'union dans le produit.
 *
 * `error_code` n'est porté que lorsqu'une `CcrError` en fournit un. Une erreur
 * quelconque n'en produit aucun : l'omission dit « CCR ne connaît pas la
 * cause », là où un littéral de repli ferait passer une ignorance pour un
 * diagnostic.
 *
 * `detail` n'est fourni que par les sites où **CCR construit lui-même** le fait
 * natif, et il porte alors le code : l'issue le recopie depuis le détail plutôt
 * que depuis l'erreur, si bien qu'aucune divergence entre les deux n'est
 * représentable.
 */
export function nativeProcessFailedOutcome(
  error: unknown,
  detail?: NativeFailureDetail,
): TerminalNegativeOutcome {
  if (detail !== undefined) {
    return { kind: 'NATIVE_PROCESS_FAILED', error_code: detail.code, native_detail: detail };
  }
  return error instanceof CcrError
    ? { kind: 'NATIVE_PROCESS_FAILED', error_code: error.code }
    : { kind: 'NATIVE_PROCESS_FAILED' };
}

/** Un fait durable, clé par invocation. */
export interface InvocationOutcomeRecord {
  readonly schema_version: number;
  readonly invocation_id: string;
  readonly recorded_at: string;
  readonly terminal_negative_outcome: TerminalNegativeOutcome;
}

/**
 * Document canonique complet.
 *
 * Une **collection clavetée** : le doublon d'`invocation_id` n'y est pas
 * représentable deux fois, et la vérification d'unicité reste explicite à
 * l'écriture plutôt que déléguée à la forme.
 */
export interface InvocationOutcomeDocument {
  readonly schema_version: number;
  readonly outcomes: readonly InvocationOutcomeRecord[];
}

/** Document vide — la forme d'un run sans aucune issue négative. */
export function emptyInvocationOutcomeDocument(): InvocationOutcomeDocument {
  return { schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION, outcomes: [] };
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

function invalid(message: string, details: Record<string, unknown> = {}): CcrError {
  return new CcrError('JOURNAL_INVALID', `invocation-outcomes.json : ${message}`, { details });
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${path} doit être une chaîne non vide.`, { field: path });
  }
  return value;
}

function requireClosed<T extends string>(value: unknown, vocabulary: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(vocabulary as readonly string[]).includes(value)) {
    throw invalid(`${path} inconnu (${String(value)}).`, { field: path });
  }
  return value as T;
}

function optionalErrorCode(record: Record<string, unknown>, path: string): string | undefined {
  if (!('error_code' in record) || record['error_code'] === undefined) return undefined;
  return requireNonEmptyString(record['error_code'], `${path}.error_code`);
}

function requireOnly(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw invalid(`${path}.${key} n'est pas un champ admis.`, { field: key });
  }
}

/** Valide une issue et la rend telle quelle. Fonction pure. */
export function validateTerminalNegativeOutcome(value: unknown): TerminalNegativeOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('terminal_negative_outcome doit être un objet.');
  }
  const record = value as Record<string, unknown>;
  const kind = requireClosed(record['kind'], TERMINAL_NEGATIVE_OUTCOME_KINDS, 'terminal_negative_outcome.kind');
  const at = 'terminal_negative_outcome';

  switch (kind) {
    case 'V3_INVALID_OUTPUT':
      requireOnly(record, ['kind', 'reason', 'at'], at);
      return {
        kind,
        reason: requireClosed(record['reason'], V3_DETECTION_REASONS, `${at}.reason`),
        at: requireNonEmptyString(record['at'], `${at}.at`),
      };
    case 'V4_INVALID_OUTPUT':
      requireOnly(record, ['kind', 'reason', 'at'], at);
      return {
        kind,
        reason: requireClosed(record['reason'], V4_ADDUCTION_REASONS, `${at}.reason`),
        at: requireNonEmptyString(record['at'], `${at}.at`),
      };
    case 'V5_INVALID_OUTPUT':
      requireOnly(record, ['kind', 'reason', 'at'], at);
      return {
        kind,
        reason: requireClosed(record['reason'], V5_PROPOSAL_REASONS, `${at}.reason`),
        at: requireNonEmptyString(record['at'], `${at}.at`),
      };
    case 'V4_REVALIDATION_REFUSED':
      requireOnly(record, ['kind', 'check', 'detail'], at);
      return {
        kind,
        check: requireNonEmptyString(record['check'], `${at}.check`),
        detail: requireNonEmptyString(record['detail'], `${at}.detail`),
      };
    case 'V5_REVALIDATION_REFUSED':
      requireOnly(record, ['kind', 'check', 'detail'], at);
      return {
        kind,
        check: requireClosed(record['check'], V5_REVALIDATION_CHECKS, `${at}.check`),
        detail: requireNonEmptyString(record['detail'], `${at}.detail`),
      };
    case 'V3_PROVIDER_FAILED':
    case 'V4_PROVIDER_FAILED':
    case 'V5_PROVIDER_FAILED': {
      requireOnly(record, ['kind', 'error_code'], at);
      const code = optionalErrorCode(record, at);
      return code === undefined ? { kind } : { kind, error_code: code };
    }
    case 'NATIVE_PROCESS_FAILED': {
      requireOnly(record, ['kind', 'error_code', 'native_detail'], at);
      const code = optionalErrorCode(record, at);
      if (!('native_detail' in record) || record['native_detail'] === undefined) {
        return code === undefined ? { kind } : { kind, error_code: code };
      }
      const detail = validateNativeFailureDetail(record['native_detail']);
      // L'égalité est l'invariant du couple : un détail qui préciserait un
      // autre code décrirait deux échecs à la fois.
      if (code !== detail.code) {
        throw invalid(
          `${at}.error_code (${String(code)}) et native_detail.code (${detail.code}) diffèrent.`,
          { field: `${at}.native_detail` },
        );
      }
      return { kind, error_code: code, native_detail: detail };
    }
  }
}

/**
 * Valide un détail natif typé. Fonction pure.
 *
 * Chaque membre est **complet et fermé** : tout champ absent est un refus, tout
 * champ supplémentaire aussi. Aucun repli ne comble un manque.
 */
export function validateNativeFailureDetail(value: unknown): NativeFailureDetail {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('native_detail doit être un objet.');
  }
  const record = value as Record<string, unknown>;
  const at = 'terminal_negative_outcome.native_detail';
  const code = requireClosed(record['code'], NATIVE_FAILURE_DETAIL_CODES, `${at}.code`);

  const expert_slot = requireClosed(record['expert_slot'], EXPERT_SLOT_IDS, `${at}.expert_slot`);
  const provider = requireClosed(record['provider'], PROVIDER_KINDS, `${at}.provider`);

  if (code === 'SESSION_ID_COLLISION') {
    requireOnly(record, ['code', 'expert_slot', 'provider', 'session_id'], at);
    return {
      code,
      expert_slot,
      provider,
      session_id: requireNonEmptyString(record['session_id'], `${at}.session_id`),
    };
  }

  requireOnly(record, ['code', 'expert_slot', 'provider', 'expected_session_id', 'found_session_id'], at);
  return {
    code,
    expert_slot,
    provider,
    expected_session_id: requireNonEmptyString(record['expected_session_id'], `${at}.expected_session_id`),
    found_session_id: requireNonEmptyString(record['found_session_id'], `${at}.found_session_id`),
  };
}

/** Valide un enregistrement complet. Fonction pure. */
export function validateInvocationOutcomeRecord(value: unknown): InvocationOutcomeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('un enregistrement doit être un objet.');
  }
  const record = value as Record<string, unknown>;
  requireOnly(record, ['schema_version', 'invocation_id', 'recorded_at', 'terminal_negative_outcome'], 'outcome');

  if (record['schema_version'] !== INVOCATION_OUTCOME_SCHEMA_VERSION) {
    throw invalid(`schema_version non pris en charge (${String(record['schema_version'])}).`);
  }
  const invocationId = requireNonEmptyString(record['invocation_id'], 'invocation_id');
  if (parseInvocationSequence(invocationId) === undefined) {
    throw invalid(`invocation_id non canonique (${invocationId}).`, { invocationId });
  }

  return {
    schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION,
    invocation_id: invocationId,
    recorded_at: requireNonEmptyString(record['recorded_at'], 'recorded_at'),
    terminal_negative_outcome: validateTerminalNegativeOutcome(record['terminal_negative_outcome']),
  };
}

/**
 * Valide le document **entier**.
 *
 * Un document présent mais non conforme est une **corruption de persistance**,
 * jamais une absence de faits : il lève, et le motif le dit.
 */
export function validateInvocationOutcomeDocument(value: unknown): InvocationOutcomeDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('le document doit être un objet JSON.');
  }
  const record = value as Record<string, unknown>;
  requireOnly(record, ['schema_version', 'outcomes'], 'document');

  if (record['schema_version'] !== INVOCATION_OUTCOME_SCHEMA_VERSION) {
    throw invalid(`schema_version non pris en charge (${String(record['schema_version'])}).`);
  }
  const raw = record['outcomes'];
  if (!Array.isArray(raw)) throw invalid('outcomes doit être une liste.');

  const seen = new Set<string>();
  const outcomes = raw.map((entry) => {
    const outcome = validateInvocationOutcomeRecord(entry);
    if (seen.has(outcome.invocation_id)) {
      throw invalid(`${outcome.invocation_id} apparaît deux fois.`, { invocationId: outcome.invocation_id });
    }
    seen.add(outcome.invocation_id);
    return outcome;
  });

  return { schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION, outcomes };
}
