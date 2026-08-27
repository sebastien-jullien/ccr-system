/**
 * Service métier V5 — l'acte humain de réconciliation, et lui seul.
 *
 * Tranche S5 du plan gelé. Ce module est l'**autorité unique** de l'écriture
 * humaine V5 : il établit les faits canoniques sous la frontière de mutation
 * native, alloue l'identité depuis l'état autoritaire, et délègue toute
 * mécanique de journal au store de S2 et toute validation de périmètre aux
 * primitives de S4.
 *
 * ```text
 * verrou de run  →  instantané stable  →  fraîcheur V5  →  forme d'autorité
 *                →  périmètre          →  effets        →  champs serveur
 *                →  append UNIQUE      →  révision résultante
 * ```
 *
 * ## Zéro fournisseur, prouvé par le type
 *
 * `ReconciliationServiceDeps` ne porte **aucune** fabrique d'adaptateur. Ce
 * n'est pas une omission : c'est la preuve, au niveau du type, qu'aucun
 * fournisseur ne peut être invoqué depuis ce module. Aucun ledger, aucun quota,
 * aucun `invocation_id` n'y est produit non plus. Le chemin humain est
 * intégralement utilisable sans modèle.
 *
 * ## Un acte, pas un état
 *
 * ```text
 * RECONCILIATION_RECORDED  =  un acte historique enregistré
 * ```
 *
 * Ce module n'écrit **aucune** actualité. Il ne dit pas quel acte est courant,
 * quelle clôture est en vigueur, ni si un désaccord subsiste : ces dérivations
 * appartiennent à S9, et aucun champ `is_closed`, `current_closure` ou
 * `active_closure` n'existe dans l'enregistrement canonique.
 *
 * ```text
 * CLOSURE DECLARATION  ≠  CURRENT CLOSURE STATE
 * CLOSURE              ≠  TRUTH · CONVERGENCE · EXPERT AGREEMENT
 * ```
 *
 * ## Ce que cette tranche ne fait pas encore
 *
 * ```text
 * TYPE REPRESENTABILITY  ≠  RUNTIME CAPABILITY IMPLEMENTED
 * ```
 *
 * Le domaine S1 sait représenter `supersedes`, `closure_withdrawal` et
 * `responds_to`. Les trois ont désormais leur runtime — S6, S7 et S8 — chacun
 * avec ses propres validations dynamiques, indépendantes les unes des autres.
 *
 * Le mécanisme de refus des capacités non livrées demeure : il est la seule
 * façon honnête de traiter une intention qu'une tranche ne sait pas encore
 * exécuter, et une forme future s'y inscrirait avant d'être implémentée.
 */

import {
  RECONCILIATION_SCHEMA_VERSION,
  formatReconciliationId,
  isControversyEntryId,
  isLegacyDecisionId,
  validateReconciliationEntry,
} from '../core/reconciliation.ts';
import type {
  ClosureDeclaration,
  ClosureWithdrawalDeclaration,
  ProposalOption,
  ProposalRelation,
  ProposalResponseRecordedEntry,
  Provenance,
  ReconciliationEntry,
  ReconciliationRecordedEntry,
  ResponseMode,
  ScopeKind,
  SupersessionRelation,
} from '../core/reconciliation.ts';
import { CcrError } from '../core/errors.ts';
import { runPaths } from '../store/layout.ts';
import {
  appendReconciliationEntries,
  readReconciliationJournal,
} from '../store/reconciliation-store.ts';
import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { prepareScope } from './reconciliation-scope.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';

/**
 * Effet fournisseur de l'opération de ce module.
 *
 * Constante et non calculée : elle est vraie par construction, puisqu'aucun
 * adaptateur n'est atteignable depuis ici.
 */
export const RECONCILIATION_HUMAN_PROVIDER_EFFECT = 'EXACT(0)' as const;

// --------------------------------------------------------------------------
// Issues contrôlées — vocabulaire du contrat §38.1
// --------------------------------------------------------------------------

/**
 * Les quatre issues d'un acte humain, et elles seules.
 *
 * ```text
 * RECORDED             l'acte est écrit ; les effets déclarés s'appliquent
 * REFUSED_VALIDATION   un contrôle du §34 a échoué — aucun acte écrit
 * REFUSED_FRESHNESS    révision périmée — aucun acte écrit
 * REFUSED_LOCK         un autre processus mute le run — aucun acte écrit
 * ```
 *
 * `RECORDED` signifie exactement : **un enregistrement canonique a été écrit**.
 * Ni que la réconciliation soit bonne, ni qu'elle soit opportune, ni qu'une
 * clôture soit courante, ni qu'un désaccord ait cessé. Aucun `SUCCESS`,
 * `RESOLVED` ou `FAILED_MERITS` n'existe.
 */
export const RECONCILIATION_OUTCOMES = [
  'RECORDED',
  'REFUSED_VALIDATION',
  'REFUSED_FRESHNESS',
  'REFUSED_LOCK',
] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

/** Motifs de refus métier propres à S5 — union fermée. */
export const RECONCILIATION_REFUSAL_REASONS = [
  'PROVENANCE_REFERENCE_NOT_FOUND',
  'CLOSURE_NOT_DECLARED_SEPARATELY',
  'UNSUPPORTED_SEMANTIC_INTENT',
  'UNKNOWN_INPUT_FIELD',
  // Supersession — S6. Motifs LOCAUX (`K17`) ; l'issue contractée reste
  // `REFUSED_VALIDATION`, et aucune issue canonique nouvelle n'est créée.
  'SUPERSESSION_SCOPE_EMPTY',
  'SUPERSESSION_SCOPE_NOT_IN_SUPERSEDING_ACT',
  'SUPERSESSION_SCOPE_NOT_IN_SUPERSEDED_ACT',
  'SUPERSEDED_ACT_NOT_FOUND',
  'SUPERSEDED_ACT_NOT_SUPERSEDABLE',
  'SUPERSEDED_ACT_FOREIGN_CONTROVERSY',
  'SELF_SUPERSESSION',
  'DUPLICATE_SUPERSEDED_ACT',
  'SUPERSESSION_CYCLE',
  // Retrait de clôture — S7. Motifs LOCAUX (`K17`).
  'WITHDRAWN_CLOSURES_EMPTY',
  'DUPLICATE_WITHDRAWN_CLOSURE',
  'WITHDRAWAL_SCOPE_EMPTY',
  'WITHDRAWAL_SCOPE_NOT_IN_WITHDRAWAL_ACT',
  'WITHDRAWAL_SCOPE_NOT_IN_CLOSURE_ACT',
  'WITHDRAWN_CLOSURE_NOT_FOUND',
  'WITHDRAWN_ACT_NOT_HUMAN',
  'WITHDRAWN_ACT_DECLARES_NO_CLOSURE',
  'WITHDRAWN_CLOSURE_FOREIGN_CONTROVERSY',
  // Propositions — S8. Motifs LOCAUX (`K17`).
  'PROPOSAL_NOT_FOUND',
  'REFERENCED_RECORD_NOT_A_PROPOSAL',
  'PROPOSAL_FOREIGN_CONTROVERSY',
  'OPTION_NOT_IN_PROPOSAL',
  'ADOPTED_OPTION_REQUIRED',
  'ADOPTED_OPTION_FORBIDDEN_OUTSIDE_ADOPTS',
] as const;
export type ReconciliationRefusalReason = (typeof RECONCILIATION_REFUSAL_REASONS)[number];

