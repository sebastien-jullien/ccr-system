/**
 * Production de `RunExecutionEvidence` pour un hôte long-lived
 * (amendement d'implémentation V2-IMP-31).
 *
 * Ce module observe **deux** faits non canoniques — le verrou présent sur le
 * disque et le registre mémoire de l'hôte — et en tire l'évidence que la
 * classification de vivacité de 0C consomme.
 *
 * Il ne lit aucun fichier canonique, n'écrit rien, et **ne supprime jamais un
 * verrou**, quel que soit son état.
 *
 * ## Deux erreurs symétriques à éviter
 *
 * ```text
 * faux « orphelin »  un verrou vient d'être posé, le registre n'est pas encore
 *                    à jour → ORPHAN_LOCK prononcé à tort
 *
 * faux « actif »     un verrou ancien traîne, une nouvelle opération démarre
 *                    sur le même run → l'ancien verrou passe pour le sien
 * ```
 *
 * Les deux se ferment par la même règle : l'association registre ↔ verrou porte
 * sur le **`lock_id` exact**, jamais sur `run_id + pid`. Une opération est
 * enregistrée avant l'acquisition et n'est liée à un verrou qu'une fois celui-ci
 * réellement obtenu — une entrée sans `lockId` ne prouve donc rien.
 */

import { hostname as osHostname } from 'node:os';

import type { PendingOperation } from '../core/run.ts';
import type { RunExecutionEvidence } from '../core/run-liveness.ts';
import type { HostOperationRegistry } from './host-operation-registry.ts';
import { assessLiveness, readRunLock } from './run-lock.ts';
import type { RunLockInfo } from './run-lock.ts';
import type { RunPaths } from '../store/layout.ts';

/** Situation du verrou, plus précise que la vivacité V1. */
export type RunLockObservation =
  /** Aucun verrou : personne ne détient le run. */
  | 'NO_LOCK'
  /** Verrou de ce processus, associé à une opération connue du registre. */
  | 'ACTIVE_HOST_OPERATION'
  /** Verrou vivant détenu par un autre processus de cet hôte. */
  | 'ACTIVE_EXTERNAL_LOCK'
  /** Verrou de ce processus, sans opération correspondante. */
  | 'ORPHAN_SAME_PID_LOCK'
  /** Propriétaire local disparu. */
  | 'STALE_LOCK'
  /** Verrou posé depuis un autre hôte : statut indéterminable ici. */
  | 'FOREIGN_LOCK'
  /** Verrou de ce PID, sans registre pour trancher (cas CLI). */
  | 'INDETERMINATE_LOCK';

export interface RunExecutionObservation {
  readonly observation: RunLockObservation;
  readonly lock: RunLockInfo | undefined;
  readonly evidence: RunExecutionEvidence;
}

/**
 * Correspondance commande de verrou → nature d'opération persistée.
 *
 * Table **fermée**, dérivée des commandes qui émettent réellement un tour agent.
 * Les autres (`pause`, `resume`, `decide`, `stop`, `setup --run`) n'en émettent
 * aucun : un verrou qui les porte ne peut pas être celui d'un
 * `pending_operation`.
 */
const LOCK_COMMAND_TO_OPERATION: Readonly<Record<string, PendingOperation['kind']>> = {
  start: 'initialization',
  send: 'send',
  step: 'step',
  handoff: 'handoff',
  // `recover` peut poursuivre une initialisation partielle, donc dispatcher.
  recover: 'initialization',
};

/**
 * Le verrou observé peut-il être celui de l'opération persistée ?
 *
 * Deux conditions cumulatives :
 *
 * 1. **la commande correspond** à la nature de l'opération ;
 * 2. **l'opération n'est pas antérieure au verrou.** CCR acquiert le verrou
 *    *avant* d'écrire `pending_operation` ; une opération datée d'avant le
 *    verrou courant appartient donc nécessairement à un détenteur précédent.
 *
 * C'est la fermeture du point §13 : un verrou vivant démontre qu'*une*
 * opération CCR détient le run, jamais que c'est *celle-ci*.
 */
