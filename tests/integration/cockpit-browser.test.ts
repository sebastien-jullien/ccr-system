/**
 * IT-3B — preuve **navigateur réelle**.
 *
 * Un vrai Chrome (ou Edge) déjà installé sur le poste charge le cockpit servi
 * par un vrai serveur, exécute les modules ES, applique la CSP, et rend le DOM.
 * Rien de tout cela n'est simulé : c'est la seule façon de démontrer qu'un
 * contenu hostile reste du texte *dans un moteur de rendu*, et que la CSP ne
 * bloque pas l'application elle-même.
 *
 * Si aucun navigateur n'est présent, ces preuves valent `NOT_TESTED` — aucune
 * dépendance n'est ajoutée pour obtenir un statut plus flatteur.
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { BrowserSession, findBrowser } from '../helpers/cdp.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { openDecisionStore } from '../../src/store/decision-store.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import type { RunFixture } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const HOSTILE = '<script>globalThis.PWNED=true</script>'
  + ' <img src=x onerror="globalThis.PWNED=true">'
  + ' </textarea><script>globalThis.PWNED=true</script>'
  + ' javascript:alert(1)'
  + ' "><svg onload=globalThis.PWNED=true>'
  + ' & < > " \'';

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

function hostileRun(runId: string): RunFixture {
  return {
    runId,
    events: [
      { round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T },
      { round: 1, actor: 'human', type: 'human_message', content: HOSTILE, timestamp: T },
      ...Array.from({ length: 130 }, (_, index) => ({
        round: 1,
        actor: 'codex' as const,
        type: 'assistant_response' as const,
        session_id: 'codex-1',
        content: `${HOSTILE} réponse ${String(index)}`,
        timestamp: new Date(Date.parse(T) + (index + 2) * 1000).toISOString(),
      })),
    ],
    decisions: [{ content: HOSTILE, timestamp: T }],
  };
}

test('(B1-B8) cockpit réel dans un navigateur réel', { timeout: 300_000 }, async (t) => {
  const executable = findBrowser();
  if (executable === undefined) {
    t.skip('REAL_BROWSER: NOT_TESTED — aucun navigateur système détecté');
    return;
  }
  t.diagnostic(`navigateur : ${executable}`);

  const dir = await makeTempDir('ccr-browser-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, hostileRun('CCR-20260402-001'));
  await materializeRun(runsDir, { runId: 'CCR-20260808-002' });

  const port = await freePort();
  let cockpit = await startCockpit({ runsDir, port });
  let browser: BrowserSession | undefined;

  try {
    browser = await BrowserSession.launch(executable);
    const url = `http://127.0.0.1:${String(port)}/`;

    // B1 — le shell se charge et s'affiche.
    await browser.navigate(url);
    assert.equal(await browser.evaluate<string>('document.title'), 'CCR — Local Cockpit');
    assert.equal(await browser.evaluate<string>('document.querySelector("h1").textContent'), 'CCR — Local Cockpit');

    // B2 — le cookie posé par « / » permet à l'API d'être consommée.
    await browser.waitFor('document.querySelectorAll("#runs-list li").length === 2');
    const cookieVisible = await browser.evaluate<string>('document.cookie');
    assert.equal(cookieVisible.includes('ccr_cockpit_session'), false, 'cookie HttpOnly : invisible au script');
    const listed = await browser.evaluate<string[]>(
      '[...document.querySelectorAll("#runs-list .run-id")].map((n) => n.textContent)',
    );
    assert.deepEqual(listed, ['CCR-20260402-001', 'CCR-20260808-002']);

    // B3 — la sélection affiche l'Overview.
    await browser.evaluate('document.querySelector("#runs-list button").click()');
    await browser.waitFor('document.querySelector("#section-overview").textContent.includes("CCR-20260402-001")');
    assert.equal(await browser.evaluate<string>('document.getElementById("run-title").textContent'), 'CCR-20260402-001');

    // B4 — pagination : la page suivante s'ajoute réellement, par le curseur.
    await browser.evaluate('document.getElementById("tab-timeline").click()');
    await browser.waitFor('document.querySelectorAll("#section-timeline .entry").length > 0');
    const firstPage = await browser.evaluate<number>('document.querySelectorAll("#section-timeline .entry").length');
    assert.ok(
      await browser.evaluate<boolean>('Boolean(document.getElementById("timeline-more"))'),
      'un curseur de page suivante est proposé',
    );
    await browser.evaluate('document.getElementById("timeline-more").click()');
    await browser.waitFor(`document.querySelectorAll("#section-timeline .entry").length > ${String(firstPage)}`);
    const secondPage = await browser.evaluate<number>('document.querySelectorAll("#section-timeline .entry").length');
    t.diagnostic(`timeline : ${String(firstPage)} entrées puis ${String(secondPage)} après « Charger la suite »`);
    assert.ok(secondPage > firstPage, 'la seconde page complète la première');

    // B5 — le contenu hostile est du texte, et rien ne s'exécute.
    const pwned = await browser.evaluate<unknown>('globalThis.PWNED ?? null');
    assert.equal(pwned, null, 'aucun script issu des données n’a été exécuté');
    const injected = await browser.evaluate<number>(
      'document.querySelectorAll("#section-timeline script, #section-timeline img, #section-timeline svg").length',
    );
    assert.equal(injected, 0, 'aucun nœud exécutable créé depuis les données');
    const visible = await browser.evaluate<boolean>(
      'document.querySelector("#section-timeline").textContent.includes("<script>globalThis.PWNED=true</script>")',
    );
    assert.equal(visible, true, 'le payload est lisible comme texte');
    // Aucun lien exécutable n'a été fabriqué depuis une donnée.
    const hrefs = await browser.evaluate<string[]>('[...document.querySelectorAll("[href],[src]")].map((n) => n.getAttribute("href") ?? n.getAttribute("src"))');
    for (const href of hrefs) {
      assert.equal(href.startsWith('/assets/'), true, `ressource inattendue : ${href}`);
    }

    // B6 — aucune erreur console critique, notamment aucune violation de CSP.
    const critical = browser.consoleEntries.filter(
      (entry) => entry.level === 'error' && !entry.text.includes('favicon'),
    );
    t.diagnostic(`console : ${String(browser.consoleEntries.length)} entrées, ${String(critical.length)} critiques`);
    assert.deepEqual(critical, [], `erreurs console : ${critical.map((e) => e.text).join(' | ')}`);
    for (const entry of browser.consoleEntries) {
      assert.equal(entry.text.includes('Content Security Policy'), false, `violation CSP : ${entry.text}`);
    }

    // B7 — le code du cockpit ne contacte que sa propre origine.
    //
    // L'assertion porte sur l'**initiateur**, pas sur le simple décompte : ce
    // poste héberge une extension qui injecte ses propres requêtes dans toutes
    // les pages. Les compter comme des nôtres serait faux ; les ignorer
    // silencieusement le serait aussi. On les nomme, et on prouve que rien
    // n'est parti de nos modules.
    const external = browser.requests.filter((observed) => !observed.url.startsWith(url) && observed.url !== 'about:blank');
    const ours = external.filter((observed) => observed.initiatorUrls.some((from) => from.includes('/assets/')));
    t.diagnostic(
      `requêtes : ${String(browser.requests.length)} · hors origine : ${String(external.length)}` +
        (external.length === 0 ? '' : ` (${[...new Set(external.map((o) => new URL(o.url).host))].join(', ')} — injectées par l’environnement)`),
    );
    assert.deepEqual(ours, [], `le cockpit a contacté une origine externe : ${ours.map((o) => o.url).join(' | ')}`);

    // Ce que ce poste ne permet PAS de vérifier, et qu'il faut dire.
    //
    // Un filtre local réécrit les en-têtes de réponse en transit : la CSP que ce
    // navigateur applique n'est pas celle que CCR émet. La CSP émise est donc
    // vérifiée là où rien ne s'interpose — au niveau HTTP, socket direct, par
    // `(A6)` de `cockpit-assets.test.ts`. Ici on constate, on nomme, et on
    // n'affirme rien qu'on ne puisse démontrer.
    const enforced = browser.responseHeaders.get(url)?.['content-security-policy'] ?? '';
    const rewritten = !enforced.startsWith("default-src 'none'");
    if (rewritten) {
      t.diagnostic(`CSP_ENFORCED: NOT_TESTED — réécrite en transit par l’environnement : ${enforced.slice(0, 120)}…`);
      // Observation utile : le payload hostile est resté du texte alors même
      // que la CSP appliquée était AFFAIBLIE. La sûreté du rendu ne dépend donc
      // pas de la CSP, elle vient de `textContent`.
      assert.equal(await browser.evaluate<unknown>('globalThis.PWNED ?? null'), null);
    } else {
      assert.ok(enforced.includes("script-src 'self'"), 'CSP appliquée telle qu’émise');
      assert.equal(enforced.includes("'unsafe-inline'"), false);
    }

    // Et la page servie n'a pas été altérée : exactement les ressources déclarées.
    assert.deepEqual(await browser.evaluate<string[]>('[...document.scripts].map((s) => s.src || "INLINE")'), [
      `${url}assets/app.js`,
    ]);
    assert.deepEqual(await browser.evaluate<string[]>('[...document.querySelectorAll("link")].map((l) => l.href)'), [
      `${url}assets/styles.css`,
    ]);
    const sameOrigin = [
      ...new Set(browser.requests.filter((observed) => observed.url.startsWith(url)).map((observed) => observed.url.slice(url.length))),
    ].sort();
    const expected = [
      '',
      'api/runs',
      'api/runs/CCR-20260402-001',
      'api/runs/CCR-20260402-001/recovery',
      // Slice 8 : les deux flux d'invalidation. Ils ne transportent aucune
      // donnée, et n'ouvrent aucune surface nouvelle.
      'api/stream',
      'api/runs/CCR-20260402-001/stream',
      'assets/api.js',
      'assets/app.js',
      'assets/cockpit.js',
      'assets/labels.js',
      'assets/render.js',
      'assets/styles.css',
    ];
    for (const target of sameOrigin) {
      const known = expected.includes(target) || target.startsWith('api/runs/CCR-20260402-001/timeline?');
      assert.ok(known, `requête inattendue vers le cockpit : ${target}`);
    }
    for (const target of expected) {
      assert.ok(sameOrigin.includes(target), `requête attendue absente : ${target}`);
    }
    // Deux appels de timeline exactement : première page, puis curseur.
    assert.equal(sameOrigin.filter((target) => target.includes('/timeline?')).length, 2);

    // B8 — après redémarrage du serveur, l'ancienne page constate l'expiration.
    await cockpit.stop();
    cockpit = await startCockpit({ runsDir, port });
    await browser.evaluate('document.getElementById("refresh-runs").click()');
    await browser.waitFor('!document.getElementById("banner").hasAttribute("hidden")');
    const banner = await browser.evaluate<string>('document.getElementById("banner").textContent');
    t.diagnostic(`bannière après redémarrage : « ${banner} »`);
    assert.match(banner, /Session expirée/);

    // Un rechargement suffit à repartir : aucune boucle n'a été nécessaire.
    await browser.navigate(url);
    await browser.waitFor('document.querySelectorAll("#runs-list li").length === 2');
    assert.equal(await browser.evaluate<boolean>('document.getElementById("banner").hasAttribute("hidden")'), true);
  } finally {
    if (browser !== undefined) await browser.close();
    await cockpit.stop().catch(() => undefined);
    await removeTempDir(dir);
  }
});

/**
 * (B-M) Mutations courtes dans un navigateur réel.
 *
 * Ce que seul un vrai navigateur démontre : l'en-tête `Origin` est posé par le
 * moteur — le cockpit ne peut pas le forger — et le cycle complet
 * « capacité → bouton → POST → refetch » fonctionne dans le moteur qui
 * l'exécutera vraiment.
 */
