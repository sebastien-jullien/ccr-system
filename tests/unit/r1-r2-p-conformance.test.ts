/**
 * Conformance R1 / R2 / P — autorité normative `4170e25`.
 *
 * Question de preuve :
 *
 * > **Les trois contrats machine ratifiés rendent-ils exactement ce qu'ils
 * > promettent — y compris là où le produit interne dirait autre chose ?**
 *
 * L'inventaire de conformité est celui figé par la spécification. Chaque
 * identifiant y répond d'une vérité, et aucune n'est fondue dans une autre.
 *
 * L'amendement de découvrabilité (§ 2.3 de R1 et de R2, gelé en `ccbb8ed`)
 * ajoute la matrice de cas et ses trois discriminations :
 *
 * ```text
 * R1-DISCOVERABLE   une identité découvrable obtient TOUJOURS un document,
 *                   quelle que soit sa métadonnée de domaine
 * R1-NOTFOUND       seule une identité non découvrable fait échouer R1
 * R2-NOTFOUND       S1 échoue
 * R2-S2             S1 réussit, S2 reste indéterminée → échec de commande
 * R2-PF             S2 franchie, S3 échoue → fait rendu, code 0
 * MATRIX            les sept cas, pour les deux surfaces, d'un seul tenant
 * ```
 *
 * Les deux discriminations exigées par l'autorité y sont mécaniques, et non
 * déduites d'une sortie identique : `402` contre `404` sépare S1 de S2, `403`
 * contre `407` sépare S2 de S3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RunServiceDeps } from '../../src/services/run-service.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runCli } from '../../src/cli/main.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { initializeInvocationLedger, openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { INVOCATION_TRIGGER_KINDS } from '../../src/core/usage-governance.ts';
import type { InvocationTriggerKind } from '../../src/core/usage-governance.ts';
import { EXPERT_SLOT_IDS } from '../../src/core/expert.ts';
import {
  COCKPIT_OPERATION_IDS,
  NATIVE_OPERATION_SERVICE,
  operationEffect,
  providerProducingOperations,
} from '../../src/services/invocation-effect.ts';
import { materializeNativeRun, materializeRun } from '../helpers/run-fixture.ts';
import { isRunDiscoverable } from '../../src/services/run-existence.ts';
import { readRunOperationalState } from '../../src/services/run-operational-state-read.ts';
import { isCcrError } from '../../src/core/errors.ts';

const AT = '2026-09-08T10:00:00.000Z';
const RUN = 'CCR-20260908-777';
/**
 * Matrice de cas de l'autorité `ccbb8ed`.
 *
 * Aucune implémentation ne branche sur ces identifiants : ils ne servent qu'à
 * nommer, ici, des situations de stockage distinctes.
 */
const CASE = {
  /** Run natif valide et complet. */
  nativeValid: 'CCR-20260908-401',
  /** Répertoire découvrable, aucune métadonnée de domaine. */
  shell: 'CCR-20260908-402',
  /** Répertoire découvrable, métadonnée de domaine illisible. */
  unreadable: 'CCR-20260908-403',
  /** Identifiant bien formé qu'aucune énumération ne reconnaît. */
  absent: 'CCR-20260908-404',
  /** Génération native établie, état absent. */
  stateAbsent: 'CCR-20260908-406',
  /** Génération native établie, état illisible. */
  stateBroken: 'CCR-20260908-407',
  /** Génération légataire établie. */
  legacy: 'CCR-20260908-409',
} as const;

