/**
 * Orchestration de connexion fournisseur (spécification V1.1, §7, §8.2, §9.3,
 * §19, §23.3).
 *
 * Cette couche **n'a aucune autorité de décision**. Elle reçoit un consentement
 * humain déjà obtenu par l'appelant, et se contente d'enchaîner :
 *
 *   consentement acquis → launcher partagé → probe initial
 *   → si AUTHENTICATED : rien de plus, aucun terminal exigé
 *   → sinon : TTY → commande officielle → interaction directe
 *     fournisseur ↔ humain → re-probe → résultat normalisé
 *
 * Ce qu'elle ne fait pas, et ne doit jamais faire :
 *
 *  - poser une question — les invites `[y/N]` appartiennent à `setup` et au
 *    preflight de `start` ;
 *  - lire, écrire, copier ou afficher un credential (INV-11-01, INV-11-02) ;
 *  - capturer la sortie du processus de connexion (§23.3) ;
 *  - déconnecter un utilisateur : aucune commande de `logout` n'existe ici ;
 *  - toucher un run, un manifest, un journal ou la configuration CCR.
 *
 * **Le succès n'est jamais déduit du code de sortie du login** (§8.2, §9.3).
 * La preuve finale est le probe qui suit. Le code de sortie ne fait que
 * disqualifier un login dont on sait déjà qu'il a mal fini.
 */

import { CcrError, isCcrError } from '../core/errors.ts';
import { runInteractiveProcess } from '../process/process-runner.ts';
import type { AgentLauncher } from '../adapters/agent-adapter.ts';
import type { AgentKind } from '../core/run.ts';
import type { AgentRuntimeProbe, RuntimeProbeOptions } from './agent-runtime-probe.ts';
import { probeClaudeRuntime, resolveLauncher as resolveClaudeLauncher } from './claude-runtime-probe.ts';
import { probeCodexRuntime, resolveLauncher as resolveCodexLauncher } from './codex-runtime-probe.ts';

/**
 * État du terminal, isolé derrière un seam injectable.
 *
 * La présence d'un `process.stdin` ne prouve rien : un processus sans terminal
 * en possède un. Seul `isTTY` sur les **deux** flux atteste qu'un humain peut
 * répondre au fournisseur.
 */
export interface TtyState {
  readonly stdin: boolean;
  readonly stdout: boolean;
}

export function detectTty(): TtyState {
  return { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true };
}

export interface AgentLoginOptions extends RuntimeProbeOptions {
  /**
   * Consentement humain explicite, déjà recueilli par l'appelant.
   *
   * Le type est le littéral `true` : ni valeur par défaut, ni champ optionnel,
   * ni booléen calculé. Passer `false` ne compile pas ; omettre le champ non
   * plus. Un contournement ne peut donc être qu'intentionnel.
   */
  readonly consentGranted: true;
  /** État du terminal. Par défaut, celui du processus courant. */
  readonly tty?: TtyState;
}

/** Résultat nominal. Les échecs passent par les erreurs CCR. */
export type LoginOutcome =
  | { readonly status: 'ALREADY_AUTHENTICATED'; readonly probe: AgentRuntimeProbe }
  | { readonly status: 'LOGIN_COMPLETED'; readonly probe: AgentRuntimeProbe };

/** Motifs d'échec normalisés. Identifiants fermés, jamais du texte fournisseur. */
export type LoginFailureReason =
  | 'CLI_NOT_FOUND'
  | 'LOGIN_LAUNCH_FAILED'
  | 'LOGIN_EXIT_NONZERO'
  | 'POST_PROBE_NOT_AUTHENTICATED';

// --------------------------------------------------------------------------
// Gardes
// --------------------------------------------------------------------------

function requireConsent(agent: AgentKind, options: AgentLoginOptions): void {
  // Garde d'exécution doublant la garde de type : un appelant JavaScript, ou
  // une valeur venue d'un `JSON.parse`, ne doit pas pouvoir passer outre.
  if (options.consentGranted !== true) {
    throw new CcrError(
      'INVALID_ARGUMENT',
      `Connexion ${agent} refusée : aucun consentement humain explicite n'a été fourni. ` +
        "CCR ne déclenche jamais une commande de login sans consentement.",
      { details: { agent } },
    );
  }
}

function requireTty(agent: AgentKind, options: AgentLoginOptions): void {
  const tty = options.tty ?? detectTty();
  if (tty.stdin && tty.stdout) return;
  throw new CcrError(
    'INTERACTIVE_TTY_REQUIRED',
    `Connexion ${agent} impossible : aucun terminal interactif n'est attaché. ` +
      'Le fournisseur doit pouvoir dialoguer directement avec vous. ' +
      'Relancez la commande depuis un terminal.',
    { details: { agent, stdinIsTty: tty.stdin, stdoutIsTty: tty.stdout } },
  );
}