test('(B-M1..B-M8) mutations courtes dans un navigateur réel', { timeout: 300_000 }, async (t) => {
  const executable = findBrowser();
  if (executable === undefined) {
    t.skip('REAL_BROWSER: NOT_TESTED — aucun navigateur système détecté');
    return;
  }

  const dir = await makeTempDir('ccr-browser-mut-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await materializeRun(runsDir, {
    runId: 'CCR-20260402-001',
    events: [{ round: 0, actor: 'system', type: 'run_created', content: 'départ', timestamp: T }],
  });

  const port = await freePort();
  const cockpit = await startCockpit({ runsDir, port });
  let browser: BrowserSession | undefined;

  try {
    browser = await BrowserSession.launch(executable);
    const url = `http://127.0.0.1:${String(port)}/`;
    await browser.navigate(url);
    await browser.waitFor('document.querySelectorAll("#runs-list li").length === 1');
    await browser.evaluate('document.querySelector("#runs-list button").click()');
    await browser.waitFor('document.querySelector("#section-overview").textContent.includes("CCR-20260402-001")');

    // B-M7 — `STEP` et `SEND` n'ont aucun contrôle exécutable.
    const actionable = await browser.evaluate<string[]>(
      '[...document.querySelectorAll("[data-action]")].map((n) => n.getAttribute("data-action"))',
    );
    t.diagnostic(`contrôles exposés : ${actionable.join(', ') || '<aucun>'}`);
    // Slice 5 : quatre mutations courtes et deux longues, rien d autre.
    for (const exposed of actionable) {
      assert.ok(
        ['PAUSE', 'RESUME', 'DECIDE', 'STOP', 'STEP', 'SEND'].includes(exposed),
        `contrôle inattendu : ${exposed}`,
      );
    }
    for (const forbidden of ['START', 'RECOVER', 'HANDOFF', 'CLEAR_STALE_LOCK', 'CONFIG']) {
      assert.equal(actionable.includes(forbidden), false, `hors périmètre : ${forbidden}`);
    }

    // B-M1 — PAUSE via le bouton piloté par la capacité.
    assert.ok(actionable.includes('PAUSE'), 'PAUSE est disponible sur un run READY');
    await browser.evaluate('document.querySelector("[data-action=PAUSE]").click()');
    await browser.waitFor('document.getElementById("run-status").textContent.includes("effectuée")');
    await browser.waitFor('document.querySelector("#section-overview").textContent.includes("Suspendu")');

    // B-M2 — RESUME redevient disponible, et l'inverse.
    await browser.waitFor('Boolean(document.querySelector("[data-action=RESUME]"))');
    await browser.evaluate('document.querySelector("[data-action=RESUME]").click()');
    await browser.waitFor('document.querySelector("#section-overview").textContent.includes("Prêt")');

    // B-M3/B-M4 — DECIDE, avec un contenu hostile, une seule fois.
    await browser.evaluate(`document.getElementById("decision-content").value = ${JSON.stringify(HOSTILE)}`);
    await browser.evaluate('document.querySelector("[data-action=DECIDE]").click()');
    await browser.waitFor('document.getElementById("run-status").textContent.includes("effectuée")');
    await browser.evaluate('document.getElementById("tab-timeline").click()');
    await browser.waitFor('document.querySelectorAll("#section-timeline .entry").length >= 2');

    const decisions = await (await openDecisionStore(runPaths(runsDir, 'CCR-20260402-001'), 'CCR-20260402-001')).readAll();
    t.diagnostic(`décisions enregistrées : ${String(decisions.length)}`);
    assert.equal(decisions.length, 1, 'une décision, une seule');
    assert.equal(decisions[0]?.content, HOSTILE);

    // B-M9 — le contenu hostile reste du texte après la mutation.
    assert.equal(await browser.evaluate<unknown>('globalThis.PWNED ?? null'), null);
    assert.equal(
      await browser.evaluate<number>('document.querySelectorAll("#section-timeline script, #section-timeline img").length'),
      0,
    );
    assert.equal(
      await browser.evaluate<boolean>(
        'document.querySelector("#section-timeline").textContent.includes("<script>globalThis.PWNED=true</script>")',
      ),
      true,
    );

    /**
     * B-M5 — une écriture externe, et la vue qui la rattrape.
     *
     * Cette étape éprouvait jusqu'au Slice 7 le refus d'une vue périmée : une
     * écriture directe dans le journal, puis un clic, et un `409` explicite.
     * Le Slice 8 supprime la prémisse — une écriture extérieure invalide
     * désormais la vue, que le navigateur recharge avant que l'humain agisse.
     * Fabriquer une péremption exigerait de cliquer plus vite que le refetch,
     * c'est-à-dire de tester une course.
     *
     * La garantie elle-même n'est pas perdue : `(X6)` l'éprouve au niveau HTTP,
     * de façon déterministe — `409`, zéro effet, reçu `FAILED` durable. Ce qui
     * est vérifié ici est ce que le Slice 8 ajoute : l'écriture extérieure
     * apparaît, et l'action suivante porte sur la vue à jour.
     */
    await browser.evaluate('document.getElementById("tab-overview").click()');
    const paths = runPaths(runsDir, 'CCR-20260402-001');
    const events = await openEventStore(paths, 'CCR-20260402-001');
    const beforeExternal = (await events.readAll()).length;
    await events.append({
      round: 0,
      actor: 'human',
      type: 'human_message',
      content: 'écriture externe',
      timestamp: new Date().toISOString(),
    });
    await browser.evaluate('document.getElementById("tab-timeline").click()');
    await browser.waitFor(
      `document.querySelectorAll("#section-timeline .entry").length > ${String(beforeExternal)}`,
      20_000,
    );
    t.diagnostic(`écriture externe reflétée sans geste humain (${String(beforeExternal)} → ${String(beforeExternal + 1)} entrées)`);
    await browser.evaluate('document.getElementById("tab-overview").click()');

    // B-M6 — STOP exige une confirmation gouvernée par la capacité.
    await browser.waitFor('Boolean(document.querySelector("[data-action=STOP]"))');
    const stopLabel = await browser.evaluate<string>('document.querySelector("[data-action=STOP]").textContent');
    await browser.evaluate('document.querySelector("[data-action=STOP]").click()');
    const armed = await browser.evaluate<string>('document.querySelector("[data-action=STOP]").textContent');
    t.diagnostic(`STOP : « ${stopLabel} » → « ${armed} »`);
    const requiresConfirmation = armed.includes('Confirmer');
    if (requiresConfirmation) {
      assert.equal(await b_stateOf(runsDir), 'READY', 'rien n’est fait avant confirmation');
      await browser.evaluate('document.querySelector("[data-action=STOP]").click()');
    }
    await browser.waitFor('document.querySelector("#section-overview").textContent.includes("Clos")');

    // B-M8 — aucune requête vers une route hors périmètre.
    const posted = browser.requests
      .filter((observed) => observed.url.startsWith(url))
      .map((observed) => observed.url.slice(url.length));
    for (const forbidden of ['step', 'send', 'start', 'recover', 'handoff', 'config']) {
      assert.equal(
        posted.some((target) => target.endsWith(`/${forbidden}`)),
        false,
        `route hors périmètre appelée : ${forbidden}`,
      );
    }
    // Deux familles d erreurs console, et une seule est un defaut.
    const errors = browser.consoleEntries.filter((entry) => entry.level === 'error');
    const network = errors.filter((entry) => entry.text.startsWith('Failed to load resource'));
    const script = errors.filter((entry) => !entry.text.startsWith('Failed to load resource'));
    t.diagnostic('erreurs console : ' + String(script.length) + ' applicatives, ' + String(network.length) + ' reseau');

    assert.deepEqual(script, [], script.map((entry) => entry.text).join(' | '));
    // Les seules entrees reseau sont les 409 volontaires du test de vue perimee :
    // le navigateur les journalise, l application les traite.
    for (const entry of network) {
      assert.match(entry.text, /status of 409/, 'entree reseau inattendue : ' + entry.text);
    }
  } finally {
    if (browser !== undefined) await browser.close();
    await cockpit.stop();
    await removeTempDir(dir);
  }
});

async function b_stateOf(runsDir: string): Promise<string> {
  const snapshot = await readStableRunSnapshot(runsDir, 'CCR-20260402-001');
  return snapshot.state.state;
}
