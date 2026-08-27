/**
 * Lecture cohérente des journaux append-only (V2-IMP-29, Slice 0B).
 *
 * L'invariant éprouvé ici tient en deux lignes :
 *
 *   ligne terminée par un saut de ligne  → strictement valide, jamais reprise
 *   fragment final NON terminé           → seul candidat transitoire
 *
 * Tout le reste — troncature, réparation, omission silencieuse, retour
 * partiel — est interdit. Le lecteur est tolérant à la concurrence, jamais à
 * la corruption.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_TAIL_RETRY,
  parseJournalLine,
  readJsonlJournal,
} from '../../src/store/jsonl-journal.ts';
import type { TailRetryBudget } from '../../src/store/jsonl-journal.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { openDecisionStore } from '../../src/store/decision-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const JOURNAL = 'events.jsonl';

/** Validation représentative : objet portant un `event_id` non vide. */
function parseLine(line: string, lineNumber: number): { event_id: string } {
  const value = parseJournalLine(line, lineNumber, JOURNAL);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`${JOURNAL} ligne ${lineNumber} : objet attendu.`), {
      code: 'SCHEMA',
    });
  }
  const id = (value as Record<string, unknown>)['event_id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw Object.assign(new Error(`${JOURNAL} ligne ${lineNumber} : event_id invalide.`), {
      code: 'SCHEMA',
    });
  }
  return { event_id: id };
}

interface Probe {
  readonly reads: string[];
  readonly sleeps: number[];
  readonly retries: number[];
  seams(budget?: TailRetryBudget): {
    read: (file: string) => Promise<string>;
    sleep: (ms: number) => Promise<void>;
    onTailRetry: (attempt: number) => void;
    budget?: TailRetryBudget;
  };
}

/** Séquence de contenus successifs observés par le lecteur, sans course. */
function probeOf(contents: readonly (string | { readonly error: NodeJS.ErrnoException })[]): Probe {
  const reads: string[] = [];
  const sleeps: number[] = [];
  const retries: number[] = [];
  let index = 0;

  return {
    reads,
    sleeps,
    retries,
    seams(budget?: TailRetryBudget) {
      return {
        read: async (): Promise<string> => {
          const next = contents[Math.min(index, contents.length - 1)];
          index += 1;
          if (next !== undefined && typeof next === 'object') throw next.error;
          reads.push(next ?? '');
          return next ?? '';
        },
        sleep: async (ms: number): Promise<void> => {
          sleeps.push(ms);
        },
        onTailRetry: (attempt: number): void => {
          retries.push(attempt);
        },
        ...(budget === undefined ? {} : { budget }),
      };
    },
  };
}

const REC1 = '{"event_id":"evt_000001"}';
const REC2 = '{"event_id":"evt_000002"}';

// --------------------------------------------------------------------------
// (1 à 5) Contrat historique préservé
// --------------------------------------------------------------------------

