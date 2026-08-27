/**
 * Validation transversale de la surface V2 assemblée (Slice 9).
 *
 * Ce fichier ne recertifie aucune fonctionnalité : il éprouve cinq propriétés
 * qui doivent tenir **quelle que soit** la route, sur des représentants choisis.
 *
 * ```text
 * S1  bind local, Host canonique, session — lecture, mutation, flux
 * S2  origine exacte, sinon rien : aucun effet, aucune revendication
 * S3  identifiants et capacités hostiles : rien hors du répertoire des runs
 * S4  reçus, flux et erreurs publiques : aucun secret n'y transite
 * ```
 *
 * `S5` vit dans `cockpit-browser-security.test.ts` : il lui faut un navigateur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { OPERATIONS_DIR_NAME } from '../../src/cockpit/operations-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN = 'CCR-20260402-001';
/** Fichier hors du répertoire des runs. Aucune réponse ne doit le contenir. */
const SENTINEL = 'SENTINELLE-HORS-RUNSDIR-4f7a2c';

interface Result {
  readonly status: number;
  readonly raw: string;
  readonly headers: Record<string, string | string[] | undefined>;
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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

interface Box {
  readonly instance: CockpitInstance;
  readonly runsDir: string;
  readonly dir: string;
  readonly port: number;
  readonly cookie: string;
  get(target: string, headers?: Record<string, string>): Promise<Result>;
  post(target: string, payload: unknown, options?: { key?: string; origin?: string | null; cookie?: string }): Promise<Result>;
  operations(): Promise<string[]>;
  cleanup(): Promise<void>;
}

async function open(): Promise<Box> {
  const dir = await makeTempDir('ccr-security-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  // Un fichier lisible, hors du répertoire des runs, et un autre au-dessus.
  await writeFile(path.join(dir, 'secret.txt'), SENTINEL, 'utf8');
  await materializeRun(runsDir, {
    runId: RUN,
    events: [{ round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T }],
  });
  const manifestPath = runPaths(runsDir, RUN).manifest;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { workspace: { cwd: string } };
  manifest.workspace.cwd = dir;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const instance = await startCockpit({ runsDir, port: 0 });
  const port = instance.server.port;
  const cookie = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${String(port)}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''));
    });
    req.on('error', reject);
    req.end();
  });

  const root = path.join(resolveCockpitDataRoot(runsDir).controlDir, OPERATIONS_DIR_NAME);

  return {
    instance,
    runsDir,
    dir,
    port,
    cookie,
    get: (target, headers = {}) =>
      send(port, 'GET', target, { Host: `127.0.0.1:${String(port)}`, Cookie: cookie, ...headers }),
    post(target, payload, options = {}) {
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${String(port)}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Idempotency-Key': options.key ?? 'cle-securite-00001',
      };
      const suppliedCookie = options.cookie === undefined ? cookie : options.cookie;
      if (suppliedCookie.length > 0) headers['Cookie'] = suppliedCookie;
      if (options.origin !== null) headers['Origin'] = options.origin ?? `http://127.0.0.1:${String(port)}`;
      return send(port, 'POST', target, headers, body);
    },
    async operations() {
      const found: string[] = [];
      const walk = async (current: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) await walk(full);
          else found.push(full);
        }
      };
      await walk(root);
      return found;
    },
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

// --------------------------------------------------------------------------
// S1 — boucle locale, hôte canonique, session
// --------------------------------------------------------------------------

