/**
 * Résolution d'identité de run — étage S1 des contrats machine de portée run.
 *
 * ## L'autorité n'est pas créée ici
 *
 * Un run est résolu **si et seulement si** son identité est reconnue
 * DÉCOUVRABLE par l'autorité d'énumération des runs — celle-là même dont
 * descendent l'inventaire machine et les descripteurs (F1). Ce module la
 * consomme ; il n'en définit pas une seconde.
 *
 * ```text
 * AUTORITÉ   listRunIds()   store/layout.ts
 *            la même fonction que `ccr list --format json` et
 *            `ccr run-descriptors`, appelée directement
 * ```
 *
 * **Réemploi d'autorité sémantique, non composition de commandes.** Aucune
 * surface F1 n'est invoquée, aucune sortie machine n'est analysée, et aucun
 * consommateur n'a à appeler F1 avant R1 ou R2.
 *
 * ## La lisibilité n'est pas une condition
 *
 * L'inventaire l'énonce pour lui-même — « La lisibilité des documents d'un run
 * n'est pas une condition d'inclusion » — et ce module en hérite sans le
 * réinterpréter : il n'ouvre aucun document, et ne peut donc pas faire dépendre
 * une identité de ce qu'un fichier contient.
 *
 * ```text
 * identité découvrable · métadonnée de domaine ABSENTE     →  S1 RÉUSSIT
 * identité découvrable · métadonnée de domaine ILLISIBLE   →  S1 RÉUSSIT
 * identité NON DÉCOUVRABLE                                 →  S1 ÉCHOUE
 * ```
 *
 * Ce que S1 laisse ouvert appartient à S2 : savoir si la question posée a un
 * sens pour ce run est une autre étape, avec sa propre issue.
 */

import { CcrError } from '../core/errors.ts';
import { listRunIds } from '../store/layout.ts';

/**
 * L'identité est-elle découvrable ?
 *
 * Aucun document n'est ouvert : la réponse ne dépend que de l'énumération.
 */
export async function isRunDiscoverable(runsDir: string, runId: string): Promise<boolean> {
  return (await listRunIds(runsDir)).includes(runId);
}

/**
 * Exige que le sélecteur désigne un run découvrable.
 *
 * Ne rend rien : un préalable satisfait n'est pas un fait à publier. Les détails
 * de l'erreur ne portent que l'identifiant demandé — aucun chemin interne ne
 * remonte vers une surface publique, fût-elle un diagnostic non normatif.
 */
export async function requireDiscoverableRun(runsDir: string, runId: string): Promise<void> {
  if (await isRunDiscoverable(runsDir, runId)) return;
  throw new CcrError('RUN_NOT_FOUND', `Aucun run découvrable ${runId}.`, {
    details: { runId },
  });
}
