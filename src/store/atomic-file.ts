/**
 * Primitives de fichier pour la persistance CCR (spécification V1, §11, §12).
 *
 * Deux garanties distinctes :
 *
 *  - `writeJsonAtomic` : un crash ne doit jamais laisser un document mutable
 *    partiellement écrit. Écriture temporaire → `fsync` → `rename`.
 *  - `appendJsonLine` : journaux strictement append-only. Aucune fonction de
 *    ce module ne permet de réécrire une ligne déjà journalisée.
 *
 * Ces primitives ignorent totalement la sémantique CCR.
 */

import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

let temporaryCounter = 0;

/**
 * Codes d'erreur transitoires de `rename` sous Windows.
 *
 * Constaté : sur Windows, remplacer un fichier dont un autre handle est ouvert
 * échoue en `EPERM`, alors que POSIX l'autorise. Un simple `ccr status` lancé
 * dans un second terminal, un éditeur ouvert sur `state.json`, un antivirus ou
 * un indexeur suffisent à provoquer le cas.
 *
 * La reprise ne relâche rien sur l'atomicité : `rename` reste tout-ou-rien.
 * On attend seulement que le verrou transitoire du lecteur se libère.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Stratégie de reprise du remplacement (amendement IMP-14).
 *
 * La stratégie initiale — 12 tentatives, délais croissants 15…165 ms, soit
 * ~990 ms — s'épuisait réellement sur le poste cible : environ un quart des
 * exécutions complètes de la suite rencontraient un `EPERM` définitif.
 *
 * La mesure a montré que ce n'était **pas** un problème de durée totale. Sur
 * ~2 000 remplacements contrariés observés sous contention, aucun n'a mis plus
 * de 556 ms à aboutir, médiane ~60 ms. Ce qui manquait était la **densité** des
 * essais : un tiers — antivirus, indexeur, lecteur concurrent — relâche puis
 * reprend le fichier, et un `rename` qui n'échantillonne que douze fois en une
 * seconde manque ces fenêtres. Un backoff croissant est exactement la mauvaise
 * forme pour ce phénomène.
 *
 * D'où : essais rapprochés, plafonnés à 25 ms, sous un double garde-fou —
 * budget de temps et nombre maximal de tentatives. Le budget est dimensionné à
 * plus de trois fois le pire cas observé.
 *
 * Le chemin normal reste gratuit : sans contention, un seul appel, aucun délai.
 */
const RENAME_MAX_ATTEMPTS = 100;
const RENAME_RETRY_BUDGET_MS = 2_000;
const RENAME_DELAYS_MS = [5, 10, 15, 20] as const;
const RENAME_DELAY_CAP_MS = 25;

/**
 * Reprise symétrique côté **lecture** (amendement IMP-08).
 *
 * Défaut démontré empiriquement sur Windows pendant l'implémentation V1.1 :
 * un lecteur ouvrant le document canonique exactement pendant le `rename` de
 * remplacement observe `ENOENT`. Le document n'est jamais partiel — c'est le
 * *nom* qui disparaît brièvement.
 *
 * Sans reprise, la conséquence n'est pas une erreur bruyante mais un mensonge
 * silencieux : `readConfig` conclut « fichier absent » et applique ses valeurs
 * par défaut, faisant passer une configuration persistée à `true` pour un
 * `false`. `readState` conclut `RUN_NOT_FOUND` pour un run existant.
 *
 * `ENOENT` est le seul de ces codes qu'un fichier **réellement** absent produit
 * aussi. Sa reprise est donc volontairement plus courte : elle borne le coût du
 * chemin nominal « pas de configuration » à quelques dizaines de millisecondes.
 *
 * Après épuisement, l'erreur réelle est relancée telle quelle : aucune erreur
 * permanente n'est masquée. Le parsing, lui, n'est jamais rejoué.
 */
const TRANSIENT_READ_CODES = new Set(['ENOENT', 'EPERM', 'EACCES', 'EBUSY']);
const ABSENT_CODE = 'ENOENT';
const READ_MAX_ATTEMPTS_ABSENT = 3;
const READ_MAX_ATTEMPTS_LOCKED = 6;
const READ_DELAYS_MS = [5, 15, 30, 50, 75] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Seams de la stratégie de reprise.
 *
 * Uniquement destinés à éprouver la politique de façon déterministe : aucune
 * signature publique n'est modifiée, et `writeJsonAtomic` n'en fournit aucun.
 */
