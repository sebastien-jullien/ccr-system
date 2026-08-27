/**
 * Tests unitaires du config store CCR (lot V1.1-1, spécification V1.1 §11,
 * §20, §20.1, §21).
 *
 * Règle absolue de cette suite : **aucun test n'écrit dans la configuration
 * réelle de l'utilisateur**. Tout chemin est injecté dans un répertoire
 * temporaire, et une garde explicite vérifie que `~/.ccr` est resté intact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

import {
  CCR_HOME_DIR_NAME,
  CONFIG_FILE_NAME,
  defaultConfigPath,
  loadEffectiveConfig,
  readConfig,
  resolveConfigPath,
  updateConfig,
  writeConfig,
} from '../../src/config/config-store.ts';
import { LEGACY_SKIP_GIT_REPO_CHECK_ENV, defaultConfig } from '../../src/config/config-schema.ts';
import type { CcrConfig } from '../../src/config/config-schema.ts';
import {
  acquireConfigLock,
  configLockFilePath,
  observeConfigLock,
  readConfigLock,
} from '../../src/lock/config-lock.ts';
import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

interface Sandbox {
  readonly dir: string;
  readonly configPath: string;
  cleanup(): Promise<void>;
}

/** Configuration isolée : jamais celle de l'utilisateur. */
async function sandbox(): Promise<Sandbox> {
  const dir = await makeTempDir('ccr-config-');
  return {
    dir,
    configPath: path.join(dir, CONFIG_FILE_NAME),
    cleanup: () => removeTempDir(dir),
  };
}

function config(overrides: Partial<CcrConfig> = {}): CcrConfig {
  return { ...defaultConfig(), ...overrides };
}

