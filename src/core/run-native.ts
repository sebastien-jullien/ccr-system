/**
 * Documents canoniques d'un run **natif V2.1** (spécification V2.1 V0.3,
 * §13.3 à §13.6).
 *
 * Deux générations coexistent sur disque, et une seule par run :
 *
 *   LEGACY_V2_EXECUTION    manifest schema 1 — modèle de `src/core/run.ts`
 *   NATIVE_V21_EXECUTION   manifest schema 2 — modèle ci-dessous
 *
 * La génération est déterminée **une fois**, à la lecture du manifest, et ne
 * change jamais. Elle n'est jamais déduite d'un événement, d'un état, d'un
 * champ runtime, d'un fournisseur ni d'un mapping de rôle.
 *
 * Ce module ne contient que des types et des constantes de version : aucune
 * lecture, aucune écriture, aucune règle d'exécution.
 */

import type { ExpertSlotId, ProviderKind } from './expert.ts';
import type { EventType, RuntimeAuthPreflight, RuntimeConfigSource } from './run.ts';
import type { ControlOwner, RunState } from './state.ts';

// --------------------------------------------------------------------------
// Versions de schéma
// --------------------------------------------------------------------------
//
// Fixées depuis les constantes observées dans `src/core/run.ts` : version
// courante + 1. Aucun numéro inventé (V0.3, §13.4).

/** `MANIFEST_SCHEMA_VERSION` observée : 1. */
export const NATIVE_MANIFEST_SCHEMA_VERSION = 2;
/** `RUNTIME_CONFIG_SCHEMA_VERSION` observée : 1. */
export const NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION = 2;
/** `STATE_SCHEMA_VERSION` observée : 2, `SUPPORTED = [1, 2]`. */
export const NATIVE_STATE_SCHEMA_VERSION = 3;

/**
 * Versions de `state.json` que le lecteur de génération sait ouvrir.
 *
 * Distincte de `SUPPORTED_STATE_SCHEMA_VERSIONS`, qui reste la liste du seul
 * lecteur legacy : élargir cette dernière ferait accepter un document natif par
 * un parseur qui l'aplatirait en document legacy.
 */
export const READABLE_STATE_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3];

/** Génération d'un run, dérivée du seul `schema_version` du manifest. */
export type RunExecutionMode = 'LEGACY_V2_EXECUTION' | 'NATIVE_V21_EXECUTION';

// --------------------------------------------------------------------------
// Manifest natif
// --------------------------------------------------------------------------

/**
 * Affectation technique d'un slot.
 *
 * Aucun champ `role` : la clé du slot porte le rôle. Un champ peut valoir deux
 * fois la même chose ; une clé non.
 */
export interface ExpertSlotBinding {
  readonly provider: ProviderKind;
  /** Identifiant natif. `null` tant que la session n'existe pas. */
  readonly session_id: string | null;
}

/**
 * Les deux slots d'un run natif.
 *
 * Exactement `author` et `challenger` : la forme empêche la duplication, la
 * validation empêche l'absence (`INV-21-11`).
 */
export interface ExpertSlots {
  readonly author: ExpertSlotBinding;
  readonly challenger: ExpertSlotBinding;
}

/**
 * Faits fournisseur d'un run natif, pour **un** moteur.
 *
 * Union discriminée par `required`, et non objet à champs optionnels : quand un
 * fournisseur n'est employé par aucun slot, les champs d'observation n'existent
 * pas. Il devient donc impossible de fabriquer une version ou un état
 * d'authentification qui n'a jamais été observé (V0.3, §11.1, §12.2).
 *
 * `NOT_REQUIRED` n'est ni « prêt » ni « en échec » : c'est l'absence de
 * question.
 */
export type NativeProviderRuntime =
  | {
      readonly required: false;
      readonly probe_status: 'NOT_REQUIRED';
    }
  | {
      readonly required: true;
      readonly probe_status: 'OBSERVED';
      readonly cli_version: string | null;
      readonly auth_preflight: RuntimeAuthPreflight;
    };

