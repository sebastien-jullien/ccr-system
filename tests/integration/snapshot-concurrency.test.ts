/**
 * IT-0C — cohérence multi-sources sous écriture concurrente réelle.
 *
 * Ce que les seams ne peuvent pas prouver : sur le **vrai** système de fichiers,
 * avec un écrivain dans un **autre processus**, une lecture des quatre sources
 * canoniques ne rend jamais un mélange qui n'a pas coexisté.
 *
 * Quatre preuves :
 *
 *  A. remplacement atomique de `state.json` pendant la lecture ;
 *  B. append d'un événement réel pendant la lecture ;
 *  C. création puis append de `decisions.jsonl` pendant la lecture ;
 *  D. lecture aboutissant alors qu'un run lock réel est détenu.
 *
 * Plus un stress borné mêlant les trois familles d'écriture.
 *
 * Aucun fournisseur IA n'est sollicité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { runPaths } from '../../src/store/layout.ts';
import { buildInitialState, writeManifest, writeState } from '../../src/store/state-store.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { MANIFEST_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { RunManifest } from '../../src/core/run.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260402-001';

function manifestOf(): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'T',
    created_at: '2026-08-08T00:00:00.000Z',
    workspace: { cwd: 'E:/prog/exemple' },
    agents: {
      claude: { session_id: 'claude-1', role: 'challenger' },
      codex: { session_id: 'codex-1', role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
  };
}

async function prepare(prefix: string): Promise<{ dir: string; runsDir: string; paths: ReturnType<typeof runPaths> }> {
  const dir = await makeTempDir(prefix);
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeManifest(paths, manifestOf());
  await writeState(paths, buildInitialState(RUN_ID, 'READY', new Date('2026-08-08T00:00:00.000Z')));
  const events = await openEventStore(paths, RUN_ID);
  await events.append({
    round: 0,
    actor: 'system',
    type: 'run_created',
    content: 'T',
    timestamp: '2026-08-08T00:00:00.000Z',
  });
  return { dir, runsDir, paths };
}

interface Writer {
  kill(): void;
  /** Résolue à la fermeture. Capturée AU SPAWN : un écouteur attaché après la
   *  fermeture ne se déclencherait jamais. */
  readonly done: Promise<void>;
}

function writer(script: string, args: readonly string[]): Writer {
  const child = spawn(process.execPath, ['-e', script, ...args], { stdio: 'ignore', shell: false });
  const done = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  return { kill: () => child.kill(), done };
}

/** Remplace `state.json` en boucle, par écriture atomique (tmp + rename). */
const STATE_WRITER = `
const fs = require('node:fs');
const [file, iterations, pauseMs] = process.argv.slice(1);
const base = JSON.parse(fs.readFileSync(file, 'utf8'));
let i = 0;
const timer = setInterval(() => {
  i += 1;
  const next = { ...base, round: i, updated_at: new Date(1767225600000 + i * 1000).toISOString() };
  const tmp = file + '.tmp' + i;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\\n');
  fs.renameSync(tmp, file);
  if (i >= Number(iterations)) { clearInterval(timer); }
}, Number(pauseMs));
`;

/** Ajoute des événements CCR valides. */
const EVENT_WRITER = `
const fs = require('node:fs');
const [file, runId, first, count, pauseMs] = process.argv.slice(1);
let i = Number(first) - 1;
const timer = setInterval(() => {
  i += 1;
  const line = JSON.stringify({
    event_id: 'evt_' + String(i).padStart(6, '0'),
    run_id: runId,
    round: 0,
    actor: 'system',
    type: 'state_changed',
    details: { n: i },
    timestamp: '2026-08-08T00:00:00.000Z',
  });
  fs.appendFileSync(file, line + '\\n');
  if (i >= Number(first) - 1 + Number(count)) { clearInterval(timer); }
}, Number(pauseMs));
`;

/** Crée puis alimente `decisions.jsonl`. */
const DECISION_WRITER = `
const fs = require('node:fs');
const [file, runId, count, pauseMs] = process.argv.slice(1);
let i = 0;
const timer = setInterval(() => {
  i += 1;
  const line = JSON.stringify({
    decision_id: 'DEC-' + String(i).padStart(4, '0'),
    run_id: runId,
    round: 0,
    author: 'human',
    status: 'ACTIVE',
    content: 'décision ' + i,
    timestamp: '2026-08-08T00:00:00.000Z',
  });
  fs.appendFileSync(file, line + '\\n');
  if (i >= Number(count)) { clearInterval(timer); }
}, Number(pauseMs));
`;