function refuse(
  reason: ReconciliationRefusalReason,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): CcrError {
  return new CcrError('INVALID_ARGUMENT', message, {
    details: { outcome: 'REFUSED_VALIDATION', reason, ...details },
  });
}

// --------------------------------------------------------------------------
// Dépendances et forme d'entrée
// --------------------------------------------------------------------------

/**
 * Dépendances du service — volontairement sans fabrique d'adaptateur.
 *
 * L'absence de `createAdapters` est la preuve, au niveau du type, qu'aucun
 * fournisseur ne peut être invoqué depuis ce module.
 */
export interface ReconciliationServiceDeps {
  readonly runsDir: string;
  now(): Date;
}

/**
 * L'acte humain, tel que l'appelant le soumet.
 *
 * L'appelant ne choisit **jamais** : l'identité, l'horodatage, l'enregistreur,
 * l'origine sémantique, la version de schéma, ni la révision observée. Ces
 * champs appartiennent au serveur, et les accepter depuis l'entrée permettrait
 * de forger une autorité que l'acte n'a pas.
 *
 * `responds_to` est ouvert depuis S8 : il rattache l'acte à une proposition CCR,
 * sans jamais produire d'effet par lui-même.
 */
export interface RecordReconciliationInput {
  readonly runId: string;
  /**
   * Révision V5 sur laquelle l'appelant a préparé son geste.
   *
   * **Fournie par l'appelant, jamais obtenue ici.** Ce service ne lit aucun
   * jeton de fraîcheur pour son propre compte : il compare la valeur reçue à
   * celle qu'il relit sous son verrou. Obtenir les deux au même endroit rendrait
   * la comparaison tautologique et ne protégerait plus rien.
   */
  readonly expected_revision: string;
  readonly target_controversy_id: string;
  readonly scope_kind: ScopeKind;
  /**
   * Énumération explicite pour un `SUBSET`. Pour un `WHOLE`, l'appelant la
   * laisse absente : le serveur l'énumère **sous le verrou**, contre l'état
   * autoritaire relu.
   */
  readonly scope?: readonly string[];
  /** Contenu humain attribué. Jamais résumé, corrigé, généré ni réinterprété. */
  readonly content: string;
  readonly provenance: Provenance;
  /**
   * Effet de clôture, **explicite et séparé** de l'opération (`H3`).
   *
   * Absent ⇒ aucun effet de clôture. Aucune valeur implicite : ni le contenu,
   * ni la provenance, ni le simple fait d'exécuter l'opération ne produisent une
   * clôture.
   */
  readonly closure?: ClosureDeclaration;
  /**
   * Relations de supersession, **explicites** et à périmètre propre (§18.1).
   *
   * ```text
   * SUPERSESSION  ≠  CLOSURE WITHDRAWAL
   * ```
   *
   * Superséder une décision ne retire **jamais** l'effet de clôture qu'elle
   * portait : `CR5-01` l'a tranché, et ce service n'écrit aucun retrait de son
   * propre chef. Les deux actualités demeurent indépendantes, et leur
   * dérivation appartient à S9.
   */
  readonly supersedes?: readonly SupersessionRelation[];
  /**
   * Retrait d'effet de clôture, **explicite** (§21.1).
   *
   * Champ d'effet **distinct** de `closure` et **distinct** de `supersedes`.
   * Absent ⇒ aucun retrait. Rien ne le produit implicitement : ni une
   * supersession, ni une décision nouvelle, ni une contradiction, ni la
   * récence, ni le silence, ni une proposition, ni une détection, ni un contenu
   * textuel qui l'affirmerait.
   *
   * ```text
   * ABSENT WITHDRAWAL DECLARATION  →  NO WITHDRAWAL ACT
   * ```
   */
  readonly closure_withdrawal?: ClosureWithdrawalDeclaration;
  /**
   * Rattachement à une proposition CCR (§13.2, §13.3).
   *
   * ```text
   * RELATION  ≠  AUTHORITY EFFECT
   * HUMAN ACCEPTANCE  ≠  AUTHORSHIP OF CCR REASONING
   * ```
   *
   * La relation n'ajoute aucun effet et ne remplace rien : `content`, `scope`,
   * `provenance` et la forme d'autorité restent exigés à l'identique. Adopter
   * une proposition crée un acte humain NOUVEAU ; cela ne réattribue jamais la
   * proposition d'origine, qui demeure d'origine `CCR`.
   */
  readonly responds_to?: ActRespondsToInput;
}

/** La relation humaine à une proposition, telle que l'appelant la soumet. */
export interface ActRespondsToInput {
  readonly proposal_id: string;
  readonly relation: ProposalRelation;
  /**
   * ADOPTED OPTION REFERENCE — portée **sous la relation `ADOPTS`** (§13.5), et
   * sous elle seule.
   */
  readonly adopted_option_id?: string;
}

/** La réponse humaine à une proposition, telle que l'appelant la soumet. */
export interface RecordProposalResponseInput {
  readonly runId: string;
  readonly expected_revision: string;
  readonly target_controversy_id: string;
  readonly proposal_id: string;
  readonly mode: ResponseMode;
  /**
   * RESPONSE OPTION REFERENCE — **optionnelle**, pour `ACCEPT` comme pour
   * `REJECT` : le §13.1 ne la lie à aucun mode. Présente, elle est validée
   * (§13.5) ; elle ne produit **aucun** effet et ne vaut jamais adoption.
   */
  readonly responded_option_id?: string;
  readonly provenance: Provenance;
}

export interface RecordProposalResponseResult {
  readonly runId: string;
  readonly outcome: 'RECORDED';
  readonly entry: ProposalResponseRecordedEntry;
  readonly reconciliation_revision: string;
  readonly provider_effect: typeof RECONCILIATION_HUMAN_PROVIDER_EFFECT;
}

export interface RecordReconciliationResult {
  readonly runId: string;
  readonly outcome: 'RECORDED';
  readonly entry: ReconciliationRecordedEntry;
  /** Révision de la source **après** l'append, calculée sous le même verrou. */
  readonly reconciliation_revision: string;
  readonly provider_effect: typeof RECONCILIATION_HUMAN_PROVIDER_EFFECT;
}

// --------------------------------------------------------------------------
// Provenance — auditabilité, jamais autorité
// --------------------------------------------------------------------------

/**
 * Confronte une provenance à l'état autoritaire — `C35`.
 *
 * ```text
 * DECLARED                forme seule : un énoncé humain ne « résout » nulle part
 * CONTROVERSY_AUTHORITY   l'entrée ctve_ DOIT résoudre dans le journal V3 du run
 * LEGACY_DECISION         forme seule — voir ci-dessous
 * ```
 *
 * ## Pourquoi `LEGACY_DECISION` n'est pas résolue ici
 *
 * Le contrat §28 place `decisions.jsonl` **hors de l'instantané stable**, et §30
 * n'en fait pas une source observée. Résoudre la référence exigerait donc de
 * lire une source dont la coexistence avec l'instantané n'a pas été établie —
 * exactement la vue que le protocole d'observation existe pour interdire. La
 * forme canonique `DEC-NNNN` est vérifiée par le domaine S1 ; au-delà, la
 * référence reste ce que le contrat en fait : **`REFERENCE_ONLY`**.
 *
 * ## Ce qu'aucune provenance ne fait
 *
 * ```text
 * PROVENANCE_PRESENT  ≠  AUTHORITY_VERIFIED
 * REFERENCE_EXISTS    ≠  AUTHORITY_SUFFICIENT
 * REFERENCE           ≠  DUPLICATION  ≠  CONVERSION
 * PROVENANCE          ≠  AUTHORITY
 * ```
 *
 * Une provenance valide, quelle que soit sa sorte, ne confère ni clôture, ni
 * effet, ni éligibilité supplémentaire : elle ne contribue à aucune des
 * conditions `H1`–`H5`. Et le `scope` **textuel** d'une autorité V3 référencée
 * n'est jamais promu en périmètre canonique V5 — le périmètre de l'acte vient
 * de son propre champ, validé par S4, et de nulle part ailleurs.
 */
