/**
 * Domaine V3 — Controversy Engine (contrat V3 gelé, `bfd07ebd…`).
 *
 * Formes et validations **pures**. Aucune IO, aucun accès disque, aucun
 * service, aucun fournisseur. Ce module est la tranche S1 du plan gelé, et
 * rien de plus.
 *
 * ## Ce que le modèle refuse par construction
 *
 * Une controverse n'est **pas** un objet à états. C'est une identité, plus une
 * suite append-only d'entrées attribuées.
 *
 * ```text
 * aucun champ de statut         ni OPEN, ni CLOSED, ni RESOLVED, ni INACTIVE
 * aucun CONVERGED               réservé, sans valeur
 * aucune disposition agrégée    la lecture n'agrège rien
 * aucun objet Position          la continuité est une RELATION attribuée
 * aucun score, aucune confiance un seuil ne fait jamais une vérité
 * ```
 *
 * Le choix est délibéré : tant qu'un champ de statut existe, une projection ou
 * un correctif peut l'écrire, et l'interdit dépend d'une vigilance permanente.
 * Il n'en existe aucun — la transition n'est donc pas représentable. C'est le
 * raisonnement de V2.1 §4.1, qui a fait de la clé du slot son rôle plutôt que
 * d'ajouter un contrôle.
 *
 * ## Trois origines sémantiques, une seule question
 *
 * `semantic_origin` répond à **de qui vient la sémantique**, jamais à qui a
 * demandé l'écriture — c'est `recorded_by`. Confondre les deux ferait d'un
 * geste d'enregistrement une appropriation de sens.
 *
 * `SOURCE` est **défini mais non productible** en V3 initial : aucun mécanisme
 * ne permet de reconnaître qu'un expert a déclaré quelque chose, et une
 * transcription humaine relève de `HUMAN` avec `about_actor` (arbitrage
 * `docs/specs/controversy.md`). Ce module n'expose donc aucun constructeur
 * qui produise `SOURCE`.
 */

import { CcrError } from './errors.ts';
import { isExpertSlotId, type ExpertSlotId } from './expert.ts';

// --------------------------------------------------------------------------
// Version de schéma — journal V3, à ne pas confondre avec celle du ledger
// --------------------------------------------------------------------------

/**
 * Version du format des entrées de controverse.
 *
 * Sans rapport avec `INVOCATION_LEDGER_SCHEMA_VERSION` : deux domaines, deux
 * versions. Le ledger appartient à V2.2 et n'est pas touché ici.
 */
export const CONTROVERSY_SCHEMA_VERSION = 1;

// --------------------------------------------------------------------------
// Identités — opaques, run-local, jamais porteuses de sens
// --------------------------------------------------------------------------

const CONTROVERSY_ID_PATTERN = /^ctv_(\d{6,})$/;
const CONTROVERSY_ENTRY_ID_PATTERN = /^ctve_(\d{6,})$/;

/**
 * Identité d'une controverse. Même convention que `evt_NNNNNN` : lisible,
 * triable, séquentielle **par run**.
 *
 * Elle est épistémiquement neutre : elle atteste qu'un enregistrement existe,
 * jamais qu'un désaccord est établi. Elle ne porte ni statut, ni nature, ni
 * gagnant, et n'a aucune portée hors du run (arbitrage `A5`).
 */
export function formatControversyId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Séquence de controverse invalide : ${String(sequence)}`);
  }
  return `ctv_${String(sequence).padStart(6, '0')}`;
}

export function parseControversySequence(id: string): number | undefined {
  const digits = CONTROVERSY_ID_PATTERN.exec(id)?.[1];
  return digits === undefined ? undefined : Number.parseInt(digits, 10);
}

/**
 * Identité d'une entrée.
 *
 * Volontairement **distincte** de celle d'une controverse, préfixe compris :
 * une entrée référence des entrées (relations, réponses humaines), et confondre
 * les deux espaces rendrait une cible ambiguë.
 */
export function formatControversyEntryId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Séquence d'entrée de controverse invalide : ${String(sequence)}`);
  }
  return `ctve_${String(sequence).padStart(6, '0')}`;
}

export function parseControversyEntrySequence(id: string): number | undefined {
  const digits = CONTROVERSY_ENTRY_ID_PATTERN.exec(id)?.[1];
  return digits === undefined ? undefined : Number.parseInt(digits, 10);
}

