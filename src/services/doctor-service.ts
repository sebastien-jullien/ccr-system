/**
 * `ccr doctor` — diagnostic local (spécification V1.1, §16).
 *
 * Propriété normative (§16.1, INV-11-10) :
 *
 * > `ccr doctor` ne modifie aucun fichier, run, état, configuration ou
 * > credential appartenant à CCR, et ne déclenche aucun login.
 *
 * Il n'acquiert pas le verrou de configuration, n'en supprime aucun, ne crée
 * pas `~/.ccr`, ne pose aucune question et n'exige aucun terminal. Les CLI
 * fournisseurs qu'il interroge peuvent avoir leurs propres effets internes,
 * hors du contrôle de CCR : `doctor` ne prétend donc pas à l'absence totale
 * d'effet sur le système, mais à l'absence d'effet sur **son domaine**.
 *
 * Le rapport est une donnée structurée, indépendante de tout rendu : le futur
 * cockpit V2 doit pouvoir le consommer sans analyser du texte de CLI. Les
 * messages humains appartiennent au renderer.
 *
 * `ccr doctor <run_id>` n'existe pas encore : il compare le runtime snapshot
 * d'un run, qui arrive au Slice 7 (amendement IMP-16).
 */

import { homedir } from 'node:os';

import { isCcrError } from '../core/errors.ts';
import type { AgentKind, RuntimeConfigSource } from '../core/run.ts';
import { observeLegacyEnv, resolveEffectiveConfig } from '../config/config-schema.ts';
import type { ConfigValueSource, LegacyEnvObservation } from '../config/config-schema.ts';
import { readConfig, resolveConfigPath } from '../config/config-store.ts';
import { assessConfigLockLiveness, observeConfigLock } from '../lock/config-lock.ts';
import type { ConfigLockLiveness, ConfigLockPresence } from '../lock/config-lock.ts';
import { resolveRunsDir } from '../store/layout.ts';
import { loadRun } from '../store/state-store.ts';
import { probeClaudeRuntime } from '../runtime/claude-runtime-probe.ts';
import { probeCodexRuntime } from '../runtime/codex-runtime-probe.ts';
import type { AgentRuntimeProbe, RuntimeProbeOptions } from '../runtime/agent-runtime-probe.ts';

export type DoctorStatus = 'READY' | 'ATTENTION' | 'BLOCKED';
export type DoctorSeverity = 'ATTENTION' | 'BLOCKER';

/**
 * Constats normalisés. Identifiants fermés : ni texte fournisseur, ni message
 * humain. Le renderer en dérive les phrases.
 */
export type DoctorFindingCode =
  | 'CLAUDE_CLI_MISSING'
  | 'CLAUDE_AUTH_REQUIRED'
  | 'CLAUDE_AUTH_UNKNOWN'
  | 'CLAUDE_VERSION_UNKNOWN'
  | 'CODEX_CLI_MISSING'
  | 'CODEX_AUTH_NOT_REPORTED'
  | 'CODEX_AUTH_UNKNOWN'
  | 'CODEX_VERSION_UNKNOWN'
  | 'CONFIG_INVALID'
  | 'CONFIG_SCHEMA_UNSUPPORTED'
  | 'CONFIG_READ_FAILED'
  | 'LEGACY_ENV_OVERRIDE'
  | 'LEGACY_ENV_NON_CANONICAL'
  | 'CONFIG_LOCK_HELD'
  | 'CONFIG_LOCK_STALE'
  | 'CONFIG_LOCK_FOREIGN'
  | 'CONFIG_LOCK_UNREADABLE'
  // --- Constats propres à un run inspecté (V1.1, §16.4) ---
  | 'RUNTIME_CONFIG_UNPINNED'
  | 'RUNTIME_CONFIG_INVALID'
  | 'CLAUDE_VERSION_CHANGED'
  | 'CODEX_VERSION_CHANGED'
  | 'RUN_CONFIG_DIFFERS_FROM_GLOBAL';

export interface DoctorFinding {
  readonly code: DoctorFindingCode;
  readonly severity: DoctorSeverity;
}

export interface DoctorRuntimeReport {
  readonly node: string;
}

