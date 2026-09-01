/**
 * Processus CCR sacrifiable, pour prouver deux frontières de crash d'un envoi
 * humain natif (Slice 2B-R, §15).
 *
 * ```text
 * p1   le processus est tué PENDANT adapter.resume
 * p2   le processus est tué APRÈS la réponse journalisée, avant le commit
 * ```
 *
 * Dans les deux cas : START complet, puis un envoi vers le contradicteur qui
 * n'aboutit jamais. Le parent lit le marqueur, tue le processus, et observe ce
 * qui est resté.
 *
 * Aucun fournisseur : les deux adapters sont des fixtures locales, et le seul
 * exécutable lancé est `process.execPath` par le parent.
 *
 * Usage : node <ce fichier> <mode:p1|p2> <runsDir> <cwd> <markerFile>
 */

import { writeFile } from 'node:fs/promises';

import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import type { AgentKind } from '../../src/core/run.ts';
import type { InteractiveResult } from '../../src/process/process-runner.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import { DEFAULT_NATIVE_BINDINGS, startNativeRun } from '../../src/services/native-start-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import { expertSlotTarget } from '../../src/services/native-target-resolver.ts';
import type { AgentAdapters } from '../../src/services/run-service.ts';

const [mode, runsDir, cwd, markerFile] = process.argv.slice(2);
if (mode === undefined || runsDir === undefined || cwd === undefined || markerFile === undefined) {
  throw new Error('usage: native-send-hang <p1|p2> <runsDir> <cwd> <markerFile>');
}

/**
 * Suspend le processus jusqu'à ce qu'un signal l'emporte.
 *
 * Le handle actif n'est pas décoratif : sans lui, la boucle d'événements se
 * vide, et Node s'arrête **de lui-même** avec le code 13 (« unsettled top-level
 * await ») quelques millisecondes après le marqueur — avant même le SIGKILL du
 * parent. La preuve porterait alors sur un arrêt spontané, et non sur un arrêt
 * brutal, et le parent pourrait manquer l'événement `exit` déjà émis.
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

function adapter(kind: AgentKind, sessionId: string, hangOnResume: boolean): AgentAdapter {
  return {
    kind,
    async start(prompt: string): Promise<AgentTurnResult> {
      return turn(kind, sessionId, prompt);
    },
    async resume(_sessionId: string, prompt: string): Promise<AgentTurnResult> {
      if (hangOnResume) {
        // Tout ce qui devait être durable avant l'appel l'est désormais.
        await writeFile(markerFile as string, 'in-flight', 'utf8');
        return forever();
      }
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

const hangOnResume = mode === 'p1';
// Le RÔLE décide, jamais le nom du fournisseur : c'est le CHALLENGER qui reçoit
// l'envoi, donc son adaptateur qui suspend. Lire la liaison plutôt que la
// recopier évite qu'un changement de convention par défaut rende ce scénario
// silencieusement inopérant — l'envoi aboutirait, et le marqueur ne serait
// jamais écrit.
const challengerProvider = DEFAULT_NATIVE_BINDINGS.challenger;
const adapters: AgentAdapters = {
  claude: adapter('claude', 'claude-durable', hangOnResume && challengerProvider === 'claude'),
  codex: adapter('codex', 'codex-durable', hangOnResume && challengerProvider === 'codex'),
};

const deps = { runsDir, now: (): Date => new Date(0), createAdapters: (): AgentAdapters => adapters };

const started = await startNativeRun(deps, {
  title: 'crash-send',
  cwd,
  prompt: 'mission initiale',
  runtimeConfig,
});

await sendNativeMessage(deps, started.runId, expertSlotTarget('challenger'), 'question humaine', {
  afterResponseJournaled: hangOnResume
    ? undefined
    : async () => {
        // La réponse est durable, le contexte de reprise l'est encore.
        await writeFile(markerFile as string, 'responded', 'utf8');
        await forever();
      },
});
