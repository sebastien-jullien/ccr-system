/**
 * Read model V5 — projection **additive et versionnée**, sans agrégation.
 *
 * Tranche S12 du plan gelé. Ce module **compose** les projections déjà
 * établies ; il n'en réinterprète aucune et n'en réimplémente aucune.
 *
 * ```text
 * READ MODEL   ≠  AUTHORITY          COMPOSITION  ≠  NEW SEMANTICS
 * DERIVED DATA ≠  NEW CANONICAL FACT COUNT        ≠  MEANING
 * ORDER        ≠  PREFERENCE
 * ```
 *
 * ## Les seize catégories du §31.3, rendues une à une
 *
 * Une par champ, jamais fusionnées. `8`/`9`, `11`/`12` et `10` sont précisément
 * les distinctions que `C51`, `C29` et `C25` protègent :
 *
 * ```text
 *  1 recorded_acts                        9 closure_effect_currentness
 *  2 proposals                           10 current_decisions
 *  3 responses                           11 historical_explicit_whole_…
 *  4 scopes                              12 current_all_entries_closure_coverage
 *  5 closure_declarations                13 disagreement_view
 *  6 closure_withdrawal_declarations     14 detections
 *  7 supersession_relations              15 attribution
 *  8 decision_currentness                16 reconciliation_revision
 * ```
 *
 * ## Les cinq séparations du §24.3 — `C50`
 *
 * ```text
 * RECORDED FACT               1 · 2 · 3 · 4 · 5 · 6 · 7 · 15
 * DERIVED FACT                8 · 10 · 12 · 13
 * HUMAN-AUTHORITATIVE EFFECT  5 · 6 · 7 observés ; 9 courant
 * CCR PROPOSAL                2 — sans effet
 * STRUCTURAL DETECTION        14 — prédicat observé
 * ```
 *
 * Un effet autoritaire exposé ici est **un effet déclaré par un acte humain
 * explicite satisfaisant le contrat V5** — jamais « décidé par une personne
 * authentifiée et habilitée » (`CR5-03`, §24.4).
 *
 * ## Ce que ce module ne fait jamais
 *
 * ```text
 * INTERDIT  reconstruire une autorité absente              §31.4
 * INTERDIT  remplacer un inconnu par un zéro
 * INTERDIT  agréger les deux actualités en un statut
 * INTERDIT  déduire l'absence de clôture d'une décision non courante
 * INTERDIT  réordonner une séquence canonique
 * ```
 *
 * Aucun statut global, aucun cycle de vie, aucune convergence, aucun score,
 * aucun rang, aucune sévérité, aucune priorité, aucune recommandation, aucune
 * remédiation. Aucune écriture : la projection n'ouvre rien, ne verrouille rien,
 * ne consulte aucune horloge et n'appelle aucun fournisseur.
 *
 * ## Un seul instantané
 *
 * Toutes les composantes proviennent du **même** `NativeRunSnapshot` — celui
 * reçu. Composer `S9` sur un état et `S10` sur un autre rendrait une vue qui
 * n'a jamais existé.
 */

import { coversAllObservedEntries } from './reconciliation-scope.ts';
import { currentClosureEffects, currentDecisions } from './reconciliation-currentness.ts';
import { detectReconciliationStructures } from './reconciliation-detector.ts';
import type { StructuralDetection } from './reconciliation-detector.ts';
import { observedDisagreementSignals } from './reconciliation-disagreement.ts';
import type { DisagreementSignal } from './reconciliation-disagreement.ts';
import type {
  Derivation,
  ProposalOption,
  ProposalRelation,
  Provenance,
  ReconciliationEntry,
  ReconciliationEntryKind,
  ReconciliationRecordedEntry,
  ResponseMode,
  ScopeKind,
  SemanticOrigin,
} from '../core/reconciliation.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';

/** Version de la forme projetée. Sans rapport avec celle du journal V5. */
export const RECONCILIATION_READ_MODEL_VERSION = 1;

// --------------------------------------------------------------------------
// Formes — une par catégorie du §31.3
// --------------------------------------------------------------------------

/** 1 — un acte humain historique : identité et contenu attribué (`A02` · `A04`). */
export interface RecordedActV1 {
  readonly entry_id: string;
  readonly content: string;
  /** `A08` — relation à une proposition, si présente. Jamais un effet. */
  readonly responds_to?: {
    readonly proposal_id: string;
    readonly relation: ProposalRelation;
    readonly adopted_option_id?: string;
  };
}

