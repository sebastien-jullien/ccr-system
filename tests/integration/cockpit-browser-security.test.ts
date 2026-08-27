/**
 * Contenu hostile dans un vrai navigateur (Slice 9, `S5`).
 *
 * Une seule chaîne, choisie pour traverser les trois vues : titre du run — donc
 * vue d'ensemble et liste —, contenu d'un événement — donc chronologie — et
 * motif d'ambiguïté — donc reprise. Si le rendu échappe quelque part, il
 * échoue partout.
 *
 * Ce qui est vérifié n'est pas l'absence d'une balise dans une chaîne, mais
 * l'absence d'un **nœud** créé depuis cette donnée, et l'absence d'exécution.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { BrowserSession, findBrowser } from '../helpers/cdp.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { PendingOperation } from '../../src/core/run.ts';

const RUN = 'CCR-20260402-001';

/**
 * Charge hostile unique, déposée dans trois champs canoniques distincts.
 *
 * Elle combine les quatre façons d'exécuter du code par injection HTML :
 * script, gestionnaire d'image, gestionnaire SVG, et cadre. Un marqueur global
 * distinct par vecteur permet de dire *lequel* aurait tiré.
 */
const HOSTILE =
  '<script>globalThis.PWNED_SCRIPT=true</script>' +
  '<img src=x onerror="globalThis.PWNED_IMG=true">' +
  '<svg onload="globalThis.PWNED_SVG=true"></svg>' +
  '<iframe src="javascript:globalThis.PWNED_FRAME=true"></iframe>' +
  '"><a href="javascript:globalThis.PWNED_LINK=true">clic</a>';

const PENDING: PendingOperation = {
  kind: 'step',
  agent: 'claude',
  round: 1,
  prompt_event_id: 'evt_000002',
  source_event_id: null,
  session_id: 'claude-1',
  return_state: 'READY',
  return_control: 'AUTOMATION',
  started_at: T,
};

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

test('(S5) une charge hostile traverse trois vues, et n’exécute rien', { timeout: 300_000 }, async (t) => {
  const executable = findBrowser();
  if (executable === undefined) {
    t.skip('REAL_BROWSER: NOT_TESTED — aucun navigateur système détecté');
    return;
  }

  const dir = await makeTempDir('ccr-browser-security-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: RUN,
    state: {
      state: 'RECOVERY_REQUIRED',
      control: 'HUMAN',
      pending_operation: PENDING,
      // Vue de reprise.
      uncertainty: { reason: HOSTILE, since: T, agent: 'claude', last_event_id: 'evt_000002' },
    } as never,
    events: [
      { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
      // Chronologie.
      { round: 0, actor: 'human', type: 'human_message', content: HOSTILE, timestamp: T },
    ],
  });

  const manifestPath = runPaths(runsDir, RUN).manifest;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { title: string; workspace: { cwd: string } };
  // Vue d'ensemble et liste.
  manifest.title = HOSTILE;
  manifest.workspace.cwd = dir;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const port = await freePort();
  const cockpit = await startCockpit({ runsDir, port });
  let browser: BrowserSession | undefined;

  try {
    browser = await BrowserSession.launch(executable);
    await browser.navigate(`http://127.0.0.1:${String(port)}/`);
    await browser.waitFor('document.querySelectorAll("#runs-list li").length === 1');
    await browser.evaluate('document.querySelector("#runs-list button").click()');
    await browser.waitFor(`document.querySelector("#section-overview").textContent.includes("${RUN}")`);

    const sections = [
      ['liste', '#runs-list'],
      ['vue d’ensemble', '#section-overview'],
      ['chronologie', '#section-timeline'],
      ['reprise', '#recovery-body'],
    ] as const;

    await browser.evaluate('document.getElementById("tab-timeline").click()');
    await browser.waitFor('document.querySelectorAll("#section-timeline .entry").length > 0');
    await browser.evaluate('document.getElementById("tab-recovery").click()');
    await browser.waitFor('document.getElementById("recovery-body").textContent.length > 0');

    for (const [label, selector] of sections) {
      const text = await browser.evaluate<string>(`document.querySelector("${selector}").textContent`);
      const dangerous = `${selector} script, ${selector} img, ${selector} svg, ${selector} iframe, ${selector} a[href^='javascript:']`;
      const injected: number = await browser.evaluate<number>(`document.querySelectorAll(${JSON.stringify(dangerous)}).length`);
      t.diagnostic(`${label} · charge rendue en texte=${String(text.includes('<script>'))} · nœuds injectés=${String(injected)}`);
      assert.ok(text.includes('<script>globalThis.PWNED_SCRIPT=true</script>'), `${label} : la charge n’est pas rendue littéralement`);
      assert.equal(injected, 0, `${label} : un nœud a été créé depuis la donnée`);
    }

    // Aucun vecteur n'a tiré, et on sait lequel aurait tiré si l'un l'avait fait.
    const fired = await browser.evaluate<string[]>(
      `["PWNED_SCRIPT","PWNED_IMG","PWNED_SVG","PWNED_FRAME","PWNED_LINK"].filter((name) => globalThis[name] === true)`,
    );
    t.diagnostic(`marqueurs déclenchés : ${fired.length === 0 ? '<aucun>' : fired.join(', ')}`);
    assert.deepEqual(fired, []);

    // Le titre hostile n'a pas davantage échappé par le document lui-même.
    const title = await browser.evaluate<string>('document.title');
    assert.equal(title, 'CCR — Local Cockpit', 'le titre du document a été altéré');

    const consoleErrors = browser.consoleEntries.filter((entry) => entry.level === 'error');
    t.diagnostic(`console : ${consoleErrors.map((entry) => entry.text.slice(0, 60)).join(' | ') || '<aucune>'}`);
    assert.deepEqual(consoleErrors.map((entry) => entry.text), [], 'erreur console');
  } finally {
    if (browser !== undefined) await browser.close();
    await cockpit.stop();
    await removeTempDir(dir);
  }
});
