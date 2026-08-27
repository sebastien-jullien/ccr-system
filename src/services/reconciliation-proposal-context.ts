/**
 * Contexte canonique d'une proposition assistée (`V5.1`).
 *
 * ## Pourquoi ce module existe
 *
 * Jusqu'ici, le chemin assisté transmettait au modèle deux identifiants nus —
 * `ctv_…` et `ctve_…` — et rien d'autre. La qualification réelle du 2026-08-21
 * a rendu ce fait observable : deux fournisseurs, deux sessions neuves, deux
 * `VALID_ZERO`. L'addendum d'autorité du même jour comble le silence du §35 :
 *
 * ```text
 * PROPOSAL_CONTEXT_POLICY = EXPLICIT_CANONICAL_CONTEXT
 * ```
 *
 * ## Ce que ce module fait, et rien d'autre
 *
 * ```text
 * sélectionner  →  sérialiser  →  mesurer  →  condenser
 * ```
 *
 * Il ne lit aucun fichier, n'interroge aucun read model, n'atteint aucun
 * fournisseur, ne reprend aucune session native et ne dépend d'aucune surface.
 * Sa **seule** source est l'instantané stable de la phase A — celui qui porte
 * déjà `R0` — si bien que le contexte décrit exactement le monde sur lequel la
 * revalidation portera.
 *
 * ## Périmètre et contexte
 *
 * ```text
 * SUBMITTED  ce sur quoi une proposition peut porter
 * CONTEXT    ce qui permet de comprendre ces unités
 * ```
 *
 * Les événements ancrés et les preuves versées sont des **sources de
 * contexte**. Ils n'entrent jamais dans l'ensemble soumis, et `derivation.inputs`
 * continue de ne désigner que les unités. Confondre les deux ferait entrer par
 * la lecture ce que le périmètre avait exclu.
 *
 * ```text
 * EXISTE DANS LE CONTEXTE  ≠  A ÉTÉ SOUMIS
 * ```
 *
 * ## Ordre
 *
 * Celui des journaux, toujours. Aucun tri par longueur, orientation, rôle,
 * fournisseur ni nombre de preuves : un ordre choisi serait une hiérarchie
 * argumentative, et le §12 du contrat l'interdit déjà pour les options rendues.
 *
 * ```text
 * SERVER ORDER  ≠  PREFERENCE
 * ```
 */

import { createHash } from 'node:crypto';

import { CcrError } from '../core/errors.ts';
import type { ControversyEntry } from '../core/controversy.ts';
import type { EvidenceEntry, MaterialRecordedEntry } from '../core/evidence.ts';
import type { NativeCcrEvent } from '../core/run-native.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';

/**
 * Version de **composition** du contexte.
 *
 * Elle ne décrit ni le contrat V5, ni un schéma persisté : elle identifie la
 * règle de sélection et de sérialisation employée. Deux contextes portant la
 * même version et les mêmes sources produisent le même condensat.
 */
export const PROPOSAL_CONTEXT_VERSION = 1;

/**
 * Borne d'octets du contexte — décision humaine du 2026-08-21, §14.
 *
 * Elle porte sur la **même** chaîne canonique que celle mesurée, condensée et
 * injectée. Aucune troncature, aucun résumé : au-delà, le refus est
 * déterministe et antérieur à tout engagement.
 */
export const MAX_PROPOSAL_CONTEXT_UTF8_BYTES = 131072;

/** Règle de sérialisation, nommée pour être citable dans une preuve. */
export const CANONICAL_SERIALIZATION_RULE =
  'CCR-V51-PROPOSAL-CONTEXT/1 · sections fixes · ordre des journaux · UTF-8 · LF';

// --------------------------------------------------------------------------
// Formes retenues — sous-ensembles fermés des objets propriétaires
// --------------------------------------------------------------------------

/** Une unité soumise, telle que V3 la détient. Aucun champ reformulé. */
export interface ProposalContextEntry {
  readonly entry_id: string;
  readonly controversy_id: string;
  readonly kind: string;
  readonly semantic_origin: string;
  readonly content: string | null;
  readonly provenance: readonly { readonly event_id: string; readonly round: number }[];
  readonly textual: { readonly event_id: string; readonly quoted_text: string; readonly occurrence: number } | null;
  readonly semantic: { readonly text: string; readonly semantic_origin: string } | null;
}