/**
 * Faits fournisseur de Codex.
 *
 * `skip_git_repo_check` reste la **seule autorité exécutable** du run pour
 * l'invocation de Codex. Elle n'a de sens que si un slot emploie Codex : quand
 * aucun ne le fait, elle n'existe pas plutôt que de valoir un `false` inerte
 * qu'un lecteur pourrait prendre pour une décision.
 */
export type NativeCodexRuntime =
  | {
      readonly required: false;
      readonly probe_status: 'NOT_REQUIRED';
    }
  | {
      readonly required: true;
      readonly probe_status: 'OBSERVED';
      readonly cli_version: string | null;
      readonly auth_preflight: RuntimeAuthPreflight;
      readonly skip_git_repo_check: boolean;
      /** Descriptif, historique, immuable. Jamais consulté pour exécuter. */
      readonly source_at_capture: RuntimeConfigSource;
    };

/**
 * Snapshot runtime natif (schema 2).
 *
 * Les faits restent **nommés par fournisseur** : ils décrivent le poste, pas
 * les acteurs du protocole. Ce sont les bindings du manifest qui disent quel
 * moteur exécute quel rôle.
 */
export interface NativeRunRuntimeConfig {
  readonly schema_version: number;
  readonly captured_at: string;
  readonly claude: NativeProviderRuntime;
  readonly codex: NativeCodexRuntime;
}

export interface NativeRunManifest {
  readonly schema_version: number;
  readonly run_id: string;
  readonly title: string;
  readonly created_at: string;
  /**
   * Répertoire de travail initial du run.
   *
   * `cwd` est la forme **canonique** — `realpath` appliqué à la création, si
   * bien que deux orthographes du même répertoire ne produisent pas deux runs
   * distincts. `declared_cwd` conserve la forme telle qu'elle a été donnée
   * lorsqu'elle en diffère : c'est une trace d'identité, utile pour relire ce
   * qui a été demandé.
   *
   * ```text
   * CONTEXTE DE TRAVAIL INITIAL   ≠   FRONTIÈRE DE SÉCURITÉ
   * ```
   *
   * Ce champ ne restreint rien. CCR ne surveille pas l'exploration du système
   * de fichiers par un fournisseur : les permissions des outils appartiennent à
   * l'environnement de ce fournisseur.
   */
  readonly workspace: {
    readonly cwd: string;
    readonly declared_cwd?: string;
  };
  readonly experts: ExpertSlots;
  /**
   * Présent sur tout run natif créé par la façade V2.1. Optionnel dans le
   * contrat parce que 1A ne câble aucune création : rendre le champ
   * obligatoire ici préjugerait de l'ordre exact retenu par le slice START.
   * S'il est présent, il est nécessairement en schema 2.
   */
  readonly runtime_config?: NativeRunRuntimeConfig;
}

// --------------------------------------------------------------------------
// État natif
// --------------------------------------------------------------------------

interface NativePendingOperationBase {
  readonly round: number;
  readonly prompt_event_id: string | null;
  readonly session_id: string | null;
  readonly return_state: RunState;
  readonly return_control: ControlOwner;
  readonly started_at: string;
}

/**
 * Transfert engagé.
 *
 * Les trois faits que la spécification exige de figer **avant** tout lancement
 * fournisseur (V0.3, §16.2) sont obligatoires ici, et non optionnels : une
 * opération de transfert dont la source ne serait pas fixée ne pourrait pas
 * être reprise sans deviner.
 */
export interface NativeStepOperation extends NativePendingOperationBase {
  readonly kind: 'step';
  readonly source_slot: ExpertSlotId;
  readonly target_slot: ExpertSlotId;
  readonly source_event_id: string;
}

/** Opération visant un seul slot : initialisation, message humain, handoff. */
export interface NativeSlotOperation extends NativePendingOperationBase {
  readonly kind: 'initialization' | 'send' | 'handoff';
  readonly expert_slot: ExpertSlotId;
}

