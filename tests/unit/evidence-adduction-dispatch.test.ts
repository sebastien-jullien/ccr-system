/**
 * V4 · S7-B — dispatch gouverné d'une adduction assistée par modèle.
 *
 * Question de preuve :
 *
 * > **Un fournisseur peut-il obtenir qu'une adduction soit persistée sur un
 * > objet qu'il n'a pas vu, ou faire dire à CCR autre chose que « cet acteur a
 * > adduit ce matériau à propos de cette cible » ?**
 *
 * Quatre propriétés.
 *
 *  1. **L'engagement précède l'appel.** L'adaptateur constate lui-même, à
 *     l'instant où il est invoqué, que son invocation est déjà au ledger — en
 *     version 3, sous le déclencheur `EVIDENCE_ADDUCTION`.
 *  2. **Le verrou n'est pas tenu pendant l'appel.** Une autre mutation du même
 *     run aboutit pendant que l'adaptateur attend : preuve dynamique, jamais
 *     lecture de source.
 *  3. **La liaison prime sur la validité.** `EXISTE MAINTENANT` n'est pas
 *     `A ÉTÉ SOUMIS`. Un objet canonique parfaitement résoluble, mais absent de
 *     l'ensemble soumis en phase A, est refusé — qu'il ait existé avant l'appel
 *     ou qu'il soit apparu pendant.
 *  4. **Tout ou rien.** La matrice s'applique aux `N` propositions avant le
 *     premier octet écrit ; un seul échec laisse zéro adduction.
 *
 * Aucun fournisseur réel : l'adaptateur est une couture de test injectée. Rien
 * ici ne dit quoi que ce soit de la qualité d'une adduction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import { CONTROVERSY_ENTRY_KINDS } from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import { ORIENTATIONS } from '../../src/core/evidence.ts';
import type { AdductionRecordedEntry, EvidenceEntry } from '../../src/core/evidence.ts';
import { INVOCATION_LEDGER_SCHEMA_VERSION_V3 } from '../../src/core/usage-governance.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { readInvocationOutcomes } from '../../src/store/invocation-outcome-store.ts';
import {
  INVOCATION_OUTCOME_SCHEMA_VERSION,
  terminalOutcomeOf,
} from '../../src/core/invocation-outcome.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { readEvidenceJournal } from '../../src/store/evidence-store.ts';
import { readControversyJournal } from '../../src/store/controversy-store.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { readUsageReadModel } from '../../src/services/usage-read-model.ts';
import { readCurrentEvidenceRevision } from '../../src/services/evidence-freshness.ts';
import { recordAssertion, recordControversy } from '../../src/services/controversy-service.ts';
import type { ControversyServiceDeps } from '../../src/services/controversy-service.ts';
import { adduceMaterial, registerMaterial } from '../../src/services/evidence-service.ts';
import type { EvidenceServiceDeps } from '../../src/services/evidence-service.ts';
import {
  ADDUCTION_PROPOSAL_VERSION,
  REVALIDATION_CHECKS,
  adduceMaterialByModel,
  buildAdductionPrompt,
  derivationInputsOf,
  revalidateProposal,
  revalidationContextOf,
} from '../../src/services/evidence-adducer.ts';
import type {
  ModelAdductionDeps,
  ModelAdductionOutcome,
  ProposedAdduction,
  RevalidationContext,
  SubmittedDispatchInputs,
} from '../../src/services/evidence-adducer.ts';

const RUN_ID = 'CCR-20260818-901';

/** Le texte détenu. « le cache » y figure DEUX fois — rangs 1 et 2 réels. */
const HELD_TEXT = 'Mesure : le cache expire en 30 s. Ensuite, le cache est reconstruit.';

const EVENTS: readonly Record<string, unknown>[] = [
  {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-18T09:10:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'S1',
    content: 'Le cache doit expirer rapidement.',
  },
  {
    event_id: 'evt_000002',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-18T09:20:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'challenger',
    session_id: 'S2',
    content: 'Non : le cache reste valide longtemps.',
  },
];

// --------------------------------------------------------------------------
// Harnais — vrai filesystem, vrai verrou, vrai ledger, adaptateur injecté
// --------------------------------------------------------------------------

interface FakeAdapter extends AgentAdapter {
  readonly calls: string[];
}

interface AdapterScript {
  readonly content?: string;
  readonly fail?: Error;
  /** Observé à l'instant exact de l'appel, hors verrou. */
  readonly onCall?: (prompt: string) => Promise<void> | void;
  readonly usage?: AgentTurnResult['usageObservation'];
}

function fakeAdapter(kind: 'claude' | 'codex', script: AdapterScript): FakeAdapter {
  const calls: string[] = [];
  return {
    kind,
    calls,
    async start(prompt: string): Promise<AgentTurnResult> {
      calls.push(prompt);
      await script.onCall?.(prompt);
      if (script.fail !== undefined) throw script.fail;
      return {
        agent: kind,
        sessionId: `adduce-${kind}-1`,
        content: script.content ?? '',
        exitCode: 0,
        startedAt: '2026-08-18T10:00:00.000Z',
        completedAt: '2026-08-18T10:00:01.000Z',
        stdoutRaw: script.content ?? '',
        stderrRaw: '',
        ...(script.usage === undefined ? {} : { usageObservation: script.usage }),
      };
    },
    resume(): Promise<AgentTurnResult> {
      throw new Error('une adduction assistée ne reprend jamais la session d’un expert');
    },
    openInteractive(): never {
      throw new Error('une adduction assistée n’ouvre aucun terminal');
    },
  };
}

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: ModelAdductionDeps;
  readonly evidence: EvidenceServiceDeps;
  readonly controversy: ControversyServiceDeps;
  calls(): number;
  dispose(): Promise<void>;
}

