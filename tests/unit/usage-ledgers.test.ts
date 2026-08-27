/**
 * V2.2-IMP-01 — fondation des journaux de gouvernance d'usage.
 *
 * Trois propriétés gouvernent ce fichier.
 *
 *  1. **Les identités sont allouées, jamais devinées.** Un identifiant déjà
 *     présent n'est jamais réattribué, et une séquence qui régresse rend le
 *     journal illisible plutôt que réparé en silence.
 *  2. **L'identité opérationnelle reste discriminée par génération.** Aucun
 *     `expert_slot` n'est fabriqué pour un run historique, et deux experts
 *     partageant un moteur restent deux identités distinctes.
 *  3. **Un journal d'usage n'est pas un transcript.** Les champs qui le
 *     rendraient tel sont refusés, à l'écriture comme à la relecture.
 *
 * Aucun fournisseur, aucun processus, aucun service métier : les stores sont
 * éprouvés seuls, sur des répertoires temporaires.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import {
  findOrphanUsageObservations,
  formatInvocationId,
  INVOCATION_TRIGGER_KINDS,
  INVOCATION_TRIGGER_KINDS_V1,
  validateInvocationIdentity,
} from '../../src/core/usage-governance.ts';
import type { NewInvocationDispatch } from '../../src/core/usage-governance.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openUsageLedger } from '../../src/store/usage-ledger.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-042';
const AT = '2026-08-11T00:00:00.000Z';

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

async function runDir(dir: string): Promise<ReturnType<typeof runPaths>> {
  const paths = runPaths(path.join(dir, 'runs'), RUN_ID);
  await mkdir(paths.root, { recursive: true });
  return paths;
}

function nativeDispatch(over: Partial<NewInvocationDispatch> = {}): NewInvocationDispatch {
  return {
    identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
    trigger_kind: 'START',
    dispatch_committed_at: AT,
    ...over,
  } as NewInvocationDispatch;
}

// ==========================================================================
// A. InvocationLedger
// ==========================================================================

test('1–3 · le journal alloue, n’écrase jamais, et refuse une séquence réutilisée', async () => {
  const dir = await makeTempDir('ccr-22-inv-');
  try {
    const paths = await runDir(dir);

    // 1 · absent ou vide → première identité, sans erreur : c'est PRE_LEDGER.
    const empty = await openInvocationLedger(paths, RUN_ID);
    assert.deepEqual(await empty.readAll(), []);
    assert.equal(empty.lastInvocationId(), null);
    const first = await empty.append(nativeDispatch());
    assert.equal(first.invocation_id, 'inv_000001');
    assert.equal(first.kind, 'DISPATCH_COMMITTED');
    assert.equal(first.schema_version, 1);
    assert.equal(first.run_id, RUN_ID);

    // 2 · l'identité suivante vient du journal relu, pas d'un compteur mémoire.
    const reopened = await openInvocationLedger(paths, RUN_ID);
    const second = await reopened.append(
      nativeDispatch({ identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'challenger', provider: 'claude' } }),
    );
    assert.equal(second.invocation_id, 'inv_000002');
    assert.equal((await reopened.readAll()).length, 2);

    // 3 · une séquence réutilisée rend le journal illisible, jamais réparé.
    const corrupted = (await readFile(paths.invocations, 'utf8'))
      .trimEnd()
      .split('\n')
      .concat(
        JSON.stringify({
          ...JSON.parse((await readFile(paths.invocations, 'utf8')).split('\n')[0] as string),
          invocation_id: 'inv_000001',
        }),
      )
      .join('\n');
    await writeFile(paths.invocations, `${corrupted}\n`, 'utf8');
    await expectRejection(openInvocationLedger(paths, RUN_ID), 'JOURNAL_INVALID', 'identifiant réutilisé');
  } finally {
    await removeTempDir(dir);
  }
});

test('4–6 · identités natives et historiques, et same-provider distinct', async () => {
  const dir = await makeTempDir('ccr-22-identity-');
  try {
    const paths = await runDir(dir);
    const ledger = await openInvocationLedger(paths, RUN_ID);

    // 4 · natif : un rôle, et un moteur qui n'est qu'un attribut.
    const author = await ledger.append(nativeDispatch({ session_id: 'S1', prompt_event_id: 'evt_000002' }));
    // 6 · same-provider : même moteur, deux identités parfaitement distinctes.
    const challenger = await ledger.append(
      nativeDispatch({
        identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'challenger', provider: 'claude' },
        session_id: 'S2',
      }),
    );
    assert.deepEqual(author.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'author',
      provider: 'claude',
    });
    assert.notDeepEqual(author.identity, challenger.identity);
    assert.notEqual(author.invocation_id, challenger.invocation_id);
    assert.equal(author.session_id, 'S1');
    assert.equal(challenger.session_id, 'S2');

    // 5 · historique : un moteur, et aucun rôle inventé.
    const legacy = await ledger.append(
      nativeDispatch({
        identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'codex', provider: 'codex' },
        trigger_kind: 'STEP',
        round: 3,
      }),
    );
    assert.deepEqual(legacy.identity, {
      generation: 'LEGACY_V2_EXECUTION',
      agent_kind: 'codex',
      provider: 'codex',
    });
    assert.equal('expert_slot' in legacy.identity, false);
    assert.equal(legacy.round, 3);

    const all = await openInvocationLedger(paths, RUN_ID);
    assert.equal((await all.readAll()).length, 3);
  } finally {
    await removeTempDir(dir);
  }
});

test('7 · une identité générationnellement incohérente est refusée', async () => {
  const dir = await makeTempDir('ccr-22-bad-identity-');
  try {
    const paths = await runDir(dir);
    const ledger = await openInvocationLedger(paths, RUN_ID);

    // Un rôle sur un run historique n'est pas un champ en trop : c'est une
    // identité inventée, et c'est exactement ce que V2.1 a supprimé.
    await expectRejection(
      ledger.append({
        identity: {
          generation: 'LEGACY_V2_EXECUTION',
          agent_kind: 'claude',
          provider: 'claude',
          expert_slot: 'author',
        },
        trigger_kind: 'STEP',
      } as unknown as NewInvocationDispatch),
      'JOURNAL_INVALID',
      'expert_slot sur un run historique',
    );

    // Réciproquement, un moteur ne devient pas une identité native.
    await expectRejection(
      ledger.append({
        identity: {
          generation: 'NATIVE_V21_EXECUTION',
          agent_kind: 'claude',
          provider: 'claude',
          expert_slot: 'author',
        },
        trigger_kind: 'STEP',
      } as unknown as NewInvocationDispatch),
      'JOURNAL_INVALID',
      'agent_kind sur un run natif',
    );

    // Rien n'a été écrit : un refus ne laisse pas de trace.
    assert.deepEqual(await ledger.readAll(), []);

    // Un déclencheur hors de la surface model-producing est refusé.
    await expectRejection(
      ledger.append({ ...nativeDispatch(), trigger_kind: 'HANDOFF' } as unknown as NewInvocationDispatch),
      'JOURNAL_INVALID',
      'HANDOFF n’est pas une invocation model-producing',
    );
    // V3-S6 puis V4-S6 : l'union globale s'élargit d'une valeur par version. Ce
    // que ce test garde est ce qui ne bouge JAMAIS — le vocabulaire de la
    // version 1, figé pour toujours : c'est ce qu'un lecteur V2.2 connaît, et
    // l'élargir réécrirait ce qu'il savait.
    assert.deepEqual([...INVOCATION_TRIGGER_KINDS_V1], ['START', 'STEP', 'SEND', 'RECOVERY_CONTINUE']);

    // Et `HANDOFF` reste hors de la surface model-producing, quelle que soit la
    // version : ouvrir un terminal humain n'est pas appeler un fournisseur.
    assert.equal((INVOCATION_TRIGGER_KINDS as readonly string[]).includes('HANDOFF'), false);
    for (const jamais of ['PAUSE', 'RESUME', 'OTHER', 'CUSTOM', 'UNKNOWN']) {
      assert.equal((INVOCATION_TRIGGER_KINDS as readonly string[]).includes(jamais), false, jamais);
    }

    // Et une génération inconnue ne devient pas un défaut.
    assert.throws(
      () => validateInvocationIdentity({ generation: 'V3', provider: 'claude' }),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('corruption · JSON, version et run étranger sont refusés sans réparation', async () => {
  const dir = await makeTempDir('ccr-22-corrupt-');
  try {
    const paths = await runDir(dir);

    await writeFile(paths.invocations, '{ pas du JSON\n', 'utf8');
    await expectRejection(openInvocationLedger(paths, RUN_ID), 'JOURNAL_INVALID', 'JSON illisible');

    const valid = {
      schema_version: 1,
      kind: 'DISPATCH_COMMITTED',
      invocation_id: 'inv_000001',
      run_id: RUN_ID,
      identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
      trigger_kind: 'START',
      dispatch_committed_at: AT,
    };

    await writeFile(paths.invocations, `${JSON.stringify({ ...valid, schema_version: 99 })}\n`, 'utf8');
    await expectRejection(openInvocationLedger(paths, RUN_ID), 'JOURNAL_INVALID', 'schema inconnu');

    await writeFile(paths.invocations, `${JSON.stringify({ ...valid, kind: 'RESPONSE_RECEIVED' })}\n`, 'utf8');
    await expectRejection(openInvocationLedger(paths, RUN_ID), 'JOURNAL_INVALID', 'kind inconnu');

    await writeFile(paths.invocations, `${JSON.stringify({ ...valid, run_id: 'CCR-20260811-999' })}\n`, 'utf8');
    await expectRejection(openInvocationLedger(paths, RUN_ID), 'JOURNAL_INVALID', 'run étranger');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. UsageLedger
// ==========================================================================

test('8–10 · observations identifiées, multiples par invocation, orphelines détectables', async () => {
  const dir = await makeTempDir('ccr-22-usage-');
  try {
    const paths = await runDir(dir);
    const invocations = await openInvocationLedger(paths, RUN_ID);
    const dispatch = await invocations.append(nativeDispatch());

    const usage = await openUsageLedger(paths, RUN_ID);

    // 8 · première identité d'observation.
    const first = await usage.append({
      invocation_id: dispatch.invocation_id,
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      tokens: {
        provider: 'claude',
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: 33,
        cache_read_input_tokens: 44,
      },
      observed_at: AT,
    });
    assert.equal(first.usage_observation_id, 'usage_000001');
    assert.equal(first.invocation_id, 'inv_000001');
    assert.equal(first.run_id, RUN_ID);

    // 9 · une même invocation peut porter plusieurs observations distinctes.
    const second = await usage.append({
      invocation_id: dispatch.invocation_id,
      provenance: 'CCR_MEASURED',
      ccr_elapsed_ms: 1234,
      exit_code: 0,
      observed_at: AT,
    });
    assert.equal(second.usage_observation_id, 'usage_000002');
    assert.notEqual(first.usage_observation_id, second.usage_observation_id);
    const stored = await usage.readAll();
    assert.equal(stored.length, 2);
    assert.equal(new Set(stored.map((entry) => entry.invocation_id)).size, 1);

    // 10 · une observation sans invocation est détectable par la vérification
    // composite — sans que le lecteur de ligne devienne une source d'invocations.
    const orphan = await usage.append({
      invocation_id: formatInvocationId(99),
      provenance: 'PROVIDER_REPORTED',
      observed_at: AT,
    });
    const orphans = findOrphanUsageObservations(await invocations.readAll(), await usage.readAll());
    assert.deepEqual(
      orphans.map((entry) => entry.usage_observation_id),
      [orphan.usage_observation_id],
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('11 · un journal d’usage n’accueille aucun transcript', async () => {
  const dir = await makeTempDir('ccr-22-no-transcript-');
  try {
    const paths = await runDir(dir);
    const usage = await openUsageLedger(paths, RUN_ID);

    for (const field of ['prompt', 'content', 'response', 'result', 'stdoutRaw', 'stderrRaw']) {
      await expectRejection(
        usage.append({
          invocation_id: 'inv_000001',
          provenance: 'PROVIDER_REPORTED',
          [field]: 'texte du modèle',
        } as never),
        'JOURNAL_INVALID',
        `${field} refusé`,
      );
    }
    assert.deepEqual(await usage.readAll(), [], 'aucun refus n’a laissé de trace');

    // Et à la relecture d'un fichier écrit par un tiers.
    await writeFile(
      paths.usage,
      `${JSON.stringify({
        schema_version: 1,
        usage_observation_id: 'usage_000001',
        invocation_id: 'inv_000001',
        run_id: RUN_ID,
        observed_at: AT,
        provenance: 'PROVIDER_REPORTED',
        stdout: 'sortie brute',
      })}\n`,
      'utf8',
    );
    await expectRejection(openUsageLedger(paths, RUN_ID), 'JOURNAL_INVALID', 'transcript relu');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Gardes d'architecture
// ==========================================================================

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * Code livré, commentaires retirés.
 *
 * La garde porte sur ce que le module **fait**, jamais sur ce qu'il dit : un
 * fichier a parfaitement le droit d'écrire « aucun quota » dans sa prose pour
 * expliquer ce qu'il ne contient pas.
 */
