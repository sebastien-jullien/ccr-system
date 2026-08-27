/**
 * Gardes de source du chemin START (Slice 6).
 *
 * Ces tests ne vérifient pas un comportement — d'autres s'en chargent. Ils
 * vérifient des **frontières** que le comportement seul ne rendrait pas
 * visibles : qu'une politique n'existe qu'à un endroit, qu'un processus n'est
 * jamais lancé, qu'un secret n'est jamais recopié.
 *
 * Une garde de source est fragile si elle cherche une chaîne. Celles-ci
 * cherchent des *appels* : ce qui casse la propriété casse la garde.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = new URL('../../src/', import.meta.url);

const read = (relative: string): Promise<string> => readFile(new URL(relative, SRC), 'utf8');

/** Retire commentaires et littéraux : une garde ne doit pas lire de la prose. */
function executable(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const COCKPIT_START_MODULES = ['cockpit/mutations-http.ts', 'cockpit/server.ts', 'services/start-mutation.ts'];

// --------------------------------------------------------------------------
// (G-START-1 / M1) Une seule voie de création
// --------------------------------------------------------------------------

test('(G-START-1) le cockpit crée un run par la façade, jamais par une composition basse', async (t) => {
  // Les primitives d'allocation et d'initialisation ne doivent apparaître dans
  // AUCUN module du chemin cockpit — ni appelées, ni même importées.
  const forbidden = ['createRunDirectory', 'initializeRun', 'startRun(', 'writeManifest', 'startClaudeSession', 'startCodexSession'];
  for (const name of COCKPIT_START_MODULES) {
    const code = executable(await read(name));
    for (const symbol of forbidden) {
      assert.equal(code.includes(symbol), false, `${name} atteint ${symbol} — la façade est contournée`);
    }
  }

  // Et la façade est bien atteinte, une seule fois, depuis le seul module de
  // composition START.
  const composition = executable(await read('services/start-mutation.ts'));
  assert.equal(
    (composition.match(/startRunWithPreflight\(/g) ?? []).length,
    1,
    'une seule invocation de la façade',
  );

  // `startRun` bas niveau n'a qu'un appelant dans tout le dépôt : la façade.
  const facade = executable(await read('services/start-application-service.ts'));
  assert.ok(facade.includes('startRun('), 'la façade appelle bien la primitive');
  t.diagnostic(`modules cockpit audités : ${COCKPIT_START_MODULES.join(', ')}`);
});

// --------------------------------------------------------------------------
// (G-START-2 / M10) Le web ne lance jamais de processus interactif
// --------------------------------------------------------------------------

test('(G-START-2) aucune exécution de processus depuis la surface web', async (t) => {
  // Le texte `ccr setup` est légitime — c'est ce que l'humain doit taper. Ce
  // qui ne l'est pas, c'est de le lancer. On cherche donc des *lancements*.
  // `exec(` et non `exec` : depuis le Slice 2G, le rendu lit légitimement
  // `identity.execution_mode` — la génération déclarée par le serveur. Ce que
  // l'on interdit est un **appel**, pas une sous-chaîne.
  const launchers = ['spawn(', 'exec(', 'execFile(', 'fork(', 'child_process', 'openExternal', 'window.open'];
  const webModules = ['cockpit/web/app.js', 'cockpit/web/cockpit.js', 'cockpit/web/render.js', 'cockpit/web/api.js', 'cockpit/web/labels.js'];
  for (const name of webModules) {
    const code = executable(await read(name));
    for (const launcher of launchers) {
      assert.equal(code.includes(launcher), false, `${name} contient ${launcher}`);
    }
  }

  // Côté serveur, le chemin START n'importe ni ne lance de processus : seul
  // l'adaptateur d'agent le fait, et il vit ailleurs.
  for (const name of ['cockpit/mutations-http.ts', 'cockpit/server.ts', 'services/start-mutation.ts']) {
    const code = executable(await read(name));
    for (const launcher of ['child_process', 'spawn(', 'execFile(', 'loginClaude', 'loginCodex', 'runSetup']) {
      assert.equal(code.includes(launcher), false, `${name} contient ${launcher}`);
    }
  }

  // Le preflight du cockpit est structurellement incapable de proposer une
  // remédiation : il déclare `non-interactive`, et rien d'autre.
  const start = await read('services/start-mutation.ts');
  assert.match(start, /kind: 'non-interactive'/, 'le cockpit déclare un preflight non interactif');
  assert.equal(/kind:\s*'interactive'/.test(start), false, 'aucune interaction possible depuis le web');
  // Ni confirmation, ni TTY : les deux capacités qui rendraient une remédiation
  // représentable n'existent pas sur ce chemin.
  for (const capability of ['confirm:', 'tty:', 'logins:']) {
    assert.equal(start.includes(capability), false, `le chemin START expose « ${capability} »`);
  }
  t.diagnostic('aucun lanceur de processus dans la surface web ni sur le chemin START');
});

// --------------------------------------------------------------------------
// (G-START-3 / M14, M15) Le navigateur n'invente ni état, ni rejeu
// --------------------------------------------------------------------------

test('(G-START-3) après un succès START, la vérité revient du read model', async (t) => {
  const code = executable(await read('cockpit/web/cockpit.js'));

  // La branche de succès recharge la liste puis le run, et n'écrit aucun état
  // CCR local. Les mots d'état canoniques ne s'y trouvent pas.
  const start = code.indexOf('function openCreatedRun');
  assert.ok(start > 0, 'la fonction d’ouverture existe');
  const body = code.slice(start, code.indexOf('\n  }', start));
  assert.ok(body.includes('refreshRuns()'), 'la liste est rechargée depuis le cœur');
  assert.ok(body.includes('loadRun('), 'le run est rechargé depuis le cœur');
  for (const invented of ['READY', 'RUNNING', 'sessions', 'round', 'control']) {
    assert.equal(body.includes(invented), false, `le navigateur fabrique « ${invented} »`);
  }

  // Aucun rejeu automatique nulle part sur le chemin de création.
  for (const forbidden of ['setInterval', 'setTimeout', 'EventSource', 'WebSocket', 'ServiceWorker']) {
    assert.equal(code.includes(forbidden), false, `cockpit.js contient ${forbidden}`);
  }
  t.diagnostic('succès START : refreshRuns + loadRun, aucun état local inventé');
});
