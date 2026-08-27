/**
 * V5.1 — surfaces HTTP V3 et V4, et le raccordement de la chaîne produit.
 *
 * Question de preuve :
 *
 * > **Le cockpit peut-il porter une controverse puis une preuve sans devenir
 * > une seconde autorité — et la réconciliation V5 devient-elle atteignable
 * > par le seul effet de ces enregistrements ?**
 *
 * Quatre propriétés.
 *
 *  1. **Union fermée.** Une opération inconnue, un champ inattendu ou un champ
 *     dont CCR est l'autorité sont refusés avant tout claim.
 *  2. **Deux actes distincts.** Retenir un matériau n'est pas le verser au
 *     débat, et le transport ne les fusionne pas davantage que le service.
 *  3. **Idempotence durable.** Une clé rejouée rejoue le résultat enregistré ;
 *     une intention différente n'est jamais fusionnée par erreur.
 *  4. **Le raccordement est porté par les journaux.** Une controverse
 *     enregistrée par HTTP fait apparaître son unité dans le read model V5 —
 *     aucun pont frontend n'existe.
 *
 * Aucun fournisseur : les deux surfaces sont humaines, et l'adaptateur de ce
 * fichier lève si on l'atteint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import {
  createOperationStore,
  newServerInstanceId,
} from '../../src/cockpit/operations-store.ts';
import type { OperationStore } from '../../src/cockpit/operations-store.ts';
import {
  CONTROVERSY_MUTATION_ROUTE_SEGMENT,
  EVIDENCE_MUTATION_ROUTE_SEGMENT,
  EVIDENCE_OPERATIONS,
  executeControversyMutation,
  executeEvidenceMutation,
} from '../../src/cockpit/mutations-http.ts';
import type { MutationResponse } from '../../src/cockpit/mutations-http.ts';
import { readNativeRunHttpView } from '../../src/cockpit/native-read-http.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { isCcrError } from '../../src/core/errors.ts';

const RUN_ID = 'CCR-20260821-701';
const EVENT_TEXT = 'le cache doit expirer apres 60 secondes, et le cache doit expirer';

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly store: OperationStore;
  readonly deps: { runService: RunServiceDeps; store: OperationStore };
  dispose(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-v51-domain-'));
  const dataRoot = await resolveCockpitDataRoot(dir);
  const runsDir = dataRoot.runsDir;
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, created_at: '2026-08-21T09:00:00.000Z', title: 'v51-domain',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'codex', session_id: 'S1' },
      challenger: { provider: 'claude', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000001',
    updated_at: '2026-08-21T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, `${JSON.stringify({
    event_id: 'evt_000001', run_id: RUN_ID, round: 1, timestamp: '2026-08-21T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: EVENT_TEXT,
  })}\n`, 'utf8');

  const store = createOperationStore(dataRoot, newServerInstanceId());
  const runService: RunServiceDeps = {
    runsDir,
    now: () => new Date('2026-08-21T12:00:00.000Z'),
    createAdapters: (): AgentAdapters => {
      throw new Error('aucune surface humaine V3 ou V4 ne construit d’adapter fournisseur');
    },
  };

  return {
    runsDir,
    paths,
    store,
    deps: { runService, store },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Le corps voyage comme sur le fil : une chaîne, jamais un objet déjà parsé. */
function send(
  h: Harness,
  segment: string,
  body: unknown,
  key: string,
): Promise<MutationResponse> {
  const request = {
    routeSegment: segment,
    runId: RUN_ID,
    generation: 'NATIVE_V21_EXECUTION' as const,
    contentType: 'application/json',
    idempotencyKey: key,
    body: JSON.stringify(body),
  };
  return segment === CONTROVERSY_MUTATION_ROUTE_SEGMENT
    ? executeControversyMutation(h.deps, request)
    : executeEvidenceMutation(h.deps, request);
}

async function view(h: Harness): Promise<Awaited<ReturnType<typeof readNativeRunHttpView>>> {
  return readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);
}

/** Ouvre une controverse par la route V3, et rend son entrée d'ouverture. */
async function openControversy(h: Harness, key = 'ccr-ctv-1'): Promise<string> {
  const before = await view(h);
  const response = await send(h, CONTROVERSY_MUTATION_ROUTE_SEGMENT, {
    operation: 'RECORD_CONTROVERSY',
    expected_controversy_revision: before.controversy_revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Les deux experts ne disent pas la même chose du cache.',
  }, key);
  assert.equal(response.receipt.status, 'SUCCEEDED', 'la controverse doit être enregistrée');

  const after = await view(h);
  if (after.controversies.availability !== 'AVAILABLE') throw new Error('run natif attendu');
  const item = after.controversies.items[0];
  assert.ok(item, 'une controverse est projetée');
  const opening = item.opening;
  assert.ok(opening, 'son entrée d’ouverture existe');
  return opening.entry_id;
}

