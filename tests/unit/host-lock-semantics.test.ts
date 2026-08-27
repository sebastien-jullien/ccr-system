/**
 * Sémantique des verrous dans un hôte long-lived (V2-IMP-31, Slice 0D).
 *
 * Ferme `CX2-002` / `INV-20-04`.
 *
 * Dans une CLI courte, « le PID propriétaire est vivant » approxime « une
 * opération est en cours ». Dans un serveur permanent, le même PID survit à des
 * centaines d'opérations : l'égalité de PID ne désigne plus aucune opération.
 *
 * Les deux erreurs symétriques à interdire :
 *
 *   faux « actif »    un verrou ancien pris pour celui d'une opération neuve
 *   faux « orphelin » un verrou légitime déclaré orphelin
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createHostOperationRegistry } from '../../src/lock/host-operation-registry.ts';
import {
  classifyLockObservation,
  isPendingCoveredByLock,
  observeRunExecution,
} from '../../src/lock/run-execution-evidence.ts';
import { acquireRunLock, lockFilePath, withRunLock } from '../../src/lock/run-lock.ts';
import type { RunLockInfo } from '../../src/lock/run-lock.ts';
import { classifyRunLiveness } from '../../src/core/run-liveness.ts';
import { deriveRunCapabilities } from '../../src/services/run-capabilities.ts';
import { MANIFEST_SCHEMA_VERSION, STATE_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { PendingOperation, RunManifest, RunStateDocument } from '../../src/core/run.ts';
import { runPaths } from '../../src/store/layout.ts';
import { computeRunRevision } from '../../src/store/run-snapshot.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260402-001';
/** PID réellement vivant et distinct du nôtre : le processus parent. */
const OTHER_LIVE_PID = process.ppid;
const T0 = '2026-08-08T00:00:00.000Z';
const T1 = '2026-08-08T00:00:10.000Z';

const MANIFEST: RunManifest = {
  schema_version: MANIFEST_SCHEMA_VERSION,
  run_id: RUN_ID,
  title: 'T',
  created_at: T0,
  workspace: { cwd: 'E:/prog/exemple' },
  agents: {
    claude: { session_id: 'claude-1', role: 'challenger' },
    codex: { session_id: 'codex-1', role: 'author' },
  },
  runtime_config: TEST_RUNTIME_CONFIG,
};

function pendingOf(kind: PendingOperation['kind'], startedAt: string): PendingOperation {
  return {
    kind,
    agent: 'claude',
    round: 1,
    prompt_event_id: 'evt_000004',
    source_event_id: 'evt_000003',
    session_id: 'claude-1',
    return_state: 'READY',
    return_control: 'AUTOMATION',
    started_at: startedAt,
  };
}

function stateOf(pending: PendingOperation | null): RunStateDocument {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: RUN_ID,
    state: 'WAITING_AGENT',
    control: 'AUTOMATION',
    round: 1,
    active_agent: 'claude',
    last_event_id: 'evt_000004',
    pending_operation: pending,
    uncertainty: null,
    updated_at: T0,
  };
}

function lockOf(over: Partial<RunLockInfo> = {}): RunLockInfo {
  return {
    lock_id: 'lock-A',
    pid: process.pid,
    hostname: hostname(),
    started_at: T0,
    command: 'step',
    ...over,
  };
}

