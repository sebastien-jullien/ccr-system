/**
 * Vocabulaire commun des probes runtime (spécification V1.1, §10, §25.2).
 *
 * Un probe **observe** l'état local d'une CLI fournisseur. Il ne décide rien :
 *
 *  - il ne bloque aucun run ;
 *  - il ne crée aucune session ;
 *  - il n'écrit nulle part ;
 *  - il ne lance aucun login ;
 *  - il ne lit aucun magasin de credentials (INV-11-02).
 *
 * Rappel normatif (§8.1) : un probe est un signal de diagnostic, jamais
 * l'autorité finale. L'appel réel reste l'autorité.
 *
 * Portée close, comme la frontière d'adapter : exactement deux intégrations,
 * Claude Code et Codex. Ce fichier n'est pas un socle de « providers »
 * extensible ; c'est le minimum partagé entre deux implémentations qui
 * diffèrent réellement.
 */

import { isCcrError } from '../core/errors.ts';
import { runProcess } from '../process/process-runner.ts';
import type { AgentLauncher } from '../adapters/agent-adapter.ts';
import type { AgentKind } from '../core/run.ts';

/** Délai d'un probe. Court : il s'agit d'une commande locale, pas d'un tour. */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/**
 * Plafond de capture d'un probe.
 *
 * Une CLI ne doit pas pouvoir faire enfler la mémoire de CCR, et rien de ce
 * qui est capturé ne survit à la normalisation.
 */
const PROBE_MAX_OUTPUT_BYTES = 256 * 1024;

export type RuntimeAuthStatus = 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'UNKNOWN';

/**
 * Codes de diagnostic **fermés** (§10.1).
 *
 * Aucune de ces valeurs n'est construite à partir d'une sortie fournisseur :
 * ce sont des identifiants choisis par CCR. Ils ne peuvent donc contenir ni
 * adresse e-mail, ni organisation, ni account ID, ni jeton.
 */
export type RuntimeDiagnostic =
  | 'CLI_NOT_FOUND'
  | 'VERSION_COMMAND_FAILED'
  | 'VERSION_UNRECOGNIZED'
  | 'AUTH_STATUS_COMMAND_FAILED'
  | 'AUTH_STATUS_UNRECOGNIZED'
  | 'PROVIDER_CONFIG_ERROR';

export interface AgentRuntimeProbe {
  readonly agent: AgentKind;
  /** La CLI existe et a pu être lancée. Indépendant du statut d'authentification. */
  readonly installed: boolean;
  /** Version extraite, ou `null` si la commande a échoué ou reste inexploitable. */
  readonly version: string | null;
  readonly authStatus: RuntimeAuthStatus;
  readonly diagnostic?: RuntimeDiagnostic;
  /** Origine de la résolution (`path`, `npm-shim`, `explicit`…), pour diagnostic. */
  readonly launcherSource: string | null;
}

export interface RuntimeProbeOptions {
  /** Répertoire de lancement. Aucun run n'est requis ni créé. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Chemin explicite vers la CLI, équivalent de `CCR_CLAUDE_BIN` / `CCR_CODEX_BIN`. */
  readonly executable?: string;
  /** Lanceur déjà résolu. Prioritaire sur `executable`. */
  readonly launcher?: AgentLauncher;
  readonly env?: NodeJS.ProcessEnv;
  readonly unsetEnv?: readonly string[];
}

