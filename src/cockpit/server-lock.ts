/**
 * `server.lock` — unicité du processus cockpit par data root
 * (V0.2 §15.3, §15.4 ; INV-20-11 ; amendement V2-IMP-35).
 *
 * ## Domaine propre
 *
 * Ce verrou ne remplace ni le run lock ni le config lock, et n'en est pas une
 * généralisation. Les sémantiques diffèrent réellement :
 *
 * ```text
 * run lock      protège UN run, durée d'une opération, porte une commande
 * config lock   protège la configuration globale, durée d'une écriture
 * server.lock   protège l'unicité d'un PROCESSUS, durée de vie du serveur
 * ```
 *
 * Le run lock est acquis et relâché des dizaines de fois par minute ; celui-ci
 * est acquis une fois et tenu des heures. Il n'a pas de `command`, pas de
 * reconfirmation d'orphelin, et sa levée n'est jamais automatique. Les
 * *principes* sont repris — création exclusive, libération par le propriétaire
 * seul, asymétrie de risque — pas l'implémentation.
 *
 * ## Asymétrie de risque, conservée
 *
 * ```text
 * un COCKPIT_ALREADY_RUNNING de trop     acceptable
 * la suppression d'un verrou vivant      inacceptable
 * ```
 *
 * Conséquence directe : **aucune suppression automatique**, en aucune
 * circonstance, pas même face à un verrou dont la péremption est démontrée. La
 * démonstration de péremption autorise à le *dire*, jamais à agir seul.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';

import { CcrError } from '../core/errors.ts';
import { isProcessAlive } from '../lock/run-lock.ts';
import type { CockpitDataRoot } from './data-root.ts';

export const SERVER_LOCK_SCHEMA_VERSION = 1;

export interface CockpitServerLockInfo {
  readonly schema_version: number;
  /** Identité exacte de l'instance. Seule clé de libération et de levée. */
  readonly instance_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly created_at: string;
}

/**
 * Situation du verrou.
 *
 * Le port n'entre pas dans l'identité : deux `ccr cockpit` sur le même data
 * root entrent en conflit même s'ils demandent des ports différents (§15.3).
 */
export type ServerLockObservation =
  /** Aucun verrou : le data root est libre. */
  | 'NONE'
  /** Verrou local dont le propriétaire est vivant. */
  | 'LOCAL_LIVE'
  /** Verrou local dont le propriétaire a démontrablement disparu. */
  | 'LOCAL_STALE'
  /** Verrou posé depuis un autre hôte : indécidable ici, jamais supprimé. */
  | 'FOREIGN'
  /** Verrou présent mais illisible ou mal formé : on ne conclut pas. */
  | 'INDETERMINATE';

export interface ServerLockInspection {
  readonly observation: ServerLockObservation;
  readonly info: CockpitServerLockInfo | undefined;
}

export type ServerLockReleaseOutcome = 'RELEASED' | 'ALREADY_GONE' | 'NOT_OWNER' | 'FAILED';

export interface CockpitServerLockHandle {
  readonly info: CockpitServerLockInfo;
  release(): Promise<ServerLockReleaseOutcome>;
}

function parseLockInfo(raw: string): CockpitServerLockInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const { schema_version: version, instance_id: id, pid, hostname: host, created_at: created } = candidate;
  if (typeof version !== 'number' || typeof id !== 'string' || id.length === 0) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof host !== 'string' || host.length === 0) return undefined;
  if (typeof created !== 'string' || created.length === 0) return undefined;
  if (version !== SERVER_LOCK_SCHEMA_VERSION) return undefined;
  return { schema_version: version, instance_id: id, pid, hostname: host, created_at: created };
}

/** Inspecte le verrou sans jamais le modifier. */
export async function inspectServerLock(
  file: string,
  hostnameOverride?: string,
): Promise<ServerLockInspection> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { observation: 'NONE', info: undefined };
    }
    // Présent mais illisible : ne pas confondre avec une absence.
    return { observation: 'INDETERMINATE', info: undefined };
  }

  const info = parseLockInfo(raw);
  if (info === undefined) return { observation: 'INDETERMINATE', info: undefined };

  if (info.hostname !== (hostnameOverride ?? osHostname())) {
    return { observation: 'FOREIGN', info };
  }
  return { observation: isProcessAlive(info.pid) ? 'LOCAL_LIVE' : 'LOCAL_STALE', info };
}

function describe(info: CockpitServerLockInfo): string {
  return `instance ${info.instance_id.slice(0, 8)} · pid ${String(info.pid)} · hôte ${info.hostname} · depuis ${info.created_at}`;
}

