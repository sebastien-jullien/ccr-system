/**
 * `ccr setup` — onboarding local (spécification V1.1, §15).
 *
 * Assemble des briques déjà validées et n'en réimplémente aucune :
 *
 *   config store + config lock   persistance de la préférence locale
 *   runtime probes               présence, version, statut d'authentification
 *   login orchestration          connexion officielle après consentement
 *
 * Ce que `setup` fait de neuf : demander, présenter, décider si le poste est
 * exploitable. Rien d'autre.
 *
 * Interdits structurels : aucun run alloué, aucune session native créée, aucun
 * modèle appelé, aucune installation de fournisseur, aucune déconnexion, aucune
 * variable d'environnement modifiée, aucun credential lu.
 *
 * `ccr setup --run <run_id>` n'existe pas encore : son objet — le snapshot
 * runtime d'un run — n'est pas implémenté. Le construire ici produirait un
 * format provisoire. Il arrivera avec le Slice 7.
 */

import { CcrError, isCcrError } from '../core/errors.ts';
import type { AgentKind } from '../core/run.ts';
import { observeLegacyEnv } from '../config/config-schema.ts';
import type { CcrConfig } from '../config/config-schema.ts';
import { readConfig, resolveConfigPath, updateConfig } from '../config/config-store.ts';
import {
  assessConfigLockLiveness,
  observeConfigLock,
  removeAbandonedConfigLock,
} from '../lock/config-lock.ts';
import { detectTty, loginClaude, loginCodex } from '../runtime/agent-login.ts';
import type { AgentLoginOptions, LoginOutcome, TtyState } from '../runtime/agent-login.ts';
import { probeClaudeRuntime } from '../runtime/claude-runtime-probe.ts';
import { probeCodexRuntime } from '../runtime/codex-runtime-probe.ts';
import type { AgentRuntimeProbe, RuntimeProbeOptions } from '../runtime/agent-runtime-probe.ts';

export type SetupStatus = 'READY' | 'INCOMPLETE';

/**
 * Points d'attention normalisés.
 *
 * Codes fermés : ils servent aux tests et, demain, à `doctor`. Aucun n'est
 * construit à partir d'une sortie fournisseur.
 */
export type SetupAttention =
  | 'CLAUDE_NOT_INSTALLED'
  | 'CODEX_NOT_INSTALLED'
  | 'CLAUDE_UNAUTHENTICATED'
  | 'CLAUDE_AUTH_UNKNOWN'
  | 'CODEX_UNAUTHENTICATED'
  | 'CODEX_AUTH_UNKNOWN'
  | 'CLAUDE_LOGIN_FAILED'
  | 'CODEX_LOGIN_FAILED'
  | 'LEGACY_ENV_OVERRIDE';

export interface SetupIo {
  out(text: string): void;
  /** Confirmation `[y/N]`, défaut NON. Le suffixe est ajouté par la primitive. */
  confirm(question: string): Promise<boolean>;
}

type ProbeFn = (options: RuntimeProbeOptions) => Promise<AgentRuntimeProbe>;
type LoginFn = (options: AgentLoginOptions) => Promise<LoginOutcome>;

export interface SetupDeps {
  readonly io: SetupIo;
  readonly tty?: TtyState;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Options transmises aux probes et aux connexions de chaque agent. */
  readonly agentOptions?: {
    readonly claude?: RuntimeProbeOptions;
    readonly codex?: RuntimeProbeOptions;
  };
  /** Implémentations injectables : éprouver l'orchestration, pas les probes. */
  readonly probes?: { readonly claude: ProbeFn; readonly codex: ProbeFn };
  readonly logins?: { readonly claude: LoginFn; readonly codex: LoginFn };
}

export interface SetupResult {
  readonly status: SetupStatus;
  readonly claude: AgentRuntimeProbe;
  readonly codex: AgentRuntimeProbe;
  readonly attentions: readonly SetupAttention[];
  readonly configPath: string;
  /** Configuration persistée, ou `undefined` si rien n'a été écrit. */
  readonly config?: CcrConfig;
}

const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

function pad(label: string): string {
  return label.padEnd(16, ' ');
}

// --------------------------------------------------------------------------
// Diagnostic d'un agent
// --------------------------------------------------------------------------

function describeAuth(status: AgentRuntimeProbe['authStatus']): string {
  switch (status) {
    case 'AUTHENTICATED':
      return 'authentifié';
    case 'UNAUTHENTICATED':
      return 'non authentifié';
    default:
      // Jamais « déconnecté » : CCR n'en sait rien (INV-11-05).
      return 'indéterminé';
  }
}

