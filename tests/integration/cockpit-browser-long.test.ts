/**
 * Opérations longues dans un **vrai** navigateur (Slice 5).
 *
 * Le Slice 4 avait prouvé les mutations courtes de bout en bout ; celles-ci
 * répondent dans la seconde. Une opération longue introduit une situation que
 * le navigateur n'avait encore jamais rencontrée : une réponse `202` qui ne
 * conclut rien, un écran qui doit dire « je ne sais pas encore » sans le
 * déguiser en échec, et un geste humain explicite pour aller chercher le
 * verdict.
 *
 * Aucun fournisseur réel n'est appelé : les adaptateurs sont des doublures
 * contrôlées par une barrière. Ce qui est réel ici, c'est le navigateur, le
 * serveur, les sockets, le run lock, le quota et les fichiers canoniques.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { BrowserSession, findBrowser } from '../helpers/cdp.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';

const RUNS = ['CCR-20260402-001', 'CCR-20260808-002', 'CCR-20260808-003'] as const;

/** Message humain hostile, et réponse d'agent hostile : les deux sens. */
const HOSTILE_HUMAN = '<script>globalThis.PWNED_SEND=true</script>';
const HOSTILE_AGENT = '<img src=x onerror="globalThis.PWNED_AGENT=true">';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Barrière ré-armable.
 *
 * `onCall` capture la promesse courante au moment de l'appel : ouvrir puis
 * ré-armer laisse donc l'appel déjà en vol se terminer, et bloque le suivant.
 */
