/**
 * V3-S3 — projection de lecture et surface HTTP.
 *
 * Question de preuve :
 *
 * > **La projection dit-elle exactement ce que le journal contient, sans rien
 * > agréger, sans rien trier, et sans jamais faire passer un run historique
 * > pour un run sans désaccord ?**
 *
 * Trois propriétés.
 *
 *  1. **Le vide est qualifié.** Legacy et natif-sans-entrée ne se ressemblent
 *     pas, et la forme elle-même empêche de les confondre.
 *  2. **L'histoire survit.** Retrait, confirmation puis contestation : tout
 *     reste visible, dans l'ordre d'append, sans état courant unique.
 *  3. **Rien n'est promu.** Une transcription humaine reste humaine, une
 *     inférence reste dérivée, un ancrage reste une localisation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import { appendControversyEntry } from '../../src/store/controversy-store.ts';
import { computeEvidenceRevision } from '../../src/store/evidence-store.ts';
import { computeReconciliationRevision } from '../../src/store/reconciliation-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import {
  CONTROVERSY_READ_MODEL_VERSION,
  controversyReadModelNotAvailable,
  projectControversyReadModel,
} from '../../src/services/controversy-read-model.ts';
import { readNativeRunHttpView } from '../../src/cockpit/native-read-http.ts';

const RUN_ID = 'CCR-20260817-001';
const CTV_A = formatControversyId(1);
const CTV_B = formatControversyId(2);

let sequence = 0;
function entry(over: Partial<ControversyEntry> = {}): ControversyEntry {
  sequence += 1;
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: CTV_A,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-17T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000010', round: 1 }] },
    ...over,
  } as ControversyEntry;
}

/** Snapshot minimal, sans disque : la projection est pure. */
function snapshotOf(
  controversies: readonly ControversyEntry[],
  events: readonly { event_id: string; content?: string | null }[] = [],
): NativeRunSnapshot {
  return {
    runId: RUN_ID,
    paths: runPaths('/nowhere', RUN_ID),
    manifest: {} as NativeRunSnapshot['manifest'],
    state: {} as NativeRunSnapshot['state'],
    events: events as NativeRunSnapshot['events'],
    controversies,
    revision: 'sha256:x',
    controversy_revision: 'ctv-sha256:x',
    // Cinquième source du snapshot stable, ajoutée par V4-S2. Ce test projette
    // V3 : le run décrit ici n'a AUCUN journal Evidence.
    //
    // S2 distingue deux états observés, et leur donne deux révisions
    // différentes : `absent` d'un côté, `present:0:` de l'autre. « Aucun
    // journal » n'est donc PAS « un journal vide », et écrire une révision
    // arbitraire ferait dire à la fixture un état que S2 ne produit jamais.
    //
    // La valeur est dérivée de la primitive autoritaire, jamais écrite à la
    // main : la projection reste pure, et la fixture ne peut pas diverger de
    // ce que le store calcule.
    evidence: [],
    evidence_revision: computeEvidenceRevision({ present: false }),
    // Sixième source du snapshot stable, ajoutée par V5-S3. Même règle que la
    // cinquième : le run décrit ici n'a AUCUN journal V5, et c'est la révision
    // qui porte la différence entre « absent » et « présent, vide ». La valeur
    // vient de la primitive autoritaire, jamais écrite à la main.
    reconciliations: [],
    reconciliation_revision: computeReconciliationRevision({ present: false }),
    attempts: 1,
  };
}