const NOT_JSON = '{ ceci n’est pas du JSON';

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  dispose(): Promise<void>;
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function harness(): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-r1r2p-'));
  return {
    runsDir,
    deps: { runsDir, now: () => new Date(AT) } as RunServiceDeps,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

async function cli(h: Harness, argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await runCli([...argv, '--runs-dir', h.runsDir], { io, deps: h.deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function accounting(h: Harness, runId = RUN): Promise<Record<string, unknown>> {
  const r = await cli(h, ['run-invocation-accounting', runId, '--format', 'json']);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out) as Record<string, unknown>;
}

async function operational(h: Harness, runId = RUN): Promise<Record<string, unknown>> {
  const r = await cli(h, ['run-operational-state', runId, '--format', 'json']);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out) as Record<string, unknown>;
}

const BINDINGS = { author: 'claude', challenger: 'codex' } as const;

/** Matérialise les sept situations de la matrice dans un magasin synthétique. */
async function materializeMatrix(h: Harness): Promise<void> {
  await materializeNativeRun(h.runsDir, {
    runId: CASE.nativeValid,
    bindings: BINDINGS,
    state: { next_step_source_slot: 'author', round: 1 },
  });

  // Découvrable, et rien d'autre : le répertoire seul.
  await mkdir(path.join(h.runsDir, CASE.shell), { recursive: true });

  // Découvrable, métadonnée de domaine présente mais illisible.
  await mkdir(path.join(h.runsDir, CASE.unreadable), { recursive: true });
  await writeFile(runPaths(h.runsDir, CASE.unreadable).manifest, NOT_JSON, 'utf8');

  await materializeNativeRun(h.runsDir, { runId: CASE.stateAbsent, bindings: BINDINGS });
  await rm(runPaths(h.runsDir, CASE.stateAbsent).state, { force: true });

  await materializeNativeRun(h.runsDir, { runId: CASE.stateBroken, bindings: BINDINGS });
  await writeFile(runPaths(h.runsDir, CASE.stateBroken).state, NOT_JSON, 'utf8');

  await materializeRun(h.runsDir, { runId: CASE.legacy });

  // CASE.absent n'est jamais matérialisé : c'est son cas.
}

/** Capture l'erreur d'une lecture qui doit échouer, et rend son code CCR. */
async function failureCode(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    assert.ok(isCcrError(error), 'une erreur CCR était attendue');
    return error.code;
  }
  assert.fail('la lecture aurait dû échouer');
}

/** Engage `count` invocations d'un déclencheur donné, par l'autorité réelle. */
async function commit(
  h: Harness,
  trigger: InvocationTriggerKind,
  count: number,
  runId = RUN,
): Promise<void> {
  const paths = runPaths(h.runsDir, runId);
  await initializeInvocationLedger(paths);
  const ledger = await openInvocationLedger(paths, runId);
  for (let i = 0; i < count; i += 1) {
    await ledger.append(
      {
        identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
        trigger_kind: trigger,
      },
      new Date(AT),
    );
  }
}

// ---------------------------------------------------------------------------
// R1
// ---------------------------------------------------------------------------

test('R1-01 · NONE et CONFIGURED(0) sont deux documents distincts', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, { runId: RUN, bindings: { author: 'claude', challenger: 'codex' } });
    const none = await accounting(h);
    assert.deepEqual(none['budget_policy'], { kind: 'NONE' });

    await openInvocationPolicyStore(runPaths(h.runsDir, RUN)).create(0);
    const zero = await accounting(h);
    assert.deepEqual(zero['budget_policy'], { kind: 'CONFIGURED', max_invocations: 0 });

    const raw = JSON.stringify(none);
    assert.equal(raw.includes('null'), false, 'aucune absence rendue à null');
    assert.equal(raw.includes('-1'), false);
    assert.equal(raw.includes('Infinity'), false);
    assert.equal(raw.includes('UNKNOWN'), false);
  } finally {
    await h.dispose();
  }
});

test('R1-02 · `consumed` est le compte d’engagements du journal, pas autre chose', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, { runId: RUN, bindings: { author: 'claude', challenger: 'codex' } });
    await commit(h, 'START', 2);
    await commit(h, 'STEP', 3);

    const ledger = await openInvocationLedger(runPaths(h.runsDir, RUN), RUN);
    const doc = await accounting(h);
    assert.equal(doc['consumed'], ledger.count(), 'consumed = InvocationLedger.count()');
    assert.equal(doc['consumed'], 5);
  } finally {
    await h.dispose();
  }
});

test('R1-03 · `remaining` dérive du maximum et du consommé, et n’existe que sous CONFIGURED', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, { runId: RUN, bindings: { author: 'claude', challenger: 'codex' } });
    await commit(h, 'STEP', 4);

    const unbounded = await accounting(h);
    assert.equal('remaining' in unbounded, false, 'aucun restant sans politique');
    assert.equal('exhausted' in unbounded, false);

    await openInvocationPolicyStore(runPaths(h.runsDir, RUN)).create(6);
    const bounded = await accounting(h);
    assert.equal(bounded['remaining'], 2);
    assert.equal(bounded['exhausted'], false);
  } finally {
    await h.dispose();
  }
});

test('R1-04 · PRE_LEDGER ne fuit aucun zéro historique', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, { runId: RUN, bindings: { author: 'claude', challenger: 'codex' } });
    await openInvocationPolicyStore(runPaths(h.runsDir, RUN)).create(16);

    const doc = await accounting(h);
    assert.equal(doc['coverage'], 'PRE_LEDGER');
    for (const key of ['consumed', 'remaining', 'exhausted', 'trigger_attribution']) {
      assert.equal(key in doc, false, `${key} doit être structurellement absent sous PRE_LEDGER`);
    }
    // La vue interne, elle, rend bien un zéro : c'est la projection publique qui
    // refuse de l'affirmer. Le contrat diverge délibérément de l'interne ici.
    const { readInvocationQuotaView } = await import('../../src/services/invocation-quota-read.ts');
    const internal = await readInvocationQuotaView(runPaths(h.runsDir, RUN));
    assert.equal(internal.consumed, 0);
    assert.equal(internal.coverage, 'PRE_LEDGER');
  } finally {
    await h.dispose();
  }
});

