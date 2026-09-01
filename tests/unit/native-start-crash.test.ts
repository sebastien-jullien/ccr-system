/**
 * Preuve de crash réel de l'initialisation native (Slice 1D, §18).
 *
 * Les fenêtres de crash des autres tests sont **fabriquées** : elles écrivent
 * le préfixe durable qu'un arrêt brutal aurait laissé. Celle-ci ne fabrique
 * rien. Un vrai processus CCR est tué au milieu d'un appel d'expert, et ce qui
 * reste sur disque est ce que le système d'exploitation a laissé.
 *
 * ```text
 * AUTHOR      durablement initialisé
 * CHALLENGER  entre dans adapter.start, écrit un marqueur, ne rend jamais la main
 * SIGKILL
 * ```
 *
 * Niveau de preuve : `AUTOMATED_REAL_PROCESS`. Aucun fournisseur : le seul
 * exécutable lancé est `process.execPath`, et les deux adapters sont des
 * fixtures locales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCcrError } from '../../src/core/errors.ts';
import { DEFAULT_NATIVE_BINDINGS } from '../../src/services/native-start-service.ts';
import { listRunIds } from '../../src/store/layout.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import {
  continueNativeInitialization,
  inspectNativeInitialization,
} from '../../src/services/native-recovery-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const HANG_FIXTURE = fileURLToPath(new URL('../fixtures/native-start-hang.ts', import.meta.url));

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return false;
}

test(
  'un CCR tué pendant l’appel du challenger laisse une incertitude, jamais un rejeu',
  { timeout: 120_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-1d-crash-');
    try {
      const runsDir = path.join(dir, 'runs');
      const marker = path.join(dir, 'in-flight.marker');

      const child = spawn(process.execPath, [HANG_FIXTURE, runsDir, dir, marker], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const reached = await waitForFile(marker, 60_000);
      if (!reached) {
        child.kill('SIGKILL');
        t.diagnostic(`stderr enfant : ${stderr.slice(0, 400)}`);
        assert.fail("le processus enfant n'a jamais atteint l'appel du challenger");
      }

      // Arrêt brutal : aucun `finally`, aucun handler, aucune écriture de sortie.
      child.kill('SIGKILL');
      // `'exit'` a pu être émis AVANT cette ligne : y attacher un écouteur
      // reviendrait alors à attendre un événement qui n'arrivera plus, et le
      // test ne se terminerait jamais. On lit d'abord l'état terminal, qui est
      // déjà porté par le child.
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => child.once('exit', resolve));
      }
      // Et c'est bien le parent qui a tué : un processus sorti de lui-même
      // n'aurait pas produit le même arrêt, et la preuve porterait sur autre
      // chose que ce qu'elle annonce.
      assert.equal(child.signalCode, 'SIGKILL', 'le processus doit être tué par le parent');

      const runIds = await listRunIds(runsDir);
      assert.equal(runIds.length, 1, 'un run a bien été alloué avant le crash');
      const runId = runIds[0] ?? '';
      const paths = runPaths(runsDir, runId);

      // ---- Ce que le crash a réellement laissé.
      const persisted = await readPersistedManifest(paths);
      assert.equal(persisted.execution_mode, 'NATIVE_V21_EXECUTION');
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return;
      // La session durable est celle de l'AUTHOR, quel que soit le fournisseur
      // que la liaison par défaut lui attribue.
      assert.equal(
        persisted.manifest.experts.author.session_id,
        `${DEFAULT_NATIVE_BINDINGS.author}-durable`,
      );
      assert.equal(persisted.manifest.experts.challenger.session_id, null);

      const state = await readPersistedState(paths);
      if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
      assert.equal(state.document.state, 'WAITING_AGENT');
      assert.equal(state.document.pending_operation?.kind, 'initialization');
      assert.equal(
        (state.document.pending_operation as { expert_slot?: string } | null)?.expert_slot,
        'challenger',
      );
      assert.equal(state.document.next_step_source_slot, null);

      const events = await (await openNativeEventStore(paths, persisted.manifest)).readAll();
      const challengerResponses = events.filter(
        (event) =>
          event.type === 'assistant_response' &&
          (event as { expert_slot_id?: string }).expert_slot_id === 'challenger',
      );
      assert.equal(challengerResponses.length, 0, 'aucune réponse du challenger');

      // ---- Classification et refus.
      const calls: string[] = [];
      const adapters: AgentAdapters = {
        claude: createFakeAdapter({ kind: 'claude', onCall: () => void calls.push('claude') }),
        codex: createFakeAdapter({ kind: 'codex', onCall: () => void calls.push('codex') }),
      };
      const deps: RunServiceDeps = {
        runsDir,
        now: () => new Date(),
        createAdapters: (): AgentAdapters => adapters,
      };

      const view = await inspectNativeInitialization(deps, runId);
      assert.equal(view.status, 'IN_FLIGHT_UNCERTAIN');
      assert.equal(view.uncertainSlot, 'challenger');
      assert.equal(calls.length, 0, 'inspection : aucun appel fournisseur');

      const before = await readFile(paths.state, 'utf8');
      await assert.rejects(
        continueNativeInitialization(deps, runId),
        (error: unknown) => isCcrError(error) && error.code === 'RECOVERY_REQUIRED',
        'continuation directe refusée',
      );
      assert.equal(calls.length, 0, 'refus : aucun appel fournisseur');
      assert.equal(await readFile(paths.state, 'utf8'), before, "le refus n'a rien écrit");
    } finally {
      await removeTempDir(dir);
    }
  },
);
