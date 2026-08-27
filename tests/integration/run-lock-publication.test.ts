/**
 * Publication du verrou de run — « créer n'est pas publier », second fichier.
 *
 * Le même défaut que celui corrigé sur le store d'idempotence vivait ici :
 * `open('.ccr.lock', 'wx')` créait le fichier **vide**, et le contenu n'y était
 * écrit qu'ensuite. Mesuré sur ce poste avant correction, pendant la fenêtre :
 *
 * ```text
 * .ccr.lock présent, 0 octet
 * lecture concurrente     → LOCK_INVALID
 * acquisition concurrente → LOCK_INVALID   (au lieu de RUN_ALREADY_LOCKED)
 * observation 0D          → INDETERMINATE_LOCK
 * ```
 *
 * Trois verdicts faux, causés uniquement par un verrou temporairement vide.
 *
 * La correction écrit le document à l'écart, le `fsync`, puis le rend visible
 * par un lien dur — exclusif et atomique. Le verrou naît complet ou ne naît
 * pas. Ce fichier de test tient la fenêtre ouverte à volonté et vérifie qu'elle
 * ne montre plus rien.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { acquireRunLock, lockFilePath, readRunLock } from '../../src/lock/run-lock.ts';
import type { RunLockHandle } from '../../src/lock/run-lock.ts';
import { observeRunExecution } from '../../src/lock/run-execution-evidence.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { runPaths } from '../../src/store/layout.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { RunPaths } from '../../src/store/layout.ts';

const RUN = 'CCR-20260810-001';

interface Box {
  readonly paths: RunPaths;
  readonly lockPath: string;
  entries(): Promise<string[]>;
  cleanup(): Promise<void>;
}

async function box(): Promise<Box> {
  const dir = await makeTempDir('ccr-run-lock-publication-');
  const paths = runPaths(path.join(dir, 'runs'), RUN);
  await mkdir(paths.root, { recursive: true });
  return {
    paths,
    lockPath: lockFilePath(paths),
    entries: async () => (await readdir(paths.root)).sort(),
    cleanup: () => removeTempDir(dir),
  };
}

/** Une porte que le test ouvre quand il le décide — jamais un délai. */
function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const codeOf = (error: unknown): string =>
  isCcrError(error) ? error.code : `${(error as NodeJS.ErrnoException).code ?? 'inconnu'}`;

// --------------------------------------------------------------------------
// W1 — la fenêtre ne montre rien
// --------------------------------------------------------------------------

