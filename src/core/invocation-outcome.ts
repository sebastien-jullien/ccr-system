/**
 * Domaine — issue terminale d'une invocation engagée.
 *
 * Formes et validations **pures**. Aucune IO, aucun accès disque, aucun
 * service, aucun fournisseur.
 *
 * ## L'autorité de cette source, et elle seule
 *
 * ```text
 * ce que CCR a établi DÉTERMINISTEMENT comme issue terminale d'une invocation
 * DÉJÀ ENGAGÉE, lorsque cette issue n'est PAS attestée par ailleurs par un
 * fait de domaine durable qui la porte lui-même
 * ```
 *
 * Le critère d'appartenance est cette absence d'auto-attestation, **jamais** la
 * polarité du résultat. Deux familles y entrent aujourd'hui :
 *
 * ```text
 * issues négatives terminales   aucun objet positif ne peut les établir
 * VALID_ZERO                    aucun objet positif ne les établit
 * ```
 *
 * Et rien d'autre n'y entre. `V3 PERSISTED`, `V4 PERSISTED`, `V5 RECORDED` et
 * les succès natifs sont attestés par leurs propres faits durables — entrées de
 * domaine portant `derivation.invocation_id`, transcript natif corrélé par
 * l'événement de prompt. Leur ajouter un enregistrement ici créerait une
 * seconde autorité sur un fait déjà établi ailleurs : **aucune autorité
 * générique de succès n'existe**, et la frontière ci-dessus l'exclut par sa
 * définition même, non par une règle ajoutée.
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
 * confondre effacerait cette orthogonalité. `RESPONSE_RECEIVED` est écrit à
 * l'identique pour `VALID_ZERO`, pour un refus d'analyse et pour un succès
 * objet : il ne prouve donc aucune des trois.
 *
 * ## Coexistence de versions d'enregistrement
 *
 * ```text
 * DOCUMENT v1        n'admet que des enregistrements v1
 * DOCUMENT v2        admet des enregistrements v1 ET v2
 * ```
 *
 * La version du document dit quel **format de conteneur** est employé et quels
 * modèles d'enregistrement il a le droit de porter ; la version d'un
 * enregistrement dit la forme sous laquelle **ce fait-là** a été persisté.
 *
 * Un enregistrement v1 relu conserve sa version, son champ
 * `terminal_negative_outcome` et sa charge utile — il n'est **jamais** converti
 * à la forme courante parce qu'un fait plus récent s'ajoute à côté de lui. Le
 * conteneur, lui, est réécrit en entier à chaque ajout : c'est le mécanisme de
 * persistance atomique, et le conteneur ne porte aucun fait.
 *
 * ```text
 * REMPLACEMENT DU DOCUMENT   normal, atomique, sans signification de fait
 * MIGRATION D'UN FAIT        interdite
 * ```
 *
 * ## Aucune taxonomie universelle d'échec
 *
 * L'issue terminale est une **union discriminée fermée** qui préserve la
 * sémantique native de l'opération d'origine. Les vocabulaires de motif de
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

/**
 * Version historique — celle de CCR v0.3.0.
 *
 * Elle n'est pas dépréciée : elle reste la forme exacte sous laquelle les faits
 * de cette époque ont été écrits, et sous laquelle ils continuent d'être relus.
 */
export const INVOCATION_OUTCOME_SCHEMA_VERSION_V1 = 1;

/** Version courante du document et des enregistrements neufs. */
export const INVOCATION_OUTCOME_SCHEMA_VERSION = 2;

/**
 * Versions d'enregistrement admises par une version de document.
 *
 * Une liste par version, jamais un repli : un conteneur v1 qui accepterait un
 * enregistrement courant mentirait sur ce qu'un lecteur v1 peut en faire. La
 * forme suit celle de `invocationTriggerKindsFor` — une version inconnue ne
 * reçoit **aucun** vocabulaire.
 */
export function invocationOutcomeRecordVersionsFor(
  documentVersion: number,
): readonly number[] | undefined {
  switch (documentVersion) {
    case INVOCATION_OUTCOME_SCHEMA_VERSION_V1:
      return [INVOCATION_OUTCOME_SCHEMA_VERSION_V1];
    case INVOCATION_OUTCOME_SCHEMA_VERSION:
      return [INVOCATION_OUTCOME_SCHEMA_VERSION_V1, INVOCATION_OUTCOME_SCHEMA_VERSION];
    default:
      return undefined;
  }
}

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

