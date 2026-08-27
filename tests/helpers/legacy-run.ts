/**
 * Fabrication d'un run **V1 historique** pour les tests de lecture legacy.
 *
 * Depuis V2-IMP-28, la création d'un nouveau run exige un snapshot runtime :
 * `startRun` ne peut plus produire un run non pinné, et c'est précisément la
 * garantie recherchée. La compatibilité V1 porte sur la **lecture** de runs
 * déjà présents sur disque, pas sur la faculté d'en créer de nouveaux.
 *
 * Ce helper matérialise donc un run legacy comme une **fixture disque** : le
 * run est créé normalement, puis son manifest est réécrit sous sa forme V1,
 * dépourvue de `runtime_config`. C'est exactement ce qu'un poste ayant utilisé
 * CCR V1 contient aujourd'hui.
 *
 * Aucun chemin de production n'est emprunté pour retirer le snapshot.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { runPaths } from '../../src/store/layout.ts';

/**
 * Réécrit le manifest d'un run existant sous sa forme V1 historique.
 *
 * @returns le contenu exact du manifest legacy écrit, utile pour prouver
 *          ensuite qu'aucune lecture ne l'a modifié.
 */
export async function demoteToLegacyManifest(runsDir: string, runId: string): Promise<string> {
  const paths = runPaths(runsDir, runId);
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as Record<string, unknown>;
  delete manifest['runtime_config'];
  const legacy = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(paths.manifest, legacy, 'utf8');
  return legacy;
}