function assertProvenanceResolves(snapshot: NativeRunSnapshot, provenance: Provenance): void {
  switch (provenance.kind) {
    case 'DECLARED':
      return;

    case 'CONTROVERSY_AUTHORITY': {
      // La référence désigne une ENTRÉE V3. Elle doit exister dans CE run,
      // résolue depuis l'instantané déjà acquis — jamais par une seconde
      // lecture, et sans qu'aucune donnée V3 ne soit touchée, copiée ou promue.
      const exists = snapshot.controversies.some(
        (entry) => entry.entry_id === provenance.entry_id,
      );
      if (!exists) {
        throw refuse(
          'PROVENANCE_REFERENCE_NOT_FOUND',
          `L'entrée de controverse ${provenance.entry_id} n'existe pas dans ce run : une provenance ` +
            "référence un fait existant, elle n'en crée aucun.",
          { entry_id: provenance.entry_id },
        );
      }
      return;
    }

    case 'LEGACY_DECISION':
      // Forme canonique déjà vérifiée par le domaine. Aucune lecture de
      // `decisions.jsonl` : hors instantané stable (§28, §30).
      return;
  }
}

// --------------------------------------------------------------------------
// Frontière d'entrée — quatre familles de champs, une seule règle
// --------------------------------------------------------------------------

/**
 * Champs que **cette tranche** accepte aujourd'hui.
 *
 * Allowlist unique, et non trois listes noires ad hoc : une tranche ultérieure
 * étend cette surface en déplaçant un nom depuis `FUTURE_SLICE_INTENT_FIELDS`,
 * et rien d'autre ne bouge.
 */
const ACCEPTED_INPUT_FIELDS: readonly string[] = [
  'runId',
  'expected_revision',
  'target_controversy_id',
  'scope_kind',
  'scope',
  'content',
  'provenance',
  'closure',
  // Ouvert par S6, et par S6 seule. Aucune ouverture collatérale.
  'supersedes',
  // Ouvert par S7, et par S7 seule.
  'closure_withdrawal',
  // Ouvert par S8 : la relation humaine à une proposition.
  'responds_to',
];

/**
 * Champs qu'une RÉPONSE accepte. Allowlist distincte, et volontairement plus
 * courte : une réponse ne gouverne rien.
 *
 * ```text
 * ni scope_kind · ni scope · ni content · ni closure
 * ni closure_withdrawal · ni supersedes · ni E
 * ```
 */
const RESPONSE_ACCEPTED_INPUT_FIELDS: readonly string[] = [
  'runId',
  'expected_revision',
  'target_controversy_id',
  'proposal_id',
  'mode',
  'responded_option_id',
  'provenance',
];

/**
 * Champs dont le **serveur** est l'auteur (§9.1, `H1`).
 *
 * Le contrat impose qu'ils soient produits ici ; une valeur proposée par
 * l'appelant est donc écrasée, et cette politique est déjà prouvée. Ce n'est pas
 * une perte d'intention humaine : l'appelant n'a aucune autorité sur ces
 * champs, et les accepter permettrait de forger une autorité que l'acte n'a pas.
 *
 * ```text
 * SERVER-OWNED OVERRIDE  ≠  SILENT LOSS OF HUMAN INTENT
 * ```
 */
const SERVER_OWNED_FIELDS: readonly string[] = [
  'entry_id',
  'schema_version',
  'recorded_at',
  'recorded_by',
  'observed_revision',
  'semantic_origin',
  'derivation',
];

/**
 * Champs **contractuellement valides** du domaine V5 dont le runtime appartient
 * à une tranche non encore livrée.
 *
 * ```text
 * supersedes           → S6
 * closure_withdrawal   → S7
 * responds_to          → S8   (relation ADOPTS / MODIFIES / REPLACES)
 * ```
 *
 * ```text
 * DOMAIN VALID  ≠  CURRENT S5 SERVICE CAPABILITY
 * ```
 *
 * Le domaine S1 continue de les représenter : ils ne sont retirés d'aucun
 * modèle canonique. Ce qui manque est l'implémentation, et une tranche
 * ultérieure l'ajoutera en retirant simplement le nom de cette table.
 */
const FUTURE_SLICE_INTENT_FIELDS: Readonly<Record<string, string>> = {
  // Vide depuis S8 : les trois champs d'intention du domaine V5 ont chacun
  // trouvé leur tranche. Le mécanisme demeure — il est la seule façon honnête
  // de refuser une capacité non encore livrée, et une tranche future qui
  // ajouterait une forme au domaine s'y inscrirait avant de l'implémenter.
};

/**
 * Garde d'entrée **brute** — la réparation du défaut de perte silencieuse.
 *
 * Le service construisait son candidat à partir de champs nommés, puis validait
 * ce seul candidat : un champ écarté avant construction n'atteignait donc ni le
 * validateur du domaine, ni celui du store. Une demande de supersession
 * devenait un acte de réconciliation ordinaire, rendu `RECORDED`.
 *
 * ```text
 * VALIDATION  ≠  REWRITING HUMAN INTENT
 * ```
 *
 * `S5` ne peut pas enregistrer honnêtement une opération qu'elle n'implémente
 * pas encore. Elle refuse donc, **avant tout octet canonique**, plutôt que
 * d'écrire un acte différent de celui demandé. Ce refus n'anticipe aucune
 * tranche : il ne déclenche ni la détection de cycles de S6, ni la politique de
 * retrait de S7, ni la résolution de proposition de S8.
 *
 * ```text
 * REFUSE CURRENTLY UNSUPPORTED  ≠  IMPLEMENT FUTURE SLICE
 * ```
 *
 * Le refus emprunte la famille déjà autorisée — `REFUSED_VALIDATION` (§38.1) —
 * et n'introduit aucune issue canonique nouvelle. Le motif est un détail local
 * (`K17`), porté dans les détails de l'erreur.
 */
function assertInputShape(input: RecordReconciliationInput): void {
  for (const field of Object.keys(input as unknown as Record<string, unknown>)) {
    if (ACCEPTED_INPUT_FIELDS.includes(field)) continue;
    // Champ serveur : politique acquise, écrasement silencieux légitime.
    if (SERVER_OWNED_FIELDS.includes(field)) continue;

    const owner = FUTURE_SLICE_INTENT_FIELDS[field];
    if (owner !== undefined) {
      throw refuse(
        'UNSUPPORTED_SEMANTIC_INTENT',
        `\`${field}\` exprime une intention que cette tranche n'implémente pas encore : son ` +
          `runtime appartient à ${owner}. La demande est refusée plutôt que réduite à un acte ` +
          "différent de celui qui a été formulé.",
        { field, runtime_owner: owner },
      );
    }

    // Champ réellement inconnu : refusé, jamais ignoré — même discipline que le
    // schéma fermé du domaine, appliquée ici à l'entrée brute.
    throw refuse(
      'UNKNOWN_INPUT_FIELD',
      `\`${field}\` n'appartient ni à l'entrée de cette tranche, ni aux champs serveur : le ` +
        "schéma d'entrée est fermé, il refuse plutôt qu'il n'ignore.",
      { field },
    );
  }
}

