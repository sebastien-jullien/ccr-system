/**
 * Détections structurelles V5 — `D01`–`D08`, huit prédicats déterministes.
 *
 * Tranche S10 du plan gelé. Chaque catégorie observe une structure présente dans
 * l'instantané, et **rien de plus** :
 *
 * ```text
 * OBSERVED STRUCTURAL FACT   ce que l'instantané contient réellement   §14.1
 * INTERPRETATION             hors contrat
 * ```
 *
 * ```text
 * DETECTION  ≠  REMEDIATION · DECISION · TRUTH · MERITS · AUTHORITY EFFECT
 * DETECTION  ≠  DISAGREEMENT STATE · CONVERGENCE · LIFECYCLE
 * ```
 *
 * ## Ce que ce module ne fait jamais
 *
 * Il n'écrit rien, n'ouvre aucun fichier, ne prend aucun verrou, ne consulte
 * aucune horloge, n'appelle aucun fournisseur et n'emploie aucun aléa. Une
 * détection positive ne crée aucun acte, aucune proposition, aucune clôture,
 * aucun retrait, aucune supersession, et ne modifie aucune actualité. Elle ne
 * suggère aucune remédiation : les huit catégories sont nommées par ce qu'elles
 * observent, jamais par ce qu'elles suggéreraient (§15).
 *
 * Aucune sortie ne porte de score, de confiance, de probabilité, de rang, de
 * priorité, de poids, de sévérité ni de compteur. Aucune ne qualifie un
 * contenu : les huit interdits du §14.3 sont tenus par la forme autant que par
 * les corps.
 *
 * ## Les deux actualités restent séparées
 *
 * `D02` et `D08` ne consultent que l'actualité **d'effet de clôture** ; `D03` et
 * `D04` ne consultent que l'actualité **de décision**. Aucun corps ne lit les
 * deux, et aucune formule d'actualité n'est réécrite ici : les deux dérivations
 * de `S9` sont appelées, jamais recopiées (`CR5-01`, `CR5-09`).
 *
 * ```text
 * S10  ≠  SECOND CURRENTNESS ENGINE
 * ```
 *
 * ## Portée d'une observation
 *
 * Une détection dit « les entrées observées satisfont ce prédicat », jamais « la
 * réalité est ainsi ». Une catégorie qui ne se déclenche pas dit seulement que
 * le prédicat n'est pas satisfait sur les entrées disponibles.
 *
 * ```text
 * NOT OBSERVED  ≠  ABSENT      UNKNOWN  ≠  ZERO      SILENCE  ≠  NEGATIVE FACT
 * ```
 *
 * ## Rien n'est persisté
 *
 * §3.3 — persister une détection créerait un fait qui peut périmer, et qu'un
 * lecteur prendrait pour un constat tenu par CCR. La forme ci-dessous ne porte
 * donc **aucune identité canonique durable** : une détection se recalcule, elle
 * ne se référence pas.
 */

import { projectControversyReadModel } from './controversy-read-model.ts';
import type { UnresolvableAnchorReason } from './controversy-read-model.ts';
import { currentClosureEffects, currentDecisions } from './reconciliation-currentness.ts';
import type { ReconciliationEntry, ReconciliationRecordedEntry } from '../core/reconciliation.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';

/** Ensemble fermé des catégories — §14.2. Ni neuvième, ni sous-catégorie. */
export const DETECTION_CATEGORIES = [
  'D01',
  'D02',
  'D03',
  'D04',
  'D05',
  'D06',
  'D07',
  'D08',
] as const;
export type DetectionCategory = (typeof DETECTION_CATEGORIES)[number];

/**
 * Une observation structurelle.
 *
 * Union discriminée : chaque catégorie porte **exactement** les références que
 * son prédicat désigne, et aucune ne peut en porter une autre. Aucun champ
 * générique n'existe par lequel une catégorie pourrait acquérir la portée d'une
 * autre, ni par lequel un effet `E1`–`E4` pourrait s'y glisser.
 */