test('R1-05 · attribution dense · zéro exact · somme = consommé', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, { runId: RUN, bindings: { author: 'claude', challenger: 'codex' } });
    await commit(h, 'START', 2);
    await commit(h, 'STEP', 10);

    const doc = await accounting(h);
    const attribution = doc['trigger_attribution'] as Record<string, number>;
    assert.deepEqual(
      Object.keys(attribution).sort(),
      [...INVOCATION_TRIGGER_KINDS].sort(),
      'une entrée par déclencheur connu, sans exception',
    );
    assert.equal(attribution['START'], 2);
    assert.equal(attribution['STEP'], 10);
    assert.equal(attribution['SEND'], 0, 'un déclencheur sans engagement vaut zéro EXACT');
    assert.equal(
      Object.values(attribution).reduce((a, b) => a + b, 0),
      doc['consumed'],
      'somme des attributions = consommé',
    );
  } finally {
    await h.dispose();
  }
});

test('R1-06 · la part de START se lit sans dérivation inter-contrats', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, { runId: RUN, bindings: { author: 'claude', challenger: 'codex' } });
    await commit(h, 'START', 2);
    await commit(h, 'STEP', 10);

    const doc = await accounting(h);
    const attribution = doc['trigger_attribution'] as Record<string, number>;
    assert.equal(attribution['START'], 2, 'lue directement, jamais par 12 − 10');
  } finally {
    await h.dispose();
  }
});

test('R1-07 · politique ou journal illisible rend PROJECTION_FAILURE, jamais NONE ni zéro', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, { runId: RUN, bindings: { author: 'claude', challenger: 'codex' } });
    const paths = runPaths(h.runsDir, RUN);

    await writeFile(paths.invocationPolicy, '{ ceci n’est pas du JSON', 'utf8');
    const brokenPolicy = await accounting(h);
    assert.equal(brokenPolicy['projection_status'], 'PROJECTION_FAILURE');
    assert.equal('budget_policy' in brokenPolicy, false, 'aucune clé sous PROJECTION_FAILURE');

    await rm(paths.invocationPolicy, { force: true });
    await writeFile(paths.invocations, 'ligne illisible\n', 'utf8');
    const brokenLedger = await accounting(h);
    assert.equal(brokenLedger['projection_status'], 'PROJECTION_FAILURE');
    assert.equal('consumed' in brokenLedger, false);
  } finally {
    await h.dispose();
  }
});

test('R1-NOTFOUND · seule une identité NON DÉCOUVRABLE fait échouer la commande', async () => {
  const h = await harness();
  try {
    await materializeMatrix(h);
    const absent = await cli(h, ['run-invocation-accounting', CASE.absent, '--format', 'json']);

    assert.equal(absent.code, 1, 'échec de commande, jamais un document');
    assert.equal(absent.out, '', 'stdout exactement vide');
    assert.throws(
      () => JSON.parse(absent.out) as unknown,
      'aucun document analysable — ni abouti, ni partiel',
    );
    // Aucune valeur de domaine ne sert à représenter l'absence de sujet.
    for (const forbidden of ['projection_status', 'AVAILABLE', 'PRE_LEDGER', 'budget_policy', 'NONE']) {
      assert.equal(absent.out.includes(forbidden), false, `${forbidden} ne doit pas être rendu`);
    }
    // `absent.err` peut porter un diagnostic : son libellé n'est pas normatif,
    // et aucune assertion ne pèse dessus.
  } finally {
    await h.dispose();
  }
});

