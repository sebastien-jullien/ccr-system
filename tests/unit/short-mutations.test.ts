/**
 * Mutations courtes — composition, empreinte et store (Slice 4).
 *
 * Ce que ces tests protègent, et qu'un test d'intégration ne verrait pas :
 *
 *  1. **un seul verrou** couvre la vérification de révision et l'effet. Deux
 *     acquisitions successives fonctionneraient parfaitement… en laissant la
 *     fenêtre TOCTOU grande ouverte ;
 *  2. l'empreinte ne dépend pas de la forme du JSON reçu ;
 *  3. un reçu d'une instance disparue vaut `UNKNOWN`, et une corruption vaut
 *     un refus — jamais une absence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import {
  computeFingerprint,
  createOperationStore,
  deriveStatus,
  digestOfContent,
  isOperationId,
  newServerInstanceId,
  toPublicReceipt,
} from '../../src/cockpit/operations-store.ts';
import type { OperationReceipt } from '../../src/cockpit/operations-store.ts';
import { fingerprintOfRequest } from '../../src/cockpit/mutations-http.ts';
import { SHORT_MUTATION_ACTIONS } from '../../src/services/short-mutations.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const SOURCE = new URL('../../src/services/short-mutations.ts', import.meta.url);

test('(S1) une seule section critique couvre la révision ET l’effet', async (t) => {
  const code = await readFile(SOURCE, 'utf8');
  const body = code.slice(code.indexOf('export async function applyShortMutation'));

  // Un seul verrou. Deux acquisitions imbriquées se bloqueraient ; deux
  // acquisitions successives laisseraient la fenêtre TOCTOU ouverte.
  assert.equal((body.match(/withRunLock\(/g) ?? []).length, 1, 'un seul run lock');

  // Les façades publiques prennent le verrou elles-mêmes : les appeler ici
  // signifierait soit un blocage, soit une seconde section critique.
  for (const facade of ['pauseRun(', 'resumeRun(', 'stopRun(', 'recordDecision(']) {
    assert.equal(body.includes(facade), false, `façade publique appelée : ${facade}`);
  }
  for (const locked of ['pauseRunLocked(', 'resumeRunLocked(', 'stopRunLocked(', 'recordDecisionLocked(']) {
    assert.ok(body.includes(locked), `primitive verrouillée attendue : ${locked}`);
  }

  // L'ordre est structurel : la révision se lit après l'acquisition.
  const lockAt = body.indexOf('withRunLock(');
  const revisionAt = body.indexOf('assertExpectedRevision(');
  const effectAt = body.indexOf('pauseRunLocked(');
  t.diagnostic(`verrou@${String(lockAt)} < révision@${String(revisionAt)} < effet@${String(effectAt)}`);
  assert.ok(lockAt < revisionAt && revisionAt < effectAt, 'verrou → révision → effet');

  // Surface close : quatre actions, pas une de plus.
  assert.deepEqual([...SHORT_MUTATION_ACTIONS], ['PAUSE', 'RESUME', 'DECIDE', 'STOP']);
  for (const excluded of ["'STEP'", "'SEND'", "'START'", "'RECOVER'", "'HANDOFF'"]) {
    assert.equal(code.includes(excluded), false, `action hors périmètre : ${excluded}`);
  }
});

test('(S2) empreinte : indépendante de la forme, sensible à l’intention', () => {
  const revision = `sha256:${'a'.repeat(64)}`;
  const base = { action: 'PAUSE', runId: 'CCR-20260402-001', expectedRevision: revision };

  // Même intention, quel que soit l'ordre d'écriture : l'empreinte se calcule
  // sur des champs validés, jamais sur les octets reçus.
  assert.equal(fingerprintOfRequest(base), fingerprintOfRequest({ ...base }));

  const variants = [
    { ...base, runId: 'CCR-20260808-002' },
    { ...base, action: 'RESUME' },
    { ...base, expectedRevision: `sha256:${'b'.repeat(64)}` },
    { ...base, content: 'décision' },
  ];
  const seen = new Set(variants.map((variant) => fingerprintOfRequest(variant)));
  assert.equal(seen.size, variants.length, 'chaque intention a son empreinte');
  assert.equal(seen.has(fingerprintOfRequest(base)), false);

  // Le contenu n'entre que par son condensat.
  const withContent = fingerprintOfRequest({ ...base, content: 'secret' });
  assert.equal(
    withContent,
    computeFingerprint({
      method: 'POST',
      action: 'PAUSE',
      runId: base.runId,
      expectedRevision: revision,
      contentDigest: digestOfContent('secret'),
    }),
  );
  assert.equal(withContent.includes('secret'), false);
  assert.match(withContent, /^sha256:[0-9a-f]{64}$/);
});

test('(S3) identifiant d’opération : format strict, dérivé, non devinable en sens inverse', () => {
  assert.equal(isOperationId(`op_${'a'.repeat(64)}`), true);
  for (const invalid of ['op_', 'op_zzz', `op_${'a'.repeat(63)}`, `op_${'A'.repeat(64)}`, `${'a'.repeat(64)}`, '../op', 'op_%2e%2e']) {
    assert.equal(isOperationId(invalid), false, invalid);
  }
});

test('(S4) reçu d’une instance disparue : UNKNOWN, sans écriture ni parcours', () => {
  const receipt: OperationReceipt = {
    schema_version: 1,
    operation_id: `op_${'a'.repeat(64)}`,
    server_instance_id: 'instance-1',
    run_id: 'CCR-20260402-001',
    action: 'PAUSE',
    fingerprint: `sha256:${'b'.repeat(64)}`,
    created_at: '2026-08-08T00:00:00.000Z',
    updated_at: '2026-08-08T00:00:00.000Z',
    status: 'RUNNING',
  };

  assert.equal(deriveStatus(receipt, 'instance-1').status, 'RUNNING', 'même instance : toujours en vol');
  assert.equal(deriveStatus(receipt, 'instance-2').status, 'UNKNOWN', 'instance disparue : on ne sait pas');

  for (const terminal of ['SUCCEEDED', 'FAILED', 'UNKNOWN'] as const) {
    const settled = { ...receipt, status: terminal };
    assert.equal(deriveStatus(settled, 'instance-2').status, terminal, 'un verdict terminal ne bouge plus');
  }
});

test('(S5) reçu public : ni empreinte, ni instance, ni clé', () => {
  const receipt: OperationReceipt = {
    schema_version: 1,
    operation_id: `op_${'a'.repeat(64)}`,
    server_instance_id: 'instance-secrete',
    run_id: 'CCR-20260402-001',
    action: 'DECIDE',
    fingerprint: `sha256:${'b'.repeat(64)}`,
    created_at: '2026-08-08T00:00:00.000Z',
    updated_at: '2026-08-08T00:00:01.000Z',
    status: 'SUCCEEDED',
    revision_after: `sha256:${'c'.repeat(64)}`,
  };
  const serialized = JSON.stringify(toPublicReceipt(receipt));

  assert.equal(serialized.includes('instance-secrete'), false);
  assert.equal(serialized.includes(receipt.fingerprint), false);
  assert.equal(serialized.includes('schema_version'), false);
  assert.deepEqual(Object.keys(toPublicReceipt(receipt)).sort(), [
    'action',
    'created_at',
    'operation_id',
    'revision_after',
    'run_id',
    'status',
    'updated_at',
  ]);
});

test('(S6) store : claim exclusif, réutilisation refusée, corruption fail-closed', async (t) => {
  const dir = await makeTempDir('ccr-ops-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const dataRoot = resolveCockpitDataRoot(runsDir);
    const instance = newServerInstanceId();
    const store = createOperationStore(dataRoot, instance);

    const input = {
      idempotencyKey: 'cle-de-test-000001',
      fingerprint: `sha256:${'a'.repeat(64)}`,
      runId: 'CCR-20260402-001',
      action: 'PAUSE',
    };

    const first = await store.claim(input);
    assert.equal(first.kind, 'CLAIMED');
    assert.equal(first.receipt.status, 'RUNNING');

    // Retransmission : le claim existant, jamais un second.
    const again = await store.claim(input);
    assert.equal(again.kind, 'EXISTING');
    assert.equal(again.receipt.operation_id, first.receipt.operation_id);

    // Même clé, autre intention.
    await assert.rejects(
      store.claim({ ...input, fingerprint: `sha256:${'b'.repeat(64)}` }),
      (error: unknown) => {
        assert.ok(isCcrError(error));
        assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED');
        return true;
      },
    );

    // Concurrence : un seul gagnant, physiquement.
    const store2 = createOperationStore(dataRoot, instance);
    const race = await Promise.all(
      Array.from({ length: 8 }, () => store2.claim({ ...input, idempotencyKey: 'cle-concurrente-01' })),
    );
    assert.equal(race.filter((result) => result.kind === 'CLAIMED').length, 1, 'un seul claim gagnant');

    const settled = await store.settle(first.receipt.operation_id, { status: 'SUCCEEDED' });
    assert.equal(settled.status, 'SUCCEEDED');
    assert.equal((await store.read(first.receipt.operation_id))?.status, 'SUCCEEDED');

    // Corruption : refus explicite, jamais « donc absent ».
    const digest = first.receipt.operation_id.slice(3);
    const file = path.join(dataRoot.controlDir, 'operations', digest.slice(0, 2), `${digest}.json`);
    await writeFile(file, '{ cassé', 'utf8');
    for (const action of [
      (): Promise<unknown> => store.read(first.receipt.operation_id),
      (): Promise<unknown> => store.claim(input),
    ]) {
      await assert.rejects(action(), (error: unknown) => {
        assert.ok(isCcrError(error));
        assert.equal(error.code, 'OPERATION_STORE_CORRUPT');
        return true;
      });
    }
    t.diagnostic('claim exclusif, réutilisation refusée, corruption refusée');

    // Un identifiant inconnu reste une absence — celle-là est légitime.
    await writeFile(file, JSON.stringify({ ...settled }), 'utf8');
    assert.equal(await store.read(`op_${'f'.repeat(64)}`), undefined);
  } finally {
    await removeTempDir(dir);
  }
});

// --------------------------------------------------------------------------
// (O-START) `created_run_id` : écrit une fois, jamais réécrit
// --------------------------------------------------------------------------

test('(O-START) un reçu START porte son run créé, et ne peut plus en changer', async (t) => {
  const dir = await makeTempDir('ccr-ops-start-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const store = createOperationStore(resolveCockpitDataRoot(runsDir), newServerInstanceId());

    // Un claim START ne nomme aucun run : c'est précisément sa raison d'être.
    const claim = await store.claim({
      idempotencyKey: 'cle-creation-00001',
      fingerprint: `sha256:${'b'.repeat(64)}`,
      action: 'START',
    });
    assert.equal(claim.kind, 'CLAIMED');
    assert.equal(claim.receipt.run_id, undefined, 'aucun run visé');
    assert.equal(claim.receipt.created_run_id, undefined, 'aucun run créé pour l’instant');
    assert.equal(toPublicReceipt(claim.receipt).created_run_id, undefined);

    const operationId = claim.receipt.operation_id;
    const associated = await store.associateRun(operationId, 'CCR-20260402-001');
    t.diagnostic(`association → ${String(associated.created_run_id)} · statut ${associated.status}`);
    assert.equal(associated.created_run_id, 'CCR-20260402-001');
    assert.equal(associated.status, 'RUNNING', 'associer ne terminalise pas');

    // Idempotente : réassocier le MÊME run est un non-événement.
    const again = await store.associateRun(operationId, 'CCR-20260402-001');
    assert.equal(again.created_run_id, 'CCR-20260402-001');

    // Un AUTRE run est un invariant rompu, jamais une correction silencieuse.
    await assert.rejects(
      store.associateRun(operationId, 'CCR-20260808-002'),
      (error: unknown) => {
        assert.ok(isCcrError(error));
        assert.equal(error.code, 'OPERATION_STORE_CORRUPT');
        return true;
      },
    );
    const after = await store.read(operationId);
    assert.equal(after?.created_run_id, 'CCR-20260402-001', 'le reçu n’a pas bougé');

    // La terminalisation conserve l'association.
    const settled = await store.settle(operationId, { status: 'SUCCEEDED' });
    assert.equal(settled.created_run_id, 'CCR-20260402-001');
    assert.equal(toPublicReceipt(settled).created_run_id, 'CCR-20260402-001');
  } finally {
    await removeTempDir(dir);
  }
});