/** Un événement **réellement ancré**. Jamais un voisin du journal. */
export interface ProposalContextEvent {
  readonly event_id: string;
  readonly round: number;
  readonly actor: string;
  readonly type: string;
  readonly expert_slot_id: string | null;
  readonly content: string | null;
}

export interface ProposalContextAdduction {
  readonly entry_id: string;
  readonly target_kind: string;
  readonly target_entry_id: string;
  readonly orientation: string;
  readonly material_id: string;
  readonly citation: string | null;
}

export interface ProposalContextMaterial {
  readonly entry_id: string;
  readonly form: string;
  readonly label: string | null;
  /** `RUN_EVENT` — identité de l'événement représenté. */
  readonly event_id: string | null;
  /**
   * Contenu rendu **uniquement** lorsqu'il ne figure pas déjà en section
   * provenance : un même événement n'est jamais sérialisé deux fois.
   */
  readonly content: string | null;
  /** `EXTERNAL_REFERENCE` — métadonnées enregistrées, jamais résolues. */
  readonly locator: string | null;
  readonly declared_digest: string | null;
}

export interface ProposalContext {
  readonly context_version: number;
  readonly target_controversy_id: string;
  readonly submitted: readonly string[];
  readonly entries: readonly ProposalContextEntry[];
  readonly events: readonly ProposalContextEvent[];
  readonly adductions: readonly ProposalContextAdduction[];
  readonly materials: readonly ProposalContextMaterial[];
}

/** Ce qui est journalisé de ce contexte — jamais le contexte lui-même. */
export interface ProposalContextAudit {
  readonly context_version: number;
  readonly context_source_ids: readonly string[];
  readonly context_utf8_bytes: number;
  readonly context_sha256: string;
}

// --------------------------------------------------------------------------
// Sélection déterministe
// --------------------------------------------------------------------------

function isAdduction(entry: EvidenceEntry): entry is Extract<EvidenceEntry, { kind: 'ADDUCTION_RECORDED' }> {
  return entry.kind === 'ADDUCTION_RECORDED';
}

function isMaterial(entry: EvidenceEntry): entry is MaterialRecordedEntry {
  return entry.kind === 'MATERIAL_RECORDED';
}

function slotOf(event: NativeCcrEvent): string | null {
  if ('expert_slot_id' in event && typeof event.expert_slot_id === 'string') return event.expert_slot_id;
  if ('target_expert_slot_id' in event && typeof event.target_expert_slot_id === 'string') {
    return event.target_expert_slot_id;
  }
  return null;
}

function projectEntry(entry: ControversyEntry): ProposalContextEntry {
  const anchors = entry.anchors;
  return {
    entry_id: entry.entry_id,
    controversy_id: entry.controversy_id,
    kind: entry.kind,
    semantic_origin:
      typeof entry.semantic_origin === 'string' ? entry.semantic_origin : entry.semantic_origin.kind,
    content: typeof entry.content === 'string' ? entry.content : null,
    provenance: anchors.provenance.map((anchor) => ({ event_id: anchor.event_id, round: anchor.round })),
    textual:
      anchors.textual === undefined
        ? null
        : {
            event_id: anchors.textual.event_id,
            quoted_text: anchors.textual.quoted_text,
            occurrence: anchors.textual.occurrence,
          },
    semantic:
      anchors.semantic === undefined
        ? null
        : {
            text: anchors.semantic.text,
            semantic_origin:
              typeof anchors.semantic.semantic_origin === 'string'
                ? anchors.semantic.semantic_origin
                : anchors.semantic.semantic_origin.kind,
          },
  };
}

/**
 * Compose le contexte d'une proposition, depuis le **seul** instantané fourni.
 *
 * `submitted` vient du propriétaire du périmètre — il n'est ni recalculé, ni
 * élargi, ni réordonné ici. Une unité nommée mais absente de l'instantané est
 * simplement absente du contexte : ce module ne décide d'aucun refus, la
 * validation d'appartenance appartient à `S4`.
 */
