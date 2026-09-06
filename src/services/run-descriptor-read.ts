/**
 * Découverte sémantique machine des runs — lecture (F1).
 *
 * Une **seconde** projection de l'autorité d'énumération, jamais une seconde
 * autorité. Elle énumère exactement les mêmes identités que l'inventaire, puis
 * associe à chacune le titre canonique enregistré dans son manifest.
 *
 * ```text
 * ÉNUMÉRATION   la même que `ccr list` — `listRunIds`, et rien d'autre
 * TITRE         le titre canonique du manifest, verbatim
 * ```
 *
 * ## Pourquoi une lecture par run, ici, et pas dans l'inventaire
 *
 * L'inventaire refuse d'ouvrir un document : l'inclusion d'une identité ne doit
 * pas dépendre de la lisibilité de ses fichiers. F1 pose une question
 * différente — « quel est le titre de ce run ? » — à laquelle seul le manifest
 * répond. La lecture est donc inévitable, et sa conséquence est assumée : un
 * run dont le titre ne peut pas être établi avec autorité empêche le document.
 *
 * ```text
 * TITRE NON ÉTABLISSABLE  →  AUCUN DOCUMENT
 * ```
 *
 * Rendre un descripteur sans titre, ou avec un titre nul, transformerait une
 * ignorance en valeur. Rendre les autres descripteurs sans lui produirait un
 * document partiel qu'aucun consommateur ne pourrait distinguer d'un document
 * complet. Le contrat interdit les deux : la lecture lève, et la CLI refuse.
 *
 * ## Bi-génération
 *
 * `title` appartient aux deux schémas de manifest. La lecture passe donc par
 * le lecteur bi-génération, et ne convertit ni ne préfère aucune génération.
 *
 * ## Ce que cette lecture ne rend jamais
 *
 * ```text
 * aucun état          ni state, ni control, ni round, ni santé
 * aucun horodatage    ni created_at, ni updated_at
 * aucun workspace     ni cwd, ni déclaration
 * aucune génération   ni native, ni historique
 * aucun fournisseur, aucune session, aucune activité
 * ```
 */

import { runPaths } from '../store/layout.ts';
import { listRunIds } from '../store/layout.ts';
import { readPersistedManifest } from '../store/native-store.ts';

/**
 * Descripteur d'un run — deux faits, et exactement deux.
 *
 * `run_id` reste **opaque** : ni sa partie date, ni sa partie ordinale ne
 * constituent une interface. `title` est le titre canonique enregistré, rendu
 * verbatim : CCR ne le normalise pas, ne le tronque pas, et ne garantit pas
 * son unicité.
 */
export interface RunDescriptor {
  readonly run_id: string;
  readonly title: string;
}

/** Vue complète — ou rien. Aucune variante partielle n'existe. */
export interface RunDescriptorsView {
  readonly descriptors: readonly RunDescriptor[];
}

/**
 * Lit les descripteurs de tous les runs découvrables.
 *
 * Deux issues, et deux seulement :
 *
 * ```text
 * SUCCÈS   tous les runs découvrables portent leur titre
 * LEVÉE    au moins un titre n'a pas pu être établi avec autorité
 * ```
 *
 * L'ordre traverse celui de l'énumération. Le contrat n'attache aucune
 * sémantique à la position dans le tableau, et cette lecture n'en introduit
 * aucune : elle ne trie ni par titre, ni par date, ni par état.
 *
 * Les titres en double sont **conservés** tels quels, comme deux descripteurs
 * distincts. L'unicité n'est pas garantie, et déduplique­r effacerait un run.
 */
export async function readRunDescriptors(runsDir: string): Promise<RunDescriptorsView> {
  // Même autorité d'énumération que l'inventaire. Un échec d'énumération —
  // autre que l'absence du répertoire, que `listRunIds` traite en zéro —
  // traverse et empêche tout document.
  const runIds = await listRunIds(runsDir);

  const descriptors: RunDescriptor[] = [];
  for (const runId of runIds) {
    // Aucun `try` : un manifest absent, illisible, d'une version inconnue ou
    // d'une génération non supportée est exactement le cas où le titre n'est
    // pas établissable. La levée est le comportement contractuel.
    const persisted = await readPersistedManifest(runPaths(runsDir, runId));
    descriptors.push({ run_id: runId, title: persisted.manifest.title });
  }

  return { descriptors };
}
