/**
 * Emplacement par défaut des données d'exécution.
 *
 * Question de preuve :
 *
 * > **Le chemin par défaut est-il bien `.ccr/runs`, et la précédence entre
 * > défaut, variable d'environnement et option explicite est-elle intacte ?**
 *
 * Trois propriétés.
 *
 *  1. **Le défaut est `.ccr/runs`**, résolu depuis la racine du projet.
 *  2. **La précédence est inchangée** : option explicite, puis `CCR_RUNS_DIR`,
 *     puis le défaut. Aucun de ces trois chemins n'en dépasse un autre.
 *  3. **Rien d'autre ne change** : la disposition d'un run à l'intérieur du
 *     répertoire — manifeste, état, journaux — ne dépend pas de sa racine.
 *
 * Ce test ne touche aucun disque : `resolveRunsDir` et `runPaths` sont des
 * fonctions pures de chemin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { CCR_ROOT, DEFAULT_RUNS_SUBDIR, resolveRunsDir, runPaths } from '../../src/store/layout.ts';

/** Exécute une fonction avec `CCR_RUNS_DIR` positionné, puis restaure. */
function withEnv<T>(value: string | undefined, run: () => T): T {
  const avant = process.env['CCR_RUNS_DIR'];
  if (value === undefined) delete process.env['CCR_RUNS_DIR'];
  else process.env['CCR_RUNS_DIR'] = value;
  try {
    return run();
  } finally {
    if (avant === undefined) delete process.env['CCR_RUNS_DIR'];
    else process.env['CCR_RUNS_DIR'] = avant;
  }
}

test('1 · le répertoire de runs par défaut est `.ccr/runs`', () => {
  assert.equal(DEFAULT_RUNS_SUBDIR, path.join('.ccr', 'runs'));

  const resolu = withEnv(undefined, () => resolveRunsDir());
  assert.equal(resolu, path.join(CCR_ROOT, '.ccr', 'runs'));

  // L'état d'exécution ne vit pas dans un répertoire de documentation.
  assert.equal(resolu.includes(`${path.sep}docs${path.sep}`), false);
  assert.equal(resolu.includes('cross-review'), false);
});

test('2 · une option explicite l’emporte sur tout le reste', () => {
  const explicite = withEnv('E:/env/ailleurs', () => resolveRunsDir('E:/explicite/runs'));
  assert.equal(explicite, path.resolve('E:/explicite/runs'));
});

test('3 · `CCR_RUNS_DIR` l’emporte sur le défaut, et seulement sur lui', () => {
  const parEnv = withEnv('E:/env/ailleurs', () => resolveRunsDir());
  assert.equal(parEnv, path.resolve('E:/env/ailleurs'));

  // Une variable vide n'est pas une valeur : le défaut reprend la main.
  const vide = withEnv('', () => resolveRunsDir());
  assert.equal(vide, path.join(CCR_ROOT, '.ccr', 'runs'));
});

test('4 · la disposition d’un run ne dépend pas de la racine', () => {
  // Même run, deux racines : seuls les préfixes diffèrent. Le changement de
  // chemin par défaut est un choix d'emplacement, jamais un changement de
  // sémantique de persistance.
  const a = runPaths('E:/a/runs', 'CCR-20260101-001');
  const b = runPaths('E:/b/.ccr/runs', 'CCR-20260101-001');

  const relatif = (racine: string, p: string): string => path.relative(racine, p);
  for (const cle of ['manifest', 'state', 'events', 'decisions', 'roundsDir'] as const) {
    assert.equal(
      relatif('E:/a/runs', a[cle]),
      relatif('E:/b/.ccr/runs', b[cle]),
      `disposition divergente pour ${cle}`,
    );
  }
});