export interface DoctorConfigReport {
  /** Chemin rendu sûr : la racine personnelle est repliée en `~`. */
  readonly path: string;
  readonly origin: 'file' | 'defaults' | 'unreadable';
  /** Code normalisé lorsque la configuration existe mais n'est pas exploitable. */
  readonly error?: 'CONFIG_INVALID' | 'CONFIG_SCHEMA_UNSUPPORTED' | 'CONFIG_READ_FAILED';
  readonly preflightOfferInteractiveLogin?: boolean;
  readonly persistedSkipGitRepoCheck?: boolean;
  /**
   * Valeur réellement appliquée et sa provenance.
   *
   * Absente lorsque la configuration est illisible **et** qu'aucune variable
   * historique ne tranche : CCR ne devine pas ce qu'il n'a pas pu lire.
   */
  readonly effective?: { readonly skipGitRepoCheck: boolean; readonly source: ConfigValueSource };
  readonly legacyEnv: LegacyEnvObservation;
}

export interface DoctorConfigLockReport {
  readonly presence: ConfigLockPresence;
  readonly liveness?: ConfigLockLiveness;
  readonly pid?: number;
  readonly hostname?: string;
  readonly createdAt?: string;
  readonly command?: string;
}

/** Mode de configuration d'un run inspecté. */
export type RunRuntimeConfigMode = 'PINNED' | 'LEGACY_UNPINNED' | 'INVALID';

export interface DoctorRunReport {
  readonly id: string;
  readonly runtimeConfigMode: RunRuntimeConfigMode;
  readonly state?: string;
  readonly control?: string;
  /** Renseigné uniquement pour un run pinné. */
  readonly capturedAt?: string;
  readonly claudeVersionAtStart?: string | null;
  readonly codexVersionAtStart?: string | null;
  readonly claudeAuthAtStart?: string;
  readonly codexAuthAtStart?: string;
  readonly skipGitRepoCheck?: boolean;
  /**
   * Provenance **au moment de la capture**. Descriptive et historique : elle
   * n'est jamais l'autorité, et n'est pas réécrite par `ccr setup --run`.
   */
  readonly sourceAtCapture?: RuntimeConfigSource;
  /**
   * Valeur qui s'appliquerait aujourd'hui d'après la configuration globale.
   * Comparative seulement : elle ne gouverne jamais un run pinné.
   */
  readonly globalSkipGitRepoCheck?: boolean;
}

export interface DoctorReport {
  readonly status: DoctorStatus;
  readonly runtime: DoctorRuntimeReport;
  readonly agents: { readonly claude: AgentRuntimeProbe; readonly codex: AgentRuntimeProbe };
  readonly config: DoctorConfigReport;
  readonly configLock: DoctorConfigLockReport;
  /** Présent uniquement lorsqu'un run a été demandé. */
  readonly run?: DoctorRunReport;
  readonly findings: readonly DoctorFinding[];
}

type ProbeFn = (options: RuntimeProbeOptions) => Promise<AgentRuntimeProbe>;

export interface DoctorDeps {
  /** Identifiant du run à inspecter. Absent, le diagnostic reste global. */
  readonly runId?: string;
  readonly runsDir?: string;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly agentOptions?: {
    readonly claude?: RuntimeProbeOptions;
    readonly codex?: RuntimeProbeOptions;
  };
  readonly probes?: { readonly claude: ProbeFn; readonly codex: ProbeFn };
}

/** Replie la racine personnelle : un rapport partagé ne divulgue pas l'identifiant. */
export function toDisplayPath(target: string, home: string = homedir()): string {
  if (home.length > 0 && target.startsWith(home)) {
    return `~${target.slice(home.length).replace(/\\/g, '/')}`;
  }
  return target;
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

function classifyAgent(probe: AgentRuntimeProbe): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const claude = probe.agent === 'claude';

  if (!probe.installed) {
    // Une CLI absente rend le reste sans objet : un seul constat, actionnable.
    findings.push({ code: claude ? 'CLAUDE_CLI_MISSING' : 'CODEX_CLI_MISSING', severity: 'BLOCKER' });
    return findings;
  }

  if (probe.version === null) {
    findings.push({
      code: claude ? 'CLAUDE_VERSION_UNKNOWN' : 'CODEX_VERSION_UNKNOWN',
      severity: 'ATTENTION',
    });
  }

  switch (probe.authStatus) {
    case 'AUTHENTICATED':
      break;
    case 'UNAUTHENTICATED':
      // Asymétrie normée (§17.3bis) : Claude bloque réellement un run, Codex
      // peut rester exécutable via une autre configuration fournisseur.
      findings.push(
        claude
          ? { code: 'CLAUDE_AUTH_REQUIRED', severity: 'BLOCKER' }
          : { code: 'CODEX_AUTH_NOT_REPORTED', severity: 'ATTENTION' },
      );
      break;
    default:
      // IMP-15 : une incertitude n'est pas un blocker certain.
      findings.push({
        code: claude ? 'CLAUDE_AUTH_UNKNOWN' : 'CODEX_AUTH_UNKNOWN',
        severity: 'ATTENTION',
      });
      break;
  }

  return findings;
}

