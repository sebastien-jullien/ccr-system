/**
 * Reprise dans un **vrai** navigateur (Slice 7).
 *
 * Quatre scénarios, une seule passe Chrome :
 *
 * ```text
 * B1  reprise canonique  → confirmation, POST, succès, vue rechargée
 * B2  verrou périmé      → levée confirmée, verrou absent, action disparue
 * B3  verrou vivant      → aucun bouton destructif
 * B4  UNKNOWN            → dit tel quel, aucun rejeu, aucun second envoi
 * ```
 *
 * Plus une injection hostile dans un texte affiché par la reprise.
 *
 * Ce qui est réel : Chrome, le serveur, les sockets, les fichiers canoniques,
 * et un processus tiers qui détient un verrou. Aucun fournisseur d'IA.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import { createOperationStore } from '../../src/cockpit/operations-store.ts';
import type { ClaimInput, ClaimResult, OperationStore } from '../../src/cockpit/operations-store.ts';
import { lockFilePath } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { BrowserSession, findBrowser } from '../helpers/cdp.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import type { PendingOperation } from '../../src/core/run.ts';

const CANONICAL = 'CCR-20260402-001';
const STALE = 'CCR-20260808-002';
const LIVE = 'CCR-20260808-003';
const UNCERTAIN = 'CCR-20260808-004';

/** Injection hostile placée dans un motif d'ambiguïté, donc affiché par la reprise. */
const HOSTILE = '<img src=x onerror="globalThis.PWNED_RECOVERY=true"><script>globalThis.PWNED_RECOVERY=true</script>';

const DEAD_PID = 2 ** 30;

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

const selectRun = (runId: string): string =>
  `Array.from(document.querySelectorAll('#runs-list button')).find((b) => b.textContent.includes('${runId}')).click()`;

const RECOVERY_BUTTONS = "Array.from(document.querySelectorAll('#recovery-body button')).map((b) => b.getAttribute('data-recovery'))";

