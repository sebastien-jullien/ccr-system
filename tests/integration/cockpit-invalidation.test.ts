/**
 * Concurrence externe — le cockpit n'est pas le seul à écrire (Slice 8).
 *
 * `ccr pause` lancé au terminal ne partage aucune mémoire avec le serveur. Ce
 * qui les relie est le disque, et rien d'autre. Le flux d'invalidation dit une
 * seule chose — *quelque chose concernant ce run a changé* — et le client va
 * relire la vérité là où elle est écrite.
 *
 * ```text
 * E1  mutation CLI réelle    → invalidation, puis état canonique du CLI
 * E2  verrou externe         → invalidation sans changement de révision
 * E3  rien ne change         → aucune invalidation
 * E4  reconnexion            → invalidation inconditionnelle, puis refetch
 * E5  charge utile           → une ressource, un instant, rien d'autre
 * E6  session et surface     → aucune exception pour EventSource
 * E7  personne ne regarde    → aucune observation
 * ```
 *
 * La CLI de `E1` est le vrai binaire du dépôt, dans un vrai processus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const CLI = fileURLToPath(new URL('../../bin/ccr.mjs', import.meta.url));
const RUN = 'CCR-20260402-001';
/** Cadence resserrée pour les preuves ; la production tient §22.4 à 2 s. */
const TICK_MS = 150;

interface Streamed {
  readonly messages: Record<string, unknown>[];
  readonly response: IncomingMessage;
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  close(): void;
}

/**
 * Ouvre un flux et accumule ses messages.
 *
 * Aucune attente aveugle : `waitFor` se résout dès qu'un message arrive, et ne
 * rend la main sur un délai que pour signaler un échec.
 */
