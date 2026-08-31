/**
 * V3-S7-B — dispatch gouverné et persistance `MODEL_ASSISTED`.
 *
 * Question de preuve :
 *
 * > **Une détection peut-elle être engagée, exécutée et persistée sous la
 * > gouvernance V2.2, sans jamais tenir le verrou de run pendant l'appel et
 * > sans qu'aucun fournisseur réel ne soit approché ?**
 *
 * Quatre propriétés.
 *
 *  1. **L'engagement précède l'appel.** L'adaptateur constate lui-même, au
 *     moment où il est invoqué, que son invocation est déjà au ledger.
 *  2. **Le verrou n'est pas tenu pendant l'appel.** Une autre mutation du même
 *     run s'exécute pendant que l'adaptateur attend — preuve dynamique, pas
 *     lecture de source.
 *  3. **Un seul appel, jamais deux.** Aucun échec d'analyse, de domaine ou de
 *     persistance ne déclenche une seconde tentative.
 *  4. **Seul CCR persiste.** Le fournisseur propose, le parseur valide la
 *     forme, le service métier revalide contre les faits courants et écrit.
 *
 * Aucun fournisseur réel : l'adaptateur est une couture de test injectée.
 * Rien ici ne dit quoi que ce soit de la qualité d'une détection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import { formatControversyEntryId } from '../../src/core/controversy.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { readInvocationOutcomes } from '../../src/store/invocation-outcome-store.ts';
import {
  INVOCATION_OUTCOME_SCHEMA_VERSION,
  terminalOutcomeOf,
} from '../../src/core/invocation-outcome.ts';
import { openUsageLedger } from '../../src/store/usage-ledger.ts';
import { readControversyJournal } from '../../src/store/controversy-store.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { readUsageReadModel } from '../../src/services/usage-read-model.ts';
import {
  CONTROVERSY_DETECTOR_OUTPUT_VERSION,
  detectControversyRelations,
} from '../../src/services/controversy-detector.ts';
import type { DetectionDeps, DetectionOutcome } from '../../src/services/controversy-detector.ts';
import {
  recordAssertion,
  recordControversy,
  recordNature,
  recordRelation,
} from '../../src/services/controversy-service.ts';
import type { ControversyServiceDeps } from '../../src/services/controversy-service.ts';

const RUN_ID = 'CCR-20260817-007';
const DISPATCH_SOURCE = new URL('../../src/services/controversy-detector.ts', import.meta.url);

const EVENTS: readonly Record<string, unknown>[] = [
  {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-17T09:10:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'S1',
    content: 'Le cache doit expirer.',
  },
  {
    event_id: 'evt_000002',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-17T09:20:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'challenger',
    session_id: 'S2',
    content: 'Non : le cache reste valide.',
  },
];

// --------------------------------------------------------------------------
// Harnais — vrai filesystem, vrai verrou, vrai ledger, adaptateur injecté
// --------------------------------------------------------------------------

interface FakeAdapter extends AgentAdapter {
  calls: string[];
}

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: DetectionDeps;
  readonly service: ControversyServiceDeps;
  /** Appels réellement passés à l'adaptateur, tous fournisseurs confondus. */
  calls(): number;
  dispose(): Promise<void>;
}

interface AdapterScript {
  /** Rendu à `start()`. Ignoré si `fail` est fourni. */
  readonly content?: string;
  readonly fail?: Error;
  /** Observé au moment exact de l'appel. */
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
        sessionId: `detect-${kind}-1`,
        content: script.content ?? '',
        exitCode: 0,
        startedAt: '2026-08-17T10:00:00.000Z',
        completedAt: '2026-08-17T10:00:01.000Z',
        stdoutRaw: script.content ?? '',
        stderrRaw: '',
        ...(script.usage === undefined ? {} : { usageObservation: script.usage }),
      };
    },
    resume(): Promise<AgentTurnResult> {
      throw new Error('une détection ne reprend jamais la session d’un expert');
    },
    openInteractive(): never {
      throw new Error('une détection n’ouvre aucun terminal');
    },
  };
}