export type StructuralDetection =
  /** `D01` — entrée hors de tout périmètre V5. */
  | { readonly category: 'D01'; readonly controversy_id: string; readonly unit: string }
  /** `D02` — entrée sans effet de clôture courant. */
  | { readonly category: 'D02'; readonly controversy_id: string; readonly unit: string }
  /** `D03` — acte humain non courant comme décision sur cette unité. */
  | {
      readonly category: 'D03';
      readonly controversy_id: string;
      readonly unit: string;
      readonly act_id: string;
    }
  /** `D04` — actes courants multiples sur une même unité. */
  | { readonly category: 'D04'; readonly controversy_id: string; readonly unit: string }
  /** `D05` — proposition sans réponse humaine enregistrée. */
  | { readonly category: 'D05'; readonly controversy_id: string; readonly proposal_id: string }
  /** `D06` — acte dont la provenance est une décision legacy. */
  | { readonly category: 'D06'; readonly controversy_id: string; readonly act_id: string }
  /** `D07` — ancrage de citation non résolvable dans le périmètre. */
  | {
      readonly category: 'D07';
      readonly controversy_id: string;
      readonly entry_id: string;
      /** Motif **technique** de non-résolution. Jamais un jugement sur la citation. */
      readonly reason: UnresolvableAnchorReason;
    }
  /** `D08` — effet de clôture retiré sur une unité. */
  | {
      readonly category: 'D08';
      readonly controversy_id: string;
      readonly unit: string;
      readonly act_id: string;
    };

/**
 * Issue d'une détection déterministe — §38.2.
 *
 * `NOT_AVAILABLE` **ne porte aucune liste et aucun compteur** : un run non
 * concerné par V5 n'a pas été regardé, il n'a pas zéro détection. La distinction
 * est structurelle, comme pour les projections V3 et V4.
 *
 * ```text
 * NOT_AVAILABLE  ≠  PRODUCED avec zéro détection
 * ```
 *
 * La troisième issue du §38.2, `REFUSED_SNAPSHOT`, ne peut pas naître ici : ce
 * module reçoit un instantané **déjà stable** et n'en acquiert aucun. Elle
 * appartient à la surface qui l'acquiert.
 */
export type ReconciliationDetectionsV1 =
  | { readonly availability: 'NOT_AVAILABLE' }
  | {
      readonly availability: 'PRODUCED';
      readonly detections: readonly StructuralDetection[];
    };

/**
 * Issue d'un run non concerné — `C52`.
 *
 * V5 ne s'applique pas à cette génération. Prétendre y avoir compté zéro
 * détection affirmerait un regard qui n'a pas eu lieu.
 */
export function reconciliationDetectionsNotAvailable(): ReconciliationDetectionsV1 {
  return { availability: 'NOT_AVAILABLE' };
}

// --------------------------------------------------------------------------
// Lectures élémentaires
// --------------------------------------------------------------------------

function isHumanAct(entry: ReconciliationEntry): entry is ReconciliationRecordedEntry {
  return entry.kind === 'RECONCILIATION_RECORDED';
}

/**
 * Les entrées V5 qui déclarent un périmètre.
 *
 * `D01` porte sur « le périmètre d'aucun **acte V5** » (§14.2), là où `D03` dit
 * « acte **humain** ». La distinction est écrite dans le contrat, et elle est
 * portante : une proposition CCR déclare bien un périmètre V5, sans produire
 * aucun effet. Une réponse n'en déclare aucun — sa forme n'en porte pas.
 */
function declaresScope(
  entry: ReconciliationEntry,
): entry is Extract<ReconciliationEntry, { scope: readonly string[] }> {
  return entry.kind === 'RECONCILIATION_RECORDED' || entry.kind === 'RECONCILIATION_PROPOSED';
}

// --------------------------------------------------------------------------
// `D01` — entrée hors de tout périmètre V5
// --------------------------------------------------------------------------

/**
 * Prédicat : l'unité n'appartient au périmètre d'aucun acte V5.
 *
 * Fait **historique** : l'existence d'une déclaration de périmètre, jamais son
 * actualité. Aucune actualité n'est consultée.
 *
 * N'établit pas qu'il faille traiter l'unité.
 */
function detectD01(
  entries: readonly ReconciliationEntry[],
  unit: string,
): boolean {
  for (const entry of entries) {
    if (!declaresScope(entry)) continue;
    if (entry.scope.includes(unit)) return false;
  }
  return true;
}

// --------------------------------------------------------------------------
// `D02` — entrée sans effet de clôture courant
// --------------------------------------------------------------------------

/**
 * Prédicat : `CLOSURE_EFFECT_CURRENTNESS(e)` est vide (§20.3).
 *
 * Dépend de l'actualité **d'effet de clôture**, et d'elle seule. L'actualité de
 * décision n'est pas consultée : `CR5-01` interdit de les recoupler, et un acte
 * supersédé n'a pas pour autant perdu sa clôture.
 *
 * N'établit pas qu'un désaccord subsiste (§14.3).
 */
function detectD02(entries: readonly ReconciliationEntry[], unit: string): boolean {
  return currentClosureEffects(entries, unit).length === 0;
}

