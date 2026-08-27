/**
 * Preflight de `ccr start` (spécification V1.1, §17).
 *
 * Principe absolu de ce slice :
 *
 * > Tout ce qui est connaissable **avant** l'engagement d'un run est vérifié
 * > avant l'allocation du `run_id`. Tout échec survenant **après** l'engagement
 * > reste régi par les sémantiques V1 — `FAILED_INITIALIZATION` et récupération
 * > partielle.
 *
 * Ce module ne connaît ni run, ni manifest, ni verrou de run : il est
 * volontairement incapable d'allouer quoi que ce soit. La frontière n'est donc
 * pas seulement documentée, elle est structurelle.
 *
 * Il ne persiste rien. Le Slice 7 fabriquera le runtime snapshot à partir des
 * faits qu'il rapporte, sans refaire cette logique.
 *
 * Ce n'est pas un second `doctor` : `doctor` demande « le poste est-il en
 * ordre ? », le preflight demande « puis-je engager un run maintenant ? ».
 */

import { CcrError, isCcrError } from '../core/errors.ts';
import type { ProviderKind } from '../core/expert.ts';
import type { AgentKind } from '../core/run.ts';
import { resolveEffectiveConfig } from '../config/config-schema.ts';
import type { ConfigValueSource } from '../config/config-schema.ts';
import { readConfig, resolveConfigPath } from '../config/config-store.ts';
import { detectTty, loginClaude, loginCodex } from './agent-login.ts';
import type { AgentLoginOptions, LoginOutcome, TtyState } from './agent-login.ts';
import { probeClaudeRuntime } from './claude-runtime-probe.ts';
import { probeCodexRuntime } from './codex-runtime-probe.ts';
import type { AgentRuntimeProbe, RuntimeProbeOptions } from './agent-runtime-probe.ts';

/** Constats non bloquants. Union fermée, aucun texte fournisseur. */
export type StartPreflightWarning =
  | 'CLAUDE_AUTH_UNKNOWN'
  | 'CODEX_AUTH_NOT_REPORTED'
  | 'CODEX_AUTH_UNKNOWN'
  | 'CODEX_LOGIN_REMEDIATION_FAILED'
  | 'LEGACY_ENV_OVERRIDE'
  | 'LEGACY_ENV_NON_CANONICAL';

export interface StartPreflightResult {
  readonly claude: AgentRuntimeProbe;
  readonly codex: AgentRuntimeProbe;
  readonly effectiveConfig: {
    readonly preflight: { readonly offerInteractiveLogin: boolean };
    readonly codex: { readonly skipGitRepoCheck: boolean; readonly source: ConfigValueSource };
  };
  readonly warnings: readonly StartPreflightWarning[];
}

type ProbeFn = (options: RuntimeProbeOptions) => Promise<AgentRuntimeProbe>;
type LoginFn = (options: AgentLoginOptions) => Promise<LoginOutcome>;

export interface StartPreflightDeps {
  /** Sortie destinée à l'humain : le preflight n'écrit rien d'autre. */
  readonly io?: { out(text: string): void };
  /** Confirmation `[y/N]`. Absente, aucune remédiation interactive n'est possible. */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly tty?: TtyState;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly agentOptions?: {
    readonly claude?: RuntimeProbeOptions;
    readonly codex?: RuntimeProbeOptions;
  };
  readonly probes?: { readonly claude: ProbeFn; readonly codex: ProbeFn };
  readonly logins?: { readonly claude: LoginFn; readonly codex: LoginFn };
}

const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

function authRequired(agent: AgentKind, reason: string): CcrError {
  return new CcrError(
    'AUTH_REQUIRED',
    `${AGENT_LABEL[agent]} n'est pas authentifié : ${reason}. Aucun run n'a été créé. ` +
      'Exécutez `ccr setup` dans un terminal, ou authentifiez-vous directement auprès du fournisseur.',
    { details: { agent, reason } },
  );
}

/** Une CLI manquante est décrite par agent, jamais par un `PATH` recopié. */
function cliNotFound(missing: readonly AgentKind[]): CcrError {
  const labels = missing.map((agent) => AGENT_LABEL[agent]).join(' et ');
  return new CcrError(
    'AGENT_CLI_NOT_FOUND',
    `${labels} introuvable${missing.length > 1 ? 's' : ''}. Aucun run n'a été créé, ` +
      "et CCR n'installe aucun fournisseur. Installez la CLI manquante, puis relancez.",
    { details: { missing: [...missing] } },
  );
}

// --------------------------------------------------------------------------
// Politique d'authentification
// --------------------------------------------------------------------------

interface PolicyContext {
  readonly deps: StartPreflightDeps;
  readonly tty: TtyState;
  readonly offerInteractiveLogin: boolean;
  readonly warnings: StartPreflightWarning[];
}