async function source(relative: string): Promise<string> {
  const raw = await readFile(path.join(SRC, relative), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

test('22–23 · les deux moteurs sont câblés, le transport ne l’est pas', async () => {
  // 22 · l'asymétrie annoncée par IMP-02 est refermée (IMP-06) : les deux
  // moteurs gouvernent leurs chemins model-producing. La garde protège la
  // frontière restante — le transport n'écrit aucun journal de gouvernance.
  for (const relative of [
    'services/native-step-service.ts',
    'services/native-send-service.ts',
    'services/native-start-service.ts',
  ]) {
    const wired = await source(relative);
    assert.ok(wired.includes('invocation-ledger'), `${relative} est câblé`);
    assert.ok(wired.includes('usage-governance-writer'), `${relative} observe son usage`);
  }
  // La reprise d'initialisation réutilise la primitive de START : elle fournit
  // la gouvernance, et n'écrit pas elle-même l'usage.
  const recovery = await source('services/native-recovery-service.ts');
  assert.ok(recovery.includes('invocation-ledger'), 'la reprise est câblée');
  assert.ok(recovery.includes("trigger: 'RECOVERY_CONTINUE'"), 'avec son propre déclencheur');

  // Le moteur historique gouverne ses trois chemins depuis un goulot unique.
  const legacy = await source('services/run-service.ts');
  assert.ok(legacy.includes('invocation-ledger'), 'le moteur historique est câblé');
  assert.ok(legacy.includes('usage-governance-writer'), 'et observe son usage');
  for (const trigger of ["trigger: 'STEP'", "trigger: 'SEND'", "trigger: 'RECOVERY_CONTINUE'"]) {
    assert.ok(legacy.includes(trigger), `${trigger} est déclaré par son appelant`);
  }

  const services = ['cockpit/operations-store.ts'];
  for (const relative of services) {
    const code = await source(relative);
    for (const forbidden of ['invocation-ledger', 'usage-ledger', 'usage-governance']) {
      assert.equal(code.includes(forbidden), false, `${relative} n’importe pas ${forbidden}`);
    }
  }

  // 23 · l'adapter peut connaître les types d'usage, jamais les stores ;
  // les stores ne connaissent aucun adapter.
  for (const relative of ['adapters/claude-adapter.ts', 'adapters/codex-adapter.ts']) {
    const code = await source(relative);
    assert.ok(code.includes("core/usage.ts"), `${relative} lit bien les types d’usage`);
    for (const forbidden of ['invocation-ledger', 'usage-ledger', 'store/']) {
      assert.equal(code.includes(forbidden), false, `${relative} ne touche pas ${forbidden}`);
    }
  }
  for (const relative of ['store/invocation-ledger.ts', 'store/usage-ledger.ts']) {
    const code = await source(relative);
    for (const forbidden of ['adapters/', 'process-runner', 'pricing', 'cost']) {
      assert.equal(code.includes(forbidden), false, `${relative} ne touche pas ${forbidden}`);
    }
  }

  // Aucun coût, aucun tarif, aucun quota dans ce slice : les modules n'existent
  // pas encore, et rien ne les nomme.
  const ledgerTypes = await source('core/usage-governance.ts');
  for (const forbidden of ['pricing_catalog_version', 'CostEstimate', 'quota']) {
    assert.equal(ledgerTypes.includes(forbidden), false, `usage-governance sans ${forbidden}`);
  }
});
