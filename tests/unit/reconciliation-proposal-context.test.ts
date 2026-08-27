/**
 * V5.1 — le contexte canonique d'une proposition assistée.
 *
 * Question de preuve :
 *
 * > **Le modèle reçoit-il le désaccord réel — et rien que ce qui s'y rattache
 * > réellement ?**
 *
 * La qualification réelle du 2026-08-21 a montré un chemin assisté qui
 * transmettait deux identifiants nus. L'addendum d'autorité du même jour comble
 * ce silence, et fixe quatre propriétés que ce fichier éprouve.
 *
 *  1. **Sélection déterministe.** Les unités soumises, les événements qu'elles
 *     ancrent, les adductions qui les visent, et les matériaux de ces
 *     adductions. Rien qui entre par proximité.
 *  2. **Exclusions.** Une autre controverse, un événement non ancré, une
 *     adduction hors périmètre, un matériau non mobilisé restent dehors.
 *  3. **Une seule chaîne canonique.** Celle qui est mesurée est celle qui est
 *     condensée, et celle qui est injectée.
 *  4. **Périmètre ≠ contexte.** Le contexte ne grossit jamais l'ensemble soumis.
 *
 * Aucun fournisseur : ce module est pur, et ne touche ni disque ni réseau.
 *
 * ```text
 * REAL_PROVIDER_CALLS = 0
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CANONICAL_SERIALIZATION_RULE,
  MAX_PROPOSAL_CONTEXT_UTF8_BYTES,
  PROPOSAL_CONTEXT_VERSION,
  assertProposalContextWithinBound,
  auditProposalContext,
  buildProposalContext,
  digestProposalContext,
  measureProposalContext,
  serializeProposalContext,
} from '../../src/services/reconciliation-proposal-context.ts';
import type { NativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { isCcrError } from '../../src/core/errors.ts';

const CTV = 'ctv_000001';
const CTV_OTHER = 'ctv_000002';
const E1 = 'ctve_000001';
const E2 = 'ctve_000002';
const E_OTHER = 'ctve_000009';

/** Positions réelles du run `CCR-20260404-001`, condensées mais fidèles. */
const INFRA = 'Le point décisif est infrastructurel : CPU throttlé hors requête.';
const APPLI = 'Le défaut le plus important est applicatif, pas infrastructurel.';

interface Parts {
  readonly controversies?: readonly unknown[];
  readonly events?: readonly unknown[];
  readonly evidence?: readonly unknown[];
}

function entry(id: string, controversyId: string, content: string, anchors: unknown): unknown {
  return {
    schema_version: 1,
    entry_id: id,
    controversy_id: controversyId,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-21T09:30:00.000Z',
    round: 0,
    content,
    anchors,
  };
}

function event(id: string, slot: string, content: string): unknown {
  return {
    event_id: id,
    run_id: 'CCR-20260821-901',
    round: 0,
    timestamp: '2026-08-21T09:10:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: slot,
    session_id: `S-${slot}`,
    content,
  };
}

function material(id: string, representation: unknown, label?: string): unknown {
  return {
    schema_version: 1,
    entry_id: id,
    kind: 'MATERIAL_RECORDED',
    recorded_by: 'CCR',
    recorded_at: '2026-08-21T09:40:00.000Z',
    submitted_by: 'HUMAN',
    representation,
    observed_by_ccr: true,
    ...(label === undefined ? {} : { label }),
  };
}

function adduction(id: string, materialId: string, targetEntryId: string, orientation = 'NONE'): unknown {
  return {
    schema_version: 1,
    entry_id: id,
    kind: 'ADDUCTION_RECORDED',
    recorded_by: 'CCR',
    recorded_at: '2026-08-21T09:45:00.000Z',
    material_id: materialId,
    target: { kind: 'CONTROVERSY_ENTRY', entry_id: targetEntryId },
    orientation,
    semantic_origin: 'HUMAN',
  };
}

function snapshotOf(parts: Parts): NativeRunSnapshot {
  return {
    runId: 'CCR-20260821-901',
    controversies: parts.controversies ?? [],
    events: parts.events ?? [],
    evidence: parts.evidence ?? [],
  } as unknown as NativeRunSnapshot;
}

// --------------------------------------------------------------------------
// A. Sélection V3 — les unités soumises, telles que V3 les détient
// --------------------------------------------------------------------------