// --------------------------------------------------------------------------
// `D03` — acte humain non courant comme décision sur une unité
// --------------------------------------------------------------------------

/**
 * Prédicat : une relation de supersession explicite vise l'acte sur cette unité
 * (§19.1).
 *
 * Dépend de l'actualité **de décision**, et d'elle seule. La règle `R1` rejetée
 * n'est pas réintroduite : la clôture éventuelle de l'acte n'est pas regardée,
 * et sa perte n'est pas déduite.
 *
 * N'établit pas que l'acte soit faux, ni que sa clôture ait cessé.
 */
function detectD03(
  entries: readonly ReconciliationEntry[],
  actId: string,
  unit: string,
): boolean {
  return !currentDecisions(entries, unit).includes(actId);
}

// --------------------------------------------------------------------------
// `D04` — actes courants multiples sur une même unité
// --------------------------------------------------------------------------

/**
 * Prédicat : `card(current_decisions(e)) ≥ 2` (§19.4).
 *
 * Dépend de l'actualité **de décision**, et d'elle seule. La détection **signale
 * sans résoudre** : elle ne nomme aucun acte, n'en départage aucun et ne rend
 * aucun cardinal — l'ensemble se lit par `currentDecisions`, qui l'expose comme
 * un ensemble.
 *
 * N'établit pas qu'il faille les départager.
 */
function detectD04(entries: readonly ReconciliationEntry[], unit: string): boolean {
  return currentDecisions(entries, unit).length >= 2;
}

// --------------------------------------------------------------------------
// `D05` — proposition sans réponse humaine enregistrée
// --------------------------------------------------------------------------

/**
 * Prédicat : aucune réponse ni acte ne référence la proposition.
 *
 * Fait **historique** : l'existence d'une référence enregistrée, quelle que soit
 * sa nature. Un `ACCEPT`, un `REJECT`, un `ADOPTS`, un `MODIFIES` et un
 * `REPLACES` comptent tous comme référence, et aucun ne devient pour autant une
 * décision. Aucune actualité n'est consultée.
 *
 * N'établit pas qu'une réponse soit due.
 */
function detectD05(entries: readonly ReconciliationEntry[], proposalId: string): boolean {
  for (const entry of entries) {
    if (entry.kind === 'PROPOSAL_RESPONSE_RECORDED') {
      if (entry.responds_to.proposal_id === proposalId) return false;
      continue;
    }
    if (entry.kind === 'RECONCILIATION_RECORDED') {
      if (entry.responds_to?.proposal_id === proposalId) return false;
    }
  }
  return true;
}

// --------------------------------------------------------------------------
// `D06` — acte dont la provenance est une décision legacy
// --------------------------------------------------------------------------

/**
 * Prédicat : `provenance.kind = LEGACY_DECISION`.
 *
 * Porte sur un **acte** (§9) — `RECONCILIATION_RECORDED`. Une réponse porte
 * aussi une provenance, mais le contrat la nomme « réponse » et jamais
 * « acte » : `RESPONSE ≠ AUTHORITATIVE HUMAN ACT` (§13.1). Aucune actualité
 * n'est consultée.
 *
 * N'établit pas que la provenance soit invalide — `PROVENANCE ≠ AUTHORITY`
 * (§10.4), et une provenance legacy n'est ni une faute ni une faiblesse.
 */
function detectD06(entry: ReconciliationRecordedEntry): boolean {
  return entry.provenance.kind === 'LEGACY_DECISION';
}

// --------------------------------------------------------------------------
// `D08` — effet de clôture retiré sur une unité
// --------------------------------------------------------------------------

/**
 * Prédicat : un retrait explicite courant vise cet effet sur cette unité.
 *
 * L'effet `( H , e )` a été déclaré — `H.closure.declared` et `e ∈ scope(H)`,
 * l'identité du §20.2 — et n'est plus courant. Par le §20.3, la seule chose qui
 * puisse produire cela est un retrait enregistré désignant `H` et couvrant `e` :
 * ni la supersession, ni la récence, ni une décision nouvelle n'en sont
 * capables. La condition se lit donc sur l'actualité **d'effet**, sans réécrire
 * le prédicat de retrait.
 *
 * N'établit pas qu'une réouverture soit un échec — `REOPENING ≠ TRUTH
 * CORRECTION` (§21.4).
 */
function detectD08(
  entries: readonly ReconciliationEntry[],
  actId: string,
  unit: string,
): boolean {
  return !currentClosureEffects(entries, unit).includes(actId);
}

// --------------------------------------------------------------------------
// Composition
// --------------------------------------------------------------------------

