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
import type { ChildProcess } from 'node:child_process';
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

/**
 * Borne de vie d'un écrivain hors processus.
 *
 * Justifiée par les charges réelles de ce fichier : le plus lourd des quatre
 * scripts enfants écrit 300 × 64 Kio, soit environ 19,2 Mio, suivis d'un seul
 * `fsync` ; les deux écrivains lents s'interrompent 400 ms et 40 ms. Démarrage
 * de Node compris, aucun n'approche la seconde en régime normal.
 *
 * Quinze secondes laissent donc un ordre de grandeur de marge au-dessus de la
 * charge observée, tout en restant au quart du délai de test le plus serré du
 * fichier (60 s). Cette marge est le point : le test doit pouvoir rendre un
 * échec attribuable, plutôt que d'être coupé par son propre délai — et à plus
 * forte raison par le plafond de fichier de la campagne d'intégration.
 */
const WRITER_LIFECYCLE_MS = 15_000;

/** Délai laissé à un enfant terminé pour être réellement fermé et récolté. */
const WRITER_TERMINATION_GRACE_MS = 2_000;

interface WriterProcessOptions {
  /** Borne de vie. Abaissée par le test de cycle de vie, jamais ailleurs. */
  readonly lifecycleMs?: number;
  /** Couture d'observation : donne l'enfant réel au test, et à lui seul. */
  readonly onSpawn?: (child: ChildProcess) => void;
}

/**
 * Écrivain hors processus : le lecteur ne partage ni mémoire ni boucle d'événements.
 *
 * ## Ce que la borne ferme
 *
 * La promesse ne se réglait que sur `error` ou `close`. Un enfant qui ne se
 * ferme jamais laissait donc une attente sans issue, et le fichier courait
 * jusqu'au plafond de la campagne. C'était le seul des quatorze fichiers
 * d'intégration lançant un processus à ne posséder aucun chemin de terminaison.
 *
 * ```text
 * ATTENTE BORNÉE   +   CYCLE DE VIE DE L'ENFANT BORNÉ
 * ```
 *
 * Les deux, et pas seulement la première : une promesse qui se réglerait en
 * laissant l'enfant vivre n'aurait fait que déplacer la fuite.
 *
 * La borne est un fait de **harnais**, jamais de produit. Son dépassement ne
 * diagnostique ni une pénurie mémoire, ni une défaillance fournisseur, ni un
 * défaut de CCR : il dit qu'un écrivain de test n'a pas fini dans sa borne.
 */