/**
 * Contrat discriminé plutôt qu'objet dont tous les champs seraient optionnels :
 * `source_slot` n'a aucun sens pour une initialisation, et un champ facultatif
 * sans règle laisserait le lecteur l'inventer.
 */
export type NativePendingOperation = NativeStepOperation | NativeSlotOperation;

export interface NativeRunUncertainty {
  readonly reason: string;
  readonly since: string;
  /** Slot concerné. Jamais un fournisseur : deux slots peuvent partager le moteur. */
  readonly expert_slot: ExpertSlotId | null;
  readonly last_event_id: string | null;
}

export interface NativeRunStateDocument {
  readonly schema_version: number;
  readonly run_id: string;
  readonly state: RunState;
  readonly control: ControlOwner;
  readonly round: number;
  /** Slot dont un tour est en vol, le cas échéant. */
  readonly active_expert_slot: ExpertSlotId | null;
  /**
   * Curseur d'alternance (V0.3, §16.2).
   *
   * `null` tant que l'initialisation n'est pas complète : il n'y a pas encore
   * deux experts entre lesquels alterner. Sa sémantique d'avancement appartient
   * aux slices START et STEP ; 1A ne fait que le rendre représentable.
   */
  readonly next_step_source_slot: ExpertSlotId | null;
  readonly last_event_id: string | null;
  readonly pending_operation: NativePendingOperation | null;
  readonly uncertainty: NativeRunUncertainty | null;
  readonly updated_at: string;
}

// --------------------------------------------------------------------------
// Journal natif
// --------------------------------------------------------------------------

/**
 * Acteurs d'un événement natif.
 *
 * `claude` et `codex` disparaissent : ils répondaient à la question « quel
 * moteur ? » en prétendant répondre à « qui ? ». Deux experts partageant un
 * moteur devenaient indiscernables, et un `actor` fournisseur cohabitant avec
 * un `expert_slot_id` aurait créé deux faits capables de diverger.
 *
 * `expert` reste une **catégorie**, jamais une identité : l'identité métier est
 * portée par les champs de slot, seuls et sans concurrent.
 *
 * `human`, `system` et `evidence` sont inchanges (doctrine, provenance
 * obligatoire).
 */
export const NATIVE_EVENT_ACTORS = ['human', 'expert', 'system', 'evidence'] as const;
export type NativeEventActor = (typeof NATIVE_EVENT_ACTORS)[number];

/** Provenance à une session : l'événement EST le tour d'un expert. */
export const EXPERT_SESSION_EVENT_TYPES = ['session_created', 'assistant_response'] as const;
/**
 * Provenance à une cible : l'événement s'adresse à un expert.
 *
 * `round_started` en fait partie depuis le micro-gate 1B.1 : V2 l'écrit avec
 * `target: targetAgent` (`run-service.ts:839`). Le classer sans slot aurait
 * rendu le contrat natif **moins expressif** que le contrat historique — CCR
 * aurait su dire quel agent un round concernait, et plus quel expert.
 */
export const EXPERT_TARGET_EVENT_TYPES = [
  'prompt_sent',
  'human_message',
  'human_handoff_started',
  'human_handoff_finished',
  'process_failed',
  'round_started',
] as const;
/** Provenance bi-slot : l'événement relate un passage de témoin abouti. */
export const TRANSFER_EVENT_TYPES = ['round_completed'] as const;

/**
 * Transfert refusé **avant** tout appel fournisseur.
 *
 * Type propre à la génération native, et absent de `EVENT_TYPES` : aucun
 * chemin historique ne l'émet, et le journal historique le refuse — à la
 * lecture parce que son type lui est inconnu, à l'écriture parce que la garde
 * de génération le rejette.
 *
 * Il ne pouvait pas être une variante de `round_completed` : aucune réponse
 * cible n'existe, donc aucun `response_event_id`. Il ne pouvait pas non plus
 * être un `state_changed` — la classe neutre ne porte aucune identité, et un
 * refus de transfert en concerne **deux** (dette consignée en IMP-02 et
 * qualifiée en IMP-05).
 */
