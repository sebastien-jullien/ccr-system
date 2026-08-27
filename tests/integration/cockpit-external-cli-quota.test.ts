/**
 * Le quota du cockpit n'est pas une autorité globale sur CCR.
 *
 * `LongOperationManager` borne à deux les opérations longues **de cette
 * instance de serveur**. Rien de plus. Un `ccr step` lancé au terminal, dans un
 * autre processus, sur le même data root, ne consomme aucun créneau et n'est
 * jamais refusé par `COCKPIT_BUSY`.
 *
 * L'argument structurel existait déjà — `createLongOperationManager` n'est
 * appelé que par `cockpit-service`, et le chemin CLI ne l'importe même pas.
 * Un argument structurel n'est pas une observation : ce fichier fait tourner
 * de **vrais processus**.
 *
 * ```text
 * processus A   le serveur cockpit
 * processus B   node bin/ccr.mjs step …      ← vraie CLI, vrai .ccr.lock
 * ```
 *
 * Le fournisseur est contrôlé par la couture de production déjà documentée —
 * `CCR_CLAUDE_BIN` / `CCR_CODEX_BIN` — pointée sur un exécutable qui bloque
 * jusqu'à ce que le test l'autorise à répondre. Aucun contrat de la CLI n'est
 * modifié, et aucun appel fournisseur n'est dépensé.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { readRunLock } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';

const CCR_BIN = fileURLToPath(new URL('../../bin/ccr.mjs', import.meta.url));
const GATED_AGENT = fileURLToPath(new URL('../fixtures/gated-agent.mjs', import.meta.url));

const R_EXT = 'CCR-20260402-001';
const R_C1 = 'CCR-20260808-002';
const R_C2 = 'CCR-20260808-003';
const R_C3 = 'CCR-20260808-004';

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Un run utilisable par une **vraie** CLI.
 *
 * La fixture partagée pointe `workspace.cwd` sur un chemin d'exemple qui
 * n'existe pas : sans effet quand l'adaptateur est une doublure en mémoire,
 * fatal dès qu'un processus doit réellement y être lancé.
 */
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

interface External {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
  exitCode: number | null;
}

/** Lance la vraie CLI CCR dans un processus séparé. */
function launchCli(args: readonly string[], gateDir: string, home: string): External {
  const child = spawn(process.execPath, [CCR_BIN, ...args], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CCR_CLAUDE_BIN: GATED_AGENT,
      CCR_CODEX_BIN: GATED_AGENT,
      CCR_GATE_DIR: gateDir,
    },
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8');
  });
  const external: External = {
    child,
    stdout: () => out,
    stderr: () => err,
    exitCode: null,
    exited: new Promise<number | null>((resolve) => {
      child.on('exit', (code) => {
        external.exitCode = code;
        resolve(code);
      });
    }),
  };
  return external;
}

/**
 * Attend que `minimum` exécutables d'agent contrôlés soient réellement entrés.
 *
 * Le marqueur est écrit par le fournisseur lui-même : sa présence prouve qu'un
 * processus d'agent a été lancé et attend, et non qu'une requête a été acceptée.
 */
async function waitForProviders(
  gateDir: string,
  minimum = 1,
  deadlineMs = 60_000,
): Promise<Record<string, unknown>[]> {
  const started = process.hrtime.bigint();
  for (;;) {
    const entries = (await readdir(gateDir)).filter((name) => name.startsWith('started-'));
    if (entries.length >= minimum) {
      const parsed: Record<string, unknown>[] = [];
      for (const name of entries) {
        parsed.push(JSON.parse(await readFile(path.join(gateDir, name), 'utf8')) as Record<string, unknown>);
      }
      return parsed;
    }
    if (Number(process.hrtime.bigint() - started) / 1e6 > deadlineMs) {
      throw new Error(`fournisseurs contrôlés attendus : ${String(minimum)}, observés : ${String(entries.length)}`);
    }
    await sleep(25);
  }
}

// --------------------------------------------------------------------------
// P2-A — l'externe d'abord
// --------------------------------------------------------------------------

