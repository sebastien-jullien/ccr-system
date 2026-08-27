/**
 * Service applicatif de reprise canonique (Slice 7, Gate A2.1a).
 *
 * Ce qui est éprouvé ici n'est pas l'effet — il appartient à V1 et ses tests le
 * couvrent déjà — mais les deux garanties que la voie V2 ajoute :
 *
 * ```text
 * la vue sur laquelle l'humain a décidé est encore la vue courante
 * la capacité qu'il a choisie est encore celle que les faits produisent
 * ```
 *
 * et la séparation qui les rend possibles : le plan **canonique** ne consulte
 * aucun verrou, sans quoi le service verrait le sien et se refuserait à
 * lui-même l'action.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { applyCanonicalRecovery } from '../../src/services/recovery-application-service.ts';
import { composeCcrApplication } from '../../src/cli/composition.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { readState } from '../../src/store/state-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import type { PendingOperation, RunStateDocument } from '../../src/core/run.ts';

const RUN = 'CCR-20260402-001';

const PENDING_STEP: PendingOperation = {
  kind: 'step',
  agent: 'claude',
  round: 1,
  prompt_event_id: 'evt_000002',
  source_event_id: null,
  session_id: 'claude-1',
  return_state: 'READY',
  return_control: 'AUTOMATION',
  started_at: T,
};

const UNCERTAINTY = {
  reason: 'tour engagé sans réponse',
  since: T,
  agent: 'claude' as const,
  last_event_id: 'evt_000002',
};

interface Counters {
  claude: number;
  codex: number;
}

interface Box {
  readonly runsDir: string;
  readonly deps: ReturnType<typeof composeCcrApplication>['runService'];
  readonly calls: Counters;
  revision(): Promise<string>;
  state(): Promise<RunStateDocument>;
  events(): Promise<number>;
  manifest(): Promise<{ agents: Record<string, { session_id: string | null }> }>;
  cleanup(): Promise<void>;
}

async function open(options: {
  readonly state?: Partial<RunStateDocument>;
  readonly journaledResponse?: boolean;
  readonly missingSession?: 'claude' | 'codex';
  readonly withoutInitialPrompt?: boolean;
} = {}): Promise<Box> {
  const dir = await makeTempDir('ccr-recovery-svc-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });

  const events = [
    { round: 0, actor: 'system' as const, type: 'run_created' as const, content: 'départ', timestamp: T },
    ...(options.withoutInitialPrompt === true
      ? []
      : [{ round: 0, actor: 'human' as const, type: 'prompt_sent' as const, content: 'contexte initial', timestamp: T }]),
    ...(options.journaledResponse === true
      ? [
          {
            round: 1,
            actor: 'claude' as const,
            type: 'assistant_response' as const,
            session_id: 'claude-1',
            content: 'réponse déjà journalisée',
            based_on: ['evt_000002'],
            timestamp: T,
          },
        ]
      : []),
  ];

  await materializeRun(runsDir, {
    runId: RUN,
    events,
    ...(options.state === undefined ? {} : { state: options.state }),
  });

  const manifestFile = runPaths(runsDir, RUN).manifest;
  {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      agents: Record<string, { session_id: string | null }>;
      workspace: { cwd: string };
    };
    if (options.missingSession !== undefined) {
      const agent = manifest.agents[options.missingSession];
      if (agent !== undefined) agent.session_id = null;
    }
    // Un répertoire de travail réel : la continuation d'initialisation y lance
    // son adaptateur.
    manifest.workspace.cwd = dir;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  const calls: Counters = { claude: 0, codex: 0 };
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({
      kind: 'claude',
      sessionId: 'claude-1',
      onCall: () => {
        calls.claude += 1;
      },
    }),
    codex: createFakeAdapter({
      kind: 'codex',
      sessionId: 'codex-1',
      onCall: () => {
        calls.codex += 1;
      },
    }),
  };
  const app = composeCcrApplication({ runsDir, depsOverrides: { createAdapters: () => adapters } });

  return {
    runsDir,
    deps: app.runService,
    calls,
    revision: async () => (await readStableRunSnapshot(runsDir, RUN)).revision,
    state: () => readState(runPaths(runsDir, RUN)),
    events: async () => (await (await openEventStore(runPaths(runsDir, RUN), RUN)).readAll()).length,
    manifest: async () =>
      JSON.parse(await readFile(manifestFile, 'utf8')) as { agents: Record<string, { session_id: string | null }> },
    cleanup: () => removeTempDir(dir),
  };
}

const codeOf = (error: unknown): string => (isCcrError(error) ? error.code : String(error));

// --------------------------------------------------------------------------
// Les trois reprises courtes — effets V1, sans le moindre fournisseur
// --------------------------------------------------------------------------

test('(RA1) matérialisation d’une ambiguïté : effet V1, aucun agent joint', async (t) => {
  const b = await open({ state: { state: 'WAITING_AGENT', pending_operation: PENDING_STEP } });
  try {
    const before = await b.revision();
    const outcome = await applyCanonicalRecovery(b.deps, {
      runId: RUN,
      expectedRevision: before,
      capability: 'RECOVERY_MATERIALIZE_AMBIGUITY',
    });
    const state = await b.state();
    t.diagnostic(
      `matérialisation → état=${state.state}/${state.control} · claude=${String(b.calls.claude)} · codex=${String(b.calls.codex)}`,
    );

    assert.equal(outcome.capability, 'RECOVERY_MATERIALIZE_AMBIGUITY');
    assert.equal(outcome.revisionBefore, before);
    assert.notEqual(outcome.revisionAfter, before, 'un fait canonique a été écrit');
    assert.equal(state.state, 'RECOVERY_REQUIRED');
    assert.equal(state.control, 'HUMAN');
    // V1 préserve délibérément l'opération abandonnée : elle reste la preuve.
    assert.notEqual(state.pending_operation, null);
    assert.equal(b.calls.claude, 0);
    assert.equal(b.calls.codex, 0);
  } finally {
    await b.cleanup();
  }
});

test('(RA2) acquittement : note transmise telle quelle, retour en PAUSED/HUMAN', async (t) => {
  const NOTE = 'J’ai vérifié le terminal : rien n’a été envoyé.';
  const b = await open({
    state: {
      state: 'RECOVERY_REQUIRED',
      control: 'HUMAN',
      pending_operation: PENDING_STEP,
      uncertainty: UNCERTAINTY,
    },
  });
  try {
    const outcome = await applyCanonicalRecovery(b.deps, {
      runId: RUN,
      expectedRevision: await b.revision(),
      capability: 'RECOVERY_ACKNOWLEDGE_AMBIGUITY',
      acknowledgementText: NOTE,
    });
    const state = await b.state();
    const journal = await (await openEventStore(runPaths(b.runsDir, RUN), RUN)).readAll();
    const acknowledged = journal.find((event) => event.details?.['reason'] === 'RECOVERY_ACKNOWLEDGED');
    t.diagnostic(`acquittement → état=${state.state}/${state.control} · note=« ${String(acknowledged?.content)} »`);

    assert.equal(outcome.capability, 'RECOVERY_ACKNOWLEDGE_AMBIGUITY');
    assert.equal(state.state, 'PAUSED');
    assert.equal(state.control, 'HUMAN');
    assert.equal(state.pending_operation, null);
    assert.equal(state.uncertainty, null);
    assert.equal(acknowledged?.content, NOTE, 'la note humaine est transmise sans transformation');
    assert.equal(acknowledged?.actor, 'human');
    assert.equal(b.calls.claude, 0);
    assert.equal(b.calls.codex, 0);
  } finally {
    await b.cleanup();
  }
});

test('(RA3) finalisation depuis une réponse journalisée : aucun rappel d’agent', async (t) => {
  const b = await open({
    state: { state: 'WAITING_AGENT', pending_operation: PENDING_STEP },
    journaledResponse: true,
  });
  try {
    const outcome = await applyCanonicalRecovery(b.deps, {
      runId: RUN,
      expectedRevision: await b.revision(),
      capability: 'RECOVERY_FINALIZE_JOURNALED_RESPONSE',
    });
    const state = await b.state();
    t.diagnostic(
      `finalisation → état=${state.state}/${state.control} · claude=${String(b.calls.claude)} · codex=${String(b.calls.codex)}`,
    );

    assert.equal(outcome.capability, 'RECOVERY_FINALIZE_JOURNALED_RESPONSE');
    assert.equal(state.pending_operation, null, 'l’opération est finalisée');
    assert.equal(b.calls.claude, 0, 'la réponse était déjà là : personne n’est rappelé');
    assert.equal(b.calls.codex, 0);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Ce qui condamne une intention — et n'atteint jamais la couture
// --------------------------------------------------------------------------

test('(RA4) révision périmée : refus sous le verrou, aucun effet, couture jamais atteinte', async (t) => {
  const b = await open({ state: { state: 'WAITING_AGENT', pending_operation: PENDING_STEP } });
  try {
    const stale = await b.revision();
    const eventsBefore = await b.events();
    let ready = 0;

    await assert.rejects(
      applyCanonicalRecovery(
        b.deps,
        { runId: RUN, expectedRevision: stale, capability: 'RECOVERY_MATERIALIZE_AMBIGUITY' },
        {
          onReadyForEffect: () => {
            ready += 1;
          },
          // Un tiers écrit pendant que l'intention est en vol : c'est la
          // fenêtre exacte que le verrou referme.
          beforeLock: async () => {
            const store = await openEventStore(runPaths(b.runsDir, RUN), RUN);
            await store.append({
              round: 0,
              actor: 'human',
              type: 'human_message',
              content: 'écriture concurrente',
              timestamp: new Date().toISOString(),
            });
          },
        },
      ),
      (error: unknown) => {
        assert.equal(codeOf(error), 'STALE_REVISION');
        return true;
      },
    );

    t.diagnostic(`révision périmée → couture appelée ${String(ready)} fois`);
    assert.equal(ready, 0, 'une intention condamnée n’atteint jamais la préparation de l’effet');
    assert.equal((await b.state()).state, 'WAITING_AGENT', 'aucun effet de reprise');
    assert.equal(await b.events(), eventsBefore + 1, 'seule l’écriture du tiers existe');
    assert.equal(b.calls.claude, 0);
  } finally {
    await b.cleanup();
  }
});

test('(RA5) capacité périmée : le plan canonique est rejoué sous le verrou, et il tranche', async (t) => {
  const b = await open({ state: { state: 'WAITING_AGENT', pending_operation: PENDING_STEP } });
  try {
    let ready = 0;

    // L'humain a lu une vue annonçant `MATERIALIZE`. La réponse arrive ensuite
    // dans le journal : les faits canoniques produisent désormais `FINALIZE`.
    const store = await openEventStore(runPaths(b.runsDir, RUN), RUN);
    await store.append({
      round: 1,
      actor: 'claude',
      type: 'assistant_response',
      session_id: 'claude-1',
      content: 'réponse arrivée entre-temps',
      based_on: ['evt_000002'],
      timestamp: new Date().toISOString(),
    });
    const revision = await b.revision();
    const eventsBefore = await b.events();

    await assert.rejects(
      applyCanonicalRecovery(
        b.deps,
        { runId: RUN, expectedRevision: revision, capability: 'RECOVERY_MATERIALIZE_AMBIGUITY' },
        {
          onReadyForEffect: () => {
            ready += 1;
          },
        },
      ),
      (error: unknown) => {
        assert.equal(codeOf(error), 'RECOVERY_CAPABILITY_STALE');
        return true;
      },
    );

    t.diagnostic(`capacité périmée → couture appelée ${String(ready)} fois`);
    assert.equal(ready, 0, 'aucune préparation d’effet sur une capacité qui n’est plus la bonne');
    assert.equal(await b.events(), eventsBefore, 'aucun effet de reprise');
    assert.equal((await b.state()).state, 'WAITING_AGENT');
    assert.equal(b.calls.claude, 0);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Cohérence de l'intention — là où V1 se taisait
// --------------------------------------------------------------------------

test('(RA6) la note d’acquittement n’est ni facultative, ni tolérée ailleurs', async (t) => {
  const b = await open({
    state: {
      state: 'RECOVERY_REQUIRED',
      control: 'HUMAN',
      pending_operation: PENDING_STEP,
      uncertainty: UNCERTAINTY,
    },
  });
  try {
    const revision = await b.revision();
    const cases = [
      ['acquittement sans note', { capability: 'RECOVERY_ACKNOWLEDGE_AMBIGUITY' as const }],
      ['acquittement vide', { capability: 'RECOVERY_ACKNOWLEDGE_AMBIGUITY' as const, acknowledgementText: '   ' }],
      ['note sur une autre capacité', { capability: 'RECOVERY_FINALIZE_JOURNALED_RESPONSE' as const, acknowledgementText: 'note' }],
    ] as const;

    for (const [label, extra] of cases) {
      await assert.rejects(
        applyCanonicalRecovery(b.deps, { runId: RUN, expectedRevision: revision, ...extra }),
        (error: unknown) => {
          assert.equal(codeOf(error), 'INVALID_ARGUMENT', label);
          return true;
        },
      );
      t.diagnostic(`${label} → INVALID_ARGUMENT`);
    }

    // Aucun de ces refus n'a touché le run — la cohérence est vérifiée avant
    // même l'acquisition du verrou.
    assert.equal(await b.revision(), revision);
    assert.equal((await b.state()).state, 'RECOVERY_REQUIRED');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// La seule capacité qui joint un fournisseur
// --------------------------------------------------------------------------

test('(RA7) continuation d’initialisation : la couture précède strictement le fournisseur', async (t) => {
  const b = await open({ missingSession: 'codex', state: { state: 'FAILED_INITIALIZATION' } });
  try {
    let providersAtHook = -1;
    const outcome = await applyCanonicalRecovery(
      b.deps,
      {
        runId: RUN,
        expectedRevision: await b.revision(),
        capability: 'RECOVERY_CONTINUE_INITIALIZATION',
      },
      {
        onReadyForEffect: () => {
          providersAtHook = b.calls.claude + b.calls.codex;
        },
      },
    );

    const manifest = await b.manifest();
    t.diagnostic(
      `couture : fournisseurs=${String(providersAtHook)} · après : claude=${String(b.calls.claude)} · ` +
        `codex=${String(b.calls.codex)} · session codex=${String(manifest.agents['codex']?.session_id)}`,
    );

    assert.equal(providersAtHook, 0, 'la couture est atteinte avant tout fournisseur');
    assert.equal(b.calls.codex, 1, 'la session manquante est créée');
    assert.equal(b.calls.claude, 0, 'la session partenaire n’est jamais recréée');
    assert.equal(manifest.agents['codex']?.session_id, 'codex-1');
    assert.equal(outcome.capability, 'RECOVERY_CONTINUE_INITIALIZATION');
    assert.notEqual(outcome.revisionAfter, outcome.revisionBefore);
  } finally {
    await b.cleanup();
  }
});

test('(RA8) aucun contexte initial : refus APRÈS la couture, et zéro fournisseur', async (t) => {
  const b = await open({
    missingSession: 'codex',
    state: { state: 'FAILED_INITIALIZATION' },
    withoutInitialPrompt: true,
  });
  try {
    let ready = 0;
    await assert.rejects(
      applyCanonicalRecovery(
        b.deps,
        {
          runId: RUN,
          expectedRevision: await b.revision(),
          capability: 'RECOVERY_CONTINUE_INITIALIZATION',
        },
        {
          onReadyForEffect: () => {
            ready += 1;
          },
        },
      ),
      (error: unknown) => {
        assert.equal(codeOf(error), 'NO_TRANSFERABLE_SOURCE');
        return true;
      },
    );

    const manifest = await b.manifest();
    t.diagnostic(
      `sans contexte initial → couture appelée ${String(ready)} fois · claude=${String(b.calls.claude)} · codex=${String(b.calls.codex)}`,
    );

    // Fait gelé : la couture précède la découverte du défaut. Au transport,
    // `NO_TRANSFERABLE_SOURCE` sera donc un échec **après** admission — la
    // requête propriétaire aura déjà rendu son `202`.
    assert.equal(ready, 1, 'la couture précède la découverte du défaut');
    assert.equal(b.calls.claude, 0, 'aucun agent joint');
    assert.equal(b.calls.codex, 0);
    assert.equal(manifest.agents['codex']?.session_id, null, 'aucune session inventée');
  } finally {
    await b.cleanup();
  }
});