export const TRANSFER_BLOCKED_EVENT_TYPES = ['transfer_blocked'] as const;
export type TransferBlockedEventType = (typeof TRANSFER_BLOCKED_EVENT_TYPES)[number];

/** Raisons fermées d'un transfert refusé. */
export const TRANSFER_BLOCKED_REASONS = ['PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER'] as const;
export type TransferBlockedReason = (typeof TRANSFER_BLOCKED_REASONS)[number];

/**
 * Quarantaine d'une source engagée dans un transfert d'issue inconnue.
 *
 * Sémantiquement **distinct** de `transfer_blocked`, malgré une forme voisine :
 *
 * ```text
 * transfer_blocked                     le fournisseur n'a jamais été appelé
 *                                      la source reste canoniquement disponible
 *
 * transfer_uncertainty_acknowledged    l'appel a peut-être été engagé
 *                                      la source ne peut plus être rejouée
 * ```
 *
 * Cet événement n'affirme ni que le fournisseur a répondu, ni le contraire, ni
 * que l'appel n'a pas été consommé. Il enregistre une seule chose : un humain a
 * reconnu l'incertitude, et CCR renonce définitivement à réutiliser cette
 * source automatiquement.
 */
export const TRANSFER_QUARANTINE_EVENT_TYPES = ['transfer_uncertainty_acknowledged'] as const;
export type TransferQuarantineEventType = (typeof TRANSFER_QUARANTINE_EVENT_TYPES)[number];

export const TRANSFER_QUARANTINE_REASONS = ['IN_FLIGHT_UNCERTAIN'] as const;
export type TransferQuarantineReason = (typeof TRANSFER_QUARANTINE_REASONS)[number];

/**
 * Transfert abandonné **après** ses faits préparatoires, avant tout appel.
 *
 * Troisième issue sans réponse d'un transfert, et distincte des deux autres :
 *
 * ```text
 * transfer_blocked                    CCR a refusé d'engager l'appel
 *                                     source réutilisable
 * transfer_aborted_before_provider    l'appel n'a jamais pu être engagé
 *                                     source réutilisable
 * transfer_uncertainty_acknowledged   l'appel a peut-être eu lieu
 *                                     source définitivement inrejouable
 * ```
 *
 * Les deux premières partagent « le fournisseur n'a jamais été appelé » sans
 * être le même fait : l'une est une décision de CCR avant le round, l'autre la
 * clôture d'une tentative interrompue. Les confondre effacerait la raison.
 *
 * `based_on` porte l'identité de la **tentative** — l'identifiant du
 * `round_started` qu'elle clôt — parce qu'une même source peut légitimement
 * être réessayée après un abandon avant appel, dans le même round logique.
 */
export const TRANSFER_ABORTED_EVENT_TYPES = ['transfer_aborted_before_provider'] as const;
export type TransferAbortedEventType = (typeof TRANSFER_ABORTED_EVENT_TYPES)[number];

export const TRANSFER_ABORTED_REASONS = ['PRE_PROVIDER_ABORTED'] as const;
export type TransferAbortedReason = (typeof TRANSFER_ABORTED_REASONS)[number];

/**
 * Clôture d'un envoi humain resté sans réponse (Slice 2B-R).
 *
 * Un `send` n'est pas un transfert : il n'a ni source, ni round consommé, ni
 * passage de témoin. Ses deux marqueurs de clôture ne pouvaient donc être ni
 * `TRANSFER_BLOCKED` ni `TRANSFER_QUARANTINED`, qui exigent tous deux **deux**
 * slots et une source. Ils ne sont pas non plus `EXPERT_SESSION` : aucune
 * session n'a produit quoi que ce soit.
 *
 * Ils ne sont pas davantage de simples `EXPERT_TARGET` : cette classe
 * n'obligerait ni `prompt_event_id` ni `reason`, et un marqueur de clôture
 * incapable de nommer l'envoi qu'il clôt ne clôt rien de vérifiable.
 *
 * ```text
 * send_aborted_before_provider     le fournisseur n'a certainement PAS été appelé
 * send_uncertainty_acknowledged    le fournisseur a PEUT-ÊTRE été appelé
 * ```
 *
 * Les deux types restent **distincts** : la première affirmation est une
 * déduction de CCR, permise par l'ordre durable de 2B ; la seconde est un
 * constat d'ignorance acquitté par un humain. Les confondre reviendrait à
 * prétendre savoir.
 */