async function expectCcrError(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isCcrError(error), `${what} : attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code, what);
    return;
  }
  assert.fail(`${what} : attendu ${code}, aucune erreur levée`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `root` traverse les permissions : un test fondé sur elles n'y prouve rien. */
const rootOnPosix =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;

// --------------------------------------------------------------------------
// Lecture
// --------------------------------------------------------------------------

test('(1) une configuration absente produit les valeurs par défaut', async () => {
  const box = await sandbox();
  try {
    const loaded = await readConfig({ configPath: box.configPath });

    assert.deepEqual(loaded.config, defaultConfig());
    assert.equal(loaded.origin, 'defaults', 'la provenance reste identifiable');
    assert.equal(loaded.path, box.configPath);
    // L'absence n'est pas une erreur, et ne crée rien sur le disque.
    assert.deepEqual(await readdir(box.dir), []);
  } finally {
    await box.cleanup();
  }
});

test('(2) une configuration valide est chargée depuis le fichier', async () => {
  const box = await sandbox();
  try {
    await writeFile(
      box.configPath,
      JSON.stringify({
        schema_version: 1,
        preflight: { offer_interactive_login: false },
        codex: { skip_git_repo_check: true },
      }),
      'utf8',
    );

    const loaded = await readConfig({ configPath: box.configPath });

    assert.equal(loaded.origin, 'file');
    assert.equal(loaded.config.preflight.offer_interactive_login, false);
    assert.equal(loaded.config.codex.skip_git_repo_check, true);
  } finally {
    await box.cleanup();
  }
});

test('(3) un JSON invalide est refusé en CONFIG_INVALID', async () => {
  const box = await sandbox();
  try {
    await writeFile(box.configPath, '{ "schema_version": 1, ', 'utf8');
    await expectCcrError(readConfig({ configPath: box.configPath }), 'CONFIG_INVALID', 'JSON tronqué');

    // Un document illisible ne devient jamais « valeurs par défaut ».
    await writeFile(box.configPath, 'pas du json', 'utf8');
    await expectCcrError(readConfig({ configPath: box.configPath }), 'CONFIG_INVALID', 'texte libre');
  } finally {
    await box.cleanup();
  }
});

test('(3/4) les erreurs de schéma remontent depuis la lecture', async () => {
  const box = await sandbox();
  try {
    await writeFile(
      box.configPath,
      JSON.stringify({ ...defaultConfig(), schema_version: 99 }),
      'utf8',
    );
    await expectCcrError(
      readConfig({ configPath: box.configPath }),
      'CONFIG_SCHEMA_UNSUPPORTED',
      'schéma inconnu sur disque',
    );

    await writeFile(
      box.configPath,
      JSON.stringify({ ...defaultConfig(), codex: { skip_git_repo_check: 'yes' } }),
      'utf8',
    );
    await expectCcrError(
      readConfig({ configPath: box.configPath }),
      'CONFIG_INVALID',
      'type invalide sur disque',
    );
  } finally {
    await box.cleanup();
  }
});

test('(3bis) un fichier présent mais illisible est refusé en CONFIG_READ_FAILED', async () => {
  const box = await sandbox();
  try {
    // Un répertoire à la place du document : présent, non lisible. Le fait
    // observé — l'accès a échoué — n'apprend rien sur le contenu, et n'appelle
    // pas la même remédiation qu'une accolade manquante.
    await mkdir(box.configPath, { recursive: true });

    try {
      await readConfig({ configPath: box.configPath });
      assert.fail('attendu CONFIG_READ_FAILED, aucune erreur levée');
    } catch (error) {
      assert.ok(isCcrError(error), `attendu une CcrError, reçu ${String(error)}`);
      assert.equal(error.code, 'CONFIG_READ_FAILED');
      // Le code système d'origine est conservé, et rien d'autre.
      assert.equal(typeof error.details['systemCode'], 'string');
      assert.equal(error.details['path'], box.configPath);
      assert.deepEqual(Object.keys(error.details).sort(), ['path', 'systemCode']);
    }
  } finally {
    await box.cleanup();
  }
});

test(
  '(3bis) un fichier sans droit de lecture est refusé en CONFIG_READ_FAILED',
  {
    skip:
      process.platform === 'win32'
        ? 'Windows n\'interdit pas la lecture via le seul attribut lecture seule'
        : rootOnPosix
          ? 'root ignore les permissions du système de fichiers'
          : false,
  },
  async () => {
    const box = await sandbox();
    try {
      await writeConfig(config(), { configPath: box.configPath });
      await chmod(box.configPath, 0o000);

      await expectCcrError(
        readConfig({ configPath: box.configPath }),
        'CONFIG_READ_FAILED',
        'EACCES en lecture',
      );

      await chmod(box.configPath, 0o600);
    } finally {
      await box.cleanup();
    }
  },
);

test('(3bis) les quatre issues de lecture restent distinctes', async () => {
  const box = await sandbox();
  try {
    // 1. absent → défauts, sans erreur.
    assert.equal((await readConfig({ configPath: box.configPath })).origin, 'defaults');

    // 2. lisible mais document invalide.
    await writeFile(box.configPath, '{ "schema_version": 1,', 'utf8');
    await expectCcrError(readConfig({ configPath: box.configPath }), 'CONFIG_INVALID', 'JSON tronqué');

    // 3. lisible, valide, version inconnue.
    await writeFile(box.configPath, JSON.stringify({ ...defaultConfig(), schema_version: 7 }), 'utf8');
    await expectCcrError(
      readConfig({ configPath: box.configPath }),
      'CONFIG_SCHEMA_UNSUPPORTED',
      'version inconnue',
    );

    // 4. présent, lecture impossible.
    const bloque = path.join(box.dir, 'bloque.json');
    await mkdir(bloque, { recursive: true });
    await expectCcrError(readConfig({ configPath: bloque }), 'CONFIG_READ_FAILED', 'lecture impossible');
  } finally {
    await box.cleanup();
  }
});

test('(3bis) updateConfig relaie CONFIG_READ_FAILED et libère son verrou', async () => {
  const box = await sandbox();
  try {
    const bloque = path.join(box.dir, 'bloque.json');
    await mkdir(bloque, { recursive: true });

    await expectCcrError(
      updateConfig((current) => current, { configPath: bloque }),
      'CONFIG_READ_FAILED',
      'lecture impossible sous verrou',
    );
    assert.equal(await readConfigLock(bloque), undefined, 'verrou libéré malgré l\'échec');
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Chemin injectable
// --------------------------------------------------------------------------

test('(7) le chemin de configuration est injectable et par défaut sous ~/.ccr', () => {
  assert.equal(defaultConfigPath('/maison'), path.join('/maison', CCR_HOME_DIR_NAME, CONFIG_FILE_NAME));
  assert.equal(resolveConfigPath('/ailleurs/config.json'), path.resolve('/ailleurs/config.json'));
  assert.equal(resolveConfigPath(), defaultConfigPath());
  assert.equal(resolveConfigPath(''), defaultConfigPath(), 'une chaîne vide ne masque pas le défaut');

  // %USERPROFILE%\.ccr\config.json sous Windows, ~/.ccr/config.json ailleurs.
  assert.ok(defaultConfigPath().startsWith(homedir()));
  assert.ok(defaultConfigPath().endsWith(path.join(CCR_HOME_DIR_NAME, CONFIG_FILE_NAME)));
});

// --------------------------------------------------------------------------
// Écriture
// --------------------------------------------------------------------------

test('(8) écriture puis relecture restituent exactement le document', async () => {
  const box = await sandbox();
  try {
    const written = config({
      preflight: { offer_interactive_login: false },
      codex: { skip_git_repo_check: true },
    });
    const result = await writeConfig(written, { configPath: box.configPath });
    assert.equal(result.origin, 'file');

    const reread = await readConfig({ configPath: box.configPath });
    assert.deepEqual(reread.config, written);
    assert.equal(reread.origin, 'file');
  } finally {
    await box.cleanup();
  }
});

test('(8) l\'écriture crée le répertoire ~/.ccr manquant', async () => {
  const box = await sandbox();
  try {
    const nested = path.join(box.dir, CCR_HOME_DIR_NAME, CONFIG_FILE_NAME);
    await writeConfig(config(), { configPath: nested });

    assert.deepEqual((await readConfig({ configPath: nested })).config, config());
  } finally {
    await box.cleanup();
  }
});

test('(9) l\'écriture ne laisse ni fichier temporaire ni verrou résiduel', async () => {
  const box = await sandbox();
  try {
    for (const skip of [true, false, true]) {
      await writeConfig(config({ codex: { skip_git_repo_check: skip } }), { configPath: box.configPath });
    }

    // Temporaire renommé, verrou libéré : le répertoire ne contient que le
    // document canonique.
    assert.deepEqual(await readdir(box.dir), [CONFIG_FILE_NAME]);

    const raw = await readFile(box.configPath, 'utf8');
    assert.ok(raw.endsWith('\n'), 'document complet, terminé par une fin de ligne');
    assert.deepEqual(JSON.parse(raw), config({ codex: { skip_git_repo_check: true } }));
  } finally {
    await box.cleanup();
  }
});

test('(9) un lecteur concurrent n\'observe jamais un document partiel', async () => {
  const box = await sandbox();
  try {
    const ancienne = config({ codex: { skip_git_repo_check: false } });
    const nouvelle = config({ codex: { skip_git_repo_check: true } });
    await writeConfig(ancienne, { configPath: box.configPath });

    let done = false;
    const writing = writeConfig(nouvelle, { configPath: box.configPath }).finally(() => {
      done = true;
    });

    // Lectures entrelacées pendant l'écriture : chacune doit voir un document
    // complet, l'ancien ou le nouveau, jamais un intermédiaire.
    let observations = 0;
    for (let attempt = 0; attempt < 20 && !done; attempt += 1) {
      await delay(1);
      const seen = (await readConfig({ configPath: box.configPath })).config;
      observations += 1;
      assert.ok(
        seen.codex.skip_git_repo_check === false || seen.codex.skip_git_repo_check === true,
        'document complet',
      );
      assert.deepEqual(
        seen,
        seen.codex.skip_git_repo_check ? nouvelle : ancienne,
        'aucun document intermédiaire',
      );
    }
    await writing;
    assert.ok(observations > 0, 'au moins une lecture entrelacée a eu lieu');
    assert.deepEqual((await readConfig({ configPath: box.configPath })).config, nouvelle);
  } finally {
    await box.cleanup();
  }
});

test('(IMP-08) une réécriture concurrente ne fait jamais apparaître les valeurs par défaut', async (t) => {
  const box = await sandbox();
  try {
    // Propriété produit : une configuration persistée à `true` ne doit pas
    // pouvoir être lue comme un `false` par défaut à cause de la seule fenêtre
    // de remplacement du fichier.
    const persisted = config({ codex: { skip_git_repo_check: true } });
    await writeConfig(persisted, { configPath: box.configPath });

    let stop = false;
    let reads = 0;
    let defaultsObserved = 0;
    let readError: unknown;

    const reader = (async () => {
      while (!stop) {
        try {
          const loaded = await readConfig({ configPath: box.configPath });
          if (loaded.origin === 'defaults') defaultsObserved += 1;
          if (loaded.config.codex.skip_git_repo_check !== true) defaultsObserved += 1;
          reads += 1;
        } catch (error) {
          readError = error;
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    // Écritures atomiques répétées du même document : seule la fenêtre de
    // remplacement varie. L'arrêt du lecteur est garanti même si une écriture
    // échoue, sinon le test se bloquerait au lieu d'échouer.
    let writeError: unknown;
    try {
      for (let index = 0; index < 30; index += 1) {
        await writeConfig(persisted, { configPath: box.configPath });
      }
    } catch (error) {
      writeError = error;
    } finally {
      stop = true;
    }
    await reader;

    // L'écriture est censée réussir ici : un échec réel fait échouer le
    // scénario, il n'est plus absorbé comme attendu.
    const writeCode =
      (writeError as { cause?: NodeJS.ErrnoException } | undefined)?.cause?.code ??
      (writeError as NodeJS.ErrnoException | undefined)?.code;
    assert.equal(writeError, undefined, `écriture en échec (${String(writeCode)}) : ${String(writeError)}`);
    assert.equal(readError, undefined, `lecture en échec : ${String(readError)}`);
    assert.ok(reads > 0, 'le lecteur doit avoir lu au moins une fois');
    assert.equal(defaultsObserved, 0, 'aucune lecture ne doit retomber sur les valeurs par défaut');
  } finally {
    await box.cleanup();
  }
});

test('(IMP-08) un fichier réellement absent produit toujours les valeurs par défaut', async () => {
  const box = await sandbox();
  try {
    // La reprise bornée ne transforme pas une absence réelle en erreur.
    const loaded = await readConfig({ configPath: box.configPath });
    assert.equal(loaded.origin, 'defaults');
    assert.equal(loaded.config.codex.skip_git_repo_check, false);
  } finally {
    await box.cleanup();
  }
});

test('(10) un document invalide n\'atteint jamais le disque', async () => {
  const box = await sandbox();
  try {
    const ancienne = config({ codex: { skip_git_repo_check: true } });
    await writeConfig(ancienne, { configPath: box.configPath });

    const invalide = { schema_version: 1, preflight: { offer_interactive_login: 'true' }, codex: {} };
    await expectCcrError(
      writeConfig(invalide as unknown as CcrConfig, { configPath: box.configPath }),
      'CONFIG_INVALID',
      'document refusé avant écriture',
    );

    assert.deepEqual((await readConfig({ configPath: box.configPath })).config, ancienne);
    assert.deepEqual(await readdir(box.dir), [CONFIG_FILE_NAME], 'ni temporaire, ni verrou');
  } finally {
    await box.cleanup();
  }
});

test(
  '(10) un échec d\'écriture réel laisse l\'ancienne configuration intacte',
  { skip: rootOnPosix ? 'root ignore les permissions du système de fichiers' : false },
  async () => {
    const box = await sandbox();
    let restore: (() => Promise<void>) | undefined;
    try {
      const ancienne = config({ codex: { skip_git_repo_check: true } });
      await writeConfig(ancienne, { configPath: box.configPath });

      // Échec provoqué par le système de fichiers, non simulé par un double :
      // sous Windows le `rename` refuse de remplacer une cible en lecture
      // seule ; ailleurs, le répertoire non inscriptible bloque le temporaire.
      if (process.platform === 'win32') {
        await chmod(box.configPath, 0o444);
        restore = async () => chmod(box.configPath, 0o666);
      } else {
        await chmod(box.dir, 0o555);
        restore = async () => chmod(box.dir, 0o755);
      }

      await expectCcrError(
        writeConfig(config({ codex: { skip_git_repo_check: false } }), { configPath: box.configPath }),
        'CONFIG_WRITE_FAILED',
        'écriture impossible',
      );

      await restore();
      restore = undefined;

      const survivante = await readConfig({ configPath: box.configPath });
      assert.deepEqual(survivante.config, ancienne, 'la configuration précédente reste canonique');
      assert.deepEqual(await readdir(box.dir), [CONFIG_FILE_NAME], 'aucun temporaire, verrou libéré');
      assert.equal(await readConfigLock(box.configPath), undefined);
    } finally {
      await restore?.();
      await box.cleanup();
    }
  },
);

// --------------------------------------------------------------------------
// Modification sous verrou
// --------------------------------------------------------------------------

test('updateConfig lit, modifie et écrit sous un même verrou', async () => {
  const box = await sandbox();
  try {
    await writeConfig(config({ preflight: { offer_interactive_login: false } }), {
      configPath: box.configPath,
    });

    const updated = await updateConfig(
      (current) => ({ ...current, codex: { skip_git_repo_check: true } }),
      { configPath: box.configPath },
    );

    // La clé non touchée est conservée : pas de perte silencieuse.
    assert.equal(updated.config.preflight.offer_interactive_login, false);
    assert.equal(updated.config.codex.skip_git_repo_check, true);
    assert.deepEqual((await readConfig({ configPath: box.configPath })).config, updated.config);
    assert.equal(await readConfigLock(box.configPath), undefined, 'verrou libéré');
  } finally {
    await box.cleanup();
  }
});

test('updateConfig part des valeurs par défaut lorsque le fichier est absent', async () => {
  const box = await sandbox();
  try {
    const updated = await updateConfig(
      (current) => ({ ...current, codex: { skip_git_repo_check: true } }),
      { configPath: box.configPath },
    );

    assert.deepEqual(updated.config, config({ codex: { skip_git_repo_check: true } }));
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Concurrence (§20.1)
// --------------------------------------------------------------------------

test('(18) une écriture concurrente est refusée en CONFIG_BUSY', async () => {
  const box = await sandbox();
  try {
    const ancienne = config({ codex: { skip_git_repo_check: true } });
    await writeConfig(ancienne, { configPath: box.configPath });

    // Un autre « ccr setup » détient le verrou.
    const holder = await acquireConfigLock(box.configPath, 'setup');

    await expectCcrError(
      writeConfig(config(), { configPath: box.configPath }),
      'CONFIG_BUSY',
      'écriture concurrente',
    );
    await expectCcrError(
      updateConfig((current) => current, { configPath: box.configPath }),
      'CONFIG_BUSY',
      'modification concurrente',
    );

    // Rien n'a été écrasé pendant le conflit.
    assert.deepEqual((await readConfig({ configPath: box.configPath })).config, ancienne);

    await holder.release();
    await writeConfig(config(), { configPath: box.configPath });
    assert.deepEqual((await readConfig({ configPath: box.configPath })).config, config());
  } finally {
    await box.cleanup();
  }
});

test('(18) une rafale d\'écritures ne produit ni perte silencieuse ni corruption', async () => {
  const box = await sandbox();
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        updateConfig((current) => ({ ...current, codex: { skip_git_repo_check: index % 2 === 0 } }), {
          configPath: box.configPath,
          command: `setup-${String(index)}`,
        }),
      ),
    );

    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1, 'au moins une écriture aboutit');
    for (const rejected of attempts.filter((attempt) => attempt.status === 'rejected')) {
      const error = (rejected as PromiseRejectedResult).reason as unknown;
      assert.ok(isCcrError(error), `attendu une CcrError, reçu ${String(error)}`);
      assert.equal(error.code, 'CONFIG_BUSY', 'un conflit est explicite, jamais silencieux');
    }

    // Le document final est complet et valide : aucune écriture partielle.
    const final = await readConfig({ configPath: box.configPath });
    assert.equal(final.origin, 'file');
    assert.deepEqual(await readdir(box.dir), [CONFIG_FILE_NAME]);
  } finally {
    await box.cleanup();
  }
});

test('(19) un processus ne peut pas libérer le verrou d\'un autre', async () => {
  const box = await sandbox();
  try {
    const mien = await acquireConfigLock(box.configPath, 'setup');

    // Un autre propriétaire écrase le fichier de verrou entre-temps.
    await writeFile(
      configLockFilePath(box.configPath),
      JSON.stringify({
        lock_id: 'autre-proprietaire',
        pid: process.pid,
        hostname: 'autre-machine',
        created_at: new Date().toISOString(),
        command: 'setup',
      }),
      'utf8',
    );

    await mien.release();

    const survivant = await readConfigLock(box.configPath);
    assert.equal(survivant?.lock_id, 'autre-proprietaire', "le verrou d'autrui est intact");

    // Et il continue de protéger la configuration.
    await expectCcrError(
      writeConfig(config(), { configPath: box.configPath }),
      'CONFIG_BUSY',
      'verrou étranger toujours opposable',
    );
  } finally {
    await box.cleanup();
  }
});

test('le document de verrou porte lock_id, pid, hostname et created_at', async () => {
  const box = await sandbox();
  try {
    const lock = await acquireConfigLock(box.configPath, 'setup');

    // Support minimal de la politique arbitrée des verrous abandonnés : sans
    // ces quatre champs, aucune levée sûre ne serait possible plus tard.
    const persisted = JSON.parse(await readFile(lock.path, 'utf8')) as Record<string, unknown>;
    for (const field of ['lock_id', 'pid', 'hostname', 'created_at']) {
      assert.ok(field in persisted, `champ ${field} présent`);
    }
    assert.equal(persisted['pid'], process.pid);
    assert.equal(persisted['hostname'], hostname());
    assert.ok(Date.parse(String(persisted['created_at'])) > 0, 'created_at est un horodatage ISO');
    assert.equal(persisted['command'], 'setup', 'commande détentrice, pour diagnostic');

    const observed = await observeConfigLock(box.configPath);
    assert.equal(observed.presence, 'HELD');
    assert.equal(observed.info?.lock_id, lock.info.lock_id);
    assert.equal(observed.info?.created_at, persisted['created_at']);

    await lock.release();
  } finally {
    await box.cleanup();
  }
});

test('un verrou absent et un verrou illisible restent deux faits distincts', async () => {
  const box = await sandbox();
  try {
    const lockPath = configLockFilePath(box.configPath);
    await mkdir(box.dir, { recursive: true });

    assert.equal((await observeConfigLock(box.configPath)).presence, 'ABSENT');

    // Document tronqué, puis document complet mais amputé d'un champ requis :
    // dans les deux cas, l'identité du détenteur est inconnue.
    for (const contenu of [
      '{ "lock_id": ',
      JSON.stringify({ lock_id: 'x', pid: process.pid, hostname: hostname() }),
      JSON.stringify({ lock_id: 'x', pid: 'douze', hostname: hostname(), created_at: 'maintenant' }),
    ]) {
      await writeFile(lockPath, contenu, 'utf8');

      const observation = await observeConfigLock(box.configPath);
      assert.equal(observation.presence, 'UNREADABLE', `contenu : ${contenu.slice(0, 40)}`);
      assert.equal(observation.info, undefined, 'aucune identité devinée');

      // Conservatisme : un verrou illisible bloque, il n'est jamais assimilé
      // à une absence — et il n'est pas supprimé.
      await expectCcrError(
        writeConfig(config(), { configPath: box.configPath }),
        'CONFIG_BUSY',
        'verrou illisible opposable',
      );
      assert.equal(await readFile(lockPath, 'utf8'), contenu, 'verrou illisible intact');
    }
  } finally {
    await box.cleanup();
  }
});

test('CONFIG_BUSY décrit le détenteur sans jamais le supprimer', async () => {
  const box = await sandbox();
  try {
    const holder = await acquireConfigLock(box.configPath, 'setup');
    try {
      await writeConfig(config(), { configPath: box.configPath });
      assert.fail('attendu CONFIG_BUSY');
    } catch (error) {
      assert.ok(isCcrError(error));
      assert.equal(error.code, 'CONFIG_BUSY');
      assert.equal(error.details['presence'], 'HELD');

      // De quoi permettre plus tard un diagnostic `doctor` et une levée sous
      // consentement, sans qu'aucune suppression n'ait lieu ici.
      const owner = error.details['owner'] as Record<string, unknown>;
      assert.equal(owner['lock_id'], holder.info.lock_id);
      assert.equal(owner['pid'], process.pid);
      assert.equal(owner['hostname'], hostname());
      assert.ok(Date.parse(String(owner['created_at'])) > 0);
    }

    assert.notEqual(await readConfigLock(box.configPath), undefined, 'verrou toujours en place');
    await holder.release();
  } finally {
    await box.cleanup();
  }
});

test('le verrou de configuration est distinct du verrou de run V1', async () => {
  const box = await sandbox();
  try {
    const lock = await acquireConfigLock(box.configPath, 'setup');

    assert.equal(configLockFilePath(box.configPath), `${box.configPath}.lock`);
    assert.notEqual(path.basename(lock.path), '.ccr.lock', 'aucun emprunt au verrou de run');

    const raw = await readFile(lock.path, 'utf8');
    assert.ok(raw.includes('"pid"'));
    assert.ok(!raw.includes('session_id'), 'donnée de liveness, jamais de donnée canonique');

    await lock.release();
    assert.equal(await readConfigLock(box.configPath), undefined);
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Configuration effective de bout en bout
// --------------------------------------------------------------------------

test('(16) loadEffectiveConfig expose la valeur et sa provenance', async () => {
  const box = await sandbox();
  try {
    const sansFichier = await loadEffectiveConfig({ configPath: box.configPath }, {});
    assert.equal(sansFichier.codex.skipGitRepoCheck, false);
    assert.equal(sansFichier.codex.source, 'default');
    assert.equal(sansFichier.configOrigin, 'defaults');

    await writeConfig(config({ codex: { skip_git_repo_check: true } }), { configPath: box.configPath });

    const depuisFichier = await loadEffectiveConfig({ configPath: box.configPath }, {});
    assert.equal(depuisFichier.codex.skipGitRepoCheck, true);
    assert.equal(depuisFichier.codex.source, 'config');
    assert.equal(depuisFichier.configPath, box.configPath);

    const avecLegacy = await loadEffectiveConfig({ configPath: box.configPath }, {
      [LEGACY_SKIP_GIT_REPO_CHECK_ENV]: '0',
    });
    // (13/17) La variable présente décide `false` ; elle reste signalable.
    assert.equal(avecLegacy.codex.skipGitRepoCheck, false);
    assert.equal(avecLegacy.codex.source, 'legacy-env');
    assert.equal(avecLegacy.legacyEnv.nonCanonical, true);
  } finally {
    await box.cleanup();
  }
});

// --------------------------------------------------------------------------
// Garde : la configuration réelle de l'utilisateur reste intacte
// --------------------------------------------------------------------------

async function describePath(target: string): Promise<string> {
  try {
    const info = await stat(target);
    return `${String(info.isDirectory())}:${String(info.size)}:${String(info.mtimeMs)}`;
  } catch (error) {
    return `absent:${(error as NodeJS.ErrnoException).code ?? 'inconnu'}`;
  }
}

test('(20) aucune opération de test n\'écrit dans la configuration réelle', async () => {
  const real = defaultConfigPath();
  const realDir = path.dirname(real);
  const before = [await describePath(realDir), await describePath(real), await describePath(`${real}.lock`)];

  const box = await sandbox();
  try {
    // Cycle complet sur un chemin injecté : lecture, écriture, modification,
    // conflit de verrou.
    await readConfig({ configPath: box.configPath });
    await writeConfig(config({ codex: { skip_git_repo_check: true } }), { configPath: box.configPath });
    await updateConfig((current) => current, { configPath: box.configPath });
    const lock = await acquireConfigLock(box.configPath, 'setup');
    await expectCcrError(
      writeConfig(config(), { configPath: box.configPath }),
      'CONFIG_BUSY',
      'conflit sur chemin injecté',
    );
    await lock.release();

    const after = [await describePath(realDir), await describePath(real), await describePath(`${real}.lock`)];
    assert.deepEqual(after, before, `${realDir} doit rester inchangé pendant les tests`);
    assert.ok(!box.configPath.startsWith(realDir), 'le bac à sable est hors de ~/.ccr');
  } finally {
    await box.cleanup();
  }
});

test('(20) le répertoire ~/.ccr n\'est pas créé par une simple lecture', async () => {
  const box = await sandbox();
  try {
    const absent = path.join(box.dir, 'inexistant', CCR_HOME_DIR_NAME, CONFIG_FILE_NAME);
    const loaded = await readConfig({ configPath: absent });

    assert.equal(loaded.origin, 'defaults');
    await assert.rejects(stat(path.dirname(absent)), 'la lecture ne crée aucun répertoire');

    // …alors qu'une écriture, elle, le crée volontairement.
    await mkdir(path.dirname(absent), { recursive: true });
    await writeConfig(config(), { configPath: absent });
    assert.equal((await readConfig({ configPath: absent })).origin, 'file');
  } finally {
    await box.cleanup();
  }
});
