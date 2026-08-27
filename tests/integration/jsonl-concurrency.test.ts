/**
 * IT-0B — concurrence réelle lecteur/écrivain sur un journal append-only.
 *
 * Ce que ni un seam ni une fixture ne peuvent prouver : sur le **vrai** système
 * de fichiers Windows, un lecteur peut observer la dernière ligne d'un journal
 * pendant qu'elle est encore en cours d'écriture par un **autre processus**.
 *
 * Trois preuves :
 *
 *  A. un fragment transitoire est repris, puis lu intégralement — aucune
 *     fausse corruption ;
 *  B. un fragment jamais complété finit par être signalé, sans troncature ;
 *  C. une ligne complète mais invalide échoue immédiatement, sans attendre.
 *
 * Plus un stress borné : appends soutenus pendant des lectures répétées.
 *
 * Aucun fournisseur IA n'est sollicité. Aucun credential n'est touché.
 *
 * Exécution : npm run test:integration
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readJsonlJournal, parseJournalLine } from '../../src/store/jsonl-journal.ts';
import type { TailRetryBudget } from '../../src/store/jsonl-journal.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

interface Record {
  readonly event_id: string;
}

function parseLine(line: string, lineNumber: number): Record {
  const value = parseJournalLine(line, lineNumber, 'events.jsonl');
  const id = (value as { event_id?: unknown }).event_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`events.jsonl ligne ${lineNumber} : event_id invalide.`);
  }
  return { event_id: id };
}

/** Écrivain hors processus : le lecteur ne partage ni mémoire ni boucle d'événements. */
function writerProcess(script: string, args: readonly string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args], { stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

const SLOW_WRITER = `
const fs = require('node:fs');
const [file, payloadSize, pauseMs] = process.argv.slice(1);
const payload = 'x'.repeat(Number(payloadSize));
const line = JSON.stringify({ event_id: 'evt_000001', content: payload });
const half = Math.floor(line.length / 2);
const fd = fs.openSync(file, 'a');
// Première moitié : le journal se termine sur un fragment incomplet.
fs.writeSync(fd, line.slice(0, half));
fs.fsyncSync(fd);
setTimeout(() => {
  fs.writeSync(fd, line.slice(half) + '\\n');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}, Number(pauseMs));
`;

const DYING_WRITER = `
const fs = require('node:fs');
const [file] = process.argv.slice(1);
const fd = fs.openSync(file, 'a');
fs.writeSync(fd, '{"event_id":"evt_000002","content":"jamais termin');
fs.fsyncSync(fd);
fs.closeSync(fd);
// Le processus meurt sans jamais compléter la ligne.
process.exit(0);
`;

/** Écrit un événement CCR **schema-valide**, en deux temps. */
const SLOW_EVENT_WRITER = `
const fs = require('node:fs');
const [file, runId, eventId, payloadSize, pauseMs] = process.argv.slice(1);
const line = JSON.stringify({
  event_id: eventId,
  run_id: runId,
  round: 1,
  actor: 'claude',
  type: 'assistant_response',
  content: 'x'.repeat(Number(payloadSize)),
  exit_code: 0,
  timestamp: '2026-08-08T00:00:00.000Z',
});
const half = Math.floor(line.length / 2);
const fd = fs.openSync(file, 'a');
fs.writeSync(fd, line.slice(0, half));
fs.fsyncSync(fd);
setTimeout(() => {
  fs.writeSync(fd, line.slice(half) + '\\n');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}, Number(pauseMs));
`;

const STRESS_WRITER = `
const fs = require('node:fs');
const [file, count, sizeArg] = process.argv.slice(1);
const payload = 'y'.repeat(Number(sizeArg));
const fd = fs.openSync(file, 'a');
for (let i = 1; i <= Number(count); i += 1) {
  const id = 'evt_' + String(i).padStart(6, '0');
  fs.writeSync(fd, JSON.stringify({ event_id: id, content: payload }) + '\\n');
}
fs.fsyncSync(fd);
fs.closeSync(fd);
`;

// --------------------------------------------------------------------------
// Test A — fragment transitoire réel
// --------------------------------------------------------------------------

test(
  'A. un fragment en cours d’écriture par un autre processus est repris, jamais signalé corrompu',
  { timeout: 60_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-jsonl-real-a-');
    try {
      const file = path.join(dir, 'events.jsonl');
      await writeFile(file, `${JSON.stringify({ event_id: 'evt_000000' })}\n`, 'utf8');

      const initialSize = (await stat(file)).size;

      // 768 KiB : bien au-delà des lignes réelles observées dans le dépôt, et
      // au-delà de toute écriture atomique du système de fichiers.
      const writing = writerProcess(SLOW_WRITER, [file, String(768 * 1024), '400']);

      // Budget ÉLARGI, propre à cette preuve : la pause de 400 ms ci-dessus est
      // volontairement pathologique — un `appendJsonLine` réel dure quelques
      // millisecondes (cf. V2-IMP-29). Le but est d'ouvrir une fenêtre assez
      // large pour observer le fragment de façon fiable, pas de mesurer le
      // budget par défaut : celui-ci est fixé numériquement par le test
      // unitaire « contrat numérique du plafond ».
      const budget: TailRetryBudget = { attempts: 80, delaysMs: [10, 15, 20, 25, 30] };
      let retries = 0;

      // On n'entre en lecture qu'une fois le fragment RÉELLEMENT présent : le
      // démarrage d'un processus Node dure plus longtemps qu'une temporisation
      // arbitraire, et lire trop tôt ne prouverait rien.
      const deadline = Date.now() + 20_000;
      for (;;) {
        if ((await stat(file)).size > initialSize) break;
        assert.ok(Date.now() < deadline, "le writer n'a jamais écrit son fragment");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(!(await readFile(file, 'utf8')).endsWith('\n'), 'le journal se termine bien sur un fragment');

      const records = await readJsonlJournal(file, {
        parseLine,
        budget,
        onTailRetry: () => {
          retries += 1;
        },
      });

      await writing;

      t.diagnostic(
        `invocations reader=1 · reprises sur cette invocation=${String(retries)} · ` +
          `budget de CE test=${String(budget.attempts)} tentatives (élargi, non le défaut)`,
      );
      assert.ok(
        retries <= budget.attempts - 1,
        'aucune invocation ne dépasse le budget qui lui est donné',
      );
      assert.equal(records.length, 2, 'le record complet est présent');
      assert.equal(records[0]?.value.event_id, 'evt_000000', 'le préfixe existant est intact');
      assert.equal(records[1]?.value.event_id, 'evt_000001');
      assert.ok(retries >= 1, 'le fragment transitoire a réellement été observé et repris');

      // Rien n'a été réparé : le fichier contient la ligne complète.
      const raw = await readFile(file, 'utf8');
      assert.ok(raw.endsWith('\n'));
    } finally {
      await removeTempDir(dir);
    }
  },
);

// --------------------------------------------------------------------------
// Test B — fragment jamais complété
// --------------------------------------------------------------------------

test(
  'B. un fragment jamais complété est signalé après un budget borné, sans troncature',
  { timeout: 60_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-jsonl-real-b-');
    try {
      const file = path.join(dir, 'events.jsonl');
      await writeFile(file, `${JSON.stringify({ event_id: 'evt_000001' })}\n`, 'utf8');

      await writerProcess(DYING_WRITER, [file]);
      const before = await readFile(file, 'utf8');

      const startedAt = Date.now();
      let retries = 0;
      await assert.rejects(
        () =>
          readJsonlJournal(file, {
            parseLine,
            onTailRetry: () => {
              retries += 1;
            },
          }),
        (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
      );
      const elapsed = Date.now() - startedAt;

      t.diagnostic(
        `invocations reader=1 · reprises=${String(retries)} (budget par défaut) · ` +
          `sommeil volontaire=100 ms · temps mur=${String(elapsed)} ms`,
      );
      assert.equal(retries, 4, 'budget par défaut entièrement consommé, jamais dépassé');
      assert.ok(elapsed < 2_000, `la reprise reste brève (${String(elapsed)} ms)`);

      // Aucune réparation : le fragment est toujours là, intact.
      assert.equal(await readFile(file, 'utf8'), before, 'ni troncature, ni réécriture');
    } finally {
      await removeTempDir(dir);
    }
  },
);

// --------------------------------------------------------------------------
// Test C — corruption stable terminée
// --------------------------------------------------------------------------

test(
  'C. une ligne complète mais invalide échoue immédiatement, sans temporisation',
  { timeout: 60_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-jsonl-real-c-');
    try {
      const file = path.join(dir, 'events.jsonl');
      await writeFile(file, `${JSON.stringify({ event_id: 'evt_000001' })}\n{"event_id":\n`, 'utf8');

      const startedAt = Date.now();
      let retries = 0;
      await assert.rejects(
        () =>
          readJsonlJournal(file, {
            parseLine,
            onTailRetry: () => {
              retries += 1;
            },
          }),
        (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
      );
      const elapsed = Date.now() - startedAt;

      t.diagnostic(`invocations reader=1 · reprises=0 · sommeil volontaire=0 ms · temps mur=${String(elapsed)} ms`);
      assert.equal(retries, 0, 'aucune reprise : le saut de ligne prouve un append terminé');
      assert.ok(elapsed < 100, `échec immédiat (${String(elapsed)} ms)`);
    } finally {
      await removeTempDir(dir);
    }
  },
);

// --------------------------------------------------------------------------
// Le chemin réel qui avait motivé le finding : `getRunStatus`
// --------------------------------------------------------------------------

test(
  'getRunStatus survit à un append concurrent réel sur events.jsonl',
  { timeout: 60_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-jsonl-status-');
    try {
      const runsDir = path.join(dir, 'runs');
      await mkdir(runsDir, { recursive: true });

      const { startRun, getRunStatus } = await import('../../src/services/run-service.ts');
      const { createFakeAdapter } = await import('../helpers/fake-adapter.ts');
      const { TEST_RUNTIME_CONFIG } = await import('../helpers/runtime-config.ts');
      const adapters = {
        claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
        codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
      };
      const started = await startRun(
        { runsDir, now: () => new Date(), createAdapters: () => adapters },
        { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: dir, prompt: 'p' },
      );

      const events = path.join(runsDir, started.runId, 'events.jsonl');
      const before = await readJsonlJournal(events, { parseLine });
      const initialSize = (await stat(events)).size;

      // Un autre processus ajoute un événement volumineux, en deux temps.
      //
      // La pause est calibrée sur la réalité mesurée : un `appendJsonLine` de
      // 512 KiB — la limite du garde-fou de transfert CCR — dure ~4 ms sur ce
      // poste, et ~21 ms pour 4 MiB. Une fenêtre de 40 ms est donc déjà
      // généreuse, et reste dans le budget par défaut du lecteur (~100 ms),
      // que `getRunStatus` ne peut pas paramétrer.
      const nextEventId = `evt_${String(before.length + 1).padStart(6, '0')}`;
      const writing = writerProcess(SLOW_EVENT_WRITER, [
        events,
        started.runId,
        nextEventId,
        String(512 * 1024),
        '40',
      ]);

      // Lectures répétées pendant toute l'écriture. La propriété éprouvée est
      // celle du finding d'origine : **aucune** de ces lectures ne doit
      // échouer, qu'elle tombe ou non sur le fragment.
      //
      // On ne synchronise pas sur la présence instantanée du fragment : sous
      // charge, la fenêtre peut se refermer entre l'observation et la lecture,
      // et une précondition de ce genre serait un test de l'ordonnanceur, pas
      // du lecteur. La preuve déterministe du mécanisme de reprise est portée
      // par le test A.
      const deps = { runsDir, now: () => new Date(), createAdapters: () => adapters };
      let reads = 0;
      let eventCount = before.length;
      const deadline = Date.now() + 20_000;

      while (eventCount === before.length) {
        assert.ok(Date.now() < deadline, "le writer n'a jamais terminé son append");
        // Historiquement : échec intégral de la lecture du run.
        const status = await getRunStatus(deps);
        reads += 1;
        eventCount = status.eventCount;
        assert.equal(status.state.state, 'READY');
        // Aucune vue partielle : le journal ne perd jamais un préfixe déjà lu.
        assert.ok(eventCount >= before.length, 'aucun record antérieur perdu');
      }

      await writing;

      t.diagnostic(
        `appels getRunStatus=${String(reads)} · invocations reader=${String(reads * 2)} ` +
          `(openEventStore + readAll, chacune plafonnée à 4 reprises) · ` +
          `événements avant=${String(before.length)} · après=${String(eventCount)} · ` +
          `taille initiale=${String(initialSize)} o`,
      );
      assert.equal(eventCount, before.length + 1, "l'événement concurrent est intégralement lu");
    } finally {
      await removeTempDir(dir);
    }
  },
);

// --------------------------------------------------------------------------
// Stress borné
// --------------------------------------------------------------------------

test(
  'stress borné : appends soutenus pendant des lectures répétées',
  { timeout: 120_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-jsonl-stress-');
    try {
      const file = path.join(dir, 'events.jsonl');
      await writeFile(file, '', 'utf8');

      const APPENDS = 300;
      const RECORD_SIZE = 64 * 1024;

      const writing = writerProcess(STRESS_WRITER, [file, String(APPENDS), String(RECORD_SIZE)]);

      let reads = 0;
      let retries = 0;
      let maxSeen = 0;
      const startedAt = Date.now();

      // Lectures répétées pendant toute l'écriture : aucune ne doit produire
      // une fausse corruption.
      while (Date.now() - startedAt < 3_000) {
        const records = await readJsonlJournal(file, {
          parseLine,
          onTailRetry: () => {
            retries += 1;
          },
        });
        reads += 1;
        maxSeen = Math.max(maxSeen, records.length);
        // Un préfixe terminé est déjà un snapshot cohérent : la longueur peut
        // croître d'une lecture à l'autre sans que ce soit une incohérence.
        for (let index = 0; index < records.length; index += 1) {
          assert.equal(records[index]?.value.event_id, `evt_${String(index + 1).padStart(6, '0')}`);
        }
        if (maxSeen >= APPENDS) break;
      }

      await writing;

      const final = await readJsonlJournal(file, { parseLine });
      const elapsed = Date.now() - startedAt;

      t.diagnostic(
        `appends=${String(APPENDS)} · lectures=${String(reads)} · reprises=${String(retries)} · ` +
          `erreurs=0 · durée=${String(elapsed)} ms`,
      );

      assert.equal(final.length, APPENDS, 'tous les records sont présents à la fin');
      assert.deepEqual(
        final.map((r) => r.value.event_id),
        Array.from({ length: APPENDS }, (_, i) => `evt_${String(i + 1).padStart(6, '0')}`),
        'ordre strictement conservé',
      );
      assert.ok(reads > 1, 'plusieurs lectures ont bien eu lieu pendant l’écriture');
    } finally {
      await removeTempDir(dir);
    }
  },
);