/** Lit en boucle pendant l'écriture ; compte succès, reprises et exhaustions. */
async function readWhileWriting(
  runsDir: string,
  durationMs: number,
  check: (snapshot: Awaited<ReturnType<typeof readStableRunSnapshot>>) => void,
): Promise<{ reads: number; retries: number; unstable: number }> {
  let reads = 0;
  let retries = 0;
  let unstable = 0;
  const deadline = Date.now() + durationMs;

  while (Date.now() < deadline) {
    try {
      const snapshot = await readStableRunSnapshot(runsDir, RUN_ID, {
        onUnstable: () => {
          retries += 1;
        },
      });
      reads += 1;
      check(snapshot);
    } catch (error) {
      if (isCcrError(error) && error.code === 'SNAPSHOT_UNSTABLE') {
        unstable += 1;
        continue;
      }
      throw error;
    }
  }
  return { reads, retries, unstable };
}

// --------------------------------------------------------------------------

test('A. remplacement atomique concurrent de state.json', { timeout: 60_000 }, async (t) => {
  const { dir, runsDir, paths } = await prepare('ccr-snapc-a-');
  try {
    const child = writer(STATE_WRITER, [paths.state, '60', '5']);
    const stats = await readWhileWriting(runsDir, 1_500, (snapshot) => {
      // Cohérence exigible : l'état lu est toujours un document valide et
      // complet, jamais un mélange partiel.
      assert.equal(snapshot.state.run_id, RUN_ID);
      assert.equal(snapshot.manifest.run_id, RUN_ID);
      assert.ok(snapshot.state.round >= 0);
    });
    child.kill();
    await child.done;

    t.diagnostic(
      `lectures=${String(stats.reads)} · reprises=${String(stats.retries)} · ` +
        `exhaustions=${String(stats.unstable)}`,
    );
    assert.ok(stats.reads > 0, 'au moins une fenêtre cohérente a été trouvée');
  } finally {
    await removeTempDir(dir);
  }
});

test('B. append concurrent d’événements réels', { timeout: 60_000 }, async (t) => {
  const { dir, runsDir, paths } = await prepare('ccr-snapc-b-');
  try {
    const child = writer(EVENT_WRITER, [paths.events, RUN_ID, '2', '80', '5']);
    let maxEvents = 0;
    let mismatch = '<aucune>';
    let stats: { reads: number; retries: number; unstable: number } = { reads: 0, retries: 0, unstable: 0 };
    let failure: unknown;
    try {
      stats = await readWhileWriting(runsDir, 1_500, (snapshot) => {
        // Un préfixe strictement croissant, jamais un trou ni un doublon.
        snapshot.events.forEach((event, index) => {
          const expected = `evt_${String(index + 1).padStart(6, '0')}`;
          if (event.event_id !== expected && mismatch === '<aucune>') {
            mismatch = `rang=${String(index)} attendu=${expected} lu=${event.event_id} sur ${String(snapshot.events.length)}`;
          }
          assert.equal(event.event_id, expected);
        });
        maxEvents = Math.max(maxEvents, snapshot.events.length);
      });
    } catch (error) {
      // Une assertion levée DANS la boucle de lecture emporterait sinon avec
      // elle toute l'instrumentation : elle est relevée ici, publiée plus bas,
      // puis relancée intacte. Le verdict ne change pas ; l'évidence survit.
      failure = error;
    }
    child.kill();
    const producerExit = await child.done;

    // ----------------------------------------------------------------------
    // Instrumentation permanente — test uniquement.
    //
    // Une occurrence historique de ce test a échoué sans laisser de signature,
    // et 75 exécutions ultérieures ne l'ont pas reproduite. Ce qui manquait
    // n'était pas une assertion de plus, mais de quoi *distinguer* les causes
    // possibles à la prochaine récidive :
    //
    //   perte d'écriture    persisted < attendu du producteur
    //   tail transitoire    dernier fragment non terminé par un saut de ligne
    //   exhaustion correcte  toutes les lectures épuisent leur budget
    //   corruption          une ligne interne inanalysable
    //   synchronisation     rien n'a été écrit pendant la fenêtre de lecture
    //
    // Les diagnostics sont émis AVANT les assertions : une assertion qui lève
    // ne doit pas emporter avec elle l'information qui l'explique. Ils ne
    // modifient ni le lecteur, ni l'écrivain, ni le calendrier, ni le verdict.
    // ----------------------------------------------------------------------
    const raw = await readFile(paths.events, 'utf8');
    const endsWithNewline = raw.endsWith('\n');
    const lines: string[] = raw.split('\n');
    const fragment = endsWithNewline ? '' : (lines[lines.length - 1] ?? '');
    const complete = lines.filter((line) => line.length > 0).length - (endsWithNewline ? 0 : 1);
    let parseable = 0;
    let firstInvalid = -1;
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      if (!endsWithNewline && index === lines.length - 1) break;
      try {
        JSON.parse(line);
        parseable += 1;
      } catch {
        if (firstInvalid < 0) firstInvalid = index + 1;
      }
    }

    t.diagnostic(
      [
        `lectures=${String(stats.reads)}`,
        `reprises=${String(stats.retries)}`,
        `exhaustions=${String(stats.unstable)}`,
        `evenements_max_lus=${String(maxEvents)}`,
        `lignes_completes=${String(complete)}`,
        `lignes_analysables=${String(parseable)}`,
        `premiere_ligne_invalide=${String(firstInvalid)}`,
        `taille_finale=${String(Buffer.byteLength(raw, 'utf8'))}o`,
        `saut_de_ligne_final=${String(endsWithNewline)}`,
        `fragment_final=${String(Buffer.byteLength(fragment, 'utf8'))}o`,
        `producteur=${JSON.stringify(producerExit)}`,
        `rupture_de_prefixe=${mismatch}`,
        `echec_en_boucle=${failure === undefined ? 'non' : String((failure as Error).message).slice(0, 120)}`,
      ].join(' · '),
    );

    if (failure !== undefined) throw failure;
    assert.ok(stats.reads > 0);
    assert.ok(maxEvents > 1, 'des événements concurrents ont bien été observés');
  } finally {
    await removeTempDir(dir);
  }
});

