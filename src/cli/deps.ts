/**
 * Construction des dépendances de la CLI.
 *
 * Seul endroit où la CLI touche aux adapters : elle les fabrique et les
 * transmet aux services. Elle ne les appelle jamais directement et n'interprète
 * aucune de leurs sorties.
 *
 * Configuration par variables d'environnement, volontairement réduite :
 *
 *   CCR_RUNS_DIR                    racine de stockage des runs
 *   CCR_CLAUDE_BIN                  chemin explicite vers la CLI Claude
 *   CCR_CODEX_BIN                   chemin explicite vers la CLI Codex
 *   CCR_AGENT_TIMEOUT_MS            délai maximal d'un tour agent
 *   CCR_CODEX_SANDBOX               politique de bac à sable à la création
 *   CCR_CODEX_SKIP_GIT_REPO_CHECK   contrainte de contexte, pas une fonction CCR
 *   CCR_MAX_TRANSFER_BYTES          garde-fou de transfert automatique (§27)
 */

import { createClaudeAdapter } from '../adapters/claude-adapter.ts';
import { createCodexAdapter } from '../adapters/codex-adapter.ts';
import type { CodexSandboxMode } from '../adapters/codex-adapter.ts';
import { DEFAULT_AGENT_TIMEOUT_MS } from '../adapters/agent-adapter.ts';
import { CcrError } from '../core/errors.ts';
import { resolveRunsDir } from '../store/layout.ts';
import type { RunRuntimeSettings, RunServiceDeps } from '../services/run-service.ts';
import { resolveRunExecutionSettings } from '../services/run-execution-settings.ts';
import type { HostOperationRegistry } from '../lock/host-operation-registry.ts';
import type { RunExecutionSettings } from '../services/run-execution-settings.ts';

const SANDBOX_MODES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access'];

function readTimeout(): number {
  const raw = process.env['CCR_AGENT_TIMEOUT_MS'];
  if (raw === undefined || raw.length === 0) return DEFAULT_AGENT_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CcrError('INVALID_ARGUMENT', `CCR_AGENT_TIMEOUT_MS invalide : ${raw}`);
  }
  return value;
}

function readSandbox(): CodexSandboxMode | undefined {
  const raw = process.env['CCR_CODEX_SANDBOX'];
  if (raw === undefined || raw.length === 0) return undefined;
  if (!SANDBOX_MODES.includes(raw)) {
    throw new CcrError('INVALID_ARGUMENT', `CCR_CODEX_SANDBOX invalide : ${raw}`, {
      details: { allowed: SANDBOX_MODES },
    });
  }
  return raw as CodexSandboxMode;
}

export interface CliDepsOverrides {
  /**
   * Résolution héritée, appliquée **uniquement** à un run dépourvu de snapshot
   * (§13.3). Évaluée paresseusement : un run pinné ne doit jamais dépendre de
   * la configuration globale, pas même pour échouer si celle-ci est illisible.
   *
   * La configuration ne transite jamais par une mutation de `process.env` :
   * elle voyage explicitement jusqu'à l'adapter concerné.
   */
  readonly legacyCodexSkipGitRepoCheck?: () => boolean;
  /** Valeur imposée à tous les adapters, quelle que soit l'origine du run. */
  readonly codexSkipGitRepoCheck?: boolean;
  /**
   * Réglages d'exécution déjà résolus par la composition applicative.
   *
   * Absents, ils sont résolus par la **même** fonction : il n'existe qu'une
   * seule règle de résolution dans tout CCR (V2-IMP-33, limite L1).
   */
  readonly settings?: RunExecutionSettings;
  /**
   * Registre d'opérations d'un hôte long-lived.
   *
   * Fourni par la composition applicative du cockpit, qui passe **le même
   * objet** au service et au read model : c'est la fermeture concrète de la
   * limite L4. Absent hors serveur — la CLI est un processus par commande.
   */
  readonly hostRegistry?: HostOperationRegistry;
  /**
   * Fabrique d adapters imposee.
   *
   * Injection de test uniquement : elle permet d exercer une operation longue
   * sans depenser d appel fournisseur reel, et de bloquer l agent a un instant
   * choisi. La production n en fournit jamais.
   */
  readonly createAdapters?: RunServiceDeps['createAdapters'];
}

export function createCliDeps(
  runsDirOverride?: string,
  overrides: CliDepsOverrides = {},
): RunServiceDeps {
  const runsDir = resolveRunsDir(runsDirOverride);
  const settings = overrides.settings ?? resolveRunExecutionSettings();
  const timeoutMs = readTimeout();
  const sandbox = readSandbox();
  const legacyResolution =
    overrides.legacyCodexSkipGitRepoCheck ??
    ((): boolean => process.env['CCR_CODEX_SKIP_GIT_REPO_CHECK'] === '1');
  const claudeBin = process.env['CCR_CLAUDE_BIN'];
  const codexBin = process.env['CCR_CODEX_BIN'];

  if (overrides.createAdapters !== undefined) {
    return {
      runsDir,
      now: () => new Date(),
      maxTransferBytes: settings.maxTransferBytes,
      createAdapters: overrides.createAdapters,
      ...(overrides.hostRegistry === undefined ? {} : { hostRegistry: overrides.hostRegistry }),
    };
  }

  return {
    runsDir,
    now: () => new Date(),
    maxTransferBytes: settings.maxTransferBytes,
    ...(overrides.hostRegistry === undefined ? {} : { hostRegistry: overrides.hostRegistry }),
    createAdapters(cwd: string, runtime?: RunRuntimeSettings) {
      // Le snapshot du run fait autorité (§13.2). À défaut seulement, la
      // résolution héritée est évaluée — et peut légitimement échouer si la
      // configuration globale est illisible, ce qui ne concerne qu'un run non
      // pinné.
      const skipGitRepoCheck =
        runtime?.codexSkipGitRepoCheck ?? overrides.codexSkipGitRepoCheck ?? legacyResolution();
      return {
        claude: createClaudeAdapter({
          cwd,
          timeoutMs,
          ...(claudeBin === undefined ? {} : { executable: claudeBin }),
        }),
        codex: createCodexAdapter({
          cwd,
          timeoutMs,
          skipGitRepoCheck,
          ...(sandbox === undefined ? {} : { sandbox }),
          ...(codexBin === undefined ? {} : { executable: codexBin }),
        }),
      };
    },
  };
}