async function harness(script: AdapterScript = {}): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s7b-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-08-18T09:00:00.000Z',
      title: 'S7-B',
      workspace: { cwd: runsDir },
      experts: {
        author: { provider: 'codex', session_id: 'S1' },
        challenger: { provider: 'claude', session_id: 'S2' },
      },
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
      last_event_id: 'evt_000002',
      updated_at: '2026-08-18T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const adapters = { claude: fakeAdapter('claude', script), codex: fakeAdapter('codex', script) };
  let tick = 0;
  const now = (): Date => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 18, 12, 0, tick));
  };

  return {
    runsDir,
    paths,
    deps: { runsDir, now, createAdapters: () => adapters },
    evidence: { runsDir, now },
    controversy: { runsDir, now },
    calls: () => adapters.claude.calls.length + adapters.codex.calls.length,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

interface Seed {
  /** Controverse NOMMÉE — son entrée d'ouverture désigne le périmètre. */
  readonly opening: string;
  readonly a: string;
  readonly b: string;
  /** Entrée d'une AUTRE controverse : existe, canonique, jamais soumise. */
  readonly foreign: string;
  readonly foreignOpening: string;
  /** Matériaux enregistrés. */
  readonly held: string;
  readonly heldEvent: string;
  readonly external: string;
  readonly unsubmitted: string;
}

async function seed(h: Harness): Promise<Seed> {
  const cRev = async (): Promise<string> => (await readControversyJournal(h.paths)).revision;
  const eRev = async (): Promise<string> => readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID);

  const opened = await recordControversy(h.controversy, {
    runId: RUN_ID,
    expected_controversy_revision: await cRev(),
    provenance_event_ids: ['evt_000001'],
    statement: 'Durée de vie du cache',
  });
  const a = await recordAssertion(h.controversy, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: opened.controversy_revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Le TTL doit être court',
  });
  const b = await recordAssertion(h.controversy, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: a.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Le TTL doit être long',
  });
  const other = await recordControversy(h.controversy, {
    runId: RUN_ID,
    expected_controversy_revision: b.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Autre sujet',
  });
  const foreign = await recordAssertion(h.controversy, {
    runId: RUN_ID,
    controversy_id: other.controversy_id,
    expected_controversy_revision: other.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Position étrangère',
  });

  const held = await registerMaterial(h.evidence, {
    runId: RUN_ID,
    expected_evidence_revision: await eRev(),
    representation: { form: 'INLINE_TEXT', text: HELD_TEXT },
    label: 'mesure',
  });
  const heldEvent = await registerMaterial(h.evidence, {
    runId: RUN_ID,
    expected_evidence_revision: held.evidence_revision,
    representation: { form: 'RUN_EVENT', event_id: 'evt_000001' },
  });
  const external = await registerMaterial(h.evidence, {
    runId: RUN_ID,
    expected_evidence_revision: heldEvent.evidence_revision,
    representation: { form: 'EXTERNAL_REFERENCE', locator: 'https://exemple.test/rapport' },
  });
  const unsubmitted = await registerMaterial(h.evidence, {
    runId: RUN_ID,
    expected_evidence_revision: external.evidence_revision,
    representation: { form: 'INLINE_TEXT', text: 'Un autre matériau, jamais soumis.' },
  });

  return {
    opening: opened.entry.entry_id,
    a: a.entry.entry_id,
    b: b.entry.entry_id,
    foreign: foreign.entry.entry_id,
    foreignOpening: other.entry.entry_id,
    held: held.entry.entry_id,
    heldEvent: heldEvent.entry.entry_id,
    external: external.entry.entry_id,
    unsubmitted: unsubmitted.entry.entry_id,
  };
}

function output(proposals: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ adduction_proposal_version: ADDUCTION_PROPOSAL_VERSION, proposals });
}

function proposal(
  materialId: string,
  targetId: string,
  orientation = 'SUPPORTS',
  citation?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    material_id: materialId,
    target_entry_id: targetId,
    orientation,
    ...(citation === undefined ? {} : { citation }),
  };
}

async function request(h: Harness, s: Seed, materialId = s.held): Promise<ModelAdductionOutcome> {
  return adduceMaterialByModel(h.deps, {
    runId: RUN_ID,
    material_id: materialId,
    controversy_opening_entry_id: s.opening,
    expert_slot: 'author',
  });
}

async function adductions(h: Harness): Promise<readonly AdductionRecordedEntry[]> {
  const journal = await readEvidenceJournal(h.paths);
  return journal.entries.filter(
    (e: EvidenceEntry): e is AdductionRecordedEntry => e.kind === 'ADDUCTION_RECORDED',
  );
}

async function modelAdductions(h: Harness): Promise<readonly AdductionRecordedEntry[]> {
  return (await adductions(h)).filter((e) => e.semantic_origin === 'CCR');
}

/** Toutes les clés d'un objet, à toute profondeur. */
function allKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      allKeys(child, into);
    }
  }
  return into;
}

// ==========================================================================
// A. Succès nominal — ce que CCR persiste, et rien de plus
// ==========================================================================

test('1 · T1/T2/T3/T4/T5 — une proposition valide devient une adduction CCR/MODEL_ASSISTED', async () => {
  const h = await harness({
    content: output([
      proposal('mat_000001', 'ctve_000002', 'SUPPORTS', { quoted_text: 'le cache', occurrence: 2 }),
    ]),
  });
  try {
    const s = await seed(h);
    assert.equal(s.held, 'mat_000001');
    assert.equal(s.a, 'ctve_000002');

    const outcome = await request(h, s);
    assert.equal(outcome.kind, 'PERSISTED');
    if (outcome.kind !== 'PERSISTED') return;
    assert.equal(h.calls(), 1);

    const persisted = await modelAdductions(h);
    assert.equal(persisted.length, 1);
    const entry = persisted[0] as AdductionRecordedEntry;

    // T2 · T3 · T4 — la provenance canonique, posée par le serveur.
    assert.equal(entry.semantic_origin, 'CCR');
    assert.equal(entry.derivation?.method, 'MODEL_ASSISTED');
    assert.equal(entry.derivation?.invocation_id, outcome.invocation_id);
    assert.equal(entry.recorded_by, 'CCR');
    assert.equal(entry.kind, 'ADDUCTION_RECORDED');
    assert.equal(entry.target.kind, 'CONTROVERSY_ENTRY');
    assert.equal(entry.target.entry_id, s.a);
    assert.equal(entry.orientation, 'SUPPORTS');
    assert.equal(entry.entry_id, 'add_000001');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(entry.recorded_at), 'horodatage posé par le serveur');
    assert.deepEqual(entry.citation, { quoted_text: 'le cache', occurrence: 2 });

    // Le ledger fait autorité sur l'identité de l'invocation.
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    assert.equal(ledger.lastInvocationId(), outcome.invocation_id);

    // T5 — aucun champ d'infrastructure ni de mérite dans l'entrée canonique.
    // La garde porte sur les CLÉS et sur les VALEURS séparément : `MODEL_ASSISTED`
    // est une METHODE de dérivation, et une garde aveugle à cette distinction
    // produirait un faux positif sur le seul mot que le contrat exige.
    assert.deepEqual([...new Set(allKeys(entry))].sort(), [
      'derivation', 'entry_id', 'inputs', 'invocation_id', 'kind', 'material_id', 'method',
      'occurrence', 'orientation', 'quoted_text', 'recorded_at', 'recorded_by', 'schema_version',
      'semantic_origin', 'target', 'citation',
    ].sort());
    for (const forbidden of [
      'provider', 'model', 'cost', 'tokens', 'usage', 'confidence', 'score', 'reliability',
      'weight', 'sufficiency', 'truth', 'winner', 'closure', 'probability', 'credibility',
      'strength', 'quality',
    ]) {
      assert.equal(allKeys(entry).includes(forbidden), false, `clé « ${forbidden} »`);
    }
    // Aucune identité de fournisseur ne fuit dans une valeur.
    const values = JSON.stringify(entry).toLowerCase().split('model_assisted').join('·');
    for (const vendor of ['claude', 'codex', 'anthropic', 'openai', 'gpt', 'model']) {
      assert.equal(values.includes(vendor), false, `valeur « ${vendor} »`);
    }

    // T28 — la révision rendue vient du store canonique, pas d'un calcul local.
    assert.equal(outcome.evidence_revision, (await readEvidenceJournal(h.paths)).revision);
    assert.equal(
      outcome.evidence_revision,
      await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID),
    );
    assert.ok(outcome.evidence_revision.startsWith('ev-sha256:'), 'espace de noms V4');
  } finally {
    await h.dispose();
  }
});