// --------------------------------------------------------------------------
// Origine sémantique
// --------------------------------------------------------------------------

/** De qui vient la sémantique. Trois catégories, et elles seules. */
export const SEMANTIC_ORIGIN_KINDS = ['SOURCE', 'HUMAN', 'CCR'] as const;
export type SemanticOriginKind = (typeof SEMANTIC_ORIGIN_KINDS)[number];

/**
 * Origine sémantique d'un fait V3.
 *
 * `actor` n'est renseigné que lorsque l'architecture sait réellement identifier
 * l'attribué :
 *
 * ```text
 * SOURCE   actor = expert_slot_id — provenance métier canonique (V0.5 §5.4)
 * HUMAN    actor ABSENT — aucune identité humaine durable n'existe dans CCR
 * CCR      actor absent — le mécanisme est porté par `derivation`
 * ```
 *
 * `about_actor` sert la transcription humaine : un humain qui structure sa
 * lecture d'un passage produit une sémantique **qui est la sienne**, à propos
 * d'une source. L'ancrage la rend auditable ; il ne la rend pas source-authored.
 */
export interface SemanticOrigin {
  readonly kind: SemanticOriginKind;
  readonly actor?: ExpertSlotId;
  readonly about_actor?: ExpertSlotId;
}

/** Qui a demandé l'écriture. Un expert ne demande jamais : il produit du texte. */
export const RECORDING_ACTORS = ['HUMAN', 'CCR'] as const;
export type RecordingActor = (typeof RECORDING_ACTORS)[number];

function validateSemanticOrigin(value: SemanticOrigin, path: string): void {
  if (!(SEMANTIC_ORIGIN_KINDS as readonly string[]).includes(value.kind)) {
    throw invalid(`${path}.kind inconnu (${String(value.kind)}).`);
  }

  if (value.kind === 'SOURCE') {
    if (value.actor === undefined || !isExpertSlotId(value.actor)) {
      throw invalid(`${path}.actor doit être un slot d'expert pour une origine SOURCE.`);
    }
  } else if (value.actor !== undefined) {
    // Pour HUMAN, aucune identité durable n'existe : `author: 'human'` est un
    // littéral de catégorie dans tout le dépôt, jamais une personne. Pour CCR,
    // le mécanisme vit dans `derivation`. Accepter un acteur ici laisserait
    // croire à une granularité que le système ne possède pas.
    throw invalid(`${path}.actor est interdit pour une origine ${value.kind}.`);
  }

  if (value.about_actor !== undefined) {
    if (value.kind !== 'HUMAN') {
      throw invalid(`${path}.about_actor n'est admis que pour une origine HUMAN.`);
    }
    if (!isExpertSlotId(value.about_actor)) {
      throw invalid(`${path}.about_actor doit être un slot d'expert.`);
    }
  }
}

// --------------------------------------------------------------------------
// Ancrages
// --------------------------------------------------------------------------

/**
 * Ancrage de provenance — obligatoire, au moins un par entrée.
 *
 * Il localise et attribue une provenance. Il ne signifie **ni** contestation,
 * **ni** appui, **ni** reformulation, **ni** identité de position : ce que fait
 * une entrée est porté par son acte, jamais par ce à quoi elle s'ancre.
 */
export interface ProvenanceAnchor {
  readonly event_id: string;
  readonly round: number;
  readonly expert_slot_id?: ExpertSlotId;
  readonly session_id?: string;
}

/**
 * Ancrage textuel — au plus un par entrée.
 *
 * Aucun décalage n'est stocké : ni octet, ni point de code, ni unité UTF-16. La
 * séquence d'octets UTF-8 du contenu n'existe à aucune étape du chemin — le
 * fichier porte les octets du JSON *échappé* — et un décalage erroné désigne un
 * fragment plausible sans que rien ne le signale. Une citation, elle, se
 * confronte à l'original.
 *
 * S1 valide la **forme**. La résolution de la citation contre le contenu
 * canonique appartient à la mutation sous verrou de S4 : elle exige une lecture,
 * et ce module n'en fait aucune.
 */
export interface TextualAnchor {
  readonly event_id: string;
  readonly quoted_text: string;
  /** Rang 1-based ; les occurrences chevauchantes sont comptées (§S4). */
  readonly occurrence: number;
}