export function isPendingCoveredByLock(
  pending: PendingOperation | null,
  lock: RunLockInfo,
): 'YES' | 'NO' | 'UNKNOWN' {
  if (pending === null) return 'UNKNOWN';

  const expected = LOCK_COMMAND_TO_OPERATION[lock.command];
  if (expected === undefined || expected !== pending.kind) return 'NO';

  const lockAt = Date.parse(lock.started_at);
  const pendingAt = Date.parse(pending.started_at);
  if (!Number.isFinite(lockAt) || !Number.isFinite(pendingAt)) return 'UNKNOWN';

  return pendingAt >= lockAt ? 'YES' : 'NO';
}

export interface ObserveOptions {
  /** Registre de l'hôte. Absent — cas CLI — aucune preuve d'activité propre. */
  readonly registry?: HostOperationRegistry;
  /** Opération persistée observée, pour le test de correspondance de §13. */
  readonly pendingOperation?: PendingOperation | null;
  readonly pid?: number;
  readonly hostname?: string;
  /** Verrou déjà lu, pour les tests déterministes. */
  readonly lock?: RunLockInfo | undefined;
}

/** Classification pure, sans accès disque. */
export function classifyLockObservation(
  runId: string,
  lock: RunLockInfo | undefined,
  options: ObserveOptions = {},
): RunExecutionObservation {
  const pid = options.pid ?? process.pid;
  const host = options.hostname ?? osHostname();
  const pending = options.pendingOperation ?? null;

  if (lock === undefined) {
    return {
      observation: 'NO_LOCK',
      lock: undefined,
      evidence: { lock: 'ABSENT', hostOperation: 'NONE', pendingCoveredByLock: 'UNKNOWN' },
    };
  }

  const covered = isPendingCoveredByLock(pending, lock);

  if (lock.hostname !== host) {
    return {
      observation: 'FOREIGN_LOCK',
      lock,
      evidence: { lock: 'FOREIGN_HOST', hostOperation: 'UNKNOWN', pendingCoveredByLock: covered },
    };
  }

  const liveness = assessLiveness(lock);
  if (liveness === 'STALE') {
    return {
      observation: 'STALE_LOCK',
      lock,
      evidence: { lock: 'STALE', hostOperation: 'NONE', pendingCoveredByLock: covered },
    };
  }

  // À partir d'ici le verrou est vivant sur cet hôte.
  if (lock.pid !== pid) {
    return {
      observation: 'ACTIVE_EXTERNAL_LOCK',
      lock,
      evidence: {
        lock: 'ALIVE_OTHER_PROCESS',
        hostOperation: 'UNKNOWN',
        pendingCoveredByLock: covered,
      },
    };
  }

  // Même PID : c'est le cas qui justifie tout ce slice. Sans registre, aucune
  // conclusion — l'égalité de PID ne désigne aucune opération.
  if (options.registry === undefined) {
    return {
      observation: 'INDETERMINATE_LOCK',
      lock,
      evidence: {
        lock: 'ALIVE_THIS_PROCESS',
        hostOperation: 'UNKNOWN',
        pendingCoveredByLock: covered,
      },
    };
  }

  const operation = options.registry.find(runId, lock.lock_id);
  if (operation === undefined) {
    // Verrou de ce processus qu'aucune opération vivante ne revendique.
    return {
      observation: 'ORPHAN_SAME_PID_LOCK',
      lock,
      evidence: {
        lock: 'ALIVE_THIS_PROCESS',
        hostOperation: 'NONE',
        pendingCoveredByLock: covered,
      },
    };
  }

  return {
    observation: 'ACTIVE_HOST_OPERATION',
    lock,
    evidence: {
      lock: 'ALIVE_THIS_PROCESS',
      hostOperation: 'ACTIVE',
      pendingCoveredByLock: covered,
    },
  };
}

/**
 * Observe le verrou d'un run et produit l'évidence correspondante.
 *
 * Ne supprime jamais rien, quelle que soit la situation constatée. La levée
 * humaine d'un verrou reste une opération explicite.
 */
/**
 * Reprise de confirmation d'un verdict « orphelin ».
 *
 * Très courte : la fenêtre visée est la durée d'un `readFile` local.
 */