// --------------------------------------------------------------------------
// Forme d'autorité humaine V5 — `H1`–`H5`
// --------------------------------------------------------------------------

/**
 * Ce que ce service établit de la forme d'autorité humaine (§10.2).
 *
 * ```text
 * H1  origine sémantique HUMAN          posée par le SERVEUR, jamais reçue
 * H2  chemin de mutation humaine        cette fonction EST ce chemin ; aucun
 *                                       fournisseur ne l'atteint (type)
 * H3  effet déclaré explicitement       `closure` est un champ séparé, absent
 *                                       par défaut ; exécuter l'opération ne
 *                                       produit jamais un effet
 * H4  périmètre explicite et énuméré    validé/énuméré par S4 sous le verrou
 * H5  instantané autoritaire frais      `expected` comparée à `observed`
 * ```
 *
 * ```text
 * OBSERVABLE HUMAN FORM  ≠  REAL-WORLD ENTITLEMENT
 * ```
 *
 * Ce module n'établit ni `IDENTITY_VERIFIED`, ni `ROLE_VERIFIED`, ni
 * `LEGAL_AUTHORIZATION_VERIFIED`, ni `PERSON_ENTITLEMENT_VERIFIED`, et ne
 * prétend pas savoir qui se trouvait derrière le terminal. Aucun champ de ce
 * fichier ne porte un nom qui le suggérerait.
 *
 * `provenance` ne contribue à **aucune** de ces cinq conditions (`CR5-02`).
 */
function assertClosureDeclaredSeparately(input: RecordReconciliationInput): void {
  if (input.closure === undefined) return;
  // `H3` — l'effet doit être déclaré, explicitement et séparément. Le domaine
  // n'admet que `declared: true` ; ce contrôle refuse en outre toute tentative
  // d'obtenir une clôture sans la déclarer.
  if (input.closure.declared !== true) {
    throw refuse(
      'CLOSURE_NOT_DECLARED_SEPARATELY',
      "Une clôture ne s'obtient que par une déclaration explicite : une opération ordinaire n'en " +
        'produit jamais (§10.5, `H3`).',
    );
  }
}

// --------------------------------------------------------------------------
// Supersession de décision — S6, contrat §18
// --------------------------------------------------------------------------

/**
 * Classes superséssibles — ensemble **fermé** (§18.3).
 *
 * ```text
 * SUPERSÉDABLE      RECONCILIATION_RECORDED · PROPOSAL_RESPONSE_RECORDED
 * NON SUPERSÉDABLE  RECONCILIATION_PROPOSED · détection · vue dérivée
 *                   · relation V3 · acte probatoire V4
 * ```
 *
 * Une proposition CCR n'est pas supersédable : superséder suppose un acte
 * humain, et une proposition n'en est pas un.
 */
const SUPERSEDABLE_KINDS: readonly ReconciliationEntry['kind'][] = [
  'RECONCILIATION_RECORDED',
  'PROPOSAL_RESPONSE_RECORDED',
];

/** Le périmètre d'un enregistrement, pour les inclusions du §18.2. */
function scopeOf(entry: ReconciliationEntry): readonly string[] {
  return (entry as unknown as Record<string, unknown>)['scope'] as readonly string[] | undefined ?? [];
}

/** Les relations de supersession portées par un enregistrement. */
function relationsOf(entry: ReconciliationEntry): readonly SupersessionRelation[] {
  return (entry as unknown as Record<string, unknown>)['supersedes'] as
    | readonly SupersessionRelation[]
    | undefined ?? [];
}

/**
 * `V25` / `CR5-08` — acyclicité vérifiée **par unité `ctve_`**.
 *
 * ```text
 * pour chaque ctve_ e :
 *     construire le graphe orienté des relations dont le supersession_scope
 *     contient e
 *     exiger l'absence de cycle dans ce graphe
 * ```
 *
 * L'arête va de l'acte **superseding** vers l'acte **superséd**. Le graphe est
 * construit par unité, et non globalement : des relations réciproques sur des
 * unités **disjointes** sont acceptées (`C22`), parce qu'aucune unité ne porte
 * alors de cycle et que la sémantique reste déterminée.
 *
 * ## Portée réelle de ce contrôle
 *
 * Sur une histoire bien formée, un acte nouveau ne **peut pas** fermer un
 * cycle : son identité vient d'être allouée, aucune relation existante ne le
 * vise, et son degré entrant est donc nul. Le contrôle n'est pas pour autant
 * décoratif — il refuse un acte qui toucherait une unité dont le graphe est
 * **déjà** cyclique, cas qu'un journal écrit hors du service peut produire. Le
 * contrat exige l'absence de cycle dans ce graphe, non l'absence de cycle
 * « ajouté par cet acte ».
 */
function findCyclicUnit(
  edges: readonly { readonly from: string; readonly to: string; readonly unit: string }[],
  units: ReadonlySet<string>,
): string | undefined {
  for (const unit of units) {
    const graph = new Map<string, string[]>();
    for (const edge of edges) {
      if (edge.unit !== unit) continue;
      const out = graph.get(edge.from) ?? [];
      out.push(edge.to);
      graph.set(edge.from, out);
    }

    const VISITING = 1;
    const DONE = 2;
    const state = new Map<string, number>();

    const hasCycle = (node: string): boolean => {
      const current = state.get(node);
      if (current === VISITING) return true;
      if (current === DONE) return false;
      state.set(node, VISITING);
      for (const next of graph.get(node) ?? []) {
        if (hasCycle(next)) return true;
      }
      state.set(node, DONE);
      return false;
    };

    for (const node of graph.keys()) {
      if (hasCycle(node)) return unit;
    }
  }
  return undefined;
}

/**
 * Valide les relations de supersession d'un acte — les neuf préconditions du
 * §18.2.
 *
 * ```text
 * VALIDATION  ≠  SCOPE AUTHORSHIP
 * ```
 *
 * Les conditions 5 et 6 **valident** que le périmètre déclaré appartient à
 * l'intersection ; elles ne le produisent jamais. Une intersection vide rend
 * toute relation valide impossible, et l'acte est refusé — jamais réduit,
 * jamais complété, jamais recalculé.
 *
 * ```text
 * RECENCY        ≠  SUPERSESSION
 * CONTRADICTION  ≠  SUPERSESSION
 * NEW_DECISION   ≠  AUTOMATIC_SUPERSESSION
 * ```
 *
 * Aucune cible n'est choisie par le système : ni « la plus récente », ni « la
 * précédente », ni un prédécesseur implicite. La relation vise l'identité que
 * l'humain a nommée, et elle seule.
 *
 * ## Ce que cette fonction ne fait jamais
 *
 * Elle ne modifie pas l'acte visé — le journal est append-only, et l'acte
 * antérieur reste tel quel. Elle n'écrit aucun pointeur d'actualité, ne calcule
 * aucune fermeture transitive, et ne crée **aucun** retrait de clôture.
 *
 * ```text
 * SUPERSESSION  ≠  CLOSURE WITHDRAWAL                         ← CR5-01
 * ```
 */
