/**
 * Vue dérivée du désaccord — les quatre signaux `S1`–`S4`, et rien d'autre.
 *
 * Tranche S11 du plan gelé.
 *
 * ```text
 * DERIVED_DISAGREEMENT_VIEW              = YES        §22
 * POSITIVE_CANONICAL_DISAGREEMENT_STATE  = NO
 * ```
 *
 * ## Ce que la vue rend
 *
 * Les signaux du §22.1, **liste fermée**, chacun avec son identité, son
 * attribution et son ancrage :
 *
 * ```text
 * S1  RELATION_RECORDED            act = CONTESTS
 * S2  RELATION_RECORDED            act = WITHDRAWS   — fait attribué, pas une clôture
 * S3  HUMAN_AUTHORITY_RECORDED     act = CONTEST_RELATION
 * S4  NATURE_RECORDED
 * ```
 *
 * `REFORMULATES`, `CONFIRM_RELATION`, `ARBITRATION`, `ASSERTION_RECORDED` et
 * `CONTROVERSY_RECORDED` **ne sont pas** des signaux. La liste ne s'élargit pas.
 *
 * ## Ce que la vue n'établit jamais
 *
 * ```text
 * INTERDIT  NO_CLOSURE            ⇒  PERSISTENT_DISAGREEMENT      §22.2
 * INTERDIT  retrait de clôture    ⇒  PERSISTENT_DISAGREEMENT
 * INTERDIT  absence de signal     ⇒  accord
 * INTERDIT  compte de signaux     ⇒  intensité
 * INTERDIT  score de désaccord    ·  état positif canonique
 * ```
 *
 * ```text
 * DISAGREEMENT_VIEW  ≠  FAILURE · NEGATIVE_CONVERGENCE · CLOSURE
 * CONVERGED          =  RESERVED                                   §23
 * ```
 *
 * Une controverse close peut conserver un désaccord expert entier. Une décision
 * humaine ne réécrit aucune position historique : `HUMAN DECISION ≠ EXPERT
 * AGREEMENT`.
 *
 * ## Pourquoi l'entrée est aussi étroite
 *
 * Ce module ne reçoit **que** les entrées V3. Ce n'est pas une commodité : c'est
 * la preuve. Aucune actualité de décision, aucune actualité d'effet de clôture,
 * aucune détection `D01`–`D08`, aucun acte, aucune proposition et aucune réponse
 * V5 ne peuvent influencer un signal, parce qu'aucun d'eux n'entre ici. Le
 * couplage n'est pas discipliné : il est impossible.
 *
 * ```text
 * SUPERSESSION · WITHDRAWAL · CLOSURE · D02 · D04 · ACCEPT · REJECT · ADOPTS
 *     →  ne sont pas des entrées de cette dérivation
 * ```
 *
 * ## Attribution préservée
 *
 * L'origine sémantique du fait V3 est rendue **telle quelle**. Une inférence CCR
 * reste une inférence : son `derivation` l'accompagne, et rien ne la promeut en
 * assertion de source.
 *
 * ```text
 * SYSTEM-INFERRED  ≠  SOURCE-ASSERTED       PERSISTED  ≠  TRUE
 * INFERRED         ≠  OBSERVED
 * ```
 *
 * ## Portée d'observation
 *
 * Le nom de la fonction porte la borne : ce sont les signaux **observés** dans
 * les entrées fournies. Une suite vide dit qu'aucun signal n'y figure — jamais
 * qu'il y a accord, que le désaccord a cessé, ni qu'il persiste.
 *
 * ```text
 * NOT OBSERVED  ≠  ABSENT      UNKNOWN  ≠  ZERO      SILENCE  ≠  AGREEMENT
 * ```
 *
 * Aucun état de disponibilité n'est rendu ici : le contrat n'en définit aucun
 * pour cette vue, et distinguer un run non concerné d'un run sans signal
 * appartient à la surface qui compose les projections.
 */

import type {
  ControversyAnchors,
  ControversyEntry,
  Derivation,
  SemanticOrigin,
} from '../core/controversy.ts';