function openStream(port: number, cookie: string, target: string): Promise<Streamed> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: target, method: 'GET', headers: { Host: `127.0.0.1:${String(port)}`, Cookie: cookie, Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`flux refusé : ${String(res.statusCode)}`));
          return;
        }
        const messages: Record<string, unknown>[] = [];
        const waiters: { count: number; resolve: () => void }[] = [];
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf('\n\n');
          while (index !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
            if (line !== undefined) {
              messages.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
              for (const waiter of [...waiters]) {
                if (messages.length >= waiter.count) {
                  waiters.splice(waiters.indexOf(waiter), 1);
                  waiter.resolve();
                }
              }
            }
            index = buffer.indexOf('\n\n');
          }
        });
        resolve({
          messages,
          response: res,
          waitFor(count, timeoutMs = 10_000) {
            if (messages.length >= count) return Promise.resolve();
            return new Promise<void>((done, fail) => {
              const timer = setTimeout(() => fail(new Error(`aucun message ${String(count)} en ${String(timeoutMs)} ms`)), timeoutMs);
              waiters.push({
                count,
                resolve: () => {
                  clearTimeout(timer);
                  done();
                },
              });
            });
          },
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function get(port: number, cookie: string, target: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, headers: { Host: `127.0.0.1:${String(port)}`, Cookie: cookie } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

interface Box {
  readonly instance: CockpitInstance;
  readonly runsDir: string;
  readonly port: number;
  readonly cookie: string;
  readonly reconciliations: () => number;
  cleanup(): Promise<void>;
}

async function open(options: { readonly withPending?: boolean } = {}): Promise<Box> {
  const dir = await makeTempDir('ccr-invalidation-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: RUN,
    events: [{ round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T }],
  });
  const manifestPath = runPaths(runsDir, RUN).manifest;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { workspace: { cwd: string } };
  manifest.workspace.cwd = dir;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  void options;

  let reconciliations = 0;
  const instance = await startCockpit({
    runsDir,
    port: 0,
    reconciliationIntervalMs: TICK_MS,
    onReconciled: () => {
      reconciliations += 1;
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
    port,
    cookie,
    reconciliations: () => reconciliations,
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

// --------------------------------------------------------------------------
// E1 — une vraie commande CLI, dans un vrai processus
// --------------------------------------------------------------------------

test('(E1) une mutation CLI externe est vue par le cockpit', async (t) => {
  const b = await open();
  try {
    const before = await readStableRunSnapshot(b.runsDir, RUN);
    const stream = await openStream(b.port, b.cookie, `/api/runs/${RUN}/stream`);
    await stream.waitFor(1);
    assert.equal(stream.messages.length, 1, 'une invalidation à la connexion');

    // Le vrai binaire, dans un processus séparé. Aucune mémoire partagée.
    const started = process.hrtime.bigint();
    const cli = spawn(process.execPath, [CLI, 'pause', '--run', RUN, '--runs-dir', b.runsDir], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cliOut = '';
    cli.stdout?.on('data', (chunk: Buffer) => (cliOut += chunk.toString('utf8')));
    cli.stderr?.on('data', (chunk: Buffer) => (cliOut += chunk.toString('utf8')));
    const code = await new Promise<number>((resolve) => cli.on('close', (value) => resolve(value ?? -1)));
    t.diagnostic(`CLI \`ccr pause\` → code ${String(code)}`);
    assert.equal(code, 0, cliOut);

    await stream.waitFor(2, 5_000);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    t.diagnostic(`invalidation reçue ${elapsed.toFixed(0)} ms après le lancement de la CLI`);

    const message = stream.messages[1] ?? {};
    assert.equal(message['resource'], 'run');
    assert.equal(message['run_id'], RUN);

    // Le client relit — et trouve exactement ce que la CLI a écrit.
    const view = await get(b.port, b.cookie, `/api/runs/${RUN}`);
    const after = await readStableRunSnapshot(b.runsDir, RUN);
    const projected = view.body['state'] as { state?: string; control?: string } | undefined;
    t.diagnostic(`état après refetch : ${String(projected?.state)}/${String(projected?.control)} · révision changée=${String(after.revision !== before.revision)}`);
    assert.equal(view.status, 200);
    assert.equal(projected?.state, 'PAUSED');
    assert.equal(projected?.control, 'HUMAN');
    assert.notEqual(after.revision, before.revision);
    assert.ok(elapsed < 3_000, `visibilité en ${elapsed.toFixed(0)} ms (budget 3 000 ms)`);

    stream.close();
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// E2 — un verrou externe ne change aucune révision
// --------------------------------------------------------------------------

test('(E2) l’apparition et la disparition d’un verrou invalident aussi', async (t) => {
  const b = await open();
  let holder: ChildProcess | undefined;
  try {
    const before = await readStableRunSnapshot(b.runsDir, RUN);
    const stream = await openStream(b.port, b.cookie, `/api/runs/${RUN}/stream`);
    await stream.waitFor(1);

    holder = spawn(process.execPath, ['tests/fixtures/hold-run-lock.mjs', b.runsDir, RUN, 'step'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve, reject) => {
      holder?.stdout?.once('data', () => resolve());
      holder?.once('error', reject);
    });

    await stream.waitFor(2, 5_000);
    const afterLock = await readStableRunSnapshot(b.runsDir, RUN);
    const recovery = await get(b.port, b.cookie, `/api/runs/${RUN}/recovery`);
    const liveness = recovery.body['liveness'] as { lock_observation?: string } | undefined;
    t.diagnostic(`verrou posé → invalidation · révision inchangée=${String(afterLock.revision === before.revision)} · observation=${String(liveness?.lock_observation)}`);

    // C'est le point : la révision canonique n'a pas bougé, et pourtant la vue
    // de reprise a changé. Un discriminant purement canonique manquerait ce cas.
    assert.equal(afterLock.revision, before.revision, 'aucun fait canonique modifié');
    assert.equal(liveness?.lock_observation, 'ACTIVE_EXTERNAL_LOCK');

    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder?.once('exit', () => resolve()));
    const { unlink } = await import('node:fs/promises');
    const { lockFilePath } = await import('../../src/lock/run-lock.ts');
    await unlink(lockFilePath(runPaths(b.runsDir, RUN)));

    await stream.waitFor(3, 5_000);
    const released = await get(b.port, b.cookie, `/api/runs/${RUN}/recovery`);
    const after = (released.body['liveness'] as { lock_observation?: string } | undefined)?.lock_observation;
    t.diagnostic(`verrou levé → invalidation · observation=${String(after)}`);
    assert.equal(after, 'NO_LOCK');

    stream.close();
  } finally {
    holder?.kill('SIGKILL');
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// E3 — rien ne change, rien ne part
// --------------------------------------------------------------------------

test('(E3) sans changement, aucune invalidation n’est émise', async (t) => {
  const b = await open();
  try {
    const stream = await openStream(b.port, b.cookie, `/api/runs/${RUN}/stream`);
    await stream.waitFor(1);
    const reconciliationsBefore = b.reconciliations();

    // Plusieurs dizaines de tours de réconciliation, aucun changement.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const turns = b.reconciliations() - reconciliationsBefore;
    t.diagnostic(`${String(turns)} réconciliation(s) · ${String(stream.messages.length - 1)} invalidation(s) après la connexion`);
    assert.ok(turns >= 5, 'la réconciliation tourne bien');
    assert.equal(stream.messages.length, 1, 'aucune invalidation superflue');

    stream.close();
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// E4 — reconnexion
// --------------------------------------------------------------------------

test('(E4) reconnexion : invalidation inconditionnelle, puis état canonique', async (t) => {
  const b = await open();
  try {
    const first = await openStream(b.port, b.cookie, `/api/runs/${RUN}/stream`);
    await first.waitFor(1);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mutation externe **pendant** la coupure : personne ne l'écoute.
    const cli = spawn(process.execPath, [CLI, 'pause', '--run', RUN, '--runs-dir', b.runsDir], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const code = await new Promise<number>((resolve) => cli.on('close', (value) => resolve(value ?? -1)));
    assert.equal(code, 0);
    t.diagnostic('mutation CLI effectuée hors connexion');

    // Reconnexion : le serveur invalide sans condition, sans rien rejouer.
    const second = await openStream(b.port, b.cookie, `/api/runs/${RUN}/stream`);
    await second.waitFor(1, 5_000);
    t.diagnostic(`à la reconnexion : ${JSON.stringify(second.messages[0])}`);
    assert.equal(second.messages[0]?.['resource'], 'run');

    const view = await get(b.port, b.cookie, `/api/runs/${RUN}`);
    const projected = view.body['state'] as { state?: string } | undefined;
    t.diagnostic(`état après refetch : ${String(projected?.state)}`);
    assert.equal(projected?.state, 'PAUSED', 'la vue n’est pas périmée');

    second.close();
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// E5 — le flux ne transporte rien
// --------------------------------------------------------------------------

test('(E5) le flux ne transporte aucune vérité canonique', async (t) => {
  const b = await open();
  try {
    const runStream = await openStream(b.port, b.cookie, `/api/runs/${RUN}/stream`);
    const listStream = await openStream(b.port, b.cookie, '/api/stream');
    await runStream.waitFor(1);
    await listStream.waitFor(1);

    // Une mutation qui écrit du texte humain : il ne doit apparaître nulle part.
    const SECRET = 'DECISION-CONFIDENTIELLE-4f7a2c';
    const cli = spawn(process.execPath, [CLI, 'decide', SECRET, '--run', RUN, '--runs-dir', b.runsDir], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    cli.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    const code = await new Promise<number>((resolve) => cli.on('close', (value) => resolve(value ?? -1)));
    assert.equal(code, 0, err);

    await runStream.waitFor(2, 5_000);
    await listStream.waitFor(2, 5_000);

    const all = [...runStream.messages, ...listStream.messages];
    t.diagnostic(`messages observés : ${JSON.stringify(all)}`);
    for (const message of all) {
      assert.deepEqual(
        Object.keys(message).sort(),
        message['resource'] === 'run' ? ['at', 'resource', 'run_id', 'type'] : ['at', 'resource', 'type'],
        'la charge utile porte une ressource et un instant, rien d’autre',
      );
      assert.equal(message['type'], 'invalidate');
      const serialized = JSON.stringify(message);
      for (const forbidden of [SECRET, 'PAUSED', 'state', 'manifest', 'timeline', 'decision', 'session', 'lock']) {
        assert.equal(serialized.includes(forbidden), false, `${forbidden} circule dans le flux`);
      }
    }

    // Et le texte est bien allé où il devait : dans le journal canonique.
    const decisions = await readFile(runPaths(b.runsDir, RUN).decisions, 'utf8');
    assert.ok(decisions.includes(SECRET), 'la décision est journalisée');

    runStream.close();
    listStream.close();
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// E6 — aucune exception de sécurité pour le flux
// --------------------------------------------------------------------------

test('(E6) le flux exige la session et la surface canoniques', async (t) => {
  const b = await open();
  try {
    const targets = ['/api/stream', `/api/runs/${RUN}/stream`];

    for (const target of targets) {
      // Sans session : refusé comme n'importe quelle lecture.
      const denied = await get(b.port, '', target);
      t.diagnostic(`${target} sans session → ${String(denied.status)}`);
      assert.equal(denied.status, 401, target);

      // Hôte non canonique : refusé avant tout routage.
      const foreign = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: b.port, path: target, headers: { Host: 'ccr.local', Cookie: b.cookie } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
      t.diagnostic(`${target} hôte étranger → ${String(foreign)}`);
      assert.equal(foreign, 403, target);

      // Paramètre inconnu : refusé. Aucun jeton n'a de raison d'être dans l'URL.
      const withParam = await get(b.port, b.cookie, `${target}?token=abc`);
      assert.equal(withParam.status, 400, target);
    }

    // Les en-têtes du flux légitime : pas de cache, pas de reniflage de type.
    const stream = await openStream(b.port, b.cookie, `/api/runs/${RUN}/stream`);
    const headers = stream.response.headers;
    t.diagnostic(`en-têtes du flux : ${String(headers['content-type'])} · ${String(headers['cache-control'])} · ${String(headers['x-content-type-options'])}`);
    assert.match(String(headers['content-type']), /^text\/event-stream/);
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['access-control-allow-origin'], undefined, 'aucun CORS');
    stream.close();
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// E7 — personne ne regarde, rien n'est observé
// --------------------------------------------------------------------------

test('(E7) sans client, aucune observation du disque', async (t) => {
  const b = await open();
  try {
    // Aucun flux ouvert : la réconciliation ne doit pas tourner.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const idle = b.reconciliations();
    t.diagnostic(`sans client : ${String(idle)} réconciliation(s)`);
    assert.equal(idle, 0, 'le disque est observé alors que personne ne regarde');

    const stream = await openStream(b.port, b.cookie, `/api/runs/${RUN}/stream`);
    await stream.waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const watching = b.reconciliations();
    assert.ok(watching > 0, 'la réconciliation démarre avec le premier client');

    // Le client part : l'observation s'arrête avec lui.
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterClose = b.reconciliations();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const later = b.reconciliations();
    t.diagnostic(`avec client=${String(watching)} · après fermeture=${String(afterClose)} → ${String(later)}`);
    assert.equal(later, afterClose, 'l’observation continue sans client');
  } finally {
    await b.cleanup();
  }
});