/**
 * Propose la connexion officielle lorsque — et seulement lorsque — la CLI
 * rapporte explicitement l'absence de session.
 *
 * `UNKNOWN` ne déclenche aucune proposition : §15.6 l'autorise sans l'imposer,
 * et proposer une reconnexion pour un statut indéterminable reviendrait à
 * suggérer un remède à un mal inconnu.
 */
async function remediateAgent(
  agent: AgentKind,
  probe: AgentRuntimeProbe,
  deps: SetupDeps,
  tty: TtyState,
  attentions: SetupAttention[],
): Promise<AgentRuntimeProbe> {
  const io = deps.io;
  const label = AGENT_LABEL[agent];

  if (!probe.installed) {
    attentions.push(agent === 'claude' ? 'CLAUDE_NOT_INSTALLED' : 'CODEX_NOT_INSTALLED');
    return probe;
  }

  if (probe.authStatus === 'AUTHENTICATED') return probe;

  if (probe.authStatus === 'UNKNOWN') {
    io.out('');
    io.out(`${label} : le statut d'authentification n'a pas pu être déterminé.`);
    io.out("  CCR ne conclut ni à une connexion, ni à une déconnexion. L'appel réel fera foi.");
    attentions.push(agent === 'claude' ? 'CLAUDE_AUTH_UNKNOWN' : 'CODEX_AUTH_UNKNOWN');
    return probe;
  }

  io.out('');
  if (agent === 'claude') {
    io.out("Claude Code ne rapporte aucune authentification active.");
  } else {
    io.out("Codex ne rapporte aucune connexion OpenAI active.");
    io.out('  Une autre configuration fournisseur peut néanmoins être utilisable.');
  }

  const consent = await io.confirm(`Se connecter à ${label} maintenant ?`);
  if (!consent) {
    attentions.push(agent === 'claude' ? 'CLAUDE_UNAUTHENTICATED' : 'CODEX_UNAUTHENTICATED');
    return probe;
  }

  const login = agent === 'claude' ? (deps.logins?.claude ?? loginClaude) : (deps.logins?.codex ?? loginCodex);
  const agentOptions = agent === 'claude' ? deps.agentOptions?.claude : deps.agentOptions?.codex;

  try {
    const outcome = await login({ ...agentOptions, consentGranted: true, tty });
    // Le probe qui suit la connexion fait foi : `setup` ne réévalue rien.
    if (outcome.probe.authStatus !== 'AUTHENTICATED') {
      attentions.push(agent === 'claude' ? 'CLAUDE_UNAUTHENTICATED' : 'CODEX_UNAUTHENTICATED');
    }
    return outcome.probe;
  } catch (error) {
    const reason = isCcrError(error) ? String(error.details['reason'] ?? error.code) : 'ERREUR_INATTENDUE';
    io.out(`  Échec de la connexion ${label} (${reason}).`);
    attentions.push(agent === 'claude' ? 'CLAUDE_LOGIN_FAILED' : 'CODEX_LOGIN_FAILED');
    attentions.push(agent === 'claude' ? 'CLAUDE_UNAUTHENTICATED' : 'CODEX_UNAUTHENTICATED');
    return probe;
  }
}

// --------------------------------------------------------------------------
// Persistance, avec levée éventuelle d'un verrou abandonné (§20.2)
// --------------------------------------------------------------------------

async function persistPreference(
  configPath: string,
  mutate: (current: CcrConfig) => CcrConfig,
  io: SetupIo,
): Promise<CcrConfig> {
  try {
    return (await updateConfig(mutate, { configPath, command: 'setup' })).config;
  } catch (error) {
    if (!isCcrError(error) || error.code !== 'CONFIG_BUSY') throw error;

    const observation = await observeConfigLock(configPath);
    const info = observation.info;
    if (observation.presence !== 'HELD' || info === undefined) {
      // Verrou illisible : identité inconnue, donc rien à proposer.
      throw error;
    }

    const liveness = assessConfigLockLiveness(info);
    if (liveness !== 'STALE') {
      // Vivant ou posé depuis un autre hôte : aucune suppression envisagée.
      throw error;
    }

    io.out('');
    io.out('Un verrou de configuration abandonné a été détecté.');
    io.out(`  processus  : ${String(info.pid)} sur ${info.hostname} (absent)`);
    io.out(`  commande   : ${info.command}`);
    io.out(`  depuis     : ${info.created_at}`);

    if (!(await io.confirm('Le supprimer ?'))) throw error;

    // Réinspection : le verrou présenté doit être exactement celui supprimé.
    if (!(await removeAbandonedConfigLock(configPath, info.lock_id))) {
      io.out('  Le verrou a changé entre-temps : rien n\'a été supprimé.');
      throw error;
    }

    // Réacquisition bornée : une seule nouvelle tentative.
    return (await updateConfig(mutate, { configPath, command: 'setup' })).config;
  }
}

