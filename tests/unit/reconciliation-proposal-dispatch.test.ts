/**
 * Preuves de la tranche S13 — section 2/3, le dispatch gouverné.
 *
 * Question de preuve :
 *
 * > **Un fournisseur peut-il obtenir qu'une proposition soit enregistrée sur un
 * > objet qu'il n'a pas vu, pendant que CCR tient le verrou, ou contre un état
 * > qui a changé depuis la référence de la tentative ?**
 *
 * Cinq propriétés.
 *
 *  1. **L'engagement précède l'appel.** L'adaptateur constate lui-même, à
 *     l'instant où il est invoqué, que son invocation est déjà au ledger — en
 *     version 4, sous le déclencheur `RECONCILIATION_PROPOSAL`.
 *  2. **Le verrou n'est pas tenu pendant l'appel** (`C43`). Une autre mutation
 *     du même run aboutit pendant que l'adaptateur attend : preuve dynamique,
 *     jamais lecture de source.
 *  3. **`R0` gouverne la tentative.** Une écriture V5 concurrente périme la
 *     référence, et le lot est refusé sans un octet.
 *  4. **`EXISTE MAINTENANT ≠ A ÉTÉ SOUMIS`.** Une unité apparue pendant l'appel
 *     résout parfaitement, et reste refusée.
 *  5. **Tout ou rien.** Aucun refus ne laisse une proposition partielle.
 *
 * Aucun fournisseur réel : l'adaptateur est une couture de test injectée.
 *
 * ```text
 * REAL_PROVIDER_CALLS = 0        FIXTURE ADAPTER  ≠  REAL PROVIDER
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
  validateControversyEntry,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import {
  INVOCATION_LEDGER_SCHEMA_VERSION,
  INVOCATION_LEDGER_SCHEMA_VERSION_V2,
  INVOCATION_LEDGER_SCHEMA_VERSION_V3,
  INVOCATION_LEDGER_SCHEMA_VERSION_V4,
  INVOCATION_TRIGGER_KINDS,
  RECONCILIATION_PROPOSAL_TRIGGER,
  SUPPORTED_INVOCATION_LEDGER_SCHEMA_VERSIONS,
  invocationLedgerSchemaVersionFor,
  invocationTriggerKindsFor,
} from '../../src/core/usage-governance.ts';
import type { InvocationTriggerKind } from '../../src/core/usage-governance.ts';
import {
  RECONCILIATION_SCHEMA_VERSION,
  formatReconciliationId,
} from '../../src/core/reconciliation.ts';
import type { ReconciliationEntry } from '../../src/core/reconciliation.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { readInvocationOutcomes } from '../../src/store/invocation-outcome-store.ts';
import {
  INVOCATION_OUTCOME_SCHEMA_VERSION,
  terminalOutcomeOf,
} from '../../src/core/invocation-outcome.ts';
import { appendControversyEntry } from '../../src/store/controversy-store.ts';
import {
  appendReconciliationEntries,
  readReconciliationJournal,
} from '../../src/store/reconciliation-store.ts';
import { withNativeMutation } from '../../src/services/native-mutation-boundary.ts';
import {
  PROPOSAL_REVALIDATION_CHECKS,
  RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
  proposeReconciliationByModel,
} from '../../src/services/reconciliation-proposer.ts';
import type {
  ReconciliationProposalOutcome,
  ReconciliationProposerDeps,
} from '../../src/services/reconciliation-proposer.ts';

const RUN_ID = 'CCR-20260820-913';
const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);
/** Apparaîtra PENDANT l'appel — jamais soumise. */
const E3 = formatControversyEntryId(3);

const EVENTS: readonly Record<string, unknown>[] = [
  {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-20T09:10:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'S1',
    content: 'Le cache doit expirer rapidement.',
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
        sessionId: `propose-${kind}-1`,
        content: script.content ?? '',
        exitCode: 0,
        startedAt: '2026-08-20T10:00:00.000Z',
        completedAt: '2026-08-20T10:00:01.000Z',
        stdoutRaw: script.content ?? '',
        stderrRaw: '',
      };
    },
    resume(): Promise<AgentTurnResult> {
      throw new Error("une proposition assistée ne reprend jamais la session d'un expert");
    },
    openInteractive(): never {
      throw new Error("une proposition assistée n'ouvre aucun terminal");
    },
  };
}

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: ReconciliationProposerDeps;
  calls(): number;
  dispose(): Promise<void>;
}