test('R1-DISCOVERABLE · toute identité découvrable obtient un document, et 402 ≠ 404', async () => {
  const h = await harness();
  try {
    await materializeMatrix(h);

    // L'autorité d'énumération est la même que celle de F1 : ce que l'inventaire
    // liste, R1 sait le servir. Le lien est vérifié, pas supposé.
    const inventory = await cli(h, ['list', '--format', 'json']);
    assert.equal(inventory.code, 0);
    const listed = (JSON.parse(inventory.out) as { runs: { run_id: string }[] }).runs.map(
      (entry) => entry.run_id,
    );
    assert.ok(listed.includes(CASE.shell), 'F1 reconnaît le répertoire nu comme découvrable');
    assert.ok(listed.includes(CASE.unreadable), 'F1 reconnaît l’identité à métadonnée illisible');
    assert.equal(listed.includes(CASE.absent), false, 'F1 ne connaît pas 404');

    // Aucune métadonnée de domaine n'est un préalable : les six identités
    // découvrables rendent toutes un document, sans exception de génération.
    for (const runId of [
      CASE.nativeValid,
      CASE.shell,
      CASE.unreadable,
      CASE.stateAbsent,
      CASE.stateBroken,
      CASE.legacy,
    ]) {
      const answered = await cli(h, ['run-invocation-accounting', runId, '--format', 'json']);
      assert.equal(answered.code, 0, `${runId} : ${answered.err}`);
      const doc = JSON.parse(answered.out) as Record<string, unknown>;
      assert.equal(doc['run_id'], runId);
      assert.equal(doc['projection_status'], 'AVAILABLE');
      // Les faits rendus ne dépendent QUE de la politique et du journal.
      assert.deepEqual(doc['budget_policy'], { kind: 'NONE' });
      assert.equal(doc['coverage'], 'PRE_LEDGER');
    }

    // La paire qui tomberait si « métadonnée absente » redevenait « run
    // introuvable » : même absence de manifest, deux issues opposées.
    assert.equal(await isRunDiscoverable(h.runsDir, CASE.shell), true, '402 est découvrable');
    assert.equal(await isRunDiscoverable(h.runsDir, CASE.absent), false, '404 ne l’est pas');
    const shell = await cli(h, ['run-invocation-accounting', CASE.shell, '--format', 'json']);
    const absent = await cli(h, ['run-invocation-accounting', CASE.absent, '--format', 'json']);
    assert.equal(shell.code, 0, '402 : la comptabilité est établie');
    assert.equal(absent.code, 1, '404 : aucun sujet');
    assert.notEqual(shell.code, absent.code, 'S1 sépare bien les deux');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

test('R2-01 · run de génération non native → NOT_APPLICABLE, distinct de tout le reste', async () => {
  const h = await harness();
  try {
    await materializeRun(h.runsDir, { runId: RUN });
    const doc = await operational(h);
    assert.equal(doc['projection_status'], 'NOT_APPLICABLE');
    assert.equal('native_state' in doc, false, 'aucun état natif fabriqué');
    assert.equal('terminal' in doc, false);
    assert.equal('control_owner' in doc, false);
    assert.equal('next_transfer_plan' in doc, false);
  } finally {
    await h.dispose();
  }
});

test('R2-02 · un plan disponible reste disponible quand le budget est épuisé', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, {
      runId: RUN,
      bindings: { author: 'claude', challenger: 'codex' },
      state: { next_step_source_slot: 'author', round: 1 },
    });
    const before = await operational(h);
    const planBefore = before['next_transfer_plan'] as Record<string, unknown>;

    await openInvocationPolicyStore(runPaths(h.runsDir, RUN)).create(1);
    await commit(h, 'STEP', 1);
    const acc = await accounting(h);
    assert.equal(acc['exhausted'], true, 'budget épuisé');

    const after = await operational(h);
    assert.deepEqual(
      after['next_transfer_plan'],
      planBefore,
      'le plan ne se filtre pas sur le quota : disponibilité ≠ engageable maintenant',
    );
  } finally {
    await h.dispose();
  }
});

test('R2-03 · aucune raison d’indisponibilité n’est exposée', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, {
      runId: RUN,
      bindings: { author: 'claude', challenger: 'codex' },
      state: { state: 'PAUSED', control: 'HUMAN' },
    });
    const doc = await operational(h);
    const plan = doc['next_transfer_plan'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(plan), ['available'], 'indisponible : la seule clé est `available`');
    const raw = JSON.stringify(doc);
    for (const leak of ['reason', 'REFUSED', 'NO_FURTHER_PRODUCTION_STEPS_INTENDED', 'RECOVERY_REQUIRED_']) {
      assert.equal(raw.includes(leak), false, `aucune raison ne doit fuir : ${leak}`);
    }
  } finally {
    await h.dispose();
  }
});

test('R2-04 · les neuf états publics sont rendus, et rien d’autre', async () => {
  const h = await harness();
  const states = [
    'READY',
    'RUNNING',
    'WAITING_AGENT',
    'WAITING_HUMAN',
    'PAUSED',
    'RECOVERY_REQUIRED',
    'FAILED_INITIALIZATION',
    'FAILED',
    'CLOSED',
  ] as const;
  try {
    for (const state of states) {
      const runId = `CCR-20260908-9${String(states.indexOf(state)).padStart(2, '0')}`;
      await materializeNativeRun(h.runsDir, {
        runId,
        bindings: { author: 'claude', challenger: 'codex' },
        state: { state },
      });
      const doc = await operational(h, runId);
      assert.equal(doc['native_state'], state, `état public ${state}`);
    }
  } finally {
    await h.dispose();
  }
});

