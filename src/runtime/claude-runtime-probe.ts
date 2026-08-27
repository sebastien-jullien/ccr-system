/**
 * Probe runtime Claude Code (spécification V1.1, §7.1, §8).
 *
 * Observe trois faits locaux, et rien d'autre :
 *
 *   claude --version        présence et version
 *   claude auth status      statut d'authentification rapporté par la CLI
 *
 * **Résolution partagée (§7.1, INV-11-16).** Le launcher est celui de
 * l'adapter V1, importé tel quel. Ce n'est pas une duplication de logique :
 * c'est littéralement la même fonction, ce qui rend impossible une divergence
 * entre ce que CCR sonde et ce que CCR lance. Aucun `shell: true`.
 *
 * **Contrat observé sur la CLI installée (2.1.224).** `claude auth status`
 * répond exit 0 avec un document JSON portant `loggedIn`, accompagné de
 * données personnelles — adresse e-mail, organisation, type d'abonnement.
 * Seul le booléen `loggedIn` est lu ; tout le reste est abandonné avec la
 * sortie (§23.2, INV-11-20).
 *
 * **Prudence sur l'inconnu (INV-11-05).** Un exit `1` sans énoncé explicite
 * n'est pas transformé en `UNAUTHENTICATED` : la même sortie peut signaler une
 * sous-commande absente, et proposer une reconnexion ne réparerait rien.
 */

import { resolveClaudeLauncher } from '../adapters/claude-adapter.ts';
import type { AgentRuntimeProbe, RuntimeAuthStatus, RuntimeDiagnostic, RuntimeProbeOptions } from './agent-runtime-probe.ts';
import {
  buildProbe,
  cliNotFound,
  interpretVersion,
  isUnresolvedLauncher,
  runProbeCommand,
} from './agent-runtime-probe.ts';
import type { AgentLauncher } from '../adapters/agent-adapter.ts';

/**
 * Résolution partagée avec l'adapter V1 — même référence de fonction.
 * L'égalité est vérifiée par test : une réimplémentation locale la romprait.
 */
export const resolveLauncher = resolveClaudeLauncher;

const VERSION_ARGS = ['--version'] as const;
const AUTH_STATUS_ARGS = ['auth', 'status'] as const;

/**
 * Lit l'énoncé explicite d'authentification.
 *
 * Un seul champ est retenu. Les flux sont examinés séparément, jamais
 * concaténés, et aucun n'est conservé.
 */
export function readLoggedInStatement(stdout: string, stderr: string): boolean | undefined {
  for (const stream of [stdout, stderr]) {
    const trimmed = stream.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const loggedIn = (parsed as Record<string, unknown>)['loggedIn'];
        if (typeof loggedIn === 'boolean') return loggedIn;
      }
    } catch {
      /* flux suivant : une sortie non structurée ne conclut rien */
    }
  }
  return undefined;
}

interface AuthVerdict {
  readonly authStatus: RuntimeAuthStatus;
  readonly authDiagnostic?: RuntimeDiagnostic;
}

/**
 * Table d'interprétation Claude réellement implémentée.
 *
 * | Observation                              | Statut            |
 * |------------------------------------------|-------------------|
 * | `loggedIn: false`, exit 0 ou 1           | `UNAUTHENTICATED` |
 * | `loggedIn: true`, exit 0                 | `AUTHENTICATED`   |
 * | `loggedIn: true`, exit non nul           | `UNKNOWN`         |
 * | aucun énoncé, exit 0 ou 1                | `UNKNOWN`         |
 * | timeout, autre exit, lancement impossible | `UNKNOWN`         |
 *
 * Une contradiction entre l'énoncé et le code de sortie n'est jamais résolue
 * en faveur de `AUTHENTICATED`.
 */
export function interpretClaudeAuth(outcome: {
  readonly launchFailed: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): AuthVerdict {
  if (outcome.launchFailed || outcome.timedOut) {
    return { authStatus: 'UNKNOWN', authDiagnostic: 'AUTH_STATUS_COMMAND_FAILED' };
  }

  const statement = readLoggedInStatement(outcome.stdout, outcome.stderr);
  const expectedExit = outcome.exitCode === 0 || outcome.exitCode === 1;

  if (statement === false && expectedExit) return { authStatus: 'UNAUTHENTICATED' };
  if (statement === true && outcome.exitCode === 0) return { authStatus: 'AUTHENTICATED' };

  return {
    authStatus: 'UNKNOWN',
    authDiagnostic: expectedExit ? 'AUTH_STATUS_UNRECOGNIZED' : 'AUTH_STATUS_COMMAND_FAILED',
  };
}

export async function probeClaudeRuntime(options: RuntimeProbeOptions = {}): Promise<AgentRuntimeProbe> {
  let launcher: AgentLauncher;
  try {
    launcher = options.launcher ?? resolveLauncher(options.executable);
  } catch (error) {
    if (isUnresolvedLauncher(error)) return cliNotFound('claude');
    throw error;
  }

  const versionOutcome = await runProbeCommand(launcher, VERSION_ARGS, options);
  if (versionOutcome.launchFailed) {
    // Résolu mais non lançable : la CLI n'est pas exploitable ici.
    return cliNotFound('claude');
  }

  const authOutcome = await runProbeCommand(launcher, AUTH_STATUS_ARGS, options);

  return buildProbe({
    agent: 'claude',
    launcherSource: launcher.source,
    ...interpretVersion(versionOutcome),
    ...interpretClaudeAuth(authOutcome),
  });
}