function writerProcess(
  script: string,
  args: readonly string[],
  options: WriterProcessOptions = {},
): Promise<number | null> {
  const bound = options.lifecycleMs ?? WRITER_LIFECYCLE_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args], { stdio: 'ignore', shell: false });
    options.onSpawn?.(child);

    let settled = false;
    let terminating = false;
    let boundTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // Règlement unique : `error` puis `close`, ou l'inverse, ne peuvent pas
    // régler deux fois, et les deux minuteries meurent avec le premier réglage.
    const settle = (act: () => void): void => {
      if (settled) return;
      settled = true;
      if (boundTimer !== undefined) clearTimeout(boundTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      act();
    };

    boundTimer = setTimeout(() => {
      if (settled) return;
      terminating = true;
      child.kill('SIGKILL');
      // Seconde borne, et elle est indispensable : attendre `close` sans limite
      // après un kill rouvrirait exactement l'attente que cette réparation ferme.
      graceTimer = setTimeout(() => {
        if (settled) return;

        // `killed` n'enregistre que le dispatch du signal, jamais la mort du
        // processus. La seule observation recevable ici est l'état réel du PID.
        const pid = child.pid;
        const probe: LivenessProbe =
          typeof pid === 'number' ? probeLiveness(pid) : { state: 'UNKNOWN' };

        // La grâce est épuisée : l'observation est abandonnée, quelle que soit
        // la classification. Ces gestionnaires ne servent plus.
        child.removeAllListeners('close');
        child.removeAllListeners('error');

        // Et le handle est détaché sur TOUTES ces branches, sans exception.
        // Sans pipes ni IPC, il est la seule référence qui maintiendrait la
        // boucle d'événements en vie — c'est-à-dire exactement la panne que
        // cette réparation ferme. Un enfant qu'on renonce à observer ne doit
        // jamais retenir le processus de test, y compris lorsque la sonde le
        // croit absent : c'est précisément quand elle ne sait pas qu'il faut
        // se détacher.
        //
        // Le détachement ne vaut que sur cette branche : sur le chemin nominal,
        // la boucle doit rester vivante pour observer `close`.
        child.unref();

        const preamble =
          `writerProcess : borne de cycle de vie de ${String(bound)} ms dépassée ; ` +
          `aucune fermeture observée dans les ${String(WRITER_TERMINATION_GRACE_MS)} ms ` +
          'de grâce suivant SIGKILL. ';
        const observed = probe.code === undefined ? '' : ` (sonde : ${probe.code})`;
        const detail =
          probe.state === 'ALIVE'
            ? `L'enfant y a survécu et vit toujours (pid ${String(pid)}). Il est détaché, ` +
              'et reste à la charge du système.'
            : probe.state === 'ABSENT'
              ? `Le processus est absent (pid ${String(pid)})${observed}, mais sa fermeture ` +
                "n'a pas été observée."
              : `La vivacité du processus n'a pas pu être établie (pid ${String(pid)})${observed}. ` +
                'Le handle est détaché ; son sort réel est inconnu.';

        settle(() => reject(new Error(preamble + detail)));
      }, WRITER_TERMINATION_GRACE_MS);
    }, bound);

    child.once('error', (error) => settle(() => reject(error)));

    child.once('close', (code) => {
      settle(() => {
        // Une fermeture consécutive à la terminaison n'est pas une sortie
        // normale : la rendre comme telle masquerait le dépassement.
        if (terminating) {
          reject(
            new Error(
              `writerProcess : borne de cycle de vie de ${String(bound)} ms dépassée ; ` +
                "l'enfant a été terminé, puis fermé.",
            ),
          );
          return;
        }
        resolve(code);
      });
    });
  });
}

/** Enfant qui démarre normalement et ne se termine jamais de lui-même. */
const NEVER_EXITING_WRITER = `
setInterval(() => {}, 1000);
`;

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

// --------------------------------------------------------------------------
// R1 — cycle de vie borné d'un écrivain hors processus
// --------------------------------------------------------------------------

/**
 * Vivacité d'un PID — trois issues, jamais deux.
 *
 * Effondrer « la sonde a levé » en « le processus est absent » serait une
 * affirmation que la sonde ne soutient pas : `EPERM` dit qu'on n'a pas le droit
 * de regarder, pas que rien n'est là.
 *
 * ```text
 * succès    →  ALIVE
 * ESRCH     →  ABSENT
 * autre     →  UNKNOWN
 * ```
 *
 * Les trois codes sont ceux que ce runtime produit réellement : succès pour un
 * PID vivant, `ESRCH` pour un PID absent, `EPERM` pour un processus protégé.
 */
type Liveness = 'ALIVE' | 'ABSENT' | 'UNKNOWN';

interface LivenessProbe {
  readonly state: Liveness;
  /** Code de la sonde, lorsqu'elle en a produit un. */
  readonly code?: string;
}