test('R2-05 · CLOSED est le seul état terminal', async () => {
  const h = await harness();
  const states = [
    'READY',
    'RUNNING',
    'WAITING_AGENT',
    'WAITING_HUMAN',
    'PAUSED',
    'RECOVERY_REQUIRED',
    'FAILED_INITIALIZATION',
    'FAILED',
    'CLOSED',
  ] as const;
  try {
    for (const state of states) {
      const runId = `CCR-20260908-8${String(states.indexOf(state)).padStart(2, '0')}`;
      await materializeNativeRun(h.runsDir, {
        runId,
        bindings: { author: 'claude', challenger: 'codex' },
        state: { state },
      });
      const doc = await operational(h, runId);
      assert.equal(doc['terminal'], state === 'CLOSED', `terminalité de ${state}`);
    }
  } finally {
    await h.dispose();
  }
});

test('R2-06 · la propriété du contrôle ne se dérive pas de l’état', async () => {
  const h = await harness();
  try {
    const pairs = [
      { state: 'READY', control: 'HUMAN' },
      { state: 'PAUSED', control: 'AUTOMATION' },
      { state: 'RUNNING', control: 'HUMAN' },
      { state: 'CLOSED', control: 'AUTOMATION' },
    ] as const;
    for (const [index, pair] of pairs.entries()) {
      const runId = `CCR-20260908-7${String(index).padStart(2, '0')}`;
      await materializeNativeRun(h.runsDir, {
        runId,
        bindings: { author: 'claude', challenger: 'codex' },
        state: { state: pair.state, control: pair.control },
      });
      const doc = await operational(h, runId);
      assert.equal(doc['native_state'], pair.state);
      assert.equal(doc['control_owner'], pair.control, 'contrôle croisé avec l’état');
    }
  } finally {
    await h.dispose();
  }
});

test('R2-07 · aucun identifiant interne, session, fournisseur ni contenu ne traverse', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, {
      runId: RUN,
      bindings: { author: 'claude', challenger: 'codex' },
      state: { next_step_source_slot: 'author', round: 1 },
    });
    const doc = await operational(h);
    const raw = JSON.stringify(doc);
    for (const leak of ['session', 'claude', 'codex', 'evt_', 'envelope', 'payload', 'source_event_id']) {
      assert.equal(raw.includes(leak), false, `ne doit pas fuir : ${leak}`);
    }
    assert.deepEqual(
      Object.keys(doc).sort(),
      [
        'control_owner',
        'native_state',
        'next_transfer_plan',
        'projection_status',
        'run_id',
        'run_operational_state_contract_version',
        'run_operational_state_machine_representation_version',
        'terminal',
      ],
      'jeu de champs fermé',
    );
  } finally {
    await h.dispose();
  }
});

test('R2-NOTFOUND · S1 échoue — aucun sujet, aucun document', async () => {
  const h = await harness();
  try {
    await materializeMatrix(h);
    const absent = await cli(h, ['run-operational-state', CASE.absent, '--format', 'json']);

    assert.equal(absent.code, 1, 'échec de commande, jamais un document');
    assert.equal(absent.out, '', 'stdout exactement vide');
    assert.throws(
      () => JSON.parse(absent.out) as unknown,
      'aucun document analysable — ni abouti, ni partiel',
    );
    // Ni l'un ni l'autre des deux statuts non disponibles ne sert à représenter
    // une absence de sujet.
    for (const forbidden of ['projection_status', 'NOT_APPLICABLE', 'PROJECTION_FAILURE', 'native_state']) {
      assert.equal(absent.out.includes(forbidden), false, `${forbidden} ne doit pas être rendu`);
    }
    // `absent.err` peut porter un diagnostic : son libellé n'est pas normatif.

    assert.equal(
      await failureCode(() => readRunOperationalState(h.deps, CASE.absent)),
      'RUN_NOT_FOUND',
      'l’échec est bien celui de S1',
    );
  } finally {
    await h.dispose();
  }
});