async function harness(script: AdapterScript = {}): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v3-s7b-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-08-17T09:00:00.000Z',
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
      updated_at: '2026-08-17T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, EVENTS.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  const adapters = { claude: fakeAdapter('claude', script), codex: fakeAdapter('codex', script) };
  let tick = 0;
  const now = (): Date => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 17, 12, 0, tick));
  };

  return {
    runsDir,
    paths,
    deps: { runsDir, now, createAdapters: () => adapters },
    service: { runsDir, now },
    calls: () => adapters.claude.calls.length + adapters.codex.calls.length,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

function output(proposals: readonly Record<string, unknown>[], version: unknown = CONTROVERSY_DETECTOR_OUTPUT_VERSION): string {
  return JSON.stringify({ detector_output_version: version, proposals });
}

async function revisionOf(h: Harness): Promise<string> {
  return (await readControversyJournal(h.paths)).revision;
}

async function entriesOf(h: Harness): Promise<Awaited<ReturnType<typeof readControversyJournal>>['entries']> {
  return (await readControversyJournal(h.paths)).entries;
}

interface Seed {
  readonly controversyId: string;
  readonly a: string;
  readonly b: string;
  readonly opening: string;
  /** Assertion appartenant à une AUTRE controverse du même run. */
  readonly foreign: string;
  readonly foreignSecond: string;
  readonly foreignControversyId: string;
}

/** Deux controverses humaines — la seconde sert à éprouver la frontière. */
async function seedControversy(h: Harness): Promise<Seed> {
  const opened = await recordControversy(h.service, {
    runId: RUN_ID,
    expected_controversy_revision: await revisionOf(h),
    provenance_event_ids: ['evt_000001'],
    statement: 'Durée de vie du cache',
  });
  const controversyId = opened.controversy_id;

  const a = await recordAssertion(h.service, {
    runId: RUN_ID,
    controversy_id: controversyId,
    expected_controversy_revision: opened.controversy_revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Le TTL doit être court',
  });
  const b = await recordAssertion(h.service, {
    runId: RUN_ID,
    controversy_id: controversyId,
    expected_controversy_revision: a.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Le TTL doit être long',
  });
  const other = await recordControversy(h.service, {
    runId: RUN_ID,
    expected_controversy_revision: b.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Autre sujet',
  });
  const foreign = await recordAssertion(h.service, {
    runId: RUN_ID,
    controversy_id: other.controversy_id,
    expected_controversy_revision: other.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Position etrangere',
  });
  const foreignSecond = await recordAssertion(h.service, {
    runId: RUN_ID,
    controversy_id: other.controversy_id,
    expected_controversy_revision: foreign.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Autre position etrangere',
  });

  return {
    controversyId,
    a: a.entry.entry_id,
    b: b.entry.entry_id,
    opening: opened.entry.entry_id,
    foreign: foreign.entry.entry_id,
    foreignSecond: foreignSecond.entry.entry_id,
    foreignControversyId: other.controversy_id,
  };
}

function proposal(controversyId: string, from: string, to: string, act = 'CONTESTS'): Record<string, unknown> {
  return { controversy_id: controversyId, from_entry_id: from, to_entry_id: to, act };
}

// ==========================================================================
// A. Gouvernance — quota, engagement, ordre
// ==========================================================================

test('1 · T1 — un quota épuisé refuse avant tout engagement et tout appel', async () => {
  const h = await harness({ content: output([]) });
  try {
    const seed = await seedControversy(h);
    await openInvocationPolicyStore(h.paths).create(0);

    await assert.rejects(
      () =>
        detectControversyRelations(h.deps, {
          runId: RUN_ID,
          controversy_id: seed.controversyId,
          expert_slot: 'author',
        }),
      (error: unknown) => isCcrError(error) && error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED',
    );

    assert.equal(h.calls(), 0, 'aucun adaptateur approché');
    assert.equal(existsSync(h.paths.invocations), false, 'aucune invocation engagée');
    assert.equal((await entriesOf(h)).filter((e) => e.recorded_by === 'CCR').length, 0);
  } finally {
    await h.dispose();
  }
});

test('2 · T2/T3 — l’adaptateur constate son engagement déjà durable', async () => {
  let observed: Record<string, unknown> | undefined;
  const h = await harness({
    content: output([]),
    onCall: async () => {
      // Lecture du ledger AU MOMENT de l'appel : c'est une preuve dynamique,
      // pas un ordre de lignes dans le source.
      const raw = await readFile(pathsRef.invocations, 'utf8');
      observed = JSON.parse(raw.trim().split('\n')[0] as string) as Record<string, unknown>;
    },
  });
  // eslint-disable-next-line prefer-const
  let pathsRef = h.paths;
  try {
    const seed = await seedControversy(h);
    const outcome = await detectControversyRelations(h.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'challenger',
    });

    assert.equal(h.calls(), 1);
    assert.ok(observed !== undefined, 'le ledger était lisible pendant l’appel');
    assert.equal(observed['kind'], 'DISPATCH_COMMITTED');
    assert.equal(observed['trigger_kind'], 'CONTROVERSY_DETECTION');
    assert.equal(observed['schema_version'], 2, 'un déclencheur V3 écrit en version 2');
    assert.equal(observed['invocation_id'], outcome.invocation_id);
    assert.deepEqual(observed['identity'], {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'challenger',
      provider: 'claude',
    });

    // L'identifiant est celui que la gouvernance V2.2 alloue, pas un second.
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    assert.equal(ledger.count(), 1);
    assert.equal(ledger.lastInvocationId(), outcome.invocation_id);
  } finally {
    await h.dispose();
  }
});