/** Liste fermée du §22.1. Ni cinquième signal, ni sous-catégorie. */
export const DISAGREEMENT_SIGNALS = ['S1', 'S2', 'S3', 'S4'] as const;
export type DisagreementSignalKind = (typeof DISAGREEMENT_SIGNALS)[number];

/**
 * Un signal observé.
 *
 * Exactement ce que le §22.1 énumère — identité, attribution, ancrage — plus la
 * catégorie du signal et la controverse qui le porte. Rien de plus : aucun
 * champ d'état, aucun compteur, aucun score, aucune sévérité, aucune cible
 * composée. Reconstituer ici un graphe « qui conteste qui » commencerait à
 * fabriquer une structure que le contrat ne rend pas, et qu'un lecteur
 * compterait.
 *
 * Aucune identité durable n'est créée pour le signal lui-même : il n'existe que
 * comme lecture du fait V3 dont il porte l'`entry_id`.
 */
export interface DisagreementSignal {
  readonly signal: DisagreementSignalKind;
  readonly controversy_id: string;
  /** Identité — celle du fait V3, jamais une identité propre à la vue. */
  readonly entry_id: string;
  /** Attribution — rendue telle quelle, jamais promue ni normalisée. */
  readonly semantic_origin: SemanticOrigin;
  /**
   * Mécanisme d'une inférence CCR, présent si et seulement si l'origine est
   * `CCR` — c'est ce qui empêche une inférence persistée de se lire comme un
   * fait observé.
   */
  readonly derivation?: Derivation;
  /** Ancrage — rendu tel quel. */
  readonly anchors: ControversyAnchors;
}

/**
 * Le signal porté par une entrée V3, s'il y en a un — §22.1.
 *
 * Prédicat purement structurel : il lit la sorte de l'entrée et l'acte déclaré,
 * jamais un contenu. Aucune comparaison sémantique, aucun rapprochement de
 * texte, aucun modèle.
 */
function signalOf(entry: ControversyEntry): DisagreementSignalKind | undefined {
  if (entry.kind === 'RELATION_RECORDED') {
    if (entry.relation?.act === 'CONTESTS') return 'S1';
    if (entry.relation?.act === 'WITHDRAWS') return 'S2';
    return undefined;
  }
  if (entry.kind === 'HUMAN_AUTHORITY_RECORDED') {
    return entry.authority?.act === 'CONTEST_RELATION' ? 'S3' : undefined;
  }
  if (entry.kind === 'NATURE_RECORDED') return 'S4';
  return undefined;
}

/**
 * Les signaux `S1`–`S4` **observés** dans les entrées V3 fournies.
 *
 * ## Ordre
 *
 * Une seule passe, dans l'ordre d'append du journal — le seul ordre autoritaire
 * qui existe. Les signaux ne sont ni regroupés par catégorie, ni triés par
 * sévérité, par récence, par acteur, par sorte ou par confiance. La position
 * d'un signal ne signifie rien.
 *
 * ```text
 * ORDER  ≠  PREFERENCE
 * ```
 *
 * ## Ce que la longueur ne dit pas
 *
 * La suite ne porte aucun champ de comptage, et sa longueur n'est pas une
 * intensité : trois signaux ne sont pas « plus de désaccord » que deux (§22.2).
 *
 * @param entries entrées V3 déjà lues, dans leur ordre d'append autoritaire
 */
export function observedDisagreementSignals(
  entries: readonly ControversyEntry[],
): readonly DisagreementSignal[] {
  const signals: DisagreementSignal[] = [];
  for (const entry of entries) {
    const signal = signalOf(entry);
    if (signal === undefined) continue;
    const observed: DisagreementSignal = {
      signal,
      controversy_id: entry.controversy_id,
      entry_id: entry.entry_id,
      semantic_origin: entry.semantic_origin,
      anchors: entry.anchors,
      ...(entry.derivation === undefined ? {} : { derivation: entry.derivation }),
    };
    signals.push(observed);
  }
  return signals;
}
