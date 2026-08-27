/**
 * V4 · S6 — compatibilité du journal d'invocations, version 3.
 *
 * Question de preuve :
 *
 * > **La version 3 admet-elle le déclencheur V4 sans qu'aucune version
 * > antérieure ne l'accepte par accident, et sans qu'un octet historique ne
 * > bouge ?**
 *
 * Quatre propriétés.
 *
 *  1. **La version qualifie l'enregistrement, jamais le fichier.** Un journal
 *     mixte se lit intégralement, ligne par ligne.
 *  2. **L'additivité est stricte, dans un seul sens.** Chaque version admet
 *     tout ce qu'admet la précédente, et une valeur de plus — jamais l'inverse.
 *  3. **La version suit la charge.** Un `SEND` écrit après une adduction reste
 *     en version 1 ; aucun writer ne monte un enregistrement.
 *  4. **Le déclencheur ne dit rien du résultat.** Un engagement peut exister
 *     sans qu'aucune adduction ne suive.
 *
 * Le défaut que ce fichier existe pour empêcher, nommément : qu'un déclencheur
 * V4 ajouté à une union « dernière version » soit accepté par un enregistrement
 * en version 2, faisant rejeter le journal entier à un lecteur de l'ère V3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONTROVERSY_DETECTION_TRIGGER,
  EVIDENCE_ADDUCTION_TRIGGER,
  INVOCATION_LEDGER_SCHEMA_VERSION,
  INVOCATION_LEDGER_SCHEMA_VERSION_V2,
  INVOCATION_LEDGER_SCHEMA_VERSION_V3,
  INVOCATION_LEDGER_SCHEMA_VERSION_V4,
  INVOCATION_TRIGGER_KINDS,
  INVOCATION_TRIGGER_KINDS_V1,
  INVOCATION_TRIGGER_KINDS_V2,
  INVOCATION_TRIGGER_KINDS_V3,
  RECONCILIATION_PROPOSAL_TRIGGER,
  SUPPORTED_INVOCATION_LEDGER_SCHEMA_VERSIONS,
  invocationLedgerSchemaVersionFor,
  invocationTriggerKindsFor,
} from '../../src/core/usage-governance.ts';
import type { InvocationTriggerKind } from '../../src/core/usage-governance.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { isCcrError } from '../../src/core/errors.ts';

const RUN_ID = 'CCR-20260818-801';
const AT = '2026-08-18T10:00:00.000Z';

const IDENTITY = {
  generation: 'NATIVE_V21_EXECUTION',
  expert_slot: 'author',
  provider: 'claude',
} as const;

/** Une ligne de ledger, telle qu'elle serait écrite sur disque. */
function record(version: number, trigger: string, sequence = 1): string {
  return JSON.stringify({
    schema_version: version,
    kind: 'DISPATCH_COMMITTED',
    invocation_id: `inv_${String(sequence).padStart(6, '0')}`,
    run_id: RUN_ID,
    identity: IDENTITY,
    trigger_kind: trigger,
    dispatch_committed_at: AT,
  });
}

