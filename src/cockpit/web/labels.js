/**
 * Libellés — traduction **fermée** de codes déjà décidés par le cœur.
 *
 * C'est la seule transformation métier autorisée au navigateur : donner un
 * texte français à une valeur qu'il a reçue. Aucune table ci-dessous ne combine
 * deux faits pour en déduire un troisième ; toutes sont des dictionnaires plats.
 *
 * La distinction n'est pas cosmétique. `switch (liveness) → libellé` affiche une
 * décision du cœur ; `if (state === X && pending) → « reprise nécessaire »`
 * fabriquerait une décision que le navigateur n'a pas les faits pour prendre.
 * Seule la première forme existe ici.
 *
 * Un code inconnu est rendu **tel quel** plutôt que masqué : mieux vaut un
 * identifiant brut affiché qu'une information silencieusement perdue.
 */

const STATES = {
  READY: 'Prêt',
  RUNNING: 'En cours',
  WAITING_AGENT: 'Tour agent en cours',
  WAITING_HUMAN: 'Attente humaine',
  PAUSED: 'Suspendu',
  RECOVERY_REQUIRED: 'Reprise requise',
  FAILED_INITIALIZATION: 'Initialisation échouée',
  FAILED: 'Échoué',
  CLOSED: 'Clos',
};

const CONTROL = {
  AUTOMATION: 'mode automatisé',
  HUMAN: 'Humain',
};

const ATTENTION = {
  NONE: 'Rien à signaler',
  HUMAN_INPUT: 'Intervention humaine',
  RECOVERY: 'Reprise requise',
  INITIALIZATION: 'Initialisation',
  FAILED: 'Échec',
};

const LIVENESS = {
  NONE: 'Aucun travail en cours',
  OPERATION_IN_FLIGHT: 'Opération en cours',
  ORPHAN_LOCK: 'Verrou orphelin',
  ABANDONED_OPERATION: 'Opération abandonnée',
  EXTERNAL_ACTIVITY: 'Activité externe',
  AMBIGUOUS: 'Situation ambiguë',
  // Verdict honnête du cœur : ni erreur, ni reprise, ni activité.
  UNDETERMINED: 'État opérationnel indéterminé avec les preuves disponibles',
};

const LIVENESS_BASIS = {
  NO_PENDING_WORK: 'aucune opération persistée',
  HOST_OPERATION_ACTIVE: 'opération de ce cockpit en cours',
  LOCK_ALIVE_OTHER_PROCESS: 'verrou détenu par un autre processus',
  LOCK_ABSENT_WITH_PENDING: 'opération persistée sans verrou',
  LOCK_STALE_WITH_PENDING: 'verrou périmé avec opération persistée',
  LOCK_FOREIGN: 'verrou posé depuis un autre hôte',
  NO_HOST_REGISTRY: 'aucun registre pour trancher',
  ORPHAN_LOCK_OBSERVED: 'verrou de ce processus non revendiqué',
  PENDING_NOT_COVERED_BY_LOCK: "le verrou observé ne couvre pas l'opération persistée",
};

const LOCK_OBSERVATION = {
  NO_LOCK: 'aucun verrou',
  ACTIVE_HOST_OPERATION: 'opération de ce cockpit',
  ACTIVE_EXTERNAL_LOCK: 'verrou externe vivant',
  ORPHAN_SAME_PID_LOCK: 'verrou orphelin de ce processus',
  STALE_LOCK: 'verrou périmé',
  FOREIGN_LOCK: 'verrou étranger',
  INDETERMINATE_LOCK: 'verrou indéterminable',
};

const CAPABILITIES = {
  STEP: 'Passage de témoin',
  SEND: 'Message humain',
  PAUSE: 'Suspendre',
  RESUME: 'Rendre à l’automatisation',
  DECIDE: 'Enregistrer une décision',
  STOP: 'Clore le run',
  // V5.1 — gestes de réconciliation. Nommés par ce qu'ils FONT, jamais par un
  // effet qu'ils n'ont pas : accepter enregistre une réponse, pas une adoption.
  // V5.1 — gestes V3 et V4, humains l'un comme l'autre.
  CONTROVERSY_RECORD: 'Enregistrement d’une controverse',
  EVIDENCE_REGISTER_MATERIAL: 'Retenue d’un matériau',
  EVIDENCE_ADDUCE_MATERIAL: 'Versement d’un matériau au débat',
  RECONCILE_PROPOSE: 'Demande de proposition',
  RECONCILE_ACCEPT: 'Réponse — acceptation',
  RECONCILE_REJECT: 'Réponse — rejet',
  RECONCILE_MODIFIES: 'Acte humain — modifie la proposition',
  RECONCILE_REPLACES: 'Acte humain — remplace la proposition',
};

const CAPABILITY_EFFECTS = {
  TRANSFER_ONE_TURN: 'transfère un tour vers l’autre agent',
  SEND_HUMAN_MESSAGE: 'transmet un message humain à un agent',
  SUSPEND_AUTOMATION: 'suspend l’automatisation',
  RETURN_TO_AUTOMATION: 'rend le contrôle à l’automatisation',
  RECORD_HUMAN_DECISION: 'enregistre une décision humaine',
  CLOSE_RUN: 'clôt le run',
};

const REASONS = {
  AUTOMATION_NOT_IN_CONTROL: 'l’automatisation ne détient pas le contrôle',
  RUN_NOT_PAUSABLE: 'le run n’est pas suspendable dans cet état',
  RUN_NOT_RESUMABLE: 'le run n’est pas reprenable dans cet état',
  HANDOFF_NOT_ALLOWED: 'le handoff n’est pas autorisé dans cet état',
  SESSION_MISSING: 'aucune session native pour cet agent',
  NO_TRANSFERABLE_SOURCE: 'aucune réponse d’agent transférable',
  SOURCE_ALREADY_TRANSFERRED: 'la dernière réponse a déjà été transférée',
  PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER: 'transfert trop volumineux pour l’automatisation',
  RECOVERY_REQUIRED: 'le run porte une ambiguïté non résolue',
  // Motifs natifs V2.1 rendus visibles par les capacités de 2D.
  AMBIGUOUS_PROVIDER_ALIAS: 'les deux experts emploient ce moteur : l’alias ne désigne personne',
  PROVIDER_ALIAS_NOT_BOUND: 'aucun expert n’emploie ce moteur',
  SOURCE_NOT_REPLAYABLE: 'la réponse a été mise en quarantaine et n’est pas rejouée',
  SOURCE_STALE_AFTER_HANDOFF: 'la position connue précède une interaction native externe',
  RECOVERY_EVIDENCE_CONFLICT: 'des faits canoniques se contredisent',
  COMMAND_UNSUPPORTED_FOR_GENERATION: 'action non portée pour la génération de ce run',
  RUN_CLOSED: 'le run est clos',
  ILLEGAL_STATE_TRANSITION: 'transition interdite dans cet état',
  STATE_NOT_ELIGIBLE: 'état non éligible',
  // Motifs fermés portés par les marqueurs du journal natif (V2.1-IMP-19).
  IN_FLIGHT_UNCERTAIN: 'issue inconnue, acquittée par un humain',
  PRE_PROVIDER_ABORTED: 'abandonné avant tout appel fournisseur',
  PRE_INTERACTIVE_ABORTED: 'abandonné avant tout terminal',
};

