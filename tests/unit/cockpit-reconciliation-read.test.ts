/**
 * V5.1 — la lecture V5 rejoint la vue HTTP native.
 *
 * Question de preuve :
 *
 * > **La projection V5 rejoint-elle ses trois voisines sous la MÊME fenêtre
 * > stable — et le fait-elle sans qu'aucune route de mutation ne l'accompagne ?**
 *
 * Le contrat V5 borne cette surface, et il la borne dans les deux sens :
 *
 * ```text
 * §40  read model         EXPOSÉ
 * §43  HTTP_MUTATION_V5   DIFFÉRÉ — « aucun chemin réservé, aucune route nommée »
 *                         « La lecture V5 est exposée par la projection
 *                           additive, sans mutation. »
 * §42  COCKPIT_V5         DIFFÉRÉ
 * ```
 *
 * Le second test rend cette borne **vérifiable** plutôt que déclarative : une
 * route de mutation V5 ajoutée un jour au transport ferait échouer ce fichier,
 * et c'est exactement ce qu'on attend de lui tant que le §43 n'a pas été amendé.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import { recordReconciliation } from '../../src/services/reconciliation-service.ts';
import type { RecordReconciliationInput } from '../../src/services/reconciliation-service.ts';
import { readCurrentReconciliationRevision } from '../../src/services/reconciliation-freshness.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { RECONCILIATION_READ_MODEL_VERSION } from '../../src/services/reconciliation-read-model.ts';
import type { ReconciliationReadModelV1 } from '../../src/services/reconciliation-read-model.ts';
import { readNativeRunHttpView } from '../../src/cockpit/native-read-http.ts';

const RUN_ID = 'CCR-20260821-101';
const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const SRC = new URL('../../src/', import.meta.url);
const NOW = new Date('2026-08-21T10:00:00.000Z');

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  dispose(): Promise<void>;
}

function v3Entry(sequence: number): ControversyEntry {
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: CTV,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-21T09:30:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  } as ControversyEntry;
}

async function nativeFixture(): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v51-read-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 'v51', created_at: '2026-08-21T09:00:00.000Z',
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
    content: 'le cache doit expirer',
  })}\n`, 'utf8');
  await writeFile(paths.controversies, `${JSON.stringify(v3Entry(1))}\n`, 'utf8');

  return { runsDir, paths, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

/** Source exécutable — commentaires retirés, comme les audits V3 et V4. */
function codeOnly(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Narrowing explicite : la forme `NOT_AVAILABLE` ne porte aucun compteur. */
function available(
  model: ReconciliationReadModelV1,
): Extract<ReconciliationReadModelV1, { availability: 'AVAILABLE' }> {
  assert.equal(model.availability, 'AVAILABLE');
  if (model.availability !== 'AVAILABLE') throw new Error('inatteignable');
  return model;
}

// --------------------------------------------------------------------------
// A. La projection V5 est exposée, additive, sous la même fenêtre
// --------------------------------------------------------------------------

test('V5.1 — la vue HTTP porte la projection V5, additive et sous le même instantané', async () => {
  const h = await nativeFixture();
  try {
    const deps = { runsDir: h.runsDir, now: (): Date => NOW };
    const acte = await recordReconciliation(deps, {
      runId: RUN_ID,
      expected_revision: await readCurrentReconciliationRevision({ runsDir: h.runsDir }, RUN_ID),
      target_controversy_id: CTV,
      scope_kind: 'SUBSET',
      scope: [E1],
      content: 'ce que la personne a décidé',
      provenance: { kind: 'DECLARED', statement: 'décidé en revue' },
    } as RecordReconciliationInput);

    const vue = await readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);

    // Les quatre champs voisins cohabitent : V5 s'AJOUTE, elle ne remplace rien.
    assert.equal(vue.generation, 'NATIVE_V21_EXECUTION');
    assert.match(vue.revision, /^sha256:[0-9a-f]{64}$/);
    assert.ok(vue.run !== undefined && vue.presentation !== undefined);
    assert.equal(vue.controversies.availability, 'AVAILABLE');
    assert.equal(vue.evidence.availability, 'AVAILABLE');

    const v5 = available(vue.reconciliations);
    assert.equal(v5.read_model_version, RECONCILIATION_READ_MODEL_VERSION);
    assert.equal(v5.recorded_count, 1);
    assert.equal(v5.items.length, 1, 'la controverse observée est énumérée depuis V3');
    assert.equal(v5.items[0]?.controversy_id, CTV);
    assert.equal(v5.items[0]?.recorded_acts[0]?.entry_id, acte.entry.entry_id);

    // La fraîcheur V5 vient du MÊME instantané, jamais d'un recalcul local, et
    // reste dans son propre espace : quatre révisions, quatre namespaces, et
    // aucune n'est comparable à une autre.
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.equal(v5.reconciliation_revision, snapshot.reconciliation_revision);
    assert.match(v5.reconciliation_revision, /^rcn-sha256:[0-9a-f]{64}$/);
    assert.notEqual(v5.reconciliation_revision, vue.revision);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — un run V5 sans aucun acte est AVAILABLE avec zéro, jamais NOT_AVAILABLE', async () => {
  const h = await nativeFixture();
  try {
    const vue = await readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);
    const v5 = available(vue.reconciliations);
    // `AVAILABLE` avec zéro acte ≠ `NOT_AVAILABLE`. Le run a été regardé.
    assert.equal(v5.recorded_count, 0);
    assert.equal(v5.items.length, 1, 'la controverse existe, sans acte V5');
    assert.deepEqual(v5.items[0]?.recorded_acts, []);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// B. La mutation V5 est bornée — addendum V5.1 §7, §17
// --------------------------------------------------------------------------

test('V5.1 — le transport délègue, et la voie d\'acceptation contrôlée reste hors surface', async () => {
  const lecture = await readFile(new URL('cockpit/native-read-http.ts', SRC), 'utf8');
  const mutations = await readFile(new URL('cockpit/mutations-http.ts', SRC), 'utf8');
  const serveur = await readFile(new URL('cockpit/server.ts', SRC), 'utf8');

  // La couche de LECTURE importe la projection, et rien qui écrive : une lecture
  // qui saurait muter serait une seconde autorité.
  assert.ok(lecture.includes('services/reconciliation-read-model.ts'));
  for (const ecriture of ['recordReconciliation(', 'recordProposalResponse(']) {
    assert.equal(lecture.includes(ecriture), false, `la lecture appelle ${ecriture}`);
  }

  // La couche de MUTATION délègue aux deux services propriétaires — et à eux
  // seuls. Le §43 différait cette surface ; l'addendum V5.1 la contracte, et
  // c'est la seule disposition qui a bougé.
  for (const owner of ['recordReconciliation(', 'recordProposalResponse(']) {
    assert.ok(mutations.includes(owner), `la mutation doit déléguer à ${owner}`);
  }
  assert.ok(mutations.includes('requestModelReconciliationProposal('));

  // La voie d'acceptation contrôlée demeure INTERDITE de toute surface produit
  // (addendum §7) : elle exige une autorisation nominative portée dans l'appel,
  // et aucun écran ne doit pouvoir la construire.
  for (const source of [lecture, mutations, serveur]) {
    assert.equal(source.includes('runControlledAcceptanceProposal'), false);
    assert.equal(source.includes('G4_REAL_PROPOSAL_ACCEPTANCE'), false);
  }

  // Une seule route nommée, et le serveur ne fabrique aucune autre.
  assert.ok(mutations.includes("RECONCILIATION_MUTATION_ROUTE_SEGMENT = 'reconciliations'"));
  assert.ok(serveur.includes('RECONCILIATION_MUTATION_ROUTE_SEGMENT'));

  // Le transport ne rejoue AUCUNE règle métier : ni actualité, ni clôture, ni
  // origine sémantique, ni vocabulaire de relation. L'audit porte sur le CODE,
  // commentaires retirés : un docblock a le droit de nommer ce que le code ne
  // doit pas décider.
  const code = codeOnly(mutations);
  for (const metier of [
    'decision_currentness',
    'closure_effect_currentness',
    "'MODIFIES'",
    "'REPLACES'",
    "'ACCEPT'",
    "'REJECT'",
  ]) {
    assert.equal(code.includes(metier), false, `le transport rejoue « ${metier} »`);
  }
});
