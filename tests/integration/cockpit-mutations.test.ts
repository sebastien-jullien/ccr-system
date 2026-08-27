/**
 * IT-4 — mutations courtes et idempotence durable, sur socket réel.
 *
 * Quatre garanties simultanées y sont éprouvées, et chacune peut casser sans
 * les autres :
 *
 * ```text
 * CSRF          l'origine exacte, sinon rien
 * vue courante  expected_revision revérifiée SOUS le verrou de l'effet
 * idempotence   claim durable AVANT tout effet
 * incertitude   crash → UNKNOWN, jamais un rejeu
 * ```
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { acquireRunLock } from '../../src/lock/run-lock.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { openDecisionStore } from '../../src/store/decision-store.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN = 'CCR-20260402-001';
const OTHER = 'CCR-20260808-002';

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

interface Box {
  readonly instance: CockpitInstance;
  readonly port: number;
  readonly runsDir: string;
  readonly cookie: string;
  readonly origin: string;
  post(route: string, payload: unknown, options?: PostOptions): Promise<Result>;
  get(target: string): Promise<Result>;
  revision(runId?: string): Promise<string>;
  facts(runId?: string): Promise<Facts>;
  cleanup(): Promise<void>;
}

interface PostOptions {
  readonly key?: string;
  readonly origin?: string | null;
  readonly contentType?: string | null;
  readonly rawBody?: string;
}

interface Facts {
  readonly state: string;
  readonly events: number;
  readonly decisions: number;
  readonly revision: string;
}

function send(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Result> {
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

async function open(options: { seams?: unknown; state?: Record<string, unknown> } = {}): Promise<Box> {
  const dir = await makeTempDir('ccr-mut-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: RUN,
    state: (options.state ?? {}) as never,
    events: [{ round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T }],
  });
  await materializeRun(runsDir, {
    runId: OTHER,
    events: [{ round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T }],
  });

  const instance = await startCockpit({
    runsDir,
    port: 0,
    ...(options.seams === undefined ? {} : { seams: options.seams as never }),
  });
  const port = instance.server.port;
  const bootstrap = await send(port, 'GET', '/', { Host: `127.0.0.1:${String(port)}` });
  void bootstrap;
  const cookieHeader = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
    });
    req.on('error', reject);
    req.end();
  });
  const origin = `http://127.0.0.1:${String(port)}`;

  return {
    instance,
    port,
    runsDir,
    cookie: cookieHeader,
    origin,
    async post(route, payload, opts = {}) {
      const body = opts.rawBody ?? JSON.stringify(payload);
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${String(port)}`,
        Cookie: cookieHeader,
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      };
      if (opts.origin !== null) headers['Origin'] = opts.origin ?? origin;
      if (opts.contentType !== null) headers['Content-Type'] = opts.contentType ?? 'application/json';
      if (opts.key !== undefined) headers['Idempotency-Key'] = opts.key;
      return send(port, 'POST', route, headers, body);
    },
    get(target) {
      return send(port, 'GET', target, { Host: `127.0.0.1:${String(port)}`, Cookie: cookieHeader });
    },
    async revision(runId = RUN) {
      return (await readStableRunSnapshot(runsDir, runId)).revision;
    },
    async facts(runId = RUN) {
      const paths = runPaths(runsDir, runId);
      const snapshot = await readStableRunSnapshot(runsDir, runId);
      const events = await (await openEventStore(paths, runId)).readAll();
      const decisions = await (await openDecisionStore(paths, runId)).readAll();
      return {
        state: snapshot.state.state,
        events: events.length,
        decisions: decisions.length,
        revision: snapshot.revision,
      };
    },
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

const KEY = 'cle-idempotence-0001';

// --------------------------------------------------------------------------
// Nominal et révision
// --------------------------------------------------------------------------

test('(X1) PAUSE : effet unique, reçu SUCCEEDED, révision changée', async (t) => {
  const b = await open();
  try {
    const before = await b.facts();
    const result = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: before.revision }, { key: KEY });

    assert.equal(result.status, 200, result.raw);
    assert.equal(result.body['status'], 'SUCCEEDED');
    assert.equal(result.body['action'], 'PAUSE');
    assert.match(String(result.body['operation_id']), /^op_[0-9a-f]{64}$/);

    const after = await b.facts();
    t.diagnostic(`${before.state} → ${after.state} · événements ${String(before.events)} → ${String(after.events)}`);

    assert.equal(after.state, 'PAUSED');
    assert.equal(after.events, before.events + 1);
    assert.notEqual(after.revision, before.revision, 'un fait canonique a changé');
    assert.equal(result.body['revision_after'], after.revision);
  } finally {
    await b.cleanup();
  }
});

test('(X2) même clé, même intention : un seul effet, le même reçu', async (t) => {
  const b = await open();
  try {
    const revision = await b.revision();
    const first = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: revision }, { key: KEY });
    const afterFirst = await b.facts();

    // Retransmission stricte.
    const second = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: revision }, { key: KEY });
    // Retransmission avec les propriétés du corps réordonnées : même intention.
    const third = await b.post(`/api/runs/${RUN}/pause`, null, {
      key: KEY,
      rawBody: JSON.stringify({ expected_revision: revision }),
    });

    const afterAll = await b.facts();
    t.diagnostic(`reçu ${String(first.body['operation_id']).slice(0, 12)}… rejoué ${String(second.status)}/${String(third.status)}`);

    assert.equal(second.body['operation_id'], first.body['operation_id']);
    assert.equal(third.body['operation_id'], first.body['operation_id']);
    assert.equal(second.body['status'], 'SUCCEEDED');
    assert.deepEqual(afterAll, afterFirst, 'aucun second effet');
  } finally {
    await b.cleanup();
  }
});

test('(X3) empreinte : l’ordre des propriétés JSON n’a aucune influence', async () => {
  const b = await open();
  try {
    const revision = await b.revision();
    const content = 'décision humaine';
    const first = await b.post(`/api/runs/${RUN}/decide`, null, {
      key: KEY,
      rawBody: JSON.stringify({ expected_revision: revision, content }),
    });
    assert.equal(first.status, 200, first.raw);

    const reordered = await b.post(`/api/runs/${RUN}/decide`, null, {
      key: KEY,
      rawBody: JSON.stringify({ content, expected_revision: revision }),
    });

    assert.equal(reordered.status, 200, reordered.raw);
    assert.equal(reordered.body['operation_id'], first.body['operation_id']);
    assert.equal((await b.facts()).decisions, 1, 'une seule décision');
  } finally {
    await b.cleanup();
  }
});

test('(X4) même clé, autre intention : 409 et aucun effet', async (t) => {
  const b = await open();
  try {
    const revision = await b.revision();
    await b.post(`/api/runs/${RUN}/pause`, { expected_revision: revision }, { key: KEY });
    const reference = await b.facts();

    const variants: readonly { readonly label: string; readonly run: () => Promise<Result> }[] = [
      {
        label: 'autre révision attendue',
        run: () => b.post(`/api/runs/${RUN}/pause`, { expected_revision: `sha256:${'b'.repeat(64)}` }, { key: KEY }),
      },
      {
        label: 'autre route',
        run: () => b.post(`/api/runs/${RUN}/resume`, { expected_revision: revision }, { key: KEY }),
      },
      {
        label: 'autre run',
        run: () => b.post(`/api/runs/${OTHER}/pause`, { expected_revision: revision }, { key: KEY }),
      },
      {
        label: 'autre contenu de décision',
        run: () => b.post(`/api/runs/${RUN}/decide`, { expected_revision: revision, content: 'autre' }, { key: KEY }),
      },
    ];

    for (const variant of variants) {
      const result = await variant.run();
      assert.equal(result.status, 409, variant.label);
      assert.equal((result.body['error'] as { code: string }).code, 'IDEMPOTENCY_KEY_REUSED', variant.label);
      t.diagnostic(`${variant.label} → 409`);
    }

    assert.deepEqual(await b.facts(), reference, 'aucun effet, sur aucun run');
    assert.deepEqual(await b.facts(OTHER), {
      state: 'READY',
      events: 1,
      decisions: 0,
      revision: (await b.facts(OTHER)).revision,
    });
  } finally {
    await b.cleanup();
  }
});

test('(X5) deux requêtes concurrentes, même clé : un seul effet', async (t) => {
  const b = await open();
  try {
    const revision = await b.revision();
    const attempts = Array.from({ length: 6 }, () =>
      b.post(`/api/runs/${RUN}/pause`, { expected_revision: revision }, { key: KEY }),
    );
    const results = await Promise.all(attempts);

    const ids = new Set(results.map((result) => String(result.body['operation_id'])));
    const after = await b.facts();
    t.diagnostic(`statuts=${results.map((r) => String(r.status)).join(',')} · identifiants=${[...ids].join(',')}`);

    /**
     * Cette assertion a été renforcée après le bug de publication du claim
     * (V2-IMP-41). La forme initiale se contentait de compter les
     * `operation_id` distincts — or six réponses d'erreur n'en portent aucun,
     * et `new Set(['undefined'])` a lui aussi une taille de un. Le test
     * survivait donc à six corruptions consécutives.
     *
     * Trois exigences séparées, désormais : chaque réponse aboutit, aucune ne
     * porte d'enveloppe d'erreur, et l'identifiant partagé en est réellement un.
     */
    for (const result of results) {
      assert.ok(result.status === 200 || result.status === 202, `statut ${String(result.status)} : ${result.raw}`);
      assert.equal(result.body['error'], undefined, result.raw);
    }
    assert.equal(ids.size, 1, 'un seul operation_id logique');
    assert.match([...ids][0] ?? '', /^op_[0-9a-f]{64}$/, 'un identifiant réel, pas une absence');
    assert.equal(after.events, 2, 'exactement un événement de pause');
    assert.equal(after.state, 'PAUSED');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// Révision et TOCTOU
