/**
 * Preuves de crash réel d'un envoi humain natif (Slice 2B-R, §15).
 *
 * Les fenêtres des autres tests sont **restaurées** : elles réécrivent les
 * octets capturés à l'instant voulu. Celles-ci ne restaurent rien. Un vrai
 * processus CCR est tué, et ce qui reste sur disque est ce que le système
 * d'exploitation a laissé — verrou orphelin compris.
 *
 * ```text
 * P1  SIGKILL pendant adapter.resume       → IN_FLIGHT_UNCERTAIN
 * P2  SIGKILL après la réponse journalisée → RESPONSE_NEEDS_FINALIZATION
 * ```
 *
 * Niveau de preuve : `AUTOMATED_REAL_PROCESS`. Aucun fournisseur : le seul
 * exécutable lancé est `process.execPath`, et les adapters sont des fixtures.
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
  acknowledgeNativeSendUncertainty,
  finalizeNativeSendRecovery,
  inspectNativeSendRecovery,
} from '../../src/services/native-send-recovery-service.ts';
import type { NativeSendRecoveryDeps } from '../../src/services/native-send-recovery-service.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const HANG_FIXTURE = fileURLToPath(new URL('../fixtures/native-send-hang.ts', import.meta.url));

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

interface Crashed {
  readonly runId: string;
  readonly paths: ReturnType<typeof runPaths>;
  readonly deps: NativeSendRecoveryDeps;
}

async function crashDuringSend(mode: 'p1' | 'p2', dir: string, t: { diagnostic(m: string): void }): Promise<Crashed> {
  const runsDir = path.join(dir, 'runs');
  const marker = path.join(dir, `${mode}.marker`);

  const child = spawn(process.execPath, [HANG_FIXTURE, mode, runsDir, dir, marker], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const reached = await waitForFile(marker, 60_000);
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    // Un enfant déjà mort n'émettra plus rien : attendre `exit` sans le
    // vérifier suspendrait le test pour toujours.
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  if (!reached) {
    t.diagnostic(`stderr enfant : ${stderr.slice(0, 500)}`);
    assert.fail(`le processus enfant n'a jamais atteint la frontière ${mode}`);
  }

  const runIds = await listRunIds(runsDir);
  assert.equal(runIds.length, 1, 'un run a été alloué avant le crash');
  return {
    runId: runIds[0] ?? '',
    paths: runPaths(runsDir, runIds[0] ?? ''),
    deps: { runsDir, now: () => new Date() },
  };
}

test(
  'P1 · tué pendant l’appel de l’envoi : incertitude, jamais de rejeu',
  { timeout: 120_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-2br-p1-');
    try {
      const crashed = await crashDuringSend('p1', dir, t);

      // ---- Ce que le crash a réellement laissé.
      const state = await readPersistedState(crashed.paths);
      if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
      assert.equal(state.document.state, 'WAITING_AGENT');
      assert.equal(state.document.pending_operation?.kind, 'send');
      assert.equal(state.document.round, 0, 'le round n’a pas avancé');
      assert.equal(state.document.next_step_source_slot, 'author', 'le curseur n’a pas avancé');

      const persisted = await readPersistedManifest(crashed.paths);
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
      const events = await (await openNativeEventStore(crashed.paths, persisted.manifest)).readAll();
      const prompt = events.find((event) => event.type === 'human_message');
      assert.ok(prompt !== undefined, 'le message humain est durable');
      assert.equal(
        events.filter(
          (event) =>
            event.type === 'assistant_response' && (event.based_on ?? []).includes(prompt.event_id),
        ).length,
        0,
        'aucune réponse à cet envoi',
      );

      // ---- Le processus tué a laissé son verrou derrière lui.
      assert.ok(await readRunLock(crashed.paths), 'verrou orphelin sur disque');

      // ---- Classification et refus, sans le moindre effet.
      const before = await readFile(crashed.paths.state, 'utf8');
      const view = await inspectNativeSendRecovery(crashed.deps, crashed.runId);
      assert.equal(view.status, 'IN_FLIGHT_UNCERTAIN');
      assert.equal(view.promptEventId, prompt.event_id);
      assert.equal(view.requiresHumanAcknowledgement, true);
      assert.equal(view.canFinalizeWithoutProvider, false);
      assert.equal(await readFile(crashed.paths.state, 'utf8'), before, 'inspection sans effet');

      await assert.rejects(
        finalizeNativeSendRecovery(crashed.deps, crashed.runId),
        (error: unknown) => isCcrError(error) && error.code === 'RECOVERY_REQUIRED',
        'finalisation directe refusée',
      );
      assert.equal(await readFile(crashed.paths.state, 'utf8'), before, 'le refus n’a rien écrit');
      // Le verrou périmé, lui, est explicitement levé — jamais contourné.
      assert.equal(await readRunLock(crashed.paths), undefined, 'verrou périmé levé');

      // ---- Acquittement : aucun fournisseur ne peut être appelé ici.
      const outcome = await acknowledgeNativeSendUncertainty(
        crashed.deps,
        crashed.runId,
        'Processus tué pendant l’appel.',
      );
      assert.equal(outcome.view.status, 'NONE');
      assert.equal(outcome.state.state, 'PAUSED');
      assert.equal(outcome.state.control, 'HUMAN');
      assert.equal(outcome.state.pending_operation, null);
      assert.equal(outcome.state.round, 0);
      assert.equal(outcome.state.next_step_source_slot, 'author');

      const after = await (await openNativeEventStore(crashed.paths, persisted.manifest)).readAll();
      assert.equal(after.filter((event) => event.type === 'send_uncertainty_acknowledged').length, 1);
      assert.equal(
        after.filter(
          (event) =>
            event.type === 'assistant_response' && (event.based_on ?? []).includes(prompt.event_id),
        ).length,
        0,
        'aucune réponse inventée',
      );
      assert.equal((await readdir(crashed.paths.roundsDir)).length, 0, 'aucun artefact de round');
    } finally {
      await removeTempDir(dir);
    }
  },
);

test(
  'P2 · tué après la réponse journalisée : finalisation locale, sans fournisseur',
  { timeout: 120_000 },
  async (t) => {
    const dir = await makeTempDir('ccr-2br-p2-');
    try {
      const crashed = await crashDuringSend('p2', dir, t);

      // ---- La réponse est durable, le commit ne l'est pas.
      const persisted = await readPersistedManifest(crashed.paths);
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
      const events = await (await openNativeEventStore(crashed.paths, persisted.manifest)).readAll();
      const prompt = events.find((event) => event.type === 'human_message');
      assert.ok(prompt !== undefined);
      const response = events.find(
        (event) => event.type === 'assistant_response' && (event.based_on ?? []).includes(prompt.event_id),
      );
      assert.ok(response !== undefined, 'la réponse de l’envoi est durable');

      const state = await readPersistedState(crashed.paths);
      if (state.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('état natif attendu');
      assert.equal(state.document.pending_operation?.kind, 'send', 'le contexte a survécu à la réponse');
      assert.equal(state.document.pending_operation?.return_state, 'READY');
      assert.equal(state.document.round, 0);
      assert.equal(state.document.next_step_source_slot, 'author');

      const view = await inspectNativeSendRecovery(crashed.deps, crashed.runId);
      assert.equal(view.status, 'RESPONSE_NEEDS_FINALIZATION');
      assert.equal(view.canFinalizeWithoutProvider, true);
      assert.equal(view.responseEventId, response.event_id);

      // ---- Finalisation : aucun fournisseur, aucune seconde réponse.
      const journalBefore = await readFile(crashed.paths.events, 'utf8');
      const outcome = await finalizeNativeSendRecovery(crashed.deps, crashed.runId);
      // Première mutation depuis le crash : le verrou orphelin est constaté
      // périmé et levé explicitement, au lieu d'être contourné.
      assert.ok(outcome.staleLock !== undefined, 'verrou orphelin constaté puis levé');
      assert.equal(outcome.state.state, 'READY', 'état de retour restauré');
      assert.equal(outcome.state.control, 'HUMAN', 'l’automatisation ne reprend pas d’elle-même');
      assert.equal(outcome.state.pending_operation, null);
      assert.equal(outcome.state.active_expert_slot, null);
      assert.equal(outcome.state.round, 0, 'round inchangé');
      assert.equal(outcome.state.next_step_source_slot, 'author', 'curseur inchangé');
      assert.equal(outcome.view.status, 'NONE');
      assert.equal(await readFile(crashed.paths.events, 'utf8'), journalBefore, 'journal inchangé');
      assert.equal((await readdir(crashed.paths.roundsDir)).length, 0, 'aucun artefact de round');
    } finally {
      await removeTempDir(dir);
    }
  },
);
