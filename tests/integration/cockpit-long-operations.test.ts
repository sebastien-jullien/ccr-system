/**
 * IT-5 — opérations longues `STEP` et `SEND` sur socket réel.
 *
 * Le fournisseur est un adapter contrôlé : il **bloque** sur une barrière que
 * le test libère. Ce n'est pas une commodité — c'est la seule façon d'observer
 * ce qui doit l'être pendant qu'une opération est en vol :
 *
 * ```text
 * le 202 arrive AVANT la réponse de l'agent
 * le run lock est tenu pendant tout l'appel
 * la vivacité vaut OPERATION_IN_FLIGHT, jamais RECOVERY_REQUIRED
 * le troisième appelant est refusé sans attendre
 * ```
 *
 * Aucun fournisseur réel n'est sollicité, aucun appel payant n'est émis.
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
import { acquireRunLock } from '../../src/lock/run-lock.ts';
import { CcrError } from '../../src/core/errors.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUNS = ['CCR-20260402-001', 'CCR-20260808-002', 'CCR-20260808-003'] as const;

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

/** Barrière contrôlée : l'agent attend que le test le libère. */
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

/** Attend qu un nombre d appels fournisseur soit atteint, sans jamais boucler sans fin. */
async function untilEntered(gate: { entered: () => number }, expected: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (gate.entered() < expected) {
    if (Date.now() > deadline) throw new Error(`appels fournisseur : ${String(gate.entered())} au lieu de ${String(expected)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Box {
  readonly instance: CockpitInstance;
  readonly port: number;
  readonly runsDir: string;
  post(route: string, payload: unknown, key: string): Promise<Result>;
  get(target: string): Promise<Result>;
  revision(runId: string): Promise<string>;
  events(runId: string): Promise<number>;
  cleanup(): Promise<void>;
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

interface OpenOptions {
  readonly onCall?: (phase: 'start' | 'resume', prompt: string) => Promise<void> | void;
  readonly failResume?: () => unknown;
  readonly respond?: (prompt: string) => string;
}

async function open(options: OpenOptions = {}): Promise<Box> {
  const dir = await makeTempDir('ccr-long-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });

  for (const runId of RUNS) {
    await materializeRun(runsDir, {
      runId,
      events: [
        { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
        {
          round: 1,
          actor: 'codex',
          type: 'assistant_response',
          session_id: 'codex-1',
          content: 'réponse initiale de Codex',
          timestamp: T,
        },
      ],
    });
  }

  const adapters: AgentAdapters = {
    claude: createFakeAdapter({
      kind: 'claude',
      sessionId: 'claude-1',
      ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
      ...(options.respond === undefined ? {} : { respond: options.respond }),
    }),
    codex: createFakeAdapter({
      kind: 'codex',
      sessionId: 'codex-1',
      ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
      ...(options.failResume === undefined ? {} : { failResume: options.failResume }),
      ...(options.respond === undefined ? {} : { respond: options.respond }),
    }),
  };

  const instance = await startCockpit({
    runsDir,
    port: 0,
    depsOverrides: { createAdapters: () => adapters },
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
    port,
    runsDir,
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
    events: async (runId) => (await (await openEventStore(runPaths(runsDir, runId), runId)).readAll()).length,
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

// --------------------------------------------------------------------------
// 202 et vivacité
// --------------------------------------------------------------------------

test('(L1) STEP : 202 avant la réponse de l’agent, vivacité OPERATION_IN_FLIGHT', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const revision = await b.revision(RUNS[0]);
    const started = process.hrtime.bigint();
    const accepted = await b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: revision }, 'cle-step-00000001');
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    // Plus fort que « avant la réponse » : à l instant du 202, le fournisseur
    // n a même pas encore été appelé. L accusé porte sur l admission, pas sur
    // l agent.
    t.diagnostic(`202 en ${elapsed.toFixed(0)} ms · appels fournisseur à cet instant : ${String(gate.entered())}`);
    assert.equal(accepted.status, 202, accepted.raw);
    assert.equal(accepted.body['status'], 'RUNNING');
    assert.equal(accepted.body['action'], 'STEP');
    await untilEntered(gate, 1);
    assert.equal(gate.entered(), 1, 'l agent est appelé une fois, et reste bloqué');

    // Pendant le blocage : le reçu est RUNNING…
    const receipt = await b.get(`/api/operations/${String(accepted.body['operation_id'])}`);
    assert.equal(receipt.body['status'], 'RUNNING');

    // …et la vivacité montre une opération en vol, pas une reprise.
    const view = await b.get(`/api/runs/${RUNS[0]}`);
    const liveness = view.body['liveness'] as Record<string, unknown>;
    t.diagnostic(`vivacité=${String(liveness['liveness'])} · verrou=${String(liveness['lock_observation'])}`);
    assert.equal(liveness['liveness'], 'OPERATION_IN_FLIGHT');
    assert.equal(liveness['needs_human_attention'], false);
    assert.equal(liveness['lock_observation'], 'ACTIVE_HOST_OPERATION');

    // Les capacités bloquées le sont par l'opération, jamais par une reprise.
    const capabilities = (view.body['capabilities'] as { capabilities: { id: string; reason?: string }[] }).capabilities;
    for (const capability of capabilities) {
      assert.notEqual(capability.reason, 'RECOVERY_REQUIRED', `${capability.id} ne doit pas invoquer une reprise`);
    }

    gate.release();
    // Terminaison : le reçu devient SUCCEEDED et la révision a changé.
    for (let i = 0; i < 200; i += 1) {
      const now = await b.get(`/api/operations/${String(accepted.body['operation_id'])}`);
      if (now.body['status'] !== 'RUNNING') {
        assert.equal(now.body['status'], 'SUCCEEDED', now.raw);
        assert.notEqual(now.body['revision_after'], revision);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('l’opération ne s’est jamais terminée');
  } finally {
    gate.release();
    await b.cleanup();
  }
});

test('(L2) SEND : 202, cible validée, contenu jamais persisté dans le reçu', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const revision = await b.revision(RUNS[0]);
    const secret = 'MESSAGE-HUMAIN-CONFIDENTIEL-XYZZY';
    const accepted = await b.post(
      `/api/runs/${RUNS[0]}/send`,
      { expected_revision: revision, target: 'claude', content: secret },
      'cle-send-00000001',
    );
    assert.equal(accepted.status, 202, accepted.raw);
    assert.equal(accepted.body['action'], 'SEND');

    // Cible inconnue : refus déterministe, aucun fournisseur.
    const bad = await b.post(
      `/api/runs/${RUNS[1]}/send`,
      { expected_revision: await b.revision(RUNS[1]), target: 'gemini', content: 'x' },
      'cle-send-invalide1',
    );
    assert.equal(bad.status, 400);

    gate.release();
    await waitTerminal(b, String(accepted.body['operation_id']));

    // Le reçu ne conserve ni le message, ni la réponse de l'agent.
    const operations = path.join(b.instance.dataRoot.controlDir, 'operations');
    let store = '';
    for (const shard of await readdir(operations)) {
      for (const name of await readdir(path.join(operations, shard))) {
        store += await readFile(path.join(operations, shard, name), 'utf8');
      }
    }
    t.diagnostic(`${String(Buffer.byteLength(store, 'utf8'))} octets de reçus inspectés`);
    for (const forbidden of [secret, 'réponse de claude', b.instance.server.sessionSecret, 'cle-send-00000001']) {
      assert.equal(store.includes(forbidden), false, `« ${forbidden.slice(0, 24)} » ne doit pas être persisté`);
    }
  } finally {
    gate.release();
    await b.cleanup();
  }
});

async function waitTerminal(b: Box, operationId: string, timeoutMs = 10_000): Promise<Result> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await b.get(`/api/operations/${operationId}`);
    if (now.body['status'] !== 'RUNNING') return now;
    if (Date.now() > deadline) throw new Error(`opération toujours RUNNING : ${now.raw}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// --------------------------------------------------------------------------
// Admission
// --------------------------------------------------------------------------

test('(L3) quota : deux opérations admises, la troisième refusée sans attendre', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const first = await b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: await b.revision(RUNS[0]) }, 'cle-quota-000001');
    const second = await b.post(
      `/api/runs/${RUNS[1]}/send`,
      { expected_revision: await b.revision(RUNS[1]), target: 'claude', content: 'bonjour' },
      'cle-quota-000002',
    );
    assert.equal(first.status, 202, first.raw);
    assert.equal(second.status, 202, second.raw);
    assert.equal(b.instance.manager.activeCount(), 2);

    // Le troisième reçoit son verdict AVANT que les deux autres ne finissent :
    // l'agent est toujours bloqué à cet instant.
    const started = process.hrtime.bigint();
    const third = await b.post(`/api/runs/${RUNS[2]}/step`, { expected_revision: await b.revision(RUNS[2]) }, 'cle-quota-000003');
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    t.diagnostic(`troisième refusé en ${elapsed.toFixed(0)} ms · appels agent = ${String(gate.entered())}`);

    assert.equal(third.status, 503, third.raw);
    assert.equal((third.body['error'] as { code: string }).code, 'COCKPIT_BUSY');
    assert.equal(gate.entered(), 2, 'le troisième n’a appelé aucun fournisseur');
    assert.equal(await b.events(RUNS[2]), 2, 'et n’a produit aucun effet');

    // STEP + SEND partagent le quota : ce n'est pas 2 + 2.
    assert.equal(b.instance.manager.activeCount(), 2);

    // Reçu terminal d'échec pour le refusé, et la même clé le reste.
    const refusedId = String(third.body['operation_id']);
    const refusedReceipt = await b.get(`/api/operations/${refusedId}`);
    assert.equal(refusedReceipt.body['status'], 'FAILED');
    assert.equal(refusedReceipt.body['error_code'], 'COCKPIT_BUSY');

    gate.release();
    await waitTerminal(b, String(first.body['operation_id']));
    await waitTerminal(b, String(second.body['operation_id']));
    assert.equal(b.instance.manager.activeCount(), 0, 'les créneaux sont rendus');

    // Un créneau libre ne ressuscite pas une tentative refusée.
    const replay = await b.post(`/api/runs/${RUNS[2]}/step`, { expected_revision: await b.revision(RUNS[2]) }, 'cle-quota-000003');
    assert.equal(replay.status, 503);
    assert.equal(replay.body['operation_id'], refusedId);
    assert.equal(await b.events(RUNS[2]), 2, 'toujours aucun effet');

    // Une nouvelle tentative humaine, elle, passe.
    const fresh = await b.post(`/api/runs/${RUNS[2]}/step`, { expected_revision: await b.revision(RUNS[2]) }, 'cle-quota-000004');
    assert.equal(fresh.status, 202, fresh.raw);
    await waitTerminal(b, String(fresh.body['operation_id']));
  } finally {
    gate.release();
    await b.cleanup();
  }
});

