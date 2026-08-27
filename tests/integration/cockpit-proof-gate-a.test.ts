/**
 * IT-5C — les six propriétés du Proof Gate A.
 *
 * Chacune était implémentée mais **non falsifiée**. Elles le sont ici sur la
 * cause plutôt que sur une conséquence :
 *
 * ```text
 * garde-fou   une intention qui échoue peut avoir changé l'état
 * M8          la révision se vérifie SOUS le verrou, pas avant
 * M13         un reçu terminal impossible à écrire → UNKNOWN, jamais RUNNING
 * M5          une mutation courte ne DEMANDE même pas d'admission
 * M6          un duplicata est intercepté AVANT l'admission
 * M7          une requête invalide ne DEMANDE même pas d'admission
 * ```
 *
 * `admitAttempts()` est l'instrument central : il compte les **demandes**, pas
 * les réservations. Observer les créneaux occupés ne prouverait rien — un
 * défaut bref serait invisible.
 *
 * Aucun fournisseur réel n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { createOperationStore } from '../../src/cockpit/operations-store.ts';
import type { OperationStore } from '../../src/cockpit/operations-store.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { CcrError } from '../../src/core/errors.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN = 'CCR-20260402-001';
const OTHER = 'CCR-20260808-002';
const THIRD = 'CCR-20260808-003';

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

interface Box {
  readonly instance: CockpitInstance;
  readonly runsDir: string;
  readonly providerCalls: () => number;
  post(route: string, payload: unknown, key: string): Promise<Result>;
  get(target: string): Promise<Result>;
  revision(runId: string): Promise<string>;
  facts(runId: string): Promise<{ state: string; control: string; events: number }>;
  cleanup(): Promise<void>;
}

interface OpenOptions {
  readonly gate?: Promise<void>;
  readonly env?: NodeJS.ProcessEnv;
  readonly beforeLock?: () => void | Promise<void>;
  readonly store?: (real: OperationStore) => OperationStore;
  /** Un seul événement de départ : aucune source transférable. */
  readonly bare?: boolean;
  readonly bigResponse?: boolean;
}

