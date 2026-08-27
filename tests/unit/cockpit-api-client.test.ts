/**
 * V5.1 — le client HTTP du navigateur, réellement exécuté.
 *
 * Question de preuve :
 *
 * > **Chaque émission mutante du client atteint-elle vraiment son chemin, avec
 * > sa clé et sa charge — ou certaines ne sont-elles jamais exercées ?**
 *
 * Ce fichier existe à cause d'un défaut démontré : `recoverNative` appelait un
 * helper `post(...)` qui n'était défini nulle part. En module ES — donc en mode
 * strict — un identifiant libre lève une `ReferenceError` au premier appel. Le
 * défaut a survécu parce que **aucun test n'exécutait ce client** : `createApi`
 * n'était appelé nulle part, et chaque test double l'api.
 *
 * ```text
 * AUDIT PAR SOUS-CHAÎNE  ≠  EXÉCUTION
 * ```
 *
 * Les émissions sont donc éprouvées ici par un `fetch` injecté, jusqu'à l'URL,
 * la méthode, les en-têtes et le corps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

interface Sent {
  readonly url: string;
  readonly init: {
    method?: string;
    credentials?: string;
    headers?: Record<string, string>;
    body?: string;
  };
}

interface ApiClient {
  recoverNative(runId: string, payload: unknown, key: string): Promise<unknown>;
  reconcile(runId: string, payload: unknown, key: string): Promise<unknown>;
  mutate(action: string, runId: string, payload: unknown, key: string): Promise<unknown>;
}

interface Harness {
  readonly api: ApiClient;
  readonly sent: Sent[];
}

async function harness(response: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throwOnFetch?: boolean;
}): Promise<Harness> {
  const { createApi } = (await importWeb('api.js')) as {
    createApi: (deps: Record<string, unknown>) => ApiClient;
  };
  const sent: Sent[] = [];
  const fetchImpl = (url: string, init: Sent['init']): Promise<unknown> => {
    sent.push({ url, init });
    if (response.throwOnFetch === true) return Promise.reject(new Error('offline'));
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: () => Promise.resolve(response.body ?? {}),
    });
  };
  return { api: createApi({ fetchImpl }), sent };
}

// --------------------------------------------------------------------------
// A. Le défaut démontré : `recoverNative` atteint bien son chemin
// --------------------------------------------------------------------------

test('V5.1 — `recoverNative` émet réellement sa requête, sans identifiant libre', async () => {
  const receipt = { operation_id: 'op_7', status: 'SUCCEEDED' };
  const { api, sent } = await harness({ body: receipt });

  // Avant réparation, cet appel levait `ReferenceError: post is not defined`
  // AVANT toute émission : `sent` serait resté vide.
  const result = await api.recoverNative(
    'CCR-20260404-001',
    { capability: 'RECOVERY_CLEAR_STALE_LOCK', expected_revision: 'sha256:x', note: 'verrou mort' },
    'ccr-key-1',
  );

  assert.deepEqual(result, receipt);
  assert.equal(sent.length, 1, 'une émission, et une seule');
  assert.equal(sent[0]?.url, '/api/runs/CCR-20260404-001/recovery');
  assert.equal(sent[0]?.init.method, 'POST');
  assert.equal(sent[0]?.init.credentials, 'same-origin');
  assert.equal(sent[0]?.init.headers?.['Content-Type'], 'application/json');
  assert.equal(sent[0]?.init.headers?.['Idempotency-Key'], 'ccr-key-1');

  // La note humaine voyage telle quelle : ni rognée, ni normalisée.
  const body = JSON.parse(String(sent[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body['note'], 'verrou mort');
  assert.equal(body['capability'], 'RECOVERY_CLEAR_STALE_LOCK');
});

test('V5.1 — `recoverNative` rend le code public et l’identifiant d’opération', async () => {
  const { api } = await harness({
    ok: false,
    status: 409,
    body: { error: { code: 'STALE_REVISION' }, operation_id: 'op_9' },
  });

  await assert.rejects(
    () => api.recoverNative('CCR-20260404-001', { capability: 'X' }, 'ccr-key-2'),
    (error: unknown) => {
      const failure = error as { name: string; status: number; code: string; operationId?: string };
      assert.equal(failure.name, 'ApiError');
      assert.equal(failure.status, 409);
      assert.equal(failure.code, 'STALE_REVISION');
      assert.equal(failure.operationId, 'op_9');
      return true;
    },
  );
});

test('V5.1 — une panne réseau devient `NETWORK`, jamais une cause inventée', async () => {
  const { api } = await harness({ throwOnFetch: true });
  await assert.rejects(
    () => api.recoverNative('CCR-20260404-001', {}, 'ccr-key-3'),
    (error: unknown) => (error as { code: string }).code === 'NETWORK',
  );
});

// --------------------------------------------------------------------------
// B. Frontière de non-régression — les émissions voisines
// --------------------------------------------------------------------------

test('V5.1 — la réconciliation V5 émet toujours sur sa propre route', async () => {
  const { api, sent } = await harness({ body: { operation_id: 'op_1', status: 'RUNNING' } });

  await api.reconcile(
    'CCR-20260821-002',
    { operation: 'PROPOSE_BY_MODEL', target_controversy_id: 'ctv_000001' },
    'ccr-key-4',
  );

  assert.equal(sent[0]?.url, '/api/runs/CCR-20260821-002/reconciliations');
  assert.equal(sent[0]?.init.method, 'POST');
  assert.equal(sent[0]?.init.headers?.['Idempotency-Key'], 'ccr-key-4');
  const body = JSON.parse(String(sent[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body['operation'], 'PROPOSE_BY_MODEL');
});

test('V5.1 — les mutations de run empruntent toujours leur table close', async () => {
  const { api, sent } = await harness({ body: { operation_id: 'op_2', status: 'SUCCEEDED' } });

  await api.mutate('PAUSE', 'CCR-20260821-003', { expected_revision: 'sha256:y' }, 'ccr-key-5');

  assert.equal(sent[0]?.url, '/api/runs/CCR-20260821-003/pause');
  assert.equal(sent[0]?.init.method, 'POST');
});