/** Une remédiation n'est envisageable qu'avec terminal, invite et autorisation. */
function canOfferLogin(context: PolicyContext): boolean {
  return (
    context.tty.stdin &&
    context.tty.stdout &&
    context.offerInteractiveLogin &&
    context.deps.confirm !== undefined
  );
}

/**
 * Claude : le seul agent dont l'absence d'authentification est réellement
 * bloquante (§17.3bis). Sur les modes sondés, un `UNAUTHENTICATED` explicite
 * s'est montré représentatif : engager un run ne produirait qu'un
 * `FAILED_INITIALIZATION` prévisible.
 */
async function applyClaudePolicy(
  probe: AgentRuntimeProbe,
  context: PolicyContext,
): Promise<AgentRuntimeProbe> {
  if (probe.authStatus === 'AUTHENTICATED') return probe;

  if (probe.authStatus === 'UNKNOWN') {
    // IMP-15 : l'incertitude n'est pas une certitude négative. On avertit, on
    // ne propose rien automatiquement, et l'appel réel tranchera.
    context.warnings.push('CLAUDE_AUTH_UNKNOWN');
    return probe;
  }

  if (!canOfferLogin(context)) {
    const reason = !context.offerInteractiveLogin
      ? 'la connexion interactive est désactivée par la configuration'
      : "aucun terminal interactif n'est attaché";
    throw authRequired('claude', reason);
  }

  context.deps.io?.out("Claude Code ne rapporte aucune authentification active.");
  const consent = await context.deps.confirm?.('Se connecter à Claude Code maintenant ?');
  if (consent !== true) throw authRequired('claude', 'la connexion a été refusée');

  const login = context.deps.logins?.claude ?? loginClaude;
  // Un échec de connexion ici n'est pas un `FAILED_INITIALIZATION` : aucun run
  // n'est engagé. L'erreur remonte telle quelle.
  const outcome = await login({
    ...context.deps.agentOptions?.claude,
    consentGranted: true,
    tty: context.tty,
  });
  return outcome.probe;
}

/**
 * Codex : aucun statut de probe ne prouve l'inexécutabilité (§17.3bis). Une
 * configuration fournisseur alternative peut parfaitement exécuter le run alors
 * que `codex login status` ne rapporte rien.
 */
async function applyCodexPolicy(
  probe: AgentRuntimeProbe,
  context: PolicyContext,
): Promise<AgentRuntimeProbe> {
  if (probe.authStatus === 'AUTHENTICATED') return probe;

  if (probe.authStatus === 'UNKNOWN') {
    context.warnings.push('CODEX_AUTH_UNKNOWN');
    return probe;
  }

  context.warnings.push('CODEX_AUTH_NOT_REPORTED');
  if (!canOfferLogin(context)) return probe;

  context.deps.io?.out('Codex ne rapporte aucune connexion OpenAI active.');
  context.deps.io?.out('  Une autre configuration fournisseur peut néanmoins être utilisable.');
  const consent = await context.deps.confirm?.('Se connecter à Codex maintenant ?');
  if (consent !== true) return probe;

  const login = context.deps.logins?.codex ?? loginCodex;
  try {
    const outcome = await login({
      ...context.deps.agentOptions?.codex,
      consentGranted: true,
      tty: context.tty,
    });
    return outcome.probe;
  } catch (error) {
    // Seule la disparition de la CLI est un fait certain ; tout autre échec de
    // remédiation laisse ouverte la possibilité d'un fournisseur alternatif.
    if (isCcrError(error) && error.details['reason'] === 'CLI_NOT_FOUND') {
      throw cliNotFound(['codex']);
    }
    context.warnings.push('CODEX_LOGIN_REMEDIATION_FAILED');
    return probe;
  }
}

// --------------------------------------------------------------------------
// Preflight
// --------------------------------------------------------------------------

/**
 * Faits d'un fournisseur pour un run natif V2.1.
 *
 * Union discriminée : quand un fournisseur n'est employé par aucun slot, il n'y
 * a pas de sonde — donc pas de champ à remplir. Aucune observation ne peut être
 * fabriquée, faute d'emplacement pour l'accueillir.
 */
export type NativeProviderPreflight =
  | { readonly required: false }
  | { readonly required: true; readonly probe: AgentRuntimeProbe };

export interface NativeStartPreflightResult {
  readonly claude: NativeProviderPreflight;
  readonly codex: NativeProviderPreflight;
  readonly effectiveConfig: StartPreflightResult['effectiveConfig'];
  readonly warnings: readonly StartPreflightWarning[];
}

interface ProvidersPreflight {
  readonly claude: AgentRuntimeProbe | null;
  readonly codex: AgentRuntimeProbe | null;
  readonly effectiveConfig: StartPreflightResult['effectiveConfig'];
  readonly warnings: StartPreflightWarning[];
}

