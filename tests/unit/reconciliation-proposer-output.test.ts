/**
 * Preuves de la tranche S13 — section 1/3, le parseur strict.
 *
 * Question de preuve :
 *
 * > **Un modèle peut-il obtenir qu'une proposition existe autrement que sous la
 * > forme exacte du §11, ou glisser un effet humain, un classement ou un score
 * > dans ce que CCR enregistrera ?**
 *
 * `C45` exige que **chacun** des quinze motifs du §36 soit refusé avant toute
 * écriture. Les quinze sont ici, un par un, nommés.
 *
 * ```text
 * FIXTURE — fonction pure, aucun run, aucun verrou, aucun fournisseur
 * RAW MODEL OUTPUT  ≠  CANONICAL V5 HISTORY
 * VALIDATION        ≠  MERITS
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatControversyEntryId, formatControversyId } from '../../src/core/controversy.ts';
import {
  MAX_PROPOSER_OUTPUT_BYTES,
  PROPOSER_OUTPUT_REFUSAL_REASONS,
  RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
  buildProposalPrompt,
  parseReconciliationProposals,
} from '../../src/services/reconciliation-proposer.ts';
import type { ProposerOutputRefusalReason } from '../../src/services/reconciliation-proposer.ts';

const CTV = formatControversyId(1);
const OTHER = formatControversyId(2);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
    target_controversy_id: CTV,
    proposals: [{ scope: [E1], options: [{ option_id: 'oa', content: 'option a' }] }],
    ...over,
  });
}

function refusal(raw: string, target: string = CTV): { reason: string; at: string } {
  const parsed = parseReconciliationProposals(raw, target);
  assert.equal(parsed.outcome, 'INVALID', `sortie acceptée à tort : ${raw.slice(0, 120)}`);
  if (parsed.outcome !== 'INVALID') throw new Error('inatteignable');
  return { reason: parsed.reason, at: parsed.at };
}

function accepted(raw: string): ReturnType<typeof parseReconciliationProposals> {
  const parsed = parseReconciliationProposals(raw, CTV);
  assert.equal(parsed.outcome, 'VALID');
  return parsed;
}

// --------------------------------------------------------------------------
// Vocabulaire
// --------------------------------------------------------------------------

test('S13 — les quinze motifs du §36, ensemble fermé', () => {
  assert.deepEqual([...PROPOSER_OUTPUT_REFUSAL_REASONS], [
    'OUTPUT_TOO_LARGE',
    'OUTPUT_UNPARSABLE',
    'UNSUPPORTED_VERSION',
    'INVALID_ENVELOPE',
    'INVALID_PROPOSAL',
    'DUPLICATE_PROPOSAL',
    'UNKNOWN_TARGET',
    'INVALID_SCOPE',
    'RANKED_OPTIONS',
    'SCORE_FIELD_PRESENT',
    'CLOSURE_CLAIMED',
    'CLOSURE_WITHDRAWAL_CLAIMED',
    'SUPERSESSION_CLAIMED',
    'HUMAN_DECISION_CLAIMED',
    'AUTHORITATIVE_EFFECT_CLAIMED',
  ]);
});

// --------------------------------------------------------------------------
// Sortie valide
// --------------------------------------------------------------------------

test('S13 — une sortie conforme est analysée, sans rien ajouter', () => {
  const parsed = accepted(
    JSON.stringify({
      version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
      target_controversy_id: CTV,
      proposals: [
        {
          scope: [E1, E2],
          options: [
            { option_id: 'ob', content: 'option b' },
            { option_id: 'oa', content: 'option a' },
          ],
        },
      ],
    }),
  );
  if (parsed.outcome !== 'VALID') throw new Error('inatteignable');
  assert.equal(parsed.proposals.length, 1);
  // La proposition analysée porte EXACTEMENT deux champs : le modèle ne peut ni
  // fournir une origine sémantique, ni une dérivation, ni un effet.
  const proposal = parsed.proposals[0];
  assert.ok(proposal, 'la proposition analysée existe');
  assert.deepEqual(Object.keys(proposal).sort(), ['options', 'scope']);
  const option = proposal.options[0];
  assert.ok(option, 'la première option analysée existe');
  assert.deepEqual(Object.keys(option).sort(), ['content', 'option_id']);
  // `ORDER ≠ PREFERENCE` — l'ordre du modèle est conservé, jamais trié.
  assert.deepEqual(
    proposal.options.map((entry) => entry.option_id),
    ['ob', 'oa'],
  );
  assert.deepEqual(proposal.scope, [E1, E2]);
});

test('S13 — un ensemble vide de propositions est valide', () => {
  const parsed = accepted(envelope({ proposals: [] }));
  if (parsed.outcome !== 'VALID') throw new Error('inatteignable');
  assert.deepEqual(parsed.proposals, []);
});

// --------------------------------------------------------------------------
// Les quinze motifs, un par un
// --------------------------------------------------------------------------

test('S13 — §36 : sortie trop volumineuse, refusée AVANT analyse', () => {
  // La charge est un JSON parfaitement valide : seule la borne la refuse. Un
  // parseur qui analyserait d'abord paierait le coût que la borne évite.
  const huge = JSON.stringify({
    version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
    target_controversy_id: CTV,
    proposals: [{ scope: [E1], options: [{ option_id: 'oa', content: 'x'.repeat(1024 * 1024) }] }],
  });
  assert.ok(huge.length > MAX_PROPOSER_OUTPUT_BYTES);
  assert.equal(refusal(huge).reason, 'OUTPUT_TOO_LARGE');
  // Et la même charge sous la borne est acceptée : le refus vient bien de la
  // taille, non d'un défaut de forme.
  const small = JSON.stringify({
    version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
    target_controversy_id: CTV,
    proposals: [{ scope: [E1], options: [{ option_id: 'oa', content: 'x'.repeat(64) }] }],
  });
  assert.equal(parseReconciliationProposals(small, CTV).outcome, 'VALID');
});

test('S13 — §36 : sortie non analysable', () => {
  assert.equal(refusal('pas du json').reason, 'OUTPUT_UNPARSABLE');
  assert.equal(refusal('{"version":').reason, 'OUTPUT_UNPARSABLE');
});

test('S13 — §36 : version non prise en charge', () => {
  assert.equal(refusal(envelope({ version: 2 })).reason, 'UNSUPPORTED_VERSION');
  assert.equal(refusal(envelope({ version: '1' })).reason, 'UNSUPPORTED_VERSION');
  assert.equal(refusal(JSON.stringify({ target_controversy_id: CTV, proposals: [] })).reason, 'UNSUPPORTED_VERSION');
});

test('S13 — §36 : enveloppe invalide', () => {
  assert.equal(refusal('[]').reason, 'INVALID_ENVELOPE');
  assert.equal(refusal('"texte"').reason, 'INVALID_ENVELOPE');
  // Enveloppe fermée : tout champ étranger est refusé, jamais ignoré.
  assert.equal(refusal(envelope({ note: 'bonjour' })).at, 'envelope.note');
  assert.equal(refusal(envelope({ note: 'bonjour' })).reason, 'INVALID_ENVELOPE');
  assert.equal(refusal(envelope({ proposals: 'aucune' })).reason, 'INVALID_ENVELOPE');
});

test('S13 — §36 : proposition invalide', () => {
  assert.equal(refusal(envelope({ proposals: ['texte'] })).reason, 'INVALID_PROPOSAL');
  assert.equal(refusal(envelope({ proposals: [{ scope: [E1] }] })).reason, 'INVALID_PROPOSAL');
  assert.equal(
    refusal(envelope({ proposals: [{ scope: [E1], options: [], note: 1 }] })).reason,
    'INVALID_PROPOSAL',
  );
  // Cardinalité : au moins une option (§11 « non vide »).
  assert.equal(
    refusal(envelope({ proposals: [{ scope: [E1], options: [] }] })).at,
    'proposals[0].options',
  );
  // Identité d'option : présente, non vide, unique.
  for (const options of [
    [{ option_id: '', content: 'c' }],
    [{ option_id: 'oa' }],
    [{ option_id: 'oa', content: '' }],
    [{ option_id: 'oa', content: 'a' }, { option_id: 'oa', content: 'b' }],
    [{ option_id: 'oa', content: 'a', extra: 1 }],
  ]) {
    assert.equal(refusal(envelope({ proposals: [{ scope: [E1], options }] })).reason, 'INVALID_PROPOSAL');
  }
});

test('S13 — §36 : proposition dupliquée', () => {
  const one = { scope: [E1], options: [{ option_id: 'oa', content: 'a' }] };
  assert.equal(refusal(envelope({ proposals: [one, one] })).reason, 'DUPLICATE_PROPOSAL');
  // Deux propositions réellement distinctes passent : le refus discrimine.
  const other = { scope: [E2], options: [{ option_id: 'oa', content: 'a' }] };
  assert.equal(parseReconciliationProposals(envelope({ proposals: [one, other] }), CTV).outcome, 'VALID');
});

test('S13 — §36 : cible inconnue', () => {
  // Le SERVEUR a choisi la cible. Une enveloppe qui en nomme une autre est
  // refusée, même si cette autre est canonique et pourrait exister.
  assert.equal(refusal(envelope({ target_controversy_id: OTHER })).reason, 'UNKNOWN_TARGET');
  assert.equal(refusal(envelope({ target_controversy_id: 'ctv_1' })).reason, 'UNKNOWN_TARGET');
  assert.equal(refusal(envelope({ target_controversy_id: E1 })).reason, 'UNKNOWN_TARGET');
  assert.equal(refusal(envelope(), OTHER).reason, 'UNKNOWN_TARGET');
});

test('S13 — §36 : périmètre invalide', () => {
  for (const scope of [[], 'ctve_000001', [E1, E1], ['ctve_1'], [CTV], [42]]) {
    assert.equal(
      refusal(envelope({ proposals: [{ scope, options: [{ option_id: 'oa', content: 'a' }] }] })).reason,
      'INVALID_SCOPE',
      JSON.stringify(scope),
    );
  }
});

test('S13 — §36 : options classées', () => {
  for (const field of [
    'rank',
    'ranked',
    'order',
    'position',
    'best',
    'best_option',
    'preferred',
    'preferred_option',
    'recommended',
    'recommended_option',
    'winner',
    'selected',
    'selected_option',
  ]) {
    // Sur l'enveloppe, sur la proposition, et sur l'option : les trois niveaux.
    assert.equal(refusal(envelope({ [field]: 1 })).reason, 'RANKED_OPTIONS', field);
    assert.equal(
      refusal(
        envelope({
          proposals: [{ scope: [E1], options: [{ option_id: 'oa', content: 'a' }], [field]: 1 }],
        }),
      ).reason,
      'RANKED_OPTIONS',
      field,
    );
    assert.equal(
      refusal(
        envelope({
          proposals: [{ scope: [E1], options: [{ option_id: 'oa', content: 'a', [field]: 1 }] }],
        }),
      ).reason,
      'RANKED_OPTIONS',
      field,
    );
  }
});

test('S13 — §36 : champ de score présent', () => {
  for (const field of [
    'score',
    'weight',
    'confidence',
    'probability',
    'priority',
    'severity',
    'certainty',
    'strength',
  ]) {
    assert.equal(refusal(envelope({ [field]: 0.9 })).reason, 'SCORE_FIELD_PRESENT', field);
    assert.equal(
      refusal(
        envelope({
          proposals: [{ scope: [E1], options: [{ option_id: 'oa', content: 'a', [field]: 0.9 }] }],
        }),
      ).reason,
      'SCORE_FIELD_PRESENT',
      field,
    );
  }
});

test('S13 — §36 : effets humains revendiqués, refusés PAR LEUR NOM', () => {
  const claims: readonly (readonly [string, unknown, ProposerOutputRefusalReason])[] = [
    ['closure', { declared: true, statement: 's' }, 'CLOSURE_CLAIMED'],
    ['closure_withdrawal', { declared: true }, 'CLOSURE_WITHDRAWAL_CLAIMED'],
    ['supersedes', [{ superseded_act_id: 'rcn_000001' }], 'SUPERSESSION_CLAIMED'],
    ['content', 'nous décidons', 'HUMAN_DECISION_CLAIMED'],
    ['provenance', { kind: 'DECLARED', statement: 's' }, 'HUMAN_DECISION_CLAIMED'],
    ['responds_to', { proposal_id: 'rcn_000001' }, 'AUTHORITATIVE_EFFECT_CLAIMED'],
    ['semantic_origin', 'HUMAN', 'AUTHORITATIVE_EFFECT_CLAIMED'],
    ['recorded_by', 'HUMAN', 'AUTHORITATIVE_EFFECT_CLAIMED'],
    ['entry_id', 'rcn_000001', 'AUTHORITATIVE_EFFECT_CLAIMED'],
    ['derivation', { method: 'DETERMINISTIC' }, 'AUTHORITATIVE_EFFECT_CLAIMED'],
    ['scope_kind', 'WHOLE', 'AUTHORITATIVE_EFFECT_CLAIMED'],
  ];
  for (const [field, value, reason] of claims) {
    // Le motif rendu NOMME ce qui a été tenté, plutôt que de l'absorber dans un
    // refus générique de champ inconnu.
    assert.equal(refusal(envelope({ [field]: value })).reason, reason, `envelope.${field}`);
    assert.equal(
      refusal(
        envelope({
          proposals: [
            { scope: [E1], options: [{ option_id: 'oa', content: 'a' }], [field]: value },
          ],
        }),
      ).reason,
      reason,
      `proposal.${field}`,
    );
  }
});

// --------------------------------------------------------------------------
// Aucune réparation
// --------------------------------------------------------------------------

test('S13 — aucune réparation silencieuse : un refus est un refus', () => {
  // Chacune de ces sorties pourrait être « sauvée » par une complétion, un
  // renommage, une suppression ou un réordonnancement. Aucune ne l'est.
  const repairable = [
    envelope({ proposals: [{ scope: [E1], options: [{ option_id: 'oa' }] }] }),
    envelope({ proposals: [{ scope: [E1], options: [{ id: 'oa', content: 'a' }] }] }),
    envelope({ proposals: [{ scope: [E1], options: [{ option_id: 'oa', content: 'a', score: 1 }] }] }),
    envelope({ version: 2 }),
  ];
  for (const raw of repairable) {
    const parsed = parseReconciliationProposals(raw, CTV);
    assert.equal(parsed.outcome, 'INVALID');
  }
});

test('S13 — la validation est une validation de REPRÉSENTATION', () => {
  // Un contenu manifestement absurde traverse le parseur : sa forme est valide.
  // Aucun champ, aucune issue et aucun nom ne prétend le contraire.
  const parsed = accepted(
    envelope({
      proposals: [
        { scope: [E1], options: [{ option_id: 'oa', content: '2 + 2 = 5, et la Terre est plate' }] },
      ],
    }),
  );
  if (parsed.outcome !== 'VALID') throw new Error('inatteignable');
  const absurd = parsed.proposals[0]?.options[0];
  assert.ok(absurd, "l'option absurde traverse le parseur");
  assert.equal(absurd.content, '2 + 2 = 5, et la Terre est plate');
  assert.equal('valid' in parsed, false);
  assert.equal('correct' in parsed, false);
  assert.equal('merits' in parsed, false);
});

// --------------------------------------------------------------------------
// L'invite ne demande aucun verdict
// --------------------------------------------------------------------------

test('S13 — l\'invite ne demande ni classement, ni gagnant, ni vérité', () => {
  // V5.1 : l'invite reçoit désormais un troisième argument, le contexte
  // canonique — décision d'autorité du 2026-08-21, qui interdit de demander une
  // proposition à partir d'identifiants opaques seuls. La garantie éprouvée ici
  // est inchangée : la présence du contexte ne doit ajouter aucune tournure
  // impérative demandant un verdict.
  const prompt = buildProposalPrompt(CTV, [E1, E2], 'CONTEXTE CANONIQUE CCR — version 1');
  // Elle décrit le protocole, et nomme les unités soumises.
  assert.ok(prompt.includes(CTV));
  assert.ok(prompt.includes(E1) && prompt.includes(E2));
  assert.ok(prompt.includes('"target_controversy_id"'));
  // Elle ne DEMANDE aucun jugement du fond. L'audit porte sur des tournures
  // impératives : l'invite nomme légitimement « meilleure » ou « score » pour
  // les INTERDIRE, et un audit par simple sous-chaîne confondrait les deux.
  for (const forbidden of [
    'Choisis la meilleure',
    'Choisis l',
    'Classe les',
    'Recommande',
    'Sélectionne',
    'Retiens la',
    'Décide ',
    'Qui a raison',
    'Détermine la vérité',
    'Évalue la qualité',
    'choose the best',
    'rank the',
    'select the winner',
    'decide who',
  ]) {
    assert.equal(prompt.includes(forbidden), false, `l'invite demande : ${forbidden}`);
  }
  // Elle interdit explicitement ce que le parseur refusera.
  assert.ok(prompt.includes('Aucun score'));
  assert.ok(prompt.includes('ne décide rien'));
  assert.ok(prompt.includes("L'ordre des options ne signifie rien"));
});