test('2 · T29/T30 — écrire une adduction assistée ne touche ni le run ni les controverses', async () => {
  const h = await harness({
    content: output([proposal('mat_000001', 'ctve_000002', 'NONE')]),
  });
  try {
    const s = await seed(h);
    const before = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    const ctvBefore = (await readControversyJournal(h.paths)).revision;
    const eventsBefore = await readFile(h.paths.events, 'utf8');

    const outcome = await request(h, s);
    assert.equal(outcome.kind, 'PERSISTED');

    const after = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.equal(after.revision, before.revision, 'révision de run INCHANGÉE');
    assert.equal((await readControversyJournal(h.paths)).revision, ctvBefore, 'révision V3 INCHANGÉE');
    assert.equal(await readFile(h.paths.events, 'utf8'), eventsBefore, 'events.jsonl intact');
    assert.notEqual(after.evidence_revision, before.evidence_revision, 'la révision V4 a bougé');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// B. Refus de périmètre — AVANT tout engagement
// ==========================================================================

test('3 · T6 — EXTERNAL_REFERENCE : aucun dispatch, aucun engagement', async () => {
  const h = await harness({ content: output([]) });
  try {
    const s = await seed(h);
    await assert.rejects(
      () => request(h, s, s.external),
      (error: unknown) =>
        isCcrError(error) &&
        (error.details as { reason?: string } | undefined)?.reason === 'MATERIAL_NOT_HELD',
    );
    assert.equal(h.calls(), 0, 'aucun adaptateur approché');
    assert.equal(existsSync(h.paths.invocations), false, 'aucune invocation engagée');
    assert.equal((await modelAdductions(h)).length, 0);

    // Et la voie HUMAINE sur le MÊME matériau reste ouverte : le refus porte sur
    // la demande assistée, jamais sur l'adductibilité du matériau.
    const human = await adduceMaterial(h.evidence, {
      runId: RUN_ID,
      expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID),
      material_id: s.external,
      target_entry_id: s.a,
      orientation: 'SUPPORTS',
    });
    assert.equal(human.entry.kind, 'ADDUCTION_RECORDED');
    assert.equal(h.calls(), 0);
  } finally {
    await h.dispose();
  }
});

test('4 · périmètre — matériau inconnu, controverse inconnue, `ctv_` refusé', async () => {
  const h = await harness({ content: output([]) });
  try {
    const s = await seed(h);
    const cases: readonly (readonly [string, string, string])[] = [
      ['mat_999999', s.opening, 'MATERIAL_NOT_FOUND'],
      ['pas-un-id', s.opening, 'MATERIAL_NOT_FOUND'],
      [s.held, 'ctve_999999', 'CONTROVERSY_NOT_FOUND'],
      // Une entrée qui existe mais n'ouvre AUCUNE controverse.
      [s.held, s.a, 'CONTROVERSY_NOT_FOUND'],
      // `ctv_` désigne un agrégat : jamais un périmètre nommable ici.
      [s.held, 'ctv_000001', 'CONTROVERSY_NOT_FOUND'],
    ];
    for (const [material_id, controversy_opening_entry_id, reason] of cases) {
      await assert.rejects(
        () =>
          adduceMaterialByModel(h.deps, {
            runId: RUN_ID,
            material_id,
            controversy_opening_entry_id,
            expert_slot: 'author',
          }),
        (error: unknown) =>
          isCcrError(error) &&
          (error.details as { reason?: string } | undefined)?.reason === reason,
        `${material_id} · ${controversy_opening_entry_id}`,
      );
    }
    assert.equal(h.calls(), 0);
    assert.equal(existsSync(h.paths.invocations), false);
  } finally {
    await h.dispose();
  }
});

test('5 · T7 — quota épuisé : refus avant tout engagement et tout appel', async () => {
  const h = await harness({ content: output([]) });
  try {
    const s = await seed(h);
    await openInvocationPolicyStore(h.paths).create(0);

    await assert.rejects(
      () => request(h, s),
      (error: unknown) => isCcrError(error) && error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED',
    );

    assert.equal(h.calls(), 0, 'aucun adaptateur approché');
    assert.equal(existsSync(h.paths.invocations), false, 'aucune invocation engagée');
    assert.equal((await modelAdductions(h)).length, 0);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// C. Gouvernance — engagement, ordre, verrou
// ==========================================================================

test('6 · T8/T9 — l’adaptateur constate son engagement DÉJÀ durable, en version 3', async () => {
  let observed: Record<string, unknown> | undefined;
  let pathsRef!: RunPaths;
  const h = await harness({
    content: output([]),
    onCall: async () => {
      // Lecture du ledger À L'INSTANT de l'appel : preuve dynamique d'ordre.
      const raw = await readFile(pathsRef.invocations, 'utf8');
      observed = JSON.parse(raw.trim().split('\n')[0] as string) as Record<string, unknown>;
    },
  });
  pathsRef = h.paths;
  try {
    const s = await seed(h);
    const outcome = await adduceMaterialByModel(h.deps, {
      runId: RUN_ID,
      material_id: s.held,
      controversy_opening_entry_id: s.opening,
      expert_slot: 'challenger',
    });

    assert.equal(h.calls(), 1);
    assert.ok(observed !== undefined, 'le ledger était lisible PENDANT l’appel');
    assert.equal(observed['kind'], 'DISPATCH_COMMITTED');
    assert.equal(observed['trigger_kind'], 'EVIDENCE_ADDUCTION');
    assert.equal(observed['schema_version'], INVOCATION_LEDGER_SCHEMA_VERSION_V3);
    assert.equal(observed['schema_version'], 3);
    assert.equal(observed['invocation_id'], outcome.invocation_id);
    assert.deepEqual(observed['identity'], {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'challenger',
      provider: 'claude',
    });

    // L'identifiant vient de la gouvernance CCR, jamais du fournisseur.
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    assert.equal(ledger.count(), 1);
    assert.equal(ledger.lastInvocationId(), outcome.invocation_id);
  } finally {
    await h.dispose();
  }
});

test('7 · T10/T19 — le verrou de run n’est PAS tenu pendant l’appel', async () => {
  let concurrentDone = false;
  let seedRef!: Seed;
  let hRef!: Harness;

  const h = await harness({
    content: output([]),
    onCall: async () => {
      // Pendant que l'adaptateur attend, une autre mutation native du MÊME run
      // doit pouvoir acquérir `.ccr.lock`. Si la phase B le tenait, cet appel
      // échouerait en RUN_ALREADY_LOCKED et le test tomberait.
      await recordAssertion(hRef.controversy, {
        runId: RUN_ID,
        controversy_id: (await readControversyJournal(hRef.paths)).entries
          .filter((e) => e.kind === 'CONTROVERSY_RECORDED')
          .map((e) => e.controversy_id)[0] as string,
        expected_controversy_revision: (await readControversyJournal(hRef.paths)).revision,
        provenance_event_ids: ['evt_000001'],
        statement: 'Position écrite PENDANT l’appel fournisseur',
      });
      concurrentDone = true;
    },
  });
  hRef = h;
  try {
    seedRef = await seed(h);
    const before = (await readControversyJournal(h.paths)).entries.length;

    const outcome = await request(h, seedRef);

    assert.equal(concurrentDone, true, 'la mutation concurrente a bien abouti');
    assert.equal(outcome.kind, 'VALID_ZERO');
    assert.equal(h.calls(), 1);

    // L'entrée écrite pendant la phase B est bien là : la phase C a relu.
    const after = (await readControversyJournal(h.paths)).entries;
    assert.equal(after.length, before + 1);
    assert.equal(after.at(-1)?.kind, 'ASSERTION_RECORDED');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// D. Les quatre issues d'échec, et l'issue de succès
// ==========================================================================

test('8 · T12 — PROVIDER_FAILED : zéro adduction, engagement conservé, zéro reprise', async () => {
  const h = await harness({ fail: new Error('le fournisseur n’a pas répondu') });
  try {
    const s = await seed(h);
    const outcome = await request(h, s);

    assert.equal(outcome.kind, 'PROVIDER_FAILED');
    assert.equal(h.calls(), 1, 'un seul appel, jamais deux');
    assert.equal((await modelAdductions(h)).length, 0);

    // L'engagement est un fait durable : il ne s'efface pas parce que la suite
    // a échoué. Et il n'est jamais converti en « rien n'a été consommé ».
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    assert.equal(ledger.count(), 1);
    if (outcome.kind === 'PROVIDER_FAILED') {
      assert.equal(ledger.lastInvocationId(), outcome.invocation_id);
    }
  } finally {
    await h.dispose();
  }
});

test('9 · T13 — INVALID_OUTPUT : zéro adduction, zéro second appel', async () => {
  for (const raw of [
    'ceci n’est pas du JSON',
    '```json\n{"adduction_proposal_version":1,"proposals":[]}\n```',
    JSON.stringify({ adduction_proposal_version: 1, proposals: [{ material_id: 'mat_000001', target_entry_id: 'ctve_000002', orientation: 'SUPPORTS', confidence: 0.9 }] }),
    JSON.stringify({ adduction_proposal_version: 9, proposals: [] }),
  ]) {
    const h = await harness({ content: raw });
    try {
      const s = await seed(h);
      const outcome = await request(h, s);
      assert.equal(outcome.kind, 'INVALID_OUTPUT', raw.slice(0, 40));
      assert.equal(h.calls(), 1, 'aucune seconde tentative, aucune demande de correction');
      assert.equal((await modelAdductions(h)).length, 0);
      assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1);
      if (outcome.kind === 'INVALID_OUTPUT') {
        assert.ok(outcome.reason.length > 0, 'motif exigé');
        assert.ok(outcome.at.length > 0, 'position exigée');
      }
    } finally {
      await h.dispose();
    }
  }
});

test('10 · T14 — VALID_ZERO : succès opérationnel, zéro adduction, zéro reprise', async () => {
  const h = await harness({ content: output([]) });
  try {
    const s = await seed(h);
    const outcome = await request(h, s);

    assert.equal(outcome.kind, 'VALID_ZERO');
    assert.equal(h.calls(), 1);
    assert.equal((await modelAdductions(h)).length, 0);
    assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1);

    // VALID_ZERO n'est pas INVALID_OUTPUT, et n'est pas PROVIDER_FAILED. Il ne
    // dit ni « aucune preuve », ni « accord », ni « rien de pertinent ».
    assert.equal('reason' in outcome, false);
    assert.equal('error_code' in outcome, false);
    assert.equal('entries' in outcome, false);

    // I — issue durable, version courante, aucun objet de domaine inventé.
    const document = await readInvocationOutcomes(h.paths);
    assert.equal(document.outcomes.length, 1);
    assert.equal(document.outcomes[0]?.invocation_id, outcome.invocation_id);
    assert.equal(document.outcomes[0]?.schema_version, INVOCATION_OUTCOME_SCHEMA_VERSION);
    const fact = document.outcomes[0];
    assert.ok(fact !== undefined);
    assert.deepEqual(terminalOutcomeOf(fact), { kind: 'VALID_ZERO' });
  } finally {
    await h.dispose();
  }
});

test('11 · T31 — l’usage reste honnête : UNOBSERVED n’est jamais un zéro', async () => {
  // Sans observation fournisseur.
  const silent = await harness({ content: output([]) });
  try {
    const s = await seed(silent);
    const outcome = await request(silent, s);
    const usage = await readUsageReadModel(silent.paths);
    const view = usage.by_invocation.find((i) => i.invocation_id === outcome.invocation_id);
    assert.ok(view !== undefined, 'l’invocation est visible');
    assert.equal(view.trigger_kind, 'EVIDENCE_ADDUCTION');
    assert.equal(view.provider_reported.state, 'UNOBSERVED');
    assert.equal(view.provider_reported.observation, undefined, 'aucun zéro fabriqué');
  } finally {
    await silent.dispose();
  }

  // Avec observation fournisseur : les primitives existantes la portent.
  const observed = await harness({
    content: output([]),
    // Observation RÉELLEMENT typée : la conversion masquait une forme qui
    // n'était pas une `UsageObservation` — ni `provider`, ni `raw` n'existent,
    // et `model` est une union discriminée, pas une chaîne.
    usage: {
      model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-x' },
      tokens: {
        provider: 'claude',
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    },
  });
  try {
    const s = await seed(observed);
    const outcome = await request(observed, s);
    const usage = await readUsageReadModel(observed.paths);
    const view = usage.by_invocation.find((i) => i.invocation_id === outcome.invocation_id);
    assert.equal(view?.provider_reported.state, 'OBSERVED');
  } finally {
    await observed.dispose();
  }
});

// ==========================================================================
// E. La matrice §17.2 — les sept contrôles de phase C
// ==========================================================================

/** Contexte de revalidation réel, construit depuis un run réel. */
async function contextOf(h: Harness): Promise<{ ctx: RevalidationContext; snapshot: NativeRunSnapshot }> {
  const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
  return { ctx: revalidationContextOf(snapshot), snapshot };
}

function submitted(materials: readonly string[], targets: readonly string[]): SubmittedDispatchInputs {
  return { materials, targets };
}

function proposed(
  material_id: string,
  target_entry_id: string,
  orientation: ProposedAdduction['orientation'] = 'NONE',
  citation?: ProposedAdduction['citation'],
): ProposedAdduction {
  return {
    material_id,
    target_entry_id,
    orientation,
    ...(citation === undefined ? {} : { citation }),
  };
}

test('12 · T16 — les SEPT contrôles échouent individuellement, et sont nommés', async () => {
  const h = await harness();
  try {
    const s = await seed(h);
    const { ctx } = await contextOf(h);
    const full = submitted([s.held], [s.opening, s.a, s.b]);

    // V6 — le matériau existe, mais n'a pas été soumis.
    assert.equal(
      revalidateProposal(ctx, full, proposed(s.unsubmitted, s.a), 'p')?.check,
      'V6',
    );
    // V7 — la cible existe, appartient au run, mais n'a pas été soumise.
    assert.equal(revalidateProposal(ctx, full, proposed(s.held, s.foreign), 'p')?.check, 'V7');

    // V2 — soumis, mais ne résout pas dans le journal V4.
    assert.equal(
      revalidateProposal(ctx, submitted(['mat_009999'], [s.a]), proposed('mat_009999', s.a), 'p')
        ?.check,
      'V2',
    );
    // V4 — soumis, mais ne résout pas dans le journal V3.
    assert.equal(
      revalidateProposal(ctx, submitted([s.held], ['ctve_009999']), proposed(s.held, 'ctve_009999'), 'p')
        ?.check,
      'V4',
    );

    // V5 — une sorte d'entrée V3 que V4 ne sait pas viser. Contexte fabriqué :
    // aucune sixième sorte n'existe aujourd'hui, et c'est précisément ce que ce
    // contrôle protège si V3 en ajoutait une.
    const futureKind = {
      ...(ctx.controversyEntriesById.get(s.a) as ControversyEntry),
      kind: 'FUTURE_KIND_RECORDED',
    } as unknown as ControversyEntry;
    const forged: RevalidationContext = {
      materialsById: ctx.materialsById,
      controversyEntriesById: new Map([[s.a, futureKind]]),
      events: ctx.events,
    };
    assert.equal(revalidateProposal(forged, full, proposed(s.held, s.a), 'p')?.check, 'V5');

    // V9 — citation sur un matériau non détenu.
    assert.equal(
      revalidateProposal(
        ctx,
        submitted([s.external], [s.a]),
        proposed(s.external, s.a, 'NONE', { quoted_text: 'x', occurrence: 1 }),
        'p',
      )?.check,
      'V9',
    );
    // V10 — citation bien formée, rang inexistant.
    assert.equal(
      revalidateProposal(
        ctx,
        full,
        proposed(s.held, s.a, 'NONE', { quoted_text: 'le cache', occurrence: 3 }),
        'p',
      )?.check,
      'V10',
    );

    // Et une proposition entièrement recevable ne produit aucun refus.
    assert.equal(
      revalidateProposal(
        ctx,
        full,
        proposed(s.held, s.a, 'SUPPORTS', { quoted_text: 'le cache', occurrence: 2 }),
        'p',
      ),
      undefined,
    );

    // Les sept, et eux seuls. `V1`, `V3`, `V8`, `V11` appartiennent au parseur.
    assert.deepEqual([...REVALIDATION_CHECKS], ['V2', 'V4', 'V5', 'V6', 'V7', 'V9', 'V10']);
  } finally {
    await h.dispose();
  }
});

test('13 · T34 — V6 et V7 PRÉCÈDENT la validation canonique', async () => {
  const h = await harness();
  try {
    const s = await seed(h);
    const { ctx } = await contextOf(h);
    const full = submitted([s.held], [s.opening, s.a, s.b]);

    // Ces deux propositions violent DEUX contrôles chacune. L'ordre décide du
    // motif rendu — et l'ordre inverse laisserait passer une proposition hors
    // périmètre au seul motif qu'elle est par ailleurs canoniquement valide.
    assert.equal(revalidateProposal(ctx, full, proposed('mat_009999', s.a), 'p')?.check, 'V6');
    assert.equal(revalidateProposal(ctx, full, proposed(s.held, 'ctve_009999'), 'p')?.check, 'V7');

    // La réciproque : soumis mais non résolvable donne bien V2 / V4.
    assert.equal(
      revalidateProposal(ctx, submitted(['mat_009999'], [s.a]), proposed('mat_009999', s.a), 'p')?.check,
      'V2',
    );
  } finally {
    await h.dispose();
  }
});

test('14 · T17/T40-A — EXISTE AVANT mais NON SOUMIS → REVALIDATION_REFUSED', async () => {
  // La cible appartient à une AUTRE controverse du même run. Elle existait avant
  // la phase A, elle est canonique, elle résout parfaitement en phase C.
  const h = await harness({
    content: output([proposal('mat_000001', 'ctve_000004', 'OBJECTS_TO')]),
  });
  try {
    const s = await seed(h);
    assert.equal(s.foreignOpening, 'ctve_000004', 'la cible étrangère existe bien');

    const outcome = await request(h, s);
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') assert.equal(outcome.check, 'V7');
    assert.equal((await modelAdductions(h)).length, 0, 'aucune adduction persistée');
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }

  // Même preuve côté matériau : enregistré avant, jamais soumis.
  const hm = await harness({
    content: output([proposal('mat_000004', 'ctve_000002', 'SUPPORTS')]),
  });
  try {
    const s = await seed(hm);
    assert.equal(s.unsubmitted, 'mat_000004');
    const outcome = await request(hm, s);
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') assert.equal(outcome.check, 'V6');
    assert.equal((await modelAdductions(hm)).length, 0);
  } finally {
    await hm.dispose();
  }
});

test('15 · T18/T40-B — AJOUTÉ PENDANT l’appel → REVALIDATION_REFUSED', async () => {
  let addedId: string | undefined;
  let hRef!: Harness;

  const h = await harness({
    // Le fournisseur nomme une entrée qui n'existait PAS en phase A.
    content: output([proposal('mat_000001', 'ctve_000006', 'SUPPORTS')]),
    onCall: async () => {
      // Mutation concurrente PENDANT l'appel — elle prouve aussi que le verrou
      // est libre. L'entrée créée appartient à la controverse soumise et sera
      // parfaitement canonique en phase C.
      const journal = await readControversyJournal(hRef.paths);
      const controversyId = journal.entries
        .filter((e) => e.kind === 'CONTROVERSY_RECORDED')
        .map((e) => e.controversy_id)[0] as string;
      const added = await recordAssertion(hRef.controversy, {
        runId: RUN_ID,
        controversy_id: controversyId,
        expected_controversy_revision: journal.revision,
        provenance_event_ids: ['evt_000001'],
        statement: 'Entrée apparue pendant l’appel fournisseur',
      });
      addedId = added.entry.entry_id;
    },
  });
  hRef = h;
  try {
    const s = await seed(h);
    const outcome = await request(h, s);

    assert.equal(addedId, 'ctve_000006', 'l’entrée a bien été ajoutée pendant la phase B');

    // Elle EXISTE, elle appartient à la controverse, elle résout — et elle est
    // refusée : elle n'a pas été soumise.
    const { ctx } = await contextOf(h);
    assert.ok(ctx.controversyEntriesById.has('ctve_000006'), 'canonique en phase C');

    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') assert.equal(outcome.check, 'V7');
    assert.equal((await modelAdductions(h)).length, 0);
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});

test('16 · T20/T37 — les entrées de dérivation sont celles de la PHASE A', async () => {
  let hRef!: Harness;
  const h = await harness({
    content: output([proposal('mat_000001', 'ctve_000002', 'SUPPORTS')]),
    onCall: async () => {
      // Le run s'enrichit pendant l'appel : une entrée de plus, un matériau de
      // plus. Rien de tout cela ne doit apparaître dans la dérivation.
      const journal = await readControversyJournal(hRef.paths);
      await recordAssertion(hRef.controversy, {
        runId: RUN_ID,
        controversy_id: journal.entries
          .filter((e) => e.kind === 'CONTROVERSY_RECORDED')
          .map((e) => e.controversy_id)[0] as string,
        expected_controversy_revision: journal.revision,
        provenance_event_ids: ['evt_000001'],
        statement: 'Ajout concurrent',
      });
      await registerMaterial(hRef.evidence, {
        runId: RUN_ID,
        expected_evidence_revision: await readCurrentEvidenceRevision(
          { runsDir: hRef.runsDir },
          RUN_ID,
        ),
        representation: { form: 'INLINE_TEXT', text: 'Matériau concurrent' },
      });
    },
  });
  hRef = h;
  try {
    const s = await seed(h);
    const outcome = await request(h, s);
    assert.equal(outcome.kind, 'PERSISTED');

    const entry = (await modelAdductions(h))[0] as AdductionRecordedEntry;
    // EXACTEMENT l'ensemble soumis : un matériau, trois entrées.
    assert.deepEqual([...(entry.derivation?.inputs ?? [])], [s.held, s.opening, s.a, s.b]);
    assert.deepEqual(
      [...(entry.derivation?.inputs ?? [])],
      [...derivationInputsOf(submitted([s.held], [s.opening, s.a, s.b]))],
      'AUTORITÉ DE LIAISON = AUTORITÉ DES ENTRÉES DE DÉRIVATION',
    );
    // Ni l'entrée, ni le matériau apparus pendant l'appel.
    assert.equal(entry.derivation?.inputs.includes('ctve_000006'), false);
    assert.equal(entry.derivation?.inputs.includes('mat_000005'), false);
  } finally {
    await h.dispose();
  }
});

test('17 · T21 — citation de forme valide, occurrence absente → REVALIDATION_REFUSED', async () => {
  const h = await harness({
    content: output([
      proposal('mat_000001', 'ctve_000002', 'SUPPORTS', { quoted_text: 'le cache', occurrence: 3 }),
    ]),
  });
  try {
    const s = await seed(h);
    const outcome = await request(h, s);

    // Le parseur avait accepté la FORME. La phase C confronte le texte.
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') assert.equal(outcome.check, 'V10');
    assert.equal((await modelAdductions(h)).length, 0);
  } finally {
    await h.dispose();
  }

  // Rang 1 et rang 2 existent réellement : le refus n'est pas un refus de tout.
  const ok = await harness({
    content: output([
      proposal('mat_000001', 'ctve_000002', 'SUPPORTS', { quoted_text: 'le cache', occurrence: 1 }),
      proposal('mat_000001', 'ctve_000003', 'SUPPORTS', { quoted_text: 'le cache', occurrence: 2 }),
    ]),
  });
  try {
    const s = await seed(ok);
    const outcome = await request(ok, s);
    assert.equal(outcome.kind, 'PERSISTED');
    assert.equal((await modelAdductions(ok)).length, 2, 'les rangs 1 et 2 existent bien');
  } finally {
    await ok.dispose();
  }
});

test('18 · V9/V10 sur un matériau RUN_EVENT — le contenu vient de l’événement', async () => {
  const h = await harness({
    content: output([
      proposal('mat_000002', 'ctve_000002', 'OBJECTS_TO', {
        quoted_text: 'Le cache doit expirer',
        occurrence: 1,
      }),
    ]),
  });
  try {
    const s = await seed(h);
    assert.equal(s.heldEvent, 'mat_000002');
    const outcome = await adduceMaterialByModel(h.deps, {
      runId: RUN_ID,
      material_id: s.heldEvent,
      controversy_opening_entry_id: s.opening,
      expert_slot: 'author',
    });
    assert.equal(outcome.kind, 'PERSISTED');
    const entry = (await modelAdductions(h))[0] as AdductionRecordedEntry;
    assert.deepEqual(entry.citation, { quoted_text: 'Le cache doit expirer', occurrence: 1 });
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// F. Tout ou rien, ordre, histoire
// ==========================================================================

test('19 · T25 — une proposition fautive parmi N laisse ZÉRO adduction du lot', async () => {
  const h = await harness({
    content: output([
      proposal('mat_000001', 'ctve_000002', 'SUPPORTS'),
      proposal('mat_000001', 'ctve_000003', 'NONE'),
      // La troisième vise une entrée jamais soumise.
      proposal('mat_000001', 'ctve_000005', 'OBJECTS_TO'),
    ]),
  });
  try {
    const s = await seed(h);
    const before = await readFile(h.paths.evidence, 'utf8');

    const outcome = await request(h, s);
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') {
      assert.equal(outcome.check, 'V7');
      assert.equal(outcome.at, 'proposals[2].target_entry_id');
    }

    // MODEL_ASSISTED_ADDUCTIONS_PERSISTED = 0 pour ce lot. Pas N-1 : zéro.
    assert.equal((await modelAdductions(h)).length, 0);
    assert.equal(await readFile(h.paths.evidence, 'utf8'), before, 'pas un octet écrit');
  } finally {
    await h.dispose();
  }
});

test('20 · T26/T33 — plusieurs propositions valides : toutes, dans l’ordre rendu', async () => {
  const h = await harness({
    content: output([
      proposal('mat_000001', 'ctve_000003', 'OBJECTS_TO'),
      proposal('mat_000001', 'ctve_000001', 'NONE'),
      proposal('mat_000001', 'ctve_000002', 'SUPPORTS'),
    ]),
  });
  try {
    const s = await seed(h);
    const outcome = await request(h, s);
    assert.equal(outcome.kind, 'PERSISTED');
    if (outcome.kind !== 'PERSISTED') return;
    assert.equal(outcome.entries.length, 3);

    const persisted = await modelAdductions(h);
    assert.equal(persisted.length, 3);

    // Ordre du lot préservé — aucun tri, aucun regroupement.
    assert.deepEqual(
      persisted.map((e) => e.target.entry_id),
      ['ctve_000003', 'ctve_000001', 'ctve_000002'],
    );
    // Identités allouées par le serveur, séquentielles, jamais devinées.
    assert.deepEqual(
      persisted.map((e) => e.entry_id),
      ['add_000001', 'add_000002', 'add_000003'],
    );
    // Une seule invocation pour le lot, la même dans les trois dérivations.
    const ids = new Set(persisted.map((e) => e.derivation?.invocation_id));
    assert.equal(ids.size, 1);
    assert.equal([...ids][0], outcome.invocation_id);
  } finally {
    await h.dispose();
  }
});

test('21 · T27/T34 — aucune déduplication contre l’histoire', async () => {
  const h = await harness({
    content: output([proposal('mat_000001', 'ctve_000002', 'SUPPORTS')]),
  });
  try {
    const s = await seed(h);

    // Une adduction HUMAINE strictement identique existe déjà.
    await adduceMaterial(h.evidence, {
      runId: RUN_ID,
      expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID),
      material_id: s.held,
      target_entry_id: s.a,
      orientation: 'SUPPORTS',
    });

    const first = await request(h, s);
    assert.equal(first.kind, 'PERSISTED');

    // Puis une SECONDE demande assistée, rigoureusement identique.
    const second = await request(h, s);
    assert.equal(second.kind, 'PERSISTED');

    const all = await adductions(h);
    assert.equal(all.length, 3, 'trois faits historiques distincts');
    assert.equal(all.filter((e) => e.semantic_origin === 'HUMAN').length, 1);
    assert.equal(all.filter((e) => e.semantic_origin === 'CCR').length, 2);

    // Trois identités distinctes, aucune réutilisée.
    assert.equal(new Set(all.map((e) => e.entry_id)).size, 3);
    // Deux invocations distinctes : aucun rejeu, aucune « adduction courante ».
    const invocations = new Set(
      all.filter((e) => e.semantic_origin === 'CCR').map((e) => e.derivation?.invocation_id),
    );
    assert.equal(invocations.size, 2);
    assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 2);
    assert.equal(h.calls(), 2, 'deux gestes, deux appels — jamais une reprise');
  } finally {
    await h.dispose();
  }
});

test('22 · T22/T23/T24 — les trois orientations persistent SANS vérité dérivée', async () => {
  for (const [orientation, target] of [
    ['SUPPORTS', 'ctve_000002'],
    ['OBJECTS_TO', 'ctve_000003'],
    ['NONE', 'ctve_000001'],
  ] as const) {
    const h = await harness({ content: output([proposal('mat_000001', target, orientation)]) });
    try {
      const s = await seed(h);
      const outcome = await request(h, s);
      assert.equal(outcome.kind, 'PERSISTED', orientation);

      const entry = (await modelAdductions(h))[0] as AdductionRecordedEntry;
      assert.equal(entry.orientation, orientation);

      // L'orientation est attribuée, jamais validée. Rien dans l'entrée ne dit
      // que SUPPORTS est correct, que OBJECTS_TO est correct, que la cible est
      // vraie ou fausse, ni que NONE signifie « sans pertinence ».
      const keys = Object.keys(entry).sort();
      assert.deepEqual(keys, [
        'derivation', 'entry_id', 'kind', 'material_id', 'orientation', 'recorded_at',
        'recorded_by', 'schema_version', 'semantic_origin', 'target',
      ]);
    } finally {
      await h.dispose();
    }
  }
  assert.deepEqual([...ORIENTATIONS], ['NONE', 'SUPPORTS', 'OBJECTS_TO']);
});

// ==========================================================================
// G. Gardes de frontière
// ==========================================================================

test('23 · T32 — aucun pending_operation, aucune Recovery, aucune reprise', async () => {
  for (const script of [
    { content: output([proposal('mat_000001', 'ctve_000002', 'SUPPORTS')]) },
    { content: output([]) },
    { content: 'illisible' },
    { content: output([proposal('mat_000001', 'ctve_000005', 'NONE')]) },
    { fail: new Error('panne') },
  ]) {
    const h = await harness(script);
    try {
      const s = await seed(h);
      const before = JSON.parse(await readFile(h.paths.state, 'utf8')) as Record<string, unknown>;
      await request(h, s);
      const after = JSON.parse(await readFile(h.paths.state, 'utf8')) as Record<string, unknown>;

      assert.equal(after['pending_operation'], null, 'aucun pending_operation');
      assert.equal(after['state'], before['state'], 'la machine à états native n’a pas bougé');
      assert.equal(after['control'], before['control']);
      assert.equal(after['round'], before['round']);
      assert.equal(h.calls(), 1, 'AT_MOST(1) — jamais deux');
    } finally {
      await h.dispose();
    }
  }
});

test('24 · T33 — aucune surface publique ne nomme le pipeline', async () => {
  const roots = ['cli/main.ts', 'cli/native-dispatch.ts', 'cockpit/server.ts', 'cockpit/mutations-http.ts'];
  for (const relative of roots) {
    const url = new URL(`../../src/${relative}`, import.meta.url);
    let code: string;
    try {
      code = await readFile(url, 'utf8');
    } catch {
      continue;
    }
    // Depuis l'activation post-S10, `cli/main.ts` importe légitimement la PORTE
    // publique et le module qui la porte. Ce qui reste interdit partout — et
    // c'est ce que cette garde protège — est le SERVICE interne et la voie
    // d'acceptation du gate.
    for (const token of [
      'adduceMaterialByModel',
      'runControlledAcceptanceAdduction',
      'S10_REAL_ADDUCTION_ACCEPTANCE',
    ]) {
      assert.equal(code.includes(token), false, `${relative} : « ${token} »`);
    }
    if (relative !== 'cli/main.ts') {
      for (const token of ['evidence-adducer', 'requestModelAdduction', 'EVIDENCE_ADDUCTION']) {
        assert.equal(code.includes(token), false, `${relative} : « ${token} »`);
      }
    }
  }
});

/**
 * Garde de mérite — en deux morceaux, et c'est délibéré.
 *
 * La DEMANDE adressée au modèle a le droit de nommer ce qu'elle refuse : « ni
 * confiance, ni score » est une interdiction, pas un champ. Une garde aveugle à
 * cette distinction produirait un faux positif sur une phrase honnête — c'est
 * exactement l'erreur que les trois gardes de S8 V3 avaient commise.
 *
 * Le CODE, lui, ne doit contenir aucun de ces mots, sous aucune forme.
 */
test('25 · T29 — aucune évaluation de mérite dans le CODE de la section 2/3', async () => {
  const raw = await readFile(new URL('../../src/services/evidence-adducer.ts', import.meta.url), 'utf8');
  const start = raw.indexOf('// SECTION 2/3');
  assert.ok(start > 0);

  const promptStart = raw.indexOf('export function buildAdductionPrompt', start);
  const promptEnd = raw.indexOf('\n}\n', promptStart);
  assert.ok(promptStart > start && promptEnd > promptStart, 'la demande est délimitée');

  const code = (raw.slice(start, promptStart) + raw.slice(promptEnd))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  const MERITS = [
    'confidence', 'score', 'reliability', 'credibility', 'weight', 'strength', 'sufficiency',
    'truth', 'probability', 'winner', 'closure', 'quality', 'convincing', 'ranking', 'threshold',
    'CONVERGED', 'PARTIALLY_VALIDATED', 'PARTIAL_SUCCESS', 'PENDING_REVIEW', 'PROVISIONAL',
    'RETRYING', 'RECOVERING', 'pending_operation', 'Recovery', 'retry',
    'UNKNOWN_AFTER_COMMITMENT',
  ];
  for (const token of MERITS) {
    assert.equal(code.includes(token), false, `code de la section 2/3 : « ${token} »`);
  }

  // Et la DEMANDE les nomme, mais uniquement pour les interdire : aucun ne
  // figure comme clé JSON dans le gabarit qu'elle donne au modèle.
  const prompt = buildAdductionPrompt('mat_000001', 'texte détenu', []);
  assert.ok(prompt.includes('ni confiance, ni score'), 'la demande interdit explicitement');
  for (const token of MERITS) {
    assert.equal(prompt.includes(`"${token}"`), false, `gabarit : clé « ${token} »`);
  }
  // Le gabarit ne demande que les quatre champs du protocole.
  for (const key of ['"material_id"', '"target_entry_id"', '"orientation"', '"citation"']) {
    assert.ok(prompt.includes(key), `gabarit : ${key}`);
  }
  assert.ok(prompt.includes('"adduction_proposal_version": 1'), 'gabarit versionné');
});

test('26 · l’occurrence se compte de la même manière sur les trois chemins', async () => {
  // Chevauchements compris, rang 1-based : la reprise se fait à `start + 1`.
  const h = await harness({
    content: output([
      proposal('mat_000001', 'ctve_000002', 'NONE', { quoted_text: 'aaa', occurrence: 2 }),
    ]),
  });
  try {
    // Un matériau dont le texte contient trois occurrences CHEVAUCHANTES.
    const s = await seed(h);
    const created = await registerMaterial(h.evidence, {
      runId: RUN_ID,
      expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID),
      representation: { form: 'INLINE_TEXT', text: 'aaaaa' },
    });
    const { ctx } = await contextOf(h);
    const full = submitted([created.entry.entry_id], [s.a]);

    for (const occurrence of [1, 2, 3]) {
      assert.equal(
        revalidateProposal(
          ctx,
          full,
          proposed(created.entry.entry_id, s.a, 'NONE', { quoted_text: 'aaa', occurrence }),
          'p',
        ),
        undefined,
        `rang ${String(occurrence)} existe`,
      );
    }
    assert.equal(
      revalidateProposal(
        ctx,
        full,
        proposed(created.entry.entry_id, s.a, 'NONE', { quoted_text: 'aaa', occurrence: 4 }),
        'p',
      )?.check,
      'V10',
    );

    // La voie HUMAINE de S4 compte exactement pareil : trois rangs, pas quatre.
    await adduceMaterial(h.evidence, {
      runId: RUN_ID,
      expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID),
      material_id: created.entry.entry_id,
      target_entry_id: s.a,
      orientation: 'NONE',
      citation: { quoted_text: 'aaa', occurrence: 3 },
    });
    const freshRevision = await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID);
    await assert.rejects(
      () =>
        adduceMaterial(h.evidence, {
          runId: RUN_ID,
          expected_evidence_revision: freshRevision,
          material_id: created.entry.entry_id,
          target_entry_id: s.a,
          orientation: 'NONE',
          citation: { quoted_text: 'aaa', occurrence: 4 },
        }),
      (error: unknown) =>
        isCcrError(error) &&
        (error.details as { reason?: string } | undefined)?.reason ===
          'CITATION_OCCURRENCE_NOT_FOUND',
      'S4 refuse le rang 4 pour la MEME raison que S7-B',
    );
  } finally {
    await h.dispose();
  }
});

test('27 · les cinq sortes d’entrées V3 sont exactement celles que V4 sait viser', () => {
  // Le contrat énumère : une assertion, une relation, l'ouverture d'une
  // controverse, une nature, une autorité humaine — « sans en ajouter aucune ».
  assert.deepEqual([...CONTROVERSY_ENTRY_KINDS], [
    'CONTROVERSY_RECORDED',
    'ASSERTION_RECORDED',
    'RELATION_RECORDED',
    'NATURE_RECORDED',
    'HUMAN_AUTHORITY_RECORDED',
  ]);
});

test('28 · C15 — un MATÉRIAU ajouté pendant l’appel n’est pas un input rétroactif', async () => {
  let hRef!: Harness;
  let addedId: string | undefined;

  const h = await harness({
    // Le fournisseur nomme un matériau qui n'existait PAS en phase A.
    content: output([proposal('mat_000005', 'ctve_000002', 'SUPPORTS')]),
    onCall: async () => {
      const created = await registerMaterial(hRef.evidence, {
        runId: RUN_ID,
        expected_evidence_revision: await readCurrentEvidenceRevision(
          { runsDir: hRef.runsDir },
          RUN_ID,
        ),
        representation: { form: 'INLINE_TEXT', text: 'Matériau apparu pendant l’appel' },
      });
      addedId = created.entry.entry_id;
    },
  });
  hRef = h;
  try {
    const s = await seed(h);
    const outcome = await request(h, s);

    assert.equal(addedId, 'mat_000005', 'le matériau a bien été enregistré pendant la phase B');

    // Il EXISTE, il est canonique, il résout en phase C — et il est refusé :
    // il n'a pas été soumis. CURRENTLY EXISTS ≠ DISPATCH INPUT.
    const { ctx } = await contextOf(h);
    assert.ok(ctx.materialsById.has('mat_000005'), 'canonique en phase C');

    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') {
      assert.equal(outcome.check, 'V6');
      assert.equal(outcome.at, 'proposals[0].material_id');
    }
    assert.equal((await modelAdductions(h)).length, 0);
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});
