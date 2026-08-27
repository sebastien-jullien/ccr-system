/**
 * Processus CCR sacrifiable, pour prouver la frontière de crash de
 * l'initialisation native (Slice 1D, §18).
 *
 * Il démarre un run natif dont l'AUTHOR répond normalement et dont le
 * CHALLENGER **n'aboutit jamais** : son adapter écrit un marqueur puis reste
 * bloqué. Le parent lit le marqueur, tue le processus, et observe ce qui est
 * réellement resté sur disque.
 *
 * Aucun fournisseur : les deux adapters sont des fixtures locales, et le seul
 * exécutable lancé est `process.execPath` par le parent.
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
import type { AgentAdapters } from '../../src/services/run-service.ts';

const [runsDir, cwd, markerFile] = process.argv.slice(2);
if (runsDir === undefined || cwd === undefined || markerFile === undefined) {
  throw new Error('usage: native-start-hang <runsDir> <cwd> <markerFile>');
}

function turn(kind: AgentKind, sessionId: string, prompt: string): AgentTurnResult {
  const at = new Date(0).toISOString();
  return {
    agent: kind,
    sessionId,
    content: `${kind}:${prompt}`,
    exitCode: 0,
    startedAt: at,
    completedAt: at,
    stdoutRaw: '',
    stderrRaw: '',
  };
}

function adapter(kind: AgentKind, sessionId: string, hang: boolean): AgentAdapter {
  return {
    kind,
    async start(prompt: string): Promise<AgentTurnResult> {
      if (!hang) return turn(kind, sessionId, prompt);
      // Tout ce qui devait être durable avant l'appel l'est désormais.
      await writeFile(markerFile as string, 'in-flight', 'utf8');
      // Ne rend jamais la main : le parent tuera ce processus.
      //
      // Le handle actif n'est pas une temporisation : il est ce qui rend le
      // scénario fidèle à ce qu'il prétend prouver. Sans lui, la boucle
      // d'événements de ce processus se vide, Node détecte un « unsettled
      // top-level await » et TERMINE LE PROCESSUS DE LUI-MÊME avec le code 13 —
      // parfois avant que le parent n'ait seulement lu le marqueur. Le crash
      // observé n'était alors plus celui qu'on voulait provoquer, et le parent
      // attendait un `exit` déjà émis. Il ne se déclenche jamais : le parent
      // tue ce processus en quelques centaines de millisecondes.
      await new Promise(() => {
        setInterval(() => {}, 1_000_000);
      });
      throw new Error('inatteignable');
    },
    async resume(_sessionId: string, prompt: string): Promise<AgentTurnResult> {
      return turn(kind, sessionId, prompt);
    },
    async openInteractive(): Promise<InteractiveResult> {
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
  // author = codex répond ; challenger = claude reste bloqué.
  codex: adapter('codex', 'codex-durable', false),
  claude: adapter('claude', 'claude-jamais', true),
};

await startNativeRun(
  { runsDir, now: () => new Date(0), createAdapters: (): AgentAdapters => adapters },
  { title: 'crash', cwd, prompt: 'mission initiale', runtimeConfig },
);