test('(1) journal absent : lu comme vide, aucun fichier créé', async () => {
  const dir = await makeTempDir('ccr-jsonl-absent-');
  try {
    const file = path.join(dir, 'absent.jsonl');
    assert.deepEqual(await readJsonlJournal(file, { parseLine }), []);
    await assert.rejects(readFile(file, 'utf8'), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT');
  } finally {
    await removeTempDir(dir);
  }
});

test('(2) journal vide, et journal ne contenant qu’un saut de ligne', async () => {
  const empty = probeOf(['']);
  assert.deepEqual(await readJsonlJournal('x', { parseLine, ...empty.seams() }), []);
  assert.deepEqual(empty.retries, [], 'aucune reprise sur un journal vide');

  const newline = probeOf(['\n']);
  assert.deepEqual(await readJsonlJournal('x', { parseLine, ...newline.seams() }), []);
  assert.deepEqual(newline.retries, []);
});

test('(3) plusieurs records valides, lignes blanches ignorées', async () => {
  const p = probeOf([`${REC1}\n\n${REC2}\n`]);
  const records = await readJsonlJournal('x', { parseLine, ...p.seams() });
  assert.deepEqual(
    records.map((r) => r.value.event_id),
    ['evt_000001', 'evt_000002'],
  );
  assert.deepEqual(
    records.map((r) => r.lineNumber),
    [1, 3],
    'les numéros de ligne restent ceux du fichier',
  );
});

test('(4) dernière ligne valide AVEC saut de ligne final : aucune reprise', async () => {
  const p = probeOf([`${REC1}\n${REC2}\n`]);
  const records = await readJsonlJournal('x', { parseLine, ...p.seams() });
  assert.equal(records.length, 2);
  assert.equal(p.reads.length, 1, 'une seule lecture');
  assert.deepEqual(p.retries, []);
});

test('(5) dernière ligne valide SANS saut de ligne final : acceptée telle quelle', async () => {
  const p = probeOf([`${REC1}\n${REC2}`]);
  const records = await readJsonlJournal('x', { parseLine, ...p.seams() });
  assert.deepEqual(
    records.map((r) => r.value.event_id),
    ['evt_000001', 'evt_000002'],
  );
  assert.equal(records[1]?.lineNumber, 2);
  assert.equal(p.reads.length, 1, 'un contenu final complet n’exige aucun saut de ligne');
  assert.deepEqual(p.retries, [], 'et ne déclenche aucune reprise');
});

// --------------------------------------------------------------------------
// (6, 7, 12) Corruption stable : échec immédiat, sans aucune reprise
// --------------------------------------------------------------------------

test('(6) ligne interne JSON invalide : échec immédiat, une seule tentative', async () => {
  const p = probeOf([`${REC1}\nBROKEN\n${REC2}\n`]);
  await assert.rejects(
    () => readJsonlJournal('x', { parseLine, ...p.seams() }),
    (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
  );
  assert.equal(p.reads.length, 1, 'une ligne interne ne peut pas devenir valide par un append');
  assert.deepEqual(p.retries, []);
  assert.deepEqual(p.sleeps, []);
});

test('(7) dernière ligne JSON invalide MAIS terminée : échec immédiat', async () => {
  const p = probeOf([`${REC1}\n{"event_id":\n`]);
  await assert.rejects(
    () => readJsonlJournal('x', { parseLine, ...p.seams() }),
    (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
  );
  assert.equal(p.reads.length, 1, 'le saut de ligne prouve que l’append est terminé');
  assert.deepEqual(p.retries, []);
});

test('(12) dernière ligne schema-invalide MAIS terminée : échec immédiat', async () => {
  const p = probeOf([`${REC1}\n{"autre":"champ"}\n`]);
  await assert.rejects(
    () => readJsonlJournal('x', { parseLine, ...p.seams() }),
    (error: unknown) => (error as { code?: string }).code === 'SCHEMA',
  );
  assert.equal(p.reads.length, 1);
  assert.deepEqual(p.retries, []);
});

// --------------------------------------------------------------------------
// (8 à 11) Fragment final non terminé : seul candidat transitoire
// --------------------------------------------------------------------------

test('(8bis) contrat numérique du plafond, en valeurs littérales', async () => {
  // Ce test est volontairement écrit avec des littéraux, et non par
  // comparaison à `DEFAULT_TAIL_RETRY` : une modification du budget par défaut
  // doit être un choix explicite, visible dans un diff, jamais un effet de
  // bord. Il fixe le plafond d'UNE invocation.
  assert.deepEqual(
    { attempts: DEFAULT_TAIL_RETRY.attempts, delaysMs: [...DEFAULT_TAIL_RETRY.delaysMs] },
    { attempts: 5, delaysMs: [5, 15, 30, 50] },
    'budget par défaut normé',
  );

  const p = probeOf([`${REC1}\n{"event_id":"evt_0000`]);
  await assert.rejects(
    () => readJsonlJournal('x', { parseLine, ...p.seams() }),
    (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
  );

  assert.equal(p.reads.length, 5, 'lectures physiques : 1 initiale + 4 reprises');
  assert.equal(p.retries.length, 4, 'appels à onTailRetry');
  assert.equal(p.sleeps.length, 4, 'appels à sleep');
  assert.deepEqual(p.sleeps, [5, 15, 30, 50], 'séquence exacte des délais');
  assert.deepEqual(p.retries, [1, 2, 3, 4], 'numéro de tentative transmis');
});

test('(8) fragment final JSON incomplet : reprises engagées', async () => {
  const p = probeOf([`${REC1}\n{"event_id":"evt_0000`]);
  await assert.rejects(() => readJsonlJournal('x', { parseLine, ...p.seams() }));
  assert.equal(p.reads.length, DEFAULT_TAIL_RETRY.attempts, 'tout le budget est consommé');
  assert.deepEqual(p.retries, [1, 2, 3, 4]);
  assert.deepEqual(p.sleeps, [...DEFAULT_TAIL_RETRY.delaysMs]);
});

test('(9) fragment complété à la tentative suivante : succès, aucune perte', async () => {
  const p = probeOf([
    `${REC1}\n{"event_id":"evt_0000`, // écriture en cours
    `${REC1}\n${REC2}\n`, // append terminé
  ]);
  const records = await readJsonlJournal('x', { parseLine, ...p.seams() });
  assert.deepEqual(
    records.map((r) => r.value.event_id),
    ['evt_000001', 'evt_000002'],
  );
  assert.equal(p.reads.length, 2);
  assert.deepEqual(p.retries, [1], 'une seule reprise a suffi');
});

test('(10) fragment jamais complété : erreur après épuisement du budget', async () => {
  const p = probeOf([`${REC1}\n{"event_id":"evt_0000`]);
  await assert.rejects(
    () => readJsonlJournal('x', { parseLine, ...p.seams({ attempts: 3, delaysMs: [1, 2] }) }),
    (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
  );
  assert.equal(p.reads.length, 3, 'budget respecté, aucune boucle infinie');
  assert.deepEqual(p.sleeps, [1, 2]);
});

test('(11) fragment final parsable mais schema-invalide : repris, puis erreur stable', async () => {
  // Un tel fragment peut être un enregistrement en cours d'écriture ; il est
  // donc retenté. Épuisé, il devient une invalidité stable — et l'erreur
  // rendue est exactement celle de la validation, pas une erreur inventée.
  const p = probeOf([`${REC1}\n{"autre":"champ"}`]);
  await assert.rejects(
    () => readJsonlJournal('x', { parseLine, ...p.seams({ attempts: 2, delaysMs: [1] }) }),
    (error: unknown) => (error as { code?: string }).code === 'SCHEMA',
  );
  assert.equal(p.reads.length, 2);
  assert.deepEqual(p.retries, [1]);
});

test('(11bis) fragment schema-invalide devenu valide : accepté sans erreur', async () => {
  const p = probeOf([`${REC1}\n{"autre":"champ"}`, `${REC1}\n${REC2}\n`]);
  const records = await readJsonlJournal('x', { parseLine, ...p.seams() });
  assert.equal(records.length, 2);
});

// --------------------------------------------------------------------------
// (13, 14) Ordre et intégralité
// --------------------------------------------------------------------------

test('(13/14) l’ordre est strictement conservé et rien n’est perdu', async () => {
  const ids = Array.from({ length: 50 }, (_, i) => `evt_${String(i + 1).padStart(6, '0')}`);
  const p = probeOf([`${ids.map((id) => JSON.stringify({ event_id: id })).join('\n')}\n`]);
  const records = await readJsonlJournal('x', { parseLine, ...p.seams() });
  assert.deepEqual(
    records.map((r) => r.value.event_id),
    ids,
    'aucune déduplication, aucune fusion, aucune réorganisation',
  );
});

test('aucun record antérieur n’est perdu lorsqu’un fragment est repris', async () => {
  const head = `${REC1}\n${REC2}\n`;
  const p = probeOf([`${head}{"event_id":"evt_0000`, `${head}{"event_id":"evt_000003"}\n`]);
  const records = await readJsonlJournal('x', { parseLine, ...p.seams() });
  assert.deepEqual(
    records.map((r) => r.value.event_id),
    ['evt_000001', 'evt_000002', 'evt_000003'],
  );
});

// --------------------------------------------------------------------------
// (15) Ligne volumineuse
// --------------------------------------------------------------------------

test('(15) un enregistrement de plus de 512 KiB est lu intégralement', async () => {
  const dir = await makeTempDir('ccr-jsonl-big-');
  try {
    const file = path.join(dir, 'events.jsonl');
    const payload = 'x'.repeat(768 * 1024);
    const line = JSON.stringify({ event_id: 'evt_000001', content: payload });
    assert.ok(Buffer.byteLength(line, 'utf8') > 512 * 1024);
    await writeFile(file, `${line}\n`, 'utf8');

    const records = await readJsonlJournal(file, {
      parseLine: (raw, n) => parseJournalLine(raw, n, JOURNAL) as { event_id: string; content: string },
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.value.content.length, payload.length, 'aucun buffer implicite ne tronque');
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// (16, 17) Les deux journaux canoniques utilisent la primitive
// --------------------------------------------------------------------------

async function runDir(prefix: string): Promise<{ dir: string; paths: ReturnType<typeof runPaths> }> {
  const dir = await makeTempDir(prefix);
  const paths = runPaths(dir, 'CCR-20260402-001');
  await mkdir(paths.root, { recursive: true });
  return { dir, paths };
}

test('(16) events.jsonl : un fragment transitoire est repris, pas signalé comme corrompu', async () => {
  const { dir, paths } = await runDir('ccr-jsonl-events-');
  try {
    const complete = JSON.stringify({
      event_id: 'evt_000001',
      run_id: 'CCR-20260402-001',
      round: 0,
      actor: 'system',
      type: 'run_created',
      timestamp: '2026-08-08T00:00:00.000Z',
    });
    await writeFile(paths.events, `${complete}\n{"event_id":"evt_0000`, 'utf8');

    let reads = 0;
    const store = await openEventStore(paths, 'CCR-20260402-001', {
      read: async (file) => {
        reads += 1;
        // Le writer termine son append entre les deux lectures.
        if (reads === 1) return readFile(file, 'utf8');
        return `${complete}\n`;
      },
      sleep: async () => undefined,
    });

    const events = await store.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_id, 'evt_000001');
    assert.ok(reads >= 2, 'la reprise a bien eu lieu');
  } finally {
    await removeTempDir(dir);
  }
});

test('(17) decisions.jsonl : même primitive, même tolérance', async () => {
  const { dir, paths } = await runDir('ccr-jsonl-decisions-');
  try {
    const complete = JSON.stringify({
      decision_id: 'DEC-0001',
      run_id: 'CCR-20260402-001',
      round: 0,
      author: 'human',
      status: 'ACTIVE',
      content: 'décision canonique',
      timestamp: '2026-08-08T00:00:00.000Z',
    });
    await writeFile(paths.decisions, `${complete}\n{"decision_id":"DEC-00`, 'utf8');

    let reads = 0;
    const store = await openDecisionStore(paths, 'CCR-20260402-001', {
      read: async () => {
        reads += 1;
        return reads === 1 ? `${complete}\n{"decision_id":"DEC-00` : `${complete}\n`;
      },
      sleep: async () => undefined,
    });

    const decisions = await store.readAll();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.decision_id, 'DEC-0001');
    assert.ok(reads >= 2, 'la reprise a bien eu lieu pour les décisions aussi');
  } finally {
    await removeTempDir(dir);
  }
});

test('(17bis) une corruption stable de decisions.jsonl reste fatale', async () => {
  const { dir, paths } = await runDir('ccr-jsonl-dec-broken-');
  try {
    await writeFile(paths.decisions, '{"decision_id":"DEC-0001"}\nBROKEN\n', 'utf8');
    await assert.rejects(
      () => openDecisionStore(paths, 'CCR-20260402-001'),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// (18, 19) Aucun verrou, aucune mutation
// --------------------------------------------------------------------------

test('(18) le lecteur de journal ne connaît aucun verrou', async () => {
  const source = await readFile(new URL('../../src/store/jsonl-journal.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('run-lock'), 'aucun import de run lock');
  assert.ok(!source.includes('config-lock'), 'aucun import de config lock');
  assert.ok(!source.includes('withRunLock'), 'aucune acquisition de verrou');
  assert.ok(!source.includes('acquireRunLock'));

  for (const store of ['event-store.ts', 'decision-store.ts']) {
    const code = await readFile(new URL(`../../src/store/${store}`, import.meta.url), 'utf8');
    assert.ok(!code.includes('run-lock'), `${store} ne prend aucun verrou`);
  }
});

test('(18bis) une lecture aboutit alors que le run lock est détenu', async () => {
  const { dir, paths } = await runDir('ccr-jsonl-locked-');
  try {
    const complete = JSON.stringify({
      event_id: 'evt_000001',
      run_id: 'CCR-20260402-001',
      round: 0,
      actor: 'system',
      type: 'run_created',
      timestamp: '2026-08-08T00:00:00.000Z',
    });
    await writeFile(paths.events, `${complete}\n`, 'utf8');

    const { acquireRunLock } = await import('../../src/lock/run-lock.ts');
    const lock = await acquireRunLock(paths, 'step');
    try {
      // Le verrou est vivant et détenu : la lecture ne doit pas attendre.
      const events = await (await openEventStore(paths, 'CCR-20260402-001')).readAll();
      assert.equal(events.length, 1);
    } finally {
      await lock.release();
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('(19) une lecture ne modifie jamais le fichier', async () => {
  const dir = await makeTempDir('ccr-jsonl-immutable-');
  try {
    const file = path.join(dir, 'events.jsonl');
    const content = `${REC1}\n{"event_id":"evt_0000`;
    await writeFile(file, content, 'utf8');

    await assert.rejects(() =>
      readJsonlJournal(file, { parseLine, sleep: async () => undefined, budget: { attempts: 2, delaysMs: [1] } }),
    );

    assert.equal(await readFile(file, 'utf8'), content, 'ni troncature, ni newline ajouté, ni réécriture');
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// (20) Code d'erreur stable
// --------------------------------------------------------------------------

test('(20) après épuisement, le code public est celui de la corruption stable', async () => {
  const transitoire = probeOf([`${REC1}\n{"event_id":"evt_0000`]);
  const direct = probeOf([`${REC1}\n{"event_id":"evt_0000\n`]);

  const codeOf = async (p: Probe): Promise<string> => {
    try {
      await readJsonlJournal('x', { parseLine, ...p.seams({ attempts: 2, delaysMs: [1] }) });
      return 'AUCUNE_ERREUR';
    } catch (error) {
      return isCcrError(error) ? error.code : 'INATTENDU';
    }
  };

  assert.equal(await codeOf(transitoire), 'JOURNAL_INVALID');
  assert.equal(
    await codeOf(direct),
    'JOURNAL_INVALID',
    'la concurrence n’introduit aucun nouveau code public',
  );
});

test('le message public ne divulgue jamais le contenu de la ligne', async () => {
  const secret = 'CONTENU-CONFIDENTIEL-DE-LA-REPONSE-AGENT';
  const p = probeOf([`{"event_id":"evt_000001","content":"${secret}"\n`]);
  try {
    await readJsonlJournal('x', { parseLine, ...p.seams() });
    assert.fail('une erreur était attendue');
  } catch (error) {
    assert.ok(isCcrError(error));
    assert.ok(!error.message.includes(secret), 'aucune fuite dans le message');
    assert.ok(!JSON.stringify(error.details).includes(secret), 'aucune fuite dans les détails');
  }
});
