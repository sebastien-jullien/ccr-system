/**
 * Preuve de crash réel d'un handoff natif (Slice 2C-R, §27).
 *
 * Les fenêtres des autres tests sont **restaurées** : elles réécrivent les
 * octets capturés à l'instant voulu. Celle-ci ne restaure rien. Un vrai
 * processus CCR est tué pendant l'attachement, et ce qui reste sur disque est
 * ce que le système d'exploitation a laissé — verrou orphelin compris.
 *
 * ```text
 * P1  SIGKILL pendant openInteractive  → IN_FLIGHT_UNCERTAIN
 * ```
 *
 * Niveau de preuve : `AUTOMATED_REAL_PROCESS`. Aucun fournisseur, aucun
 * terminal : le seul exécutable lancé est `process.execPath`, et les adapters
 * sont des fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCcrError } from '../../src/core/errors.ts';
import { readRunLock } from '../../src/lock/run-lock.ts';
import { listRunIds, runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../../src/store/native-store.ts';
import {
  acknowledgeNativeHandoffUncertainty,
  finalizeNativeHandoffRecovery,
  inspectNativeHandoffRecovery,
} from '../../src/services/native-handoff-recovery-service.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const HANG_FIXTURE = fileURLToPath(new URL('../fixtures/native-handoff-hang.ts', import.meta.url));

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
  'P1 · tué pendant l’attachement : étendue inconnue, jamais de réouverture',
  { timeout: 120_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-2cr-p1-');
    try {
      const runsDir = path.join(dir, 'runs');
      const marker = path.join(dir, 'p1.marker');

      const child = spawn(process.execPath, [HANG_FIXTURE, runsDir, dir, marker], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const reached = await waitForFile(marker, 60_000);
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      if (!reached) {
        t.diagnostic(`stderr enfant : ${stderr.slice(0, 500)}`);
        assert.fail("le processus enfant n'a jamais atteint la frontière p1");
      }

      const runIds = await listRunIds(runsDir);
      assert.equal(runIds.length, 1, 'un run a été alloué avant le crash');
      const runId = runIds[0] ?? '';
      const paths = runPaths(runsDir, runId);
      const deps = { runsDir, now: () => new Date() };

      // ---- Ce que le crash a réellement laissé.
      const state = await readPersistedState(paths);
      if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
      assert.equal(state.document.state, 'PAUSED', 'un handoff ne transitionne pas');
      assert.equal(state.document.control, 'HUMAN');
      assert.equal(state.document.pending_operation?.kind, 'handoff');
      assert.equal(state.document.active_expert_slot, 'challenger');
      assert.equal(state.document.round, 0);
      assert.equal(state.document.next_step_source_slot, 'author');

      const persisted = await readPersistedManifest(paths);
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
      const events = await (await openNativeEventStore(paths, persisted.manifest)).readAll();
      const started = events.find((event) => event.type === 'human_handoff_started');
      assert.ok(started !== undefined, 'l’ouverture est durable');
      assert.equal(events.filter((event) => event.type === 'human_handoff_finished').length, 0);
      assert.equal(events.filter((event) => event.type === 'process_failed').length, 0);
      assert.ok(await readRunLock(paths), 'verrou orphelin sur disque');

      // ---- Classification et refus, sans le moindre effet.
      const before = await readFile(paths.state, 'utf8');
      const view = await inspectNativeHandoffRecovery(deps, runId);
      assert.equal(view.status, 'IN_FLIGHT_UNCERTAIN');
      assert.equal(view.startedEventId, started.event_id);
      assert.equal(view.requiresHumanAcknowledgement, true);
      assert.equal(view.canFinalizeWithoutInteractive, false);
      assert.equal(await readFile(paths.state, 'utf8'), before, 'inspection sans effet');

      await assert.rejects(
        finalizeNativeHandoffRecovery(deps, runId),
        (error: unknown) => isCcrError(error) && error.code === 'RECOVERY_REQUIRED',
        'finalisation directe refusée',
      );
      assert.equal(await readFile(paths.state, 'utf8'), before, 'le refus n’a rien écrit');
      // Le verrou périmé, lui, est explicitement levé — jamais contourné.
      assert.equal(await readRunLock(paths), undefined, 'verrou périmé levé');

      // ---- Acquittement : aucune réouverture n'est structurellement possible.
      const outcome = await acknowledgeNativeHandoffUncertainty(
        deps,
        runId,
        'Processus tué pendant l’attachement.',
      );
      assert.equal(outcome.view.status, 'NONE');
      assert.equal(outcome.state.state, 'PAUSED');
      assert.equal(outcome.state.control, 'HUMAN');
      assert.equal(outcome.state.pending_operation, null);
      assert.equal(outcome.state.active_expert_slot, null);
      assert.equal(outcome.state.round, 0);
      assert.equal(outcome.state.next_step_source_slot, 'author');

      const after = await (await openNativeEventStore(paths, persisted.manifest)).readAll();
      assert.equal(after.filter((event) => event.type === 'handoff_uncertainty_acknowledged').length, 1);
      assert.equal(after.filter((event) => event.type === 'human_handoff_finished').length, 0);
      assert.equal((await readdir(paths.roundsDir)).length, 0, 'aucun artefact de round');
    } finally {
      await removeTempDir(dir);
    }
  },
);
