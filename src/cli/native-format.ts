/**
 * Mise en forme d'un run natif pour le terminal (Slice 2E).
 *
 * Formatage **seulement**. Aucune règle n'est réévaluée ici : les verdicts, les
 * codes de refus, les statuts de reprise et les gestes disponibles viennent
 * intégralement de la projection 2D. Une ligne affichée est une lecture, jamais
 * une décision.
 *
 * Ce que la CLI ajoute est du texte ; ce qu'elle ne fait jamais, c'est
 * recalculer quel slot est source, si un alias est ambigu, si un handoff est
 * permis, ou si une position est périmée.
 */

import { EXPERT_SLOT_IDS } from '../core/expert.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import type { UsageReadModel } from '../services/usage-read-model.ts';
import type { CostEstimateReadModel } from '../services/cost-estimate-read-model.ts';
import type {
  NativeControlCapability,
  NativeOperationCapability,
  NativeRunReadModelV1,
} from '../services/native-read-model.ts';

function capability(label: string, capability: NativeOperationCapability): string {
  return capability.allowed ? `${label} : autorisé` : `${label} : refusé (${String(capability.reason_code)})`;
}

/**
 * Contrôle humain — trois issues, pas deux.
 *
 * « déjà satisfait » n'est pas « refusé » : afficher un refus là où CCR répond
 * « rien à faire » inventerait un obstacle.
 */
function controlLabel(label: string, control: NativeControlCapability): string {
  if (!control.allowed) {
    const domains = control.conflicting_recovery_domains;
    const detail = domains === undefined ? '' : ` : ${domains.join(', ')}`;
    return `${label} : refusé (${String(control.reason_code)}${detail})`;
  }
  return control.noop ? `${label} : sans effet (déjà satisfait)` : `${label} : autorisé`;
}

function controlLine(view: NativeRunReadModelV1): string {
  return (
    `  contrôle    ${controlLabel('pause', view.operations.pause)} · ` +
    `${controlLabel('resume', view.operations.resume)}`
  );
}

function expertLine(slot: ExpertSlotId, view: NativeRunReadModelV1): string {
  const expert = view.experts[slot];
  const session = expert.session_id ?? '—';
  const operations = [
    capability('send', view.operations.experts[slot].send),
    capability('handoff', view.operations.experts[slot].handoff),
  ].join(' · ');
  return `  ${slot.padEnd(11)}${expert.provider.padEnd(8)}session ${session.padEnd(24)}${expert.session_status}\n              ${operations}`;
}

function stepLine(view: NativeRunReadModelV1): string {
  const step = view.operations.step;
  if (step.allowed) {
    return (
      `  transfert   ${String(step.source_slot)} → ${String(step.target_slot)} ` +
      `(source ${String(step.source_event_id)}, round ${String(step.next_round)}, ` +
      `${String(step.payload_bytes)} octets)`
    );
  }
  return `  transfert   refusé (${String(step.reason_code)}) — source ${step.source_status}`;
}

function recoveryLine(view: NativeRunReadModelV1): string {
  const domains = [
    ['initialisation', view.recovery.initialization.status] as const,
    ['transfert', view.recovery.step.status] as const,
    ['envoi', view.recovery.send.status] as const,
    ['handoff', view.recovery.handoff.status] as const,
  ];
  return `  reprises    ${domains.map(([name, status]) => `${name} ${status}`).join(' · ')}`;
}

function actionsLine(view: NativeRunReadModelV1): string | null {
  const entries: string[] = [];
  const domains = [
    ['initialisation', view.recovery.initialization.available_actions] as const,
    ['transfert', view.recovery.step.available_actions] as const,
    ['envoi', view.recovery.send.available_actions] as const,
    ['handoff', view.recovery.handoff.available_actions] as const,
  ];
  for (const [name, actions] of domains) {
    if (actions.length === 0) continue;
    entries.push(`${name} : ${actions.map((action) => action.action).join(', ')}`);
  }
  if (entries.length === 0) return null;
  return `  gestes      ${entries.join(' · ')}`;
}

