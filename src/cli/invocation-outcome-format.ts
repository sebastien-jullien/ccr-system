/**
 * Mise en forme humaine des faits dédiés d'issue d'invocation.
 *
 * Cette surface **rend ce qui est persisté**, sans le reclasser. Le genre
 * d'issue est affiché sous son code exact, et sa charge utile typée est
 * parcourue telle quelle : aucun vocabulaire de motif n'est traduit, aucun
 * genre n'est renommé, aucune famille V3/V4/V5 n'est rapprochée d'une autre.
 *
 * ## Deux règles de rendu qui portent tout le contrat
 *
 * ```text
 * ZÉRO RÉSULTAT   énoncé de cardinalité, jamais d'existence de fichier,
 *                 jamais de succès, jamais d'échec
 * VALID_ZERO      le code exact reste visible ; la glose est bornée à la
 *                 cardinalité, et ne devient jamais « aucun résultat »
 * ```
 *
 * Le localisateur d'artefact n'est imprimé **que lorsqu'un enregistrement
 * existe** : l'annoncer sur une requête sans résultat affirmerait la présence
 * physique d'un conteneur que cette surface ne constate pas.
 */

import type {
  InvocationOutcomeFact,
  InvocationOutcomeFactsView,
} from '../services/invocation-outcome-read.ts';

/** Énoncé de cardinalité. Il ne parle ni de fichier, ni de résultat. */
export const NO_INVOCATION_OUTCOME_FACT =
  "Aucun fait dédié d'issue d'invocation enregistré pour cette requête.";

/**
 * Glose de `VALID_ZERO`, délibérément étroite.
 *
 * Elle décrit une cardinalité et une validité structurelle. Elle ne dit ni
 * accord, ni consensus, ni échec, ni contexte suffisant, ni succès générique.
 */
const VALID_ZERO_GLOSS = 'résultat structurellement valide de cardinalité zéro pour l’opération concernée';

function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Rend la charge utile d'une issue, champ par champ.
 *
 * Le parcours est générique **par fidélité** : il recopie ce que
 * l'enregistrement porte, sans table de correspondance capable de renommer un
 * motif ou d'en fusionner deux.
 */
function payloadLines(outcome: InvocationOutcomeFact['outcome']): string[] {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(outcome)) {
    if (key === 'kind' || value === undefined) continue;

    if (key === 'native_detail' && value !== null && typeof value === 'object') {
      lines.push(`      ${key.padEnd(10)} —`);
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (innerValue === undefined) continue;
        lines.push(`        ${inner.padEnd(20)} ${renderValue(innerValue)}`);
      }
      continue;
    }

    lines.push(`      ${key.padEnd(10)} ${renderValue(value)}`);
  }

  return lines;
}

function factLines(fact: InvocationOutcomeFact): string[] {
  const lines = [
    `  ${fact.invocation_id}   enregistrement v${String(fact.source_schema_version)}   ${fact.recorded_at}`,
    `      issue      ${fact.outcome.kind}`,
  ];

  if (fact.outcome.kind === 'VALID_ZERO') {
    lines.push(`                 ${VALID_ZERO_GLOSS}`);
    return lines;
  }

  lines.push(...payloadLines(fact.outcome));
  return lines;
}

/** Rend la vue complète. */
export function formatInvocationOutcomeFacts(view: InvocationOutcomeFactsView): string {
  const lines = [`Run ${view.run_id} — faits dédiés d'issue d'invocation`];

  lines.push(
    "  autorité   fait durable d'issue d'invocation — ni décision humaine,",
    "             ni autorité d'objet de domaine, ni résultat terminal générique",
  );

  if (view.filter !== undefined) {
    lines.push(`  filtre     invocation ${view.filter.invocation_id}`);
  }

  if (view.facts.length === 0) {
    lines.push('', NO_INVOCATION_OUTCOME_FACT);
    return lines.join('\n');
  }

  lines.push('  source     invocation-outcomes.json', '');

  for (const fact of view.facts) {
    lines.push(...factLines(fact));
  }

  return lines.join('\n');
}
