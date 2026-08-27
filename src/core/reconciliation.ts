/**
 * Domaine V5 du Reconciliation Engine — formes, identité, unions fermées.
 *
 * Tranche S1 du plan gelé. Ce module fournit la **fondation de domaine** ; il ne
 * lit ni n'écrit aucun journal (S2), n'observe aucun instantané (S3), ne valide
 * aucune appartenance de périmètre (S4), n'exécute aucune mutation (S5) et ne
 * dérive aucune actualité (S9).
 *
 * ```text
 * S1 DÉFINIT LA FORME        les slices ultérieures valident le MONDE
 * ```
 *
 * ## Fonction pure
 *
 * Aucun disque, aucun réseau, aucun fournisseur, aucun adaptateur, aucune
 * horloge, aucun aléa, aucun tri dépendant de la locale. La même entrée rend
 * toujours le même résultat, ou le même refus.
 *
 * ## Ce que ce module n'établit jamais
 *
 * ```text
 * FORME VALIDE   ≠   L'OBJET EXISTE
 * FORME VALIDE   ≠   LE PÉRIMÈTRE EST LÉGITIME
 * FORME VALIDE   ≠   L'ACTE EST OPPORTUN
 * ```
 *
 * Un identifiant canoniquement écrit mais désignant un objet inexistant
 * **traverse** ce module. Ce n'est pas une faiblesse : l'existence se décide
 * contre un instantané autoritaire, qui n'existe pas à cette tranche.
 *
 * ## Schéma fermé, jamais liste noire
 *
 * Chaque forme refuse tout champ étranger plutôt que de l'ignorer. Les onze
 * champs de mérite que le contrat §26.1 interdit — `score`, `weight`,
 * `confidence`, `rank`, `preferred`, `winner`, `probability`… — sont donc hors
 * schéma **par construction** : aucune liste noire ne les nomme, et aucune n'a
 * à être tenue à jour.
 *
 * ```text
 * ORDER   ≠   PREFERENCE
 * ```
 *
 * L'ordre d'un tableau d'options est un ordre de sérialisation. Il n'encode
 * aucune préférence, et rien dans ces formes ne permet d'en exprimer une.
 */

import { CcrError } from './errors.ts';
import { parseDecisionSequence } from './ids.ts';
import { parseControversyEntrySequence, parseControversySequence } from './controversy.ts';

// --------------------------------------------------------------------------
// Version de schéma
// --------------------------------------------------------------------------

/**
 * Version du journal V5.
 *
 * **Distincte** de `CONTROVERSY_SCHEMA_VERSION` et de `EVIDENCE_SCHEMA_VERSION` :
 * autant de domaines, autant de compteurs. Les confondre ferait dépendre la
 * lisibilité d'un journal du rythme d'évolution d'un autre.
 */
export const RECONCILIATION_SCHEMA_VERSION = 1;

// --------------------------------------------------------------------------
// Identité
// --------------------------------------------------------------------------

const RECONCILIATION_ID_PATTERN = /^rcn_(\d{6,})$/;

function invalid(message: string): CcrError {
  return new CcrError('INVALID_ARGUMENT', `Entrée V5 invalide : ${message}`);
}

/**
 * Identité d'un enregistrement V5.
 *
 * Espace **disjoint** de `evt_`, `ctv_`, `ctve_`, `mat_`, `add_` et des
 * identifiants de décision legacy. Même convention de lisibilité que les
 * précédents : préfixe propre, séquence décimale, six chiffres au moins.
 *
 * ```text
 * IDENTITY ORDER  ≠  PRIORITY  ≠  MERITS  ≠  CURRENTNESS
 * ```
 *
 * L'identité atteste qu'un enregistrement existe dans ce run. Elle ne dit ni
 * qu'il est courant, ni qu'il prime, ni qu'il a raison.
 */
