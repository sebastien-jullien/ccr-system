/**
 * Processus CCR sacrifiable, pour prouver la fenêtre `H1` d'un handoff natif
 * (Slice 2C-R, §27).
 *
 * ```text
 * p1   le processus est tué PENDANT openInteractive
 * ```
 *
 * START complet, run suspendu sous contrôle humain, puis un handoff qui
 * n'aboutit jamais. Le parent lit le marqueur, tue le processus, et observe ce
 * qui est resté.
 *
 * Aucun fournisseur, aucun terminal : les deux adapters sont des fixtures, et
 * le seul exécutable lancé est `process.execPath` par le parent.
 *
 * Usage : node <ce fichier> <runsDir> <cwd> <markerFile>
 */

import { writeFile } from 'node:fs/promises';

import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import type { AgentKind } from '../../src/core/run.ts';
import type { InteractiveResult } from '../../src/process/process-runner.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import { handoffNativeExpert } from '../../src/services/native-handoff-service.ts';
import { expertSlotTarget } from '../../src/services/native-target-resolver.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import { persistNativeStateUpdate, readPersistedState } from '../../src/store/native-store.ts';

const [runsDir, cwd, markerFile] = process.argv.slice(2);
if (runsDir === undefined || cwd === undefined || markerFile === undefined) {
  throw new Error('usage: native-handoff-hang <runsDir> <cwd> <markerFile>');
}

/**
 * Suspend le processus jusqu'à ce qu'un signal l'emporte.
 *
 * Le handle actif n'est pas décoratif : sans lui, la boucle d'événements se
 * vide et Node s'arrête **de lui-même** avec le code 13, avant même le SIGKILL
 * du parent. La preuve porterait alors sur un arrêt spontané.
 */
const forever = async (): Promise<never> => {
  const keepAlive = setInterval(() => {}, 1_000);
  await new Promise(() => {});
  clearInterval(keepAlive);
  throw new Error('inatteignable');
};

function turn(kind: AgentKind, sessionId: string, prompt: string): AgentTurnResult {
  const at = new Date(0).toISOString();
  return {
    agent: kind,
    sessionId,
    content: `${kind}:${prompt.slice(0, 40)}`,
    exitCode: 0,
    startedAt: at,
    completedAt: at,
    stdoutRaw: '',
    stderrRaw: '',
  };
}

function adapter(kind: AgentKind, sessionId: string, hangOnInteractive: boolean): AgentAdapter {
  return {
    kind,
    async start(prompt: string): Promise<AgentTurnResult> {
      return turn(kind, sessionId, prompt);
    },
    async resume(_sessionId: string, prompt: string): Promise<AgentTurnResult> {
      return turn(kind, sessionId, prompt);
    },
    async openInteractive(): Promise<InteractiveResult> {
      if (hangOnInteractive) {
        // Tout ce qui devait être durable avant le lancement l'est désormais.
        await writeFile(markerFile as string, 'in-flight', 'utf8');
        return forever();
      }
      throw new Error('non utilisé');
    },
  };
}

const runtimeConfig: NativeRunRuntimeConfig = {
  schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  captured_at: new Date(0).toISOString(),
  claude: { required: true, probe_status: 'OBSERVED', cli_version: '0.0.0', auth_preflight: 'AUTHENTICATED' },
  codex: {
    required: true,
    probe_status: 'OBSERVED',
    cli_version: '0.0.0',
    auth_preflight: 'AUTHENTICATED',
    skip_git_repo_check: false,
    source_at_capture: 'default',
  },
};

const adapters: AgentAdapters = {
  // author = codex, challenger = claude : c'est claude qui reçoit le handoff.
  codex: adapter('codex', 'codex-durable', false),
  claude: adapter('claude', 'claude-durable', true),
};

const deps = { runsDir, now: (): Date => new Date(0), createAdapters: (): AgentAdapters => adapters };

const started = await startNativeRun(deps, {
  title: 'crash-handoff',
  cwd,
  prompt: 'mission initiale',
  runtimeConfig,
});

// Un handoff exige un run suspendu sous contrôle humain.
const paths = runPaths(runsDir, started.runId);
const current = await readPersistedState(paths);
if (current.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
await persistNativeStateUpdate(
  paths,
  current.document,
  { state: 'PAUSED', control: 'HUMAN' },
  new Date(0),
);

await handoffNativeExpert(deps, started.runId, expertSlotTarget('challenger'));