test('(B1..B4) reprise dans un navigateur réel', { timeout: 300_000 }, async (t) => {
  const executable = findBrowser();
  if (executable === undefined) {
    t.skip('REAL_BROWSER: NOT_TESTED — aucun navigateur système détecté');
    return;
  }

  const dir = await makeTempDir('ccr-browser-recovery-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });

  const created = { round: 0, actor: 'system' as const, type: 'run_created' as const, content: 'départ', timestamp: T };
  const prompt = { round: 0, actor: 'human' as const, type: 'prompt_sent' as const, content: 'contexte initial', timestamp: T };

  // B1 + XSS : une ambiguïté acquittable, dont le motif est hostile.
  await materializeRun(runsDir, {
    runId: CANONICAL,
    state: {
      state: 'RECOVERY_REQUIRED',
      control: 'HUMAN',
      pending_operation: PENDING,
      uncertainty: { reason: HOSTILE, since: T, agent: 'claude', last_event_id: 'evt_000002' },
    } as never,
    events: [created, prompt],
  });
  await materializeRun(runsDir, { runId: STALE, events: [created] });
  await materializeRun(runsDir, { runId: LIVE, events: [created] });
  await materializeRun(runsDir, {
    runId: UNCERTAIN,
    state: { state: 'WAITING_AGENT', pending_operation: PENDING } as never,
    events: [created, prompt],
  });

  for (const runId of [CANONICAL, STALE, LIVE, UNCERTAIN]) {
    const file = runPaths(runsDir, runId).manifest;
    const manifest = JSON.parse(await readFile(file, 'utf8')) as { workspace: { cwd: string } };
    manifest.workspace.cwd = dir;
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  // B2 : verrou périmé, propriétaire mort.
  const stalePaths = runPaths(runsDir, STALE);
  await writeFile(
    lockFilePath(stalePaths),
    `${JSON.stringify({ lock_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pid: DEAD_PID, hostname: hostname(), started_at: T, command: 'step' }, null, 2)}\n`,
    'utf8',
  );

  // B3 : verrou détenu par un processus réellement vivant.
  const holder: ChildProcess = spawn(process.execPath, ['tests/fixtures/hold-run-lock.mjs', runsDir, LIVE, 'send'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    holder.stdout?.once('data', () => resolve());
    holder.once('error', reject);
  });

  const dataRoot = resolveCockpitDataRoot(runsDir);
  await mkdir(dataRoot.controlDir, { recursive: true });

  /**
   * Store réel, à une exception près : toute revendication portant sur le run
   * `UNCERTAIN` rend un reçu déjà `UNKNOWN`, comme après un redémarrage.
   *
   * C'est le seul moyen d'atteindre cet écran sans tuer le cockpit en pleine
   * requête pilotée par le navigateur. Le compteur, lui, est réel : il verra
   * tout second envoi.
   */
  let claims = 0;
  const realStore = createOperationStore(dataRoot, 'instance-navigateur');
  const store: OperationStore = {
    ...realStore,
    async claim(input: ClaimInput): Promise<ClaimResult> {
      claims += 1;
      const claimed = await realStore.claim(input);
      if (input.runId !== UNCERTAIN) return claimed;
      return { kind: 'EXISTING', receipt: { ...claimed.receipt, status: 'UNKNOWN' } };
    },
  };

  let providerCalls = 0;
  const adapters: AgentAdapters = {
    claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', onCall: async () => {
      providerCalls += 1;
    } }),
    codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', onCall: async () => {
      providerCalls += 1;
    } }),
  };

  const port = await freePort();
  const cockpit = await startCockpit({
    runsDir,
    port,
    operationsStore: store,
    depsOverrides: { createAdapters: () => adapters },
  });
  let browser: BrowserSession | undefined;

  try {
    browser = await BrowserSession.launch(executable);
    await browser.navigate(`http://127.0.0.1:${String(port)}/`);
    await browser.waitFor('document.querySelectorAll("#runs-list li").length === 4');

    // ----------------------------------------------------------------------
    // B1 — reprise canonique
    // ----------------------------------------------------------------------
    await browser.evaluate(selectRun(CANONICAL));
    await browser.waitFor(`document.querySelector("#section-overview").textContent.includes("${CANONICAL}")`);
    await browser.evaluate('document.getElementById("tab-recovery").click()');
    await browser.waitFor(`${RECOVERY_BUTTONS}.length > 0`);

    const offered = await browser.evaluate<string[]>(RECOVERY_BUTTONS);
    t.diagnostic(`B1 · capacités offertes : ${offered.join(', ')}`);
    assert.deepEqual(offered, ['RECOVERY_ACKNOWLEDGE_AMBIGUITY']);

    // XSS — le motif hostile est affiché comme texte, et rien ne s'exécute.
    const shown = await browser.evaluate<string>('document.getElementById("recovery-body").textContent');
    assert.ok(shown.includes('<img src=x'), 'le motif hostile est rendu littéralement');
    assert.equal(await browser.evaluate<unknown>('globalThis.PWNED_RECOVERY ?? null'), null);
    assert.equal(await browser.evaluate<number>('document.querySelectorAll("#recovery-body script, #recovery-body img, #recovery-body svg").length'), 0);
    t.diagnostic('XSS · motif hostile rendu en texte · aucun script, img ou svg injecté');

    // Confirmation : le premier clic arme, il n'envoie pas.
    await browser.evaluate('document.getElementById("recovery-acknowledgement").value = "Vérifié au terminal."');
    const claimsBeforeArm = claims;
    await browser.evaluate('document.querySelector("#recovery-body button[data-recovery]").click()');
    const armedLabel = await browser.evaluate<string>('document.querySelector("#recovery-body button[data-recovery]").textContent');
    t.diagnostic(`B1 · après le premier clic : « ${armedLabel} » · revendications=${String(claims - claimsBeforeArm)}`);
    assert.ok(armedLabel.startsWith('Confirmer'), 'le premier clic demande confirmation');
    assert.equal(claims - claimsBeforeArm, 0, 'aucun envoi avant confirmation');

    const revisionBefore = (await readStableRunSnapshot(runsDir, CANONICAL)).revision;
    await browser.evaluate('document.querySelector("#recovery-body button[data-recovery]").click()');
    await browser.waitFor('document.getElementById("recovery-status").textContent.includes("effectuée")');

    const revisionAfter = (await readStableRunSnapshot(runsDir, CANONICAL)).revision;
    const stateAfter = (await readStableRunSnapshot(runsDir, CANONICAL)).state.state;
    t.diagnostic(`B1 · état ${stateAfter} · révision changée=${String(revisionAfter !== revisionBefore)} · fournisseurs=${String(providerCalls)}`);
    assert.notEqual(revisionAfter, revisionBefore, "l'effet canonique a eu lieu");
    assert.equal(providerCalls, 0, 'une reprise courte ne joint aucun fournisseur');
    // La vue a été rechargée depuis le cœur : la capacité consommée a disparu.
    await browser.waitFor(`${RECOVERY_BUTTONS}.length === 0`);
    const overview = await browser.evaluate<string>('document.getElementById("section-overview").textContent');
    assert.ok(overview.includes('CCR-20260402-001'), 'la vue canonique est rechargée');

    // ----------------------------------------------------------------------
    // B2 — levée d'un verrou périmé
    // ----------------------------------------------------------------------
    await browser.evaluate(selectRun(STALE));
    await browser.waitFor(`document.querySelector("#section-overview").textContent.includes("${STALE}")`);
    await browser.evaluate('document.getElementById("tab-recovery").click()');
    await browser.waitFor(`${RECOVERY_BUTTONS}.includes('RECOVERY_CLEAR_STALE_LOCK')`);
    t.diagnostic(`B2 · capacités offertes : ${(await browser.evaluate<string[]>(RECOVERY_BUTTONS)).join(', ')}`);

    const revisionStaleBefore = (await readStableRunSnapshot(runsDir, STALE)).revision;
    await browser.evaluate('document.querySelector("#recovery-body button[data-recovery=\\"RECOVERY_CLEAR_STALE_LOCK\\"]").click()');
    const clearLabel = await browser.evaluate<string>('document.querySelector("#recovery-body button[data-recovery=\\"RECOVERY_CLEAR_STALE_LOCK\\"]").textContent');
    assert.ok(clearLabel.startsWith('Confirmer'), 'la levée demande une confirmation explicite');
    assert.equal(existsSync(lockFilePath(stalePaths)), true, 'rien n’est supprimé avant confirmation');

    await browser.evaluate('document.querySelector("#recovery-body button[data-recovery=\\"RECOVERY_CLEAR_STALE_LOCK\\"]").click()');
    await browser.waitFor('document.getElementById("recovery-status").textContent.includes("effectuée")');
    await browser.waitFor(`${RECOVERY_BUTTONS}.includes('RECOVERY_CLEAR_STALE_LOCK') === false`);

    t.diagnostic(`B2 · verrou après levée : ${String(existsSync(lockFilePath(stalePaths)))} · action encore offerte : non`);
    assert.equal(existsSync(lockFilePath(stalePaths)), false, 'le verrou périmé a été levé');
    assert.equal((await readStableRunSnapshot(runsDir, STALE)).revision, revisionStaleBefore, 'aucun fait canonique touché');
    assert.equal(providerCalls, 0, 'aucune reprise enchaînée automatiquement');

    // ----------------------------------------------------------------------
    // B3 — verrou vivant : aucune action destructive
    // ----------------------------------------------------------------------
    await browser.evaluate(selectRun(LIVE));
    await browser.waitFor(`document.querySelector("#section-overview").textContent.includes("${LIVE}")`);
    await browser.evaluate('document.getElementById("tab-recovery").click()');
    await browser.waitFor('document.getElementById("recovery-body").textContent.length > 0');

    const liveButtons = await browser.evaluate<string[]>(RECOVERY_BUTTONS);
    const liveObservation = await browser.evaluate<string>('document.getElementById("recovery-body").textContent');
    t.diagnostic(`B3 · boutons=${liveButtons.length === 0 ? '<aucun>' : liveButtons.join(', ')}`);
    assert.equal(liveButtons.includes('RECOVERY_CLEAR_STALE_LOCK'), false, 'un verrou vivant n’ouvre aucune levée');
    assert.equal(
      await browser.evaluate<number>('document.querySelectorAll("#recovery-body .is-destructive").length'),
      0,
      'aucun contrôle destructif',
    );
    assert.ok(liveObservation.length > 0, 'la situation reste décrite');
    assert.equal(existsSync(lockFilePath(runPaths(runsDir, LIVE))), true, 'le verrou vivant est intact');

    // ----------------------------------------------------------------------
    // B4 — résultat inconnu
    // ----------------------------------------------------------------------
    await browser.evaluate(selectRun(UNCERTAIN));
    await browser.waitFor(`document.querySelector("#section-overview").textContent.includes("${UNCERTAIN}")`);
    await browser.evaluate('document.getElementById("tab-recovery").click()');
    await browser.waitFor(`${RECOVERY_BUTTONS}.length > 0`);

    const claimsBefore = claims;
    await browser.evaluate('document.querySelector("#recovery-body button[data-recovery]").click()');
    await browser.waitFor('document.getElementById("recovery-status").textContent.includes("résultat inconnu")');

    const unknownText = await browser.evaluate<string>('document.getElementById("recovery-status").textContent');
    t.diagnostic(`B4 · ${unknownText.slice(0, 110)}`);
    assert.match(unknownText, /résultat inconnu/);
    assert.match(unknownText, /Aucun rejeu n’est tenté/);

    // Aucune reprise ne repart seule : on observe, sans rien toucher.
    const claimsAfterFirst = claims;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    t.diagnostic(`B4 · revendications pendant l'observation : ${String(claims - claimsAfterFirst)}`);
    assert.equal(claims - claimsAfterFirst, 0, 'aucun second envoi pendant l’observation');
    assert.equal(claims - claimsBefore, 1, 'exactement une revendication pour un clic');

    // Le seul geste offert consulte le reçu ; il ne réémet rien.
    assert.equal(await browser.evaluate<boolean>('Boolean(document.getElementById("recovery-check"))'), true);
    await browser.evaluate('document.getElementById("recovery-check").click()');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(claims - claimsAfterFirst, 0, 'vérifier n’est pas réémettre');

    const consoleErrors = browser.consoleEntries.filter((entry) => entry.level === 'error');
    t.diagnostic(`console : ${String(consoleErrors.length)} erreur(s)`);
    assert.equal(await browser.evaluate<unknown>('globalThis.PWNED_RECOVERY ?? null'), null);
  } finally {
    holder.kill('SIGKILL');
    if (browser !== undefined) await browser.close();
    await cockpit.stop();
    await removeTempDir(dir);
  }
});