function assertSupersessionValid(
  snapshot: NativeRunSnapshot,
  input: RecordReconciliationInput,
  actScope: readonly string[],
  actEntryId: string,
): void {
  const relations = input.supersedes;
  if (relations === undefined) return;
  if (!Array.isArray(relations)) {
    throw refuse('SUPERSESSION_SCOPE_EMPTY', 'supersedes doit être un tableau de relations (§18.1).');
  }

  const byId = new Map<string, ReconciliationEntry>();
  for (const entry of snapshot.reconciliations) byId.set(entry.entry_id, entry);

  const actScopeSet = new Set(actScope);
  const seenTargets = new Set<string>();
  const touchedUnits = new Set<string>();

  for (const [index, relation] of relations.entries()) {
    const at = `supersedes[${String(index)}]`;
    const targetId = relation.superseded_act_id;

    // ---- 7 — pas d'auto-référence. Interdit GLOBALEMENT, quelle que soit
    // l'unité : un acte ne se supersède jamais lui-même.
    if (targetId === actEntryId) {
      throw refuse('SELF_SUPERSESSION', `${at} : un acte ne peut pas se superséder lui-même (§18.5).`, {
        at, superseded_act_id: targetId,
      });
    }

    // ---- 8 — aucun doublon de superseded_act_id dans un même acte.
    if (seenTargets.has(targetId)) {
      throw refuse('DUPLICATE_SUPERSEDED_ACT', `${at} : ${targetId} est visé deux fois par le même acte.`, {
        at, superseded_act_id: targetId,
      });
    }
    seenTargets.add(targetId);

    // ---- 2 — l'acte visé existe, résolu contre la source V5 AUTORITAIRE.
    // Jamais une copie fournie par l'appelant.
    const target = byId.get(targetId);
    if (target === undefined) {
      throw refuse(
        'SUPERSEDED_ACT_NOT_FOUND',
        `${at} : l'acte ${targetId} n'existe pas dans ce run. Une supersession référence un acte ` +
          "existant, elle n'en crée aucun.",
        { at, superseded_act_id: targetId },
      );
    }

    // ---- 2 (suite) / §18.3 — classe superséssible, ensemble fermé.
    if (!SUPERSEDABLE_KINDS.includes(target.kind)) {
      throw refuse(
        'SUPERSEDED_ACT_NOT_SUPERSEDABLE',
        `${at} : un enregistrement de sorte ${target.kind} n'est pas superséssible (§18.3).`,
        { at, superseded_act_id: targetId, kind: target.kind },
      );
    }

    // ---- 3 — même controverse cible. Aucun remappage automatique.
    if (target.target.controversy_id !== input.target_controversy_id) {
      throw refuse(
        'SUPERSEDED_ACT_FOREIGN_CONTROVERSY',
        `${at} : ${targetId} porte sur ${target.target.controversy_id}, non sur ` +
          `${input.target_controversy_id}.`,
        { at, superseded_act_id: targetId, target_controversy_id: target.target.controversy_id },
      );
    }

    // ---- 4 — périmètre explicite et NON VIDE.
    const relationScope = relation.supersession_scope;
    if (!Array.isArray(relationScope) || relationScope.length === 0) {
      throw refuse(
        'SUPERSESSION_SCOPE_EMPTY',
        `${at}.supersession_scope doit être explicitement énuméré et non vide (§18.2).`,
        { at },
      );
    }

    const targetScopeSet = new Set(scopeOf(target));
    for (const unit of relationScope) {
      // ---- 5 — ⊆ périmètre de l'acte superseding.
      if (!actScopeSet.has(unit)) {
        throw refuse(
          'SUPERSESSION_SCOPE_NOT_IN_SUPERSEDING_ACT',
          `${at} : ${unit} n'appartient pas au périmètre de l'acte qui supersède.`,
          { at, entry_id: unit },
        );
      }
      // ---- 6 — ⊆ périmètre de l'acte superséd.
      if (!targetScopeSet.has(unit)) {
        throw refuse(
          'SUPERSESSION_SCOPE_NOT_IN_SUPERSEDED_ACT',
          `${at} : ${unit} n'appartient pas au périmètre de ${targetId}.`,
          { at, entry_id: unit, superseded_act_id: targetId },
        );
      }
      touchedUnits.add(unit);
    }
  }

  if (touchedUnits.size === 0) return;

  // ---- 9 — acyclicité PAR UNITÉ. Le graphe réunit les relations déjà
  // enregistrées et celles de l'acte en cours.
  const edges: { from: string; to: string; unit: string }[] = [];
  for (const entry of snapshot.reconciliations) {
    for (const relation of relationsOf(entry)) {
      for (const unit of relation.supersession_scope) {
        edges.push({ from: entry.entry_id, to: relation.superseded_act_id, unit });
      }
    }
  }
  for (const relation of relations) {
    for (const unit of relation.supersession_scope) {
      edges.push({ from: actEntryId, to: relation.superseded_act_id, unit });
    }
  }

  const cyclic = findCyclicUnit(edges, touchedUnits);
  if (cyclic !== undefined) {
    throw refuse(
      'SUPERSESSION_CYCLE',
      `Un cycle de supersession existe sur l'unité ${cyclic} : la sémantique n'y serait pas ` +
        'déterminée (§18.5).',
      { entry_id: cyclic },
    );
  }
}

// --------------------------------------------------------------------------
// Retrait de clôture — S7, contrat §21
// --------------------------------------------------------------------------

/** La déclaration de clôture portée par un enregistrement, s'il en porte une. */
function closureOf(entry: ReconciliationEntry): ClosureDeclaration | undefined {
  return (entry as unknown as Record<string, unknown>)['closure'] as ClosureDeclaration | undefined;
}

/**
 * Valide un retrait de clôture — les neuf préconditions du §21.2.
 *
 * ```text
 * CLOSURE WITHDRAWAL  ≠  SUPERSESSION
 * CLOSURE WITHDRAWAL  ≠  HISTORY REWRITE
 * CLOSURE WITHDRAWAL  ≠  TRUTH CORRECTION
 * ```
 *
 * ## Désignation non ambiguë — §21.3
 *
 * Lorsque plusieurs effets de clôture existent sur une même unité, le retrait
 * **énumère explicitement** les actes dont il retire la clôture. Aucune règle de
 * récence n'existe :
 *
 * ```text
 * INTERDIT  latest closure wins
 * INTERDIT  retrait par défaut de toutes les clôtures d'une unité
 * INTERDIT  retrait implicite par supersession
 * RECENCY   ≠  WITHDRAWAL AUTHORITY
 * ```
 *
 * ## Ce que cette fonction ne fait jamais
 *
 * Elle ne touche pas l'acte qui avait déclaré la clôture : le journal est
 * append-only, et la déclaration historique demeure enregistrée et lisible. Elle
 * n'écrit aucun état de cycle de vie — ni `OPEN`, ni `CLOSED`, ni `REOPENED` —
 * et ne calcule aucune actualité d'effet : le §20.3 est la règle de S9, non la
 * sienne.
 *
 * ```text
 * HISTORICAL WITHDRAWAL  ≠  CURRENT STATE IMPLEMENTED
 * REOPENING              ≠  ERASURE OF HISTORICAL CLOSURE
 * ```
 */
