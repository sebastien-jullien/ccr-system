/**
 * Domaine V4 — Evidence Engine.
 *
 * Ce module porte le vocabulaire du domaine, et rien d'autre : aucune lecture,
 * aucune écriture, aucune horloge, aucun fournisseur. Les identifiants sont
 * **server-authoritative**, mais leur formatage et leur validation sont purs :
 * l'attribution appartient au store et au service, tranches ultérieures.
 *
 * ## Le finding que ce module matérialise
 *
 * ```text
 * LA RÉTENTION N'EST PAS L'INVOCATION
 * ```
 *
 * CCR conserve déjà des matériaux — quatre fichiers par tour d'expert — dont
 * aucun fait canonique ne parle. V4 sépare donc structurellement deux choses :
 *
 * ```text
 * MATÉRIAU     un objet enregistré, identifié, dont CCR sait ce qu'il en a observé
 * ADDUCTION    un acte historique : un acteur verse ce matériau à propos d'une cible
 * ```
 *
 * Une adduction **référence** un matériau ; elle n'en est jamais une propriété.
 * Un matériau ne porte ni cible, ni orientation, ni compteur, ni statut : la
 * séparation est portée par la **forme**, pas par une convention.
 *
 * ## Le mot employé, et pourquoi
 *
 * « Adduire » signifie *verser un matériau au débat*, et rien d'autre. Il ne dit
 * jamais que l'acteur a créé, écrit, fourni ou possédé ce matériau — la
 * provenance du matériau et l'origine sémantique de l'adduction sont deux faits
 * distincts. Le mot « invocation » n'est pas employé : depuis V2.2 il désigne un
 * appel fournisseur gouverné, et deux sens autoritaires sous un seul mot est
 * exactement le défaut que ce dépôt refuse partout ailleurs.
 *
 * ## Ce que ce module n'affirme jamais
 *
 * ```text
 * SUPPORTS    ≠  la cible est vraie
 * OBJECTS_TO  ≠  la cible est fausse
 * NONE        ≠  sans pertinence · ≠ doute · ≠ soutien faible
 * forme de représentation  ≠  qualité probatoire
 * ```
 *
 * Aucune force, aucune crédibilité, aucune suffisance, aucun score, aucun cycle
 * de vie. Les sept classes de preuve de `V0.5 §6` qualifient les preuves que
 * nous avons **sur CCR** ; elles n'apparaissent nulle part ici.
 */

import { CcrError } from './errors.ts';
import { formatControversyEntryId, parseControversyEntrySequence } from './controversy.ts';

/**
 * Version du journal V4, portée **par enregistrement**.
 *
 * Sans rapport avec `CONTROVERSY_SCHEMA_VERSION` ni avec les versions du ledger
 * d'invocation : trois domaines, trois compteurs.
 */
export const EVIDENCE_SCHEMA_VERSION = 1;

// --------------------------------------------------------------------------
// Identités
// --------------------------------------------------------------------------

const MATERIAL_ID_PATTERN = /^mat_(\d{6,})$/;
const ADDUCTION_ID_PATTERN = /^add_(\d{6,})$/;

function invalid(message: string): CcrError {
  return new CcrError('INVALID_ARGUMENT', `Entrée V4 invalide : ${message}`);
}

/**
 * Identité d'un matériau enregistré. Séquentielle **par run**, comme `ctve_`.
 *
 * Elle est épistémiquement neutre : elle atteste qu'un enregistrement existe
 * dans ce run, jamais que deux matériaux sont le même objet dans le monde.
 * Mêmes octets n'obligent pas à partager une identité, et une même URL ne
 * garantit pas un même contenu — CCR ne possède aucune autorité d'équivalence.
 */
