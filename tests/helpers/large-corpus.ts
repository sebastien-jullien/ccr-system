/**
 * Corpus volumineux réel, partagé par les preuves fonctionnelles et par les
 * mesures de performance.
 *
 * Les deux surfaces construisent exactement le même corpus : ce que le
 * benchmark chronomètre est ce que la preuve fonctionnelle vérifie.
 */

import { mkdir, writeFile } from 'node:fs/promises';

import type { CockpitReadModelDeps } from '../../src/services/cockpit-read-model.ts';
import { DEFAULT_MAX_TRANSFER_BYTES } from '../../src/services/transfer.ts';
import { buildInitialState, writeManifest, writeState } from '../../src/store/state-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { MANIFEST_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { RunManifest } from '../../src/core/run.ts';
import { TEST_RUNTIME_CONFIG } from './runtime-config.ts';

export const CORPUS_TIME = '2026-08-08T00:00:00.000Z';
export const SETTINGS = { maxTransferBytes: DEFAULT_MAX_TRANSFER_BYTES };

export function manifestOf(runId: string): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    title: `Run ${runId}`,
    created_at: CORPUS_TIME,
    workspace: { cwd: 'E:/prog/exemple' },
    agents: {
      claude: { session_id: 'claude-1', role: 'challenger' },
      codex: { session_id: 'codex-1', role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
  };
}

/** Écrit un journal directement, sans passer par le store : rapide et réaliste. */
export async function writeJournal(file: string, runId: string, count: number, payloadBytes: number): Promise<void> {
  const payload = 'x'.repeat(payloadBytes);
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(
      JSON.stringify({
        event_id: `evt_${String(i).padStart(6, '0')}`,
        run_id: runId,
        round: 0,
        actor: i === 1 ? 'system' : 'codex',
        type: i === 1 ? 'run_created' : 'assistant_response',
        content: i === 1 ? 'T' : payload,
        timestamp: new Date(Date.parse(CORPUS_TIME) + i * 1000).toISOString(),
      }),
    );
  }
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

export async function makeRun(runsDir: string, runId: string, events: number, payloadBytes: number): Promise<void> {
  const paths = runPaths(runsDir, runId);
  await mkdir(paths.root, { recursive: true });
  await writeManifest(paths, manifestOf(runId));
  await writeState(paths, buildInitialState(runId, 'READY', new Date(CORPUS_TIME)));
  if (events > 0) await writeJournal(paths.events, runId, events, payloadBytes);
}

export function depsOf(runsDir: string): CockpitReadModelDeps {
  return { runsDir, settings: SETTINGS };
}
