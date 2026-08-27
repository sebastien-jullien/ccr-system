/**
 * Lecture cohérente d'un journal JSONL append-only
 * (CCR V2 V0.2 §10 ; amendement d'implémentation V2-IMP-29).
 *
 * ## Défaut corrigé
 *
 * `appendJsonLine` écrit une ligne entière puis la synchronise, mais une
 * ligne volumineuse — plusieurs dizaines de kibioctets sont observées dans les
 * journaux réels du dépôt — n'atteint pas le disque en une seule écriture
 * atomique. Un lecteur concurrent peut donc observer le journal **pendant**
 * l'append, et voir sa dernière ligne tronquée.
 *
 * Le lecteur historique interprétait cette troncature comme une corruption du
 * journal : la lecture d'un run échouait intégralement, alors que rien n'était
 * corrompu.
 *
 * ## Ce qui est toléré, et rien d'autre
 *
 * ```text
 * lignes terminées par un saut de ligne  →  strictement valides, sans appel
 * fragment final NON terminé             →  seul candidat transitoire
 * ```
 *
 * Un saut de ligne prouve que l'append de cette ligne est terminé : une ligne
 * terminée invalide est une corruption **stable**, et échoue immédiatement,
 * sans la moindre reprise. Une invalidité interne au journal ne peut pas non
 * plus être réparée par un append futur : même traitement.
 *
 * Seul le fragment final non terminé peut légitimement devenir valide dans les
 * millisecondes qui suivent. Il est donc, et lui seul, relu.
 *
 * ## Ce que ce module ne fait jamais
 *
 * Il ne tronque pas, ne supprime pas la dernière ligne, n'ignore aucun record
 * invalide, ne réécrit pas le journal, n'ajoute aucun saut de ligne, et ne
 * retourne jamais « seulement ce qui était valide avant l'erreur ».
 *
 * > Tolérant à la concurrence, jamais à la corruption.
 *
 * ## Aucun verrou
 *
 * La lecture ne prend **aucun** run lock. Un lecteur — le futur cockpit, ou
 * `ccr status` — doit pouvoir observer un run pendant `WAITING_AGENT`, alors
 * que le processus agent détient le verrou pour une durée pouvant atteindre le
 * timeout fournisseur. La robustesse au fragment transitoire est assurée par le
 * lecteur lui-même, pas par une exclusion mutuelle.
 *
 * ## Portée
 *
 * Ce module traite **un** fichier append-only. La cohérence entre plusieurs
 * sources canoniques — manifest, état, journaux — relève de la révision et du
 * snapshot cohérent (V0.2 §11), hors de ce périmètre.
 *
 * Il est distinct de `atomic-file.ts` à dessein : `readTextWithRetry` y reprend
 * des **erreurs de système de fichiers** sur des documents remplacés par
 * `rename`. Le problème traité ici est d'une autre nature — un contenu
 * partiellement écrit, lisible sans erreur.
 */

import { readFile } from 'node:fs/promises';

import { CcrError } from '../core/errors.ts';

/** Enregistrement validé, accompagné de sa ligne d'origine (1-based). */
export interface JournalRecord<T> {
  readonly lineNumber: number;
  readonly value: T;
}

/**
 * Budget de reprise du fragment final.
 *
 * Dimensionné pour une écriture locale en cours, pas pour attendre un
 * fournisseur : au pire une centaine de millisecondes ajoutées à une lecture,
 * jamais davantage.
 */
export interface TailRetryBudget {
  /** Tentatives **totales**, première lecture comprise. */
  readonly attempts: number;
  /** Attente avant chaque nouvelle tentative, en millisecondes. */
  readonly delaysMs: readonly number[];
}

export const DEFAULT_TAIL_RETRY: TailRetryBudget = {
  attempts: 5,
  delaysMs: [5, 15, 30, 50],
};

