/**
 * Actualité V5 — **deux** dérivations indépendantes, pures, sans écriture.
 *
 * Tranche S9 du plan gelé. Le contrat expose deux actualités qui ne se déduisent
 * jamais l'une de l'autre (`CR5-01`, §20.1) :
 *
 * ```text
 * DECISION_CURRENTNESS         ← relations de supersession, seules      §19.1
 * CLOSURE_EFFECT_CURRENTNESS   ← clôtures et retraits, seuls            §20.3
 * ```
 *
 * ```text
 * DECISION CURRENTNESS  ≠  CLOSURE-EFFECT CURRENTNESS
 * CURRENTNESS           ≠  TRUTH
 * CURRENTNESS           ≠  MERITS
 * CURRENTNESS           ≠  CONVERGENCE
 * CURRENTNESS           ≠  GLOBAL LIFECYCLE STATE
 * ```
 *
 * ## Aucune entrée commune
 *
 * Les deux fonctions lisent le même journal, et **aucun fait commun**.
 * `currentDecisions` ne consulte jamais `closure` ni `closure_withdrawal` ;
 * `currentClosureEffects` ne consulte jamais `supersedes` (`C27`). La séparation
 * n'est pas une convention de nommage : elle se vérifie en lisant les deux corps,
 * qui n'ont aucun auxiliaire de lecture d'effet en partage.
 *
 * ## Dérivé, jamais persisté
 *
 * ```text
 * DERIVED_CURRENTNESS      = YES        §19.5
 * MUTABLE_CURRENT_POINTER  = NO
 * DERIVED VIEW             ≠  PERSISTED AUTHORITY
 * ```
 *
 * Ce module n'écrit rien, n'ouvre aucun fichier, ne prend aucun verrou, ne
 * consulte aucune horloge et n'appelle aucun fournisseur. Il ne marque, ne
 * réécrit, ne normalise ni ne supprime aucun acte historique : son entrée est un
 * instantané **déjà lu**, et il la rend intacte. Aucun champ `current`,
 * `active`, `is_current`, `superseded_flag` ni `withdrawn_flag` n'est produit,
 * ici ou ailleurs.
 *
 * ## Ce que ce module n'établit pas
 *
 * Une décision courante n'est pas une décision vraie, ni préférée, ni gagnante.
 * Un effet de clôture courant n'est pas un état `CLOSED` de la controverse
 * (§21.6). L'absence d'effet courant n'est pas un désaccord (§22 · `S11`), et
 * aucune catégorie de détection n'est produite ici (§14 · `S10`).
 *
 * ```text
 * ORDER  ≠  PREFERENCE
 * ```
 *
 * Les deux fonctions rendent un **ensemble**, sérialisé dans l'ordre d'append du
 * journal fourni. Elles ne trient pas, ne regroupent pas, ne dédupliquent pas et
 * ne mettent aucun élément en avant (§26.3). En choisir un est interdit (§19.4).
 */

import { CcrError } from '../core/errors.ts';
import { isControversyEntryId } from '../core/reconciliation.ts';
import type {
  ReconciliationEntry,
  ReconciliationRecordedEntry,
} from '../core/reconciliation.ts';

/**
 * Motifs de refus — union fermée.
 *
 * Une seule question est hors domaine : celle posée sur une unité qui ne peut
 * pas être une `ctve_` canonique. Y répondre « ensemble vide » affirmerait
 * qu'aucune décision et aucune clôture ne portent sur cette unité, ce qui serait
 * une affirmation historique sur un identifiant inexistant.
 *
 * ```text
 * UNKNOWN  ≠  ZERO
 * ```
 */
export const CURRENTNESS_REFUSAL_REASONS = ['UNIT_NOT_CANONICAL'] as const;
export type CurrentnessRefusalReason = (typeof CURRENTNESS_REFUSAL_REASONS)[number];

function refuse(
  reason: CurrentnessRefusalReason,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): CcrError {
  return new CcrError('INVALID_ARGUMENT', message, { details: { reason, ...details } });
}

function requireCanonicalUnit(unit: string): void {
  if (!isControversyEntryId(unit)) {
    throw refuse('UNIT_NOT_CANONICAL', "l'unité d'actualité doit être une `ctve_` canonique (§5).", {
      unit,
    });
  }
}

