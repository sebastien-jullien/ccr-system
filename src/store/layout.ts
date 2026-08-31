/**
 * Disposition sur disque d'un run CCR (spécification V1, §10).
 *
 *   <runsDir>/<run_id>/
 *   ├── manifest.json
 *   ├── state.json
 *   ├── events.jsonl
 *   ├── decisions.jsonl
 *   ├── rounds/
 *   └── artifacts/
 *
 * Aucun index d'affichage n'est produit : la V2 pourra en dériver un depuis
 * ces fichiers, qui restent l'autorité.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatRoundDirName, isRunId } from '../core/ids.ts';

/** Racine du dépôt CCR, déduite de l'emplacement de ce module. */
export const CCR_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

export const DEFAULT_RUNS_SUBDIR = path.join('.ccr', 'runs');

export interface RunPaths {
  readonly runId: string;
  readonly root: string;
  readonly manifest: string;
  readonly state: string;
  readonly events: string;
  readonly decisions: string;
  readonly roundsDir: string;
  readonly artifactsDir: string;
  /**
   * Journaux de gouvernance d'usage (CCR V2.2, `V2.2-IMP-01`).
   *
   * Additifs, et **hors révision** : une écriture d'usage ne doit jamais
   * invalider une précondition métier. Leur absence est l'état normal d'un run
   * antérieur au ledger, jamais une corruption.
   */
  readonly invocations: string;
  readonly usage: string;
  /**
   * Document canonique des issues négatives terminales d'invocation.
   *
   * Additif et **hors révision de run**. Document **atomique**, jamais un
   * journal : une queue partielle stable rendrait illisibles des faits déjà
   * commités, ce que le contrat de durabilité interdit.
   *
   * Son absence est l'état normal d'un run sans issue négative, et de tout run
   * antérieur à cette source. Absence et document vide y commandent la même
   * sémantique — aucune conclusion —, raison pour laquelle aucun marqueur de
   * naissance n'existe.
   */
  readonly invocationOutcomes: string;
  /**
   * Politique de quota d'invocations du run (CCR V2.2, `V2.2-IMP-07`).
   *
   * Additive et **hors révision**, comme les deux journaux. Son absence est le
   * cas normal — et le fait exact : aucune politique de quota CCR.
   */
  readonly invocationPolicy: string;
  /**
   * Journal V3 des controverses (contrat V3, `C-1`).
   *
   * Additif et **hors révision de run** : une entrée de controverse ne change
   * pas l'état opérationnel du run, et ne doit donc jamais invalider une
   * précondition métier native. Son absence est l'état normal de tout run
   * antérieur à V3 — décrire le chemin ne matérialise pas la source.
   */
  readonly controversies: string;
  /**
   * Journal V4 de l'Evidence Engine (contrat V4, §14.1).
   *
   * Additif et **hors révision de run** : enregistrer un matériau ou l'adduire
   * au débat ne change pas l'état opérationnel du run, et ne doit donc jamais
   * invalider une précondition métier native. Son absence est l'état normal de
   * tout run antérieur à V4 — décrire le chemin ne matérialise pas la source.
   */
  readonly evidence: string;
  /**
   * Journal V5 du Reconciliation Engine (contrat V5 §27.1).
   *
   * Additif et **hors révision de run** : enregistrer une proposition, un acte
   * humain ou une réponse ne change pas l'état opérationnel du run, et ne doit
   * donc jamais invalider une précondition métier native. Son absence est l'état
   * normal de tout run antérieur à V5 — décrire le chemin ne matérialise pas la
   * source.
   *
   * Journal **dédié** : aucun enregistrement V5 ne rejoint `events.jsonl`,
   * `controversies.jsonl`, `evidence.jsonl` ni `decisions.jsonl`, et aucun de
   * ces journaux n'est muté.
   */
  readonly reconciliations: string;
}

export function resolveRunsDir(explicit?: string): string {
  const candidate = explicit ?? process.env['CCR_RUNS_DIR'];
  return candidate !== undefined && candidate.length > 0
    ? path.resolve(candidate)
    : path.join(CCR_ROOT, DEFAULT_RUNS_SUBDIR);
}

export function runPaths(runsDir: string, runId: string): RunPaths {
  const root = path.join(runsDir, runId);
  return {
    runId,
    root,
    manifest: path.join(root, 'manifest.json'),
    state: path.join(root, 'state.json'),
    events: path.join(root, 'events.jsonl'),
    decisions: path.join(root, 'decisions.jsonl'),
    roundsDir: path.join(root, 'rounds'),
    artifactsDir: path.join(root, 'artifacts'),
    invocations: path.join(root, 'invocations.jsonl'),
    usage: path.join(root, 'usage.jsonl'),
    invocationOutcomes: path.join(root, 'invocation-outcomes.json'),
    invocationPolicy: path.join(root, 'invocation-policy.json'),
    controversies: path.join(root, 'controversies.jsonl'),
    evidence: path.join(root, 'evidence.jsonl'),
    reconciliations: path.join(root, 'reconciliations.jsonl'),
  };
}

export function roundDir(paths: RunPaths, round: number): string {
  return path.join(paths.roundsDir, formatRoundDirName(round));
}

/** Identifiants de run présents sur disque, triés par ordre croissant. */
export async function listRunIds(runsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && isRunId(entry.name))
    .map((entry) => entry.name)
    .sort();
}
