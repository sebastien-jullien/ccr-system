/**
 * V3-S6 — compatibilité du journal d'invocations V2.2.
 *
 * Question de preuve :
 *
 * > **Le ledger peut-il porter la raison d'une future détection sans qu'aucune
 * > installation dépourvue de détection ne change de version ?**
 *
 * Quatre propriétés.
 *
 *  1. **La version qualifie l'enregistrement, pas le fichier.** Un journal n'a
 *     pas d'époque : `v1 · v2 · v1` est légitime, et chaque ligne est analysée
 *     selon la sienne.
 *  2. **Aucun déclencheur existant ne change de version.** C'est la garantie de
 *     retour en arrière la plus importante de la tranche.
 *  3. **Aucun mensonge de ledger.** Le déclencheur de détection dit pourquoi une
 *     invocation a été engagée, jamais ce qu'elle a trouvé, et aucun ancien
 *     déclencheur n'est réutilisé pour le porter.
 *  4. **Aucune migration.** Lire ne réécrit rien ; une version inconnue interdit
 *     une lecture complète honnête au lieu d'être sautée.
 *
 * Aucun fournisseur, aucun détecteur, aucun prompt : S6 ne prépare que la voie
 * gouvernée, et cette tranche n'écrit aucune controverse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import {
  CONTROVERSY_DETECTION_TRIGGER,
  INVOCATION_LEDGER_SCHEMA_VERSION,
  INVOCATION_LEDGER_SCHEMA_VERSION_V2,
  INVOCATION_TRIGGER_KINDS,
  INVOCATION_TRIGGER_KINDS_V1,
  SUPPORTED_INVOCATION_LEDGER_SCHEMA_VERSIONS,
  invocationLedgerSchemaVersionFor,
  invocationTriggerKindsFor,
  validateInvocationDispatchRecord,
} from '../../src/core/usage-governance.ts';
import type { InvocationTriggerKind, NewInvocationDispatch } from '../../src/core/usage-governance.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { readUsageReadModel } from '../../src/services/usage-read-model.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260817-006';
const AT = '2026-08-17T00:00:00.000Z';
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

async function runDir(dir: string): Promise<ReturnType<typeof runPaths>> {
  const paths = runPaths(path.join(dir, 'runs'), RUN_ID);
  await mkdir(paths.root, { recursive: true });
  return paths;
}

function dispatch(trigger: InvocationTriggerKind): NewInvocationDispatch {
  return {
    identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
    trigger_kind: trigger,
    dispatch_committed_at: AT,
  } as NewInvocationDispatch;
}

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

/** Lignes réellement persistées, telles qu'elles sont sur le disque. */
async function persistedLines(file: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ==========================================================================
// A. Vocabulaire et modèle de version
// ==========================================================================

test('1 · une seule valeur nouvelle, et le vocabulaire v1 reste figé', () => {
  assert.deepEqual([...INVOCATION_TRIGGER_KINDS_V1], ['START', 'STEP', 'SEND', 'RECOVERY_CONTINUE']);
  assert.equal(CONTROVERSY_DETECTION_TRIGGER, 'CONTROVERSY_DETECTION');

  // V4-S6 : l'union globale s'est élargie d'une seconde valeur. Ce test garde
  // ce qui lui appartient — le vocabulaire de la VERSION 2 —, et non l'union
  // globale, qui grandira à chaque version. Ce que V3 avait établi reste vrai :
  // la v2 admet la v1 plus la détection, et rien d'autre.
  assert.deepEqual(
    [...invocationTriggerKindsFor(2)],
    ['START', 'STEP', 'SEND', 'RECOVERY_CONTINUE', 'CONTROVERSY_DETECTION'],
  );
  assert.equal(invocationTriggerKindsFor(2).length, INVOCATION_TRIGGER_KINDS_V1.length + 1);
  for (const forbidden of ['OTHER', 'CUSTOM', 'V3', 'UNKNOWN_TRIGGER', 'DETECTION']) {
    assert.equal((INVOCATION_TRIGGER_KINDS as readonly string[]).includes(forbidden), false, forbidden);
  }

  // La constante historique n'a PAS été bumpée, et la v2 non plus.
  assert.equal(INVOCATION_LEDGER_SCHEMA_VERSION, 1);
  assert.equal(INVOCATION_LEDGER_SCHEMA_VERSION_V2, 2);
  assert.ok(SUPPORTED_INVOCATION_LEDGER_SCHEMA_VERSIONS.includes(1));
  assert.ok(SUPPORTED_INVOCATION_LEDGER_SCHEMA_VERSIONS.includes(2));

  // Le vocabulaire dépend de la version, et chacune est additive.
  assert.deepEqual([...invocationTriggerKindsFor(1)], [...INVOCATION_TRIGGER_KINDS_V1]);

  for (const trigger of INVOCATION_TRIGGER_KINDS_V1) {
    assert.equal(invocationLedgerSchemaVersionFor(trigger), 1, trigger);
  }
  assert.equal(invocationLedgerSchemaVersionFor('CONTROVERSY_DETECTION'), 2);
});

test('2 · T9 — aucun déclencheur existant n’est réutilisé pour la détection', async () => {
  // Garde de source : les services qui engagent une invocation portent des
  // unions littérales étroites. Aucun ne PEUT émettre le nouveau déclencheur.
  const services = [
    'services/run-service.ts',
    'services/native-start-service.ts',
    'services/native-step-service.ts',
    'services/native-send-service.ts',
    'services/native-recovery-service.ts',
  ];
  for (const relative of services) {
    const code = await readFile(path.join(SRC, relative), 'utf8');
    assert.equal(
      code.includes('CONTROVERSY_DETECTION'),
      false,
      `${relative} n’émet pas le déclencheur de détection`,
    );
  }

  // Et réciproquement : le nouveau déclencheur ne se déguise pas en ancien —
  // il porte une valeur propre, absente du vocabulaire v1.
  assert.equal(
    (INVOCATION_TRIGGER_KINDS_V1 as readonly string[]).includes(CONTROVERSY_DETECTION_TRIGGER),
    false,
  );
});

// ==========================================================================
// B. Stratégie d'écriture — prouvée sur les lignes persistées
// ==========================================================================

test('3 · T2/T3 — le writer choisit la version d’après la charge', async () => {
  const dir = await makeTempDir('ccr-s6-write-');
  try {
    const paths = await runDir(dir);
    const ledger = await openInvocationLedger(paths, RUN_ID);

    for (const trigger of INVOCATION_TRIGGER_KINDS_V1) {
      const written = await ledger.append(dispatch(trigger));
      assert.equal(written.schema_version, 1, trigger);
    }
    const detection = await ledger.append(dispatch('CONTROVERSY_DETECTION'));
    assert.equal(detection.schema_version, 2);

    // Ce sont les OCTETS persistés qui font foi, pas la valeur rendue.
    const lines = await persistedLines(paths.invocations);
    assert.deepEqual(
      lines.map((line) => [line['trigger_kind'], line['schema_version']]),
      [
        ['START', 1],
        ['STEP', 1],
        ['SEND', 1],
        ['RECOVERY_CONTINUE', 1],
        ['CONTROVERSY_DETECTION', 2],
      ],
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('4 · T4/T5 — ledger mixte v1 → v2 → v1, et le writer ne devient pas monotone', async () => {
  const dir = await makeTempDir('ccr-s6-mixed-');
  try {
    const paths = await runDir(dir);
    const ledger = await openInvocationLedger(paths, RUN_ID);

    await ledger.append(dispatch('SEND'));
    await ledger.append(dispatch('CONTROVERSY_DETECTION'));
    // Le TROISIÈME est écrit APRÈS le v2, par le writer courant : c'est le
    // point qui prouve qu'aucune époque de fichier n'existe.
    const afterDetection = await ledger.append(dispatch('SEND'));
    assert.equal(afterDetection.schema_version, 1, 'un SEND reste v1 après une détection');

    const lines = await persistedLines(paths.invocations);
    assert.deepEqual(lines.map((line) => line['schema_version']), [1, 2, 1]);

    // Le lecteur V3 rend les trois, dans l'ordre, chacun avec SA version.
    const reread = await openInvocationLedger(paths, RUN_ID);
    const records = await reread.readAll();
    assert.deepEqual(
      records.map((record) => [record.invocation_id, record.trigger_kind, record.schema_version]),
      [
        ['inv_000001', 'SEND', 1],
        ['inv_000002', 'CONTROVERSY_DETECTION', 2],
        ['inv_000003', 'SEND', 1],
      ],
    );

    // Une quatrième invocation ordinaire, sur un journal contenant déjà un v2.
    const fourth = await reread.append(dispatch('STEP'));
    assert.equal(fourth.schema_version, 1);
  } finally {
    await removeTempDir(dir);
  }
});

test('5 · T11 — lire ne réécrit rien : les octets sont inchangés', async () => {
  const dir = await makeTempDir('ccr-s6-nomigration-');
  try {
    const paths = await runDir(dir);
    const ledger = await openInvocationLedger(paths, RUN_ID);
    await ledger.append(dispatch('START'));
    await ledger.append(dispatch('CONTROVERSY_DETECTION'));

    const before = await readFile(paths.invocations, 'utf8');
    for (let i = 0; i < 3; i += 1) {
      const reader = await openInvocationLedger(paths, RUN_ID);
      assert.equal((await reader.readAll()).length, 2);
    }
    assert.equal(await readFile(paths.invocations, 'utf8'), before, 'aucune migration, aucun octet touché');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Analyse — matrice version × déclencheur
// ==========================================================================

test('6 · matrice version × déclencheur, à la lecture', () => {
  const base = {
    kind: 'DISPATCH_COMMITTED',
    invocation_id: 'inv_000001',
    run_id: RUN_ID,
    identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
    dispatch_committed_at: AT,
  };
  const record = (version: unknown, trigger: unknown): unknown => ({
    ...base,
    schema_version: version,
    trigger_kind: trigger,
  });

  // v1 + ancien déclencheur → accepté, et sa version est conservée.
  const v1old = validateInvocationDispatchRecord(record(1, 'SEND'));
  assert.equal(v1old.schema_version, 1);
  assert.equal(v1old.trigger_kind, 'SEND');

  // v1 + détection → REFUSÉ. L'admettre ferait échouer un lecteur V2.2 sur une
  // valeur d'énumération au lieu d'une version, ce que le contrat refuse.
  assert.throws(
    () => validateInvocationDispatchRecord(record(1, 'CONTROVERSY_DETECTION')),
    (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
  );

  // v2 + ancien déclencheur → ACCEPTÉ à la lecture. La v2 est additive : elle
  // n'a jamais rétréci un champ qu'elle élargit, et un lecteur ancien la refuse
  // déjà sur la VERSION, donc l'accepter ici ne coûte aucune garantie.
  const v2old = validateInvocationDispatchRecord(record(2, 'STEP'));
  assert.equal(v2old.schema_version, 2, 'sa propre version, jamais rabattue sur 1');
  assert.equal(v2old.trigger_kind, 'STEP');

  // v2 + détection → accepté.
  const v2new = validateInvocationDispatchRecord(record(2, 'CONTROVERSY_DETECTION'));
  assert.equal(v2new.schema_version, 2);
  assert.equal(v2new.trigger_kind, 'CONTROVERSY_DETECTION');

  // V4-S6 : la version 3 existe désormais, et elle est additive — elle admet
  // tout ce que la v2 admet. Ce que ce test garde reste la propriété V3 : un
  // enregistrement conserve SA version, jamais rabattue ni montée.
  const v3old = validateInvocationDispatchRecord(record(3, 'STEP'));
  assert.equal(v3old.schema_version, 3, 'sa propre version, jamais rabattue');
  const v3detection = validateInvocationDispatchRecord(record(3, 'CONTROVERSY_DETECTION'));
  assert.equal(v3detection.schema_version, 3);

  // V5-S13 : la version 4 existe à son tour, additive de la même façon. Le
  // fichier ne change pas de mission pour autant — il garde la propriété V3.
  const v4old = validateInvocationDispatchRecord(record(4, 'STEP'));
  assert.equal(v4old.schema_version, 4, 'sa propre version, jamais rabattue');
  const v4adduction = validateInvocationDispatchRecord(record(4, 'EVIDENCE_ADDUCTION'));
  assert.equal(v4adduction.schema_version, 4);

  // Et la frontière que V3 protégeait tient toujours : la v2 ne s'élargit pas
  // au déclencheur d'une version ultérieure.
  assert.throws(
    () => validateInvocationDispatchRecord(record(2, 'EVIDENCE_ADDUCTION')),
    (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    'la v2 refuse un déclencheur v3',
  );

  // La même frontière, une génération plus loin : la v3 ne s'élargit pas au
  // déclencheur v4. C'est exactement ce que ce fichier existe pour empêcher.
  assert.throws(
    () => validateInvocationDispatchRecord(record(3, 'RECONCILIATION_PROPOSAL')),
    (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    'la v3 refuse un déclencheur v4',
  );

  // T6 — version inconnue, quel que soit le déclencheur. La 4 en sort : elle
  // est prise en charge depuis V5-S13. La 5, elle, n'existe pas encore, et ce
  // test doit continuer à détecter le jour où elle apparaîtra.
  for (const version of [0, 5, 99, '2', null, undefined]) {
    assert.throws(
      () => validateInvocationDispatchRecord(record(version, 'SEND')),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
      `version ${String(version)}`,
    );
  }

  // T7 — déclencheur inconnu, dans les deux versions. Aucun sens inventé.
  for (const version of [1, 2]) {
    for (const trigger of ['HANDOFF', 'PAUSE', 'DETECTION', 'CONTROVERSY_FOUND', '']) {
      assert.throws(
        () => validateInvocationDispatchRecord(record(version, trigger)),
        (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
        `v${String(version)} + ${trigger}`,
      );
    }
  }
});

test('7 · T8 — la sémantique v1 refuse ce qu’un enregistrement v1 ne peut pas porter', async () => {
  const dir = await makeTempDir('ccr-s6-v1-boundary-');
  try {
    const paths = await runDir(dir);

    // La frontière v1 est portée par le parser versionné lui-même : sous la
    // version 1, le vocabulaire est celui figé par V2.2, et rien d'autre.
    await writeFile(
      paths.invocations,
      `${JSON.stringify({
        schema_version: 1,
        kind: 'DISPATCH_COMMITTED',
        invocation_id: 'inv_000001',
        run_id: RUN_ID,
        identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
        trigger_kind: 'CONTROVERSY_DETECTION',
        dispatch_committed_at: AT,
      })}\n`,
      'utf8',
    );
    await expectRejection(
      openInvocationLedger(paths, RUN_ID),
      'JOURNAL_INVALID',
      'détection sous une version 1',
    );

    // Et la règle d'admission qu'un runtime V2.2 portait — « la version doit
    // valoir INVOCATION_LEDGER_SCHEMA_VERSION » — reste constatable : elle
    // exclut toute ligne v2. Aucun ancien binaire n'est exécuté ici, et rien
    // ne le prétend.
    //
    // La comparaison passe par une liaison élargie à `number` : les deux
    // constantes sont typées par leur littéral, et un `===` direct serait rejeté
    // statiquement comme sans recouvrement. L'élargissement est **local au
    // test** — aucune constante de production n'est modifiée — et la garde reste
    // une garde : si les deux versions devenaient un jour égales, cette
    // assertion échouerait à l'exécution.
    const admittedByV22: number = INVOCATION_LEDGER_SCHEMA_VERSION;
    assert.equal(INVOCATION_LEDGER_SCHEMA_VERSION_V2 === admittedByV22, false);
  } finally {
    await removeTempDir(dir);
  }
});

test('8 · T6 — une version inconnue au milieu interdit une lecture complète', async () => {
  const dir = await makeTempDir('ccr-s6-unknown-');
  try {
    const paths = await runDir(dir);
    const line = (sequence: number, version: number, trigger: string): string =>
      JSON.stringify({
        schema_version: version,
        kind: 'DISPATCH_COMMITTED',
        invocation_id: `inv_${String(sequence).padStart(6, '0')}`,
        run_id: RUN_ID,
        identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
        trigger_kind: trigger,
        dispatch_committed_at: AT,
      });

    const content = `${line(1, 1, 'START')}\n${line(2, 7, 'START')}\n${line(3, 1, 'SEND')}\n`;
    await writeFile(paths.invocations, content, 'utf8');

    // Ni deux enregistrements, ni un : le journal est une autorité durable, et
    // une ligne non comprise interdit d'en prétendre une lecture complète.
    await expectRejection(openInvocationLedger(paths, RUN_ID), 'JOURNAL_INVALID', 'version inconnue médiane');
    assert.equal(await readFile(paths.invocations, 'utf8'), content, 'aucune réparation');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// D. Propagation, quota, et ce que S6 n'écrit pas
// ==========================================================================

test('9 · T10 — le read model expose le nouveau déclencheur tel quel', async () => {
  const dir = await makeTempDir('ccr-s6-readmodel-');
  try {
    const paths = await runDir(dir);
    const ledger = await openInvocationLedger(paths, RUN_ID);
    await ledger.append(dispatch('SEND'));
    await ledger.append(dispatch('CONTROVERSY_DETECTION'));

    const view = await readUsageReadModel(paths);

    assert.deepEqual(
      view.by_invocation.map((invocation) => invocation.trigger_kind),
      ['SEND', 'CONTROVERSY_DETECTION'],
    );

    // Le déclencheur est une RAISON, pas un résultat : la projection n'en
    // dérive aucun sens supplémentaire.
    const detection = view.by_invocation[1];
    assert.equal(detection?.provider_reported.state, 'UNOBSERVED', 'aucun usage n’est supposé connu');
    const serialized = JSON.stringify(view);
    for (const invented of ['controversy_found', 'detection_succeeded', 'no_disagreement', 'CONTROVERSY_FOUND']) {
      assert.equal(serialized.includes(invented), false, invented);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('10 · le quota compte des engagements, sans regarder le déclencheur', async () => {
  const dir = await makeTempDir('ccr-s6-quota-');
  try {
    const paths = await runDir(dir);
    const ledger = await openInvocationLedger(paths, RUN_ID);

    await ledger.append(dispatch('SEND'));
    assert.equal(ledger.count(), 1);
    await ledger.append(dispatch('CONTROVERSY_DETECTION'));
    assert.equal(ledger.count(), 2, 'une détection compte comme tout engagement');
    assert.equal(ledger.nextSequence(), 3, 'aucun espace d’identifiants nouveau');

    // Aucun quota par défaut n'est fabriqué : l'absence de politique reste
    // l'absence de politique.
    assert.equal(existsSync(paths.invocationPolicy), false);
  } finally {
    await removeTempDir(dir);
  }
});

test('11 · T12 — S6 n’écrit aucune controverse, et n’appelle aucun fournisseur', async () => {
  const dir = await makeTempDir('ccr-s6-absence-');
  try {
    const paths = await runDir(dir);
    const ledger = await openInvocationLedger(paths, RUN_ID);
    await ledger.append(dispatch('CONTROVERSY_DETECTION'));

    // Un enregistrement v2 ne prouve pas qu'une inférence existe.
    assert.equal(existsSync(paths.controversies), false, 'aucun journal de controverses');
    assert.equal(existsSync(paths.usage), false, 'aucune observation d’usage');

    // Garde de source : les deux modules mutés ne connaissent ni détecteur, ni
    // prompt, ni adapter, ni sortie de modèle.
    for (const relative of ['core/usage-governance.ts', 'store/invocation-ledger.ts']) {
      const code = (await readFile(path.join(SRC, relative), 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const forbidden of [
        'MODEL_ASSISTED',
        'controversy-detector',
        // `prompt_event_id` est un champ historique légitime : la garde vise la
        // CONSTRUCTION d'un prompt, pas la référence à un événement.
        'buildPrompt',
        'promptFor',
        'createAdapters',
        'spawn',
        'position_id',
        'CONVERGED',
        'confidence',
        'CONTROVERSY_FOUND',
        'DETECTION_SUCCEEDED',
        'NO_DISAGREEMENT',
      ]) {
        assert.equal(code.includes(forbidden), false, `${relative} : « ${forbidden} »`);
      }
    }
  } finally {
    await removeTempDir(dir);
  }
});