export function formatReconciliationId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Séquence V5 invalide : ${String(sequence)}`);
  }
  return `rcn_${String(sequence).padStart(6, '0')}`;
}

export function parseReconciliationSequence(id: string): number | undefined {
  const digits = RECONCILIATION_ID_PATTERN.exec(id)?.[1];
  return digits === undefined ? undefined : Number.parseInt(digits, 10);
}

/**
 * Forme canonique exacte — `V01`.
 *
 * `\d{6,}` est non borné et `parseInt` absorbe les zéros de tête : sans
 * aller-retour, `rcn_0000001` passerait pour canonique. Le contrat exige
 * `format(parse(id)) === id`, et c'est cette égalité qui fait foi.
 */
function isCanonical(
  id: unknown,
  parse: (value: string) => number | undefined,
  format: (sequence: number) => string,
): boolean {
  if (typeof id !== 'string') return false;
  const sequence = parse(id);
  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) return false;
  return format(sequence) === id;
}

export function isReconciliationId(value: unknown): boolean {
  return isCanonical(value, parseReconciliationSequence, formatReconciliationId);
}

/** Identité d'une **controverse** — seule sorte de cible V5 (contrat §5). */
export function isControversyId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const sequence = parseControversySequence(value);
  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) return false;
  return `ctv_${String(sequence).padStart(6, '0')}` === value;
}

/** Identité d'une **entrée** de controverse — seule unité de périmètre (§6.1). */
export function isControversyEntryId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const sequence = parseControversyEntrySequence(value);
  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) return false;
  return `ctve_${String(sequence).padStart(6, '0')}` === value;
}

/**
 * Identité d'une décision legacy, telle que le dépôt la produit réellement.
 *
 * Le contrat §10.4 l'écrit `dec_…`, par commodité de lecture. La forme réelle
 * appartient à `core/ids.ts` depuis V1 et vaut `DEC-NNNN` : c'est elle qui est
 * exigée, faute de quoi **aucune** référence legacy réelle ne résoudrait jamais.
 * Le code réel est une contrainte d'intégration, jamais une permission — et une
 * référence qui ne peut pas désigner un objet existant n'a aucune valeur d'audit.
 *
 * ```text
 * LEGACY_DECISIONS_ROLE = REFERENCE_ONLY
 * ```
 */
export function isLegacyDecisionId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const sequence = parseDecisionSequence(value);
  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) return false;
  return `DEC-${String(sequence).padStart(4, '0')}` === value;
}

// --------------------------------------------------------------------------
// Unions fermées — vocabulaire LOCAL au moteur V5
// --------------------------------------------------------------------------

/**
 * Les trois classes d'enregistrement (§3.1).
 *
 * Une seule d'entre elles peut porter un effet autoritaire, et le type le rend
 * lisible : voir `ReconciliationRecordedEntry`.
 */
export const RECONCILIATION_ENTRY_KINDS = [
  'RECONCILIATION_PROPOSED',
  'RECONCILIATION_RECORDED',
  'PROPOSAL_RESPONSE_RECORDED',
] as const;
export type ReconciliationEntryKind = (typeof RECONCILIATION_ENTRY_KINDS)[number];

/**
 * Origine sémantique — union fermée **du présent contrat**, non transversale.
 *
 * V3 en connaît trois (`SOURCE`, `HUMAN`, `CCR`) ; V5 en connaît deux. Aucune
 * union V3 ou V4 n'est élargie pour accueillir V5, et aucune valeur V5 n'est
 * empruntée à un autre domaine.
 *
 * ```text
 * DERIVATION         ≠  SEMANTIC_ORIGIN
 * PROVIDER           ≠  SEMANTIC_ORIGIN
 * RECORDER           ≠  SEMANTIC_ORIGIN
 * TECHNICAL EXECUTOR ≠  SEMANTIC_ORIGIN
 * ```
 */
export const SEMANTIC_ORIGINS = ['HUMAN', 'CCR'] as const;
export type SemanticOrigin = (typeof SEMANTIC_ORIGINS)[number];

/**
 * Méthode de dérivation — exigée si et seulement si l'origine est `CCR` (§7).
 *
 * `MODEL_ASSISTED` est une **méthode de dérivation**, jamais une origine
 * sémantique : un modèle qui infère ne devient pas l'auteur de ce qu'il infère,
 * et le fournisseur qui l'exécute encore moins.
 */
export const DERIVATION_METHODS = ['DETERMINISTIC', 'MODEL_ASSISTED'] as const;
export type DerivationMethod = (typeof DERIVATION_METHODS)[number];

/** Sorte de périmètre (§6.2). L'énumération gouverne ; le marqueur ne gouverne rien. */
export const SCOPE_KINDS = ['SUBSET', 'WHOLE'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** Mode d'une réponse humaine (§13.1). Ni l'un ni l'autre ne produit d'effet. */
export const RESPONSE_MODES = ['ACCEPT', 'REJECT'] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];

/**
 * Relation d'un acte humain à une proposition (§13.3) — trois sémantiques
 * distinctes, jamais un faux enum.
 *
 * ```text
 * ADOPTS     l'humain fait sien le contenu proposé, et désigne l'option adoptée
 * MODIFIES   la proposition demeure la base explicite d'un contenu modifié
 * REPLACES   la proposition ne demeure que contexte et référence
 * ```
 *
 * ```text
 * RELATION  ≠  AUTHORITY EFFECT
 * ```
 *
 * Aucune des trois ne produit d'effet par elle-même : l'effet est porté, s'il
 * existe, par les champs `closure`, `closure_withdrawal` ou `supersedes` du même
 * acte.
 */
export const PROPOSAL_RELATIONS = ['ADOPTS', 'MODIFIES', 'REPLACES'] as const;
export type ProposalRelation = (typeof PROPOSAL_RELATIONS)[number];

/** Sortes de provenance (§10.4). Union fermée, à titre d'auditabilité seule. */
export const PROVENANCE_KINDS = ['DECLARED', 'CONTROVERSY_AUTHORITY', 'LEGACY_DECISION'] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

// --------------------------------------------------------------------------
// Bornes d'écriture
// --------------------------------------------------------------------------

/**
 * Bornes en **octets UTF-8**, jamais en points de code.
 *
 * Compter des caractères laisserait passer un document quatre fois plus lourd
 * dès qu'il est écrit hors ASCII. Refus, jamais troncature : un texte tronqué
 * serait relu comme s'il était entier.
 */
export const MAX_CONTENT_BYTES = 256 * 1024;
export const MAX_STATEMENT_BYTES = 64 * 1024;
export const MAX_OPTION_ID_BYTES = 1024;

// --------------------------------------------------------------------------
// Formes
// --------------------------------------------------------------------------

/** Cible canonique — exactement une controverse (§5). */
export interface ReconciliationTarget {
  readonly kind: 'CONTROVERSY';
  readonly controversy_id: string;
}

/**
 * Provenance — information d'audit **obligatoire**, et rien d'autre.
 *
 * ```text
 * PROVENANCE_PRESENT  ≠  AUTHORITY_VERIFIED
 * REFERENCE_EXISTS    ≠  AUTHORITY_SUFFICIENT
 * PROVENANCE          ≠  AUTHORITY
 * AUDITABILITY        ≠  AUTHORIZATION
 * ```
 *
 * Aucun champ de ce module ne s'appelle `verifiedAuthority`, `authorizedByRole`
 * ni `identityVerified` : CCR ne peut établir aucun de ces faits, et un nom qui
 * le suggérerait serait un mensonge de type.
 */
export type Provenance =
  | { readonly kind: 'DECLARED'; readonly statement: string }
  | { readonly kind: 'CONTROVERSY_AUTHORITY'; readonly entry_id: string }
  | { readonly kind: 'LEGACY_DECISION'; readonly decision_id: string };

/** Dérivation CCR (§7 · §11). Présente si et seulement si l'origine est `CCR`. */
export interface Derivation {
  readonly method: DerivationMethod;
  readonly invocation_id?: string;
  readonly inputs: readonly string[];
}

/** Une option proposée (§12). Ni rang, ni score, ni marqueur de préférence. */
export interface ProposalOption {
  readonly option_id: string;
  readonly content: string;
}

/**
 * Effet de clôture (§16.1). Champ d'effet porté par un acte humain, jamais un
 * acte.
 *
 * Absent ⇒ aucun effet de clôture. Aucune valeur implicite, aucun défaut.
 */
export interface ClosureDeclaration {
  readonly declared: true;
  readonly statement: string;
}

/**
 * Retrait de clôture (§21.1) — **distinct** de la clôture et **distinct** de la
 * supersession.
 *
 * ```text
 * SUPERSESSION OF DECISION  ≠  SUPERSESSION OF CLOSURE EFFECT
 * ```
 *
 * Le type le rend structurel : une relation de supersession n'a aucun champ par
 * lequel elle pourrait encoder un retrait, et réciproquement.
 */
export interface ClosureWithdrawalDeclaration {
  readonly declared: true;
  readonly withdrawn_closures: readonly string[];
  readonly withdrawal_scope: readonly string[];
  readonly statement: string;
}

/**
 * Une relation de supersession (§18.1).
 *
 * **Chaque relation porte son propre périmètre explicite.** Aucun périmètre
 * n'est hérité, ni calculé par intersection : le contrat ne reconstruit jamais
 * une intention humaine.
 */
export interface SupersessionRelation {
  readonly superseded_act_id: string;
  readonly supersession_scope: readonly string[];
}

/** Relation d'un acte humain à une proposition (§13.2). */
export interface ActRespondsTo {
  readonly proposal_id: string;
  readonly relation: ProposalRelation;
  /** ADOPTED OPTION REFERENCE — accompagne toujours un `content` humain (§13.5). */
  readonly adopted_option_id?: string;
}

/** Réponse humaine à une proposition (§13.1). */
export interface ResponseRespondsTo {
  readonly proposal_id: string;
  readonly mode: ResponseMode;
  /** RESPONSE OPTION REFERENCE — aucun effet, aucune adoption (§13.5). */
  readonly responded_option_id?: string;
}

/** Enveloppe commune aux trois classes. */
interface ReconciliationEntryBase {
  readonly schema_version: number;
  readonly entry_id: string;
  readonly kind: ReconciliationEntryKind;
  readonly target: ReconciliationTarget;
  readonly semantic_origin: SemanticOrigin;
  /** Le scribe. Jamais l'origine sémantique, jamais l'auteur. */
  readonly recorded_by: 'CCR';
  readonly recorded_at: string;
  readonly observed_revision: string;
}

/**
 * Proposition CCR (§11) — **aucun effet par elle-même**.
 *
 * ```text
 * CCR_PROPOSAL_HAS_NO_EFFECT_BY_ITSELF = TRUE
 * PROPOSAL  ≠  DECISION
 * ```
 *
 * Le type ne porte ni `closure`, ni `closure_withdrawal`, ni `supersedes`, ni
 * `provenance`, ni `content` : une proposition ne peut donc pas devenir un acte
 * humain par ajout d'un champ, et la validation refuse ces champs plutôt que de
 * les ignorer.
 */
export interface ReconciliationProposedEntry extends ReconciliationEntryBase {
  readonly kind: 'RECONCILIATION_PROPOSED';
  readonly semantic_origin: 'CCR';
  readonly scope_kind: ScopeKind;
  readonly scope: readonly string[];
  readonly derivation: Derivation;
  readonly options: readonly ProposalOption[];
}

/**
 * Acte humain de réconciliation (§9.1) — **seule** forme pouvant porter un effet
 * autoritaire (`CR5-05`).
 *
 * Les quatre effets du §24.2 sont portés par des champs **distincts et
 * explicites** : aucun champ générique ne permet d'en ambiguïser deux.
 *
 * ```text
 * E1  effet de réconciliation   le fait même de l'acte, avec son content
 * E2  effet de clôture          closure
 * E3  retrait de clôture        closure_withdrawal
 * E4  supersession              supersedes
 * ```
 *
 * `derivation` y est **interdit** : une origine `HUMAN` n'a pas de dérivation.
 */
export interface ReconciliationRecordedEntry extends ReconciliationEntryBase {
  readonly kind: 'RECONCILIATION_RECORDED';
  readonly semantic_origin: 'HUMAN';
  readonly scope_kind: ScopeKind;
  readonly scope: readonly string[];
  readonly content: string;
  readonly provenance: Provenance;
  readonly closure?: ClosureDeclaration;
  readonly closure_withdrawal?: ClosureWithdrawalDeclaration;
  readonly supersedes?: readonly SupersessionRelation[];
  readonly responds_to?: ActRespondsTo;
}

/**
 * Réponse humaine à une proposition (§13.1) — **aucun effet**.
 *
 * ```text
 * ACCEPT RESPONSE  ≠  AUTHORITATIVE RECONCILIATION ACT
 * ```
 *
 * Ni `scope_kind`, ni `scope`, ni `content`, ni `closure`, ni
 * `closure_withdrawal`, ni `supersedes`. Un périmètre n'y gouvernerait rien, et
 * sa seule présence inviterait à le lire comme le périmètre d'un effet : la
 * forme le retire plutôt que de lui inventer une sémantique.
 */
export interface ProposalResponseRecordedEntry extends ReconciliationEntryBase {
  readonly kind: 'PROPOSAL_RESPONSE_RECORDED';
  readonly semantic_origin: 'HUMAN';
  readonly provenance: Provenance;
  readonly responds_to: ResponseRespondsTo;
}

export type ReconciliationEntry =
  | ReconciliationProposedEntry
  | ReconciliationRecordedEntry
  | ProposalResponseRecordedEntry;

// --------------------------------------------------------------------------
// Outils de validation
// --------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuse tout champ étranger, à **tout** niveau fermé.
 *
 * C'est ce seul mécanisme qui met hors schéma les onze champs de mérite du
 * §26.1 — et, du même geste, les champs d'autorité qu'un fournisseur ne doit
 * jamais pouvoir forger. Extraire le connu en laissant tomber le reste leur
 * ouvrirait la porte aux uns comme aux autres.
 */
function requireOnly(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw invalid(`${path}.${key} est un champ étranger : le schéma V5 est fermé, il refuse plutôt qu'il n'ignore.`);
    }
  }
}

function requireNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${path} doit être une chaîne non vide.`);
  }
}

