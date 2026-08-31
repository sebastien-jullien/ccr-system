/**
 * Commit d'une issue terminale d'invocation, sous sérialisation.
 *
 * ## Pourquoi une reprise de verrou ici, et pas ailleurs
 *
 * Les trois chemins assistés — détection V3, adduction V4, proposition V5 —
 * partagent la même architecture en trois phases : la phase A **relâche** le
 * verrou de run avant d'entrer dans l'adaptateur, parce qu'un verrou ne doit
 * pas couvrir une latence de fournisseur. La classification terminale naît donc
 * hors de toute sérialisation.
 *
 * Ce module rouvre une frontière **courte**, uniquement pour la séquence
 * lecture → vérification → écriture. C'est exactement le motif que le
 * proposeur emploie déjà pour persister l'usage après le retour du fournisseur
 * (`v5-propose-model-usage`) ; aucun mécanisme nouveau n'est introduit.
 *
 * ## Ce que ce module n'est pas
 *
 * Il n'est **pas** destiné aux chemins natifs. `START` possède sa propre
 * frontière courte, et `SEND`, `STEP` et la reprise d'initialisation écrivent
 * déjà sous un verrou détenu : les y faire passer reprendrait un verrou non
 * réentrant et échouerait en `RUN_ALREADY_LOCKED`.
 */

import { appendInvocationOutcome } from '../store/invocation-outcome-store.ts';
import type { TerminalOutcome } from '../core/invocation-outcome.ts';
import { runPaths } from '../store/layout.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';

export interface InvocationOutcomeWriterDeps {
  readonly runsDir: string;
  now(): Date;
}

/**
 * Persiste l'issue terminale, puis rend la main.
 *
 * L'appelant doit invoquer cette fonction **avant** d'exposer son résultat :
 * c'est l'ordre que le contrat de durabilité impose, et il n'est pas
 * inversable. Un échec ici remonte tel quel — `INVOCATION_OUTCOME_WRITE_FAILED`
 * — et prend la place du résultat, qui ne doit jamais paraître garanti alors
 * qu'il ne l'est pas. Aucun rejeu fournisseur, aucun remboursement de quota :
 * l'invocation a bien été consommée, et l'échec porte sur la persistance seule.
 *
 * Vaut pour les deux familles que cette autorité porte — issue négative et
 * `VALID_ZERO`. Aucun succès attesté par son propre objet de domaine n'y entre.
 */
export async function commitInvocationOutcome(
  deps: InvocationOutcomeWriterDeps,
  runId: string,
  command: string,
  invocationId: string,
  outcome: TerminalOutcome,
): Promise<void> {
  await withNativeMutation({ runsDir: deps.runsDir, runId, command }, async () => {
    await appendInvocationOutcome(
      runPaths(deps.runsDir, runId),
      invocationId,
      outcome,
      deps.now().toISOString(),
    );
  });
}
