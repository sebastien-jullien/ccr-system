/**
 * V2.1-IMP-17C — mutations HTTP natives.
 *
 * Le transport ne devient pas un second moteur. Ce qu'il compose, c'est la
 * précondition de vue et sa capture d'après, aux deux seules positions où elles
 * sont correctes : à l'intérieur du verrou que le service détient déjà.
 *
 * Trois propriétés gouvernent ce fichier.
 *
 *  1. **La génération précède la sémantique.** « claude » nomme un agent dans un
 *     run historique et un moteur dans un run natif ; le mot ne peut pas
 *     trancher pour le run.
 *  2. **Une vue périmée l'emporte.** `STALE_REVISION` gagne sur tout refus
 *     métier constaté ensuite, et ne consomme ni créneau ni fournisseur.
 *  3. **Un échec n'implique pas un état inchangé.** Un chemin qui écrit avant de
 *     rejeter porte sa `revision_after`, capturée sous le verrou.
 *
 * Aucun fournisseur réel, aucun terminal, aucun serveur : les adapters sont des
 * fixtures, et chaque refus compte les appels pour démontrer qu'aucun n'a eu
 * lieu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { createOperationStore, newServerInstanceId, toPublicReceipt } from '../../src/cockpit/operations-store.ts';
import type { OperationStore } from '../../src/cockpit/operations-store.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import type { LongOperationManager } from '../../src/cockpit/long-operations.ts';
import {
  executeLongMutation,
  executeRecoveryMutation,
  executeShortMutation,
  executeStartMutation,
} from '../../src/cockpit/mutations-http.ts';
import type { MutationResponse } from '../../src/cockpit/mutations-http.ts';
import { readNativeRunHttpView } from '../../src/cockpit/native-read-http.ts';
import { readRunGeneration } from '../../src/store/run-directory.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { startRun } from '../../src/services/run-service.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const KEY = 'idem-key-0000000001';

interface Harness {
  readonly runsDir: string;
  readonly store: OperationStore;
  readonly manager: LongOperationManager;
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  readonly preflightSeams: {
    readonly probes: Record<ProviderKind, () => Promise<AgentRuntimeProbe>>;
    readonly configPath: string;
    readonly env: Record<string, string>;
  };
  calls(): number;
  interactives(): number;
}

async function harness(
  dir: string,
  options: {
    sessions?: Partial<Record<ProviderKind, readonly string[]>>;
    /** Fait échouer le premier `start()` du moteur nommé : initialisation partielle. */
    failStartOf?: ProviderKind;
  } = {},
): Promise<Harness> {
  const dataRoot = await resolveCockpitDataRoot(dir);
  const interactives: string[] = [];
  let failed = false;
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: options.sessions?.[kind] ?? [`${kind}-1`, `${kind}-2`],
      sessionId: `${kind}-1`,
      ...(options.failStartOf === kind
        ? {
            failStart: (): unknown => {
              if (failed) return undefined;
              failed = true;
              return new Error('fournisseur indisponible');
            },
          }
        : {}),
      onInteractive: (sessionId) => {
        interactives.push(`${kind}:${sessionId}`);
      },
    });
  const adapters = { claude: build('claude'), codex: build('codex') };

  const probe = (agent: ProviderKind): AgentRuntimeProbe => ({
    agent,
    installed: true,
    version: '1.0.0',
    authStatus: 'AUTHENTICATED',
    launcherSource: 'path',
  });

  return {
    runsDir: dataRoot.runsDir,
    store: createOperationStore(dataRoot, newServerInstanceId()),
    manager: createLongOperationManager(),
    adapters,
    deps: {
      runsDir: dataRoot.runsDir,
      now: () => new Date(),
      createAdapters: (): AgentAdapters => adapters,
    },
    preflightSeams: {
      configPath: path.join(dataRoot.controlDir, 'config-isole.json'),
      env: {},
      probes: { claude: async () => probe('claude'), codex: async () => probe('codex') },
    },
    calls: () => adapters.claude.calls.length + adapters.codex.calls.length,
    interactives: () => interactives.length,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

interface Receipt {
  readonly status: string;
  readonly error_code?: string;
  readonly revision_after?: string;
  readonly created_run_id?: string;
  readonly operation_id: string;
}

function receiptOf(body: unknown): Receipt {
  return body as Receipt;
}

function errorCodeOf(result: { body: unknown; receipt: Receipt }): string {
  const shaped = result.body as { error?: { code?: string } };
  return result.receipt.error_code ?? shaped.error?.code ?? '';
}

/**
 * Attend la terminalisation d'une opération.
 *
 * Une opération longue rend `202` **dès l'admission** : le reçu terminal arrive
 * ensuite. Observer la réponse immédiate ne dirait donc rien de l'effet.
 */
async function settle(
  h: Harness,
  response: MutationResponse,
): Promise<{ body: unknown; receipt: Receipt }> {
  // Le corps d'un refus est une enveloppe d'erreur, pas un reçu : c'est le
  // champ `receipt` qui porte toujours la résolution.
  const immediate = receiptOf(response.receipt);
  if (response.status !== 202) return { body: response.body, receipt: immediate };
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const current = await h.store.read(immediate.operation_id);
    if (current !== undefined && current.status !== 'RUNNING') {
      return { body: response.body, receipt: toPublicReceipt(current) as Receipt };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`opération ${immediate.operation_id} non terminalisée`);
}

/** Crée un run natif par la voie HTTP, et rend son identifiant. */
async function startNative(
  h: Harness,
  payload: Record<string, unknown> = {},
  key = KEY,
): Promise<string> {
  const response = await executeStartMutation(
    {
      store: h.store,
      manager: h.manager,
      createRunServiceDeps: () => h.deps,
      preflightSeams: h.preflightSeams,
    },
    {
      contentType: 'application/json',
      idempotencyKey: key,
      body: json({ title: 'T', workspace_cwd: process.cwd(), prompt: 'mission', ...payload }),
    },
  );
  const runId = (await settle(h, response)).receipt.created_run_id;
  assert.ok(runId !== undefined, `run alloué (${json(response.body)})`);
  return runId;
}

async function revisionOf(h: Harness, runId: string): Promise<string> {
  return (await readNativeRunHttpView({ runsDir: h.runsDir }, runId)).revision;
}

async function shortMutation(
  h: Harness,
  runId: string,
  segment: string,
  body: Record<string, unknown>,
  key = 'idem-short-000000001',
): Promise<{ body: unknown; receipt: Receipt }> {
  return settle(
    h,
    await executeShortMutation(
    { runService: h.deps, store: h.store },
    {
      routeSegment: segment,
      runId,
      generation: await readRunGeneration(h.runsDir, runId),
      contentType: 'application/json',
      idempotencyKey: key,
      body: json(body),
    },
  ),
  );
}

async function longMutation(
  h: Harness,
  runId: string,
  segment: string,
  body: Record<string, unknown>,
  key = 'idem-long-0000000001',
): Promise<{ body: unknown; receipt: Receipt }> {
  return settle(
    h,
    await executeLongMutation(
    { runService: h.deps, store: h.store, manager: h.manager },
    {
      routeSegment: segment,
      runId,
      generation: await readRunGeneration(h.runsDir, runId),
      contentType: 'application/json',
      idempotencyKey: key,
      body: json(body),
    },
  ),
  );
}

async function journalOf(h: Harness, runId: string): Promise<string> {
  return readFile(runPaths(h.runsDir, runId).events, 'utf8');
}

// ==========================================================================
// A. START
// ==========================================================================

test('1–4 · `POST /api/runs` crée un run natif, defaults gelés et permutations', async () => {
  const dir = await makeTempDir('ccr-17c-start-');
  try {
    const h = await harness(dir);
    const runId = await startNative(h);

    // 1 · natif, et non historique.
    assert.equal(await readRunGeneration(h.runsDir, runId), 'NATIVE_V21_EXECUTION');
    const persisted = await readPersistedManifest(runPaths(h.runsDir, runId));
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    // 2 · defauts gelés de V2.1.
    assert.equal(persisted.manifest.experts.author.provider, 'codex');
    assert.equal(persisted.manifest.experts.challenger.provider, 'claude');
    assert.equal(h.calls(), 2, 'deux positions initiales, deux appels simulés');

    // 3 · same-provider valide, et deux sessions distinctes.
    const same = await harness(await makeTempDir('ccr-17c-start-same-'), {
      sessions: { claude: ['C1', 'C2'] },
    });
    const sameId = await startNative(same, { author_provider: 'claude', challenger_provider: 'claude' });
    const sameManifest = await readPersistedManifest(runPaths(same.runsDir, sameId));
    if (sameManifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('natif attendu');
    assert.equal(sameManifest.manifest.experts.author.provider, 'claude');
    assert.equal(sameManifest.manifest.experts.challenger.provider, 'claude');
    assert.notEqual(
      sameManifest.manifest.experts.author.session_id,
      sameManifest.manifest.experts.challenger.session_id,
    );

    // 4 · un moteur inconnu est un refus d'usage, avant toute allocation.
    await assert.rejects(
      startNative(h, { author_provider: 'gemini' }, 'idem-key-0000000002'),
      (error: unknown) => isCcrError(error) && error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('5–6 · START est idempotent, et un conflit d’empreinte ne crée aucun second run', async () => {
  const dir = await makeTempDir('ccr-17c-start-idem-');
  try {
    const h = await harness(dir);
    const first = await startNative(h);
    const callsAfterFirst = h.calls();

    // 5 · même clé, même payload : même reçu, même run, aucun second appel.
    const replay = await startNative(h);
    assert.equal(replay, first);
    assert.equal(h.calls(), callsAfterFirst, 'aucun second fournisseur simulé');

    // 6 · même clé, payload différent : conflit, et toujours un seul run.
    let conflictCode = '';
    try {
      await executeStartMutation(
        {
          store: h.store,
          manager: h.manager,
          createRunServiceDeps: () => h.deps,
          preflightSeams: h.preflightSeams,
        },
        {
          contentType: 'application/json',
          idempotencyKey: KEY,
          body: json({ title: 'AUTRE', workspace_cwd: process.cwd(), prompt: 'autre' }),
        },
      );
    } catch (error) {
      conflictCode = isCcrError(error) ? error.code : 'INATTENDU';
    }
    assert.notEqual(conflictCode, '', 'même clé, autre intention : conflit');
    assert.equal(h.calls(), callsAfterFirst, 'aucun second run, aucun second appel');
  } finally {
    await removeTempDir(dir);
  }
});

test('7 · une initialisation partielle conserve le run et son identité', async () => {
  const dir = await makeTempDir('ccr-17c-start-partial-');
  try {
    // Le challenger échoue : la doctrine V1 conserve la session de l'author.
    const h = await harness(dir, { failStartOf: 'claude' });

    const response = await executeStartMutation(
      {
        store: h.store,
        manager: h.manager,
        createRunServiceDeps: () => h.deps,
        preflightSeams: h.preflightSeams,
      },
      {
        contentType: 'application/json',
        idempotencyKey: KEY,
        body: json({ title: 'T', workspace_cwd: process.cwd(), prompt: 'mission' }),
      },
    );
    const runId = (await settle(h, response)).receipt.created_run_id;
    assert.ok(runId !== undefined, 'le run alloué reste nommable');

    const state = await readPersistedState(runPaths(h.runsDir, runId));
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('natif attendu');
    assert.equal(state.document.state, 'FAILED_INITIALIZATION');
    const manifest = await readPersistedManifest(runPaths(h.runsDir, runId));
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('natif attendu');
    assert.notEqual(manifest.manifest.experts.author.session_id, null, 'session déjà obtenue conservée');
    assert.equal(manifest.manifest.experts.challenger.session_id, null);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. PAUSE / RESUME
// ==========================================================================

test('8–10 · PAUSE natif applique la révision sous le verrou et rend `revision_after`', async () => {
  const dir = await makeTempDir('ccr-17c-pause-');
  try {
    const h = await harness(dir);
    const runId = await startNative(h);
    const before = await revisionOf(h, runId);

    // 8 · succès, et la révision d'après est celle de l'effet.
    const ok = await shortMutation(h, runId, 'pause', { expected_revision: before });
    const receipt = ok.receipt;
    assert.equal(receipt.status, 'SUCCEEDED');
    assert.ok(receipt.revision_after !== undefined);
    assert.notEqual(receipt.revision_after, before);
    assert.equal(receipt.revision_after, await revisionOf(h, runId));
    const state = await readPersistedState(runPaths(h.runsDir, runId));
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('natif attendu');
    assert.equal(state.document.state, 'PAUSED');
    assert.equal(state.document.control, 'HUMAN');

    // 9 · rejeu de la même clé : aucun second `run_paused`.
    const journalBefore = await journalOf(h, runId);
    const replay = await shortMutation(h, runId, 'pause', { expected_revision: before });
    assert.equal(replay.receipt.operation_id, receipt.operation_id);
    assert.equal(await journalOf(h, runId), journalBefore);

    // 10 · une vue périmée est refusée, sans le moindre effet.
    const stale = await shortMutation(h, runId, 'resume', { expected_revision: before }, 'idem-stale-000000001');
    assert.equal(errorCodeOf(stale), 'STALE_REVISION');
    assert.equal(await journalOf(h, runId), journalBefore);
  } finally {
    await removeTempDir(dir);
  }
});

test('11–12 · RESUME : la vue périmée l’emporte sur le refus métier conflictuel', async () => {
  const dir = await makeTempDir('ccr-17c-resume-conflict-');
  try {
    const h = await harness(dir);
    const runId = await startNative(h);
    await shortMutation(h, runId, 'pause', { expected_revision: await revisionOf(h, runId) }, 'idem-pause-000000001');

    // La vue lue par l'humain…
    const observed = await revisionOf(h, runId);

    // …puis les faits deviennent contradictoires : deux réponses pour un envoi.
    const paths = runPaths(h.runsDir, runId);
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('natif attendu');
    const { openNativeEventStore } = await import('../../src/store/native-event-store.ts');
    const events = await openNativeEventStore(paths, persisted.manifest);
    const message = await events.append({
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: persisted.manifest.experts.author.session_id as string,
      content: 'question',
    });
    for (const content of ['première', 'seconde']) {
      await events.append({
        round: 0,
        actor: 'expert',
        type: 'assistant_response',
        expert_slot_id: 'author',
        session_id: persisted.manifest.experts.author.session_id as string,
        content,
        exit_code: 0,
        based_on: [message.event_id],
      });
    }

    // 11 · la révision périmée gagne — c'est la priorité historique.
    const stale = await shortMutation(
      h,
      runId,
      'resume',
      { expected_revision: observed },
      'idem-stale-000000002',
    );
    assert.equal(errorCodeOf(stale), 'STALE_REVISION');

    // 12 · avec la vue courante, le refus métier apparaît, et lui seul.
    const conflict = await shortMutation(
      h,
      runId,
      'resume',
      { expected_revision: await revisionOf(h, runId) },
      'idem-conflict-00000001',
    );
    assert.equal(errorCodeOf(conflict), 'RECOVERY_EVIDENCE_CONFLICT');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. STEP
// ==========================================================================

test('13–15 · STEP natif : succès par le moteur natif, stale sans fournisseur', async () => {
  const dir = await makeTempDir('ccr-17c-step-');
  try {
    const h = await harness(dir);
    const runId = await startNative(h);
    const callsAfterStart = h.calls();
    const before = await revisionOf(h, runId);

    // 13 · une vue périmée n'ouvre aucun round et n'atteint aucun fournisseur.
    const journalBefore = await journalOf(h, runId);
    const stale = await longMutation(h, runId, 'step', { expected_revision: 'sha256:' + '0'.repeat(64) });
    assert.equal(errorCodeOf(stale), 'STALE_REVISION');
    assert.equal(h.calls(), callsAfterStart, 'aucun fournisseur simulé');
    assert.equal(await journalOf(h, runId), journalBefore);
    assert.equal(h.manager.activeCount(), 0, 'aucun créneau consommé');

    // 14 · succès : le service natif choisit source, cible et round.
    const ok = await longMutation(h, runId, 'step', { expected_revision: before }, 'idem-step-0000000002');
    assert.equal(ok.receipt.status, 'SUCCEEDED', json(ok.body));
    assert.equal(h.calls(), callsAfterStart + 1, 'exactement un appel simulé');
    const journal = await journalOf(h, runId);
    assert.ok(journal.includes('"type":"round_completed"'));
    assert.ok(journal.includes('"source_slot_id":"author"'));

    // 15 · le curseur a avancé, et la révision aussi.
    const state = await readPersistedState(runPaths(h.runsDir, runId));
    if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('natif attendu');
    assert.equal(state.document.next_step_source_slot, 'challenger');
    assert.notEqual(await revisionOf(h, runId), before);
  } finally {
    await removeTempDir(dir);
  }
});

test('16 · STEP : un échec après effet durable porte sa `revision_after`', async () => {
  const dir = await makeTempDir('ccr-17c-step-blocked-');
  try {
    const h = await harness(dir);
    const runId = await startNative(h);
    const callsAfterStart = h.calls();
    // Garde-fou de taille : `transfer_blocked`, WAITING_HUMAN/HUMAN, puis refus.
    // Chemin purement déterministe, sans le moindre fournisseur.
    const bounded: RunServiceDeps = { ...h.deps, maxTransferBytes: 8 };
    const boundedHarness: Harness = { ...h, deps: bounded };

    const before = await revisionOf(h, runId);
    const response = await settle(
      h,
      await executeLongMutation(
      { runService: bounded, store: h.store, manager: h.manager },
      {
        routeSegment: 'step',
        runId,
        generation: await readRunGeneration(h.runsDir, runId),
        contentType: 'application/json',
        idempotencyKey: 'idem-blocked-00000001',
        body: json({ expected_revision: before }),
      },
    ),
    );

    assert.equal(errorCodeOf(response), 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
    const receipt = response.receipt;
    assert.equal(receipt.status, 'FAILED');
    assert.ok(receipt.revision_after !== undefined, 'une intention qui échoue peut avoir écrit');
    assert.notEqual(receipt.revision_after, before);
    assert.equal(boundedHarness.calls(), callsAfterStart, 'aucun fournisseur atteint');
    assert.ok((await journalOf(h, runId)).includes('"type":"transfer_blocked"'));
    assert.equal(h.manager.activeCount(), 0, 'créneau libéré');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. SEND — la génération avant la cible
// ==========================================================================

test('17–19 · SEND natif : slots canoniques, alias 2A, aucune table dans le transport', async () => {
  const dir = await makeTempDir('ccr-17c-send-');
  try {
    const h = await harness(dir);
    const runId = await startNative(h);
    const callsAfterStart = h.calls();

    // 17 · cible canonique : un ExpertSlot.
    const ok = await longMutation(
      h,
      runId,
      'send',
      { expected_revision: await revisionOf(h, runId), target: 'author', content: 'précision' },
      'idem-send-0000000001',
    );
    assert.equal(ok.receipt.status, 'SUCCEEDED', json(ok.body));
    assert.equal(h.calls(), callsAfterStart + 1);
    const journal = await journalOf(h, runId);
    assert.ok(journal.includes('"type":"human_message"'));
    assert.ok(journal.includes('"target_expert_slot_id":"author"'));

    // 18 · alias mixed-provider : `claude` désigne le challenger, par 2A.
    const alias = await longMutation(
      h,
      runId,
      'send',
      { expected_revision: await revisionOf(h, runId), target: 'claude', content: 'via alias' },
      'idem-send-0000000002',
    );
    assert.equal(alias.receipt.status, 'SUCCEEDED', json(alias.body));
    assert.equal(h.calls(), callsAfterStart + 2);

    // 19 · une vue périmée n'écrit aucun message et n'appelle personne.
    const journalBefore = await journalOf(h, runId);
    const stale = await longMutation(
      h,
      runId,
      'send',
      { expected_revision: 'sha256:' + '1'.repeat(64), target: 'challenger', content: 'jamais' },
      'idem-send-0000000003',
    );
    assert.equal(errorCodeOf(stale), 'STALE_REVISION');
    assert.equal(await journalOf(h, runId), journalBefore);
    assert.equal(h.calls(), callsAfterStart + 2);
  } finally {
    await removeTempDir(dir);
  }
});

test('20–21 · SEND same-provider : les deux slots restent adressables, l’alias cède', async () => {
  const dir = await makeTempDir('ccr-17c-send-same-');
  try {
    const h = await harness(dir, { sessions: { claude: ['C1', 'C2'] } });
    const runId = await startNative(h, { author_provider: 'claude', challenger_provider: 'claude' });
    const callsAfterStart = h.calls();

    // 20 · `author` et `challenger` restent parfaitement adressables.
    for (const [slot, key] of [
      ['author', 'idem-same-0000000001'],
      ['challenger', 'idem-same-0000000002'],
    ] as const) {
      const response = await longMutation(
        h,
        runId,
        'send',
        { expected_revision: await revisionOf(h, runId), target: slot, content: `pour ${slot}` },
        key,
      );
      assert.equal(response.receipt.status, 'SUCCEEDED', `${slot} : ${json(response.body)}`);
    }
    assert.equal(h.calls(), callsAfterStart + 2);

    // 21 · l'alias devient ambigu, et l'autre moteur n'est lié à personne.
    const ambiguous = await longMutation(
      h,
      runId,
      'send',
      { expected_revision: await revisionOf(h, runId), target: 'claude', content: 'ambigu' },
      'idem-same-0000000003',
    );
    assert.equal(errorCodeOf(ambiguous), 'AMBIGUOUS_PROVIDER_ALIAS');

    const absent = await longMutation(
      h,
      runId,
      'send',
      { expected_revision: await revisionOf(h, runId), target: 'codex', content: 'absent' },
      'idem-same-0000000004',
    );
    assert.equal(errorCodeOf(absent), 'PROVIDER_ALIAS_NOT_BOUND');
    assert.equal(h.calls(), callsAfterStart + 2, 'aucun fournisseur pour un alias refusé');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Frontières encore fermées
// ==========================================================================

test('22–24 · DECIDE, STOP et la reprise native sont refusés explicitement', async () => {
  const dir = await makeTempDir('ccr-17c-frontieres-');
  try {
    const h = await harness(dir);
    const runId = await startNative(h);
    const revision = await revisionOf(h, runId);
    const journalBefore = await journalOf(h, runId);

    // 22–23 · DECIDE et STOP n'ont pas de service natif en V2.1.
    for (const [segment, body, key] of [
      ['decide', { expected_revision: revision, content: 'décision' }, 'idem-decide-00000001'],
      ['stop', { expected_revision: revision }, 'idem-stop-0000000001'],
    ] as const) {
      const response = await shortMutation(h, runId, segment, body, key);
      assert.equal(errorCodeOf(response), 'COMMAND_UNSUPPORTED_FOR_GENERATION', segment);
    }

    // 24 · la reprise native ne tombe jamais dans le moteur V1.
    // Le refus précède le claim : aucune opération n'est même ouverte, et la
    // reprise native ne peut donc pas tomber dans le moteur V1.
    let recoveryCode = '';
    try {
      await executeRecoveryMutation(
        { runService: h.deps, store: h.store, manager: h.manager },
        {
          routeSegment: 'continue-initialization',
          runId,
          generation: await readRunGeneration(h.runsDir, runId),
          contentType: 'application/json',
          idempotencyKey: 'idem-recover-0000001',
          body: json({ expected_revision: revision }),
        },
      );
    } catch (error) {
      recoveryCode = isCcrError(error) ? error.code : 'INATTENDU';
    }
    assert.equal(recoveryCode, 'COMMAND_UNSUPPORTED_FOR_GENERATION');

    assert.equal(await journalOf(h, runId), journalBefore, 'aucune de ces routes n’a écrit');
    assert.equal(h.interactives(), 0, 'FAKE_INTERACTIVE_CALLS = 0');
  } finally {
    await removeTempDir(dir);
  }
});

test('25 · un run historique conserve exactement ses services', async () => {
  const dir = await makeTempDir('ccr-17c-legacy-');
  try {
    const h = await harness(dir);
    const legacy = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'historique',
      cwd: 'E:/prog/exemple',
      prompt: 'p',
    });
    assert.equal(await readRunGeneration(h.runsDir, legacy.runId), 'LEGACY_V2_EXECUTION');

    const { readStableRunSnapshot } = await import('../../src/store/run-snapshot.ts');
    const revision = (await readStableRunSnapshot(h.runsDir, legacy.runId)).revision;

    // PAUSE historique : moteur V2, sémantique inchangée.
    const paused = await shortMutation(h, legacy.runId, 'pause', { expected_revision: revision }, 'idem-legacy-00000001');
    assert.equal(paused.receipt.status, 'SUCCEEDED');

    // Et `decide`, qui reste disponible sur un run historique.
    const decided = await shortMutation(
      h,
      legacy.runId,
      'decide',
      { expected_revision: paused.receipt.revision_after ?? revision, content: 'gouvernance' },
      'idem-legacy-00000002',
    );
    assert.equal(decided.receipt.status, 'SUCCEEDED');
  } finally {
    await removeTempDir(dir);
  }
});

test('26 · aucune route HANDOFF, et le transport n’atteint aucun terminal', async () => {
  const source = await readFile(
    new URL('../../src/cockpit/mutations-http.ts', import.meta.url),
    'utf8',
  );
  for (const forbidden of ['handoffNativeExpert', 'openInteractive', 'handoffRun']) {
    assert.equal(source.includes(forbidden), false, `le transport ne connaît pas ${forbidden}`);
  }
  const server = await readFile(new URL('../../src/cockpit/server.ts', import.meta.url), 'utf8');
  assert.equal(server.includes('handoff'), false, 'aucune route handoff');
});
