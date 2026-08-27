/**
 * Verrou de la configuration globale CCR (spécification V1.1, §20.1).
 *
 * Problème traité, et lui seul : deux `ccr setup` concurrents lisent la même
 * configuration, modifient chacun une clé différente et réécrivent l'ensemble.
 * L'écriture atomique empêche la corruption du fichier mais **pas** le *lost
 * update*. Le cycle lecture → modification → écriture doit donc être sérialisé.
 *
 * Contrainte de non-régression explicite de la spécification : le run lock V1
 * n'est ni modifié, ni réutilisé, ni fusionné avec celui-ci. La configuration
 * globale et les runs sont deux domaines distincts. Ce module est volontairement
 * autonome — il ne partage aucune ligne avec `run-lock.ts`, au prix d'une
 * ressemblance de forme assumée.
 *
 * Propriétés :
 *
 *  - **acquisition atomique** : création `wx`, jamais un `exists()` suivi d'un
 *    `create()` qui ouvrirait une fenêtre de course ;
 *  - **conflit explicite** : `CONFIG_BUSY`, jamais une attente silencieuse ;
 *  - **seul le propriétaire libère son verrou**, identifié par `lock_id` ;
 *  - **aucune suppression automatique**, y compris d'un verrou abandonné :
 *    aucune commande normale ne supprime un verrou en silence.
 *
 * Le document de verrou porte `lock_id`, `pid`, `hostname` et `created_at`
 * (amendement IMP-02). Ces champs sont le support de la politique arbitrée des
 * verrous abandonnés : `doctor` pourra signaler un verrou local démontré
 * périmé, et `setup` pourra en proposer la levée sous consentement explicite,
 * en ne supprimant que le `lock_id` exact qu'il vient d'inspecter. Rien de
 * cela n'est implémenté ici : seule l'**observation** l'est, afin que le
 * format n'ait pas à changer plus tard.
 *
 * Asymétrie de risque assumée, identique à la V1 : un `CONFIG_BUSY` de trop
 * est acceptable ; la suppression d'un verrou vivant ne l'est pas.
 */

import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { CcrError } from '../core/errors.ts';
// Prédicat système générique, emprunté au verrou de run sans le modifier ni
// fusionner les deux mécanismes : « ce PID existe-t-il ? » ne porte aucune
// sémantique de run. Le dupliquer ici serait recopier six lignes d'OS.
import { isProcessAlive } from './run-lock.ts';

export interface ConfigLockInfo {
  readonly lock_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly created_at: string;
  /** Commande CCR détentrice, pour diagnostic humain. */
  readonly command: string;
}

/**
 * Fait observable au sujet du fichier de verrou.
 *
 * `ABSENT` et `UNREADABLE` doivent rester distincts : les confondre
 * conduirait une future levée de verrou abandonné à traiter un document
 * corrompu comme une absence de verrou, donc à écraser un verrou peut-être
 * vivant. C'est précisément l'erreur que la politique arbitrée interdit.
 */
export type ConfigLockPresence = 'ABSENT' | 'HELD' | 'UNREADABLE';

export interface ConfigLockObservation {
  readonly presence: ConfigLockPresence;
  readonly path: string;
  /** Renseigné uniquement lorsque `presence === 'HELD'`. */
  readonly info?: ConfigLockInfo;
}

export interface ConfigLockHandle {
  readonly info: ConfigLockInfo;
  readonly path: string;
  /** Supprime le verrou uniquement s'il porte toujours notre `lock_id`. */
  release(): Promise<void>;
}

/** Le verrou est adjacent au fichier de configuration qu'il protège. */
export function configLockFilePath(configPath: string): string {
  return `${configPath}.lock`;
}

function parseLockInfo(raw: string): ConfigLockInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  const lockId = record['lock_id'];
  const pid = record['pid'];
  const host = record['hostname'];
  const createdAt = record['created_at'];
  const command = record['command'];

  // Les quatre champs requis par la politique des verrous abandonnés. Un
  // document incomplet est déclaré illisible, jamais complété de valeurs
  // plausibles : on ne décide pas d'une suppression sur une identité devinée.
  if (
    typeof lockId !== 'string' ||
    typeof pid !== 'number' ||
    typeof host !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    return undefined;
  }

  return {
    lock_id: lockId,
    pid,
    hostname: host,
    created_at: createdAt,
    command: typeof command === 'string' ? command : 'inconnue',
  };
}

/**
 * Observe le fichier de verrou sans jamais le modifier.
 *
 * Constatation pure : aucune interrogation du système de processus, aucune
 * conclusion de péremption. Classer un verrou `ALIVE` / `STALE` /
 * `FOREIGN_HOST` appartient aux slices `doctor` et `setup`.
 */
export async function observeConfigLock(configPath: string): Promise<ConfigLockObservation> {
  const file = configLockFilePath(configPath);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { presence: 'ABSENT', path: file };
    // Présent mais inaccessible : conservatisme, ce n'est pas une absence.
    return { presence: 'UNREADABLE', path: file };
  }

  const info = parseLockInfo(raw);
  return info === undefined ? { presence: 'UNREADABLE', path: file } : { presence: 'HELD', path: file, info };
}

