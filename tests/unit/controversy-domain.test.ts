/**
 * V3-S1 — fondation de domaine pur.
 *
 * Question de preuve :
 *
 * > **Le domaine V3 rend-il impossible ce que le contrat gelé interdit, et
 * > refuse-t-il déterministement ce qu'il ne peut pas encore vérifier ?**
 *
 * Trois propriétés.
 *
 *  1. **L'interdit est structurel, pas réglementaire.** Aucun champ de statut
 *     n'existe, donc aucune transition n'est représentable.
 *  2. **Une attribution ne se fabrique pas.** `SOURCE` n'a aucun producteur,
 *     `HUMAN` n'invente aucune identité, et une dérivation ne s'attache qu'à
 *     ce qui a réellement dérivé.
 *  3. **Ce qui exige une lecture n'est pas validé ici.** S1 valide la forme ;
 *     la résolution d'une citation contre le contenu canonique appartient à S4.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  AUTHORITY_ACTS,
  CONTROVERSY_ENTRY_KINDS,
  CONTROVERSY_SCHEMA_VERSION,
  DERIVATION_METHODS,
  RECORDING_ACTORS,
  RELATION_ACTS,
  SEMANTIC_ORIGIN_KINDS,
  formatControversyEntryId,
  formatControversyId,
  parseControversyEntrySequence,
  parseControversySequence,
  validateControversyEntry,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';

const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);

function entry(over: Partial<ControversyEntry> = {}): ControversyEntry {
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: E1,
    controversy_id: CTV,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-17T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000010', round: 1 }] },
    ...over,
  } as ControversyEntry;
}

/** Message de refus, pour distinguer un refus attendu d'un crash quelconque. */
function refusal(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail('un refus était attendu');
}

// ==========================================================================
// A. Identités
// ==========================================================================

test('1 · les identités de controverse et d’entrée vivent dans deux espaces disjoints', () => {
  assert.equal(parseControversySequence(CTV), 1);
  assert.equal(parseControversyEntrySequence(E1), 1);

  // Une entrée référence des entrées ; confondre les deux espaces rendrait
  // toute cible ambiguë.
  assert.equal(parseControversySequence(E1), undefined);
  assert.equal(parseControversyEntrySequence(CTV), undefined);

  assert.throws(() => formatControversyId(0));
  assert.throws(() => formatControversyEntryId(-1));
});

// ==========================================================================
// B. Origine sémantique — la dérivation suit l'origine, jamais l'inverse
// ==========================================================================

test('2 · `derivation` est requise si l’origine est CCR, et interdite sinon', () => {
  // Requise.
  const missing = refusal(() =>
    validateControversyEntry(entry({ semantic_origin: { kind: 'CCR' }, recorded_by: 'CCR' })),
  );
  assert.match(missing, /derivation est requise/);

  // Interdite pour un fait humain : lui en attacher une attribuerait un
  // mécanisme à qui n'a rien dérivé.
  const forbidden = refusal(() =>
    validateControversyEntry(
      entry({ derivation: { method: 'DETERMINISTIC_LOCAL', inputs: [] } }),
    ),
  );
  assert.match(forbidden, /derivation est interdite/);

  // Acceptée lorsque les deux coïncident.
  const ok = validateControversyEntry(
    entry({
      semantic_origin: { kind: 'CCR' },
      recorded_by: 'CCR',
      derivation: { method: 'DETERMINISTIC_LOCAL', inputs: ['evt_000010'] },
    }),
  );
  assert.equal(ok.derivation?.method, 'DETERMINISTIC_LOCAL');
});

