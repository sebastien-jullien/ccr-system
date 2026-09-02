/**
 * Lecture restreinte des faits dédiés d'issue d'invocation.
 *
 * Projection **dérivée**, calculée à la demande, qui ne persiste rien et ne
 * lit qu'une seule source :
 *
 * ```text
 * SOURCE UNIQUE   la persistance des issues d'invocation
 * ```
 *
 * ## Centrée sur le fait, jamais sur l'engagement
 *
 * Cette vue énumère **les enregistrements qui existent**, pas les invocations
 * qui pourraient en porter un. Elle n'ouvre donc ni le registre d'engagement,
 * ni le transcript natif, ni les observations d'usage, ni aucun journal de
 * domaine.
 *
 * ```text
 * JOINTURE AVEC invocations.jsonl   AUCUNE
 * JOINTURE NATIVE / DOMAINE / USAGE AUCUNE
 * ```
 *
 * La conséquence est voulue : un identifiant d'invocation sans enregistrement
 * rend **zéro fait**, et rien d'autre. Cette vue ne sait pas — et ne cherche
 * pas à savoir — si cette invocation a été engagée, si elle a réussi ailleurs,
 * ou si elle n'a jamais existé. Consulter le registre pour le dire créerait
 * ici une lecture d'état d'invocation que cette surface n'a pas à porter.
 *
 * ## Normalisation d'enveloppe, et rien d'autre
 *
 * Deux versions d'enregistrement coexistent, sous deux noms de champ :
 *
 * ```text
 * v1   terminal_negative_outcome
 * v2   terminal_outcome
 * ```
 *
 * La vue expose un champ unique `outcome`, obtenu par `terminalOutcomeOf`, et
 * conserve à côté la version **source** de l'enregistrement. C'est une
 * normalisation d'enveloppe de stockage :
 *
 * ```text
 * NORMALISÉ    le nom du champ conteneur
 * PRÉSERVÉS    le genre d'issue, sa charge utile typée, ses vocabulaires
 *              de motif, et la version qui l'a persisté
 * ```
 *
 * Aucun genre n'est renommé, aucun motif n'est remappé, aucun vocabulaire
 * V3/V4/V5 n'est fusionné, aucune équivalence sémantique n'est inventée.
 *
 * ## Ce que cette vue ne rend jamais
 *
 * ```text
 * aucun mot d'état par invocation    ni SUCCESS, ni FAILED, ni UNKNOWN, ni OK
 * aucune preuve de succès dérivée    SUCCESS_EVIDENCE n'est pas calculé
 * aucune contradiction croisée       INCONSISTENT n'est pas calculé
 * aucun agrégat de run               ni compte, ni taux, ni tri par gravité
 * aucun succès générique             il n'en existe aucun à rendre
 * ```
 *
 * ## Absence, corruption, version
 *
 * La sémantique d'absence est celle de la persistance sous-jacente, reprise
 * telle quelle : un conteneur absent y vaut collection vide. Cette vue
 * n'ajoute aucune distinction publique entre « fichier absent » et
 * « collection vide » — le contrat porte sur les faits rendus, pas sur
 * l'existence physique d'un conteneur.
 *
 * Une corruption et une version non prise en charge **lèvent**, et ne
 * deviennent jamais une collection vide : rendre le sous-ensemble qui a bien
 * voulu s'analyser serait exactement la corruption déguisée en absence que la
 * source refuse.
 */

import { CcrError } from '../core/errors.ts';
import { terminalOutcomeOf } from '../core/invocation-outcome.ts';
import type { TerminalOutcome } from '../core/invocation-outcome.ts';
import { parseInvocationSequence } from '../core/usage-governance.ts';
import { readInvocationOutcomes } from '../store/invocation-outcome-store.ts';
import type { RunPaths } from '../store/layout.ts';

/**
 * Un fait dédié, tel que la surface publique l'expose.
 *
 * `source_schema_version` est la version **de l'enregistrement lu**, pas celle
 * du conteneur : elle dit sous quelle forme ce fait-là a été persisté, et elle
 * survit à la normalisation d'enveloppe.
 */
export interface InvocationOutcomeFact {
  readonly invocation_id: string;
  readonly source_schema_version: number;
  readonly recorded_at: string;
  readonly outcome: TerminalOutcome;
}

/** Le résultat d'une requête, dans l'ordre d'ajout persisté. */
export interface InvocationOutcomeFactsView {
  readonly run_id: string;
  /** Renseigné lorsque la requête a été restreinte à une invocation. */
  readonly filter: { readonly invocation_id: string } | undefined;
  readonly facts: readonly InvocationOutcomeFact[];
}

/**
 * Rend les faits dédiés du run, éventuellement filtrés sur une invocation.
 *
 * Le filtre porte sur **le même ensemble d'enregistrements**, et rien de plus :
 * il n'interroge aucune autre autorité pour décider si l'identifiant existe
 * quelque part. Un identifiant canonique sans enregistrement rend zéro fait,
 * ce qui est une cardinalité, jamais un verdict.
 *
 * La syntaxe de l'identifiant est vérifiée parce qu'un identifiant non
 * canonique ne peut correspondre à aucun fait : filtrer dessus rendrait un
 * zéro qui ressemblerait à une réponse alors que la question était mal posée.
 */
export async function readInvocationOutcomeFacts(
  paths: RunPaths,
  options: { readonly invocationId?: string } = {},
): Promise<InvocationOutcomeFactsView> {
  const requested = options.invocationId;

  if (requested !== undefined && parseInvocationSequence(requested) === undefined) {
    throw new CcrError(
      'INVALID_ARGUMENT',
      `Identifiant d'invocation non canonique : ${requested}.`,
      { details: { invocationId: requested } },
    );
  }

  // Source unique. Toute erreur — corruption, version non prise en charge —
  // remonte telle quelle : elle ne se requalifie jamais en collection vide.
  const document = await readInvocationOutcomes(paths);

  const facts = document.outcomes
    .filter((record) => requested === undefined || record.invocation_id === requested)
    .map(
      (record): InvocationOutcomeFact => ({
        invocation_id: record.invocation_id,
        source_schema_version: record.schema_version,
        recorded_at: record.recorded_at,
        outcome: terminalOutcomeOf(record),
      }),
    );

  return {
    run_id: paths.runId,
    filter: requested === undefined ? undefined : { invocation_id: requested },
    facts,
  };
}