/**
 * Ancrage sémantique — au plus un par entrée.
 *
 * Son origine est **propre** et indépendante de celle de l'entrée qui le porte :
 * une entrée humaine peut citer un énoncé dont la sémantique vient d'ailleurs.
 *
 * Il ne porte **aucune identité de position**. Deux entrées citant le même
 * énoncé ne sont pas reliées par ce fait : la continuité est une relation
 * déclarée, et une relation porte une attribution — une identité partagée n'en
 * porterait aucune.
 */
export interface SemanticAnchor {
  readonly text: string;
  readonly semantic_origin: SemanticOrigin;
}

function validateProvenanceAnchor(anchor: ProvenanceAnchor, index: number): void {
  const path = `anchors.provenance[${String(index)}]`;
  requireNonEmpty(anchor.event_id, `${path}.event_id`);
  if (!Number.isInteger(anchor.round) || anchor.round < 0) {
    throw invalid(`${path}.round doit être un entier positif ou nul.`);
  }
  if (anchor.expert_slot_id !== undefined && !isExpertSlotId(anchor.expert_slot_id)) {
    throw invalid(`${path}.expert_slot_id inconnu.`);
  }
  if (anchor.session_id !== undefined) requireNonEmpty(anchor.session_id, `${path}.session_id`);
}

function validateTextualAnchor(anchor: TextualAnchor): void {
  requireNonEmpty(anchor.event_id, 'anchors.textual.event_id');
  // Une citation vide ne désigne rien : toute position du contenu la
  // « contiendrait », et l'ancrage cesserait d'être déterministe.
  requireNonEmpty(anchor.quoted_text, 'anchors.textual.quoted_text');
  if (!Number.isInteger(anchor.occurrence) || anchor.occurrence < 1) {
    throw invalid('anchors.textual.occurrence doit être un entier strictement positif.');
  }
}

// --------------------------------------------------------------------------
// Dérivation — obligatoire si et seulement si l'origine est CCR
// --------------------------------------------------------------------------

export const DERIVATION_METHODS = ['DETERMINISTIC_LOCAL', 'MODEL_ASSISTED'] as const;
export type DerivationMethod = (typeof DERIVATION_METHODS)[number];

/**
 * Provenance d'un fait dérivé par CCR.
 *
 * Aucun score de confiance n'existe, et c'est structurel : l'arbitrage `A2` et
 * V0.5 §16.10 interdisent qu'un seuil fasse une vérité. Un tel champ n'aurait
 * aucun usage légitime, et son existence inviterait à l'usage illégitime.
 *
 * Le fournisseur et le modèle ne sont pas dupliqués : ils se retrouvent par
 * `invocation_id` dans l'`InvocationLedger`, qui en est l'autorité.
 */
export interface Derivation {
  readonly method: DerivationMethod;
  /** Requis pour `MODEL_ASSISTED`, interdit sinon. */
  readonly invocation_id?: string;
  /** Références stables des éléments utilisés — identifiants d'événements. */
  readonly inputs: readonly string[];
}

function validateDerivation(derivation: Derivation): void {
  if (!(DERIVATION_METHODS as readonly string[]).includes(derivation.method)) {
    throw invalid(`derivation.method inconnue (${String(derivation.method)}).`);
  }
  if (derivation.method === 'MODEL_ASSISTED') {
    if (derivation.invocation_id === undefined) {
      throw invalid('derivation.invocation_id est requis pour MODEL_ASSISTED.');
    }
    requireNonEmpty(derivation.invocation_id, 'derivation.invocation_id');
  } else if (derivation.invocation_id !== undefined) {
    // Une dérivation locale n'a produit aucun appel : lui attacher une
    // invocation attribuerait un fait de ledger à un calcul qui n'a rien
    // déclenché.
    throw invalid('derivation.invocation_id est interdit pour DETERMINISTIC_LOCAL.');
  }
  if (!Array.isArray(derivation.inputs)) throw invalid('derivation.inputs doit être une liste.');
  derivation.inputs.forEach((input, index) =>
    requireNonEmpty(input, `derivation.inputs[${String(index)}]`),
  );
}

// --------------------------------------------------------------------------
// Actes
// --------------------------------------------------------------------------

