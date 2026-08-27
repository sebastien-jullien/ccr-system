#!/usr/bin/env node
/**
 * Détient un `.ccr.lock` de run, réellement, jusqu'à ce qu'on le tue.
 *
 * Sert aux preuves de levée : un verrou vivant doit être refusé, et un verrou
 * dont le propriétaire est mort doit devenir levable. Les deux exigent un
 * **vrai** processus — un fichier écrit à la main ne mourrait jamais.
 *
 * Usage : node hold-run-lock.mjs <runsDir> <runId> [command]
 * Écrit `HELD <lock_id>` sur stdout une fois le verrou acquis.
 */

import { acquireRunLock } from '../../src/lock/run-lock.ts';
import { runPaths } from '../../src/store/layout.ts';

const [runsDir, runId, command = 'step'] = process.argv.slice(2);
if (runsDir === undefined || runId === undefined) {
  process.stderr.write('usage: hold-run-lock <runsDir> <runId> [command]\n');
  process.exit(2);
}

const handle = await acquireRunLock(runPaths(runsDir, runId), command);
process.stdout.write(`HELD ${handle.info.lock_id}\n`);

// Aucun gestionnaire de signal : un `SIGKILL` laisse le fichier derrière lui,
// exactement comme un crash.
//
// Un `Promise` jamais résolue ne suffit pas : Node sort dès qu'aucun handle
// n'est en attente, et le processus mourrait aussitôt — le verrou serait alors
// périmé au lieu d'être vivant, et la preuve dirait le contraire de ce qu'elle
// prétend. Un intervalle garde la boucle d'événements ouverte.
setInterval(() => undefined, 3_600_000);