export interface ReadJournalOptions<T> {
  /**
   * Analyse et valide **une** ligne complète.
   *
   * Propre à chaque journal : la mécanique JSONL est commune, la validation
   * des enregistrements ne l'est pas.
   */
  readonly parseLine: (line: string, lineNumber: number) => T;
  /** Seam de lecture, pour des tests déterministes. */
  readonly read?: (file: string) => Promise<string>;
  /** Seam d'attente, pour des tests déterministes. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly budget?: TailRetryBudget;
  /** Diagnostic interne. N'écrit jamais sur une sortie utilisateur. */
  readonly onTailRetry?: (attempt: number) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `JSON.parse` d'une ligne de journal, converti en erreur CCR stable.
 *
 * Le contenu de la ligne n'est jamais recopié dans le message public : un
 * journal contient des réponses d'agents intégrales.
 */
export function parseJournalLine(line: string, lineNumber: number, journal: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (cause) {
    throw new CcrError('JOURNAL_INVALID', `${journal} ligne ${lineNumber} : JSON illisible.`, {
      details: { journal, line: lineNumber },
      cause,
    });
  }
}

/** Découpe le contenu en lignes terminées et en fragment final éventuel. */
function split(raw: string): { readonly terminated: string; readonly tail: string; readonly tailLine: number } {
  const lastNewline = raw.lastIndexOf('\n');
  const terminated = lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1);
  const tail = lastNewline === -1 ? raw : raw.slice(lastNewline + 1);

  // Numéro de la ligne portant le fragment : autant de sauts de ligne
  // consommés, plus un.
  let newlines = 0;
  for (let index = 0; index < terminated.length; index += 1) {
    if (terminated[index] === '\n') newlines += 1;
  }
  return { terminated, tail, tailLine: newlines + 1 };
}

/**
 * Lit un journal JSONL append-only.
 *
 * Un journal absent est un journal vide : contrat V1 conservé. Il n'est jamais
 * remplacé par `rename`, donc son `ENOENT` est univoque et n'est pas repris.
 *
 * Les lignes blanches sont ignorées, comme historiquement.
 */
export async function readJsonlJournal<T>(
  file: string,
  options: ReadJournalOptions<T>,
): Promise<JournalRecord<T>[]> {
  const read = options.read ?? ((target: string): Promise<string> => readFile(target, 'utf8'));
  const sleep = options.sleep ?? defaultSleep;
  const budget = options.budget ?? DEFAULT_TAIL_RETRY;

  for (let attempt = 1; ; attempt += 1) {
    let raw: string;
    try {
      raw = await read(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const { terminated, tail, tailLine } = split(raw);

    // ------------------------------------------------------------------
    // Lignes terminées : aucune tolérance, aucune reprise. Un saut de ligne
    // prouve que leur écriture est achevée ; leur invalidité est stable.
    // ------------------------------------------------------------------
    const records: JournalRecord<T>[] = [];
    const lines = terminated.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = (lines[index] ?? '').trim();
      if (line.length === 0) continue;
      records.push({ lineNumber: index + 1, value: options.parseLine(line, index + 1) });
    }

    // ------------------------------------------------------------------
    // Fragment final non terminé : seul candidat transitoire.
    // ------------------------------------------------------------------
    const fragment = tail.trim();
    if (fragment.length === 0) return records;

    let tailError: unknown;
    try {
      // Déjà complet et valide : accepté tel quel. Le saut de ligne final
      // n'est pas exigé lorsque le contenu se suffit.
      records.push({ lineNumber: tailLine, value: options.parseLine(fragment, tailLine) });
      return records;
    } catch (error) {
      tailError = error;
    }

    // Budget épuisé : le fragment est stable, donc réellement invalide.
    // L'erreur rendue est exactement celle que la validation a produite.
    if (attempt >= budget.attempts) throw tailError;

    options.onTailRetry?.(attempt);
    await sleep(budget.delaysMs[attempt - 1] ?? budget.delaysMs.at(-1) ?? 50);
  }
}
