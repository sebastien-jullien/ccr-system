/**
 * IT-6 — `POST /api/runs` : création idempotente d'un run.
 *
 * Une opération longue de plus, à une différence près qui gouverne tout : **le
 * run n'existe pas encore**. Il n'y a donc ni `expected_revision` — aucune vue
 * ne peut être périmée — ni `run_id` au moment du claim. Ce qui doit être
 * prouvé ici est un ordre :
 *
 * ```text
 * claim → preflight → admission → allocation → created_run_id → fournisseur
 * ```
 *
 * Chaque flèche est une garantie séparée, et chacune a son test.
 *
 * Aucun fournisseur réel : les probes de preflight et les adapters sont des
 * doublures contrôlées. Ce qui est réel : le serveur, les sockets, le run lock,
 * le store d'idempotence et les fichiers canoniques.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { OPERATIONS_DIR_NAME } from '../../src/cockpit/operations-store.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { StartMutationHooks } from '../../src/services/start-mutation.ts';

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

function probe(agent: 'claude' | 'codex', authStatus: AgentRuntimeProbe['authStatus'], installed = true): AgentRuntimeProbe {
  return { agent, installed, version: installed ? '1.0.0' : null, authStatus, launcherSource: 'explicit' };
}

/** Barrière contrôlée : les agents attendent que le test les libère. */
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

interface OpenOptions {
  readonly claudeAuth?: AgentRuntimeProbe['authStatus'];
  readonly codexAuth?: AgentRuntimeProbe['authStatus'];
  readonly claudeInstalled?: boolean;
  readonly onCall?: () => Promise<void>;
  readonly failClaude?: () => unknown;
  readonly failCodex?: () => unknown;
  readonly startHooks?: StartMutationHooks;
}

interface Box {
  readonly instance: CockpitInstance;
  readonly runsDir: string;
  readonly workspace: string;
  readonly dir: string;
  post(payload: unknown, key: string, raw?: string): Promise<Result>;
  get(target: string): Promise<Result>;
  runIds(): Promise<string[]>;
  providerCalls(): number;
  cleanup(): Promise<void>;
}

