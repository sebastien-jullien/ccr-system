/**
 * Création d'un run dans un **vrai** navigateur (Slice 6).
 *
 * Quatre issues, et ce que l'écran n'offre jamais :
 *
 * ```text
 * SUCCEEDED               le run s'ouvre, depuis le read model
 * AUTH_REQUIRED           une commande à taper, pas un bouton à cliquer
 * FAILED_INITIALIZATION   le run existe, il reste inspectable
 * UNKNOWN                 dit tel quel, jamais rejoué, jamais deviné
 * ```
 *
 * Aucun fournisseur réel : probes de preflight et adapters sont des doublures.
 * Ce qui est réel : Chrome, le serveur, les sockets, les fichiers canoniques.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import type { CockpitInstance } from '../../src/cockpit/cockpit-service.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { createOperationStore } from '../../src/cockpit/operations-store.ts';
import type { OperationStore } from '../../src/cockpit/operations-store.ts';
import { BrowserSession, findBrowser } from '../helpers/cdp.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';

const HOSTILE_TITLE = '<script>globalThis.PWNED_START=true</script>';
const HOSTILE_PROMPT = '"><svg onload="globalThis.PWNED_PROMPT=true">';

const probeOf = (agent: 'claude' | 'codex', authStatus: AgentRuntimeProbe['authStatus'] = 'AUTHENTICATED'): Promise<AgentRuntimeProbe> =>
  Promise.resolve({ agent, installed: true, version: '1.0.0', authStatus, launcherSource: 'explicit' });

function barrier(): { wait: () => Promise<void>; open: () => void } {
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  return { wait: () => gate, open: () => unlock() };
}

interface Stand {
  readonly instance: CockpitInstance;
  readonly url: string;
  readonly runsDir: string;
  readonly workspace: string;
  runIds(): Promise<string[]>;
  stop(): Promise<void>;
}

interface StandOptions {
  readonly claudeAuth?: AgentRuntimeProbe['authStatus'];
  readonly onCall?: () => Promise<void>;
  readonly failCodex?: () => unknown;
  readonly breakAssociation?: boolean;
}

async function stand(dir: string, name: string, options: StandOptions = {}): Promise<Stand> {
  const runsDir = path.join(dir, name, 'runs');
  const workspace = path.join(dir, name, 'workspace');
  for (const target of [runsDir, workspace]) await mkdir(target, { recursive: true });

  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', ...(options.onCall === undefined ? {} : { onCall: options.onCall }) }),
    codex: createFakeAdapter({
      kind: 'codex',
      sessionId: 'codex-1',
      ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
      ...(options.failCodex === undefined ? {} : { failStart: options.failCodex }),
    }),
  };

  const real = createOperationStore(resolveCockpitDataRoot(runsDir), 'instance-navigateur');
  const broken: OperationStore = {
    claim: (input) => real.claim(input),
    associateRun: () => Promise.reject(new Error('écriture impossible')),
    settle: (id, patch) => real.settle(id, patch),
    read: (id) => real.read(id),
  };

  const instance = await startCockpit({
    runsDir,
    port: 0,
    depsOverrides: { createAdapters: () => adapters },
    preflightSeams: {
      configPath: path.join(dir, 'absente.json'),
      env: {},
      probes: {
        claude: () => probeOf('claude', options.claudeAuth ?? 'AUTHENTICATED'),
        codex: () => probeOf('codex'),
      },
    },
    ...(options.breakAssociation === true ? { operationsStore: broken } : {}),
  });

  return {
    instance,
    url: `http://127.0.0.1:${String(instance.server.port)}/`,
    runsDir,
    workspace,
    runIds: async () => (await readdir(runsDir)).filter((entry) => entry.startsWith('CCR-')),
    stop: () => instance.stop().then(() => undefined),
  };
}

/** Remplit le formulaire de création et clique. Aucune validation cliente. */
async function fill(browser: BrowserSession, title: string, workspace: string, prompt: string): Promise<void> {
  await browser.evaluate(`document.getElementById("start-title").value = ${JSON.stringify(title)}`);
  await browser.evaluate(`document.getElementById("start-workspace").value = ${JSON.stringify(workspace)}`);
  await browser.evaluate(`document.getElementById("start-prompt").value = ${JSON.stringify(prompt)}`);
  await browser.evaluate('document.getElementById("start-submit").click()');
}

const statusOf = (browser: BrowserSession): Promise<string> =>
  browser.evaluate<string>('document.getElementById("start-status").textContent');

const buttonsOf = (browser: BrowserSession): Promise<string[]> =>
  browser.evaluate<string[]>('[...document.querySelectorAll("#start-status button")].map((n) => n.id)');