test('R2-S2 · S1 réussit, S2 reste indéterminée — la commande échoue sans rien affirmer', async () => {
  const h = await harness();
  try {
    await materializeMatrix(h);

    for (const runId of [CASE.shell, CASE.unreadable]) {
      // S1 est franchi : l'identité est découvrable, et l'autorité le dit.
      assert.equal(await isRunDiscoverable(h.runsDir, runId), true, `${runId} est découvrable`);

      // S2 ne l'est pas — et c'est un échec de S2, pas de S1. La distinction est
      // mécanique : le code diffère de celui d'une identité non découvrable.
      assert.equal(
        await failureCode(() => readRunOperationalState(h.deps, runId)),
        'NATIVE_APPLICABILITY_NOT_ESTABLISHED',
        `${runId} : S1 franchi, S2 indéterminée`,
      );

      const seen = await cli(h, ['run-operational-state', runId, '--format', 'json']);
      assert.equal(seen.code, 1, 'aucune projection n’est rendue');
      assert.equal(seen.out, '', 'stdout exactement vide');
      for (const forbidden of ['projection_status', 'NOT_APPLICABLE', 'PROJECTION_FAILURE', 'UNAVAILABLE']) {
        assert.equal(seen.out.includes(forbidden), false, `${forbidden} ne doit pas être rendu`);
      }
    }

    // 402 contre 404 : même code de sortie public, deux chemins sémantiques
    // distincts. Ce test tombe si S1 et S2 sont de nouveau confondus.
    assert.notEqual(
      await failureCode(() => readRunOperationalState(h.deps, CASE.shell)),
      await failureCode(() => readRunOperationalState(h.deps, CASE.absent)),
      'un run découvrable ne doit jamais être déclaré introuvable',
    );
  } finally {
    await h.dispose();
  }
});

test('R2-PF · S2 franchie, S3 échoue — le fait est rendu, et 403 ≠ 407', async () => {
  const h = await harness();
  try {
    await materializeMatrix(h);

    // Le manifest établit l'applicabilité native. C'est l'état qui manque, ou
    // qui est illisible : l'échec appartient à S3, et reste un fait rendu.
    for (const runId of [CASE.stateAbsent, CASE.stateBroken]) {
      const seen = await cli(h, ['run-operational-state', runId, '--format', 'json']);
      assert.equal(seen.code, 0, `${runId} : un empêchement de projection reste un succès de commande`);
      const doc = JSON.parse(seen.out) as Record<string, unknown>;
      assert.equal(doc['projection_status'], 'PROJECTION_FAILURE');
      assert.equal('native_state' in doc, false, 'aucun état fabriqué sous PROJECTION_FAILURE');
    }

    // La paire qui tombe si S2 et S3 sont confondus : même illisibilité, deux
    // étages différents, deux issues opposées.
    const indeterminate = await cli(h, ['run-operational-state', CASE.unreadable, '--format', 'json']);
    const projectionFailed = await cli(h, ['run-operational-state', CASE.stateBroken, '--format', 'json']);
    assert.equal(indeterminate.code, 1, '403 : applicabilité non établie → aucun document');
    assert.equal(indeterminate.out, '');
    assert.equal(projectionFailed.code, 0, '407 : applicabilité établie → un document');
    assert.equal(
      (JSON.parse(projectionFailed.out) as Record<string, unknown>)['projection_status'],
      'PROJECTION_FAILURE',
    );

    // Et l'autre bord, côté R1 : ces deux mêmes runs restent comptables.
    for (const runId of [CASE.unreadable, CASE.stateBroken]) {
      const accounting = await cli(h, ['run-invocation-accounting', runId, '--format', 'json']);
      assert.equal(accounting.code, 0);
      assert.equal(
        (JSON.parse(accounting.out) as Record<string, unknown>)['coverage'],
        'PRE_LEDGER',
        'un run découvrable sans journal garde sa couverture PRE_LEDGER',
      );
    }
  } finally {
    await h.dispose();
  }
});