/** Résultat brut d'une commande de probe, avant toute normalisation. */
export interface ProbeCommandOutcome {
  /** Le processus n'a pas pu être lancé (exécutable absent, échec de spawn). */
  readonly launchFailed: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  /** Flux strictement séparés : jamais fusionnés, jamais persistés. */
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Exécute une commande de probe.
 *
 * Ne lève jamais pour un code de sortie non nul ou un timeout : c'est
 * l'interprétation propre à chaque CLI qui décide de leur sens. Sans shell,
 * sans prompt, sans `stdin`.
 */
export async function runProbeCommand(
  launcher: AgentLauncher,
  args: readonly string[],
  options: RuntimeProbeOptions,
): Promise<ProbeCommandOutcome> {
  try {
    const result = await runProcess({
      executable: launcher.executable,
      args: [...launcher.prefixArgs, ...args],
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.unsetEnv === undefined ? {} : { unsetEnv: options.unsetEnv }),
    });
    return {
      launchFailed: false,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (isCcrError(error) && (error.code === 'EXECUTABLE_NOT_FOUND' || error.code === 'PROCESS_LAUNCH_FAILED')) {
      return { launchFailed: true, timedOut: false, exitCode: null, stdout: '', stderr: '' };
    }
    throw error;
  }
}

/** Résolution impossible : la CLI est absente, ce n'est pas un échec CCR. */
export function isUnresolvedLauncher(error: unknown): boolean {
  return isCcrError(error) && error.code === 'AGENT_EXECUTABLE_UNRESOLVED';
}

export function cliNotFound(agent: AgentKind): AgentRuntimeProbe {
  return {
    agent,
    installed: false,
    version: null,
    // Une CLI absente n'est pas une CLI déconnectée : on ne sait rien.
    authStatus: 'UNKNOWN',
    diagnostic: 'CLI_NOT_FOUND',
    launcherSource: null,
  };
}

/**
 * Extrait un numéro de version.
 *
 * Seul le jeton reconnu est conservé — jamais la ligne, jamais la sortie. La
 * sanitisation n'est donc pas un filtre appliqué après coup : elle est la
 * conséquence directe de n'extraire qu'un motif fermé.
 *
 * Les deux flux sont examinés séparément, jamais concaténés.
 */
const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/;
const VERSION_SCAN_LIMIT = 4096;

export function extractVersion(stdout: string, stderr: string): string | null {
  for (const stream of [stdout, stderr]) {
    const match = VERSION_PATTERN.exec(stream.slice(0, VERSION_SCAN_LIMIT));
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Recherche un marqueur fermé dans un flux, sans jamais fusionner les flux. */
export function hasMarker(streams: readonly string[], marker: string): boolean {
  const needle = marker.toLowerCase();
  return streams.some((stream) => stream.toLowerCase().includes(needle));
}

/**
 * Assemble le résultat normalisé.
 *
 * Précédence du diagnostic unique de §10 : l'absence de CLI prime, puis le
 * diagnostic d'authentification — celui sur lequel un humain peut agir — puis
 * celui de version.
 */
export function buildProbe(input: {
  readonly agent: AgentKind;
  readonly launcherSource: string;
  readonly version: string | null;
  readonly versionDiagnostic?: RuntimeDiagnostic;
  readonly authStatus: RuntimeAuthStatus;
  readonly authDiagnostic?: RuntimeDiagnostic;
}): AgentRuntimeProbe {
  const diagnostic = input.authDiagnostic ?? input.versionDiagnostic;
  return {
    agent: input.agent,
    // La CLI a répondu : elle est installée, qu'elle soit authentifiée ou non.
    installed: true,
    version: input.version,
    authStatus: input.authStatus,
    ...(diagnostic === undefined ? {} : { diagnostic }),
    launcherSource: input.launcherSource,
  };
}

/** Interprétation commune d'une commande `--version`. */
export function interpretVersion(outcome: ProbeCommandOutcome): {
  readonly version: string | null;
  readonly versionDiagnostic?: RuntimeDiagnostic;
} {
  if (outcome.timedOut || outcome.exitCode !== 0) {
    return { version: null, versionDiagnostic: 'VERSION_COMMAND_FAILED' };
  }
  const version = extractVersion(outcome.stdout, outcome.stderr);
  return version === null ? { version: null, versionDiagnostic: 'VERSION_UNRECOGNIZED' } : { version };
}