/** 2 — une proposition CCR, options **non classées** (`V29`). */
export interface ProposalV1 {
  readonly entry_id: string;
  readonly options: readonly ProposalOption[];
}

/** 3 — une réponse humaine, avec son mode. Aucun effet, aucune adoption. */
export interface ResponseV1 {
  readonly entry_id: string;
  readonly proposal_id: string;
  readonly mode: ResponseMode;
  readonly responded_option_id?: string;
}

/** 4 — un périmètre énuméré, avec son `scope_kind`. */
export interface ScopeV1 {
  readonly entry_id: string;
  readonly scope_kind: ScopeKind;
  readonly scope: readonly string[];
}

/** 5 — une déclaration de clôture **historique**, avec son périmètre (`A05`). */
export interface ClosureDeclarationV1 {
  readonly entry_id: string;
  readonly statement: string;
  readonly scope: readonly string[];
}

/** 6 — une déclaration de retrait **historique**, avec ses cibles (`A06`). */
export interface ClosureWithdrawalDeclarationV1 {
  readonly entry_id: string;
  readonly statement: string;
  readonly withdrawn_closures: readonly string[];
  readonly withdrawal_scope: readonly string[];
}

/** 7 — une relation de supersession, avec son **périmètre propre** (`A07`). */
export interface SupersessionRelationV1 {
  readonly entry_id: string;
  readonly superseded_act_id: string;
  readonly supersession_scope: readonly string[];
}

/**
 * 8 — `DECISION_CURRENTNESS`, **par acte et par unité**.
 *
 * Jamais un booléen global par acte : une supersession partielle laisse l'acte
 * courant ailleurs. Cette dimension ne dit **rien** de la clôture (`C51`).
 */
export interface DecisionCurrentnessV1 {
  readonly act_id: string;
  readonly unit: string;
  readonly current: boolean;
}

/**
 * 9 — `CLOSURE_EFFECT_CURRENTNESS`, **par unité**, comme un ensemble.
 *
 * Un ensemble vide est la représentation de `NONE` (§20.3) : aucun effet
 * courant sur cette unité. Ce n'est ni l'affirmation qu'aucune clôture n'a
 * jamais été déclarée — `closure_declarations` demeure —, ni un état ouvert.
 */
export interface ClosureEffectCurrentnessV1 {
  readonly unit: string;
  readonly act_ids: readonly string[];
}

/**
 * 10 — `current_decisions(e)` — **ensemble, jamais une valeur** (`C25`).
 *
 * En choisir un est interdit (§19.4). Aucun cardinal n'est exposé.
 */
export interface CurrentDecisionsV1 {
  readonly unit: string;
  readonly act_ids: readonly string[];
}

/** 15 — provenance et attribution, rendues telles quelles. */
export interface AttributionV1 {
  readonly entry_id: string;
  readonly kind: ReconciliationEntryKind;
  readonly semantic_origin: SemanticOrigin;
  /** Le scribe. Jamais l'origine sémantique, jamais l'auteur. */
  readonly recorded_by: 'CCR';
  /** Présente sur un acte et sur une réponse. `PROVENANCE ≠ AUTHORITY` (§10.4). */
  readonly provenance?: Provenance;
  /** Présente ssi l'origine est `CCR`. */
  readonly derivation?: Derivation;
}

/**
 * Les quinze catégories propres à une controverse.
 *
 * Aucun champ ne les résume, aucun ne les combine. Il n'existe ici ni `status`,
 * ni `effective_state`, ni `resolution_state` : `CR5-01` doit rester
 * directement représentable, et il l'est parce que `8` et `9` sont deux champs.
 */