test(
  '(X1) une opération longue de CLI externe ne consomme aucun créneau cockpit',
  { timeout: 300_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-extquota-a-');
    const runsDir = path.join(dir, 'runs');
    const gateDir = path.join(dir, 'gate');
    const home = path.join(dir, 'home');
    const workspace = path.join(dir, 'workspace');
    for (const target of [runsDir, gateDir, home, workspace]) await mkdir(target, { recursive: true });
    for (const runId of [R_EXT, R_C1, R_C2, R_C3]) await seedRun(runsDir, runId, workspace);

    // Le cockpit garde ses propres doublures : ce qui est éprouvé ici est la
    // séparation des quotas, pas une seconde fois le chemin fournisseur.
    let openBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const adapters: AgentAdapters = {
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', onCall: () => barrier }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', onCall: () => barrier }),
    };

    const cockpit = await startCockpit({ runsDir, port: 0, depsOverrides: { createAdapters: () => adapters } });
    const port = cockpit.server.port;
    const cookie = await cookieOf(port);
    const get = (target: string): Promise<Result> =>
      http(port, 'GET', target, { Host: `127.0.0.1:${String(port)}`, Cookie: cookie });
    const post = async (runId: string, key: string): Promise<Result> => {
      const revision = (await readStableRunSnapshot(runsDir, runId)).revision;
      const body = JSON.stringify({ expected_revision: revision });
      return http(port, 'POST', `/api/runs/${runId}/step`, {
        Host: `127.0.0.1:${String(port)}`,
        Origin: `http://127.0.0.1:${String(port)}`,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Idempotency-Key': key,
      }, body);
    };

    let external: External | undefined;
    try {
      // Même data root pour les deux processus — vérifié, pas supposé.
      const canonical = resolveCockpitDataRoot(runsDir).dataRoot;
      assert.equal(path.resolve(cockpit.dataRoot.dataRoot), path.resolve(canonical));

      // ---- processus B : la vraie CLI, sur R-EXT -----------------------
      external = launchCli(['step', '--run', R_EXT, '--runs-dir', runsDir], gateDir, home);
      const providers = await waitForProviders(gateDir, 1);
      t.diagnostic(`CLI externe PID=${String(external.child.pid)} · commande=step --run ${R_EXT}`);
      t.diagnostic(`fournisseur contrôlé atteint : ${JSON.stringify(providers[0]?.['kind'])} PID=${String(providers[0]?.['pid'])}`);
      assert.equal(providers.length, 1, 'un seul fournisseur en vol');

      // L'opération externe est active : elle tient le verrou de R-EXT, et
      // le PID inscrit est bien celui du processus CLI, pas celui du test.
      const lock = await readRunLock(runPaths(runsDir, R_EXT));
      t.diagnostic(`verrou R-EXT : pid=${String(lock?.pid)} commande=${String(lock?.command)} (test pid=${String(process.pid)})`);
      assert.ok(lock !== undefined, 'le run externe est verrouillé');
      assert.equal(lock.pid, external.child.pid, 'le verrou appartient au processus CLI');
      assert.equal(lock.command, 'step');
      assert.notEqual(lock.pid, process.pid);
      assert.equal(external.exitCode, null, 'le processus externe tourne encore');

      // ---- le cockpit VOIT l'opération externe --------------------------
      //
      // C'est l'assertion qui empêche cette preuve d'être vide. `active_count`
      // à zéro serait vrai même si la CLI externe n'existait pas : le compteur
      // est un `Set` local au processus. Ce qui a du contenu, c'est que le
      // cockpit dispose de l'évidence — il lit le verrou, il le classe, il
      // l'affiche — et choisit malgré tout de ne pas la compter dans son quota.
      const seenView = await get(`/api/runs/${R_EXT}`);
      const seen = seenView.body['liveness'] as { liveness: string; basis: string };
      t.diagnostic(`read model cockpit sur R-EXT : vivacité=${seen.liveness} · fondement=${seen.basis}`);
      assert.equal(seenView.status, 200, seenView.raw);
      assert.notEqual(seen.liveness, 'NONE', 'le cockpit observe bien une activité sur R-EXT');
      assert.equal(seen.basis, 'LOCK_HELD_BY_OTHER_PROCESS', 'et il sait qu’elle vient d’un autre processus');

      // ---- le quota cockpit l'ignore malgré tout ------------------------
      t.diagnostic(`cockpit active_count avant = ${String(cockpit.manager.activeCount())}`);
      assert.equal(cockpit.manager.activeCount(), 0, 'aucun créneau cockpit consommé par la CLI externe');
      assert.equal(cockpit.manager.admitAttempts(), 0, 'aucun créneau même demandé');

      // Témoin de vivacité, relevé à chaque étape : trois preuves croisées —
      // le processus vit, le verrou lui appartient, le fournisseur attend.
      const stillAlive = async (label: string): Promise<void> => {
        const held = await readRunLock(runPaths(runsDir, R_EXT));
        const markers = (await readdir(gateDir)).filter((name) => name.startsWith('started-'));
        t.diagnostic(
          `[${label}] externe vivante : pid=${String(external?.exitCode === null)} · ` +
            `verrou=${String(held?.pid === external?.child.pid)} · fournisseurs=${String(markers.length)}`,
        );
        assert.equal(external?.exitCode, null, `[${label}] le processus externe tourne encore`);
        assert.equal(held?.pid, external?.child.pid, `[${label}] il tient toujours le verrou de R-EXT`);
        assert.equal(markers.length, 1, `[${label}] son fournisseur attend toujours`);
      };

      // ---- contrôle négatif : le MÊME run reste protégé par le verrou ---
      const attemptsBefore = cockpit.manager.admitAttempts();
      const sameRun = await post(R_EXT, 'cle-meme-run-0001');
      t.diagnostic(`cockpit sur R-EXT → ${String(sameRun.status)} ${String((sameRun.body['error'] as { code?: string } | undefined)?.code)}`);
      assert.equal(sameRun.status, 409, sameRun.raw);
      assert.equal((sameRun.body['error'] as { code: string }).code, 'RUN_ALREADY_LOCKED');
      assert.equal(cockpit.manager.admitAttempts() - attemptsBefore, 0, 'refus par le verrou, avant toute admission');
      assert.equal(cockpit.manager.activeCount(), 0);

      // ---- deux longues cockpit : c'est bien elles qui saturent ---------
      await stillAlive('avant op1');
      const first = await post(R_C1, 'cle-cockpit-00001');
      t.diagnostic(`cockpit op1 (${R_C1}) → ${String(first.status)} · active_count = ${String(cockpit.manager.activeCount())}`);
      assert.equal(first.status, 202, first.raw);
      assert.equal(cockpit.manager.activeCount(), 1);

      await stillAlive('entre op1 et op2');
      const second = await post(R_C2, 'cle-cockpit-00002');
      t.diagnostic(`cockpit op2 (${R_C2}) → ${String(second.status)} · active_count = ${String(cockpit.manager.activeCount())}`);
      assert.equal(second.status, 202, second.raw);
      assert.equal(cockpit.manager.activeCount(), 2, 'les deux créneaux sont pris par le cockpit seul');

      // L'externe est toujours en vol au moment même de ces assertions.
      await stillAlive('après op2');

      // ---- la troisième cockpit est refusée ----------------------------
      const third = await post(R_C3, 'cle-cockpit-00003');
      t.diagnostic(`cockpit op3 (${R_C3}) → ${String(third.status)} ${String((third.body['error'] as { code?: string } | undefined)?.code)}`);
      assert.equal(third.status, 503, third.raw);
      assert.equal((third.body['error'] as { code: string }).code, 'COCKPIT_BUSY');

      // ---- libération ordonnée -----------------------------------------
      await writeFile(path.join(gateDir, 'release'), '', 'utf8');
      const code = await external.exited;
      t.diagnostic(`CLI externe terminée : code=${String(code)} · stdout=${external.stdout().trim().split('\n').pop() ?? ''}`);
      assert.equal(code, 0, external.stderr());
      assert.equal(cockpit.manager.activeCount(), 2, 'la fin de l’externe ne rend aucun créneau cockpit');
    } finally {
      openBarrier();
      await writeFile(path.join(gateDir, 'release'), '', 'utf8').catch(() => undefined);
      if (external !== undefined) await external.exited.catch(() => undefined);
      await cockpit.stop();
      await removeTempDir(dir);
    }
  },
);

