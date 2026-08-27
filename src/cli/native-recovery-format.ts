/**
 * Mise en forme des reprises natives (Slice 2E-R).
 *
 * Formatage seulement. Les statuts, les gestes disponibles, leurs qualificatifs
 * et les conflits viennent de la projection 2D ; la CLI les écrit, et n'en
 * déduit rien.
 */

import type { NativeRunReadModelV1 } from '../services/native-read-model.ts';

interface DomainRow {
  readonly label: string;
  readonly status: string;
  readonly actions: readonly string[];
  readonly qualifiers: readonly string[];
  readonly facts: readonly string[];
  readonly conflicts: readonly string[];
}

function slugOf(action: string): string {
  return action.toLowerCase().replaceAll('_', '-');
}

function rows(view: NativeRunReadModelV1): readonly DomainRow[] {
  const qualifiers = (
    actions: readonly { action: string; may_call_provider: boolean; resulting_control?: string }[],
  ): string[] => {
    const notes: string[] = [];
    for (const action of actions) {
      if (action.may_call_provider) notes.push(`${slugOf(action.action)} : peut appeler un fournisseur`);
      if (action.resulting_control !== undefined) {
        notes.push(`${slugOf(action.action)} → contrôle ${action.resulting_control}`);
      }
    }
    return notes;
  };
  const fact = (label: string, value: string | undefined): string[] =>
    value === undefined ? [] : [`${label} ${value}`];

  return [
    {
      label: 'initialization',
      status: view.recovery.initialization.status,
      actions: view.recovery.initialization.available_actions.map((action) => slugOf(action.action)),
      qualifiers: qualifiers(view.recovery.initialization.available_actions),
      facts: [
        ...(view.recovery.initialization.missing_slots.length === 0
          ? []
          : [`slots manquants ${view.recovery.initialization.missing_slots.join(', ')}`]),
        ...(view.recovery.initialization.uncertain_slot === null
          ? []
          : [`slot incertain ${view.recovery.initialization.uncertain_slot}`]),
      ],
      conflicts: view.recovery.initialization.conflicts,
    },
    {
      label: 'step',
      status: view.recovery.step.status,
      actions: view.recovery.step.available_actions.map((action) => slugOf(action.action)),
      qualifiers: qualifiers(view.recovery.step.available_actions),
      facts: [
        ...fact('source', view.recovery.step.source_event_id),
        ...fact('réponse', view.recovery.step.response_event_id),
      ],
      conflicts: view.recovery.step.conflicts,
    },
    {
      label: 'send',
      status: view.recovery.send.status,
      actions: view.recovery.send.available_actions.map((action) => slugOf(action.action)),
      qualifiers: qualifiers(view.recovery.send.available_actions),
      facts: [
        ...fact('message', view.recovery.send.prompt_event_id),
        ...(view.recovery.send.orphan_prompt_event_ids.length === 0
          ? []
          : [`orphelins ${view.recovery.send.orphan_prompt_event_ids.join(', ')}`]),
      ],
      conflicts: view.recovery.send.conflicts,
    },
    {
      label: 'handoff',
      status: view.recovery.handoff.status,
      actions: view.recovery.handoff.available_actions.map((action) => slugOf(action.action)),
      qualifiers: qualifiers(view.recovery.handoff.available_actions),
      facts: [
        ...fact('ouverture', view.recovery.handoff.started_event_id),
        ...(view.recovery.handoff.orphan_started_event_ids.length === 0
          ? []
          : [`orphelines ${view.recovery.handoff.orphan_started_event_ids.join(', ')}`]),
      ],
      conflicts: view.recovery.handoff.conflicts,
    },
  ];
}

/**
 * Les quatre domaines, leurs statuts et leurs gestes.
 *
 * L'humain choisit ensuite explicitement : rien n'est sélectionné pour lui,
 * même lorsqu'un seul geste est disponible.
 */
export function formatNativeRecoveryOverview(view: NativeRunReadModelV1): string {
  const lines = [
    `Run ${view.identity.run_id} — reprises natives`,
    `  état        ${view.operational_state.state} / ${view.operational_state.control}`,
  ];
  for (const row of rows(view)) {
    const actions = row.actions.length === 0 ? '—' : row.actions.join(', ');
    lines.push(`  ${row.label.padEnd(15)}${row.status.padEnd(30)}${actions}`);
    for (const detail of [...row.facts, ...row.qualifiers]) lines.push(`      ${detail}`);
    for (const conflict of row.conflicts) lines.push(`      contradiction : ${conflict}`);
  }
  return lines.join('\n');
}

/** État des reprises après un geste, relu depuis une projection fraîche. */
export function formatNativeRecoveryResult(
  view: NativeRunReadModelV1,
  domain: string,
  actions: readonly string[],
): string {
  const row = rows(view).find((candidate) => candidate.label === domain);
  const lines: string[] = [];
  for (const action of actions) lines.push(`  · ${action}`);
  lines.push('');
  lines.push(`RECOVERY ${domain} : ${row?.status ?? '—'}`);
  lines.push(`control : ${view.operational_state.control}`);
  lines.push(`state   : ${view.operational_state.state}`);
  return lines.join('\n');
}
