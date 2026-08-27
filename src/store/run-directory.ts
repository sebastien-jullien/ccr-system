/**
 * Répertoire de runs — identification et énumération **bi-génération**
 * (V2.1-IMP-17B).
 *
 * ## Pourquoi ce module existe
 *
 * Trois surfaces posent la même question — « de quel run parle-t-on, et de
 * quelle génération ? » — et une seule savait y répondre : la plomberie de la
 * CLI. Faire dépendre le transport HTTP de `src/cli/` aurait inversé la
 * dépendance ; la dupliquer aurait créé deux réponses à une question qui n'en
 * admet qu'une.
 *
 * ## Ce que ce module contient, et ce qu'il ne contiendra jamais
 *
 * Il lit **deux petits documents par run** — `manifest.json` et `state.json` —
 * et n'en rend que des scalaires déjà persistés. Aucun journal n'est ouvert,
 * aucune capacité n'est dérivée, aucune reprise n'est classifiée, aucun
 * fournisseur n'est sondé. C'est ce qui garde une énumération utilisable
 * pendant qu'un autre processus détient le verrou d'un run.
 *
 * Les deux champs propres à une génération ne se traduisent **jamais** l'un en
 * l'autre : un `active_expert_slot` natif ne devient pas un `claude|codex`, et
 * un `active_agent` historique ne devient pas un slot. Chacun est nul dans
 * l'autre génération, et son absence est un fait, pas une lacune.
 */

import { isCcrError } from '../core/errors.ts';
import type { AgentKind } from '../core/run.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import type { RunExecutionMode } from '../core/run-native.ts';
import type { ControlOwner, RunState } from '../core/state.ts';
import { CcrError } from '../core/errors.ts';
import { listRunIds, runPaths } from './layout.ts';
import { readPersistedManifest, readPersistedState } from './native-store.ts';

/**
 * Étiquette de génération, réexportée ici.
 *
 * Ce n'est pas un format natif : c'est le **discriminant** qu'une surface
 * bi-génération doit nommer. Les consommateurs l'obtiennent d'ici, et
 * n'acquièrent pour autant aucune connaissance des documents natifs — ils ne
 * reçoivent que les scalaires normalisés ci-dessous.
 */
export type { RunExecutionMode } from '../core/run-native.ts';

/**
 * Identité d'un ExpertSlot, réexportée pour la même raison.
 *
 * Une surface bi-génération doit pouvoir **nommer** le slot actif d'un run
 * natif sans apprendre à lire un journal ou un manifest natif. Le type est une
 * union de deux littéraux ; il ne donne accès à aucun format.
 */
export type { ExpertSlotId } from '../core/expert.ts';

/**
 * Faits d'identité d'un run, normalisés, quelle que soit sa génération.
 *
 * Volontairement plat : aucun document n'est exposé, donc aucun consommateur
 * n'a besoin de savoir lire un manifest natif pour énumérer des runs.
 */
export interface RunDirectoryEntry {
  readonly runId: string;
  /** `null` lorsque le run est présent mais illisible. */
  readonly generation: RunExecutionMode | null;
  readonly title: string | null;
  readonly createdAt: string | null;
  readonly workspaceCwd: string | null;
  readonly state: RunState | null;
  readonly control: ControlOwner | null;
  readonly round: number | null;
  readonly updatedAt: string | null;
  readonly runtimePinned: boolean | null;
  /** Historique uniquement. Toujours `null` sur un run natif. */
  readonly activeAgent: AgentKind | null;
  /** Natif uniquement. Toujours `null` sur un run historique. */
  readonly activeExpertSlot: ExpertSlotId | null;
  /** Code CCR renseigné si et seulement si le run est illisible. */
  readonly error?: string;
}

/** Génération d'un run, lue depuis son manifest et de nulle part ailleurs. */
export async function readRunGeneration(runsDir: string, runId: string): Promise<RunExecutionMode> {
  return (await readPersistedManifest(runPaths(runsDir, runId))).execution_mode;
}

/**
 * Lit les faits d'identité d'un run, sans jamais lever pour une illisibilité.
 *
 * Un run corrompu, ou portant une version qu'aucune génération ne connaît,
 * reste **visible** avec son code : le masquer serait pire que l'afficher.
 */
export async function readRunDirectoryEntry(runsDir: string, runId: string): Promise<RunDirectoryEntry> {
  const paths = runPaths(runsDir, runId);
  try {
    const manifest = await readPersistedManifest(paths);
    const state = await readPersistedState(paths);
    if (manifest.execution_mode !== state.execution_mode) {
      // Deux documents d'un même run se réclamant de générations différentes :
      // personne ne tranche, et surtout pas une énumération.
      throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
        details: { runId, manifest: manifest.execution_mode, state: state.execution_mode },
      });
    }

    const common = {
      runId,
      generation: manifest.execution_mode,
      title: manifest.manifest.title,
      createdAt: manifest.manifest.created_at,
      workspaceCwd: manifest.manifest.workspace.cwd,
      state: state.document.state,
      control: state.document.control,
      round: state.document.round,
      updatedAt: state.document.updated_at,
      runtimePinned: manifest.manifest.runtime_config !== undefined,
    };

    return manifest.execution_mode === 'NATIVE_V21_EXECUTION'
      ? {
          ...common,
          activeAgent: null,
          activeExpertSlot:
            state.execution_mode === 'NATIVE_V21_EXECUTION' ? state.document.active_expert_slot : null,
        }
      : {
          ...common,
          activeAgent: state.execution_mode === 'LEGACY_V2_EXECUTION' ? state.document.active_agent : null,
          activeExpertSlot: null,
        };
  } catch (error) {
    return {
      runId,
      generation: null,
      title: null,
      createdAt: null,
      workspaceCwd: null,
      state: null,
      control: null,
      round: null,
      updatedAt: null,
      runtimePinned: null,
      activeAgent: null,
      activeExpertSlot: null,
      error: isCcrError(error) ? error.code : String(error),
    };
  }
}

/** Énumère les runs, quelle que soit leur génération. O(runs) sur deux fichiers. */
export async function listRunDirectory(runsDir: string): Promise<readonly RunDirectoryEntry[]> {
  const runIds = await listRunIds(runsDir);
  const entries: RunDirectoryEntry[] = [];
  for (const runId of runIds) entries.push(await readRunDirectoryEntry(runsDir, runId));
  return entries;
}

/**
 * Run visé, quelle que soit sa génération.
 *
 * Même politique que la résolution historique — le run le plus récent qui n'est
 * pas clos — mais avec le lecteur **des deux générations** : le lecteur
 * historique refuse un état natif, et un run natif serait donc invisible, ou
 * pire, remplacé silencieusement par un run plus ancien.
 */
export async function resolveAnyRunId(runsDir: string, explicit?: string): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const runIds = [...(await listRunIds(runsDir))].reverse();
  for (const runId of runIds) {
    try {
      const state = await readPersistedState(runPaths(runsDir, runId));
      if (state.document.state !== 'CLOSED') return runId;
    } catch {
      // Run illisible : il ne peut pas être le run actif implicite.
    }
  }

  throw new CcrError(
    'NO_ACTIVE_RUN',
    "Aucun run actif : précisez --run <run_id>, ou créez un run avec `ccr start`.",
    { details: { runsDir } },
  );
}

/** Run visé **et** sa génération, en une seule résolution. */
export async function resolveRunTarget(
  runsDir: string,
  explicit?: string,
): Promise<{ runId: string; generation: RunExecutionMode }> {
  const runId = await resolveAnyRunId(runsDir, explicit);
  return { runId, generation: await readRunGeneration(runsDir, runId) };
}