test('V5.1 — une unité soumise arrive avec son énoncé, jamais son seul identifiant', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA)],
  });

  const context = buildProposalContext(snapshot, CTV, [E1]);
  assert.equal(context.context_version, PROPOSAL_CONTEXT_VERSION);
  assert.equal(context.entries.length, 1);
  assert.equal(context.entries[0]?.entry_id, E1);
  assert.equal(context.entries[0]?.content, INFRA, "l'énoncé, non reformulé");
  assert.equal(context.entries[0]?.semantic_origin, 'HUMAN');

  const text = serializeProposalContext(context);
  assert.ok(text.includes(INFRA), 'le désaccord est réellement dans la chaîne canonique');
  assert.ok(text.includes(E1));
});

test('V5.1 — plusieurs unités soumises, dans l’ordre du journal', () => {
  const snapshot = snapshotOf({
    controversies: [
      entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] }),
      entry(E2, CTV, APPLI, { provenance: [{ event_id: 'evt_000006', round: 0 }] }),
    ],
    events: [event('evt_000003', 'author', INFRA), event('evt_000006', 'challenger', APPLI)],
  });

  // Demandées à l'envers : l'ordre rendu reste celui du journal, jamais celui
  // de la requête — un ordre choisi serait une hiérarchie argumentative.
  const context = buildProposalContext(snapshot, CTV, [E2, E1]);
  assert.deepEqual(context.entries.map((item) => item.entry_id), [E1, E2]);
  assert.deepEqual(context.events.map((item) => item.event_id), ['evt_000003', 'evt_000006']);
});

test('V5.1 — les trois ancrages traversent le contexte', () => {
  const snapshot = snapshotOf({
    controversies: [
      entry(E1, CTV, INFRA, {
        provenance: [{ event_id: 'evt_000003', round: 0 }],
        textual: { event_id: 'evt_000003', quoted_text: 'CPU throttlé', occurrence: 1 },
        semantic: { text: 'le péril est infrastructurel', semantic_origin: { kind: 'HUMAN' } },
      }),
    ],
    events: [event('evt_000003', 'author', INFRA)],
  });

  const text = serializeProposalContext(buildProposalContext(snapshot, CTV, [E1]));
  assert.ok(text.includes('CPU throttlé'), 'ancrage textuel rendu');
  assert.ok(text.includes('occurrence 1'));
  assert.ok(text.includes('le péril est infrastructurel'), 'ancrage sémantique rendu');
  assert.ok(text.includes('evt_000003'), 'ancrage de provenance rendu');
});

// --------------------------------------------------------------------------
// B. Exclusions — rien n'entre par proximité
// --------------------------------------------------------------------------

test('V5.1 — un événement non ancré reste dehors, si proche soit-il', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [
      event('evt_000003', 'author', INFRA),
      // Voisin immédiat dans le journal, jamais ancré par l'unité soumise.
      event('evt_000004', 'challenger', 'un secret de fixture : sk-live-NE-DOIT-PAS-FUIR'),
    ],
  });

  const context = buildProposalContext(snapshot, CTV, [E1]);
  assert.deepEqual(context.events.map((item) => item.event_id), ['evt_000003']);
  const text = serializeProposalContext(context);
  assert.equal(text.includes('evt_000004'), false);
  assert.equal(text.includes('sk-live-NE-DOIT-PAS-FUIR'), false, 'aucune fuite par voisinage');
});

test('V5.1 — une autre controverse n’entre jamais dans le contexte', () => {
  const snapshot = snapshotOf({
    controversies: [
      entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] }),
      entry(E_OTHER, CTV_OTHER, 'un désaccord sans rapport', {
        provenance: [{ event_id: 'evt_000099', round: 3 }],
      }),
    ],
    events: [event('evt_000003', 'author', INFRA), event('evt_000099', 'author', 'sans rapport')],
  });

  // Même en NOMMANT l'unité étrangère, la cible de la controverse tranche.
  const context = buildProposalContext(snapshot, CTV, [E1, E_OTHER]);
  assert.deepEqual(context.entries.map((item) => item.entry_id), [E1]);
  const text = serializeProposalContext(context);
  assert.equal(text.includes('un désaccord sans rapport'), false);
  assert.equal(text.includes('evt_000099'), false);
});