export function formatMaterialId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Séquence de matériau invalide : ${String(sequence)}`);
  }
  return `mat_${String(sequence).padStart(6, '0')}`;
}

export function parseMaterialSequence(id: string): number | undefined {
  const digits = MATERIAL_ID_PATTERN.exec(id)?.[1];
  return digits === undefined ? undefined : Number.parseInt(digits, 10);
}

/**
 * Identité d'une adduction.
 *
 * Espace de noms **disjoint** de celui des matériaux, préfixe compris : une
 * adduction référence un matériau, et confondre les deux espaces rendrait cette
 * référence ambiguë.
 */
export function formatAdductionId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Séquence d'adduction invalide : ${String(sequence)}`);
  }
  return `add_${String(sequence).padStart(6, '0')}`;
}

export function parseAdductionSequence(id: string): number | undefined {
  const digits = ADDUCTION_ID_PATTERN.exec(id)?.[1];
  return digits === undefined ? undefined : Number.parseInt(digits, 10);
}

/**
 * Forme canonique exacte, exigée par le contrat (§2.1).
 *
 * `\d{6,}` est **non borné**, et `Number.parseInt` absorbe les zéros de tête :
 * sans aller-retour, `mat_0000001` et deux cent mille chiffres passeraient tous
 * deux pour canoniques. Le contrat exige `format(parse(id)) === id`, et c'est
 * cette égalité — et elle seule — qui fait foi.
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

export function isMaterialId(value: unknown): boolean {
  return isCanonical(value, parseMaterialSequence, formatMaterialId);
}

export function isAdductionId(value: unknown): boolean {
  return isCanonical(value, parseAdductionSequence, formatAdductionId);
}

/**
 * Identité d'une **entrée** de controverse, seule identité qu'une cible porte.
 *
 * Les primitives V3 font autorité et ne sont pas réimplémentées ici : ce module
 * les compose avec la garde d'aller-retour du contrat V4. `ctv_` — l'identité
 * d'une controverse — n'est jamais une cible : viser l'entrée d'ouverture vise
 * exactement cette entrée, jamais l'agrégat.
 */
export function isControversyEntryTargetId(value: unknown): boolean {
  return isCanonical(value, parseControversyEntrySequence, formatControversyEntryId);
}

// --------------------------------------------------------------------------
// Vocabulaires fermés
// --------------------------------------------------------------------------

export const EVIDENCE_ENTRY_KINDS = ['MATERIAL_RECORDED', 'ADDUCTION_RECORDED'] as const;
export type EvidenceEntryKind = (typeof EVIDENCE_ENTRY_KINDS)[number];

/**
 * Formes de représentation d'un matériau — **trois, et trois seulement**.
 *
 * Ce n'est **pas** une taxonomie argumentative. Les trois se distinguent
 * uniquement parce que la vérification déterministe possible n'est pas la même :
 * une citation ne peut être confrontée que si CCR détient une représentation.
 * Sans cette conséquence mécanique, aucune des trois n'existerait.
 *
 * Aucune n'est plus forte, plus fiable ou plus probante qu'une autre, et aucune
 * lecture ne peut les ordonner.
 */
export const MATERIAL_REPRESENTATION_FORMS = [
  'RUN_EVENT',
  'INLINE_TEXT',
  'EXTERNAL_REFERENCE',
] as const;
export type MaterialRepresentationForm = (typeof MATERIAL_REPRESENTATION_FORMS)[number];

/**
 * Origine sémantique de la **soumission** d'un matériau.
 *
 * `HUMAN` uniquement au premier palier. Un matériau peut *provenir* d'un expert
 * ou d'un tiers ; cela ne fait pas de cette source l'auteur de la soumission,
 * et encore moins l'auteur d'une adduction.
 */
export const MATERIAL_SUBMISSION_ORIGINS = ['HUMAN'] as const;
export type MaterialSubmissionOrigin = (typeof MATERIAL_SUBMISSION_ORIGINS)[number];

/**
 * Orientation argumentative — union fermée, champ **obligatoire**.
 *
 * `NONE` est une **valeur**, jamais une absence. Représenter l'absence
 * d'orientation par un champ absent, `null` ou un défaut implicite permettrait
 * de la reconstruire comme une position cachée — ce que le contrat interdit.
 *
 * Une orientation est **déclarée par un acteur**. Elle n'est jamais un constat
 * de CCR, et aucune surface ne peut la calculer, l'inférer ni la compléter.
 */