/**
 * Issue terminale d'une invocation, telle que la version courante la persiste.
 *
 * `VALID_ZERO` n'a **aucune charge utile**, et c'est exact plutôt qu'économe :
 * le fait dit « cette invocation engagée a atteint `VALID_ZERO` », rien de
 * plus. La famille d'opération n'y figure pas — `trigger_kind` en fait autorité
 * au ledger, sous la même clé. Le périmètre soumis n'y figure pas non plus :
 * une décision produit gelée l'exclut du fait.
 *
 * Les issues négatives portent, elles, un discriminant par famille — `V3_`,
 * `V4_`, `V5_` — parce que leurs vocabulaires de motif diffèrent réellement et
 * ne doivent pas fusionner. `VALID_ZERO` ne porte aucun motif : il n'y a rien à
 * garder séparé, et un membre unique applique le même principe à un fait sans
 * charge utile.
 */
export type TerminalOutcome = TerminalNegativeOutcome | { readonly kind: 'VALID_ZERO' };

/** Vrai si l'issue est le succès opérationnel sans objet de domaine. */
export function isValidZeroOutcome(outcome: TerminalOutcome): boolean {
  return outcome.kind === 'VALID_ZERO';
}

/**
 * Enregistrement historique — CCR v0.3.0.
 *
 * Conservé tel quel, nom de champ compris. Le renommer pour l'homogénéité du
 * fichier réécrirait un fait déjà commité.
 */
export interface InvocationOutcomeRecordV1 {
  readonly schema_version: typeof INVOCATION_OUTCOME_SCHEMA_VERSION_V1;
  readonly invocation_id: string;
  readonly recorded_at: string;
  readonly terminal_negative_outcome: TerminalNegativeOutcome;
}

/** Enregistrement courant — le seul que ce module écrit désormais. */
export interface InvocationOutcomeRecordV2 {
  readonly schema_version: typeof INVOCATION_OUTCOME_SCHEMA_VERSION;
  readonly invocation_id: string;
  readonly recorded_at: string;
  readonly terminal_outcome: TerminalOutcome;
}

/** Un fait durable, clé par invocation, dans l'une des formes supportées. */
export type InvocationOutcomeRecord = InvocationOutcomeRecordV1 | InvocationOutcomeRecordV2;

/**
 * L'issue portée par un enregistrement, quelle que soit sa version persistée.
 *
 * **Normalisation en mémoire, et rien d'autre.** Le nom de stockage historique
 * n'est pas le nom du modèle logique courant, et cette projection ne justifie
 * jamais de réécrire le stockage.
 */
export function terminalOutcomeOf(record: InvocationOutcomeRecord): TerminalOutcome {
  return record.schema_version === INVOCATION_OUTCOME_SCHEMA_VERSION_V1
    ? record.terminal_negative_outcome
    : record.terminal_outcome;
}

/**
 * Document canonique complet.
 *
 * Une **collection clavetée** : le doublon d'`invocation_id` n'y est pas
 * représentable deux fois, et la vérification d'unicité reste explicite à
 * l'écriture plutôt que déléguée à la forme. L'unicité ne connaît **aucune**
 * version : un fait v1 et un fait courant portant la même invocation sont un
 * doublon, exactement comme deux faits de même version.
 */
export interface InvocationOutcomeDocument {
  readonly schema_version: number;
  readonly outcomes: readonly InvocationOutcomeRecord[];
}

/** Document vide — la forme d'un run sans aucune issue terminale enregistrée. */
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

/** Valide l'issue terminale courante — l'union négative, plus `VALID_ZERO`. */
export function validateTerminalOutcome(value: unknown): TerminalOutcome {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record['kind'] === 'VALID_ZERO') {
      // Fait sans charge utile : tout champ supplémentaire est refusé plutôt
      // qu'ignoré. C'est ce refus qui empêche le périmètre soumis, un motif ou
      // un `success: true` d'y entrer un jour par distraction.
      requireOnly(record, ['kind'], 'terminal_outcome');
      return { kind: 'VALID_ZERO' };
    }
  }
  return validateTerminalNegativeOutcome(value);
}

/**
 * Identité et horodatage, communs aux deux versions d'enregistrement.
 *
 * L'`invocation_id` canonique est la clé d'unicité, et la seule corrélation que
 * le fait porte.
 */
function validateOutcomeIdentity(record: Record<string, unknown>): {
  invocationId: string;
  recordedAt: string;
} {
  const invocationId = requireNonEmptyString(record['invocation_id'], 'invocation_id');
  if (parseInvocationSequence(invocationId) === undefined) {
    throw invalid(`invocation_id non canonique (${invocationId}).`, { invocationId });
  }
  return { invocationId, recordedAt: requireNonEmptyString(record['recorded_at'], 'recorded_at') };
}

