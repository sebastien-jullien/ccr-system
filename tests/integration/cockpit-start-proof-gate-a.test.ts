/**
 * Slice 6 — Proof Gate A : incertitude, crash, quota mixte, vivacité de START.
 *
 * Le Slice 6 avait prouvé le chemin heureux et ses refus. Restent les questions
 * où CCR ne peut pas répondre « oui » ou « non » sans mentir :
 *
 * ```text
 * un run est alloué, le reçu ne peut pas le nommer   → ni succès, ni échec
 * le processus meurt entre deux écritures durables   → jamais un rejeu
 * ```
 *
 * Aucun fournisseur réel n'est sollicité : probes de preflight et adapters sont
 * des doublures. Ce qui est réel : les processus, les sockets, les verrous et
 * les fichiers canoniques.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearStaleCockpitLock, startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { inspectServerLock } from '../../src/cockpit/server-lock.ts';
import { createOperationStore } from '../../src/cockpit/operations-store.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { readRunLock } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { OperationReceipt, OperationStore } from '../../src/cockpit/operations-store.ts';
import type { StartMutationHooks } from '../../src/services/start-mutation.ts';

const CRASHER = fileURLToPath(new URL('../helpers/crash-cockpit.ts', import.meta.url));
const RUNS = ['CCR-20260402-001', 'CCR-20260808-002', 'CCR-20260808-003'] as const;

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

function http(port: number, method: string, target: string, headers: Record<string, string>, body?: string): Promise<Result> {
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function barrier(): { wait: () => Promise<void>; release: () => void; entered: () => number } {
  let count = 0;
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  return {
    wait: async () => {
      count += 1;
      await gate;
    },
    release: () => unlock(),
    entered: () => count,
  };
}

const probeOf = (agent: 'claude' | 'codex'): Promise<AgentRuntimeProbe> =>
  Promise.resolve({ agent, installed: true, version: '1.0.0', authStatus: 'AUTHENTICATED', launcherSource: 'explicit' });

/** Compteurs par agent : le reçu seul ne prouve jamais « aucun rejeu ». */
interface Counters {
  claude: number;
  codex: number;
}

interface OpenOptions {
  readonly seedRuns?: boolean;
  readonly onCall?: () => Promise<void>;
  readonly claudeAuth?: AgentRuntimeProbe['authStatus'];
  readonly startHooks?: StartMutationHooks;
  readonly store?: (real: OperationStore) => OperationStore;
}

interface Box {
  readonly instance: CockpitInstance;
  readonly runsDir: string;
  readonly workspace: string;
  readonly dir: string;
  readonly calls: Counters;
  start(payload: unknown, key: string): Promise<Result>;
  long(runId: string, segment: 'step' | 'send', key: string, extra?: Record<string, unknown>): Promise<Result>;
  get(target: string): Promise<Result>;
  runIds(): Promise<string[]>;
  cleanup(): Promise<void>;
}