function requireBounded(value: string, max: number, path: string): void {
  if (Buffer.byteLength(value, 'utf8') > max) {
    throw invalid(`${path} dépasse la borne d'écriture V5 : refus, jamais troncature.`);
  }
}

function requireClosed<T extends string>(value: unknown, vocabulary: readonly T[], path: string): asserts value is T {
  if (typeof value !== 'string' || !(vocabulary as readonly string[]).includes(value)) {
    throw invalid(`${path} hors de l'union fermée : ${vocabulary.join(' | ')}.`);
  }
}

function requireIdArray(
  value: unknown,
  predicate: (candidate: unknown) => boolean,
  path: string,
): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw invalid(`${path} doit être un tableau.`);
  value.forEach((candidate, index) => {
    if (!predicate(candidate)) {
      throw invalid(`${path}[${String(index)}] n'est pas une identité canonique.`);
    }
  });
}

function requireAbsent(record: Record<string, unknown>, fields: readonly string[], reason: string): void {
  for (const field of fields) {
    if (field in record) throw invalid(`${field} ${reason}`);
  }
}

// --------------------------------------------------------------------------
// Validation des sous-formes
// --------------------------------------------------------------------------

function validateTarget(value: unknown): void {
  if (!isPlainObject(value)) throw invalid('target doit être un objet.');
  requireOnly(value, ['kind', 'controversy_id'], 'target');
  if (value['kind'] !== 'CONTROVERSY') {
    throw invalid("target.kind vaut 'CONTROVERSY' — une seule sorte de cible existe (§5).");
  }
  if (!isControversyId(value['controversy_id'])) {
    throw invalid('target.controversy_id doit être une identité `ctv_` canonique.');
  }
}

