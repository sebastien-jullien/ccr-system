/**
 * Tests unitaires des primitives de persistance (spécification V1, §11, §12).
 *
 * Objectif : démontrer l'atomicité de l'écriture d'état et le caractère
 * strictement append-only des journaux.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  appendJsonLine,
  pathExists,
  readJsonFile,
  readTextWithRetry,
  renameWithRetry,
  writeJsonAtomic,
} from '../../src/store/atomic-file.ts';
import type { RenameRetryOptions } from '../../src/store/atomic-file.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

test('writeJsonAtomic écrit puis remplace intégralement le document', async () => {
  const dir = await makeTempDir('ccr-atomic-');
  try {
    const file = path.join(dir, 'state.json');

    await writeJsonAtomic(file, { state: 'READY', round: 0 });
    assert.deepEqual(await readJsonFile(file), { state: 'READY', round: 0 });

    await writeJsonAtomic(file, { state: 'PAUSED', round: 3 });
    assert.deepEqual(await readJsonFile(file), { state: 'PAUSED', round: 3 });

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'aucun fichier temporaire ne doit subsister');
  } finally {
    await removeTempDir(dir);
  }
});

test('un échec de sérialisation laisse le document précédent intact', async () => {
  const dir = await makeTempDir('ccr-atomic-fail-');
  try {
    const file = path.join(dir, 'state.json');
    await writeJsonAtomic(file, { state: 'READY' });

    const hostile = {
      toJSON(): never {
        throw new Error('sérialisation impossible');
      },
    };
    await assert.rejects(writeJsonAtomic(file, hostile));

    assert.deepEqual(await readJsonFile(file), { state: 'READY' });
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'le fichier temporaire doit être nettoyé');
  } finally {
    await removeTempDir(dir);
  }
});

/**
 * Renvoie le code système d'une erreur, `cause` comprise.
 *
 * Sous Windows, un remplacement peut échouer en `EPERM` lorsqu'un tiers —
 * lecteur concurrent, antivirus, indexeur — détient un descripteur au moment du
 * `rename`, jusqu'à épuiser la reprise de l'écrivain. Cette limite est **classée
 * POST-V1.1** et ne concerne pas l'atomicité : le document précédent reste
 * intact. Les tests de course la tolèrent explicitement, en la signalant, et
 * continuent d'exiger toutes leurs propriétés de lecture.
 */
function systemCode(error: unknown): string | undefined {
  const direct = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: NodeJS.ErrnoException } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

