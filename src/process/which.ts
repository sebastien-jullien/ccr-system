/**
 * Localisation d'un exécutable dans le `PATH`.
 *
 * CCR lance les CLI officielles sans shell (spécification V1, §46). Il lui
 * faut donc un fichier réellement exécutable par `spawn`, ce qui exclut sous
 * Windows les shims `.cmd`, `.bat` et `.ps1` : depuis Node 18.20/20.12 ceux-ci
 * exigent `shell: true`, que la spécification demande d'éviter.
 *
 * Ce module se limite à la recherche de fichiers ; il ne connaît aucun agent.
 */

import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/** Extensions lançables directement par `spawn` sous Windows. */
const WINDOWS_DIRECT_EXTENSIONS = ['.exe', '.com'] as const;

/** Extensions d'un point d'entrée à exécuter via Node plutôt que directement. */
const NODE_SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;

export function isNodeScript(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  return NODE_SCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function listPathDirectories(
  pathEnv: string | undefined = process.env['PATH'] ?? process.env['Path'],
): string[] {
  if (pathEnv === undefined || pathEnv.length === 0) return [];
  return pathEnv
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0);
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Premier fichier existant parmi `fileNames`, cherché dans `dirs`. */
export function findFirstExisting(
  dirs: readonly string[],
  fileNames: readonly string[],
): string | undefined {
  for (const dir of dirs) {
    for (const name of fileNames) {
      const candidate = path.join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* entrée absente */
      }
    }
  }
  return undefined;
}

/**
 * Exécutable lançable directement (sans shell) portant ce nom.
 * Retourne `undefined` si seul un shim non lançable existe.
 */
export function findDirectExecutable(
  name: string,
  dirs: readonly string[] = listPathDirectories(),
): string | undefined {
  const candidates =
    process.platform === 'win32' ? WINDOWS_DIRECT_EXTENSIONS.map((ext) => `${name}${ext}`) : [name];

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return undefined;
}
