/**
 * Cockpit qui meurt à un point choisi de la section critique.
 *
 * Lancé comme processus réel par les preuves de crash. La terminaison est
 * **inconditionnelle** (`SIGKILL` sur soi-même) : aucun gestionnaire, aucun
 * `finally`, aucune écriture de reçu terminal — exactement ce qu'un arrêt
 * brutal produit.
 *
 * ```text
 * before-lock         après le claim durable, avant tout effet          (courte)
 * after-effect        après la mutation canonique, avant le reçu        (courte)
 * long-before         opération longue admise, avant l'appel agent
 * long-after          opération longue, effet fait, avant le reçu terminal
 * long-hang           opération longue admise, agent qui ne répond jamais
 *
 * start-before-alloc  START admise, avant la moindre allocation
 * start-after-alloc   run alloué, avant que le reçu ne le nomme
 * start-after-assoc   reçu associé, avant le premier fournisseur
 * start-hang          fournisseur d'initialisation qui ne répond jamais
 * start-after-final   effet canonique complet, avant le reçu terminal
 *
 * clear-after-unlink   verrou périmé supprimé, avant le reçu terminal
 * ```
 *
 * Usage : `node tests/helpers/crash-cockpit.ts <runsDir> <port> <point>`
 */

import { startCockpit } from '../../src/cockpit/cockpit-service.ts';
import { createFakeAdapter } from './fake-adapter.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import type { AgentKind } from '../../src/core/run.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';

const [runsDir, port, point] = process.argv.slice(2);

if (runsDir === undefined || port === undefined || point === undefined) {
  process.stderr.write('usage: crash-cockpit <runsDir> <port> <point>\n');
  process.exit(2);
}

const suicide = (): never => {
  // Ni `exit`, ni exception : une terminaison que rien ne peut intercepter.
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
};

const never = (): Promise<void> => new Promise(() => undefined);

const isLong = point.startsWith('long-');
const isStart = point.startsWith('start-');
const hangs = point === 'long-hang' || point === 'start-hang';

/** Agent factice : aucun fournisseur réel n'est sollicité par ces preuves. */
const adapters: AgentAdapters = {
  claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1', ...(hangs ? { onCall: never } : {}) }),
  codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1', ...(hangs ? { onCall: never } : {}) }),
};

/**
 * Preflight contrôlé.
 *
 * Un crash proof doit éprouver l'ordre de CCR, pas la présence d'une CLI sur la
 * machine d'exécution. Les probes sont donc des doublures — et le preflight,
 * lui, reste le vrai.
 */
const probe = (agent: AgentKind): Promise<AgentRuntimeProbe> =>
  Promise.resolve({ agent, installed: true, version: '1.0.0', authStatus: 'AUTHENTICATED', launcherSource: 'explicit' });

const instance = await startCockpit({
  runsDir,
  port: Number.parseInt(port, 10),
  ...(isLong || isStart ? { depsOverrides: { createAdapters: () => adapters } } : {}),
  ...(isStart
    ? {
        preflightSeams: {
          env: {},
          probes: { claude: () => probe('claude'), codex: () => probe('codex') },
        },
      }
    : {}),
  ...(point === 'before-lock' ? { seams: { beforeLock: suicide } } : {}),
  ...(point === 'after-effect' ? { seams: { afterEffect: suicide } } : {}),
  ...(point === 'long-before' ? { longHooks: { beforeProvider: suicide } } : {}),
  ...(point === 'long-after' ? { longHooks: { afterEffect: suicide } } : {}),
  ...(point === 'start-before-alloc' ? { startHooks: { beforeAllocation: suicide } } : {}),
  ...(point === 'start-after-alloc' ? { startHooks: { afterAllocation: suicide } } : {}),
  ...(point === 'start-after-assoc' ? { startHooks: { onRunAllocated: suicide } } : {}),
  ...(point === 'start-after-final' ? { startHooks: { afterFinalization: suicide } } : {}),
  ...(point === 'clear-after-unlink' ? { recoveryHooks: { afterCleared: suicide } } : {}),
});

process.stdout.write(`READY ${String(instance.server.port)}\n`);
