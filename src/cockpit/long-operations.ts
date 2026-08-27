/**
 * Admission des opérations longues du cockpit (V0.2 §20 ; V2-IMP-38).
 *
 * ## Ce que ce composant est
 *
 * Une **barrière de transport**, et rien d'autre :
 *
 * ```text
 * admission     au plus 2 opérations agent simultanées, tous runs confondus
 * incertitude   les opérations dont le reçu n'a pas pu être finalisé
 * drain         barrière d'arrêt, pour ne pas relâcher server.lock trop tôt
 * ```
 *
 * ## Ce qu'il n'est pas
 *
 * Ni machine d'état CCR, ni file d'attente, ni ordonnanceur, ni source de
 * vivacité, ni autorité canonique. La vivacité d'un run reste établie par
 * `HostOperationRegistry`, qui associe une opération à un **`lock_id` exact** ;
 * une entrée active ici ne prouve rien sur un run donné.
 *
 * ## Pourquoi aucune file
 *
 * Une file transformerait un refus immédiat en attente indéterminée : le
 * troisième appelant croirait son action acceptée alors qu'elle dépend d'un
 * fournisseur qui peut ne jamais répondre. Le refus est rendu **avant** que
 * l'une des deux opérations en cours ne se termine — c'est une propriété
 * testable, et elle l'est.
 *
 * ## Atomicité
 *
 * `admit` est **synchrone**. C'est ce qui rend la réservation atomique sur la
 * boucle d'événements : aucun `await` ne s'intercale entre la vérification du
 * quota et la réservation, donc aucun entrelacement ne peut produire un
 * troisième créneau.
 */

import { CcrError } from '../core/errors.ts';

/** Plafond normatif de V0.2 §20. Partagé par `STEP` et `SEND`, tous runs confondus. */
export const MAX_CONCURRENT_LONG_OPERATIONS = 2;

export interface LongOperationSlot {
  readonly operationId: string;
  /** Idempotent : un double relâchement ne libère pas deux créneaux. */
  release(): void;
}

export interface LongOperationManager {
  admit(operationId: string): LongOperationSlot;
  activeCount(): number;
  /**
   * Nombre total de tentatives d admission, refus compris.
   *
   * Existe pour éprouver la **cause** et non sa conséquence : une mutation
   * courte, un duplicata déjà en vol ou une requête invalide ne doivent pas
   * seulement échouer à occuper un créneau — ils ne doivent pas même demander.
   */
  admitAttempts(): number;
  activeOperationIds(): readonly string[];
  /** Reçu terminal non écrit : l'opération devient incertaine pour cette instance. */
  markUncertain(operationId: string): void;
  isUncertain(operationId: string): boolean;
  /** Cesse d'admettre. Les opérations en cours continuent. */
  beginShutdown(): void;
  isShuttingDown(): boolean;
  /** Barrière d'arrêt : résout quand plus aucune opération ne peut muter. */
  drain(): Promise<void>;
}

export function createLongOperationManager(
  limit: number = MAX_CONCURRENT_LONG_OPERATIONS,
): LongOperationManager {
  const active = new Set<string>();
  const uncertain = new Set<string>();
  const waiters: (() => void)[] = [];
  let shuttingDown = false;
  let attempts = 0;

  const settle = (): void => {
    if (active.size > 0) return;
    while (waiters.length > 0) waiters.shift()?.();
  };

  return {
    admit(operationId: string): LongOperationSlot {
      attempts += 1;
      if (shuttingDown) {
        throw new CcrError(
          'COCKPIT_SHUTTING_DOWN',
          "Le cockpit s'arrête : aucune nouvelle opération agent n'est acceptée.",
        );
      }
      // Réutiliser un créneau déjà détenu n'en consomme pas un second : une
      // retransmission de la même opération ne doit pas peser sur le quota.
      if (!active.has(operationId) && active.size >= limit) {
        throw new CcrError(
          'COCKPIT_BUSY',
          `Le cockpit exécute déjà ${String(limit)} opérations agent. Aucune file d'attente n'est constituée.`,
          { details: { limit, active: active.size } },
        );
      }
      active.add(operationId);

      let released = false;
      return {
        operationId,
        release(): void {
          if (released) return;
          released = true;
          active.delete(operationId);
          settle();
        },
      };
    },
    activeCount: () => active.size,
    admitAttempts: () => attempts,
    activeOperationIds: () => [...active],
    markUncertain(operationId: string): void {
      uncertain.add(operationId);
    },
    isUncertain: (operationId: string) => uncertain.has(operationId),
    beginShutdown(): void {
      shuttingDown = true;
      settle();
    },
    isShuttingDown: () => shuttingDown,
    drain(): Promise<void> {
      if (active.size === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
