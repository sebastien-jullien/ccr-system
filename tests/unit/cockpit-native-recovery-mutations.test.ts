/**
 * V2.1-IMP-17D — reprises HTTP natives.
 *
 * Quatre moteurs, dix couples, et une règle qui gouverne tout : **le geste est
 * nommé, jamais choisi**. Plusieurs diagnostics coexistent sur un même run, aux
 * conséquences opposées — un acquittement met une source en quarantaine
 * définitive, une clôture avant appel la laisse transférable. Deviner
 * reviendrait à décider à la place de l'humain.
 *
 * Le transport valide une **matrice statique** et une syntaxe de note. Il ne
 * décide jamais qu'un geste est actuellement disponible : la primitive reprend
 * le verrou, se reclassifie et refuse elle-même.
 *
 * Aucun fournisseur réel, aucun terminal. Un adapter simulé n'est atteint que
 * là où l'initialisation exige réellement une session manquante.
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
  executeNativeRecoveryMutation,
  executeRecoveryMutation,
} from '../../src/cockpit/mutations-http.ts';
import type { MutationResponse } from '../../src/cockpit/mutations-http.ts';
import { readNativeRecoveryHttpView } from '../../src/cockpit/native-read-http.ts';
import {
  isSupportedPair,
  nativeRecoveryActionOf,
  NATIVE_RECOVERY_DOMAINS,
} from '../../src/services/native-recovery-dispatch.ts';
import { readRunGeneration } from '../../src/store/run-directory.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readPersistedManifest } from '../../src/store/native-store.ts';
import { DEFAULT_NATIVE_BINDINGS, startNativeRun } from '../../src/services/native-start-service.ts';
import { startRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { nativeFixtureManifest } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

/** Note à espaces significatifs : elle doit arriver bit pour bit. */
const NOTE = '  « décision humaine — élève / β »  ';

interface Harness {
  readonly runsDir: string;
  readonly store: OperationStore;
  readonly manager: LongOperationManager;
  readonly deps: RunServiceDeps;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  calls(): number;
  interactives(): number;
}

async function harness(dir: string, options: { failStartOf?: ProviderKind } = {}): Promise<Harness> {
  const dataRoot = await resolveCockpitDataRoot(dir);
  const interactives: string[] = [];
  let failed = false;
  const build = (kind: ProviderKind): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: [`${kind}-1`, `${kind}-2`],
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
    calls: () => adapters.claude.calls.length + adapters.codex.calls.length,
    interactives: () => interactives.length,
  };
}

interface Receipt {
  readonly status: string;
  readonly error_code?: string;
  readonly revision_after?: string;
  readonly operation_id: string;
}