/**
 * `V13` — provenance présente et de type fermé.
 *
 * Ce contrôle établit qu'une provenance **est déclarée et bien formée**. Il
 * n'établit ni que la référence existe, ni qu'elle est pertinente, ni — surtout
 * — qu'elle confère la moindre autorité.
 */
function validateProvenance(value: unknown): void {
  if (!isPlainObject(value)) throw invalid('provenance doit être un objet (§10.4).');
  const kind = value['kind'];
  requireClosed(kind, PROVENANCE_KINDS, 'provenance.kind');

  switch (kind) {
    case 'DECLARED':
      requireOnly(value, ['kind', 'statement'], 'provenance');
      requireNonEmptyString(value['statement'], 'provenance.statement');
      requireBounded(value['statement'], MAX_STATEMENT_BYTES, 'provenance.statement');
      return;
    case 'CONTROVERSY_AUTHORITY':
      requireOnly(value, ['kind', 'entry_id'], 'provenance');
      if (!isControversyEntryId(value['entry_id'])) {
        throw invalid('provenance.entry_id doit être une identité `ctve_` canonique.');
      }
      return;
    case 'LEGACY_DECISION':
      requireOnly(value, ['kind', 'decision_id'], 'provenance');
      if (!isLegacyDecisionId(value['decision_id'])) {
        throw invalid('provenance.decision_id doit porter la forme canonique du dépôt (`DEC-NNNN`).');
      }
      return;
  }
}