function unit(sequence: number): ControversyEntry {
  return validateControversyEntry({
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: CTV,
    kind: sequence === 1 ? 'CONTROVERSY_RECORDED' : 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'SOURCE', actor: 'author' },
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T09:30:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  } as ControversyEntry);
}

async function harness(script: AdapterScript = {}): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s13-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-08-20T09:00:00.000Z',
      title: 'S13',
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
      last_event_id: 'evt_000001',
      updated_at: '2026-08-20T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  await writeFile(
    paths.controversies,
    [unit(1), unit(2)].map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );

  const adapters = { claude: fakeAdapter('claude', script), codex: fakeAdapter('codex', script) };
  let tick = 0;
  const now = (): Date => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 20, 12, 0, tick));
  };

  return {
    runsDir,
    paths,
    deps: { runsDir, now, createAdapters: () => adapters },
    calls: () => adapters.claude.calls.length + adapters.codex.calls.length,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

function output(proposals: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
    target_controversy_id: CTV,
    proposals,
  });
}

const ONE_PROPOSAL = [{ scope: [E1], options: [{ option_id: 'oa', content: 'option a' }] }];

async function propose(h: Harness): Promise<ReconciliationProposalOutcome> {
  return proposeReconciliationByModel(h.deps, {
    runId: RUN_ID,
    target_controversy_id: CTV,
    scope_kind: 'SUBSET',
    scope: [E1, E2],
    expert_slot: 'challenger',
  });
}

async function v5Entries(h: Harness): Promise<readonly ReconciliationEntry[]> {
  if (!existsSync(h.paths.reconciliations)) return [];
  return (await readReconciliationJournal(h.paths)).entries;
}

