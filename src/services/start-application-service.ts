/**
 * StartApplicationService — voie applicative unique de création d'un run
 * (CCR V2 V0.2, §16 ; amendement d'implémentation V2-IMP-28).
 *
 * ## Défaut corrigé
 *
 * Jusqu'ici, la composition normative
 *
 *   configuration → configuration effective → probes → preflight
 *   → snapshot runtime → allocation → manifest → agents
 *
 * vivait dans `commandStart`, une fonction **privée de la CLI**. Le service
 * exporté `startRun` n'exécutait aucun preflight et acceptait un
 * `runtimeConfig` **optionnel** : tout appelant non-CLI créait donc
 * silencieusement un run V1 legacy non pinné, en violation des invariants
 * V1.1 exigeant que tout nouveau run porte son snapshot.
 *
 * Ce module rend la composition réutilisable, et `StartRunInput.runtimeConfig`
 * est devenu obligatoire : la voie basse ne permet plus la création moderne
 * sans snapshot.
 *
 * ## Frontière
 *
 * Tout ce qui est connaissable **avant** l'engagement est vérifié avant que le
 * moindre répertoire de run soit alloué. Un échec de preflight ne laisse aucun
 * run derrière lui. Une panne fournisseur **après** l'engagement conserve
 * intégralement la sémantique V1 : `FAILED_INITIALIZATION`, sessions déjà
 * créées préservées, aucun rollback.
 *
 * ## Interaction
 *
 * Ce module n'a aucune connaissance de `readline`, `process.stdin`,
 * `process.stdout` ni de la console. Les capacités d'interaction lui sont
 * transmises explicitement (`StartInteraction`), afin qu'un appelant
 * non interactif — un serveur, une tâche planifiée — utilise exactement le
 * même preflight sans qu'aucune remédiation ne puisse être proposée.
 *
 * L'asymétrie Claude / Codex de V1.1 est intégralement déléguée à
 * `runStartPreflight` : ce module ne la reformule pas.
 */

import { RUNTIME_CONFIG_SCHEMA_VERSION } from '../core/run.ts';
import type { AgentRole, RunRuntimeConfig } from '../core/run.ts';
import type { TtyState } from '../runtime/agent-login.ts';
import { runStartPreflight } from '../runtime/preflight-service.ts';
import type {
  StartPreflightDeps,
  StartPreflightResult,
  StartPreflightWarning,
} from '../runtime/preflight-service.ts';
import { startRun } from './run-service.ts';
import type {
  RunRuntimeSettings,
  RunServiceDeps,
  StartRunHooks,
  StartRunResult,
} from './run-service.ts';

// --------------------------------------------------------------------------
// Contrat d'interaction
// --------------------------------------------------------------------------

/**
 * Capacités d'interaction humaine offertes par l'appelant.
 *
 * Le choix est explicite et fermé : il n'existe pas de troisième cas où une
 * remédiation serait « peut-être » possible. Un appelant qui ne peut pas poser
 * de question déclare `non-interactive`, et le preflight applique alors la
 * politique V1.1 correspondante — `AUTH_REQUIRED` sans run pour Claude,
 * avertissement non bloquant pour Codex.
 */
export type StartInteraction =
  | {
      readonly kind: 'non-interactive';
      /** Sortie informative facultative. Aucune question ne sera posée. */
      readonly out?: (text: string) => void;
    }
  | {
      readonly kind: 'interactive';
      readonly out: (text: string) => void;
      /** Invite `[y/N]`. Sa seule présence autorise une remédiation. */
      readonly confirm: (question: string) => Promise<boolean>;
      /** État TTY observé par l'appelant. Absent : détection standard. */
      readonly tty?: TtyState;
    };

/**
 * Seams d'environnement du preflight, hors interaction.
 *
 * `io`, `confirm` et `tty` en sont exclus par construction : ils ne peuvent
 * venir que de `StartInteraction`, afin qu'aucun appelant ne puisse déclarer
 * `non-interactive` tout en glissant une capacité de confirmation.
 */
export type StartPreflightSeams = Omit<StartPreflightDeps, 'io' | 'confirm' | 'tty'>;

// --------------------------------------------------------------------------
// Contrat de la façade
// --------------------------------------------------------------------------