/** Détenteur identifié du verrou, ou `undefined` s'il est absent ou illisible. */
export async function readConfigLock(configPath: string): Promise<ConfigLockInfo | undefined> {
  return (await observeConfigLock(configPath)).info;
}

/**
 * Vivacité d'un verrou identifié (§20.2).
 *
 * Conservatisme inter-machines, identique à la V1 : un verrou posé depuis un
 * autre hôte n'est jamais déclaré périmé sur la seule base d'un PID local
 * absent — le PID d'une autre machine ne veut rien dire ici.
 *
 * L'âge du verrou n'entre pas dans la décision : un `setup` laissé ouvert une
 * heure devant une invite reste vivant.
 */
export type ConfigLockLiveness = 'ALIVE' | 'STALE' | 'FOREIGN_HOST';

export function assessConfigLockLiveness(info: ConfigLockInfo): ConfigLockLiveness {
  if (info.hostname !== hostname()) return 'FOREIGN_HOST';
  return isProcessAlive(info.pid) ? 'ALIVE' : 'STALE';
}

/**
 * Supprime un verrou abandonné, et lui seul.
 *
 * La suppression n'est jamais décidée sur la foi d'une observation antérieure :
 * le verrou est **réinspecté** au moment d'agir, et n'est retiré que si son
 * identité est toujours exactement celle présentée à l'humain, et qu'il est
 * toujours démontré périmé. Entre l'invite et la réponse, un autre processus a
 * pu prendre le verrou légitimement.
 *
 * Retourne `false` — sans erreur — dès que l'une de ces conditions n'est plus
 * vraie : ne rien supprimer est toujours une issue acceptable.
 */
export async function removeAbandonedConfigLock(
  configPath: string,
  expectedLockId: string,
): Promise<boolean> {
  const observation = await observeConfigLock(configPath);
  if (observation.presence !== 'HELD') return false;

  const info = observation.info;
  if (info === undefined || info.lock_id !== expectedLockId) return false;
  if (assessConfigLockLiveness(info) !== 'STALE') return false;

  await unlink(observation.path).catch(() => undefined);
  return true;
}

function busyError(configPath: string, observation: ConfigLockObservation): CcrError {
  const existing = observation.info;
  const owner =
    existing === undefined
      ? 'un autre processus (verrou illisible)'
      : `le processus ${String(existing.pid)} sur ${existing.hostname} ` +
        `(commande « ${existing.command} », depuis ${existing.created_at})`;
  return new CcrError(
    'CONFIG_BUSY',
    `La configuration CCR est en cours de modification par ${owner}. ` +
      'Aucune modification n\'a été effectuée. Verrou : ' +
      observation.path,
    {
      details: {
        configPath,
        lockPath: observation.path,
        presence: observation.presence,
        ...(existing === undefined ? { owner: null } : { owner: existing }),
      },
    },
  );
}

/**
 * Acquiert le verrou d'écriture de la configuration globale.
 *
 * Échoue immédiatement plutôt que d'attendre : `ccr setup` est une commande
 * interactive rare, une erreur lisible vaut mieux qu'une file d'attente
 * implicite.
 */
export async function acquireConfigLock(configPath: string, command: string): Promise<ConfigLockHandle> {
  const file = configLockFilePath(configPath);
  await mkdir(path.dirname(configPath), { recursive: true });

  const info: ConfigLockInfo = {
    lock_id: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    created_at: new Date().toISOString(),
    command,
  };

  let handle;
  for (let attempt = 1; handle === undefined; attempt += 1) {
    try {
      // `wx` : création exclusive, arbitrée par le système de fichiers.
      handle = await open(file, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const observation = await observeConfigLock(configPath);
      // Verrou réellement disparu entre l'échec et l'observation : une seule
      // seconde chance. Un verrou illisible, lui, n'est pas une absence.
      if (observation.presence === 'ABSENT' && attempt === 1) continue;
      throw busyError(configPath, observation);
    }
  }

  try {
    await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  return {
    info,
    path: file,
    async release(): Promise<void> {
      const observation = await observeConfigLock(configPath).catch(
        (): ConfigLockObservation => ({ presence: 'UNREADABLE', path: file }),
      );
      // On ne supprime que le `lock_id` exact que l'on vient d'observer :
      // ni le verrou d'un autre propriétaire, ni un document illisible.
      if (observation.presence !== 'HELD' || observation.info?.lock_id !== info.lock_id) return;
      await unlink(file).catch(() => undefined);
    },
  };
}

/** Exécute une écriture de configuration sous verrou, libéré en toutes circonstances. */
export async function withConfigLock<T>(
  configPath: string,
  command: string,
  operation: (lock: ConfigLockHandle) => Promise<T>,
): Promise<T> {
  const lock = await acquireConfigLock(configPath, command);
  try {
    return await operation(lock);
  } finally {
    await lock.release();
  }
}