/** `V09` — une dérivation existe si et seulement si l'origine est `CCR`. */
function validateDerivation(value: unknown): void {
  if (!isPlainObject(value)) throw invalid('derivation doit être un objet.');
  requireOnly(value, ['method', 'invocation_id', 'inputs'], 'derivation');
  requireClosed(value['method'], DERIVATION_METHODS, 'derivation.method');
  if (!Array.isArray(value['inputs'])) throw invalid('derivation.inputs doit être un tableau.');
  value['inputs'].forEach((input, index) => {
    requireNonEmptyString(input, `derivation.inputs[${String(index)}]`);
  });
  if ('invocation_id' in value) {
    requireNonEmptyString(value['invocation_id'], 'derivation.invocation_id');
  }
}

/**
 * `V29` — options non classées.
 *
 * La forme n'offre **aucun** champ de rang, de score ou de préférence, et le
 * schéma fermé refuse d'en accueillir un. L'unicité des `option_id` dans une
 * même proposition est structurelle : sans elle, `adopted_option_id` et
 * `responded_option_id` désigneraient deux objets à la fois.
 */
function validateOptions(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('options doit être un tableau non vide (§11).');
  }
  const seen = new Set<string>();
  value.forEach((option, index) => {
    const path = `options[${String(index)}]`;
    if (!isPlainObject(option)) throw invalid(`${path} doit être un objet.`);
    requireOnly(option, ['option_id', 'content'], path);
    requireNonEmptyString(option['option_id'], `${path}.option_id`);
    requireBounded(option['option_id'], MAX_OPTION_ID_BYTES, `${path}.option_id`);
    requireNonEmptyString(option['content'], `${path}.content`);
    requireBounded(option['content'], MAX_CONTENT_BYTES, `${path}.content`);
    if (seen.has(option['option_id'])) {
      throw invalid(`${path}.option_id est dupliqué : une référence d'option deviendrait ambiguë.`);
    }
    seen.add(option['option_id']);
  });
}