test('C. création puis append concurrent de decisions.jsonl', { timeout: 60_000 }, async (t) => {
  const { dir, runsDir, paths } = await prepare('ccr-snapc-c-');
  try {
    // Le fichier n'existe pas encore : absence puis présence est un changement.
    const child = writer(DECISION_WRITER, [paths.decisions, RUN_ID, '60', '5']);
    let maxDecisions = 0;
    const stats = await readWhileWriting(runsDir, 1_500, (snapshot) => {
      snapshot.decisions.forEach((decision, index) => {
        assert.equal(decision.decision_id, `DEC-${String(index + 1).padStart(4, '0')}`);
      });
      maxDecisions = Math.max(maxDecisions, snapshot.decisions.length);
    });
    child.kill();
    await child.done;

    t.diagnostic(
      `lectures=${String(stats.reads)} · reprises=${String(stats.retries)} · ` +
        `exhaustions=${String(stats.unstable)} · décisions max vues=${String(maxDecisions)}`,
    );
    assert.ok(stats.reads > 0);
    assert.ok(maxDecisions > 0, 'des décisions concurrentes ont bien été observées');
  } finally {
    await removeTempDir(dir);
  }
});

test('D. la lecture aboutit alors qu’un run lock réel est détenu', { timeout: 60_000 }, async (t) => {
  const { dir, runsDir, paths } = await prepare('ccr-snapc-d-');
  try {
    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const lock = await acquireRunLock(paths, 'step');
    try {
      const started = Date.now();
      const snapshot = await readStableRunSnapshot(runsDir, RUN_ID);
      const elapsed = Date.now() - started;
      t.diagnostic(`lecture sous verrou détenu : ${String(elapsed)} ms`);
      assert.equal(snapshot.state.state, 'READY');
      assert.ok(elapsed < 1_000, 'aucune attente de libération du verrou');
    } finally {
      await lock.release();
    }
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Stress borné : les trois familles d'écriture simultanément
// --------------------------------------------------------------------------

test('stress borné — state, events et decisions écrits ensemble', { timeout: 120_000 }, async (t) => {
  const { dir, runsDir, paths } = await prepare('ccr-snapc-stress-');
  try {
    const children = [
      writer(STATE_WRITER, [paths.state, '200', '7']),
      writer(EVENT_WRITER, [paths.events, RUN_ID, '2', '200', '9']),
      writer(DECISION_WRITER, [paths.decisions, RUN_ID, '200', '11']),
    ];

    let incoherences = 0;
    const stats = await readWhileWriting(runsDir, 3_000, (snapshot) => {
      // Invariants vérifiables sur les données elles-mêmes.
      snapshot.events.forEach((event, index) => {
        if (event.event_id !== `evt_${String(index + 1).padStart(6, '0')}`) incoherences += 1;
      });
      snapshot.decisions.forEach((decision, index) => {
        if (decision.decision_id !== `DEC-${String(index + 1).padStart(4, '0')}`) incoherences += 1;
      });
      if (snapshot.manifest.run_id !== RUN_ID || snapshot.state.run_id !== RUN_ID) incoherences += 1;
    });

    for (const child of children) child.kill();
    await Promise.all(children.map((c) => c.done));

    t.diagnostic(
      `écritures≈600 · lectures=${String(stats.reads)} · reprises=${String(stats.retries)} · ` +
        `exhaustions=${String(stats.unstable)} · incohérences=${String(incoherences)}`,
    );

    assert.equal(incoherences, 0, 'aucun mélange impossible n’a été qualifié de stable');
    assert.ok(
      stats.reads + stats.unstable > 0,
      'des lectures ont bien été tentées pendant l’écriture continue',
    );
  } finally {
    await removeTempDir(dir);
  }
});
