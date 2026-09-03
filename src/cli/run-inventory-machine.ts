/**
 * Représentation machine de l'inventaire des runs découvrables.
 *
 * **Une représentation de l'autorité d'énumération**, et rien d'autre. Elle dit
 * quelles identités de run cette autorité reconnaît comme découvrables, et
 * n'affirme rien de leur contenu.
 *
 * ## Ce que ce module ne fait pas
 *
 * ```text
 * AUCUNE LECTURE      ni manifest, ni state, ni journal, ni système de fichiers
 * AUCUN ÉTAT          ni statut, ni santé, ni complétion, ni maturité
 * AUCUNE PROJECTION   ni titre, ni génération, ni horodatage, ni workspace
 * AUCUN DIAGNOSTIC    l'issue de lecture d'un document n'entre pas ici
 * ```
 *
 * Il reçoit une liste d'identités déjà énumérées et la sérialise. C'est
 * volontaire : faire dépendre l'inventaire d'une lecture par run rendrait
 * l'inclusion d'une identité conditionnelle à la lisibilité de ses documents,
 * ce que le contrat refuse.
 *
 * ## Construction explicite
 *
 * Chaque entrée est bâtie champ par champ. Aucun objet interne n'est diffusé,
 * si bien qu'un champ apparaissant demain en amont ne peut pas fuir dans le
 * contrat public.
 *
 * ## Ordre
 *
 * L'ordre d'énumération traverse tel quel. Ce module n'introduit aucun tri, et
 * le contrat v1 n'attache **aucune** sémantique à la position dans le tableau.
 */

/** Version du contrat d'inventaire machine — axe public unique. */
export const RUN_INVENTORY_CONTRACT_VERSION = 1;

/** Seule valeur admise par `--format` sur `ccr list`. */
export const RUN_INVENTORY_FORMAT = 'json';

/**
 * Rend l'inventaire machine complet.
 *
 * Une énumération sans identité rend `"runs": []`. Ce tableau vide est une
 * cardinalité : il ne dit ni succès, ni échec, ni santé, ni absence de toute
 * activité CCR passée.
 */
export function serializeRunInventory(runIds: readonly string[]): string {
  const document = {
    run_inventory_contract_version: RUN_INVENTORY_CONTRACT_VERSION,
    // `run_id` est le seul fait d'inventaire autorisé, et il est opaque : ni sa
    // partie date, ni sa partie ordinale ne constituent une interface.
    runs: runIds.map((runId) => ({ run_id: runId })),
  };

  return JSON.stringify(document, null, 2);
}