function gate(): { wait(): Promise<void>; open(): void; rearm(): void; entered(): number } {
  let release!: () => void;
  let promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  return {
    wait() {
      entered += 1;
      return promise;
    },
    open() {
      release();
    },
    rearm() {
      promise = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    entered: () => entered,
  };
}

test('(B-L1..B-L9) opérations longues dans un navigateur réel', { timeout: 300_000 }, async (t) => {
  const executable = findBrowser();
  if (executable === undefined) {
    t.skip('REAL_BROWSER: NOT_TESTED — aucun navigateur système détecté');
    return;
  }

  const dir = await makeTempDir('ccr-browser-long-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  for (const runId of RUNS) {
    await materializeRun(runsDir, {
      runId,
      events: [
        { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
        { round: 1, actor: 'codex', type: 'assistant_response', session_id: 'codex-1', content: 'réponse', timestamp: T },
      ],
    });
  }

  const barrier = gate();
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({
      kind: 'claude',
      sessionId: 'claude-1',
      onCall: () => barrier.wait(),
      respond: () => HOSTILE_AGENT,
    }),
    codex: createFakeAdapter({
      kind: 'codex',
      sessionId: 'codex-1',
      onCall: () => barrier.wait(),
      respond: () => HOSTILE_AGENT,
    }),
  };

  const port = await freePort();
  const cockpit = await startCockpit({ runsDir, port, depsOverrides: { createAdapters: () => adapters } });
  let browser: BrowserSession | undefined;
  // Créneau artificiel : déclaré ici pour être rendu même si une assertion
  // échoue — sans quoi le drain d'arrêt attendrait un slot jamais libéré.
  let held: { release(): void } | undefined;

  /**
   * Consulte le reçu jusqu'au verdict — un clic humain, répété.
   *
   * Le cockpit n'installe aucune consultation automatique : c'est donc au test
   * de rejouer le geste. Rien n'est assoupli — le verdict attendu reste
   * « effectuée », et le nombre de tentatives est borné.
   */
  const confirm = async (session: BrowserSession): Promise<number> => {
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const status = await session.evaluate<string>('document.getElementById("run-status").textContent');
      if (status.includes('effectuée')) return attempt;
      await session.evaluate('document.getElementById("operation-check")?.click()');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return -1;
  };

  const select = async (session: BrowserSession, runId: string): Promise<void> => {
    await session.evaluate(
      `[...document.querySelectorAll("#runs-list button")].find((b) => b.textContent.includes(${JSON.stringify(runId)})).click()`,
    );
    await session.waitFor(`document.querySelector("#section-overview").textContent.includes(${JSON.stringify(runId)})`);
  };

  try {
    browser = await BrowserSession.launch(executable);
    const base = `http://127.0.0.1:${String(port)}/`;
    await browser.navigate(base);
    await browser.waitFor(`document.querySelectorAll("#runs-list li").length === ${String(RUNS.length)}`);
    await select(browser, RUNS[0]);

    // ------------------------------------------------------------------
    // B-L1 — périmètre exécutable : quatre courtes, deux longues, rien d'autre.
    // ------------------------------------------------------------------
    const actionable = await browser.evaluate<string[]>(
      '[...document.querySelectorAll("[data-action]")].map((n) => n.getAttribute("data-action"))',
    );
    t.diagnostic(`contrôles exposés : ${actionable.join(', ')}`);
    // Quatre courtes, deux longues : exactement six, et pas une de plus.
    assert.deepEqual(
      [...actionable].sort(),
      ['DECIDE', 'PAUSE', 'RESUME', 'SEND', 'STEP', 'STOP'],
      'aucun contrôle hors du Slice 5',
    );
    for (const forbidden of ['START', 'RECOVER', 'HANDOFF', 'CLEAR_STALE_LOCK', 'CONFIG']) {
      assert.equal(actionable.includes(forbidden), false, `hors périmètre : ${forbidden}`);
    }

    // ------------------------------------------------------------------
    // B-L2 — les cibles SEND viennent du cœur, jamais des sessions visibles.
    // ------------------------------------------------------------------
    const targets = await browser.evaluate<string[]>(
      `fetch("/api/runs/${RUNS[0]}").then((r) => r.json())`
        + '.then((v) => v.capabilities.capabilities.find((c) => c.id === "SEND").targets)',
    );
    const options = await browser.evaluate<string[]>(
      '[...document.querySelectorAll("#send-target option")].map((n) => n.value)',
    );
    const sessions = await browser.evaluate<string[]>(
      `fetch("/api/runs/${RUNS[0]}").then((r) => r.json())`
        + '.then((v) => Object.keys(v.sessions ?? {}).filter((k) => v.sessions[k]))',
    );
    t.diagnostic(`SEND.targets=[${targets.join(',')}] · sélecteur=[${options.join(',')}] · sessions=[${sessions.join(',')}]`);
    assert.deepEqual(options, targets, 'le sélecteur est exactement SEND.targets');

    // ------------------------------------------------------------------
    // B-L3 — STEP : 202, écran indéterminé, aucun rejeu offert.
    // ------------------------------------------------------------------
    await browser.evaluate('document.querySelector("[data-action=STEP]").click()');
    await browser.waitFor('document.getElementById("run-status").textContent.includes("toujours en cours")');
    assert.ok(await browser.evaluate<boolean>('Boolean(document.getElementById("operation-check"))'), 'vérification offerte');
    assert.equal(
      await browser.evaluate<boolean>('Boolean(document.getElementById("mutation-retry"))'),
      false,
      'aucun rejeu proposé sur un résultat en cours',
    );

    // ------------------------------------------------------------------
    // B-L4 — le verdict ne vient qu'après le fournisseur, sur geste humain.
    // ------------------------------------------------------------------
    barrier.open();
    const stepAttempts = await confirm(browser);
    t.diagnostic(`STEP : verdict obtenu au bout de ${String(stepAttempts)} consultation(s)`);
    assert.ok(stepAttempts > 0, 'le verdict finit par arriver, sur geste humain');
    // La vue a bien été rechargée depuis le cœur : le tour est visible.
    await browser.evaluate('document.getElementById("tab-timeline").click()');
    await browser.waitFor('document.querySelectorAll("#section-timeline .entry").length >= 3');

    // ------------------------------------------------------------------
    // B-L5 — SEND : contenu hostile humain, réponse hostile de l'agent.
    // ------------------------------------------------------------------
    barrier.rearm();
    await browser.evaluate('document.getElementById("tab-overview").click()');
    await browser.waitFor('Boolean(document.getElementById("send-content"))');
    await browser.evaluate(`document.getElementById("send-content").value = ${JSON.stringify(HOSTILE_HUMAN)}`);
    await browser.evaluate('document.querySelector("[data-action=SEND]").click()');
    await browser.waitFor('document.getElementById("run-status").textContent.includes("toujours en cours")');
    barrier.open();
    const sendAttempts = await confirm(browser);
    t.diagnostic(`SEND : verdict obtenu au bout de ${String(sendAttempts)} consultation(s)`);
    assert.ok(sendAttempts > 0, 'le verdict finit par arriver, sur geste humain');

    await browser.evaluate('document.getElementById("tab-timeline").click()');
    await browser.waitFor(
      `document.querySelector("#section-timeline").textContent.includes(${JSON.stringify(HOSTILE_HUMAN)})`,
    );
    assert.equal(await browser.evaluate<unknown>('globalThis.PWNED_SEND ?? null'), null, 'message humain inerte');
    assert.equal(await browser.evaluate<unknown>('globalThis.PWNED_AGENT ?? null'), null, 'réponse agent inerte');
    assert.equal(
      await browser.evaluate<number>(
        'document.querySelectorAll("#section-timeline script, #section-timeline img, #section-timeline iframe").length',
      ),
      0,
      'aucun nœud exécutable créé',
    );
    assert.equal(
      await browser.evaluate<boolean>(
        `document.querySelector("#section-timeline").textContent.includes(${JSON.stringify(HOSTILE_AGENT)})`,
      ),
      true,
      'la réponse hostile est rendue comme texte, intégralement',
    );

    // ------------------------------------------------------------------
    // B-L6 — quota saturé : 503 fermé, aucun rejeu automatique.
    // ------------------------------------------------------------------
    barrier.rearm();
    await select(browser, RUNS[1]);
    await browser.evaluate('document.querySelector("[data-action=STEP]").click()');
    await browser.waitFor('document.getElementById("run-status").textContent.includes("toujours en cours")');
    // Second créneau : réservé depuis le test, faute de pouvoir piloter deux
    // runs simultanément depuis un seul écran. Le quota vaut deux.
    held = cockpit.manager.admit('op_saturation_navigateur');
    assert.equal(cockpit.manager.activeCount(), 2, 'quota saturé');

    const before = browser.requests.filter((r) => r.url.endsWith(`/${RUNS[2]}/step`)).length;
    await select(browser, RUNS[2]);
    await browser.evaluate('document.querySelector("[data-action=STEP]").click()');
    await browser.waitFor('document.getElementById("run-status").getAttribute("class").includes("is-error")');
    const busy = await browser.evaluate<string>('document.getElementById("run-status").textContent');
    const busyControls = await browser.evaluate<string[]>(
      '[...document.querySelectorAll("#run-status button")].map((n) => n.id)',
    );
    t.diagnostic(`quota saturé → « ${busy.trim()} » · contrôles=[${busyControls.join(',')}]`);
    assert.match(busy, /deux opérations agent/i, `message inattendu : ${busy}`);
    assert.match(busy, /Aucune file d attente/i, 'le refus dit qu’il n’y a pas de file');
    assert.deepEqual(busyControls, [], 'un refus de quota n’offre aucun contrôle');

    // Aucun renvoi automatique : on laisse au client tout le temps d'en faire un.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = browser.requests.filter((r) => r.url.endsWith(`/${RUNS[2]}/step`)).length;
    t.diagnostic(`envois STEP sur ${RUNS[2]} : ${String(after - before)}`);
    assert.equal(after - before, 1, 'une seule tentative, jamais rejouée toute seule');

    held.release();
    held = undefined;
    barrier.open();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ------------------------------------------------------------------
    // B-L7 — UNKNOWN : dit tel quel, sans rejeu, avec vérification manuelle.
    // ------------------------------------------------------------------
    barrier.rearm();
    await select(browser, RUNS[2]);
    await browser.evaluate('document.querySelector("[data-action=STEP]").click()');
    await browser.waitFor('document.getElementById("run-status").textContent.includes("toujours en cours")');
    await browser.evaluate('document.getElementById("operation-check").click()');
    await browser.waitFor('[...performance.getEntriesByType("resource")].some((e) => e.name.includes("/api/operations/"))');
    // L'identifiant d'opération se lit dans le trafic réel : c'est le
    // navigateur qui vient de le demander, pas le test qui le devine.
    const seen = browser.requests
      .map((r) => /\/api\/operations\/(op_[0-9a-f]+)$/.exec(r.url)?.[1])
      .filter((id): id is string => id !== undefined);
    const operationId = seen[seen.length - 1];
    assert.ok(operationId !== undefined, 'le navigateur a bien consulté un reçu');
    cockpit.manager.markUncertain(operationId);

    await browser.evaluate('document.getElementById("operation-check").click()');
    await browser.waitFor('document.getElementById("run-status").textContent.includes("inconnu")');
    const unknown = await browser.evaluate<string>('document.getElementById("run-status").textContent');
    const controls = await browser.evaluate<string[]>(
      '[...document.querySelectorAll("#run-status button")].map((n) => n.id)',
    );
    t.diagnostic(`UNKNOWN → « ${unknown.trim()} » · contrôles=[${controls.join(',')}]`);
    assert.deepEqual(controls, ['operation-check'], 'un seul geste : vérifier');
    assert.equal(controls.includes('mutation-retry'), false, 'aucun rejeu sur un résultat inconnu');

    barrier.open();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // ------------------------------------------------------------------
    // B-L8 — aucune route hors périmètre, aucune erreur applicative.
    // ------------------------------------------------------------------
    const posted = browser.requests.filter((r) => r.url.startsWith(base)).map((r) => r.url.slice(base.length));
    for (const forbidden of ['start', 'recover', 'handoff', 'config', 'lock']) {
      assert.equal(posted.some((target) => target.endsWith(`/${forbidden}`)), false, `route hors périmètre : ${forbidden}`);
    }
    const errors = browser.consoleEntries.filter((entry) => entry.level === 'error');
    const network = errors.filter((entry) => entry.text.startsWith('Failed to load resource'));
    const script = errors.filter((entry) => !entry.text.startsWith('Failed to load resource'));
    t.diagnostic(`erreurs console : ${String(script.length)} applicatives, ${String(network.length)} réseau`);
    assert.deepEqual(script, [], script.map((entry) => entry.text).join(' | '));
    for (const entry of network) {
      assert.match(entry.text, /status of 503/, `entrée réseau inattendue : ${entry.text}`);
    }
  } finally {
    held?.release();
    barrier.open();
    if (browser !== undefined) await browser.close();
    await cockpit.stop();
    await removeTempDir(dir);
  }
});