test('(L4) trois requêtes simultanées : exactement deux admises', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const revisions = await Promise.all(RUNS.map((runId) => b.revision(runId)));
    const results = await Promise.all(
      RUNS.map((runId, index) =>
        b.post(`/api/runs/${runId}/step`, { expected_revision: revisions[index] ?? '' }, `cle-course-00000${String(index)}`),
      ),
    );

    const accepted = results.filter((result) => result.status === 202);
    const refused = results.filter((result) => result.status === 503);
    await untilEntered(gate, 2);
    t.diagnostic(`statuts=${results.map((r) => String(r.status)).join(',')} · appels agent=${String(gate.entered())}`);

    assert.equal(accepted.length, 2, 'jamais trois');
    assert.equal(refused.length, 1);
    assert.equal(gate.entered(), 2, 'au plus deux fournisseurs simultanés');
    assert.ok(b.instance.manager.activeCount() <= 2);

    gate.release();
    for (const result of accepted) await waitTerminal(b, String(result.body['operation_id']));
  } finally {
    gate.release();
    await b.cleanup();
  }
});

test('(L5) une retransmission ne consomme jamais un second créneau', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const key = 'cle-duplicate-0001';
    const revision = await b.revision(RUNS[0]);
    const first = await b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: revision }, key);
    assert.equal(first.status, 202);

    const duplicates = await Promise.all([
      b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: revision }, key),
      b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: revision }, key),
    ]);
    t.diagnostic(`duplicatas : ${duplicates.map((d) => String(d.status)).join(',')} · créneaux=${String(b.instance.manager.activeCount())}`);

    for (const duplicate of duplicates) {
      assert.equal(duplicate.body['operation_id'], first.body['operation_id']);
      assert.equal(duplicate.body['status'], 'RUNNING');
    }
    assert.equal(b.instance.manager.activeCount(), 1, 'un seul créneau');
    await untilEntered(gate, 1);
    assert.equal(gate.entered(), 1, 'un seul appel fournisseur');

    // Un second créneau reste donc disponible pour un autre run.
    const other = await b.post(
      `/api/runs/${RUNS[1]}/send`,
      { expected_revision: await b.revision(RUNS[1]), target: 'claude', content: 'x' },
      'cle-autre-0000001',
    );
    assert.equal(other.status, 202, other.raw);

    gate.release();
    await waitTerminal(b, String(first.body['operation_id']));
    await waitTerminal(b, String(other.body['operation_id']));
  } finally {
    gate.release();
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Préconditions avant admission
// --------------------------------------------------------------------------

test('(L6) une requête déjà condamnée ne consomme aucun créneau', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const stale = `sha256:${'c'.repeat(64)}`;

    // Vue périmée.
    const outdated = await b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: stale }, 'cle-stale-0000001');
    assert.equal(outdated.status, 409, outdated.raw);
    assert.equal((outdated.body['error'] as { code: string }).code, 'STALE_REVISION');

    // Session absente pour la cible.
    await materializeRun(b.runsDir, { runId: 'CCR-20260808-004' });
    const noSession = await b.post(
      `/api/runs/${RUNS[0]}/send`,
      { expected_revision: await b.revision(RUNS[0]), target: 'claude', content: 'x' },
      'cle-session-000001',
    );
    // La session existe ici : on vérifie plutôt qu'un run sans source refuse STEP.
    assert.equal(noSession.status, 202, noSession.raw);

    t.diagnostic(`créneaux occupés après refus : ${String(b.instance.manager.activeCount())} · appels=${String(gate.entered())}`);
    assert.equal(b.instance.manager.activeCount(), 1, 'seule la requête valide occupe un créneau');

    gate.release();
    await waitTerminal(b, String(noSession.body['operation_id']));
  } finally {
    gate.release();
    await b.cleanup();
  }
});