function assertClosureWithdrawalValid(
  snapshot: NativeRunSnapshot,
  input: RecordReconciliationInput,
  actScope: readonly string[],
): void {
  const withdrawal = input.closure_withdrawal;
  if (withdrawal === undefined) return;

  // ---- 6 — `withdrawn_closures` non vide, sans doublon (`V19`). C'est la
  // condition de DÉSIGNATION NON AMBIGUË : sans elle, il faudrait deviner
  // quelle clôture est visée, et deviner serait choisir.
  const targets = withdrawal.withdrawn_closures;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw refuse(
      'WITHDRAWN_CLOSURES_EMPTY',
      'closure_withdrawal.withdrawn_closures doit désigner explicitement au moins une clôture ' +
        '(§21.2 c.6). Aucun retrait par défaut n\'existe.',
    );
  }
  const seen = new Set<string>();
  for (const [index, id] of targets.entries()) {
    if (seen.has(id)) {
      throw refuse(
        'DUPLICATE_WITHDRAWN_CLOSURE',
        `closure_withdrawal.withdrawn_closures[${String(index)}] : ${id} est désigné deux fois.`,
        { position: index, withdrawn_closure: id },
      );
    }
    seen.add(id);
  }

  // ---- 4 — `withdrawal_scope` explicitement énuméré, non vide.
  const scope = withdrawal.withdrawal_scope;
  if (!Array.isArray(scope) || scope.length === 0) {
    throw refuse(
      'WITHDRAWAL_SCOPE_EMPTY',
      'closure_withdrawal.withdrawal_scope doit être explicitement énuméré et non vide (§21.2 c.4).',
    );
  }

  // ---- 5 — ⊆ périmètre de l'acte de retrait (`V17`).
  const actScopeSet = new Set(actScope);
  for (const unit of scope) {
    if (!actScopeSet.has(unit)) {
      throw refuse(
        'WITHDRAWAL_SCOPE_NOT_IN_WITHDRAWAL_ACT',
        `closure_withdrawal.withdrawal_scope : ${unit} n'appartient pas au périmètre de l'acte de retrait.`,
        { entry_id: unit },
      );
    }
  }

  const byId = new Map<string, ReconciliationEntry>();
  for (const entry of snapshot.reconciliations) byId.set(entry.entry_id, entry);

  for (const [index, targetId] of targets.entries()) {
    const at = `closure_withdrawal.withdrawn_closures[${String(index)}]`;

    // ---- 7 — l'acte visé EXISTE, résolu contre l'état V5 autoritaire relu
    // sous le verrou. Aucune copie fournie par l'appelant n'est crue.
    const target = byId.get(targetId);
    if (target === undefined) {
      throw refuse(
        'WITHDRAWN_CLOSURE_NOT_FOUND',
        `${at} : l'acte ${targetId} n'existe pas dans ce run. Un retrait référence un fait ` +
          "historique, il n'en crée aucun.",
        { at, withdrawn_closure: targetId },
      );
    }

    // ---- 7 (suite) — l'acte visé est HUMAIN.
    if (target.semantic_origin !== 'HUMAN') {
      throw refuse(
        'WITHDRAWN_ACT_NOT_HUMAN',
        `${at} : ${targetId} porte l'origine ${target.semantic_origin} ; seul un acte humain peut ` +
          'avoir déclaré une clôture.',
        { at, withdrawn_closure: targetId, semantic_origin: target.semantic_origin },
      );
    }

    // ---- 7 (fin) — l'acte visé DÉCLARE EFFECTIVEMENT une clôture. Aucun effet
    // de clôture n'est inféré depuis `content`, `provenance`, `supersedes` ou
    // quelque autre champ : seule la déclaration compte.
    const closure = closureOf(target);
    if (closure === undefined || closure.declared !== true) {
      throw refuse(
        'WITHDRAWN_ACT_DECLARES_NO_CLOSURE',
        `${at} : ${targetId} ne déclare aucune clôture. Un acte sans clôture ne devient pas ` +
          '« une clôture à retirer ».',
        { at, withdrawn_closure: targetId },
      );
    }

    // ---- 3 — même controverse cible que les clôtures visées.
    if (target.target.controversy_id !== input.target_controversy_id) {
      throw refuse(
        'WITHDRAWN_CLOSURE_FOREIGN_CONTROVERSY',
        `${at} : ${targetId} porte sur ${target.target.controversy_id}, non sur ` +
          `${input.target_controversy_id}.`,
        { at, withdrawn_closure: targetId, target_controversy_id: target.target.controversy_id },
      );
    }

    // ---- 8 — `withdrawal_scope` ⊆ périmètre de CHAQUE clôture visée (`V18`).
    // L'effet de clôture porte sur les unités énumérées de l'acte qui l'a
    // déclarée (§16.3) ; on ne peut retirer que là où il portait.
    const closureScope = new Set(scopeOf(target));
    for (const unit of scope) {
      if (!closureScope.has(unit)) {
        throw refuse(
          'WITHDRAWAL_SCOPE_NOT_IN_CLOSURE_ACT',
          `${at} : ${unit} n'appartient pas au périmètre de la clôture de ${targetId}.`,
          { at, entry_id: unit, withdrawn_closure: targetId },
        );
      }
    }
  }
}

// --------------------------------------------------------------------------
// Propositions — S8, contrat §13
// --------------------------------------------------------------------------

/**
 * Résout une proposition et, si demandée, l'une de ses options — `V27`, `V28`,
 * `V33`.
 *
 * ```text
 * 1  la proposition référencée EXISTE dans l'état V5 autoritaire
 * 2  elle est bien une RECONCILIATION_PROPOSED — jamais un acte ni une réponse
 * 3  l'option, si demandée, existe DANS CETTE proposition
 * ```
 *
 * ```text
 * OPTION BELONGS TO EXACT REFERENCED PROPOSAL
 * OPTION ORDER  ≠  PREFERENCE
 * ```
 *
 * Aucune option n'est choisie par position, par rang, par récence ni par
 * heuristique : seule l'identité déclarée est cherchée, et elle n'est cherchée
 * que dans la proposition nommée. Une option dont l'`option_id` existe dans une
 * **autre** proposition ne résout pas.
 *
 * ```text
 * REFERENCE VALIDATION  ≠  MERITS VALIDATION
 * ```
 *
 * Résoudre établit qu'une référence désigne un objet réel. Cela n'établit ni que
 * l'option soit bonne, ni qu'elle doive être suivie.
 */
function resolveProposal(
  snapshot: NativeRunSnapshot,
  proposalId: string,
  targetControversyId: string,
  at: string,
): ReconciliationEntry {
  const referenced = snapshot.reconciliations.find((entry) => entry.entry_id === proposalId);
  if (referenced === undefined) {
    throw refuse(
      'PROPOSAL_NOT_FOUND',
      `${at} : la proposition ${proposalId} n'existe pas dans ce run.`,
      { at, proposal_id: proposalId },
    );
  }
  if (referenced.kind !== 'RECONCILIATION_PROPOSED') {
    throw refuse(
      'REFERENCED_RECORD_NOT_A_PROPOSAL',
      `${at} : ${proposalId} est un enregistrement de sorte ${referenced.kind}, non une ` +
        'proposition CCR.',
      { at, proposal_id: proposalId, kind: referenced.kind },
    );
  }
  if (referenced.target.controversy_id !== targetControversyId) {
    throw refuse(
      'PROPOSAL_FOREIGN_CONTROVERSY',
      `${at} : ${proposalId} porte sur ${referenced.target.controversy_id}, non sur ` +
        `${targetControversyId}.`,
      { at, proposal_id: proposalId, target_controversy_id: referenced.target.controversy_id },
    );
  }
  return referenced;
}

function assertOptionBelongsToProposal(
  proposal: ReconciliationEntry,
  optionId: string,
  at: string,
): void {
  const options = (proposal as unknown as Record<string, unknown>)['options'] as
    | readonly ProposalOption[]
    | undefined ?? [];
  if (!options.some((option) => option.option_id === optionId)) {
    throw refuse(
      'OPTION_NOT_IN_PROPOSAL',
      `${at} : l'option ${optionId} n'existe pas dans ${proposal.entry_id}. Aucune référence ` +
        "croisée vers l'option d'une autre proposition n'est admise (§13.5).",
      { at, proposal_id: proposal.entry_id, option_id: optionId },
    );
  }
}