test('(W1) pendant la publication, aucun lecteur ne voit de verrou incomplet', async (t) => {
  const b = await box();
  try {
    const held = gate();
    let reached!: () => void;
    const windowOpen = new Promise<void>((resolve) => {
      reached = resolve;
    });

    const owner = acquireRunLock(b.paths, 'step', {
      onExclusiveCreated: async () => {
        reached();
        await held.promise;
      },
    });
    await windowOpen;

    // Le document existe, à l'écart — pas au chemin du verrou.
    const entries = await b.entries();
    t.diagnostic(`pendant la fenêtre : ${entries.join(', ')}`);
    assert.equal(existsSync(b.lockPath), false, 'le chemin du verrou ne doit rien porter d’incomplet');
    const staged = entries.filter((name) => name.startsWith('.ccr.lock.') && name.endsWith('.tmp'));
    assert.equal(staged.length, 1, 'le document attend à l’écart');
    const pending = JSON.parse(await readFile(path.join(b.paths.root, staged[0] ?? ''), 'utf8')) as Record<string, unknown>;
    assert.match(String(pending['lock_id']), /^[0-9a-f-]{36}$/, 'et il est déjà complet');

    // Les trois verdicts qui étaient faux.
    const read = await readRunLock(b.paths).then((v) => (v === undefined ? 'AUCUN VERROU' : `verrou ${v.lock_id}`), codeOf);
    const observation = await observeRunExecution(b.paths, {}).then((o) => o.observation, codeOf);
    t.diagnostic(`lecture → ${read} · observation 0D → ${observation}`);
    assert.equal(read, 'AUCUN VERROU', 'un verrou en cours de publication n’est pas un verrou illisible');
    assert.notEqual(read, 'LOCK_INVALID');
    assert.equal(observation, 'NO_LOCK');
    assert.notEqual(observation, 'INDETERMINATE_LOCK');

    held.open();
    const handle = await owner;
    t.diagnostic(`après publication : ${(await b.entries()).join(', ')}`);
    assert.equal(existsSync(b.lockPath), true);
    assert.equal((await readRunLock(b.paths))?.lock_id, handle.info.lock_id, 'le verrou publié est bien le sien');
    assert.deepEqual(await b.entries(), ['.ccr.lock'], 'le document à l’écart est retiré');
    assert.equal(await handle.release(), 'RELEASED');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// W2 — un seul propriétaire, quoi qu'il arrive dans la fenêtre
// --------------------------------------------------------------------------

test('(W2) une acquisition concurrente pendant la fenêtre : un seul propriétaire', async (t) => {
  const b = await box();
  let winner: RunLockHandle | undefined;
  try {
    const held = gate();
    let reached!: () => void;
    const windowOpen = new Promise<void>((resolve) => {
      reached = resolve;
    });

    const first = acquireRunLock(b.paths, 'step', {
      onExclusiveCreated: async () => {
        reached();
        await held.promise;
      },
    });
    await windowOpen;

    // Aucun verrou n'est encore publié : ce concurrent l'obtient légitimement.
    const rival = await acquireRunLock(b.paths, 'send');
    winner = rival;
    t.diagnostic(`concurrent pendant la fenêtre → obtient le verrou ${rival.info.lock_id}`);

    held.open();
    const refused = await first.then(() => 'ACQUIS', (error: unknown) => codeOf(error));
    t.diagnostic(`propriétaire retardé → ${refused}`);

    // Le refus dit la vérité : le verrou est détenu, pas illisible.
    assert.equal(refused, 'RUN_ALREADY_LOCKED');
    assert.notEqual(refused, 'LOCK_INVALID');

    // Un seul verrou sur disque, complet, et c'est celui du gagnant.
    assert.deepEqual(await b.entries(), ['.ccr.lock'], 'aucun document abandonné au chemin du verrou');
    const published = JSON.parse(await readFile(b.lockPath, 'utf8')) as Record<string, unknown>;
    assert.equal(published['lock_id'], rival.info.lock_id);
    assert.equal(published['command'], 'send', 'le perdant n’a rien écrit par-dessus');
    assert.equal((await readRunLock(b.paths))?.lock_id, rival.info.lock_id);
  } finally {
    if (winner !== undefined) await winner.release();
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// W3 — interruption pendant la publication
// --------------------------------------------------------------------------

test('(W3) interrompu avant la publication : aucun verrou, aucun second propriétaire', async (t) => {
  const b = await box();
  try {
    // Le propriétaire abandonne dans la fenêtre, document écrit, jamais lié.
    const aborted = await acquireRunLock(b.paths, 'step', {
      onExclusiveCreated: () => {
        throw new Error('interruption pendant la publication');
      },
    }).then(() => 'ACQUIS', (error: unknown) => (error as Error).message);
    t.diagnostic(`publication interrompue → ${aborted}`);
    assert.equal(aborted, 'interruption pendant la publication');

    // Rien au chemin du verrou : un abandon ne laisse pas d'artefact à lire.
    assert.equal(existsSync(b.lockPath), false);
    assert.equal(await readRunLock(b.paths), undefined);
    assert.equal((await observeRunExecution(b.paths, {})).observation, 'NO_LOCK');

    // L'acquisition suivante réussit, et elle est seule.
    const handle = await acquireRunLock(b.paths, 'send');
    assert.equal((await readRunLock(b.paths))?.lock_id, handle.info.lock_id);
    assert.equal(await handle.release(), 'RELEASED');

    /**
     * Et l'artefact hérité — un `.ccr.lock` vide, tel que l'ancien protocole
     * pouvait en laisser au crash — reste **fail-closed** : il n'est ni ignoré,
     * ni écrasé, et n'ouvre à personne un second droit de propriété.
     */
    await writeFile(b.lockPath, '', 'utf8');
    const onLegacy = await acquireRunLock(b.paths, 'step').then(() => 'ACQUIS', codeOf);
    t.diagnostic(`artefact vide hérité → acquisition ${onLegacy}`);
    assert.equal(onLegacy, 'LOCK_INVALID', 'un verrou illisible ne se laisse pas reprendre');
    assert.equal(await readFile(b.lockPath, 'utf8'), '', "l'artefact n'est ni réparé ni supprimé");
    assert.deepEqual(await b.entries(), ['.ccr.lock'], 'aucun document laissé à côté');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// W4 — la publication atomique échoue : rien, plutôt qu'un verrou mal né
// --------------------------------------------------------------------------

test('(W4) `link` impossible : échec franc, aucun verrou, aucun repli', async (t) => {
  const b = await box();
  try {
    /**
     * Un vrai échec de `link`, obtenu sans nouvelle couture : le document à
     * l'écart disparaît pendant la fenêtre, et la liaison échoue en `ENOENT`.
     *
     * Ce que ce test surveille n'est pas le code système — il vaudrait
     * `EPERM` ou `ENOSYS` sur un système de fichiers sans lien dur — mais la
     * branche empruntée : celle où CCR n'a pas d'autre façon de publier.
     * L'ancienne publication en deux temps y retombait, et aurait laissé un
     * `.ccr.lock` derrière elle. Son absence est donc la preuve qu'aucun repli
     * n'existe.
     */
    const failed = await acquireRunLock(b.paths, 'step', {
      onExclusiveCreated: async (info) => {
        await unlink(path.join(b.paths.root, `.ccr.lock.${info.lock_id}.tmp`));
      },
    }).then(() => 'ACQUIS', (error: unknown) => error);

    const code = typeof failed === 'string' ? failed : codeOf(failed);
    const message = isCcrError(failed) ? failed.message : '';
    t.diagnostic(`publication impossible → ${code}`);
    t.diagnostic(`répertoire du run après échec : ${JSON.stringify(await b.entries())}`);

    // 1. erreur CCR propre, pas une erreur système brute remontée telle quelle
    assert.equal(code, 'LOCK_PUBLICATION_FAILED');
    assert.ok(isCcrError(failed), 'une erreur CCR, pas un `Error` de `node:fs`');
    assert.match(message, /Aucun verrou n'a été posé/, "le message dit ce qui est vérifiable");
    assert.equal((failed as { details?: { syscall?: string } }).details?.syscall, 'link');

    // 2. aucun `.ccr.lock`, donc aucun repli vers `open('wx') → write`
    assert.equal(existsSync(b.lockPath), false, 'un repli aurait publié un verrou ici');
    assert.deepEqual(await b.entries(), [], 'ni verrou, ni document abandonné');

    // 3. aucune propriété accordée : les lecteurs ne voient rien
    assert.equal(await readRunLock(b.paths), undefined);
    assert.equal((await observeRunExecution(b.paths, {})).observation, 'NO_LOCK');

    // 4. et l'échec n'a rien consommé : une acquisition normale reprend la main
    const handle = await acquireRunLock(b.paths, 'send');
    assert.equal((await readRunLock(b.paths))?.lock_id, handle.info.lock_id);
    assert.equal(await handle.release(), 'RELEASED');
  } finally {
    await b.cleanup();
  }
});