function validateClosure(value: unknown): void {
  if (!isPlainObject(value)) throw invalid('closure doit être un objet (§16.1).');
  requireOnly(value, ['declared', 'statement'], 'closure');
  if (value['declared'] !== true) {
    throw invalid("closure.declared vaut exactement true — l'absence du champ est la seule autre forme.");
  }
  requireNonEmptyString(value['statement'], 'closure.statement');
  requireBounded(value['statement'], MAX_STATEMENT_BYTES, 'closure.statement');
}

function validateClosureWithdrawal(value: unknown): void {
  if (!isPlainObject(value)) throw invalid('closure_withdrawal doit être un objet (§21.1).');
  requireOnly(value, ['declared', 'withdrawn_closures', 'withdrawal_scope', 'statement'], 'closure_withdrawal');
  if (value['declared'] !== true) {
    throw invalid('closure_withdrawal.declared vaut exactement true.');
  }
  requireIdArray(value['withdrawn_closures'], isReconciliationId, 'closure_withdrawal.withdrawn_closures');
  requireIdArray(value['withdrawal_scope'], isControversyEntryId, 'closure_withdrawal.withdrawal_scope');
  requireNonEmptyString(value['statement'], 'closure_withdrawal.statement');
  requireBounded(value['statement'], MAX_STATEMENT_BYTES, 'closure_withdrawal.statement');
}

function validateSupersedes(value: unknown): void {
  if (!Array.isArray(value)) throw invalid('supersedes doit être un tableau (§18.1).');
  value.forEach((relation, index) => {
    const path = `supersedes[${String(index)}]`;
    if (!isPlainObject(relation)) throw invalid(`${path} doit être un objet.`);
    requireOnly(relation, ['superseded_act_id', 'supersession_scope'], path);
    if (!isReconciliationId(relation['superseded_act_id'])) {
      throw invalid(`${path}.superseded_act_id doit être une identité \`rcn_\` canonique.`);
    }
    requireIdArray(relation['supersession_scope'], isControversyEntryId, `${path}.supersession_scope`);
  });
}

function validateActRespondsTo(value: unknown): void {
  if (!isPlainObject(value)) throw invalid('responds_to doit être un objet.');
  requireOnly(value, ['proposal_id', 'relation', 'adopted_option_id'], 'responds_to');
  if (!isReconciliationId(value['proposal_id'])) {
    throw invalid('responds_to.proposal_id doit être une identité `rcn_` canonique.');
  }
  requireClosed(value['relation'], PROPOSAL_RELATIONS, 'responds_to.relation');
  if ('adopted_option_id' in value) {
    requireNonEmptyString(value['adopted_option_id'], 'responds_to.adopted_option_id');
    requireBounded(value['adopted_option_id'], MAX_OPTION_ID_BYTES, 'responds_to.adopted_option_id');
  }
  // `mode` appartient à la RÉPONSE, jamais à l'acte : les deux formes de
  // `responds_to` sont distinctes, et les confondre laisserait un acte humain
  // se présenter comme une réponse.
  requireAbsent(value, ['mode', 'responded_option_id'], "appartient à la réponse, jamais à l'acte humain (§13.5).");
}

