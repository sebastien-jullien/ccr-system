/**
 * Démarrage et arrêt du cockpit local — ordre normatif (V0.2 §32).
 *
 * ```text
 * 1. résolution et canonicalisation du CCR data root
 * 2. acquisition exclusive de server.lock        ← AVANT toute autre chose
 * 3. création de l'unique HostOperationRegistry
 * 4. composition applicative commune
 * 5. génération d'un secret de session neuf
 * 6. ouverture du socket 127.0.0.1
 * 7. serveur prêt
 * ```
 *
 * L'ordre est la garantie : le verrou précédant le socket, un second cockpit
 * est arrêté **avant** d'écouter quoi que ce soit. Un processus refusé n'ouvre
 * aucun port, ne génère aucun secret et ne modifie aucun fichier.
 *
 * Si l'ouverture du socket échoue après l'acquisition, le propriétaire tente sa
 * libération — et un échec de libération est **rapporté**, jamais masqué : un
 * verrou survivant à un démarrage raté est précisément le cas qui bloquerait
 * silencieusement tous les démarrages suivants.
 */

import { CcrError } from '../core/errors.ts';
import { composeCcrApplication } from '../cli/composition.ts';
import type { CcrApplication, ComposeOptions } from '../cli/composition.ts';
import { createHostOperationRegistry } from '../lock/host-operation-registry.ts';
import type { HostOperationRegistry } from '../lock/host-operation-registry.ts';
import { materializeCcrDataRoot, resolveCockpitDataRoot } from './data-root.ts';
import type { CanonicalizeOptions, CockpitDataRoot } from './data-root.ts';
import { acquireServerLock, clearStaleServerLock } from './server-lock.ts';
import type { CockpitServerLockInfo, ServerLockReleaseOutcome } from './server-lock.ts';
import { createOperationStore } from './operations-store.ts';
import { createLongOperationManager } from './long-operations.ts';
import type { LongOperationManager } from './long-operations.ts';
import type { LongMutationHooks } from '../services/long-mutations.ts';
import type { StartMutationHooks } from '../services/start-mutation.ts';
import type { CanonicalRecoveryHooks } from '../services/recovery-application-service.ts';
import type { ClearStaleRunLockHooks } from '../services/clear-stale-run-lock-service.ts';
import type { StartPreflightSeams } from '../services/start-application-service.ts';
import type { OperationStore } from './operations-store.ts';
import type { ShortMutationSeams } from '../services/short-mutations.ts';
import { startCockpitHttpServer } from './server.ts';
import type { RunningCockpitServer } from './server.ts';

export interface StartCockpitOptions {
  readonly runsDir?: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly home?: string;
  /** Injection de test uniquement. */
  readonly sessionSecret?: string;
  /**
   * Couture de résolution filesystem — test uniquement.
   *
   * Sert à éprouver la discipline fail-closed : une identité de data root
   * indéterminable doit tout arrêter avant le verrou et avant le socket.
   */
  readonly realpath?: CanonicalizeOptions['realpath'];
  /** Coutures de test de la section critique des mutations. */
  readonly seams?: ShortMutationSeams;
  readonly longHooks?: LongMutationHooks;
  /** Seams de preflight — tests uniquement. La production n'en fournit aucune. */
  readonly preflightSeams?: StartPreflightSeams;
  readonly startHooks?: StartMutationHooks;
  /** Cadence de réconciliation des écritures externes. §22.4 en production. */
  readonly reconciliationIntervalMs?: number;
  /** Couture de test : un tour de réconciliation vient d'avoir lieu. */
  readonly onReconciled?: (watchedRuns: number) => void;
  /** Coutures de reprise — tests uniquement. */
  readonly recoveryHooks?: CanonicalRecoveryHooks & ClearStaleRunLockHooks;
  /**
   * Store d'idempotence imposé.
   *
   * Injection de test uniquement : elle permet de faire échouer la
   * terminalisation d'un reçu, situation qu'aucun montage réel ne produit à la
   * demande. La production compose toujours le sien.
   */
  readonly operationsStore?: OperationStore;
  /** Injection de test des adapters d agents. */
  readonly depsOverrides?: ComposeOptions['depsOverrides'];
}

export interface CockpitInstance {
  readonly dataRoot: CockpitDataRoot;
  readonly lock: CockpitServerLockInfo;
  readonly server: RunningCockpitServer;
  /**
   * Registre unique du processus, partagé par le service et le read model.
   * Exposé pour que l'identité d'objet soit vérifiable (limite L4).
   */
  readonly registry: HostOperationRegistry;
  /**
   * Composition effectivement utilisée. Exposée pour que l'unicité du registre
   * soit vérifiable **sur le chemin de production**, et pas seulement sur un
   * appel direct à `composeCcrApplication`.
   */
  readonly application: CcrApplication;
  /** Store d'idempotence de cette instance. Non canonique. */
  readonly operations: OperationStore;
  /** Admission des opérations longues. Transport, jamais métier. */
  readonly manager: LongOperationManager;
  stop(): Promise<ServerLockReleaseOutcome>;
}