/**
 * État déjà atteint, dit en clair.
 *
 * Employé lorsque la capacité est `allowed` ET `noop` : le geste reste offert,
 * mais l'état demandé est déjà celui du run. Dire « disponible » et « sans
 * effet » côte à côte se lisait comme une contradiction.
 */
const CAPABILITIES_SETTLED = {
  RESUME: 'Mode automatisé déjà actif',
  PAUSE: 'Automatisation déjà suspendue',
  STOP: 'Run déjà clos',
  STEP: 'Aucun transfert en attente',
  SEND: 'Aucun envoi en attente',
};

const RECOVERY_CAPABILITIES = {
  RECOVERY_FINALIZE_JOURNALED_RESPONSE: 'Finaliser une réponse déjà journalisée',
  RECOVERY_CONTINUE_INITIALIZATION: 'Poursuivre une initialisation partielle',
  RECOVERY_MATERIALIZE_AMBIGUITY: 'Matérialiser l’ambiguïté',
  RECOVERY_ACKNOWLEDGE_AMBIGUITY: 'Acquitter l’ambiguïté',
  RECOVERY_CLEAR_STALE_LOCK: 'Lever un verrou périmé',
};

const MISSING_PRIMITIVE_REASONS = {
  NOT_SELECTABLE_IN_V1: 'non sélectionnable seule avec les primitives V1',
};

const UNREADABLE = {
  MANIFEST_INVALID: 'manifeste illisible',
  STATE_INVALID: 'état illisible',
  RUN_NOT_FOUND: 'run introuvable',
  UNREADABLE: 'run illisible',
};

const EVENT_TYPES = {
  run_created: 'création du run',
  human_message: 'message humain',
  assistant_response: 'réponse d’agent',
  transfer: 'passage de témoin',
  decision_recorded: 'décision enregistrée',
  state_changed: 'changement d’état',
  handoff_opened: 'handoff ouvert',
  handoff_closed: 'handoff fermé',
  run_closed: 'run clos',
  // Types du journal canonique rendus lisibles par la chronologie native
  // (V2.1-IMP-19). Ils existaient déjà sur disque : seule leur lecture est
  // nouvelle.
  session_created: 'session créée',
  prompt_sent: 'demande transmise',
  round_started: 'round ouvert',
  round_completed: 'passage de témoin',
  control_changed: 'changement de contrôle',
  human_handoff_started: 'handoff ouvert',
  human_handoff_finished: 'handoff fermé',
  process_failed: 'échec de processus',
  run_paused: 'run suspendu',
  run_resumed: 'run repris',
  run_completed: 'run terminé',
  runtime_config_changed: 'snapshot runtime modifié',
  // Marqueurs natifs : trois issues sans réponse, et leurs clôtures.
  transfer_blocked: 'transfert refusé avant appel',
  transfer_aborted_before_provider: 'transfert abandonné avant appel',
  transfer_uncertainty_acknowledged: 'incertitude de transfert acquittée',
  send_aborted_before_provider: 'envoi abandonné avant appel',
  send_uncertainty_acknowledged: 'incertitude d’envoi acquittée',
  handoff_aborted_before_interactive: 'handoff abandonné avant terminal',
  handoff_uncertainty_acknowledged: 'incertitude de handoff acquittée',
};

const ACTORS = {
  system: 'système',
  human: 'humain',
  claude: 'Claude',
  codex: 'Codex',
  evidence: 'évidence',
  // Catégorie native, jamais une identité : qui a agi se lit sur le slot.
  expert: 'expert',
};

/**
 * Vocabulaire natif V2.1 (Slice 2G).
 *
 * Un ExpertSlot nomme un **role** dans la controverse ; le fournisseur reste un
 * attribut technique, libelle par `ACTORS`. Les deux ne se traduisent jamais
 * l'un en l'autre : deux experts peuvent partager un moteur.
 */
const GENERATIONS = {
  LEGACY_V2_EXECUTION: 'historique',
  NATIVE_V21_EXECUTION: 'natif V2.1',
};

const EXPERT_SLOTS = {
  author: 'Auteur',
  challenger: 'Challenger',
};

const ALIAS_RESOLUTIONS = {
  UNIQUE: 'un expert',
  AMBIGUOUS: 'ambigu — les deux experts',
  NOT_BOUND: 'aucun expert',
};

const STEP_SOURCES = {
  READY: 'transférable',
  MISSING: 'aucune réponse transférable',
  ALREADY_TRANSFERRED: 'déjà transférée',
  NON_REPLAYABLE: 'en quarantaine',
  STALE_AFTER_HANDOFF: 'périmée après une interaction native',
  PAYLOAD_TOO_LARGE: 'trop volumineuse',
  BLOCKED: 'indisponible',
};

const RECOVERY_DOMAINS = {
  initialization: 'Initialisation',
  step: 'Transfert',
  send: 'Envoi',
  handoff: 'Handoff',
};

