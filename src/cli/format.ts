/**
 * Rendu textuel de la CLI (spécification V0.2, §23, §45).
 *
 * Uniquement de la mise en forme : aucune décision métier, aucune écriture.
 */

import type { AgentKind } from '../core/run.ts';
import type { RunStatus } from '../services/run-service.ts';
import type { UsageReadModel } from '../services/usage-read-model.ts';
import type { CostEstimateReadModel } from '../services/cost-estimate-read-model.ts';
import type { RunSummary } from './native-dispatch.ts';

function agentBlock(status: RunStatus, agent: AgentKind, label: string): string[] {
  const entry = status.manifest.agents[agent];
  const activity =
    entry.session_id === null
      ? 'absente'
      : status.state.active_agent === agent
        ? 'tour en vol'
        : 'idle';

  return [
    label,
    `  session   : ${entry.session_id ?? '—'}`,
    `  role      : ${entry.role}`,
    `  status    : ${activity}`,
  ];
}

/**
 * Usage observé du run, en une ligne.
 *
 * Des comptes d'invocations et d'observations, jamais un total de jetons ni un
 * coût : Claude et Codex ne composent pas leurs compteurs de la même façon, et
 * CCR ne connaît aucun tarif.
 */
function usageLine(usage: UsageReadModel): string {
  const counts = usage.invocations;
  const parts = [
    `${String(counts.total)} invocation(s)`,
    `usage fournisseur ${String(counts.provider_reported.observed)} observée(s)` +
      ` / ${String(counts.provider_reported.unobserved)} non observée(s)`,
  ];
  if (counts.provider_reported.ambiguous > 0) {
    parts.push(`${String(counts.provider_reported.ambiguous)} ambiguë(s)`);
  }
  const anomalies =
    usage.anomalies.orphan_observations.length + usage.anomalies.duplicate_observations.length;
  if (anomalies > 0) parts.push(`${String(anomalies)} anomalie(s)`);
  return parts.join(' · ');
}

/**
 * Estimations de coût du run, en une ligne.
 *
 * Des comptes, et un montant seulement lorsqu'il en existe un. Sans catalogue
 * tarifaire — l'état de ce dépôt — rien n'est estimable, et afficher « 0 » le
 * dirait faux.
 *
 * Une somme ayant absorbé au moins une matérialisation arrondie porte « ≈ ».
 * Sans lui, un positif arrondi à zéro s'afficherait comme un coût nul.
 */
export function costLine(model: CostEstimateReadModel): string {
  const estimated = model.providers.reduce((sum, entry) => sum + entry.estimated_invocations, 0);
  const unknown = model.providers.reduce((sum, entry) => sum + entry.unknown_invocations, 0);
  const parts = [`${String(estimated)} estimée(s)`, `${String(unknown)} inconnue(s)`];
  if (model.pricing.kind === 'NONE') {
    parts.push('aucun catalogue tarifaire');
  } else {
    parts.push(`catalogue ${model.pricing.catalog_version}`);
    for (const provider of model.providers) {
      for (const bucket of provider.amounts_by_currency) {
        const approx = bucket.rounded_amount_invocations > 0 ? '≈' : '';
        parts.push(`${provider.provider} ${approx}${bucket.estimated_amount_sum} ${bucket.currency}`);
      }
    }
  }
  return parts.join(' · ');
}

/**
 * Politique d'invocations du run, en une ligne.
 *
 * Une limite CCR, jamais un quota fournisseur. La couverture est rappelée
 * lorsqu'aucun journal n'existe : sur un run antérieur, « 0 engagée » ne dit
 * pas qu'aucun modèle n'a jamais répondu.
 */
function quotaLine(status: RunStatus): string {
  const quota = status.invocationQuota;
  const scope = quota.coverage === 'PRE_LEDGER' ? ' (aucun journal d’invocations)' : '';
  if (quota.kind === 'NONE') {
    return `Quota CCR   : aucune limite — ${String(quota.consumed)} engagée(s)${scope}`;
  }
  return (
    `Quota CCR   : ${String(quota.consumed)}/${String(quota.limit)} engagée(s), ` +
    `restant ${String(quota.remaining)}${quota.exhausted ? ' — ÉPUISÉ' : ''}${scope}`
  );
}