function validateResponseRespondsTo(value: unknown): void {
  if (!isPlainObject(value)) throw invalid('responds_to doit être un objet (§13.1).');
  requireOnly(value, ['proposal_id', 'mode', 'responded_option_id'], 'responds_to');
  if (!isReconciliationId(value['proposal_id'])) {
    throw invalid('responds_to.proposal_id doit être une identité `rcn_` canonique.');
  }
  requireClosed(value['mode'], RESPONSE_MODES, 'responds_to.mode');
  if ('responded_option_id' in value) {
    requireNonEmptyString(value['responded_option_id'], 'responds_to.responded_option_id');
    requireBounded(value['responded_option_id'], MAX_OPTION_ID_BYTES, 'responds_to.responded_option_id');
  }
  requireAbsent(
    value,
    ['relation', 'adopted_option_id'],
    "appartient à l'acte humain, jamais à la réponse : une réponse n'adopte rien (§13.5).",
  );
}

/**
 * Périmètre — part **structurelle** seulement (`V03`).
 *
 * Présent, tableau non vide, chaque unité canoniquement écrite. L'appartenance
 * à la cible, l'existence dans l'instantané, l'absence de doublon et
 * l'énumération autoritaire de `WHOLE` appartiennent à S4 : elles exigent un
 * état du monde que cette tranche n'observe pas.
 *
 * ```text
 * WHOLE  n'est JAMAIS représenté par un périmètre absent, ni par un tableau vide
 * ```
 */
function validateScope(record: Record<string, unknown>, path: string): void {
  requireClosed(record['scope_kind'], SCOPE_KINDS, `${path}scope_kind`);
  const scope = record['scope'];
  if (!Array.isArray(scope) || scope.length === 0) {
    throw invalid(`${path}scope doit être une énumération non vide — WHOLE compris (§6.3).`);
  }
  requireIdArray(scope, isControversyEntryId, `${path}scope`);
}

// --------------------------------------------------------------------------
// Validation d'entrée
// --------------------------------------------------------------------------

const PROPOSED_KEYS = [
  'schema_version', 'entry_id', 'kind', 'target', 'semantic_origin', 'recorded_by', 'recorded_at',
  'observed_revision', 'scope_kind', 'scope', 'derivation', 'options',
] as const;

const RECORDED_KEYS = [
  'schema_version', 'entry_id', 'kind', 'target', 'semantic_origin', 'recorded_by', 'recorded_at',
  'observed_revision', 'scope_kind', 'scope', 'content', 'provenance', 'closure',
  'closure_withdrawal', 'supersedes', 'responds_to',
] as const;

const RESPONSE_KEYS = [
  'schema_version', 'entry_id', 'kind', 'target', 'semantic_origin', 'recorded_by', 'recorded_at',
  'observed_revision', 'provenance', 'responds_to',
] as const;

/** Les trois champs d'effet, nommés une fois — `V10`. */
export const EFFECT_FIELDS = ['closure', 'closure_withdrawal', 'supersedes'] as const;

function validateEnvelope(entry: Record<string, unknown>): void {
  if (entry['schema_version'] !== RECONCILIATION_SCHEMA_VERSION) {
    throw invalid(`schema_version non pris en charge (${String(entry['schema_version'])}).`);
  }
  if (!isReconciliationId(entry['entry_id'])) {
    throw invalid('entry_id doit être une identité `rcn_` canonique (`V01`).');
  }
  requireClosed(entry['kind'], RECONCILIATION_ENTRY_KINDS, 'kind');
  validateTarget(entry['target']);
  requireClosed(entry['semantic_origin'], SEMANTIC_ORIGINS, 'semantic_origin');
  if (entry['recorded_by'] !== 'CCR') {
    throw invalid("recorded_by vaut 'CCR' : le scribe n'est jamais l'origine sémantique.");
  }
  requireNonEmptyString(entry['recorded_at'], 'recorded_at');
  requireNonEmptyString(entry['observed_revision'], 'observed_revision');
}

/**
 * Valide une entrée V5 et la rend telle quelle.
 *
 * Fonction **pure**. Tout ce qui exige de consulter le monde — existence d'une
 * controverse, appartenance d'une unité, fraîcheur d'une révision, cohérence
 * d'un graphe de supersession, actualité d'un effet — appartient aux tranches
 * qui disposent d'un instantané et d'un verrou.
 */