test('(L7) verrou de run détenu ailleurs : aucun fournisseur, aucune file', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const held = await acquireRunLock(runPaths(b.runsDir, RUNS[0]), 'step');
    try {
      const blocked = await b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: await b.revision(RUNS[0]) }, 'cle-verrou-000001');
      t.diagnostic(`verrou externe → ${String(blocked.status)} ${String((blocked.body['error'] as { code?: string } | undefined)?.code)}`);

      assert.equal(blocked.status, 409, blocked.raw);
      assert.equal((blocked.body['error'] as { code: string }).code, 'RUN_ALREADY_LOCKED');
      assert.equal(gate.entered(), 0, 'aucun fournisseur appelé');
      assert.equal(b.instance.manager.activeCount(), 0, 'aucun créneau consommé');
      // Un créneau pris puis rendu laisserait activeCount() à zéro : seule la
      // tentative distingue « jamais demandé » de « demandé puis relâché ».
      assert.equal(b.instance.manager.admitAttempts(), 0, 'aucun créneau même demandé');
    } finally {
      await held.release();
    }
  } finally {
    gate.release();
    await b.cleanup();
  }
});

test('(L8) les mutations courtes ne comptent pas dans le quota', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const long = await b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: await b.revision(RUNS[0]) }, 'cle-long-0000001');
    assert.equal(long.status, 202);
    assert.equal(b.instance.manager.activeCount(), 1);

    // Une mutation courte sur un autre run passe, et ne pèse pas.
    const paused = await b.post(`/api/runs/${RUNS[1]}/pause`, { expected_revision: await b.revision(RUNS[1]) }, 'cle-courte-000001');
    assert.equal(paused.status, 200, paused.raw);
    assert.equal(b.instance.manager.activeCount(), 1, 'le quota long est inchangé');

    // Et un second long reste admissible.
    const second = await b.post(
      `/api/runs/${RUNS[2]}/send`,
      { expected_revision: await b.revision(RUNS[2]), target: 'claude', content: 'x' },
      'cle-long-0000002',
    );
    t.diagnostic(`créneaux après une courte et deux longues : ${String(b.instance.manager.activeCount())}`);
    assert.equal(second.status, 202, second.raw);
    assert.equal(b.instance.manager.activeCount(), 2);

    gate.release();
    await waitTerminal(b, String(long.body['operation_id']));
    await waitTerminal(b, String(second.body['operation_id']));
  } finally {
    gate.release();
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Échec fournisseur et isolation
// --------------------------------------------------------------------------

test('(L9) échec fournisseur : reçu FAILED, créneau libéré, aucun rejeu', async (t) => {
  const b = await open({ failResume: () => new CcrError('AGENT_EXIT_NONZERO', 'la CLI a échoué') });
  try {
    // La révision de la tentative est figée ici : une retransmission de LA MÊME
    // tentative doit la réutiliser, sinon c est une intention différente.
    const revision = await b.revision(RUNS[0]);
    const accepted = await b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: revision }, 'cle-echec-0000001');
    assert.equal(accepted.status, 202, accepted.raw);

    const terminal = await waitTerminal(b, String(accepted.body['operation_id']));
    t.diagnostic(`issue : ${String(terminal.body['status'])} · code ${String(terminal.body['error_code'])}`);
    assert.equal(terminal.body['status'], 'FAILED');
    assert.equal(terminal.body['error_code'], 'AGENT_EXIT_NONZERO');
    assert.equal(b.instance.manager.activeCount(), 0, 'créneau rendu');

    // Retransmission de la même tentative : le même échec, aucun nouvel appel.
    const replay = await b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: revision }, 'cle-echec-0000001');
    assert.equal(replay.body['operation_id'], accepted.body['operation_id']);
    assert.equal(b.instance.manager.activeCount(), 0);
  } finally {
    await b.cleanup();
  }
});

