/**
 * Registre des opérations d'un hôte long-lived
 * (CCR V2 V0.2 §15.2 ; amendement d'implémentation V2-IMP-31).
 *
 * ## Problème corrigé — `CX2-002`
 *
 * Dans une CLI courte, « le PID propriétaire du verrou est vivant » approxime
 * correctement « une opération est en cours » : le processus ne fait qu'une
 * chose, et il meurt ensuite. Dans un serveur long-lived, le même PID survit à
 * des centaines d'opérations sur des dizaines de runs. L'égalité de PID ne
 * désigne alors plus **aucune** opération en particulier.
 *
 * ## Ce que ce registre est
 *
 * Une preuve **éphémère** de vivacité : les opérations que *ce* processus sait
 * avoir lancées et n'a pas encore terminées. Il répond à une seule question :
 *
 * > une opération connue de cet hôte est-elle actuellement associée à *ce*
 * > verrou exact ?
 *
 * ## Ce qu'il n'est pas
 *
 * - **non canonique** : en mémoire, jamais persisté, vide au démarrage, perdu
 *   au crash ;
 * - **indépendant** de `state.json`, de `pending_operation`, des événements et
 *   des futurs reçus ;
 * - **dépourvu de logique de récupération** : il ne répare rien, ne supprime
 *   aucun verrou, ne conclut rien sur le sort d'une opération ;
 * - **sans machine d'état** : aucune phase `QUEUED`/`STARTING`/`RECOVERING`.
 *   Une entrée existe ou n'existe pas.
 *
 * L'autorité de sérialisation reste le run lock, inchangé.
 */

import { randomUUID } from 'node:crypto';

/**
 * Opération connue de cet hôte.
 *
 * `hostOperationId` distingue deux opérations successives du même serveur sur
 * le même run — ce que `run_id + pid` ne fait pas.
 */
export interface HostOperation {
  readonly hostOperationId: string;
  readonly runId: string;
  /** Commande CCR, telle que passée au run lock. */
  readonly action: string;
  readonly startedAt: string;
  /**
   * `lock_id` du verrou **réellement acquis**.
   *
   * `null` tant que l'acquisition n'a pas abouti : une opération enregistrée
   * mais sans verrou ne prouve rien et n'est jamais une évidence d'activité.
   */
  readonly lockId: string | null;
}

export interface HostOperationRegistry {
  /** Déclare une intention. L'entrée ne prouve encore rien. */
  begin(runId: string, action: string): string;
  /** Associe l'opération au verrou effectivement obtenu. */
  bindLock(hostOperationId: string, lockId: string): void;
  /** Retire l'opération, quelle qu'ait été son issue. Idempotent. */
  end(hostOperationId: string): void;
  /**
   * Opération de cet hôte associée **exactement** à ce verrou.
   *
   * L'égalité porte sur `runId` **et** `lockId`. Une correspondance sur le seul
   * `runId` laisserait une nouvelle opération légitimer un verrou ancien.
   */
  find(runId: string, lockId: string): HostOperation | undefined;
  active(): readonly HostOperation[];
  size(): number;
}

export interface HostRegistryOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export function createHostOperationRegistry(options: HostRegistryOptions = {}): HostOperationRegistry {
  const now = options.now ?? ((): Date => new Date());
  const newId = options.newId ?? ((): string => randomUUID());
  const operations = new Map<string, HostOperation>();

  return {
    begin(runId: string, action: string): string {
      const hostOperationId = newId();
      operations.set(hostOperationId, {
        hostOperationId,
        runId,
        action,
        startedAt: now().toISOString(),
        lockId: null,
      });
      return hostOperationId;
    },

    bindLock(hostOperationId: string, lockId: string): void {
      const operation = operations.get(hostOperationId);
      // Une opération déjà retirée n'est jamais ressuscitée par un binding
      // tardif : ce serait rouvrir la fenêtre du faux « actif ».
      if (operation === undefined) return;
      operations.set(hostOperationId, { ...operation, lockId });
    },

    end(hostOperationId: string): void {
      operations.delete(hostOperationId);
    },

    find(runId: string, lockId: string): HostOperation | undefined {
      for (const operation of operations.values()) {
        if (operation.runId === runId && operation.lockId === lockId) return operation;
      }
      return undefined;
    },

    active(): readonly HostOperation[] {
      return [...operations.values()];
    },

    size(): number {
      return operations.size;
    },
  };
}
