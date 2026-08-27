/**
 * Surface HTTP de la reprise (Slice 7, Gate A2.1c).
 *
 * Cinq intentions, cinq routes, et une seule qui joint un fournisseur. Ce qui
 * est éprouvé ici est le transport : schémas, codes, reçus, idempotence, quota
 * — les effets métier appartiennent aux services déjà gelés.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { OPERATIONS_DIR_NAME } from '../../src/cockpit/operations-store.ts';
import { lockTokenFor } from '../../src/lock/lock-token.ts';
import { lockFilePath, readRunLock } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import type { PendingOperation, RunStateDocument } from '../../src/core/run.ts';

const RUNS = ['CCR-20260402-001', 'CCR-20260808-002', 'CCR-20260808-003', 'CCR-20260808-004'] as const;

const PENDING: PendingOperation = {
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

const UNCERTAINTY = { reason: 'tour engagé sans réponse', since: T, agent: 'claude' as const, last_event_id: 'evt_000002' };

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

function send(port: number, method: string, target: string, headers: Record<string, string>, body?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const operationIdFor = (key: string): string => `op_${createHash('sha256').update(key, 'utf8').digest('hex')}`;
const errorCode = (r: Result): string => String((r.body['error'] as { code?: string } | undefined)?.code);

interface Counters {
  claude: number;
  codex: number;
}

interface RunSpec {
  readonly id: string;
  readonly state?: Partial<RunStateDocument>;
  readonly journaled?: boolean;
  readonly missingSession?: 'claude' | 'codex';
  readonly withoutInitialPrompt?: boolean;
}

interface Box {
  readonly instance: CockpitInstance;
  readonly runsDir: string;
  readonly dir: string;
  readonly calls: Counters;
  /**
   * Nombre de fournisseurs joints à l'instant de la **première admission**.
   *
   * C'est l'instant où le `202` est décidé — la couture est appelée après la
   * réservation du créneau et avant la résolution de la poignée de main.
   * Mesurer côté client, au retour de la requête, mesurerait autre chose : la
   * lecture de la réponse est un évènement réseau, l'appel fournisseur suit la
   * chaîne asynchrone du serveur, et rien n'ordonne les deux. Constaté : au
   * repos le client gagne 12 fois sur 12, mais le fournisseur est appelé dans
   * les 60 ms qui suivent — sous charge, l'ordre s'inverse.
   */
  readonly admissionProviders: () => number | undefined;
  post(runId: string, capability: string, payload: unknown, key: string, extraHeaders?: Record<string, string>): Promise<Result>;
  get(target: string): Promise<Result>;
  revision(runId: string): Promise<string>;
  state(runId: string): Promise<RunStateDocument>;
  cleanup(): Promise<void>;
}