// --------------------------------------------------------------------------
// A. V3 — la controverse s'enregistre depuis la surface HTTP
// --------------------------------------------------------------------------

test('V5.1 — la vue expose le jeton de fraîcheur V3, distinct de tous les autres', async () => {
  const h = await harness();
  try {
    const v = await view(h);
    assert.match(v.controversy_revision, /^ctv-sha256:[0-9a-f]{64}$/);
    assert.notEqual(v.controversy_revision, v.revision);
    if (v.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.notEqual(v.controversy_revision, v.evidence.evidence_revision);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — `RECORD_CONTROVERSY` par HTTP, sans fournisseur, et la vue le montre', async () => {
  const h = await harness();
  try {
    const opening = await openControversy(h);
    assert.match(opening, /^ctve_[0-9]{6}$/);

    const v = await view(h);
    if (v.controversies.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.equal(v.controversies.recorded_count, 1);
    // La révision V3 a bougé, celle du run n'a pas à bouger pour autant.
    assert.notEqual(v.controversy_revision, 'ctv-sha256:');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// B. V4 — deux actes distincts, jamais fondus
// --------------------------------------------------------------------------

test('V5.1 — deux opérations V4 exactement, et rien d’autre', () => {
  assert.deepEqual([...EVIDENCE_OPERATIONS], ['REGISTER_MATERIAL', 'ADDUCE_MATERIAL']);
  assert.equal(EVIDENCE_MUTATION_ROUTE_SEGMENT, 'evidence');
});

test('V5.1 — retenir un matériau ne le verse pas au débat', async () => {
  const h = await harness();
  try {
    await openControversy(h);
    const before = await view(h);
    if (before.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');

    const response = await send(h, EVIDENCE_MUTATION_ROUTE_SEGMENT, {
      operation: 'REGISTER_MATERIAL',
      expected_evidence_revision: before.evidence.evidence_revision,
      representation: { form: 'RUN_EVENT', event_id: 'evt_000001' },
      label: 'la réponse de l’auteur',
    }, 'ccr-mat-1');
    assert.equal(response.receipt.status, 'SUCCEEDED');

    const after = await view(h);
    if (after.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');
    // RETENTION ≠ ADDUCTION : un matériau, zéro adduction.
    assert.equal(after.evidence.recorded_material_count, 1);
    assert.equal(after.evidence.recorded_adduction_count, 0);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — adduire mobilise un matériau existant contre une entrée existante', async () => {
  const h = await harness();
  try {
    const opening = await openControversy(h);

    const beforeMaterial = await view(h);
    if (beforeMaterial.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');
    await send(h, EVIDENCE_MUTATION_ROUTE_SEGMENT, {
      operation: 'REGISTER_MATERIAL',
      expected_evidence_revision: beforeMaterial.evidence.evidence_revision,
      representation: { form: 'INLINE_TEXT', text: EVENT_TEXT },
    }, 'ccr-mat-2');

    const beforeAdduction = await view(h);
    if (beforeAdduction.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');
    const material = beforeAdduction.evidence.materials[0];
    assert.ok(material, 'le matériau retenu est projeté');

    const response = await send(h, EVIDENCE_MUTATION_ROUTE_SEGMENT, {
      operation: 'ADDUCE_MATERIAL',
      expected_evidence_revision: beforeAdduction.evidence.evidence_revision,
      material_id: material.entry.entry_id,
      target_entry_id: opening,
      // Fournie explicitement : le service n'applique aucun défaut.
      orientation: 'OBJECTS_TO',
    }, 'ccr-add-1');
    assert.equal(response.receipt.status, 'SUCCEEDED');
    assert.match(String(response.receipt.revision_after), /^ev-sha256:/);

    const after = await view(h);
    if (after.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.equal(after.evidence.recorded_material_count, 1);
    assert.equal(after.evidence.recorded_adduction_count, 1);
    assert.equal(after.evidence.adductions[0]?.entry.orientation, 'OBJECTS_TO');
    assert.equal(after.evidence.adductions[0]?.entry.semantic_origin, 'HUMAN');
  } finally {
    await h.dispose();
  }
});

test('V5.1 — opération inconnue, champ inattendu et champ serveur sont refusés', async () => {
  const h = await harness();
  try {
    const v = await view(h);
    if (v.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');
    const revision = v.evidence.evidence_revision;

    for (const [index, body] of [
      { operation: 'ADDUCE', expected_evidence_revision: revision },
      { operation: 'REGISTER_MATERIAL', expected_evidence_revision: revision, observed_by_ccr: true },
      { operation: 'REGISTER_MATERIAL', expected_evidence_revision: revision, orientation: 'SUPPORTS' },
      { operation: 'ADDUCE_MATERIAL' },
    ].entries()) {
      await assert.rejects(
        () => send(h, EVIDENCE_MUTATION_ROUTE_SEGMENT, body, `ccr-bad-${String(index)}`),
        (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
      );
    }
    // Aucun claim, donc aucun octet : le refus précède toute trace durable.
    assert.equal(existsSync(h.paths.evidence), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C. Idempotence durable — §20.3 du contrat V4, sans altération
// --------------------------------------------------------------------------

test('V5.1 — une clé rejouée rejoue le résultat, et n’écrit pas un second acte', async () => {
  const h = await harness();
  try {
    const v = await view(h);
    if (v.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');
    const body = {
      operation: 'REGISTER_MATERIAL',
      expected_evidence_revision: v.evidence.evidence_revision,
      representation: { form: 'INLINE_TEXT', text: 'un fait retenu' },
    };

    const first = await send(h, EVIDENCE_MUTATION_ROUTE_SEGMENT, body, 'ccr-idem-1');
    const second = await send(h, EVIDENCE_MUTATION_ROUTE_SEGMENT, body, 'ccr-idem-1');

    assert.equal(first.receipt.status, 'SUCCEEDED');
    assert.equal(second.receipt.operation_id, first.receipt.operation_id);
    assert.equal(second.receipt.status, 'SUCCEEDED');

    const after = await view(h);
    if (after.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.equal(after.evidence.recorded_material_count, 1, 'un seul matériau retenu');
  } finally {
    await h.dispose();
  }
});

test('V5.1 — deux intentions différentes sous la même clé ne sont pas fusionnées', async () => {
  const h = await harness();
  try {
    const v = await view(h);
    if (v.evidence.availability !== 'AVAILABLE') throw new Error('inatteignable');
    const revision = v.evidence.evidence_revision;

    await send(h, EVIDENCE_MUTATION_ROUTE_SEGMENT, {
      operation: 'REGISTER_MATERIAL',
      expected_evidence_revision: revision,
      representation: { form: 'INLINE_TEXT', text: 'premier fait' },
    }, 'ccr-conflit');

    // Même clé, corps différent : l'empreinte diffère, et le rejeu est refusé
    // plutôt que confondu avec la tentative précédente.
    await assert.rejects(
      () => send(h, EVIDENCE_MUTATION_ROUTE_SEGMENT, {
        operation: 'REGISTER_MATERIAL',
        expected_evidence_revision: revision,
        representation: { form: 'INLINE_TEXT', text: 'second fait, différent' },
      }, 'ccr-conflit'),
      (error: unknown) => isCcrError(error),
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D. Le raccordement — porté par les journaux, jamais par un pont frontend
// --------------------------------------------------------------------------

test('V5.1 — une controverse enregistrée par HTTP rend la réconciliation V5 atteignable', async () => {
  const h = await harness();
  try {
    // Avant : V5 est disponible, mais n'a aucune unité à réconcilier.
    const before = await view(h);
    if (before.reconciliations.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.equal(before.reconciliations.items.length, 0, 'rien à réconcilier');

    const opening = await openControversy(h);

    // Après : l'unité apparaît, par le seul effet du journal V3. Le read model
    // V5 énumère depuis les controverses observées — `§6.5`, `CR5-12`.
    const after = await view(h);
    if (after.reconciliations.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.equal(after.reconciliations.items.length, 1);
    if (after.controversies.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.equal(
      after.reconciliations.items[0]?.controversy_id,
      after.controversies.items[0]?.controversy_id,
      'la même controverse, vue par deux projections',
    );
    assert.ok(opening.startsWith('ctve_'));

    // Et rien n'a été réconcilié pour autant : une unité observable n'est pas
    // un acte, et le silence n'est pas la convergence.
    assert.equal(after.reconciliations.recorded_count, 0);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// E. Le transport n'est pas une autorité
// --------------------------------------------------------------------------

test('V5.1 — le transport V4 délègue, et ne rejoue aucune règle métier', async () => {
  const source = (await readFile(new URL('../../src/cockpit/mutations-http.ts', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const owner of ['registerMaterial(', 'adduceMaterial(']) {
    assert.ok(source.includes(owner), `la mutation doit déléguer à ${owner}`);
  }
  for (const forbidden of [
    'appendEvidenceEntries',
    'observed_by_ccr:',
    'semantic_origin:',
    "'SUPPORTS'",
    "'OBJECTS_TO'",
    'runControlledAcceptanceAdduction',
    'requestModelAdduction',
  ]) {
    assert.equal(source.includes(forbidden), false, `le transport porte « ${forbidden} »`);
  }
});
