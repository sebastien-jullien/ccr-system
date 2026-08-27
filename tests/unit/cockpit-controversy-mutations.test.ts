/**
 * V3-S5 — surface HTTP de mutation et idempotence durable.
 *
 * Question de preuve :
 *
 * > **Le transport peut-il exposer les huit opérations métier sans en devenir
 * > une seconde autorité, et sans qu'une retransmission produise un second
 * > effet ?**
 *
 * Quatre propriétés.
 *
 *  1. **Union fermée.** Un discriminant inconnu, une charge arbitraire ou un
 *     champ dont CCR est l'autorité sont refusés avant tout claim.
 *  2. **Trois couches de doublon.** Rejeu HTTP, doublon exact du contrat et
 *     ressemblance sémantique sont trois choses distinctes, et le restent.
 *  3. **Le reçu fait autorité sur l'opération passée.** `SUCCEEDED`, `FAILED`
 *     et `UNKNOWN` se rejouent tels quels, sans rappeler le service.
 *  4. **La fraîcheur reste sous le verrou.** Le transport ne la prévalide pas.
 *
 * Aucun fournisseur, aucun navigateur, aucun ledger. Le seul socket ouvert est
 * une boucle locale, sur un cockpit de test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import {
  createOperationStore,
  newServerInstanceId,
} from '../../src/cockpit/operations-store.ts';
import type {
  ClaimInput,
  ClaimResult,
  OperationReceipt,
  OperationStore,
  SettlePatch,
} from '../../src/cockpit/operations-store.ts';
import {
  CONTROVERSY_MUTATION_ROUTE_SEGMENT,
  CONTROVERSY_OPERATIONS,
  executeControversyMutation,
} from '../../src/cockpit/mutations-http.ts';
import type { MutationResponse } from '../../src/cockpit/mutations-http.ts';
import { readNativeRunHttpView } from '../../src/cockpit/native-read-http.ts';
import { readControversyJournal } from '../../src/store/controversy-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';

const RUN_ID = 'CCR-20260817-001';
const HTTP_SOURCE = new URL('../../src/cockpit/mutations-http.ts', import.meta.url);
const AUTHOR_CONTENT = 'Le cache doit expirer. aaa fin.';
const CHALLENGER_CONTENT = 'Non : aa le cache reste valide.';

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
    content: AUTHOR_CONTENT,
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
    content: CHALLENGER_CONTENT,
  },
];

// --------------------------------------------------------------------------
// Harnais — vrai filesystem, vrai store d'idempotence, aucun fournisseur
// --------------------------------------------------------------------------

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly store: OperationStore;
  readonly deps: { runService: RunServiceDeps; store: OperationStore };
  readonly dataRoot: Awaited<ReturnType<typeof resolveCockpitDataRoot>>;
  dispose(): Promise<void>;
}

/**
 * `createAdapters` lève.
 *
 * Aucune opération V3 n'a le droit d'en demander un ; si une seule le faisait,
 * ce test échouerait au lieu de passer en silence.
 */
function noProviderDeps(runsDir: string): RunServiceDeps {
  return {
    runsDir,
    now: () => new Date(),
    createAdapters: (): AgentAdapters => {
      throw new Error('Aucune opération V3 ne construit d’adapter fournisseur.');
    },
  };
}