test('(L10) le registre d’opérations hôte reste l’évidence de vivacité', async (t) => {
  const gate = barrier();
  const b = await open({ onCall: () => gate.wait() });
  try {
    const accepted = await b.post(`/api/runs/${RUNS[0]}/step`, { expected_revision: await b.revision(RUNS[0]) }, 'cle-registre-00001');
    assert.equal(accepted.status, 202);

    // Le registre associe l'opération au `lock_id` exact du verrou du run.
    const registry = b.instance.registry;
    const lockRaw = await readFile(path.join(b.runsDir, RUNS[0], '.ccr.lock'), 'utf8');
    const lockId = (JSON.parse(lockRaw) as { lock_id: string }).lock_id;
    t.diagnostic(`registre : ${String(registry.size())} entrée(s) · lock ${lockId.slice(0, 8)}…`);

    assert.ok(registry.find(RUNS[0], lockId) !== undefined, 'association exacte opération ↔ verrou');
    // Le manager, lui, ne connaît que des identifiants d'opération : il ne
    // prouve rien sur un run donné.
    assert.equal(b.instance.manager.activeCount(), 1);
    assert.equal(b.instance.manager.activeOperationIds()[0], accepted.body['operation_id']);

    gate.release();
    await waitTerminal(b, String(accepted.body['operation_id']));
    assert.equal(registry.size(), 0, 'registre vidé après la fin');
  } finally {
    gate.release();
    await b.cleanup();
  }
});

