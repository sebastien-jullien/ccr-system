/**
 * IT-3 — service des assets du cockpit, sur socket réel.
 *
 * Le serveur gagne une surface statique ; il ne doit pas gagner un serveur de
 * fichiers. La propriété centrale n'est pas « les assets sont servis » mais
 * « rien d'autre ne l'est » — et surtout, aucune requête ne devient un chemin.
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { COCKPIT_ASSETS } from '../../src/cockpit/assets.ts';
import { SESSION_COOKIE_NAME } from '../../src/cockpit/session.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function header(result: HttpResult, name: string): string {
  const value = result.headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

function http(
  port: number,
  target: string,
  options: { host?: string; cookie?: string; method?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${String(port)}` };
    if (options.cookie !== undefined) headers['Cookie'] = options.cookie;
    const req = request(
      { host: '127.0.0.1', port, path: target, method: options.method ?? 'GET', headers },
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

interface Box {
  readonly instance: CockpitInstance;
  readonly port: number;
  readonly cookie: string;
  cleanup(): Promise<void>;
}

async function open(): Promise<Box> {
  const dir = await makeTempDir('ccr-assets-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: 'CCR-20260402-001',
    events: [{ round: 0, actor: 'system', type: 'run_created', content: 'SECRET-METIER-XYZZY', timestamp: T }],
  });

  const instance = await startCockpit({ runsDir, port: 0 });
  const bootstrap = await http(instance.server.port, '/');
  const cookie = (bootstrap.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  return {
    instance,
    port: instance.server.port,
    cookie,
    cleanup: async () => {
      await instance.stop();
      await removeTempDir(dir);
    },
  };
}

test('(A1) chaque asset déclaré est servi avec son type explicite', async (t) => {
  const b = await open();
  try {
    for (const [route, asset] of COCKPIT_ASSETS) {
      const result = await http(b.port, route, { cookie: b.cookie });
      assert.equal(result.status, 200, route);
      assert.equal(header(result, 'content-type'), asset.contentType, route);
      assert.ok(result.body.length > 0, route);
      // Type explicite, jamais deviné à partir du contenu.
      assert.equal(header(result, 'x-content-type-options'), 'nosniff');
      assert.equal(header(result, 'cache-control'), 'no-store');
    }
    t.diagnostic(`${String(COCKPIT_ASSETS.size)} assets servis`);
  } finally {
    await b.cleanup();
  }
});

test('(A2) tout ce qui n’est pas déclaré est introuvable', async () => {
  const b = await open();
  try {
    for (const route of [
      '/assets/',
      '/assets/inconnu.js',
      '/assets/app.js.map',
      '/assets/index.html',
      '/assets/app.JS',
      '/assets/app.js/',
      '/web/app.js',
      '/package.json',
      '/src/cockpit/server.ts',
    ]) {
      const result = await http(b.port, route, { cookie: b.cookie });
      assert.equal(result.status, 404, `« ${route} » doit être introuvable`);
      assert.equal(JSON.parse(result.body).error.code, 'NOT_FOUND');
    }
  } finally {
    await b.cleanup();
  }
});

test('(A3) traversal : refusé, et surtout jamais concaténé à un chemin', async () => {
  const b = await open();
  try {
    for (const route of [
      '/assets/../server.ts',
      '/assets/../../package.json',
      '/assets/%2e%2e/server.ts',
      '/assets/%2e%2e%2f%2e%2e%2fpackage.json',
      '/assets/%252e%252e/server.ts',
      '/assets/..%2fserver.ts',
      '/assets/..%5cserver.ts',
      '/assets/app.js%00.txt',
      '/assets/C:%5cWindows%5cwin.ini',
    ]) {
      const result = await http(b.port, route, { cookie: b.cookie });
      assert.ok([400, 404].includes(result.status), `« ${route} » → ${String(result.status)}`);
      for (const leak of ['import ', 'CcrError', 'devDependencies', '[fonts]']) {
        assert.equal(result.body.includes(leak), false, `« ${route} » ne divulgue rien`);
      }
      assert.match(header(result, 'content-type'), /^application\/json/);
    }
  } finally {
    await b.cleanup();
  }
});

test('(A4) les assets restent derrière le Host strict et la session', async () => {
  const b = await open();
  try {
    const forged = await http(b.port, '/assets/app.js', { host: 'evil.example', cookie: b.cookie });
    assert.equal(forged.status, 403);

    // Choix assumé : les assets exigent la session comme le reste. Ils ne
    // contiennent aucune donnée sensible, mais une seconde règle d'accès serait
    // une exception de plus à maintenir — et une exception est le meilleur
    // endroit où une faille s'installe.
    const anonymous = await http(b.port, '/assets/app.js');
    assert.equal(anonymous.status, 401);
    assert.equal(JSON.parse(anonymous.body).error.code, 'UNAUTHENTICATED');

    const wrong = await http(b.port, '/assets/app.js', { cookie: `${SESSION_COOKIE_NAME}=faux` });
    assert.equal(wrong.status, 401);

    // Une query sur un asset est refusée : rien n'est paramétrable ici.
    assert.equal((await http(b.port, '/assets/app.js?v=1', { cookie: b.cookie })).status, 400);
    // Aucune mutation, même sur un fichier statique : sans origine canonique
    // le refus est immédiat, et avec elle la route n'existe simplement pas.
    assert.equal((await http(b.port, '/assets/app.js', { cookie: b.cookie, method: 'POST' })).status, 403);
    assert.equal(
      (await http(b.port, '/assets/app.js', { cookie: b.cookie, method: 'POST', host: `127.0.0.1:${String(b.port)}` })).status,
      403,
    );
  } finally {
    await b.cleanup();
  }
});

test('(A5) aucun asset ne transporte de donnée CCR ni de secret', async () => {
  const b = await open();
  try {
    for (const route of COCKPIT_ASSETS.keys()) {
      const body = (await http(b.port, route, { cookie: b.cookie })).body;
      assert.equal(body.includes(b.instance.server.sessionSecret), false, `${route} : secret de session`);
      assert.equal(body.includes('SECRET-METIER-XYZZY'), false, `${route} : contenu de run`);
      assert.equal(body.includes('CCR-20260402-001'), false, `${route} : identifiant de run`);
      assert.equal(body.includes(b.instance.dataRoot.dataRoot), false, `${route} : chemin du data root`);
    }
  } finally {
    await b.cleanup();
  }
});

test('(A6) CSP : élargie au strict nécessaire, sans unsafe-inline ni unsafe-eval', async (t) => {
  const b = await open();
  try {
    for (const route of ['/', '/assets/app.js', '/assets/styles.css', '/api/runs']) {
      const csp = header(await http(b.port, route, { cookie: b.cookie }), 'content-security-policy');
      t.diagnostic(`${route} → ${csp}`);

      for (const directive of [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        "img-src 'none'",
        "font-src 'none'",
        "media-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ]) {
        assert.ok(csp.includes(directive), `${route} : ${directive}`);
      }

      for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", 'https:', 'http:', 'data:', "'*'"]) {
        assert.equal(csp.includes(forbidden), false, `${route} : ${forbidden} interdit`);
      }
    }
  } finally {
    await b.cleanup();
  }
});

test('(A7) le shell ne référence que des ressources de même origine', async () => {
  const b = await open();
  try {
    const html = (await http(b.port, '/')).body;
    for (const external of ['http://', 'https://', '//cdn', 'integrity=', 'crossorigin']) {
      assert.equal(html.includes(external), false, `référence externe : ${external}`);
    }
    // Chaque module référencé est réellement déclaré dans l'allowlist.
    const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? '');
    assert.ok(referenced.length >= 2);
    for (const reference of referenced) {
      assert.ok(COCKPIT_ASSETS.has(reference), `${reference} déclaré`);
    }
  } finally {
    await b.cleanup();
  }
});