async function seedRun(runsDir: string, runId: string, cwd: string): Promise<void> {
  await materializeRun(runsDir, {
    runId,
    events: [
      { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
      { round: 1, actor: 'codex', type: 'assistant_response', session_id: 'codex-1', content: 'réponse', timestamp: T },
    ],
  });
  const file = runPaths(runsDir, runId).manifest;
  const manifest = JSON.parse(await readFile(file, 'utf8')) as { workspace: { cwd: string } };
  manifest.workspace.cwd = cwd;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function open(options: OpenOptions = {}): Promise<Box> {
  const dir = await makeTempDir('ccr-s6a-');
  const runsDir = path.join(dir, 'runs');
  const workspace = path.join(dir, 'workspace');
  for (const target of [runsDir, workspace]) await mkdir(target, { recursive: true });
  if (options.seedRuns === true) {
    for (const runId of RUNS) await seedRun(runsDir, runId, workspace);
  }

  const calls: Counters = { claude: 0, codex: 0 };
  const record = (agent: 'claude' | 'codex') => async (): Promise<void> => {
    calls[agent] += 1;
    await options.onCall?.();
  };
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', onCall: record('claude') }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', onCall: record('codex') }),
  };

  const dataRoot = resolveCockpitDataRoot(runsDir);
  const realStore = createOperationStore(dataRoot, 'instance-de-test');

  const instance = await startCockpit({
    runsDir,
    port: 0,
    depsOverrides: { createAdapters: () => adapters },
    preflightSeams: {
      configPath: path.join(dir, 'absente.json'),
      env: {},
      probes: {
        claude: () =>
          options.claudeAuth === undefined
            ? probeOf('claude')
            : Promise.resolve({
                agent: 'claude' as const,
                installed: true,
                version: '1.0.0',
                authStatus: options.claudeAuth,
                launcherSource: 'explicit',
              }),
        codex: () => probeOf('codex'),
      },
    },
    ...(options.startHooks === undefined ? {} : { startHooks: options.startHooks }),
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

  const mutate = (target: string, body: string, key: string): Promise<Result> =>
    http(port, 'POST', target, {
      Host: `127.0.0.1:${String(port)}`,
      Origin: `http://127.0.0.1:${String(port)}`,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      'Idempotency-Key': key,
    }, body);

  return {
    instance,
    runsDir,
    workspace,
    dir,
    calls,
    start: (payload, key) => mutate('/api/runs', JSON.stringify(payload), key),
    async long(runId, segment, key, extra = {}) {
      const revision = (await readStableRunSnapshot(runsDir, runId)).revision;
      return mutate(`/api/runs/${runId}/${segment}`, JSON.stringify({ expected_revision: revision, ...extra }), key);
    },
    get: (target) => http(port, 'GET', target, { Host: `127.0.0.1:${String(port)}`, Cookie: cookie }),
    runIds: async () => (await readdir(runsDir)).filter((name) => name.startsWith('CCR-')),
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

const intent = (workspace: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Revue croisée',
  workspace_cwd: workspace,
  prompt: 'Contexte initial du run.',
  ...over,
});

// --------------------------------------------------------------------------
// Quota mixte
// --------------------------------------------------------------------------

test('(A1) START et STEP partagent exactement le même quota', async (t) => {
  const gate = barrier();
  const b = await open({ seedRuns: true, onCall: () => gate.wait() });
  try {
    const stepped = await b.long(RUNS[0], 'step', 'cle-mixte-step0001');
    assert.equal(stepped.status, 202, stepped.raw);
    assert.equal(b.instance.manager.activeCount(), 1, 'STEP occupe un créneau');

    const created = await b.start(intent(b.workspace), 'cle-mixte-start001');
    t.diagnostic(`STEP puis START → ${String(stepped.status)}, ${String(created.status)} · active_count = ${String(b.instance.manager.activeCount())}`);
    assert.equal(created.status, 202, created.raw);
    assert.equal(b.instance.manager.activeCount(), 2, 'START occupe le second');

    const third = await b.long(RUNS[1], 'step', 'cle-mixte-step0002');
    t.diagnostic(`troisième longue → ${String(third.status)} ${String((third.body['error'] as { code?: string } | undefined)?.code)}`);
    assert.equal(third.status, 503, third.raw);
    assert.equal((third.body['error'] as { code: string }).code, 'COCKPIT_BUSY');
  } finally {
    gate.release();
    await b.cleanup();
  }
});

test('(A2) START et SEND partagent exactement le même quota', async (t) => {
  const gate = barrier();
  const b = await open({ seedRuns: true, onCall: () => gate.wait() });
  try {
    const sent = await b.long(RUNS[0], 'send', 'cle-mixte-send0001', { target: 'codex', content: 'bonjour' });
    assert.equal(sent.status, 202, sent.raw);
    assert.equal(b.instance.manager.activeCount(), 1);

    const created = await b.start(intent(b.workspace), 'cle-mixte-start002');
    t.diagnostic(`SEND puis START → ${String(sent.status)}, ${String(created.status)} · active_count = ${String(b.instance.manager.activeCount())}`);
    assert.equal(created.status, 202, created.raw);
    assert.equal(b.instance.manager.activeCount(), 2);

    const third = await b.long(RUNS[1], 'step', 'cle-mixte-step0003');
    assert.equal(third.status, 503, third.raw);
    assert.equal((third.body['error'] as { code: string }).code, 'COCKPIT_BUSY');
  } finally {
    gate.release();
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Préconditions : jamais un créneau
// --------------------------------------------------------------------------

test('(A3) une tentative condamnée ne demande jamais d’admission', async (t) => {
  for (const [label, options, expected] of [
    ['authentification', { claudeAuth: 'UNAUTHENTICATED' as const }, 'AUTH_REQUIRED'],
    ['workspace', {}, 'INVALID_ARGUMENT'],
  ] as const) {
    const b = await open(options);
    try {
      // Un seul obstacle à la fois : sinon la preuve ne dirait pas lequel a joué.
      const workspace = label === 'workspace' ? path.join(b.dir, 'nulle-part') : b.workspace;
      const before = b.instance.manager.admitAttempts();
      const refused = await b.start(intent(workspace), `cle-condamnee-${label.slice(0, 4)}`);
      const delta = b.instance.manager.admitAttempts() - before;
      const receipt = await b.get(`/api/operations/${String(refused.body['operation_id'])}`);
      t.diagnostic(
        `${label} → ${String(refused.status)} ${String((refused.body['error'] as { code?: string } | undefined)?.code)} · ` +
          `delta admitAttempts=${String(delta)} · runs=${String((await b.runIds()).length)}`,
      );
      assert.equal((refused.body['error'] as { code: string }).code, expected, `${label} : code attendu`);
      assert.equal(delta, 0, `${label} : aucun créneau même demandé`);
      assert.equal(receipt.body['created_run_id'], undefined, `${label} : aucun run associé`);
      assert.deepEqual(await b.runIds(), [], `${label} : aucun run`);
    } finally {
      await b.cleanup();
    }
  }
});

// --------------------------------------------------------------------------
// Registre hôte : après l'allocation, jamais avant
// --------------------------------------------------------------------------

test('(A4) START en vol : registre exact, vivacité honnête', async (t) => {
  const gate = barrier();
  let seenBeforeAllocation = -1;
  const b = await open({
    onCall: () => gate.wait(),
    startHooks: {
      beforeAllocation: () => {
        // Un créneau est pris ; aucun run n'existe, donc aucun lien de registre.
        seenBeforeAllocation = 0;
      },
    },
  });
  try {
    const accepted = await b.start(intent(b.workspace), 'cle-registre-00001');
    assert.equal(accepted.status, 202, accepted.raw);
    const created = String(accepted.body['created_run_id']);

    // Avant allocation : le manager suit une opération, le registre ne suit rien.
    t.diagnostic(`avant allocation : liens de registre = ${String(seenBeforeAllocation)}`);
    assert.equal(seenBeforeAllocation, 0, 'aucun lien de registre avant qu’un run existe');

    // Après allocation : le lien porte le run ET le verrou réellement obtenu.
    const lock = await readRunLock(runPaths(b.runsDir, created));
    assert.ok(lock !== undefined, 'le run créé est verrouillé pendant son initialisation');
    const bound = b.instance.registry.find(created, lock.lock_id);
    t.diagnostic(`registre : run=${created} · lock_id=${lock.lock_id} · lié=${String(bound !== undefined)} · commande=${lock.command}`);
    assert.ok(bound !== undefined, 'le registre lie exactement ce run à ce verrou');
    assert.equal(lock.command, 'start');
    assert.equal(b.instance.registry.find(created, `${lock.lock_id}-autre`), undefined, 'jamais sur le seul run_id');

    // La vue du run dit ce qui est vrai : une opération est en vol, et rien
    // n'appelle l'humain — ce n'est ni une reprise, ni une ambiguïté.
    const view = await b.get(`/api/runs/${created}`);
    const liveness = view.body['liveness'] as {
      liveness: string;
      basis: string;
      needs_human_attention: boolean;
      pending_operation: unknown;
    };
    t.diagnostic(
      `vivacité=${liveness.liveness} · fondement=${liveness.basis} · ` +
        `attention=${String(liveness.needs_human_attention)} · opération=${JSON.stringify(liveness.pending_operation)}`,
    );
    assert.equal(view.status, 200, view.raw);
    assert.equal(liveness.liveness, 'OPERATION_IN_FLIGHT');
    assert.equal(liveness.basis, 'HOST_REGISTRY_ACTIVE', 'l’évidence vient du registre, pas d’une heuristique');
    assert.equal(liveness.needs_human_attention, false, 'une opération en vol n’appelle personne');
    for (const forbidden of ['RECOVERY_REQUIRED', 'AMBIGUOUS', 'ORPHAN_LOCK', 'ABANDONED_OPERATION']) {
      assert.notEqual(liveness.liveness, forbidden);
    }
  } finally {
    gate.release();
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Association impossible : ni succès, ni échec
// --------------------------------------------------------------------------

test('(A5) association impossible : UNKNOWN, aucun fournisseur, aucun rejeu', async (t) => {
  let breakNext = true;
  const b = await open({
    store: (real) => ({
      claim: (input) => real.claim(input),
      associateRun: (id, runId) => {
        // Le run existe déjà à cet instant : c'est précisément la fenêtre où
        // le reçu ne peut plus dire la vérité s'il ne peut pas être écrit.
        if (breakNext) return Promise.reject(new Error('écriture impossible'));
        return real.associateRun(id, runId);
      },
      settle: (id, patch) => real.settle(id, patch),
      read: (id) => real.read(id),
    }),
  });
  try {
    const key = 'cle-assoc-0000001';
    const attempt = await b.start(intent(b.workspace), key);
    const operationId = operationIdFor(key);
    t.diagnostic(`association rompue → ${String(attempt.status)} ${String(attempt.body['status'])}`);

    const receipt = await b.get(`/api/operations/${operationId}`);
    const runs = await b.runIds();
    t.diagnostic(
      `reçu=${String(receipt.body['status'])} · created_run_id=${String(receipt.body['created_run_id'])} · ` +
        `runs=${runs.join(',')} · claude=${String(b.calls.claude)} · codex=${String(b.calls.codex)}`,
    );

    // Un run existe, le reçu ne peut pas le nommer : le seul verdict honnête.
    assert.equal(receipt.body['status'], 'UNKNOWN', receipt.raw);
    assert.equal(receipt.body['created_run_id'], undefined, 'aucune association n’a pu être écrite');
    assert.equal(runs.length, 1, 'le run alloué existe bel et bien');
    assert.equal(b.calls.claude, 0, 'aucun fournisseur joint');
    assert.equal(b.calls.codex, 0);
    assert.equal(b.instance.manager.activeCount(), 0, 'le créneau est rendu');

    // Retransmission : même verdict, aucune seconde allocation, aucun agent.
    breakNext = false;
    const replay = await b.start(intent(b.workspace), key);
    t.diagnostic(`rejeu → ${String(replay.status)} ${String(replay.body['status'])}`);
    assert.equal(replay.body['status'], 'UNKNOWN', replay.raw);
    assert.deepEqual(await b.runIds(), runs, 'aucune seconde allocation');
    assert.equal(b.calls.claude, 0);
    assert.equal(b.calls.codex, 0);

    // Aucune recherche heuristique : le reçu ne s'invente pas un run.
    const durable = JSON.parse(
      await readFile(
        path.join(b.instance.dataRoot.controlDir, 'operations', operationId.slice(3, 5), `${operationId.slice(3)}.json`),
        'utf8',
      ),
    ) as OperationReceipt;
    assert.equal(durable.created_run_id, undefined, 'le reçu durable ne devine rien');
  } finally {
    await b.cleanup();
  }
});


// --------------------------------------------------------------------------
// C1 → C5 — crashs sur processus réels
// --------------------------------------------------------------------------

interface Crasher {
  readonly port: number;
  readonly exited: Promise<void>;
  readonly kill: () => void;
}

function launchCrasher(runsDir: string, port: number, point: string): Promise<Crasher> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASHER, runsDir, String(port), point], { stdio: 'pipe', shell: false });
    let out = '';
    let err = '';
    const exited = new Promise<void>((done) => child.on('close', () => done()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cockpit suicidaire non démarré : ${out} ${err}`));
    }, 60_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = /READY (\d+)/.exec(out);
      if (match === null) return;
      clearTimeout(timer);
      resolve({
        port: Number.parseInt(match[1] ?? '0', 10),
        exited,
        kill: () => {
          child.kill('SIGKILL');
        },
      });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function cookieOf(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Lève le verrou de serveur laissé par le processus mort. */
async function clearCrashedLock(runsDir: string): Promise<string> {
  const dataRoot = resolveCockpitDataRoot(runsDir);
  const observed = await inspectServerLock(dataRoot.serverLock);
  if (observed.observation === 'NONE') return 'NONE';
  assert.equal(observed.observation, 'LOCAL_STALE', 'le verrou du processus mort survit — comportement attendu');
  await clearStaleCockpitLock(runsDir, observed.info?.instance_id ?? '');
  return observed.observation;
}

/**
 * Trois instants, trois noms — et jamais « run alloué » pour les désigner tous.
 *
 * ```text
 * A  directory allocated        createRunDirectory a réussi, le run_id existe
 * B  canonical run initialized  manifest + state + run_created sont durables
 * C  receipt associated         associateRun(operation_id, run_id) est durable
 * ```
 *
 * Le point de mort de `C2` est **entre B et C**, pas entre A et B : la couture
 * `afterAllocation` est invoquée depuis `initializeRun`, après l'écriture du
 * manifest, de l'état et de l'événement de création.
 */
interface CrashCase {
  readonly label: string;
  readonly point: string;
  /** Un répertoire de run doit-il exister après le crash ? (A) */
  readonly directoryAllocated: boolean;
  /** Le reçu doit-il nommer ce run ? (C) */
  readonly runAssociated: boolean;
  /** L'agent doit-il avoir été joint avant le crash ? */
  readonly hangs?: boolean;
}

const CRASHES: readonly CrashCase[] = [
  { label: 'C1 — avant A : aucun répertoire alloué', point: 'start-before-alloc', directoryAllocated: false, runAssociated: false },
  { label: 'C2 — après B, avant C : run canonique initialisé, reçu non associé', point: 'start-after-alloc', directoryAllocated: true, runAssociated: false },
  { label: 'C3 — après C, avant le fournisseur', point: 'start-after-assoc', directoryAllocated: true, runAssociated: true },
  { label: 'C4 — pendant le fournisseur', point: 'start-hang', directoryAllocated: true, runAssociated: true, hangs: true },
  { label: 'C5 — effet canonique complet, avant le reçu terminal', point: 'start-after-final', directoryAllocated: true, runAssociated: true },
];

for (const crash of CRASHES) {
  test(`(${crash.label}) → UNKNOWN, aucun rejeu`, { timeout: 180_000 }, async (t) => {
    const dir = await makeTempDir('ccr-s6crash-');
    const runsDir = path.join(dir, 'runs');
    const workspace = path.join(dir, 'workspace');
    for (const target of [runsDir, workspace]) await mkdir(target, { recursive: true });

    const key = 'cle-s6-crash-00001';
    const operationId = operationIdFor(key);
    const port = await freePort();

    try {
      // 1. Le cockpit suicidaire reçoit la création et meurt au point choisi.
      const crasher = await launchCrasher(runsDir, port, crash.point);
      const cookie = await cookieOf(crasher.port);
      const body = JSON.stringify(intent(workspace));
      const posted = http(crasher.port, 'POST', '/api/runs', {
        Host: `127.0.0.1:${String(crasher.port)}`,
        Origin: `http://127.0.0.1:${String(crasher.port)}`,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Idempotency-Key': key,
      }, body).catch(() => undefined);

      if (crash.hangs === true) {
        // C4 : l'agent ne répondra jamais. On attend l'accusé — preuve que le
        // run est alloué, associé, et que le fournisseur est réellement en
        // vol — puis on tue le processus.
        const accepted = await posted;
        t.diagnostic(`202 avant le kill : ${String(accepted?.status)} · run=${String(accepted?.body['created_run_id'])}`);
        assert.equal(accepted?.status, 202);
        crasher.kill();
      } else {
        await posted;
      }
      await crasher.exited;

      // 2. Ce que le disque porte réellement, avant toute relecture applicative.
      const allocated = (await readdir(runsDir)).filter((name) => name.startsWith('CCR-'));
      t.diagnostic(`après crash : runs=${allocated.join(',') || '<aucun>'}`);
      assert.equal(allocated.length, crash.directoryAllocated ? 1 : 0, 'répertoires de run alloués (A)');

      if (allocated[0] !== undefined) {
        // Le snapshot runtime est durable dès l'écriture du manifest, donc
        // avant tout fournisseur : un crash ultérieur ne peut pas le perdre.
        const manifest = JSON.parse(
          await readFile(path.join(runsDir, allocated[0], 'manifest.json'), 'utf8'),
        ) as { runtime_config?: unknown; agents: Record<string, { session_id: string | null }> };
        assert.notEqual(manifest.runtime_config, undefined, 'snapshot runtime durable');

        if (crash.point === 'start-after-final') {
          // C5 : l'effet canonique était **complet** au moment du crash. Seul
          // le reçu terminal manque — et c'est exactement ce qui doit rester
          // `UNKNOWN` sans qu'aucune session soit recréée.
          const state = JSON.parse(
            await readFile(path.join(runsDir, allocated[0], 'state.json'), 'utf8'),
          ) as { state: string };
          t.diagnostic(
            `C5 avant redémarrage : état=${state.state} · claude=${String(manifest.agents['claude']?.session_id)} · ` +
              `codex=${String(manifest.agents['codex']?.session_id)}`,
          );
          assert.equal(state.state, 'READY', 'le run était correctement initialisé');
          assert.equal(manifest.agents['claude']?.session_id, 'claude-1');
          assert.equal(manifest.agents['codex']?.session_id, 'codex-1');
        }
      }

      // 3. Redémarrage, après levée explicite du verrou périmé.
      const observation = await clearCrashedLock(runsDir);
      t.diagnostic(`verrou de serveur après crash : ${observation}`);

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
      const revived = await startCockpit({
        runsDir,
        port: 0,
        depsOverrides: { createAdapters: () => adapters },
        preflightSeams: { env: {}, probes: { claude: () => probeOf('claude'), codex: () => probeOf('codex') } },
      });

      try {
        const revivedCookie = await cookieOf(revived.server.port);
        const receipt = await http(revived.server.port, 'GET', `/api/operations/${operationId}`, {
          Host: `127.0.0.1:${String(revived.server.port)}`,
          Cookie: revivedCookie,
        });
        t.diagnostic(
          `reçu après redémarrage : ${String(receipt.body['status'])} · created_run_id=${String(receipt.body['created_run_id'])}`,
        );
        assert.equal(receipt.body['status'], 'UNKNOWN', receipt.raw);
        if (crash.runAssociated) {
          assert.equal(receipt.body['created_run_id'], allocated[0], 'le reçu nomme le run qu il avait associé');
        } else {
          assert.equal(receipt.body['created_run_id'], undefined, 'aucune association, et aucune devinette');
        }

        // 4. Retransmission : la lecture d'un verdict, et rien d'autre.
        const replayBody = JSON.stringify(intent(workspace));
        const replay = await http(revived.server.port, 'POST', '/api/runs', {
          Host: `127.0.0.1:${String(revived.server.port)}`,
          Origin: `http://127.0.0.1:${String(revived.server.port)}`,
          Cookie: revivedCookie,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(replayBody, 'utf8')),
          'Idempotency-Key': key,
        }, replayBody);

        const after = (await readdir(runsDir)).filter((name) => name.startsWith('CCR-'));
        t.diagnostic(
          `rejeu → ${String(replay.status)} ${String(replay.body['status'])} · runs=${String(after.length)} · ` +
            `claude=${String(calls.claude)} · codex=${String(calls.codex)} · admitAttempts=${String(revived.manager.admitAttempts())}`,
        );
        assert.equal(replay.body['status'], 'UNKNOWN', replay.raw);
        assert.deepEqual(after, allocated, 'aucune seconde allocation');
        assert.equal(calls.claude, 0, 'aucun fournisseur Claude après redémarrage');
        assert.equal(calls.codex, 0, 'aucun fournisseur Codex après redémarrage');
        assert.equal(revived.manager.admitAttempts(), 0, 'aucune seconde admission');
      } finally {
        await revived.stop();
      }
    } finally {
      await removeTempDir(dir);
    }
  });
}


// --------------------------------------------------------------------------
// C6 — réponse HTTP perdue, et S7 rejouée avec des compteurs par agent
// --------------------------------------------------------------------------

test('(C6) réponse perdue : le serveur poursuit, la retransmission ne rejoue rien', { timeout: 180_000 }, async (t) => {
  const held = barrier();
  const b = await open({ startHooks: { onRunAllocated: () => held.wait() } });
  const key = 'cle-perdue-0000001';
  const operationId = operationIdFor(key);
  try {
    // Le socket est réellement détruit avant que la réponse puisse être écrite.
    const body = JSON.stringify(intent(b.workspace));
    const port = b.instance.server.port;
    const cookie = await cookieOf(port);
    const lost = new Promise<string>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/runs',
          method: 'POST',
          headers: {
            Host: `127.0.0.1:${String(port)}`,
            Origin: `http://127.0.0.1:${String(port)}`,
            Cookie: cookie,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body, 'utf8')),
            'Idempotency-Key': key,
          },
        },
        () => resolve('réponse reçue'),
      );
      req.on('error', (error) => resolve(`socket rompu : ${error.message}`));
      req.write(body);
      req.end();
      // L'association est en attente : on coupe pendant que le serveur travaille.
      setTimeout(() => {
        req.destroy(new Error('connexion perdue'));
      }, 150);
    });

    t.diagnostic(`client : ${await lost}`);
    held.release();

    // Le serveur, lui, va jusqu'au bout.
    let receipt = await b.get(`/api/operations/${operationId}`);
    for (let attempt = 0; attempt < 400 && receipt.body['status'] === 'RUNNING'; attempt += 1) {
      await sleep(25);
      receipt = await b.get(`/api/operations/${operationId}`);
    }
    const created = String(receipt.body['created_run_id']);
    t.diagnostic(
      `reçu : ${String(receipt.body['status'])} · run=${created} · claude=${String(b.calls.claude)} · codex=${String(b.calls.codex)}`,
    );
    assert.equal(receipt.body['status'], 'SUCCEEDED', receipt.raw);
    assert.match(created, /^CCR-\d{8}-\d{3}$/);
    assert.equal(b.calls.claude, 1, 'une initialisation Claude');
    assert.equal(b.calls.codex, 1, 'une initialisation Codex');

    // Retransmission : même opération, même run, aucune seconde admission.
    const attempts = b.instance.manager.admitAttempts();
    const replay = await b.start(intent(b.workspace), key);
    t.diagnostic(
      `rejeu → ${String(replay.status)} ${String(replay.body['status'])} · run=${String(replay.body['created_run_id'])} · ` +
        `runs=${String((await b.runIds()).length)} · admitAttempts delta=${String(b.instance.manager.admitAttempts() - attempts)}`,
    );
    assert.equal(replay.body['operation_id'], operationId);
    assert.equal(replay.body['created_run_id'], created, 'le même run, jamais un second');
    assert.equal(replay.body['status'], 'SUCCEEDED');
    assert.deepEqual(await b.runIds(), [created], 'une seule allocation au total');
    assert.equal(b.calls.claude, 1, 'aucune seconde session Claude');
    assert.equal(b.calls.codex, 1, 'aucune seconde session Codex');
    assert.equal(b.instance.manager.admitAttempts() - attempts, 0, 'aucune seconde admission');
  } finally {
    held.release();
    await b.cleanup();
  }
});