test('(S1) socket local, hôte canonique et session : lecture, mutation, flux', async (t) => {
  const b = await open();
  try {
    // Le socket est lié à la boucle locale, tel que le système le rapporte.
    t.diagnostic(`bind : ${b.instance.server.address}:${String(b.port)}`);
    assert.equal(b.instance.server.address, '127.0.0.1', 'le cockpit n’écoute pas ailleurs');

    // Une autorité non canonique n'apprend rien de la surface — même avec une
    // session valide, et sur les trois familles de routes.
    for (const [label, method, target] of [
      ['lecture', 'GET', `/api/runs/${RUN}`],
      ['mutation', 'POST', `/api/runs/${RUN}/pause`],
      ['flux', 'GET', `/api/runs/${RUN}/stream`],
    ] as const) {
      const foreign = await send(b.port, method, target, { Host: 'ccr.local', Cookie: b.cookie });
      t.diagnostic(`${label} · hôte étranger → ${String(foreign.status)}`);
      assert.equal(foreign.status, 403, label);
      assert.equal(JSON.parse(foreign.raw).error.code, 'INVALID_HOST', label);
    }

    // Sans session, rien ne s'ouvre — pas davantage un flux qu'une lecture.
    for (const [label, method, target] of [
      ['lecture', 'GET', `/api/runs/${RUN}`],
      ['flux', 'GET', `/api/runs/${RUN}/stream`],
      ['flux global', 'GET', '/api/stream'],
      ['asset', 'GET', '/assets/app.js'],
    ] as const) {
      const anonymous = await send(b.port, method, target, { Host: `127.0.0.1:${String(b.port)}` });
      t.diagnostic(`${label} · sans session → ${String(anonymous.status)}`);
      assert.equal(anonymous.status, 401, label);
    }

    // Une mutation sans session est refusée avant même la question de l'origine.
    const mutation = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: (await readStableRunSnapshot(b.runsDir, RUN)).revision }, { cookie: '' });
    t.diagnostic(`mutation · sans session → ${String(mutation.status)} ${String(JSON.parse(mutation.raw).error.code)}`);
    assert.equal(mutation.status, 401);
    assert.deepEqual(await b.operations(), [], 'aucune revendication pour une requête non authentifiée');

    // Le shell, lui, est le seul document servi sans session : il ne contient
    // aucune donnée CCR, et c'est lui qui la pose.
    const shell = await send(b.port, 'GET', '/', { Host: `127.0.0.1:${String(b.port)}` });
    assert.equal(shell.status, 200);
    assert.match(String(shell.headers['set-cookie']?.[0] ?? ''), /HttpOnly/);
    assert.equal(shell.raw.includes(RUN), false, 'aucune donnée CCR injectée dans le shell');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// S2 — origine exacte, sinon rien
// --------------------------------------------------------------------------

test('(S2) origine : absente, nulle ou étrangère → aucun effet, aucune revendication', async (t) => {
  const b = await open();
  try {
    const before = await readStableRunSnapshot(b.runsDir, RUN);
    const stateBefore = await readFile(runPaths(b.runsDir, RUN).state, 'utf8');

    const refusals = [
      ['absente', null],
      ['nulle', 'null'],
      ['étrangère', 'http://evil.example'],
      ['bon hôte, autre port', `http://127.0.0.1:${String(b.port + 1)}`],
      ['bon port, autre schéma', `https://127.0.0.1:${String(b.port)}`],
    ] as const;

    let index = 0;
    for (const [label, origin] of refusals) {
      index += 1;
      const key = `cle-origine-${String(index).padStart(5, '0')}`;
      const result = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: before.revision }, { key, origin });
      t.diagnostic(`origine ${label} → ${String(result.status)} ${String(JSON.parse(result.raw).error.code)}`);
      assert.equal(result.status, 403, label);
      assert.equal(JSON.parse(result.raw).error.code, 'INVALID_ORIGIN', label);
    }

    // Le refus précède la revendication durable : aucune clé n'est consommée,
    // et rien n'a été écrit.
    assert.deepEqual(await b.operations(), [], 'une revendication a survécu à un refus d’origine');
    assert.equal(await readFile(runPaths(b.runsDir, RUN).state, 'utf8'), stateBefore, 'état modifié');
    assert.equal((await readStableRunSnapshot(b.runsDir, RUN)).revision, before.revision);

    // Avec l'origine exacte, le chemin normal s'ouvre.
    const accepted = await b.post(`/api/runs/${RUN}/pause`, { expected_revision: before.revision }, { key: 'cle-origine-exacte' });
    t.diagnostic(`origine exacte → ${String(accepted.status)} ${String(JSON.parse(accepted.raw).status)}`);
    assert.equal(accepted.status, 200, accepted.raw);
    assert.equal(JSON.parse(accepted.raw).status, 'SUCCEEDED');
    assert.equal((await b.operations()).length, 1, 'exactement une revendication, celle qui a abouti');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// S3 — identifiants et capacités hostiles
// --------------------------------------------------------------------------

test('(S3) identifiants hostiles : rien hors du répertoire des runs', async (t) => {
  const b = await open();
  try {
    assert.equal(existsSync(path.join(b.dir, 'secret.txt')), true, 'la sentinelle existe');

    const hostile = [
      '../secret.txt',
      '..%2Fsecret.txt',
      '..%252Fsecret.txt',
      '%2e%2e%2fsecret.txt',
      'CCR-20260402-001%2F..%2F..%2Fsecret.txt',
      'CCR-20260402-001/../../secret.txt',
      '....//secret.txt',
      'CCR-20260402-001%00',
      'C:%5CWindows%5Cwin.ini',
    ];

    const observed: string[] = [];
    for (const identifier of hostile) {
      for (const suffix of ['', '/timeline', '/recovery', '/stream']) {
        const result = await b.get(`/api/runs/${identifier}${suffix}`);
        observed.push(`${String(result.status)}`);
        assert.ok(result.status === 400 || result.status === 404, `${identifier}${suffix} → ${String(result.status)}`);
        assert.equal(result.raw.includes(SENTINEL), false, `contenu hors runsDir rendu : ${identifier}`);
        // Aucun chemin brut ne fuit : ni séparateur système, ni racine.
        assert.equal(/[A-Za-z]:\\|\/tmp\/|runs[\\/]/.test(result.raw), false, `chemin brut dans l’erreur : ${result.raw.slice(0, 120)}`);
      }
    }
    t.diagnostic(`${String(hostile.length * 4)} formes hostiles → statuts ${[...new Set(observed)].join(', ')}`);

    // Capacité de reprise inconnue : une table close, pas un chemin.
    for (const capability of ['inconnue', '../pause', '..%2Fpause', 'clear-stale-lock/../step']) {
      const result = await b.post(`/api/runs/${RUN}/recovery/${capability}`, { expected_revision: 'x' }, { key: 'cle-capacite-00001' });
      t.diagnostic(`capacité « ${capability} » → ${String(result.status)}`);
      assert.ok(result.status === 400 || result.status === 404, capability);
      assert.equal(result.raw.includes(SENTINEL), false);
    }

    // Et un identifiant d'opération n'est pas davantage un chemin.
    for (const operation of ['../../secret.txt', 'op_..%2F..%2Fsecret.txt', 'op_zzz']) {
      const result = await b.get(`/api/operations/${operation}`);
      assert.ok(result.status === 400 || result.status === 404, operation);
      assert.equal(result.raw.includes(SENTINEL), false);
    }

    assert.deepEqual(await b.operations(), [], 'aucune revendication produite par une forme hostile');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// S4 — reçus, flux et erreurs publiques
// --------------------------------------------------------------------------

test('(S4) aucun secret dans un reçu, un flux ou une erreur publique', async (t) => {
  const b = await open();
  const KEY = 'cle-secrete-4f7a2c';
  const DECISION = 'TEXTE-DE-DECISION-CONFIDENTIEL-9b3e';
  try {
    // Un flux ouvert pendant la mutation : il verra passer l'invalidation.
    const frames: string[] = [];
    const stream = await new Promise<{ close(): void }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: b.port, path: `/api/runs/${RUN}/stream`, headers: { Host: `127.0.0.1:${String(b.port)}`, Cookie: b.cookie } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => frames.push(chunk));
          resolve({ close: () => req.destroy() });
        },
      );
      req.on('error', reject);
      req.end();
    });

    const revision = (await readStableRunSnapshot(b.runsDir, RUN)).revision;
    const decided = await b.post(`/api/runs/${RUN}/decide`, { expected_revision: revision, content: DECISION }, { key: KEY });
    assert.equal(decided.status, 200, decided.raw);

    // Laisse une invalidation arriver, puis referme.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    stream.close();

    // 1. Le reçu, tel qu'il est publié **et** tel qu'il est persisté.
    const receiptId = `op_${createHash('sha256').update(KEY, 'utf8').digest('hex')}`;
    const published = await b.get(`/api/operations/${receiptId}`);
    const files = await b.operations();
    const persisted = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
    t.diagnostic(`reçu publié : ${published.raw}`);

    // 2. Une erreur publique, provoquée sur une vue périmée.
    const failed = await b.post(`/api/runs/${RUN}/decide`, { expected_revision: `sha256:${'0'.repeat(64)}`, content: DECISION }, { key: 'cle-perimee-000001' });
    t.diagnostic(`erreur publique : ${failed.raw}`);
    assert.equal(failed.status, 409);
    assert.deepEqual(Object.keys(JSON.parse(failed.raw)).sort(), ['error', 'operation_id']);
    assert.deepEqual(Object.keys(JSON.parse(failed.raw).error).sort(), ['code', 'message']);

    const surfaces = [
      ['reçu publié', published.raw],
      ['reçu persisté', persisted],
      ['flux', frames.join('')],
      ['erreur publique', failed.raw],
    ] as const;

    const secrets = [
      [KEY, 'clé d’idempotence brute'],
      [DECISION, 'texte de décision'],
      [b.cookie, 'cookie de session'],
      [b.dir, 'chemin du poste'],
      ['stderr', 'sortie fournisseur'],
      ['lock_id', 'identité brute de verrou'],
      ['pid', 'processus'],
      ['hostname', 'nom d’hôte'],
    ] as const;

    for (const [where, content] of surfaces) {
      assert.ok(content.length > 0, `${where} : rien à inspecter`);
      for (const [secret, what] of secrets) {
        assert.equal(content.includes(secret), false, `${what} présent dans ${where}`);
      }
    }
    t.diagnostic(`quatre surfaces inspectées, huit secrets recherchés — aucun trouvé`);

    // 3. Et le texte est bien allé où il devait : dans le journal canonique.
    const decisions = await readFile(runPaths(b.runsDir, RUN).decisions, 'utf8');
    assert.ok(decisions.includes(DECISION), 'la décision est journalisée');

    // 4. Le flux a bien porté une invalidation, et rien d'autre.
    const messages = frames.join('').split('\n\n').filter((frame) => frame.startsWith('data: '));
    assert.ok(messages.length >= 1, 'le flux a émis');
    for (const frame of messages) {
      const message = JSON.parse(frame.slice(6)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(message).sort(), ['at', 'resource', 'run_id', 'type']);
    }

    // 5. Aucun en-tête CORS, sur aucune des trois familles de réponses.
    for (const [label, headers] of [
      ['lecture', (await b.get(`/api/runs/${RUN}`)).headers],
      ['reçu', published.headers],
      ['erreur', failed.headers],
    ] as const) {
      for (const header of ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods']) {
        assert.equal(headers[header], undefined, `${label} porte ${header}`);
      }
    }
  } finally {
    await b.cleanup();
  }
});