/**
 * Valide la relation d'un acte humain à une proposition — `V27`, `V28`.
 *
 * ```text
 * ADOPTS      adopted_option_id EXIGÉ — la relation « réfère l'option adoptée »
 *             (§13.3), et §13.5 la porte « sous la relation ADOPTS »
 * MODIFIES    adopted_option_id INTERDIT — la proposition est la base, pas une
 *             option adoptée
 * REPLACES    adopted_option_id INTERDIT — la proposition n'est que contexte
 * ```
 *
 * ```text
 * REPLACES (relation à une proposition)  ≠  supersedes (relation entre actes)
 * ```
 *
 * Le mot « replace » ne contamine pas S6 : cette relation ne crée aucune
 * supersession, et n'en est pas une.
 */
function assertActRespondsToValid(
  snapshot: NativeRunSnapshot,
  input: RecordReconciliationInput,
): void {
  const relation = input.responds_to;
  if (relation === undefined) return;

  const at = 'responds_to';
  const proposal = resolveProposal(
    snapshot,
    relation.proposal_id,
    input.target_controversy_id,
    at,
  );

  if (relation.relation === 'ADOPTS') {
    if (relation.adopted_option_id === undefined) {
      throw refuse(
        'ADOPTED_OPTION_REQUIRED',
        `${at} : la relation ADOPTS désigne l'option adoptée sans ambiguïté (§13.3) ; ` +
          '`adopted_option_id` est donc exigé.',
        { at, proposal_id: relation.proposal_id },
      );
    }
    assertOptionBelongsToProposal(proposal, relation.adopted_option_id, `${at}.adopted_option_id`);
    return;
  }

  // `MODIFIES` / `REPLACES` — §13.5 porte `adopted_option_id` « sous la relation
  // ADOPTS ». Hors d'elle, le champ est refusé plutôt qu'ignoré.
  if (relation.adopted_option_id !== undefined) {
    throw refuse(
      'ADOPTED_OPTION_FORBIDDEN_OUTSIDE_ADOPTS',
      `${at}.adopted_option_id n'est porté que sous la relation ADOPTS (§13.5) ; la relation ` +
        `déclarée est ${relation.relation}.`,
      { at, relation: relation.relation },
    );
  }
}

// --------------------------------------------------------------------------
// L'unique mutation de cette tranche
// --------------------------------------------------------------------------

/**
 * Enregistre un acte humain de réconciliation.
 *
 * L'ordre est le contrat lui-même : la fraîcheur est comparée **avant** toute
 * validation métier, et toute validation précède l'unique écriture durable. Un
 * refus, quel qu'il soit, laisse le journal — et son absence — intacts.
 *
 * ```text
 * BUSINESS REFUSAL  →  ZERO CANONICAL BYTES WRITTEN
 * ```
 *
 * Un seul `withNativeMutation`, donc **une seule** acquisition du verrou de run.
 * Les primitives de S4 sont appelées **à l'intérieur** de cette frontière et
 * n'en prennent aucune : le verrou n'est pas réentrant, et un second `link`
 * échouerait contre notre propre processus.
 *
 * Le fait enregistré est exactement celui-ci :
 *
 * > une personne a enregistré ce contenu, sur ce périmètre, à cette date, avec
 * > ces effets déclarés.
 *
 * Il ne dit ni que le contenu est vrai, ni que les experts s'accordent, ni
 * qu'une convergence existe.
 */
export async function recordReconciliation(
  deps: ReconciliationServiceDeps,
  input: RecordReconciliationInput,
  boundary?: NativeMutationBoundary,
): Promise<RecordReconciliationResult> {
  const paths = runPaths(deps.runsDir, input.runId);

  return withNativeMutation(
    {
      runsDir: deps.runsDir,
      runId: input.runId,
      command: 'v5-record-reconciliation',
      ...(boundary === undefined ? {} : { boundary }),
    },
    async () => {
      // ---- Faits canoniques courants, relus SOUS le verrou. Le snapshot refuse
      // un run historique et lève sur tout journal corrompu.
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, input.runId);

      // ---- `H5` / `V31` — la fraîcheur AVANT toute validation métier. La
      // valeur attendue vient de l'appelant ; la valeur observée est dérivée de
      // l'état qu'on vient de relire. Les deux appartiennent au domaine
      // `rcn-sha256:`, et aucune autre révision n'entre dans cette comparaison.
      const observedRevision = snapshot.reconciliation_revision;
      if (observedRevision !== input.expected_revision) {
        throw new CcrError(
          'STALE_REVISION',
          `Le Reconciliation Engine du run ${input.runId} a changé depuis la vue de l'appelant : ` +
            "aucune écriture n'est tentée.",
          {
            details: {
              outcome: 'REFUSED_FRESHNESS',
              runId: input.runId,
              expected_revision: input.expected_revision,
              observed_revision: observedRevision,
            },
          },
        );
      }

      // ---- Frontière d'entrée. Placée APRÈS la fraîcheur, jamais avant : une
      // vue périmée invalide la demande entière, et cette précédence est celle
      // que le contrat impose. Une requête à la fois périmée et porteuse d'un
      // champ non supporté est donc refusée pour sa fraîcheur.
      assertInputShape(input);

      // ---- `H3` — l'effet doit être déclaré séparément, avant toute autre
      // validation métier : un effet qui ne peut pas être déclaré séparément est
      // une condition d'arrêt de cette tranche.
      assertClosureDeclaredSeparately(input);

      // ---- `H4` / `V03` — périmètre validé, ou `WHOLE` ÉNUMÉRÉ, contre l'état
      // autoritaire relu DANS cette frontière. Une énumération préparée hors
      // verrou n'est jamais réutilisée : `prepareScope` ne voit que ce snapshot.
      const scope = prepareScope(snapshot, {
        target_controversy_id: input.target_controversy_id,
        scope_kind: input.scope_kind,
        scope: input.scope,
      });

      // ---- `V13` / `C33` / `C34` / `C35` — provenance confrontée à l'état
      // autoritaire. Elle demeure une information d'audit.
      assertProvenanceResolves(snapshot, input.provenance);

      // ---- Identité allouée depuis l'état autoritaire, sous ce verrou. Aucun
      // compteur parallèle. La séquence est strictement croissante ; elle n'est
      // pas contiguë, et aucun trou n'est comblé.
      const journal = await readReconciliationJournal(paths);
      const entryId = formatReconciliationId(journal.next_sequence);

      // ---- `V20`–`V26` — supersession. Validée APRÈS l'allocation, parce que
      // l'irréflexivité et l'acyclicité se posent sur l'identité de l'acte.
      // Aucun octet n'a encore été écrit : l'identité n'est qu'un nombre lu.
      assertSupersessionValid(snapshot, input, scope, entryId);

      // ---- `V15`–`V19` — retrait de clôture. Validé SÉPARÉMENT de la
      // supersession : une supersession valide ne rend pas un retrait valide,
      // et réciproquement. Les deux dimensions restent indépendantes.
      assertClosureWithdrawalValid(snapshot, input, scope);

      // ---- `V27`/`V28` — relation à une proposition. Validée SÉPARÉMENT des
      // effets : `ADOPTS` valide ne rend valide ni une clôture, ni une
      // supersession, ni un retrait — et réciproquement.
      assertActRespondsToValid(snapshot, input);

      // ---- Champs serveur. L'appelant n'en choisit aucun.
      const candidate: ReconciliationEntry = validateReconciliationEntry({
        schema_version: RECONCILIATION_SCHEMA_VERSION,
        entry_id: entryId,
        kind: 'RECONCILIATION_RECORDED',
        target: { kind: 'CONTROVERSY', controversy_id: input.target_controversy_id },
        // `H1` — posée par le serveur. Aucun appelant ne peut prétendre à une
        // autre origine, et `CCR` ou un fournisseur n'ont aucun chemin ici.
        semantic_origin: 'HUMAN',
        recorded_by: 'CCR',
        recorded_at: deps.now().toISOString(),
        observed_revision: observedRevision,
        scope_kind: input.scope_kind,
        scope,
        content: input.content,
        provenance: input.provenance,
        ...(input.closure === undefined ? {} : { closure: input.closure }),
        // Enregistrée telle qu'elle a été déclarée : ni réordonnée, ni
        // complétée, ni réduite. Aucune fermeture transitive n'est ajoutée.
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
        // Déclaration historique, enregistrée telle quelle. Elle n'efface rien :
        // la clôture visée demeure lisible dans son acte d'origine.
        ...(input.closure_withdrawal === undefined
          ? {}
          : { closure_withdrawal: input.closure_withdrawal }),
        // Rattachement historique. Il ne porte aucun effet, et la proposition
        // référencée demeure inchangée — d'origine `CCR`, comme elle l'a été.
        ...(input.responds_to === undefined ? {} : { responds_to: input.responds_to }),
      } as ReconciliationEntry);

      // ---- Unique écriture durable, dans ce verrou.
      const written = await appendReconciliationEntries(paths, [candidate]);
      const after = await readReconciliationJournal(paths);

      return {
        runId: input.runId,
        outcome: 'RECORDED' as const,
        entry: written[0] as ReconciliationRecordedEntry,
        reconciliation_revision: after.revision,
        provider_effect: RECONCILIATION_HUMAN_PROVIDER_EFFECT,
      };
    },
  );
}

