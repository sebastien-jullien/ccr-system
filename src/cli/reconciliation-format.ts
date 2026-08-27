/**
 * Présentation V5 — **rendu seulement**.
 *
 * Tranche S14 du plan gelé. Ce module met en forme des structures **déjà
 * produites** par `S12`. Il ne dérive rien.
 *
 * ```text
 * FORMAT  ≠  DERIVATION        CLI PRESENTATION  ≠  BUSINESS AUTHORITY
 * ORDER   ≠  PREFERENCE
 * ```
 *
 * ## Ce que ce module ne fait jamais
 *
 * Il ne trie pas, ne regroupe pas, ne compte pas pour créer du sens, ne choisit
 * aucune décision, n'interprète aucun désaccord, n'infère aucune clôture, ne
 * réécrit pas `NOT_AVAILABLE` en liste vide et ne transforme aucun inconnu en
 * zéro. Il ne compose pas non plus `S9`, `S10` ou `S11` pour fabriquer une vue
 * différente de celle du read model.
 *
 * Les **deux actualités** sont rendues sous deux libellés distincts, jamais
 * fusionnées en un statut : `CR5-01` doit rester lisible à l'écran.
 *
 * ```text
 * INTERDIT   OPEN · CLOSED · REOPENED · RESOLVED · CONVERGED comme état global
 * INTERDIT   gagnant · rang · score · recommandation · progression · santé
 * ```
 */

import type {
  ControversyReconciliationV1,
  ReconciliationReadModelV1,
} from '../services/reconciliation-read-model.ts';

function indent(lines: readonly string[]): readonly string[] {
  return lines.map((line) => `  ${line}`);
}

/** Les faits d'une controverse, catégorie par catégorie, sans agrégat. */
function formatControversy(item: ControversyReconciliationV1): readonly string[] {
  const lines: string[] = [`controverse ${item.controversy_id}`];

  lines.push('  actes humains');
  for (const act of item.recorded_acts) {
    const relation =
      act.responds_to === undefined
        ? ''
        : ` — ${act.responds_to.relation} ${act.responds_to.proposal_id}` +
          (act.responds_to.adopted_option_id === undefined
            ? ''
            : ` option ${act.responds_to.adopted_option_id}`);
    lines.push(`    ${act.entry_id}${relation}`);
    lines.push(`      ${act.content}`);
  }

  lines.push('  propositions CCR');
  for (const proposal of item.proposals) {
    lines.push(`    ${proposal.entry_id}`);
    // Ordre serveur, sans marqueur : aucune option n'est « principale ».
    for (const option of proposal.options) {
      lines.push(`      ${option.option_id} · ${option.content}`);
    }
  }

  lines.push('  réponses humaines');
  for (const response of item.responses) {
    const option =
      response.responded_option_id === undefined
        ? ''
        : ` option ${response.responded_option_id}`;
    lines.push(`    ${response.entry_id} ${response.mode} ${response.proposal_id}${option}`);
  }

  lines.push('  périmètres déclarés');
  for (const scope of item.scopes) {
    lines.push(`    ${scope.entry_id} ${scope.scope_kind} [${scope.scope.join(' ')}]`);
  }

  lines.push('  clôtures déclarées (historique)');
  for (const closure of item.closure_declarations) {
    lines.push(`    ${closure.entry_id} [${closure.scope.join(' ')}] — ${closure.statement}`);
  }

  lines.push('  retraits de clôture déclarés (historique)');
  for (const withdrawal of item.closure_withdrawal_declarations) {
    lines.push(
      `    ${withdrawal.entry_id} retire [${withdrawal.withdrawn_closures.join(' ')}] ` +
        `sur [${withdrawal.withdrawal_scope.join(' ')}]`,
    );
  }

  lines.push('  relations de supersession');
  for (const relation of item.supersession_relations) {
    lines.push(
      `    ${relation.entry_id} supersède ${relation.superseded_act_id} ` +
        `sur [${relation.supersession_scope.join(' ')}]`,
    );
  }

  // Les deux actualités, deux rubriques. Aucune ligne ne les combine.
  lines.push('  actualité de décision — par acte et par unité');
  for (const row of item.decision_currentness) {
    lines.push(`    ${row.act_id} / ${row.unit} : ${row.current ? 'courante' : 'non courante'}`);
  }

  lines.push('  décisions courantes — ensemble par unité, jamais départagé');
  for (const row of item.current_decisions) {
    lines.push(`    ${row.unit} : ${row.act_ids.length === 0 ? '—' : row.act_ids.join(' ')}`);
  }

  lines.push("  actualité d'effet de clôture — ensemble par unité");
  for (const row of item.closure_effect_currentness) {
    lines.push(`    ${row.unit} : ${row.act_ids.length === 0 ? 'NONE' : row.act_ids.join(' ')}`);
  }

  // §17.2 — deux faits distincts, jamais l'un présenté comme l'autre.
  lines.push(
    `  déclaration humaine historique de clôture sur WHOLE : ` +
      `${item.historical_explicit_whole_scope_closure_declaration ? 'oui' : 'non'}`,
  );
  lines.push(
    `  couverture actuelle de toutes les unités par un effet courant : ` +
      `${item.current_all_entries_closure_coverage ? 'oui' : 'non'}`,
  );

  lines.push('  signaux de désaccord observés — S1–S4');
  for (const signal of item.disagreement_view) {
    const actor = signal.semantic_origin.actor === undefined ? '' : `/${signal.semantic_origin.actor}`;
    lines.push(`    ${signal.signal} ${signal.entry_id} (${signal.semantic_origin.kind}${actor})`);
  }

  lines.push('  détections structurelles — D01–D08');
  for (const detection of item.detections) {
    const subject =
      'unit' in detection
        ? detection.unit
        : 'proposal_id' in detection
          ? detection.proposal_id
          : 'act_id' in detection
            ? detection.act_id
            : detection.entry_id;
    const act = 'act_id' in detection && 'unit' in detection ? ` ${detection.act_id}` : '';
    lines.push(`    ${detection.category} ${subject}${act}`);
  }

  return lines;
}

/**
 * Rend le read model V5.
 *
 * `NOT_AVAILABLE` est rendu **comme tel** : jamais comme une liste vide, jamais
 * comme un zéro. Un run non concerné n'a pas été regardé.
 *
 * ```text
 * NOT_AVAILABLE  ≠  EMPTY        UNKNOWN  ≠  ZERO
 * ```
 */
export function formatReconciliationReadModel(model: ReconciliationReadModelV1): string {
  if (model.availability === 'NOT_AVAILABLE') {
    return [
      'Réconciliation V5 : NOT_AVAILABLE',
      "Ce run n'est pas concerné par V5. Ce n'est pas « zéro acte » : il n'a pas été regardé.",
    ].join('\n');
  }

  const lines: string[] = [
    `Réconciliation V5 — révision ${model.reconciliation_revision}`,
    // Nombre d'ENREGISTREMENTS, jamais une mesure d'activité ou de progression.
    `enregistrements V5 observés : ${String(model.recorded_count)}`,
    '',
  ];
  for (const item of model.items) {
    lines.push(...formatControversy(item));
    lines.push('');
  }
  lines.push(
    "Une proposition n'est pas une décision. Une décision non courante n'a pas perdu " +
      "sa clôture. Une absence de signal n'est pas un accord.",
  );
  return lines.join('\n');
}

/** Un acte enregistré, rendu sans commentaire d'opportunité. */
export function formatRecordedEntry(entryId: string, revision: string): readonly string[] {
  return indent([`enregistré : ${entryId}`, `révision V5 : ${revision}`]);
}
