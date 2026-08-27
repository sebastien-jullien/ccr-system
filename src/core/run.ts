/**
 * Modèle canonique d'un run CCR (spécification V0.2, §9, §11, §12, §17, §41).
 *
 * Séparation stricte (amendement A-4) :
 *
 *   manifest.json  → identité et configuration relativement stables
 *   state.json     → état mutable courant
 *
 * Aucune donnée mutable n'est dupliquée entre les deux documents.
 *
 * Ce modèle ignore totalement les formats natifs Claude et Codex : il ne
 * manipule que du texte et des identifiants opaques.
 */

import type { ControlOwner, RunState } from './state.ts';

/**
 * Les deux agents de la V1. Déclaré ici, dans le noyau : le modèle canonique
 * ne dépend pas de la couche adapter.
 */
export type AgentKind = 'claude' | 'codex';

export const MANIFEST_SCHEMA_VERSION = 1;
/** Version du snapshot runtime, indépendante de celle du manifest (§14.0). */
export const RUNTIME_CONFIG_SCHEMA_VERSION = 1;
/** Version 2 : ajout de `pending_operation` (amendement A-9). */
export const STATE_SCHEMA_VERSION = 2;
/** Versions de `state.json` encore lisibles. */
export const SUPPORTED_STATE_SCHEMA_VERSIONS: readonly number[] = [1, 2];
export const ROUND_SCHEMA_VERSION = 1;

/** Les rôles sont inversables d'un run à l'autre (doctrine V0.3, §14). */
export type AgentRole = 'author' | 'challenger';

export interface AgentManifestEntry {
  /** Identifiant natif. `null` tant que la session n'existe pas. */
  readonly session_id: string | null;
  readonly role: AgentRole;
}

/** Statut d'authentification observé au preflight. Copie fermée du vocabulaire probe. */
export type RuntimeAuthPreflight = 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'UNKNOWN';

/**
 * Origine de la valeur effective au moment de la capture.
 *
 * **Historique et descriptif.** Ce champ répond à une seule question : d'où
 * venait la valeur lorsque le snapshot initial du run a été pris ? Il ne
 * détermine jamais le comportement exécutable, et n'est pas réécrit lorsqu'un
 * humain modifie la valeur par la suite — c'est l'événement
 * `runtime_config_changed` qui documente un tel override.
 */
export type RuntimeConfigSource = 'default' | 'config' | 'legacy-env';

/**
 * Configuration d'exécution figée à la création d'un run V1.1 (§14).
 *
 * Deux natures de champs, à ne pas confondre :
 *
 *  - `cli_version` et `auth_preflight` sont **descriptifs** : ils décrivent le
 *    contexte observé au démarrage. Ils ne figent aucun exécutable et ne
 *    conditionnent aucune exécution ultérieure ;
 *  - `skip_git_repo_check` est **exécutable** : il gouverne réellement les
 *    invocations Codex du run, pour toute sa durée de vie.
 *
 * Ne contient jamais de credential, d'adresse e-mail, d'organisation, d'account
 * ID ni de sortie fournisseur (§23.4, INV-11-20).
 */
export interface RunRuntimeConfig {
  readonly schema_version: number;
  readonly captured_at: string;
  readonly claude: {
    readonly cli_version: string | null;
    readonly auth_preflight: RuntimeAuthPreflight;
  };
  readonly codex: {
    readonly cli_version: string | null;
    readonly auth_preflight: RuntimeAuthPreflight;
    /** **Seule autorité exécutable** du run pour l'invocation de Codex. */
    readonly skip_git_repo_check: boolean;
    /** Descriptif, historique, immuable. Jamais consulté pour exécuter. */
    readonly source_at_capture: RuntimeConfigSource;
  };
}

export interface RunManifest {
  readonly schema_version: number;
  readonly run_id: string;
  readonly title: string;
  readonly created_at: string;
  /** Répertoire de travail canonique depuis lequel les deux agents sont lancés. */
  readonly workspace: { readonly cwd: string };
  readonly agents: {
    readonly claude: AgentManifestEntry;
    readonly codex: AgentManifestEntry;
  };
  /**
   * Snapshot V1.1. Absent sur un run V1 historique, qui reste lisible et
   * exécutable et n'est jamais réécrit pour l'acquérir (§14.0, INV-11-09).
   */
  readonly runtime_config?: RunRuntimeConfig;
}

/**
 * Marqueur d'incertitude (§32).
 *
 * Présent lorsque CCR ne peut pas affirmer ce qui s'est réellement produit.
 * Sa présence interdit toute reprise automatique aveugle.
 */
