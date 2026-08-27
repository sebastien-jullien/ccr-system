/**
 * Répertoires temporaires pour les tests d'intégration.
 *
 * Les CLI d'agents laissent parfois des fichiers verrouillés derrière elles
 * sous Windows (`EBUSY`). Le nettoyage ne doit jamais transformer un test par
 * ailleurs concluant en échec, ni masquer son résultat réel.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Répertoire encore verrouillé : sans conséquence sur le verdict du test.
  }
}