const ORPHAN_CONFIRMATION = { attempts: 4, delaysMs: [1, 2, 4] } as const;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function observeRunExecution(
  paths: RunPaths,
  options: ObserveOptions = {},
): Promise<RunExecutionObservation> {
  if (options.lock !== undefined) {
    return classifyLockObservation(paths.runId, options.lock, options);
  }

  let lock: RunLockInfo | undefined;
  try {
    lock = await readRunLock(paths);
  } catch {
    // Verrou **présent mais illisible**. C'est notamment l'état exact d'une
    // acquisition en cours : `wx` crée le fichier vide, puis l'écrit. Le
    // confondre avec une absence conclurait « opération abandonnée » sur une
    // acquisition parfaitement normale (V2-IMP-31, correctif de course).
    return {
      observation: 'INDETERMINATE_LOCK',
      lock: undefined,
      evidence: {
        lock: 'UNKNOWN',
        hostOperation: 'UNKNOWN',
        pendingCoveredByLock: 'UNKNOWN',
      },
    };
  }

  const result = classifyLockObservation(paths.runId, lock, options);

  // ------------------------------------------------------------------
  // Confirmation du seul verdict qu'une lecture désynchronisée peut
  // produire à tort.
  //
  // Le verrou est lu à un instant, le registre consulté au suivant. Entre les
  // deux, l'opération propriétaire peut avoir libéré son verrou **et** quitté
  // le registre : le lecteur tient alors un verrou déjà supprimé, qu'aucune
  // entrée ne revendique plus, et conclurait « orphelin » sur un cycle de vie
  // parfaitement normal.
  //
  // `end()` survenant toujours APRÈS `unlink()`, il suffit de revérifier que
  // le verrou observé est toujours là, à l'identique : s'il a disparu ou
  // changé, la conclusion portait sur un monde révolu.
  // ------------------------------------------------------------------
  if (result.observation !== 'ORPHAN_SAME_PID_LOCK') return result;

  // Aucune sortie anticipée : **tout** verdict « orphelin », y compris celui
  // produit après un changement de verrou, repasse par cette boucle. Une version
  // antérieure reclassifiait puis retournait directement le nouveau monde ; ce
  // reclassement pouvait à son tour être périmé — verrou relu, puis registre
  // consulté après la fin de l'opération propriétaire — et publiait un faux
  // orphelin sans l'avoir confirmé une seule fois (trace mesurée, cycle
  // acquisition/libération de ~10 ms).
  let observedId = lock?.lock_id;
  let stableFor = 1;

  for (let attempt = 1; attempt < ORPHAN_CONFIRMATION.attempts; attempt += 1) {
    await pause(ORPHAN_CONFIRMATION.delaysMs[attempt - 1] ?? 4);

    let current: RunLockInfo | undefined;
    try {
      current = await readRunLock(paths);
    } catch {
      return {
        observation: 'INDETERMINATE_LOCK',
        lock: undefined,
        evidence: { lock: 'UNKNOWN', hostOperation: 'UNKNOWN', pendingCoveredByLock: 'UNKNOWN' },
      };
    }

    // Le monde a réellement bougé vers autre chose qu'un orphelin : ce verdict
    // est positif, il n'a pas besoin de confirmation supplémentaire.
    const next = classifyLockObservation(paths.runId, current, options);
    if (next.observation !== 'ORPHAN_SAME_PID_LOCK') return next;

    if (current !== undefined && current.lock_id === observedId) {
      // Le **même** verrou est jugé orphelin deux fois de suite : un verrou
      // réellement abandonné est stable, un cycle normal ne l'est pas.
      stableFor += 1;
      if (stableFor >= 2) return next;
    } else {
      observedId = current?.lock_id;
      stableFor = 1;
    }
  }

  // Budget épuisé sans jamais observer deux fois le même verrou orphelin : le
  // run est en rotation rapide. CCR ne conclut pas — il le dit.
  return {
    observation: 'INDETERMINATE_LOCK',
    lock: undefined,
    evidence: { lock: 'UNKNOWN', hostOperation: 'UNKNOWN', pendingCoveredByLock: 'UNKNOWN' },
  };
}
