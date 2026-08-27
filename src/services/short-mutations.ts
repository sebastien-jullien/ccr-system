/**
 * Mutations courtes — composition **section critique unique**
 * (V0.2 §11.2, §23 ; amendement V2-IMP-37).
 *
 * ## Le problème que ce module existe pour résoudre
 *
 * `expected_revision` protège l'utilisateur contre l'action prise sur une vue
 * périmée. Cette protection ne vaut que si la vérification et l'effet sont dans
 * la **même** section critique :
 *
 * ```text
 * FAUX     lire la révision → acquérir le verrou → agir
 *          entre la lecture et le verrou, le run peut changer : la
 *          vérification portait sur un monde révolu (TOCTOU)
 *
 * JUSTE    acquérir le verrou → lire la révision → vérifier → agir → relire
 * ```
 *
 * Le run lock est le point de sérialisation de CCR : sous ce verrou, aucune
 * autre opération CCR ne peut muter le run. La révision lue après acquisition
 * est donc celle sur laquelle l'effet s'appliquera, sans intervalle.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il ne réimplémente **aucune** règle métier. Gardes, transitions, événements,
 * décisions et erreurs restent ceux de V1 : il appelle les primitives
 * `…Locked` du service, exactement celles que la CLI atteint par ses propres
 * façades. Le transport ne devient jamais une seconde autorité.
 *
 * Il n'acquiert pas non plus deux fois le verrou : les façades publiques
 * (`pauseRun`, `stopRun`…) le prennent elles-mêmes et ne sont donc jamais
 * appelées ici. Une garde structurelle le vérifie.
 */

import { CcrError } from '../core/errors.ts';
import { withRunLock } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import { assertExpectedRevision, readStableRunSnapshot } from '../store/run-snapshot.ts';
import {
  hostLockHooks,
  pauseRunLocked,
  recordDecisionLocked,
  resumeRunLocked,
  stopRunLocked,
} from './run-service.ts';
import type { RunServiceDeps } from './run-service.ts';
import { decideGuard } from '../core/run-guards.ts';

/** Surface exacte du Slice 4. `STEP` et `SEND` n'en font pas partie. */
export const SHORT_MUTATION_ACTIONS = ['PAUSE', 'RESUME', 'DECIDE', 'STOP'] as const;
export type ShortMutationAction = (typeof SHORT_MUTATION_ACTIONS)[number];

/** Commande portée par le verrou, identique à celle qu'emploie la CLI. */
const LOCK_COMMAND: Readonly<Record<ShortMutationAction, string>> = {
  PAUSE: 'pause',
  RESUME: 'resume',
  DECIDE: 'decide',
  STOP: 'stop',
};

export interface ShortMutationInput {
  readonly runId: string;
  readonly action: ShortMutationAction;
  /** Révision de la `RunView` sur laquelle l'humain a décidé d'agir. */
  readonly expectedRevision: string;
  /** Contenu de la décision — `DECIDE` uniquement. */
  readonly content?: string;
}

export interface ShortMutationOutcome {
  readonly runId: string;
  readonly action: ShortMutationAction;
  readonly revisionBefore: string;
  readonly revisionAfter: string;
  /** Faux lorsque la primitive V1 était déjà satisfaite : aucun événement. */
  readonly changed: boolean;
  readonly decisionId?: string;
}

/**
 * Point d'observation de la section critique — **test uniquement**.
 *
 * Sans lui, la fenêtre TOCTOU que ce module ferme ne serait éprouvable que de
 * façon probabiliste. `beforeLock` s'exécute après la validation et avant
 * l'acquisition ; `afterEffect` après la mutation canonique et avant que
 * l'appelant ne finalise son reçu.
 */
export interface ShortMutationSeams {
  readonly beforeLock?: () => void | Promise<void>;
  readonly afterEffect?: () => void | Promise<void>;
}

/**
 * Applique une mutation courte sous **un seul** run lock.
 *
 * Ordre garanti : verrou → révision courante → comparaison → effet V1 →
 * relecture de la révision. Un `STALE_REVISION` interrompt avant tout effet :
 * aucun événement, aucune décision, aucun changement d'état.
 */
export async function applyShortMutation(
  deps: RunServiceDeps,
  input: ShortMutationInput,
  seams: ShortMutationSeams = {},
): Promise<ShortMutationOutcome> {
  const { runId, action } = input;

  // Validation métier qui ne dépend pas de l'état : elle appartient à V1 et
  // n'est pas réécrite ici — la même garde partagée est consultée.
  const content = input.content === undefined ? undefined : input.content.trim();
  if (action === 'DECIDE' && decideGuard((content ?? '').length > 0).kind === 'REFUSED') {
    throw new CcrError('INVALID_ARGUMENT', 'Une décision ne peut pas être vide.');
  }

  await seams.beforeLock?.();

  const paths = runPaths(deps.runsDir, runId);
  return withRunLock(
    paths,
    LOCK_COMMAND[action],
    async () => {
      // Sous verrou : ce que l'on lit est ce sur quoi on agira.
      const before = await readStableRunSnapshot(deps.runsDir, runId);
      assertExpectedRevision(input.expectedRevision, before.revision);

      let changed = true;
      let decisionId: string | undefined;

      switch (action) {
        case 'PAUSE':
          changed = (await pauseRunLocked(deps, runId)).changed;
          break;
        case 'RESUME':
          changed = (await resumeRunLocked(deps, runId)).changed;
          break;
        case 'STOP':
          changed = (await stopRunLocked(deps, runId)).changed;
          break;
        case 'DECIDE': {
          const result = await recordDecisionLocked(deps, runId, content ?? '');
          decisionId = result.decision.decision_id;
          break;
        }
      }

      await seams.afterEffect?.();

      const after = await readStableRunSnapshot(deps.runsDir, runId);
      return {
        runId,
        action,
        revisionBefore: before.revision,
        revisionAfter: after.revision,
        changed,
        ...(decisionId === undefined ? {} : { decisionId }),
      };
    },
    hostLockHooks(deps, runId, LOCK_COMMAND[action]),
  );
}