async function runDir(prefix: string): Promise<{ dir: string; paths: ReturnType<typeof runPaths> }> {
  const dir = await makeTempDir(prefix);
  const paths = runPaths(dir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  return { dir, paths };
}

// --------------------------------------------------------------------------
// (1 à 4) Registre
// --------------------------------------------------------------------------

test('(1) un registre neuf est vide', () => {
  const registry = createHostOperationRegistry();
  assert.equal(registry.size(), 0);
  assert.deepEqual(registry.active(), []);
  assert.equal(registry.find(RUN_ID, 'lock-A'), undefined);
});

test('(2) enregistrement, liaison, retrait', () => {
  const registry = createHostOperationRegistry();
  const id = registry.begin(RUN_ID, 'step');

  // Tant qu'aucun verrou n'est lié, l'entrée ne prouve rien.
  assert.equal(registry.find(RUN_ID, 'lock-A'), undefined, 'une intention ne prouve rien');
  assert.equal(registry.size(), 1);

  registry.bindLock(id, 'lock-A');
  assert.equal(registry.find(RUN_ID, 'lock-A')?.hostOperationId, id);

  registry.end(id);
  assert.equal(registry.size(), 0);
  assert.equal(registry.find(RUN_ID, 'lock-A'), undefined);
  registry.end(id); // idempotent
});

test('(3) deux runs simultanés du même processus ne se contaminent pas', () => {
  const registry = createHostOperationRegistry();
  const a = registry.begin('CCR-20260402-001', 'step');
  const b = registry.begin('CCR-20260808-002', 'send');
  registry.bindLock(a, 'lock-A');
  registry.bindLock(b, 'lock-B');

  assert.equal(registry.find('CCR-20260402-001', 'lock-A')?.hostOperationId, a);
  assert.equal(registry.find('CCR-20260808-002', 'lock-B')?.hostOperationId, b);
  // Croisements interdits.
  assert.equal(registry.find('CCR-20260402-001', 'lock-B'), undefined);
  assert.equal(registry.find('CCR-20260808-002', 'lock-A'), undefined);
});

test('(4) une opération nouvelle ne réhabilite jamais un verrou ancien', () => {
  const registry = createHostOperationRegistry();
  const first = registry.begin(RUN_ID, 'step');
  registry.bindLock(first, 'lock-L1');
  registry.end(first);

  // L1 traîne encore sur le disque ; une nouvelle opération démarre.
  const second = registry.begin(RUN_ID, 'step');
  registry.bindLock(second, 'lock-L2');

  assert.equal(registry.find(RUN_ID, 'lock-L1'), undefined, 'L1 reste orphelin');
  assert.equal(registry.find(RUN_ID, 'lock-L2')?.hostOperationId, second);
});

// --------------------------------------------------------------------------
// (5 à 12) Classification d'un verrou observé
// --------------------------------------------------------------------------

test('(5) même PID + verrou exact + registre exact → opération de l’hôte active', () => {
  const registry = createHostOperationRegistry();
  const id = registry.begin(RUN_ID, 'step');
  registry.bindLock(id, 'lock-A');

  const result = classifyLockObservation(RUN_ID, lockOf(), {
    registry,
    pendingOperation: pendingOf('step', T1),
  });
  assert.equal(result.observation, 'ACTIVE_HOST_OPERATION');
  assert.equal(result.evidence.hostOperation, 'ACTIVE');
  assert.equal(result.evidence.lock, 'ALIVE_THIS_PROCESS');
});

test('(6) même PID sans aucune entrée de registre → verrou orphelin', () => {
  const result = classifyLockObservation(RUN_ID, lockOf(), {
    registry: createHostOperationRegistry(),
    pendingOperation: pendingOf('step', T1),
  });
  assert.equal(result.observation, 'ORPHAN_SAME_PID_LOCK');
  assert.equal(result.evidence.hostOperation, 'NONE');
});

test('(7) même PID mais le registre porte un AUTRE verrou → jamais actif', () => {
  const registry = createHostOperationRegistry();
  const id = registry.begin(RUN_ID, 'step');
  registry.bindLock(id, 'lock-L2');

  // Le disque porte L1, le registre L2 : l'égalité de PID ne suffit pas.
  const result = classifyLockObservation(RUN_ID, lockOf({ lock_id: 'lock-L1' }), {
    registry,
    pendingOperation: pendingOf('step', T1),
  });
  assert.equal(result.observation, 'ORPHAN_SAME_PID_LOCK');
  assert.notEqual(result.evidence.hostOperation, 'ACTIVE');
});

test('(8) autre PID vivant avec correspondance suffisante', () => {
  const result = classifyLockObservation(
    RUN_ID,
    lockOf({ pid: OTHER_LIVE_PID, command: 'step', started_at: T0 }),
    { pendingOperation: pendingOf('step', T1), pid: process.pid },
  );
  assert.equal(result.observation, 'ACTIVE_EXTERNAL_LOCK');
  assert.equal(result.evidence.lock, 'ALIVE_OTHER_PROCESS');
  assert.equal(result.evidence.pendingCoveredByLock, 'YES');
});

test('(9) autre PID vivant SANS correspondance suffisante', () => {
  // Action différente : le verrou est vivant, mais pas pour cette opération.
  const wrongAction = classifyLockObservation(
    RUN_ID,
    lockOf({ pid: OTHER_LIVE_PID, command: 'decide' }),
    { pendingOperation: pendingOf('step', T1), pid: process.pid },
  );
  assert.equal(wrongAction.evidence.pendingCoveredByLock, 'NO');

  // Opération antérieure au verrou : elle appartient à un détenteur précédent.
  const older = classifyLockObservation(
    RUN_ID,
    lockOf({ pid: OTHER_LIVE_PID, command: 'step', started_at: T1 }),
    { pendingOperation: pendingOf('step', T0), pid: process.pid },
  );
  assert.equal(older.evidence.pendingCoveredByLock, 'NO');

  // Et la classification refuse alors de conclure.
  const verdict = classifyRunLiveness(
    { manifest: MANIFEST, state: stateOf(pendingOf('step', T0)), pendingResponseJournaled: false },
    older.evidence,
  );
  assert.equal(verdict.liveness, 'UNDETERMINED');
});

test('(10) verrou périmé → ORPHAN_LOCK', () => {
  const result = classifyLockObservation(RUN_ID, lockOf({ pid: 2 ** 30 }), {
    registry: createHostOperationRegistry(),
    pendingOperation: pendingOf('step', T1),
  });
  assert.equal(result.observation, 'STALE_LOCK');

  const verdict = classifyRunLiveness(
    { manifest: MANIFEST, state: stateOf(pendingOf('step', T1)), pendingResponseJournaled: false },
    result.evidence,
  );
  assert.equal(verdict.liveness, 'ORPHAN_LOCK');
});

test('(11) verrou d’un autre hôte : jamais supprimé, jamais conclu', async () => {
  const { dir, paths } = await runDir('ccr-0d-foreign-');
  try {
    const foreign = lockOf({ hostname: 'AUTRE-POSTE', lock_id: 'lock-F' });
    await writeFile(lockFilePath(paths), `${JSON.stringify(foreign, null, 2)}\n`, 'utf8');
    const before = await readFile(lockFilePath(paths), 'utf8');

    const result = await observeRunExecution(paths, {
      registry: createHostOperationRegistry(),
      pendingOperation: pendingOf('step', T1),
    });
    assert.equal(result.observation, 'FOREIGN_LOCK');
    assert.equal(result.evidence.lock, 'FOREIGN_HOST');

    assert.equal(await readFile(lockFilePath(paths), 'utf8'), before, 'aucune suppression');
  } finally {
    await removeTempDir(dir);
  }
});

test('(12) même PID sans registre — cas CLI — reste indéterminé', () => {
  const result = classifyLockObservation(RUN_ID, lockOf(), {
    pendingOperation: pendingOf('step', T1),
  });
  assert.equal(result.observation, 'INDETERMINATE_LOCK');
  assert.equal(result.evidence.hostOperation, 'UNKNOWN');

  const verdict = classifyRunLiveness(
    { manifest: MANIFEST, state: stateOf(pendingOf('step', T1)), pendingResponseJournaled: false },
    result.evidence,
  );
  assert.equal(verdict.liveness, 'UNDETERMINED');
});

// --------------------------------------------------------------------------
// (13 à 15) Cycle de vie
// --------------------------------------------------------------------------

test('(13) une acquisition qui échoue ne laisse aucune opération active', async () => {
  const { dir, paths } = await runDir('ccr-0d-acqfail-');
  try {
    const registry = createHostOperationRegistry();
    const blocking = await acquireRunLock(paths, 'step');
    try {
      const id = registry.begin(RUN_ID, 'step');
      await assert.rejects(() => acquireRunLock(paths, 'step'));
      // L'entrée existe mais n'est liée à aucun verrou : elle ne prouve rien.
      assert.equal(registry.find(RUN_ID, blocking.info.lock_id), undefined);
      registry.end(id);
      assert.equal(registry.size(), 0);
    } finally {
      await blocking.release();
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('(14) une opération qui échoue nettoie le registre', async () => {
  const { dir, paths } = await runDir('ccr-0d-throw-');
  try {
    const registry = createHostOperationRegistry();
    const id = registry.begin(RUN_ID, 'step');

    await assert.rejects(() =>
      withRunLock(
        paths,
        'step',
        async () => {
          throw new Error('échec métier');
        },
        {
          onAcquired: (info) => registry.bindLock(id, info.lock_id),
          onReleased: () => registry.end(id),
        },
      ),
    );

    assert.equal(registry.size(), 0, 'aucune fuite après échec');
  } finally {
    await removeTempDir(dir);
  }
});

test('(15) une libération en échec est rapportée, jamais masquée', async () => {
  const { dir, paths } = await runDir('ccr-0d-release-');
  try {
    const lock = await acquireRunLock(paths, 'step');
    // Un tiers remplace le verrou : le nôtre a disparu.
    await writeFile(
      lockFilePath(paths),
      `${JSON.stringify(lockOf({ lock_id: 'lock-AUTRE' }), null, 2)}\n`,
      'utf8',
    );

    const outcome = await lock.release();
    assert.equal(outcome, 'NOT_OWNER', 'le verrou d’autrui n’est pas supprimé');
    const raw = JSON.parse(await readFile(lockFilePath(paths), 'utf8')) as RunLockInfo;
    assert.equal(raw.lock_id, 'lock-AUTRE', 'et il est intact');

    // Verrou déjà disparu : issue distincte.
    const second = await acquireRunLock(runPaths(dir, 'CCR-20260808-002'), 'step').catch(() => undefined);
    void second;
  } finally {
    await removeTempDir(dir);
  }
});

test('une libération nominale rapporte RELEASED, une seconde ALREADY_GONE', async () => {
  const { dir, paths } = await runDir('ccr-0d-release2-');
  try {
    const lock = await acquireRunLock(paths, 'step');
    assert.equal(await lock.release(), 'RELEASED');
    assert.equal(await lock.release(), 'ALREADY_GONE');
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// (16, 17) Non-canonicité
// --------------------------------------------------------------------------

test('(16) le registre n’écrit aucun fichier', async () => {
  const { dir, paths } = await runDir('ccr-0d-nowrite-');
  try {
    const { readdir } = await import('node:fs/promises');
    const before = await readdir(paths.root);

    const registry = createHostOperationRegistry();
    const id = registry.begin(RUN_ID, 'step');
    registry.bindLock(id, 'lock-A');
    await observeRunExecution(paths, { registry, pendingOperation: pendingOf('step', T1) });
    registry.end(id);

    assert.deepEqual(await readdir(paths.root), before, 'aucun fichier créé ni modifié');

    const source = await readFile(
      new URL('../../src/lock/host-operation-registry.ts', import.meta.url),
      'utf8',
    );
    assert.ok(!source.includes('node:fs'), 'le registre ne connaît pas le disque');
  } finally {
    await removeTempDir(dir);
  }
});

test('(17) ni le registre ni le verrou ne changent la révision', () => {
  const state = stateOf(pendingOf('step', T1));
  const inputs = { manifest: MANIFEST, state, events: [], decisions: [] };
  const reference = computeRunRevision(inputs);

  const registry = createHostOperationRegistry();
  const id = registry.begin(RUN_ID, 'step');
  registry.bindLock(id, 'lock-A');

  for (const evidence of [
    classifyLockObservation(RUN_ID, undefined, {}).evidence,
    classifyLockObservation(RUN_ID, lockOf(), { registry }).evidence,
    classifyLockObservation(RUN_ID, lockOf({ pid: 2 ** 30 }), { registry }).evidence,
  ]) {
    classifyRunLiveness({ manifest: MANIFEST, state, pendingResponseJournaled: false }, evidence);
    assert.equal(computeRunRevision(inputs), reference);
  }
});

// --------------------------------------------------------------------------
// (18 à 20) Capacités, requiresRecovery, verrous anciens
// --------------------------------------------------------------------------

test('(18) sous opération de l’hôte démontrée, le motif reste OPERATION_IN_FLIGHT', () => {
  const registry = createHostOperationRegistry();
  const id = registry.begin(RUN_ID, 'step');
  registry.bindLock(id, 'lock-A');

  const evidence = classifyLockObservation(RUN_ID, lockOf(), {
    registry,
    pendingOperation: pendingOf('step', T1),
  }).evidence;
  const state = stateOf(pendingOf('step', T1));
  const liveness = classifyRunLiveness(
    { manifest: MANIFEST, state, pendingResponseJournaled: false },
    evidence,
  );
  assert.equal(liveness.liveness, 'OPERATION_IN_FLIGHT');

  const capabilities = deriveRunCapabilities(
    { manifest: MANIFEST, state, events: [], decisions: [], requiresRecovery: true },
    liveness.liveness,
  ).capabilities;
  for (const capability of capabilities) {
    if (capability.id === 'DECIDE') continue;
    assert.equal(capability.reason, 'OPERATION_IN_FLIGHT', `${capability.id}`);
  }
});

test('(19) requiresRecovery seul ne décide toujours rien', () => {
  const state = stateOf(pendingOf('step', T1));
  const facts = { manifest: MANIFEST, state, pendingResponseJournaled: true };
  const registry = createHostOperationRegistry();
  const bound = registry.begin(RUN_ID, 'step');
  registry.bindLock(bound, 'lock-A');

  const results = new Set([
    classifyRunLiveness(facts, classifyLockObservation(RUN_ID, lockOf(), { registry, pendingOperation: state.pending_operation }).evidence).liveness,
    classifyRunLiveness(facts, classifyLockObservation(RUN_ID, lockOf(), { registry: createHostOperationRegistry(), pendingOperation: state.pending_operation }).evidence).liveness,
    classifyRunLiveness(facts, classifyLockObservation(RUN_ID, undefined, {}).evidence).liveness,
    classifyRunLiveness(facts, classifyLockObservation(RUN_ID, lockOf(), { pendingOperation: state.pending_operation }).evidence).liveness,
  ]);
  assert.deepEqual(
    [...results].sort(),
    ['ABANDONED_OPERATION', 'OPERATION_IN_FLIGHT', 'ORPHAN_LOCK', 'UNDETERMINED'],
    'quatre situations pour un requiresRecovery identique',
  );
});

test('(20) un verrou V1 ancien reste inspectable sans identité moderne', async () => {
  const { dir, paths } = await runDir('ccr-0d-legacy-');
  try {
    // Verrou tel que la V1 l'écrit : le schéma est inchangé, `lock_id` existe
    // déjà. On vérifie qu'un document minimal reste exploitable.
    const legacy = {
      lock_id: 'ancien-verrou',
      pid: 2 ** 30,
      hostname: hostname(),
      started_at: T0,
      command: 'step',
    };
    await writeFile(lockFilePath(paths), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    const result = await observeRunExecution(paths, {
      registry: createHostOperationRegistry(),
      pendingOperation: pendingOf('step', T1),
    });
    assert.equal(result.observation, 'STALE_LOCK', 'qualifiable par les seules capacités V1');
    assert.equal(result.lock?.lock_id, 'ancien-verrou');
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// Correspondance §13
// --------------------------------------------------------------------------

test('la correspondance verrou ↔ opération est explicite et fermée', () => {
  const pending = pendingOf('step', T1);

  assert.equal(isPendingCoveredByLock(pending, lockOf({ command: 'step', started_at: T0 })), 'YES');
  assert.equal(isPendingCoveredByLock(pending, lockOf({ command: 'send' })), 'NO', 'action différente');
  assert.equal(isPendingCoveredByLock(pending, lockOf({ command: 'pause' })), 'NO', 'action sans tour');
  assert.equal(
    isPendingCoveredByLock(pendingOf('step', T0), lockOf({ command: 'step', started_at: T1 })),
    'NO',
    'opération antérieure au verrou',
  );
  assert.equal(isPendingCoveredByLock(null, lockOf()), 'UNKNOWN');
  assert.equal(
    isPendingCoveredByLock(pendingOf('initialization', T1), lockOf({ command: 'start' })),
    'YES',
  );
  assert.equal(
    isPendingCoveredByLock(pendingOf('initialization', T1), lockOf({ command: 'recover' })),
    'YES',
    'recover peut poursuivre une initialisation',
  );
});

// --------------------------------------------------------------------------
// Fenêtres d'acquisition et de libération (mini-gate 0D)
//
// Race démontrée avant correction : entre la publication de `.ccr.lock` et son
// association au registre, un lecteur voyait `ORPHAN_SAME_PID_LOCK` sur une
// acquisition parfaitement normale. Corrigée par annonce de l'identité AVANT
// publication (Option A).
// --------------------------------------------------------------------------

test('fenêtre forcée : aucune observation ne produit de faux orphelin', async (t) => {
  const { dir, paths } = await runDir('ccr-0d-window-');
  try {
    const registry = createHostOperationRegistry();
    const op = registry.begin(RUN_ID, 'step');
    const pending = pendingOf('step', new Date(Date.now() + 60_000).toISOString());

    const handle = await acquireRunLock(paths, 'step', {
      onIdentityPrepared: (info) => registry.bindLock(op, info.lock_id),
    });

    // Fenêtre artificielle significative pendant laquelle le verrou est
    // publié : plusieurs observations doivent toutes être correctes.
    // Boucle pilotée par le NOMBRE d'observations, pas par le temps : sous
    // charge, une fenêtre temporelle fixe produirait trop peu d'itérations et
    // le test mesurerait l'ordonnanceur au lieu du protocole.
    const observations: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const observed = await observeRunExecution(paths, { registry, pendingOperation: pending });
      observations.push(observed.observation);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await handle.release();
    registry.end(op);

    const falseOrphan = observations.filter((o) => o === 'ORPHAN_SAME_PID_LOCK').length;
    t.diagnostic(
      `observations=${String(observations.length)} · faux orphelins=${String(falseOrphan)} · ` +
        `distinctes=${[...new Set(observations)].join(',')}`,
    );
    assert.equal(observations.length, 15, 'fenêtre réellement observée plusieurs fois');
    assert.equal(falseOrphan, 0, 'aucun faux orphelin pendant une acquisition normale');
    assert.deepEqual([...new Set(observations)], ['ACTIVE_HOST_OPERATION']);
  } finally {
    await removeTempDir(dir);
  }
});

test('un verrou présent mais illisible n’est jamais lu comme absent', async () => {
  const { dir, paths } = await runDir('ccr-0d-unreadable-');
  try {
    // État exact du disque juste après `open(file, 'wx')` : fichier vide.
    await writeFile(lockFilePath(paths), '', 'utf8');

    const observed = await observeRunExecution(paths, {
      registry: createHostOperationRegistry(),
      pendingOperation: pendingOf('step', T1),
    });
    assert.equal(observed.observation, 'INDETERMINATE_LOCK');

    // Le confondre avec une absence conclurait « abandonnée » à tort.
    const verdict = classifyRunLiveness(
      { manifest: MANIFEST, state: stateOf(pendingOf('step', T1)), pendingResponseJournaled: true },
      observed.evidence,
    );
    assert.equal(verdict.liveness, 'UNDETERMINED');
    assert.notEqual(verdict.liveness, 'ABANDONED_OPERATION');
  } finally {
    await removeTempDir(dir);
  }
});

test('ancien verrou + nouvelle acquisition : l’ancien ne devient jamais actif', async (t) => {
  const { dir, paths } = await runDir('ccr-0d-oldlock-');
  try {
    // L1 : verrou ancien de CE PID, qu'aucune opération ne revendique.
    const l1: RunLockInfo = {
      lock_id: 'lock-L1-ancien',
      pid: process.pid,
      hostname: hostname(),
      started_at: T0,
      command: 'step',
    };
    await writeFile(lockFilePath(paths), `${JSON.stringify(l1, null, 2)}\n`, 'utf8');
    const before = await readFile(lockFilePath(paths), 'utf8');

    const registry = createHostOperationRegistry();
    const pending = pendingOf('step', T1);

    // O2 tente d'acquérir : `wx` doit échouer puisque L1 existe.
    await assert.rejects(() =>
      withRunLock(paths, 'step', async () => undefined, {
        onIdentityPrepared: (info) => registry.bindLock(registry.begin(RUN_ID, 'step'), info.lock_id),
        onAcquireFailed: () => undefined,
      }),
    );

    // Pendant et après la tentative, L1 garde sa classification.
    const observed = await observeRunExecution(paths, { registry, pendingOperation: pending });
    t.diagnostic(`ancien verrou observé = ${observed.observation}`);
    assert.notEqual(observed.observation, 'ACTIVE_HOST_OPERATION', 'jamais réhabilité');
    assert.equal(observed.observation, 'ORPHAN_SAME_PID_LOCK');
    assert.equal(await readFile(lockFilePath(paths), 'utf8'), before, 'aucune suppression');
  } finally {
    await removeTempDir(dir);
  }
});

test('une acquisition échouée ne laisse aucune intention dans le registre', async () => {
  const { dir, paths } = await runDir('ccr-0d-failclean-');
  try {
    const blocking = await acquireRunLock(paths, 'step');
    try {
      const registry = createHostOperationRegistry();
      const op = registry.begin(RUN_ID, 'step');

      await assert.rejects(() =>
        withRunLock(paths, 'step', async () => undefined, {
          onIdentityPrepared: (info) => registry.bindLock(op, info.lock_id),
          onAcquireFailed: () => registry.end(op),
        }),
      );

      assert.equal(registry.size(), 0, 'aucune fuite après échec d’acquisition');
    } finally {
      await blocking.release();
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('après le cycle de vie, une libération en échec ne laisse jamais « actif »', async (t) => {
  const { dir, paths } = await runDir('ccr-0d-relfail-');
  try {
    const registry = createHostOperationRegistry();
    const op = registry.begin(RUN_ID, 'step');
    let outcome: string | undefined;

    await withRunLock(
      paths,
      'step',
      async () => {
        // Un tiers écrase le verrou : la libération échouera à le supprimer,
        // et le fichier restera sur le disque.
        await writeFile(
          lockFilePath(paths),
          `${JSON.stringify(lockOf({ lock_id: 'lock-SURVIVANT' }), null, 2)}\n`,
          'utf8',
        );
      },
      {
        onIdentityPrepared: (info) => registry.bindLock(op, info.lock_id),
        onAcquireFailed: () => registry.end(op),
        onReleased: (_info, result) => {
          outcome = result;
          registry.end(op);
        },
      },
    );

    t.diagnostic(`issue de libération = ${String(outcome)} · registre = ${String(registry.size())}`);
    assert.equal(outcome, 'NOT_OWNER', 'la libération n’a pas supprimé le verrou d’autrui');
    assert.equal(registry.size(), 0, 'le cycle de vie est terminé');

    // Le verrou subsiste : il ne doit surtout pas être « actif ».
    const observed = await observeRunExecution(paths, {
      registry,
      pendingOperation: pendingOf('step', T1),
    });
    assert.notEqual(observed.observation, 'ACTIVE_HOST_OPERATION');
    assert.equal(observed.observation, 'ORPHAN_SAME_PID_LOCK');
  } finally {
    await removeTempDir(dir);
  }
});

test('le SERVICE associe l’opération avant que le verrou soit observable', async (t) => {
  const { existsSync } = await import('node:fs');
  const { pauseRun } = await import('../../src/services/run-service.ts');
  const { buildInitialState, writeManifest, writeState } = await import('../../src/store/state-store.ts');

  const { dir, paths } = await runDir('ccr-0d-service-bind-');
  try {
    await writeManifest(paths, MANIFEST);
    await writeState(paths, buildInitialState(RUN_ID, 'READY', new Date(T0)));

    // Registre instrumenté : il note si le verrou était DÉJÀ publié au moment
    // où le service a demandé l'association. S'il l'était, la fenêtre de faux
    // orphelin est ouverte.
    const inner = createHostOperationRegistry();
    const lockVisibleAtBind: boolean[] = [];
    const probe = {
      begin: (runId: string, action: string) => inner.begin(runId, action),
      bindLock: (id: string, lockId: string) => {
        lockVisibleAtBind.push(existsSync(lockFilePath(paths)));
        inner.bindLock(id, lockId);
      },
      end: (id: string) => inner.end(id),
      find: (runId: string, lockId: string) => inner.find(runId, lockId),
      active: () => inner.active(),
      size: () => inner.size(),
    };

    await pauseRun(
      {
        runsDir: path.dirname(paths.root),
        now: () => new Date(T1),
        createAdapters: () => ({
          claude: createFakeAdapter({ kind: 'claude' }),
          codex: createFakeAdapter({ kind: 'codex' }),
        }),
        hostRegistry: probe,
      },
      { runId: RUN_ID },
    );

    t.diagnostic(`associations=${String(lockVisibleAtBind.length)} · verrou déjà visible=${JSON.stringify(lockVisibleAtBind)}`);
    assert.equal(lockVisibleAtBind.length, 1, 'le service a bien associé une opération');
    assert.deepEqual(
      lockVisibleAtBind,
      [false],
      'le verrou ne doit PAS être observable au moment de l’association',
    );
    assert.equal(inner.size(), 0, 'aucune entrée résiduelle après l’opération');
  } finally {
    await removeTempDir(dir);
  }
});