const RECOVERY_STATUSES = {
  NONE: 'aucune reprise nécessaire',
  CLEAN_MISSING: 'session manquante',
  RECONCILABLE_DURABLE_RESPONSE: 'réponse durable à réconcilier',
  LINKED_NEEDS_FINALIZATION: 'liaison à finaliser',
  COMPLETE_NEEDS_FINALIZATION: 'initialisation à finaliser',
  IN_FLIGHT_UNCERTAIN: 'issue inconnue',
  EVIDENCE_CONFLICT: 'faits contradictoires',
  PRE_PROVIDER_ABORTED: 'abandonné avant tout appel',
  PRE_INTERACTIVE_ABORTED: 'abandonné avant tout terminal',
  RESPONSE_NEEDS_FINALIZATION: 'réponse à finaliser',
  FAILURE_NEEDS_FINALIZATION: 'échec à finaliser',
  ROUND_COMPLETED_NEEDS_COMMIT: 'round à commiter',
  RESOLUTION_NEEDS_COMMIT: 'clôture à commiter',
  FINISHED_NEEDS_COMMIT: 'fin à commiter',
};

const RECOVERY_ACTIONS = {
  CONTINUE: 'Continuer l’initialisation',
  FINALIZE: 'Finaliser',
  ACKNOWLEDGE_UNCERTAINTY: 'Acquitter l’incertitude',
  ABORT_BEFORE_PROVIDER: 'Clore avant tout appel',
  ABORT_BEFORE_INTERACTIVE: 'Clore avant tout terminal',
};

const DOCTOR_STATUS = {
  READY: 'Prêt',
  ATTENTION: 'Attention',
  BLOCKED: 'Bloqué',
};

const DOCTOR_SEVERITY = {
  ATTENTION: 'Attention',
  BLOCKER: 'Bloquant',
};

const DOCTOR_FINDINGS = {
  CLAUDE_CLI_MISSING: 'la CLI Claude Code est introuvable',
  CLAUDE_AUTH_REQUIRED: 'Claude Code demande une connexion',
  CLAUDE_AUTH_UNKNOWN: 'statut d’authentification Claude inconnu',
  CLAUDE_VERSION_UNKNOWN: 'version de Claude Code inconnue',
  CODEX_CLI_MISSING: 'la CLI Codex est introuvable',
  CODEX_AUTH_NOT_REPORTED: 'Codex ne rapporte pas son statut d’authentification',
  CODEX_AUTH_UNKNOWN: 'statut d’authentification Codex inconnu',
  CODEX_VERSION_UNKNOWN: 'version de Codex inconnue',
  CONFIG_INVALID: 'configuration locale invalide',
  CONFIG_SCHEMA_UNSUPPORTED: 'schéma de configuration inconnu',
  CONFIG_READ_FAILED: 'configuration locale illisible',
  LEGACY_ENV_OVERRIDE: 'une variable d’environnement héritée impose une valeur',
  LEGACY_ENV_NON_CANONICAL: 'variable héritée présente avec une valeur non canonique',
  CONFIG_LOCK_HELD: 'un verrou de configuration est détenu',
  CONFIG_LOCK_STALE: 'un verrou de configuration est périmé',
  CONFIG_LOCK_FOREIGN: 'un verrou de configuration vient d’un autre hôte',
  CONFIG_LOCK_UNREADABLE: 'verrou de configuration illisible',
  RUNTIME_CONFIG_UNPINNED: 'ce run n’a pas de snapshot runtime (legacy)',
  RUNTIME_CONFIG_INVALID: 'snapshot runtime invalide',
  CLAUDE_VERSION_CHANGED: 'la version de Claude a changé depuis le démarrage du run',
  CODEX_VERSION_CHANGED: 'la version de Codex a changé depuis le démarrage du run',
  RUN_CONFIG_DIFFERS_FROM_GLOBAL: 'la configuration du run diffère de la configuration globale',
};

const CONFIG_SOURCES = {
  'legacy-env': 'variable d’environnement héritée',
  config: 'fichier de configuration',
  default: 'valeur par défaut',
};

/**
 * Messages d'erreur publics.
 *
 * Fermés et rédigés ici : aucun message serveur n'est réaffiché tel quel, et
 * aucun objet d'erreur n'est rendu. Un code non listé reçoit le message
 * générique — jamais le contenu brut de la réponse.
 */