/**
 * Les huit prédicats, appliqués à l'instantané fourni.
 *
 * ## Ordre
 *
 * Les catégories sont parcourues dans l'ordre de l'ensemble fermé du §14.2 ;
 * à l'intérieur de chacune, les faits sont parcourus dans l'ordre d'append du
 * journal qui les porte — V3 pour les unités et les ancrages, V5 pour les actes
 * et les propositions. Aucun tri n'est appliqué : ni par importance, ni par
 * confiance, ni par sévérité, ni par sorte, ni par horodatage, ni par identité.
 *
 * ```text
 * ORDER  ≠  PREFERENCE
 * ```
 *
 * ## Cardinalité
 *
 * Une détection par fait satisfaisant le prédicat. Aucune fusion, aucun
 * dédoublonnage : deux occurrences contractuellement distinctes restent deux
 * observations. `D02` et `D08` peuvent porter sur la même unité sans se
 * confondre — l'une observe qu'aucun effet n'y est courant, l'autre qu'un effet
 * déclaré y a été retiré.
 *
 * ## Séparation V3 / V5
 *
 * Les unités et les ancrages sont lus dans l'état V3 de l'instantané, en lecture
 * seule et par la projection existante. Aucun état V3 n'est reconstruit depuis
 * du texte ou depuis V5, et aucun module V3 n'est modifié.
 *
 * ```text
 * V3 READ  ≠  V3 MUTATION
 * ```
 */
export function detectReconciliationStructures(
  snapshot: NativeRunSnapshot,
): ReconciliationDetectionsV1 {
  const entries = snapshot.reconciliations;
  const detections: StructuralDetection[] = [];

  // `D01` · `D02` · `D04` — par unité, dans l'ordre d'append du journal V3.
  for (const unit of snapshot.controversies) {
    if (detectD01(entries, unit.entry_id)) {
      detections.push({
        category: 'D01',
        controversy_id: unit.controversy_id,
        unit: unit.entry_id,
      });
    }
  }
  for (const unit of snapshot.controversies) {
    if (detectD02(entries, unit.entry_id)) {
      detections.push({
        category: 'D02',
        controversy_id: unit.controversy_id,
        unit: unit.entry_id,
      });
    }
  }

  // `D03` — par couple ( acte humain , unité de son périmètre ).
  for (const entry of entries) {
    if (!isHumanAct(entry)) continue;
    for (const unit of entry.scope) {
      if (detectD03(entries, entry.entry_id, unit)) {
        detections.push({
          category: 'D03',
          controversy_id: entry.target.controversy_id,
          unit,
          act_id: entry.entry_id,
        });
      }
    }
  }

  for (const unit of snapshot.controversies) {
    if (detectD04(entries, unit.entry_id)) {
      detections.push({
        category: 'D04',
        controversy_id: unit.controversy_id,
        unit: unit.entry_id,
      });
    }
  }

  // `D05` — par proposition, dans l'ordre d'append du journal V5.
  for (const entry of entries) {
    if (entry.kind !== 'RECONCILIATION_PROPOSED') continue;
    if (detectD05(entries, entry.entry_id)) {
      detections.push({
        category: 'D05',
        controversy_id: entry.target.controversy_id,
        proposal_id: entry.entry_id,
      });
    }
  }

  // `D06` — par acte humain.
  for (const entry of entries) {
    if (!isHumanAct(entry)) continue;
    if (detectD06(entry)) {
      detections.push({
        category: 'D06',
        controversy_id: entry.target.controversy_id,
        act_id: entry.entry_id,
      });
    }
  }

  // `D07` — seam V3 en lecture seule : les motifs de non-résolution déjà
  // qualifiés par la projection de controverse, dans son ordre.
  const v3 = projectControversyReadModel(snapshot);
  if (v3.availability === 'AVAILABLE') {
    for (const item of v3.items) {
      for (const anchor of item.unresolvable_anchors) {
        detections.push({
          category: 'D07',
          controversy_id: item.controversy_id,
          entry_id: anchor.entry_id,
          reason: anchor.reason,
        });
      }
    }
  }

  // `D08` — par couple ( acte déclarant une clôture , unité de son périmètre ).
  for (const entry of entries) {
    if (!isHumanAct(entry)) continue;
    if (entry.closure?.declared !== true) continue;
    for (const unit of entry.scope) {
      if (detectD08(entries, entry.entry_id, unit)) {
        detections.push({
          category: 'D08',
          controversy_id: entry.target.controversy_id,
          unit,
          act_id: entry.entry_id,
        });
      }
    }
  }

  return { availability: 'PRODUCED', detections };
}