/**
 * Un acte humain, au sens du §9 — c'est-à-dire exactement la classe
 * `RECONCILIATION_RECORDED`.
 *
 * Aucune vérification d'origine ne s'y ajoute : la classe **est** la forme
 * humaine (§9.1, §10.2), et une proposition ou une réponse ne peuvent pas porter
 * `supersedes`, `closure` ni `closure_withdrawal` — leur schéma les refuse
 * (§11, §13.1). Une proposition n'est donc jamais une décision courante, et une
 * réponse non plus, quel que soit son `mode` ou sa `relation` (§13.1, §13.3).
 */
function isHumanAct(entry: ReconciliationEntry): entry is ReconciliationRecordedEntry {
  return entry.kind === 'RECONCILIATION_RECORDED';
}

// --------------------------------------------------------------------------
// A — Actualité de décision (§19)
// --------------------------------------------------------------------------

/**
 * Existe-t-il une relation de supersession **enregistrée** visant `actId` sur
 * `unit` ? — §19.1.
 *
 * Le test porte sur **l'existence de la relation**, jamais sur l'actualité de
 * son auteur (`CR5-09`, §19.3). C'est précisément ce qui interdit la
 * résurrection : si `H3` supersède `H2` et `H2` supersède `H1`, la relation
 * `H2 → H1` demeure enregistrée, donc `H1` demeure non courant sur son unité.
 *
 * Aucune chaîne n'est parcourue, aucun arc n'est composé, aucune transitivité
 * n'est fabriquée : la relation `H3 → H1` n'existe pas, et rien ici ne la
 * suppose. La récence, l'horodatage, l'ordre d'append et l'identité `rcn_` ne
 * participent à aucune étape.
 */
