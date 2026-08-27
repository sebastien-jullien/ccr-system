/**
 * Verrou de run (spécification V1, §22).
 *
 * Un même run ne doit jamais être muté simultanément par deux processus CCR.
 *
 * Principes :
 *
 *  - **acquisition atomique.** Le fichier est créé avec `wx` : la création
 *    échoue si le fichier existe déjà. Aucun `exists()` suivi d'un `create()`,
 *    qui introduirait une fenêtre de course ;
 *  - **le verrou est une donnée de liveness**, pas un élément canonique du
 *    run. Sa perte n'altère ni le manifest, ni l'état, ni les journaux ;
 *  - **un processus ne supprime que son propre verrou**, identifié par
 *    `lock_id` ;
 *  - **aucune suppression silencieuse d'un verrou périmé** dans une commande
 *    métier : c'est la responsabilité explicite de `ccr recover` ;
 *  - **conservatisme inter-machines.** Un verrou posé par un autre hôte n'est
 *    jamais déclaré périmé sur la seule base d'un PID local absent. La V1 est
 *    locale ; elle ne prétend pas résoudre le cas distribué.
 */

import { link, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { CcrError } from '../core/errors.ts';
import type { RunPaths } from '../store/layout.ts';
import path from 'node:path';

export interface RunLockInfo {
  readonly lock_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly started_at: string;
  /** Commande CCR détentrice, pour diagnostic. */
  readonly command: string;
}

export type LockLiveness =
  /** Le processus propriétaire existe encore sur cette machine. */
  | 'ALIVE'
  /** Le propriétaire a disparu : candidat à `ccr recover`. */
  | 'STALE'
  /** Verrou posé depuis un autre hôte : statut indéterminable ici. */
  | 'FOREIGN_HOST';

/**
 * Issue observable d'une libération.
 *
 * La V1 absorbait silencieusement les deux échecs possibles — lecture
 * impossible, suppression impossible. Le verrou restait alors sur le disque
 * sans que personne ne le sache. L'issue est désormais **rapportée** ; le
 * comportement, lui, est inchangé : aucune exception n'est levée, et le verrou
 * d'un autre propriétaire n'est jamais supprimé (V2-IMP-31).
 */
export type LockReleaseOutcome =
  /** Verrou supprimé. */
  | 'RELEASED'
  /** Déjà absent : rien à faire. */
  | 'ALREADY_GONE'
  /** Le verrou présent appartient à quelqu'un d'autre : intact. */
  | 'NOT_OWNER'
  /** Lecture ou suppression impossible : le verrou peut subsister. */
  | 'FAILED';

export interface RunLockHandle {
  readonly info: RunLockInfo;
  /** Supprime le verrou uniquement s'il porte toujours notre `lock_id`. */
  release(): Promise<LockReleaseOutcome>;
}

export function lockFilePath(paths: RunPaths): string {
  return path.join(paths.root, '.ccr.lock');
}

/**
 * Un processus local porte-t-il encore ce PID ?
 *
 * `EPERM` signifie que le processus existe mais appartient à un autre
 * utilisateur : il est donc bien vivant.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLockInfo(raw: string, file: string): RunLockInfo {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new CcrError('LOCK_INVALID', `Fichier de verrou illisible : ${file}`, {
      details: { path: file },
      cause,
    });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CcrError('LOCK_INVALID', `Fichier de verrou malformé : ${file}`, { details: { path: file } });
  }

  const record = value as Record<string, unknown>;
  const lockId = record['lock_id'];
  const pid = record['pid'];
  const host = record['hostname'];
  const startedAt = record['started_at'];
  const command = record['command'];

  if (
    typeof lockId !== 'string' ||
    typeof pid !== 'number' ||
    typeof host !== 'string' ||
    typeof startedAt !== 'string'
  ) {
    throw new CcrError('LOCK_INVALID', `Fichier de verrou incomplet : ${file}`, { details: { path: file } });
  }

  return {
    lock_id: lockId,
    pid,
    hostname: host,
    started_at: startedAt,
    command: typeof command === 'string' ? command : 'inconnue',
  };
}

/** Lit le verrou présent, sans jamais le modifier. */
export async function readRunLock(paths: RunPaths): Promise<RunLockInfo | undefined> {
  const file = lockFilePath(paths);
  try {
    return parseLockInfo(await readFile(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function assessLiveness(info: RunLockInfo): LockLiveness {
  if (info.hostname !== hostname()) return 'FOREIGN_HOST';
  return isProcessAlive(info.pid) ? 'ALIVE' : 'STALE';
}

function conflictError(info: RunLockInfo, liveness: LockLiveness, runId: string): CcrError {
  if (liveness === 'STALE') {
    return new CcrError(
      'STALE_LOCK',
      `Le run ${runId} porte un verrou dont le propriétaire (pid ${String(info.pid)}) a disparu. ` +
        'Utilisez `ccr recover` : aucune commande métier ne supprime un verrou périmé.',
      { details: { runId, ...info, liveness } },
    );
  }
  const reason =
    liveness === 'FOREIGN_HOST'
      ? `posé depuis l'hôte ${info.hostname}, statut indéterminable ici`
      : `détenu par le processus ${String(info.pid)}`;
  return new CcrError('RUN_ALREADY_LOCKED', `Le run ${runId} est ${reason} (commande : ${info.command}).`, {
    details: { runId, ...info, liveness },
  });
}

export interface AcquireOptions {
  /**
   * Appelé avec l'identité du verrou **avant** que celui-ci devienne
   * observable sur le disque (V2-IMP-31, correctif de course).
   *
   * Motif : entre la publication du fichier et son association à une opération
   * de l'hôte, un lecteur concurrent voyait un verrou de son propre PID sans
   * correspondance — et concluait `ORPHAN_SAME_PID_LOCK` sur une acquisition
   * parfaitement normale. Annoncer l'identité **avant** la publication ferme
   * cette fenêtre structurellement : au premier instant où le verrou peut être
   * observé, sa correspondance existe déjà.
   *
   * L'inverse reste vrai : une identité annoncée mais jamais publiée ne
   * correspond à aucun fichier, et ne peut donc légitimer aucun verrou ancien.
   */
  onIdentityPrepared?(info: RunLockInfo): void;
  /**
   * Couture **test uniquement** : la création exclusive a réussi, le contenu
   * n'est pas encore écrit.
   *
   * C'est la fenêtre où le fichier de verrou existe et ne contient rien. La
   * maintenir ouverte à volonté est le seul moyen d'observer ce qu'un
   * concurrent y lit, au lieu d'en débattre. Aucun appelant de production ne la
   * fournit.
   */
  onExclusiveCreated?(info: RunLockInfo): void | Promise<void>;
}

/**
 * La publication a échoué, et rien n'a été posé.
 *
 * Le message nomme l'hypothèse la plus probable — un système de fichiers sans
 * lien dur — sans l'affirmer : CCR connaît le code système, pas la cause. Ce
 * qu'il affirme, en revanche, est vérifiable et c'est le seul point qui engage
 * la sûreté : aucun verrou n'existe.
 */
function publicationFailed(runId: string, code: string | undefined, cause: unknown): CcrError {
  return new CcrError(
    'LOCK_PUBLICATION_FAILED',
    `Le verrou du run ${runId} n'a pas pu être publié de façon atomique (${code ?? 'code inconnu'}). ` +
      "Aucun verrou n'a été posé. Ce système de fichiers ne prend peut-être pas en charge les liens durs : " +
      'CCR exige un répertoire de runs qui les supporte, plutôt qu’une publication en deux temps ' +
      'pendant laquelle un verrou vide serait lisible.',
    { details: { runId, syscall: 'link', code: code ?? null }, cause },
  );
}

/**
 * Acquiert le verrou du run pour toute la durée d'une opération mutante.
 *
 * Échoue explicitement plutôt que d'attendre : la V1 préfère une erreur
 * lisible à une file d'attente implicite.
 */
export async function acquireRunLock(
  paths: RunPaths,
  command: string,
  options: AcquireOptions = {},
): Promise<RunLockHandle> {
  const file = lockFilePath(paths);
  const info: RunLockInfo = {
    lock_id: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    started_at: new Date().toISOString(),
    command,
  };

  // Identité connue de l'appelant AVANT toute publication.
  options.onIdentityPrepared?.(info);

  // Le contenu est écrit à l'écart, puis rendu visible d'un seul geste.
  const staging = `${file}.${info.lock_id}.tmp`;
  const document = `${JSON.stringify(info, null, 2)}\n`;
  try {
    const staged = await open(staging, 'wx');
    try {
      await staged.writeFile(document, 'utf8');
      await staged.sync();
    } finally {
      await staged.close();
    }

    // Contenu complet et durable, chemin du verrou encore inexistant. C'était
    // la fenêtre : elle ne montre plus rien, puisqu'il n'y a rien à montrer.
    await options.onExclusiveCreated?.(info);

    try {
      // `link` est à la fois exclusif — il échoue si le nom existe — et
      // atomique. Le verrou naît donc complet, ou ne naît pas.
      await link(staging, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        const existing = await readRunLock(paths);
        if (existing === undefined) {
          // Le verrou a disparu entre-temps : une seule nouvelle tentative, qui
          // annoncera sa propre identité — l'ancienne n'a jamais été publiée.
          return acquireRunLock(paths, command, options);
        }
        throw conflictError(existing, assessLiveness(existing), paths.runId);
      }
      // Aucun repli. L'ancienne publication en deux temps rouvrirait
      // exactement la fenêtre que ce protocole ferme : un `.ccr.lock` vide,
      // lisible, et pris pour un verrou illisible par tout concurrent. Mieux
      // vaut ne pas acquérir que d'acquérir de cette façon-là.
      throw publicationFailed(paths.runId, code, error);
    }
  } finally {
    await unlink(staging).catch(() => undefined);
  }

  return {
    info,
    async release(): Promise<LockReleaseOutcome> {
      let current: RunLockInfo | undefined;
      try {
        current = await readRunLock(paths);
      } catch {
        // Verrou illisible : il peut subsister. On le dit au lieu de l'ignorer.
        return 'FAILED';
      }
      if (current === undefined) return 'ALREADY_GONE';
      // On ne supprime jamais le verrou d'un autre propriétaire.
      if (current.lock_id !== info.lock_id) return 'NOT_OWNER';
      try {
        await unlink(file);
        return 'RELEASED';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ALREADY_GONE' : 'FAILED';
      }
    },
  };
}

/**
 * Supprime un verrou périmé. Réservé à `ccr recover`.
 *
 * Ne supprime rien si le propriétaire est vivant ou si le verrou vient d'un
 * autre hôte.
 */
export async function clearStaleLock(paths: RunPaths): Promise<RunLockInfo | undefined> {
  const existing = await readRunLock(paths);
  if (existing === undefined) return undefined;
  if (assessLiveness(existing) !== 'STALE') {
    throw conflictError(existing, assessLiveness(existing), paths.runId);
  }
  await unlink(lockFilePath(paths)).catch(() => undefined);
  return existing;
}

/**
 * Observateurs facultatifs du cycle de vie du verrou.
 *
 * Ils permettent à un hôte long-lived d'associer une opération au verrou
 * **exact** qu'elle vient d'obtenir (V2-IMP-31). Absents — cas de la CLI — le
 * comportement est rigoureusement celui de la V1.
 */
export interface RunLockHooks {
  /**
   * Appelé avec l'identité du verrou **avant** sa publication.
   *
   * C'est ici qu'un hôte long-lived associe l'opération au verrou : le
   * faire après la publication rouvrirait la fenêtre de faux orphelin.
   */
  onIdentityPrepared?(info: RunLockInfo): void;
  /** Appelé après acquisition effective, avant l'opération métier. */
  onAcquired?(info: RunLockInfo): void;
  /** Appelé si l'acquisition n'aboutit pas : l'intention doit être retirée. */
  onAcquireFailed?(): void;
  /** Appelé après la tentative de libération, en toutes circonstances. */
  onReleased?(info: RunLockInfo, outcome: LockReleaseOutcome): void;
}

/** Exécute une opération mutante sous verrou, libéré en toutes circonstances. */
export async function withRunLock<T>(
  paths: RunPaths,
  command: string,
  operation: (lock: RunLockHandle) => Promise<T>,
  hooks?: RunLockHooks,
): Promise<T> {
  let lock: RunLockHandle;
  try {
    lock = await acquireRunLock(paths, command, {
      ...(hooks?.onIdentityPrepared === undefined ? {} : { onIdentityPrepared: hooks.onIdentityPrepared }),
    });
  } catch (error) {
    // L'acquisition a échoué : l'identité annoncée n'a jamais été publiée et
    // l'intention doit disparaître, sans quoi elle fuirait dans le registre.
    hooks?.onAcquireFailed?.();
    throw error;
  }

  hooks?.onAcquired?.(lock.info);
  try {
    return await operation(lock);
  } finally {
    const outcome = await lock.release();
    hooks?.onReleased?.(lock.info, outcome);
  }
}
