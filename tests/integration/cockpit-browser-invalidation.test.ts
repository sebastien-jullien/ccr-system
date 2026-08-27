/**
 * Concurrence externe dans un **vrai** navigateur (Slice 8).
 *
 * ```text
 * B1  la CLI modifie le run       → invalidation → refetch → nouvelle vérité
 * B2  un verrou apparaît/part     → la vue de reprise suit
 * B3  le flux est coupé           → reconnexion → refetch, jamais de vue périmée
 * ```
 *
 * Aucune campagne XSS : le flux ne transporte aucune donnée métier, et rien de
 * ce qu'il contient n'est rendu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { lockFilePath } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { BrowserSession, findBrowser } from '../helpers/cdp.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const CLI = fileURLToPath(new URL('../../bin/ccr.mjs', import.meta.url));
const RUN = 'CCR-20260402-001';

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

async function runCli(args: string[], runsDir: string): Promise<void> {
  const child = spawn(process.execPath, [CLI, ...args, '--runs-dir', runsDir], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const code = await new Promise<number>((resolve) => child.on('close', (value) => resolve(value ?? -1)));
  assert.equal(code, 0, `ccr ${args.join(' ')} : ${err}`);
}

test('(B1..B3) concurrence externe dans un navigateur réel', { timeout: 300_000 }, async (t) => {
  const executable = findBrowser();
  if (executable === undefined) {
    t.skip('REAL_BROWSER: NOT_TESTED — aucun navigateur système détecté');
    return;
  }

  const dir = await makeTempDir('ccr-browser-invalidation-');
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

  const port = await freePort();
  const cockpit = await startCockpit({ runsDir, port });
  let browser: BrowserSession | undefined;
  let holder: ChildProcess | undefined;

  try {
    browser = await BrowserSession.launch(executable);
    await browser.navigate(`http://127.0.0.1:${String(port)}/`);
    await browser.waitFor('document.querySelectorAll("#runs-list li").length === 1');
    await browser.evaluate('document.querySelector("#runs-list button").click()');
    await browser.waitFor(`document.querySelector("#section-overview").textContent.includes("${RUN}")`);

    const shownState = 'document.getElementById("section-overview").textContent';
    assert.ok((await browser.evaluate<string>(shownState)).includes('Prêt'), 'état initial affiché');

    // ----------------------------------------------------------------------
    // B1 — la CLI modifie le run, personne n'a rien cliqué
    // ----------------------------------------------------------------------
    const revisionBefore = (await readStableRunSnapshot(runsDir, RUN)).revision;
    const started = Date.now();
    await runCli(['pause', '--run', RUN], runsDir);
    await browser.waitFor(`${shownState}.includes("Suspendu")`, 20_000);
    const elapsed = Date.now() - started;
    t.diagnostic(`B1 · mutation CLI visible en ${String(elapsed)} ms, sans geste humain`);

    const revisionAfter = (await readStableRunSnapshot(runsDir, RUN)).revision;
    assert.notEqual(revisionAfter, revisionBefore);
    assert.ok(elapsed < 20_000, 'la vue a fini par refléter la mutation externe');

    // ----------------------------------------------------------------------
    // B2 — un verrou externe change la vue de reprise, pas la révision
    // ----------------------------------------------------------------------
    await browser.evaluate('document.getElementById("tab-recovery").click()');
    await browser.waitFor('document.getElementById("recovery-body").textContent.length > 0');
    const beforeLock = await browser.evaluate<string>('document.getElementById("recovery-body").textContent');
    assert.ok(beforeLock.includes('aucun verrou'), `attendu « aucun verrou », vu : ${beforeLock.slice(0, 120)}`);

    holder = spawn(process.execPath, ['tests/fixtures/hold-run-lock.mjs', runsDir, RUN, 'step'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve, reject) => {
      holder?.stdout?.once('data', () => resolve());
      holder?.once('error', reject);
    });

    const lockRevision = (await readStableRunSnapshot(runsDir, RUN)).revision;
    await browser.waitFor(
      'document.getElementById("recovery-body").textContent.includes("verrou externe vivant")',
      20_000,
    );
    t.diagnostic(`B2 · verrou externe reflété · révision inchangée=${String(lockRevision === revisionAfter)}`);
    assert.equal(lockRevision, revisionAfter, 'aucun fait canonique modifié par le verrou');

    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder?.once('exit', () => resolve()));
    await unlink(lockFilePath(runPaths(runsDir, RUN)));
    await browser.waitFor('document.getElementById("recovery-body").textContent.includes("aucun verrou")', 20_000);
    t.diagnostic('B2 · levée du verrou reflétée à son tour');

    // ----------------------------------------------------------------------
    // B3 — le flux est coupé, une mutation passe, la reconnexion rattrape
    // ----------------------------------------------------------------------
    await browser.evaluate('document.getElementById("tab-overview").click()');
    // Coupure côté serveur : toutes les connexions ouvertes tombent, dont les
    // flux. `EventSource` se reconnecte de lui-même.
    await browser.evaluate('globalThis.__ccrCoupure = true');
    cockpit.server.dropConnections();
    await runCli(['resume', '--run', RUN], runsDir);
    t.diagnostic('B3 · flux coupé, mutation CLI effectuée pendant la coupure');

    await browser.waitFor(`${shownState}.includes("Prêt")`, 30_000);
    const finalState = (await readStableRunSnapshot(runsDir, RUN)).state;
    t.diagnostic(`B3 · après reconnexion : état canonique ${finalState.state}/${finalState.control}`);
    assert.equal(finalState.state, 'READY');
    assert.equal(finalState.control, 'AUTOMATION');

    // La coupure de B3 est délibérée : `EventSource` la journalise. Ce qui
    // compte est qu'aucune erreur applicative ne s'y ajoute.
    const consoleErrors = browser.consoleEntries.filter((entry) => entry.level === 'error');
    t.diagnostic(`console : ${consoleErrors.map((entry) => entry.text.slice(0, 60)).join(' | ') || '<aucune>'}`);
    const applicative = consoleErrors.filter((entry) => !/EventSource|net::ERR|Failed to load resource/i.test(entry.text));
    assert.deepEqual(applicative.map((entry) => entry.text), [], 'erreur applicative dans la console');
  } finally {
    holder?.kill('SIGKILL');
    if (browser !== undefined) await browser.close();
    await cockpit.stop();
    await removeTempDir(dir);
  }
});