export interface ControversyReconciliationV1 {
  readonly controversy_id: string;
  readonly recorded_acts: readonly RecordedActV1[];
  readonly proposals: readonly ProposalV1[];
  readonly responses: readonly ResponseV1[];
  readonly scopes: readonly ScopeV1[];
  readonly closure_declarations: readonly ClosureDeclarationV1[];
  readonly closure_withdrawal_declarations: readonly ClosureWithdrawalDeclarationV1[];
  readonly supersession_relations: readonly SupersessionRelationV1[];
  readonly decision_currentness: readonly DecisionCurrentnessV1[];
  readonly closure_effect_currentness: readonly ClosureEffectCurrentnessV1[];
  readonly current_decisions: readonly CurrentDecisionsV1[];
  /**
   * 11 — §17.2 `A`. Un humain a déclaré une clôture sur un périmètre `WHOLE`,
   * borné à l'instantané de **cet acte**, et la déclaration est enregistrée.
   *
   * Ne dit **pas** que la controverse entière soit actuellement close.
   */
  readonly historical_explicit_whole_scope_closure_declaration: boolean;
  /**
   * 12 — §17.2 `B`. Toutes les `ctve_` **actuellement observées** sont couvertes
   * par un effet de clôture courant.
   *
   * ```text
   * A  ≠  B          STRUCTURAL COVERAGE  ≠  HUMAN WHOLE-CLOSURE DECISION
   * ```
   *
   * Une `ctve_` apparue depuis peut rendre `B` faux sans rendre `A` faux.
   */
  readonly current_all_entries_closure_coverage: boolean;
  readonly disagreement_view: readonly DisagreementSignal[];
  readonly detections: readonly StructuralDetection[];
  readonly attribution: readonly AttributionV1[];
}

/**
 * Disponibilité — §31.2, exactement deux valeurs.
 *
 * ```text
 * NOT_AVAILABLE   run non concerné — la forme ne porte AUCUN compteur
 * AVAILABLE       run natif ; recorded_count possiblement 0
 * ```
 *
 * `NOT_AVAILABLE` ne porte ni liste, ni compteur, ni révision, ni booléen : un
 * run non concerné n'a pas été regardé, il n'a pas zéro acte. La distinction est
 * **structurelle**, portée par l'union — pas par une convention de lecture.
 *
 * ```text
 * NOT_AVAILABLE  ≠  AVAILABLE avec zéro          UNKNOWN  ≠  ZERO
 * ```
 *
 * `REFUSED_SNAPSHOT` n'appartient pas à cette union : le §31.2 ne l'y met pas,
 * et ce module reçoit un instantané déjà stable qu'il n'acquiert pas.
 */
export type ReconciliationReadModelV1 =
  | {
      readonly read_model_version: number;
      readonly availability: 'NOT_AVAILABLE';
    }
  | {
      readonly read_model_version: number;
      readonly availability: 'AVAILABLE';
      /**
       * Nombre d'**enregistrements V5 observés** — les trois sortes confondues,
       * égal au nombre d'entrées du journal par construction.
       *
       * Ce n'est ni un nombre de controverses, ni une mesure d'activité, de
       * progression, de désaccord, de couverture ou de maturité. C'est le seul
       * nombre exposé par cette forme.
       *
       * ```text
       * COUNT  ≠  MEANING
       * ```
       */
      readonly recorded_count: number;
      /**
       * 16 — jeton technique de fraîcheur du journal V5, restitué tel quel.
       *
       * ```text
       * REVISION  ≠  AUTHORITY
       * ```
       *
       * Il ne dit ni version métier, ni maturité, ni ancienneté normative, et ne
       * se compare à aucune révision d'un autre domaine.
       */
      readonly reconciliation_revision: string;
      /**
       * Les controverses observées, dans l'ordre de leur **première apparition**
       * dans le journal V3 — le seul ordre autoritaire qui existe.
       *
       * L'énumération vient de V3 parce que le §6.5 (`CR5-12`) y place
       * l'existence d'une controverse observable : elle est portée par au moins
       * une `ctve_`. Conséquence assumée : une cible V5 qui ne serait portée par
       * aucune `ctve_` observée ne figurerait pas ici — le chemin d'écriture la
       * refuse (`S4`), et l'inventer ici reconstruirait une autorité absente.
       */
      readonly items: readonly ControversyReconciliationV1[];
    };

/**
 * Projection d'un run non concerné — `C52`.
 *
 * `NOT_AVAILABLE` n'est pas un zéro : V5 ne s'applique pas à cette génération,
 * et prétendre y avoir compté zéro acte affirmerait un regard qui n'a pas eu
 * lieu.
 */
export function reconciliationReadModelNotAvailable(): ReconciliationReadModelV1 {
  return {
    read_model_version: RECONCILIATION_READ_MODEL_VERSION,
    availability: 'NOT_AVAILABLE',
  };
}