/** Traduit une situation occupée en erreur explicite. Ne supprime jamais rien. */
function occupiedError(inspection: ServerLockInspection, file: string): CcrError {
  const { observation, info } = inspection;
  const details = { path: file, observation };

  if (observation === 'LOCAL_LIVE' && info !== undefined) {
    return new CcrError(
      'COCKPIT_ALREADY_RUNNING',
      `Un cockpit CCR est déjà actif sur ce data root (${describe(info)}). ` +
        "Aucun port n'a été ouvert. Utilisez l'instance existante, ou arrêtez-la explicitement.",
      { details: { ...details, instance_id: info.instance_id } },
    );
  }
  if (observation === 'LOCAL_STALE' && info !== undefined) {
    return new CcrError(
      'COCKPIT_SERVER_LOCK_STALE',
      `Un verrou de cockpit subsiste alors que son propriétaire a disparu (${describe(info)}). ` +
        'CCR ne le supprime jamais seul : levez-le explicitement avec ' +
        `\`ccr cockpit clear-stale-lock --lock-id ${info.instance_id}\`.`,
      { details: { ...details, instance_id: info.instance_id } },
    );
  }
  if (observation === 'FOREIGN' && info !== undefined) {
    return new CcrError(
      'COCKPIT_SERVER_LOCK_FOREIGN',
      `Le verrou de cockpit a été posé depuis l'hôte ${info.hostname} : son statut est indéterminable ici. ` +
        "Il n'est pas supprimé.",
      { details: { ...details, instance_id: info.instance_id } },
    );
  }
  return new CcrError(
    'COCKPIT_SERVER_LOCK_INDETERMINATE',
    `Un verrou de cockpit est présent mais illisible (${file}). CCR ne conclut pas et ne le supprime pas.`,
    { details },
  );
}

/**
 * Acquiert le verrou du data root.
 *
 * Échoue explicitement plutôt que d'attendre : il n'existe aucun auto-join
 * (§15.3). Cette acquisition précède l'ouverture du socket.
 */
export async function acquireServerLock(paths: CockpitDataRoot): Promise<CockpitServerLockHandle> {
  await mkdir(paths.controlDir, { recursive: true });

  const info: CockpitServerLockInfo = {
    schema_version: SERVER_LOCK_SCHEMA_VERSION,
    instance_id: randomUUID(),
    pid: process.pid,
    hostname: osHostname(),
    created_at: new Date().toISOString(),
  };

  let handle;
  try {
    // `wx` : création exclusive et atomique.
    handle = await open(paths.serverLock, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw occupiedError(await inspectServerLock(paths.serverLock), paths.serverLock);
  }

  try {
    await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  return {
    info,
    async release(): Promise<ServerLockReleaseOutcome> {
      const current = await inspectServerLock(paths.serverLock);
      if (current.observation === 'NONE') return 'ALREADY_GONE';
      // Un verrou illisible peut être celui d'un autre : on ne le touche pas.
      if (current.info === undefined) return 'FAILED';
      if (current.info.instance_id !== info.instance_id) return 'NOT_OWNER';
      try {
        await unlink(paths.serverLock);
        return 'RELEASED';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ALREADY_GONE' : 'FAILED';
      }
    },
  };
}

/**
 * Levée humaine explicite d'un `server.lock` local démontré périmé.
 *
 * Six conditions cumulatives, dont une **relecture immédiate** avant la
 * suppression : entre l'observation et l'acte, un nouveau cockpit a pu démarrer
 * et poser son propre verrou. Sans cette relecture, la commande de réparation
 * deviendrait elle-même l'outil qui supprime un verrou vivant.
 *
 * `expectedInstanceId` est obligatoire : la levée ne s'appuie jamais sur un PID
 * seul, qui peut avoir été recyclé.
 */
export interface ClearStaleOptions {
  /**
   * Point d'observation entre le constat et la relecture.
   *
   * Sa raison d'être est explicite : sans lui, la fenêtre TOCTOU que cette
   * fonction referme ne serait vérifiable que de façon probabiliste, ce qui ne
   * démontrerait rien. Aucun appelant de production ne le fournit.
   */
  readonly onObserved?: () => void | Promise<void>;
}

export async function clearStaleServerLock(
  paths: CockpitDataRoot,
  expectedInstanceId: string,
  options: ClearStaleOptions = {},
): Promise<CockpitServerLockInfo> {
  const before = await inspectServerLock(paths.serverLock);

  if (before.observation === 'NONE') {
    throw new CcrError(
      'COCKPIT_SERVER_LOCK_NOT_FOUND',
      `Aucun verrou de cockpit sur ce data root (${paths.serverLock}).`,
      { details: { path: paths.serverLock } },
    );
  }
  if (before.info === undefined) {
    throw occupiedError(before, paths.serverLock);
  }
  if (before.info.instance_id !== expectedInstanceId) {
    throw new CcrError(
      'COCKPIT_SERVER_LOCK_IDENTITY_MISMATCH',
      "L'identité fournie n'est pas celle du verrou observé. Aucune suppression n'a été effectuée.",
      { details: { path: paths.serverLock, observation: before.observation } },
    );
  }
  if (before.observation !== 'LOCAL_STALE') {
    // Vivant, étranger : refus, sans suppression.
    throw occupiedError(before, paths.serverLock);
  }

  await options.onObserved?.();

  // Relecture immédiate : le monde a pu changer depuis l'observation.
  const now = await inspectServerLock(paths.serverLock);
  if (
    now.observation !== 'LOCAL_STALE' ||
    now.info === undefined ||
    now.info.instance_id !== expectedInstanceId ||
    now.info.pid !== before.info.pid ||
    now.info.created_at !== before.info.created_at
  ) {
    throw new CcrError(
      'COCKPIT_SERVER_LOCK_CHANGED',
      "Le verrou a changé entre l'observation et la levée. Aucune suppression n'a été effectuée.",
      { details: { path: paths.serverLock, observation: now.observation } },
    );
  }

  await unlink(paths.serverLock);
  return now.info;
}