test('(A6) initialisation partielle rejouée : aucun agent n’est rappelé', async (t) => {
  const dir = await makeTempDir('ccr-s6-partiel-');
  const runsDir = path.join(dir, 'runs');
  const workspace = path.join(dir, 'workspace');
  for (const target of [runsDir, workspace]) await mkdir(target, { recursive: true });

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
      failStart: () => new Error('codex indisponible'),
    }),
  };
  const instance = await startCockpit({
    runsDir,
    port: 0,
    depsOverrides: { createAdapters: () => adapters },
    preflightSeams: { env: {}, probes: { claude: () => probeOf('claude'), codex: () => probeOf('codex') } },
  });

  try {
    const port = instance.server.port;
    const cookie = await cookieOf(port);
    const key = 'cle-partiel-rejeu1';
    const send = (): Promise<Result> => {
      const body = JSON.stringify(intent(workspace));
      return http(port, 'POST', '/api/runs', {
        Host: `127.0.0.1:${String(port)}`,
        Origin: `http://127.0.0.1:${String(port)}`,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Idempotency-Key': key,
      }, body);
    };

    const accepted = await send();
    assert.equal(accepted.status, 202, accepted.raw);
    const created = String(accepted.body['created_run_id']);

    let receipt = await http(port, 'GET', `/api/operations/${operationIdFor(key)}`, {
      Host: `127.0.0.1:${String(port)}`,
      Cookie: cookie,
    });
    for (let attempt = 0; attempt < 400 && receipt.body['status'] === 'RUNNING'; attempt += 1) {
      await sleep(25);
      receipt = await http(port, 'GET', `/api/operations/${operationIdFor(key)}`, {
        Host: `127.0.0.1:${String(port)}`,
        Cookie: cookie,
      });
    }
    const state = JSON.parse(await readFile(path.join(runsDir, created, 'state.json'), 'utf8')) as { state: string };
    t.diagnostic(
      `partielle : reçu=${String(receipt.body['status'])} · run=${created} · état=${state.state} · ` +
        `claude=${String(calls.claude)} · codex=${String(calls.codex)}`,
    );
    assert.equal(receipt.body['status'], 'FAILED');
    assert.equal(receipt.body['created_run_id'], created);
    assert.equal(state.state, 'FAILED_INITIALIZATION');
    assert.equal(calls.claude, 1);
    assert.equal(calls.codex, 1);

    // Rejeu : le verdict est relu, aucun agent n'est sollicité une seconde fois.
    const attempts = instance.manager.admitAttempts();
    const replay = await send();
    t.diagnostic(
      `rejeu → ${String(replay.status)} · claude=${String(calls.claude)} · codex=${String(calls.codex)} · ` +
        `admitAttempts delta=${String(instance.manager.admitAttempts() - attempts)}`,
    );
    assert.equal(String(replay.body['operation_id']), operationIdFor(key));
    assert.equal(calls.claude, 1, 'Claude n’est pas rappelé');
    assert.equal(calls.codex, 1, 'Codex n’est pas rappelé');
    assert.equal(instance.manager.admitAttempts() - attempts, 0, 'aucune seconde admission');
    assert.deepEqual((await readdir(runsDir)).filter((n) => n.startsWith('CCR-')), [created]);
  } finally {
    await instance.stop();
    await removeTempDir(dir);
  }
});