const ERRORS = {
  // Le run réel a montré un 401 muet après un redémarrage du cockpit : la page
  // gardait une session périmée, et le geste ne disait rien. Le message nomme
  // les trois faits utiles — l'état, le remède, et surtout ce que CCR NE fait
  // pas de lui-même.
  UNAUTHENTICATED:
    'Votre session cockpit a expiré. Rechargez l’interface avant de réessayer. '
    + 'La demande n’est pas relancée automatiquement.',
  COMMAND_UNSUPPORTED_FOR_GENERATION: 'Cette action n’est pas portée pour la génération de ce run.',
  RECOVERY_EVIDENCE_CONFLICT: 'Des faits canoniques de ce run se contredisent : CCR ne choisit pas lequel est vrai.',
  AMBIGUOUS_PROVIDER_ALIAS: 'Les deux experts emploient ce moteur : désignez « Auteur » ou « Challenger ».',
  PROVIDER_ALIAS_NOT_BOUND: 'Aucun expert de ce run n’emploie ce moteur.',
  INVALID_HOST: 'Origine refusée par le cockpit.',
  NOT_FOUND: 'Ressource introuvable.',
  RUN_NOT_FOUND: 'Ce run n’existe pas (ou plus).',
  STALE_REVISION: 'La vue a changé depuis son chargement — rechargez-la.',
  RUN_ALREADY_LOCKED: 'Une autre opération utilise actuellement ce run.',
  STALE_LOCK: 'Ce run porte un verrou dont le propriétaire a disparu.',
  RECOVERY_REQUIRED: 'Ce run porte une ambiguïté non résolue.',
  MANIFEST_INVALID: 'Le manifeste de ce run n’est pas exploitable — une réparation humaine est nécessaire.',
  STATE_INVALID: 'L’état de ce run n’est pas exploitable — une réparation humaine est nécessaire.',
  JOURNAL_INVALID: 'Le journal de ce run n’est pas exploitable — une réparation humaine est nécessaire.',
  SCHEMA_VERSION_UNSUPPORTED: 'Ce run utilise un schéma que cette version de CCR ne sait pas lire.',
  SNAPSHOT_UNSTABLE: 'Le run est en cours de modification — réessayez dans un instant.',
  INVALID_ARGUMENT: 'Requête invalide.',
  // Le cockpit a offert un geste qu'il n'a pas su composer depuis la vue reçue.
  // Rien n'a été envoyé : le message dit l'échec plutôt que de laisser un
  // bouton sans effet.
  CLIENT_CANNOT_COMPOSE:
    'Le cockpit n’a pas su composer cette action depuis la vue courante — rien n’a été envoyé. '
    + 'Rechargez le run ; si le geste reste sans effet, signalez-le.',
  INVALID_ORIGIN: 'Origine de la requête refusée par le cockpit.',
  AUTH_REQUIRED:
    'L authentification d un agent doit être préparée dans un terminal. Exécutez : ccr setup',
  AGENT_CLI_NOT_FOUND: 'Une CLI d agent est absente de ce poste. Installez-la, puis réessayez.',
  COCKPIT_BUSY:
    'Le cockpit exécute déjà deux opérations agent. Aucune file d attente : reprenez plus tard.',
  COCKPIT_SHUTTING_DOWN: 'Le cockpit s arrête : aucune nouvelle opération agent.',
  // Refus antérieur à tout engagement : aucun moteur n'a été appelé, et rien
  // n'a été résumé ni tronqué pour faire entrer le contexte de force.
  PROPOSAL_CONTEXT_TOO_LARGE:
    'Le contexte de la proposition dépasse la taille autorisée — aucun moteur n’a été appelé, '
    + 'et rien n’a été raccourci. Réduisez le périmètre soumis.',
  AGENT_TIMEOUT: 'L agent n a pas répondu dans le délai imparti.',
  AGENT_EXIT_NONZERO: 'La CLI de l agent s est terminée en erreur.',
  AGENT_OUTPUT_UNPARSABLE: 'La sortie de l agent n est pas analysable.',
  AGENT_OUTPUT_INCOMPLETE: 'Le tour de l agent ne s est pas terminé.',
  AGENT_RESULT_MISSING: 'Le tour n a produit aucun message exploitable.',
  AGENT_REPORTED_ERROR: 'L agent a lui-même signalé un échec de tour.',
  NO_TRANSFERABLE_SOURCE: 'Aucune réponse d agent n est transférable dans ce run.',
  SOURCE_ALREADY_TRANSFERRED: 'La dernière réponse a déjà servi de source à un passage de témoin.',
  PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER:
    'Le transfert dépasse le garde-fou automatique : c est à vous de décider de la suite.',
  IDEMPOTENCY_KEY_REUSED:
    'Cette tentative a déjà servi pour une autre action — anomalie du cockpit, pas du run.',
  OPERATION_NOT_FOUND: 'Cette opération est inconnue du cockpit.',
  OPERATION_STORE_CORRUPT:
    'Le journal d’idempotence est illisible — aucune action effectuée, et rien ne sera rejoué.',
  PAYLOAD_TOO_LARGE: 'Contenu trop volumineux.',
  UNSUPPORTED_MEDIA_TYPE: 'Format de requête non pris en charge.',
  RUN_NOT_PAUSABLE: 'Ce run ne peut pas être suspendu dans son état actuel.',
  RUN_NOT_RESUMABLE: 'Ce run ne peut pas être rendu à l’automatisation dans son état actuel.',
  AUTOMATION_NOT_IN_CONTROL: 'L’automatisation ne détient pas le contrôle de ce run.',
  ILLEGAL_STATE_TRANSITION: 'Cette transition est interdite dans l’état actuel.',
  METHOD_NOT_ALLOWED: 'Méthode non autorisée.',
  INTERNAL_ERROR: 'Erreur interne du cockpit.',
  NETWORK: 'Le cockpit local est injoignable.',
};

/** Codes pour lesquels un simple réessai est la bonne réponse. */
const RETRYABLE = new Set(['SNAPSHOT_UNSTABLE', 'NETWORK']);

/**
 * Vocabulaire V3 — controverses.
 *
 * Chaque table est plate, et chaque libellé reste **au niveau du fait**. Un
 * acte n'est jamais promu en conclusion : `CONTESTS` se dit « conteste », pas
 * « prouve faux » ; `WITHDRAWS` se dit « retire », pas « supprimé » ;
 * `REFORMULATES` se dit « reformule », pas « remplace définitivement ».
 *
 * Aucun statut n'existe, et aucun libellé n'en fabrique : il n'y a ni ouvert,
 * ni clos, ni résolu, ni gagnant.
 */
const CONTROVERSY_AVAILABILITY = {
  AVAILABLE: 'V3 disponible',
  NOT_AVAILABLE: 'V3 ne s’applique pas à cette génération de run',
};

/**
 * Ce qu'une adduction vise. Le contrat n'en admet qu'une sorte aujourd'hui, et
 * l'écran n'a aucune raison d'en afficher le jeton brut.
 */
const EVIDENCE_TARGET_KINDS = {
  CONTROVERSY_ENTRY: 'entrée de controverse',
};

const CONTROVERSY_ENTRY_KINDS = {
  CONTROVERSY_RECORDED: 'Controverse enregistrée',
  ASSERTION_RECORDED: 'Assertion',
  RELATION_RECORDED: 'Relation',
  NATURE_RECORDED: 'Nature',
  HUMAN_AUTHORITY_RECORDED: 'Autorité humaine',
};

/**
 * De qui vient la sémantique — jamais qui a demandé l'écriture.
 *
 * `HUMAN` ne devient pas la source dont il parle : c'est tout l'objet de
 * `docs/specs/controversy.md`, et l'affichage le porte.
 */
const SEMANTIC_ORIGINS = {
  SOURCE: 'Source — produit par l’expert',
  HUMAN: 'Humain',
  CCR: 'Inférence CCR',
};

const RELATION_ACTS = {
  CONTESTS: 'conteste',
  REFORMULATES: 'reformule',
  WITHDRAWS: 'retire',
};

/**
 * Actes d'autorité humaine.
 *
 * `CONFIRM_RELATION` n'est pas une vérité sur le fond, et `CONTEST_RELATION`
 * n'est pas une suppression rétroactive : les deux disent qui a répondu quoi.
 */
const AUTHORITY_ACTS = {
  ARBITRATION: 'arbitrage',
  CONFIRM_RELATION: 'confirme la relation inférée',
  CONTEST_RELATION: 'conteste la relation inférée',
};

const DERIVATION_METHODS = {
  DETERMINISTIC_LOCAL: 'dérivation locale déterministe',
  MODEL_ASSISTED: 'assistée par modèle',
};

/**
 * Motif d'un ancrage qui ne se résout pas.
 *
 * Une information de **vérifiabilité**, jamais un verdict : un ancrage non
 * résolu ne rend ni la controverse invalide, ni la relation fausse, ni la
 * source fabriquée.
 */