function probeLiveness(pid: number): LivenessProbe {
  try {
    process.kill(pid, 0);
    return { state: 'ALIVE' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { state: 'ABSENT', code };
    return code === undefined ? { state: 'UNKNOWN' } : { state: 'UNKNOWN', code };
  }
}

/**
 * R1. Un écrivain qui ne se termine jamais est borné, terminé, et réellement
 * récolté.
 *
 * Le défaut fermé ici n'était pas une lenteur : c'était une attente **sans
 * issue**. `writerProcess` ne se réglait que sur `error` ou `close`, si bien
 * qu'un enfant qui ne fermait jamais faisait courir le fichier entier jusqu'au
 * plafond de la campagne d'intégration.
 *
 * Ce test refuse de se contenter d'un rejet. Un rejet prouve que l'attente est
 * bornée ; il ne prouve pas que l'enfant est mort. Les deux sont exigés :
 *
 * ```text
 * ATTENTE BORNÉE   +   CYCLE DE VIE DE L'ENFANT BORNÉ
 * ```
 *
 * La borne locale est courte — le test doit finir en secondes, pas les subir —
 * mais reste largement au-dessus de la latence de lancement d'un processus
 * Windows, pour ne pas dépendre de l'ordonnanceur.
 */
test(
  'R1. un écrivain qui ne se termine jamais est borné, terminé et récolté',
  { timeout: 20_000 },
  async (t) => {
    let observed: ChildProcess | undefined;
    let settlement: 'resolved' | 'rejected' | 'pending' = 'pending';
    let message = '';

    const started = Date.now();
    try {
      await writerProcess(NEVER_EXITING_WRITER, [], {
        lifecycleMs: 750,
        onSpawn: (child) => {
          observed = child;
        },
      });
      settlement = 'resolved';
    } catch (error) {
      settlement = 'rejected';
      message = error instanceof Error ? error.message : String(error);
    }
    const elapsedMs = Date.now() - started;

    assert.ok(observed !== undefined, "l'enfant a bien été lancé");
    const child = observed;
    const pid = child.pid;
    assert.equal(typeof pid, 'number', 'PID observé');

    // 1 · La promesse s'est réglée — et par la borne, jamais par une sortie
    //     naturelle : l'enfant tourne un intervalle sans fin.
    assert.equal(settlement, 'rejected', `réglée par rejet (observé : ${settlement})`);
    assert.match(message, /borne de cycle de vie de 750 ms dépassée/, 'la borne est nommée');

    // 2 · Terminaison tentée ET fermeture réellement observée. Le second
    //     message — celui de la grâce écoulée — vaudrait échec de récolte.
    assert.match(message, /terminé, puis fermé/, 'la fermeture a suivi la terminaison');
    assert.equal(child.killed, true, 'terminaison demandée sur cet enfant');

    // 3 · L'enfant a une issue : Node l'a récolté, il ne reste pas en vol.
    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      `issue de processus observée (exitCode=${String(child.exitCode)} signal=${String(child.signalCode)})`,
    );

    // 4 · Aucun orphelin. Une courte tolérance laisse l'OS finir sa récolte,
    //     et l'assertion exige ABSENT : une sonde qui échoue pour une autre
    //     raison rend UNKNOWN, et UNKNOWN n'est pas une preuve d'absence.
    let probe = probeLiveness(pid as number);
    for (let attempt = 0; attempt < 40 && probe.state !== 'ABSENT'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      probe = probeLiveness(pid as number);
    }
    assert.equal(
      probe.state,
      'ABSENT',
      `aucun orphelin ne subsiste (pid ${String(pid)}, sonde ${probe.state}` +
        `${probe.code === undefined ? '' : ` ${probe.code}`})`,
    );

    // 5 · Le coût du test est en secondes, et la borne domine la mesure.
    assert.ok(elapsedMs < 10_000, `réglé en ${String(elapsedMs)} ms`);

    // 6 · Le chemin nominal reste intact : un enfant qui sort rend son code.
    const code = await writerProcess('process.exit(0);', []);
    assert.equal(code, 0, 'sortie normale : code préservé, aucune terminaison forcée');

    t.diagnostic(
      `borne=750ms · réglage=${settlement} en ${String(elapsedMs)} ms · ` +
        `killed=${String(child.killed)} · exitCode=${String(child.exitCode)} · ` +
        `signal=${String(child.signalCode)} · orphelin=non`,
    );
  },
);