// --------------------------------------------------------------------------
// P2-B — le cockpit d'abord, et cette fois le serveur est lui aussi un
// processus séparé : `node bin/ccr.mjs cockpit`.
// --------------------------------------------------------------------------

test(
  '(X2) cockpit saturé dans son propre processus : une CLI externe passe quand même',
  { timeout: 300_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-extquota-b-');
    const runsDir = path.join(dir, 'runs');
    const gateDir = path.join(dir, 'gate');
    const home = path.join(dir, 'home');
    const workspace = path.join(dir, 'workspace');
    for (const target of [runsDir, gateDir, home, workspace]) await mkdir(target, { recursive: true });
    for (const runId of [R_EXT, R_C1, R_C2, R_C3]) await seedRun(runsDir, runId, workspace);

    // Processus A : le vrai serveur, lancé par la vraie commande.
    const server = launchCli(['cockpit', '--runs-dir', runsDir, '--port', '0'], gateDir, home);
    let external: External | undefined;
    try {
      const started = process.hrtime.bigint();
      let url = '';
      while (url === '') {
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(server.stdout());
        if (match !== null) url = match[0];
        else if (Number(process.hrtime.bigint() - started) / 1e6 > 60_000) {
          throw new Error(`le cockpit n’a pas démarré : ${server.stderr()}`);
        } else await sleep(50);
      }
      const port = Number(new URL(url).port);
      t.diagnostic(`cockpit PID=${String(server.child.pid)} · ${url}`);
      assert.notEqual(server.child.pid, process.pid);

      const cookie = await cookieOf(port);
      const post = async (runId: string, key: string): Promise<Result> => {
        const revision = (await readStableRunSnapshot(runsDir, runId)).revision;
        const body = JSON.stringify({ expected_revision: revision });
        return http(port, 'POST', `/api/runs/${runId}/step`, {
          Host: `127.0.0.1:${String(port)}`,
          Origin: `http://127.0.0.1:${String(port)}`,
          Cookie: cookie,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body, 'utf8')),
          'Idempotency-Key': key,
        }, body);
      };

      // Deux longues cockpit, bloquées sur le fournisseur contrôlé.
      const first = await post(R_C1, 'cle-serveur-00001');
      const second = await post(R_C2, 'cle-serveur-00002');
      assert.equal(first.status, 202, first.raw);
      assert.equal(second.status, 202, second.raw);
      const providers = await waitForProviders(gateDir, 2);
      const startedBefore = providers.length;
      t.diagnostic(`fournisseurs cockpit en vol : ${String(startedBefore)}`);
      assert.equal(startedBefore, 2, 'les deux opérations cockpit atteignent réellement leur fournisseur');

      // Saturation constatée depuis la surface publique — pas depuis un champ
      // interne : ce processus-ci n'a aucun accès au manager du serveur.
      const refused = await post(R_C3, 'cle-serveur-00003');
      t.diagnostic(`cockpit op3 → ${String(refused.status)} ${String((refused.body['error'] as { code?: string } | undefined)?.code)}`);
      assert.equal(refused.status, 503, refused.raw);
      assert.equal((refused.body['error'] as { code: string }).code, 'COCKPIT_BUSY');

      // Processus B : la CLI externe, pendant que le quota est saturé.
      external = launchCli(['step', '--run', R_EXT, '--runs-dir', runsDir], gateDir, home);
      const after = await (async (): Promise<Record<string, unknown>[]> => {
        const limit = process.hrtime.bigint();
        for (;;) {
          const seen = await waitForProviders(gateDir, 1);
          if (seen.length > startedBefore) return seen;
          if (external?.exitCode !== null) {
            throw new Error(`la CLI externe a fini sans atteindre son fournisseur : ${external?.stderr() ?? ''}`);
          }
          if (Number(process.hrtime.bigint() - limit) / 1e6 > 60_000) {
            throw new Error('la CLI externe n’a jamais atteint son fournisseur');
          }
          await sleep(25);
        }
      })();
      t.diagnostic(`CLI externe PID=${String(external.child.pid)} · fournisseurs en vol = ${String(after.length)}`);
      assert.equal(after.length, 3, 'trois fournisseurs simultanés : deux cockpit, un CLI externe');

      const lock = await readRunLock(runPaths(runsDir, R_EXT));
      t.diagnostic(`verrou R-EXT : pid=${String(lock?.pid)} (cockpit pid=${String(server.child.pid)})`);
      assert.equal(lock?.pid, external.child.pid, 'le run externe appartient au processus CLI');
      assert.notEqual(lock?.pid, server.child.pid);

      await writeFile(path.join(gateDir, 'release'), '', 'utf8');
      const code = await external.exited;
      t.diagnostic(`CLI externe terminée : code=${String(code)}`);
      assert.equal(code, 0, `${external.stdout()}\n${external.stderr()}`);
      assert.equal(
        /COCKPIT_BUSY/.test(external.stdout() + external.stderr()),
        false,
        'la CLI externe n’a jamais vu le quota du cockpit',
      );
    } finally {
      await writeFile(path.join(gateDir, 'release'), '', 'utf8').catch(() => undefined);
      if (external !== undefined) await external.exited.catch(() => undefined);
      server.child.kill();
      await server.exited.catch(() => undefined);
      await removeTempDir(dir);
    }
  },
);