function supersessionRecordedAgainst(
  entries: readonly ReconciliationEntry[],
  actId: string,
  unit: string,
): boolean {
  for (const entry of entries) {
    if (!isHumanAct(entry)) continue;
    const relations = entry.supersedes;
    if (relations === undefined) continue;
    for (const relation of relations) {
      if (relation.superseded_act_id === actId && relation.supersession_scope.includes(unit)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * `current_decisions(e)` — §19.1 · §19.4.
 *
 * ```text
 * current_decision(H, e)  ⟺  e ∈ scope(H)
 *                         ∧  ¬∃ relation R enregistrée telle que
 *                               R.superseded_act_id = H
 *                            ∧  e ∈ R.supersession_scope
 * ```
 *
 * Déterministe, sans horloge, sans ordre sémantique, sans arbitrage.
 *
 * ```text
 * RECENCY        ≠  CURRENTNESS         LATEST  ≠  CURRENT
 * CONTRADICTION  ≠  SUPERSESSION
 * ```
 *
 * Un acte plus récent qui ne supersède rien ne rend rien non courant, même s'il
 * porte un contenu contradictoire sur le même périmètre (§19.2). Deux actes sans
 * relation entre eux sont **tous deux** courants : le résultat est un ensemble,
 * et en départager les membres par date, par identité ou par ordre d'append est
 * interdit (§19.4). `D04` les signale sans les résoudre — et cette signalisation
 * appartient à `S10`, pas à ce module.
 *
 * Le calcul est **par unité**. Une supersession partielle ne retire jamais
 * l'acte antérieur des autres unités de son périmètre.
 *
 * `closure`, `closure_withdrawal`, `provenance`, `responds_to`, `content`,
 * `recorded_at`, la dérivation et le fournisseur ne sont **pas** des entrées de
 * ce calcul (§20.1).
 *
 * Un ensemble vide signifie exactement : aucun acte humain observé dans ce
 * journal ne déclare `unit` dans son périmètre sans être superséder sur elle.
 * Il ne signifie ni qu'aucune décision n'a jamais existé, ni que l'unité
 * existe — ce module n'observe pas le journal V3.
 *
 * @param entries instantané V5 déjà lu, dans son ordre d'append autoritaire
 * @param unit    unité `ctve_` canonique
 */
export function currentDecisions(
  entries: readonly ReconciliationEntry[],
  unit: string,
): readonly string[] {
  requireCanonicalUnit(unit);
  const current: string[] = [];
  for (const entry of entries) {
    if (!isHumanAct(entry)) continue;
    if (!entry.scope.includes(unit)) continue;
    if (supersessionRecordedAgainst(entries, entry.entry_id, unit)) continue;
    current.push(entry.entry_id);
  }
  return current;
}

// --------------------------------------------------------------------------
// B — Actualité d'effet de clôture (§20)
// --------------------------------------------------------------------------

/**
 * Existe-t-il un retrait **enregistré** désignant la clôture de `closureActId`
 * et couvrant `unit` ? — §20.3.
 *
 * La désignation est **explicite et nominative** (§21.3) : le retrait énumère
 * les actes dont il retire la clôture. Partager une unité de périmètre avec une
 * autre clôture ne la retire pas.
 *
 * ```text
 * INTERDIT   latest closure wins
 * INTERDIT   retrait par défaut de toutes les clôtures d'une unité
 * INTERDIT   retrait implicite par supersession
 * ```
 *
 * Comme au §19.1, le test porte sur l'existence du retrait enregistré, jamais
 * sur l'actualité décisionnelle de l'acte qui le porte : la supersession n'est
 * pas une entrée de ce calcul (§20.1, `C27`), et une décision supersédée ne
 * réécrit pas les effets historiques qu'elle a explicitement produits (§21.4).
 *
 * Plusieurs retraits du même effet sont sans conséquence supplémentaire :
 * l'existentiel est idempotent. Aucun n'emporte sur l'autre, aucun n'est une
 * erreur, aucun ne crée une sorte d'actualité nouvelle.
 */
function withdrawalRecordedAgainst(
  entries: readonly ReconciliationEntry[],
  closureActId: string,
  unit: string,
): boolean {
  for (const entry of entries) {
    if (!isHumanAct(entry)) continue;
    const withdrawal = entry.closure_withdrawal;
    if (withdrawal?.declared !== true) continue;
    if (
      withdrawal.withdrawn_closures.includes(closureActId) &&
      withdrawal.withdrawal_scope.includes(unit)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * `CLOSURE_EFFECT_CURRENTNESS(e)` — §20.2 · §20.3.
 *
 * Un effet de clôture est identifié par le couple `( act_id , ctve_ )` (§20.2) :
 * aucune identité d'objet « clôture » n'est créée ici, et aucun agrégat
 * n'existe. La fonction rend les `act_id` dont l'effet est courant **sur cette
 * unité**.
 *
 * ```text
 * ( H , e ) courant  ⟺  H.closure.declared = true
 *                    ∧  e ∈ scope(H)
 *                    ∧  ¬∃ retrait W enregistré tel que
 *                          H ∈ W.withdrawn_closures
 *                       ∧  e ∈ W.withdrawal_scope
 * ```
 *
 * `supersedes` n'apparaît pas dans ce corps, et n'apparaîtra pas : superséder un
 * acte qui déclarait une clôture ne retire pas cette clôture (§21.5 cas `A`,
 * `C27`). Rien d'autre ne la retire non plus (§20.4) : ni la récence, ni la
 * contradiction, ni une décision nouvelle, ni une proposition, ni une réponse
 * `REJECT`, ni une détection, ni une sortie de modèle, ni le silence.
 *
 * ```text
 * AUCUNE RÉOUVERTURE IMPLICITE
 * ```
 *
 * Un retrait partiel laisse courant l'effet sur les unités qu'il ne nomme pas.
 *
 * Un ensemble vide est la représentation de `NONE` (§20.3) : aucun effet de
 * clôture courant **sur cette unité, dans ce journal**. Ce n'est ni
 * l'affirmation qu'aucune clôture n'a jamais été déclarée — la déclaration
 * historique demeure enregistrée et lisible (§21.4) —, ni un état `OPEN` de la
 * controverse (§21.6), ni un désaccord (§22).
 *
 * @param entries instantané V5 déjà lu, dans son ordre d'append autoritaire
 * @param unit    unité `ctve_` canonique
 */
export function currentClosureEffects(
  entries: readonly ReconciliationEntry[],
  unit: string,
): readonly string[] {
  requireCanonicalUnit(unit);
  const current: string[] = [];
  for (const entry of entries) {
    if (!isHumanAct(entry)) continue;
    if (entry.closure?.declared !== true) continue;
    if (!entry.scope.includes(unit)) continue;
    if (withdrawalRecordedAgainst(entries, entry.entry_id, unit)) continue;
    current.push(entry.entry_id);
  }
  return current;
}