async function ledgerLines(h: Harness): Promise<readonly Record<string, unknown>[]> {
  if (!existsSync(h.paths.invocations)) return [];
  const raw = await readFile(h.paths.invocations, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// --------------------------------------------------------------------------
// Gouvernance d'invocation — déclencheur dédié et versionné
// --------------------------------------------------------------------------

test('S13 — le déclencheur dédié existe, et n\'écrase aucun vocabulaire historique', () => {
  assert.equal(RECONCILIATION_PROPOSAL_TRIGGER, 'RECONCILIATION_PROPOSAL');
  assert.deepEqual([...INVOCATION_TRIGGER_KINDS], [
    'START',
    'STEP',
    'SEND',
    'RECOVERY_CONTINUE',
    'CONTROVERSY_DETECTION',
    'EVIDENCE_ADDUCTION',
    'RECONCILIATION_PROPOSAL',
  ]);
  assert.deepEqual([...SUPPORTED_INVOCATION_LEDGER_SCHEMA_VERSIONS], [1, 2, 3, 4]);

  // Les mappings historiques, inchangés — c'est la propriété centrale.
  assert.equal(invocationLedgerSchemaVersionFor('START'), INVOCATION_LEDGER_SCHEMA_VERSION);
  assert.equal(invocationLedgerSchemaVersionFor('STEP'), INVOCATION_LEDGER_SCHEMA_VERSION);
  assert.equal(invocationLedgerSchemaVersionFor('SEND'), INVOCATION_LEDGER_SCHEMA_VERSION);
  assert.equal(
    invocationLedgerSchemaVersionFor('RECOVERY_CONTINUE'),
    INVOCATION_LEDGER_SCHEMA_VERSION,
  );
  assert.equal(
    invocationLedgerSchemaVersionFor('CONTROVERSY_DETECTION'),
    INVOCATION_LEDGER_SCHEMA_VERSION_V2,
  );
  assert.equal(
    invocationLedgerSchemaVersionFor('EVIDENCE_ADDUCTION'),
    INVOCATION_LEDGER_SCHEMA_VERSION_V3,
  );
  // Et le nouveau, dans la version NOUVELLE.
  assert.equal(
    invocationLedgerSchemaVersionFor(RECONCILIATION_PROPOSAL_TRIGGER),
    INVOCATION_LEDGER_SCHEMA_VERSION_V4,
  );

  // `NO RETROACTIVE VOCABULARY REWRITE` : v1, v2 et v3 ignorent le nouveau
  // déclencheur. Sans liste v3 figée, il y serait entré par la porte de service.
  assert.deepEqual([...invocationTriggerKindsFor(1)], ['START', 'STEP', 'SEND', 'RECOVERY_CONTINUE']);
  assert.equal(invocationTriggerKindsFor(2).includes('EVIDENCE_ADDUCTION'), false);
  assert.equal(invocationTriggerKindsFor(3).includes('EVIDENCE_ADDUCTION'), true);
  assert.equal(invocationTriggerKindsFor(3).includes(RECONCILIATION_PROPOSAL_TRIGGER), false);
  assert.equal(invocationTriggerKindsFor(4).includes(RECONCILIATION_PROPOSAL_TRIGGER), true);
  // Une version inconnue ne reçoit AUCUN vocabulaire.
  assert.deepEqual([...invocationTriggerKindsFor(5)], []);
});

test('S13 — un déclencheur inconnu reste refusé AVANT écriture', async () => {
  const h = await harness();
  try {
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    await assert.rejects(
      () =>
        ledger.append(
          {
            identity: {
              generation: 'NATIVE_V21_EXECUTION',
              expert_slot: 'author',
              provider: 'codex',
            },
            trigger_kind: 'RECONCILIATION_PROPOSAL_V2' as unknown as InvocationTriggerKind,
          },
          new Date('2026-08-20T12:00:00.000Z'),
        ),
      (error: unknown) => isCcrError(error),
    );
    // Aucune ligne écrite : le refus précède l'octet.
    assert.deepEqual(await ledgerLines(h), []);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Engagement, verrou, cardinalité
// --------------------------------------------------------------------------

test('S13 — l\'engagement est écrit AVANT la tentative, en version 4', async () => {
  let observed: readonly Record<string, unknown>[] = [];
  const h = await harness({
    content: output(ONE_PROPOSAL),
    onCall: async () => {
      // Constaté à l'instant de l'appel, par l'adaptateur lui-même.
      const raw = await readFile(runPaths(h.runsDir, RUN_ID).invocations, 'utf8');
      observed = raw
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  });
  try {
    const outcome = await propose(h);
    assert.equal(outcome.kind, 'RECORDED');
    assert.equal(observed.length, 1);
    const engagement = observed[0];
    assert.ok(engagement, "l'engagement est déjà au ledger à l'instant de l'appel");
    assert.equal(engagement['trigger_kind'], RECONCILIATION_PROPOSAL_TRIGGER);
    assert.equal(engagement['schema_version'], INVOCATION_LEDGER_SCHEMA_VERSION_V4);
    assert.equal(engagement['kind'], 'DISPATCH_COMMITTED');
    // `invocation_id` — référence d'audit technique résoluble dans le ledger.
    assert.equal(engagement['invocation_id'], outcome.invocation_id);
    const relu = await ledgerLines(h);
    assert.equal(relu.length, 1);
    const reread = relu[0];
    assert.ok(reread, "l'engagement est relisible après l'opération");
    assert.equal(reread['invocation_id'], outcome.invocation_id);
  } finally {
    await h.dispose();
  }
});

test('S13 — `C43` : le verrou n\'est pas tenu pendant l\'appel fournisseur', async () => {
  let concurrent = false;
  const h = await harness({
    content: output(ONE_PROPOSAL),
    onCall: async () => {
      // Une VRAIE mutation du même run, sous le VRAI verrou, pendant l'attente.
      // Si le verrou était tenu, cette acquisition échouerait.
      await withNativeMutation(
        { runsDir: h.runsDir, runId: RUN_ID, command: 'v5-s13-concurrent' },
        async () => {
          await appendControversyEntry(runPaths(h.runsDir, RUN_ID), unit(3));
          concurrent = true;
        },
      );
    },
  });
  try {
    const outcome = await propose(h);
    assert.equal(concurrent, true, 'la mutation concurrente a échoué : le verrou était tenu');
    // Et la proposition aboutit quand même : la mutation V3 concurrente ne
    // périme pas la référence V5.
    assert.equal(outcome.kind, 'RECORDED');
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});

test('S13 — exactement un dispatch, aucun rejeu, aucun repli', async () => {
  const h = await harness({ content: 'sortie inexploitable' });
  try {
    const outcome = await propose(h);
    assert.equal(outcome.kind, 'INVALID_OUTPUT');
    // Une sortie inexploitable ne provoque NI retry, NI second modèle, NI
    // demande de correction, NI comparaison.
    assert.equal(h.calls(), 1);
    assert.deepEqual(await v5Entries(h), []);
    // L'engagement, lui, demeure : `ENGAGEMENT ≠ SUCCÈS`.
    assert.equal((await ledgerLines(h)).length, 1);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Refus avant engagement
// --------------------------------------------------------------------------

test('S13 — un refus de périmètre ne coûte rien : zéro dispatch, zéro engagement', async () => {
  const h = await harness({ content: output(ONE_PROPOSAL) });
  try {
    await assert.rejects(
      () =>
        proposeReconciliationByModel(h.deps, {
          runId: RUN_ID,
          target_controversy_id: CTV,
          scope_kind: 'SUBSET',
          // Une unité qui n'existe pas dans ce run.
          scope: [E1, formatControversyEntryId(99)],
          expert_slot: 'challenger',
        }),
      (error: unknown) => isCcrError(error),
    );
    assert.equal(h.calls(), 0, 'le fournisseur a été sollicité pour une condition déterminable');
    assert.equal(existsSync(h.paths.invocations), false);
    assert.deepEqual(await v5Entries(h), []);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// `R0` / `R1`
// --------------------------------------------------------------------------

test('S13 — `R0` / `R1` : une écriture V5 concurrente périme la tentative', async () => {
  const h = await harness({
    content: output(ONE_PROPOSAL),
    onCall: async () => {
      // Un acte humain V5 concurrent, écrit sous le verrou pendant l'appel : la
      // révision autoritaire V5 change, donc `R1 ≠ R0`.
      await withNativeMutation(
        { runsDir: h.runsDir, runId: RUN_ID, command: 'v5-s13-concurrent-v5' },
        async () => {
          const paths = runPaths(h.runsDir, RUN_ID);
          await appendReconciliationEntries(paths, [
            {
              schema_version: RECONCILIATION_SCHEMA_VERSION,
              entry_id: formatReconciliationId(1),
              kind: 'RECONCILIATION_RECORDED',
              target: { kind: 'CONTROVERSY', controversy_id: CTV },
              semantic_origin: 'HUMAN',
              recorded_by: 'CCR',
              recorded_at: '2026-08-20T11:59:00.000Z',
              observed_revision: 'rcn-sha256:concurrent',
              scope_kind: 'SUBSET',
              scope: [E1],
              content: 'décision humaine concurrente',
              provenance: { kind: 'DECLARED', statement: 'décidé en revue' },
            } as unknown as ReconciliationEntry,
          ]);
        },
      );
    },
  });
  try {
    const outcome = await propose(h);
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind !== 'REVALIDATION_REFUSED') throw new Error('inatteignable');
    assert.equal(outcome.check, 'R0');
    // La sortie du modèle était structurellement VALIDE : seul l'état a changé.
    // Aucune proposition n'est écrite — l'acte humain concurrent reste seul.
    const entries = await v5Entries(h);
    assert.equal(entries.length, 1);
    const concurrent = entries[0];
    assert.ok(concurrent, "l'acte humain concurrent demeure seul au journal");
    assert.equal(concurrent.kind, 'RECONCILIATION_RECORDED');
    assert.equal(h.calls(), 1);
    // L'engagement demeure enregistré.
    assert.equal((await ledgerLines(h)).length, 1);
  } finally {
    await h.dispose();
  }
});

test('S13 — `EXISTE MAINTENANT ≠ A ÉTÉ SOUMIS`', async () => {
  const h = await harness({
    // Le modèle nomme `E3`, qui n'existait pas au moment de la soumission.
    content: output([{ scope: [E3], options: [{ option_id: 'oa', content: 'a' }] }]),
    onCall: async () => {
      await withNativeMutation(
        { runsDir: h.runsDir, runId: RUN_ID, command: 'v5-s13-late-unit' },
        async () => {
          await appendControversyEntry(runPaths(h.runsDir, RUN_ID), unit(3));
        },
      );
    },
  });
  try {
    const outcome = await propose(h);
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind !== 'REVALIDATION_REFUSED') throw new Error('inatteignable');
    // `E3` RÉSOUT parfaitement dans l'état relu — la validation de périmètre
    // l'accepte. C'est l'appartenance à l'ensemble soumis qui le refuse.
    assert.equal(outcome.check, 'SUBMITTED_SET');
    assert.ok(outcome.detail.includes(E3));
    assert.deepEqual(await v5Entries(h), []);
  } finally {
    await h.dispose();
  }
});

test('S13 — les quatre contrôles de phase C, ensemble fermé', () => {
  assert.deepEqual([...PROPOSAL_REVALIDATION_CHECKS], [
    'R0',
    'SCOPE',
    'SUBMITTED_SET',
    'CANONICAL_FORM',
  ]);
});

// --------------------------------------------------------------------------
// Issues
// --------------------------------------------------------------------------

test('S13 — un échec fournisseur laisse l\'engagement et zéro proposition', async () => {
  const h = await harness({ fail: new Error('le moteur ne répond pas') });
  try {
    const outcome = await propose(h);
    assert.equal(outcome.kind, 'PROVIDER_FAILED');
    // `DISPATCH_COMMITTED ≠ SUCCÈS` : l'engagement est là, le succès non.
    assert.equal((await ledgerLines(h)).length, 1);
    assert.deepEqual(await v5Entries(h), []);
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});

test('S13 — un ensemble vide est une issue distincte, sans proposition', async () => {
  const h = await harness({ content: output([]) });
  try {
    const outcome = await propose(h);
    assert.equal(outcome.kind, 'VALID_ZERO');
    assert.deepEqual(await v5Entries(h), []);
    // Ne signifie ni « rien à réconcilier », ni accord : aucune de ces valeurs
    // n'existe dans l'issue.
    assert.deepEqual(Object.keys(outcome).sort(), ['invocation_id', 'kind']);

    // J — issue durable, version courante, aucune proposition inventée.
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

test('S13 — succès : un seul append atomique, origine CCR, dérivation MODEL_ASSISTED', async () => {
  const h = await harness({
    content: output([
      { scope: [E1], options: [{ option_id: 'ob', content: 'b' }, { option_id: 'oa', content: 'a' }] },
      { scope: [E2], options: [{ option_id: 'oc', content: 'c' }] },
    ]),
  });
  try {
    const outcome = await propose(h);
    assert.equal(outcome.kind, 'RECORDED');
    if (outcome.kind !== 'RECORDED') throw new Error('inatteignable');
    assert.equal(outcome.entries.length, 2);

    const entries = await v5Entries(h);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.kind, 'RECONCILIATION_PROPOSED');
      // `PROVIDER ≠ SEMANTIC ORIGIN` — le fournisseur est `codex`/`claude`,
      // l'origine reste CCR, et le scribe aussi.
      assert.equal(entry.semantic_origin, 'CCR');
      assert.equal(entry.recorded_by, 'CCR');
      assert.equal(String(entry.semantic_origin).includes('claude'), false);
      // Aucun effet humain, aucune provenance d'autorité.
      for (const forbidden of ['closure', 'closure_withdrawal', 'supersedes', 'content', 'provenance', 'responds_to']) {
        assert.equal(forbidden in entry, false, `${forbidden} présent`);
      }
    }
    const first = entries[0] as unknown as Record<string, unknown>;
    const derivation = first['derivation'] as Record<string, unknown>;
    assert.equal(derivation['method'], 'MODEL_ASSISTED');
    assert.equal(derivation['invocation_id'], outcome.invocation_id);
    // Les entrées de dérivation sont l'ensemble SOUMIS, jamais ce que le modèle
    // a nommé : elles ne peuvent pas affirmer ce qu'il n'a pas vu.
    assert.deepEqual(derivation['inputs'], [E1, E2]);
    // Une sélection dans un ensemble fourni reste un `SUBSET`.
    assert.equal(first['scope_kind'], 'SUBSET');
    // `ORDER ≠ PREFERENCE` — l'ordre des options du modèle est conservé.
    assert.deepEqual(
      (first['options'] as readonly { option_id: string }[]).map((o) => o.option_id),
      ['ob', 'oa'],
    );
    // Identités allouées contre le journal relu, en séquence.
    assert.deepEqual(
      entries.map((entry) => entry.entry_id),
      [formatReconciliationId(1), formatReconciliationId(2)],
    );
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});

test('S13 — tout ou rien : une seule proposition fautive laisse zéro octet', async () => {
  const h = await harness({
    content: output([
      { scope: [E1], options: [{ option_id: 'oa', content: 'a' }] },
      // La seconde nomme une unité jamais soumise et jamais existante.
      { scope: [formatControversyEntryId(77)], options: [{ option_id: 'ob', content: 'b' }] },
    ]),
  });
  try {
    const outcome = await propose(h);
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind !== 'REVALIDATION_REFUSED') throw new Error('inatteignable');
    assert.equal(outcome.check, 'SCOPE');
    // La PREMIÈRE proposition était parfaitement valide. Aucune n'est écrite.
    assert.deepEqual(await v5Entries(h), []);
    assert.equal(existsSync(h.paths.reconciliations), false);
  } finally {
    await h.dispose();
  }
});