async function open(options: OpenOptions = {}): Promise<Box> {
  const dir = await makeTempDir('ccr-start-');
  const runsDir = path.join(dir, 'runs');
  const workspace = path.join(dir, 'workspace');
  for (const target of [runsDir, workspace]) await mkdir(target, { recursive: true });

  let calls = 0;
  const record = async (): Promise<void> => {
    calls += 1;
    await options.onCall?.();
  };
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({
      kind: 'claude',
      sessionId: 'claude-1',
      onCall: record,
      ...(options.failClaude === undefined ? {} : { failStart: options.failClaude }),
    }),
    codex: createFakeAdapter({
      kind: 'codex',
      sessionId: 'codex-1',
      onCall: record,
      ...(options.failCodex === undefined ? {} : { failStart: options.failCodex }),
    }),
  };

  const instance = await startCockpit({
    runsDir,
    port: 0,
    depsOverrides: { createAdapters: () => adapters },
    preflightSeams: {
      configPath: path.join(dir, 'absente.json'),
      env: {},
      probes: {
        claude: () => Promise.resolve(probe('claude', options.claudeAuth ?? 'AUTHENTICATED', options.claudeInstalled ?? true)),
        codex: () => Promise.resolve(probe('codex', options.codexAuth ?? 'AUTHENTICATED')),
      },
    },
    ...(options.startHooks === undefined ? {} : { startHooks: options.startHooks }),
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
    workspace,
    dir,
    post(payload, key, raw) {
      const body = raw ?? JSON.stringify(payload);
      return send(port, 'POST', '/api/runs', {
        Host: `127.0.0.1:${String(port)}`,
        Origin: `http://127.0.0.1:${String(port)}`,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Idempotency-Key': key,
      }, body);
    },
    get: (target) => send(port, 'GET', target, { Host: `127.0.0.1:${String(port)}`, Cookie: cookie }),
    runIds: async () => (await readdir(runsDir)).filter((name) => name.startsWith('CCR-')),
    providerCalls: () => calls,
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

/** Attend la terminalisation d'un reçu — geste explicite, jamais automatique. */
async function settle(b: Box, operationId: string): Promise<Result> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const receipt = await b.get(`/api/operations/${operationId}`);
    if (receipt.body['status'] !== 'RUNNING') return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('le reçu n’a jamais quitté RUNNING');
}

// --------------------------------------------------------------------------
// Ordre : allocation, association, puis fournisseur
// --------------------------------------------------------------------------

test('(S1) START : 202 après allocation et association, avant tout fournisseur', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const accepted = await b.post(intent(b.workspace), 'cle-start-000001');
    t.diagnostic(`202 → ${JSON.stringify(accepted.body)} · fournisseurs appelés = ${String(b.providerCalls())}`);

    assert.equal(accepted.status, 202, accepted.raw);
    assert.equal(accepted.body['action'], 'START');
    assert.equal(accepted.body['status'], 'RUNNING');
    const created = String(accepted.body['created_run_id']);
    assert.match(created, /^CCR-\d{8}-\d{3}$/, 'le run créé est nommé dans l’accusé');
    assert.equal(accepted.body['run_id'], undefined, 'aucun run visé : il est créé, pas ciblé');

    // Gate absolu : le reçu porte le run AVANT que le moindre agent soit joint.
    assert.equal(b.providerCalls(), 0, 'aucun fournisseur avant l’association durable');
    const receipt = await b.get(`/api/operations/${String(accepted.body['operation_id'])}`);
    assert.equal(receipt.body['created_run_id'], created, 'l’association est durable, pas seulement rendue');
    assert.deepEqual(await b.runIds(), [created], 'exactement un run alloué');

    // Le run est déjà inspectable, et porte son snapshot.
    const manifest = JSON.parse(
      await readFile(path.join(b.runsDir, created, 'manifest.json'), 'utf8'),
    ) as { runtime_config?: unknown; workspace: { cwd: string }; title: string };
    assert.notEqual(manifest.runtime_config, undefined, 'aucun run moderne sans snapshot runtime');
    assert.equal(manifest.title, 'Revue croisée');
    t.diagnostic(`workspace : entrée=${b.workspace} · canonique=${manifest.workspace.cwd}`);

    gate.release();
    const terminal = await settle(b, String(accepted.body['operation_id']));
    t.diagnostic(`terminal → ${String(terminal.body['status'])} · fournisseurs = ${String(b.providerCalls())}`);
    assert.equal(terminal.body['status'], 'SUCCEEDED');
    assert.equal(terminal.body['created_run_id'], created);
    assert.equal(b.providerCalls(), 2, 'les deux sessions natives ont été initialisées');

    // La vérité finale vient du read model, jamais du reçu.
    const view = await b.get(`/api/runs/${created}`);
    assert.equal(view.status, 200, view.raw);
    assert.equal((view.body['identity'] as { run_id: string }).run_id, created);
  } finally {
    gate.release();
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Preflight : aucun run, aucun créneau
// --------------------------------------------------------------------------

test('(S2) Claude non authentifié : AUTH_REQUIRED, aucun run, aucun créneau', async (t) => {
  const b = await open({ claudeAuth: 'UNAUTHENTICATED' });
  try {
    const attempts = b.instance.manager.admitAttempts();
    const refused = await b.post(intent(b.workspace), 'cle-auth-0000001');
    t.diagnostic(`auth bloquante → ${String(refused.status)} ${String((refused.body['error'] as { code?: string } | undefined)?.code)}`);

    assert.equal(refused.status, 422, refused.raw);
    assert.equal((refused.body['error'] as { code: string }).code, 'AUTH_REQUIRED');
    assert.deepEqual(await b.runIds(), [], 'aucun répertoire de run');
    assert.equal(b.providerCalls(), 0, 'aucune session native');
    assert.equal(b.instance.manager.admitAttempts() - attempts, 0, 'aucun créneau même demandé');

    // Le reçu terminal existe, et ne nomme aucun run.
    const operationId = String(refused.body['operation_id']);
    const receipt = await b.get(`/api/operations/${operationId}`);
    assert.equal(receipt.body['status'], 'FAILED', receipt.raw);
    assert.equal(receipt.body['error_code'], 'AUTH_REQUIRED');
    assert.equal(receipt.body['created_run_id'], undefined, 'aucun run associé');

    // Retransmission de la même tentative : même verdict, toujours aucun run.
    const replay = await b.post(intent(b.workspace), 'cle-auth-0000001');
    assert.equal(replay.status, 422, replay.raw);
    assert.equal((replay.body['error'] as { code: string }).code, 'AUTH_REQUIRED');
    assert.deepEqual(await b.runIds(), []);
  } finally {
    await b.cleanup();
  }
});

test('(S3) workspace invalide : reçu FAILED, aucun run, aucun créneau', async (t) => {
  const b = await open();
  try {
    const attempts = b.instance.manager.admitAttempts();
    const absent = path.join(b.dir, 'workspace-qui-n-existe-pas');
    const refused = await b.post(intent(absent), 'cle-workspace-0001');
    t.diagnostic(`workspace absent → ${String(refused.body['status'])} ${String(refused.body['error_code'])}`);

    assert.equal(refused.status, 400, refused.raw);
    assert.equal((refused.body['error'] as { code: string }).code, 'INVALID_ARGUMENT');
    assert.deepEqual(await b.runIds(), []);
    assert.equal(b.instance.manager.admitAttempts() - attempts, 0, 'aucun créneau pour une intention condamnée');

    const receipt = await b.get(`/api/operations/${String(refused.body['operation_id'])}`);
    assert.equal(receipt.body['status'], 'FAILED', receipt.raw);
    assert.equal(receipt.body['created_run_id'], undefined);

    // Un chemin relatif n'est pas davantage un workspace : l'autorité est ici,
    // jamais dans le répertoire courant du serveur.
    const relative = await b.post(intent('workspace'), 'cle-workspace-0002');
    assert.equal(relative.status, 400, relative.raw);
    assert.equal((relative.body['error'] as { code: string }).code, 'INVALID_ARGUMENT');
    assert.deepEqual(await b.runIds(), []);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Idempotence
// --------------------------------------------------------------------------

test('(S4) même clé : un seul run, quel que soit l’ordre des propriétés', async (t) => {
  const b = await open();
  try {
    const first = await b.post(intent(b.workspace), 'cle-idem-0000001');
    assert.equal(first.status, 202, first.raw);
    const created = String(first.body['created_run_id']);
    await settle(b, String(first.body['operation_id']));
    const calls = b.providerCalls();

    // Mêmes champs, ordre différent : même intention, donc même empreinte.
    const reordered = JSON.stringify({
      prompt: 'Contexte initial du run.',
      workspace_cwd: b.workspace,
      title: 'Revue croisée',
    });
    const replay = await b.post(undefined, 'cle-idem-0000001', reordered);
    t.diagnostic(`rejeu → ${String(replay.status)} ${String(replay.body['status'])} · run=${String(replay.body['created_run_id'])}`);

    assert.equal(replay.body['operation_id'], first.body['operation_id']);
    assert.equal(replay.body['created_run_id'], created);
    assert.equal(b.providerCalls(), calls, 'aucun second fournisseur');
    assert.deepEqual(await b.runIds(), [created], 'un seul run sur disque');

    // Une autre intention sous la même clé est refusée, sans effet.
    for (const [label, payload] of [
      ['titre', intent(b.workspace, { title: 'Autre titre' })],
      ['workspace', intent(b.dir)],
      ['contexte', intent(b.workspace, { prompt: 'Autre contexte.' })],
    ] as const) {
      const conflict = await b.post(payload, 'cle-idem-0000001');
      t.diagnostic(`${label} différent → ${String(conflict.status)} ${String((conflict.body['error'] as { code?: string } | undefined)?.code)}`);
      assert.equal(conflict.status, 409, conflict.raw);
      assert.equal((conflict.body['error'] as { code: string }).code, 'IDEMPOTENCY_KEY_REUSED');
    }
    assert.deepEqual(await b.runIds(), [created], 'toujours un seul run');
  } finally {
    await b.cleanup();
  }
});

test('(S5) requêtes concurrentes portant la même clé : exactement une allocation', async (t) => {
  const b = await open();
  try {
    const results = await Promise.all([
      b.post(intent(b.workspace), 'cle-course-000001'),
      b.post(intent(b.workspace), 'cle-course-000001'),
      b.post(intent(b.workspace), 'cle-course-000001'),
    ]);
    const codes = results.map((r) => r.status);
    t.diagnostic(`trois requêtes simultanées → ${codes.join(', ')}`);
    for (const result of results) assert.ok(result.status === 202 || result.status === 200, result.raw);

    for (const result of results) assert.equal(result.body['error'], undefined, result.raw);
    const operationIds = new Set(results.map((r) => String(r.body['operation_id'])));
    assert.equal(operationIds.size, 1, 'une seule opération');
    // Un identifiant réel : trois erreurs partageraient elles aussi « undefined ».
    assert.match([...operationIds][0] ?? '', /^op_[0-9a-f]{64}$/);
    await settle(b, [...operationIds][0] ?? '');
    assert.equal((await b.runIds()).length, 1, 'exactement un run alloué');
    assert.equal(b.providerCalls(), 2, 'exactement une initialisation');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Quota : START pèse comme STEP et SEND
// --------------------------------------------------------------------------

test('(S6) START partage le quota long : deux en vol, la troisième refusée', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const first = await b.post(intent(b.workspace), 'cle-quota-0000001');
    assert.equal(first.status, 202, first.raw);
    assert.equal(b.instance.manager.activeCount(), 1);

    const second = await b.post(intent(b.workspace, { title: 'Second run' }), 'cle-quota-0000002');
    assert.equal(second.status, 202, second.raw);
    assert.equal(b.instance.manager.activeCount(), 2, 'deux START occupent les deux créneaux');

    const third = await b.post(intent(b.workspace, { title: 'Troisième run' }), 'cle-quota-0000003');
    t.diagnostic(`troisième START → ${String(third.status)} ${String(third.body['error_code'])}`);
    assert.equal(third.status, 503, third.raw);
    assert.equal((third.body['error'] as { code: string }).code, 'COCKPIT_BUSY');
    const busyReceipt = await b.get(`/api/operations/${String(third.body['operation_id'])}`);
    assert.equal(busyReceipt.body['status'], 'FAILED', busyReceipt.raw);
    assert.equal(busyReceipt.body['created_run_id'], undefined, 'un refus de quota ne crée aucun run');
    assert.equal((await b.runIds()).length, 2, 'deux runs seulement');

    // Même clé après libération : même verdict, jamais une nouvelle tentative.
    gate.release();
    await settle(b, String(first.body['operation_id']));
    await settle(b, String(second.body['operation_id']));
    const replay = await b.post(intent(b.workspace, { title: 'Troisième run' }), 'cle-quota-0000003');
    assert.equal(replay.status, 503, replay.raw);
    assert.equal((replay.body['error'] as { code: string }).code, 'COCKPIT_BUSY');
    assert.equal((await b.runIds()).length, 2, 'toujours deux runs');
  } finally {
    gate.release();
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Initialisation partielle
// --------------------------------------------------------------------------

test('(S7) initialisation partielle : le run est conservé, la session obtenue aussi', async (t) => {
  const b = await open({ failCodex: () => new Error('codex indisponible') });
  try {
    const accepted = await b.post(intent(b.workspace), 'cle-partiel-00001');
    assert.equal(accepted.status, 202, accepted.raw);
    const created = String(accepted.body['created_run_id']);

    const terminal = await settle(b, String(accepted.body['operation_id']));
    t.diagnostic(`initialisation partielle → ${String(terminal.body['status'])} ${String(terminal.body['error_code'])}`);
    assert.equal(terminal.body['status'], 'FAILED');
    assert.equal(terminal.body['created_run_id'], created, 'le run créé reste nommé');

    // Aucun nettoyage destructif : le run existe, inspectable.
    assert.deepEqual(await b.runIds(), [created]);
    const state = JSON.parse(await readFile(path.join(b.runsDir, created, 'state.json'), 'utf8')) as { state: string };
    const manifest = JSON.parse(
      await readFile(path.join(b.runsDir, created, 'manifest.json'), 'utf8'),
    ) as { agents: { claude: { session_id: string | null }; codex: { session_id: string | null } } };
    t.diagnostic(`état=${state.state} · claude=${String(manifest.agents.claude.session_id)} · codex=${String(manifest.agents.codex.session_id)}`);
    assert.equal(state.state, 'FAILED_INITIALIZATION');
    assert.equal(manifest.agents.claude.session_id, 'claude-1', 'la session réussie est conservée');
    assert.equal(manifest.agents.codex.session_id, null);

    // Retransmission : aucune seconde session, aucun second run. Un verdict
    // d'échec revient sous forme d'enveloppe publique — c'est le contrat gelé
    // du Slice 4 — et le run créé se lit sur le reçu, jamais deviné.
    const calls = b.providerCalls();
    const replay = await b.post(intent(b.workspace), 'cle-partiel-00001');
    assert.equal(String(replay.body['operation_id']), String(accepted.body['operation_id']));
    const replayReceipt = await b.get(`/api/operations/${String(replay.body['operation_id'])}`);
    assert.equal(replayReceipt.body['created_run_id'], created, 'le run reste joignable depuis le reçu');
    assert.equal(replayReceipt.body['status'], 'FAILED');
    assert.equal(b.providerCalls(), calls, 'aucun nouvel appel fournisseur');
    assert.deepEqual(await b.runIds(), [created]);
  } finally {
    await b.cleanup();
  }
});


// --------------------------------------------------------------------------
// (S8) Audit de secret : un reçu START porte une identité, jamais une intention
// --------------------------------------------------------------------------

test('(S8) reçus START : ni clé en clair, ni contexte, ni chemin, ni réponse agent', async (t) => {
  const SECRET_PROMPT = 'CONTEXTE-CONFIDENTIEL-3d91af';
  const SECRET_TITLE = 'TITRE-CONFIDENTIEL-7c02be';
  const KEY = 'cle-secret-start-01';
  const b = await open({ failCodex: () => new Error('codex indisponible') });
  try {
    // Une création réussie n'existe pas ici — Codex échoue — mais les deux
    // issues écrivent le même genre de reçu, et c'est lui qui est audité.
    const accepted = await b.post(
      { title: SECRET_TITLE, workspace_cwd: b.workspace, prompt: SECRET_PROMPT },
      KEY,
    );
    assert.equal(accepted.status, 202, accepted.raw);
    const created = String(accepted.body['created_run_id']);
    await settle(b, String(accepted.body['operation_id']));

    // Les faits de l'intention existent bien là où ils doivent : le manifest.
    const manifest = await readFile(path.join(b.runsDir, created, 'manifest.json'), 'utf8');
    assert.ok(manifest.includes(SECRET_TITLE), 'le titre vit dans le manifest');
    assert.ok(manifest.includes(path.basename(b.workspace)), 'le workspace vit dans le manifest');

    // Le magasin d'opérations, lui, ne porte qu'une identité et un verdict.
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
      for (const [what, secret] of [
        ['contexte initial', SECRET_PROMPT],
        ['titre', SECRET_TITLE],
        ['clé en clair', KEY],
        ['chemin du workspace', path.basename(b.workspace)],
        ['réponse agent', 'ECHO:'],
      ] as const) {
        assert.equal(content.includes(secret), false, `${what} trouvé dans ${path.basename(file)}`);
      }
      for (const forbidden of ['cookie', 'Cookie', 'token', 'Authorization', 'PATH=', 'stderr']) {
        assert.equal(content.includes(forbidden), false, `${forbidden} trouvé dans ${path.basename(file)}`);
      }
    }
    t.diagnostic(`reçus START inspectés : ${String(files.length)} fichier(s), ${String(bytes)} octets`);
    assert.equal(files.length, 1, 'un reçu, un seul');

    // Et la projection publique n'en réintroduit rien.
    const receipt = await b.get(`/api/operations/${String(accepted.body['operation_id'])}`);
    for (const secret of [SECRET_PROMPT, SECRET_TITLE, KEY]) {
      assert.equal(receipt.raw.includes(secret), false, 'le reçu public expose un secret');
    }
    assert.equal(receipt.body['created_run_id'], created, 'il porte bien ce qu’il doit porter');
  } finally {
    await b.cleanup();
  }
});