// --------------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------------

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const io = deps.io;
  const tty = deps.tty ?? detectTty();

  // Avant toute chose : sans terminal, aucun effet d'aucune sorte (§15.8).
  if (!tty.stdin || !tty.stdout) {
    throw new CcrError(
      'INTERACTIVE_TTY_REQUIRED',
      '`ccr setup` est une commande interactive et requiert un terminal. ' +
        "Aucune configuration n'a été lue ni modifiée. " +
        'Pour un diagnostic sans terminal, `ccr doctor` sera prévu à cet effet.',
      { details: { stdinIsTty: tty.stdin, stdoutIsTty: tty.stdout } },
    );
  }

  const configPath = resolveConfigPath(deps.configPath);
  const env = deps.env ?? process.env;
  const attentions: SetupAttention[] = [];

  io.out('CCR — configuration locale');
  io.out('');
  io.out('Runtime');
  io.out(`  ${pad('Node.js')}${process.versions.node}`);

  const probeClaude = deps.probes?.claude ?? probeClaudeRuntime;
  const probeCodex = deps.probes?.codex ?? probeCodexRuntime;

  // Les deux agents sont toujours sondés : un diagnostic complet en une seule
  // exécution vaut mieux qu'une découverte en deux temps.
  const initialClaude = await probeClaude({ ...deps.agentOptions?.claude });
  const initialCodex = await probeCodex({ ...deps.agentOptions?.codex });

  for (const probe of [initialClaude, initialCodex]) {
    const label = AGENT_LABEL[probe.agent];
    io.out(
      probe.installed
        ? `  ${pad(label)}${probe.version ?? 'version inconnue'}`
        : `  ${pad(label)}absent — CCR n'installe rien`,
    );
  }

  io.out('');
  io.out('Authentification (état rapporté par les CLI)');
  for (const probe of [initialClaude, initialCodex]) {
    if (!probe.installed) continue;
    io.out(`  ${pad(AGENT_LABEL[probe.agent])}${describeAuth(probe.authStatus)}`);
  }

  const claude = await remediateAgent('claude', initialClaude, deps, tty, attentions);
  const codex = await remediateAgent('codex', initialCodex, deps, tty, attentions);

  // --- Préférence Codex hors dépôt Git ---

  const current = await readConfig({ configPath });
  const alreadyAllowed = current.config.codex.skip_git_repo_check;

  io.out('');
  io.out('Codex hors dépôt Git');
  io.out("  Ce réglage ajoute uniquement le contournement du garde de dépôt de Codex.");
  io.out('  Il ne modifie ni le bac à sable, ni les approbations, et ne confie aucune');
  io.out('  responsabilité Git à CCR.');
  if (alreadyAllowed) {
    io.out('  Réglage actuel : autorisé. Répondre non retirera cette autorisation.');
  }

  const skipGitRepoCheck = await io.confirm(
    'Autoriser CCR à utiliser Codex en dehors d\'un dépôt Git ?',
  );

  const legacy = observeLegacyEnv(env);
  if (legacy.present) {
    attentions.push('LEGACY_ENV_OVERRIDE');
    io.out('');
    io.out(`Attention : la variable ${legacy.variable} est définie dans cet environnement.`);
    io.out(
      `  Elle impose actuellement : ${legacy.canonical ? 'autorisé' : 'non autorisé'}` +
        (legacy.canonical ? '' : ' (seule la valeur exacte "1" active le contournement)'),
    );
    io.out('  Tant qu\'elle est présente, elle prime sur la configuration.');
    io.out('  CCR ne modifie pas votre environnement : retirez-la pour que le réglage s\'applique.');
  }

  // La préférence locale est persistée même si un fournisseur reste non
  // authentifié : c'est une configuration de poste, pas une transaction d'auth.
  const config = await persistPreference(
    configPath,
    (existing) => ({ ...existing, codex: { skip_git_repo_check: skipGitRepoCheck } }),
    io,
  );

  io.out('');
  io.out('Configuration écrite :');
  io.out(`  ${configPath}`);

  // --- Verdict ---

  const status: SetupStatus =
    claude.installed && codex.installed && claude.authStatus === 'AUTHENTICATED'
      ? 'READY'
      : 'INCOMPLETE';

  io.out('');
  if (status === 'READY') {
    io.out('Setup terminé.');
  } else {
    io.out('Setup terminé de façon incomplète :');
    for (const attention of attentions) io.out(`  · ${attention}`);
  }

  return { status, claude, codex, attentions, configPath, config };
}