function aliasLine(view: NativeRunReadModelV1): string {
  const aliases = Object.entries(view.compatibility.provider_aliases).map(([provider, resolution]) =>
    resolution.resolution === 'UNIQUE'
      ? `${provider} → ${resolution.expert_slot}`
      : `${provider} → ${resolution.resolution}`,
  );
  return `  alias       ${aliases.join(' · ')}`;
}

/**
 * Réponse d'un expert, nommée par son **slot**.
 *
 * Le pendant natif de `formatAgentResponse` : en same-provider, deux réponses
 * du même moteur resteraient indiscernables si le titre nommait le moteur.
 */
export function formatNativeResponse(slot: ExpertSlotId, sessionId: string, response: string): string {
  const title = slot.toUpperCase();
  return [`--- ${title} (${sessionId}) ---`, response, `--- FIN ${title} ---`].join('\n');
}

/**
 * Usage observé du run, en une ligne.
 *
 * Des comptes d'invocations et d'observations, jamais un total de jetons ni un
 * coût : Claude et Codex ne composent pas leurs compteurs de la même façon, et
 * CCR ne connaît aucun tarif.
 */
function usageSummary(usage: UsageReadModel): string {
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
export function costSummary(model: CostEstimateReadModel): string {
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

function costLine(view: NativeRunReadModelV1): string {
  return `  coût estimé ${costSummary(view.cost_estimate)}`;
}

function usageLine(view: NativeRunReadModelV1): string {
  return `  usage CCR   ${usageSummary(view.usage)}`;
}

/**
 * Politique d'invocations du run, en une ligne.
 *
 * Une limite CCR, jamais un quota fournisseur ni un plafond de dépense. La
 * couverture n'est rappelée que lorsqu'elle change le sens du compte : sur un
 * run antérieur au journal, « 0 consommée » ne dit pas qu'aucun modèle n'a
 * jamais répondu.
 */
function quotaLine(view: NativeRunReadModelV1): string {
  const quota = view.invocation_quota;
  const scope = quota.coverage === 'PRE_LEDGER' ? '   (aucun journal d’invocations)' : '';
  if (quota.kind === 'NONE') {
    return `  quota CCR   aucune limite — ${String(quota.consumed)} invocation(s) engagée(s)${scope}`;
  }
  return (
    `  quota CCR   ${String(quota.consumed)}/${String(quota.limit)} engagée(s)` +
    `   restant ${String(quota.remaining)}${quota.exhausted ? '   ÉPUISÉ' : ''}${scope}`
  );
}

/**
 * Vue textuelle d'un run natif.
 *
 * Les experts sont nommés par leur **slot**, jamais par leur moteur : c'est la
 * même règle que le journal, et la seule qui reste vraie quand les deux experts
 * partagent le même fournisseur.
 */
export function formatNativeStatus(view: NativeRunReadModelV1): string {
  const lines = [
    `Run ${view.identity.run_id} — ${view.identity.title}`,
    `  génération  ${view.identity.execution_mode}`,
    `  workspace   ${view.identity.workspace_cwd}`,
    `  état        ${view.operational_state.state} / ${view.operational_state.control}` +
      `   round ${String(view.operational_state.round)}` +
      `   curseur ${view.operational_state.next_step_source_slot ?? '—'}`,
  ];
  if (view.operational_state.pending_operation !== null) {
    lines.push(`  opération   ${view.operational_state.pending_operation.kind} engagée`);
  }
  for (const slot of EXPERT_SLOT_IDS) lines.push(expertLine(slot, view));
  lines.push(stepLine(view));
  lines.push(controlLine(view));
  lines.push(recoveryLine(view));
  const actions = actionsLine(view);
  if (actions !== null) lines.push(actions);
  lines.push(aliasLine(view));
  lines.push(quotaLine(view));
  lines.push(usageLine(view));
  lines.push(costLine(view));

  const conflicts = [
    ...view.recovery.initialization.conflicts,
    ...view.recovery.step.conflicts,
    ...view.recovery.send.conflicts,
    ...view.recovery.handoff.conflicts,
  ];
  if (conflicts.length > 0) {
    lines.push('  FAITS CONTRADICTOIRES');
    for (const conflict of conflicts) lines.push(`    · ${conflict}`);
  }

  return lines.join('\n');
}