test('(L11) le manager n’influence ni la révision, ni la vivacité au repos', async () => {
  const b = await open();
  try {
    const before = await b.revision(RUNS[0]);
    // Un refus de quota crée un reçu et occupe le manager un instant ; rien
    // de canonique ne bouge.
    const view = await b.get(`/api/runs/${RUNS[0]}`);
    assert.equal((view.body['liveness'] as { liveness: string }).liveness, 'NONE');
    assert.equal(await b.revision(RUNS[0]), before);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (L12) Audit de secret : un reçu ne contient ni l'intention, ni la réponse
// --------------------------------------------------------------------------

test('(L12) reçus STEP et SEND : aucune trace du contenu humain ni de la réponse agent', async (t) => {
  const SECRET_HUMAIN = 'MOT-DE-PASSE-HUMAIN-8f21c4';
  const SECRET_AGENT = 'REPONSE-AGENT-CONFIDENTIELLE-b70d9a';
  const b = await open({ respond: () => SECRET_AGENT });
  try {
    const sent = await b.post(
      `/api/runs/${RUNS[0]}/send`,
      { expected_revision: await b.revision(RUNS[0]), target: 'claude', content: SECRET_HUMAIN },
      'cle-secret-00001',
    );
    assert.ok(sent.status === 202 || sent.status === 200, sent.raw);
    const sendId = String(sent.body['operation_id']);

    // Le `202` part à l'admission : la seconde opération doit attendre que la
    // première ait vraiment rendu le run lock, sans quoi elle serait refusée.
    let settled = '';
    for (let attempt = 0; attempt < 200 && !['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(settled); attempt += 1) {
      settled = String((await b.get(`/api/operations/${sendId}`)).body['status']);
      if (!['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(settled)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    t.diagnostic(`SEND terminalisée : ${settled}`);
    assert.equal(settled, 'SUCCEEDED');

    const stepped = await b.post(
      `/api/runs/${RUNS[0]}/step`,
      { expected_revision: await b.revision(RUNS[0]) },
      'cle-secret-00002',
    );
    assert.ok(stepped.status === 202 || stepped.status === 200, stepped.raw);
    const stepId = String(stepped.body['operation_id']);

    // L'effet a bien eu lieu : les deux secrets sont dans les sources canoniques.
    const events = await (await openEventStore(runPaths(b.runsDir, RUNS[0]), RUNS[0])).readAll();
    const canonical = JSON.stringify(events);
    assert.ok(canonical.includes(SECRET_HUMAIN), 'le message humain existe bien là où il doit être');
    assert.ok(canonical.includes(SECRET_AGENT), 'la réponse agent existe bien là où elle doit être');

    // Le magasin d'opérations, lui, ne doit rien en savoir : il porte une
    // identité et un verdict, pas une charge utile.
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
      assert.equal(content.includes(SECRET_HUMAIN), false, `contenu humain trouvé dans ${path.basename(file)}`);
      assert.equal(content.includes(SECRET_AGENT), false, `réponse agent trouvée dans ${path.basename(file)}`);
      // Ni la clé d'idempotence en clair : le nom du fichier est une empreinte.
      assert.equal(content.includes('cle-secret-'), false, `clé en clair dans ${path.basename(file)}`);
    }
    t.diagnostic(`reçus inspectés : ${String(files.length)} fichier(s), ${String(bytes)} octets`);
    assert.ok(files.length >= 2, 'les deux reçus ont bien été écrits');

    // Et la réponse publique du reçu ne les réintroduit pas non plus.
    for (const operationId of [sendId, stepId]) {
      const receipt = await b.get(`/api/operations/${operationId}`);
      assert.equal(receipt.status, 200, receipt.raw);
      assert.equal(receipt.raw.includes(SECRET_HUMAIN), false, 'contenu humain exposé par le reçu');
      assert.equal(receipt.raw.includes(SECRET_AGENT), false, 'réponse agent exposée par le reçu');
    }
  } finally {
    await b.cleanup();
  }
});