// --------------------------------------------------------------------------
// Composition
// --------------------------------------------------------------------------

function isHumanAct(entry: ReconciliationEntry): entry is ReconciliationRecordedEntry {
  return entry.kind === 'RECONCILIATION_RECORDED';
}

/**
 * Les controverses observées, dans l'ordre de première apparition du journal V3.
 *
 * Aucun tri, aucun regroupement par similarité, aucune déduplication autre que
 * l'identité stricte de la controverse.
 */
function observedControversies(snapshot: NativeRunSnapshot): readonly string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const entry of snapshot.controversies) {
    if (seen.has(entry.controversy_id)) continue;
    seen.add(entry.controversy_id);
    order.push(entry.controversy_id);
  }
  return order;
}

/** Les unités d'une controverse, dans l'ordre d'append du journal V3. */
function unitsOf(snapshot: NativeRunSnapshot, controversyId: string): readonly string[] {
  const units: string[] = [];
  for (const entry of snapshot.controversies) {
    if (entry.controversy_id === controversyId) units.push(entry.entry_id);
  }
  return units;
}

function attributionOf(entry: ReconciliationEntry): AttributionV1 {
  return {
    entry_id: entry.entry_id,
    kind: entry.kind,
    semantic_origin: entry.semantic_origin,
    recorded_by: entry.recorded_by,
    ...(entry.kind === 'RECONCILIATION_PROPOSED'
      ? { derivation: entry.derivation }
      : { provenance: entry.provenance }),
  };
}

/**
 * Compose une controverse — quinze champs, chacun issu de son propriétaire.
 *
 * Les sept premières catégories sont lues **telles quelles** dans le journal V5,
 * dans son ordre d'append. Les quatre dérivées appellent `S9`, `S4`, `S11` et
 * `S10` : aucune formule d'actualité, aucun prédicat de détection et aucun
 * prédicat de signal n'est réécrit ici.
 */