test('MATRIX · les sept cas de l’autorité, pour les deux surfaces', async () => {
  const h = await harness();
  try {
    await materializeMatrix(h);

    // `null` = échec de commande attendu, sans document.
    const expected: readonly [string, string | null, string | null][] = [
      [CASE.nativeValid, 'AVAILABLE', 'AVAILABLE'],
      [CASE.shell, 'AVAILABLE', null],
      [CASE.unreadable, 'AVAILABLE', null],
      [CASE.absent, null, null],
      [CASE.stateAbsent, 'AVAILABLE', 'PROJECTION_FAILURE'],
      [CASE.stateBroken, 'AVAILABLE', 'PROJECTION_FAILURE'],
      [CASE.legacy, 'AVAILABLE', 'NOT_APPLICABLE'],
    ];

    for (const [runId, r1, r2] of expected) {
      const accounting = await cli(h, ['run-invocation-accounting', runId, '--format', 'json']);
      if (r1 === null) {
        assert.equal(accounting.code, 1, `R1 ${runId} : échec de commande`);
        assert.equal(accounting.out, '', `R1 ${runId} : stdout vide`);
      } else {
        assert.equal(accounting.code, 0, `R1 ${runId} : ${accounting.err}`);
        assert.equal(
          (JSON.parse(accounting.out) as Record<string, unknown>)['projection_status'],
          r1,
          `R1 ${runId}`,
        );
      }

      const operational = await cli(h, ['run-operational-state', runId, '--format', 'json']);
      if (r2 === null) {
        assert.equal(operational.code, 1, `R2 ${runId} : échec de commande`);
        assert.equal(operational.out, '', `R2 ${runId} : stdout vide`);
      } else {
        assert.equal(operational.code, 0, `R2 ${runId} : ${operational.err}`);
        assert.equal(
          (JSON.parse(operational.out) as Record<string, unknown>)['projection_status'],
          r2,
          `R2 ${runId}`,
        );
      }
    }
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// P
// ---------------------------------------------------------------------------

test('P-01 · les six effets publiés sont exactement ceux ratifiés', async () => {
  const h = await harness();
  try {
    const r = await cli(h, ['operation-effects', '--format', 'json']);
    assert.equal(r.code, 0, r.err);
    const doc = JSON.parse(r.out) as { operations: readonly Record<string, unknown>[] };
    const byId = new Map(doc.operations.map((o) => [o['operation'] as string, o]));
    assert.deepEqual(
      [...byId.keys()],
      ['START', 'STEP', 'SEND', 'PAUSE', 'RESUME', 'HANDOFF'],
      'vocabulaire fermé de la représentation 1',
    );
    assert.deepEqual(byId.get('START'), {
      operation: 'START',
      may_call_provider: 'YES',
      invocation_effect: { kind: 'AT_MOST', count: 2 },
    });
    for (const id of ['STEP', 'SEND']) {
      assert.deepEqual(byId.get(id)?.['invocation_effect'], { kind: 'EXACT', count: 1 }, id);
      assert.equal(byId.get(id)?.['may_call_provider'], 'YES', id);
    }
    for (const id of ['PAUSE', 'RESUME']) {
      assert.deepEqual(byId.get(id)?.['invocation_effect'], { kind: 'EXACT', count: 0 }, id);
      assert.equal(byId.get(id)?.['may_call_provider'], 'NO', id);
    }
    assert.deepEqual(byId.get('HANDOFF'), {
      operation: 'HANDOFF',
      may_call_provider: 'NOT_AVAILABLE',
      invocation_effect: { kind: 'UNKNOWN' },
    });
  } finally {
    await h.dispose();
  }
});

test('P-02 · la commande répond sans run, et refuse un identifiant de run', async () => {
  const h = await harness();
  try {
    const ok = await cli(h, ['operation-effects', '--format', 'json']);
    assert.equal(ok.code, 0, 'aucun run n’est requis');
    assert.equal(ok.out.length > 0, true);

    const refused = await cli(h, ['operation-effects', '--format', 'json', RUN]);
    assert.equal(refused.code, 2, 'un positionnel est refusé, jamais ignoré');
    assert.equal(refused.out, '', 'aucun document sur stdout en cas d’erreur d’usage');
  } finally {
    await h.dispose();
  }
});

test('P-03 · la projection consomme la primitive canonique, sans table recopiée', async () => {
  const h = await harness();
  try {
    const r = await cli(h, ['operation-effects', '--format', 'json']);
    const doc = JSON.parse(r.out) as { operations: readonly Record<string, unknown>[] };
    for (const entry of doc.operations) {
      const canonical = operationEffect(entry['operation'] as (typeof COCKPIT_OPERATION_IDS)[number]);
      assert.equal(entry['may_call_provider'], canonical.may_call_provider);
      assert.deepEqual(
        entry['invocation_effect'],
        canonical.invocation_effect.kind === 'UNKNOWN'
          ? { kind: 'UNKNOWN' }
          : { kind: canonical.invocation_effect.kind, count: canonical.invocation_effect.count },
        `${String(entry['operation'])} projette la primitive`,
      );
    }
  } finally {
    await h.dispose();
  }
});

test('P-04 · anti-dérive NUMÉRIQUE entre cardinalité publiée et cardinalité d’exécution', async () => {
  // Anti-dérive NUMÉRIQUE, par invariant mécanique (option B du contrat P § 9.2).
  //
  // La primitive publie un littéral, et c'est délibéré : une garde
  // architecturale du dépôt interdit à `invocation-effect.ts` — service de
  // présentation, non moteur natif — d'importer le modèle de créneaux. La
  // liaison entre la cardinalité publiée et la cardinalité d'exécution est donc
  // établie ICI, mécaniquement, plutôt que par partage de source.
  //
  // Sensibilité exigée par le contrat, dans les deux sens :
  //   créneaux 2 → 3   la cardinalité attendue devient 3, le littéral 2 échoue
  //   site d'engagement ajouté   le produit site × multiplicité change, et échoue
  const start = operationEffect('START');
  assert.equal(start.invocation_effect.kind, 'AT_MOST');
  assert.equal(
    start.invocation_effect.kind === 'AT_MOST' ? start.invocation_effect.count : -1,
    EXPERT_SLOT_IDS.length,
    'la cardinalité publiée de START doit égaler le nombre de créneaux que START peut lancer',
  );

  // Second verrou, celui qui attrape un changement d'exécution : pour chaque
  // opération qui peut appeler un fournisseur, le nombre de SITES d'engagement
  // de son service doit correspondre à la cardinalité publiée.
  //
  //   STEP · SEND   un site  → EXACT(1)
  //   START         un site, exécuté PAR CRÉNEAU → AT_MOST(EXPERT_SLOT_IDS.length)
  //
  // Un second site d'engagement ajouté à STEP porterait le compte à 2, et cette
  // assertion échouerait contre EXACT(1). Un site ajouté à START porterait sa
  // cardinalité réelle à 2 × créneaux, et l'assertion échouerait de même.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const servicesDir = path.resolve(here, '..', '..', 'src', 'services');
  const perOperationSlotMultiplicity: Readonly<Record<string, number>> = {
    START: EXPERT_SLOT_IDS.length,
  };

  for (const operation of providerProducingOperations()) {
    const source = await readFile(path.join(servicesDir, NATIVE_OPERATION_SERVICE[operation]), 'utf8');
    const callSites = source
      .split('\n')
      .filter((line) => line.includes('assertInvocationQuotaAvailable(') && !line.trimStart().startsWith('import'))
      .length;
    assert.equal(callSites > 0, true, `${operation} doit porter au moins un site d'engagement`);

    const effect = operationEffect(operation).invocation_effect;
    assert.notEqual(effect.kind, 'UNKNOWN', `${operation} publie une cardinalité finie`);
    const published = effect.kind === 'UNKNOWN' ? -1 : effect.count;
    const multiplicity = perOperationSlotMultiplicity[operation] ?? 1;
    assert.equal(
      published,
      callSites * multiplicity,
      `dérive numérique sur ${operation} : ${String(callSites)} site(s) × ${String(multiplicity)} ` +
        `≠ cardinalité publiée ${String(published)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// X — compatibilité des contrats existants
// ---------------------------------------------------------------------------

test('X-01 · les contrats publics existants rendent des documents inchangés', async () => {
  const h = await harness();
  try {
    await materializeNativeRun(h.runsDir, {
      runId: RUN,
      bindings: { author: 'claude', challenger: 'codex' },
      state: { next_step_source_slot: 'author', round: 1 },
    });

    const inventory = await cli(h, ['list', '--format', 'json']);
    assert.equal(inventory.code, 0);
    const inv = JSON.parse(inventory.out) as Record<string, unknown>;
    assert.deepEqual(Object.keys(inv).sort(), ['run_inventory_contract_version', 'runs']);
    assert.equal(inv['run_inventory_contract_version'], 1);

    const descriptors = await cli(h, ['run-descriptors', '--format', 'json']);
    assert.equal(descriptors.code, 0);
    const desc = JSON.parse(descriptors.out) as { runs: readonly Record<string, unknown>[] };
    assert.deepEqual(Object.keys(desc.runs[0] ?? {}).sort(), ['run_id', 'title']);

    const rep1 = await cli(h, ['run-activity', RUN, '--format', 'json']);
    assert.equal(rep1.code, 0);
    const a1 = JSON.parse(rep1.out) as Record<string, unknown>;
    assert.equal(a1['durable_run_activity_machine_representation_version'], 1);
    assert.equal('production_intent' in a1, false, 'rep 1 ne porte pas production_intent');

    const rep2 = await cli(h, [
      'run-activity',
      RUN,
      '--format',
      'json',
      '--machine-representation-version',
      '2',
    ]);
    assert.equal(rep2.code, 0);
    const a2 = JSON.parse(rep2.out) as Record<string, unknown>;
    assert.equal(a2['durable_run_activity_machine_representation_version'], 2);

    const outcomes = await cli(h, ['invocation-outcomes', RUN, '--format', 'json']);
    assert.equal(outcomes.code, 0);
    const oc = JSON.parse(outcomes.out) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(oc).sort(),
      ['facts', 'machine_representation_version', 'run_id', 'semantic_contract_version'],
    );
    assert.deepEqual(oc['facts'], [], 'un tableau vide reste une cardinalité');
  } finally {
    await h.dispose();
  }
});