export const SEND_ABORTED_EVENT_TYPES = ['send_aborted_before_provider'] as const;
export const SEND_UNCERTAINTY_EVENT_TYPES = ['send_uncertainty_acknowledged'] as const;
export const SEND_RESOLUTION_EVENT_TYPES = [
  ...SEND_ABORTED_EVENT_TYPES,
  ...SEND_UNCERTAINTY_EVENT_TYPES,
] as const;
export type SendResolutionEventType = (typeof SEND_RESOLUTION_EVENT_TYPES)[number];

/**
 * Motif attendu, **par type**.
 *
 * Le motif ne peut pas migrer d'un marqueur à l'autre : ce sont précisément les
 * deux sémantiques que le Slice 2B-R interdit de fusionner.
 */
export const SEND_RESOLUTION_REASONS: Readonly<Record<SendResolutionEventType, string>> = {
  send_aborted_before_provider: 'PRE_PROVIDER_ABORTED',
  send_uncertainty_acknowledged: 'IN_FLIGHT_UNCERTAIN',
};

/**
 * Clôture d'une ouverture de handoff (Slice 2C-R).
 *
 * Un `handoff` n'a ni source, ni round, ni réponse : ses marqueurs ne pouvaient
 * être ni `TRANSFER`, ni `TRANSFER_QUARANTINED`, qui exigent deux slots et une
 * source, ni `EXPERT_SESSION`, qui affirme qu'une session a produit un tour.
 *
 * Ils ne sont pas non plus des clôtures d'envoi : un envoi clôt un
 * `human_message` dont CCR possède le contenu, un handoff clôt une ouverture
 * dont il ignore tout ce qui a suivi. Les deux familles nomment donc des
 * identifiants différents — `prompt_event_id` d'un côté, `started_event_id` de
 * l'autre — et ne se confondent pas.
 *
 * ```text
 * handoff_aborted_before_interactive   le client interactif n'a CERTAINEMENT pas
 *                                      été lancé
 * handoff_uncertainty_acknowledged     il a PEUT-ÊTRE vécu, et CCR ignore ce
 *                                      qu'il a produit
 * ```
 */
export const HANDOFF_ABORTED_EVENT_TYPES = ['handoff_aborted_before_interactive'] as const;
export const HANDOFF_UNCERTAINTY_EVENT_TYPES = ['handoff_uncertainty_acknowledged'] as const;
export const HANDOFF_RESOLUTION_EVENT_TYPES = [
  ...HANDOFF_ABORTED_EVENT_TYPES,
  ...HANDOFF_UNCERTAINTY_EVENT_TYPES,
] as const;
export type HandoffResolutionEventType = (typeof HANDOFF_RESOLUTION_EVENT_TYPES)[number];

/** Motif attendu, **par type**. Les deux sémantiques ne migrent pas. */
export const HANDOFF_RESOLUTION_REASONS: Readonly<Record<HandoffResolutionEventType, string>> = {
  handoff_aborted_before_interactive: 'PRE_INTERACTIVE_ABORTED',
  handoff_uncertainty_acknowledged: 'IN_FLIGHT_UNCERTAIN',
};

/** Types d'événement qu'un journal natif peut porter. */
export type NativeEventType =
  | EventType
  | TransferBlockedEventType
  | TransferQuarantineEventType
  | TransferAbortedEventType
  | SendResolutionEventType
  | HandoffResolutionEventType;

export type ExpertSessionEventType = (typeof EXPERT_SESSION_EVENT_TYPES)[number];
export type ExpertTargetEventType = (typeof EXPERT_TARGET_EVENT_TYPES)[number];
export type TransferEventType = (typeof TRANSFER_EVENT_TYPES)[number];

