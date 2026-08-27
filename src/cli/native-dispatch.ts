/**
 * Aiguillage de génération de la CLI (Slice 2E).
 *
 * Deux générations de runs cohabitent, et **le même mot ne veut pas dire la
 * même chose dans les deux** :
 *
 * ```text
 * run historique   « claude »  →  un agent, identité métier
 * run natif V2.1   « claude »  →  un alias de moteur, secondaire
 * ```
 *
 * La conséquence est un ordre obligatoire : la génération du run est établie
 * depuis ses faits persistés **avant** que l'argument de cible ne soit
 * interprété. Un parseur global qui traduirait `claude` en agent dès la ligne
 * de commande trancherait une question qui appartient au run.
 *
 * ## Où vit désormais la plomberie
 *
 * L'identification et l'énumération sont passées dans `store/run-directory.ts`
 * (V2.1-IMP-17B) : le transport HTTP pose exactement les mêmes questions, et
 * le faire dépendre de `src/cli/` aurait inversé la dépendance. Ce module n'en
 * conserve que la **mise en forme CLI** — le reste est réexporté tel quel, sans
 * la moindre variation de comportement.
 */

import { listRunDirectory } from '../store/run-directory.ts';
import type { RunDirectoryEntry, RunExecutionMode } from '../store/run-directory.ts';
import type { ControlOwner, RunState } from '../core/state.ts';

export {
  listRunDirectory,
  readRunDirectoryEntry,
  readRunGeneration,
  resolveAnyRunId,
  resolveRunTarget,
} from '../store/run-directory.ts';
export type { RunDirectoryEntry, RunExecutionMode } from '../store/run-directory.ts';

/**
 * Résumé d'un run tel que `ccr list` l'affiche.
 *
 * Projection de `RunDirectoryEntry`, volontairement plus pauvre : la CLI
 * n'affiche ni l'identité active, ni le workspace, ni l'épinglage runtime.
 */
export interface RunSummary {
  readonly runId: string;
  /** `null` lorsque le run est présent mais illisible. */
  readonly generation: RunExecutionMode | null;
  readonly title: string;
  readonly state: RunState | null;
  readonly control: ControlOwner | null;
  readonly round: number | null;
  readonly updatedAt: string | null;
  /** Renseigné lorsque le run est présent mais illisible. */
  readonly error?: string;
}

function summaryOf(entry: RunDirectoryEntry): RunSummary {
  return {
    runId: entry.runId,
    generation: entry.generation,
    title: entry.title ?? '(illisible)',
    state: entry.state,
    control: entry.control,
    round: entry.round,
    updatedAt: entry.updatedAt,
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

/**
 * Énumère les runs, quelle que soit leur génération.
 *
 * Le défaut réparé en `IMP-16` tenait entièrement au choix du lecteur :
 * `readManifest` historique valide `schema_version` contre `[1]`, si bien qu'un
 * run natif — parfaitement sain, et créé par cette même CLI — était rapporté
 * « (illisible) » dès sa seconde d'existence.
 *
 * Un run réellement corrompu, ou portant une version qu'aucune génération ne
 * connaît, reste illisible : la compatibilité native ne sert pas de couverture
 * à une corruption.
 */
export async function listAnyRuns(runsDir: string): Promise<RunSummary[]> {
  return (await listRunDirectory(runsDir)).map(summaryOf);
}