export const ORIENTATIONS = ['NONE', 'SUPPORTS', 'OBJECTS_TO'] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

/**
 * Origine sémantique d'une adduction — les deux admises par
 * `docs/specs/evidence.md`.
 *
 * Ni `SOURCE` — un expert versant lui-même —, ni une origine CCR purement
 * déterministe. Les introduire exigerait une **nouvelle décision humaine**, pas
 * une extension technique.
 */
export const ADDUCTION_SEMANTIC_ORIGINS = ['HUMAN', 'CCR'] as const;
export type AdductionSemanticOrigin = (typeof ADDUCTION_SEMANTIC_ORIGINS)[number];

/**
 * Méthode de dérivation — **une seule valeur** en V4.
 *
 * L'union existe pour que le champ soit fermé et refusé s'il porte autre chose,
 * pas pour préparer une seconde méthode.
 */
export const ADDUCTION_DERIVATION_METHODS = ['MODEL_ASSISTED'] as const;
export type AdductionDerivationMethod = (typeof ADDUCTION_DERIVATION_METHODS)[number];

/** Sorte de cible — une seule au premier palier. */
export const EVIDENCE_TARGET_KINDS = ['CONTROVERSY_ENTRY'] as const;
export type EvidenceTargetKind = (typeof EVIDENCE_TARGET_KINDS)[number];

/** Le scribe. CCR tient le journal ; cela n'en fait jamais l'auteur sémantique. */
export const EVIDENCE_RECORDING_ACTORS = ['CCR'] as const;
export type EvidenceRecordingActor = (typeof EVIDENCE_RECORDING_ACTORS)[number];

// --------------------------------------------------------------------------
// Bornes
// --------------------------------------------------------------------------

/** Alignée sur `MAX_CONTROVERSY_TEXT_BYTES` : même discipline, même refus. */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024;
export const MAX_LOCATOR_BYTES = 4 * 1024;
export const MAX_LABEL_BYTES = 4 * 1024;

/**
 * Seule forme d'empreinte canonique du dépôt.
 *
 * Elle qualifie une empreinte **déclarée par l'appelant**. CCR ne la calcule
 * pas, ne la vérifie pas, et ne l'oppose à rien : `declared_digest` n'est jamais
 * une confirmation d'intégrité.
 */
const DECLARED_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

// --------------------------------------------------------------------------
// Formes
// --------------------------------------------------------------------------

/** Le matériau **est** un événement canonique de ce run. CCR détient le contenu. */
export interface RunEventRepresentation {
  readonly form: 'RUN_EVENT';
  readonly event_id: string;
}

/** Texte fourni par l'appelant, capturé verbatim. CCR détient le contenu. */
export interface InlineTextRepresentation {
  readonly form: 'INLINE_TEXT';
  readonly text: string;
}

/**
 * Un localisateur enregistré comme chaîne, et **rien d'autre**.
 *
 * L'enregistrer établit exactement ceci : cette chaîne a été enregistrée comme
 * localisateur, par cet acteur, à cette date. Jamais que CCR a observé le
 * contenu désigné, qu'il existe, qu'il est accessible ou qu'il est stable.
 */
export interface ExternalReferenceRepresentation {
  readonly form: 'EXTERNAL_REFERENCE';
  readonly locator: string;
  /** Déclarée par l'appelant. Jamais calculée, jamais vérifiée par CCR. */
  readonly declared_digest?: string;
}

export type MaterialRepresentation =
  | RunEventRepresentation
  | InlineTextRepresentation
  | ExternalReferenceRepresentation;

/**
 * CCR détient-il une représentation de ce matériau ?
 *
 * Booléen **structurel** : il découle de la forme, et l'appelant ne peut donc
 * pas construire la combinaison impossible « référence externe observée ».
 */
