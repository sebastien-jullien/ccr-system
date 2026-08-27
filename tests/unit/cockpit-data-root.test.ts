/**
 * Identité du CCR data root (Slice 2, §4 ; mini-gate de clôture, §6-§9).
 *
 * L'enjeu n'est pas cosmétique. Deux propriétés opposées doivent tenir
 * ensemble, et chacune casse l'unicité du serveur si elle cède :
 *
 * ```text
 * convergence   deux écritures du MÊME root réel → une seule identité
 * séparation    deux roots logiquement DISTINCTS → deux identités
 * ```
 *
 * La seconde est la plus facile à perdre silencieusement : une canonicalisation
 * qui remonterait au premier ancêtre existant sans réattacher le suffixe ferait
 * de `parent/a` et `parent/b` inexistants un seul et même data root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { realpathSync, symlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { hostname } from 'node:os';
import path from 'node:path';

import {
  canonicalizeCcrDataRoot,
  materializeCcrDataRoot,
  resolveCockpitDataRoot,
} from '../../src/cockpit/data-root.ts';
import type { RealpathResolver } from '../../src/cockpit/data-root.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

/** Tous les `server.lock` sous une racine, à n'importe quelle profondeur. */
async function findServerLocks(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'server.lock') found.push(full);
    }
  };
  await walk(root);
  return found;
}

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

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

test('(D0) le data root est le répertoire de runs, et cockpit/ en est un enfant', async () => {
  const dir = await makeTempDir('ccr-droot-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });

    const root = resolveCockpitDataRoot(runsDir);

    assert.equal(root.runsDir, root.dataRoot, 'le data root EST le répertoire de runs');
    assert.equal(root.controlDir, path.join(root.dataRoot, 'cockpit'));
    assert.equal(root.serverLock, path.join(root.dataRoot, 'cockpit', 'server.lock'));
    assert.ok(path.isAbsolute(root.dataRoot), 'chemin absolu');
  } finally {
    await removeTempDir(dir);
  }
});