async function open(specs: readonly RunSpec[], onCall?: () => Promise<void>): Promise<Box> {
  const dir = await makeTempDir('ccr-recovery-http-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });

  for (const spec of specs) {
    const events = [
      { round: 0, actor: 'system' as const, type: 'run_created' as const, content: 'départ', timestamp: T },
      ...(spec.withoutInitialPrompt === true
        ? []
        : [{ round: 0, actor: 'human' as const, type: 'prompt_sent' as const, content: 'contexte initial', timestamp: T }]),
      ...(spec.journaled === true
        ? [
            {
              round: 1,
              actor: 'claude' as const,
              type: 'assistant_response' as const,
              session_id: 'claude-1',
              content: 'réponse journalisée',
              based_on: ['evt_000002'],
              timestamp: T,
            },
          ]
        : []),
    ];
    await materializeRun(runsDir, { runId: spec.id, events, ...(spec.state === undefined ? {} : { state: spec.state }) });

    const file = runPaths(runsDir, spec.id).manifest;
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      agents: Record<string, { session_id: string | null }>;
      workspace: { cwd: string };
    };
    if (spec.missingSession !== undefined) {
      const agent = manifest.agents[spec.missingSession];
      if (agent !== undefined) agent.session_id = null;
    }
    manifest.workspace.cwd = dir;
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  const calls: Counters = { claude: 0, codex: 0 };
  const record = (agent: 'claude' | 'codex') => async (): Promise<void> => {
    calls[agent] += 1;
    await onCall?.();
  };
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', onCall: record('claude') }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', onCall: record('codex') }),
  };

  let providersAtAdmission: number | undefined;
  const instance = await startCockpit({
    runsDir,
    port: 0,
    depsOverrides: { createAdapters: () => adapters },
    recoveryHooks: {
      onReadyForEffect: () => {
        providersAtAdmission ??= calls.claude + calls.codex;
      },
    },
  });
  const port = instance.server.port;
  const cookie = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
    });
    req.on('error', reject);
    req.end();
  });

  return {
    instance,
    runsDir,
    dir,
    calls,
    admissionProviders: () => providersAtAdmission,
    post(runId, capability, payload, key, extraHeaders = {}) {
      const body = JSON.stringify(payload);
      return send(port, 'POST', `/api/runs/${runId}/recovery/${capability}`, {
        Host: `127.0.0.1:${String(port)}`,
        Origin: `http://127.0.0.1:${String(port)}`,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Idempotency-Key': key,
        ...extraHeaders,
      }, body);
    },
    get: (target) => send(port, 'GET', target, { Host: `127.0.0.1:${String(port)}`, Cookie: cookie }),
    revision: async (runId) => (await readStableRunSnapshot(runsDir, runId)).revision,
    state: async (runId) => JSON.parse(await readFile(runPaths(runsDir, runId).state, 'utf8')) as RunStateDocument,
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

test('(H-R1) cinq routes exactes, et aucun alias', async (t) => {
  const b = await open([{ id: RUNS[0], state: { state: 'WAITING_AGENT', pending_operation: PENDING } }]);
  try {
    const revision = await b.revision(RUNS[0]);
    // La table close répond — ici par un refus métier, preuve qu'elle a routé.
    const routed = await b.post(RUNS[0], 'finalize-journaled-response', { expected_revision: revision }, 'cle-route-000001');
    t.diagnostic(`finalize sur un run ambigu → ${String(routed.status)} ${errorCode(routed)}`);
    assert.equal(routed.status, 409);
    assert.equal(errorCode(routed), 'RECOVERY_CAPABILITY_STALE');

    for (const alias of ['', 'recover', 'anything-else', 'clear_stale_lock', 'CLEAR-STALE-LOCK']) {
      const result = await b.post(RUNS[0], alias, { expected_revision: revision }, `cle-alias-${alias.slice(0, 6).padEnd(6, 'x')}`);
      assert.equal(result.status, 404, `alias accepté : « ${alias} »`);
    }
    t.diagnostic('cinq alias refusés en 404');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Les trois reprises courtes
// --------------------------------------------------------------------------

test('(H-R2) reprises courtes : 200, reçu exact, aucun fournisseur, aucun créneau', async (t) => {
  // Trois runs dans un seul cockpit : chaque capacité a son propre run, et le
  // poste n'ouvre qu'un serveur — un test ne doit pas épuiser les ports pour
  // prouver une propriété de transport.
  const cases = [
    {
      capability: 'materialize-ambiguity',
      action: 'RECOVERY_MATERIALIZE_AMBIGUITY',
      spec: { id: RUNS[0], state: { state: 'WAITING_AGENT' as const, pending_operation: PENDING } },
      payload: {} as Record<string, unknown>,
    },
    {
      capability: 'finalize-journaled-response',
      action: 'RECOVERY_FINALIZE_JOURNALED_RESPONSE',
      spec: { id: RUNS[1], state: { state: 'WAITING_AGENT' as const, pending_operation: PENDING }, journaled: true },
      payload: {},
    },
    {
      capability: 'acknowledge-ambiguity',
      action: 'RECOVERY_ACKNOWLEDGE_AMBIGUITY',
      spec: {
        id: RUNS[2],
        state: {
          state: 'RECOVERY_REQUIRED' as const,
          control: 'HUMAN' as const,
          pending_operation: PENDING,
          uncertainty: UNCERTAINTY,
        },
      },
      payload: { acknowledgement_text: 'Vérifié au terminal.' },
    },
  ];

  const b = await open(cases.map((item) => item.spec));
  try {
    for (const item of cases) {
      const run = item.spec.id;
      const attempts = b.instance.manager.admitAttempts();
      const key = `cle-court-${item.capability.slice(0, 8)}`;
      const payload = { expected_revision: await b.revision(run), ...item.payload };
      const result = await b.post(run, item.capability, payload, key);
      t.diagnostic(`${item.capability} → ${String(result.status)} ${String(result.body['status'])}`);

      assert.equal(result.status, 200, result.raw);
      assert.equal(result.body['action'], item.action);
      assert.equal(result.body['status'], 'SUCCEEDED');
      assert.equal(result.body['run_id'], run);
      assert.equal(result.body['created_run_id'], undefined, 'created_run_id n’appartient qu’à START');
      assert.match(String(result.body['revision_after']), /^sha256:[0-9a-f]{64}$/);
      assert.equal(result.body['error_code'], undefined);
      assert.equal(b.calls.claude + b.calls.codex, 0, 'aucun fournisseur');
      assert.equal(b.instance.manager.admitAttempts() - attempts, 0, 'aucun créneau demandé');

      // Retransmission : la même requête, à l'octet près. Elle rend le reçu
      // déjà rendu, sans rejouer l'effet — alors même que la révision qu'elle
      // porte est désormais périmée.
      const replay = await b.post(run, item.capability, payload, key);
      assert.equal(replay.status, 200, replay.raw);
      assert.equal(replay.body['operation_id'], result.body['operation_id']);
      assert.equal(replay.body['revision_after'], result.body['revision_after']);
      assert.equal(b.calls.claude + b.calls.codex, 0);
    }
  } finally {
    await b.cleanup();
  }
});

test('(H-R3) la note d’acquittement : obligatoire ici, refusée ailleurs', async (t) => {
  const b = await open([
    {
      id: RUNS[0],
      state: { state: 'RECOVERY_REQUIRED', control: 'HUMAN', pending_operation: PENDING, uncertainty: UNCERTAINTY },
    },
  ]);
  try {
    const revision = await b.revision(RUNS[0]);
    const cases = [
      ['vide', 'acknowledge-ambiguity', { expected_revision: revision, acknowledgement_text: '   ' }, 400, 'INVALID_ARGUMENT'],
      ['absente', 'acknowledge-ambiguity', { expected_revision: revision }, 400, 'INVALID_ARGUMENT'],
      ['trop longue', 'acknowledge-ambiguity', { expected_revision: revision, acknowledgement_text: 'x'.repeat(256 * 1024 + 1) }, 413, 'PAYLOAD_TOO_LARGE'],
      ['sur une autre route', 'materialize-ambiguity', { expected_revision: revision, acknowledgement_text: 'note' }, 400, 'INVALID_ARGUMENT'],
      ['champ inconnu', 'materialize-ambiguity', { expected_revision: revision, force: true }, 400, 'INVALID_ARGUMENT'],
      ['révision mal formée', 'materialize-ambiguity', { expected_revision: 'sha256:court' }, 400, 'INVALID_ARGUMENT'],
    ] as const;

    let index = 0;
    for (const [label, capability, payload, status, code] of cases) {
      index += 1;
      const key = `cle-schema-${String(index).padStart(6, '0')}`;
      const result = await b.post(RUNS[0], capability, payload, key);
      t.diagnostic(`${label} → ${String(result.status)} ${errorCode(result)}`);
      assert.equal(result.status, status, `${label} : ${result.raw.slice(0, 120)}`);
      assert.equal(errorCode(result), code, label);

      // Et le refus a lieu **avant** la revendication durable : une intention
      // mal formée ne laisse aucun reçu derrière elle. Sans cela, un schéma
      // relâché resterait invisible — l'échec surviendrait plus loin, avec le
      // même code, mais après avoir consommé la clé.
      const receipt = await b.get(`/api/operations/${operationIdFor(key)}`);
      assert.equal(receipt.status, 404, `${label} : un reçu a été créé`);
    }
    assert.equal((await b.state(RUNS[0])).state, 'RECOVERY_REQUIRED', 'aucun effet');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Levée de verrou
// --------------------------------------------------------------------------

test('(H-R4) levée : 200, révision inchangée, aucun revision_after', async (t) => {
  const b = await open([{ id: RUNS[0] }]);
  try {
    const paths = runPaths(b.runsDir, RUNS[0]);
    await writeFile(
      lockFilePath(paths),
      `${JSON.stringify({ lock_id: 'l-mort', pid: 2 ** 30, hostname: hostname(), started_at: T, command: 'step' }, null, 2)}\n`,
      'utf8',
    );
    const lock = await readRunLock(paths);
    assert.ok(lock !== undefined);
    const token = lockTokenFor(RUNS[0], lock);
    const before = await b.revision(RUNS[0]);
    const attempts = b.instance.manager.admitAttempts();

    const key = 'cle-levee-0000001';
    const result = await b.post(RUNS[0], 'clear-stale-lock', { observed_lock_token: token }, key);
    t.diagnostic(`levée → ${String(result.status)} ${String(result.body['status'])} · verrou=${String(existsSync(lockFilePath(paths)))}`);

    assert.equal(result.status, 200, result.raw);
    assert.equal(result.body['action'], 'RECOVERY_CLEAR_STALE_LOCK');
    assert.equal(result.body['status'], 'SUCCEEDED');
    assert.equal(result.body['run_id'], RUNS[0]);
    assert.equal(result.body['created_run_id'], undefined);
    assert.equal(result.body['revision_after'], undefined, 'la levée ne participe pas à la ligne canonique');
    assert.equal(result.body['error_code'], undefined);
    assert.equal(existsSync(lockFilePath(paths)), false, 'le verrou est levé');
    assert.equal(await b.revision(RUNS[0]), before, 'révision canonique inchangée');
    assert.equal(b.instance.manager.admitAttempts() - attempts, 0, 'aucun créneau');
    assert.equal(b.calls.claude + b.calls.codex, 0, 'aucune reprise enchaînée');

    // Retransmission alors que le verrou n'existe plus : le reçu répond, et
    // le système de fichiers n'est pas réinspecté.
    const replay = await b.post(RUNS[0], 'clear-stale-lock', { observed_lock_token: token }, key);
    assert.equal(replay.status, 200, replay.raw);
    assert.equal(replay.body['status'], 'SUCCEEDED');
    assert.equal(replay.body['operation_id'], result.body['operation_id']);
  } finally {
    await b.cleanup();
  }
});

test('(H-R5) levée refusée : deux causes, deux codes, deux reçus FAILED', async (t) => {
  const b = await open([{ id: RUNS[0] }, { id: RUNS[1] }]);
  try {
    // Verrou étranger : non levable.
    const foreign = runPaths(b.runsDir, RUNS[0]);
    const foreignInfo = { lock_id: 'l-etranger', pid: 2 ** 30, hostname: `${hostname()}-ailleurs`, started_at: T, command: 'step' };
    await writeFile(lockFilePath(foreign), `${JSON.stringify(foreignInfo, null, 2)}\n`, 'utf8');
    const notClearable = await b.post(
      RUNS[0],
      'clear-stale-lock',
      { observed_lock_token: lockTokenFor(RUNS[0], foreignInfo) },
      'cle-etranger-00001',
    );
    t.diagnostic(`verrou étranger → ${String(notClearable.status)} ${errorCode(notClearable)}`);
    assert.equal(notClearable.status, 422, notClearable.raw);
    assert.equal(errorCode(notClearable), 'RECOVERY_LOCK_NOT_CLEARABLE');
    assert.equal(existsSync(lockFilePath(foreign)), true, 'intact');

    // Jeton de L1 alors que L2 est en place.
    const rotated = runPaths(b.runsDir, RUNS[1]);
    const l1 = { lock_id: 'l-1', pid: 2 ** 30, hostname: hostname(), started_at: T, command: 'step' };
    const l2 = { lock_id: 'l-2', pid: 2 ** 30, hostname: hostname(), started_at: T, command: 'send' };
    await writeFile(lockFilePath(rotated), `${JSON.stringify(l2, null, 2)}\n`, 'utf8');
    const changed = await b.post(
      RUNS[1],
      'clear-stale-lock',
      { observed_lock_token: lockTokenFor(RUNS[1], l1) },
      'cle-rotation-00001',
    );
    t.diagnostic(`jeton périmé → ${String(changed.status)} ${errorCode(changed)}`);
    assert.equal(changed.status, 409, changed.raw);
    assert.equal(errorCode(changed), 'RECOVERY_LOCK_CHANGED');
    assert.equal((await readRunLock(rotated))?.lock_id, 'l-2', 'L2 intact');

    // Les deux reçus sont terminaux, et une retransmission ne réévalue rien.
    for (const [key, code] of [['cle-etranger-00001', 'RECOVERY_LOCK_NOT_CLEARABLE'], ['cle-rotation-00001', 'RECOVERY_LOCK_CHANGED']] as const) {
      const receipt = await b.get(`/api/operations/${operationIdFor(key)}`);
      assert.equal(receipt.body['status'], 'FAILED', receipt.raw);
      assert.equal(receipt.body['error_code'], code);
    }

    // Le verrou étranger devient levable ? Non : la clé porte déjà son verdict.
    await writeFile(lockFilePath(foreign), `${JSON.stringify({ ...foreignInfo, hostname: hostname() }, null, 2)}\n`, 'utf8');
    const replay = await b.post(
      RUNS[0],
      'clear-stale-lock',
      { observed_lock_token: lockTokenFor(RUNS[0], foreignInfo) },
      'cle-etranger-00001',
    );
    assert.equal(errorCode(replay), 'RECOVERY_LOCK_NOT_CLEARABLE', 'le monde a changé, le verdict non');
    assert.equal(existsSync(lockFilePath(foreign)), true, 'toujours intact');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Continuation d'initialisation — la seule longue
// --------------------------------------------------------------------------

test('(H-R6) continuation : 202 à l’admission, zéro fournisseur à cet instant', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = await open([{ id: RUNS[0], missingSession: 'codex', state: { state: 'FAILED_INITIALIZATION' } }], () => gate);
  try {
    const key = 'cle-continue-00001';
    const accepted = await b.post(RUNS[0], 'continue-initialization', { expected_revision: await b.revision(RUNS[0]) }, key);
    t.diagnostic(
      `202 → ${String(accepted.status)} ${String(accepted.body['status'])} · fournisseurs à l’admission = ${String(b.admissionProviders())}` +
        ` (au retour client : ${String(b.calls.claude + b.calls.codex)}, non ordonné)`,
    );

    assert.equal(accepted.status, 202, accepted.raw);
    assert.equal(accepted.body['action'], 'RECOVERY_CONTINUE_INITIALIZATION');
    assert.equal(accepted.body['status'], 'RUNNING');
    assert.equal(accepted.body['run_id'], RUNS[0]);
    assert.equal(accepted.body['created_run_id'], undefined);
    assert.equal(accepted.body['revision_after'], undefined, 'rien n’est encore fait');
    // L'instant qui compte est celui où l'accusé est décidé, pas celui où le
    // client finit de le lire.
    assert.equal(b.admissionProviders(), 0, 'un fournisseur avait déjà été joint quand le créneau a été pris');
    assert.equal(b.instance.manager.activeCount(), 1, 'un créneau, exactement');

    // Retransmission pendant que le fournisseur est bloqué.
    const attempts = b.instance.manager.admitAttempts();
    const duplicate = await b.post(RUNS[0], 'continue-initialization', { expected_revision: accepted.body['revision_after'] ?? (await b.revision(RUNS[0])) }, key);
    t.diagnostic(`doublon → ${String(duplicate.status)} ${String(duplicate.body['status'])}`);
    assert.equal(duplicate.status, 200, duplicate.raw);
    assert.equal(duplicate.body['status'], 'RUNNING');
    assert.equal(duplicate.body['operation_id'], accepted.body['operation_id']);
    assert.equal(b.instance.manager.admitAttempts() - attempts, 0, 'aucune seconde admission');
    assert.equal(b.calls.claude + b.calls.codex, 0, 'aucun second fournisseur');

    release();
    let receipt = await b.get(`/api/operations/${operationIdFor(key)}`);
    for (let i = 0; i < 400 && receipt.body['status'] === 'RUNNING'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      receipt = await b.get(`/api/operations/${operationIdFor(key)}`);
    }
    t.diagnostic(`terminal → ${String(receipt.body['status'])} · codex=${String(b.calls.codex)}`);
    assert.equal(receipt.body['status'], 'SUCCEEDED', receipt.raw);
    assert.match(String(receipt.body['revision_after']), /^sha256:[0-9a-f]{64}$/);
    assert.equal(receipt.body['created_run_id'], undefined);
    assert.equal(b.calls.codex, 1, 'la session manquante est créée, une fois');
    assert.equal(b.calls.claude, 0, 'la session partenaire n’est jamais recréée');
  } finally {
    release();
    await b.cleanup();
  }
});

test('(H-R7) aucun contexte initial : admise puis FAILED, jamais 422 à l’appelant', async (t) => {
  const b = await open([
    { id: RUNS[0], missingSession: 'codex', state: { state: 'FAILED_INITIALIZATION' }, withoutInitialPrompt: true },
  ]);
  try {
    const key = 'cle-sans-source-01';
    const accepted = await b.post(RUNS[0], 'continue-initialization', { expected_revision: await b.revision(RUNS[0]) }, key);
    t.diagnostic(`propriétaire → ${String(accepted.status)} ${String(accepted.body['status'])}`);

    // La requête propriétaire a été admise : elle rend 202, jamais 422.
    assert.equal(accepted.status, 202, accepted.raw);
    assert.notEqual(accepted.status, 422);

    let receipt = await b.get(`/api/operations/${operationIdFor(key)}`);
    for (let i = 0; i < 400 && receipt.body['status'] === 'RUNNING'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      receipt = await b.get(`/api/operations/${operationIdFor(key)}`);
    }
    t.diagnostic(`reçu terminal → ${String(receipt.body['status'])} ${String(receipt.body['error_code'])}`);
    assert.equal(receipt.body['status'], 'FAILED');
    assert.equal(receipt.body['error_code'], 'NO_TRANSFERABLE_SOURCE');
    assert.equal(b.calls.claude + b.calls.codex, 0, 'aucun agent joint');

    // C'est la retransmission, elle, qui projette le mapping HTTP de l'échec.
    const replay = await b.post(RUNS[0], 'continue-initialization', { expected_revision: await b.revision(RUNS[0]) }, key);
    t.diagnostic(`retransmission → ${String(replay.status)} ${errorCode(replay)}`);
    assert.equal(replay.status, 422, replay.raw);
    assert.equal(errorCode(replay), 'NO_TRANSFERABLE_SOURCE');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Préconditions, quota et idempotence
// --------------------------------------------------------------------------

test('(H-R8) une intention condamnée ne demande jamais de créneau', async (t) => {
  const b = await open([{ id: RUNS[0], missingSession: 'codex', state: { state: 'FAILED_INITIALIZATION' } }]);
  try {
    const cases = [
      ['revision-perimee', { expected_revision: `sha256:${'0'.repeat(64)}` }, 409, 'STALE_REVISION'],
      ['schema-invalide', { expected_revision: 'pas-une-revision' }, 400, 'INVALID_ARGUMENT'],
    ] as const;

    for (const [label, payload, status, code] of cases) {
      const attempts = b.instance.manager.admitAttempts();
      const result = await b.post(RUNS[0], 'continue-initialization', payload, `cle-${label}`);
      const delta = b.instance.manager.admitAttempts() - attempts;
      t.diagnostic(`${label} → ${String(result.status)} ${errorCode(result)} · delta admitAttempts=${String(delta)}`);
      assert.equal(result.status, status, result.raw);
      assert.equal(errorCode(result), code);
      assert.equal(delta, 0, `${label} : un créneau a été demandé`);
      assert.equal(b.calls.claude + b.calls.codex, 0);
    }

    // Capacité périmée : le run n'est pas dans l'état demandé.
    const attempts = b.instance.manager.admitAttempts();
    const stale = await b.post(RUNS[0], 'materialize-ambiguity', { expected_revision: await b.revision(RUNS[0]) }, 'cle-capacite-00001');
    t.diagnostic(`capacité périmée → ${String(stale.status)} ${errorCode(stale)}`);
    assert.equal(stale.status, 409, stale.raw);
    assert.equal(errorCode(stale), 'RECOVERY_CAPABILITY_STALE');
    assert.equal(b.instance.manager.admitAttempts() - attempts, 0);
  } finally {
    await b.cleanup();
  }
});

test('(H-R9) quota mixte : la continuation partage les deux créneaux', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = await open(
    [
      { id: RUNS[0], missingSession: 'codex', state: { state: 'FAILED_INITIALIZATION' } },
      { id: RUNS[1], state: { state: 'WAITING_AGENT', pending_operation: PENDING } },
      { id: RUNS[2] },
      { id: RUNS[3], missingSession: 'claude', state: { state: 'FAILED_INITIALIZATION' } },
    ],
    () => gate,
  );
  try {
    // Deux créneaux occupés : une continuation, plus une opération longue
    // simulée du même manager.
    const first = await b.post(RUNS[0], 'continue-initialization', { expected_revision: await b.revision(RUNS[0]) }, 'cle-quota-cont001');
    assert.equal(first.status, 202, first.raw);
    assert.equal(b.instance.manager.activeCount(), 1);
    const held = b.instance.manager.admit('op_autre_longue_operation');
    assert.equal(b.instance.manager.activeCount(), 2);

    // Une reprise courte sur un autre run passe : elle n'est pas une opération
    // d'agent, et ne demande aucun créneau.
    const attempts = b.instance.manager.admitAttempts();
    const short = await b.post(RUNS[1], 'materialize-ambiguity', { expected_revision: await b.revision(RUNS[1]) }, 'cle-quota-court01');
    t.diagnostic(`courte pendant quota plein → ${String(short.status)} · delta=${String(b.instance.manager.admitAttempts() - attempts)}`);
    assert.equal(short.status, 200, short.raw);
    assert.equal(b.instance.manager.admitAttempts() - attempts, 0);

    // Une levée aussi.
    const paths = runPaths(b.runsDir, RUNS[2]);
    const info = { lock_id: 'l-mort-2', pid: 2 ** 30, hostname: hostname(), started_at: T, command: 'step' };
    await writeFile(lockFilePath(paths), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    const cleared = await b.post(RUNS[2], 'clear-stale-lock', { observed_lock_token: lockTokenFor(RUNS[2], info) }, 'cle-quota-levee01');
    t.diagnostic(`levée pendant quota plein → ${String(cleared.status)}`);
    assert.equal(cleared.status, 200, cleared.raw);
    assert.equal(existsSync(lockFilePath(paths)), false);

    // La troisième longue, elle, se heurte au quota — et son reçu le dit.
    const third = await b.post(RUNS[3], 'continue-initialization', { expected_revision: await b.revision(RUNS[3]) }, 'cle-quota-troisi1');
    t.diagnostic(`troisième longue → ${String(third.status)} ${errorCode(third)}`);
    assert.equal(third.status, 503, third.raw);
    assert.equal(errorCode(third), 'COCKPIT_BUSY');
    assert.equal(b.calls.claude, 0, 'refusée avant tout fournisseur');
    const refused = await b.get(`/api/operations/${operationIdFor('cle-quota-troisi1')}`);
    assert.equal(refused.body['status'], 'FAILED', refused.raw);
    assert.equal(refused.body['error_code'], 'COCKPIT_BUSY');
    assert.equal((await b.state(RUNS[3])).state, 'FAILED_INITIALIZATION', 'aucun effet canonique');

    held.release();
    release();
  } finally {
    release();
    await b.cleanup();
  }
});

test('(H-R10) même clé, autre intention : refus sans effet', async (t) => {
  const b = await open([{ id: RUNS[0], state: { state: 'WAITING_AGENT', pending_operation: PENDING } }]);
  try {
    const revision = await b.revision(RUNS[0]);
    const key = 'cle-reutilisee-01';
    const first = await b.post(RUNS[0], 'materialize-ambiguity', { expected_revision: revision }, key);
    assert.equal(first.status, 200, first.raw);

    const conflict = await b.post(RUNS[0], 'materialize-ambiguity', { expected_revision: `sha256:${'1'.repeat(64)}` }, key);
    t.diagnostic(`empreinte différente → ${String(conflict.status)} ${errorCode(conflict)}`);
    assert.equal(conflict.status, 409, conflict.raw);
    assert.equal(errorCode(conflict), 'IDEMPOTENCY_KEY_REUSED');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Secret des reçus
// --------------------------------------------------------------------------

test('(H-R11) les reçus de reprise ne portent ni note, ni verrou, ni clé', async (t) => {
  const NOTE = 'NOTE-CONFIDENTIELLE-4f7a2c';
  const KEY = 'cle-secret-recov1';
  const b = await open([
    {
      id: RUNS[0],
      state: { state: 'RECOVERY_REQUIRED', control: 'HUMAN', pending_operation: PENDING, uncertainty: UNCERTAINTY },
    },
  ]);
  try {
    const result = await b.post(
      RUNS[0],
      'acknowledge-ambiguity',
      { expected_revision: await b.revision(RUNS[0]), acknowledgement_text: NOTE },
      KEY,
    );
    assert.equal(result.status, 200, result.raw);

    const root = path.join(resolveCockpitDataRoot(b.runsDir).controlDir, OPERATIONS_DIR_NAME);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(root);
    let bytes = 0;
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      bytes += content.length;
      for (const secret of [NOTE, KEY, 'l-mort', 'lock_id', 'hostname', 'stderr', 'cookie', 'Cookie']) {
        assert.equal(content.includes(secret), false, `${secret} trouvé dans ${path.basename(file)}`);
      }
    }
    t.diagnostic(`reçus de reprise inspectés : ${String(files.length)} fichier(s), ${String(bytes)} octets`);

    // La note vit là où elle doit : dans le journal canonique.
    const events = await readFile(runPaths(b.runsDir, RUNS[0]).events, 'utf8');
    assert.ok(events.includes(NOTE), 'la note humaine est journalisée');
  } finally {
    await b.cleanup();
  }
});

test('(H-R12) ordre de sécurité : session, origine, méthode, média — avant tout schéma', async (t) => {
  const b = await open([{ id: RUNS[0], state: { state: 'WAITING_AGENT', pending_operation: PENDING } }]);
  try {
    const port = b.instance.server.port;
    const target = `/api/runs/${RUNS[0]}/recovery/materialize-ambiguity`;
    // Corps délibérément invalide : s'il était examiné, la réponse serait 400.
    const body = JSON.stringify({ inconnu: true });
    const base = {
      Host: `127.0.0.1:${String(port)}`,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      'Idempotency-Key': 'cle-securite-0001',
    };
    const noSession = await send(port, 'POST', target, { ...base, Origin: `http://127.0.0.1:${String(port)}` }, body);
    t.diagnostic(`sans session → ${String(noSession.status)} ${errorCode(noSession)}`);
    assert.equal(noSession.status, 401, noSession.raw);

    // Une route de mutation n'existe pas en lecture — et se comporte comme les
    // routes de mutation déjà gelées, sans exception pour la reprise.
    const view = await b.get(target);
    const pause = await b.get(`/api/runs/${RUNS[0]}/pause`);
    t.diagnostic(`GET reprise → ${String(view.status)} · GET pause → ${String(pause.status)}`);
    assert.equal(view.status, pause.status, 'la reprise se lit comme les mutations gelées');

    // Une route de reprise inconnue reste un 404, même bien authentifiée.
    const unknown = await b.post(RUNS[0], 'materialize', { expected_revision: await b.revision(RUNS[0]) }, 'cle-inconnue-0001');
    assert.equal(unknown.status, 404, unknown.raw);

    // Média absent : refusé avant le schéma, donc jamais 400.
    const media = await b.post(RUNS[0], 'materialize-ambiguity', {}, 'cle-media-000001', { 'Content-Type': 'text/plain' });
    t.diagnostic(`média invalide → ${String(media.status)} ${errorCode(media)}`);
    assert.equal(media.status, 415, media.raw);

    // Aucun de ces refus n'a laissé de reçu.
    for (const key of ['cle-securite-0001', 'cle-inconnue-0001', 'cle-media-000001']) {
      assert.equal((await b.get(`/api/operations/${operationIdFor(key)}`)).status, 404, key);
    }
    assert.equal((await b.state(RUNS[0])).state, 'WAITING_AGENT', 'aucun effet');
  } finally {
    await b.cleanup();
  }
});