/** Ce qu'une relation fait, déclaré — jamais déduit de son ancrage. */
export const RELATION_ACTS = ['CONTESTS', 'REFORMULATES', 'WITHDRAWS'] as const;
export type RelationAct = (typeof RELATION_ACTS)[number];

/**
 * Ce qu'une autorité humaine fait.
 *
 * `CONFIRM_RELATION` et `CONTEST_RELATION` sont strictement symétriques et ne
 * portent aucun champ de vérité : la lecture peut dire qu'une confirmation est
 * enregistrée, jamais qu'une position est vraie.
 */
export const AUTHORITY_ACTS = ['ARBITRATION', 'CONFIRM_RELATION', 'CONTEST_RELATION'] as const;
export type AuthorityAct = (typeof AUTHORITY_ACTS)[number];

// --------------------------------------------------------------------------
// Enveloppe d'entrée
// --------------------------------------------------------------------------

export const CONTROVERSY_ENTRY_KINDS = [
  'CONTROVERSY_RECORDED',
  'ASSERTION_RECORDED',
  'RELATION_RECORDED',
  'NATURE_RECORDED',
  'HUMAN_AUTHORITY_RECORDED',
] as const;
export type ControversyEntryKind = (typeof CONTROVERSY_ENTRY_KINDS)[number];

/**
 * Ancrages d'une entrée.
 *
 * La cardinalité est portée par la **forme**, non par un contrôle : un ancrage
 * textuel et un ancrage sémantique sont des champs uniques, pas des listes.
 * Un tableau de `SemanticAnchor` permettrait plusieurs unités sémantiques dans
 * une même assertion, et rendrait ambiguë toute entrée qui la vise.
 */
export interface ControversyAnchors {
  readonly provenance: readonly ProvenanceAnchor[];
  readonly textual?: TextualAnchor;
  readonly semantic?: SemanticAnchor;
}

/** Charge d'une relation entre deux entrées. Aucune identité de position. */
export interface RelationPayload {
  readonly from_entry_id: string;
  readonly to_entry_id: string;
  readonly act: RelationAct;
}

/** Charge d'une autorité humaine. `target_entry_id` vise l'entrée concernée. */
export interface AuthorityPayload {
  readonly act: AuthorityAct;
  readonly target_entry_id?: string;
  readonly scope?: string;
}

/**
 * Enveloppe commune. Une seule forme, discriminée par `kind`.
 *
 * Aucun champ de mutation d'état n'y figure — ni `status`, ni `active`, ni
 * `closed`, ni `deleted`. Un retrait ou une reformulation est un **fait
 * enregistré**, porté par une entrée de relation, jamais une mutation.
 */