export interface RunUncertainty {
  readonly reason: string;
  readonly since: string;
  readonly agent: AgentKind | null;
  /** Dernier événement connu avant l'ambiguïté. */
  readonly last_event_id: string | null;
}

/** Nature de l'opération en vol (amendement A-9). */
export type PendingOperationKind = 'initialization' | 'send' | 'step' | 'handoff';

/**
 * Contexte minimal d'une opération engagée, persisté **avant** tout lancement
 * de processus agent.
 *
 * Il rend la reprise déterministe : après un crash, `control = HUMAN` ne dit
 * pas s'il fallait restaurer `PAUSED` ou `WAITING_HUMAN`. Deviner à partir du
 * texte des événements serait fragile.
 *
 * Ce n'est pas un moteur de transactions : uniquement ce qui est nécessaire.
 */
export interface PendingOperation {
  readonly kind: PendingOperationKind;
  readonly agent: AgentKind;
  readonly round: number;
  /** Événement CCR portant l'intention (prompt, ou début de handoff). */
  readonly prompt_event_id: string | null;
  /** Événement source d'un passage de témoin, le cas échéant. */
  readonly source_event_id: string | null;
  readonly session_id: string | null;
  readonly return_state: RunState;
  readonly return_control: ControlOwner;
  readonly started_at: string;
}

export interface RunStateDocument {
  readonly schema_version: number;
  readonly run_id: string;
  readonly state: RunState;
  readonly control: ControlOwner;
  readonly round: number;
  /** Agent dont un tour est en vol, le cas échéant. */
  readonly active_agent: AgentKind | null;
  readonly last_event_id: string | null;
  /**
   * Opération engagée non terminée. Sa présence au rechargement **est** le
   * signal d'ambiguïté : le processus précédent est mort en cours d'opération.
   */
  readonly pending_operation: PendingOperation | null;
  readonly uncertainty: RunUncertainty | null;
  readonly updated_at: string;
}

// --------------------------------------------------------------------------
// Journal d'événements
// --------------------------------------------------------------------------

/** Provenance obligatoire de tout événement (§4.4 des instructions dépôt). */
export const EVENT_ACTORS = ['human', 'claude', 'codex', 'system', 'evidence'] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

/** Types initiaux (§12), complétés par `state_changed` (amendement A-5). */
export const EVENT_TYPES = [
  'run_created',
  'session_created',
  'prompt_sent',
  'assistant_response',
  'human_message',
  'human_handoff_started',
  'human_handoff_finished',
  'control_changed',
  'state_changed',
  'round_started',
  'round_completed',
  'decision_recorded',
  'process_failed',
  'run_paused',
  'run_resumed',
  'run_completed',
  /** Mutation humaine explicite du snapshot runtime (§15.7, INV-11-19). */
  'runtime_config_changed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface CcrEvent {
  readonly event_id: string;
  readonly run_id: string;
  readonly round: number;
  readonly timestamp: string;
  readonly actor: EventActor;
  readonly type: EventType;
  /** Session native concernée, si l'événement en vise une. */
  readonly session_id?: string | null;
  /** Contenu textuel intégral, jamais résumé par CCR (§26). */
  readonly content?: string | null;
  readonly exit_code?: number | null;
  readonly target?: AgentKind | null;
  /** Provenance : événements dont celui-ci dérive. */
  readonly based_on?: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Événement tel que fourni par l'appelant ; le store attribue id/horodatage. */
export type NewCcrEvent = Omit<CcrEvent, 'event_id' | 'run_id' | 'timestamp'> & {
  readonly timestamp?: string;
};

// --------------------------------------------------------------------------
// Journal de décisions
// --------------------------------------------------------------------------

/** La gestion complète de la supersession appartient à une version ultérieure (§17). */
export type DecisionStatus = 'ACTIVE';

export interface CcrDecision {
  readonly decision_id: string;
  readonly run_id: string;
  readonly round: number;
  readonly timestamp: string;
  readonly author: 'human';
  readonly status: DecisionStatus;
  readonly content: string;
}

export type NewCcrDecision = Omit<CcrDecision, 'decision_id' | 'run_id' | 'timestamp'> & {
  readonly timestamp?: string;
};

// --------------------------------------------------------------------------
// Rounds
// --------------------------------------------------------------------------

export interface RoundTurnRef {
  readonly agent: AgentKind;
  readonly prompt_event_id: string;
  readonly response_event_id: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

export interface RoundMetadata {
  readonly schema_version: number;
  readonly run_id: string;
  readonly round: number;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly workspace_cwd: string;
  readonly turns: readonly RoundTurnRef[];
}