// --------------------------------------------------------------------------

test('(X6) révision périmée : 409, zéro effet, reçu FAILED durable', async (t) => {
  const b = await open();
  try {
    const stale = `sha256:${'c'.repeat(64)}`;
    const paths = runPaths(b.runsDir, RUN);
    const stateBefore = await readFile(paths.state, 'utf8');
    const before = await b.facts();

    const result = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: stale }, { key: KEY });
    assert.equal(result.status, 409, result.raw);
    assert.equal((result.body['error'] as { code: string }).code, 'STALE_REVISION');

    const after = await b.facts();
    assert.equal(await readFile(paths.state, 'utf8'), stateBefore, 'état inchangé, octet pour octet');
    assert.deepEqual(after, before, 'aucun événement, aucune décision, même révision');

    // Le reçu existe : le claim précède la précondition, délibérément.
    const operationId = String(result.body['operation_id']);
    const receipt = await b.get(`/api/operations/${operationId}`);
    t.diagnostic(`reçu ${String(receipt.body['status'])} · code ${String(receipt.body['error_code'])}`);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body['status'], 'FAILED');
    assert.equal(receipt.body['error_code'], 'STALE_REVISION');

    // Retransmission après que la révision a changé : même échec, pas une
    // nouvelle tentative. La tentative avait été décidée sur une vue révolue.
    const paused = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: before.revision }, { key: 'autre-cle-00001' });
    assert.equal(paused.status, 200);

    const replay = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: stale }, { key: KEY });
    assert.equal(replay.status, 409);
    assert.equal((replay.body['error'] as { code: string }).code, 'STALE_REVISION');
    assert.equal(replay.body['operation_id'], operationId);

    // Preuve que le verdict stocké est rendu SANS toucher au run : un verrou
    // détenu par un tiers ne change rien. Une réévaluation, elle, devrait
    // acquérir ce verrou — et échouerait donc autrement.
    const held = await acquireRunLock(runPaths(b.runsDir, RUN), 'step');
    try {
      const underLock = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: stale }, { key: KEY });
      assert.equal(underLock.status, 409);
      assert.equal(
        (underLock.body['error'] as { code: string }).code,
        'STALE_REVISION',
        'le verdict vient du reçu, pas d une nouvelle évaluation',
      );
      assert.equal(underLock.body['operation_id'], operationId);
    } finally {
      await held.release();
    }
  } finally {
    await b.cleanup();
  }
});

