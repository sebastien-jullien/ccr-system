/**
 * Frontières du chemin de reprise (Slice 7).
 *
 * Deux propriétés que le comportement seul ne rendrait pas visibles, et qu'un
 * refactor futur pourrait défaire sans qu'aucun test métier ne bronche :
 *
 * ```text
 * le cockpit ne dépend jamais de la façade publique `recoverRun`
 * la sélection d'une capacité n'existe qu'à un seul endroit
 * ```
 *
 * La première protège la doctrine V2 : `recoverRun` lève un verrou périmé
 * **avant** d'acquérir le sien (`run-service.ts:1383-1390`), sur une seule
 * observation. C'est le comportement V1, gelé et légitime en ligne de commande ;
 * il n'a pas sa place dans une intention HTTP, où la levée est une décision
 * humaine distincte.
 *
 * Ces gardes inspectent les **clauses d'import**, pas des chaînes libres : un
 * appel ne peut pas apparaître sans que le symbole soit importé.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recoverRunLocked } from '../../src/services/run-service.ts';
import { planRecovery, RECOVERY_CAPABILITY_IDS } from '../../src/services/recovery-planner.ts';
import { RECOVERY_ROUTES } from '../../src/cockpit/mutations-http.ts';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|js)$/.test(entry.name)) found.push(full);
    }
  };
  await walk(directory);
  return found;
}

/** Retire commentaires et littéraux : une garde ne lit pas de la prose. */
function executable(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Symboles réellement importés d'un module, clause par clause. */
function importedSymbols(code: string): Map<string, string[]> {
  const byModule = new Map<string, string[]>();
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g;
  for (const match of code.matchAll(pattern)) {
    const names = (match[1] ?? '')
      .split(',')
      .map((piece) => piece.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
      .filter((name) => name.length > 0);
    const module = match[2] ?? '';
    byModule.set(module, [...(byModule.get(module) ?? []), ...names]);
  }
  return byModule;
}

// --------------------------------------------------------------------------
// (R-B1) Le cockpit ne dépend jamais de la façade legacy
// --------------------------------------------------------------------------

test('(R-B1) aucun module du cockpit n’importe le `recoverRun` public', async (t) => {
  const files = await filesUnder(path.join(SRC, 'cockpit'));
  assert.ok(files.length > 0, 'le répertoire du cockpit a bien été parcouru');

  const offenders: string[] = [];
  for (const file of files) {
    const code = await readFile(file, 'utf8');
    for (const [, names] of importedSymbols(code)) {
      if (names.includes('recoverRun')) offenders.push(path.relative(SRC, file));
    }
    // Ceinture et bretelles : un accès dynamique contournerait la clause.
    assert.equal(
      /\brecoverRun\s*\(/.test(code),
      false,
      `${path.relative(SRC, file)} appelle recoverRun`,
    );
  }
  t.diagnostic(`modules cockpit audités : ${String(files.length)}`);
  assert.deepEqual(offenders, [], 'la façade legacy est atteinte depuis le cockpit');
});

// --------------------------------------------------------------------------
// (R-B2) La primitive verrouillée est réutilisable, et c'est bien la V1
// --------------------------------------------------------------------------

test('(R-B2) `recoverRunLocked` est exporté, et `recoverRun` reste inchangé', async (t) => {
  assert.equal(typeof recoverRunLocked, 'function', 'la primitive verrouillée est réutilisable');

  const code = await readFile(path.join(SRC, 'services', 'run-service.ts'), 'utf8');

  // La façade publique conserve son pré-nettoyage legacy : ce slice ne la
  // modifie pas, il cesse seulement de l'emprunter.
  assert.match(code, /export async function recoverRun\(/);
  assert.match(code, /assessLiveness\(existing\) === 'STALE'/, 'le comportement V1 est intact');
  assert.match(code, /staleLock = await clearStaleLock\(paths\)/);

  // Une seule définition de la primitive verrouillée : aucune branche dupliquée.
  assert.equal(
    (code.match(/function recoverRunLocked\(/g) ?? []).length,
    1,
    'la logique de reprise n’existe qu’une fois',
  );
  t.diagnostic('recoverRun legacy intact · recoverRunLocked exporté une seule fois');
});

// --------------------------------------------------------------------------
// (R-B3) Une seule logique de sélection de capacité
// --------------------------------------------------------------------------

test('(R-B3) la sélection d’une capacité n’existe que dans le planner partagé', async (t) => {
  assert.equal(typeof planRecovery, 'function');

  const planner = await readFile(path.join(SRC, 'services', 'recovery-planner.ts'), 'utf8');
  assert.match(planner, /export function planCanonicalRecovery\(/, 'le planner porte la décision métier');

  // La décision canonique ne consulte aucun fait d'exécution : c'est ce qui
  // permet à un appelant détenant déjà le verrou de ne pas se le voir opposer.
  const canonicalStart = planner.indexOf('export function planCanonicalRecovery(');
  const canonicalBody = planner.slice(canonicalStart, planner.indexOf('\n}', canonicalStart));
  for (const forbidden of ['observed', 'lock', 'Lock', 'liveness', 'evidence', 'registry', 'pid', 'hostname']) {
    assert.equal(
      canonicalBody.includes(forbidden),
      false,
      `le plan canonique consulte « ${forbidden} » : la circularité reviendrait`,
    );
  }

  // Le transport nomme les capacités — il le doit, une route est un segment de
  // chemin. Ce qu'il ne doit pas faire, c'est **choisir** : sa table est une
  // bijection figée entre une syntaxe d'URL et une intention, et rien d'autre
  // dans le fichier ne peut désigner une capacité.
  const bijection = new Set(Object.values(RECOVERY_ROUTES));
  t.diagnostic(`table de routes : ${String(Object.keys(RECOVERY_ROUTES).length)} segments → ${String(bijection.size)} capacités`);
  assert.equal(Object.keys(RECOVERY_ROUTES).length, RECOVERY_CAPABILITY_IDS.length, 'table incomplète ou surnuméraire');
  assert.equal(bijection.size, RECOVERY_CAPABILITY_IDS.length, 'deux segments désignent la même capacité');
  for (const id of RECOVERY_CAPABILITY_IDS) {
    assert.equal(bijection.has(id), true, `aucune route pour ${id}`);
  }

  const transport = await readFile(path.join(SRC, 'cockpit', 'mutations-http.ts'), 'utf8');
  const table = transport.slice(
    transport.indexOf('export const RECOVERY_ROUTES'),
    transport.indexOf('};', transport.indexOf('export const RECOVERY_ROUTES')),
  );
  // Hors de la table, toute mention d'une capacité doit être une *comparaison*
  // avec la capacité déjà déduite de la route — jamais une affectation. C'est
  // la différence entre distinguer et choisir.
  const outside = transport.replace(table, '');
  const mentions: string[] = [];
  for (const id of RECOVERY_CAPABILITY_IDS) {
    const pattern = new RegExp(`(.{0,24})'${id}'`, 'g');
    for (const match of outside.matchAll(pattern)) {
      mentions.push(id);
      assert.match(
        match[1] ?? '',
        /(?:capability|canonical)\s*(?:===|!==)\s*$/,
        `${id} est nommée hors comparaison : le transport choisit une capacité`,
      );
    }
  }
  t.diagnostic(`mutations-http.ts : ${String(mentions.length)} mention(s) hors table, toutes comparatives`);

  // Et surtout : le transport ne planifie rien. Il ne peut pas rebâtir une
  // décision qu'il n'a aucun moyen d'appeler.
  const consumers = [
    path.join(SRC, 'services', 'cockpit-read-model.ts'),
    path.join(SRC, 'cockpit', 'mutations-http.ts'),
    path.join(SRC, 'cockpit', 'server.ts'),
  ];
  for (const file of consumers) {
    const code = await readFile(file, 'utf8');
    assert.equal(
      /switch\s*\([^)]*liveness/.test(code),
      false,
      `${path.basename(file)} contient un second aiguillage sur la vivacité`,
    );
  }
  for (const forbidden of ['planCanonicalRecovery', 'pendingResponseJournaled', 'observeRunExecution']) {
    assert.equal(transport.includes(forbidden), false, `le transport réintroduit ${forbidden}`);
  }

  // Et la vue consomme réellement le planner complet — plan canonique plus
  // gating d'exécution, puisqu'elle ne détient aucun verrou.
  const view = await readFile(path.join(SRC, 'services', 'cockpit-read-model.ts'), 'utf8');
  assert.match(view, /planRecovery\(/, 'la vue appelle le planner partagé');

  // Le service de mutation, lui, détient le verrou : il consomme le plan
  // canonique seul, et n'observe jamais l'exécution.
  const service = await readFile(path.join(SRC, 'services', 'recovery-application-service.ts'), 'utf8');
  assert.match(service, /planCanonicalRecovery\(/, 'le service appelle le plan canonique');
  for (const forbidden of ['observeRunExecution', 'planRecovery(', 'classifyRunLiveness']) {
    assert.equal(service.includes(forbidden), false, `le service réintroduit ${forbidden}`);
  }
});

// --------------------------------------------------------------------------
// (R-B4) La levée de verrou ne chaîne rien, et ne dépend de rien
// --------------------------------------------------------------------------

test('(R-B4) le service de levée est isolé : aucune reprise, aucun quota, aucun verrou pris', async (t) => {
  const file = path.join(SRC, 'services', 'clear-stale-run-lock-service.ts');
  const code = executable(await readFile(file, 'utf8'));

  // Aucune reprise canonique ne peut être enchaînée : les symboles ne sont ni
  // importés, ni appelés. Après une levée réussie, le service retourne.
  for (const forbidden of [
    'recoverRun',
    'recoverRunLocked',
    'applyCanonicalRecovery',
    'LongOperationManager',
    'createLongOperationManager',
    'withRunLock',
    'acquireRunLock',
    'createAdapters',
  ]) {
    assert.equal(code.includes(forbidden), false, `le service de levée atteint ${forbidden}`);
  }

  // La reconfirmation 0D ne doit pas être court-circuitée : `options.lock`
  // désactive la double observation, et c'est exactement ce qui protège de la
  // rotation de verrou.
  assert.match(code, /observeRunExecution\(/, 'l’observation robuste est utilisée');
  assert.equal(/lock:\s*[A-Za-z]/.test(code), false, 'le raccourci options.lock n’est jamais fourni');

  // Le chemin dérive du run id validé, jamais d'une entrée d'appelant.
  assert.match(code, /runPaths\(/);
  assert.match(code, /isRunId\(/);
  assert.equal(code.includes('force'), false, 'aucune levée forcée');
  t.diagnostic('service de levée : aucune dépendance de reprise, de quota ni de verrou');
});
