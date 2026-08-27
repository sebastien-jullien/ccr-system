/**
 * Erreurs CCR.
 *
 * Règle de conception (spécification V1, §12) : l'incertitude ne doit jamais
 * devenir un succès. Chaque situation ambiguë reçoit un code explicite plutôt
 * qu'une valeur par défaut silencieuse.
 *
 * Le tableau de codes grandit slice par slice ; il n'anticipe pas les besoins
 * des versions ultérieures.
 */

export type CcrErrorCode =
  // --- Couche process ---
  | 'INVALID_ARGUMENT'
  | 'EXECUTABLE_NOT_FOUND'
  | 'PROCESS_LAUNCH_FAILED'
  // --- Couche adapter ---
  /** Aucun exécutable lançable n'a pu être déterminé pour l'agent. */
  | 'AGENT_EXECUTABLE_UNRESOLVED'
  /** Le délai a expiré : aucune réponse n'est inventée. */
  | 'AGENT_TIMEOUT'
  /** La CLI s'est terminée avec un code non nul. */
  | 'AGENT_EXIT_NONZERO'
  /** La sortie structurée n'est pas analysable (JSON/JSONL invalide). */
  | 'AGENT_OUTPUT_UNPARSABLE'
  /** La sortie est syntaxiquement valide mais le tour n'est pas terminé. */
  | 'AGENT_OUTPUT_INCOMPLETE'
  /** L'identifiant de session native est absent de la sortie. */
  | 'AGENT_SESSION_ID_MISSING'
  /** Le tour n'a produit aucun message final exploitable. */
  | 'AGENT_RESULT_MISSING'
  /** La session reprise n'est pas celle demandée. */
  | 'AGENT_SESSION_MISMATCH'
  /** L'agent a lui-même signalé un échec de tour. */
  | 'AGENT_REPORTED_ERROR'
  // --- Couche persistance ---
  /** Transition interdite par la machine d'état V1. */
  | 'ILLEGAL_STATE_TRANSITION'
  | 'RUN_NOT_FOUND'
  | 'RUN_ALREADY_EXISTS'
  | 'MANIFEST_INVALID'
  | 'STATE_INVALID'
  /** Journal append-only illisible (ligne corrompue, identifiant incohérent). */
  | 'JOURNAL_INVALID'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  /** Un run rechargé porte une ambiguïté non résolue : reprise interdite. */
  | 'RECOVERY_REQUIRED'
  /** L'agent visé n'a pas encore de session native dans ce run. */
  | 'SESSION_MISSING'
  /** Aucun run exploitable n'a pu être déterminé. */
  | 'NO_ACTIVE_RUN'
  // --- Passage de témoin ---
  /** Aucune réponse d'agent transférable dans le journal CCR. */
  | 'NO_TRANSFERABLE_SOURCE'
  /** La dernière réponse d'agent a déjà servi de source à un passage de témoin. */
  | 'SOURCE_ALREADY_TRANSFERRED'
  /** Garde-fou CCR : transfert anormalement volumineux (§27). */
  | 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER'
  /** L'automatisation ne détient pas le contrôle du run. */
  | 'AUTOMATION_NOT_IN_CONTROL'
  /**
   * La dernière réponse du slot précède une interaction native externe.
   *
   * Distinct de `SOURCE_NOT_REPLAYABLE` : la source n'a été ni consommée ni
   * quarantainée. Elle est simplement **périmée** — la session native a pu
   * avancer hors du journal CCR, et CCR ne prétend pas savoir où elle en est.
   */
  | 'SOURCE_STALE_AFTER_HANDOFF'
  // --- Contrôle humain ---
  /** Le run ne peut pas être suspendu proprement dans son état actuel. */
  | 'RUN_NOT_PAUSABLE'
  /** Le run ne peut pas être rendu à l'automatisation dans son état actuel. */
  | 'RUN_NOT_RESUMABLE'
  /** Le handoff interactif n'est pas autorisé dans l'état actuel. */
  | 'HANDOFF_NOT_ALLOWED'
  /**
   * Des faits canoniques se contredisent : le run ne peut pas gagner en
   * autonomie.
   *
   * Distinct de `RECOVERY_REQUIRED`, et délibérément : celui-ci annonce une
   * reprise possible, et oriente vers `ccr recover`. Un `EVIDENCE_CONFLICT`
   * n'offre **aucun** geste — CCR ne choisit pas laquelle de deux affirmations
   * est vraie. Réutiliser `RECOVERY_REQUIRED` enverrait l'humain vers une
   * commande qui ne lui proposerait rien.
   */
  | 'RECOVERY_EVIDENCE_CONFLICT'
  /**
   * La commande existe, mais pas pour la génération du run visé.
   *
   * Ni un schéma non supporté — CCR lit parfaitement ce run —, ni une garde
   * métier : c'est une limite de surface, déclarée telle quelle plutôt que
   * déguisée en erreur de lecture.
   */
  | 'COMMAND_UNSUPPORTED_FOR_GENERATION'
  /**
   * L'engagement d'invocation n'a pas pu être persisté (CCR V2.2).
   *
   * Panne de **CCR**, jamais de l'expert : aucun fournisseur n'a été appelé, et
   * aucun `AGENT_*` ni `PROCESS_*` ne doit être détourné pour la décrire — ils
   * attribueraient à la session cible une défaillance de stockage local.
   *
   * Sa conséquence est gelée par le contrat V2.2 :
   * `INVOCATION_APPEND_FAILURE_BLOCKS_PROVIDER = YES`.
   */
  | 'INVOCATION_LEDGER_WRITE_FAILED'
  /**
   * `invocation-policy.json` illisible ou non conforme (`V2.2-IMP-07`).
   *
   * Une politique **présente mais invalide** n'est jamais requalifiée en
   * politique absente : l'absence du document est un fait exact — aucune
   * politique de quota CCR — tandis qu'un document corrompu est un problème de
   * gouvernance, et il se dit.
   */
  | 'INVOCATION_POLICY_INVALID'
  /**
   * Écriture de `invocation-policy.json` impossible (`V2.2-IMP-07`).
   *
   * Couvre aussi le refus d'écraser une politique déjà établie : en V0.1 une
   * politique est stable une fois posée, et aucune surface ne la modifie.
   */
  | 'INVOCATION_POLICY_WRITE_FAILED'
  /**
   * La politique de quota du run refuse une **nouvelle** invocation
   * (`V2.2-IMP-08`).
   *
   * Signifie exactement : la politique CCR per-run a refusé un nouvel
   * engagement model-producing. Jamais un quota fournisseur, une limite de
   * débit, un incident de facturation, une panne d'agent, de processus ou de
   * stockage — CCR ne sait rien de ces choses-là.
   *
   * Le refus ne porte aucun `invocation_id` : c'est le sens même du refus,
   * aucune invocation n'a été créée.
   */
  | 'CCR_INVOCATION_QUOTA_EXCEEDED'
  /**
   * Catalogue tarifaire présent mais non conforme (`V2.2-IMP-11`).
   *
   * Un catalogue corrompu n'est jamais requalifié en « aucun catalogue » :
   * l'absence est un état normal — CCR n'embarque aucun tarif — tandis qu'un
   * document invalide est un problème de gouvernance, et il se dit.
   */
  | 'PRICING_CATALOG_INVALID'
  /**
   * Catalogue tarifaire désigné mais illisible (`V2.2-IMP-11`).
   *
   * Couvre le sélecteur qui cite une version absente : demander une version
   * précise et ne pas la trouver n'est pas la même chose que n'en demander
   * aucune.
   */
  | 'PRICING_CATALOG_READ_FAILED'
  // --- Verrouillage et reprise ---
  /** Un autre processus CCR vivant détient déjà ce run. */
  | 'RUN_ALREADY_LOCKED'
  /** Un verrou subsiste alors que son propriétaire a disparu. */
  | 'STALE_LOCK'
  /** Le fichier de verrou est illisible ou incomplet. */
  | 'LOCK_INVALID'
  /**
   * La publication atomique du verrou a échoué, et aucun verrou n'a été posé.
   *
   * CCR ne publie un verrou de run que d'un seul geste — un lien dur, exclusif
   * et atomique. Quand ce geste échoue pour une raison autre que « le nom
   * existe déjà », il n'existe aucune seconde façon d'y parvenir sans rouvrir
   * la fenêtre pendant laquelle un verrou vide est lisible. L'acquisition
   * échoue donc, franchement, plutôt que d'y retomber.
   */
  | 'LOCK_PUBLICATION_FAILED'
  // --- Configuration locale (V1.1, §21, §22) ---
  /** Document de configuration présent mais impossible à lire (I/O). */
  | 'CONFIG_READ_FAILED'
  /** Document de configuration lisible mais invalide, mal typé ou incomplet. */
  | 'CONFIG_INVALID'
  /** `schema_version` de configuration inconnue de cette version de CCR. */
  | 'CONFIG_SCHEMA_UNSUPPORTED'
  /** L'écriture a échoué : la configuration précédente reste canonique. */
  | 'CONFIG_WRITE_FAILED'
  /** Une autre écriture de configuration est engagée : conflit explicite. */
  | 'CONFIG_BUSY'
  // --- Connexion fournisseur (V1.1, §8.2, §9.3, §22) ---
  /** La connexion officielle n'a pas abouti : le probe qui suit fait foi. */
  | 'AUTH_LOGIN_FAILED'
  /** Opération exigeant un terminal humain attaché aux deux flux. */
  | 'INTERACTIVE_TTY_REQUIRED'
  // --- Preflight de `ccr start` (V1.1, §17) ---
  /** Une CLI fournisseur requise est absente : aucun run n'est alloué. */
  | 'AGENT_CLI_NOT_FOUND'
  /** Prérequis d'authentification certain, sans remédiation réussie. */
  | 'AUTH_REQUIRED'
  // --- Initialisation native V2.1 (§10.3) ---
  /**
   * Deux slots d'un même run ont obtenu la même identité native.
   *
   * L'identité d'une continuité est le couple `(provider, session_id)`. Deux
   * experts partageant un moteur doivent donc obtenir deux sessions distinctes.
   * Quand le second démarrage rend l'identifiant du premier, CCR n'a aucun
   * moyen de savoir laquelle des deux conversations il vient d'ouvrir :
   * l'échec est fermé, sans retry et sans attribution.
   */
  | 'SESSION_ID_COLLISION'
  /**
   * La source attendue a été mise en quarantaine et ne peut plus être rejouée.
   *
   * Distinct de `SOURCE_ALREADY_TRANSFERRED` : une source transférée a produit
   * un round abouti, une source en quarantaine a été engagée dans un transfert
   * dont CCR ignore l'issue. La rejouer présenterait un appel peut-être
   * consommé comme s'il n'avait pas eu lieu.
   */
  | 'SOURCE_NOT_REPLAYABLE'
  // --- Alias de fournisseur (V0.3, §17.1, §18.1, §19) ---
  /**
   * Aucun expert du run n'emploie ce fournisseur.
   *
   * Distinct de `SESSION_MISSING` : là, l'expert existe et sa session manque ;
   * ici, l'alias ne désigne personne.
   */
  | 'PROVIDER_ALIAS_NOT_BOUND'
  /**
   * Les deux experts emploient ce fournisseur : l'alias ne désigne personne
   * en particulier.
   *
   * Aucune préférence implicite n'est appliquée. C'est l'alias qui cède, jamais
   * la configuration : les deux slots restent adressables par leur nom.
   */
  | 'AMBIGUOUS_PROVIDER_ALIAS'
  // --- Lecture cohérente et vue périmée (V2, §10, §11) ---
  /** Aucune fenêtre de lecture cohérente n'a pu être établie dans le budget. */
  | 'SNAPSHOT_UNSTABLE'
  /** L'action a été demandée sur une vue qui n'est plus la vue courante. */
  | 'STALE_REVISION'
  /** Les faits ont changé sous le verrou : la capacité demandée n'est plus celle du plan. */
  | 'RECOVERY_CAPABILITY_STALE'
  /** Le verrou présent n'est plus exactement celui que l'humain a observé. */
  | 'RECOVERY_LOCK_CHANGED'
  /** Vivant, étranger, indéterminé ou absent : aucune levée n'est sûre. */
  | 'RECOVERY_LOCK_NOT_CLEARABLE'
  // --- Serveur cockpit local (V2, §15.3, §15.4, §32) ---
  /**
   * L'identité canonique du CCR data root n'a pas pu être établie.
   *
   * Fail-closed : l'unicité du cockpit repose sur cette identité. Une résolution
   * qui échoue ne prouve pas que la forme lexicale désigne le bon stockage —
   * elle prouve seulement qu'on ne sait pas. Rien n'est donc démarré, et rien
   * n'est supprimé.
   */
  | 'CCR_DATA_ROOT_UNRESOLVABLE'
  /** Un serveur cockpit vivant détient déjà ce data root. */
  | 'COCKPIT_ALREADY_RUNNING'
  /** `server.lock` local dont le propriétaire a disparu. Jamais supprimé seul. */
  | 'COCKPIT_SERVER_LOCK_STALE'
  /** `server.lock` posé depuis un autre hôte : statut indéterminable ici. */
  | 'COCKPIT_SERVER_LOCK_FOREIGN'
  /** `server.lock` présent mais illisible ou mal formé. */
  | 'COCKPIT_SERVER_LOCK_INDETERMINATE'
  /** Levée demandée sur un verrou absent. */
  | 'COCKPIT_SERVER_LOCK_NOT_FOUND'
  /** Levée demandée avec une identité qui n'est pas celle du verrou observé. */
  | 'COCKPIT_SERVER_LOCK_IDENTITY_MISMATCH'
  /** Le verrou a changé entre l'observation et la suppression : aucun effet. */
  | 'COCKPIT_SERVER_LOCK_CHANGED'
  /** L'ouverture du socket loopback a échoué. Aucun repli n'est tenté. */
  | 'COCKPIT_BIND_FAILED'
  // --- Mutations courtes et idempotence durable (V2, §19, §23) ---
  /** Même clé d'idempotence, intention différente : refus, aucun effet. */
  | 'IDEMPOTENCY_KEY_REUSED'
  /** Aucun reçu d'opération ne porte cet identifiant. */
  | 'OPERATION_NOT_FOUND'
  /**
   * Reçu d'idempotence illisible.
   *
   * Fail-closed : le traiter comme absent rouvrirait le rejeu que ce store
   * ferme. Refus explicite, aucun effet métier.
   */
  | 'OPERATION_STORE_CORRUPT'
  /** En-tête `Origin` absent, `null` ou différent de l'origine canonique. */
  | 'INVALID_ORIGIN'
  /** Corps de requête dépassant la borne, jamais tronqué silencieusement. */
  | 'PAYLOAD_TOO_LARGE'
  /** Type de contenu inattendu sur une mutation : aucun parser multi-format. */
  | 'UNSUPPORTED_MEDIA_TYPE'
  // --- Operations longues (V2, S20) ---
  /**
   * Les deux creneaux d operations agent sont occupes.
   *
   * Refus immediat, sans file d attente : faire patienter reviendrait a faire
   * dependre une reponse d un fournisseur qui peut ne jamais repondre.
   */
  | 'COCKPIT_BUSY'
  /** Le cockpit s arrete : il n admet plus de nouvelle operation longue. */
  | 'COCKPIT_SHUTTING_DOWN'
  /**
   * Contexte de proposition assistee au-dela de la borne autorisee (V5.1).
   *
   * Refus PRE-DISPATCH : constate avant le quota, avant l invocation_id, avant
   * le ledger et avant tout adaptateur. Aucune troncature, aucun resume, aucun
   * fournisseur atteint. Il n est donc AUCUNE des six issues du §38.4, qui
   * decrivent ce qui advient une fois un engagement pris.
   */
  | 'PROPOSAL_CONTEXT_TOO_LARGE';

export interface CcrErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * Erreur applicative CCR porteuse d'un code stable.
 *
 * Le `message` est destiné à l'humain ; le `code` est destiné au programme.
 * `details` ne doit jamais contenir de secret ni d'environnement complet.
 */
export class CcrError extends Error {
  readonly code: CcrErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CcrErrorCode, message: string, options: CcrErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CcrError';
    this.code = code;
    this.details = options.details ?? {};
  }
}

export function isCcrError(value: unknown): value is CcrError {
  return value instanceof CcrError;
}