export interface StartApplicationDeps {
  readonly interaction: StartInteraction;
  /**
   * Fabrique les dépendances de run une fois la configuration effective
   * connue.
   *
   * La valeur transmise provient du snapshot que ce module vient de
   * construire, jamais de `process.env` ni d'une relecture de la
   * configuration globale.
   */
  createRunServiceDeps(runtime: RunRuntimeSettings): RunServiceDeps;
  readonly preflight?: StartPreflightSeams;
  /**
   * Invoqué dès la fin du preflight et **avant toute allocation**.
   *
   * Tout ce que l'appelant apprend avant l'engagement passe par ici : c'est
   * aussi ce qui rend la frontière observable dans les tests.
   */
  readonly onPreflight?: (result: StartPreflightResult) => void | Promise<void>;
  /**
   * Invoqué une fois le run alloué et matérialisé, **avant tout fournisseur**.
   *
   * Symétrique de `onPreflight` : l'un marque la dernière seconde où rien
   * n'existe, l'autre la dernière seconde où rien d'externe n'a été appelé.
   * Entre les deux se trouve exactement la fenêtre où une association durable
   * est encore possible et déjà utile.
   */
  readonly onRunAllocated?: StartRunHooks['onAllocated'];
  readonly now?: () => Date;
}

export interface StartApplicationInput {
  readonly title: string;
  readonly cwd: string;
  /** Contexte initial envoyé aux deux agents pour créer leurs sessions. */
  readonly prompt: string;
  readonly claudeRole?: AgentRole;
  readonly codexRole?: AgentRole;
}

export interface StartApplicationResult extends StartRunResult {
  readonly warnings: readonly StartPreflightWarning[];
  /** Snapshot effectivement figé dans le manifest. */
  readonly runtimeConfig: RunRuntimeConfig;
}

// --------------------------------------------------------------------------
// Composition
// --------------------------------------------------------------------------

/**
 * Traduit les capacités déclarées en dépendances de preflight.
 *
 * Le cas `non-interactive` impose un TTY absent en plus de l'absence
 * d'invite : la remédiation devient structurellement impossible, et ne dépend
 * pas de l'état réel du terminal du processus appelant.
 */
function interactionDeps(
  interaction: StartInteraction,
): Pick<StartPreflightDeps, 'io' | 'confirm' | 'tty'> {
  if (interaction.kind === 'non-interactive') {
    return {
      ...(interaction.out === undefined ? {} : { io: { out: interaction.out } }),
      tty: { stdin: false, stdout: false },
    };
  }
  return {
    io: { out: interaction.out },
    confirm: interaction.confirm,
    ...(interaction.tty === undefined ? {} : { tty: interaction.tty }),
  };
}

/**
 * Fige les faits observés par le preflight.
 *
 * `source_at_capture` est recopié tel quel : il documente d'où venait la
 * valeur, et n'est jamais consulté pour exécuter quoi que ce soit. La seule
 * autorité exécutable est `skip_git_repo_check`.
 */
export function buildRuntimeConfig(
  preflight: StartPreflightResult,
  capturedAt: Date,
): RunRuntimeConfig {
  return {
    schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: capturedAt.toISOString(),
    claude: {
      cli_version: preflight.claude.version,
      auth_preflight: preflight.claude.authStatus,
    },
    codex: {
      cli_version: preflight.codex.version,
      auth_preflight: preflight.codex.authStatus,
      skip_git_repo_check: preflight.effectiveConfig.codex.skipGitRepoCheck,
      source_at_capture: preflight.effectiveConfig.codex.source,
    },
  };
}

/**
 * Crée un run V1.1 complet : preflight, snapshot, allocation, sessions.
 *
 * Seule voie autorisée pour créer un nouveau run. Un appelant HTTP futur
 * l'utilise telle quelle ; il n'appelle jamais `startRun` directement.
 */
export async function startRunWithPreflight(
  deps: StartApplicationDeps,
  input: StartApplicationInput,
): Promise<StartApplicationResult> {
  const now = deps.now ?? ((): Date => new Date());

  // ------------------------------------------------------------------
  // Avant engagement. Aucun `run_id`, aucun répertoire, aucun manifest,
  // aucun événement, aucune session fournisseur ne peut exister ici.
  // ------------------------------------------------------------------
  const preflight = await runStartPreflight({
    ...deps.preflight,
    ...interactionDeps(deps.interaction),
  });

  const runtimeConfig = buildRuntimeConfig(preflight, now());
  await deps.onPreflight?.(preflight);

  // ------------------------------------------------------------------
  // Engagement. À partir d'ici la sémantique V1 s'applique intégralement,
  // `FAILED_INITIALIZATION` compris : aucun run n'est détruit pour rendre
  // l'initialisation artificiellement atomique.
  // ------------------------------------------------------------------
  const runServiceDeps = deps.createRunServiceDeps({
    codexSkipGitRepoCheck: runtimeConfig.codex.skip_git_repo_check,
  });

  const result = await startRun(
    runServiceDeps,
    {
      runtimeConfig,
      title: input.title,
      cwd: input.cwd,
      prompt: input.prompt,
      ...(input.claudeRole === undefined ? {} : { claudeRole: input.claudeRole }),
      ...(input.codexRole === undefined ? {} : { codexRole: input.codexRole }),
    },
    deps.onRunAllocated === undefined ? {} : { onAllocated: deps.onRunAllocated },
  );

  return { ...result, warnings: preflight.warnings, runtimeConfig };
}