function classifyLegacyEnv(legacy: LegacyEnvObservation): DoctorFinding[] {
  if (!legacy.present) return [];
  const findings: DoctorFinding[] = [{ code: 'LEGACY_ENV_OVERRIDE', severity: 'ATTENTION' }];
  if (legacy.nonCanonical) findings.push({ code: 'LEGACY_ENV_NON_CANONICAL', severity: 'ATTENTION' });
  return findings;
}

function classifyLock(lock: DoctorConfigLockReport): DoctorFinding[] {
  if (lock.presence === 'ABSENT') return [];
  if (lock.presence === 'UNREADABLE') {
    return [{ code: 'CONFIG_LOCK_UNREADABLE', severity: 'ATTENTION' }];
  }
  switch (lock.liveness) {
    case 'STALE':
      return [{ code: 'CONFIG_LOCK_STALE', severity: 'ATTENTION' }];
    case 'FOREIGN_HOST':
      return [{ code: 'CONFIG_LOCK_FOREIGN', severity: 'ATTENTION' }];
    default:
      return [{ code: 'CONFIG_LOCK_HELD', severity: 'ATTENTION' }];
  }
}

/**
 * Agrégation déterministe.
 *
 * Aucune priorité implicite tirée de l'ordre des sondes : les constats sont
 * triés, et le statut ne dépend que de leur contenu.
 */
export function aggregateStatus(findings: readonly DoctorFinding[]): DoctorStatus {
  if (findings.some((finding) => finding.severity === 'BLOCKER')) return 'BLOCKED';
  return findings.length > 0 ? 'ATTENTION' : 'READY';
}

// --------------------------------------------------------------------------
// Diagnostic
// --------------------------------------------------------------------------

async function inspectConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<{ report: DoctorConfigReport; findings: DoctorFinding[] }> {
  const legacyEnv = observeLegacyEnv(env);
  const displayPath = toDisplayPath(configPath, home);

  try {
    const loaded = await readConfig({ configPath });
    const effective = resolveEffectiveConfig(loaded, env);
    return {
      report: {
        path: displayPath,
        origin: loaded.origin,
        preflightOfferInteractiveLogin: loaded.config.preflight.offer_interactive_login,
        persistedSkipGitRepoCheck: loaded.config.codex.skip_git_repo_check,
        effective: {
          skipGitRepoCheck: effective.codex.skipGitRepoCheck,
          source: effective.codex.source,
        },
        legacyEnv,
      },
      findings: [],
    };
  } catch (error) {
    // La configuration n'est ni réparée, ni réécrite, ni remplacée par des
    // valeurs par défaut : le code normalisé est conservé et rapporté.
    const code =
      isCcrError(error) &&
      (error.code === 'CONFIG_INVALID' ||
        error.code === 'CONFIG_SCHEMA_UNSUPPORTED' ||
        error.code === 'CONFIG_READ_FAILED')
        ? error.code
        : undefined;
    if (code === undefined) throw error;

    // Une variable historique présente tranche même sans configuration lisible ;
    // sinon la valeur effective reste inconnue, et n'est pas inventée.
    const effective = legacyEnv.present
      ? { skipGitRepoCheck: legacyEnv.canonical, source: 'legacy-env' as ConfigValueSource }
      : undefined;

    return {
      report: {
        path: displayPath,
        origin: 'unreadable',
        error: code,
        ...(effective === undefined ? {} : { effective }),
        legacyEnv,
      },
      findings: [{ code, severity: 'BLOCKER' }],
    };
  }
}

async function inspectLock(configPath: string): Promise<DoctorConfigLockReport> {
  const observation = await observeConfigLock(configPath);
  const info = observation.info;
  if (observation.presence !== 'HELD' || info === undefined) {
    return { presence: observation.presence };
  }
  return {
    presence: 'HELD',
    liveness: assessConfigLockLiveness(info),
    pid: info.pid,
    hostname: info.hostname,
    createdAt: info.created_at,
    command: info.command,
  };
}

/**
 * Inspecte un run, sans jamais le modifier (§16.4).
 *
 * Trois modes strictement distincts :
 *
 *   snapshot valide   → PINNED, comparaisons avec le runtime observé
 *   snapshot absent   → LEGACY_UNPINNED, signalé mais jamais migré
 *   snapshot présent mais invalide → INVALID, blocage
 *
 * Présence + invalidité n'est **pas** absence historique : confondre les deux
 * ferait retomber un run pinné corrompu sur une résolution d'environnement.
 */