export async function startCockpit(options: StartCockpitOptions = {}): Promise<CockpitInstance> {
  // Matérialisé avant canonicalisation : l'identité vient de l'OS, jamais de
  // l'orthographe de l'appelant (voir `data-root.ts`).
  const dataRoot = await materializeCcrDataRoot(
    options.runsDir,
    options.realpath === undefined ? {} : { realpath: options.realpath },
  );

  // 2. Le verrou d'abord. Un refus ici n'a rien ouvert.
  const lock = await acquireServerLock(dataRoot);

  try {
    // 3-4. Un registre, une composition, partagés par les deux couches.
    const registry = createHostOperationRegistry();
    const application = composeCcrApplication({
      runsDir: dataRoot.runsDir,
      hostRegistry: registry,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.depsOverrides === undefined ? {} : { depsOverrides: options.depsOverrides }),
    });

    // Le reçu porte l'identité de l'instance : c'est ce qui permet de dire
    // « cette opération appartient à un serveur qui n'existe plus », donc
    // `UNKNOWN`, sans jamais rejouer.
    const operations = options.operationsStore ?? createOperationStore(dataRoot, lock.info.instance_id);
    const manager = createLongOperationManager();

    // 5-6. Secret neuf puis socket loopback.
    const server = await startCockpitHttpServer({
      dataRoot,
      readModel: application.readModel,
      runService: application.runService,
      operations,
      manager,
      // `START` a besoin d'une fabrique paramétrée par le snapshot que son
      // propre preflight vient de figer — jamais des dépendances composées au
      // démarrage du serveur, qui décriraient une autre configuration.
      createRunServiceDeps: application.createRunServiceDeps,
      ...(options.longHooks === undefined ? {} : { longHooks: options.longHooks }),
      ...(options.preflightSeams === undefined ? {} : { preflightSeams: options.preflightSeams }),
      ...(options.startHooks === undefined ? {} : { startHooks: options.startHooks }),
      ...(options.recoveryHooks === undefined ? {} : { recoveryHooks: options.recoveryHooks }),
      ...(options.reconciliationIntervalMs === undefined ? {} : { reconciliationIntervalMs: options.reconciliationIntervalMs }),
      ...(options.onReconciled === undefined ? {} : { onReconciled: options.onReconciled }),
      ...(options.seams === undefined ? {} : { seams: options.seams }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.sessionSecret === undefined ? {} : { sessionSecret: options.sessionSecret }),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.home === undefined ? {} : { home: options.home }),
    });

    return {
      dataRoot,
      lock: lock.info,
      server,
      registry,
      application,
      operations,
      manager,
      /**
       * Arrêt gracieux — **le verrou en dernier**.
       *
       * ```text
       * cesser d'admettre → fermer l'écoute → drainer → libérer server.lock
       * ```
       *
       * L'ordre est l'invariant. Relâcher `server.lock` pendant qu'une
       * opération admise peut encore muter un run autoriserait un second
       * cockpit à démarrer, à déclarer l'ancienne opération `UNKNOWN`, puis à
       * voir arriver son effet. Le verrou reste donc détenu tant qu'un effet
       * canonique reste possible.
       *
       * Aucune annulation de fournisseur n'est inventée : si l'agent ne revient
       * jamais, le drain ne se termine pas. Un arrêt forcé est alors un crash,
       * traité comme tel — verrou périmé et remédiation humaine explicite.
       */
      async stop(): Promise<ServerLockReleaseOutcome> {
        manager.beginShutdown();
        await server.close();
        await manager.drain();
        return lock.release();
      },
    };
  } catch (error) {
    const outcome = await lock.release();
    if (outcome !== 'RELEASED' && outcome !== 'ALREADY_GONE') {
      throw new CcrError(
        'COCKPIT_BIND_FAILED',
        `Le démarrage du cockpit a échoué, et son verrou n'a pas pu être libéré (${outcome}). ` +
          `Levez-le explicitement : \`ccr cockpit clear-stale-lock --lock-id ${lock.info.instance_id}\`.`,
        { details: { release: outcome, instance_id: lock.info.instance_id }, cause: error },
      );
    }
    throw error;
  }
}

/**
 * Levée humaine d'un `server.lock` local périmé, depuis un chemin de data root.
 *
 * La canonicalisation précède l'inspection, et elle est **fail-closed** : une
 * identité indéterminable interrompt la commande avant toute lecture, donc
 * *a fortiori* avant toute suppression. C'est la discipline la plus importante
 * ici — cette commande est la seule du cockpit qui supprime un fichier.
 *
 * Aucun repli vers une forme lexicale : supprimer d'après un chemin qu'on n'a
 * pas su résoudre reviendrait à effacer un verrou dont on ignore s'il est
 * celui du data root visé.
 */
export async function clearStaleCockpitLock(
  runsDir: string | undefined,
  expectedInstanceId: string,
  options: CanonicalizeOptions = {},
): Promise<{ dataRoot: CockpitDataRoot; removed: CockpitServerLockInfo }> {
  const dataRoot = resolveCockpitDataRoot(runsDir, options);
  const removed = await clearStaleServerLock(dataRoot, expectedInstanceId);
  return { dataRoot, removed };
}