export function materialIsHeld(form: MaterialRepresentationForm): boolean {
  return form === 'RUN_EVENT' || form === 'INLINE_TEXT';
}

/** Cible d'une adduction. Canonique — jamais un texte libre, jamais un sélecteur. */
export interface EvidenceTargetRef {
  readonly kind: EvidenceTargetKind;
  readonly entry_id: string;
}

/**
 * Citation — au plus une par adduction, portée par un champ unique.
 *
 * Aucun décalage n'est stocké : ni octet, ni point de code, ni unité UTF-16.
 * La citation se confronte à l'original, comme l'ancrage textuel V3, plutôt que
 * de désigner un fragment plausible qu'aucun contrôle ne démentirait.
 *
 * `occurrence` est un **rang 1-based**, et les occurrences chevauchantes sont
 * comptées. Le contrat V4 emploie le mot « rang » sans le redéfinir : la
 * convention est donc celle, documentée, de `TextualAnchor` en V3.
 */
export interface AdductionCitation {
  readonly quoted_text: string;
  readonly occurrence: number;
}

/**
 * Dérivation d'une adduction inférée par CCR.
 *
 * Elle dit **comment** l'inférence a été produite et **sur quoi** elle a porté.
 * Elle ne confère aucune autorité de mérite : une adduction dérivée reste une
 * proposition attribuée, dont l'orientation n'est jamais validée.
 *
 * `inputs` est l'ensemble réellement soumis au modèle. Sa vérification contre
 * l'ensemble de dispatch appartient à S7-B ; ce module n'en valide que la forme.
 */
export interface AdductionDerivation {
  readonly method: AdductionDerivationMethod;
  readonly invocation_id: string;
  readonly inputs: readonly string[];
}

/**
 * Enveloppe commune, discriminée par `kind`.
 *
 * Aucun champ de mutation d'état n'y figure — ni `status`, ni `active`, ni
 * `closed`, ni `deleted`, ni `superseded`, ni compteur. Une adduction ultérieure
 * n'efface jamais une adduction antérieure : le journal est append-only, et une
 * position contraire est un **fait nouveau**, jamais une correction.
 */
interface EvidenceEntryCommon {
  readonly schema_version: number;
  readonly entry_id: string;
  readonly kind: EvidenceEntryKind;
  readonly recorded_by: EvidenceRecordingActor;
  readonly recorded_at: string;
}

export interface MaterialRecordedEntry extends EvidenceEntryCommon {
  readonly kind: 'MATERIAL_RECORDED';
  readonly submitted_by: MaterialSubmissionOrigin;
  readonly representation: MaterialRepresentation;
  /**
   * Booléen structurel, cohérent avec la forme par construction.
   *
   * Il dit ce que CCR détient, jamais ce qu'il croit. Il ne qualifie pas la
   * pièce : un matériau non détenu n'est ni faux, ni douteux, ni faible.
   */
  readonly observed_by_ccr: boolean;
  /** Texte libre borné, destiné à l'humain. **Jamais une catégorie.** */
  readonly label?: string;
}

export interface AdductionRecordedEntry extends EvidenceEntryCommon {
  readonly kind: 'ADDUCTION_RECORDED';
  readonly material_id: string;
  readonly target: EvidenceTargetRef;
  readonly orientation: Orientation;
  readonly semantic_origin: AdductionSemanticOrigin;
  readonly derivation?: AdductionDerivation;
  readonly citation?: AdductionCitation;
}

export type EvidenceEntry = MaterialRecordedEntry | AdductionRecordedEntry;

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

function requireNonEmpty(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${path} doit être une chaîne non vide.`);
  }
}

function requireBounded(value: string, max: number, path: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > max) {
    throw invalid(`${path} dépasse la borne d'écriture V4 : refus, jamais troncature.`);
  }
}

function requireClosed<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
  path: string,
): void {
  if (typeof value !== 'string' || !(vocabulary as readonly string[]).includes(value)) {
    throw invalid(`${path} inconnu (${String(value)}).`);
  }
}

