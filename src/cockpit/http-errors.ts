/**
 * Mapper public d'erreurs — allowlist fermée (V0.2 §23.4, §24).
 *
 * ## Ce que ce module empêche
 *
 * Les erreurs internes de CCR sont riches, et c'est exactement le problème :
 * `CcrError.details` des adapters contient la ligne de commande complète et un
 * extrait de sortie fournisseur ; les erreurs de verrou contiennent le nom
 * d'hôte et le PID. Rien de tout cela ne franchit la frontière HTTP.
 *
 * La traduction est donc une **allowlist** : un code absent de la table ne
 * devient pas « son meilleur équivalent », il devient `INTERNAL_ERROR`. Une
 * erreur nouvelle est ainsi invisible plutôt qu'indiscrète, et le test de
 * fermeture de la table le vérifie.
 *
 * ```text
 * jamais sérialisés   details · cause · stack · argv · stderr fournisseur
 *                     nom d'hôte · pid · secret de session · chemin interne
 * ```
 *
 * ## Divergences assumées avec §23.4, consignées en V2-IMP-35
 *
 * 1. **401 pour la session.** §23.4 range « Origin/Host/session refusés » en
 *    `403`. Le Slice 2 distingue les deux : `401` quand le navigateur n'a pas
 *    encore visité `/` — une situation *réparable par le client* —, `403`
 *    quand l'autorité annoncée est refusée — une situation qui ne se répare
 *    pas en réessayant.
 * 2. **405** n'existe pas dans §23.4, qui suppose des routes mutantes. Le
 *    Slice 2 n'en a aucune : toute méthode mutante est refusée en amont.
 * 3. **`SNAPSHOT_UNSTABLE` → 503**, transitoire et réessayable ; **corruption
 *    stable → 422**, qui ne se répare pas par un réessai. Confondre les deux
 *    ferait promettre au cockpit une reprise qui n'arrivera jamais, ou
 *    déclarer corrompu un run parfaitement sain en cours d'écriture.
 */

import { isCcrError } from '../core/errors.ts';
import type { CcrErrorCode } from '../core/errors.ts';

/** Codes propres au transport, sans équivalent dans le cœur. */
export type TransportErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_HOST'
  | 'METHOD_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export type PublicErrorCode = CcrErrorCode | TransportErrorCode;

export interface PublicErrorBody {
  readonly error: {
    readonly code: PublicErrorCode;
    readonly message: string;
  };
}

export interface PublicError {
  readonly status: number;
  readonly body: PublicErrorBody;
}

interface PublicMapping {
  readonly status: number;
  readonly message: string;
}

/**
 * Table fermée. Un code CCR absent d'ici ne franchit pas la frontière HTTP.
 *
 * Les messages sont écrits pour un humain, en français, sans détail technique :
 * le `code` reste la clé de diagnostic partagée avec la CLI (§24.3).
 */
const PUBLIC_ERRORS: Partial<Record<CcrErrorCode, PublicMapping>> = {
  // --- 400 : la requête elle-même est invalide ---
  INVALID_ARGUMENT: { status: 400, message: 'Requête invalide.' },

  // --- 404 ---
  RUN_NOT_FOUND: { status: 404, message: "Ce run n'existe pas." },

  // --- 409 : conflit sur une vue ou un verrou ---
  STALE_REVISION: {
    status: 409,
    message: "La vue a changé depuis l'émission de ce curseur. Rechargez la page.",
  },
  RUN_ALREADY_LOCKED: { status: 409, message: 'Une autre opération utilise actuellement ce run.' },
  STALE_LOCK: { status: 409, message: 'Ce run porte un verrou dont le propriétaire a disparu.' },
  LOCK_PUBLICATION_FAILED: {
    status: 422,
    message: 'Le verrou de ce run n a pas pu etre publie sur ce systeme de fichiers. Aucun verrou n a ete pose.',
  },

  // --- 422 : l'entité référencée n'est pas exploitable en l'état ---
  //
  // Refus métier atteignables par les mutations courtes du Slice 4. Les codes
  // propres à `STEP`/`SEND` — `NO_TRANSFERABLE_SOURCE`, `SESSION_MISSING`… —
  // restent délibérément non publiés : aucune route ne peut les produire
  // aujourd'hui, et publier un code inatteignable serait une promesse.
  RUN_NOT_PAUSABLE: { status: 422, message: 'Ce run ne peut pas être suspendu dans son état actuel.' },
  RUN_NOT_RESUMABLE: {
    status: 422,
    message: 'Ce run ne peut pas être rendu à l’automatisation dans son état actuel.',
  },
  AUTOMATION_NOT_IN_CONTROL: { status: 422, message: 'L’automatisation ne détient pas le contrôle de ce run.' },
  ILLEGAL_STATE_TRANSITION: { status: 422, message: 'Cette transition est interdite dans l’état actuel.' },
  RECOVERY_REQUIRED: { status: 422, message: 'Ce run porte une ambiguïté non résolue.' },
  MANIFEST_INVALID: { status: 422, message: "Le manifeste de ce run n'est pas exploitable." },
  STATE_INVALID: { status: 422, message: "L'état de ce run n'est pas exploitable." },
  JOURNAL_INVALID: { status: 422, message: "Le journal de ce run n'est pas exploitable." },
  SCHEMA_VERSION_UNSUPPORTED: {
    status: 422,
    message: 'Ce run utilise un schéma que cette version de CCR ne sait pas lire.',
  },

  // --- Mutations courtes (Slice 4) ---
  /** CSRF : l'origine annoncée n'est pas l'origine canonique du cockpit. */
  INVALID_ORIGIN: { status: 403, message: 'Origine de la requête refusée.' },
  /** Même clé, autre intention : c'est un défaut du client, pas du run. */
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    message: "Cette clé d'idempotence a déjà servi pour une autre opération.",
  },
  OPERATION_NOT_FOUND: { status: 404, message: "Cette opération n'existe pas." },
  /**
   * Corruption du store d'idempotence : surtout pas réessayable.
   *
   * Un `503` inviterait à retenter, et une retransmission après corruption est
   * précisément ce qui pourrait produire un second effet.
   */
  OPERATION_STORE_CORRUPT: {
    status: 422,
    message: "Le journal d'idempotence du cockpit est illisible. Aucune action n'a été effectuée.",
  },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Requête trop volumineuse.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Type de contenu non pris en charge.' },

  // --- Refus et échecs atteignables par les opérations longues (Slice 5) ---
  //
  // Publiés parce qu'ils peuvent désormais survenir : un `step`/`send` traverse
  // une CLI fournisseur. Le code reste la clé de diagnostic partagée avec la
  // CLI ; aucun détail — argv, sortie, chemin — ne l'accompagne.
  NO_TRANSFERABLE_SOURCE: { status: 422, message: 'Aucune réponse d agent n est transférable dans ce run.' },
  SOURCE_ALREADY_TRANSFERRED: {
    status: 422,
    message: 'La dernière réponse a déjà servi de source à un passage de témoin.',
  },
  PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER: {
    status: 422,
    message: 'Le transfert dépasse le garde-fou automatique : l humain décide de la suite.',
  },
  SESSION_MISSING: { status: 422, message: 'Cet agent n a pas encore de session native dans ce run.' },
  AGENT_TIMEOUT: { status: 504, message: 'L agent n a pas répondu dans le délai imparti.' },
  AGENT_EXIT_NONZERO: { status: 422, message: 'La CLI de l agent s est terminée en erreur.' },
  AGENT_OUTPUT_UNPARSABLE: { status: 422, message: 'La sortie de l agent n est pas analysable.' },
  AGENT_OUTPUT_INCOMPLETE: { status: 422, message: 'Le tour de l agent ne s est pas terminé.' },
  AGENT_SESSION_ID_MISSING: { status: 422, message: 'L agent n a pas rendu d identifiant de session.' },
  AGENT_RESULT_MISSING: { status: 422, message: 'Le tour n a produit aucun message exploitable.' },
  AGENT_SESSION_MISMATCH: { status: 422, message: 'La session reprise n est pas celle demandée.' },
  AGENT_REPORTED_ERROR: { status: 422, message: 'L agent a lui-même signalé un échec de tour.' },
  AGENT_EXECUTABLE_UNRESOLVED: { status: 422, message: 'Aucun exécutable lançable pour cet agent.' },
  AGENT_CLI_NOT_FOUND: { status: 422, message: 'Une CLI d agent requise est absente de ce poste.' },
  // --- Reprise : trois refus, trois causes distinctes ---
  RECOVERY_CAPABILITY_STALE: {
    status: 409,
    message: 'Les faits du run ont change depuis votre lecture. Rechargez la vue de reprise.',
  },
  RECOVERY_LOCK_CHANGED: {
    status: 409,
    message: 'Le verrou present n est plus celui que vous avez observe. Rien n a ete supprime.',
  },
  RECOVERY_LOCK_NOT_CLEARABLE: {
    status: 422,
    message: 'Ce verrou n est pas levable : vivant, etranger, indetermine ou absent.',
  },
  // L authentification d un fournisseur se prépare dans un terminal, jamais
  // depuis le web : le cockpit n ouvre aucun flux de connexion, et se contente
  // de nommer le geste que l humain doit faire lui-même.
  AUTH_REQUIRED: {
    status: 422,
    message: 'Un agent n est pas authentifié. Préparez la connexion dans un terminal avec `ccr setup`.',
  },
  EXECUTABLE_NOT_FOUND: { status: 422, message: 'Exécutable introuvable.' },
  PROCESS_LAUNCH_FAILED: { status: 422, message: 'Le lancement du processus a échoué.' },

  // --- 503 : indisponibilité transitoire, réessayable ---
  //
  // Le quota est transitoire par nature — un créneau se libérera. Mais rien
  // n est réessayé automatiquement : reprendre l action est une décision
  // humaine, avec une nouvelle tentative.
  COCKPIT_BUSY: {
    status: 503,
    message: 'Le cockpit exécute déjà deux opérations agent. Aucune file d attente n est constituée.',
  },
  COCKPIT_SHUTTING_DOWN: { status: 503, message: 'Le cockpit s arrête : aucune nouvelle opération agent.' },
  SNAPSHOT_UNSTABLE: {
    status: 503,
    message: 'Le run est en cours de modification. Réessayez dans un instant.',
  },

  // --- Configuration, lecture seule ---
  CONFIG_READ_FAILED: { status: 422, message: "La configuration locale n'a pas pu être lue." },
  CONFIG_INVALID: { status: 422, message: "La configuration locale n'est pas valide." },
  CONFIG_SCHEMA_UNSUPPORTED: {
    status: 422,
    message: 'La configuration locale utilise un schéma inconnu de cette version.',
  },

  // --- Refus métier V2.1 (V2.1-IMP-17B) ---
  //
  // Publiés ici parce qu'ils sont déjà produits par les moteurs natifs, et que
  // les laisser hors table les faisait tomber en `500 INTERNAL_ERROR` — avec
  // leur code remplacé. Un refus métier n'est pas une erreur interne, et le
  // cockpit ne doit pas transformer « votre alias désigne deux experts » en
  // « erreur interne du cockpit ».
  //
  // `422` sans exception : ce sont des refus stables, constatés avant tout
  // effet, et qu'aucune nouvelle tentative identique ne changerait.
  AMBIGUOUS_PROVIDER_ALIAS: {
    status: 422,
    message: 'Les deux experts de ce run emploient ce moteur : l’alias ne désigne personne.',
  },
  PROVIDER_ALIAS_NOT_BOUND: {
    status: 422,
    message: 'Aucun expert de ce run n’emploie ce moteur.',
  },
  SOURCE_NOT_REPLAYABLE: {
    status: 422,
    message: 'Cette réponse a été engagée dans un transfert d’issue inconnue : elle n’est pas rejouée.',
  },
  SOURCE_STALE_AFTER_HANDOFF: {
    status: 422,
    message: 'La dernière position de cet expert précède une interaction native externe.',
  },
  HANDOFF_NOT_ALLOWED: {
    status: 422,
    message: 'Le handoff exige un run suspendu, sous contrôle humain.',
  },
  RECOVERY_EVIDENCE_CONFLICT: {
    status: 422,
    message: 'Des faits canoniques de ce run se contredisent : CCR ne choisit pas lequel est vrai.',
  },
  COMMAND_UNSUPPORTED_FOR_GENERATION: {
    status: 422,
    message: 'Cette commande n’existe pas pour la génération de ce run.',
  },

  // --- Gouvernance d'usage (V2.2-IMP-02) ---
  //
  // Atteignable par une mutation STEP : sans mapping, un échec connu de
  // persistance deviendrait un `500 INTERNAL_ERROR` avec son code remplacé.
  // `422`, comme les autres pannes de l'environnement local : la requête était
  // bien formée, et aucun réessai identique ne la ferait aboutir.
  INVOCATION_LEDGER_WRITE_FAILED: {
    status: 422,
    message:
      'CCR n’a pas pu enregistrer l’engagement de cet appel. Aucun agent n’a été sollicité.',
  },
};

const TRANSPORT_ERRORS: Record<TransportErrorCode, PublicMapping> = {
  UNAUTHENTICATED: {
    status: 401,
    message: "Session absente ou périmée. Ouvrez d'abord la page du cockpit.",
  },
  INVALID_HOST: { status: 403, message: 'Hôte non autorisé.' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Cette méthode HTTP n’est pas autorisée.' },
  NOT_FOUND: { status: 404, message: 'Ressource inconnue.' },
  INTERNAL_ERROR: { status: 500, message: 'Erreur interne du cockpit.' },
};

/** Réponse publique pour un code de transport. */
export function transportError(code: TransportErrorCode): PublicError {
  const mapping = TRANSPORT_ERRORS[code];
  return { status: mapping.status, body: { error: { code, message: mapping.message } } };
}

/**
 * Traduit n'importe quelle valeur levée en réponse publique.
 *
 * Une valeur qui n'est pas une `CcrError`, ou dont le code n'est pas
 * explicitement publié, devient `INTERNAL_ERROR` : le cockpit ne devine pas.
 */
export function publicErrorFor(error: unknown): PublicError {
  if (!isCcrError(error)) return transportError('INTERNAL_ERROR');
  const mapping = PUBLIC_ERRORS[error.code];
  if (mapping === undefined) return transportError('INTERNAL_ERROR');
  return {
    status: mapping.status,
    body: { error: { code: error.code, message: mapping.message } },
  };
}

/** Codes CCR effectivement publiés. Sert au test de fermeture de la table. */
export function publishedCcrErrorCodes(): readonly CcrErrorCode[] {
  return Object.keys(PUBLIC_ERRORS) as CcrErrorCode[];
}

/**
 * Codes que la couche HTTP déclare **publics** — allowlist close.
 *
 * Tous les `CcrErrorCode` ne le sont pas, et c'est délibéré : certains décrivent
 * des situations internes qu'un navigateur n'a aucune raison de distinguer. Ce
 * qui doit être vrai, en revanche, c'est qu'un code déclaré public possède un
 * mapping — sans quoi il tomberait silencieusement en `500` avec son code
 * remplacé, ce qui est exactement le défaut que `IMP-17B` ferme.
 *
 * La liste est écrite ici, et le test compare les deux ensembles dans les
 * **deux** sens. Ajouter un mapping sans le déclarer public, ou l'inverse, est
 * une erreur de test, jamais une découverte en production.
 */
export const PUBLIC_CCR_ERROR_CODES: readonly CcrErrorCode[] = Object.freeze(
  Object.keys(PUBLIC_ERRORS) as CcrErrorCode[],
);

/** Vrai si et seulement si ce code possède une réponse publique. */
export function isPublicCcrErrorCode(code: CcrErrorCode): boolean {
  return PUBLIC_ERRORS[code] !== undefined;
}