test('(X7) TOCTOU : le run change entre le claim et le verrou → STALE_REVISION', async (t) => {
  let box: Box | undefined;
  let mutated = false;

  const seams = {
    beforeLock: async (): Promise<void> => {
      // Exactement la fenêtre visée : après validation et claim, avant que la
      // section critique ne s'ouvre. Un écrivain tiers fait avancer le run.
      if (mutated || box === undefined) return;
      mutated = true;
      const paths = runPaths(box.runsDir, RUN);
      const events = await openEventStore(paths, RUN);
      await events.append({
        round: 0,
        actor: 'human',
        type: 'human_message',
        content: 'écriture concurrente',
        timestamp: new Date().toISOString(),
      });
    },
  };

  box = await open({ seams });
  try {
    const revision = await box.revision();
    const before = await box.facts();

    const result = await box.post(`/api/runs/${RUN}/pause`, { expected_revision: revision }, { key: KEY });
    const after = await box.facts();
    t.diagnostic(`révision lue puis modifiée → ${String(result.status)} ${String((result.body['error'] as { code?: string } | undefined)?.code)}`);

    assert.equal(mutated, true, 'la fenêtre a bien été exercée');
    assert.equal(result.status, 409);
    assert.equal((result.body['error'] as { code: string }).code, 'STALE_REVISION');
    assert.equal(after.state, before.state, 'la mutation HTTP n’a rien fait');
    // Le seul événement supplémentaire est celui de l'écrivain concurrent.
    assert.equal(after.events, before.events + 1);
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Décision, opérations, CSRF
// --------------------------------------------------------------------------

test('(X8) DECIDE : une décision, une chaîne d’événements, jamais deux', async (t) => {
  const b = await open();
  try {
    const revision = await b.revision();
    const content = 'Nous retenons l’option B.';
    const first = await b.post(`/api/runs/${RUN}/decide`, { expected_revision: revision, content }, { key: KEY });
    assert.equal(first.status, 200, first.raw);

    for (let i = 0; i < 3; i += 1) {
      const replay = await b.post(`/api/runs/${RUN}/decide`, { expected_revision: revision, content }, { key: KEY });
      assert.equal(replay.body['operation_id'], first.body['operation_id']);
    }

    const paths = runPaths(b.runsDir, RUN);
    const decisions = await (await openDecisionStore(paths, RUN)).readAll();
    const events = await (await openEventStore(paths, RUN)).readAll();
    const recorded = events.filter((event) => event.type === 'decision_recorded');
    t.diagnostic(`décisions=${String(decisions.length)} · événements decision_recorded=${String(recorded.length)}`);

    assert.equal(decisions.length, 1);
    assert.equal(recorded.length, 1);
    assert.equal(decisions[0]?.content, content);
  } finally {
    await b.cleanup();
  }
});

test('(X9) Origin : seule l’origine canonique autorise une mutation', async (t) => {
  const b = await open();
  try {
    const revision = await b.revision();
    const before = await b.facts();

    for (const origin of [
      null,
      'null',
      `http://localhost:${String(b.port)}`,
      `http://127.0.0.1:${String(b.port + 1)}`,
      `https://127.0.0.1:${String(b.port)}`,
      'http://evil.example',
      '',
    ]) {
      const result = await b.post(
        `/api/runs/${RUN}/pause`,
        { expected_revision: revision },
        { key: `cle-${String(Math.abs(String(origin).length))}-000001`, origin },
      );
      assert.equal(result.status, 403, `origine « ${String(origin)} »`);
      assert.equal((result.body['error'] as { code: string }).code, 'INVALID_ORIGIN');
    }

    t.diagnostic('sept origines refusées, aucun effet');
    assert.deepEqual(await b.facts(), before);
    // Aucun reçu n'a été créé : le refus précède le claim.
    const operations = path.join(b.instance.dataRoot.controlDir, 'operations');
    assert.equal(await readdir(operations).then(() => true, () => false), false, 'aucun store créé');
  } finally {
    await b.cleanup();
  }
});

test('(X10) validation : média, corps, clé — refus déterministes sans claim', async (t) => {
  const b = await open();
  try {
    const revision = await b.revision();
    const operations = path.join(b.instance.dataRoot.controlDir, 'operations');

    const cases: readonly { readonly label: string; readonly options: PostOptions; readonly payload: unknown; readonly status: number; readonly code: string }[] = [
      { label: 'sans Idempotency-Key', options: {}, payload: { expected_revision: revision }, status: 400, code: 'INVALID_ARGUMENT' },
      { label: 'clé trop courte', options: { key: 'abc' }, payload: { expected_revision: revision }, status: 400, code: 'INVALID_ARGUMENT' },
      { label: 'type inattendu', options: { key: KEY, contentType: 'text/plain' }, payload: { expected_revision: revision }, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
      { label: 'JSON illisible', options: { key: KEY, rawBody: '{pas du json' }, payload: null, status: 400, code: 'INVALID_ARGUMENT' },
      { label: 'révision absente', options: { key: KEY }, payload: {}, status: 400, code: 'INVALID_ARGUMENT' },
      { label: 'révision mal formée', options: { key: KEY }, payload: { expected_revision: 'nawak' }, status: 400, code: 'INVALID_ARGUMENT' },
      { label: 'champ inattendu', options: { key: KEY }, payload: { expected_revision: revision, force: true }, status: 400, code: 'INVALID_ARGUMENT' },
      { label: 'décision vide', options: { key: KEY }, payload: { expected_revision: revision, content: '   ' }, status: 400, code: 'INVALID_ARGUMENT' },
    ];

    for (const testCase of cases) {
      const route = testCase.label === 'décision vide' ? `/api/runs/${RUN}/decide` : `/api/runs/${RUN}/pause`;
      const result = await b.post(route, testCase.payload, testCase.options);
      assert.equal(result.status, testCase.status, testCase.label);
      assert.equal((result.body['error'] as { code: string }).code, testCase.code, testCase.label);
    }

    // Corps hors borne : refus, jamais une troncature.
    const huge = await b.post(`/api/runs/${RUN}/decide`, null, {
      key: KEY,
      rawBody: JSON.stringify({ expected_revision: revision, content: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(huge.status, 413);

    t.diagnostic(`${String(cases.length + 1)} refus, aucun reçu créé`);
    assert.equal(await readdir(operations).then(() => true, () => false), false, 'aucun claim');
    assert.equal((await b.facts()).events, 1, 'aucun effet');
  } finally {
    await b.cleanup();
  }
});

test('(X10 bis) la route non canonique /decisions n’existe pas — et ne consomme aucune clé', async (t) => {
  const b = await open();
  try {
    const revision = await b.revision();
    const operations = path.join(b.instance.dataRoot.controlDir, 'operations');
    const before = await b.facts();

    // Une intention métier, une route publique.  n a jamais existé
    // côté V0.2 ; elle ne doit ni répondre, ni réserver la clé d idempotence.
    const result = await b.post(
      `/api/runs/${RUN}/decisions`,
      { expected_revision: revision, content: 'décision' },
      { key: KEY },
    );
    t.diagnostic('POST /decisions → ' + String(result.status));
    assert.equal(result.status, 404, result.raw);
    assert.equal(await readdir(operations).then(() => true, () => false), false, 'aucun claim consommé');
    assert.deepEqual(await b.facts(), before, 'aucun effet');

    // Et la clé reste disponible pour la route canonique.
    const canonical = await b.post(
      `/api/runs/${RUN}/decide`,
      { expected_revision: revision, content: 'décision' },
      { key: KEY },
    );
    assert.equal(canonical.status, 200, canonical.raw);
    assert.equal(canonical.body['status'], 'SUCCEEDED');
    assert.equal((await b.facts()).decisions, 1);
  } finally {
    await b.cleanup();
  }
});

test('(X11) GET /api/operations/:id — reçu public, identifiant strictement validé', async () => {
  const b = await open();
  try {
    const revision = await b.revision();
    const created = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: revision }, { key: KEY });
    const operationId = String(created.body['operation_id']);

    const receipt = await b.get(`/api/operations/${operationId}`);
    assert.equal(receipt.status, 200);
    assert.deepEqual(Object.keys(receipt.body).sort(), [
      'action',
      'created_at',
      'operation_id',
      'revision_after',
      'run_id',
      'status',
      'updated_at',
    ]);

    for (const forged of [
      '/api/operations/../../package.json',
      '/api/operations/%2e%2e%2f%2e%2e%2fpackage.json',
      '/api/operations/%252e%252e',
      `/api/operations/${operationId}%00`,
      '/api/operations/op_XYZ',
      `/api/operations/${operationId}/extra`,
    ]) {
      const result = await b.get(forged);
      assert.ok([400, 404].includes(result.status), `${forged} → ${String(result.status)}`);
      assert.equal(result.raw.includes('devDependencies'), false);
    }
  } finally {
    await b.cleanup();
  }
});

test('(X12) store d’idempotence corrompu : fail-closed, aucun effet', async (t) => {
  const b = await open();
  try {
    const revision = await b.revision();
    const created = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: revision }, { key: KEY });
    const operationId = String(created.body['operation_id']);
    const digest = operationId.slice(3);
    const file = path.join(b.instance.dataRoot.controlDir, 'operations', digest.slice(0, 2), `${digest}.json`);
    const before = await b.facts();

    for (const corruption of ['{ pas du json', '{}', JSON.stringify({ schema_version: 1, operation_id: 'op_zzz' })]) {
      await writeFile(file, corruption, 'utf8');

      // Retransmission : un reçu illisible ne doit JAMAIS être pris pour une
      // absence, sans quoi l'effet serait rejoué.
      const replay = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: revision }, { key: KEY });
      assert.equal(replay.status, 422, corruption.slice(0, 20));
      assert.equal((replay.body['error'] as { code: string }).code, 'OPERATION_STORE_CORRUPT');

      const lookup = await b.get(`/api/operations/${operationId}`);
      assert.equal(lookup.status, 422);
      assert.deepEqual(await b.facts(), before, 'aucun effet supplémentaire');
    }
    t.diagnostic('trois formes de corruption, trois refus explicites');
  } finally {
    await b.cleanup();
  }
});

test('(X13) le store ne contient ni secret, ni clé brute, ni décision en clair', async (t) => {
  const b = await open();
  try {
    const revision = await b.revision();
    const content = 'DECISION-CONFIDENTIELLE-XYZZY';
    await b.post(`/api/runs/${RUN}/decide`, { expected_revision: revision, content }, { key: KEY });

    const operations = path.join(b.instance.dataRoot.controlDir, 'operations');
    const files: string[] = [];
    for (const shard of await readdir(operations)) {
      for (const name of await readdir(path.join(operations, shard))) {
        files.push(path.join(operations, shard, name));
      }
    }
    assert.equal(files.length, 1);
    const raw = await readFile(files[0] ?? '', 'utf8');
    t.diagnostic(`reçu de ${String(Buffer.byteLength(raw, 'utf8'))} octets`);

    for (const secret of [content, KEY, b.instance.server.sessionSecret, b.runsDir, String(process.pid)]) {
      assert.equal(raw.includes(secret), false, `« ${secret.slice(0, 24)} » ne doit pas être persisté`);
    }
    // Mais la décision est bien canonique, elle, dans le journal du run.
    const decisions = await (await openDecisionStore(runPaths(b.runsDir, RUN), RUN)).readAll();
    assert.equal(decisions[0]?.content, content);
  } finally {
    await b.cleanup();
  }
});

test('(X14) le store d’opérations n’influence jamais la révision canonique', async (t) => {
  const b = await open();
  try {
    const before = await b.revision();

    // Un échec déterministe crée un reçu — et rien d'autre.
    await b.post(`/api/runs/${RUN}/pause`, { expected_revision: `sha256:${'d'.repeat(64)}` }, { key: KEY });
    const afterFailure = await b.revision();
    assert.equal(afterFailure, before, 'un reçu n’est pas un fait canonique');

    // Un succès change la révision — par son effet V1, pas par son reçu.
    const success = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: before }, { key: 'cle-succes-000001' });
    assert.equal(success.status, 200, success.raw);
    const afterSuccess = await b.revision();
    assert.notEqual(afterSuccess, before);

    // Et une relecture du reçu ne bouge rien non plus.
    await b.get(`/api/operations/${String(success.body['operation_id'])}`);
    assert.equal(await b.revision(), afterSuccess);
    t.diagnostic(`${before.slice(7, 19)}… → ${afterSuccess.slice(7, 19)}…`);
  } finally {
    await b.cleanup();
  }
});

