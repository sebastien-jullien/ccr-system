/**
 * Verrou de run occupé : un refus certain doit produire un reçu terminal
 * (V2-IMP-41, second défaut démontré).
 *
 * `RUN_ALREADY_LOCKED` n'a qu'un site de construction, et il n'est atteint que
 * depuis la branche `EEXIST` de `acquireRunLock` — donc avant que la callback
 * gardée existe. L'effet vaut zéro, et on le sait. Laisser le reçu en `RUNNING`
 * affirmait le contraire : que l'opération était peut-être en cours.
 *
 * Le verrou est ici détenu par un **vrai processus** extérieur au cockpit. Un
 * fichier écrit à la main serait classé périmé, et prouverait autre chose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { assessLiveness, readRunLock } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import type { PendingOperation, RunStateDocument } from '../../src/core/run.ts';

const PAUSE_RUN = 'CCR-20260402-001';
const RECOVERY_RUN = 'CCR-20260808-002';
const STEP_RUN = 'CCR-20260808-003';
const INIT_RUN = 'CCR-20260808-004';

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

interface Box {
  readonly instance: CockpitInstance;
  readonly runsDir: string;
  readonly providerCalls: () => number;
  post(route: string, payload: unknown, key: string): Promise<Result>;
  get(target: string): Promise<Result>;
  revision(runId: string): Promise<string>;
  state(runId: string): Promise<RunStateDocument>;
  hold(runId: string, command?: string): Promise<ChildProcess>;
  cleanup(): Promise<void>;
}

async function open(): Promise<Box> {
  const dir = await makeTempDir('ccr-lock-busy-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });

  const created = { round: 0, actor: 'system' as const, type: 'run_created' as const, content: 'départ', timestamp: T };
  const prompt = { round: 0, actor: 'human' as const, type: 'prompt_sent' as const, content: 'contexte initial', timestamp: T };

  await materializeRun(runsDir, { runId: PAUSE_RUN, events: [created] });
  await materializeRun(runsDir, {
    runId: RECOVERY_RUN,
    state: { state: 'WAITING_AGENT', pending_operation: PENDING } as never,
    events: [created, prompt],
  });
  await materializeRun(runsDir, {
    runId: STEP_RUN,
    events: [
      created,
      { round: 1, actor: 'codex' as const, type: 'assistant_response' as const, session_id: 'codex-1', content: 'réponse initiale', timestamp: T },
    ],
  });
  await materializeRun(runsDir, { runId: INIT_RUN, state: { state: 'FAILED_INITIALIZATION' } as never, events: [created, prompt] });

  for (const runId of [PAUSE_RUN, RECOVERY_RUN, STEP_RUN, INIT_RUN]) {
    const file = runPaths(runsDir, runId).manifest;
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      agents: Record<string, { session_id: string | null }>;
      workspace: { cwd: string };
    };
    manifest.workspace.cwd = dir;
    if (runId === INIT_RUN) {
      const codex = manifest.agents['codex'];
      if (codex !== undefined) codex.session_id = null;
    }
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  let providerCalls = 0;
  const count = async (): Promise<void> => {
    providerCalls += 1;
  };
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', onCall: count }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', onCall: count }),
  };

  const instance = await startCockpit({ runsDir, port: 0, depsOverrides: { createAdapters: () => adapters } });
  const port = instance.server.port;
  const cookie = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
    });
    req.on('error', reject);
    req.end();
  });

  const holders: ChildProcess[] = [];

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
    state: async (runId) => JSON.parse(await readFile(runPaths(runsDir, runId).state, 'utf8')) as RunStateDocument,
    async hold(runId, command = 'step') {
      const child = spawn(process.execPath, ['tests/fixtures/hold-run-lock.mjs', runsDir, runId, command], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      holders.push(child);
      await new Promise<void>((resolve, reject) => {
        child.stdout?.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`le détenteur est mort (${String(code)})`)));
      });
      return child;
    },
    cleanup: async () => {
      for (const child of holders) child.kill('SIGKILL');
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

/** Reçu physique tel qu'il est publié sur disque, sans passer par HTTP. */
async function receiptOnDisk(runsDir: string, key: string): Promise<Record<string, unknown>> {
  const { resolveCockpitDataRoot } = await import('../../src/cockpit/data-root.ts');
  const { OPERATIONS_DIR_NAME } = await import('../../src/cockpit/operations-store.ts');
  const digest = operationIdFor(key).slice(3);
  const file = path.join(resolveCockpitDataRoot(runsDir).controlDir, OPERATIONS_DIR_NAME, digest.slice(0, 2), `${digest}.json`);
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

// --------------------------------------------------------------------------
// L1 — mutation courte
// --------------------------------------------------------------------------

test('(L1) PAUSE sur un run verrouillé : 409 et reçu FAILED, jamais RUNNING', async (t) => {
  const b = await open();
  try {
    await b.hold(PAUSE_RUN, 'send');
    const key = 'cle-busy-pause001';
    const before = await b.state(PAUSE_RUN);

    const result = await b.post(`/api/runs/${PAUSE_RUN}/pause`, { expected_revision: await b.revision(PAUSE_RUN) }, key);
    t.diagnostic(`propriétaire → ${String(result.status)} ${errorCode(result)}`);
    assert.equal(result.status, 409, result.raw);
    assert.equal(errorCode(result), 'RUN_ALREADY_LOCKED');

    // Le reçu physique, puis sa projection publique : les deux terminaux.
    const disk = await receiptOnDisk(b.runsDir, key);
    t.diagnostic(`reçu disque → ${String(disk['status'])} / ${String(disk['error_code'])}`);
    assert.equal(disk['status'], 'FAILED');
    assert.equal(disk['error_code'], 'RUN_ALREADY_LOCKED');
    assert.notEqual(disk['status'], 'RUNNING');

    const receipt = await b.get(`/api/operations/${operationIdFor(key)}`);
    assert.equal(receipt.body['status'], 'FAILED', receipt.raw);
    assert.equal(receipt.body['error_code'], 'RUN_ALREADY_LOCKED');
    assert.equal(receipt.body['revision_after'], undefined, 'aucun effet, donc aucune révision d’après');

    // Retransmission : le même verdict, sans réévaluer le verrou.
    const replay = await b.post(`/api/runs/${PAUSE_RUN}/pause`, { expected_revision: await b.revision(PAUSE_RUN) }, key);
    assert.equal(replay.status, 409, replay.raw);
    assert.equal(errorCode(replay), 'RUN_ALREADY_LOCKED');
    assert.equal(replay.body['operation_id'] ?? disk['operation_id'], disk['operation_id']);

    assert.deepEqual(await b.state(PAUSE_RUN), before, 'aucun effet canonique');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// L2 — reprise canonique courte
// --------------------------------------------------------------------------

test('(L2) reprise courte sur un run verrouillé : 409, reçu FAILED, aucune reprise', async (t) => {
  const b = await open();
  try {
    await b.hold(RECOVERY_RUN, 'step');
    const key = 'cle-busy-recover1';
    const before = await b.state(RECOVERY_RUN);

    const result = await b.post(
      `/api/runs/${RECOVERY_RUN}/recovery/materialize-ambiguity`,
      { expected_revision: await b.revision(RECOVERY_RUN) },
      key,
    );
    t.diagnostic(`reprise → ${String(result.status)} ${errorCode(result)}`);
    assert.equal(result.status, 409, result.raw);
    assert.equal(errorCode(result), 'RUN_ALREADY_LOCKED');

    const disk = await receiptOnDisk(b.runsDir, key);
    assert.equal(disk['status'], 'FAILED');
    assert.equal(disk['error_code'], 'RUN_ALREADY_LOCKED');
    assert.equal(disk['action'], 'RECOVERY_MATERIALIZE_AMBIGUITY');

    assert.deepEqual(await b.state(RECOVERY_RUN), before, 'aucun effet de reprise');
    assert.equal(b.providerCalls(), 0);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// L3 — chemins longs, avant admission
// --------------------------------------------------------------------------

test('(L3) chemins longs verrouillés : FAILED, aucun créneau, aucun fournisseur', async (t) => {
  const b = await open();
  try {
    await b.hold(STEP_RUN, 'send');
    await b.hold(INIT_RUN, 'send');

    const cases = [
      { label: 'STEP', route: `/api/runs/${STEP_RUN}/step`, run: STEP_RUN, key: 'cle-busy-step0001' },
      {
        label: 'CONTINUE_INITIALIZATION',
        route: `/api/runs/${INIT_RUN}/recovery/continue-initialization`,
        run: INIT_RUN,
        key: 'cle-busy-continu1',
      },
    ] as const;

    for (const item of cases) {
      const attempts = b.instance.manager.admitAttempts();
      const before = await b.state(item.run);
      const result = await b.post(item.route, { expected_revision: await b.revision(item.run) }, item.key);
      const delta = b.instance.manager.admitAttempts() - attempts;
      t.diagnostic(`${item.label} → ${String(result.status)} ${errorCode(result)} · delta admitAttempts=${String(delta)}`);

      assert.equal(result.status, 409, `${item.label} : ${result.raw}`);
      assert.equal(errorCode(result), 'RUN_ALREADY_LOCKED', item.label);
      assert.equal(delta, 0, `${item.label} : un créneau a été demandé avant le verrou`);

      const disk = await receiptOnDisk(b.runsDir, item.key);
      assert.equal(disk['status'], 'FAILED', item.label);
      assert.equal(disk['error_code'], 'RUN_ALREADY_LOCKED', item.label);
      assert.deepEqual(await b.state(item.run), before, `${item.label} : effet canonique`);
    }

    assert.equal(b.providerCalls(), 0, 'aucun fournisseur joint');
    assert.equal(b.instance.manager.activeCount(), 0);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// L4 — même clé après libération, puis clé neuve
// --------------------------------------------------------------------------

test('(L4) le verrou libéré ne rouvre pas une tentative jugée ; une clé neuve, si', async (t) => {
  const b = await open();
  try {
    const holder = await b.hold(PAUSE_RUN, 'send');
    const K1 = 'cle-busy-premier1';
    const K2 = 'cle-busy-seconde1';

    const first = await b.post(`/api/runs/${PAUSE_RUN}/pause`, { expected_revision: await b.revision(PAUSE_RUN) }, K1);
    assert.equal(first.status, 409, first.raw);
    assert.equal(errorCode(first), 'RUN_ALREADY_LOCKED');
    assert.equal((await receiptOnDisk(b.runsDir, K1))['status'], 'FAILED');

    // Le verrou disparaît réellement : le processus meurt et son fichier part.
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    const { lockFilePath } = await import('../../src/lock/run-lock.ts');
    const lockPath = lockFilePath(runPaths(b.runsDir, PAUSE_RUN));
    const { unlink } = await import('node:fs/promises');
    await unlink(lockPath);
    t.diagnostic('verrou externe libéré');

    // La même clé porte toujours son verdict : la tentative a été jugée.
    const retry = await b.post(`/api/runs/${PAUSE_RUN}/pause`, { expected_revision: await b.revision(PAUSE_RUN) }, K1);
    t.diagnostic(`même clé après libération → ${String(retry.status)} ${errorCode(retry)}`);
    assert.equal(retry.status, 409, retry.raw);
    assert.equal(errorCode(retry), 'RUN_ALREADY_LOCKED');
    assert.equal((await b.state(PAUSE_RUN)).control, 'AUTOMATION', 'aucune réévaluation, donc aucun effet');

    // Une clé neuve est une nouvelle tentative humaine, et elle est évaluée.
    const fresh = await b.post(`/api/runs/${PAUSE_RUN}/pause`, { expected_revision: await b.revision(PAUSE_RUN) }, K2);
    t.diagnostic(`clé neuve → ${String(fresh.status)} ${String(fresh.body['status'])}`);
    assert.equal(fresh.status, 200, fresh.raw);
    assert.equal(fresh.body['status'], 'SUCCEEDED');
    assert.equal((await b.state(PAUSE_RUN)).control, 'HUMAN', 'la mutation a bien eu lieu');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// L5 — assertion générale
// --------------------------------------------------------------------------

test('(L5) aucune requête propriétaire close en 409 verrou ne laisse un reçu RUNNING', async (t) => {
  const b = await open();
  try {
    await b.hold(PAUSE_RUN, 'send');
    await b.hold(RECOVERY_RUN, 'send');
    await b.hold(STEP_RUN, 'send');

    /**
     * Quatrième verrou : son propriétaire est **mort**, et son fichier reste.
     *
     * C'est l'autre sortie du même `conflictError`, choisie par le seul examen
     * de vivacité. Une première écriture de ce test la classait « hors
     * périmètre » et passait à la suivante — elle ne pouvait donc pas voir que
     * la correction ne couvrait qu'une moitié du refus. Le cas mort est
     * pourtant le plus fréquent : il survit à un arrêt brutal.
     */
    const dead = await b.hold(INIT_RUN, 'send');
    dead.kill('SIGKILL');
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
    const abandoned = await readRunLock(runPaths(b.runsDir, INIT_RUN));
    assert.ok(abandoned !== undefined, 'le verrou du processus mort subsiste');
    assert.equal(assessLiveness(abandoned), 'STALE', 'le propriétaire est bien mort');

    const attempts = [
      { key: 'cle-l5-pause00001', route: `/api/runs/${PAUSE_RUN}/pause`, run: PAUSE_RUN, code: 'RUN_ALREADY_LOCKED' },
      { key: 'cle-l5-stop000001', route: `/api/runs/${PAUSE_RUN}/stop`, run: PAUSE_RUN, code: 'RUN_ALREADY_LOCKED' },
      { key: 'cle-l5-recover001', route: `/api/runs/${RECOVERY_RUN}/recovery/materialize-ambiguity`, run: RECOVERY_RUN, code: 'RUN_ALREADY_LOCKED' },
      { key: 'cle-l5-step000001', route: `/api/runs/${STEP_RUN}/step`, run: STEP_RUN, code: 'RUN_ALREADY_LOCKED' },
      { key: 'cle-l5-perime001', route: `/api/runs/${INIT_RUN}/pause`, run: INIT_RUN, code: 'STALE_LOCK' },
      { key: 'cle-l5-perime002', route: `/api/runs/${INIT_RUN}/recovery/materialize-ambiguity`, run: INIT_RUN, code: 'STALE_LOCK' },
    ] as const;

    const observed: string[] = [];
    for (const attempt of attempts) {
      const result = await b.post(attempt.route, { expected_revision: await b.revision(attempt.run) }, attempt.key);
      // Aucune échappatoire : un refus de verrou entre dans le périmètre, quelle
      // que soit la vivacité du détenteur.
      assert.equal(result.status, 409, `${attempt.key} : ${result.raw}`);
      assert.equal(errorCode(result), attempt.code, attempt.key);

      const disk = await receiptOnDisk(b.runsDir, attempt.key);
      observed.push(`${attempt.route.split('/').pop() ?? ''}[${attempt.code}] → ${String(disk['status'])}/${String(disk['error_code'])}`);
      assert.notEqual(disk['status'], 'RUNNING', `${attempt.key} : reçu resté RUNNING`);
      assert.equal(disk['status'], 'FAILED', attempt.key);
      assert.equal(disk['error_code'], attempt.code, attempt.key);
    }
    t.diagnostic(observed.join(' · '));
    assert.equal(observed.length, attempts.length);
  } finally {
    await b.cleanup();
  }
});