const UNRESOLVABLE_ANCHORS = {
  EVENT_NOT_FOUND: 'événement introuvable',
  CONTENT_UNAVAILABLE: 'contenu indisponible',
  OCCURRENCE_NOT_FOUND: 'occurrence introuvable',
};

/**
 * Disponibilité de l'Evidence Engine V4.
 *
 * `NOT_AVAILABLE` n'est **pas** un zéro : ce run appartient à une génération que
 * V4 ne regarde pas. Dire « aucun matériau » serait affirmer un regard qui n'a
 * pas eu lieu.
 */
const EVIDENCE_AVAILABILITY = {
  AVAILABLE: 'V4 disponible',
  NOT_AVAILABLE: 'V4 ne s’applique pas à cette génération de run',
};

/**
 * Forme d'une représentation de matériau.
 *
 * Trois formes, distinguées par **ce que CCR détient**, jamais par une qualité
 * de la pièce. Une référence externe n'est ni douteuse, ni faible, ni fausse :
 * CCR n'en détient simplement aucun contenu.
 */
const MATERIAL_FORMS = {
  RUN_EVENT: 'événement du run',
  INLINE_TEXT: 'texte détenu',
  EXTERNAL_REFERENCE: 'référence externe',
};

/** Qui a soumis le matériau. Une seule origine existe au premier palier. */
const MATERIAL_SUBMISSION_ORIGINS = {
  HUMAN: 'soumis par un humain',
};

/**
 * Orientation **déclarée** d'une adduction.
 *
 * Les trois libellés nomment un **acte**, jamais un résultat. « soutien
 * déclaré » ne dit pas que la cible est vraie, « objection déclarée » ne dit
 * pas qu'elle est fausse, et « aucune orientation déclarée » ne dit pas que le
 * matériau est sans pertinence — il dit que personne n'a pris position.
 */
const ORIENTATIONS = {
  NONE: 'aucune orientation déclarée',
  SUPPORTS: 'soutien déclaré',
  OBJECTS_TO: 'objection déclarée',
};

/**
 * Vérifiabilité **dérivée** d'un matériau.
 *
 * Elle décrit ce que CCR a pu constater, jamais une qualité de la pièce. Aucun
 * libellé ne dit « fiable », « suspect », « faible », « invalide » ni
 * « manquant » : ces mots n'existent nulle part dans V4.
 */
const MATERIAL_VERIFIABILITY = {
  HELD_AND_RESOLVABLE: 'représentation détenue, relue',
  HELD_BUT_UNRESOLVABLE: 'représentation attendue, non relue',
  NOT_OBSERVED_BY_CCR: 'non observé par CCR',
};

/**
 * Motifs V4 de non-résolution — union propre à V4.
 *
 * Distincte de celle des ancrages V3 : `MATERIAL_NOT_HELD` n'y a pas
 * d'équivalent, et confondre les deux tables ferait afficher un motif qu'un
 * domaine n'admet pas.
 */
const EVIDENCE_UNRESOLVABLE = {
  EVENT_NOT_FOUND: 'événement introuvable',
  CONTENT_UNAVAILABLE: 'contenu indisponible',
  MATERIAL_NOT_HELD: 'aucune représentation détenue à confronter',
  OCCURRENCE_NOT_FOUND: 'occurrence introuvable',
};

/**
 * Résolution d'une citation, telle que le serveur l'a dérivée.
 *
 * `RESOLVABLE` établit exactement « la citation existe dans le matériau », et
 * jamais « la citation appuie la cible ». `UNRESOLVABLE` ne rend l'adduction ni
 * invalide, ni fausse : elle reste un fait enregistré, et reste affichée.
 */
const CITATION_RESOLUTION = {
  RESOLVABLE: 'citation retrouvée dans le matériau',
  UNRESOLVABLE: 'citation non retrouvée',
};

/**
 * Vocabulaire V5 — réconciliation.
 *
 * Quatre interdits gouvernent ces libellés (addendum V5.1 §14) : une proposition
 * n'est jamais présentée comme une décision, une actualité de décision jamais
 * comme une actualité d'effet, une clôture jamais comme un consensus, une
 * détection jamais comme une erreur d'expert.
 */
const RECONCILIATION_AVAILABILITY = {
  AVAILABLE: 'V5 disponible',
  NOT_AVAILABLE: 'V5 ne s’applique pas à cette génération de run',
};

const RECONCILIATION_ENTRY_KINDS = {
  RECONCILIATION_RECORDED: 'Acte humain de réconciliation',
  RECONCILIATION_PROPOSED: 'Proposition CCR',
  PROPOSAL_RESPONSE_RECORDED: 'Réponse humaine à une proposition',
};

/** Une réponse est un fait historique. Elle n'adopte rien, et ne clôt rien. */
const RESPONSE_MODES = {
  ACCEPT: 'réponse : acceptation',
  REJECT: 'réponse : rejet',
};

/** Relation d'un ACTE humain à une proposition. Distincte d'une réponse. */
const PROPOSAL_RELATIONS = {
  ADOPTS: 'reprend le contenu proposé',
  MODIFIES: 'part de la proposition et la modifie',
  REPLACES: 'écarte la proposition et lui substitue un contenu propre',
};

/**
 * Détections structurelles — §14.2.
 *
 * Chaque libellé décrit une **forme observée dans le journal**, jamais un
 * jugement sur la qualité d'un raisonnement ou la compétence d'un expert.
 */
const RECONCILIATION_DETECTIONS = {
  D01: 'un acte porte sur un périmètre déjà couvert par un autre acte',
  D02: 'une unité est couverte par plusieurs déclarations de clôture courantes',
  D03: 'une unité de la controverse n’est couverte par aucun acte humain',
  D04: 'plusieurs actes courants coexistent sur la même unité',
  D05: 'une proposition n’a reçu aucune réponse',
  D06: 'un acte cite une proposition sans en reprendre le contenu',
  D07: 'un périmètre déclaré WHOLE et un périmètre partiel coexistent',
  D08: 'un effet de clôture reste courant alors que sa décision ne l’est plus',
};

/** Signaux de désaccord — dérivés de V3, jamais un état persistant. */
const DISAGREEMENT_SIGNALS = {
  CONTESTS: 'une relation de contestation est enregistrée',
  WITHDRAWS: 'un retrait est enregistré',
  CONTEST_RELATION: 'une relation inférée a été contestée',
  NATURE_RECORDED: 'la nature du désaccord a été qualifiée',
};

