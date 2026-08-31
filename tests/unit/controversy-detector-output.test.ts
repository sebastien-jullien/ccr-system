/**
 * V3-S7-A — sémantique locale du détecteur et parseur versionné.
 *
 * Question de preuve :
 *
 * > **Une sortie non fiable peut-elle produire des propositions typées sans
 * > qu'aucun modèle ne soit appelé, et sans qu'un refus puisse jamais se
 * > confondre avec « rien trouvé » ?**
 *
 * Quatre propriétés.
 *
 *  1. **Valide-zéro n'est pas invalide.** Les deux laissent le journal V3
 *     intact, mais ne disent pas la même chose — et la forme du résultat
 *     empêche de les confondre.
 *  2. **La borne précède l'analyse.** Une sortie trop grosse est refusée avant
 *     qu'on tente d'en lire la syntaxe.
 *  3. **Le schéma est fermé.** Un modèle ne devient jamais autorité en glissant
 *     un champ supplémentaire.
 *  4. **Rien n'est persisté, rien n'est invoqué.** Le module est pur : aucune
 *     horloge, aucun aléa, aucun disque, aucun fournisseur.
 *
 * Aucune preuve ici ne dit quoi que ce soit de la QUALITÉ d'une détection :
 * précision, rappel et vérité intellectuelle restent hors périmètre.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { RELATION_ACTS } from '../../src/core/controversy.ts';
import {
  CONTROVERSY_DETECTOR_OUTPUT_VERSION,
  DETECTOR_OUTPUT_REFUSAL_REASONS,
  MAX_DETECTOR_OUTPUT_BYTES,
  SUPPORTED_DETECTOR_OUTPUT_VERSIONS,
  parseDetectorOutput,
} from '../../src/services/controversy-detector.ts';
import type { DetectorOutputParse } from '../../src/services/controversy-detector.ts';

const SOURCE = new URL('../../src/services/controversy-detector.ts', import.meta.url);

function output(proposals: readonly unknown[], version: unknown = CONTROVERSY_DETECTOR_OUTPUT_VERSION): string {
  return JSON.stringify({ detector_output_version: version, proposals });
}

function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    controversy_id: 'ctv_000001',
    from_entry_id: 'ctve_000002',
    to_entry_id: 'ctve_000003',
    act: 'CONTESTS',
    ...over,
  };
}

function valid(result: DetectorOutputParse): Extract<DetectorOutputParse, { outcome: 'VALID' }> {
  assert.equal(result.outcome, 'VALID', `attendu VALID, obtenu ${JSON.stringify(result)}`);
  if (result.outcome !== 'VALID') throw new Error('inatteignable');
  return result;
}

function refused(result: DetectorOutputParse, reason: string, label: string): void {
  assert.equal(result.outcome, 'INVALID', `${label} : attendu INVALID`);
  if (result.outcome !== 'INVALID') return;
  assert.equal(result.reason, reason, label);
}

// ==========================================================================
// A. Les deux issues, et leur distinction structurelle
// ==========================================================================

test('1 · T1 — une sortie valide sans proposition est un SUCCÈS, pas un échec', () => {
  const result = valid(parseDetectorOutput(output([])));

  assert.equal(result.detector_output_version, 1);
  assert.deepEqual(result.proposals, []);

  // La distinction est portée par la FORME : une issue invalide ne possède
  // aucun champ `proposals`, donc aucun appelant ne peut le lire sans avoir
  // d'abord constaté `VALID`. Replier un refus sur `[]` est inexprimable.
  const bad = parseDetectorOutput('{');
  assert.equal(bad.outcome, 'INVALID');
  assert.equal('proposals' in bad, false, 'un refus ne porte aucune liste vide');
  assert.equal('detector_output_version' in bad, false);

  assert.deepEqual([...DETECTOR_OUTPUT_REFUSAL_REASONS], [
    'OUTPUT_TOO_LARGE',
    'INVALID_JSON',
    'UNSUPPORTED_OUTPUT_VERSION',
    'INVALID_OUTPUT_SHAPE',
    'INVALID_PROPOSAL',
  ]);
  assert.deepEqual([...SUPPORTED_DETECTOR_OUTPUT_VERSIONS], [1]);
});

test('2 · T2 — une proposition valide est rendue typée, et rien de plus', () => {
  const result = valid(parseDetectorOutput(output([proposal()])));

  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.proposals[0], {
    controversy_id: 'ctv_000001',
    from_entry_id: 'ctve_000002',
    to_entry_id: 'ctve_000003',
    act: 'CONTESTS',
  });

  // Une proposition n'est PAS une entrée : aucun champ d'autorité n'y figure.
  const asRecord = result.proposals[0] as unknown as Record<string, unknown>;
  for (const forbidden of [
    'entry_id',
    'schema_version',
    'recorded_at',
    'recorded_by',
    'semantic_origin',
    'derivation',
    'invocation_id',
    'confidence',
    'score',
    'position_id',
    'status',
  ]) {
    assert.equal(forbidden in asRecord, false, `aucun champ ${forbidden}`);
  }
});

test('3 · T3/T16 — l’ordre de production est préservé, et rien n’est dédupliqué', () => {
  const acts = [...RELATION_ACTS];
  const proposals = [
    proposal({ act: 'WITHDRAWS', from_entry_id: 'ctve_000009' }),
    proposal({ act: 'CONTESTS' }),
    proposal({ act: 'REFORMULATES', to_entry_id: 'ctve_000007' }),
    // Doublon strictement identique au deuxième : le plan n'impose aucun refus
    // dans une même sortie, et l'information brute est conservée telle quelle.
    proposal({ act: 'CONTESTS' }),
  ];

  const result = valid(parseDetectorOutput(output(proposals)));

  assert.equal(result.proposals.length, 4, 'aucune déduplication, ni exacte ni sémantique');
  assert.deepEqual(
    result.proposals.map((item) => item.act),
    ['WITHDRAWS', 'CONTESTS', 'REFORMULATES', 'CONTESTS'],
    'ordre de production, jamais un tri',
  );
  assert.deepEqual(result.proposals[1], result.proposals[3]);

  // Aucun tri par acte, identifiant, texte ou horodatage.
  assert.notDeepEqual(
    result.proposals.map((item) => item.act),
    [...acts].sort(),
  );
});

// ==========================================================================
// B. Borne, avant toute analyse
// ==========================================================================

test('4 · T13/T14 — la borne s’applique AVANT le parsing', () => {
  // Un document exactement à la borne, valide par ailleurs : accepté. Le
  // remplissage est de l'espace JSON, qui ne change pas la structure.
  const base = '{"detector_output_version":1,"proposals":[]}';
  const padding = ' '.repeat(MAX_DETECTOR_OUTPUT_BYTES - Buffer.byteLength(base, 'utf8'));
  const exact = `{"detector_output_version":1,${padding}"proposals":[]}`;
  assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_DETECTOR_OUTPUT_BYTES);
  assert.deepEqual(valid(parseDetectorOutput(exact)).proposals, []);

  // Un octet de plus : refus.
  refused(parseDetectorOutput(`${exact} `), 'OUTPUT_TOO_LARGE', 'un octet au-delà');

  // La preuve d'ORDRE : une sortie trop grosse ET syntaxiquement invalide rend
  // `OUTPUT_TOO_LARGE`, jamais `INVALID_JSON`. Si la borne venait après
  // l'analyse, le refus porterait l'autre motif.
  const oversizedGarbage = `{${'x'.repeat(MAX_DETECTOR_OUTPUT_BYTES)}`;
  refused(parseDetectorOutput(oversizedGarbage), 'OUTPUT_TOO_LARGE', 'trop gros ET illisible');

  // La mesure est en octets UTF-8, pas en unités UTF-16.
  const multibyte = '«'.repeat(MAX_DETECTOR_OUTPUT_BYTES / 2 + 1);
  assert.ok(multibyte.length < MAX_DETECTOR_OUTPUT_BYTES);
  refused(parseDetectorOutput(multibyte), 'OUTPUT_TOO_LARGE', 'octets, jamais caractères');
});

// ==========================================================================
// C. Refus déterministes
// ==========================================================================

test('5 · T4/T5/T6 — syntaxe, version et forme', () => {
  for (const [label, raw] of [
    ['objet non clos', '{'],
    ['vide', ''],
    ['texte libre', 'Voici les désaccords que j’ai trouvés.'],
    ['markdown', '```json\n{"detector_output_version":1,"proposals":[]}\n```'],
    ['NaN', '{"detector_output_version":NaN,"proposals":[]}'],
  ] as const) {
    refused(parseDetectorOutput(raw), 'INVALID_JSON', label);
  }

  for (const [label, version] of [
    ['version 0', 0],
    ['version 2', 2],
    ['version 99', 99],
    ['version chaîne', '1'],
    ['version nulle', null],
  ] as const) {
    refused(parseDetectorOutput(output([], version)), 'UNSUPPORTED_OUTPUT_VERSION', label);
  }
  // Version absente : c'est encore un refus de version, jamais un défaut.
  refused(parseDetectorOutput('{"proposals":[]}'), 'UNSUPPORTED_OUTPUT_VERSION', 'version absente');

  for (const [label, raw] of [
    ['tableau au sommet', '[]'],
    ['chaîne au sommet', '"rien"'],
    ['nombre au sommet', '42'],
    ['null au sommet', 'null'],
    ['proposals absent', '{"detector_output_version":1}'],
    ['proposals objet', '{"detector_output_version":1,"proposals":{}}'],
    ['proposals nul', '{"detector_output_version":1,"proposals":null}'],
    ['proposal au singulier', '{"detector_output_version":1,"proposal":[]}'],
  ] as const) {
    refused(parseDetectorOutput(raw), 'INVALID_OUTPUT_SHAPE', label);
  }
});

test('6 · T7/T8/T9/T10 — vocabulaire fermé et identités canoniques', () => {
  for (const [label, over] of [
    ['acte inconnu', { act: 'SUPPORTS' }],
    ['acte inventé', { act: 'AGREES_WITH' }],
    ['acte de position', { act: 'SAME_POSITION' }],
    ['acte de clôture', { act: 'RESOLVES' }],
    ['acte vide', { act: '' }],
    ['acte non chaîne', { act: 1 }],
    ['acte en minuscules', { act: 'contests' }],
    ['controversy_id non canonique', { controversy_id: 'ctv_1' }],
    ['controversy_id d’entrée', { controversy_id: 'ctve_000001' }],
    ['controversy_id espacé', { controversy_id: ' ctv_000001' }],
    ['controversy_id nul', { controversy_id: null }],
    ['from non canonique', { from_entry_id: 'evt_000002' }],
    ['from de controverse', { from_entry_id: 'ctv_000002' }],
    ['to non canonique', { to_entry_id: 'ctve_00' }],
    ['to absent', { to_entry_id: undefined }],
    ['auto-référence', { from_entry_id: 'ctve_000005', to_entry_id: 'ctve_000005' }],
  ] as const) {
    const built = proposal(over as Record<string, unknown>);
    if ((over as Record<string, unknown>)['to_entry_id'] === undefined && 'to_entry_id' in over) {
      delete built['to_entry_id'];
    }
    refused(parseDetectorOutput(output([built])), 'INVALID_PROPOSAL', label);
  }

  // Les trois actes du contrat, et eux seuls, sont acceptés.
  for (const act of RELATION_ACTS) {
    const result = valid(parseDetectorOutput(output([proposal({ act })])));
    assert.equal(result.proposals[0]?.act, act);
  }
});

test('7 · T11/T12 — le modèle ne devient jamais autorité par un champ en plus', () => {
  const forged: readonly (readonly [string, Record<string, unknown>])[] = [
    ['semantic_origin', { semantic_origin: { kind: 'CCR' } }],
    ['derivation', { derivation: { method: 'MODEL_ASSISTED', inputs: [] } }],
    ['invocation_id', { invocation_id: 'inv_000001' }],
    ['entry_id', { entry_id: 'ctve_000099' }],
    ['recorded_by', { recorded_by: 'CCR' }],
    ['recorded_at', { recorded_at: '2026-08-17T00:00:00.000Z' }],
    ['schema_version', { schema_version: 1 }],
    ['confidence', { confidence: 0.97 }],
    ['probability', { probability: 1 }],
    ['score', { score: 10 }],
    ['certainty', { certainty: 'high' }],
    ['agreement_score', { agreement_score: 0 }],
    ['provider', { provider: 'claude' }],
    ['model', { model: 'claude-opus' }],
    ['cost', { cost: 0.01 }],
    ['status', { status: 'OPEN' }],
    ['position_id', { position_id: 'pos_1' }],
    ['same_position', { same_position: true }],
    ['rationale', { rationale: 'parce que' }],
    ['nature', { nature: 'désaccord de méthode' }],
  ];

  for (const [label, extra] of forged) {
    refused(parseDetectorOutput(output([proposal(extra)])), 'INVALID_PROPOSAL', label);
  }

  // Et au niveau de l'enveloppe.
  for (const [label, raw] of [
    ['confidence globale', '{"detector_output_version":1,"proposals":[],"confidence":0.5}'],
    ['invocation globale', '{"detector_output_version":1,"proposals":[],"invocation_id":"inv_000001"}'],
    ['modèle global', '{"detector_output_version":1,"proposals":[],"model":"x"}'],
  ] as const) {
    refused(parseDetectorOutput(raw), 'INVALID_OUTPUT_SHAPE', label);
  }
});

// ==========================================================================
// D. Fixtures adverses
// ==========================================================================

test('8 · §26 — sorties adverses ciblées : le parseur reste fermé', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['proposition non-objet', output(['CONTESTS']), 'INVALID_PROPOSAL'],
    ['proposition tableau', output([[]]), 'INVALID_PROPOSAL'],
    ['proposition nulle', output([null]), 'INVALID_PROPOSAL'],
    ['objet imbriqué hors sujet', output([proposal({ meta: { deep: { deeper: [1, 2, 3] } } })]), 'INVALID_PROPOSAL'],
    [
      'clé prototype dans une proposition',
      '{"detector_output_version":1,"proposals":[{"__proto__":{"polluted":true},"controversy_id":"ctv_000001","from_entry_id":"ctve_000002","to_entry_id":"ctve_000003","act":"CONTESTS"}]}',
      'INVALID_PROPOSAL',
    ],
    [
      'clé prototype dans l’enveloppe',
      '{"__proto__":{"polluted":true},"detector_output_version":1,"proposals":[]}',
      'INVALID_OUTPUT_SHAPE',
    ],
    // Le motif de séquence du domaine n'est pas borné, et `parseInt` absorbe
    // les zéros de tête : sans exigence de forme canonique, cet identifiant de
    // 200 ko désignerait la séquence 1 et serait accepté.
    ['identifiant démesuré', output([proposal({ controversy_id: `ctv_${'0'.repeat(200000)}1` })]), 'INVALID_PROPOSAL'],
    ['remplissage de zéros', output([proposal({ controversy_id: 'ctv_0000001' })]), 'INVALID_PROPOSAL'],
    ['séquence nulle', output([proposal({ from_entry_id: 'ctve_000000' })]), 'INVALID_PROPOSAL'],
    ['séquence hors des entiers sûrs', output([proposal({ to_entry_id: `ctve_${'9'.repeat(25)}` })]), 'INVALID_PROPOSAL'],
    ['saut de ligne dans un identifiant', output([proposal({ controversy_id: 'ctv_000001\n' })]), 'INVALID_PROPOSAL'],
    ['retour chariot dans un acte', output([proposal({ act: 'CONTESTS\r\n' })]), 'INVALID_PROPOSAL'],
  ];

  for (const [label, raw, reason] of cases) {
    refused(parseDetectorOutput(raw), reason, label);
  }

  // Aucune pollution de prototype n'a eu lieu.
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);

  // Le premier refus arrête l'analyse : une sortie partiellement lisible n'est
  // pas une sortie valide amputée.
  const mixed = output([proposal(), proposal({ act: 'SUPPORTS' }), proposal()]);
  const result = parseDetectorOutput(mixed);
  assert.equal(result.outcome, 'INVALID');
  if (result.outcome === 'INVALID') assert.equal(result.at, 'output.proposals[1].act');
});

test('9 · T15 — aucune normalisation : JSON définit la représentation, pas nous', () => {
  // Un échappement JSON est décodé par JSON, et le résultat est la chaîne
  // ordinaire — c'est la seule normalisation admise, et elle ne vient pas d'ici.
  const escaped = '{"detector_output_version":1,"proposals":[{"controversy_id":"ctv_00000\\u0031","from_entry_id":"ctve_000002","to_entry_id":"ctve_000003","act":"CONTESTS"}]}';
  const result = valid(parseDetectorOutput(escaped));
  assert.equal(result.proposals[0]?.controversy_id, 'ctv_000001');

  // Et rien n'est rogné, ni mis en forme : un identifiant entouré d'espaces
  // n'est pas « réparé », il est refusé.
  for (const candidate of ['ctv_000001 ', ' ctv_000001', 'ctv_000001\t', 'CTV_000001']) {
    refused(
      parseDetectorOutput(output([proposal({ controversy_id: candidate })])),
      'INVALID_PROPOSAL',
      candidate,
    );
  }
});

test('10 · T17 — déterminisme : même entrée, même sortie ou même refus', () => {
  const raws = [
    output([]),
    output([proposal(), proposal({ act: 'WITHDRAWS' })]),
    '{"detector_output_version":9,"proposals":[]}',
    'pas du json',
    output([proposal({ act: 'SUPPORTS' })]),
  ];

  for (const raw of raws) {
    const a = parseDetectorOutput(raw);
    const b = parseDetectorOutput(raw);
    assert.deepEqual(a, b, raw.slice(0, 40));
  }

  // L'ordre des propriétés du JSON reçu ne change pas le résultat.
  const ordered = '{"detector_output_version":1,"proposals":[{"act":"CONTESTS","to_entry_id":"ctve_000003","from_entry_id":"ctve_000002","controversy_id":"ctv_000001"}]}';
  assert.deepEqual(parseDetectorOutput(ordered), parseDetectorOutput(output([proposal()])));
});

// ==========================================================================
// E. Absence de fournisseur, de ledger et de persistance
// ==========================================================================

test('11 · T18 — le module est pur : ni fournisseur, ni ledger, ni disque, ni horloge', async () => {
  const whole = (await readFile(SOURCE, 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // V3-S7-B a ajouté au même module l'orchestration de dispatch, qui appelle
  // légitimement un adaptateur et le ledger. La garde de pureté est donc bornée
  // au PARSEUR — et elle y reste entière, ce qui prouve que 7-A n'a rien gagné
  // au passage. Le repère est un identifiant : les commentaires sont retirés.
  const border = whole.indexOf('interface DetectionAdapters');
  assert.ok(border > 0, 'la section de dispatch est délimitée');
  // Le bloc d'imports appartient au module entier, pas à une section : il est
  // vérifié séparément, plus bas.
  const importsEnd = whole.indexOf('export const CONTROVERSY_DETECTOR_OUTPUT_VERSION');
  assert.ok(importsEnd > 0 && importsEnd < border);
  const code = whole.slice(importsEnd, border);

  for (const forbidden of [
    'createAdapters',
    'spawn',
    'execFile',
    'node:fs',
    'node:http',
    'node:child_process',
    'fetch(',
    'invocation-ledger',
    'usage-governance',
    'InvocationLedger',
    'DISPATCH_COMMITTED',
    'CONTROVERSY_DETECTION',
    'controversy-store',
    'appendControversyEntry',
    'native-run-snapshot',
    'withNativeMutation',
    'Date.now',
    'Math.random',
    'new Date',
    'process.env',
  ]) {
    assert.equal(code.includes(forbidden), false, `le détecteur ne contient pas « ${forbidden} »`);
  }

  // Aucun prompt n'est construit : la forme attendue de sortie est définie, la
  // demande envoyée à un modèle appartient à 7-B.
  for (const forbidden of ['buildPrompt', 'promptFor', 'systemPrompt', 'renderPrompt']) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }

  // Aucun modèle de vérité n'est introduit.
  for (const forbidden of [
    'MODEL_ASSISTED',
    'position_id',
    'CONVERGED',
    'confidence',
    'winner',
    'closure',
    'similarity',
    'agreement',
  ]) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
  for (const pattern of [/\bstatus\s*[:=]/, /\bscore\b/]) {
    assert.equal(pattern.test(code), false, String(pattern));
  }

  // Le parseur lui-même n'utilise que le domaine V3 et une mesure d'octets :
  // aucun des imports ajoutés par le dispatch n'apparaît dans son corps.
  for (const seam of [
    'openInvocationLedger',
    'openUsageLedger',
    'readStableNativeRunSnapshot',
    'withNativeMutation',
    'assertInvocationQuotaAvailable',
    'recordDetectedRelations',
    'createAdapters',
  ]) {
    assert.equal(code.includes(seam), false, `le parseur n'utilise pas ${seam}`);
  }

  // Et le dispatch, lui, ne persiste jamais directement : il passe par le
  // service métier, jamais par le journal.
  const dispatch = whole.slice(border);
  assert.equal(dispatch.includes('recordDetectedRelations('), true, 'la persistance passe par le service');
  assert.equal(dispatch.includes('appendControversyEntry'), false, 'aucun append direct');
  assert.equal(dispatch.includes('parseDetectorOutput('), true, 'le parseur 7-A est le seul');
  assert.equal(dispatch.includes('JSON.parse'), false, 'aucune seconde analyse');

  // Les imports du module, énumérés : aucun n'est un fournisseur concret, un
  // rendu, un réseau ou une horloge — l'adaptateur est une abstraction fournie
  // par l'appelant, et le temps vient de `deps.now`.
  const imports = [...whole.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(imports)].sort(), [
    '../adapters/agent-adapter.ts',
    '../core/controversy.ts',
    '../core/errors.ts',
    '../core/expert.ts',
    '../core/usage-governance.ts',
    '../store/invocation-ledger.ts',
    '../store/layout.ts',
    '../store/native-run-snapshot.ts',
    '../store/usage-ledger.ts',
    './controversy-read-model.ts',
    './controversy-service.ts',
    // Durabilité de l'issue négative : une couture de persistance du dispatch,
    // de la même famille que le service métier et l'écriture d'usage. Le
    // parseur, lui, l'ignore — la garde de pureté ci-dessus le vérifie.
    './invocation-outcome-writer.ts',
    './invocation-quota.ts',
    './native-mutation-boundary.ts',
    './native-start-service.ts',
    './run-service.ts',
    './transfer.ts',
    './usage-governance-writer.ts',
  ]);
  for (const forbidden of ['node:child_process', 'node:http', 'node:net', 'node:fs']) {
    assert.equal(whole.includes(forbidden), false, forbidden);
  }
});