export function formatStatus(status: RunStatus): string {
  const lines: string[] = [
    status.manifest.run_id,
    status.manifest.title,
    '',
    `State       : ${status.state.state}`,
    `Control     : ${status.state.control}`,
    `Round       : ${String(status.state.round)}`,
    '',
    `Workspace   : ${status.manifest.workspace.cwd}`,
    '',
    ...agentBlock(status, 'claude', 'Claude'),
    '',
    ...agentBlock(status, 'codex', 'Codex'),
    '',
    `Last event  : ${status.state.last_event_id ?? '—'} (${String(status.eventCount)} événements)`,
    quotaLine(status),
    `Usage CCR   : ${usageLine(status.usage)}`,
    `Coût estimé : ${costLine(status.costEstimate)}`,
  ];

  if (status.requiresRecovery) {
    lines.push(
      '',
      'ATTENTION : un tour agent était en vol lors du dernier arrêt de CCR.',
      "Il est impossible d'affirmer qu'il n'a pas eu lieu.",
      'Ce run doit passer explicitement par RECOVERY_REQUIRED avant toute reprise automatique.',
    );
  }

  if (status.state.pending_operation !== null) {
    const operation = status.state.pending_operation;
    lines.push(
      '',
      `Opération engagée : ${operation.kind} (${operation.agent}) depuis ${operation.started_at}`,
      `  retour attendu  : ${operation.return_state} / ${operation.return_control}`,
    );
  }

  if (status.state.uncertainty !== null) {
    lines.push(
      '',
      `Incertitude : ${status.state.uncertainty.reason}`,
      `  depuis    : ${status.state.uncertainty.since}`,
      `  agent     : ${status.state.uncertainty.agent ?? '—'}`,
    );
  }

  if (status.lock !== undefined) {
    lines.push(
      '',
      `Verrou      : ${status.lockLiveness ?? 'inconnu'} — pid ${String(status.lock.pid)} ` +
        `sur ${status.lock.hostname}, commande « ${status.lock.command} », depuis ${status.lock.started_at}`,
    );
    if (status.lockLiveness === 'STALE') {
      lines.push('              Utilisez `ccr recover` pour le nettoyer.');
    }
  }

  return lines.join('\n');
}

/**
 * Génération d'un run, en un mot.
 *
 * Explicite, et strictement limitée à ce qu'elle dit : elle nomme le moteur
 * d'exécution du run, jamais ses acteurs. Un run historique reste décrit par ses
 * fournisseurs, un run natif par ses ExpertSlots — et `list` n'en montre ni les
 * uns ni les autres.
 */
function generationLabel(summary: RunSummary): string {
  if (summary.generation === null) return '—';
  return summary.generation === 'NATIVE_V21_EXECUTION' ? 'natif' : 'historique';
}

export function formatList(summaries: readonly RunSummary[]): string {
  if (summaries.length === 0) return 'Aucun run.';

  const stateWidth = Math.max(...summaries.map((summary) => (summary.state ?? 'ILLISIBLE').length));
  const generationWidth = Math.max(...summaries.map((summary) => generationLabel(summary).length));
  return summaries
    .map((summary) => {
      const state = (summary.state ?? 'ILLISIBLE').padEnd(stateWidth);
      const generation = generationLabel(summary).padEnd(generationWidth);
      const suffix = summary.error === undefined ? '' : `  [${summary.error}]`;
      return `${summary.runId}  ${state}  ${generation}  ${summary.title}${suffix}`;
    })
    .join('\n');
}

export function formatAgentResponse(agent: AgentKind, sessionId: string, response: string): string {
  return [`--- ${agent.toUpperCase()} (${sessionId}) ---`, response, `--- FIN ${agent.toUpperCase()} ---`].join('\n');
}