test('V5.1 — une adduction hors périmètre, et son matériau, restent dehors', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA)],
    evidence: [
      material('mat_000001', { form: 'INLINE_TEXT', text: 'pièce versée au périmètre' }),
      material('mat_000002', { form: 'INLINE_TEXT', text: 'pièce visant une autre unité' }),
      adduction('add_000001', 'mat_000001', E1),
      adduction('add_000002', 'mat_000002', E_OTHER),
    ],
  });

  const context = buildProposalContext(snapshot, CTV, [E1]);
  assert.deepEqual(context.adductions.map((item) => item.entry_id), ['add_000001']);
  assert.deepEqual(context.materials.map((item) => item.entry_id), ['mat_000001']);
  const text = serializeProposalContext(context);
  assert.equal(text.includes('pièce visant une autre unité'), false);
  assert.equal(text.includes('mat_000002'), false);
});

// --------------------------------------------------------------------------
// C. Les trois représentations V4
// --------------------------------------------------------------------------

test('V5.1 — INLINE_TEXT porte son texte canonique', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA)],
    evidence: [
      material('mat_000001', { form: 'INLINE_TEXT', text: 'relevé direct du 2026-07-20' }, 'relevé'),
      adduction('add_000001', 'mat_000001', E1, 'SUPPORTS'),
    ],
  });

  const text = serializeProposalContext(buildProposalContext(snapshot, CTV, [E1]));
  assert.ok(text.includes('relevé direct du 2026-07-20'));
  assert.ok(text.includes('SUPPORTS'), "l'orientation déclarée est rendue");
});

test('V5.1 — EXTERNAL_REFERENCE : métadonnées seules, aucune résolution', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA)],
    evidence: [
      material('mat_000001', {
        form: 'EXTERNAL_REFERENCE',
        locator: 'https://exemple.invalid/note-technique',
        declared_digest: 'sha256:0123456789abcdef',
      }),
      adduction('add_000001', 'mat_000001', E1, 'OBJECTS_TO'),
    ],
  });

  const context = buildProposalContext(snapshot, CTV, [E1]);
  assert.equal(context.materials[0]?.locator, 'https://exemple.invalid/note-technique');
  assert.equal(context.materials[0]?.declared_digest, 'sha256:0123456789abcdef');
  // Aucun contenu : CCR ne détient rien, et n'ira rien chercher.
  assert.equal(context.materials[0]?.content, null);
});

test('V5.1 — RUN_EVENT déjà rendu : référencé, jamais dupliqué', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA)],
    evidence: [
      material('mat_000001', { form: 'RUN_EVENT', event_id: 'evt_000003' }),
      adduction('add_000001', 'mat_000001', E1),
    ],
  });

  const context = buildProposalContext(snapshot, CTV, [E1]);
  assert.equal(context.materials[0]?.event_id, 'evt_000003');
  assert.equal(context.materials[0]?.content, null, 'contenu non dupliqué');

  const text = serializeProposalContext(context);
  const occurrences = text.split(INFRA).length - 1;
  // Une fois dans l'énoncé de l'unité, une fois dans l'événement ancré — et
  // pas une troisième fois sous le matériau qui le référence.
  assert.equal(occurrences, 2, `le contenu de l'événement n'apparaît pas trois fois (${String(occurrences)})`);
  assert.ok(text.includes('contenu rendu ci-dessus'));
});

test('V5.1 — RUN_EVENT non ancré : son contenu est rendu, puisque nul autre ne le porte', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA), event('evt_000010', 'challenger', 'mesure jointe au débat')],
    evidence: [
      material('mat_000001', { form: 'RUN_EVENT', event_id: 'evt_000010' }),
      adduction('add_000001', 'mat_000001', E1),
    ],
  });

  const context = buildProposalContext(snapshot, CTV, [E1]);
  // L'événement n'est pas ancré, donc absent de la section provenance…
  assert.deepEqual(context.events.map((item) => item.event_id), ['evt_000003']);
  // …mais il est versé au débat, donc son contenu accompagne son matériau.
  assert.equal(context.materials[0]?.content, 'mesure jointe au débat');
  assert.ok(serializeProposalContext(context).includes('mesure jointe au débat'));
});

// --------------------------------------------------------------------------
// D. Périmètre ≠ contexte
// --------------------------------------------------------------------------

test('V5.1 — le contexte ne grossit jamais l’ensemble soumis', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA)],
    evidence: [
      material('mat_000001', { form: 'RUN_EVENT', event_id: 'evt_000003' }),
      adduction('add_000001', 'mat_000001', E1),
    ],
  });

  const context = buildProposalContext(snapshot, CTV, [E1]);
  // Un seul soumis, malgré un événement et deux objets V4 dans le contexte.
  assert.deepEqual([...context.submitted], [E1]);
  assert.equal(context.events.length, 1);
  assert.equal(context.adductions.length, 1);
  assert.equal(context.materials.length, 1);

  const text = serializeProposalContext(context);
  assert.ok(text.includes('UNITÉS SOUMISES'));
  assert.ok(text.includes('jamais des unités soumises'), 'la distinction est dite au modèle');
});