export interface RenameRetryOptions {
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly platform?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Remplace `from` par `to`, en absorbant les verrous transitoires.
 *
 * `rename` reste tout-ou-rien : la reprise ne relâche rien sur l'atomicité.
 * La destination n'est **jamais** supprimée au préalable pour faciliter
 * l'opération — cela rouvrirait exactement la fenêtre `ENOENT` côté lecteur
 * corrigée par IMP-08.
 *
 * Après épuisement, l'erreur réelle est propagée telle quelle.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const doRename = options.rename ?? rename;
  const platform = options.platform ?? process.platform;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const startedAt = now();

  for (let attempt = 1; ; attempt += 1) {
    try {
      await doRename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      // Le phénomène est propre à Windows ; ailleurs, `rename` est atomique
      // pour les ouvreurs concurrents et une erreur est une erreur.
      const retryable = platform === 'win32' && TRANSIENT_RENAME_CODES.has(code);
      if (!retryable) throw error;

      const exhausted = attempt >= RENAME_MAX_ATTEMPTS || now() - startedAt >= RENAME_RETRY_BUDGET_MS;
      if (exhausted) throw error;

      await sleep(RENAME_DELAYS_MS[attempt - 1] ?? RENAME_DELAY_CAP_MS);
    }
  }
}

/** `fsync` du répertoire : rend le `rename` durable sur les systèmes POSIX. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Certains systèmes de fichiers refusent l'ouverture d'un répertoire.
  } finally {
    await handle?.close();
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Écrit un document JSON de façon atomique.
 *
 * Un lecteur concurrent observe soit l'ancien contenu complet, soit le
 * nouveau, jamais un état intermédiaire.
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = path.dirname(file);
  temporaryCounter += 1;
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${temporaryCounter}.tmp`);
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  let handle;
  try {
    handle = await open(temporary, 'w');
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();

  try {
    await renameWithRetry(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  await syncDirectory(dir);
}

/**
 * Lit un fichier texte en absorbant la fenêtre de remplacement (IMP-08).
 *
 * `read` est injectable afin que la politique de reprise soit éprouvée
 * déterministement, sans dépendre d'une course.
 */
export async function readTextWithRetry(
  file: string,
  read: (target: string) => Promise<string> = (target) => readFile(target, 'utf8'),
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_READ_CODES.has(code)) throw error;

      const maxAttempts = code === ABSENT_CODE ? READ_MAX_ATTEMPTS_ABSENT : READ_MAX_ATTEMPTS_LOCKED;
      // Épuisement : on relance l'erreur réelle, jamais une interprétation.
      if (attempt >= maxAttempts) throw error;

      await delay(READ_DELAYS_MS[attempt - 1] ?? READ_DELAYS_MS[READ_DELAYS_MS.length - 1] ?? 75);
    }
  }
}

/**
 * Lit un document JSON canonique.
 *
 * L'accès est repris ; l'analyse ne l'est jamais. Un JSON invalide est un fait
 * stable : le rejouer ne ferait que masquer un document corrompu.
 */
export async function readJsonFile(file: string): Promise<unknown> {
  const raw = await readTextWithRetry(file);
  return JSON.parse(raw) as unknown;
}

/**
 * Ajoute une ligne à un journal append-only.
 *
 * Le contenu déjà présent n'est jamais relu, réécrit ni tronqué : une
 * correction doit produire un nouvel enregistrement.
 */
export async function appendJsonLine(file: string, data: unknown): Promise<void> {
  const line = `${JSON.stringify(data)}\n`;
  const handle = await open(file, 'a');
  try {
    await handle.writeFile(line, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * La lecture d'un journal JSONL append-only n'appartient pas à ce module.
 *
 * Elle exige une sémantique propre — distinguer un fragment final en cours
 * d'écriture d'une corruption stable — que la reprise sur erreurs de système
 * de fichiers ci-dessus ne fournit pas et ne doit pas fournir. Elle vit dans
 * `jsonl-journal.ts` (V2-IMP-29), et il n'existe volontairement **qu'un seul**
 * lecteur de journal dans CCR.
 */