export function validateReconciliationEntry(entry: ReconciliationEntry): ReconciliationEntry {
  if (!isPlainObject(entry)) throw invalid('une entrée doit être un objet.');
  validateEnvelope(entry);

  switch (entry.kind) {
    case 'RECONCILIATION_PROPOSED': {
      const record = entry as unknown as Record<string, unknown>;
      requireOnly(record, PROPOSED_KEYS, 'entrée');
      // `V08` — la sorte lie l'origine. Une proposition d'origine HUMAN
      // permettrait à CCR de se présenter comme une personne.
      if (entry.semantic_origin !== 'CCR') {
        throw invalid("une proposition porte l'origine sémantique 'CCR', et elle seule (§11).");
      }
      validateScope(record, '');
      // `V09` — dérivation obligatoire ⟺ origine CCR.
      validateDerivation(record['derivation']);
      validateOptions(record['options']);
      // `V10` — aucun effet, aucune provenance d'autorité, aucun contenu de
      // décision. Le schéma fermé les refuse déjà ; ce refus les NOMME, pour
      // que le motif rendu dise exactement ce qui a été tenté.
      requireAbsent(
        record,
        [...EFFECT_FIELDS, 'provenance', 'content', 'responds_to'],
        'est interdit sur une proposition CCR : elle ne produit aucun effet par elle-même (§11).',
      );
      return entry;
    }

    case 'RECONCILIATION_RECORDED': {
      const record = entry as unknown as Record<string, unknown>;
      requireOnly(record, RECORDED_KEYS, 'entrée');
      if (entry.semantic_origin !== 'HUMAN') {
        throw invalid("un acte de réconciliation porte l'origine sémantique 'HUMAN' (§9.1).");
      }
      validateScope(record, '');
      // `V12` — contenu humain obligatoire (`CR5-04`). Aucun acte autoritaire
      // ne peut exister dont la seule substance serait le contenu d'une
      // proposition CCR.
      requireNonEmptyString(record['content'], 'content');
      requireBounded(record['content'] as string, MAX_CONTENT_BYTES, 'content');
      // `V13` — provenance obligatoire, sans effet sur l'autorité.
      validateProvenance(record['provenance']);
      if ('closure' in record) validateClosure(record['closure']);
      if ('closure_withdrawal' in record) validateClosureWithdrawal(record['closure_withdrawal']);
      if ('supersedes' in record) validateSupersedes(record['supersedes']);
      if ('responds_to' in record) validateActRespondsTo(record['responds_to']);
      // `V09` — une origine HUMAN n'a pas de dérivation (§9.2).
      requireAbsent(record, ['derivation'], "est interdit sur un acte humain : une origine HUMAN n'a pas de dérivation (§9.2).");
      requireAbsent(record, ['options'], 'appartient à une proposition, jamais à un acte humain.');
      return entry;
    }

    case 'PROPOSAL_RESPONSE_RECORDED': {
      const record = entry as unknown as Record<string, unknown>;
      requireOnly(record, RESPONSE_KEYS, 'entrée');
      if (entry.semantic_origin !== 'HUMAN') {
        throw invalid("une réponse porte l'origine sémantique 'HUMAN' (§13.1).");
      }
      validateProvenance(record['provenance']);
      validateResponseRespondsTo(record['responds_to']);
      // `V03` / `V10` — la réponse ne gouverne aucune unité et ne porte aucun
      // effet. Un périmètre n'y gouvernerait rien, et sa seule présence
      // inviterait à le lire comme le périmètre d'un effet.
      requireAbsent(
        record,
        ['scope_kind', 'scope', 'content', ...EFFECT_FIELDS, 'derivation', 'options'],
        'est absent de la forme canonique d\'une réponse : elle ne produit aucun effet (§13.1).',
      );
      return entry;
    }
  }
}

/**
 * Un enregistrement peut-il porter un effet autoritaire ? — `V10`.
 *
 * Prédicat de **forme**, jamais d'autorité : il dit quelle classe peut porter un
 * effet, jamais qu'un effet donné est légitime, opportun ou courant.
 */
export function mayCarryAuthoritativeEffect(kind: ReconciliationEntryKind): boolean {
  return kind === 'RECONCILIATION_RECORDED';
}