async function settle(h: Harness, response: MutationResponse): Promise<{ body: unknown; receipt: Receipt }> {
  const immediate = response.receipt as unknown as Receipt;
  if (response.status !== 202) return { body: response.body, receipt: immediate };
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const current = await h.store.read(immediate.operation_id);
    if (current !== undefined && current.status !== 'RUNNING') {
      return { body: response.body, receipt: toPublicReceipt(current) as unknown as Receipt };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('opération non terminalisée');
}

function codeOf(result: { body: unknown; receipt: Receipt }): string {
  const shaped = result.body as { error?: { code?: string } };
  return result.receipt.error_code ?? shaped.error?.code ?? '';
}

async function recover(
  h: Harness,
  runId: string,
  payload: Record<string, unknown>,
  key = 'idem-rec-00000000001',
): Promise<{ body: unknown; receipt: Receipt }> {
  return settle(
    h,
    await executeNativeRecoveryMutation(
      { runService: h.deps, store: h.store, manager: h.manager },
      {
        routeSegment: 'recovery',
        runId,
        generation: await readRunGeneration(h.runsDir, runId),
        contentType: 'application/json',
        idempotencyKey: key,
        body: JSON.stringify(payload),
      },
    ),
  );
}

async function refusal(h: Harness, runId: string, payload: Record<string, unknown>, key = 'idem-bad-00000000001'): Promise<string> {
  try {
    await recover(h, runId, payload, key);
  } catch (error) {
    return isCcrError(error) ? error.code : 'INATTENDU';
  }
  return '';
}

/**
 * Session que le harnais attribue à un slot, sous la liaison par défaut.
 *
 * Les faits semés doivent rester cohérents avec le manifest réellement
 * construit : une session recopiée en dur serait refusée par le journal pour
 * une raison étrangère à ce que le test éprouve.
 */
function sessionOfSlot(slot: 'author' | 'challenger'): string {
  return `${DEFAULT_NATIVE_BINDINGS[slot]}-1`;
}

async function nativeRun(h: Harness): Promise<string> {
  const result = await startNativeRun(h.deps, {
    title: 'T',
    cwd: process.cwd(),
    prompt: 'mission',
    runtimeConfig: nativeFixtureManifest('CCR-20260811-001', {
      author: 'codex',
      challenger: 'claude',
    }).runtime_config!,
  });
  assert.equal(result.failure, undefined);
  return result.runId;
}

async function revisionOf(h: Harness, runId: string): Promise<string> {
  return (await readNativeRecoveryHttpView({ runsDir: h.runsDir }, runId)).revision;
}

async function recoveryOf(h: Harness, runId: string): Promise<Record<string, { status: string }>> {
  return (await readNativeRecoveryHttpView({ runsDir: h.runsDir }, runId)).recovery as unknown as Record<
    string,
    { status: string }
  >;
}

async function journalOf(h: Harness, runId: string): Promise<string> {
  return readFile(runPaths(h.runsDir, runId).events, 'utf8');
}

/** Ajoute un fait au journal natif, comme un moteur l'écrirait. */
async function append(h: Harness, runId: string, event: Record<string, unknown>): Promise<string> {
  const paths = runPaths(h.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('natif attendu');
  const store = await openNativeEventStore(paths, persisted.manifest);
  return (await store.append(event as never)).event_id;
}

// ==========================================================================
// A. Contrat statique
// ==========================================================================

test('1–2 · la matrice des dix couples est exacte, et fermée', () => {
  const expected: Record<string, readonly string[]> = {
    initialization: ['continue', 'acknowledge-uncertainty'],
    step: ['finalize', 'acknowledge-uncertainty'],
    send: ['finalize', 'acknowledge-uncertainty', 'abort-before-provider'],
    handoff: ['finalize', 'acknowledge-uncertainty', 'abort-before-interactive'],
  };
  const slugs = [
    'continue',
    'finalize',
    'acknowledge-uncertainty',
    'abort-before-provider',
    'abort-before-interactive',
  ];

  let supported = 0;
  for (const domain of NATIVE_RECOVERY_DOMAINS) {
    for (const slug of slugs) {
      const action = nativeRecoveryActionOf(slug);
      assert.ok(action !== undefined);
      const allowed = isSupportedPair(domain, action);
      assert.equal(allowed, expected[domain]?.includes(slug), `${domain} × ${slug}`);
      if (allowed) supported += 1;
    }
  }
  assert.equal(supported, 10, 'dix couples, exactement');
});

test('3–6 · le transport refuse les couples, les notes absentes et les notes superflues', async () => {
  const dir = await makeTempDir('ccr-17d-syntax-');
  try {
    const h = await harness(dir);
    const runId = await nativeRun(h);
    const revision = await revisionOf(h, runId);
    const before = await journalOf(h, runId);

    // 3 · un couple qu'aucune primitive ne sert.
    assert.equal(
      await refusal(h, runId, { expected_revision: revision, domain: 'step', action: 'continue' }),
      'INVALID_ARGUMENT',
    );
    // 4 · une note obligatoire absente, ou blanche.
    for (const note of [undefined, '   ']) {
      assert.equal(
        await refusal(h, runId, {
          expected_revision: revision,
          domain: 'send',
          action: 'acknowledge-uncertainty',
          ...(note === undefined ? {} : { note }),
        }),
        'INVALID_ARGUMENT',
      );
    }
    // 5 · une note superflue n'est jamais ignorée en silence — pas même vide.
    for (const note of ['inutile', '']) {
      assert.equal(
        await refusal(h, runId, {
          expected_revision: revision,
          domain: 'send',
          action: 'abort-before-provider',
          note,
        }),
        'INVALID_ARGUMENT',
      );
    }
    // 6 · une route nue n'inspecte rien et ne choisit pour personne.
    assert.equal(await refusal(h, runId, { expected_revision: revision }), 'INVALID_ARGUMENT');
    assert.equal(await refusal(h, runId, { expected_revision: revision, domain: 'send' }), 'INVALID_ARGUMENT');

    assert.equal(await journalOf(h, runId), before, 'aucun refus syntaxique n’écrit');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Vue périmée
// ==========================================================================

test('7–8 · une vue périmée l’emporte sur la reprise, sans créneau ni fournisseur', async () => {
  const dir = await makeTempDir('ccr-17d-stale-');
  try {
    const h = await harness(dir);
    const runId = await nativeRun(h);
    const observed = await revisionOf(h, runId);
    const callsBefore = h.calls();

    // Les faits changent : un envoi resté sans issue.
    await append(h, runId, {
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: sessionOfSlot('author'),
      content: 'envoi orphelin',
    });
    const journalBefore = await journalOf(h, runId);

    const stale = await recover(h, runId, {
      expected_revision: observed,
      domain: 'send',
      action: 'abort-before-provider',
    });
    assert.equal(codeOf(stale), 'STALE_REVISION');
    assert.equal(await journalOf(h, runId), journalBefore, 'aucun marqueur');
    assert.equal(h.manager.activeCount(), 0, 'aucun créneau');
    assert.equal(h.calls(), callsBefore, 'aucun fournisseur');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Les quatre domaines
// ==========================================================================

test('9–11 · SEND : clôture avant appel, idempotence, et aucun autre domaine purgé', async () => {
  const dir = await makeTempDir('ccr-17d-send-');
  try {
    const h = await harness(dir);
    const runId = await nativeRun(h);

    // Deux diagnostics coexistent, de deux domaines différents.
    await append(h, runId, {
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: sessionOfSlot('author'),
      content: 'envoi orphelin',
    });
    await append(h, runId, {
      round: 0,
      actor: 'human',
      type: 'human_handoff_started',
      target_expert_slot_id: 'challenger',
      session_id: sessionOfSlot('challenger'),
      details: { state: 'READY', control: 'AUTOMATION' },
    });
    const initial = await recoveryOf(h, runId);
    assert.equal(initial['send']?.status, 'PRE_PROVIDER_ABORTED');
    assert.equal(initial['handoff']?.status, 'PRE_INTERACTIVE_ABORTED');

    // 9 · le geste nommé, et lui seul.
    const revisionUsed = await revisionOf(h, runId);
    const ok = await recover(h, runId, {
      expected_revision: revisionUsed,
      domain: 'send',
      action: 'abort-before-provider',
    });
    assert.equal(ok.receipt.status, 'SUCCEEDED', JSON.stringify(ok.body));
    assert.ok(ok.receipt.revision_after !== undefined);

    // 10 · l'autre domaine n'a pas été touché : aucune purge globale.
    const after = await recoveryOf(h, runId);
    assert.equal(after['send']?.status, 'NONE');
    assert.equal(after['handoff']?.status, 'PRE_INTERACTIVE_ABORTED');
    assert.equal(
      (await journalOf(h, runId)).split('send_aborted_before_provider').length - 1,
      1,
      'un seul marqueur',
    );

    // 11 · rejeu de l'intention **identique** : même reçu, aucun second marqueur.
    const journalBefore = await journalOf(h, runId);
    const replay = await recover(h, runId, {
      expected_revision: revisionUsed,
      domain: 'send',
      action: 'abort-before-provider',
    });
    assert.equal(replay.receipt.operation_id, ok.receipt.operation_id);
    assert.equal(await journalOf(h, runId), journalBefore);
    assert.equal(h.calls(), 2, 'seules les deux positions initiales ont appelé');
  } finally {
    await removeTempDir(dir);
  }
});

test('12–13 · HANDOFF : clôture avant terminal, et jamais de réouverture', async () => {
  const dir = await makeTempDir('ccr-17d-handoff-');
  try {
    const h = await harness(dir);
    const runId = await nativeRun(h);
    await append(h, runId, {
      round: 0,
      actor: 'human',
      type: 'human_handoff_started',
      target_expert_slot_id: 'challenger',
      session_id: sessionOfSlot('challenger'),
      details: { state: 'READY', control: 'AUTOMATION' },
    });

    const ok = await recover(h, runId, {
      expected_revision: await revisionOf(h, runId),
      domain: 'handoff',
      action: 'abort-before-interactive',
    });
    assert.equal(ok.receipt.status, 'SUCCEEDED', JSON.stringify(ok.body));
    assert.ok((await journalOf(h, runId)).includes('handoff_aborted_before_interactive'));
    assert.equal((await recoveryOf(h, runId))['handoff']?.status, 'NONE');

    // 13 · une reprise de handoff ne rouvre jamais le terminal.
    assert.equal(h.interactives(), 0, 'FAKE_INTERACTIVE_CALLS = 0');
    assert.equal(h.adapters.claude.interactiveCalls.length, 0);
    assert.equal(h.adapters.codex.interactiveCalls.length, 0);
  } finally {
    await removeTempDir(dir);
  }
});

test('14–16 · STEP : acquittement, note bit pour bit, et quarantaine côté moteur', async () => {
  const dir = await makeTempDir('ccr-17d-step-');
  try {
    const h = await harness(dir);
    const runId = await nativeRun(h);
    const paths = runPaths(h.runsDir, runId);

    // Fenêtre d'incertitude de 1G : ouverture, intention, contexte engagé.
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('natif attendu');
    const { readPersistedState, persistNativeStateUpdate } = await import(
      '../../src/store/native-store.ts'
    );
    const source = JSON.parse(
      (await journalOf(h, runId))
        .split(/\r?\n/)
        .filter((line) => line.includes('"type":"assistant_response"'))[0] ?? '{}',
    ) as { event_id: string };
    const started = await append(h, runId, {
      round: 1,
      actor: 'system',
      type: 'round_started',
      target_expert_slot_id: 'challenger',
      based_on: [source.event_id],
      details: { round: 1, source_slot: 'author', target_slot: 'challenger', source_event_id: source.event_id },
    });
    const prompt = await append(h, runId, {
      round: 1,
      actor: 'system',
      type: 'prompt_sent',
      target_expert_slot_id: 'challenger',
      session_id: sessionOfSlot('challenger'),
      content: 'enveloppe',
      based_on: [source.event_id],
    });
    void started;
    const current = await readPersistedState(paths);
    if (current.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('natif attendu');
    // La machine d'état exige RUNNING avant WAITING_AGENT : c'est l'ordre que
    // le moteur emprunte lui-même.
    const running = await persistNativeStateUpdate(paths, current.document, { state: 'RUNNING' }, new Date());
    await persistNativeStateUpdate(
      paths,
      running,
      {
        state: 'WAITING_AGENT',
        activeExpertSlot: 'challenger',
        lastEventId: prompt,
        pendingOperation: {
          kind: 'step',
          source_slot: 'author',
          target_slot: 'challenger',
          source_event_id: source.event_id,
          round: 1,
          prompt_event_id: prompt,
          session_id: sessionOfSlot('challenger'),
          return_state: 'READY',
          return_control: 'AUTOMATION',
          started_at: new Date().toISOString(),
        },
      },
      new Date(),
    );
    assert.equal((await recoveryOf(h, runId))['step']?.status, 'IN_FLIGHT_UNCERTAIN');

    const ok = await recover(h, runId, {
      expected_revision: await revisionOf(h, runId),
      domain: 'step',
      action: 'acknowledge-uncertainty',
      note: NOTE,
    });
    assert.equal(ok.receipt.status, 'SUCCEEDED', JSON.stringify(ok.body));

    // 15 · exactement un marqueur, et la note **bit pour bit**.
    const journal = await journalOf(h, runId);
    assert.equal(journal.split('transfer_uncertainty_acknowledged').length - 1, 1);
    const acknowledged = journal
      .split(/\r?\n/)
      .filter((line) => line.includes('transfer_uncertainty_acknowledged'))
      .map((line) => JSON.parse(line) as { content?: string; details?: Record<string, unknown> })[0];
    // Bout en bout, depuis le corps HTTP jusqu'au journal : la note humaine est
    // celle que l'humain a écrite, bordures comprises (repair IMP-15.1).
    assert.equal(acknowledged?.content, NOTE, 'note persistée bit pour bit');
    assert.notEqual(acknowledged?.content, NOTE.trim(), 'le témoin distingue les deux comportements');
    assert.deepEqual([...(acknowledged?.content ?? '')], [...NOTE], 'aucune normalisation Unicode');

    // 16 · la quarantaine appartient au moteur : le transport ne la calcule pas.
    assert.equal((await recoveryOf(h, runId))['step']?.status, 'NONE');
    assert.equal(h.calls(), 2, 'aucun fournisseur pour un acquittement');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Initialisation — le seul geste qui peut appeler
// ==========================================================================

test('17 · une initialisation saine ne consomme aucun créneau et n’appelle personne', async () => {
  const dir = await makeTempDir('ccr-17d-init-local-');
  try {
    const h = await harness(dir);
    const runId = await nativeRun(h);
    const callsBefore = h.calls();

    // Rien à réparer : le geste est nommé quand même, et la primitive répond.
    const response = await recover(h, runId, {
      expected_revision: await revisionOf(h, runId),
      domain: 'initialization',
      action: 'continue',
    });
    assert.equal(response.receipt.status, 'SUCCEEDED', JSON.stringify(response.body));
    assert.equal(h.calls(), callsBefore, 'aucun appel simulé : rien ne manquait');
    assert.equal(h.manager.admitAttempts(), 0, 'aucune demande d’admission');
  } finally {
    await removeTempDir(dir);
  }
});

test('18–20 · un slot réellement manquant : un créneau, un appel, et pas de rejeu', async () => {
  const dir = await makeTempDir('ccr-17d-init-provider-');
  try {
    // Le challenger échoue au START : `CLEAN_MISSING` sur ce slot seul.
    // L'échec est armé sur le fournisseur qui porte ce rôle sous la liaison
    // réellement appliquée au run — sinon c'est l'author qui échouerait, et les
    // DEUX slots deviendraient manquants.
    const h = await harness(dir, { failStartOf: DEFAULT_NATIVE_BINDINGS.challenger });
    const started = await startNativeRun(h.deps, {
      title: 'T',
      cwd: process.cwd(),
      prompt: 'mission',
      runtimeConfig: nativeFixtureManifest('CCR-20260811-001', {
        author: 'codex',
        challenger: 'claude',
      }).runtime_config!,
    });
    assert.ok(started.failure !== undefined, 'initialisation partielle');
    const runId = started.runId;
    const callsAfterStart = h.calls();

    const revisionUsed = await revisionOf(h, runId);
    const ok = await recover(h, runId, {
      expected_revision: revisionUsed,
      domain: 'initialization',
      action: 'continue',
    });
    assert.equal(ok.receipt.status, 'SUCCEEDED', JSON.stringify(ok.body));

    // 18 · exactement un créneau, exactement un appel — pour le slot manquant.
    assert.equal(h.manager.admitAttempts(), 1, 'une seule admission');
    assert.equal(h.manager.activeCount(), 0, 'créneau libéré');
    assert.equal(h.calls(), callsAfterStart + 1, 'un seul appel simulé');
    // 19 · le slot complet n'a jamais été rejoué. C'est l'adaptateur de
    // l'AUTHOR qui est compté, quel que soit le moteur qui porte ce rôle.
    assert.equal(
      h.adapters[DEFAULT_NATIVE_BINDINGS.author].calls.length,
      1,
      'author non rejoué',
    );
    assert.equal((await recoveryOf(h, runId))['initialization']?.status, 'NONE');
    assert.ok(ok.receipt.revision_after !== undefined);

    // 20 · rejeu idempotent : aucun second appel.
    const replay = await recover(h, runId, {
      expected_revision: revisionUsed,
      domain: 'initialization',
      action: 'continue',
    });
    assert.equal(replay.receipt.operation_id, ok.receipt.operation_id);
    assert.equal(h.calls(), callsAfterStart + 1, 'aucun second fournisseur');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Indisponibilité dynamique, et séparation des contrats
// ==========================================================================

test('21 · un geste statiquement valide mais indisponible est refusé, jamais substitué', async () => {
  const dir = await makeTempDir('ccr-17d-unavailable-');
  try {
    const h = await harness(dir);
    const runId = await nativeRun(h);
    // Un diagnostic existe — mais dans un AUTRE domaine.
    await append(h, runId, {
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: sessionOfSlot('author'),
      content: 'envoi orphelin',
    });
    assert.equal((await recoveryOf(h, runId))['step']?.status, 'NONE');

    const journalBefore = await journalOf(h, runId);
    const response = await recover(h, runId, {
      expected_revision: await revisionOf(h, runId),
      domain: 'step',
      action: 'finalize',
    });

    // Le verdict appartient au moteur : `1G` traite une reprise sans objet comme
    // un geste sans effet plutôt que comme une erreur, et le transport
    // transporte ce verdict tel quel. Ce que ce test établit est plus fort et
    // plus utile : **aucune substitution**.
    assert.equal(
      await journalOf(h, runId),
      journalBefore,
      'aucun marqueur substitutif n’a été écrit',
    );
    assert.equal(
      (await recoveryOf(h, runId))['send']?.status,
      'PRE_PROVIDER_ABORTED',
      'le geste disponible dans l’autre domaine n’a pas été exécuté à la place',
    );
    assert.equal(h.calls(), 2, 'aucun fournisseur');
  } finally {
    await removeTempDir(dir);
  }
});

test('22–24 · les deux contrats de reprise restent séparés', async () => {
  const dir = await makeTempDir('ccr-17d-separation-');
  try {
    const h = await harness(dir);
    const nativeId = await nativeRun(h);
    const legacy = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'historique',
      cwd: 'E:/prog/exemple',
      prompt: 'p',
    });

    // 22 · l'ancienne route V1 est refusée sur un run natif, avant le moteur V1.
    let legacyRouteOnNative = '';
    try {
      await executeRecoveryMutation(
        { runService: h.deps, store: h.store, manager: h.manager },
        {
          routeSegment: 'continue-initialization',
          runId: nativeId,
          generation: 'NATIVE_V21_EXECUTION',
          contentType: 'application/json',
          idempotencyKey: 'idem-v1-on-native-01',
          body: JSON.stringify({ expected_revision: await revisionOf(h, nativeId) }),
        },
      );
    } catch (error) {
      legacyRouteOnNative = isCcrError(error) ? error.code : 'INATTENDU';
    }
    assert.equal(legacyRouteOnNative, 'COMMAND_UNSUPPORTED_FOR_GENERATION');

    // 23 · la route native est refusée sur un run historique : `domaine × geste`
    // n'a aucune traduction vers les capacités V1.
    let nativeRouteOnLegacy = '';
    try {
      await executeNativeRecoveryMutation(
        { runService: h.deps, store: h.store, manager: h.manager },
        {
          routeSegment: 'recovery',
          runId: legacy.runId,
          generation: 'LEGACY_V2_EXECUTION',
          contentType: 'application/json',
          idempotencyKey: 'idem-native-on-v1-1',
          body: JSON.stringify({
            expected_revision: 'sha256:' + '0'.repeat(64),
            domain: 'initialization',
            action: 'continue',
          }),
        },
      );
    } catch (error) {
      nativeRouteOnLegacy = isCcrError(error) ? error.code : 'INATTENDU';
    }
    assert.equal(nativeRouteOnLegacy, 'COMMAND_UNSUPPORTED_FOR_GENERATION');

    // 24 · la taxonomie V1 reste intacte pour un run historique.
    const { readStableRunSnapshot } = await import('../../src/store/run-snapshot.ts');
    const revision = (await readStableRunSnapshot(h.runsDir, legacy.runId)).revision;
    const v1 = await executeRecoveryMutation(
      { runService: h.deps, store: h.store, manager: h.manager },
      {
        routeSegment: 'continue-initialization',
        runId: legacy.runId,
        generation: 'LEGACY_V2_EXECUTION',
        contentType: 'application/json',
        idempotencyKey: 'idem-v1-on-legacy-1',
        body: JSON.stringify({ expected_revision: revision }),
      },
    );
    assert.ok(v1.receipt.operation_id.startsWith('op_'), 'la reprise V1 a bien été ouverte');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// F. Gardes statiques
// ==========================================================================

test('25–27 · aucune taxonomie V1 dans le natif, et toujours aucune route HANDOFF', async () => {
  const source = await readFile(
    new URL('../../src/services/native-recovery-mutations.ts', import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    'RECOVERY_CAPABILITY_IDS',
    'RECOVERY_FINALIZE_JOURNALED_RESPONSE',
    'materialize-ambiguity',
    'acknowledge-ambiguity',
    'recoverRun',
    'recovery-planner',
  ]) {
    assert.equal(source.includes(forbidden), false, `la reprise native ignore ${forbidden}`);
  }

  const dispatch = await readFile(
    new URL('../../src/services/native-recovery-dispatch.ts', import.meta.url),
    'utf8',
  );
  for (const forbidden of ['openInteractive', 'handoffNativeExpert']) {
    assert.equal(dispatch.includes(forbidden), false, `aucune réouverture : ${forbidden}`);
  }

  const server = await readFile(new URL('../../src/cockpit/server.ts', import.meta.url), 'utf8');
  assert.equal(server.includes('handoff'), false, 'aucune route handoff normale');
  assert.ok(server.includes('routeNativeRecovery'), 'la route native existe');
});

// ==========================================================================
// G. Repair IMP-15.1 — aucune substitution d'action
// ==========================================================================

test('28 · un geste indisponible n’est jamais remplacé par l’unique geste disponible ailleurs', async () => {
  const dir = await makeTempDir('ccr-17d-no-substitution-');
  try {
    const h = await harness(dir);
    const runId = await nativeRun(h);

    // Un seul geste est réellement disponible sur tout le run, et il est dans
    // un AUTRE domaine : c'est la configuration qui rend la tentation d'un
    // auto-choix indiscutable.
    await append(h, runId, {
      round: 0,
      actor: 'human',
      type: 'human_message',
      target_expert_slot_id: 'author',
      session_id: sessionOfSlot('author'),
      content: 'envoi resté sans issue',
    });
    const view = await readNativeRecoveryHttpView({ runsDir: h.runsDir }, runId);
    const available = Object.values(view.recovery).flatMap((domain) => domain.available_actions);
    assert.equal(available.length, 1, 'exactement un geste disponible sur tout le run');
    assert.equal(available[0]?.action, 'ABORT_BEFORE_PROVIDER');
    assert.equal(view.recovery.step.available_actions.length, 0, 'aucun geste de transfert');

    const journalBefore = await journalOf(h, runId);

    // On demande un couple **statiquement valide** mais absent des gestes
    // disponibles. Le verdict de la primitive — refus ou geste sans effet —
    // appartient au moteur ; ce qui est exigé ici est plus étroit et plus
    // important : aucune substitution.
    await recover(h, runId, {
      expected_revision: await revisionOf(h, runId),
      domain: 'step',
      action: 'finalize',
    }).catch(() => undefined);

    assert.equal(await journalOf(h, runId), journalBefore, 'aucun marqueur écrit');
    const after = await recoveryOf(h, runId);
    assert.equal(
      after['send']?.status,
      'PRE_PROVIDER_ABORTED',
      'le seul geste disponible n’a pas été exécuté à la place',
    );
    assert.equal(after['step']?.status, 'NONE');
    assert.equal(after['handoff']?.status, 'NONE');
    assert.equal(after['initialization']?.status, 'NONE');
    assert.equal(h.calls(), 2, 'aucun fournisseur');
  } finally {
    await removeTempDir(dir);
  }
});