/**
 * Tout le reste — **generation-neutral**.
 *
 * Ces événements ne portent aucune identité : ni expert, ni fournisseur, ni
 * session. Leur sens et leur forme sur le fil sont identiques dans les deux
 * générations, et c'est délibéré : il n'y a rien à distinguer, donc rien qui
 * puisse diverger.
 *
 * Leur génération ne se lit pas sur le record. Elle vient du manifest, donc du
 * store sélectionné. Ce n'est pas un journal mixte : le record est
 * sémantiquement commun aux deux générations (micro-gate 1B.1).
 */
export type GenerationNeutralEventType = Exclude<
  EventType,
  ExpertSessionEventType | ExpertTargetEventType | TransferEventType
>;

interface NativeEventBase {
  readonly event_id: string;
  readonly run_id: string;
  readonly round: number;
  readonly timestamp: string;
  readonly actor: NativeEventActor;
  /** Contenu textuel intégral, jamais résumé par CCR. */
  readonly content?: string | null;
  readonly exit_code?: number | null;
  readonly based_on?: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Tour d'un expert.
 *
 * `expert_slot_id` et `session_id` sont **tous deux** obligatoires, et ne se
 * remplacent pas : le premier dit qui a agi dans CCR, le second dans quelle
 * continuité native. L'identité métier ne se déduit jamais de la technique.
 */
export interface NativeExpertSessionEvent extends NativeEventBase {
  readonly type: ExpertSessionEventType;
  readonly expert_slot_id: ExpertSlotId;
  readonly session_id: string;
}

/** Événement adressé à un expert. */
export interface NativeExpertTargetEvent extends NativeEventBase {
  readonly type: ExpertTargetEventType;
  readonly target_expert_slot_id: ExpertSlotId;
  readonly session_id?: string | null;
}

/**
 * Passage de témoin.
 *
 * Quatre faits obligatoires, parce qu'un transfert a une source **et** une
 * cible : un identifiant unique ne peut pas les porter.
 */
export interface NativeTransferEvent extends NativeEventBase {
  readonly type: TransferEventType;
  readonly source_slot_id: ExpertSlotId;
  readonly target_slot_id: ExpertSlotId;
  readonly source_event_id: string;
  readonly response_event_id: string;
}

/**
 * Événement sans identité.
 *
 * Aucun champ de slot, aucun `target`, aucun acteur fournisseur — et **aucun
 * `session_id`, pas même nul** : une provenance technique native n'est jamais
 * orpheline du slot auquel elle appartient. Un identifiant de session sans slot
 * nommerait une continuité sans dire à qui elle est, et un champ nul en donnerait
 * une seconde écriture de fil pour le même fait.
 */
export interface NativeGenerationNeutralEvent extends NativeEventBase {
  readonly type: GenerationNeutralEventType;
}

/**
 * Transfert refusé avant appel — **bi-slot, sans réponse**.
 *
 * `response_event_id` est structurellement absent : l'inventer vide donnerait à
 * un lecteur un champ à interpréter là où il n'y a rien eu.
 */
export interface NativeTransferBlockedEvent extends NativeEventBase {
  readonly type: TransferBlockedEventType;
  readonly source_slot_id: ExpertSlotId;
  readonly target_slot_id: ExpertSlotId;
  readonly source_event_id: string;
  readonly reason: TransferBlockedReason;
}

/**
 * Source mise en quarantaine — **bi-slot, sans réponse connue**.
 *
 * `response_event_id` est absent parce que CCR ne sait précisément pas si une
 * réponse exploitable existe. L'inventer, même nul, laisserait croire à une
 * conclusion.
 */
export interface NativeTransferQuarantineEvent extends NativeEventBase {
  readonly type: TransferQuarantineEventType;
  readonly source_slot_id: ExpertSlotId;
  readonly target_slot_id: ExpertSlotId;
  readonly source_event_id: string;
  readonly reason: TransferQuarantineReason;
}

/**
 * Envoi humain abandonné avant tout appel — **un slot, aucune réponse**.
 *
 * `prompt_event_id` est obligatoire : sans lui, un lecteur ultérieur verrait
 * toujours le même `human_message` sans issue, et le marqueur ne prouverait
 * rien. `response_event_id` est structurellement absent — il n'y a pas eu
 * d'appel, donc rien à désigner.
 */
export interface NativeSendAbortedEvent extends NativeEventBase {
  readonly type: 'send_aborted_before_provider';
  readonly target_expert_slot_id: ExpertSlotId;
  readonly prompt_event_id: string;
  readonly reason: 'PRE_PROVIDER_ABORTED';
}

/**
 * Envoi humain d'issue inconnue, acquitté — **un slot, aucune conclusion**.
 *
 * L'événement n'affirme ni que le fournisseur a répondu, ni le contraire, ni
 * que l'appel n'a pas été consommé. Il enregistre qu'un humain a reconnu
 * l'ignorance de CCR et renonce à toute reprise automatique de cet envoi.
 */
export interface NativeSendUncertaintyEvent extends NativeEventBase {
  readonly type: 'send_uncertainty_acknowledged';
  readonly target_expert_slot_id: ExpertSlotId;
  readonly prompt_event_id: string;
  readonly reason: 'IN_FLIGHT_UNCERTAIN';
}

/**
 * Ouverture de handoff abandonnée avant tout lancement — **un slot, aucune
 * interaction**.
 *
 * `started_event_id` est obligatoire : c'est l'ouverture précise que ce
 * marqueur clôt. `response_event_id` et `session_id` sont structurellement
 * absents — rien n'a été atteint, et rien n'a répondu.
 */
export interface NativeHandoffAbortedEvent extends NativeEventBase {
  readonly type: 'handoff_aborted_before_interactive';
  readonly target_expert_slot_id: ExpertSlotId;
  readonly started_event_id: string;
  readonly reason: 'PRE_INTERACTIVE_ABORTED';
}

/**
 * Handoff d'étendue inconnue, acquitté — **un slot, aucune conclusion**.
 *
 * L'événement n'affirme ni que l'interaction a démarré, ni qu'elle s'est
 * terminée, ni qu'aucun message n'a été échangé, ni que la session native est
 * inchangée, ni qu'un client externe survivant est arrêté, ni que le coût est
 * connu.
 */
export interface NativeHandoffUncertaintyEvent extends NativeEventBase {
  readonly type: 'handoff_uncertainty_acknowledged';
  readonly target_expert_slot_id: ExpertSlotId;
  readonly started_event_id: string;
  readonly reason: 'IN_FLIGHT_UNCERTAIN';
}

/**
 * Tentative de transfert close avant tout appel — **bi-slot, sans réponse**.
 *
 * `response_event_id` est structurellement absent : rien n'a été appelé, donc
 * rien n'a répondu. La source reste transférable, et ce marqueur ne la met pas
 * en quarantaine — c'est précisément ce qui le sépare d'un acquittement
 * d'incertitude.
 */
export interface NativeTransferAbortedEvent extends NativeEventBase {
  readonly type: TransferAbortedEventType;
  readonly source_slot_id: ExpertSlotId;
  readonly target_slot_id: ExpertSlotId;
  readonly source_event_id: string;
  readonly reason: TransferAbortedReason;
}

export type NativeCcrEvent =
  | NativeExpertSessionEvent
  | NativeExpertTargetEvent
  | NativeTransferEvent
  | NativeTransferBlockedEvent
  | NativeTransferQuarantineEvent
  | NativeTransferAbortedEvent
  | NativeSendAbortedEvent
  | NativeSendUncertaintyEvent
  | NativeHandoffAbortedEvent
  | NativeHandoffUncertaintyEvent
  | NativeGenerationNeutralEvent;

type EventDraft<T> = T extends unknown
  ? Omit<T, 'event_id' | 'run_id' | 'timestamp'> & { readonly timestamp?: string }
  : never;

/** Événement tel que fourni par l'appelant ; le store attribue id/horodatage. */
export type NewNativeCcrEvent = EventDraft<NativeCcrEvent>;

/**
 * Garde de typage — les quatre classes de provenance partitionnent `EventType`.
 *
 * ```text
 * EXPERT_SESSION       expert_slot_id + session_id
 * EXPERT_TARGET        target_expert_slot_id
 * TRANSFER             source_slot_id + target_slot_id + response_event_id
 * TRANSFER_BLOCKED     source_slot_id + target_slot_id, sans appel
 * TRANSFER_QUARANTINED source_slot_id + target_slot_id, issue inconnue
 * TRANSFER_ABORTED     source_slot_id + target_slot_id, jamais appelé
 * SEND_RESOLUTION      target_expert_slot_id + prompt_event_id, sans réponse
 * HANDOFF_RESOLUTION   target_expert_slot_id + started_event_id, sans réponse
 * GENERATION_NEUTRAL   aucune identité, aucune session
 * ```
 *
 * Ajouter un type d'événement sans lui assigner de classe casse le `typecheck`
 * ici, plutôt que de le laisser tomber silencieusement dans la catégorie
 * neutre — où il pourrait porter une identité que personne ne validerait.
 */
type AssertNever<T extends never> = T;
export type EveryEventTypeHasAProvenance = AssertNever<
  Exclude<
    NativeEventType,
    | ExpertSessionEventType
    | ExpertTargetEventType
    | TransferEventType
    | TransferBlockedEventType
    | TransferQuarantineEventType
    | TransferAbortedEventType
    | SendResolutionEventType
    | HandoffResolutionEventType
    | GenerationNeutralEventType
  >
>;

// --------------------------------------------------------------------------
// Artefacts `rounds/` natifs
// --------------------------------------------------------------------------

/** `ROUND_SCHEMA_VERSION` observée : 1. */
export const NATIVE_ROUND_SCHEMA_VERSION = 2;

/**
 * Tour consigné dans un artefact de round.
 *
 * `expert_slot` est l'identité ; `provider` et `session_id` sont des faits
 * techniques de diagnostic, facultatifs, et sans autorité.
 */
export interface NativeRoundTurnRef {
  readonly expert_slot: ExpertSlotId;
  readonly prompt_event_id: string;
  readonly response_event_id: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly provider?: ProviderKind;
  readonly session_id?: string | null;
}

/**
 * Artefact de round natif — **toujours un passage de témoin**.
 *
 * Le micro-gate 1B.1 a établi que `rounds/` ne stocke pas START, et ne l'a
 * jamais stocké : V2 n'écrit d'artefact que depuis le chemin STEP
 * (`run-service.ts:882`), `rounds/0/` est impossible (`ids.ts:73`), et un seul
 * `metadata.json` existe par numéro — deux tours initiaux s'y écrasaient
 * silencieusement.
 *
 * La forme `initial_turn` a donc été retirée plutôt que réparée. Les deux
 * positions initiales sont déjà conservées canoniquement dans `events.jsonl` ;
 * leur inventer deux numéros de round aurait produit un état faux pour un
 * artefact qui n'est même pas canonique.
 *
 * Il n'y a plus d'union : un discriminant à une seule valeur ne discrimine
 * rien. La validation refuse explicitement `kind` et `expert_slot`, pour qu'une
 * tentative d'écrire un round initial échoue en disant pourquoi.
 */
export interface NativeRoundMetadata {
  readonly schema_version: number;
  readonly run_id: string;
  readonly round: number;
  readonly started_at: string;
  /** `null` seulement si le round n'a pas été mené à son terme. */
  readonly completed_at: string | null;
  readonly workspace_cwd: string;
  readonly source_slot: ExpertSlotId;
  readonly target_slot: ExpertSlotId;
  /** Liens diagnostiques vers le journal, qui reste la source canonique. */
  readonly source_event_id: string;
  readonly response_event_id: string | null;
  readonly turns: readonly NativeRoundTurnRef[];
}

