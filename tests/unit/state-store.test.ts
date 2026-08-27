/**
 * Tests unitaires du state store (spécification V0.2, §9, §11, §30, §32, §42).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import {
  applyStateUpdate,
  assertRecoveryResolved,
  buildInitialState,
  buildRecoveryUpdate,
  createRunDirectory,
  loadRun,
  persistStateUpdate,
  readManifest,
  readState,
  setAgentSessionId,
  writeManifest,
  writeState,
} from '../../src/store/state-store.ts';
import { listRunIds, runPaths } from '../../src/store/layout.ts';
import { MANIFEST_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { RunManifest } from '../../src/core/run.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const NOW = new Date(2026, 3, 1, 17, 50, 0);

function manifestFor(runId: string, cwd: string): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    title: 'Assainissement phase 2',
    created_at: NOW.toISOString(),
    workspace: { cwd },
    agents: {
      claude: { session_id: null, role: 'challenger' },
      codex: { session_id: null, role: 'author' },
    },
  };
}

async function newRun(runsDir: string, cwd = 'E:/prog/exemple') {
  const paths = await createRunDirectory(runsDir, NOW);
  await writeManifest(paths, manifestFor(paths.runId, cwd));
  await writeState(paths, buildInitialState(paths.runId, 'READY', NOW));
  return paths;
}

// --------------------------------------------------------------------------
// Identité et création
// --------------------------------------------------------------------------

test('createRunDirectory attribue des ordinaux successifs le même jour', async () => {
  const runsDir = await makeTempDir('ccr-runs-');
  try {
    const first = await createRunDirectory(runsDir, NOW);
    const second = await createRunDirectory(runsDir, NOW);
    const third = await createRunDirectory(runsDir, NOW);

    assert.equal(first.runId, 'CCR-20260401-001');
    assert.equal(second.runId, 'CCR-20260401-002');
    assert.equal(third.runId, 'CCR-20260401-003');
    assert.deepEqual(await listRunIds(runsDir), [
      'CCR-20260401-001',
      'CCR-20260401-002',
      'CCR-20260401-003',
    ]);
  } finally {
    await removeTempDir(runsDir);
  }
});

test("createRunDirectory ne réutilise pas un ordinal déjà pris, même si un run a été supprimé", async () => {
  const runsDir = await makeTempDir('ccr-runs-gap-');
  try {
    await createRunDirectory(runsDir, NOW);
    const second = await createRunDirectory(runsDir, NOW);
    // Un répertoire manquant ne doit pas faire régresser le compteur au-delà
    // de l'ordinal maximal observé.
    assert.equal(second.runId, 'CCR-20260401-002');

    const third = await createRunDirectory(runsDir, NOW);
    assert.equal(third.runId, 'CCR-20260401-003');
  } finally {
    await removeTempDir(runsDir);
  }
});

test('la création prépare rounds/ et artifacts/', async () => {
  const runsDir = await makeTempDir('ccr-runs-layout-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const { pathExists } = await import('../../src/store/atomic-file.ts');
    assert.equal(await pathExists(paths.roundsDir), true);
    assert.equal(await pathExists(paths.artifactsDir), true);
  } finally {
    await removeTempDir(runsDir);
  }
});

// --------------------------------------------------------------------------
// Manifest
// --------------------------------------------------------------------------

test('le manifest se relit à l\'identique et ne porte ni state ni round', async () => {
  const runsDir = await makeTempDir('ccr-manifest-');
  try {
    const paths = await newRun(runsDir);
    const manifest = await readManifest(paths);

    assert.equal(manifest.run_id, paths.runId);
    assert.equal(manifest.workspace.cwd, 'E:/prog/exemple');
    assert.equal(manifest.agents.claude.role, 'challenger');
    assert.equal(manifest.agents.codex.session_id, null);

    const raw = JSON.parse(await readFile(paths.manifest, 'utf8')) as Record<string, unknown>;
    assert.equal('state' in raw, false, 'amendement A-4 : pas d\'état dans le manifest');
    assert.equal('round' in raw, false, 'amendement A-4 : pas de round dans le manifest');
    assert.equal('repository' in raw, false, 'amendement A-1 : pas de contexte Git');
  } finally {
    await removeTempDir(runsDir);
  }
});

test('setAgentSessionId enregistre un identifiant natif sans toucher au reste', async () => {
  const runsDir = await makeTempDir('ccr-session-id-');
  try {
    const paths = await newRun(runsDir);
    const manifest = await readManifest(paths);

    const updated = await setAgentSessionId(paths, manifest, 'codex', '019fdd0a-38d8-7793-8232-e3447e6848db');

    assert.equal(updated.agents.codex.session_id, '019fdd0a-38d8-7793-8232-e3447e6848db');
    assert.equal(updated.agents.claude.session_id, null, 'la session partenaire est préservée');
    assert.equal(updated.agents.codex.role, 'author');
    assert.deepEqual(await readManifest(paths), updated);
  } finally {
    await removeTempDir(runsDir);
  }
});

test('un manifest de schéma inconnu est refusé explicitement', async () => {
  const runsDir = await makeTempDir('ccr-schema-');
  try {
    const paths = await newRun(runsDir);
    await writeFile(paths.manifest, JSON.stringify({ schema_version: 99 }), 'utf8');

    await assert.rejects(
      readManifest(paths),
      (error: unknown) => isCcrError(error) && error.code === 'SCHEMA_VERSION_UNSUPPORTED',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});

test('un run inexistant produit RUN_NOT_FOUND', async () => {
  const runsDir = await makeTempDir('ccr-absent-');
  try {
    await assert.rejects(
      readManifest(runPaths(runsDir, 'CCR-20260807-099')),
      (error: unknown) => isCcrError(error) && error.code === 'RUN_NOT_FOUND',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});

// --------------------------------------------------------------------------
// État courant
// --------------------------------------------------------------------------

test('l\'état initial est READY sous contrôle AUTOMATION', async () => {
  const runsDir = await makeTempDir('ccr-state-init-');
  try {
    const paths = await newRun(runsDir);
    const state = await readState(paths);

    assert.equal(state.state, 'READY');
    assert.equal(state.control, 'AUTOMATION');
    assert.equal(state.round, 0);
    assert.equal(state.active_agent, null);
    assert.equal(state.last_event_id, null);
    assert.equal(state.uncertainty, null);
  } finally {
    await removeTempDir(runsDir);
  }
});

test('persistStateUpdate valide la transition avant d\'écrire', async () => {
  const runsDir = await makeTempDir('ccr-state-update-');
  try {
    const paths = await newRun(runsDir);
    let state = await readState(paths);

    state = await persistStateUpdate(paths, state, { state: 'RUNNING' });
    assert.equal(state.state, 'RUNNING');

    state = await persistStateUpdate(paths, state, { state: 'WAITING_AGENT', activeAgent: 'claude' });
    assert.equal((await readState(paths)).state, 'WAITING_AGENT');
    assert.equal((await readState(paths)).active_agent, 'claude');

    const before = await readState(paths);
    await assert.rejects(
      persistStateUpdate(paths, before, { state: 'CLOSED' }),
      (error: unknown) => isCcrError(error) && error.code === 'ILLEGAL_STATE_TRANSITION',
    );
    assert.deepEqual(await readState(paths), before, 'aucune écriture après refus');
  } finally {
    await removeTempDir(runsDir);
  }
});

test('le contrôle humain est indépendant de l\'état', () => {
  const state = buildInitialState('CCR-20260401-001', 'READY', NOW);

  const paused = applyStateUpdate(state, { state: 'PAUSED', control: 'HUMAN' }, NOW);
  assert.equal(paused.control, 'HUMAN');

  // On peut être PAUSED tout en ayant rendu le contrôle à l'automatisation :
  // la spécification traite les deux dimensions séparément (§19).
  const resumed = applyStateUpdate(paused, { control: 'AUTOMATION' }, NOW);
  assert.equal(resumed.state, 'PAUSED');
  assert.equal(resumed.control, 'AUTOMATION');
});

test('un state.json portant un état hors machine V1 est refusé', async () => {
  const runsDir = await makeTempDir('ccr-state-invalid-');
  try {
    const paths = await newRun(runsDir);
    const state = await readState(paths);
    await writeFile(paths.state, JSON.stringify({ ...state, state: 'CONVERGED' }), 'utf8');

    await assert.rejects(
      readState(paths),
      (error: unknown) => isCcrError(error) && error.code === 'STATE_INVALID',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});

// --------------------------------------------------------------------------
// Rechargement et invariant de reprise (§32)
// --------------------------------------------------------------------------

test('un run se recharge intégralement depuis ses seuls fichiers persistés', async () => {
  const runsDir = await makeTempDir('ccr-reload-');
  try {
    const paths = await newRun(runsDir);
    const manifest = await readManifest(paths);
    await setAgentSessionId(paths, manifest, 'claude', 'claude-session-1');
    const withCodex = await readManifest(paths);
    await setAgentSessionId(paths, withCodex, 'codex', 'codex-thread-1');

    let state = await readState(paths);
    state = await persistStateUpdate(paths, state, { state: 'RUNNING', round: 2 });
    await persistStateUpdate(paths, state, { state: 'READY' });

    // Rechargement « depuis un autre processus » : rien n'est en mémoire.
    const loaded = await loadRun(runsDir, paths.runId);

    assert.equal(loaded.manifest.agents.claude.session_id, 'claude-session-1');
    assert.equal(loaded.manifest.agents.codex.session_id, 'codex-thread-1');
    assert.equal(loaded.state.state, 'READY');
    assert.equal(loaded.state.round, 2);
    assert.equal(loaded.requiresRecovery, false);
    assert.doesNotThrow(() => assertRecoveryResolved(loaded));
  } finally {
    await removeTempDir(runsDir);
  }
});

test('un WAITING_AGENT persisté ne redevient jamais RUNNING au rechargement', async () => {
  const runsDir = await makeTempDir('ccr-recovery-');
  try {
    const paths = await newRun(runsDir);
    let state = await readState(paths);
    state = await persistStateUpdate(paths, state, { state: 'RUNNING' });
    await persistStateUpdate(paths, state, {
      state: 'WAITING_AGENT',
      activeAgent: 'codex',
      lastEventId: 'evt_000012',
    });

    const before = await readFile(paths.state, 'utf8');
    const loaded = await loadRun(runsDir, paths.runId);

    assert.equal(loaded.state.state, 'WAITING_AGENT', "l'état persisté n'est pas requalifié");
    assert.notEqual(loaded.state.state, 'RUNNING');
    assert.equal(loaded.requiresRecovery, true);
    assert.equal(await readFile(paths.state, 'utf8'), before, 'le chargement ne modifie aucun fichier');

    assert.throws(
      () => assertRecoveryResolved(loaded),
      (error: unknown) => isCcrError(error) && error.code === 'RECOVERY_REQUIRED',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});

test('la reprise matérialise l\'ambiguïté dans RECOVERY_REQUIRED', async () => {
  const runsDir = await makeTempDir('ccr-recovery-mark-');
  try {
    const paths = await newRun(runsDir);
    let state = await readState(paths);
    state = await persistStateUpdate(paths, state, { state: 'RUNNING' });
    state = await persistStateUpdate(paths, state, {
      state: 'WAITING_AGENT',
      activeAgent: 'claude',
      lastEventId: 'evt_000007',
    });

    const loaded = await loadRun(runsDir, paths.runId);
    const recovered = await persistStateUpdate(
      paths,
      loaded.state,
      buildRecoveryUpdate(loaded.state, undefined, NOW),
      NOW,
    );

    assert.equal(recovered.state, 'RECOVERY_REQUIRED');
    assert.equal(recovered.active_agent, null);
    assert.ok(recovered.uncertainty !== null);
    assert.equal(recovered.uncertainty?.agent, 'claude');
    assert.equal(recovered.uncertainty?.last_event_id, 'evt_000007');
    assert.ok(recovered.uncertainty?.reason.includes('engagée'));
    assert.equal(recovered.control, 'HUMAN');

    const reloaded = await loadRun(runsDir, paths.runId);
    assert.equal(reloaded.requiresRecovery, false, 'l\'ambiguïté est désormais matérialisée');
    assert.equal(reloaded.state.state, 'RECOVERY_REQUIRED');
  } finally {
    await removeTempDir(runsDir);
  }
});

test('une identité incohérente entre manifest et state est refusée', async () => {
  const runsDir = await makeTempDir('ccr-identity-');
  try {
    const paths = await newRun(runsDir);
    const state = await readState(paths);
    await writeFile(paths.state, JSON.stringify({ ...state, run_id: 'CCR-20260807-999' }), 'utf8');

    await assert.rejects(
      loadRun(runsDir, paths.runId),
      (error: unknown) => isCcrError(error) && error.code === 'MANIFEST_INVALID',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});
