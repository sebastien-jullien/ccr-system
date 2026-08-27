/**
 * Composition applicative — **résolution unique** des réglages d'exécution
 * (limite L1 du ledger Slice 0 ; amendement V2-IMP-33).
 *
 * Ferme le dernier écart possible entre ce que le cockpit **annonce** et ce
 * que le service **fera** : le garde-fou de transfert est résolu une fois, ici,
 * puis partagé. Deux résolutions indépendantes ne sont plus représentables dans
 * la composition normale.
 *
 * ```text
 * resolveRunExecutionSettings()   ← une seule lecture de l'environnement
 *   ├─ RunServiceDeps.maxTransferBytes      exécute réellement `step`
 *   └─ CockpitReadModelDeps.settings        annonce la capacité `STEP`
 *
 * HostOperationRegistry (hôte)    ← une seule instance par processus cockpit
 *   ├─ RunServiceDeps.hostRegistry          enregistre les opérations en vol
 *   └─ CockpitReadModelDeps.hostRegistry    les reconnaît comme vivantes
 * ```
 *
 * Le registre suit la même règle que les réglages, et pour la même raison : un
 * second registre ferait voir au cockpit des opérations « orphelines » qui sont
 * en réalité les siennes (limite L4).
 *
 * L'injection bas niveau reste possible pour les tests unitaires ; c'est la
 * composition **applicative** qui garantit l'unicité.
 */

import { createCliDeps } from './deps.ts';
import type { CliDepsOverrides } from './deps.ts';
import { resolveRunExecutionSettings } from '../services/run-execution-settings.ts';
import type { RunExecutionSettings } from '../services/run-execution-settings.ts';
import type { RunRuntimeSettings, RunServiceDeps } from '../services/run-service.ts';
import type { CockpitReadModelDeps } from '../services/cockpit-read-model.ts';
import type { HostOperationRegistry } from '../lock/host-operation-registry.ts';
import { resolveRunsDir } from '../store/layout.ts';

export interface CcrApplication {
  readonly runsDir: string;
  /** Réglages effectifs, partagés par les deux couches. */
  readonly settings: RunExecutionSettings;
  readonly runService: RunServiceDeps;
  /**
   * Fabrique de dépendances de run **paramétrée par le snapshot runtime**.
   *
   * `runService` ci-dessus est figé à la composition ; un run qui vient d'être
   * créé, lui, doit s'exécuter avec la configuration que son propre preflight
   * a figée. C'est exactement le contrat qu'attend `startRunWithPreflight`, et
   * la seule façon de le lui donner sans que le cockpit recompose la politique.
   */
  createRunServiceDeps(runtime: RunRuntimeSettings): RunServiceDeps;
  readonly readModel: CockpitReadModelDeps;
}

export interface ComposeOptions {
  readonly runsDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly depsOverrides?: CliDepsOverrides;
  /**
   * Registre d'un hôte long-lived. Absent hors serveur : la classification de
   * vivacité reste prudente. Son instanciation appartient au Slice 2.
   */
  readonly hostRegistry?: HostOperationRegistry;
}

/**
 * Compose les dépendances applicatives de lecture **et** d'exécution.
 *
 * Point d'entrée unique : tout appelant qui a besoin des deux — le futur
 * serveur cockpit au premier chef — passe par ici et ne peut donc pas obtenir
 * deux valeurs différentes.
 */
export function composeCcrApplication(options: ComposeOptions = {}): CcrApplication {
  const runsDir = resolveRunsDir(options.runsDir);
  const settings = resolveRunExecutionSettings(options.env);

  const runService = createCliDeps(options.runsDir, {
    ...options.depsOverrides,
    settings,
    // Le **même** objet que celui remis au read model : deux registres
    // distincts feraient diverger ce que le cockpit observe de ce que le
    // service exécute (limite L4).
    ...(options.hostRegistry === undefined ? {} : { hostRegistry: options.hostRegistry }),
  });

  return {
    runsDir,
    settings,
    runService,
    createRunServiceDeps: (runtime: RunRuntimeSettings): RunServiceDeps =>
      createCliDeps(options.runsDir, {
        ...options.depsOverrides,
        settings,
        codexSkipGitRepoCheck: runtime.codexSkipGitRepoCheck,
        ...(options.hostRegistry === undefined ? {} : { hostRegistry: options.hostRegistry }),
      }),
    readModel: {
      runsDir,
      settings,
      ...(options.hostRegistry === undefined ? {} : { hostRegistry: options.hostRegistry }),
    },
  };
}
