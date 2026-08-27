/**
 * Création d'un run depuis le cockpit — composition (V2-IMP-39).
 *
 * ## Ce que ce module n'est pas
 *
 * Il ne recompose **rien**. La politique de création — configuration effective,
 * probes, preflight, snapshot runtime, allocation, sessions natives — vit dans
 * `startRunWithPreflight` et n'existe qu'à un seul endroit. Ce module fournit
 * trois choses que la façade ne peut pas connaître : un workspace validé, un
 * créneau d'admission, et un instant où associer durablement le run créé.
 *
 * ## Ordre garanti
 *
 * ```text
 * (le claim durable a déjà eu lieu, dans la couche HTTP)
 * → workspace canonique                 aucun effet
 * → preflight non interactif            aucun effet, aucun run
 * → admission cockpit                   le créneau se réserve ici
 * → allocation du run                   premier effet durable, run_id connu
 * → association receipt ↔ run           avant tout fournisseur
 * → initialisation des sessions natives
 * ```
 *
 * ## Pourquoi le preflight précède l'admission
 *
 * Un créneau est rare — deux pour toute l'instance. Une tentative déjà
 * condamnée par un workspace inexistant ou une authentification absente ne doit
 * pas en immobiliser un. C'est la même règle qu'au Slice 5 : préconditions
 * d'abord, admission ensuite, effet enfin.
 *
 * ## Pourquoi l'admission précède l'allocation
 *
 * L'inverse laisserait des runs derrière un refus de quota. Un `503` doit être
 * un non-événement : aucun répertoire, aucun manifest, aucune session.
 */

import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

import { CcrError } from '../core/errors.ts';
import { startRunWithPreflight } from './start-application-service.ts';
import type { StartPreflightSeams } from './start-application-service.ts';
import type { RunRuntimeSettings, RunServiceDeps } from './run-service.ts';
import type { LongOperationManager, LongOperationSlot } from '../cockpit/long-operations.ts';

export interface StartMutationInput {
  readonly title: string;
  /** Chemin **syntaxiquement** normalisé, tel qu'il est entré dans l'empreinte. */
  readonly workspaceCwd: string;
  readonly prompt: string;
}

export interface StartMutationOutcome {
  readonly runId: string;
  /** Chemin canonique réellement figé dans le manifest. */
  readonly canonicalCwd: string;
}

/**
 * Coutures de la création.
 *
 * Trois instants gouvernent toutes les preuves d'incertitude, et ils sont
 * distincts :
 *
 * ```text
 * beforeAllocation   créneau pris, RIEN n'existe encore
 * afterAllocation    le run existe, le reçu ne le nomme PAS encore
 * onRunAllocated     le reçu le nomme, aucun fournisseur n'a été joint
 * ```
 *
 * Confondre les deux derniers reviendrait à ignorer précisément la fenêtre où
 * un run peut exister sans que rien ne permette de le rattacher à l'intention
 * qui l'a produit. Aucun appelant de production n'en fournit.
 */
export interface StartMutationHooks {
  /** Le créneau est réservé, rien n'existe encore. */
  onAdmitted?: (operationId: string) => void;
  /** Association durable faite ; aucun fournisseur n'a encore été joint. */
  onRunAllocated?: (runId: string) => void | Promise<void>;
  /** Couture de test : après le claim, avant la validation du workspace. */
  beforePreflight?: () => void | Promise<void>;
  /** Couture de test : admission obtenue, avant l'allocation. */
  beforeAllocation?: () => void | Promise<void>;
  /** Couture de test : run alloué, avant toute association durable. */
  afterAllocation?: (runId: string) => void | Promise<void>;
  /** Couture de test : effet canonique complet, avant le reçu terminal. */
  afterFinalization?: () => void | Promise<void>;
}

export interface StartMutationDeps {
  readonly createRunServiceDeps: (runtime: RunRuntimeSettings) => RunServiceDeps;
  readonly manager: LongOperationManager;
  readonly operationId: string;
  readonly preflightSeams?: StartPreflightSeams;
}

/**
 * Canonicalise le répertoire de travail — et refuse tout le reste.
 *
 * Le navigateur propose un texte ; l'autorité reste ici. Un chemin relatif, un
 * fichier, un lien mort ou un répertoire absent sont refusés **avant** que le
 * preflight ne lance le moindre processus.
 */
export async function canonicalizeWorkspace(input: string): Promise<string> {
  if (!path.isAbsolute(input)) {
    throw new CcrError('INVALID_ARGUMENT', 'Le répertoire de travail doit être un chemin absolu.');
  }
  let canonical: string;
  try {
    canonical = await realpath(input);
  } catch {
    // Le motif exact — absent, permission, lien mort — n'est pas rendu public :
    // il décrirait le système de fichiers de l'hôte à un appelant distant.
    throw new CcrError('INVALID_ARGUMENT', "Le répertoire de travail n'existe pas.");
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new CcrError('INVALID_ARGUMENT', "Le répertoire de travail n'est pas un répertoire.");
  }
  return canonical;
}

export async function applyStartMutation(
  deps: StartMutationDeps,
  input: StartMutationInput,
  hooks: StartMutationHooks = {},
): Promise<StartMutationOutcome> {
  await hooks.beforePreflight?.();

  // Précondition locale, sans le moindre effet et sans créneau consommé.
  const canonicalCwd = await canonicalizeWorkspace(input.workspaceCwd);

  let slot: LongOperationSlot | undefined;
  try {
    const result = await startRunWithPreflight(
      {
        // Jamais de remédiation depuis le web : le preflight est structurellement
        // incapable de poser une question, quel que soit le TTY du serveur.
        interaction: { kind: 'non-interactive' },
        createRunServiceDeps: deps.createRunServiceDeps,
        ...(deps.preflightSeams === undefined ? {} : { preflight: deps.preflightSeams }),
        onPreflight: async () => {
          // Le preflight a réussi : rien n'existe encore, et c'est exactement
          // l'instant où réserver le créneau a un sens.
          slot = deps.manager.admit(deps.operationId);
          hooks.onAdmitted?.(deps.operationId);
          await hooks.beforeAllocation?.();
        },
        onRunAllocated: async (runId) => {
          await hooks.afterAllocation?.(runId);
          await hooks.onRunAllocated?.(runId);
        },
      },
      { title: input.title, cwd: canonicalCwd, prompt: input.prompt },
    );

    if (result.failure !== undefined) {
      // Initialisation partielle : le run existe, la session déjà obtenue est
      // conservée, l'état est `FAILED_INITIALIZATION`. On ne détruit rien pour
      // rendre l'échec atomique — la sémantique V1 est intégralement préservée.
      const error = result.failure.error;
      (error as { runId?: string }).runId = result.runId;
      throw error;
    }

    return { runId: result.runId, canonicalCwd };
  } catch (error) {
    // `beforeAllocation` ou l'association ont pu échouer après l'allocation :
    // l'appelant doit pouvoir nommer le run malgré tout.
    throw error;
  } finally {
    slot?.release();
  }
}