function loginFailed(
  agent: AgentKind,
  reason: LoginFailureReason,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CcrError {
  return new CcrError('AUTH_LOGIN_FAILED', message, {
    details: { agent, reason, ...details },
    ...(cause === undefined ? {} : { cause }),
  });
}

// --------------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------------

interface AgentLoginContract {
  readonly agent: AgentKind;
  /** Résolution partagée avec l'adapter V1 et les probes (§7.1). */
  readonly resolveLauncher: (explicit?: string) => AgentLauncher;
  readonly probe: (options: RuntimeProbeOptions) => Promise<AgentRuntimeProbe>;
  /** Commande officielle de connexion, hors préfixes du launcher. */
  readonly loginArgs: readonly string[];
}

async function orchestrateLogin(
  contract: AgentLoginContract,
  options: AgentLoginOptions,
): Promise<LoginOutcome> {
  const { agent } = contract;

  // Le consentement est la garde absolue : sans lui, rien — pas même un probe.
  //
  // Le terminal, lui, n'est exigé qu'au moment où un processus interactif doit
  // réellement être lancé. L'exiger plus tôt refuserait un agent déjà
  // authentifié dans un environnement sans TTY, alors qu'aucune interaction
  // n'y serait nécessaire.
  requireConsent(agent, options);

  let launcher: AgentLauncher;
  try {
    launcher = options.launcher ?? contract.resolveLauncher(options.executable);
  } catch (error) {
    if (isCcrError(error) && error.code === 'AGENT_EXECUTABLE_UNRESOLVED') {
      throw loginFailed(
        agent,
        'CLI_NOT_FOUND',
        `Connexion ${agent} impossible : aucune CLI lançable n'a été localisée.`,
        {},
        error,
      );
    }
    throw error;
  }

  // Le probe et la connexion visent le **même** exécutable résolu une seule
  // fois : ce qui est sondé est ce qui est lancé.
  const probeOptions: RuntimeProbeOptions = { ...options, launcher };

  const initial = await contract.probe(probeOptions);
  if (initial.authStatus === 'AUTHENTICATED') {
    // Ni navigateur ouvert, ni compte valide ré-authentifié.
    return { status: 'ALREADY_AUTHENTICATED', probe: initial };
  }

  // À partir d'ici, une interaction humaine est réellement nécessaire : le
  // terminal devient exigible.
  requireTty(agent, options);

  // `UNKNOWN` n'est pas `UNAUTHENTICATED` (INV-11-05). Il n'autorise aucune
  // conclusion — mais le consentement, lui, autorise la tentative.
  let exitCode: number | null;
  try {
    const result = await runInteractiveProcess({
      executable: launcher.executable,
      args: [...launcher.prefixArgs, ...contract.loginArgs],
      cwd: options.cwd ?? process.cwd(),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.unsetEnv === undefined ? {} : { unsetEnv: options.unsetEnv }),
    });
    exitCode = result.exitCode;
  } catch (error) {
    throw loginFailed(
      agent,
      'LOGIN_LAUNCH_FAILED',
      `Connexion ${agent} impossible : la commande officielle n'a pas pu être lancée.`,
      {},
      error,
    );
  }

  // Le probe suit **toujours** une terminaison, y compris après un code non
  // nul : c'est la seule façon de constater, plutôt que de supposer, l'état
  // réel — et de détecter une CLI qui échouerait tout en authentifiant.
  const after = await contract.probe(probeOptions);
  const postProbe = {
    postProbeAuthStatus: after.authStatus,
    postProbeDiagnostic: after.diagnostic ?? null,
    loginExitCode: exitCode,
  };

  if (exitCode !== 0) {
    throw loginFailed(
      agent,
      'LOGIN_EXIT_NONZERO',
      `Connexion ${agent} échouée : la commande officielle s'est terminée avec le code ${String(exitCode)}.`,
      postProbe,
    );
  }

  if (after.authStatus !== 'AUTHENTICATED') {
    throw loginFailed(
      agent,
      'POST_PROBE_NOT_AUTHENTICATED',
      `Connexion ${agent} non confirmée : après la commande officielle, la CLI rapporte ` +
        `${after.authStatus}. Le code de sortie du login ne suffit pas à établir un succès.`,
      postProbe,
    );
  }

  return { status: 'LOGIN_COMPLETED', probe: after };
}

// --------------------------------------------------------------------------
// Les deux fournisseurs connus
// --------------------------------------------------------------------------

const CLAUDE: AgentLoginContract = {
  agent: 'claude',
  resolveLauncher: resolveClaudeLauncher,
  probe: probeClaudeRuntime,
  loginArgs: ['auth', 'login'],
};

const CODEX: AgentLoginContract = {
  agent: 'codex',
  resolveLauncher: resolveCodexLauncher,
  probe: probeCodexRuntime,
  loginArgs: ['login'],
};

export function loginClaude(options: AgentLoginOptions): Promise<LoginOutcome> {
  return orchestrateLogin(CLAUDE, options);
}

export function loginCodex(options: AgentLoginOptions): Promise<LoginOutcome> {
  return orchestrateLogin(CODEX, options);
}