async function inspectRun(
  runsDir: string,
  runId: string,
  claude: AgentRuntimeProbe,
  codex: AgentRuntimeProbe,
  globalEffective: boolean | undefined,
): Promise<{ report: DoctorRunReport; findings: DoctorFinding[] }> {
  let loaded;
  try {
    loaded = await loadRun(runsDir, runId);
  } catch (error) {
    if (isCcrError(error) && (error.code === 'MANIFEST_INVALID' || error.code === 'SCHEMA_VERSION_UNSUPPORTED')) {
      if (error.details['field'] === 'runtime_config') {
        return {
          report: { id: runId, runtimeConfigMode: 'INVALID' },
          findings: [{ code: 'RUNTIME_CONFIG_INVALID', severity: 'BLOCKER' }],
        };
      }
    }
    // `RUN_NOT_FOUND` et les autres erreurs remontent telles quelles.
    throw error;
  }

  const snapshot = loaded.manifest.runtime_config;
  const base = { id: runId, state: loaded.state.state, control: loaded.state.control };

  if (snapshot === undefined) {
    return {
      report: {
        ...base,
        runtimeConfigMode: 'LEGACY_UNPINNED',
        ...(globalEffective === undefined ? {} : { globalSkipGitRepoCheck: globalEffective }),
      },
      findings: [{ code: 'RUNTIME_CONFIG_UNPINNED', severity: 'ATTENTION' }],
    };
  }

  const findings: DoctorFinding[] = [];

  // Les versions sont descriptives : une CLI mise à jour n'invalide pas un run.
  if (claude.version !== null && snapshot.claude.cli_version !== null && claude.version !== snapshot.claude.cli_version) {
    findings.push({ code: 'CLAUDE_VERSION_CHANGED', severity: 'ATTENTION' });
  }
  if (codex.version !== null && snapshot.codex.cli_version !== null && codex.version !== snapshot.codex.cli_version) {
    findings.push({ code: 'CODEX_VERSION_CHANGED', severity: 'ATTENTION' });
  }
  if (globalEffective !== undefined && globalEffective !== snapshot.codex.skip_git_repo_check) {
    // Information utile, jamais un blocage : le run garde sa valeur.
    findings.push({ code: 'RUN_CONFIG_DIFFERS_FROM_GLOBAL', severity: 'ATTENTION' });
  }

  return {
    report: {
      ...base,
      runtimeConfigMode: 'PINNED',
      capturedAt: snapshot.captured_at,
      claudeVersionAtStart: snapshot.claude.cli_version,
      codexVersionAtStart: snapshot.codex.cli_version,
      claudeAuthAtStart: snapshot.claude.auth_preflight,
      codexAuthAtStart: snapshot.codex.auth_preflight,
      skipGitRepoCheck: snapshot.codex.skip_git_repo_check,
      sourceAtCapture: snapshot.codex.source_at_capture,
      ...(globalEffective === undefined ? {} : { globalSkipGitRepoCheck: globalEffective }),
    },
    findings,
  };
}

/**
 * Produit le rapport complet.
 *
 * Aucun fail-fast : les deux agents, la configuration et le verrou sont
 * diagnostiqués dans tous les cas. Un agent absent n'empêche pas d'examiner la
 * configuration, et une configuration illisible n'empêche pas de sonder les
 * agents.
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const configPath = resolveConfigPath(deps.configPath);
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();

  const probeClaude = deps.probes?.claude ?? probeClaudeRuntime;
  const probeCodex = deps.probes?.codex ?? probeCodexRuntime;

  const [claude, codex, config, configLock] = await Promise.all([
    probeClaude({ ...deps.agentOptions?.claude }),
    probeCodex({ ...deps.agentOptions?.codex }),
    inspectConfig(configPath, env, home),
    inspectLock(configPath),
  ]);

  // Le diagnostic global est produit à l'identique, puis complété.
  const run =
    deps.runId === undefined
      ? undefined
      : await inspectRun(
          resolveRunsDir(deps.runsDir),
          deps.runId,
          claude,
          codex,
          config.report.effective?.skipGitRepoCheck,
        );

  const findings = [
    ...classifyAgent(claude),
    ...classifyAgent(codex),
    ...config.findings,
    ...classifyLegacyEnv(config.report.legacyEnv),
    ...classifyLock(configLock),
    ...(run?.findings ?? []),
  ].sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === 'BLOCKER' ? -1 : 1;
    return left.code.localeCompare(right.code);
  });

  return {
    status: aggregateStatus(findings),
    runtime: { node: process.versions.node },
    agents: { claude, codex },
    config: config.report,
    configLock,
    ...(run === undefined ? {} : { run: run.report }),
    findings,
  };
}

export const AGENT_LABELS: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };
