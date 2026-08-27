/**
 * V4 · S7-A — parseur strict de sortie modèle.
 *
 * Question de preuve :
 *
 * > **Une sortie de fournisseur non fiable peut-elle acquérir une autorité que
 * > personne ne lui a donnée, simplement parce qu'elle est analysable ?**
 *
 * Quatre propriétés.
 *
 *  1. **Le schéma est fermé.** Toute clé hors protocole rend la sortie invalide,
 *     qu'elle porte un jugement (`confidence`, `score`) ou une autorité du
 *     serveur (`entry_id`, `recorded_by`). Jamais ignorée.
 *  2. **`VALID_ZERO` et `INVALID_OUTPUT` sont structurellement distincts.**
 *     L'union discriminée interdit qu'un refus s'effondre en liste vide.
 *  3. **La forme n'est pas l'existence.** Un identifiant canonique désignant un
 *     objet inexistant traverse le parseur ; c'est la phase C qui le refusera,
 *     et ce refus-là s'appelle autrement.
 *  4. **Tout ou rien.** Une proposition invalide parmi `N` rend le lot entier
 *     invalide ; aucune n'est retirée en silence.
 *
 * Le défaut que ce fichier existe pour empêcher, nommément : qu'un parseur
 * « tolérant » — clôtures Markdown retirées, champ inconnu ignoré, doublon
 * dédupliqué, sortie tronquée à la borne — rende un lot que le modèle n'a pas
 * produit, en le présentant comme sa réponse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ADDUCER_OUTPUT_REFUSAL_REASONS,
  ADDUCTION_PROPOSAL_VERSION,
  MAX_ADDUCER_OUTPUT_BYTES,
  SUPPORTED_ADDUCTION_PROPOSAL_VERSIONS,
  parseAdductionProposals,
} from '../../src/services/evidence-adducer.ts';
import type { AdductionProposalParse } from '../../src/services/evidence-adducer.ts';
import { MAX_INLINE_TEXT_BYTES, ORIENTATIONS } from '../../src/core/evidence.ts';
import { utf8ByteLength } from '../../src/services/transfer.ts';

// --------------------------------------------------------------------------
// Fabriques — aucun champ n'est écrit à la main deux fois.
// --------------------------------------------------------------------------

const MAT = 'mat_000001';
const CTVE = 'ctve_000001';

function envelope(proposals: readonly unknown[], version: unknown = ADDUCTION_PROPOSAL_VERSION): string {
  return JSON.stringify({ adduction_proposal_version: version, proposals });
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { material_id: MAT, target_entry_id: CTVE, orientation: 'NONE', ...overrides };
}

/** Refus attendu — motif et position exigés par le contrat §17.5. */
function refused(result: AdductionProposalParse, reason: string, atPrefix?: string): void {
  assert.equal(result.outcome, 'INVALID');
  if (result.outcome !== 'INVALID') return;
  assert.equal(result.reason, reason);
  assert.ok(result.at.length > 0, 'une position est exigée');
  if (atPrefix !== undefined) {
    assert.ok(result.at.startsWith(atPrefix), `position « ${result.at} » sous « ${atPrefix} »`);
  }
}

/** Succès attendu, avec le nombre exact de propositions rendues. */
function accepted(result: AdductionProposalParse, count: number): void {
  assert.equal(result.outcome, 'VALID');
  if (result.outcome !== 'VALID') return;
  assert.equal(result.proposals.length, count);
  assert.equal(result.adduction_proposal_version, ADDUCTION_PROPOSAL_VERSION);
}

/** Source exécutable : commentaires retirés, jamais la prose. */
async function executable(relative: string): Promise<string> {
  const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

// ==========================================================================
// A. Succès — VALID_ZERO et propositions bien formées
// ==========================================================================

test('1 · T1 — VALID_ZERO est un SUCCÈS, structurellement distinct d’un refus', () => {
  const result = parseAdductionProposals(envelope([]));
  accepted(result, 0);

  // La distinction ne repose sur aucune convention d'appelant : un refus ne
  // porte PAS de champ `proposals`, donc aucune lecture ne peut le confondre
  // avec un lot vide. C'est ce que le contrat §19 appelle structurel.
  assert.ok('proposals' in result);
  const rejected = parseAdductionProposals('{');
  assert.equal('proposals' in rejected, false, 'un refus n’a pas de liste vide');
  assert.equal(rejected.outcome, 'INVALID');

  // Et VALID_ZERO ne dit rien du monde : aucun champ ne prétend le contraire.
  assert.deepEqual(Object.keys(result).sort(), ['adduction_proposal_version', 'outcome', 'proposals']);
});

test('2 · T2/T3/T4 — les trois orientations du domaine, et elles seules', () => {
  for (const orientation of ORIENTATIONS) {
    const result = parseAdductionProposals(envelope([proposal({ orientation })]));
    accepted(result, 1);
    if (result.outcome !== 'VALID') continue;
    assert.deepEqual(result.proposals[0], {
      material_id: MAT,
      target_entry_id: CTVE,
      orientation,
    });
  }

  // L'union est celle du domaine, importée — jamais une copie locale.
  assert.deepEqual([...ORIENTATIONS], ['NONE', 'SUPPORTS', 'OBJECTS_TO']);
});

test('3 · T5 — plusieurs propositions, dans l’ordre produit, jamais retriées', () => {
  const raw = envelope([
    proposal({ material_id: 'mat_000003', orientation: 'OBJECTS_TO' }),
    proposal({ material_id: 'mat_000001', orientation: 'NONE' }),
    proposal({ material_id: 'mat_000002', orientation: 'SUPPORTS' }),
  ]);
  const result = parseAdductionProposals(raw);
  accepted(result, 3);
  if (result.outcome !== 'VALID') return;
  assert.deepEqual(
    result.proposals.map((p) => p.material_id),
    ['mat_000003', 'mat_000001', 'mat_000002'],
    'l’ordre de production est préservé',
  );
});

// ==========================================================================
// B. Syntaxe et enveloppe
// ==========================================================================

test('4 · T6 — JSON invalide', () => {
  for (const raw of ['', '   ', '{', '{"a":}', 'null,', '{"a":1,}', "{'a':1}", '{"a":1}garbage']) {
    refused(parseAdductionProposals(raw), 'INVALID_JSON', 'output');
  }
});

test('5 · T7 — racine de mauvais type', () => {
  for (const raw of ['[]', '"texte"', '42', 'true', 'null', '[{"material_id":"mat_000001"}]']) {
    refused(parseAdductionProposals(raw), 'INVALID_OUTPUT_SHAPE', 'output');
  }
});

test('6 · T8 — version absente, inconnue ou de mauvais type', () => {
  assert.deepEqual([...SUPPORTED_ADDUCTION_PROPOSAL_VERSIONS], [ADDUCTION_PROPOSAL_VERSION]);
  assert.equal(ADDUCTION_PROPOSAL_VERSION, 1);

  for (const version of [0, 2, 99, -1, 1.5, '1', null, true]) {
    refused(
      parseAdductionProposals(envelope([], version)),
      'UNSUPPORTED_OUTPUT_VERSION',
      'output.adduction_proposal_version',
    );
  }
  // Absente : la clé manque entièrement.
  refused(
    parseAdductionProposals(JSON.stringify({ proposals: [] })),
    'UNSUPPORTED_OUTPUT_VERSION',
    'output.adduction_proposal_version',
  );
  // `proposals` absente ou de mauvais type est une autre faute, nommée autrement.
  refused(
    parseAdductionProposals(JSON.stringify({ adduction_proposal_version: 1 })),
    'INVALID_OUTPUT_SHAPE',
    'output.proposals',
  );
  refused(
    parseAdductionProposals(JSON.stringify({ adduction_proposal_version: 1, proposals: {} })),
    'INVALID_OUTPUT_SHAPE',
    'output.proposals',
  );
});

test('7 · T9 — clé inconnue à la racine', () => {
  for (const key of ['confidence', 'provider', 'model', 'usage', 'cost', 'run_id', 'note', '__proto__']) {
    const raw = JSON.stringify({
      adduction_proposal_version: ADDUCTION_PROPOSAL_VERSION,
      proposals: [],
      [key]: 1,
    });
    refused(parseAdductionProposals(raw), 'INVALID_OUTPUT_SHAPE', 'output.');
  }
});

// ==========================================================================
// C. Schéma fermé — la frontière de sécurité de S7-A
// ==========================================================================

/**
 * Le test nommé qu'exige le plan §10 pour la preuve de mutation nº 4.
 *
 * Les sept mots ci-dessous sont ceux du plan, dans son ordre. Ils ne sont
 * refusés par **aucune liste noire** : ils tombent parce qu'ils sont hors d'un
 * schéma fermé. Les nommer ici documente la frontière, sans la déplacer.
 */
test('8 · T10/T11/T12/T13/T14 — confidence · score · weight · reliability · provider · model · cost', () => {
  const forbidden = [
    'confidence',
    'score',
    'weight',
    'reliability',
    'provider',
    'model',
    'cost',
    // Le reste de la liste fermée du contrat §19, au même titre.
    'credibility',
    'strength',
    'sufficiency',
    'truth',
    'probability',
    'winner',
    'closure',
    'quality',
    'tokens',
    'usage',
  ];

  for (const key of forbidden) {
    const raw = envelope([proposal({ [key]: 0.99 })]);
    refused(parseAdductionProposals(raw), 'INVALID_PROPOSAL', 'output.proposals[0].');

    // Et la valeur n'a aucune importance : c'est la CLÉ qui est hors schéma.
    for (const value of [0, 1, 'high', null, false, {}, []]) {
      const other = envelope([proposal({ [key]: value })]);
      refused(parseAdductionProposals(other), 'INVALID_PROPOSAL', 'output.proposals[0].');
    }
  }
});

test('9 · T28 — aucune autorité canonique ne peut être forgée par le fournisseur', () => {
  // Ces champs sont attribués par le serveur, après revalidation. Le protocole
  // ne les contient pas : ils tombent donc comme clés inconnues, au même titre
  // qu'un champ de score. C'est la même frontière, pas une seconde règle.
  const forged = [
    'entry_id',
    'schema_version',
    'recorded_at',
    'recorded_by',
    'semantic_origin',
    'derivation',
    'invocation_id',
    'evidence_revision',
    'kind',
    'submitted_by',
  ];
  for (const key of forged) {
    refused(
      parseAdductionProposals(envelope([proposal({ [key]: 'CCR' })])),
      'INVALID_PROPOSAL',
      'output.proposals[0].',
    );
  }

  // Réciproque structurelle : une proposition RENDUE ne porte aucun de ces
  // champs, même quand la sortie était valide.
  const result = parseAdductionProposals(envelope([proposal()]));
  accepted(result, 1);
  if (result.outcome !== 'VALID') return;
  const keys = Object.keys(result.proposals[0] ?? {});
  assert.deepEqual(keys.sort(), ['material_id', 'orientation', 'target_entry_id']);
  for (const key of [...forged, 'confidence', 'score', 'provider', 'model', 'cost']) {
    assert.equal(keys.includes(key), false, `proposition rendue sans « ${key} »`);
  }
});

test('10 · T10 — toute clé inconnue de proposition, même anodine', () => {
  for (const key of ['reason', 'comment', 'rank', 'id', 'target', 'kind_of_target', '__proto__']) {
    refused(
      parseAdductionProposals(envelope([proposal({ [key]: 'x' })])),
      'INVALID_PROPOSAL',
      'output.proposals[0].',
    );
  }
  // Et à l'intérieur de la citation, qui est fermée elle aussi.
  refused(
    parseAdductionProposals(
      envelope([proposal({ citation: { quoted_text: 'x', occurrence: 1, confidence: 1 } })]),
    ),
    'INVALID_PROPOSAL',
    'output.proposals[0].citation.',
  );
});

// ==========================================================================
// D. Orientation — V8
// ==========================================================================

test('11 · T15/T16 — orientation hors union, et orientation absente', () => {
  for (const orientation of [
    'NEUTRAL', 'SUPPORT', 'OBJECT', 'AGAINST', 'TRUE', 'FALSE',
    'none', 'supports', 'objects_to', 'OBJECTS-TO', '', 1, null, true,
  ]) {
    refused(
      parseAdductionProposals(envelope([proposal({ orientation })])),
      'INVALID_PROPOSAL',
      'output.proposals[0].orientation',
    );
  }

  // Absente : le protocole la rend obligatoire, et rien ne la remplace. Une
  // valeur inconnue n'est JAMAIS ramenée à NONE — un silence du modèle
  // deviendrait sinon une position neutre que personne n'a prise.
  const withoutOrientation: Record<string, unknown> = { material_id: MAT, target_entry_id: CTVE };
  refused(
    parseAdductionProposals(envelope([withoutOrientation])),
    'INVALID_PROPOSAL',
    'output.proposals[0].orientation',
  );
});

// ==========================================================================
// E. Identifiants — V1 et V3, forme seulement
// ==========================================================================

test('12 · T17 — forme non canonique refusée, dans les deux champs', () => {
  const badMaterials = [
    'mat_1', 'mat_00001', 'mat_0000001', 'mat_000000', 'MAT_000001', 'mat000001',
    ' mat_000001', 'mat_000001 ', 'ctve_000001', 'add_000001', 'ctv_000001', '', 1, null, {},
  ];
  for (const material_id of badMaterials) {
    refused(
      parseAdductionProposals(envelope([proposal({ material_id })])),
      'INVALID_PROPOSAL',
      'output.proposals[0].material_id',
    );
  }

  const badTargets = [
    'ctve_1', 'ctve_00001', 'ctve_0000001', 'ctve_000000', 'CTVE_000001',
    // `ctv_` désigne une CONTROVERSE, jamais une cible : viser l'entrée
    // d'ouverture vise cette entrée, jamais l'agrégat.
    'ctv_000001', 'mat_000001', 'add_000001', '', 0, null, [],
  ];
  for (const target_entry_id of badTargets) {
    refused(
      parseAdductionProposals(envelope([proposal({ target_entry_id })])),
      'INVALID_PROPOSAL',
      'output.proposals[0].target_entry_id',
    );
  }
});

test('13 · T18 — canonique mais inexistant TRAVERSE le parseur', () => {
  // Une séquence qu'aucun run ne portera jamais. Le parseur l'accepte, et c'est
  // exactement le contrat : `V2`/`V4` — la résolution — appartiennent à la
  // phase C, contre le snapshot courant. Les avancer ici exigerait de lire un
  // run, et transformerait un `REVALIDATION_REFUSED` en `INVALID_OUTPUT`.
  const raw = envelope([
    proposal({ material_id: 'mat_999999', target_entry_id: 'ctve_888888', orientation: 'SUPPORTS' }),
  ]);
  const result = parseAdductionProposals(raw);
  accepted(result, 1);
  if (result.outcome !== 'VALID') return;
  assert.equal(result.proposals[0]?.material_id, 'mat_999999');

  // Ce que le succès ci-dessus établit, et ce qu'il n'établit pas :
  //   FORME VALIDE  ≠  L'OBJET EXISTE.
});

// ==========================================================================
// F. Citation — forme seulement
// ==========================================================================

test('14 · T19 — citation de forme valide, texte multioctet compris', () => {
  for (const quoted_text of ['a', 'une phrase citée', '😀 émoji', 'ligne\nligne', '"guillemets"']) {
    const result = parseAdductionProposals(
      envelope([proposal({ citation: { quoted_text, occurrence: 3 } })]),
    );
    accepted(result, 1);
    if (result.outcome !== 'VALID') continue;
    assert.deepEqual(result.proposals[0]?.citation, { quoted_text, occurrence: 3 });
  }
});

test('15 · T20 — occurrence hors convention, et citation incomplète', () => {
  for (const occurrence of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '1', null, true]) {
    refused(
      parseAdductionProposals(envelope([proposal({ citation: { quoted_text: 'x', occurrence } })])),
      'INVALID_PROPOSAL',
      'output.proposals[0].citation.occurrence',
    );
  }

  // Incomplète : les deux champs sont exigés ensemble. `quoted_text` sans rang
  // ne désigne rien de décidable ; un rang sans texte ne désigne rien du tout.
  refused(
    parseAdductionProposals(envelope([proposal({ citation: { quoted_text: 'x' } })])),
    'INVALID_PROPOSAL',
    'output.proposals[0].citation.occurrence',
  );
  refused(
    parseAdductionProposals(envelope([proposal({ citation: { occurrence: 1 } })])),
    'INVALID_PROPOSAL',
    'output.proposals[0].citation.quoted_text',
  );
  // Texte vide, mauvais type, ou citation qui n'est pas un objet.
  for (const quoted_text of ['', 1, null, [], {}]) {
    refused(
      parseAdductionProposals(envelope([proposal({ citation: { quoted_text, occurrence: 1 } })])),
      'INVALID_PROPOSAL',
      'output.proposals[0].citation.quoted_text',
    );
  }
  for (const citation of [null, 'texte', 1, []]) {
    refused(
      parseAdductionProposals(envelope([proposal({ citation })])),
      'INVALID_PROPOSAL',
      'output.proposals[0].citation',
    );
  }

  // Borne du domaine, importée : une citation ne peut pas être plus longue que
  // le texte le plus long que CCR accepte de détenir.
  const tooLong = 'a'.repeat(MAX_INLINE_TEXT_BYTES + 1);
  refused(
    parseAdductionProposals(envelope([proposal({ citation: { quoted_text: tooLong, occurrence: 1 } })])),
    'INVALID_PROPOSAL',
    'output.proposals[0].citation.quoted_text',
  );
});

test('16 · T21 — la citation n’est jamais RÉSOLUE ici', () => {
  // Un texte qui n'existe dans aucun matériau, à un rang absurdement élevé. Le
  // parseur l'accepte : il établit CITATION SHAPE VALID, et rien d'autre.
  // `V9` (matériau détenu) et `V10` (texte présent au rang) sont des contrôles
  // de phase C ; ils exigent le matériau, que ce module ne lit pas.
  const result = parseAdductionProposals(
    envelope([
      proposal({
        citation: { quoted_text: 'phrase qui n’existe dans aucun matériau', occurrence: 4096 },
      }),
    ]),
  );
  accepted(result, 1);
  if (result.outcome !== 'VALID') return;
  assert.equal(result.proposals[0]?.citation?.occurrence, 4096);

  // Aucun décalage, aucune plage, aucune correspondance de ligne n'est produite.
  assert.deepEqual(Object.keys(result.proposals[0]?.citation ?? {}).sort(), [
    'occurrence',
    'quoted_text',
  ]);
});

// ==========================================================================
// G. V11 — doublon dans le lot
// ==========================================================================

test('17 · T22 — deux propositions identiques invalident le LOT', () => {
  const raw = envelope([proposal({ orientation: 'SUPPORTS' }), proposal({ orientation: 'SUPPORTS' })]);
  // Le motif nomme le lot, pas la proposition : une proposition en double n'est
  // pas malformée, c'est la réponse qui l'est (contrat §20.2).
  refused(parseAdductionProposals(raw), 'DUPLICATE_PROPOSAL', 'output.proposals[1]');

  // Citation comprise dans l'identité exacte.
  const withCitation = { quoted_text: 'même', occurrence: 2 };
  refused(
    parseAdductionProposals(
      envelope([proposal({ citation: withCitation }), proposal({ citation: withCitation })]),
    ),
    'DUPLICATE_PROPOSAL',
    'output.proposals[1]',
  );

  // Le doublon n'est JAMAIS retiré en silence : la sortie ne rend pas un lot
  // dédupliqué de taille 1. C'est ce que « invalide le lot » signifie.
  const deduped = parseAdductionProposals(raw);
  assert.equal(deduped.outcome, 'INVALID');
});

test('18 · T22 — une seule différence suffit : aucune fusion, aucune similarité', () => {
  // Quatre lots dont les deux propositions diffèrent par UN champ chacun.
  const distincts: readonly (readonly [string, unknown, unknown])[] = [
    ['material_id', MAT, 'mat_000002'],
    ['target_entry_id', CTVE, 'ctve_000002'],
    ['orientation', 'SUPPORTS', 'OBJECTS_TO'],
    ['citation', { quoted_text: 'a', occurrence: 1 }, { quoted_text: 'a', occurrence: 2 }],
  ];
  for (const [field, left, right] of distincts) {
    const result = parseAdductionProposals(
      envelope([proposal({ [field]: left }), proposal({ [field]: right })]),
    );
    accepted(result, 2);
  }

  // Deux propositions dont l'une seule porte une citation sont distinctes.
  accepted(
    parseAdductionProposals(
      envelope([proposal(), proposal({ citation: { quoted_text: 'a', occurrence: 1 } })]),
    ),
    2,
  );

  // Aucune similarité sémantique, aucune normalisation : ces deux citations
  // sont « les mêmes » pour un lecteur humain, et distinctes pour CCR, qui ne
  // possède aucune autorité d'équivalence (contrat §20.1).
  accepted(
    parseAdductionProposals(
      envelope([
        proposal({ citation: { quoted_text: 'Texte', occurrence: 1 } }),
        proposal({ citation: { quoted_text: 'texte', occurrence: 1 } }),
      ]),
    ),
    2,
  );
});

// ==========================================================================
// H. Tout ou rien
// ==========================================================================

test('19 · T23 — une invalide parmi N rend le lot entier invalide', () => {
  const raw = envelope([
    proposal({ material_id: 'mat_000001' }),
    proposal({ material_id: 'mat_000002' }),
    proposal({ material_id: 'mat_000003', confidence: 0.9 }),
    proposal({ material_id: 'mat_000004' }),
  ]);
  const result = parseAdductionProposals(raw);
  refused(result, 'INVALID_PROPOSAL', 'output.proposals[2].');

  // Aucune sortie ne rend N-1 propositions valides et n'en tait une.
  assert.equal('proposals' in result, false, 'aucun lot amputé n’est rendu');

  // Même chose quand la fautive est la dernière, et quand c'est un doublon.
  refused(
    parseAdductionProposals(
      envelope([proposal({ material_id: 'mat_000001' }), proposal({ orientation: 'NEUTRAL' })]),
    ),
    'INVALID_PROPOSAL',
    'output.proposals[1].orientation',
  );
  const withDuplicate = parseAdductionProposals(
    envelope([proposal({ material_id: 'mat_000001' }), proposal(), proposal()]),
  );
  assert.equal('proposals' in withDuplicate, false);
});

// ==========================================================================
// I. Borne brute — avant JSON.parse
// ==========================================================================

const HEAD = '{"adduction_proposal_version":1,"proposals":[]';

/** Payload valide, rembourré d'espaces JSON, d'une taille exacte en octets. */
function padded(bytes: number): string {
  return HEAD + ' '.repeat(bytes - HEAD.length - 1) + '}';
}

test('20 · T24 — à la limite EXACTE, la sortie est acceptée', () => {
  assert.equal(MAX_ADDUCER_OUTPUT_BYTES, 1024 * 1024);
  const raw = padded(MAX_ADDUCER_OUTPUT_BYTES);
  assert.equal(utf8ByteLength(raw), MAX_ADDUCER_OUTPUT_BYTES);
  // Le contrat dit « au-delà, INVALID_OUTPUT ». La limite exacte est en deçà.
  accepted(parseAdductionProposals(raw), 0);
});

test('21 · T25 — à la limite + 1, refus AVANT JSON.parse', () => {
  const raw = `${padded(MAX_ADDUCER_OUTPUT_BYTES)} `;
  assert.equal(utf8ByteLength(raw), MAX_ADDUCER_OUTPUT_BYTES + 1);
  refused(parseAdductionProposals(raw), 'OUTPUT_TOO_LARGE', 'output');

  // Preuve d'ORDRE, sans instrumentation : un payload hors borne qui n'est même
  // pas du JSON rend OUTPUT_TOO_LARGE, jamais INVALID_JSON. S'il avait atteint
  // l'analyseur, le motif serait l'autre.
  const garbage = '{'.repeat(MAX_ADDUCER_OUTPUT_BYTES + 1);
  refused(parseAdductionProposals(garbage), 'OUTPUT_TOO_LARGE', 'output');

  // Preuve décisive : `JSON.parse` est rendu explosif le temps d'un appel.
  const original = JSON.parse;
  try {
    JSON.parse = () => {
      throw new Error('JSON.parse ne doit jamais être atteint hors borne');
    };
    refused(parseAdductionProposals(raw), 'OUTPUT_TOO_LARGE', 'output');
  } finally {
    JSON.parse = original;
  }

  // Et rien n'est tronqué : la sortie hors borne n'est pas analysée « en partie ».
  const result = parseAdductionProposals(raw);
  assert.equal('proposals' in result, false);
});

test('22 · T26 — la métrique est l’OCTET UTF-8, jamais le caractère', () => {
  // 300 000 émojis : 600 000 unités UTF-16, 1 200 000 octets. Sous la borne si
  // l'on comptait des caractères ; au-dessus si l'on compte des octets.
  const raw = '😀'.repeat(300_000);
  assert.ok(raw.length < MAX_ADDUCER_OUTPUT_BYTES, 'sous la borne en unités UTF-16');
  assert.ok(utf8ByteLength(raw) > MAX_ADDUCER_OUTPUT_BYTES, 'au-dessus en octets');

  // Une métrique en caractères aurait laissé passer le payload jusqu'à
  // `JSON.parse`, et le motif rendu serait INVALID_JSON.
  refused(parseAdductionProposals(raw), 'OUTPUT_TOO_LARGE', 'output');

  // Réciproque : un texte multioctet sous la borne n'est pas pénalisé.
  accepted(parseAdductionProposals(envelope([proposal({
    citation: { quoted_text: '😀'.repeat(1000), occurrence: 1 },
  })])), 1);
});

// ==========================================================================
// J. Aucune réparation
// ==========================================================================

test('23 · T27 — clôture Markdown : refus, jamais retrait automatique', () => {
  const inner = envelope([]);
  // La MÊME charge, valide seule, devient invalide entourée d'une clôture.
  accepted(parseAdductionProposals(inner), 0);

  for (const fenced of [
    '```json\n' + inner + '\n```',
    '```\n' + inner + '\n```',
    'Voici la réponse :\n' + inner,
    inner + '\nVoilà.',
    '<json>' + inner + '</json>',
  ]) {
    refused(parseAdductionProposals(fenced), 'INVALID_JSON', 'output');
  }

  // Aucune sous-chaîne JSON n'est cherchée, aucune clôture n'est retirée : le
  // protocole est la charge du fournisseur, et le tolérer à moitié le rendrait
  // facultatif.
});

test('24 · aucun PROVIDER_FAILED n’est déductible d’un texte', () => {
  // Le parseur ne sait rien du transport. Recevoir un texte suppose déjà qu'une
  // réponse existe : conclure à un échec fournisseur serait inventer un fait.
  assert.equal(
    (ADDUCER_OUTPUT_REFUSAL_REASONS as readonly string[]).includes('PROVIDER_FAILED'),
    false,
  );
  for (const absent of ['REVALIDATION_REFUSED', 'VALID_ZERO', 'UNKNOWN', 'TIMEOUT']) {
    assert.equal((ADDUCER_OUTPUT_REFUSAL_REASONS as readonly string[]).includes(absent), false, absent);
  }
  assert.deepEqual([...ADDUCER_OUTPUT_REFUSAL_REASONS], [
    'OUTPUT_TOO_LARGE',
    'INVALID_JSON',
    'UNSUPPORTED_OUTPUT_VERSION',
    'INVALID_OUTPUT_SHAPE',
    'INVALID_PROPOSAL',
    'DUPLICATE_PROPOSAL',
  ]);
});

test('25 · déterminisme : même texte, même résultat, aucune dépendance externe', () => {
  const samples = [envelope([]), envelope([proposal()]), '```json{}```', padded(64)];
  for (const raw of samples) {
    assert.deepEqual(parseAdductionProposals(raw), parseAdductionProposals(raw));
  }
});