test('3 · T4 — le verrou de run n’est PAS tenu pendant l’appel', async () => {
  let released!: () => void;
  const barrier = new Promise<void>((resolve) => {
    released = resolve;
  });
  let concurrentDone = false;

  const h = await harness({
    content: output([]),
    onCall: async () => {
      // Pendant que l'adaptateur attend, une autre mutation native du MÊME run
      // doit pouvoir acquérir `.ccr.lock`. Si la phase B le tenait, cet appel
      // échouerait en RUN_ALREADY_LOCKED et le test tomberait.
      await recordNature(h.service, {
        runId: RUN_ID,
        controversy_id: seedRef.controversyId,
        expected_controversy_revision: await revisionOf(h),
        provenance_event_ids: ['evt_000001'],
        nature: 'désaccord de méthode',
      });
      concurrentDone = true;
      released();
      await barrier;
    },
  });
  let seedRef!: { controversyId: string; a: string; b: string };
  try {
    seedRef = await seedControversy(h);
    const before = (await entriesOf(h)).length;

    const outcome = await detectControversyRelations(h.deps, {
      runId: RUN_ID,
      controversy_id: seedRef.controversyId,
      expert_slot: 'author',
    });

    assert.equal(concurrentDone, true, 'la mutation concurrente a bien abouti');
    assert.equal(outcome.kind, 'VALID_ZERO');
    assert.equal(h.calls(), 1);

    // La nature écrite pendant la phase B est bien là, et la détection ne l'a
    // pas écrasée : elle a relu les faits courants.
    const after = await entriesOf(h);
    assert.equal(after.length, before + 1);
    assert.equal(after.at(-1)?.kind, 'NATURE_RECORDED');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// B. Les quatre issues
// ==========================================================================

test('4 · T5 — sortie valide sans proposition : succès, zéro relation', async () => {
  const h = await harness({ content: output([]) });
  try {
    const seed = await seedControversy(h);
    const before = (await entriesOf(h)).length;

    const outcome = await detectControversyRelations(h.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'author',
    });

    assert.equal(outcome.kind, 'VALID_ZERO');
    assert.equal(h.calls(), 1, 'aucun second appel');
    assert.equal((await entriesOf(h)).length, before, 'aucune relation persistée');

    // L'invocation, elle, reste un fait durable.
    assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1);

    // H — l'issue est durable, sous la version courante, et aucun objet de
    // domaine n'a été inventé pour la porter. Elle l'était avant que le
    // résultat ne soit rendu : le commit précède le `return` dans le service.
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

test('5 · T6/T7 — persistance MODEL_ASSISTED complète et véridique', async () => {
  // Le terrain doit exister avant que l'adaptateur ne soit scripté : on ouvre
  // donc un premier harnais pour connaître les identités, puis on rejoue.
  const probe = await harness();
  const seed = await seedControversy(probe);
  // Périmètre : SEULES les entrées de la controverse visée. La seconde
  // controverse du run n'est jamais soumise au modèle.
  const inputsExpected = (await entriesOf(probe))
    .filter((entry) => entry.controversy_id === seed.controversyId)
    .map((entry) => entry.entry_id);
  const journal = await readFile(probe.paths.controversies, 'utf8');
  const manifest = await readFile(probe.paths.manifest, 'utf8');
  const state = await readFile(probe.paths.state, 'utf8');
  const events = await readFile(probe.paths.events, 'utf8');
  await probe.dispose();

  const h = await harness({ content: output([proposal(seed.controversyId, seed.b, seed.a)]) });
  try {
    await writeFile(h.paths.manifest, manifest, 'utf8');
    await writeFile(h.paths.state, state, 'utf8');
    await writeFile(h.paths.events, events, 'utf8');
    await writeFile(h.paths.controversies, journal, 'utf8');

    const outcome = await detectControversyRelations(h.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'author',
    });

    assert.equal(outcome.kind, 'PERSISTED');
    if (outcome.kind !== 'PERSISTED') throw new Error('inatteignable');
    assert.equal(outcome.entries.length, 1);

    const entry = outcome.entries[0];
    assert.equal(entry?.kind, 'RELATION_RECORDED');
    assert.equal(entry?.semantic_origin.kind, 'CCR');
    assert.equal(entry?.recorded_by, 'CCR');
    assert.equal(entry?.derivation?.method, 'MODEL_ASSISTED');
    assert.equal(entry?.derivation?.invocation_id, outcome.invocation_id);
    assert.deepEqual(entry?.relation, {
      from_entry_id: seed.b,
      to_entry_id: seed.a,
      act: 'CONTESTS',
    });

    // T7 — les inputs sont exactement les entrées soumises au modèle.
    assert.deepEqual([...(entry?.derivation?.inputs ?? [])], inputsExpected);

    // Aucun champ de vérité, aucun fournisseur dupliqué dans la dérivation.
    const derivation = entry?.derivation as unknown as Record<string, unknown>;
    for (const forbidden of ['confidence', 'score', 'provider', 'model', 'cost']) {
      assert.equal(forbidden in derivation, false, forbidden);
    }

    // L'identifiant d'invocation relie le ledger et la dérivation.
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    assert.equal((await ledger.readAll())[0]?.invocation_id, outcome.invocation_id);
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});

test('6 · T8/T9/T10 — sortie invalide : aucune relation, aucun second appel', async () => {
  const cases: readonly (readonly [string, string])[] = [
    ['JSON illisible', '{ pas du json'],
    ['version inconnue', output([], 9)],
    ['champ interdit', output([{ controversy_id: 'ctv_000001', from_entry_id: 'ctve_000002', to_entry_id: 'ctve_000003', act: 'CONTESTS', confidence: 0.9 }])],
    ['acte inventé', output([{ controversy_id: 'ctv_000001', from_entry_id: 'ctve_000002', to_entry_id: 'ctve_000003', act: 'SUPPORTS' }])],
  ];

  for (const [label, content] of cases) {
    const h = await harness({ content });
    try {
      const seed = await seedControversy(h);
      const before = (await entriesOf(h)).length;

      const outcome = await detectControversyRelations(h.deps, {
        runId: RUN_ID,
        controversy_id: seed.controversyId,
        expert_slot: 'author',
      });

      assert.equal(outcome.kind, 'INVALID_OUTPUT', label);
      assert.notEqual(outcome.kind, 'VALID_ZERO');
      assert.equal(h.calls(), 1, `${label} : un seul appel`);
      assert.equal((await entriesOf(h)).length, before, `${label} : aucune relation`);
      assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1, `${label} : invocation durable`);
    } finally {
      await h.dispose();
    }
  }
});

test('7 · T11 — une panne de fournisseur reste distincte d’une sortie invalide', async () => {
  const h = await harness({ fail: new Error('le moteur est indisponible') });
  try {
    const seed = await seedControversy(h);
    const before = (await entriesOf(h)).length;

    const outcome = await detectControversyRelations(h.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'author',
    });

    assert.equal(outcome.kind, 'PROVIDER_FAILED');
    assert.notEqual(outcome.kind, 'INVALID_OUTPUT');
    assert.notEqual(outcome.kind, 'VALID_ZERO');
    assert.equal(h.calls(), 1, 'aucune reprise automatique');
    assert.equal((await entriesOf(h)).length, before);

    // T21 — l'invocation reste engagée, sans observation, sans reprise de run.
    assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1);
    const view = await readUsageReadModel(h.paths);
    assert.equal(view.by_invocation[0]?.provider_reported.state, 'UNOBSERVED');
    assert.equal(view.by_invocation[0]?.ccr_measured.state, 'UNOBSERVED');
    const persistedState = JSON.parse(await readFile(h.paths.state, 'utf8')) as Record<string, unknown>;
    assert.equal(persistedState['pending_operation'], null, 'aucune reprise de run introduite');
    assert.equal(persistedState['state'], 'READY');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// C. Revalidation canonique en phase C
// ==========================================================================

test('8 · T12/T13/T14/T15 — une proposition non recevable ne persiste rien', async () => {
  const probe = await harness();
  const seed = await seedControversy(probe);
  const journal = await readFile(probe.paths.controversies, 'utf8');
  const manifest = await readFile(probe.paths.manifest, 'utf8');
  const state = await readFile(probe.paths.state, 'utf8');
  const events = await readFile(probe.paths.events, 'utf8');
  await probe.dispose();

  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['controverse inexistante', proposal('ctv_000999', seed.a, seed.b)],
    ['extrémité inexistante', proposal(seed.controversyId, seed.a, 'ctve_000900')],
    ['inter-controverses', proposal(seed.controversyId, seed.a, seed.foreign)],
    ['cible non-assertion', proposal(seed.controversyId, seed.a, seed.opening, 'REFORMULATES')],
  ];

  for (const [label, bad] of cases) {
    const h = await harness({ content: output([bad]) });
    try {
      await writeFile(h.paths.manifest, manifest, 'utf8');
      await writeFile(h.paths.state, state, 'utf8');
      await writeFile(h.paths.events, events, 'utf8');
      await writeFile(h.paths.controversies, journal, 'utf8');
      const before = await readFile(h.paths.controversies, 'utf8');

      await assert.rejects(
        () =>
          detectControversyRelations(h.deps, {
            runId: RUN_ID,
            controversy_id: seed.controversyId,
            expert_slot: 'author',
          }),
        (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
        label,
      );

      assert.equal(await readFile(h.paths.controversies, 'utf8'), before, `${label} : journal intact`);
      assert.equal(h.calls(), 1, `${label} : aucun second appel`);
      assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1);
    } finally {
      await h.dispose();
    }
  }
});

test('9 · T16/T17/T18 — lot, doublons et sémantique tout-ou-rien', async () => {
  const probe = await harness();
  const seed = await seedControversy(probe);
  const journal = await readFile(probe.paths.controversies, 'utf8');
  const manifest = await readFile(probe.paths.manifest, 'utf8');
  const state = await readFile(probe.paths.state, 'utf8');
  const events = await readFile(probe.paths.events, 'utf8');
  await probe.dispose();

  const restore = async (h: Harness): Promise<void> => {
    await writeFile(h.paths.manifest, manifest, 'utf8');
    await writeFile(h.paths.state, state, 'utf8');
    await writeFile(h.paths.events, events, 'utf8');
    await writeFile(h.paths.controversies, journal, 'utf8');
  };

  // T18 — deux propositions distinctes et valides : les deux persistent, dans
  // l'ordre de production.
  const many = await harness({
    content: output([
      proposal(seed.controversyId, seed.b, seed.a),
      proposal(seed.controversyId, seed.a, seed.b, 'REFORMULATES'),
    ]),
  });
  try {
    await restore(many);
    const outcome = await detectControversyRelations(many.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'author',
    });
    assert.equal(outcome.kind, 'PERSISTED');
    if (outcome.kind !== 'PERSISTED') throw new Error('inatteignable');
    assert.deepEqual(
      outcome.entries.map((entry) => entry.relation?.act),
      ['CONTESTS', 'REFORMULATES'],
    );
    assert.notEqual(outcome.entries[0]?.entry_id, outcome.entries[1]?.entry_id);
  } finally {
    await many.dispose();
  }

  // T16/T17 — un doublon exact dans le lot : tout-ou-rien, et le refus tombe
  // AVANT le premier append, jamais après.
  const dup = await harness({
    content: output([
      proposal(seed.controversyId, seed.b, seed.a),
      proposal(seed.controversyId, seed.b, seed.a),
    ]),
  });
  try {
    await restore(dup);
    const before = await readFile(dup.paths.controversies, 'utf8');
    await assert.rejects(
      () =>
        detectControversyRelations(dup.deps, {
          runId: RUN_ID,
          controversy_id: seed.controversyId,
          expert_slot: 'author',
        }),
      (error: unknown) =>
        isCcrError(error) && (error.details['reason'] as string) === 'EXACT_DUPLICATE',
    );
    assert.equal(await readFile(dup.paths.controversies, 'utf8'), before, 'aucun octet écrit');
  } finally {
    await dup.dispose();
  }

  // T16 — une seule proposition invalide dans un lot par ailleurs valide :
  // zéro relation issue de ce lot.
  const mixed = await harness({
    content: output([
      proposal(seed.controversyId, seed.b, seed.a),
      proposal(seed.controversyId, seed.a, 'ctve_000900'),
    ]),
  });
  try {
    await restore(mixed);
    const before = await readFile(mixed.paths.controversies, 'utf8');
    await assert.rejects(() =>
      detectControversyRelations(mixed.deps, {
        runId: RUN_ID,
        controversy_id: seed.controversyId,
        expert_slot: 'author',
      }),
    );
    assert.equal(await readFile(mixed.paths.controversies, 'utf8'), before, 'tout-ou-rien');
  } finally {
    await mixed.dispose();
  }
});

test('10 · T19 — le run évolue pendant l’appel : les endpoints historiques restent valides', async () => {
  const probe = await harness();
  const seed = await seedControversy(probe);
  const journal = await readFile(probe.paths.controversies, 'utf8');
  const manifest = await readFile(probe.paths.manifest, 'utf8');
  const state = await readFile(probe.paths.state, 'utf8');
  const events = await readFile(probe.paths.events, 'utf8');
  await probe.dispose();

  let harnessRef!: Harness;
  const h = await harness({
    content: output([proposal(seed.controversyId, seed.b, seed.a)]),
    onCall: async () => {
      // Écriture humaine concurrente : la révision de controverse change.
      await recordNature(harnessRef.service, {
        runId: RUN_ID,
        controversy_id: seed.controversyId,
        expected_controversy_revision: await revisionOf(harnessRef),
        provenance_event_ids: ['evt_000001'],
        nature: 'désaccord de méthode',
      });
    },
  });
  harnessRef = h;
  try {
    await writeFile(h.paths.manifest, manifest, 'utf8');
    await writeFile(h.paths.state, state, 'utf8');
    await writeFile(h.paths.events, events, 'utf8');
    await writeFile(h.paths.controversies, journal, 'utf8');
    const revisionAtDispatch = await revisionOf(h);

    const outcome = await detectControversyRelations(h.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'author',
    });

    // La révision a changé, et la persistance a quand même eu lieu : le journal
    // est append-only, les entrées visées n'ont pas disparu.
    assert.notEqual(await revisionOf(h), revisionAtDispatch);
    assert.equal(outcome.kind, 'PERSISTED');
    if (outcome.kind !== 'PERSISTED') throw new Error('inatteignable');
    assert.equal(outcome.entries.length, 1);
    assert.equal(outcome.controversy_revision, await revisionOf(h));

    // L'écriture concurrente est intacte, et la relation vient après elle.
    const after = await entriesOf(h);
    assert.equal(after.some((entry) => entry.kind === 'NATURE_RECORDED'), true);
    assert.equal(after.at(-1)?.derivation?.method, 'MODEL_ASSISTED');
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// D. Usage, autorité, absence de surface
// ==========================================================================

test('11 · T21/T22 — l’usage n’est que ce qui a été observé', async () => {
  // Sans observation fournisseur : seule la mesure de CCR existe, et aucun
  // compteur à zéro n'est inventé.
  const bare = await harness({ content: output([]) });
  try {
    const seed = await seedControversy(bare);
    await detectControversyRelations(bare.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'author',
    });

    const view = await readUsageReadModel(bare.paths);
    assert.equal(view.by_invocation.length, 1);
    assert.equal(view.by_invocation[0]?.trigger_kind, 'CONTROVERSY_DETECTION');
    assert.equal(view.by_invocation[0]?.provider_reported.state, 'UNOBSERVED');
    assert.equal(view.by_invocation[0]?.ccr_measured.state, 'OBSERVED');

    const usage = await (await openUsageLedger(bare.paths, RUN_ID)).readAll();
    assert.equal(usage.some((record) => record.provenance === 'PROVIDER_REPORTED'), false);
    const serialized = JSON.stringify(view);
    for (const invented of ['"cost":0', '"input_tokens":0', 'provider_reported_cost']) {
      assert.equal(serialized.includes(invented), false, invented);
    }
  } finally {
    await bare.dispose();
  }

  // Avec observation : le writer V2.2 existant l'enregistre, sans variante.
  const reported = await harness({
    content: output([]),
    usage: { tokens: { input_tokens: 12, output_tokens: 3 } } as never,
  });
  try {
    const seed = await seedControversy(reported);
    await detectControversyRelations(reported.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'author',
    });
    const view = await readUsageReadModel(reported.paths);
    assert.equal(view.by_invocation[0]?.provider_reported.state, 'OBSERVED');
  } finally {
    await reported.dispose();
  }
});

test('12 · T23/T24/T25/T26 — aucune surface publique, aucun déclenchement, aucune reprise', async () => {
  const dispatch = (await readFile(DISPATCH_SOURCE, 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // V3-S7-C a ajouté la frontière de disponibilité au même module. La garde est
  // donc bornée à la SECTION DE DISPATCH, qui doit rester aveugle au drapeau :
  // c'est la voie publique qui le consulte, jamais le service gouverné.
  const gateStart = dispatch.indexOf('const MODEL_DETECTION_IMPLEMENTED');
  assert.ok(gateStart > 0, 'la section de disponibilité est délimitée');
  const body = dispatch.slice(0, gateStart);

  // T24 — le dispatch ne consulte ni ne lève aucune porte publique.
  // `AVAILABLE` n'est pas cherché tel quel : le discriminant du read model S3
  // le porte légitimement. Ce qui est interdit, c'est la porte de disponibilité.
  for (const forbidden of [
    'MODEL_DETECTION_RUNTIME_AVAILABILITY',
    'RUNTIME_AVAILABILITY',
    'mutations-http',
    'cockpit',
    'registerRoute',
  ]) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }

  // T25/T26 — aucun déclenchement automatique, aucune reprise.
  for (const forbidden of ['setTimeout', 'setInterval', 'retry', 'again', 'pending_operation']) {
    assert.equal(dispatch.includes(forbidden), false, forbidden);
  }
  // Un seul site d'appel d'adaptateur dans tout le module.
  assert.equal((dispatch.match(/\.start\(/g) ?? []).length, 1, 'un seul site d’appel');

  // T25 — aucun moteur natif n'appelle la détection.
  const engines = [
    'native-start-service.ts',
    'native-step-service.ts',
    'native-send-service.ts',
    'native-handoff-service.ts',
    'native-recovery-service.ts',
  ];
  for (const engine of engines) {
    const code = await readFile(new URL(`../../src/services/${engine}`, import.meta.url), 'utf8');
    assert.equal(code.includes('controversy-detector'), false, `${engine} ne déclenche aucune détection`);
    assert.equal(code.includes('detectControversyRelations'), false, engine);
  }

  // T23 — aucune surface HTTP n'expose la détection.
  for (const surface of ['mutations-http.ts', 'server.ts']) {
    const code = await readFile(new URL(`../../src/cockpit/${surface}`, import.meta.url), 'utf8');
    assert.equal(code.includes('controversy-detector'), false, surface);
    assert.equal(code.includes('recordDetectedRelations'), false, surface);
    assert.equal(code.includes('MODEL_ASSISTED'), false, surface);
  }
});

// ==========================================================================
// E. Liaison aux faits réellement soumis
//
// Une relation `MODEL_ASSISTED` affirme deux choses à la fois : qu'elle est
// valide contre l'état canonique, et qu'elle dérive des faits fournis au
// modèle. La seconde n'est pas impliquée par la première — une proposition
// peut être parfaitement valide ailleurs, ou porter sur une entrée apparue
// pendant l'appel. Persister alors une dérivation qui ne les contient pas
// serait une provenance mensongère.
// ==========================================================================

interface Snapshot {
  readonly manifest: string;
  readonly state: string;
  readonly events: string;
  readonly journal: string;
  readonly entryIds: readonly string[];
  readonly scopedIds: readonly string[];
}

async function capture(h: Harness, controversyId: string): Promise<Snapshot> {
  const entries = await entriesOf(h);
  return {
    manifest: await readFile(h.paths.manifest, 'utf8'),
    state: await readFile(h.paths.state, 'utf8'),
    events: await readFile(h.paths.events, 'utf8'),
    journal: await readFile(h.paths.controversies, 'utf8'),
    entryIds: entries.map((entry) => entry.entry_id),
    scopedIds: entries
      .filter((entry) => entry.controversy_id === controversyId)
      .map((entry) => entry.entry_id),
  };
}

async function restoreInto(h: Harness, snap: Snapshot): Promise<void> {
  await writeFile(h.paths.manifest, snap.manifest, 'utf8');
  await writeFile(h.paths.state, snap.state, 'utf8');
  await writeFile(h.paths.events, snap.events, 'utf8');
  await writeFile(h.paths.controversies, snap.journal, 'utf8');
}

test('13 · §4 — une proposition visant une AUTRE controverse est refusée', async () => {
  const probe = await harness();
  const seed = await seedControversy(probe);
  const snap = await capture(probe, seed.controversyId);
  await probe.dispose();

  // Structurellement irréprochable dans la seconde controverse : le refus ne
  // peut donc venir que de la liaison au périmètre soumis.
  const h = await harness({
    content: output([proposal(seed.foreignControversyId, seed.foreign, seed.foreignSecond)]),
  });
  try {
    await restoreInto(h, snap);
    const before = await readFile(h.paths.controversies, 'utf8');

    await assert.rejects(
      () =>
        detectControversyRelations(h.deps, {
          runId: RUN_ID,
          controversy_id: seed.controversyId,
          expert_slot: 'author',
        }),
      (error: unknown) =>
        isCcrError(error) && (error.details['reason'] as string) === 'DETECTION_SCOPE_MISMATCH',
    );

    assert.equal(await readFile(h.paths.controversies, 'utf8'), before, 'aucune relation, nulle part');
    assert.equal(h.calls(), 1, 'un seul appel, aucune reprise');
    assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1, 'invocation durable');
  } finally {
    await h.dispose();
  }
});

test('14 · §5 — une entrée ajoutée PENDANT l’appel ne devient pas un input rétroactif', async () => {
  const probe = await harness();
  const seed = await seedControversy(probe);
  const snap = await capture(probe, seed.controversyId);
  await probe.dispose();

  // L'identité de la future entrée est déterministe : le journal restauré en
  // porte N, la suivante sera N+1.
  const unseen = formatControversyEntryId(snap.entryIds.length + 1);

  let harnessRef!: Harness;
  const h = await harness({
    content: output([proposal(seed.controversyId, seed.a, unseen)]),
    onCall: async () => {
      // Naissance de l'entrée pendant l'appel, dans la MÊME controverse.
      await recordAssertion(harnessRef.service, {
        runId: RUN_ID,
        controversy_id: seed.controversyId,
        expected_controversy_revision: await revisionOf(harnessRef),
        provenance_event_ids: ['evt_000001'],
        statement: 'Position apparue pendant l’appel',
      });
    },
  });
  harnessRef = h;
  try {
    await restoreInto(h, snap);

    await assert.rejects(
      () =>
        detectControversyRelations(h.deps, {
          runId: RUN_ID,
          controversy_id: seed.controversyId,
          expert_slot: 'author',
        }),
      (error: unknown) =>
        isCcrError(error) && (error.details['reason'] as string) === 'DETECTION_ENDPOINT_NOT_SUBMITTED',
    );

    // Ce qui rend le refus significatif : l'entrée existe, elle est canonique,
    // et elle appartient bien à la controverse visée.
    const after = await entriesOf(h);
    const born = after.find((entry) => entry.entry_id === unseen);
    assert.ok(born !== undefined, 'l’entrée est bien née pendant l’appel');
    assert.equal(born.controversy_id, seed.controversyId, 'et dans la MÊME controverse');
    assert.equal(born.kind, 'ASSERTION_RECORDED', 'et sa forme aurait été admissible');

    // Elle n'a pourtant jamais été soumise : aucune relation inférée.
    assert.equal(after.some((entry) => entry.derivation?.method === 'MODEL_ASSISTED'), false);
    assert.equal(h.calls(), 1);
    assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1);
  } finally {
    await h.dispose();
  }
});

test('15 · §6 — une évolution sans incidence du run reste autorisée', async () => {
  const probe = await harness();
  const seed = await seedControversy(probe);
  const snap = await capture(probe, seed.controversyId);
  await probe.dispose();

  let harnessRef!: Harness;
  const h = await harness({
    content: output([proposal(seed.controversyId, seed.b, seed.a)]),
    onCall: async () => {
      await recordNature(harnessRef.service, {
        runId: RUN_ID,
        controversy_id: seed.controversyId,
        expected_controversy_revision: await revisionOf(harnessRef),
        provenance_event_ids: ['evt_000001'],
        nature: 'désaccord de méthode',
      });
    },
  });
  harnessRef = h;
  try {
    await restoreInto(h, snap);
    const revisionAtDispatch = await revisionOf(h);

    const outcome = await detectControversyRelations(h.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'author',
    });

    // Le run a changé, et la persistance a quand même eu lieu : le critère est
    // la liaison aux inputs, jamais l'immobilité du run.
    assert.notEqual(await revisionOf(h), revisionAtDispatch);
    assert.equal(outcome.kind, 'PERSISTED');
    if (outcome.kind !== 'PERSISTED') throw new Error('inatteignable');
    assert.deepEqual([...(outcome.entries[0]?.derivation?.inputs ?? [])], [...snap.scopedIds]);
  } finally {
    await h.dispose();
  }
});

test('16 · §11 — un doublon exact apparu PENDANT l’appel', async () => {
  const probe = await harness();
  const seed = await seedControversy(probe);
  const snap = await capture(probe, seed.controversyId);
  await probe.dispose();

  let harnessRef!: Harness;
  const h = await harness({
    content: output([proposal(seed.controversyId, seed.b, seed.a)]),
    onCall: async () => {
      // Un geste humain enregistre la même relation pendant l'appel.
      await recordRelation(harnessRef.service, {
        runId: RUN_ID,
        controversy_id: seed.controversyId,
        expected_controversy_revision: await revisionOf(harnessRef),
        provenance_event_ids: ['evt_000001'],
        act: 'CONTESTS',
        from_entry_id: seed.b,
        to_entry_id: seed.a,
      });
    },
  });
  harnessRef = h;
  try {
    await restoreInto(h, snap);

    const settled = await detectControversyRelations(h.deps, {
      runId: RUN_ID,
      controversy_id: seed.controversyId,
      expert_slot: 'author',
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const entries = await entriesOf(h);
    const human = entries.filter(
      (entry) => entry.kind === 'RELATION_RECORDED' && entry.semantic_origin.kind === 'HUMAN',
    );
    assert.equal(human.length, 1, 'la relation humaine concurrente est bien là');

    const inferred = entries.filter((entry) => entry.derivation?.method === 'MODEL_ASSISTED');

    // La règle contractuelle de doublon exact compare aussi l'ATTRIBUTION :
    // « même kind, même controverse, **même attribution**, mêmes ancrages,
    // même contenu », et §17.2 précise pour les relations « même triplet
    // from/to/act/**origine** ». Une relation humaine et une inférence CCR ne
    // sont donc pas le même fait, et la règle existante — appliquée sans
    // exemption pour une origine CCR — les laisse coexister.
    assert.equal(settled.ok, true, 'la règle de doublon exact ne les confond pas');
    assert.equal(inferred.length, 1, 'l’inférence est persistée, distincte');
    assert.equal(inferred[0]?.semantic_origin.kind, 'CCR');
    assert.equal(human[0]?.semantic_origin.kind, 'HUMAN');
    assert.deepEqual(inferred[0]?.relation, human[0]?.relation, 'même triplet, origines différentes');

    // Et un doublon exact de MÊME origine, lui, reste refusé : c'est ce que le
    // test 9 établit sur un lot, et ce que la garde préserve ici.
    assert.notEqual(inferred[0]?.entry_id, human[0]?.entry_id);

    assert.equal(h.calls(), 1, 'un seul appel, aucune reprise');
    assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1);
  } finally {
    await h.dispose();
  }
});

test('17 · §12 — la liaison est vérifiée sur TOUT le lot avant le premier append', async () => {
  const probe = await harness();
  const seed = await seedControversy(probe);
  const snap = await capture(probe, seed.controversyId);
  await probe.dispose();

  // La première proposition est irréprochable ; la seconde vise une entrée
  // jamais soumise. Aucune des deux ne doit être écrite.
  const h = await harness({
    content: output([
      proposal(seed.controversyId, seed.b, seed.a),
      proposal(seed.controversyId, seed.a, seed.foreign),
    ]),
  });
  try {
    await restoreInto(h, snap);
    const before = await readFile(h.paths.controversies, 'utf8');

    await assert.rejects(
      () =>
        detectControversyRelations(h.deps, {
          runId: RUN_ID,
          controversy_id: seed.controversyId,
          expert_slot: 'author',
        }),
      (error: unknown) =>
        isCcrError(error) &&
        ['DETECTION_ENDPOINT_NOT_SUBMITTED', 'ENTRY_OUTSIDE_CONTROVERSY'].includes(
          error.details['reason'] as string,
        ),
    );

    assert.equal(await readFile(h.paths.controversies, 'utf8'), before, 'tout-ou-rien : aucun octet');
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});
