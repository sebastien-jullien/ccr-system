/**
 * Classification de vivacité d'un run
 * (CCR V2 V0.2 §14 ; amendement d'implémentation V2-IMP-30).
 *
 * ## Défaut corrigé — `CLX2-A1`
 *
 * Le seul signal exposé par les services V1 est :
 *
 * ```text
 * requiresRecovery = state === 'WAITING_AGENT' || pending_operation !== null
 * ```
 *
 * Or `dispatchTurn` persiste **exactement ces deux conditions avant tout appel
 * agent**, et ne les efface qu'après journalisation de la réponse. C'est
 * l'invariant de reprise A-9, et il est correct. Mais il rend le prédicat vrai
 * pendant **chaque tour normal**, jusqu'à la durée du timeout fournisseur.
 *
 * En V1 la confusion était inoffensive : le processus CLI détenteur du verrou
 * était le seul lecteur *et* le seul écrivain, et ne s'interrogeait jamais
 * pendant son propre tour. Un cockpit rend les deux simultanés par
 * construction — il afficherait « récupération nécessaire » pendant une
 * opération parfaitement normale.
 *
 * ## Principe
 *
 * `requiresRecovery` répond à « une mutation peut-elle être émise ? ».
 * Il ne répond pas à « faut-il intervenir ? ».
 *
 * Répondre à la seconde question exige des faits **opérationnels externes**,
 * qui ne sont pas dans les fichiers canoniques : quelqu'un exécute-t-il
 * réellement cette opération en ce moment ? Ces faits sont fournis
 * explicitement (`RunExecutionEvidence`) et ne sont jamais devinés.
 *
 * ## Honnêteté du modèle
 *
 * Lorsque l'évidence disponible ne permet pas de trancher, la classification
 * est `UNDETERMINED`. Elle n'invente pas de conclusion, et surtout elle ne
 * prétend pas qu'une récupération est nécessaire. C'est une divergence assumée
 * avec la liste fermée de V0.2 §14.1, signalée à l'arbitrage.
 */

import type { PendingOperation, RunManifest, RunStateDocument } from './run.ts';

/**
 * Classification exposée au read model.
 *
 * `UNDETERMINED` s'ajoute à la liste de V0.2 §14.1 : voir l'en-tête.
 */
export const RUN_LIVENESS = [
  'NONE',
  'OPERATION_IN_FLIGHT',
  'PARTIAL_INITIALIZATION',
  'ABANDONED_OPERATION',
  'AMBIGUOUS',
  'ORPHAN_LOCK',
  'UNDETERMINED',
] as const;

export type RunLiveness = (typeof RUN_LIVENESS)[number];

/**
 * Ce que le lecteur sait du **monde extérieur** aux fichiers canoniques.
 *
 * Aucun champ n'est deviné : un appelant qui ignore un fait le déclare
 * `UNKNOWN`, et la classification en tient compte.
 */
export interface RunExecutionEvidence {
  /**
   * Verrou de run observé.
   *
   * `ALIVE_OTHER_PROCESS`  un autre processus vivant détient le run ;
   * `ALIVE_THIS_PROCESS`   le verrou porte le PID du lecteur lui-même ;
   * `STALE`                le propriétaire local a disparu ;
   * `FOREIGN_HOST`         posé depuis un autre hôte, statut indéterminable ;
   * `ABSENT`               aucun verrou ;
   * `UNKNOWN`              le lecteur n'a pas observé le verrou.
   */
  readonly lock:
    | 'ABSENT'
    | 'ALIVE_OTHER_PROCESS'
    | 'ALIVE_THIS_PROCESS'
    | 'STALE'
    | 'FOREIGN_HOST'
    | 'UNKNOWN';
  /**
   * Le processus courant exécute-t-il lui-même une opération sur ce run ?
   *
   * Réponse du registre mémoire de l'hôte long-lived. En 0C aucun registre
   * n'existe : la valeur est `UNKNOWN`, et c'est ce qui rend `ALIVE_THIS_PROCESS`
   * indécidable. Le registre réel appartient au Slice 0D.
   */
  readonly hostOperation: 'ACTIVE' | 'NONE' | 'UNKNOWN';
  /**
   * Le verrou observé peut-il être celui de l'opération persistée ?
   *
   * Un verrou vivant démontre qu'**une** opération CCR détient le run. Il ne
   * démontre pas que c'est **celle-ci** : une CLI peut fort bien venir
   * d'acquérir le verrou pour une autre action pendant qu'un
   * `pending_operation` ancien et abandonné traîne dans `state.json`.
   *
   * `NO` ferme donc explicitement la conclusion « en vol » (V2-IMP-31).
   */
  readonly pendingCoveredByLock: 'YES' | 'NO' | 'UNKNOWN';
}