/**
 * Valide un enregistrement **selon sa propre version**.
 *
 * Deux propriétés font tout le contrat de compatibilité :
 *
 * ```text
 * la version rendue est celle LUE      jamais la version courante estampillée
 * la liste de champs est PAR VERSION   jamais une liste fusionnée
 * ```
 *
 * Estampiller la version courante convertirait silencieusement chaque fait
 * historique à la relecture suivante, et la première réécriture atomique du
 * document le rendrait durable : ce serait une migration à l'écriture, que le
 * contrat d'immutabilité interdit. Fusionner les listes de champs laisserait un
 * enregistrement v1 porter le champ courant, et réciproquement — les deux
 * formes cesseraient d'être fermées.
 *
 * `allowedVersions` vient du conteneur : un document v1 n'admet aucun
 * enregistrement courant, et le refuser ici est le seul endroit où cette règle
 * peut être vérifiée.
 */
export function validateInvocationOutcomeRecord(
  value: unknown,
  allowedVersions: readonly number[] = [
    INVOCATION_OUTCOME_SCHEMA_VERSION_V1,
    INVOCATION_OUTCOME_SCHEMA_VERSION,
  ],
): InvocationOutcomeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('un enregistrement doit être un objet.');
  }
  const record = value as Record<string, unknown>;
  const version = record['schema_version'];

  if (typeof version !== 'number' || !allowedVersions.includes(version)) {
    throw invalid(`schema_version d'enregistrement non pris en charge (${String(version)}).`, {
      field: 'outcome.schema_version',
      found: version,
      allowed: [...allowedVersions],
    });
  }

  if (version === INVOCATION_OUTCOME_SCHEMA_VERSION_V1) {
    requireOnly(
      record,
      ['schema_version', 'invocation_id', 'recorded_at', 'terminal_negative_outcome'],
      'outcome',
    );
    const identity = validateOutcomeIdentity(record);
    return {
      // La version LUE, rendue telle quelle : c'est ce qui sera réécrit.
      schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION_V1,
      invocation_id: identity.invocationId,
      recorded_at: identity.recordedAt,
      terminal_negative_outcome: validateTerminalNegativeOutcome(record['terminal_negative_outcome']),
    };
  }

  requireOnly(record, ['schema_version', 'invocation_id', 'recorded_at', 'terminal_outcome'], 'outcome');
  const identity = validateOutcomeIdentity(record);
  return {
    schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION,
    invocation_id: identity.invocationId,
    recorded_at: identity.recordedAt,
    terminal_outcome: validateTerminalOutcome(record['terminal_outcome']),
  };
}

/**
 * Valide le document **entier**.
 *
 * Un document présent mais non conforme est une **corruption de persistance**,
 * jamais une absence de faits : il lève, et le motif le dit. Une version
 * d'enregistrement inconnue n'est jamais ignorée en silence — l'ignorer
 * rendrait un ensemble de faits plus petit et parfaitement plausible, c'est-à-
 * dire exactement la corruption déguisée en absence que cette source refuse.
 *
 * La version rendue est celle du document **lu**. Le passage à la version
 * courante appartient à l'écriture, qui seule sait qu'un modèle nouveau entre
 * dans le conteneur.
 */
export function validateInvocationOutcomeDocument(value: unknown): InvocationOutcomeDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('le document doit être un objet JSON.');
  }
  const record = value as Record<string, unknown>;
  requireOnly(record, ['schema_version', 'outcomes'], 'document');

  const documentVersion = record['schema_version'];
  const allowedVersions =
    typeof documentVersion === 'number'
      ? invocationOutcomeRecordVersionsFor(documentVersion)
      : undefined;
  if (typeof documentVersion !== 'number' || allowedVersions === undefined) {
    throw invalid(`schema_version de document non pris en charge (${String(documentVersion)}).`, {
      field: 'document.schema_version',
      found: documentVersion,
    });
  }

  const raw = record['outcomes'];
  if (!Array.isArray(raw)) throw invalid('outcomes doit être une liste.');

  // UN seul domaine d'unicité, toutes versions confondues. Deux ensembles
  // séparés par version laisseraient un fait v1 et un fait courant revendiquer
  // la même invocation, ce que l'exclusivité terminale interdit.
  const seen = new Set<string>();
  const outcomes = raw.map((entry) => {
    const outcome = validateInvocationOutcomeRecord(entry, allowedVersions);
    if (seen.has(outcome.invocation_id)) {
      throw invalid(`${outcome.invocation_id} apparaît deux fois.`, { invocationId: outcome.invocation_id });
    }
    seen.add(outcome.invocation_id);
    return outcome;
  });

  return { schema_version: documentVersion, outcomes };
}