// --------------------------------------------------------------------------
// E. Sérialisation, mesure, condensat — une seule chaîne
// --------------------------------------------------------------------------

function sized(bytes: number): string {
  return 'x'.repeat(bytes);
}

test('V5.1 — la borne compte des OCTETS UTF-8, pas des caractères', () => {
  assert.equal(MAX_PROPOSAL_CONTEXT_UTF8_BYTES, 131072);
  assert.ok(CANONICAL_SERIALIZATION_RULE.length > 0);

  // « é » pèse deux octets : une mesure en caractères passerait, la vraie non.
  const multibyte = 'é'.repeat(70000);
  assert.equal(multibyte.length, 70000, '70 000 caractères');
  assert.equal(measureProposalContext(multibyte), 140000, '140 000 octets');
  assert.throws(
    () => assertProposalContextWithinBound(multibyte),
    (error: unknown) => isCcrError(error) && error.code === 'PROPOSAL_CONTEXT_TOO_LARGE',
  );
});

test('V5.1 — 131071 accepté · 131072 accepté · 131073 refusé', () => {
  assert.equal(assertProposalContextWithinBound(sized(131071)), 131071);
  assert.equal(assertProposalContextWithinBound(sized(131072)), 131072);
  assert.throws(
    () => assertProposalContextWithinBound(sized(131073)),
    (error: unknown) => isCcrError(error) && error.code === 'PROPOSAL_CONTEXT_TOO_LARGE',
  );
});

test('V5.1 — le refus ne tronque rien et ne résume rien', () => {
  try {
    assertProposalContextWithinBound(sized(200000));
    assert.fail('un refus était attendu');
  } catch (error) {
    assert.ok(isCcrError(error));
    assert.equal(error.code, 'PROPOSAL_CONTEXT_TOO_LARGE');
    assert.match(error.message, /troncature/);
    assert.match(error.message, /résumé/);
    assert.equal((error.details as { context_utf8_bytes?: number }).context_utf8_bytes, 200000);
  }
});

test('V5.1 — mesure, condensat et injection portent la MÊME chaîne', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA)],
  });

  const context = buildProposalContext(snapshot, CTV, [E1]);
  const text = serializeProposalContext(context);
  const audit = auditProposalContext(context, text);

  assert.equal(audit.context_utf8_bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(audit.context_sha256, `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`);
  assert.equal(audit.context_version, PROPOSAL_CONTEXT_VERSION);
});

test('V5.1 — même sources, même condensat · un caractère de plus, condensat différent', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA)],
  });

  const first = serializeProposalContext(buildProposalContext(snapshot, CTV, [E1]));
  const second = serializeProposalContext(buildProposalContext(snapshot, CTV, [E1]));
  assert.equal(digestProposalContext(first), digestProposalContext(second), 'reconstruction stable');

  const mutated = snapshotOf({
    controversies: [entry(E1, CTV, `${INFRA}.`, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA)],
  });
  const third = serializeProposalContext(buildProposalContext(mutated, CTV, [E1]));
  assert.notEqual(digestProposalContext(first), digestProposalContext(third), 'un point suffit');
});

test('V5.1 — les identifiants audités sont ceux réellement lus', () => {
  const snapshot = snapshotOf({
    controversies: [entry(E1, CTV, INFRA, { provenance: [{ event_id: 'evt_000003', round: 0 }] })],
    events: [event('evt_000003', 'author', INFRA), event('evt_000004', 'challenger', 'non ancré')],
    evidence: [
      material('mat_000001', { form: 'RUN_EVENT', event_id: 'evt_000003' }),
      adduction('add_000001', 'mat_000001', E1),
    ],
  });

  const context = buildProposalContext(snapshot, CTV, [E1]);
  const audit = auditProposalContext(context, serializeProposalContext(context));
  assert.deepEqual([...audit.context_source_ids], [CTV, E1, 'evt_000003', 'add_000001', 'mat_000001']);
  assert.equal(audit.context_source_ids.includes('evt_000004'), false, 'le non-lu n’est pas audité');
});