/**
 * Issues du chemin assisté — traduction, jamais invention d'une cause.
 *
 * Aucun de ces libellés n'affirme ce que CCR n'a pas observé : ni « le
 * fournisseur est hors ligne », ni « le quota est épuisé », ni « le modèle s'est
 * trompé ».
 */
const PROPOSAL_OUTCOMES = {
  RECORDED: 'proposition enregistrée — elle ne décide rien',
  VALID_ZERO: 'aucune proposition produite — ni accord constaté, ni échec',
  NOT_AVAILABLE: 'la proposition assistée n’est pas ouverte sur ce runtime',
  INVALID_OUTPUT: 'sortie du moteur inexploitable — rien n’a été enregistré',
  REVALIDATION_REFUSED: 'l’état a changé pendant l’appel — rien n’a été écrit',
  PROVIDER_FAILED: 'le moteur n’a pas rendu de sortie — l’engagement reste inscrit',
  PROPOSAL_SCOPE_REFUSED: 'périmètre non recevable — rien n’a été engagé',
};

/**
 * Motifs de refus du parseur strict — les quinze du §36.
 *
 * Ils décrivent **ce que la sortie contenait**, jamais une intention prêtée au
 * moteur : « a revendiqué une clôture » dit ce qui a été lu, « a voulu clore »
 * dirait ce qu'on imagine.
 */
const PROPOSER_REFUSALS = {
  OUTPUT_TOO_LARGE: 'sortie au-delà de la borne d’octets',
  OUTPUT_UNPARSABLE: 'sortie non analysable comme JSON',
  UNSUPPORTED_VERSION: 'version de protocole non supportée',
  INVALID_ENVELOPE: 'enveloppe non conforme',
  INVALID_PROPOSAL: 'proposition non conforme',
  DUPLICATE_PROPOSAL: 'proposition en double',
  UNKNOWN_TARGET: 'controverse visée inconnue',
  INVALID_SCOPE: 'périmètre non conforme',
  RANKED_OPTIONS: 'options classées — un rang est un verdict',
  SCORE_FIELD_PRESENT: 'champ de mérite présent — un score est un verdict',
  CLOSURE_CLAIMED: 'clôture revendiquée',
  CLOSURE_WITHDRAWAL_CLAIMED: 'retrait de clôture revendiqué',
  SUPERSESSION_CLAIMED: 'supersession revendiquée',
  HUMAN_DECISION_CLAIMED: 'décision humaine revendiquée',
  AUTHORITATIVE_EFFECT_CLAIMED: 'effet autoritaire revendiqué',
};

/** Les quatre contrôles de revalidation — §38, phase C. */
const REVALIDATION_CHECKS = {
  R0: 'la révision V5 a changé pendant l’appel',
  SCOPE: 'périmètre refusé à la revalidation',
  SUBMITTED_SET: 'une unité désignée n’appartenait pas à l’ensemble soumis',
  CANONICAL_FORM: 'forme canonique refusée',
};

/** Nature d'une opération engagée, telle que l'état la nomme. */
const OPERATION_KINDS = {
  initialization: 'Initialisation',
  step: 'Transfert',
  send: 'Envoi',
  handoff: 'Handoff',
};

function lookup(table, code) {
  if (typeof code !== 'string' || code.length === 0) return '';
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : code;
}

export const label = {
  state: (code) => lookup(STATES, code),
  control: (code) => lookup(CONTROL, code),
  attention: (code) => lookup(ATTENTION, code),
  liveness: (code) => lookup(LIVENESS, code),
  livenessBasis: (code) => lookup(LIVENESS_BASIS, code),
  lockObservation: (code) => lookup(LOCK_OBSERVATION, code),
  capability: (code) => lookup(CAPABILITIES, code),
  capabilityEffect: (code) => lookup(CAPABILITY_EFFECTS, code),
  reason: (code) => lookup(REASONS, code),
  recoveryCapability: (code) => lookup(RECOVERY_CAPABILITIES, code),
  capabilitySettled: (code) => (Object.prototype.hasOwnProperty.call(CAPABILITIES_SETTLED, code)
    ? CAPABILITIES_SETTLED[code]
    : `${lookup(CAPABILITIES, code)} — état déjà atteint`),
  // Historique lisible. Les deux fonctions sont définies plus bas, hors de cet
  // objet, parce qu'elles portent chacune une doctrine à documenter.
  historyLine: (type) => historyLine(type),
  isHumanAct: (entry) => isHumanAct(entry),
  isHistoryTechnical: (type) => isHistoryTechnical(type),
  missingPrimitiveReason: (code) => lookup(MISSING_PRIMITIVE_REASONS, code),
  unreadable: (code) => lookup(UNREADABLE, code),
  eventType: (code) => lookup(EVENT_TYPES, code),
  actor: (code) => lookup(ACTORS, code),
  generation: (code) => lookup(GENERATIONS, code),
  expertSlot: (code) => lookup(EXPERT_SLOTS, code),
  aliasResolution: (code) => lookup(ALIAS_RESOLUTIONS, code),
  stepSource: (code) => lookup(STEP_SOURCES, code),
  recoveryDomain: (code) => lookup(RECOVERY_DOMAINS, code),
  recoveryStatus: (code) => lookup(RECOVERY_STATUSES, code),
  recoveryAction: (code) => lookup(RECOVERY_ACTIONS, code),
  doctorStatus: (code) => lookup(DOCTOR_STATUS, code),
  doctorSeverity: (code) => lookup(DOCTOR_SEVERITY, code),
  doctorFinding: (code) => lookup(DOCTOR_FINDINGS, code),
  configSource: (code) => lookup(CONFIG_SOURCES, code),
  error: (code) => (Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : ERRORS.INTERNAL_ERROR),
  controversyAvailability: (code) => lookup(CONTROVERSY_AVAILABILITY, code),
  controversyEntryKind: (code) => lookup(CONTROVERSY_ENTRY_KINDS, code),
  evidenceTargetKind: (code) => (typeof code === 'string' && code.length > 0
    ? lookup(EVIDENCE_TARGET_KINDS, code)
    : '—'),
  semanticOrigin: (code) => lookup(SEMANTIC_ORIGINS, code),
  relationAct: (code) => lookup(RELATION_ACTS, code),
  authorityAct: (code) => lookup(AUTHORITY_ACTS, code),
  derivationMethod: (code) => lookup(DERIVATION_METHODS, code),
  unresolvableAnchor: (code) => lookup(UNRESOLVABLE_ANCHORS, code),
  evidenceAvailability: (code) => lookup(EVIDENCE_AVAILABILITY, code),
  materialForm: (code) => lookup(MATERIAL_FORMS, code),
  materialSubmission: (code) => lookup(MATERIAL_SUBMISSION_ORIGINS, code),
  orientation: (code) => lookup(ORIENTATIONS, code),
  materialVerifiability: (code) => lookup(MATERIAL_VERIFIABILITY, code),
  evidenceUnresolvable: (code) => lookup(EVIDENCE_UNRESOLVABLE, code),
  citationResolution: (code) => lookup(CITATION_RESOLUTION, code),
  reconciliationAvailability: (code) => lookup(RECONCILIATION_AVAILABILITY, code),
  reconciliationEntryKind: (code) => lookup(RECONCILIATION_ENTRY_KINDS, code),
  responseMode: (code) => lookup(RESPONSE_MODES, code),
  proposalRelation: (code) => lookup(PROPOSAL_RELATIONS, code),
  reconciliationDetection: (code) => lookup(RECONCILIATION_DETECTIONS, code),
  disagreementSignal: (code) => lookup(DISAGREEMENT_SIGNALS, code),
  proposalOutcome: (code) => lookup(PROPOSAL_OUTCOMES, code),
  proposerRefusal: (code) => lookup(PROPOSER_REFUSALS, code),
  revalidationCheck: (code) => lookup(REVALIDATION_CHECKS, code),
  operationKind: (code) => lookup(OPERATION_KINDS, code),
};