/**
 * Enregistre une **réponse humaine** à une proposition — S8, §13.1.
 *
 * ```text
 * RESPONSE  ≠  AUTHORITATIVE HUMAN ACT
 * ACCEPT / REJECT  ≠  AUTHORITY EFFECT
 * ```
 *
 * Le fait enregistré est exactement celui-ci :
 *
 * > une personne a répondu `ACCEPT` ou `REJECT` à cette proposition, à cette
 * > date, éventuellement à propos de l'une de ses options.
 *
 * Il ne clôt rien, ne supersède rien, ne retire rien, ne produit aucun `E`, et
 * ne crée aucun `RECONCILIATION_RECORDED`. Un `ACCEPT`, même accompagné d'une
 * référence d'option réelle, **ne devient pas** `ADOPTS` : produire un effet
 * exige un acte humain complet, avec son contenu, son périmètre et ses effets
 * déclarés (§13.2).
 *
 * La forme ne porte ni `scope_kind`, ni `scope`, ni `content`, ni `closure`, ni
 * `closure_withdrawal`, ni `supersedes` : une allowlist d'entrée distincte les
 * refuse, plutôt que de les ignorer.
 *
 * Même discipline de mutation que l'acte humain : une seule frontière, fraîcheur
 * comparée avant toute validation métier, identité allouée sous le verrou,
 * unique append.
 */
export async function recordProposalResponse(
  deps: ReconciliationServiceDeps,
  input: RecordProposalResponseInput,
  boundary?: NativeMutationBoundary,
): Promise<RecordProposalResponseResult> {
  const paths = runPaths(deps.runsDir, input.runId);

  return withNativeMutation(
    {
      runsDir: deps.runsDir,
      runId: input.runId,
      command: 'v5-record-proposal-response',
      ...(boundary === undefined ? {} : { boundary }),
    },
    async () => {
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, input.runId);

      // ---- Fraîcheur AVANT toute validation métier — même précédence que
      // l'acte humain, et pour la même raison.
      const observedRevision = snapshot.reconciliation_revision;
      if (observedRevision !== input.expected_revision) {
        throw new CcrError(
          'STALE_REVISION',
          `Le Reconciliation Engine du run ${input.runId} a changé depuis la vue de l'appelant : ` +
            "aucune écriture n'est tentée.",
          {
            details: {
              outcome: 'REFUSED_FRESHNESS',
              runId: input.runId,
              expected_revision: input.expected_revision,
              observed_revision: observedRevision,
            },
          },
        );
      }

      // ---- Frontière d'entrée propre à la réponse : tout champ d'effet ou
      // inconnu est refusé, jamais écarté en silence.
      for (const field of Object.keys(input as unknown as Record<string, unknown>)) {
        if (RESPONSE_ACCEPTED_INPUT_FIELDS.includes(field)) continue;
        if (SERVER_OWNED_FIELDS.includes(field)) continue;
        throw refuse(
          'UNKNOWN_INPUT_FIELD',
          `\`${field}\` n'appartient pas à l'entrée d'une réponse : elle ne gouverne aucune ` +
            'unité et ne porte aucun effet (§13.1).',
          { field },
        );
      }

      // ---- `V27` / `V33` — la proposition existe, est bien une proposition, et
      // l'option, si elle est désignée, appartient À CETTE proposition.
      const proposal = resolveProposal(
        snapshot,
        input.proposal_id,
        input.target_controversy_id,
        'responds_to',
      );
      if (input.responded_option_id !== undefined) {
        assertOptionBelongsToProposal(
          proposal,
          input.responded_option_id,
          'responds_to.responded_option_id',
        );
      }

      const journal = await readReconciliationJournal(paths);
      const entryId = formatReconciliationId(journal.next_sequence);

      const candidate: ReconciliationEntry = validateReconciliationEntry({
        schema_version: RECONCILIATION_SCHEMA_VERSION,
        entry_id: entryId,
        kind: 'PROPOSAL_RESPONSE_RECORDED',
        target: { kind: 'CONTROVERSY', controversy_id: input.target_controversy_id },
        semantic_origin: 'HUMAN',
        recorded_by: 'CCR',
        recorded_at: deps.now().toISOString(),
        observed_revision: observedRevision,
        provenance: input.provenance,
        responds_to: {
          proposal_id: input.proposal_id,
          mode: input.mode,
          ...(input.responded_option_id === undefined
            ? {}
            : { responded_option_id: input.responded_option_id }),
        },
      } as ReconciliationEntry);

      const written = await appendReconciliationEntries(paths, [candidate]);
      const after = await readReconciliationJournal(paths);

      return {
        runId: input.runId,
        outcome: 'RECORDED' as const,
        entry: written[0] as ProposalResponseRecordedEntry,
        reconciliation_revision: after.revision,
        provider_effect: RECONCILIATION_HUMAN_PROVIDER_EFFECT,
      };
    },
  );
}

/**
 * Les sortes de provenance qu'une référence oblige à résoudre.
 *
 * Publié pour être **confronté aux tests**, jamais cru sur parole : la liste dit
 * où une résolution a réellement lieu, et le motif de son absence ailleurs est
 * écrit dans `assertProvenanceResolves`.
 */
export const PROVENANCE_KINDS_RESOLVED_AGAINST_SNAPSHOT: readonly Provenance['kind'][] = [
  'CONTROVERSY_AUTHORITY',
];

/** Réexport de commodité pour les preuves de forme. Aucune logique propre. */
export { isControversyEntryId, isLegacyDecisionId };