export interface ControversyEntry {
  readonly schema_version: number;
  readonly entry_id: string;
  readonly controversy_id: string;
  readonly kind: ControversyEntryKind;
  readonly semantic_origin: SemanticOrigin;
  readonly recorded_by: RecordingActor;
  readonly recorded_at: string;
  readonly round: number;
  readonly anchors: ControversyAnchors;
  readonly derivation?: Derivation;
  readonly content?: string;
  readonly relation?: RelationPayload;
  readonly authority?: AuthorityPayload;
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

function invalid(message: string): CcrError {
  return new CcrError('INVALID_ARGUMENT', `Entrée de controverse invalide : ${message}`);
}

function requireNonEmpty(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${path} doit être une chaîne non vide.`);
  }
}

/**
 * Valide une entrée et la rend telle quelle.
 *
 * Fonction **pure** : aucune lecture, aucune écriture, aucune horloge. Tout ce
 * qui exige de consulter le journal — existence des entrées visées, appartenance
 * à la même controverse, nature de la cible d'une réponse humaine — appartient
 * au service de S4, qui seul dispose du contexte et du verrou.
 */
export function validateControversyEntry(entry: ControversyEntry): ControversyEntry {
  if (entry.schema_version !== CONTROVERSY_SCHEMA_VERSION) {
    throw invalid(`schema_version non pris en charge (${String(entry.schema_version)}).`);
  }
  if (parseControversyEntrySequence(entry.entry_id) === undefined) {
    throw invalid(`entry_id non canonique (${String(entry.entry_id)}).`);
  }
  if (parseControversySequence(entry.controversy_id) === undefined) {
    throw invalid(`controversy_id non canonique (${String(entry.controversy_id)}).`);
  }
  if (!(CONTROVERSY_ENTRY_KINDS as readonly string[]).includes(entry.kind)) {
    throw invalid(`kind inconnu (${String(entry.kind)}).`);
  }
  if (!(RECORDING_ACTORS as readonly string[]).includes(entry.recorded_by)) {
    throw invalid(`recorded_by inconnu (${String(entry.recorded_by)}).`);
  }
  requireNonEmpty(entry.recorded_at, 'recorded_at');
  if (!Number.isInteger(entry.round) || entry.round < 0) {
    throw invalid('round doit être un entier positif ou nul.');
  }

  validateSemanticOrigin(entry.semantic_origin, 'semantic_origin');

  // Dérivation : requise si et seulement si l'origine est CCR. Sans cette
  // équivalence, une inférence pourrait exister sans provenance de mécanisme,
  // ou un fait humain se voir attribuer une dérivation qu'il n'a pas.
  if (entry.semantic_origin.kind === 'CCR') {
    if (entry.derivation === undefined) throw invalid('derivation est requise pour une origine CCR.');
    validateDerivation(entry.derivation);
  } else if (entry.derivation !== undefined) {
    throw invalid(`derivation est interdite pour une origine ${entry.semantic_origin.kind}.`);
  }

  const anchors = entry.anchors;
  if (anchors === undefined || !Array.isArray(anchors.provenance) || anchors.provenance.length === 0) {
    throw invalid('au moins un ancrage de provenance est requis.');
  }
  anchors.provenance.forEach(validateProvenanceAnchor);
  if (anchors.textual !== undefined) validateTextualAnchor(anchors.textual);
  if (anchors.semantic !== undefined) {
    requireNonEmpty(anchors.semantic.text, 'anchors.semantic.text');
    validateSemanticOrigin(anchors.semantic.semantic_origin, 'anchors.semantic.semantic_origin');
  }

  if (entry.content !== undefined) requireNonEmpty(entry.content, 'content');

  validateKindPayload(entry);
  return entry;
}

function validateKindPayload(entry: ControversyEntry): void {
  const isRelation = entry.kind === 'RELATION_RECORDED';
  const isAuthority = entry.kind === 'HUMAN_AUTHORITY_RECORDED';

  if (isRelation) {
    const relation = entry.relation;
    if (relation === undefined) throw invalid('relation est requise pour RELATION_RECORDED.');
    if (!(RELATION_ACTS as readonly string[]).includes(relation.act)) {
      throw invalid(`relation.act inconnu (${String(relation.act)}).`);
    }
    if (parseControversyEntrySequence(relation.from_entry_id) === undefined) {
      throw invalid(`relation.from_entry_id non canonique (${String(relation.from_entry_id)}).`);
    }
    if (parseControversyEntrySequence(relation.to_entry_id) === undefined) {
      throw invalid(`relation.to_entry_id non canonique (${String(relation.to_entry_id)}).`);
    }
    // Contrainte purement locale : elle ne demande aucun journal. Une entrée
    // qui se vise elle-même ne dit rien, quel que soit l'acte.
    if (relation.from_entry_id === relation.to_entry_id) {
      throw invalid('une relation ne peut pas viser sa propre origine.');
    }
  } else if (entry.relation !== undefined) {
    throw invalid(`relation est interdite pour ${entry.kind}.`);
  }

  if (isAuthority) {
    const authority = entry.authority;
    if (authority === undefined) throw invalid('authority est requise pour HUMAN_AUTHORITY_RECORDED.');
    if (!(AUTHORITY_ACTS as readonly string[]).includes(authority.act)) {
      throw invalid(`authority.act inconnu (${String(authority.act)}).`);
    }
    if (entry.semantic_origin.kind !== 'HUMAN') {
      throw invalid("une autorité humaine exige une origine sémantique HUMAN.");
    }
    if (authority.target_entry_id !== undefined
      && parseControversyEntrySequence(authority.target_entry_id) === undefined) {
      throw invalid(`authority.target_entry_id non canonique (${String(authority.target_entry_id)}).`);
    }
    if (authority.scope !== undefined) requireNonEmpty(authority.scope, 'authority.scope');
  } else if (entry.authority !== undefined) {
    throw invalid(`authority est interdite pour ${entry.kind}.`);
  }
}
