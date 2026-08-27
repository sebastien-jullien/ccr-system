/**
 * Rendu textuel de `ccr doctor`.
 *
 * Uniquement de la mise en forme : aucune décision, aucune écriture, aucun
 * accès disque. Le statut et les constats sont calculés par le service ; ce
 * module se contente de leur donner des phrases.
 *
 * Règle de vocabulaire (§24) : CCR rapporte ce que les CLI **disent**, jamais
 * ce qui serait vrai côté serveur. Aucune sortie fournisseur brute n'entre ici,
 * puisque le rapport n'en contient pas.
 */

import { AGENT_LABELS } from '../services/doctor-service.ts';
import type {
  DoctorConfigLockReport,
  DoctorFinding,
  DoctorFindingCode,
  DoctorReport,
  DoctorRunReport,
} from '../services/doctor-service.ts';
import type { AgentRuntimeProbe } from '../runtime/agent-runtime-probe.ts';

/** Une phrase par constat, et une action lorsqu'elle existe réellement. */
const FINDING_MESSAGES: Record<DoctorFindingCode, string> = {
  CLAUDE_CLI_MISSING: "Claude Code est introuvable. CCR n'installe aucun fournisseur.",
  CLAUDE_AUTH_REQUIRED:
    'Claude Code est installé mais ne rapporte aucune authentification. ' +
    'Exécutez `ccr setup` pour que la connexion officielle vous soit proposée.',
  CLAUDE_AUTH_UNKNOWN:
    "Le statut d'authentification de Claude Code n'a pas pu être déterminé. " +
    "L'appel réel reste l'autorité.",
  CLAUDE_VERSION_UNKNOWN: "La version de Claude Code n'a pas pu être déterminée.",
  CODEX_CLI_MISSING: "Codex est introuvable. CCR n'installe aucun fournisseur.",
  CODEX_AUTH_NOT_REPORTED:
    'Codex ne rapporte aucune connexion OpenAI active. ' +
    'Une autre configuration fournisseur peut néanmoins être utilisable.',
  CODEX_AUTH_UNKNOWN:
    "Le statut d'authentification de Codex n'a pas pu être déterminé. " +
    "L'appel réel reste l'autorité.",
  CODEX_VERSION_UNKNOWN: "La version de Codex n'a pas pu être déterminée.",
  CONFIG_INVALID:
    "La configuration CCR existe mais n'est pas valide. CCR ne la réécrit pas : corrigez-la ou supprimez-la.",
  CONFIG_SCHEMA_UNSUPPORTED:
    'La configuration CCR porte une version de schéma que cette version de CCR ne sait pas lire.',
  CONFIG_READ_FAILED: "La configuration CCR existe mais n'a pas pu être lue. Vérifiez ses droits d'accès.",
  LEGACY_ENV_OVERRIDE:
    'La variable CCR_CODEX_SKIP_GIT_REPO_CHECK est définie et prime sur la configuration. ' +
    'Retirez-la pour que le réglage persistant s\'applique.',
  LEGACY_ENV_NON_CANONICAL:
    'La variable CCR_CODEX_SKIP_GIT_REPO_CHECK porte une valeur non canonique : ' +
    'seule la valeur exacte "1" active le contournement ; toute autre valeur vaut false.',
  CONFIG_LOCK_HELD:
    'Un verrou de configuration est détenu par un processus vivant. ' +
    'Une écriture de configuration échouerait pour le moment.',
  CONFIG_LOCK_STALE:
    'Un verrou de configuration semble abandonné : son propriétaire local a disparu. ' +
    'Exécutez `ccr setup` pour l\'examiner et, si vous le confirmez, le retirer.',
  CONFIG_LOCK_FOREIGN:
    'Un verrou de configuration provient d\'un autre hôte : son état ne peut pas être déterminé ici.',
  CONFIG_LOCK_UNREADABLE:
    "Un verrou de configuration est présent mais illisible. CCR ne le supprime pas.",
  RUNTIME_CONFIG_UNPINNED:
    "Ce run est un run V1 historique : sa configuration d'exécution n'est pas figée. " +
    "Elle est résolue à chaque invocation, et peut donc varier d'un terminal à l'autre.",
  RUNTIME_CONFIG_INVALID:
    "Ce run porte une configuration runtime illisible. CCR ne la remplace pas et ne la traite " +
    'pas comme absente : un snapshot corrompu est un fait distinct.',
  CLAUDE_VERSION_CHANGED:
    'La version de Claude Code installée diffère de celle observée au démarrage du run. ' +
    'Cette information est descriptive : le run reste utilisable.',
  CODEX_VERSION_CHANGED:
    'La version de Codex installée diffère de celle observée au démarrage du run. ' +
    'Cette information est descriptive : le run reste utilisable.',
  RUN_CONFIG_DIFFERS_FROM_GLOBAL:
    'La configuration globale actuelle diffère de celle figée dans ce run. ' +
    'Le run conserve sa propre valeur : telle est la raison d\'être du snapshot.',
};

