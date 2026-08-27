/**
 * Projection de lecture V3 — depuis le snapshot stable, et depuis lui seul.
 *
 * Tranche S3 du plan gelé. Fonction **pure** : elle reçoit un snapshot déjà
 * établi cohérent par S2 et n'ouvre rien. Aucune seconde lecture de
 * `controversies.jsonl` n'existe ici — une lecture parallèle rendrait de
 * nouveau possible la vue combinée que la frontière de stabilité existe pour
 * interdire.
 *
 * ## Ce que la projection ne calcule pas
 *
 * ```text
 * aucun statut · aucune disposition agrégée · aucune clôture
 * aucun gagnant · aucun score · aucune convergence
 * aucun regroupement par similarité · aucun tri
 * aucun entrelacement avec events.jsonl
 * ```
 *
 * Le premier `CONTROVERSY_RECORDED` d'une controverse ne devient **pas** un
 * état ouvert. Un `WITHDRAWS` ne retire aucune entrée de la lecture. Un
 * `REFORMULATES` ne fusionne rien. Un `CONTESTS` ne désigne personne.
 *
 * ## Vérité du vide
 *
 * ```text
 * legacy   NOT_AVAILABLE — et la forme ne porte alors AUCUN compteur
 * natif    AVAILABLE, recorded_count possiblement 0
 * ```
 *
 * L'union est discriminée pour que « legacy » ne puisse pas porter un zéro :
 * un run historique n'a pas été regardé, il n'a pas zéro controverse. La
 * distinction est structurelle, pas conventionnelle.
 */

import type { ControversyEntry, TextualAnchor } from '../core/controversy.ts';
import type { NativeCcrEvent } from '../core/run-native.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';

/** Version de la forme projetée. Sans rapport avec celle du journal V3. */
export const CONTROVERSY_READ_MODEL_VERSION = 1;

// --------------------------------------------------------------------------
// Formes
// --------------------------------------------------------------------------

/**
 * Motif d'un ancrage textuel qui ne se résout pas.
 *
 * Nommer la cause est le minimum honnête : un ancrage muet laisserait croire à
 * un extrait vide, ce que le contrat interdit explicitement.
 */
export const UNRESOLVABLE_ANCHOR_REASONS = [
  'EVENT_NOT_FOUND',
  'CONTENT_UNAVAILABLE',
  'OCCURRENCE_NOT_FOUND',
] as const;
export type UnresolvableAnchorReason = (typeof UNRESOLVABLE_ANCHOR_REASONS)[number];

export interface UnresolvableAnchorV1 {
  readonly entry_id: string;
  readonly event_id: string;
  readonly occurrence: number;
  readonly reason: UnresolvableAnchorReason;
}

/**
 * Une controverse enregistrée, et les faits consignés sous son identité.
 *
 * `opening` est `null` lorsque le journal porte des entrées sous une identité
 * dont l'enregistrement n'a jamais été écrit. Ce n'est pas normalisé : le fait
 * est rendu tel quel plutôt que masqué.
 */
export interface ControversyItemV1 {
  readonly controversy_id: string;
  readonly opening: ControversyEntry | null;
  /** Toutes les entrées de cette controverse, dans l'ordre d'append. */
  readonly entries: readonly ControversyEntry[];
  /** Sous-ensemble d'autorité humaine, même ordre — un filtre, pas un tri. */
  readonly authority_entries: readonly ControversyEntry[];
  readonly unresolvable_anchors: readonly UnresolvableAnchorV1[];
}

export type ControversyReadModelV1 =
  | {
      readonly read_model_version: number;
      readonly availability: 'NOT_AVAILABLE';
    }
  | {
      readonly read_model_version: number;
      readonly availability: 'AVAILABLE';
      /**
       * Nombre de **controverses** enregistrées — jamais un nombre d'entrées.
       * Égal à `items.length` par construction.
       */
      readonly recorded_count: number;
      readonly items: readonly ControversyItemV1[];
    };

// --------------------------------------------------------------------------
// Legacy
// --------------------------------------------------------------------------

/**
 * Projection d'un run historique.
 *
 * `NOT_AVAILABLE` n'est pas un zéro : V3 ne s'applique pas à cette génération,
 * et prétendre y avoir compté zéro controverse serait affirmer un regard qui
 * n'a pas eu lieu.
 */
export function controversyReadModelNotAvailable(): ControversyReadModelV1 {
  return {
    read_model_version: CONTROVERSY_READ_MODEL_VERSION,
    availability: 'NOT_AVAILABLE',
  };
}

// --------------------------------------------------------------------------
// Résolution d'ancrage — déterministe, depuis le snapshot
// --------------------------------------------------------------------------

/**
 * Occurrences exactes, **chevauchements compris**, rang 1-based.
 *
 * Même règle que l'écriture appliquera : la recherche reprend à
 * `start + 1`, jamais à `start + longueur`. Deux comptages différents
 * donneraient deux rangs pour le même ancrage.
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

function classifyAnchor(
  anchor: TextualAnchor,
  events: ReadonlyMap<string, NativeCcrEvent>,
): UnresolvableAnchorReason | null {
  const event = events.get(anchor.event_id);
  if (event === undefined) return 'EVENT_NOT_FOUND';

  const content = event.content;
  if (typeof content !== 'string') return 'CONTENT_UNAVAILABLE';

  return occurrenceExists(content, anchor.quoted_text, anchor.occurrence)
    ? null
    : 'OCCURRENCE_NOT_FOUND';
}

// --------------------------------------------------------------------------
// Projection
// --------------------------------------------------------------------------

/**
 * Projette les entrées du snapshot, regroupées par controverse.
 *
 * L'ordre des controverses est celui de leur **première apparition** dans le
 * journal ; l'ordre des entrées d'une controverse est leur ordre d'append. Les
 * deux dérivent du seul ordre autoritaire qui existe — celui du journal — et
 * aucun horodatage n'est consulté.
 */
export function projectControversyReadModel(snapshot: NativeRunSnapshot): ControversyReadModelV1 {
  const events = new Map<string, NativeCcrEvent>();
  for (const event of snapshot.events) events.set(event.event_id, event);

  const order: string[] = [];
  const grouped = new Map<string, ControversyEntry[]>();

  for (const entry of snapshot.controversies) {
    let bucket = grouped.get(entry.controversy_id);
    if (bucket === undefined) {
      bucket = [];
      grouped.set(entry.controversy_id, bucket);
      order.push(entry.controversy_id);
    }
    bucket.push(entry);
  }

  const items: ControversyItemV1[] = order.map((controversyId) => {
    const entries = grouped.get(controversyId) ?? [];

    const unresolvable: UnresolvableAnchorV1[] = [];
    for (const entry of entries) {
      const anchor = entry.anchors.textual;
      if (anchor === undefined) continue;
      const reason = classifyAnchor(anchor, events);
      if (reason === null) continue;
      unresolvable.push({
        entry_id: entry.entry_id,
        event_id: anchor.event_id,
        occurrence: anchor.occurrence,
        reason,
      });
    }

    return {
      controversy_id: controversyId,
      // Le premier enregistrement, s'il existe. Aucun n'est fabriqué.
      opening: entries.find((entry) => entry.kind === 'CONTROVERSY_RECORDED') ?? null,
      entries,
      authority_entries: entries.filter((entry) => entry.kind === 'HUMAN_AUTHORITY_RECORDED'),
      unresolvable_anchors: unresolvable,
    };
  });

  return {
    read_model_version: CONTROVERSY_READ_MODEL_VERSION,
    availability: 'AVAILABLE',
    recorded_count: items.length,
    items,
  };
}