// ==========================================================================
// K. Garde de pureté — S7-A ne touche rien
// ==========================================================================

/**
 * Garde recalibrée en S7-B, et resserrée.
 *
 * Ce qu'elle gardait : « le FICHIER n'importe que deux modules purs ». Cette
 * formulation est devenue fausse par construction — le plan gelé réunit trois
 * responsabilités dans ce fichier, et S7-B y consomme légitimement le snapshot
 * natif, le ledger et un adaptateur.
 *
 * Ce qu'elle garde désormais : **la SECTION 1/3 est pure**. C'est la propriété
 * qui était réellement en jeu, et elle survivra aux sections suivantes. La
 * nouvelle forme est plus étroite, pas plus lâche : chaque identifiant importé
 * par le module est classé nommément, et un symbole du côté impur qui
 * apparaîtrait dans le parseur tue l'assertion.
 */
test('26 · le parseur — section 1/3 — est PUR, quoi que le reste du fichier devienne', async () => {
  const raw = await readFile(
    new URL('../../src/services/evidence-adducer.ts', import.meta.url),
    'utf8',
  );
  const start = raw.indexOf('// SECTION 1/3');
  const end = raw.indexOf('// SECTION 2/3');
  assert.ok(start > 0, 'la section 1/3 est marquée');
  assert.ok(end > start, 'la section 2/3 suit la section 1/3');

  const parser = raw
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  // Le parseur est bien DANS cette section — la garde ne porte pas sur du vide.
  assert.ok(parser.includes('export function parseAdductionProposals'), 'parseur en section 1/3');
  assert.ok(parser.includes('export const MAX_ADDUCER_OUTPUT_BYTES'), 'borne en section 1/3');

  const forbidden = [
    'node:fs', 'node:path', 'node:os', 'node:http', 'node:https', 'node:child_process',
    'node:crypto', 'readFile', 'writeFile', 'spawn', 'exec(', 'fetch(',
    'process.env', 'Date.now', 'new Date', 'Math.random',
    'NativeRunSnapshot', 'readStableNativeRunSnapshot', 'withNativeMutation', 'runPaths',
    'openInvocationLedger', 'openUsageLedger', 'appendEvidenceEntries', 'readEvidenceJournal',
    'assertInvocationQuotaAvailable', 'createUsageRecorder', 'createAdapters',
    'AgentAdapter', 'ProviderKind', 'credential', 'cockpit',
    // Aucune enveloppe canonique n'est construite ici.
    'ADDUCTION_RECORDED', 'MATERIAL_RECORDED', 'MODEL_ASSISTED', 'semantic_origin', 'recorded_by',
  ];
  for (const token of forbidden) {
    assert.equal(parser.includes(token), false, `section 1/3 : « ${token} »`);
  }

  // Classement NOMMÉ de chaque identifiant importé par le module. Un symbole du
  // côté impur employé dans le parseur, ou l'inverse, tue cette assertion.
  const importBlock = raw.slice(0, start);
  const imported = [...importBlock.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)]
    .flatMap((m) => (m[1] ?? '').split(','))
    .map((name) => name.replace(/^\s*(?:type\s+)?/, '').trim())
    .filter((name) => name.length > 0);
  assert.ok(imported.length >= 30, `le balayage voit les imports (${String(imported.length)})`);

  // Les six seuls symboles importés que le parseur a le droit de toucher.
  const PURE_SIDE = new Set([
    'MAX_INLINE_TEXT_BYTES', 'ORIENTATIONS', 'isControversyEntryTargetId', 'isMaterialId',
    'Orientation', 'utf8ByteLength',
  ]);
  for (const name of imported) {
    const used = new RegExp(`\\b${name}\\b`).test(parser);
    assert.equal(used, PURE_SIDE.has(name), `section 1/3 · « ${name} » : usage ${String(used)}`);
  }
  for (const name of PURE_SIDE) {
    assert.ok(imported.includes(name), `« ${name} » est bien importé`);
  }
});
