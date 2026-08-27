/**
 * IT-2B — preuves sur de **vrais processus** `ccr cockpit`.
 *
 * Ce que le test en cours de processus ne peut pas prouver :
 *
 *  - qu'un second cockpit échoue **avant** d'ouvrir son socket — la seule
 *    démonstration possible est qu'aucun serveur n'écoute sur le port qu'il
 *    avait demandé ;
 *  - qu'un arrêt brutal laisse le verrou, et que le démarrage suivant refuse ;
 *  - que le secret de session ne transite jamais par la sortie standard.
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { createServer, connect } from 'node:net';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { inspectServerLock } from '../../src/cockpit/server-lock.ts';
import { SESSION_COOKIE_NAME } from '../../src/cockpit/session.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const CLI = fileURLToPath(new URL('../../bin/ccr.mjs', import.meta.url));

interface Cockpit {
  readonly child: ChildProcess;
  readonly port: number;
  readonly url: string;
  stdout(): string;
  stderr(): string;
  /** Terminaison inconditionnelle : simule un crash, pas un arrêt propre. */
  kill(): Promise<void>;
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Exécute la CLI et attend sa sortie.
 *
 * Le délai n'est pas un confort : une commande qui **refuse** puis ne se
 * termine jamais a forcément laissé une ressource ouverte. Sans borne, ce
 * symptôme se manifesterait par un blocage anonyme ; avec elle, l'assertion qui
 * suit peut nommer la propriété réellement violée.
 */
