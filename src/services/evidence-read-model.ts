/**
 * Projection V4 — lecture seule, server-authoritative.
 *
 * Tranche S3 du plan gelé. Ce module compose **au-dessus du snapshot natif déjà
 * lu**, exactement comme la projection V3 : il n'ouvre aucun fichier, n'écrit
 * rien, ne touche pas `rounds/`, et ne consulte ni le ledger d'invocation, ni le
 * réseau.
 *
 * ```text
 * UN snapshot stable  →  UNE projection déterministe
 * ```
 *
 * Relire `evidence.jsonl` ici ouvrirait une fenêtre entre les entrées projetées
 * et les événements contre lesquels elles se résolvent : la vue rendue pourrait
 * décrire une combinaison qui n'a jamais coexisté. C'est précisément ce que le
 * protocole de snapshot existe pour interdire.
 *
 * ## Ce que cette projection dérive, et ce qu'elle n'affirme jamais
 *
 * Elle dérive une **vérifiabilité** — ce que CCR peut constater — et une
 * **résolution de citation**. Rien d'autre.
 *
 * ```text
 * UNRESOLVABLE          ≠ FAUX
 * NOT_OBSERVED_BY_CCR   ≠ FAUX  ≠ ABSENT  ≠ INEXISTANT
 * SUPPORTS              ≠ la cible est vraie
 * OBJECTS_TO            ≠ la cible est fausse
 * NONE                  ≠ sans pertinence
 * ```
 *
 * Aucune force, aucune fiabilité, aucune crédibilité, aucune suffisance, aucun
 * classement, aucun gagnant. La vérifiabilité décrit ce qui a pu être constaté,
 * jamais une qualité de la pièce.
 *
 * ## Dérivée à la lecture, jamais persistée
 *
 * Une citation qui cesse de se résoudre ne réécrit rien : l'entrée historique
 * demeure, et seule la projection change. C'est le précédent `unresolvable_anchors`
 * de V3, repris sans altération.
 */

import type { EvidenceEntry, MaterialRecordedEntry, AdductionRecordedEntry } from '../core/evidence.ts';
import { materialIsHeld } from '../core/evidence.ts';
import type { NativeCcrEvent } from '../core/run-native.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';

/** Version de la forme projetée. Sans rapport avec celle du journal V4. */
export const EVIDENCE_READ_MODEL_VERSION = 1;

// --------------------------------------------------------------------------
// Formes
// --------------------------------------------------------------------------

/**
 * Motif d'un matériau détenu qui ne se relit pas.
 *
 * Union fermée, reprise du contrat sans extension. `EVENT_NOT_FOUND` couvre un
 * `RUN_EVENT` dont l'événement a disparu du journal natif ; `CONTENT_UNAVAILABLE`
 * un événement présent qui ne porte aucun contenu textuel.
 */
export const MATERIAL_UNRESOLVABLE_REASONS = ['EVENT_NOT_FOUND', 'CONTENT_UNAVAILABLE'] as const;
export type MaterialUnresolvableReason = (typeof MATERIAL_UNRESOLVABLE_REASONS)[number];

/**
 * Vérifiabilité d'un matériau — **dérivée**, jamais persistée.
 *
 * Union discriminée : un motif ne peut exister sans son cas, et un matériau
 * jamais observé ne peut pas porter un motif de non-résolution, qui laisserait
 * croire qu'une lecture a été tentée.
 */
export type MaterialVerifiabilityV1 =
  | { readonly kind: 'HELD_AND_RESOLVABLE' }
  | { readonly kind: 'HELD_BUT_UNRESOLVABLE'; readonly reason: MaterialUnresolvableReason }
  | { readonly kind: 'NOT_OBSERVED_BY_CCR' };

/**
 * Motif d'une citation qui ne se résout pas. Union fermée du contrat.
 *
 * `MATERIAL_NOT_HELD` couvre les deux situations où **rien n'est disponible à
 * confronter** : un matériau de forme `EXTERNAL_REFERENCE`, et un `material_id`
 * qui ne résout pas dans ce journal. La seconde ne peut être produite par aucun
 * chemin d'écriture CCR — S4 et S7-B exigent tous deux que le matériau résolve —
 * mais une projection ne suppose pas ses entrées : elle rend le fait, avec le
 * seul motif que le contrat admet.
 */