test('un lecteur concurrent ne peut jamais observer un document partiel', async (t) => {
  const dir = await makeTempDir('ccr-atomic-race-');
  try {
    const file = path.join(dir, 'state.json');
    const payload = 'x'.repeat(120_000);
    await writeJsonAtomic(file, { seq: 0, payload });

    let reads = 0;
    let stop = false;
    // Deux échecs de natures opposées, longtemps confondus (IMP-09) :
    //   - un document tronqué ou corrompu est une violation d'atomicité ;
    //   - une erreur d'accès est une fenêtre de remplacement, que la primitive
    //     doit absorber — et si elle persiste, elle se nomme telle qu'elle est.
    let atomicityViolation: string | undefined;
    let persistentAccessError: string | undefined;

    const reader = (async () => {
      while (!stop) {
        try {
          const value = (await readJsonFile(file)) as { seq: unknown; payload: unknown };
          assert.equal(typeof value.seq, 'number');
          assert.equal(String(value.payload).length, payload.length);
          reads += 1;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (typeof code === 'string') persistentAccessError = code;
          else atomicityViolation = String(error).slice(0, 200);
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    // L'arrêt du lecteur doit survenir même si l'écriture échoue : sans cela,
    // une écriture en erreur laisse la boucle tourner indéfiniment et le test
    // se bloque au lieu d'échouer — un blocage est bien pire qu'un échec.
    let writeError: NodeJS.ErrnoException | undefined;
    try {
      for (let seq = 1; seq <= 30; seq += 1) {
        await writeJsonAtomic(file, { seq, payload });
      }
    } catch (error) {
      writeError = error as NodeJS.ErrnoException;
    } finally {
      stop = true;
    }
    await reader;

    // Dans ce scénario l'écriture est censée réussir : un échec réel reste un
    // échec du scénario. Le code système est nommé pour ce qu'il est, sans être
    // requalifié en « document partiel ».
    assert.equal(
      writeError,
      undefined,
      `écriture concurrente en échec (${String(systemCode(writeError))}) : la reprise du ` +
        "remplacement n'a pas absorbé la contention",
    );
    assert.equal(
      atomicityViolation,
      undefined,
      `document partiel ou corrompu observé : ${String(atomicityViolation)}`,
    );
    assert.equal(
      persistentAccessError,
      undefined,
      `erreur d'accès persistante après reprise bornée : ${String(persistentAccessError)} — ` +
        "ce n'est pas un document partiel, mais la reprise de lecture n'a pas suffi",
    );
    assert.ok(reads > 0, 'le lecteur doit avoir lu au moins une fois');
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Politique de reprise du remplacement (IMP-14)
// --------------------------------------------------------------------------

/** Ce que l'ancienne stratégie pouvait absorber : 12 tentatives, 11 reprises. */
const ANCIENNE_BORNE_TENTATIVES = 12;

interface RenameProbe {
  readonly calls: number;
  readonly delays: number[];
}

/** `failures` échecs consécutifs, puis succès. */
function renameSeam(failures: number, code = 'EPERM'): { probe: RenameProbe; options: RenameRetryOptions } {
  const state = { calls: 0, delays: [] as number[] };
  let clock = 0;
  return {
    probe: state as unknown as RenameProbe,
    options: {
      platform: 'win32',
      now: () => clock,
      sleep: async (ms: number) => {
        state.delays.push(ms);
        clock += ms;
      },
      rename: async () => {
        state.calls += 1;
        if (state.calls <= failures) {
          const error = new Error(`${code}: simulé`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
      },
    },
  };
}

test('(1) un remplacement contrarié plusieurs fois finit par aboutir', async () => {
  const { probe, options } = renameSeam(6);
  await renameWithRetry('temp', 'canonique.json', options);

  assert.equal(probe.calls, 7, 'six échecs absorbés, puis succès');
  // Essais rapprochés : c'est la densité qui absorbe la contention, pas la durée.
  assert.deepEqual(probe.delays, [5, 10, 15, 20, 25, 25]);
});

test('(2) la nouvelle stratégie absorbe bien plus que l\'ancienne ne le pouvait', async () => {
  // L'ancienne bornait à 12 tentatives ; celle-ci en absorbe plusieurs fois plus.
  const { probe, options } = renameSeam(ANCIENNE_BORNE_TENTATIVES * 3);
  await renameWithRetry('temp', 'canonique.json', options);

  assert.equal(probe.calls, ANCIENNE_BORNE_TENTATIVES * 3 + 1);
  assert.ok(probe.calls > ANCIENNE_BORNE_TENTATIVES, "au-delà de l'ancienne borne");
  // …et le temps simulé reste très inférieur au budget.
  assert.ok(
    probe.delays.reduce((sum, ms) => sum + ms, 0) < 1_000,
    'densité élevée, durée courte',
  );
});

test('(3) une contention persistante finit par propager l\'erreur réelle', async () => {
  const { probe, options } = renameSeam(Number.MAX_SAFE_INTEGER);

  await assert.rejects(
    renameWithRetry('temp', 'canonique.json', options),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'EPERM', "l'erreur réelle est propagée, non réinterprétée");
      return true;
    },
  );
  // Bornée par le temps ou par le nombre d'essais, jamais infinie.
  assert.ok(probe.calls <= 100, `bornée : ${String(probe.calls)} tentatives`);
  assert.ok(probe.delays.reduce((sum, ms) => sum + ms, 0) <= 2_000, 'budget respecté');
});

test('(4) une erreur non transitoire n\'est jamais rejouée', async () => {
  for (const code of ['ENOSPC', 'EXDEV', 'EROFS']) {
    const { probe, options } = renameSeam(Number.MAX_SAFE_INTEGER, code);
    await assert.rejects(renameWithRetry('temp', 'canonique.json', options));
    assert.equal(probe.calls, 1, `${code} : aucune reprise`);
  }
});

test('(4bis) hors Windows, le comportement de rename est inchangé', async () => {
  const { probe, options } = renameSeam(1);
  await assert.rejects(renameWithRetry('temp', 'canonique.json', { ...options, platform: 'linux' }));
  assert.equal(probe.calls, 1, 'aucune reprise introduite sur les plateformes non concernées');
});

test('(8) la destination canonique n\'est jamais supprimée pour faciliter le remplacement', async () => {
  const dir = await makeTempDir('ccr-atomic-nodelete-');
  try {
    const file = path.join(dir, 'state.json');
    await writeJsonAtomic(file, { seq: 'ancienne' });

    // À chaque tentative, la destination doit rester lisible et complète : une
    // stratégie qui la supprimerait d'abord rouvrirait la fenêtre ENOENT.
    let attempts = 0;
    const observed: unknown[] = [];
    await assert.rejects(
      renameWithRetry(path.join(dir, 'inexistant.tmp'), file, {
        platform: 'win32',
        sleep: async () => undefined,
        rename: async () => {
          attempts += 1;
          observed.push(JSON.parse(await readFile(file, 'utf8')) as unknown);
          if (attempts >= 5) {
            const error = new Error('EPERM: simulé') as NodeJS.ErrnoException;
            error.code = 'ENOSPC';
            throw error;
          }
          const error = new Error('EPERM: simulé') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        },
      }),
    );

    assert.equal(attempts, 5);
    for (const seen of observed) {
      assert.deepEqual(seen, { seq: 'ancienne' }, 'document canonique intact à chaque essai');
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('(6/7) un remplacement définitivement impossible laisse la destination intacte et nettoie', async () => {
  const dir = await makeTempDir('ccr-atomic-fail-');
  try {
    const file = path.join(dir, 'state.json');
    await writeJsonAtomic(file, { seq: 'ancienne' });

    // Destination en lecture seule : le remplacement échouera pour de bon.
    if (process.platform === 'win32') await chmod(file, 0o444);
    else await chmod(dir, 0o555);

    await assert.rejects(writeJsonAtomic(file, { seq: 'nouvelle' }));

    if (process.platform === 'win32') await chmod(file, 0o666);
    else await chmod(dir, 0o755);

    assert.deepEqual(await readJsonFile(file), { seq: 'ancienne' }, 'destination intacte');
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith('.tmp')),
      [],
      'temporaire nettoyé au mieux',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Politique de reprise de lecture (IMP-08)
// --------------------------------------------------------------------------

/** Lecteur injectable : `codes` est la suite d'échecs avant succès. */
function failingReader(codes: readonly string[], content = '{"ok":true}') {
  const calls: string[] = [];
  return {
    calls,
    read: async (file: string): Promise<string> => {
      const index = calls.length;
      calls.push(file);
      const code = codes[index];
      if (code === undefined) return content;
      const error = new Error(`${code}: simulé`) as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    },
  };
}

test('une erreur transitoire est absorbée dès que la lecture redevient possible', async () => {
  for (const code of ['ENOENT', 'EPERM', 'EACCES', 'EBUSY']) {
    const reader = failingReader([code]);
    const text = await readTextWithRetry('canonique.json', reader.read);

    assert.equal(text, '{"ok":true}', code);
    assert.equal(reader.calls.length, 2, `${code} : une reprise, puis succès`);
  }
});

test('la reprise est bornée et relance l\'erreur réelle finale', async () => {
  // ENOENT : borne courte, car c'est aussi le code d'un fichier réellement
  // absent — le chemin nominal « pas de configuration ».
  const absent = failingReader(Array.from({ length: 20 }, () => 'ENOENT'));
  await assert.rejects(readTextWithRetry('absent.json', absent.read), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'ENOENT', "l'erreur réelle est relancée, non réinterprétée");
    return true;
  });
  assert.equal(absent.calls.length, 3, 'borne ENOENT');

  // Verrouillage : borne plus large, ce code n'apparaît pas sur un fichier absent.
  const locked = failingReader(Array.from({ length: 20 }, () => 'EBUSY'));
  await assert.rejects(readTextWithRetry('verrouille.json', locked.read), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'EBUSY');
    return true;
  });
  assert.equal(locked.calls.length, 6, 'borne verrouillage');
});

test('une erreur non transitoire n\'est jamais rejouée', async () => {
  const reader = failingReader(['EISDIR']);
  await assert.rejects(readTextWithRetry('repertoire.json', reader.read), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'EISDIR');
    return true;
  });
  assert.equal(reader.calls.length, 1, 'aucune reprise');
});

test('la reprise ignore le contenu : un JSON invalide n\'est jamais rejoué', async () => {
  // La couche de reprise ne connaît pas le JSON : elle rend le texte tel quel.
  const reader = failingReader([], 'pas du json');
  assert.equal(await readTextWithRetry('corrompu.json', reader.read), 'pas du json');
  assert.equal(reader.calls.length, 1);

  // …et l'analyse, hors de la boucle, échoue une fois pour toutes.
  const dir = await makeTempDir('ccr-atomic-parse-');
  try {
    const file = path.join(dir, 'corrompu.json');
    await writeFile(file, '{ "tronque": ', 'utf8');
    await assert.rejects(readJsonFile(file), (error: unknown) => error instanceof SyntaxError);
  } finally {
    await removeTempDir(dir);
  }
});

test('un fichier réellement absent reste absent après la reprise bornée', async () => {
  const dir = await makeTempDir('ccr-atomic-absent-');
  try {
    await assert.rejects(
      readJsonFile(path.join(dir, 'jamais-ecrit.json')),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 'ENOENT');
        return true;
      },
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('appendJsonLine ajoute sans jamais réécrire les lignes précédentes', async () => {
  const dir = await makeTempDir('ccr-append-');
  try {
    const file = path.join(dir, 'events.jsonl');

    await appendJsonLine(file, { event_id: 'evt_000001', type: 'run_created' });
    const afterFirst = await readFile(file, 'utf8');

    await appendJsonLine(file, { event_id: 'evt_000002', type: 'prompt_sent' });
    const afterSecond = await readFile(file, 'utf8');

    assert.ok(afterSecond.startsWith(afterFirst), 'le préfixe existant doit être conservé octet pour octet');
    assert.ok(afterSecond.endsWith('\n'), 'chaque append se termine par un saut de ligne');
  } finally {
    await removeTempDir(dir);
  }
});