test('3 · `MODEL_ASSISTED` exige `invocation_id` ; `DETERMINISTIC_LOCAL` le refuse', () => {
  const base = { semantic_origin: { kind: 'CCR' } as const, recorded_by: 'CCR' as const };

  const missing = refusal(() =>
    validateControversyEntry(entry({ ...base, derivation: { method: 'MODEL_ASSISTED', inputs: [] } })),
  );
  assert.match(missing, /invocation_id est requis/);

  const forbidden = refusal(() =>
    validateControversyEntry(
      entry({
        ...base,
        derivation: { method: 'DETERMINISTIC_LOCAL', invocation_id: 'inv_000001', inputs: [] },
      }),
    ),
  );
  assert.match(forbidden, /invocation_id est interdit/);

  const ok = validateControversyEntry(
    entry({ ...base, derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000001', inputs: [] } }),
  );
  assert.equal(ok.derivation?.invocation_id, 'inv_000001');
});

test('4 · `actor` suit ce que l’architecture sait identifier — et rien de plus', () => {
  // SOURCE porte le slot : c'est la provenance métier canonique.
  const source = validateControversyEntry(
    entry({ semantic_origin: { kind: 'SOURCE', actor: 'challenger' } }),
  );
  assert.equal(source.semantic_origin.actor, 'challenger');

  // SOURCE sans slot n'a pas de provenance : refus.
  assert.match(
    refusal(() => validateControversyEntry(entry({ semantic_origin: { kind: 'SOURCE' } }))),
    /doit être un slot d’expert|doit être un slot d'expert/,
  );

  // HUMAN ne porte AUCUNE identité : aucune identité humaine durable n'existe
  // dans CCR, et le type ne doit pas en promettre une.
  assert.match(
    refusal(() =>
      validateControversyEntry(
        entry({ semantic_origin: { kind: 'HUMAN', actor: 'author' } as never }),
      ),
    ),
    /actor est interdit/,
  );

  // CCR non plus : son mécanisme vit dans `derivation`.
  assert.match(
    refusal(() =>
      validateControversyEntry(
        entry({
          semantic_origin: { kind: 'CCR', actor: 'author' } as never,
          recorded_by: 'CCR',
          derivation: { method: 'DETERMINISTIC_LOCAL', inputs: [] },
        }),
      ),
    ),
    /actor est interdit/,
  );
});

test('5 · une transcription humaine est HUMAN à propos d’une source, jamais SOURCE', () => {
  const transcription = validateControversyEntry(
    entry({
      semantic_origin: { kind: 'HUMAN', about_actor: 'challenger' },
      anchors: {
        provenance: [{ event_id: 'evt_000010', round: 1, expert_slot_id: 'challenger' }],
        textual: { event_id: 'evt_000010', quoted_text: 'je conteste X', occurrence: 1 },
      },
    }),
  );

  assert.equal(transcription.semantic_origin.kind, 'HUMAN');
  assert.equal(transcription.semantic_origin.about_actor, 'challenger');
  // L'ancrage rend la transcription auditable ; il ne la rend pas
  // source-authored. Le type ne laisse aucun chemin vers SOURCE.
  assert.equal(transcription.semantic_origin.actor, undefined);

  // `about_actor` n'a de sens que pour une sémantique humaine.
  for (const kind of ['SOURCE', 'CCR'] as const) {
    assert.match(
      refusal(() =>
        validateControversyEntry(
          entry({
            semantic_origin: { kind, actor: 'author', about_actor: 'challenger' } as never,
            recorded_by: 'CCR',
            derivation: { method: 'DETERMINISTIC_LOCAL', inputs: [] },
          }),
        ),
      ),
      /about_actor n’est admis|about_actor n'est admis|actor est interdit/,
    );
  }
});

// ==========================================================================
// C. Ancrages — cardinalité et forme
// ==========================================================================

test('6 · au moins un ancrage de provenance ; au plus un textuel, au plus un sémantique', () => {
  assert.match(
    refusal(() => validateControversyEntry(entry({ anchors: { provenance: [] } }))),
    /au moins un ancrage de provenance/,
  );

  // La cardinalité maximale est portée par la FORME : `textual` et `semantic`
  // sont des champs uniques. Il n'existe aucun tableau à borner.
  const ok = validateControversyEntry(
    entry({
      anchors: {
        provenance: [{ event_id: 'evt_000010', round: 1 }, { event_id: 'evt_000011', round: 2 }],
        textual: { event_id: 'evt_000010', quoted_text: 'un extrait', occurrence: 2 },
        semantic: { text: 'X est contestable', semantic_origin: { kind: 'HUMAN' } },
      },
    }),
  );
  assert.equal(ok.anchors.provenance.length, 2);
  assert.equal(ok.anchors.textual?.occurrence, 2);
});

test('7 · une citation vide et une occurrence non positive sont refusées', () => {
  const empty = refusal(() =>
    validateControversyEntry(
      entry({
        anchors: {
          provenance: [{ event_id: 'evt_000010', round: 1 }],
          textual: { event_id: 'evt_000010', quoted_text: '', occurrence: 1 },
        },
      }),
    ),
  );
  assert.match(empty, /quoted_text/);

  for (const occurrence of [0, -1, 1.5]) {
    assert.match(
      refusal(() =>
        validateControversyEntry(
          entry({
            anchors: {
              provenance: [{ event_id: 'evt_000010', round: 1 }],
              textual: { event_id: 'evt_000010', quoted_text: 'x', occurrence },
            },
          }),
        ),
      ),
      /occurrence/,
    );
  }
});

// ==========================================================================
// D. Actes et charges
// ==========================================================================

test('8 · les actes sont des unions fermées, et la charge suit le kind', () => {
  assert.deepEqual([...RELATION_ACTS], ['CONTESTS', 'REFORMULATES', 'WITHDRAWS']);
  assert.deepEqual([...AUTHORITY_ACTS], ['ARBITRATION', 'CONFIRM_RELATION', 'CONTEST_RELATION']);

  const relation = validateControversyEntry(
    entry({
      kind: 'RELATION_RECORDED',
      relation: { from_entry_id: E1, to_entry_id: E2, act: 'WITHDRAWS' },
    }),
  );
  assert.equal(relation.relation?.act, 'WITHDRAWS');

  // Une relation qui se vise elle-même ne dit rien — contrainte purement
  // locale, donc validable sans journal.
  assert.match(
    refusal(() =>
      validateControversyEntry(
        entry({
          kind: 'RELATION_RECORDED',
          relation: { from_entry_id: E1, to_entry_id: E1, act: 'CONTESTS' },
        }),
      ),
    ),
    /sa propre origine/,
  );

  // Une charge sans son kind, et un kind sans sa charge, sont tous deux refusés.
  assert.match(
    refusal(() =>
      validateControversyEntry(
        entry({ relation: { from_entry_id: E1, to_entry_id: E2, act: 'CONTESTS' } }),
      ),
    ),
    /relation est interdite/,
  );
  assert.match(
    refusal(() => validateControversyEntry(entry({ kind: 'RELATION_RECORDED' }))),
    /relation est requise/,
  );
});

test('9 · confirmation et contestation d’inférence sont représentables, et humaines', () => {
  for (const act of ['CONFIRM_RELATION', 'CONTEST_RELATION'] as const) {
    const authority = validateControversyEntry(
      entry({
        kind: 'HUMAN_AUTHORITY_RECORDED',
        semantic_origin: { kind: 'HUMAN' },
        authority: { act, target_entry_id: E2 },
      }),
    );
    assert.equal(authority.authority?.act, act);
    assert.equal(authority.authority?.target_entry_id, E2);
  }

  // Une autorité humaine ne peut pas venir d'ailleurs que d'un humain.
  assert.match(
    refusal(() =>
      validateControversyEntry(
        entry({
          kind: 'HUMAN_AUTHORITY_RECORDED',
          semantic_origin: { kind: 'CCR' },
          recorded_by: 'CCR',
          derivation: { method: 'DETERMINISTIC_LOCAL', inputs: [] },
          authority: { act: 'ARBITRATION', scope: 'le point Y' },
        }),
      ),
    ),
    /origine sémantique HUMAN/,
  );
});

test('10 · kind, recorded_by et schema_version inconnus sont refusés', () => {
  assert.deepEqual([...CONTROVERSY_ENTRY_KINDS], [
    'CONTROVERSY_RECORDED',
    'ASSERTION_RECORDED',
    'RELATION_RECORDED',
    'NATURE_RECORDED',
    'HUMAN_AUTHORITY_RECORDED',
  ]);
  assert.deepEqual([...RECORDING_ACTORS], ['HUMAN', 'CCR']);
  assert.deepEqual([...SEMANTIC_ORIGIN_KINDS], ['SOURCE', 'HUMAN', 'CCR']);
  assert.deepEqual([...DERIVATION_METHODS], ['DETERMINISTIC_LOCAL', 'MODEL_ASSISTED']);

  assert.match(refusal(() => validateControversyEntry(entry({ kind: 'CONTROVERSY_OPENED' as never }))), /kind inconnu/);
  assert.match(refusal(() => validateControversyEntry(entry({ recorded_by: 'EXPERT' as never }))), /recorded_by inconnu/);
  assert.match(refusal(() => validateControversyEntry(entry({ schema_version: 2 }))), /schema_version/);
});

// ==========================================================================
// E. Gardes de source — ce qui doit rester impossible
// ==========================================================================

/** Code exécutable du module de domaine, commentaires retirés. */
async function executableDomain(): Promise<string> {
  const raw = await readFile(new URL('../../src/core/controversy.ts', import.meta.url), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

test('11 · aucun champ de statut, de score ou de cycle de vie n’existe dans le domaine', async () => {
  const code = await executableDomain();

  // Un interdit tenu par construction : ces identifiants ne doivent apparaître
  // dans aucune forme, sinon une projection pourrait un jour les écrire.
  for (const forbidden of [
    'status', 'lifecycle', 'position_id', 'PositionId',
    'confidence', 'score', 'closure', 'winner',
    'CONVERGED', 'RESOLVED', 'INACTIVE', 'superseded_as_state',
  ]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `le domaine V3 ne doit contenir aucun \`${forbidden}\``,
    );
  }
});

test('12 · aucun constructeur ne produit une origine SOURCE', async () => {
  const code = await executableDomain();

  // `SOURCE` est une forme du modèle, pas une capacité : V3 initial n'a aucun
  // producteur structuré, et le protocole expert reste DEFERRED.
  assert.equal(code.includes("'SOURCE'"), true, 'la catégorie existe');
  for (const producer of [
    'recordSourceAssertion', 'fromTranscription', 'toSource', 'asSource', 'promoteToSource',
  ]) {
    assert.equal(code.includes(producer), false, `aucun producteur \`${producer}\` ne doit exister`);
  }

  // Le seul chemin qui mentionne SOURCE est une VALIDATION, jamais une
  // fabrication : il exige un slot fourni par l'appelant.
  const occurrences = code.split("'SOURCE'").length - 1;
  assert.equal(occurrences, 2, 'SOURCE apparaît dans son union et dans sa validation, nulle part ailleurs');
});

test('13 · le domaine ne fait aucune entrée-sortie', async () => {
  const code = await executableDomain();
  for (const io of ['node:fs', 'readFile', 'writeFile', 'node:path', 'Date.now', 'new Date']) {
    assert.equal(code.includes(io), false, `le domaine V3 ne doit pas employer \`${io}\``);
  }
});