function runLines(run: DoctorRunReport): string[] {
  const lines = [`  ${pad('Run')}${run.id}`];
  if (run.state !== undefined) lines.push(`  ${pad('État')}${run.state} / ${run.control ?? '?'}`);

  if (run.runtimeConfigMode !== 'PINNED') {
    lines.push(
      `  ${pad('Configuration')}${run.runtimeConfigMode === 'INVALID' ? 'snapshot illisible' : 'non figée (run V1 historique)'}`,
    );
    if (run.globalSkipGitRepoCheck !== undefined) {
      lines.push(
        `  ${pad('Résolution')}${String(run.globalSkipGitRepoCheck)} — calculée maintenant, non figée`,
      );
    }
    return lines;
  }

  lines.push(`  ${pad('Configuration')}figée le ${run.capturedAt ?? '?'}`);
  lines.push(`  ${pad('Codex hors Git')}${String(run.skipGitRepoCheck)} (fait autorité pour ce run)`);
  if (run.sourceAtCapture !== undefined) {
    // Libellé volontairement historique : jamais « source actuelle ». Après un
    // `ccr setup --run`, la valeur peut avoir changé sans que sa provenance
    // d'origine ne devienne fausse.
    lines.push(`  ${pad('Source à la capture')}${run.sourceAtCapture}`);
  }
  if (run.globalSkipGitRepoCheck !== undefined) {
    lines.push(`  ${pad('Config globale')}${String(run.globalSkipGitRepoCheck)} (comparatif seulement)`);
  }
  lines.push(
    `  ${pad('Au démarrage')}Claude ${run.claudeVersionAtStart ?? '?'} ${run.claudeAuthAtStart ?? '?'}`,
  );
  lines.push(`  ${pad('')}Codex ${run.codexVersionAtStart ?? '?'} ${run.codexAuthAtStart ?? '?'}`);
  return lines;
}

function pad(label: string): string {
  return label.padEnd(20, ' ');
}

function describeAuth(status: AgentRuntimeProbe['authStatus']): string {
  switch (status) {
    case 'AUTHENTICATED':
      return 'authentifié';
    case 'UNAUTHENTICATED':
      return 'non authentifié';
    default:
      return 'indéterminé';
  }
}

function agentLine(probe: AgentRuntimeProbe): string {
  const label = pad(AGENT_LABELS[probe.agent]);
  if (!probe.installed) return `  ${label}absent`;

  const version = (probe.version ?? 'version inconnue').padEnd(12, ' ');
  const source = probe.launcherSource === 'npm-shim' ? ' (point d\'entrée npm)' : '';
  return `  ${label}${version}${describeAuth(probe.authStatus)}${source}`;
}

function lockLines(lock: DoctorConfigLockReport): string[] {
  if (lock.presence === 'ABSENT') return [`  ${pad('Verrou')}aucun`];
  if (lock.presence === 'UNREADABLE') return [`  ${pad('Verrou')}présent, illisible`];

  const state =
    lock.liveness === 'STALE'
      ? 'abandonné'
      : lock.liveness === 'FOREIGN_HOST'
        ? 'autre hôte'
        : 'détenu';
  const lines = [`  ${pad('Verrou')}${state} — processus ${String(lock.pid ?? '?')}`];
  if (lock.liveness === 'FOREIGN_HOST') lines.push(`  ${pad('')}hôte ${lock.hostname ?? '?'}`);
  if (lock.createdAt !== undefined) lines.push(`  ${pad('')}depuis ${lock.createdAt}`);
  return lines;
}

function configLines(report: DoctorReport): string[] {
  const config = report.config;
  const origin =
    config.origin === 'file' ? 'fichier' : config.origin === 'defaults' ? 'valeurs par défaut' : 'illisible';

  const lines = [`  ${pad('Chemin')}${config.path}`, `  ${pad('Origine')}${origin}`];

  if (config.preflightOfferInteractiveLogin !== undefined) {
    lines.push(`  ${pad('Login proposé')}${String(config.preflightOfferInteractiveLogin)}`);
  }
  // « persisté » ne se dit que d'un fichier réel : sans configuration, la
  // valeur affichée serait un défaut, pas un choix enregistré.
  if (config.origin === 'file' && config.persistedSkipGitRepoCheck !== undefined) {
    lines.push(`  ${pad('Codex hors Git')}${String(config.persistedSkipGitRepoCheck)} (persisté)`);
  }
  if (config.effective === undefined) {
    lines.push(`  ${pad('Effectif')}indéterminé — configuration illisible`);
  } else {
    const source =
      config.effective.source === 'legacy-env'
        ? 'variable héritée'
        : config.effective.source === 'config'
          ? 'configuration'
          : 'valeur par défaut';
    lines.push(`  ${pad('Effectif')}${String(config.effective.skipGitRepoCheck)} — ${source}`);
  }

  return lines;
}

function findingLines(findings: readonly DoctorFinding[], severity: DoctorFinding['severity']): string[] {
  return findings
    .filter((finding) => finding.severity === severity)
    .map((finding) => `  · [${finding.code}] ${FINDING_MESSAGES[finding.code]}`);
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    'CCR — diagnostic local',
    '',
    'Runtime',
    `  ${pad('Node.js')}${report.runtime.node}`,
    '',
    'Agents (état rapporté par les CLI)',
    agentLine(report.agents.claude),
    agentLine(report.agents.codex),
    '',
    'Configuration',
    ...configLines(report),
    '',
    'Verrou de configuration',
    ...lockLines(report.configLock),
  ];

  if (report.run !== undefined) {
    lines.push('', 'Run inspecté', ...runLines(report.run));
  }

  const blockers = findingLines(report.findings, 'BLOCKER');
  if (blockers.length > 0) {
    lines.push('', 'Blocages', ...blockers);
  }

  const attentions = findingLines(report.findings, 'ATTENTION');
  if (attentions.length > 0) {
    lines.push('', 'Points d\'attention', ...attentions);
  }

  lines.push('', `Statut : ${report.status}`);
  return lines.join('\n');
}