/** Évidence d'un lecteur qui n'observe rien : le cas le plus prudent. */
export const NO_EVIDENCE: RunExecutionEvidence = {
  lock: 'UNKNOWN',
  hostOperation: 'UNKNOWN',
  pendingCoveredByLock: 'UNKNOWN',
};

export interface LivenessFacts {
  readonly manifest: RunManifest;
  readonly state: RunStateDocument;
  /**
   * Une réponse d'agent est-elle déjà journalisée pour l'opération en vol ?
   *
   * Fait canonique décisif : il distingue une opération **finalisable de façon
   * déterministe** — CCR possède déjà le contenu — d'une opération dont le sort
   * est inconnu. C'est exactement la distinction que fait `ccr recover`.
   */
  readonly pendingResponseJournaled: boolean;
}

export interface LivenessVerdict {
  readonly liveness: RunLiveness;
  /** Ce qui a décidé, en clair et sans texte d'interface. */
  readonly basis: LivenessBasis;
  readonly pendingOperation: PendingOperation | null;
}

export type LivenessBasis =
  | 'NO_PENDING_WORK'
  | 'RECOVERY_MATERIALIZED'
  | 'PARTIAL_SESSIONS'
  | 'LOCK_HELD_BY_OTHER_PROCESS'
  | 'HOST_REGISTRY_ACTIVE'
  | 'NO_LIVE_OWNER_RESPONSE_JOURNALED'
  | 'NO_LIVE_OWNER_NO_RESPONSE'
  | 'STALE_LOCK_OBSERVED'
  | 'LOCK_THIS_PROCESS_WITHOUT_HOST_OPERATION'
  | 'EVIDENCE_INSUFFICIENT';

function verdict(
  liveness: RunLiveness,
  basis: LivenessBasis,
  pendingOperation: PendingOperation | null,
): LivenessVerdict {
  return { liveness, basis, pendingOperation };
}

/** Sessions natives que le manifest ne porte pas encore. */
function sessionsMissing(manifest: RunManifest): number {
  return (
    (manifest.agents.claude.session_id === null ? 1 : 0) +
    (manifest.agents.codex.session_id === null ? 1 : 0)
  );
}

/**
 * Classe la situation d'un run.
 *
 * **Ne consulte jamais `requiresRecovery`** : ce prédicat mélange précisément
 * les deux situations que cette fonction doit séparer.
 */
export function classifyRunLiveness(
  facts: LivenessFacts,
  evidence: RunExecutionEvidence = NO_EVIDENCE,
): LivenessVerdict {
  const pending = facts.state.pending_operation;
  const state = facts.state.state;

  // 1. Ambiguïté déjà matérialisée par CCR lui-même : fait canonique, aucune
  //    évidence externe ne peut le contredire.
  if (state === 'RECOVERY_REQUIRED') {
    return verdict('AMBIGUOUS', 'RECOVERY_MATERIALIZED', pending);
  }

  // 2. Initialisation incomplète et récupérable : constatable sur les seuls
  //    faits canoniques.
  //
  //    Le prédicat portait « exactement une session présente », et la vivacité
  //    répondait alors à « est-ce *partiel* ? » plutôt qu'à sa question
  //    déclarée : « faut-il intervenir ? ». Un run dont les deux sessions
  //    manquaient — l'échec du premier agent, cas nominal — était classé
  //    `NONE`, donc sans attention humaine, et `planRecovery` masquait la
  //    capacité que `planCanonicalRecovery` produisait déjà. Le service, lui,
  //    l'exécutait (V2.1-REPAIR, zéro-session).
  //
  //    `PARTIAL_INITIALIZATION` conserve son nom : c'est un statut de vivacité
  //    — initialisation incomplète, récupérable — et non un compte littéral de
  //    sessions. `PARTIAL_SESSIONS` reste sa base, valeur publique du contrat.
  if (state === 'FAILED_INITIALIZATION' && sessionsMissing(facts.manifest) > 0) {
    return verdict('PARTIAL_INITIALIZATION', 'PARTIAL_SESSIONS', pending);
  }

  // 3. Aucun travail en vol persisté : rien à signaler. Un verrou éventuel
  //    n'est alors qu'une opération courte, pas une situation à traiter.
  if (state !== 'WAITING_AGENT' && pending === null) {
    return verdict('NONE', 'NO_PENDING_WORK', null);
  }

  // ------------------------------------------------------------------
  // À partir d'ici : le disque porte un travail engagé. Les faits canoniques
  // seuls ne peuvent PAS dire s'il est en cours ou abandonné — c'est
  // exactement le défaut CLX2-A1. L'évidence tranche, ou rien ne tranche.
  // ------------------------------------------------------------------

  // 4. Preuve positive d'activité.
  //
  // Elle exige DEUX choses : qu'une opération soit démontrée vivante, et que
  // l'opération persistée que nous observons puisse être celle-là. Un verrou
  // vivant portant une autre action, ou postérieur à l'opération persistée,
  // prouve qu'un travail est en cours — pas que c'est celui-ci (V2-IMP-31).
  if (evidence.pendingCoveredByLock !== 'NO') {
    if (evidence.hostOperation === 'ACTIVE') {
      return verdict('OPERATION_IN_FLIGHT', 'HOST_REGISTRY_ACTIVE', pending);
    }
    if (evidence.lock === 'ALIVE_OTHER_PROCESS' && evidence.pendingCoveredByLock === 'YES') {
      return verdict('OPERATION_IN_FLIGHT', 'LOCK_HELD_BY_OTHER_PROCESS', pending);
    }
  }

  // Un verrou vivant qui ne peut pas être celui de l'opération observée
  // interdit toute conclusion : ni « en vol », ni « abandonnée ».
  if (evidence.lock === 'ALIVE_OTHER_PROCESS' || evidence.hostOperation === 'ACTIVE') {
    return verdict('UNDETERMINED', 'EVIDENCE_INSUFFICIENT', pending);
  }

  // 5. Verrou périmé : le propriétaire a disparu. Le verrou lui-même appelle
  //    une décision humaine, distincte du sort de l'opération.
  if (evidence.lock === 'STALE') {
    return verdict('ORPHAN_LOCK', 'STALE_LOCK_OBSERVED', pending);
  }

  // 6. Verrou portant le PID du lecteur, sans opération connue de l'hôte.
  //    Décidable seulement avec un registre : c'est le Slice 0D.
  if (evidence.lock === 'ALIVE_THIS_PROCESS') {
    return evidence.hostOperation === 'NONE'
      ? verdict('ORPHAN_LOCK', 'LOCK_THIS_PROCESS_WITHOUT_HOST_OPERATION', pending)
      : verdict('UNDETERMINED', 'EVIDENCE_INSUFFICIENT', pending);
  }

  // 7. Aucun propriétaire vivant : l'opération est abandonnée. Reste à savoir
  //    si CCR possède déjà son résultat.
  if (evidence.lock === 'ABSENT') {
    return facts.pendingResponseJournaled
      ? verdict('ABANDONED_OPERATION', 'NO_LIVE_OWNER_RESPONSE_JOURNALED', pending)
      : verdict('AMBIGUOUS', 'NO_LIVE_OWNER_NO_RESPONSE', pending);
  }

  // 8. `FOREIGN_HOST` ou `UNKNOWN` : le lecteur ne sait pas, et le dit.
  return verdict('UNDETERMINED', 'EVIDENCE_INSUFFICIENT', pending);
}

/**
 * Une classification appelle-t-elle une action humaine ?
 *
 * `OPERATION_IN_FLIGHT` relève de la vie normale du run : il n'apparaît jamais
 * comme un incident (V0.2 INV-20-10). `UNDETERMINED` non plus — ne pas savoir
 * n'est pas un incident constaté.
 */
export function needsHumanAttention(liveness: RunLiveness): boolean {
  return (
    liveness === 'PARTIAL_INITIALIZATION' ||
    liveness === 'ABANDONED_OPERATION' ||
    liveness === 'AMBIGUOUS' ||
    liveness === 'ORPHAN_LOCK'
  );
}