test('(B1..B8) création de run dans un navigateur réel', { timeout: 300_000 }, async (t) => {
  const executable = findBrowser();
  if (executable === undefined) {
    t.skip('REAL_BROWSER: NOT_TESTED — aucun navigateur système détecté');
    return;
  }

  const dir = await makeTempDir('ccr-browser-start-');
  const gate = barrier();
  const stands: Stand[] = [];
  let browser: BrowserSession | undefined;

  try {
    browser = await BrowserSession.launch(executable);

    // ------------------------------------------------------------------
    // B1 — succès, et B7/B8 observés au passage
    // ------------------------------------------------------------------
    const happy = await stand(dir, 'happy', { onCall: () => gate.wait() });
    stands.push(happy);
    await browser.navigate(happy.url);
    await browser.waitFor('Boolean(document.getElementById("start-submit"))');

    // B8 — aucun contrôle de reprise n'est introduit par ce slice.
    const controls = await browser.evaluate<string[]>(
      '[...document.querySelectorAll("[data-action]")].map((n) => n.getAttribute("data-action"))',
    );
    t.diagnostic(`contrôles exposés hors run : ${controls.join(', ') || '<aucun>'}`);
    for (const forbidden of ['RECOVER', 'CLEAR_STALE_LOCK', 'START']) {
      assert.equal(controls.includes(forbidden), false, `contrôle interdit : ${forbidden}`);
    }

    // Contenu hostile dans le titre ET le contexte initial.
    await fill(browser, HOSTILE_TITLE, happy.workspace, HOSTILE_PROMPT);
    await browser.waitFor('document.getElementById("start-status").textContent.includes("en cours")');

    const pending = await statusOf(browser);
    const pendingButtons = await buttonsOf(browser);
    t.diagnostic(`202 → « ${pending.trim()} » · boutons=[${pendingButtons.join(',')}]`);
    assert.match(pending, /Création du run CCR-\d{8}-\d{3} en cours/, 'created_run_id est annoncé');
    assert.match(pending, /Opération op_[0-9a-f]{64}/, 'operation_id est annoncé');
    assert.deepEqual(pendingButtons, ['start-check'], 'un seul geste : vérifier');

    /**
     * B7 — rien ne se consulte tout seul pendant que l'agent est bloqué.
     *
     * Formulée jusqu'au Slice 7 comme « zéro requête », elle comptait tout.
     * Depuis le Slice 8, l'apparition du run invalide la liste, et le
     * navigateur la relit — une lecture provoquée par un changement réel, pas
     * un sondage. Ce que la garantie visait reste intact et devient explicite :
     * le reçu n'est jamais consulté sans geste humain, et rien n'est réémis.
     */
    const before = browser.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const observed = browser.requests.slice(before).map((entry) => entry.url.replace(/^https?:\/\/[^/]+\//, ''));
    t.diagnostic(`requêtes pendant 2 s d'attente : ${observed.join(', ') || '<aucune>'}`);
    assert.equal(
      observed.some((target) => target.startsWith('api/operations/')),
      false,
      'le reçu a été consulté sans geste humain',
    );
    assert.equal(
      observed.some((target) => target.startsWith('assets/') || target === ''),
      false,
      'rechargement automatique de la page',
    );
    // Aucune création n'est réémise : la surface de création n'est pas touchée.
    assert.equal(observed.filter((target) => target === 'api/runs').length <= 1, true, 'liste relue plus d’une fois');

    gate.open();
    let attempts = 0;
    for (; attempts < 40; attempts += 1) {
      if ((await statusOf(browser)).includes('créé')) break;
      await browser.evaluate('document.getElementById("start-check")?.click()');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const success = await statusOf(browser);
    const created = (await happy.runIds())[0] ?? '';
    t.diagnostic(`succès après ${String(attempts)} consultation(s) → « ${success.trim()} »`);
    assert.match(success, /Run CCR-\d{8}-\d{3} créé/);
    assert.equal((await happy.runIds()).length, 1, 'exactement un run');

    // La vue affichée vient du read model, pas du reçu.
    await browser.waitFor(`document.querySelector("#section-overview").textContent.includes(${JSON.stringify(created)})`);

    // XSS — titre et contexte hostiles rendus comme texte, dans les deux vues.
    await browser.evaluate('document.getElementById("tab-timeline").click()');
    await browser.waitFor('document.querySelectorAll("#section-timeline .entry").length >= 1');
    assert.equal(await browser.evaluate<unknown>('globalThis.PWNED_START ?? null'), null, 'titre inerte');
    assert.equal(await browser.evaluate<unknown>('globalThis.PWNED_PROMPT ?? null'), null, 'contexte inerte');
    assert.equal(
      await browser.evaluate<number>('document.querySelectorAll("#detail script, #detail svg, #detail img, #detail iframe").length'),
      0,
      'aucun nœud exécutable créé depuis les données',
    );
    const shown = await browser.evaluate<string>('document.querySelector("#detail").textContent');
    assert.ok(shown.includes(HOSTILE_TITLE), 'le titre hostile est rendu intégralement, comme texte');

    // Le manifest, lui, porte bien le titre hostile : c'est un fait canonique.
    const manifest = await readFile(path.join(happy.runsDir, created, 'manifest.json'), 'utf8');
    assert.ok(manifest.includes('PWNED_START'), 'le titre est conservé tel quel côté canonique');

    // ------------------------------------------------------------------
    // B2 — AUTH_REQUIRED : une commande, pas une action
    // ------------------------------------------------------------------
    const unauth = await stand(dir, 'auth', { claudeAuth: 'UNAUTHENTICATED' });
    stands.push(unauth);
    await browser.navigate(unauth.url);
    await browser.waitFor('Boolean(document.getElementById("start-submit"))');
    await fill(browser, 'Run refusé', unauth.workspace, 'Contexte.');
    await browser.waitFor('document.getElementById("start-status").getAttribute("class").includes("is-error")');

    const authText = await statusOf(browser);
    const authButtons = await buttonsOf(browser);
    const links = await browser.evaluate<number>('document.querySelectorAll("#start-status a").length');
    t.diagnostic(`AUTH_REQUIRED → « ${authText.trim()} » · boutons=[${authButtons.join(',') || '<aucun>'}] · liens=${String(links)}`);
    assert.match(authText, /terminal/i);
    assert.ok(authText.includes('ccr setup'), 'la commande est affichée telle quelle');
    assert.deepEqual(authButtons, [], 'aucun contrôle : la remédiation est externe');
    assert.equal(links, 0, 'aucun lien cliquable');
    assert.deepEqual(await unauth.runIds(), [], 'aucun run créé');

    // ------------------------------------------------------------------
    // B3 — FAILED_INITIALIZATION : le run existe, il s'ouvre
    // ------------------------------------------------------------------
    const partial = await stand(dir, 'partiel', { failCodex: () => new Error('codex indisponible') });
    stands.push(partial);
    await browser.navigate(partial.url);
    await browser.waitFor('Boolean(document.getElementById("start-submit"))');
    await fill(browser, 'Run partiel', partial.workspace, 'Contexte.');
    for (let i = 0; i < 40; i += 1) {
      if ((await statusOf(browser)).includes('échoué')) break;
      await browser.evaluate('document.getElementById("start-check")?.click()');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const failedText = await statusOf(browser);
    const failedButtons = await buttonsOf(browser);
    t.diagnostic(`FAILED_INITIALIZATION → « ${failedText.trim()} » · boutons=[${failedButtons.join(',')}]`);
    assert.match(failedText, /créé mais son initialisation a échoué/i);
    assert.deepEqual(failedButtons, ['start-open'], 'ouvrir le run, et rien d’autre');

    const partialRun = (await partial.runIds())[0] ?? '';
    await browser.evaluate('document.getElementById("start-open").click()');
    await browser.waitFor(`document.querySelector("#section-overview").textContent.includes(${JSON.stringify(partialRun)})`);
    const state = JSON.parse(await readFile(path.join(partial.runsDir, partialRun, 'state.json'), 'utf8')) as { state: string };
    assert.equal(state.state, 'FAILED_INITIALIZATION');

    // ------------------------------------------------------------------
    // B4 — UNKNOWN avec run connu
    // ------------------------------------------------------------------
    const uncertain = await stand(dir, 'inconnu');
    stands.push(uncertain);
    await browser.navigate(uncertain.url);
    await browser.waitFor('Boolean(document.getElementById("start-submit"))');
    await fill(browser, 'Run incertain', uncertain.workspace, 'Contexte.');
    await browser.waitFor('document.getElementById("start-status").textContent.includes("en cours")');
    const known = (await statusOf(browser)).match(/CCR-\d{8}-\d{3}/)?.[0] ?? '';
    for (const id of uncertain.instance.manager.activeOperationIds()) uncertain.instance.manager.markUncertain(id);
    // L'opération peut déjà être terminée : on marque aussi celle du reçu.
    const receiptId = (await statusOf(browser)).match(/op_[0-9a-f]{64}/)?.[0] ?? '';
    uncertain.instance.manager.markUncertain(receiptId);
    await browser.evaluate('document.getElementById("start-check").click()');
    await browser.waitFor('document.getElementById("start-status").textContent.includes("inconnu")');

    const unknownText = await statusOf(browser);
    const unknownButtons = await buttonsOf(browser);
    t.diagnostic(`UNKNOWN (run ${known}) → « ${unknownText.trim()} » · boutons=[${unknownButtons.join(',')}]`);
    assert.match(unknownText, /inconnu/i);
    assert.equal(unknownButtons.includes('mutation-retry'), false, 'aucun rejeu');
    assert.deepEqual(unknownButtons, ['start-check', 'start-open'], 'vérifier, ou ouvrir le run connu');
    await browser.evaluate('document.getElementById("start-open").click()');
    await browser.waitFor(`document.querySelector("#section-overview").textContent.includes(${JSON.stringify(known)})`);

    // ------------------------------------------------------------------
    // B5 — UNKNOWN sans run connu : aucune recherche heuristique
    // ------------------------------------------------------------------
    const orphan = await stand(dir, 'orphelin', { breakAssociation: true });
    stands.push(orphan);
    await browser.navigate(orphan.url);
    await browser.waitFor('Boolean(document.getElementById("start-submit"))');
    const requestsBefore = browser.requests.length;
    await fill(browser, 'Run orphelin', orphan.workspace, 'Contexte.');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    t.diagnostic(`orphelin, état brut : « ${(await statusOf(browser)).trim()} »`);
    await browser.waitFor('document.getElementById("start-status").textContent.includes("inconnu")');

    const orphanText = await statusOf(browser);
    const orphanButtons = await buttonsOf(browser);
    const listed = browser.requests.slice(requestsBefore).map((r) => r.url);
    t.diagnostic(`UNKNOWN sans run → « ${orphanText.trim()} » · boutons=[${orphanButtons.join(',')}]`);
    assert.match(orphanText, /inconnu/i);
    assert.deepEqual(orphanButtons, ['start-check'], 'aucun run à ouvrir : aucun bouton pour le faire');
    assert.equal((await orphan.runIds()).length, 1, 'un run orphelin existe pourtant sur disque');
    // Et le navigateur ne part pas à sa recherche.
    assert.equal(
      listed.some((url) => /\/api\/runs\/CCR-/.test(url)),
      false,
      `le navigateur cherche un run correspondant : ${listed.join(' ')}`,
    );

    // ------------------------------------------------------------------
    // B6 — quota saturé
    // ------------------------------------------------------------------
    const busy = await stand(dir, 'quota');
    stands.push(busy);
    const held = [busy.instance.manager.admit('op_saturation_a'), busy.instance.manager.admit('op_saturation_b')];
    try {
      await browser.navigate(busy.url);
      await browser.waitFor('Boolean(document.getElementById("start-submit"))');
      await fill(browser, 'Run refusé', busy.workspace, 'Contexte.');
      await browser.waitFor('document.getElementById("start-status").getAttribute("class").includes("is-error")');

      const busyText = await statusOf(browser);
      const busyButtons = await buttonsOf(browser);
      const sent = browser.requests.filter((r) => r.url.endsWith('/api/runs')).length;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const sentAfter = browser.requests.filter((r) => r.url.endsWith('/api/runs')).length;
      t.diagnostic(`quota → « ${busyText.trim()} » · boutons=[${busyButtons.join(',') || '<aucun>'}] · envois=${String(sentAfter - sent)}`);
      assert.match(busyText, /deux opérations agent/i);
      assert.match(busyText, /Aucune file d attente/i);
      assert.deepEqual(busyButtons, [], 'aucun contrôle sur un refus de quota');
      assert.equal(sentAfter - sent, 0, 'aucun renvoi automatique');
      assert.deepEqual(await busy.runIds(), [], 'aucun run créé');
    } finally {
      for (const slot of held) slot.release();
    }

    // ------------------------------------------------------------------
    // Erreurs console : aucune applicative
    // ------------------------------------------------------------------
    const errors = browser.consoleEntries.filter((entry) => entry.level === 'error');
    const network = errors.filter((entry) => entry.text.startsWith('Failed to load resource'));
    const script = errors.filter((entry) => !entry.text.startsWith('Failed to load resource'));
    t.diagnostic(`erreurs console : ${String(script.length)} applicatives, ${String(network.length)} réseau`);
    assert.deepEqual(script, [], script.map((entry) => entry.text).join(' | '));
    for (const entry of network) {
      assert.match(entry.text, /status of (422|503)/, `entrée réseau inattendue : ${entry.text}`);
    }
  } finally {
    gate.open();
    if (browser !== undefined) await browser.close();
    for (const item of stands) await item.stop().catch(() => undefined);
    await removeTempDir(dir);
  }
});