async function harness(options: { legacy?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-v3-s5-'));
  const dataRoot = await resolveCockpitDataRoot(dir);
  const runsDir = dataRoot.runsDir;
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  const legacy = options.legacy === true;
  await writeFile(
    paths.manifest,
    JSON.stringify(
      legacy
        ? {
            schema_version: 1,
            run_id: RUN_ID,
            created_at: '2026-08-17T09:00:00.000Z',
            title: 'S5-legacy',
            workspace: { cwd: runsDir },
            agents: {
              claude: { session_id: 'S1', role: 'author' },
              codex: { session_id: 'S2', role: 'challenger' },
            },
          }
        : {
            schema_version: 2,
            run_id: RUN_ID,
            created_at: '2026-08-17T09:00:00.000Z',
            title: 'S5',
            workspace: { cwd: runsDir },
            experts: {
              author: { provider: 'codex', session_id: 'S1' },
              challenger: { provider: 'claude', session_id: 'S2' },
            },
          },
    ),
    'utf8',
  );
  await writeFile(
    paths.state,
    JSON.stringify({
      schema_version: legacy ? 2 : 3,
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

  const store = createOperationStore(dataRoot, newServerInstanceId());
  return {
    runsDir,
    paths,
    store,
    dataRoot,
    deps: { runService: noProviderDeps(runsDir), store },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

let keyCounter = 0;
function newKey(): string {
  keyCounter += 1;
  return `v3-idem-key-${String(keyCounter).padStart(8, '0')}`;
}

function post(
  h: Harness,
  body: unknown,
  key: string,
  overrides: { store?: OperationStore; contentType?: string } = {},
): Promise<MutationResponse> {
  return executeControversyMutation(
    { runService: h.deps.runService, store: overrides.store ?? h.store },
    {
      routeSegment: CONTROVERSY_MUTATION_ROUTE_SEGMENT,
      runId: RUN_ID,
      generation: 'NATIVE_V21_EXECUTION',
      contentType: overrides.contentType ?? 'application/json',
      idempotencyKey: key,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
}

async function revisionOf(h: Harness): Promise<string> {
  const view = await readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);
  const projection = view.controversies;
  if (projection.availability !== 'AVAILABLE') throw new Error('run natif attendu');
  return (await readControversyJournal(h.paths)).revision;
}

async function entryCount(h: Harness): Promise<number> {
  if (!existsSync(h.paths.controversies)) return 0;
  return (await readControversyJournal(h.paths)).entries.length;
}

function receiptOf(response: MutationResponse): {
  operation_id: string;
  status: string;
  error_code?: string;
  revision_after?: string;
} {
  return response.receipt as never;
}

function errorCodeOf(response: MutationResponse): string {
  const shaped = response.body as { error?: { code?: string } };
  return receiptOf(response).error_code ?? shaped.error?.code ?? '';
}

/** Ouvre une controverse et rend son identité, lue par la surface S3. */
async function openControversy(h: Harness): Promise<{ controversyId: string; revision: string }> {
  const response = await post(
    h,
    {
      operation: 'RECORD_CONTROVERSY',
      expected_controversy_revision: await revisionOf(h),
      provenance_event_ids: ['evt_000001'],
      statement: 'Durée de vie du cache',
    },
    newKey(),
  );
  assert.equal(receiptOf(response).status, 'SUCCEEDED');

  // Le client retrouve l'identité créée par la lecture S3, dont l'ordre est
  // celui de la première apparition : la nouvelle controverse est la dernière.
  const view = await readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);
  const projection = view.controversies;
  if (projection.availability !== 'AVAILABLE') throw new Error('run natif attendu');
  const last = projection.items.at(-1);
  assert.ok(last !== undefined);
  return { controversyId: last.controversy_id, revision: receiptOf(response).revision_after ?? '' };
}

// ==========================================================================
// A. Union fermée et frontière de DTO
// ==========================================================================

test('1 · T1 — les huit opérations sont routées vers leur service', async () => {
  const h = await harness();
  try {
    const opened = await openControversy(h);
    let revision = opened.revision;

    const next = async (body: Record<string, unknown>): Promise<MutationResponse> => {
      const response = await post(
        h,
        { ...body, expected_controversy_revision: revision },
        newKey(),
      );
      assert.equal(receiptOf(response).status, 'SUCCEEDED', JSON.stringify(body['operation']));
      revision = receiptOf(response).revision_after ?? '';
      return response;
    };

    await next({
      operation: 'RECORD_TRANSCRIPTION',
      controversy_id: opened.controversyId,
      about_actor: 'challenger',
      anchor: { event_id: 'evt_000002', quoted_text: 'le cache reste valide', occurrence: 1 },
      statement: 'Challenger affirme que le cache reste valide',
    });
    await next({
      operation: 'RECORD_ASSERTION',
      controversy_id: opened.controversyId,
      provenance_event_ids: ['evt_000001'],
      statement: 'Le TTL doit être court',
    });
    await next({
      operation: 'RECORD_ASSERTION',
      controversy_id: opened.controversyId,
      provenance_event_ids: ['evt_000001'],
      statement: 'Le TTL doit être long',
    });

    const journal = await readControversyJournal(h.paths);
    const assertions = journal.entries.filter((entry) => entry.kind === 'ASSERTION_RECORDED');
    const from = assertions.at(-1)?.entry_id ?? '';
    const to = assertions.at(-2)?.entry_id ?? '';

    await next({
      operation: 'RECORD_RELATION',
      controversy_id: opened.controversyId,
      provenance_event_ids: ['evt_000001'],
      act: 'CONTESTS',
      from_entry_id: from,
      to_entry_id: to,
    });
    await next({
      operation: 'RECORD_NATURE',
      controversy_id: opened.controversyId,
      provenance_event_ids: ['evt_000001'],
      nature: 'désaccord de méthode',
    });
    await next({
      operation: 'RECORD_HUMAN_AUTHORITY',
      controversy_id: opened.controversyId,
      provenance_event_ids: ['evt_000001'],
      scope: 'périmètre : choix du TTL',
    });

    // Les cinq types du domaine sont atteints, et chacun par son opération.
    const kinds = new Set((await readControversyJournal(h.paths)).entries.map((entry) => entry.kind));
    assert.deepEqual(
      [...kinds].sort(),
      ['ASSERTION_RECORDED', 'CONTROVERSY_RECORDED', 'HUMAN_AUTHORITY_RECORDED', 'NATURE_RECORDED', 'RELATION_RECORDED'],
    );

    // `CONFIRM_RELATION` et `CONTEST_RELATION` visent une inférence CCR, que
    // seul S7 produit : leur routage est prouvé par le refus MÉTIER qu'elles
    // rapportent — un refus de transport n'aurait jamais atteint le service.
    for (const operation of ['CONFIRM_RELATION', 'CONTEST_RELATION'] as const) {
      const response = await post(
        h,
        {
          operation,
          controversy_id: opened.controversyId,
          expected_controversy_revision: revision,
          provenance_event_ids: ['evt_000001'],
          target_entry_id: from,
        },
        newKey(),
      );
      assert.equal(receiptOf(response).status, 'FAILED', operation);
      assert.equal(errorCodeOf(response), 'INVALID_ARGUMENT', operation);
      assert.equal(response.status, 400);
    }

    assert.deepEqual([...CONTROVERSY_OPERATIONS].sort(), [
      'CONFIRM_RELATION',
      'CONTEST_RELATION',
      'RECORD_ASSERTION',
      'RECORD_CONTROVERSY',
      'RECORD_HUMAN_AUTHORITY',
      'RECORD_NATURE',
      'RECORD_RELATION',
      'RECORD_TRANSCRIPTION',
    ]);
  } finally {
    await h.dispose();
  }
});

test('2 · T2/T3 — discriminant inconnu, charge générique, clé absente : refus avant claim', async () => {
  const h = await harness();
  try {
    const revision = await revisionOf(h);
    const valid = {
      operation: 'RECORD_CONTROVERSY',
      expected_controversy_revision: revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'sujet',
    };

    const refused: readonly (readonly [string, unknown, string | undefined])[] = [
      ['opération inconnue', { ...valid, operation: 'APPEND_ENTRY' }, newKey()],
      ['opération absente', { expected_controversy_revision: revision }, newKey()],
      ['charge brute', { ...valid, raw_payload: { kind: 'x' } }, newKey()],
      ['révision absente', { operation: 'RECORD_CONTROVERSY', provenance_event_ids: ['evt_000001'], statement: 's' }, newKey()],
      ['corps non JSON', 'pas du json', newKey()],
      ['corps tableau', [1, 2], newKey()],
      ['clé absente', valid, undefined],
      ['clé trop courte', valid, 'court'],
    ];

    for (const [label, body, key] of refused) {
      await assert.rejects(
        () =>
          executeControversyMutation(h.deps, {
            routeSegment: CONTROVERSY_MUTATION_ROUTE_SEGMENT,
            runId: RUN_ID,
            generation: 'NATIVE_V21_EXECUTION',
            contentType: 'application/json',
            ...(key === undefined ? {} : { idempotencyKey: key }),
            body: typeof body === 'string' ? body : JSON.stringify(body),
          } as never),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'INVALID_ARGUMENT', label);
          return true;
        },
        label,
      );
    }

    // Type de contenu inattendu : aucun parseur multi-format.
    await assert.rejects(
      () => post(h, valid, newKey(), { contentType: 'text/plain' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'UNSUPPORTED_MEDIA_TYPE');
        return true;
      },
    );

    // T17 — aucun refus de transport n'a matérialisé le journal.
    assert.equal(existsSync(h.paths.controversies), false);
  } finally {
    await h.dispose();
  }
});

test('3 · T15 — les champs dont CCR est l’autorité sont refusés, jamais acceptés', async () => {
  const h = await harness();
  try {
    const revision = await revisionOf(h);
    const base = {
      operation: 'RECORD_CONTROVERSY',
      expected_controversy_revision: revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'sujet',
    };

    const forged: readonly Record<string, unknown>[] = [
      { entry_id: 'ctve_000009' },
      { schema_version: 42 },
      { recorded_at: '1999-01-01T00:00:00.000Z' },
      { recorded_by: 'CCR' },
      { semantic_origin: { kind: 'CCR' } },
      { derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_1', inputs: [] } },
      { invocation_id: 'inv_1' },
      { anchors: { provenance: [] } },
      { provider_effect: 'AT_MOST(1)' },
      { controversy_revision: 'ctv-sha256:0' },
    ];

    for (const extra of forged) {
      const field = Object.keys(extra)[0] ?? '';
      await assert.rejects(
        () => post(h, { ...base, ...extra }, newKey()),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'INVALID_ARGUMENT', field);
          assert.match(String((error as Error).message), /autorité|inattendu/, field);
          return true;
        },
        field,
      );
    }

    assert.equal(existsSync(h.paths.controversies), false, 'aucun de ces refus n’a écrit');

    // Et la voie légitime, elle, produit bien une entrée HUMAN sans dérivation.
    await post(h, base, newKey());
    const entry = (await readControversyJournal(h.paths)).entries[0];
    assert.equal(entry?.semantic_origin.kind, 'HUMAN');
    assert.equal(entry?.recorded_by, 'HUMAN');
    assert.equal(entry?.derivation, undefined);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// B. Idempotence durable
// ==========================================================================

test('4 · T4 — rejeu exact après SUCCESS : même reçu, un seul append', async () => {
  const h = await harness();
  try {
    const body = {
      operation: 'RECORD_CONTROVERSY',
      expected_controversy_revision: await revisionOf(h),
      provenance_event_ids: ['evt_000001'],
      statement: 'Durée de vie du cache',
    };
    const key = newKey();

    const first = await post(h, body, key);
    assert.equal(receiptOf(first).status, 'SUCCEEDED');
    assert.equal(first.status, 200);
    assert.equal(await entryCount(h), 1);

    // Réponse perdue : le client retransmet à l'identique.
    const replay = await post(h, body, key);
    assert.deepEqual(replay.receipt, first.receipt, 'le même reçu, champ pour champ');
    assert.equal(await entryCount(h), 1, 'aucun second append');
  } finally {
    await h.dispose();
  }
});

test('5 · T18 — le reçu porte la révision V3 résultante, sans read model parallèle', async () => {
  const h = await harness();
  try {
    const response = await post(
      h,
      {
        operation: 'RECORD_CONTROVERSY',
        expected_controversy_revision: await revisionOf(h),
        provenance_event_ids: ['evt_000001'],
        statement: 'sujet',
      },
      newKey(),
    );

    const receipt = receiptOf(response);
    assert.equal(receipt.revision_after, await revisionOf(h));
    // Le préfixe distingue visiblement un jeton V3 d'un jeton de run.
    assert.equal(receipt.revision_after?.startsWith('ctv-sha256:'), true);
    assert.equal(receipt.revision_after?.startsWith('sha256:'), false);

    // Le reçu décrit ce qui s'est passé, jamais l'état courant de la controverse.
    assert.deepEqual(Object.keys(response.receipt).sort(), [
      'action',
      'created_at',
      'operation_id',
      'revision_after',
      'run_id',
      'status',
      'updated_at',
    ]);
    const asRecord = response.receipt as unknown as Record<string, unknown>;
    for (const forbidden of ['items', 'entries', 'recorded_count', 'availability', 'entry']) {
      assert.equal(forbidden in asRecord, false, `aucun champ ${forbidden}`);
    }
  } finally {
    await h.dispose();
  }
});

test('6 · T5/T13 — rejeu exact après FAILED : le verdict d’origine, sans réévaluation', async () => {
  const h = await harness();
  try {
    // Un refus dont la CAUSE disparaîtrait si le service était rappelé : la
    // controverse visée n'existe pas encore. Après sa création, une nouvelle
    // évaluation rendrait `STALE_REVISION` — un code différent.
    const revision = await revisionOf(h);
    const body = {
      operation: 'RECORD_ASSERTION',
      controversy_id: 'ctv_000001',
      expected_controversy_revision: revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'position orpheline',
    };
    const key = newKey();

    const failed = await post(h, body, key);
    assert.equal(receiptOf(failed).status, 'FAILED');
    assert.equal(errorCodeOf(failed), 'INVALID_ARGUMENT');
    assert.equal(failed.status, 400);
    assert.equal(await entryCount(h), 0);

    // Le monde change : la controverse existe désormais, et la révision aussi.
    await post(
      h,
      {
        operation: 'RECORD_CONTROVERSY',
        expected_controversy_revision: revision,
        provenance_event_ids: ['evt_000001'],
        statement: 'Durée de vie du cache',
      },
      newKey(),
    );
    assert.equal(await entryCount(h), 1);
    assert.notEqual(await revisionOf(h), revision);

    const replay = await post(h, body, key);
    assert.deepEqual(replay.receipt, failed.receipt, 'le verdict d’origine, à l’identique');
    assert.equal(errorCodeOf(replay), 'INVALID_ARGUMENT', 'jamais requalifié en STALE_REVISION');
    assert.equal(await entryCount(h), 1, 'aucun append');
  } finally {
    await h.dispose();
  }
});

/**
 * Store qui **omet** la finalisation du reçu.
 *
 * Simule exactement l'arrêt brutal survenu après l'effet et avant l'écriture du
 * verdict : le claim est durable, le reçu reste `RUNNING`. Aucun fichier n'est
 * falsifié — c'est le store réel, privé de son dernier geste.
 */
function storeWithoutSettle(inner: OperationStore): OperationStore {
  return {
    claim: (input: ClaimInput): Promise<ClaimResult> => inner.claim(input),
    associateRun: (id: string, runId: string): Promise<OperationReceipt> => inner.associateRun(id, runId),
    read: (id: string): Promise<OperationReceipt | undefined> => inner.read(id),
    settle: async (id: string, _patch: SettlePatch): Promise<OperationReceipt> => {
      const current = await inner.read(id);
      if (current === undefined) throw new Error('reçu introuvable');
      return current;
    },
  };
}

test('7 · T6 — rejeu exact après UNKNOWN : jamais un re-dispatch', async () => {
  const h = await harness();
  try {
    const body = {
      operation: 'RECORD_CONTROVERSY',
      expected_controversy_revision: await revisionOf(h),
      provenance_event_ids: ['evt_000001'],
      statement: 'Durée de vie du cache',
    };
    const key = newKey();

    // Instance A : l'effet a lieu, le verdict n'est jamais écrit.
    const crashed = await post(h, body, key, { store: storeWithoutSettle(h.store) });
    assert.equal(receiptOf(crashed).status, 'RUNNING');
    assert.equal(await entryCount(h), 1, 'l’effet, lui, a bien eu lieu');

    // Instance B : nouveau serveur, nouvelle identité d'instance. Un reçu
    // `RUNNING` d'une instance disparue se lit `UNKNOWN`.
    const restarted = createOperationStore(h.dataRoot, newServerInstanceId());
    const replay = await post(h, body, key, { store: restarted });

    assert.equal(receiptOf(replay).status, 'UNKNOWN');
    assert.equal(receiptOf(replay).operation_id, receiptOf(crashed).operation_id);
    assert.equal(await entryCount(h), 1, 'aucun second effet');

    // La preuve du non-rappel : si le service avait été rejoué, sa révision
    // attendue serait périmée et le verdict vaudrait `STALE_REVISION`.
    assert.equal(receiptOf(replay).error_code, undefined);
    assert.notEqual(receiptOf(replay).status, 'FAILED');
  } finally {
    await h.dispose();
  }
});

test('8 · T7/T8/T9 — même clé, intention différente : refus d’empreinte', async () => {
  const h = await harness();
  try {
    const revision = await revisionOf(h);
    const body = {
      operation: 'RECORD_CONTROVERSY',
      expected_controversy_revision: revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'Durée de vie du cache',
    };
    const key = newKey();

    const first = await post(h, body, key);
    assert.equal(receiptOf(first).status, 'SUCCEEDED');
    const after = await revisionOf(h);

    const divergent: readonly (readonly [string, Record<string, unknown>])[] = [
      ['corps différent', { ...body, statement: 'Un autre sujet' }],
      ['provenance différente', { ...body, provenance_event_ids: ['evt_000002'] }],
      ['opération différente', {
        operation: 'RECORD_NATURE',
        controversy_id: 'ctv_000001',
        expected_controversy_revision: revision,
        provenance_event_ids: ['evt_000001'],
        nature: 'x',
      }],
      // Une nouvelle révision avec la même clé n'est pas un retry exact : le
      // geste a été décidé sur une autre vue.
      ['révision différente', { ...body, expected_controversy_revision: after }],
    ];

    for (const [label, variant] of divergent) {
      await assert.rejects(
        () => post(h, variant, key),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'IDEMPOTENCY_KEY_REUSED', label);
          return true;
        },
        label,
      );
    }

    assert.equal(await entryCount(h), 1, 'aucun refus d’empreinte n’a produit d’effet');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// C. Trois couches de doublon
// ==========================================================================

test('9 · T10/T11 — rejeu HTTP, doublon exact du contrat et ressemblance sont distincts', async () => {
  const h = await harness();
  try {
    const opened = await openControversy(h);

    const assertion = (revision: string): Record<string, unknown> => ({
      operation: 'RECORD_ASSERTION',
      controversy_id: opened.controversyId,
      expected_controversy_revision: revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'Le TTL doit être court',
    });

    // Couche 1 — même clé, même empreinte : rejeu, aucun second appel.
    const k1 = newKey();
    const revision = await revisionOf(h);
    const first = await post(h, assertion(revision), k1);
    assert.equal(receiptOf(first).status, 'SUCCEEDED');
    const replay = await post(h, assertion(revision), k1);
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(await entryCount(h), 2);

    // Couche 2 — clé neuve, geste identique : le service EST appelé, et c'est
    // le contrat qui refuse, comme doublon exact.
    const k2 = newKey();
    const duplicate = await post(h, assertion(await revisionOf(h)), k2);
    assert.equal(receiptOf(duplicate).status, 'FAILED');
    assert.equal(errorCodeOf(duplicate), 'INVALID_ARGUMENT');
    assert.notEqual(receiptOf(duplicate).operation_id, receiptOf(first).operation_id);
    assert.equal(await entryCount(h), 2, 'refusé par le métier, pas par le transport');

    // Couche 3 — seulement ressemblant : aucune déduplication sémantique.
    const near = await post(
      h,
      { ...assertion(await revisionOf(h)), statement: 'Le TTL doit être court.' },
      newKey(),
    );
    assert.equal(receiptOf(near).status, 'SUCCEEDED');
    assert.equal(await entryCount(h), 3);
  } finally {
    await h.dispose();
  }
});

test('10 · T11 — un acte d’autorité humaine répété reste possible avec une clé neuve', async () => {
  const h = await harness();
  try {
    const opened = await openControversy(h);

    const authority = (revision: string): Record<string, unknown> => ({
      operation: 'RECORD_HUMAN_AUTHORITY',
      controversy_id: opened.controversyId,
      expected_controversy_revision: revision,
      provenance_event_ids: ['evt_000001'],
      scope: 'périmètre : choix du TTL',
    });

    const k1 = newKey();
    const first = await post(h, authority(await revisionOf(h)), k1);
    assert.equal(receiptOf(first).status, 'SUCCEEDED');

    // Même clé : rejeu, un seul fait.
    await post(h, authority(receiptOf(first).revision_after ?? ''), k1).catch(() => undefined);
    const afterReplay = await entryCount(h);

    // Clé neuve, acte identique : deux gestes humains distincts, tous deux
    // légitimes — le contrat déclare cette entrée non idempotente.
    const second = await post(h, authority(await revisionOf(h)), newKey());
    assert.equal(receiptOf(second).status, 'SUCCEEDED');

    const authorities = (await readControversyJournal(h.paths)).entries.filter(
      (entry) => entry.kind === 'HUMAN_AUTHORITY_RECORDED',
    );
    assert.equal(authorities.length, 2, 'deux autorités historiques distinctes');
    assert.notEqual(authorities[0]?.entry_id, authorities[1]?.entry_id);
    assert.equal(await entryCount(h), afterReplay + 1);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// D. Fraîcheur, absence, legacy
// ==========================================================================

test('11 · T12/T13 — §19 : vue périmée, aucun append, et rejeu du même échec', async () => {
  const h = await harness();
  try {
    const opened = await openControversy(h);
    const r1 = await revisionOf(h);

    // A avec R1 → succès → R2.
    const a = await post(
      h,
      {
        operation: 'RECORD_ASSERTION',
        controversy_id: opened.controversyId,
        expected_controversy_revision: r1,
        provenance_event_ids: ['evt_000001'],
        statement: 'Position A',
      },
      newKey(),
    );
    assert.equal(receiptOf(a).status, 'SUCCEEDED');
    const r2 = await revisionOf(h);
    assert.notEqual(r1, r2);

    // B avec R1, clé neuve → conflit.
    const bodyB = {
      operation: 'RECORD_ASSERTION',
      controversy_id: opened.controversyId,
      expected_controversy_revision: r1,
      provenance_event_ids: ['evt_000001'],
      statement: 'Position B',
    };
    const keyB = newKey();
    const b = await post(h, bodyB, keyB);
    assert.equal(receiptOf(b).status, 'FAILED');
    assert.equal(errorCodeOf(b), 'STALE_REVISION');
    assert.equal(b.status, 409);
    const countAfterB = await entryCount(h);
    assert.equal(countAfterB, 2, 'aucun append pour B');

    // Rejeu exact de B : le même verdict, jamais une réévaluation dans R2.
    const replay = await post(h, bodyB, keyB);
    assert.deepEqual(replay.receipt, b.receipt);
    assert.equal(await entryCount(h), countAfterB);

    // Et B avec la révision courante aboutit : le refus portait bien sur la vue.
    const fixed = await post(h, { ...bodyB, expected_controversy_revision: r2 }, newKey());
    assert.equal(receiptOf(fixed).status, 'SUCCEEDED');
  } finally {
    await h.dispose();
  }
});

test('12 · T16 — première mutation sur un journal ABSENT, via la surface HTTP', async () => {
  const h = await harness();
  try {
    assert.equal(existsSync(h.paths.controversies), false);

    // La lecture S3 fournit le jeton d'un journal absent, sans le créer.
    const view = await readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);
    assert.equal(view.controversies.availability, 'AVAILABLE');
    assert.equal(existsSync(h.paths.controversies), false, 'lire ne matérialise rien');
    const absent = await revisionOf(h);

    const response = await post(
      h,
      {
        operation: 'RECORD_CONTROVERSY',
        expected_controversy_revision: absent,
        provenance_event_ids: ['evt_000001'],
        statement: 'Durée de vie du cache',
      },
      newKey(),
    );

    assert.equal(receiptOf(response).status, 'SUCCEEDED');
    assert.equal(existsSync(h.paths.controversies), true);
    assert.equal(await entryCount(h), 1);
    assert.notEqual(receiptOf(response).revision_after, absent);
  } finally {
    await h.dispose();
  }
});

test('13 · T14 — un run legacy est refusé par le service, sans journal V3', async () => {
  const h = await harness({ legacy: true });
  try {
    const response = await post(
      h,
      {
        operation: 'RECORD_CONTROVERSY',
        expected_controversy_revision: 'ctv-sha256:peu-importe',
        provenance_event_ids: ['evt_000001'],
        statement: 'sujet',
      },
      newKey(),
    );

    assert.equal(receiptOf(response).status, 'FAILED');
    assert.equal(errorCodeOf(response), 'SCHEMA_VERSION_UNSUPPORTED');
    assert.equal(response.status, 422, 'jamais un 404, jamais un 500');
    assert.equal(existsSync(h.paths.controversies), false);
    assert.equal(existsSync(h.paths.decisions), false, 'aucune migration');
  } finally {
    await h.dispose();
  }
});

test('14 · T20 — les erreurs publiques ne portent ni pile, ni cause, ni chemin', async () => {
  const h = await harness();
  try {
    const failed = await post(
      h,
      {
        operation: 'RECORD_ASSERTION',
        controversy_id: 'ctv_000404',
        expected_controversy_revision: await revisionOf(h),
        provenance_event_ids: ['evt_000001'],
        statement: 'x',
      },
      newKey(),
    );

    assert.equal(failed.status, 400);
    const body = failed.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['error', 'operation_id']);
    assert.deepEqual(Object.keys(body['error'] as object).sort(), ['code', 'message']);

    const serialized = JSON.stringify(failed.body);
    for (const leak of ['stack', 'cause', 'at Object', h.runsDir, 'controversies.jsonl', 'ctv_000404']) {
      assert.equal(serialized.includes(leak), false, `aucune fuite : ${leak}`);
    }
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// E. Effet fournisseur, concurrence, garde de couche
// ==========================================================================

test('15 · T19 — effet fournisseur EXACT(0) sur les huit opérations', async () => {
  const h = await harness();
  try {
    // `createAdapters` lève : toute tentative d'approcher un fournisseur ferait
    // échouer ces appels au lieu de les laisser réussir en silence.
    const opened = await openControversy(h);
    await post(
      h,
      {
        operation: 'RECORD_NATURE',
        controversy_id: opened.controversyId,
        expected_controversy_revision: await revisionOf(h),
        provenance_event_ids: ['evt_000001'],
        nature: 'désaccord de méthode',
      },
      newKey(),
    );

    assert.equal(existsSync(h.paths.invocations), false, 'aucun InvocationLedger');
    assert.equal(existsSync(h.paths.usage), false, 'aucun journal d’usage');
    assert.equal(existsSync(h.paths.invocationPolicy), false);
  } finally {
    await h.dispose();
  }
});

test('16 · §29 — deux requêtes concurrentes, même clé : au plus une exécution', async () => {
  const h = await harness();
  try {
    const body = {
      operation: 'RECORD_CONTROVERSY',
      expected_controversy_revision: await revisionOf(h),
      provenance_event_ids: ['evt_000001'],
      statement: 'Durée de vie du cache',
    };
    const key = newKey();

    const outcomes = await Promise.allSettled([post(h, body, key), post(h, body, key)]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    assert.equal(fulfilled.length, 2, 'aucune des deux n’échoue : la seconde rejoue');

    const ids = fulfilled.map((outcome) =>
      receiptOf((outcome as PromiseFulfilledResult<MutationResponse>).value).operation_id,
    );
    assert.equal(new Set(ids).size, 1, 'une seule identité d’opération');
    assert.equal(await entryCount(h), 1, 'au plus une exécution métier');
  } finally {
    await h.dispose();
  }
});

test('17 · §25 — le transport n’est pas un second moteur de controverse', async () => {
  const source = await readFile(HTTP_SOURCE, 'utf8');
  const marker = '// V3 — controverses';
  const start = source.indexOf(marker);
  assert.ok(start > 0, 'la section V3 est délimitée');
  // Borne de FIN : la surface V5.1 partage ce module, et son vocabulaire est le
  // sien. Auditer jusqu'à la fin du fichier ferait juger V3 sur les mots de V5.
  const end = source.indexOf('// Réconciliation V5 —');
  assert.ok(end > start, 'la section V3 se termine avant la surface V5');
  const section = source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // Aucune logique métier dupliquée : ni résolution d'ancrage, ni vérification
  // de paternité, ni contrôle de cible, ni détection de doublon, ni allocation.
  const forbidden = [
    'indexOf(',
    'occurrenceExists',
    'about_actor !==',
    'authoringSlot',
    'formatControversyEntryId',
    'formatControversyId',
    'appendControversyEntry',
    'readStableNativeRunSnapshot',
    'computeControversyRevision',
    'withRunLock',
    'withNativeMutation',
    'controversies.jsonl',
    'node:fs',
    'ASSERTION_RECORDED',
    'RELATION_RECORDED',
    'semantic_origin:',
    'MODEL_ASSISTED',
    'InvocationLedger',
    'position_id',
    'CONVERGED',
    'confidence',
    'similarity',
  ];
  for (const token of forbidden) {
    assert.equal(section.includes(token), false, `la section V3 ne contient pas « ${token} »`);
  }
  for (const pattern of [/\bstatus\s*[:=]\s*'(OPEN|CLOSED|RESOLVED)'/, /\bwinner\b/, /\bclosure\b/]) {
    assert.equal(pattern.test(section), false, `motif interdit ${String(pattern)}`);
  }

  // Et elle passe bien par les huit opérations du service, et par elles seules.
  for (const call of [
    'recordControversy(',
    'recordHumanTranscription(',
    'recordAssertion(',
    'recordRelation(',
    'recordNature(',
    'recordHumanAuthority(',
    'confirmInferredRelation(',
    'contestInferredRelation(',
  ]) {
    assert.equal(section.includes(call), true, `dispatch manquant : ${call}`);
  }
});

// ==========================================================================
// F. Preuve sur socket loopback réelle
// ==========================================================================

interface HttpResult {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function httpRequest(
  port: number,
  method: string,
  target: string,
  options: { cookie?: string; origin?: string; key?: string; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${String(port)}` };
    if (options.cookie !== undefined) headers['Cookie'] = options.cookie;
    if (options.origin !== undefined) headers['Origin'] = options.origin;
    if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(options.body, 'utf8'));
    }
    const req = request(
      { host: '127.0.0.1', port, method, path: target, headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test('18 · §28/T21 — POST réel sur socket loopback, protégé comme les autres', async () => {
  const h = await harness();
  try {
    const { startCockpit } = await import('../../src/cockpit/cockpit-service.ts');
    const instance = await startCockpit({ runsDir: h.runsDir, port: 0 });
    const port = instance.server.port;
    const origin = `http://127.0.0.1:${String(port)}`;
    const route = `/api/runs/${RUN_ID}/${CONTROVERSY_MUTATION_ROUTE_SEGMENT}`;

    try {
      const bodyOf = (revision: string): string =>
        JSON.stringify({
          operation: 'RECORD_CONTROVERSY',
          expected_controversy_revision: revision,
          provenance_event_ids: ['evt_000001'],
          statement: 'Durée de vie du cache',
        });

      // T21 — sans session : refusé avant tout routage.
      const anonymous = await httpRequest(port, 'POST', route, {
        origin,
        key: newKey(),
        body: bodyOf('x'),
      });
      assert.equal(anonymous.status, 401);

      // Session posée par le shell, comme un navigateur l'obtiendrait.
      const shell = await httpRequest(port, 'GET', '/');
      const setCookie = shell.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
      assert.ok(cookie.length > 0, 'le shell pose la session');

      // T21 — origine étrangère : refusée, même authentifiée.
      const foreign = await httpRequest(port, 'POST', route, {
        cookie,
        origin: 'http://evil.example',
        key: newKey(),
        body: bodyOf('x'),
      });
      assert.equal(foreign.status, 403);
      assert.equal(existsSync(h.paths.controversies), false, 'aucun refus n’a écrit');

      // GET S3 → jeton de fraîcheur.
      const before = await httpRequest(port, 'GET', `/api/runs/${RUN_ID}`, { cookie });
      assert.equal(before.status, 200);
      const view = JSON.parse(before.body) as {
        controversies: { availability: string; recorded_count?: number };
      };
      assert.equal(view.controversies.availability, 'AVAILABLE');
      assert.equal(view.controversies.recorded_count, 0);
      const revision = await revisionOf(h);

      // POST → service S4 → reçu.
      const key = newKey();
      const created = await httpRequest(port, 'POST', route, {
        cookie,
        origin,
        key,
        body: bodyOf(revision),
      });
      assert.equal(created.status, 200);
      const receipt = JSON.parse(created.body) as {
        status: string;
        operation_id: string;
        revision_after: string;
        action: string;
      };
      assert.equal(receipt.status, 'SUCCEEDED');
      assert.equal(receipt.action, 'CONTROVERSY:RECORD_CONTROVERSY');
      assert.equal(receipt.revision_after.startsWith('ctv-sha256:'), true);

      // GET S3 reflète l'entrée.
      const after = await httpRequest(port, 'GET', `/api/runs/${RUN_ID}`, { cookie });
      const reread = JSON.parse(after.body) as {
        controversies: {
          recorded_count: number;
          items: readonly { controversy_id: string; opening: { content?: string } | null }[];
        };
      };
      assert.equal(reread.controversies.recorded_count, 1);
      assert.equal(reread.controversies.items[0]?.opening?.content, 'Durée de vie du cache');

      // Rejeu exact : le même reçu, aucune seconde entrée.
      const replay = await httpRequest(port, 'POST', route, {
        cookie,
        origin,
        key,
        body: bodyOf(revision),
      });
      assert.equal(replay.status, 200);
      assert.deepEqual(JSON.parse(replay.body), receipt);
      assert.equal(await entryCount(h), 1, 'aucune seconde entrée');
    } finally {
      await instance.stop();
    }
  } finally {
    await h.dispose();
  }
});
