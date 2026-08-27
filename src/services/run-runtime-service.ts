/**
 * `ccr setup --run <run_id>` — mutation explicite du snapshot d'un run
 * (spécification V1.1, §15.7, INV-11-19).
 *
 * C'est une **porte de sortie exceptionnelle**, pas un workflow nominal : un
 * run créé avec `skip_git_repo_check = false` serait autrement condamné, sans
 * autre issue que sa clôture et la perte du couple de sessions natives.
 *
 * Toutes les conditions sont exigées conjointement :
 *
 *   terminal interactif · run existant · contrôle HUMAIN
 *   état PAUSED ou WAITING_HUMAN · aucune opération en vol · run lock acquis
 *
 * Et rien d'autre ne bouge : aucun agent appelé, aucune reprise automatique,
 * aucun changement d'état ni de contrôle, aucune recapture des versions
 * observées au démarrage — celles-ci décrivent le contexte **initial** du run,
 * que la mutation ne réécrit pas. C'est l'événement `runtime_config_changed`
 * qui documente le changement.
 */

import { CcrError } from '../core/errors.ts';
import type { RunManifest, RunRuntimeConfig } from '../core/run.ts';
import { withRunLock } from '../lock/run-lock.ts';
import { openEventStore } from '../store/event-store.ts';
import { runPaths } from '../store/layout.ts';
import { loadRun, writeManifest } from '../store/state-store.ts';

export interface UpdateRunRuntimeInput {
  readonly runId: string;
  /** Nouvelle valeur exécutable. Seule clé mutable par cette commande. */
  readonly skipGitRepoCheck: boolean;
}

export interface UpdateRunRuntimeResult {
  readonly runId: string;
  readonly previous: boolean;
  readonly next: boolean;
  readonly manifest: RunManifest;
  readonly eventId: string;
}

/** Le snapshot d'un run pinné, ou une erreur explicite s'il n'y en a pas. */
export function requirePinnedSnapshot(manifest: RunManifest): RunRuntimeConfig {
  const snapshot = manifest.runtime_config;
  if (snapshot === undefined) {
    // Aucune migration implicite : un run V1 historique n'acquiert pas un
    // snapshot parce qu'on a tenté de le modifier (§14.0, INV-11-09).
    throw new CcrError(
      'MANIFEST_INVALID',
      `Le run ${manifest.run_id} est un run V1 historique : sa configuration runtime n'est pas ` +
        "figée, et CCR ne la fige pas rétroactivement. Créez un nouveau run pour bénéficier d'une " +
        'configuration reproductible.',
      { details: { runId: manifest.run_id, field: 'runtime_config', reason: 'LEGACY_UNPINNED' } },
    );
  }
  return snapshot;
}

/**
 * Applique la mutation sous le run lock.
 *
 * Les conditions sont revérifiées **après** l'acquisition du verrou : l'état
 * observé avant lui n'engage à rien, un autre processus ayant pu le changer.
 */
export async function updateRunRuntimeConfig(
  runsDir: string,
  input: UpdateRunRuntimeInput,
  now: () => Date = () => new Date(),
): Promise<UpdateRunRuntimeResult> {
  const paths = runPaths(runsDir, input.runId);

  return withRunLock(paths, 'setup --run', async () => {
    const loaded = await loadRun(runsDir, input.runId);
    const snapshot = requirePinnedSnapshot(loaded.manifest);

    if (loaded.state.control !== 'HUMAN') {
      throw new CcrError(
        'AUTOMATION_NOT_IN_CONTROL',
        `Le run ${input.runId} est sous contrôle de l'automatisation. ` +
          'Suspendez-le (`ccr pause`) avant de modifier sa configuration runtime.',
        { details: { runId: input.runId, control: loaded.state.control } },
      );
    }

    if (loaded.state.state !== 'PAUSED' && loaded.state.state !== 'WAITING_HUMAN') {
      throw new CcrError(
        'ILLEGAL_STATE_TRANSITION',
        `La configuration runtime d'un run ne peut être modifiée qu'en PAUSED ou WAITING_HUMAN ` +
          `(état actuel : ${loaded.state.state}).`,
        { details: { runId: input.runId, state: loaded.state.state } },
      );
    }

    if (loaded.state.pending_operation !== null) {
      throw new CcrError(
        'RECOVERY_REQUIRED',
        `Une opération « ${loaded.state.pending_operation.kind} » est engagée sur le run ` +
          `${input.runId}. Résolvez-la (\`ccr recover\`) avant de modifier sa configuration runtime.`,
        { details: { runId: input.runId, pendingOperation: loaded.state.pending_operation.kind } },
      );
    }

    const previous = snapshot.codex.skip_git_repo_check;

    // Seule la clé autorisée change. `captured_at`, versions et statuts d'auth
    // décrivent le démarrage du run et ne sont pas recapturés.
    const updated: RunManifest = {
      ...loaded.manifest,
      runtime_config: {
        ...snapshot,
        codex: { ...snapshot.codex, skip_git_repo_check: input.skipGitRepoCheck },
      },
    };
    await writeManifest(paths, updated);

    const events = await openEventStore(paths, input.runId);
    const event = await events.append({
      round: loaded.state.round,
      actor: 'human',
      type: 'runtime_config_changed',
      details: {
        key: 'codex.skip_git_repo_check',
        previous,
        next: input.skipGitRepoCheck,
        origin: 'human',
      },
      timestamp: now().toISOString(),
    });

    // Ni état, ni contrôle, ni reprise : la mutation ne rend pas la main à
    // l'automatisation.
    return {
      runId: input.runId,
      previous,
      next: input.skipGitRepoCheck,
      manifest: updated,
      eventId: event.event_id,
    };
  });
}