async function fixture(): Promise<{ paths: RunPaths; dispose(): Promise<void> }> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s6-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  return { paths, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

/** Le journal est-il lisible avec exactement cette ligne ? */
async function accepts(version: number, trigger: string): Promise<boolean> {
  const h = await fixture();
  try {
    await writeFile(h.paths.invocations, `${record(version, trigger)}\n`, 'utf8');
    const records = await (await openInvocationLedger(h.paths, RUN_ID)).readAll();
    return records.length === 1 && records[0]?.trigger_kind === trigger;
  } catch (error) {
    assert.ok(isCcrError(error), `v${String(version)} + ${trigger} : ${String(error)}`);
    return false;
  } finally {
    await h.dispose();
  }
}

// ==========================================================================
// A. Vocabulaires
// ==========================================================================

test('1 · quatre versions, quatre vocabulaires strictement additifs', () => {
  assert.equal(INVOCATION_LEDGER_SCHEMA_VERSION, 1);
  assert.equal(INVOCATION_LEDGER_SCHEMA_VERSION_V2, 2);
  assert.equal(INVOCATION_LEDGER_SCHEMA_VERSION_V3, 3);
  assert.equal(INVOCATION_LEDGER_SCHEMA_VERSION_V4, 4);
  assert.deepEqual([...SUPPORTED_INVOCATION_LEDGER_SCHEMA_VERSIONS], [1, 2, 3, 4]);

  assert.deepEqual([...INVOCATION_TRIGGER_KINDS_V1], ['START', 'STEP', 'SEND', 'RECOVERY_CONTINUE']);
  assert.deepEqual([...INVOCATION_TRIGGER_KINDS_V2], [
    'START', 'STEP', 'SEND', 'RECOVERY_CONTINUE', 'CONTROVERSY_DETECTION',
  ]);
  // La version 3 se compare à SA liste figée. `INVOCATION_TRIGGER_KINDS` la
  // décrivait tant qu'elle était la dernière ; ce n'est plus le cas, et un
  // vocabulaire historique ne se déduit jamais du vocabulaire courant.
  assert.deepEqual([...INVOCATION_TRIGGER_KINDS_V3], [
    'START', 'STEP', 'SEND', 'RECOVERY_CONTINUE', 'CONTROVERSY_DETECTION', 'EVIDENCE_ADDUCTION',
  ]);
  assert.deepEqual([...INVOCATION_TRIGGER_KINDS], [
    'START', 'STEP', 'SEND', 'RECOVERY_CONTINUE', 'CONTROVERSY_DETECTION', 'EVIDENCE_ADDUCTION',
    'RECONCILIATION_PROPOSAL',
  ]);

  assert.equal(EVIDENCE_ADDUCTION_TRIGGER, 'EVIDENCE_ADDUCTION');
  assert.equal(CONTROVERSY_DETECTION_TRIGGER, 'CONTROVERSY_DETECTION');
  assert.equal(RECONCILIATION_PROPOSAL_TRIGGER, 'RECONCILIATION_PROPOSAL');

  // Additivité, dans un seul sens : chaque version contient la précédente.
  const v1 = new Set<string>(INVOCATION_TRIGGER_KINDS_V1);
  const v2 = new Set<string>(INVOCATION_TRIGGER_KINDS_V2);
  const v3 = new Set<string>(INVOCATION_TRIGGER_KINDS_V3);
  const v4 = new Set<string>(INVOCATION_TRIGGER_KINDS);
  for (const t of v1) assert.ok(v2.has(t), `v2 admet ${t}`);
  for (const t of v2) assert.ok(v3.has(t), `v3 admet ${t}`);
  for (const t of v3) assert.ok(v4.has(t), `v4 admet ${t}`);
  assert.equal(v2.size, v1.size + 1);
  assert.equal(v3.size, v2.size + 1);
  assert.equal(v4.size, v3.size + 1);

  // Et une seule valeur nouvelle : aucun autre déclencheur V4 n'est créé.
  const nouveaux = [...v3].filter((t) => !v2.has(t));
  assert.deepEqual(nouveaux, ['EVIDENCE_ADDUCTION']);
  for (const invente of ['EVIDENCE', 'MODEL_ADDUCTION', 'EVIDENCE_DETECTION',
                         'EVIDENCE_SUPPORT', 'EVIDENCE_OBJECTION']) {
    assert.equal(v3.has(invente), false, invente);
  }

  // Même discipline pour la génération suivante : la v4 n'apporte qu'une valeur.
  const nouveauxV4 = [...v4].filter((t) => !v3.has(t));
  assert.deepEqual(nouveauxV4, ['RECONCILIATION_PROPOSAL']);
});

test('2 · le vocabulaire d’une version est exhaustif, jamais un repli', () => {
  assert.deepEqual([...invocationTriggerKindsFor(1)], [...INVOCATION_TRIGGER_KINDS_V1]);
  assert.deepEqual([...invocationTriggerKindsFor(2)], [...INVOCATION_TRIGGER_KINDS_V2]);
  assert.deepEqual([...invocationTriggerKindsFor(3)], [...INVOCATION_TRIGGER_KINDS_V3]);
  assert.deepEqual([...invocationTriggerKindsFor(4)], [...INVOCATION_TRIGGER_KINDS]);

  // Et le vocabulaire v3 ne contient PAS le déclencheur v4 : c'est la frontière
  // que la liste figée protège.
  assert.equal(invocationTriggerKindsFor(3).includes(RECONCILIATION_PROPOSAL_TRIGGER), false);

  // Une version inconnue ne reçoit AUCUN vocabulaire. Le repli « sinon le
  // dernier » aurait fait admettre à la version 2 tout déclencheur futur.
  for (const version of [0, 5, 99, -1, 1.5, Number.NaN]) {
    assert.deepEqual([...invocationTriggerKindsFor(version)], [], String(version));
  }
});

// ==========================================================================
// B. Lecture — la matrice d'acceptation
// ==========================================================================

test('3 · T1/T2/T3 — la version 1 n’a pas bougé d’un déclencheur', async () => {
  for (const trigger of INVOCATION_TRIGGER_KINDS_V1) {
    assert.equal(await accepts(1, trigger), true, `v1 + ${trigger}`);
  }
  assert.equal(await accepts(1, 'CONTROVERSY_DETECTION'), false, 'v1 refuse la détection');
  assert.equal(await accepts(1, 'EVIDENCE_ADDUCTION'), false, 'v1 refuse l’adduction');
});

test('4 · T4/T5/T6 — la version 2 admet la détection, et REFUSE l’adduction', async () => {
  for (const trigger of INVOCATION_TRIGGER_KINDS_V1) {
    assert.equal(await accepts(2, trigger), true, `v2 + ${trigger}`);
  }
  assert.equal(await accepts(2, 'CONTROVERSY_DETECTION'), true, 'v2 admet la détection');

  // LA preuve principale de cette tranche. Admettre ici ferait rejeter le
  // journal entier à un lecteur de l'ère V3 : il verrait une version qu'il
  // admet porter une valeur qu'il refuse.
  assert.equal(await accepts(2, 'EVIDENCE_ADDUCTION'), false, 'v2 REFUSE l’adduction');
});

test('5 · T7/T8/T9 — la version 3 admet tout ce que la 2 admet, plus une', async () => {
  for (const trigger of INVOCATION_TRIGGER_KINDS_V2) {
    assert.equal(await accepts(3, trigger), true, `v3 + ${trigger}`);
  }
  assert.equal(await accepts(3, 'EVIDENCE_ADDUCTION'), true, 'v3 admet l’adduction');
});

test('6 · T10/T11 — version inconnue et déclencheur inconnu sont refusés', async () => {
  // Ce qui rend le refus lisible, c'est la frontière : la 4 est CONNUE, et elle
  // admet ce que la 3 admet, plus le déclencheur qu'elle apporte.
  for (const trigger of INVOCATION_TRIGGER_KINDS_V3) {
    assert.equal(await accepts(4, trigger), true, `v4 + ${trigger}`);
  }
  assert.equal(await accepts(4, RECONCILIATION_PROPOSAL_TRIGGER), true, 'v4 admet la proposition');

  // Et la 3 ne l'admet pas : un lecteur de l'ère V4 verrait une version qu'il
  // accepte porter une valeur qu'il refuse.
  assert.equal(await accepts(3, RECONCILIATION_PROPOSAL_TRIGGER), false, 'v3 REFUSE la proposition');

  for (const version of [0, 5, 99, -1]) {
    assert.equal(await accepts(version, 'START'), false, `schema ${String(version)}`);
  }
  for (const trigger of ['HANDOFF', 'PAUSE', 'RESUME', 'OTHER', 'CUSTOM', 'UNKNOWN', '']) {
    assert.equal(await accepts(3, trigger), false, `trigger ${trigger}`);
  }
});

// ==========================================================================
// C. Écriture — la matrice de sélection
// ==========================================================================

test('7 · T12/T13/T14 — la version suit la charge, jamais le millésime', () => {
  for (const trigger of INVOCATION_TRIGGER_KINDS_V1) {
    assert.equal(invocationLedgerSchemaVersionFor(trigger), 1, trigger);
  }
  assert.equal(invocationLedgerSchemaVersionFor('CONTROVERSY_DETECTION'), 2);
  assert.equal(invocationLedgerSchemaVersionFor('EVIDENCE_ADDUCTION'), 3);

  // Aucun writer ne « monte » un enregistrement : la sélection est une fonction
  // pure de son seul argument, et rien d'autre ne l'influence.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(invocationLedgerSchemaVersionFor('SEND'), 1, 'SEND reste en v1');
    assert.equal(invocationLedgerSchemaVersionFor('CONTROVERSY_DETECTION'), 2);
  }

  // Un déclencheur hors union retombe sur la version 1 — la plus ÉTROITE, donc
  // celle qui le refusera —, jamais sur la dernière, qui l'accueillerait.
  for (const inconnu of ['HANDOFF', 'PAUSE', 'EVIDENCE', 'MODEL_ADDUCTION']) {
    assert.equal(
      invocationLedgerSchemaVersionFor(inconnu as InvocationTriggerKind),
      INVOCATION_LEDGER_SCHEMA_VERSION,
      inconnu,
    );
    assert.equal(
      (invocationTriggerKindsFor(1) as readonly string[]).includes(inconnu),
      false,
      `${inconnu} sera refusé par la v1`,
    );
  }
});