function composeControversy(
  snapshot: NativeRunSnapshot,
  controversyId: string,
  detections: readonly StructuralDetection[],
  signals: readonly DisagreementSignal[],
): ControversyReconciliationV1 {
  const entries = snapshot.reconciliations;
  const own = entries.filter((entry) => entry.target.controversy_id === controversyId);
  const units = unitsOf(snapshot, controversyId);

  const recorded_acts: RecordedActV1[] = [];
  const proposals: ProposalV1[] = [];
  const responses: ResponseV1[] = [];
  const scopes: ScopeV1[] = [];
  const closure_declarations: ClosureDeclarationV1[] = [];
  const closure_withdrawal_declarations: ClosureWithdrawalDeclarationV1[] = [];
  const supersession_relations: SupersessionRelationV1[] = [];
  const attribution: AttributionV1[] = [];

  for (const entry of own) {
    attribution.push(attributionOf(entry));

    if (entry.kind === 'RECONCILIATION_PROPOSED') {
      proposals.push({ entry_id: entry.entry_id, options: entry.options });
      scopes.push({
        entry_id: entry.entry_id,
        scope_kind: entry.scope_kind,
        scope: entry.scope,
      });
      continue;
    }

    if (entry.kind === 'PROPOSAL_RESPONSE_RECORDED') {
      responses.push({
        entry_id: entry.entry_id,
        proposal_id: entry.responds_to.proposal_id,
        mode: entry.responds_to.mode,
        ...(entry.responds_to.responded_option_id === undefined
          ? {}
          : { responded_option_id: entry.responds_to.responded_option_id }),
      });
      continue;
    }

    recorded_acts.push({
      entry_id: entry.entry_id,
      content: entry.content,
      ...(entry.responds_to === undefined ? {} : { responds_to: entry.responds_to }),
    });
    scopes.push({ entry_id: entry.entry_id, scope_kind: entry.scope_kind, scope: entry.scope });
    if (entry.closure?.declared === true) {
      closure_declarations.push({
        entry_id: entry.entry_id,
        statement: entry.closure.statement,
        scope: entry.scope,
      });
    }
    if (entry.closure_withdrawal?.declared === true) {
      closure_withdrawal_declarations.push({
        entry_id: entry.entry_id,
        statement: entry.closure_withdrawal.statement,
        withdrawn_closures: entry.closure_withdrawal.withdrawn_closures,
        withdrawal_scope: entry.closure_withdrawal.withdrawal_scope,
      });
    }
    for (const relation of entry.supersedes ?? []) {
      supersession_relations.push({
        entry_id: entry.entry_id,
        superseded_act_id: relation.superseded_act_id,
        supersession_scope: relation.supersession_scope,
      });
    }
  }

  // 10 puis 8 — une seule dérivation de `S9` par unité, dont l'appartenance
  // donne l'actualité par couple. Aucune seconde formule n'existe.
  const current_decisions: CurrentDecisionsV1[] = units.map((unit) => ({
    unit,
    act_ids: currentDecisions(entries, unit),
  }));
  const currentByUnit = new Map(current_decisions.map((row) => [row.unit, row.act_ids]));

  const decision_currentness: DecisionCurrentnessV1[] = [];
  for (const entry of own) {
    if (!isHumanAct(entry)) continue;
    for (const unit of entry.scope) {
      decision_currentness.push({
        act_id: entry.entry_id,
        unit,
        current: (currentByUnit.get(unit) ?? currentDecisions(entries, unit)).includes(
          entry.entry_id,
        ),
      });
    }
  }

  // 9 — dimension distincte, dérivée séparément. Rien de la dimension 8 n'y
  // entre, et rien de 9 n'entre dans 8 (`C51`, `CR5-01`).
  const closure_effect_currentness: ClosureEffectCurrentnessV1[] = units.map((unit) => ({
    unit,
    act_ids: currentClosureEffects(entries, unit),
  }));

  // 11 — fait historique. 12 — fait structurel courant, calculé par son
  // propriétaire (`S4`) sur les unités effectivement couvertes.
  const historical_explicit_whole_scope_closure_declaration = own.some(
    (entry) =>
      isHumanAct(entry) && entry.scope_kind === 'WHOLE' && entry.closure?.declared === true,
  );
  const closedUnits = closure_effect_currentness
    .filter((row) => row.act_ids.length > 0)
    .map((row) => row.unit);
  const current_all_entries_closure_coverage = coversAllObservedEntries(
    snapshot,
    controversyId,
    closedUnits,
  );

  return {
    controversy_id: controversyId,
    recorded_acts,
    proposals,
    responses,
    scopes,
    closure_declarations,
    closure_withdrawal_declarations,
    supersession_relations,
    decision_currentness,
    closure_effect_currentness,
    current_decisions,
    historical_explicit_whole_scope_closure_declaration,
    current_all_entries_closure_coverage,
    disagreement_view: signals.filter((signal) => signal.controversy_id === controversyId),
    detections: detections.filter((detection) => detection.controversy_id === controversyId),
    attribution,
  };
}

/**
 * Le read model V5, composé depuis **cet** instantané et lui seul.
 *
 * ## Ordre
 *
 * Chaque sous-projection conserve l'ordre de son propriétaire : journal V3 pour
 * les controverses, les unités et les signaux ; journal V5 pour les actes, les
 * propositions, les réponses, les périmètres, les clôtures, les retraits, les
 * relations et l'attribution ; ordre de `S10` pour les détections. Rien n'est
 * trié par importance, sorte, identité, horodatage, sévérité, acteur ou
 * confiance, et la composition n'introduit aucun ordre global.
 *
 * ```text
 * COMPOSITION  ≠  GLOBAL RESORT          ORDER  ≠  PREFERENCE
 * ```
 *
 * Une position dans un tableau n'est ni un rang, ni une priorité, ni un ordre de
 * recommandation.
 */
export function projectReconciliationReadModel(
  snapshot: NativeRunSnapshot,
): ReconciliationReadModelV1 {
  const detected = detectReconciliationStructures(snapshot);
  const detections = detected.availability === 'PRODUCED' ? detected.detections : [];
  const signals = observedDisagreementSignals(snapshot.controversies);

  return {
    read_model_version: RECONCILIATION_READ_MODEL_VERSION,
    availability: 'AVAILABLE',
    recorded_count: snapshot.reconciliations.length,
    reconciliation_revision: snapshot.reconciliation_revision,
    items: observedControversies(snapshot).map((controversyId) =>
      composeControversy(snapshot, controversyId, detections, signals),
    ),
  };
}