export function buildProposalContext(
  snapshot: NativeRunSnapshot,
  targetControversyId: string,
  submitted: readonly string[],
): ProposalContext {
  const wanted = new Set(submitted);

  // ---- Unités soumises, dans l'ordre du journal V3.
  const entries = snapshot.controversies
    .filter((entry) => wanted.has(entry.entry_id) && entry.controversy_id === targetControversyId)
    .map(projectEntry);

  // ---- Événements RÉELLEMENT ancrés par ces unités, et eux seuls. Un
  // événement voisin dans le journal n'entre jamais par proximité.
  const anchored = new Set<string>();
  for (const entry of entries) {
    for (const anchor of entry.provenance) anchored.add(anchor.event_id);
    if (entry.textual !== null) anchored.add(entry.textual.event_id);
  }

  const events = snapshot.events
    .filter((event) => anchored.has(event.event_id))
    .map((event) => ({
      event_id: event.event_id,
      round: event.round,
      actor: event.actor,
      type: event.type,
      expert_slot_id: slotOf(event),
      content: typeof event.content === 'string' ? event.content : null,
    }));

  // ---- Adductions dont la CIBLE est une unité soumise. Une adduction visant
  // une autre unité de la même controverse reste dehors.
  const adductions = snapshot.evidence
    .filter(isAdduction)
    .filter((entry) => wanted.has(entry.target.entry_id))
    .map((entry) => ({
      entry_id: entry.entry_id,
      target_kind: entry.target.kind,
      target_entry_id: entry.target.entry_id,
      orientation: entry.orientation,
      material_id: entry.material_id,
      citation: entry.citation === undefined ? null : entry.citation.quoted_text,
    }));

  // ---- Et les matériaux de ces adductions, jamais les autres.
  const mobilized = new Set(adductions.map((adduction) => adduction.material_id));
  const rendered = new Set(events.map((event) => event.event_id));

  const materials = snapshot.evidence
    .filter(isMaterial)
    .filter((entry) => mobilized.has(entry.entry_id))
    .map((entry) => {
      const representation = entry.representation;
      const eventId = representation.form === 'RUN_EVENT' ? representation.event_id : null;
      // Aucune duplication : si l'événement est déjà rendu en provenance, le
      // matériau le référence sans réécrire son contenu. Le condensat reste
      // stable, et le modèle ne lit pas deux fois la même position.
      const inlineEvent =
        eventId !== null && !rendered.has(eventId)
          ? (snapshot.events.find((event) => event.event_id === eventId)?.content ?? null)
          : null;
      return {
        entry_id: entry.entry_id,
        form: representation.form,
        label: entry.label === undefined ? null : entry.label,
        event_id: eventId,
        content:
          representation.form === 'INLINE_TEXT'
            ? representation.text
            : typeof inlineEvent === 'string'
              ? inlineEvent
              : null,
        locator: representation.form === 'EXTERNAL_REFERENCE' ? representation.locator : null,
        declared_digest:
          representation.form === 'EXTERNAL_REFERENCE' && representation.declared_digest !== undefined
            ? representation.declared_digest
            : null,
      };
    });

  return {
    context_version: PROPOSAL_CONTEXT_VERSION,
    target_controversy_id: targetControversyId,
    submitted: [...submitted],
    entries,
    events,
    adductions,
    materials,
  };
}

// --------------------------------------------------------------------------
// Sérialisation canonique — la MÊME chaîne est mesurée, condensée et injectée
// --------------------------------------------------------------------------

/**
 * Rend la chaîne canonique du contexte.
 *
 * C'est **exactement** ce texte qui entre dans le prompt, exactement lui qui est
 * mesuré, et exactement lui qui est condensé. Mesurer une représentation et en
 * transmettre une autre rendrait l'audit décoratif.
 */