async function nativeRun(generation = 2): Promise<{
  runsDir: string;
  paths: ReturnType<typeof runPaths>;
  dispose: () => Promise<void>;
}> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v3-s3-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  // Un run historique porte `agents`, provider-keyed ; un run natif porte
  // `experts`, role-keyed. La distinction est celle que V2.1 existe pour poser.
  const actors =
    generation === 1
      ? {
          agents: {
            claude: { session_id: 'S2', role: 'challenger' },
            codex: { session_id: 'S1', role: 'author' },
          },
        }
      : {
          experts: {
            author: { provider: 'codex', session_id: 'S1' },
            challenger: { provider: 'claude', session_id: 'S2' },
          },
        };

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: generation,
      run_id: RUN_ID,
      created_at: '2026-08-17T09:00:00.000Z',
      title: 'S3',
      workspace: { cwd: runsDir },
      ...actors,
    }),
    'utf8',
  );
  await writeFile(
    paths.state,
    JSON.stringify({
      schema_version: 3,
      run_id: RUN_ID,
      state: 'READY',
      control: 'AUTOMATION',
      round: 1,
      active_expert_slot: null,
      next_step_source_slot: 'author',
      last_event_id: null,
      updated_at: '2026-08-17T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, '', 'utf8');
  return { runsDir, paths, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

function available(model: ReturnType<typeof projectControversyReadModel>) {
  assert.equal(model.availability, 'AVAILABLE');
  if (model.availability !== 'AVAILABLE') throw new Error('unreachable');
  return model;
}

// ==========================================================================
// A. Vérité du vide
// ==========================================================================

test('1 · natif sans journal : AVAILABLE, zéro controverse, et rien n’est créé', async () => {
  const run = await nativeRun();
  try {
    assert.equal(existsSync(run.paths.controversies), false);

    const snapshot = await readStableNativeRunSnapshot(run.runsDir, RUN_ID);
    const model = available(projectControversyReadModel(snapshot));

    assert.equal(model.recorded_count, 0);
    assert.deepEqual(model.items, []);
    assert.equal(model.read_model_version, CONTROVERSY_READ_MODEL_VERSION);
    assert.equal(existsSync(run.paths.controversies), false, 'la lecture ne matérialise rien');
  } finally {
    await run.dispose();
  }
});

test('2 · natif avec journal vide : AVAILABLE, zéro controverse', async () => {
  const run = await nativeRun();
  try {
    await writeFile(run.paths.controversies, '', 'utf8');
    const snapshot = await readStableNativeRunSnapshot(run.runsDir, RUN_ID);
    const model = available(projectControversyReadModel(snapshot));

    assert.equal(model.recorded_count, 0);
    assert.deepEqual(model.items, []);
  } finally {
    await run.dispose();
  }
});

test('3 · legacy : NOT_AVAILABLE, et la forme ne PEUT PAS porter un compteur', async () => {
  const legacy = controversyReadModelNotAvailable();
  assert.equal(legacy.availability, 'NOT_AVAILABLE');

  // La distinction est structurelle : `recorded_count` n'existe pas sur cette
  // branche de l'union. Aucun « AVAILABLE + 0 » n'est représentable pour un
  // run historique.
  assert.equal('recorded_count' in legacy, false);
  assert.equal('items' in legacy, false);

  // Et le chemin natif refuse un run historique plutôt que d'en projeter un vide.
  const run = await nativeRun(1);
  try {
    await assert.rejects(
      () => readStableNativeRunSnapshot(run.runsDir, RUN_ID),
      /SCHEMA_VERSION_UNSUPPORTED|génération/,
    );
  } finally {
    await run.dispose();
  }
});

// ==========================================================================
// B. Regroupement et ordre
// ==========================================================================

test('4 · une controverse à plusieurs entrées : un item, ordre d’append préservé', () => {
  sequence = 0;
  const entries = [
    entry({ kind: 'CONTROVERSY_RECORDED' }),
    entry(),
    entry({ kind: 'NATURE_RECORDED', content: 'interprétatif' }),
  ];
  const model = available(projectControversyReadModel(snapshotOf(entries)));

  assert.equal(model.recorded_count, 1);
  assert.equal(model.items.length, model.recorded_count, 'recorded_count === items.length');
  assert.deepEqual(
    model.items[0]?.entries.map((e) => e.entry_id),
    entries.map((e) => e.entry_id),
  );
  assert.equal(model.items[0]?.opening?.kind, 'CONTROVERSY_RECORDED');
});

test('5 · deux controverses entrelacées : deux items, ordres relatifs intacts', () => {
  sequence = 0;
  const a1 = entry({ controversy_id: CTV_A, kind: 'CONTROVERSY_RECORDED' });
  const b1 = entry({ controversy_id: CTV_B, kind: 'CONTROVERSY_RECORDED' });
  const a2 = entry({ controversy_id: CTV_A });
  const b2 = entry({ controversy_id: CTV_B });
  const a3 = entry({ controversy_id: CTV_A });

  const model = available(projectControversyReadModel(snapshotOf([a1, b1, a2, b2, a3])));

  assert.equal(model.recorded_count, 2);
  // Ordre des items : première apparition dans le journal, jamais un tri.
  assert.deepEqual(model.items.map((item) => item.controversy_id), [CTV_A, CTV_B]);
  assert.deepEqual(model.items[0]?.entries.map((e) => e.entry_id), [a1.entry_id, a2.entry_id, a3.entry_id]);
  assert.deepEqual(model.items[1]?.entries.map((e) => e.entry_id), [b1.entry_id, b2.entry_id]);
});

test('6 · des entrées sans enregistrement d’ouverture : `opening` reste null', () => {
  sequence = 0;
  const orphan = entry();
  const model = available(projectControversyReadModel(snapshotOf([orphan])));

  assert.equal(model.recorded_count, 1);
  assert.equal(model.items[0]?.opening, null, 'aucune ouverture n’est fabriquée');
  assert.equal(model.items[0]?.entries.length, 1);
});

// ==========================================================================
// C. Fidélité d'attribution
// ==========================================================================

test('7 · une transcription humaine reste HUMAN à propos d’une source', () => {
  sequence = 0;
  const transcription = entry({
    semantic_origin: { kind: 'HUMAN', about_actor: 'challenger' },
    anchors: {
      provenance: [{ event_id: 'evt_000010', round: 1, expert_slot_id: 'challenger' }],
      textual: { event_id: 'evt_000010', quoted_text: 'je conteste X', occurrence: 1 },
    },
  });
  const model = available(
    projectControversyReadModel(
      snapshotOf([transcription], [{ event_id: 'evt_000010', content: 'je conteste X' }]),
    ),
  );

  const projected = model.items[0]?.entries[0];
  assert.equal(projected?.semantic_origin.kind, 'HUMAN');
  assert.equal(projected?.semantic_origin.about_actor, 'challenger');
  assert.equal(projected?.semantic_origin.actor, undefined, 'jamais promue en SOURCE');
});

test('8 · une inférence reste CCR, avec son invocation_id', () => {
  sequence = 0;
  const inference = entry({
    kind: 'RELATION_RECORDED',
    semantic_origin: { kind: 'CCR' },
    recorded_by: 'CCR',
    derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000007', inputs: ['evt_000010'] },
    relation: {
      from_entry_id: formatControversyEntryId(80),
      to_entry_id: formatControversyEntryId(81),
      act: 'CONTESTS',
    },
  });
  const model = available(projectControversyReadModel(snapshotOf([inference])));

  const projected = model.items[0]?.entries[0];
  assert.equal(projected?.semantic_origin.kind, 'CCR');
  assert.equal(projected?.derivation?.method, 'MODEL_ASSISTED');
  assert.equal(projected?.derivation?.invocation_id, 'inv_000007');
  // La projection ne va pas chercher fournisseur, modèle ni coût : ils vivent
  // dans l'InvocationLedger, qui en est l'autorité.
  assert.equal('provider' in (projected?.derivation ?? {}), false);
});

// ==========================================================================
// D. L'histoire survit
// ==========================================================================

test('9 · confirmation puis contestation — et l’inverse — restent toutes deux visibles', () => {
  for (const acts of [
    ['CONFIRM_RELATION', 'CONTEST_RELATION'],
    ['CONTEST_RELATION', 'CONFIRM_RELATION'],
  ] as const) {
    sequence = 0;
    const target = formatControversyEntryId(50);
    const entries = acts.map((act) =>
      entry({
        kind: 'HUMAN_AUTHORITY_RECORDED',
        semantic_origin: { kind: 'HUMAN' },
        authority: { act, target_entry_id: target },
      }),
    );

    const model = available(projectControversyReadModel(snapshotOf(entries)));
    const item = model.items[0];

    assert.deepEqual(item?.authority_entries.map((e) => e.authority?.act), [...acts]);
    assert.equal(item?.authority_entries.length, 2, 'la première réponse n’est jamais écrasée');
    // Aucun état courant n'est dérivé : ni `confirmed`, ni `last`.
    assert.equal('confirmed' in (item ?? {}), false);
    assert.equal('last_human_response' in (item ?? {}), false);
  }
});

test('10 · un retrait ne supprime rien de l’histoire', () => {
  sequence = 0;
  const assertion = entry();
  const withdrawal = entry({
    kind: 'RELATION_RECORDED',
    relation: { from_entry_id: formatControversyEntryId(90), to_entry_id: assertion.entry_id, act: 'WITHDRAWS' },
  });

  const model = available(projectControversyReadModel(snapshotOf([assertion, withdrawal])));
  const item = model.items[0];

  assert.equal(item?.entries.length, 2, 'l’assertion visée reste présente');
  assert.deepEqual(item?.entries.map((e) => e.entry_id), [assertion.entry_id, withdrawal.entry_id]);
  // Aucune fusion, aucun état « courant », aucun gagnant.
  assert.equal('current_position' in (item ?? {}), false);
});

// ==========================================================================
// E. Ancrages
// ==========================================================================

test('11 · un ancrage textuel est préservé tel quel, sans décalage ni rendu', () => {
  sequence = 0;
  const anchored = entry({
    anchors: {
      provenance: [{ event_id: 'evt_000010', round: 1 }],
      textual: { event_id: 'evt_000010', quoted_text: 'aa', occurrence: 2 },
    },
  });
  const model = available(
    projectControversyReadModel(snapshotOf([anchored], [{ event_id: 'evt_000010', content: 'aaa' }])),
  );

  const textual = model.items[0]?.entries[0]?.anchors.textual;
  assert.deepEqual(textual, { event_id: 'evt_000010', quoted_text: 'aa', occurrence: 2 });
  assert.equal('start' in (textual ?? {}), false, 'aucun décalage n’est produit');

  // « aa » dans « aaa » : deux occurrences chevauchantes, donc la 2e existe.
  assert.deepEqual(model.items[0]?.unresolvable_anchors, []);
});

test('12 · un ancrage qui ne se résout pas est nommé, avec son motif', () => {
  sequence = 0;
  const cases = [
    { anchor: { event_id: 'evt_999999', quoted_text: 'x', occurrence: 1 }, reason: 'EVENT_NOT_FOUND' },
    { anchor: { event_id: 'evt_000011', quoted_text: 'x', occurrence: 1 }, reason: 'CONTENT_UNAVAILABLE' },
    { anchor: { event_id: 'evt_000010', quoted_text: 'aa', occurrence: 9 }, reason: 'OCCURRENCE_NOT_FOUND' },
  ] as const;

  for (const { anchor, reason } of cases) {
    sequence = 0;
    const anchored = entry({
      anchors: { provenance: [{ event_id: 'evt_000010', round: 1 }], textual: anchor },
    });
    const model = available(
      projectControversyReadModel(
        snapshotOf([anchored], [
          { event_id: 'evt_000010', content: 'aaa' },
          { event_id: 'evt_000011', content: null },
        ]),
      ),
    );

    assert.deepEqual(model.items[0]?.unresolvable_anchors, [
      { entry_id: anchored.entry_id, event_id: anchor.event_id, occurrence: anchor.occurrence, reason },
    ]);
  }
});

// ==========================================================================
// F. Surface HTTP et frontière d'erreur
// ==========================================================================

test('13 · la vue HTTP porte la même vérité que la projection, sous la même révision', async () => {
  const run = await nativeRun();
  try {
    sequence = 0;
    await appendControversyEntry(run.paths, entry({ kind: 'CONTROVERSY_RECORDED' }));
    await appendControversyEntry(run.paths, entry());

    const view = await readNativeRunHttpView({ runsDir: run.runsDir }, RUN_ID);
    const snapshot = await readStableNativeRunSnapshot(run.runsDir, RUN_ID);

    assert.deepEqual(view.controversies, projectControversyReadModel(snapshot));
    assert.equal(view.controversies.availability, 'AVAILABLE');
    if (view.controversies.availability !== 'AVAILABLE') throw new Error('unreachable');
    assert.equal(view.controversies.recorded_count, 1);
    assert.equal(view.controversies.items[0]?.entries.length, 2);

    // La révision de run reste celle du snapshot : V3 ne la déplace pas.
    assert.equal(view.revision, snapshot.revision);
  } finally {
    await run.dispose();
  }
});

test('14 · une corruption du journal ne devient jamais un état à zéro', async () => {
  const run = await nativeRun();
  try {
    sequence = 0;
    const valid = JSON.stringify(entry());
    await writeFile(run.paths.controversies, `${valid}\n{"broken":\n`, 'utf8');

    // La lecture échoue honnêtement, à travers la surface HTTP comme en interne.
    await assert.rejects(() => readNativeRunHttpView({ runsDir: run.runsDir }, RUN_ID));
    await assert.rejects(() => readStableNativeRunSnapshot(run.runsDir, RUN_ID));
  } finally {
    await run.dispose();
  }
});

// ==========================================================================
// G. Gardes de source
// ==========================================================================

async function executable(relative: string): Promise<string> {
  const raw = await readFile(new URL(relative, import.meta.url), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

test('15 · la projection ne relit jamais le journal et n’ouvre aucune source', async () => {
  const code = await executable('../../src/services/controversy-read-model.ts');

  for (const forbidden of [
    'readControversyJournal', 'controversies.jsonl', 'readJsonlJournal',
    'node:fs', 'readFile', 'runPaths', 'readStableNativeRunSnapshot',
    'InvocationLedger', 'invocation-ledger',
  ]) {
    assert.equal(code.includes(forbidden), false, `S3 ne doit pas employer \`${forbidden}\``);
  }
});

test('16 · aucun état, aucun tri, aucun ordre inter-journaux', async () => {
  const code = await executable('../../src/services/controversy-read-model.ts');

  for (const forbidden of [
    'status', 'disposition', 'closure', 'winner', 'converged', 'CONVERGED',
    'resolved', 'RESOLVED', 'position_id', 'same_position', 'current_position',
    'confidence', 'agreement_score', 'resolution_score',
    '.sort(', 'localeCompare', 'timestamp',
  ]) {
    assert.equal(code.includes(forbidden), false, `S3 ne doit pas produire \`${forbidden}\``);
  }

  // Et aucun entrelacement : les événements ne servent qu'à résoudre un ancrage.
  assert.equal(code.includes('recorded_at'), false, 'aucun horodatage n’est consulté');
});