export const CITATION_UNRESOLVABLE_REASONS = [
  'MATERIAL_NOT_HELD',
  'CONTENT_UNAVAILABLE',
  'OCCURRENCE_NOT_FOUND',
] as const;
export type CitationUnresolvableReason = (typeof CITATION_UNRESOLVABLE_REASONS)[number];

export type CitationResolutionV1 =
  | { readonly kind: 'RESOLVABLE' }
  | { readonly kind: 'UNRESOLVABLE'; readonly reason: CitationUnresolvableReason };

/** Un matériau enregistré, et ce que CCR peut en constater aujourd'hui. */
export interface MaterialItemV1 {
  readonly entry: MaterialRecordedEntry;
  readonly verifiability: MaterialVerifiabilityV1;
}

/**
 * Une adduction enregistrée, et la résolution de sa citation s'il y en a une.
 *
 * `null` dit qu'aucune citation n'a été portée — pas qu'une résolution a échoué.
 * Le matériau et la cible restent désignés par leurs identifiants canoniques :
 * les recopier créerait une seconde vérité capable de diverger.
 */
export interface AdductionItemV1 {
  readonly entry: AdductionRecordedEntry;
  readonly citation_resolution: CitationResolutionV1 | null;
}

/**
 * Projection V4 — union **discriminée**.
 *
 * `NOT_AVAILABLE` ne porte aucune autre clé : un run historique n'a pas été
 * regardé, et il ne doit pas pouvoir porter un zéro. La distinction est
 * structurelle, pas conventionnelle.
 */
export type EvidenceReadModelV1 =
  | {
      readonly read_model_version: number;
      readonly availability: 'NOT_AVAILABLE';
    }
  | {
      readonly read_model_version: number;
      readonly availability: 'AVAILABLE';
      /** Jeton de fraîcheur V4, **repris du snapshot**, jamais recalculé ici. */
      readonly evidence_revision: string;
      /** Deux listes plates, dans l'ordre d'append. Aucun regroupement. */
      readonly materials: readonly MaterialItemV1[];
      readonly adductions: readonly AdductionItemV1[];
      /** Égaux aux longueurs par construction — le client ne dérive aucun compte. */
      readonly recorded_material_count: number;
      readonly recorded_adduction_count: number;
    };

// --------------------------------------------------------------------------
// Legacy
// --------------------------------------------------------------------------

/**
 * Projection d'un run historique.
 *
 * `NOT_AVAILABLE` n'est pas un zéro : V4 ne s'applique pas à cette génération,
 * et prétendre y avoir compté zéro matériau serait affirmer un regard qui n'a
 * pas eu lieu.
 */
export function evidenceReadModelNotAvailable(): EvidenceReadModelV1 {
  return {
    read_model_version: EVIDENCE_READ_MODEL_VERSION,
    availability: 'NOT_AVAILABLE',
  };
}

// --------------------------------------------------------------------------
// Résolution — déterministe, depuis le snapshot
// --------------------------------------------------------------------------

/**
 * Occurrences exactes, **chevauchements compris**, rang 1-based.
 *
 * Règle identique à celle de la projection V3, délibérément réénoncée plutôt
 * que partagée : la mutualiser exigerait d'exporter une fonction privée d'un
 * module V3 gelé, donc de le modifier. Deux comptages différents donneraient
 * deux rangs pour la même citation ; celui-ci reprend `start + 1`, jamais
 * `start + longueur`.
 */
function occurrenceExists(content: string, quoted: string, occurrence: number): boolean {
  let found = 0;
  let from = 0;
  for (;;) {
    const index = content.indexOf(quoted, from);
    if (index === -1) return false;
    found += 1;
    if (found === occurrence) return true;
    from = index + 1;
  }
}

/**
 * Contenu réellement disponible d'un matériau, ou le motif de son absence.
 *
 * Un `EXTERNAL_REFERENCE` rend `null` sans motif : rien n'a jamais été observé,
 * et il n'y a donc pas eu d'échec de lecture.
 */