/**
 * Durée écoulée → forme lisible.
 *
 * Ne rend **que du temps observé** : ni estimation restante, ni pourcentage, ni
 * projection. Une durée négative — horloges décalées — est ramenée à zéro
 * plutôt qu'affichée à l'envers.
 */
export function formatElapsed(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) return '—';
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${String(hours)} h ${String(minutes)} min`;
  if (minutes > 0) return `${String(minutes)} min ${String(seconds)} s`;
  return `${String(seconds)} s`;
}

/**
 * Écart entre un instant serveur et maintenant, en millisecondes.
 *
 * Rend `null` — et non zéro — quand l'horodatage est illisible : une durée
 * inconnue ne s'affiche pas comme une durée nulle.
 */
export function elapsedSince(iso, now) {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return null;
  return now - started;
}

export function isRetryable(code) {
  return RETRYABLE.has(code);
}

/** Horodatage ISO → heure locale lisible. Transformation d'affichage pure. */
export function formatInstant(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

/**
 * Les quatre espaces de révision du produit.
 *
 * Ils ne sont jamais comparés entre eux : un condensat de controverse et un
 * condensat de réconciliation portent le même algorithme sur des univers
 * différents. Le préfixe reste donc affiché — c'est lui qui dit de quel espace
 * la valeur relève.
 */
const REVISION_NAMESPACES = ['ctv-sha256:', 'rcn-sha256:', 'ev-sha256:', 'sha256:'];

/** Nombre de caractères de condensat réellement affichés. */
const REVISION_DIGEST_CHARS = 12;

/**
 * Révision opaque → forme courte lisible. La valeur complète reste exacte et
 * accessible : les appelants la portent en `title`, et rien ici ne la modifie.
 *
 * L'ancienne implémentation ne retirait que le préfixe `sha256:`, si bien
 * qu'une révision `ev-sha256:` ou `rcn-sha256:` consommait sa fenêtre de douze
 * caractères dans son propre préfixe et n'exposait qu'un ou deux caractères de
 * condensat — trop peu pour distinguer deux valeurs, donc trop peu pour servir.
 */
export function shortRevision(revision) {
  if (typeof revision !== 'string') return '—';
  const namespace = REVISION_NAMESPACES.find((prefix) => revision.startsWith(prefix));
  if (namespace === undefined) {
    return revision.length <= REVISION_DIGEST_CHARS ? revision : `${revision.slice(0, REVISION_DIGEST_CHARS)}…`;
  }
  const digest = revision.slice(namespace.length);
  // Une valeur déjà courte est rendue entière : une ellipsie y annoncerait une
  // suite qui n'existe pas.
  if (digest.length <= REVISION_DIGEST_CHARS) return revision;
  return `${namespace}${digest.slice(0, REVISION_DIGEST_CHARS)}…`;
}

export function formatCount(value) {
  return typeof value === 'number' ? String(value) : '—';
}

/**
 * Accord en nombre, pour les compteurs rendus à l'écran.
 *
 * « 1 run(s) » était faux au singulier. Le pluriel n'est pas une parenthèse.
 */
export function pluralize(count, singular, plural) {
  const value = typeof count === 'number' ? count : 0;
  return `${String(value)} ${Math.abs(value) > 1 ? plural : singular}`;
}

/**
 * Montant monétaire → forme lisible, sans jamais prétendre à une précision
 * supérieure à celle observée.
 *
 * Le fournisseur publie par exemple `4.1596655`. L'afficher tel quel dans le
 * texte principal se lit mal et suggère une comptabilité à sept décimales.
 * L'arrondi n'existe qu'ici, à l'affichage : la valeur persistée, la valeur
 * transmise et tout calcul restent ceux du fournisseur, et la valeur exacte est
 * portée en `title` par l'appelant.
 */
export function formatMoney(amount, currency) {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return `${String(amount)} ${String(currency)}`;
  // Deux décimales pour un montant ordinaire ; davantage tant qu'un montant très
  // faible s'afficherait autrement comme nul, ce qui serait un mensonge.
  const decimals = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `${value.toFixed(decimals)} ${String(currency)}`;
}

/**
 * Historique lisible — table **fermée**, un type d'événement par ligne.
 *
 * ## Ce que cette table est
 *
 * Une traduction : `type` → phrase française. Rien d'autre. Elle ne combine pas
 * deux champs, ne consulte aucun horodatage, ne regarde pas l'entrée voisine, et
 * ne déduit jamais un fait qu'un événement ne porte pas.
 *
 * ## Ce qu'elle refuse explicitement
 *
 * ```text
 * recorded_by   ≠  origine sémantique
 * provider      ≠  origine sémantique
 * adjacence     ≠  causalité
 * chronologie   ≠  agentivité
 * ```
 *
 * Un événement écrit par CCR à la demande d'un humain porte `recorded_by: CCR`.
 * En conclure « CCR a décidé » serait faux ; en conclure « un humain a décidé »
 * le serait tout autant. Le seul fait disponible est le TYPE de l'événement,
 * plus — pour l'unique type ambigu — l'acteur que l'événement porte lui-même.
 */

/**
 * Phrase de l'historique, par type. Fermée : un type absent est rendu par son
 * libellé technique plutôt que par une phrase inventée.
 */
const HISTORY_LINES = {
  run_created: 'Run créé',
  session_created: 'Session native ouverte',
  prompt_sent: 'Demande transmise',
  assistant_response: 'Réponse d’expert',
  human_message: 'Message humain transmis',
  human_handoff_started: 'Session interactive ouverte',
  human_handoff_finished: 'Session interactive fermée',
  control_changed: 'Changement de contrôle',
  state_changed: 'Changement d’état',
  round_started: 'Tour ouvert',
  round_completed: 'Passage de témoin',
  decision_recorded: 'Décision enregistrée',
  process_failed: 'Échec de processus',
  run_paused: 'Automatisation suspendue',
  run_resumed: 'Automatisation reprise',
  run_completed: 'Run terminé',
  runtime_config_changed: 'Runtime épinglé modifié',
  transfer_blocked: 'Passage de témoin bloqué',
  transfer_uncertainty_acknowledged: 'Incertitude de transfert acquittée',
  transfer_aborted_before_provider: 'Transfert abandonné avant tout appel fournisseur',
  send_aborted_before_provider: 'Envoi abandonné avant tout appel fournisseur',
  send_uncertainty_acknowledged: 'Incertitude d’envoi acquittée',
  handoff_aborted_before_interactive: 'Handoff abandonné avant tout terminal',
  handoff_uncertainty_acknowledged: 'Incertitude de handoff acquittée',
};

/**
 * Types repliés par défaut dans l'Historique — table **fermée**.
 *
 * ## Pourquoi une table distincte de celle du fil
 *
 * Le fil répond à « est-ce une contribution à la conversation ? » ; son
 * `default:` renvoie donc TECHNICAL pour tout ce qui n'en est pas une — la
 * création du run comprise. L'Historique répond à une autre question :
 *
 * ```text
 * technicité conversationnelle  ≠  visibilité par défaut de l'Historique
 * ```
 *
 * « Run créé » appartient au cycle de vie normal que l'utilisateur doit
 * pouvoir lire. Réutiliser la classification du fil l'escamotait.
 *
 * ## Forme de la règle
 *
 * Fermée, explicite, indexée par TYPE CANONIQUE, et de présentation seule.
 * Aucun contenu n'est lu, aucun `recorded_by`, aucun fournisseur, aucun
 * horodatage, aucun voisin, aucune position. Deux événements de même type
 * reçoivent la même visibilité, quelles que soient leurs autres différences.
 *
 * Le repli est l'EXCEPTION : n'y figurent que l'ouverture d'une session native
 * et l'ouverture d'un tour — de la mécanique de session et de transport. Tout
 * le reste est visible, y compris les échecs, les abandons et les acquittements
 * d'incertitude, qu'il serait fautif de masquer.
 */
const HISTORY_TECHNICAL_TYPES = [
  'session_created',
  'round_started',
];

/**
 * Cet événement est-il replié par défaut dans l'Historique ?
 *
 * Lit `type`, et rien d'autre. Un type inconnu est VISIBLE : mieux vaut
 * afficher un fait qu'on ne sait pas qualifier que le masquer en silence.
 */
export function isHistoryTechnical(type) {
  return HISTORY_TECHNICAL_TYPES.includes(type);
}

/**
 * Types dont **la définition même** est un acte humain.
 *
 * Chacun n'existe que parce qu'une personne a agi : écrire un message, ouvrir
 * ou fermer un terminal interactif, enregistrer une décision, modifier le
 * runtime épinglé, acquitter une incertitude que la machine ne peut pas lever.
 *
 * `run_paused`, `run_resumed`, `control_changed` et `state_changed` n'y sont
 * **pas** : le journal ne dit pas, sur ces types, qui a provoqué le changement.
 * Les y ajouter ferait dire à l'écran une chose que le fichier ne dit pas.
 */
const HUMAN_ACT_EVENT_TYPES = [
  'human_message',
  'human_handoff_started',
  'human_handoff_finished',
  'decision_recorded',
  'runtime_config_changed',
  'transfer_uncertainty_acknowledged',
  'send_uncertainty_acknowledged',
  'handoff_uncertainty_acknowledged',
];

/**
 * Cet événement est-il l'acte d'un humain ?
 *
 * Deux voies, et deux seulement, toutes deux LUES sur l'événement :
 *
 *  1. l'événement porte lui-même `actor: 'human'` ;
 *  2. son TYPE est un acte humain par définition — le type existe parce qu'une
 *     personne a agi, quelle que soit la catégorie qui l'a écrit.
 *
 * `actor` est un champ de l'événement, écrit par celui qui l'a produit. Ce
 * n'est ni `recorded_by`, ni un fournisseur, ni une position dans la liste. Un
 * événement qui se déclare humain est lu comme tel : l'ignorer perdrait un fait
 * canonique, ce qui est l'erreur symétrique de celle qu'on veut éviter.
 *
 * Tout le reste rend `false` — notamment `run_paused`, `run_resumed` et
 * `control_changed` lorsqu'ils ne portent pas d'acteur humain. Ne pas savoir
 * n'est pas savoir que non ; mais afficher « humain » sans le fait serait
 * affirmer, et c'est cela qui est interdit.
 */
export function isHumanAct(entry) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return false;
  if (entry.actor === 'human') return true;
  return HUMAN_ACT_EVENT_TYPES.includes(entry.type);
}

/** Phrase de l'historique pour un type. Un type inconnu est rendu tel quel. */
export function historyLine(type) {
  return Object.prototype.hasOwnProperty.call(HISTORY_LINES, type) ? HISTORY_LINES[type] : String(type);
}

export { HISTORY_LINES, HUMAN_ACT_EVENT_TYPES, HISTORY_TECHNICAL_TYPES };