test('(X15) le server.lock et les opérations restent des domaines distincts', async () => {
  const b = await open();
  try {
    const revision = await b.revision();
    await b.post(`/api/runs/${RUN}/pause`, { expected_revision: revision }, { key: KEY });

    const control = b.instance.dataRoot.controlDir;
    const entries = (await readdir(control)).sort();
    assert.deepEqual(entries, ['operations', 'server.lock']);

    // Le verrou de serveur n'est pas touché par une mutation.
    const lock = await stat(b.instance.dataRoot.serverLock);
    assert.ok(lock.size > 0);
    // Et le store d'opérations vit à côté, sans interaction.
    assert.equal((await readdir(path.join(control, 'operations'))).length, 1);
  } finally {
    await b.cleanup();
  }
});

test('(X16) RESUME et STOP passent par les gardes V1, sans requalification', async (t) => {
  const b = await open({ state: { state: 'PAUSED', control: 'HUMAN' } });
  try {
    const revision = await b.revision();
    const resumed = await b.post(`/api/runs/${RUN}/resume`, { expected_revision: revision }, { key: 'cle-resume-000001' });
    assert.equal(resumed.status, 200, resumed.raw);
    const afterResume = await b.facts();
    t.diagnostic(`PAUSED → ${afterResume.state}`);
    assert.equal(afterResume.state, 'READY');

    const stopped = await b.post(`/api/runs/${RUN}/stop`, { expected_revision: afterResume.revision }, { key: 'cle-stop-0000001' });
    assert.equal(stopped.status, 200, stopped.raw);
    assert.equal((await b.facts()).state, 'CLOSED');

    // Un run clos n'est plus suspendable : la garde V1 tranche, pas le transport.
    const refused = await b.post(
      `/api/runs/${RUN}/pause`,
      { expected_revision: (await b.facts()).revision },
      { key: 'cle-refus-0000001' },
    );
    assert.equal(refused.status, 422, refused.raw);
    assert.equal((refused.body['error'] as { code: string }).code, 'RUN_NOT_PAUSABLE');
  } finally {
    await b.cleanup();
  }
});