async function open(options: OpenOptions = {}): Promise<Box> {
  const dir = await makeTempDir('ccr-gate-a-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });

  const response = options.bigResponse === true ? 'x'.repeat(4096) : 'réponse initiale de Codex';
  for (const runId of [RUN, OTHER, THIRD]) {
    await materializeRun(runsDir, {
      runId,
      events: options.bare === true
        ? [{ round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T }]
        : [
            { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
            { round: 1, actor: 'codex', type: 'assistant_response', session_id: 'codex-1', content: response, timestamp: T },
          ],
    });
  }

  let providerCalls = 0;
  const onCall = async (): Promise<void> => {
    providerCalls += 1;
    if (options.gate !== undefined) await options.gate;
  };
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', onCall }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', onCall }),
  };

  const dataRoot = resolveCockpitDataRoot(runsDir);
  const realStore = createOperationStore(dataRoot, 'instance-de-test');

  const instance = await startCockpit({
    runsDir,
    port: 0,
    depsOverrides: { createAdapters: () => adapters },
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.beforeLock === undefined ? {} : { longHooks: { beforeLock: options.beforeLock } }),
    ...(options.store === undefined ? {} : { operationsStore: options.store(realStore) }),
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
    providerCalls: () => providerCalls,
    post(route, payload, key) {
      const body = JSON.stringify(payload);
      return send(port, 'POST', route, {
        Host: `127.0.0.1:${String(port)}`,
        Origin: `http://127.0.0.1:${String(port)}`,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Idempotency-Key': key,
      }, body);
    },
    get: (target) => send(port, 'GET', target, { Host: `127.0.0.1:${String(port)}`, Cookie: cookie }),
    revision: async (runId) => (await readStableRunSnapshot(runsDir, runId)).revision,
    async facts(runId) {
      const snapshot = await readStableRunSnapshot(runsDir, runId);
      const events = await (await openEventStore(runPaths(runsDir, runId), runId)).readAll();
      return { state: snapshot.state.state, control: snapshot.state.control, events: events.length };
    },
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

// --------------------------------------------------------------------------
// (G1) Garde-fou de taille : une intention refusée, un état pourtant changé
// --------------------------------------------------------------------------

test('(G1) STEP surdimensionné : 422, effet canonique, revision_after capturée', async (t) => {
  // Garde-fou volontairement minuscule : la réponse initiale le dépasse.
  const b = await open({ env: { CCR_MAX_TRANSFER_BYTES: '64' }, bigResponse: true });
  try {
    const before = await b.revision(RUN);
    const attempts = b.instance.manager.admitAttempts();
    const key = 'cle-oversize-00001';

    const refused = await b.post(`/api/runs/${RUN}/step`, { expected_revision: before }, key);
    const after = await b.facts(RUN);
    t.diagnostic(`${String(refused.status)} ${String((refused.body['error'] as { code?: string } | undefined)?.code)} · état ${after.state}/${after.control}`);

    assert.equal(refused.status, 422, refused.raw);
    assert.equal((refused.body['error'] as { code: string }).code, 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');

    // L'effet canonique V1 a bien eu lieu : le garde-fou protège, il ne se tait pas.
    assert.equal(after.state, 'WAITING_HUMAN');
    assert.equal(after.control, 'HUMAN');
    const events = await (await openEventStore(runPaths(b.runsDir, RUN), RUN)).readAll();
    const guard = events.find((event) => (event.details as { reason?: string } | null)?.reason === 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
    assert.ok(guard !== undefined, 'événement de garde-fou V1 présent');
    assert.equal(guard?.actor, 'system');
    assert.equal((guard?.details as { to?: string }).to, 'WAITING_HUMAN');

    // Et surtout : ni créneau demandé, ni fournisseur appelé.
    assert.equal(b.instance.manager.admitAttempts(), attempts, 'aucune demande d’admission');
    assert.equal(b.providerCalls(), 0, 'aucun fournisseur');

    // La révision d'après existe, et elle diffère : c'est la preuve que la
    // capture s'est faite avant la libération du verrou.
    const operationId = String(refused.body['operation_id']);
    const receipt = await b.get(`/api/operations/${operationId}`);
    assert.equal(receipt.body['status'], 'FAILED');
    assert.equal(receipt.body['error_code'], 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
    assert.equal(typeof receipt.body['revision_after'], 'string');
    assert.notEqual(receipt.body['revision_after'], before);
    assert.equal(receipt.body['revision_after'], await b.revision(RUN), 'révision réellement produite');

    // Retransmission : le verdict durable, jamais un second garde-fou.
    const factsBefore = await b.facts(RUN);
    const replay = await b.post(`/api/runs/${RUN}/step`, { expected_revision: before }, key);
    assert.equal(replay.status, 422);
    assert.equal(replay.body['operation_id'], operationId);
    assert.deepEqual(await b.facts(RUN), factsBefore, 'aucun nouvel événement, aucune transition');
    assert.equal(b.instance.manager.admitAttempts(), attempts);
    assert.equal(b.providerCalls(), 0);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (G2 / M8) TOCTOU : la révision se vérifie sous le verrou
// --------------------------------------------------------------------------

test('(G2) TOCTOU long : le run change entre le claim et le verrou → STALE_REVISION', async (t) => {
  let box: Box | undefined;
  let mutated = false;

  const beforeLock = async (): Promise<void> => {
    if (mutated || box === undefined) return;
    mutated = true;
    // Écrivain tiers : le run passe de R1 à R2 pendant la fenêtre.
    const events = await openEventStore(runPaths(box.runsDir, RUN), RUN);
    await events.append({
      round: 1,
      actor: 'human',
      type: 'human_message',
      content: 'écriture concurrente',
      timestamp: new Date().toISOString(),
    });
  };

  box = await open({ beforeLock });
  try {
    const r1 = await box.revision(RUN);
    const attempts = box.instance.manager.admitAttempts();
    const before = await box.facts(RUN);

    const result = await box.post(`/api/runs/${RUN}/step`, { expected_revision: r1 }, 'cle-toctou-000001');
    const r2 = await box.revision(RUN);
    t.diagnostic(`R1 ${r1.slice(7, 17)}… → R2 ${r2.slice(7, 17)}… · ${String(result.status)}`);

    assert.equal(mutated, true, 'la fenêtre a bien été exercée');
    assert.notEqual(r2, r1, 'le run a réellement changé');
    assert.equal(result.status, 409, result.raw);
    assert.equal((result.body['error'] as { code: string }).code, 'STALE_REVISION');

    assert.equal(box.instance.manager.admitAttempts(), attempts, 'aucune demande d’admission');
    assert.equal(box.providerCalls(), 0, 'aucun fournisseur');
    // Le seul événement supplémentaire est celui de l'écrivain tiers.
    assert.equal((await box.facts(RUN)).events, before.events + 1);

    const receipt = await box.get(`/api/operations/${String(result.body['operation_id'])}`);
    assert.equal(receipt.body['status'], 'FAILED');
    assert.equal(receipt.body['error_code'], 'STALE_REVISION');
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// (G3 / M13) Terminalisation durable impossible → UNKNOWN
// --------------------------------------------------------------------------

test('(G3) reçu terminal impossible à écrire : UNKNOWN, jamais RUNNING éternel', async (t) => {
  let failNext = true;
  const b = await open({
    store: (real) => ({
      claim: (input) => real.claim(input),
      associateRun: (id, runId) => real.associateRun(id, runId),
      read: (id) => real.read(id),
      settle: (id, patch) => {
        // Panne durable au pire moment : l effet est fait, et AUCUN verdict ne
        // peut être écrit — ni le succès, ni le repli en échec.
        if (failNext) return Promise.reject(new CcrError('OPERATION_STORE_CORRUPT', 'écriture impossible'));
        return real.settle(id, patch);
      },
    }),
  });
  try {
    const key = 'cle-terminal-00001';
    // Révision figée : une retransmission de LA MÊME tentative doit la
    // réutiliser, sinon elle exprime une autre intention.
    const revision = await b.revision(RUN);
    const accepted = await b.post(`/api/runs/${RUN}/step`, { expected_revision: revision }, key);
    assert.equal(accepted.status, 202, accepted.raw);
    const operationId = String(accepted.body['operation_id']);

    // On attend que l'opération quitte l'état actif du manager.
    for (let i = 0; i < 400 && b.instance.manager.activeCount() > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const receipt = await b.get(`/api/operations/${operationId}`);
    t.diagnostic(`reçu disque=RUNNING · rendu=${String(receipt.body['status'])} · créneaux=${String(b.instance.manager.activeCount())}`);

    assert.equal(receipt.body['status'], 'UNKNOWN', 'l’instance sait que la tâche est finie');
    assert.equal(b.instance.manager.isUncertain(operationId), true);
    assert.equal(b.instance.manager.activeCount(), 0, 'créneau libéré');
    assert.equal(b.instance.registry.size(), 0, 'registre hôte nettoyé');
    assert.equal(b.providerCalls(), 1, 'exactement un appel fournisseur');

    // Retransmission : même verdict, aucune relance.
    const attempts = b.instance.manager.admitAttempts();
    const factsBefore = await b.facts(RUN);
    const replay = await b.post(`/api/runs/${RUN}/step`, { expected_revision: revision }, key);
    assert.equal(replay.body['status'], 'UNKNOWN', replay.raw);
    assert.equal(replay.body['operation_id'], operationId);
    assert.equal(b.instance.manager.admitAttempts(), attempts, 'aucune nouvelle admission');
    assert.equal(b.providerCalls(), 1, 'aucun nouveau fournisseur');
    assert.deepEqual(await b.facts(RUN), factsBefore, 'aucun nouvel effet');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (G4 / M5, M6, M7) Qui demande l'admission — et qui ne la demande pas
// --------------------------------------------------------------------------

test('(G4) une mutation courte ne demande jamais d’admission longue', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = await open({ gate });
  try {
    // Deux opérations longues occupent le quota.
    await b.post(`/api/runs/${RUN}/step`, { expected_revision: await b.revision(RUN) }, 'cle-g4-long-00001');
    await b.post(`/api/runs/${OTHER}/step`, { expected_revision: await b.revision(OTHER) }, 'cle-g4-long-00002');
    assert.equal(b.instance.manager.activeCount(), 2);

    const attempts = b.instance.manager.admitAttempts();
    const decided = await b.post(
      `/api/runs/${THIRD}/decide`,
      { expected_revision: await b.revision(THIRD), content: 'décision humaine' },
      'cle-g4-courte-0001',
    );
    t.diagnostic(`courte → ${String(decided.status)} · demandes d’admission inchangées : ${String(b.instance.manager.admitAttempts() === attempts)}`);

    assert.equal(decided.status, 200, decided.raw);
    assert.equal(b.instance.manager.admitAttempts(), attempts, 'le chemin court ne demande rien');
    assert.equal(b.instance.manager.activeCount(), 2, 'le quota long est intact');

    release();
  } finally {
    release();
    await b.cleanup();
  }
});

test('(G5) un duplicata en vol est intercepté avant l’admission', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = await open({ gate });
  try {
    const key = 'cle-g5-duplicate01';
    const revision = await b.revision(RUN);
    const first = await b.post(`/api/runs/${RUN}/step`, { expected_revision: revision }, key);
    assert.equal(first.status, 202);
    for (let i = 0; i < 200 && b.providerCalls() === 0; i += 1) await new Promise((r) => setTimeout(r, 10));

    const attempts = b.instance.manager.admitAttempts();
    const duplicate = await b.post(`/api/runs/${RUN}/step`, { expected_revision: revision }, key);
    t.diagnostic(`duplicata → ${String(duplicate.status)} ${String(duplicate.body['status'])} · demandes ${String(attempts)} → ${String(b.instance.manager.admitAttempts())}`);

    assert.equal(duplicate.body['operation_id'], first.body['operation_id']);
    assert.equal(duplicate.body['status'], 'RUNNING');
    assert.equal(b.instance.manager.admitAttempts(), attempts, 'l’idempotence intercepte avant l’admission');
    assert.equal(b.instance.manager.activeCount(), 1);
    assert.equal(b.providerCalls(), 1);

    release();
  } finally {
    release();
    await b.cleanup();
  }
});

test('(G6) une requête invalide ne demande jamais d’admission', async (t) => {
  const stale = await open();
  try {
    const attempts = stale.instance.manager.admitAttempts();

    // A — vue périmée.
    const outdated = await stale.post(`/api/runs/${RUN}/step`, { expected_revision: `sha256:${'a'.repeat(64)}` }, 'cle-g6-stale-00001');
    assert.equal(outdated.status, 409);

    // B — cible SEND invalide (refus de schéma, avant même le claim).
    const badTarget = await stale.post(
      `/api/runs/${RUN}/send`,
      { expected_revision: await stale.revision(RUN), target: 'gemini', content: 'x' },
      'cle-g6-cible-00001',
    );
    assert.equal(badTarget.status, 400);

    t.diagnostic(`demandes d’admission après deux refus : ${String(stale.instance.manager.admitAttempts() - attempts)}`);
    assert.equal(stale.instance.manager.admitAttempts(), attempts, 'aucune demande');
    assert.equal(stale.providerCalls(), 0);
  } finally {
    await stale.cleanup();
  }

  // C — aucune source transférable.
  const bare = await open({ bare: true });
  try {
    const attempts = bare.instance.manager.admitAttempts();
    const noSource = await bare.post(`/api/runs/${RUN}/step`, { expected_revision: await bare.revision(RUN) }, 'cle-g6-source-0001');
    assert.equal(noSource.status, 422, noSource.raw);
    assert.equal((noSource.body['error'] as { code: string }).code, 'NO_TRANSFERABLE_SOURCE');
    assert.equal(bare.instance.manager.admitAttempts(), attempts, 'aucune demande');
    assert.equal(bare.providerCalls(), 0);
  } finally {
    await bare.cleanup();
  }
});