function validateRepresentation(representation: MaterialRepresentation): void {
  requireClosed(representation.form, MATERIAL_REPRESENTATION_FORMS, 'representation.form');

  // `declared_digest` est confiné à la référence externe. Le tolérer sur un
  // contenu détenu porterait une empreinte que CCR n'a pas calculée à côté
  // d'octets qu'il possède : un lecteur y lirait une intégrité confirmée.
  if (representation.form !== 'EXTERNAL_REFERENCE' && 'declared_digest' in representation) {
    throw invalid(
      `representation.declared_digest est interdit sur une représentation ${representation.form} : ` +
        "une empreinte déclarée ne qualifie qu'un matériau que CCR ne détient pas.",
    );
  }

  switch (representation.form) {
    case 'RUN_EVENT':
      requireNonEmpty(representation.event_id, 'representation.event_id');
      return;

    case 'INLINE_TEXT':
      requireNonEmpty(representation.text, 'representation.text');
      requireBounded(representation.text, MAX_INLINE_TEXT_BYTES, 'representation.text');
      return;

    case 'EXTERNAL_REFERENCE': {
      requireNonEmpty(representation.locator, 'representation.locator');
      requireBounded(representation.locator, MAX_LOCATOR_BYTES, 'representation.locator');
      const digest = representation.declared_digest;
      if (digest !== undefined && !DECLARED_DIGEST_PATTERN.test(digest)) {
        throw invalid(
          'representation.declared_digest doit porter la forme canonique. ' +
            "Elle reste DÉCLARÉE : CCR ne l'a pas calculée et ne la vérifie pas.",
        );
      }
      return;
    }
  }
}

function validateMaterial(entry: MaterialRecordedEntry): void {
  requireClosed(entry.submitted_by, MATERIAL_SUBMISSION_ORIGINS, 'submitted_by');
  validateRepresentation(entry.representation);

  // Le booléen suit la forme. Une référence externe « observée » décrirait une
  // observation qui n'a jamais eu lieu ; un contenu détenu « non observé »
  // masquerait une confrontation possible.
  const held = materialIsHeld(entry.representation.form);
  if (typeof entry.observed_by_ccr !== 'boolean' || entry.observed_by_ccr !== held) {
    throw invalid(
      `observed_by_ccr doit valoir ${String(held)} pour une représentation ` +
        `${entry.representation.form} : ce booléen suit la forme, il ne se déclare pas.`,
    );
  }

  if (entry.label !== undefined) {
    requireNonEmpty(entry.label, 'label');
    requireBounded(entry.label, MAX_LABEL_BYTES, 'label');
  }

  for (const forbidden of ['material_id', 'target', 'orientation', 'citation', 'derivation']) {
    if (forbidden in entry) {
      throw invalid(`${forbidden} est interdit sur un matériau : une adduction n'en est pas une propriété.`);
    }
  }
}

function validateDerivation(derivation: AdductionDerivation): void {
  requireClosed(derivation.method, ADDUCTION_DERIVATION_METHODS, 'derivation.method');
  requireNonEmpty(derivation.invocation_id, 'derivation.invocation_id');
  if (!Array.isArray(derivation.inputs)) {
    throw invalid('derivation.inputs doit être une liste.');
  }
  derivation.inputs.forEach((input, index) => {
    requireNonEmpty(input, `derivation.inputs[${String(index)}]`);
  });
}

function validateCitation(citation: AdductionCitation): void {
  requireNonEmpty(citation.quoted_text, 'citation.quoted_text');
  requireBounded(citation.quoted_text, MAX_INLINE_TEXT_BYTES, 'citation.quoted_text');
  if (!Number.isSafeInteger(citation.occurrence) || citation.occurrence < 1) {
    throw invalid('citation.occurrence doit être un rang entier supérieur ou égal à 1.');
  }
}