function runCliProcess(args: readonly string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: 'pipe', shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr: `${stderr}
<processus toujours vivant après ${String(timeoutMs)} ms>` });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Lance un cockpit et attend l'URL qu'il annonce. */
function launchCockpit(runsDir: string, port: number | 'ephemeral'): Promise<Cockpit> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI, 'cockpit', '--runs-dir', runsDir, '--port', port === 'ephemeral' ? '0' : String(port)],
      { stdio: 'pipe', shell: false },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Le cockpit n'a pas démarré. stdout=${stdout} stderr=${stderr}`));
    }, 60_000);

    const closed = new Promise<void>((done) => child.on('close', () => done()));

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(stdout);
      if (match === null || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        child,
        port: Number.parseInt(match[1] ?? '0', 10),
        url: match[0],
        stdout: () => stdout,
        stderr: () => stderr,
        kill: async () => {
          child.kill('SIGKILL');
          await closed;
        },
      });
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Le cockpit s'est arrêté sans annoncer d'URL. stdout=${stdout} stderr=${stderr}`));
    });
  });
}

interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function http(
  port: number,
  requestPath: string,
  options: { host?: string; cookie?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${String(port)}` };
    if (options.cookie !== undefined) headers['Cookie'] = options.cookie;
    const req = request({ host: '127.0.0.1', port, path: requestPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** Port libre au moment de l'appel : sert de port « demandé mais jamais ouvert ». */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function boxDir(prefix: string): Promise<{ dir: string; runsDir: string }> {
  const dir = await makeTempDir(prefix);
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  return { dir, runsDir };
}

// --------------------------------------------------------------------------

test('(P1/P2) démarrage CLI réel : URL annoncée, session, API — et Host hostile refusé', async (t) => {
  const { dir, runsDir } = await boxDir('ccr-cockpit-p1-');
  const cockpit = await launchCockpit(runsDir, 'ephemeral');
  try {
    t.diagnostic(cockpit.stdout().trim().split('\n').join(' · '));

    // P1 — le navigateur visite « / », reçoit sa session, puis lit l'API.
    const bootstrap = await http(cockpit.port, '/');
    assert.equal(bootstrap.status, 200);
    const setCookie = (bootstrap.headers['set-cookie'] as string[] | undefined)?.[0] ?? '';
    assert.ok(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`));
    const cookie = setCookie.split(';')[0] ?? '';

    assert.equal((await http(cockpit.port, '/api/runs')).status, 401, 'sans cookie, rien');
    const runs = await http(cockpit.port, '/api/runs', { cookie });
    assert.equal(runs.status, 200);
    assert.deepEqual(JSON.parse(runs.body), { runs: [] });

    // P2 — Host forgé sur une connexion loopback bien réelle.
    for (const host of ['evil.example', `localhost:${String(cockpit.port)}`]) {
      const forged = await http(cockpit.port, '/api/runs', { host, cookie });
      assert.equal(forged.status, 403, `Host « ${host} »`);
    }

    // Le secret ne transite jamais par la sortie du processus.
    const secret = cookie.slice(SESSION_COOKIE_NAME.length + 1);
    assert.ok(secret.length >= 40);
    assert.equal(cockpit.stdout().includes(secret), false, 'aucun secret sur stdout');
    assert.equal(cockpit.stderr().includes(secret), false, 'aucun secret sur stderr');
    assert.equal(cockpit.url.includes(secret), false, 'aucun secret dans l’URL');
  } finally {
    await cockpit.kill();
    await removeTempDir(dir);
  }
});

test('(P3) second cockpit sur le même data root : refus AVANT d’ouvrir son port', async (t) => {
  const { dir, runsDir } = await boxDir('ccr-cockpit-p3-');
  const first = await launchCockpit(runsDir, 'ephemeral');
  try {
    const requested = await freePort();
    assert.equal(await isListening(requested), false, 'le port choisi est bien libre au départ');

    const second = await runCliProcess(['cockpit', '--runs-dir', runsDir, '--port', String(requested)]);
    t.diagnostic(`sortie du second : code=${String(second.code)} · ${second.stderr.trim().slice(0, 120)}`);

    assert.notEqual(second.code, 0, 'code de sortie non nul');
    assert.match(second.stderr, /COCKPIT_ALREADY_RUNNING/);
    // L'unicité porte sur le data root, pas sur le port : demander un autre
    // port ne change rien.
    assert.equal(await isListening(requested), false, 'aucun socket n’a été ouvert');
    // Et l'instance existante est intacte.
    assert.equal((await http(first.port, '/')).status, 200);
    // Aucun auto-join : le second n'a pas non plus renvoyé vers le premier.
    assert.equal(second.stdout.includes(first.url), false);
  } finally {
    await first.kill();
    await removeTempDir(dir);
  }
});

test('(PB) deux data roots distincts : deux cockpits simultanés', async () => {
  const a = await boxDir('ccr-cockpit-pb-a-');
  const c = await boxDir('ccr-cockpit-pb-b-');
  const first = await launchCockpit(a.runsDir, 'ephemeral');
  const second = await launchCockpit(c.runsDir, 'ephemeral');
  try {
    assert.notEqual(first.port, second.port);
    assert.equal((await http(first.port, '/')).status, 200);
    assert.equal((await http(second.port, '/')).status, 200);

    // Chaque instance possède son propre verrou et son propre secret.
    const lockA = await inspectServerLock(resolveCockpitDataRoot(a.runsDir).serverLock);
    const lockB = await inspectServerLock(resolveCockpitDataRoot(c.runsDir).serverLock);
    assert.equal(lockA.observation, 'LOCAL_LIVE');
    assert.equal(lockB.observation, 'LOCAL_LIVE');
    assert.notEqual(lockA.info?.instance_id, lockB.info?.instance_id);
  } finally {
    await first.kill();
    await second.kill();
    await removeTempDir(a.dir);
    await removeTempDir(c.dir);
  }
});

test('(P4/P5) crash → verrou survivant → refus → levée exacte → redémarrage à secret neuf', async (t) => {
  const { dir, runsDir } = await boxDir('ccr-cockpit-p5-');
  try {
    const dataRoot = resolveCockpitDataRoot(runsDir);

    // 1. Un cockpit vit, on relève sa session.
    const first = await launchCockpit(runsDir, 'ephemeral');
    const firstCookie =
      ((await http(first.port, '/')).headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const lockBefore = await inspectServerLock(dataRoot.serverLock);
    assert.equal(lockBefore.observation, 'LOCAL_LIVE');

    // 2. Terminaison inconditionnelle : aucun code de nettoyage ne s'exécute.
    await first.kill();

    // 3. Le verrou survit — comportement attendu, pas un défaut.
    const orphan = await inspectServerLock(dataRoot.serverLock);
    assert.equal(orphan.observation, 'LOCAL_STALE');
    const instanceId = orphan.info?.instance_id ?? '';
    t.diagnostic(`verrou survivant : ${instanceId}`);

    // 4. Le démarrage suivant refuse, et n'ouvre rien.
    const refused = await runCliProcess(['cockpit', '--runs-dir', runsDir, '--port', '0']);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /COCKPIT_SERVER_LOCK_STALE/);
    assert.equal(
      (await inspectServerLock(dataRoot.serverLock)).info?.instance_id,
      instanceId,
      'un refus ne supprime rien',
    );

    // 5. Une identité fausse ne lève rien.
    const wrong = await runCliProcess([
      'cockpit',
      'clear-stale-lock',
      '--runs-dir',
      runsDir,
      '--lock-id',
      'aaaaaaaa-0000-0000-0000-000000000000',
    ]);
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.stderr, /COCKPIT_SERVER_LOCK_IDENTITY_MISMATCH/);
    assert.equal((await inspectServerLock(dataRoot.serverLock)).observation, 'LOCAL_STALE');

    // 6. Levée humaine explicite, avec l'identité exacte.
    const cleared = await runCliProcess([
      'cockpit',
      'clear-stale-lock',
      '--runs-dir',
      runsDir,
      '--lock-id',
      instanceId,
    ]);
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal((await inspectServerLock(dataRoot.serverLock)).observation, 'NONE');

    // 7. Redémarrage : P4 — secret renouvelé, ancien cookie sans valeur.
    const second = await launchCockpit(runsDir, 'ephemeral');
    try {
      const newCookie =
        ((await http(second.port, '/')).headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
      assert.notEqual(newCookie, firstCookie, 'secret régénéré à chaque démarrage');
      assert.equal(
        (await http(second.port, '/api/runs', { cookie: firstCookie })).status,
        401,
        'le cookie de l’instance morte n’authentifie rien',
      );
      assert.equal((await http(second.port, '/api/runs', { cookie: newCookie })).status, 200);
    } finally {
      await second.kill();
    }

    // Le verrou de run V1 n'a jamais été touché par tout cela.
    const files = await readFile(dataRoot.serverLock, 'utf8').catch(() => null);
    assert.notEqual(files, null, 'le second cockpit a bien posé son propre verrou');
  } finally {
    await removeTempDir(dir);
  }
});

/** Tous les `server.lock` présents sous une racine, à n'importe quelle profondeur. */
async function findServerLocks(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'server.lock') found.push(full);
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * (PC) Course de création : deux cockpits démarrent **simultanément** sur un
 * data root qui n'existe pas encore.
 *
 * C'est le cas où une canonicalisation dépendante de l'instant, ou de
 * l'orthographe de l'appelant, produirait deux identités pour un seul root
 * logique — et donc deux serveurs là où l'invariant en autorise un.
 *
 * Les deux processus emploient volontairement des écritures différentes du même
 * chemin : casse distincte et détour lexical.
 */
test('(PC) deux cockpits simultanés sur un root inexistant : un seul gagne', async (t) => {
  const dir = await makeTempDir('ccr-cockpit-race-');
  try {
    const base = path.join(dir, 'parent');
    await mkdir(base, { recursive: true });
    // Ni l'un ni l'autre n'existe au moment du lancement.
    const spellingA = path.join(base, 'monroot');
    const spellingB = path.join(base, 'MONROOT', '.', 'sous', '..');

    const launch = (runsDir: string): Promise<CliResult> =>
      // Le gagnant reste vivant : la borne est ce qui met fin à son attente.
      runCliProcess(['cockpit', '--runs-dir', runsDir, '--port', '0'], 10_000);

    // Lancés dans le même tour de boucle : aucune sérialisation implicite.
    const [first, second] = await Promise.all([launch(spellingA), launch(spellingB)]);

    const outcomes = [first, second];
    const started = outcomes.filter((r) => /http:\/\/127\.0\.0\.1:\d+\//.test(r.stdout));
    const refused = outcomes.filter((r) => /COCKPIT_ALREADY_RUNNING/.test(r.stderr));

    t.diagnostic(
      `A: code=${String(first.code)} url=${String(/http:\/\/127\.0\.0\.1:\d+\//.test(first.stdout))} · ` +
        `B: code=${String(second.code)} url=${String(/http:\/\/127\.0\.0\.1:\d+\//.test(second.stdout))}`,
    );

    assert.equal(started.length, 1, 'exactement un serveur HTTP a démarré');
    assert.equal(refused.length, 1, 'exactement un refus COCKPIT_ALREADY_RUNNING');
    assert.notEqual(refused[0]?.code, 0, 'le refusé sort en code non nul');

    // La preuve décisive : un seul verrou sur tout l'arbre, pas un par
    // orthographe. Le gagnant a été tué par la borne de `runCliProcess`, donc
    // son verrou subsiste — c'est attendu après une terminaison brutale.
    const locks = await findServerLocks(dir);
    t.diagnostic(`verrous trouvés : ${locks.length === 0 ? '<aucun>' : locks.join(' | ')}`);
    assert.equal(locks.length, 1, 'un seul server.lock pour un seul root logique');
    assert.ok(
      (locks[0] ?? '').toLowerCase().endsWith(path.join('monroot', 'cockpit', 'server.lock').toLowerCase()),
      `verrou attendu sous le root logique, obtenu ${String(locks[0])}`,
    );
  } finally {
    await removeTempDir(dir);
  }
});