/**
 * Corps commun du preflight, borné à un ensemble de fournisseurs.
 *
 * Extrait pour que la variante native ne soit pas une copie : le preflight
 * historique **est** ce corps appliqué aux deux fournisseurs. Aucune politique
 * n'est reformulée, et l'asymétrie Claude/Codex de V1.1 reste entièrement dans
 * `applyClaudePolicy` / `applyCodexPolicy`.
 */
async function preflightProviders(
  required: ReadonlySet<ProviderKind>,
  deps: StartPreflightDeps,
): Promise<ProvidersPreflight> {
  const configPath = resolveConfigPath(deps.configPath);
  const env = deps.env ?? process.env;

  // Une configuration présente mais inexploitable arrête tout ici : jamais
  // remplacée par des valeurs par défaut, jamais réparée.
  const loaded = await readConfig({ configPath });
  const effective = resolveEffectiveConfig(loaded, env);

  const warnings: StartPreflightWarning[] = [];
  if (effective.legacyEnv.present) {
    warnings.push('LEGACY_ENV_OVERRIDE');
    if (effective.legacyEnv.nonCanonical) warnings.push('LEGACY_ENV_NON_CANONICAL');
  }

  const probeClaude = deps.probes?.claude ?? probeClaudeRuntime;
  const probeCodex = deps.probes?.codex ?? probeCodexRuntime;

  // Les environnements requis sont connus avant tout engagement, afin qu'une
  // seule exécution signale les deux problèmes. Un fournisseur non requis n'est
  // **pas sondé** : ne pas le lancer est la seule façon honnête de ne rien
  // affirmer sur lui.
  const [claudeProbe, codexProbe] = await Promise.all([
    required.has('claude') ? probeClaude({ ...deps.agentOptions?.claude }) : Promise.resolve(null),
    required.has('codex') ? probeCodex({ ...deps.agentOptions?.codex }) : Promise.resolve(null),
  ]);

  const missing: AgentKind[] = [];
  if (claudeProbe !== null && !claudeProbe.installed) missing.push('claude');
  if (codexProbe !== null && !codexProbe.installed) missing.push('codex');
  if (missing.length > 0) throw cliNotFound(missing);

  const context: PolicyContext = {
    deps,
    tty: deps.tty ?? detectTty(),
    offerInteractiveLogin: effective.preflight.offerInteractiveLogin,
    warnings,
  };

  // Claude d'abord : son échec est bloquant, autant ne pas proposer une
  // connexion Codex pour un run qui ne se fera pas.
  const claude = claudeProbe === null ? null : await applyClaudePolicy(claudeProbe, context);
  const codex = codexProbe === null ? null : await applyCodexPolicy(codexProbe, context);

  return {
    claude,
    codex,
    effectiveConfig: {
      preflight: { offerInteractiveLogin: effective.preflight.offerInteractiveLogin },
      codex: {
        skipGitRepoCheck: effective.codex.skipGitRepoCheck,
        source: effective.codex.source,
      },
    },
    warnings,
  };
}

const BOTH_PROVIDERS: ReadonlySet<ProviderKind> = new Set<ProviderKind>(['claude', 'codex']);

/**
 * Preflight historique — comportement V1.1/V2 strictement inchangé : les deux
 * fournisseurs sont requis, sondés et soumis à leur politique.
 */
export async function runStartPreflight(deps: StartPreflightDeps = {}): Promise<StartPreflightResult> {
  const result = await preflightProviders(BOTH_PROVIDERS, deps);
  if (result.claude === null || result.codex === null) {
    // Inatteignable : les deux fournisseurs sont dans l'ensemble requis.
    throw new CcrError('AGENT_CLI_NOT_FOUND', 'Preflight historique : sonde absente.');
  }
  return {
    claude: result.claude,
    codex: result.codex,
    effectiveConfig: result.effectiveConfig,
    warnings: result.warnings,
  };
}

/**
 * Preflight d'un run natif V2.1, borné aux fournisseurs réellement liés
 * (V0.3, §11.1, `INV-21-13`).
 *
 * Un fournisseur qu'aucun slot n'emploie ne peut ni bloquer le run, ni être
 * sondé, ni être lancé, ni recevoir une observation.
 */
export async function runNativeStartPreflight(
  required: ReadonlySet<ProviderKind>,
  deps: StartPreflightDeps = {},
): Promise<NativeStartPreflightResult> {
  const result = await preflightProviders(required, deps);
  return {
    claude: result.claude === null ? { required: false } : { required: true, probe: result.claude },
    codex: result.codex === null ? { required: false } : { required: true, probe: result.codex },
    effectiveConfig: result.effectiveConfig,
    warnings: result.warnings,
  };
}