function validateAdduction(entry: AdductionRecordedEntry): void {
  if (!isMaterialId(entry.material_id)) {
    throw invalid(`material_id non canonique (${String(entry.material_id)}).`);
  }

  requireClosed(entry.target?.kind, EVIDENCE_TARGET_KINDS, 'target.kind');
  if (!isControversyEntryTargetId(entry.target.entry_id)) {
    throw invalid(
      `target.entry_id non canonique (${String(entry.target.entry_id)}). ` +
        "Une cible est une ENTRÉE — `ctv_` désigne une controverse, jamais une cible.",
    );
  }

  requireClosed(entry.orientation, ORIENTATIONS, 'orientation');
  requireClosed(entry.semantic_origin, ADDUCTION_SEMANTIC_ORIGINS, 'semantic_origin');

  // Exclusion mutuelle stricte : c'est ce qui rend impossible une adduction
  // humaine portant une dérivation modèle, et une inférence CCR sans dérivation.
  if (entry.semantic_origin === 'CCR') {
    if (entry.derivation === undefined) {
      throw invalid('derivation est exigée pour une origine CCR.');
    }
    validateDerivation(entry.derivation);
  } else if (entry.derivation !== undefined) {
    throw invalid(`derivation est interdite pour une origine ${entry.semantic_origin}.`);
  }

  if (entry.citation !== undefined) validateCitation(entry.citation);
}

/**
 * Valide une entrée V4 et la rend telle quelle.
 *
 * Refuse plutôt que de corriger : aucune normalisation, aucune troncature,
 * aucune valeur par défaut. Les unions sont fermées, et une valeur inconnue est
 * refusée — il n'existe aucune permissivité « à l'épreuve du futur », dont
 * l'effet serait d'accepter en silence ce que le contrat n'a pas prévu.
 *
 * Ce que cette fonction **ne peut pas** établir, faute d'I/O : qu'un matériau,
 * une cible ou un événement existent réellement dans le run, ni qu'une citation
 * figure dans une représentation. Ces contrôles appartiennent au store et au
 * service, et le contrat les nomme.
 */
export function validateEvidenceEntry(entry: EvidenceEntry): EvidenceEntry {
  if (entry.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    throw invalid(`schema_version non pris en charge (${String(entry.schema_version)}).`);
  }
  requireClosed(entry.kind, EVIDENCE_ENTRY_KINDS, 'kind');
  requireClosed(entry.recorded_by, EVIDENCE_RECORDING_ACTORS, 'recorded_by');
  requireNonEmpty(entry.recorded_at, 'recorded_at');

  const expected = entry.kind === 'MATERIAL_RECORDED' ? isMaterialId : isAdductionId;
  if (!expected(entry.entry_id)) {
    throw invalid(`entry_id non canonique pour ${entry.kind} (${String(entry.entry_id)}).`);
  }

  if (entry.kind === 'MATERIAL_RECORDED') validateMaterial(entry);
  else validateAdduction(entry);

  return entry;
}

/**
 * Une citation est-elle structurellement possible sur ce matériau ?
 *
 * Prédicat **pur**, appelé par le service une fois le matériau résolu : ce
 * module ne connaît d'une adduction que le `material_id`, et ne peut donc pas
 * décider seul. La règle, elle, est du domaine.
 *
 * Le refus est **mécanique, jamais doctrinal** : sans représentation détenue, il
 * n'existe rien à confronter. Il porte sur la citation, jamais sur l'adduction —
 * verser au débat un matériau que CCR n'a pas observé reste parfaitement admis,
 * parce que non vérifiable ne signifie pas faux.
 */
export function assertCitationSupportedByMaterial(
  entry: AdductionRecordedEntry,
  form: MaterialRepresentationForm,
): void {
  if (entry.citation === undefined) return;
  if (!materialIsHeld(form)) {
    throw invalid(
      `une citation est impossible sur un matériau ${form} : CCR n'en détient aucune ` +
        "représentation à confronter. Le refus porte sur la citation, jamais sur l'adduction.",
    );
  }
}