export function serializeProposalContext(context: ProposalContext): string {
  const lines: string[] = [];

  lines.push(`CONTEXTE CANONIQUE CCR — version ${String(context.context_version)}`);
  lines.push(`Controverse : ${context.target_controversy_id}`);
  lines.push('');
  lines.push('UNITÉS SOUMISES — ce sur quoi une proposition peut porter.');

  for (const entry of context.entries) {
    lines.push('');
    lines.push(`--- ${entry.entry_id}`);
    lines.push(`classe : ${entry.kind}`);
    lines.push(`origine sémantique : ${entry.semantic_origin}`);
    if (entry.content !== null) {
      lines.push('énoncé :');
      lines.push(entry.content);
    }
    for (const anchor of entry.provenance) {
      lines.push(`ancrage de provenance : ${anchor.event_id} (round ${String(anchor.round)})`);
    }
    if (entry.textual !== null) {
      lines.push(
        `ancrage textuel : ${entry.textual.event_id} · occurrence ${String(entry.textual.occurrence)}`,
      );
      lines.push(entry.textual.quoted_text);
    }
    if (entry.semantic !== null) {
      lines.push(`ancrage sémantique (origine ${entry.semantic.semantic_origin}) :`);
      lines.push(entry.semantic.text);
    }
  }

  lines.push('');
  lines.push('ÉVÉNEMENTS ANCRÉS — contexte de lecture, jamais des unités soumises.');
  if (context.events.length === 0) lines.push('(aucun)');
  for (const event of context.events) {
    lines.push('');
    lines.push(`--- ${event.event_id}`);
    lines.push(
      `rôle : ${event.expert_slot_id ?? '—'} · acteur : ${event.actor} · type : ${event.type} · round ${String(event.round)}`,
    );
    if (event.content !== null) lines.push(event.content);
  }

  lines.push('');
  lines.push('PREUVES VERSÉES AU DÉBAT — contexte de lecture, jamais des unités soumises.');
  if (context.adductions.length === 0) lines.push('(aucune)');
  for (const adduction of context.adductions) {
    lines.push('');
    lines.push(`--- ${adduction.entry_id}`);
    lines.push(`cible : ${adduction.target_kind} ${adduction.target_entry_id}`);
    lines.push(`orientation déclarée : ${adduction.orientation}`);
    lines.push(`matériau : ${adduction.material_id}`);
    if (adduction.citation !== null) lines.push(`citation : ${adduction.citation}`);
  }

  for (const material of context.materials) {
    lines.push('');
    lines.push(`--- ${material.entry_id}`);
    lines.push(`forme : ${material.form}`);
    if (material.label !== null) lines.push(`libellé : ${material.label}`);
    if (material.event_id !== null) lines.push(`événement représenté : ${material.event_id}`);
    if (material.locator !== null) lines.push(`référence externe enregistrée : ${material.locator}`);
    if (material.declared_digest !== null) lines.push(`condensat déclaré : ${material.declared_digest}`);
    if (material.content !== null) lines.push(material.content);
    else if (material.event_id !== null) lines.push('(contenu rendu ci-dessus, sous cet événement)');
  }

  return lines.join('\n');
}

export function measureProposalContext(serialized: string): number {
  return Buffer.byteLength(serialized, 'utf8');
}

export function digestProposalContext(serialized: string): string {
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

/**
 * Identifiants réellement employés — l'audit du §16.
 *
 * Ils disent **ce qui a été lu**. `derivation.inputs`, lui, dit ce qui a été
 * soumis. Aucun des deux ne se déduit de l'autre, et ce module ne les mélange
 * jamais.
 */
export function proposalContextSourceIds(context: ProposalContext): readonly string[] {
  return [
    context.target_controversy_id,
    ...context.entries.map((entry) => entry.entry_id),
    ...context.events.map((event) => event.event_id),
    ...context.adductions.map((adduction) => adduction.entry_id),
    ...context.materials.map((material) => material.entry_id),
  ];
}

export function auditProposalContext(context: ProposalContext, serialized: string): ProposalContextAudit {
  return {
    context_version: context.context_version,
    context_source_ids: proposalContextSourceIds(context),
    context_utf8_bytes: measureProposalContext(serialized),
    context_sha256: digestProposalContext(serialized),
  };
}

/**
 * Refus **antérieur à tout engagement**.
 *
 * Levé avant le quota, avant l'`invocation_id`, avant le ledger et avant tout
 * adaptateur. Il ne consomme rien, n'écrit rien et n'atteint aucun fournisseur —
 * ce qui est précisément ce qui le rend vérifiable.
 *
 * Il n'est **aucune** des six issues du §38.4 : celles-ci décrivent ce qui
 * advient une fois un engagement pris.
 */
export function assertProposalContextWithinBound(serialized: string): number {
  const bytes = measureProposalContext(serialized);
  if (bytes > MAX_PROPOSAL_CONTEXT_UTF8_BYTES) {
    throw new CcrError(
      'PROPOSAL_CONTEXT_TOO_LARGE',
      `Le contexte de proposition dépasse la borne autorisée (${String(bytes)} octets UTF-8 pour ` +
        `${String(MAX_PROPOSAL_CONTEXT_UTF8_BYTES)} admis). Aucune troncature et aucun résumé ne sont ` +
        'produits : la demande est refusée avant tout engagement.',
      { details: { context_utf8_bytes: bytes, max_utf8_bytes: MAX_PROPOSAL_CONTEXT_UTF8_BYTES } },
    );
  }
  return bytes;
}