function heldContent(
  representation: MaterialRecordedEntry['representation'],
  events: ReadonlyMap<string, NativeCcrEvent>,
): { readonly content: string } | { readonly reason: MaterialUnresolvableReason } | null {
  switch (representation.form) {
    case 'INLINE_TEXT':
      // Le contenu est dans l'enregistrement lui-même : rien à retrouver.
      return { content: representation.text };

    case 'RUN_EVENT': {
      const event = events.get(representation.event_id);
      if (event === undefined) return { reason: 'EVENT_NOT_FOUND' };
      const content = event.content;
      if (typeof content !== 'string') return { reason: 'CONTENT_UNAVAILABLE' };
      return { content };
    }

    case 'EXTERNAL_REFERENCE':
      // Aucune récupération, aucune requête, aucune résolution du localisateur.
      // CCR n'a observé que la chaîne enregistrée.
      return null;
  }
}

function classifyMaterial(
  entry: MaterialRecordedEntry,
  events: ReadonlyMap<string, NativeCcrEvent>,
): MaterialVerifiabilityV1 {
  if (!materialIsHeld(entry.representation.form)) return { kind: 'NOT_OBSERVED_BY_CCR' };
  const held = heldContent(entry.representation, events);
  if (held === null) return { kind: 'NOT_OBSERVED_BY_CCR' };
  return 'reason' in held
    ? { kind: 'HELD_BUT_UNRESOLVABLE', reason: held.reason }
    : { kind: 'HELD_AND_RESOLVABLE' };
}

function classifyCitation(
  entry: AdductionRecordedEntry,
  materials: ReadonlyMap<string, MaterialRecordedEntry>,
  events: ReadonlyMap<string, NativeCcrEvent>,
): CitationResolutionV1 | null {
  const citation = entry.citation;
  if (citation === undefined) return null;

  const material = materials.get(entry.material_id);
  if (material === undefined) return { kind: 'UNRESOLVABLE', reason: 'MATERIAL_NOT_HELD' };

  const held = heldContent(material.representation, events);
  if (held === null) return { kind: 'UNRESOLVABLE', reason: 'MATERIAL_NOT_HELD' };
  if ('reason' in held) return { kind: 'UNRESOLVABLE', reason: 'CONTENT_UNAVAILABLE' };

  return occurrenceExists(held.content, citation.quoted_text, citation.occurrence)
    ? { kind: 'RESOLVABLE' }
    : { kind: 'UNRESOLVABLE', reason: 'OCCURRENCE_NOT_FOUND' };
}

// --------------------------------------------------------------------------
// Projection
// --------------------------------------------------------------------------

function isMaterial(entry: EvidenceEntry): entry is MaterialRecordedEntry {
  return entry.kind === 'MATERIAL_RECORDED';
}

/**
 * Projette les entrées V4 du snapshot en deux listes plates.
 *
 * L'ordre de chaque liste est celui du journal, seul ordre autoritaire qui
 * existe. Aucun horodatage n'est consulté, aucun identifiant n'est trié, aucune
 * entrée n'est regroupée, fusionnée ni dédupliquée : deux matériaux de charge
 * identique restent deux éléments, et deux adductions identiques aussi.
 *
 * Un journal absent et un journal vide produisent la même paire de listes
 * vides — c'est `evidence_revision` qui porte leur différence, comme le contrat
 * l'exige.
 */
export function projectEvidenceReadModel(snapshot: NativeRunSnapshot): EvidenceReadModelV1 {
  const events = new Map<string, NativeCcrEvent>();
  for (const event of snapshot.events) events.set(event.event_id, event);

  const materialsById = new Map<string, MaterialRecordedEntry>();
  for (const entry of snapshot.evidence) {
    if (isMaterial(entry)) materialsById.set(entry.entry_id, entry);
  }

  const materials: MaterialItemV1[] = [];
  const adductions: AdductionItemV1[] = [];

  for (const entry of snapshot.evidence) {
    if (isMaterial(entry)) {
      materials.push({ entry, verifiability: classifyMaterial(entry, events) });
    } else {
      adductions.push({ entry, citation_resolution: classifyCitation(entry, materialsById, events) });
    }
  }

  return {
    read_model_version: EVIDENCE_READ_MODEL_VERSION,
    availability: 'AVAILABLE',
    evidence_revision: snapshot.evidence_revision,
    materials,
    adductions,
    recorded_material_count: materials.length,
    recorded_adduction_count: adductions.length,
  };
}