test('8 · le writer réel écrit la version de la charge', async () => {
  const h = await fixture();
  try {
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    const attendu: readonly (readonly [InvocationTriggerKind, number])[] = [
      ['START', 1],
      ['CONTROVERSY_DETECTION', 2],
      ['EVIDENCE_ADDUCTION', 3],
      ['SEND', 1],
    ];
    for (const [trigger] of attendu) {
      // `run_id` est omis de `NewInvocationDispatch` : il appartient au CONTEXTE
      // du store — `openInvocationLedger(paths, runId)` — jamais à la charge.
      await ledger.append({ identity: IDENTITY, trigger_kind: trigger });
    }

    const records = await (await openInvocationLedger(h.paths, RUN_ID)).readAll();
    assert.deepEqual(
      records.map((r) => [r.trigger_kind, r.schema_version]),
      attendu.map(([t, v]) => [t, v]),
    );
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// D. Journal mixte, et intégrité de l'histoire
// ==========================================================================

test('9 · T15/T16 — un journal mixte se lit entièrement, dans son ordre', async () => {
  const h = await fixture();
  try {
    const lignes = [
      record(1, 'START', 1),
      record(2, 'CONTROVERSY_DETECTION', 2),
      record(3, 'EVIDENCE_ADDUCTION', 3),
      record(1, 'SEND', 4),
      record(2, 'CONTROVERSY_DETECTION', 5),
      record(1, 'RECOVERY_CONTINUE', 6),
    ];
    const octets = `${lignes.join('\n')}\n`;
    await writeFile(h.paths.invocations, octets, 'utf8');

    const records = await (await openInvocationLedger(h.paths, RUN_ID)).readAll();
    assert.equal(records.length, 6, 'aucune ligne perdue');
    assert.deepEqual(records.map((r) => r.schema_version), [1, 2, 3, 1, 2, 1]);
    assert.deepEqual(records.map((r) => r.trigger_kind), [
      'START', 'CONTROVERSY_DETECTION', 'EVIDENCE_ADDUCTION', 'SEND',
      'CONTROVERSY_DETECTION', 'RECOVERY_CONTINUE',
    ]);
    assert.deepEqual(records.map((r) => r.invocation_id), [
      'inv_000001', 'inv_000002', 'inv_000003', 'inv_000004', 'inv_000005', 'inv_000006',
    ]);

    // T16 — la ligne v3 ne change rien à ses voisines : elles gardent leur
    // version et leur sens.
    assert.equal(records[3]?.schema_version, 1, 'un SEND après une adduction reste v1');
    assert.equal(records[4]?.schema_version, 2);

    // T17 — lire ne réécrit rien : les octets sont identiques.
    assert.equal(await readFile(h.paths.invocations, 'utf8'), octets);
  } finally {
    await h.dispose();
  }
});

test('10 · T17 — aucune migration : une ligne refusée laisse le fichier intact', async () => {
  const h = await fixture();
  try {
    // Un journal légitime, suivi d'une ligne dont le déclencheur ne correspond
    // pas à sa version. Ce n'est pas un « déclencheur futur » : c'est un
    // enregistrement invalide.
    const octets = `${record(1, 'START', 1)}\n${record(2, 'EVIDENCE_ADDUCTION', 2)}\n`;
    await writeFile(h.paths.invocations, octets, 'utf8');

    await assert.rejects(
      () => openInvocationLedger(h.paths, RUN_ID),
      (error: unknown) => isCcrError(error),
    );
    assert.equal(await readFile(h.paths.invocations, 'utf8'), octets, 'octets intacts');

    // Une version inconnue : même refus, même intégrité. La 4 ayant été prise
    // en charge par V5-S13, l'inconnue de ce test est désormais la 5.
    const inconnue = `${record(5, 'START', 1)}\n`;
    await writeFile(h.paths.invocations, inconnue, 'utf8');
    await assert.rejects(
      () => openInvocationLedger(h.paths, RUN_ID),
      (error: unknown) => isCcrError(error),
    );
    assert.equal(await readFile(h.paths.invocations, 'utf8'), inconnue);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// E. Ce que le déclencheur ne dit pas
// ==========================================================================

test('11 · T18 — un engagement n’est pas un résultat, et n’appelle aucun fournisseur', async () => {
  const h = await fixture();
  try {
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    await ledger.append({
      identity: IDENTITY,
      trigger_kind: 'EVIDENCE_ADDUCTION',
    });

    const records = await (await openInvocationLedger(h.paths, RUN_ID)).readAll();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.trigger_kind, 'EVIDENCE_ADDUCTION');
    assert.equal(records[0]?.kind, 'DISPATCH_COMMITTED');

    // L'enregistrement ne porte AUCUN résultat : ni adduction, ni orientation,
    // ni sortie, ni succès. Un engagement peut exister sans qu'aucune adduction
    // ne suive.
    const serialise = JSON.stringify(records[0]);
    for (const interdit of [
      'adduction', 'material', 'orientation', 'SUPPORTS', 'OBJECTS_TO',
      'outcome', 'result', 'success', 'persisted', 'VALID_ZERO',
    ]) {
      assert.equal(serialise.includes(interdit), false, interdit);
    }

    // Aucun usage n'est inventé : le journal d'usage n'existe même pas.
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(h.paths.usage), false, 'aucune observation d’usage');
  } finally {
    await h.dispose();
  }
});

test('12 · le domaine V4 n’a rien à voir avec la gouvernance d’invocation', async () => {
  const source = (await readFile(new URL('../../src/core/usage-governance.ts', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // La gouvernance ne connaît ni matériaux, ni adductions, ni orientations :
  // elle sait pourquoi un appel a été engagé, et rien de plus.
  for (const interdit of [
    'MATERIAL_RECORDED', 'ADDUCTION_RECORDED', 'material_id', 'adduction_id',
    'orientation', 'evidence_revision', 'ev-sha256', 'core/evidence',
    'evidence-store', 'evidence-service',
  ]) {
    assert.equal(source.includes(interdit), false, `usage-governance : ${interdit}`);
  }

  // Et aucun fournisseur n'est atteint depuis ce module.
  for (const interdit of ['adapter', 'Adapter', 'createAdapters', '.start(', 'spawn(']) {
    assert.equal(source.includes(interdit), false, `usage-governance : ${interdit}`);
  }
});