test('(D1) alias lexicaux : D, D/., D/child/.. → même identité', async () => {
  const dir = await makeTempDir('ccr-droot-dots-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(path.join(runsDir, 'child'), { recursive: true });

    const reference = resolveCockpitDataRoot(runsDir);
    for (const alias of [
      path.join(runsDir, '.'),
      path.join(runsDir, 'child', '..'),
      path.join(runsDir, '.', 'child', '..', '.'),
      `${runsDir}${path.sep}`,
    ]) {
      const observed = resolveCockpitDataRoot(alias);
      assert.equal(observed.dataRoot, reference.dataRoot, `alias « ${alias} »`);
      assert.equal(observed.serverLock, reference.serverLock);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('(D1 bis) une différence de casse ne crée pas un second data root (Windows)', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Sémantique de casse propre à Windows — NOT_TESTED ailleurs');
    return;
  }
  const dir = await makeTempDir('ccr-droot-case-');
  try {
    const runsDir = path.join(dir, 'RunsDir');
    await mkdir(runsDir, { recursive: true });

    const direct = resolveCockpitDataRoot(runsDir);
    const shouted = resolveCockpitDataRoot(runsDir.toUpperCase());

    t.diagnostic(`${direct.dataRoot} ≡ ${shouted.dataRoot}`);
    assert.equal(shouted.dataRoot, direct.dataRoot, 'la casse réelle est restituée par l’OS');
  } finally {
    await removeTempDir(dir);
  }
});

test('(D2) jonction / lien symbolique vers un root existant → même identité', async (t) => {
  const dir = await makeTempDir('ccr-droot-link-');
  try {
    const real = path.join(dir, 'reel');
    const link = path.join(dir, 'alias');
    await mkdir(real, { recursive: true });

    try {
      // `junction` ne requiert pas de privilège élevé sous Windows ; ailleurs,
      // le type est ignoré et un lien symbolique de répertoire est créé.
      symlinkSync(real, link, 'junction');
    } catch (error) {
      t.skip(`NOT_TESTED — création de lien impossible ici (${(error as NodeJS.ErrnoException).code ?? 'inconnu'})`);
      return;
    }

    const direct = resolveCockpitDataRoot(real);
    const through = resolveCockpitDataRoot(link);
    t.diagnostic(`${through.dataRoot} ≡ ${direct.dataRoot}`);

    assert.equal(through.dataRoot, direct.dataRoot, 'la jonction est dépliée');
    assert.equal(through.serverLock, direct.serverLock);

    // Et même lorsque le suffixe traverse la jonction sans exister encore.
    assert.equal(
      canonicalizeCcrDataRoot(path.join(link, 'pas-encore')),
      canonicalizeCcrDataRoot(path.join(real, 'pas-encore')),
      'ancêtre déplié, suffixe réattaché',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('(D3) deux roots inexistants distincts sous le même parent restent distincts', async (t) => {
  const dir = await makeTempDir('ccr-droot-siblings-');
  try {
    const parent = path.join(dir, 'parent');
    await mkdir(parent, { recursive: true });

    const a = resolveCockpitDataRoot(path.join(parent, 'a'));
    const b = resolveCockpitDataRoot(path.join(parent, 'b'));
    t.diagnostic(`a=${a.dataRoot} · b=${b.dataRoot}`);

    // Le défaut redouté : s'effondrer tous deux sur `parent`.
    assert.notEqual(a.dataRoot, b.dataRoot, 'suffixe conservé, pas de fusion');
    assert.notEqual(a.serverLock, b.serverLock);
    assert.equal(a.dataRoot, path.join(canonicalizeCcrDataRoot(parent), 'a'));
    assert.equal(b.dataRoot, path.join(canonicalizeCcrDataRoot(parent), 'b'));

    // Profondeur quelconque, même exigence.
    const deep = resolveCockpitDataRoot(path.join(parent, 'x', 'y', 'z'));
    assert.equal(deep.dataRoot, path.join(canonicalizeCcrDataRoot(parent), 'x', 'y', 'z'));
    assert.notEqual(deep.dataRoot, canonicalizeCcrDataRoot(parent));
  } finally {
    await removeTempDir(dir);
  }
});

test('(D4) root inexistant puis créé → même identité logique', async (t) => {
  const dir = await makeTempDir('ccr-droot-later-');
  try {
    const target = path.join(dir, 'plus', 'tard');

    const before = resolveCockpitDataRoot(target);
    await mkdir(target, { recursive: true });
    const after = resolveCockpitDataRoot(target);

    t.diagnostic(`avant=${before.dataRoot} · après=${after.dataRoot}`);
    assert.equal(after.dataRoot, before.dataRoot, 'identité stable de part et d’autre de la création');
    assert.equal(after.serverLock, before.serverLock);
  } finally {
    await removeTempDir(dir);
  }
});

test('(D4 bis) la matérialisation rend l’identité indépendante de l’orthographe', async (t) => {
  const dir = await makeTempDir('ccr-droot-materialize-');
  try {
    const lower = path.join(dir, 'monroot');
    const upper = path.join(dir, 'MONROOT');

    // Forme pure, sur un root encore inexistant : la casse de l'appelant est
    // conservée, faute de vérité disque à consulter. C'est précisément ce que
    // la matérialisation retire de l'équation.
    const pureLower = canonicalizeCcrDataRoot(lower);
    const pureUpper = canonicalizeCcrDataRoot(upper);

    const first = await materializeCcrDataRoot(lower);
    const second = await materializeCcrDataRoot(upper);

    t.diagnostic(
      `pure : ${path.basename(pureLower)} vs ${path.basename(pureUpper)} · ` +
        `matérialisée : ${path.basename(first.dataRoot)} vs ${path.basename(second.dataRoot)}`,
    );

    if (process.platform === 'win32') {
      assert.equal(second.dataRoot, first.dataRoot, 'l’OS tranche, pas l’orthographe');
      assert.equal(second.serverLock, first.serverLock);
    } else {
      // Système sensible à la casse : ce sont réellement deux roots.
      assert.notEqual(second.dataRoot, first.dataRoot);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('(D5) deux écritures du même root existant : le second cockpit est refusé', async (t) => {
  const dir = await makeTempDir('ccr-droot-alias-run-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(path.join(runsDir, 'child'), { recursive: true });
    const { startCockpit } = await import('../../src/cockpit/cockpit-service.ts');
    const { isCcrError } = await import('../../src/core/errors.ts');

    const first = await startCockpit({ runsDir, port: 0 });
    try {
      const alias = path.join(runsDir, 'child', '..');
      t.diagnostic(`alias utilisé : ${alias}`);

      await assert.rejects(startCockpit({ runsDir: alias, port: 0 }), (error: unknown) => {
        assert.ok(isCcrError(error));
        assert.equal(error.code, 'COCKPIT_ALREADY_RUNNING');
        return true;
      });
    } finally {
      assert.equal(await first.stop(), 'RELEASED');
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('(D6) deux roots distincts : deux server.lock distincts, deux serveurs', async (t) => {
  const dir = await makeTempDir('ccr-droot-two-');
  try {
    const { startCockpit } = await import('../../src/cockpit/cockpit-service.ts');
    const a = path.join(dir, 'parent', 'a');
    const b = path.join(dir, 'parent', 'b');

    const first = await startCockpit({ runsDir: a, port: 0 });
    const second = await startCockpit({ runsDir: b, port: 0 });
    try {
      t.diagnostic(`${first.dataRoot.serverLock} | ${second.dataRoot.serverLock}`);
      assert.notEqual(first.dataRoot.serverLock, second.dataRoot.serverLock);
      assert.notEqual(first.lock.instance_id, second.lock.instance_id);
      assert.notEqual(first.server.port, second.server.port);
      assert.equal(await exists(first.dataRoot.serverLock), true);
      assert.equal(await exists(second.dataRoot.serverLock), true);
    } finally {
      await first.stop();
      await second.stop();
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('(D7) server.lock est sous R/cockpit/, jamais sous un ancêtre de R', async (t) => {
  const dir = await makeTempDir('ccr-droot-place-');
  try {
    const { startCockpit } = await import('../../src/cockpit/cockpit-service.ts');
    // Root volontairement inexistant, et profond : c'est le cas où une
    // canonicalisation qui perdrait le suffixe placerait le verrou chez
    // l'ancêtre.
    const grandParent = path.join(dir, 'gp');
    const parent = path.join(grandParent, 'p');
    const root = path.join(parent, 'r');

    const instance = await startCockpit({ runsDir: root, port: 0 });
    try {
      const expected = path.join(instance.dataRoot.dataRoot, 'cockpit', 'server.lock');
      t.diagnostic(`verrou : ${instance.dataRoot.serverLock}`);

      assert.equal(instance.dataRoot.serverLock, expected);
      assert.equal(await exists(expected), true, 'le verrou est bien sous R');
      assert.equal(path.basename(instance.dataRoot.dataRoot), 'r', 'R n’a pas été tronqué');

      for (const ancestor of [parent, grandParent, dir]) {
        assert.equal(
          await exists(path.join(ancestor, 'cockpit', 'server.lock')),
          false,
          `aucun verrou chez l’ancêtre ${ancestor}`,
        );
      }

      // Le verrou décrit bien cette instance.
      const raw: unknown = JSON.parse(await readFile(expected, 'utf8'));
      assert.equal((raw as { instance_id: string }).instance_id, instance.lock.instance_id);
    } finally {
      assert.equal(await instance.stop(), 'RELEASED');
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('(D8) le sous-répertoire cockpit/ ne peut pas être confondu avec un run', async () => {
  const { isRunId } = await import('../../src/core/ids.ts');
  // C'est ce qui autorise cockpit/ à cohabiter avec les runs sans toucher au
  // layout V1 : `listRunIds` ne retient que les identifiants canoniques.
  assert.equal(isRunId('cockpit'), false);
});

// --------------------------------------------------------------------------
// Fail-closed — l'identité du data root est une primitive de sécurité
//
// Une résolution qui échoue ne prouve pas que la forme lexicale est l'identité
// canonique ; elle prouve qu'on ne sait pas. Deux alias irrésolus garderaient
// chacun leur forme lexicale et pourraient désigner le même stockage : c'est
// exactement ce que l'invariant « un cockpit par data root » interdit.
//
// La couture de résolution est nécessaire, pas confortable : sous Windows, un
// chemin situé sous un fichier rend `ENOENT`, jamais `ENOTDIR`. Aucun code
// inattendu n'est reproductible de façon fiable par le système de fichiers.
// --------------------------------------------------------------------------

function failingRealpath(code: string, failOn?: (target: string) => boolean): RealpathResolver {
  return (target: string) => {
    if (failOn === undefined || failOn(target)) {
      const error: NodeJS.ErrnoException = new Error(`échec simulé ${code}`);
      error.code = code;
      throw error;
    }
    return realpathSync.native(target);
  };
}

async function expectUnresolvable(action: () => unknown): Promise<void> {
  const { isCcrError } = await import('../../src/core/errors.ts');
  await assert.rejects(
    (async () => action())(),
    (error: unknown) => {
      assert.ok(isCcrError(error), `CcrError attendue, reçu ${String(error)}`);
      assert.equal(error.code, 'CCR_DATA_ROOT_UNRESOLVABLE');
      // Message public : il explique, sans pile ni objet brut.
      assert.match(error.message, /identité canonique|pas pu être préparé/);
      assert.equal(error.message.includes('Error:'), false);
      assert.equal('stack' in error.details, false);
      return true;
    },
  );
}

test('(C1) ENOENT conserve exactement la sémantique du suffixe inexistant', async (t) => {
  const dir = await makeTempDir('ccr-failclosed-enoent-');
  try {
    const parent = path.join(dir, 'parent');
    await mkdir(parent, { recursive: true });
    const real = canonicalizeCcrDataRoot(parent);

    // Seul le chemin complet est absent ; la remontée doit opérer normalement.
    const observed = canonicalizeCcrDataRoot(path.join(parent, 'a', 'b'), {
      realpath: failingRealpath('ENOENT', (target) => target !== real && target !== parent),
    });
    t.diagnostic(observed);
    assert.equal(observed, path.join(real, 'a', 'b'), 'suffixe réattaché, aucun échec');
  } finally {
    await removeTempDir(dir);
  }
});

test('(C2/C3/C4) EACCES, ELOOP, ENOTDIR → échec, jamais de repli lexical', async (t) => {
  const dir = await makeTempDir('ccr-failclosed-codes-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });

    for (const code of ['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'EIO']) {
      const realpath = failingRealpath(code);
      await expectUnresolvable(() => canonicalizeCcrDataRoot(runsDir, { realpath }));
      await expectUnresolvable(() => resolveCockpitDataRoot(runsDir, { realpath }));
      await expectUnresolvable(() => materializeCcrDataRoot(runsDir, { realpath }));
      t.diagnostic(`${code} → CCR_DATA_ROOT_UNRESOLVABLE`);
    }

    // Le repli redouté n'existe plus : aucune valeur lexicale n'est rendue.
    let lexical: string | undefined;
    try {
      lexical = canonicalizeCcrDataRoot(runsDir, { realpath: failingRealpath('EACCES') });
    } catch {
      lexical = undefined;
    }
    assert.equal(lexical, undefined, 'aucune identité inventée');
  } finally {
    await removeTempDir(dir);
  }
});

test('(C4 bis) aucun ancêtre résoluble → échec explicite', async () => {
  const dir = await makeTempDir('ccr-failclosed-noancestor-');
  try {
    // Tout est ENOENT jusqu'à la racine du volume : il n'existe aucun ancêtre
    // réel sur lequel fonder une identité.
    await expectUnresolvable(() =>
      canonicalizeCcrDataRoot(path.join(dir, 'x'), { realpath: failingRealpath('ENOENT') }),
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('(C5) démarrage sous erreur inattendue : aucun verrou, aucun socket', async (t) => {
  const dir = await makeTempDir('ccr-failclosed-start-');
  try {
    const runsDir = path.join(dir, 'runs');
    const { startCockpit } = await import('../../src/cockpit/cockpit-service.ts');

    // Port réservé puis relâché : s'il est ouvert ensuite, un serveur a démarré.
    const port = await freePort();
    assert.equal(await isListening(port), false, 'port libre au départ');

    await expectUnresolvable(() => startCockpit({ runsDir, port, realpath: failingRealpath('EACCES') }));

    // `mkdir` précède la canonicalisation : le répertoire vide existe. C'est
    // déclaré, pas dissimulé — mais aucun artefact cockpit n'existe.
    const materialized = await exists(runsDir);
    const locks = await findServerLocks(dir);
    t.diagnostic(`répertoire matérialisé=${String(materialized)} · verrous trouvés=${String(locks.length)}`);

    assert.equal(locks.length, 0, 'aucun server.lock');
    assert.equal(await exists(path.join(runsDir, 'cockpit')), false, 'aucun répertoire de contrôle');
    assert.equal(await isListening(port), false, 'aucun socket ouvert');
  } finally {
    await removeTempDir(dir);
  }
});

test('(C6) levée sous erreur inattendue : aucun fichier supprimé', async (t) => {
  const dir = await makeTempDir('ccr-failclosed-clear-');
  try {
    const runsDir = path.join(dir, 'runs');
    const root = resolveCockpitDataRoot(runsDir);
    await mkdir(root.controlDir, { recursive: true });

    const stale = {
      schema_version: 1,
      instance_id: 'cafecafe-0000-0000-0000-000000000000',
      pid: 999_996,
      hostname: hostname(),
      created_at: new Date().toISOString(),
    };
    await writeFile(root.serverLock, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');
    const before = await readFile(root.serverLock, 'utf8');

    const { clearStaleCockpitLock } = await import('../../src/cockpit/cockpit-service.ts');

    // La commande destructive s'arrête AVANT toute lecture du verrou.
    await expectUnresolvable(() =>
      clearStaleCockpitLock(runsDir, stale.instance_id, { realpath: failingRealpath('EACCES') }),
    );

    assert.equal(await readFile(root.serverLock, 'utf8'), before, 'verrou intact, octet pour octet');
    t.diagnostic('identité indéterminable → aucune suppression');

    // Contrôle positif : la même levée réussit lorsque l'identité est établie.
    const { removed } = await clearStaleCockpitLock(runsDir, stale.instance_id);
    assert.equal(removed.instance_id, stale.instance_id);
    assert.equal(await exists(root.serverLock), false);
  } finally {
    await removeTempDir(dir);
  }
});
