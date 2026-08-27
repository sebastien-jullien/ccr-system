/**
 * Probe runtime Codex (spécification V1.1, §7.1, §9).
 *
 * Observe :
 *
 *   codex --version         présence et version
 *   codex login status      statut d'authentification rapporté par la CLI
 *
 * **Résolution partagée (§7.1, INV-11-16).** Le launcher est celui de
 * l'adapter V1, importé tel quel. Le défaut visé est démontré sur ce poste :
 * `spawn("codex", { shell: false })` échoue en `ENOENT` alors que Codex est
 * installé et utilisé avec succès par la V1 — l'installation npm n'expose
 * qu'un shim `codex.cmd`. Un probe naïf conclurait à une CLI absente.
 *
 * **Contrat observé sur la CLI installée (0.146.0).** `codex login status`
 * répond exit 0 en écrivant sur `stderr`, `stdout` restant vide. Les deux flux
 * sont donc examinés, séparément et sans jamais être fusionnés.
 *
 * **Exit 1 est surchargé (§9.1, amendement V0.2-04).** Une erreur de
 * `config.toml` produit le même code qu'une session absente. Sans le marqueur
 * explicite, le statut reste `UNKNOWN` : proposer une reconnexion pour un
 * problème de configuration ne le résoudrait pas.
 *
 * Aucune résolution des providers Codex n'est tentée : ni profils, ni
 * `model_providers`, ni `env_key`. V1.1 ne devient pas un moteur de résolution
 * de fournisseurs.
 */

import { resolveCodexLauncher } from '../adapters/codex-adapter.ts';
import type { AgentRuntimeProbe, RuntimeAuthStatus, RuntimeDiagnostic, RuntimeProbeOptions } from './agent-runtime-probe.ts';
import {
  buildProbe,
  cliNotFound,
  hasMarker,
  interpretVersion,
  isUnresolvedLauncher,
  runProbeCommand,
} from './agent-runtime-probe.ts';
import type { AgentLauncher } from '../adapters/agent-adapter.ts';

/**
 * Résolution partagée avec l'adapter V1 — même référence de fonction.
 * L'égalité est vérifiée par test : une réimplémentation locale la romprait.
 */
export const resolveLauncher = resolveCodexLauncher;

const VERSION_ARGS = ['--version'] as const;
const LOGIN_STATUS_ARGS = ['login', 'status'] as const;

/** Marqueur explicite de session absente (§9.1). Chaîne fermée. */
const NOT_LOGGED_IN_MARKER = 'not logged in';

/**
 * Marqueur d'erreur de configuration. Reconnaissance de surface, volontairement
 * limitée : elle nomme le fichier, elle n'en interprète pas le contenu.
 */
const CONFIG_ERROR_MARKER = 'config.toml';

interface AuthVerdict {
  readonly authStatus: RuntimeAuthStatus;
  readonly authDiagnostic?: RuntimeDiagnostic;
}

/**
 * Table d'interprétation Codex réellement implémentée (§9.1).
 *
 * | Observation                                        | Statut            |
 * |----------------------------------------------------|-------------------|
 * | exit 0                                             | `AUTHENTICATED`   |
 * | exit 1 **et** `Not logged in` sur `stdout` ou `stderr` | `UNAUTHENTICATED` |
 * | exit 1 **et** marqueur de configuration            | `UNKNOWN` + `PROVIDER_CONFIG_ERROR` |
 * | exit 1 sans marqueur                               | `UNKNOWN`         |
 * | timeout, autre exit, lancement impossible          | `UNKNOWN`         |
 *
 * Une sortie inconnue n'est jamais interprétée optimistement.
 */
export function interpretCodexAuth(outcome: {
  readonly launchFailed: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): AuthVerdict {
  if (outcome.launchFailed || outcome.timedOut) {
    return { authStatus: 'UNKNOWN', authDiagnostic: 'AUTH_STATUS_COMMAND_FAILED' };
  }
  if (outcome.exitCode === 0) return { authStatus: 'AUTHENTICATED' };

  const streams = [outcome.stdout, outcome.stderr];

  if (outcome.exitCode === 1) {
    if (hasMarker(streams, NOT_LOGGED_IN_MARKER)) return { authStatus: 'UNAUTHENTICATED' };
    if (hasMarker(streams, CONFIG_ERROR_MARKER)) {
      return { authStatus: 'UNKNOWN', authDiagnostic: 'PROVIDER_CONFIG_ERROR' };
    }
    return { authStatus: 'UNKNOWN', authDiagnostic: 'AUTH_STATUS_UNRECOGNIZED' };
  }

  return { authStatus: 'UNKNOWN', authDiagnostic: 'AUTH_STATUS_COMMAND_FAILED' };
}

export async function probeCodexRuntime(options: RuntimeProbeOptions = {}): Promise<AgentRuntimeProbe> {
  let launcher: AgentLauncher;
  try {
    launcher = options.launcher ?? resolveLauncher(options.executable);
  } catch (error) {
    if (isUnresolvedLauncher(error)) return cliNotFound('codex');
    throw error;
  }

  const versionOutcome = await runProbeCommand(launcher, VERSION_ARGS, options);
  if (versionOutcome.launchFailed) {
    return cliNotFound('codex');
  }

  const authOutcome = await runProbeCommand(launcher, LOGIN_STATUS_ARGS, options);

  return buildProbe({
    agent: 'codex',
    launcherSource: launcher.source,
    ...interpretVersion(versionOutcome),
    ...interpretCodexAuth(authOutcome),
  });
}
