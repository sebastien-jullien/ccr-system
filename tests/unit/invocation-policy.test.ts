/**
 * V2.2-IMP-07 — fondation de la politique de quota per-run.
 *
 * Ce slice ne refuse **rien**. Il établit un contrat, et deux distinctions que
 * tout le reste dépendra de ne jamais confondre :
 *
 * ```text
 * document absent      aucune politique de quota CCR — aucun refus futur
 * max_invocations = 0  politique valide — aucune invocation nouvelle permise
 * ```
 *
 * et :
 *
 * ```text
 * count()          nombre réel d'engagements
 * nextSequence()   curseur d'allocation — jamais un compte
 * ```
 *
 * Aucun fournisseur, aucun processus, aucune surface de modification.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import {
  INVOCATION_POLICY_SCHEMA_VERSION,
  invocationPolicyDocument,
  resolveInvocationPolicy,
  validateInvocationPolicyDocument,
} from '../../src/core/invocation-policy.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { computeRunRevision, readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import { computeNativeRunRevision, readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import { materializeRun, materializeNativeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';

const RUN = 'CCR-20260811-001';

async function box(prefix: string): Promise<{ runsDir: string; paths: RunPaths; cleanup(): Promise<void> }> {
  const dir = await makeTempDir(prefix);
  const runsDir = path.join(dir, 'runs');
  await mkdir(path.join(runsDir, RUN), { recursive: true });
  return { runsDir, paths: runPaths(runsDir, RUN), cleanup: () => removeTempDir(dir) };
}

function expectInvalid(action: () => unknown, what: string): void {
  assert.throws(
    action,
    (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_POLICY_INVALID',
    what,
  );
}

// ==========================================================================
// A. Le contrat
// ==========================================================================

test('1–3 · absence, zéro et limite positive sont trois faits distincts', async () => {
  const b = await box('ccr-policy-facts-');
  try {
    const store = openInvocationPolicyStore(b.paths);

    // 1 · aucun document : aucune politique. Pas `null`, pas `-1`, pas UNKNOWN.
    assert.equal(await store.read(), undefined);
    assert.deepEqual(await store.resolve(), { kind: 'NONE' });

    // 2 · zéro est une politique, et elle dit l'inverse de l'absence.
    const zero = await store.create(0);
    assert.deepEqual(zero, {
      schema_version: INVOCATION_POLICY_SCHEMA_VERSION,
      invocation_quota: { max_invocations: 0 },
    });
    assert.deepEqual(await store.resolve(), { kind: 'CONFIGURED', maxInvocations: 0 });
    assert.notDeepEqual(await store.resolve(), { kind: 'NONE' });
  } finally {
    await b.cleanup();
  }

  // 3 · une limite positive, relue telle quelle.
  const c = await box('ccr-policy-positive-');
  try {
    const store = openInvocationPolicyStore(c.paths);
    await store.create(5);
    assert.deepEqual(await store.resolve(), { kind: 'CONFIGURED', maxInvocations: 5 });
    const raw = JSON.parse(await readFile(c.paths.invocationPolicy, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), ['invocation_quota', 'schema_version']);
  } finally {
    await c.cleanup();
  }
});

test('4–6 · la validation ne convertit rien et n’ignore rien', () => {
  // 4 · négatif.
  expectInvalid(() => invocationPolicyDocument(-1), 'une limite négative est refusée');

  // 5 · non entier, et non nombre.
  for (const value of [1.5, '3', null, true, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expectInvalid(
      () =>
        validateInvocationPolicyDocument({
          schema_version: 1,
          invocation_quota: { max_invocations: value },
        }),
      `max_invocations = ${String(value)} est refusé`,
    );
  }

  // 6 · schéma inconnu, et schéma non entier.
  for (const version of [2, 0, '1', 1.5, undefined]) {
    expectInvalid(
      () =>
        validateInvocationPolicyDocument({
          schema_version: version,
          invocation_quota: { max_invocations: 1 },
        }),
      `schema_version = ${String(version)} est refusé`,
    );
  }

  // Structure : un champ étranger est refusé, jamais ignoré.
  expectInvalid(
    () =>
      validateInvocationPolicyDocument({
        schema_version: 1,
        invocation_quota: { max_invocations: 1, max_tokens: 100 },
      }),
    'une limite de jetons n’a rien à faire ici',
  );
  expectInvalid(
    () =>
      validateInvocationPolicyDocument({
        schema_version: 1,
        invocation_quota: { max_invocations: 1 },
        consumed: 2,
      }),
    '`consumed` est dérivé du journal, jamais persisté',
  );
  for (const shape of [[], 'texte', 42, null]) {
    expectInvalid(() => validateInvocationPolicyDocument(shape), 'le document doit être un objet');
  }
  expectInvalid(
    () => validateInvocationPolicyDocument({ schema_version: 1 }),
    'invocation_quota est obligatoire',
  );
});

test('7 · une politique corrompue n’est jamais requalifiée en politique absente', async () => {
  const b = await box('ccr-policy-corrupt-');
  try {
    const store = openInvocationPolicyStore(b.paths);

    await writeFile(b.paths.invocationPolicy, '{ ceci n’est pas du JSON', 'utf8');
    await assert.rejects(
      store.read(),
      (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_POLICY_INVALID',
    );
    await assert.rejects(store.resolve(), (error: unknown) => isCcrError(error));

    // Un document syntaxiquement correct mais non conforme lève de même.
    await writeFile(
      b.paths.invocationPolicy,
      JSON.stringify({ schema_version: 1, invocation_quota: { max_invocations: -3 } }),
      'utf8',
    );
    await assert.rejects(
      store.read(),
      (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_POLICY_INVALID',
    );
  } finally {
    await b.cleanup();
  }
});

test('8 · une politique établie n’est jamais écrasée en silence', async () => {
  const b = await box('ccr-policy-stable-');
  try {
    const store = openInvocationPolicyStore(b.paths);
    await store.create(3);
    const written = await readFile(b.paths.invocationPolicy, 'utf8');

    await assert.rejects(
      store.create(99),
      (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_POLICY_WRITE_FAILED',
    );

    // Ni la politique, ni son octet : V0.1 la traite comme stable.
    assert.equal(await readFile(b.paths.invocationPolicy, 'utf8'), written);
    assert.deepEqual(await store.resolve(), { kind: 'CONFIGURED', maxInvocations: 3 });

    // Une limite refusée ne touche jamais le disque.
    const c = await box('ccr-policy-refused-');
    try {
      await assert.rejects(
        openInvocationPolicyStore(c.paths).create(-2),
        (error: unknown) => isCcrError(error) && error.code === 'INVOCATION_POLICY_INVALID',
      );
      await assert.rejects(readFile(c.paths.invocationPolicy, 'utf8'));
    } finally {
      await c.cleanup();
    }
  } finally {
    await b.cleanup();
  }
});

// ==========================================================================
// B. Les deux générations, et la révision
// ==========================================================================

test('9–11 · additive sur les deux générations, et hors révision métier', async () => {
  const dir = await makeTempDir('ccr-policy-generations-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });

    const legacy = 'CCR-20260811-001';
    const native = 'CCR-20260811-002';
    await materializeRun(runsDir, {
      runId: legacy,
      events: [{ round: 0, actor: 'system', type: 'run_created', content: 'T', timestamp: T }],
    });
    await materializeNativeRun(runsDir, {
      runId: native,
      bindings: { author: 'codex', challenger: 'claude' },
    });

    // 9 · 10 · aucun des deux ne porte de politique — l'état normal.
    for (const runId of [legacy, native]) {
      assert.equal(await openInvocationPolicyStore(runPaths(runsDir, runId)).read(), undefined);
    }

    const before = {
      legacy: (await readStableRunSnapshot(runsDir, legacy)).revision,
      native: (await readStableNativeRunSnapshot(runsDir, native)).revision,
    };

    // Aucune migration : le document s'ajoute tel quel sur les deux.
    await openInvocationPolicyStore(runPaths(runsDir, legacy)).create(7);
    await openInvocationPolicyStore(runPaths(runsDir, native)).create(7);

    // 11 · la révision métier ignore la politique, dans les deux moteurs.
    const legacyAfter = await readStableRunSnapshot(runsDir, legacy);
    const nativeAfter = await readStableNativeRunSnapshot(runsDir, native);
    assert.equal(legacyAfter.revision, before.legacy);
    assert.equal(nativeAfter.revision, before.native);

    // Et les fonctions de révision elles-mêmes n'en prennent aucun paramètre.
    assert.equal(
      computeRunRevision({
        manifest: legacyAfter.manifest,
        state: legacyAfter.state,
        events: legacyAfter.events,
        decisions: legacyAfter.decisions,
      }),
      before.legacy,
    );
    assert.equal(
      computeNativeRunRevision(nativeAfter.manifest, nativeAfter.state, nativeAfter.events),
      before.native,
    );

    // La politique reste lisible après ces lectures.
    assert.deepEqual(await openInvocationPolicyStore(runPaths(runsDir, legacy)).resolve(), {
      kind: 'CONFIGURED',
      maxInvocations: 7,
    });
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Le compte des engagements
// ==========================================================================

test('12–13 · le compte vient des enregistrements, jamais du curseur', async () => {
  const b = await box('ccr-policy-count-');
  try {
    const empty = await openInvocationLedger(b.paths, RUN);
    assert.equal(empty.count(), 0);
    assert.equal(empty.nextSequence(), 1);

    for (const agent of ['claude', 'codex', 'claude'] as const) {
      await empty.append(
        {
          identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: agent, provider: agent },
          trigger_kind: 'STEP',
        },
        new Date(T),
      );
    }
    assert.equal(empty.count(), 3, 'trois engagements');
    assert.equal(empty.nextSequence(), 4);
    assert.equal((await empty.readAll()).length, 3);

    // Séquence strictement croissante mais NON contiguë : le journal reste
    // valide, et c'est exactement là que le curseur cesse d'être un compte.
    const c = await box('ccr-policy-count-gap-');
    try {
      const line = (id: string): string =>
        `${JSON.stringify({
          schema_version: 1,
          kind: 'DISPATCH_COMMITTED',
          invocation_id: id,
          run_id: RUN,
          identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'claude', provider: 'claude' },
          trigger_kind: 'STEP',
          dispatch_committed_at: T,
        })}\n`;
      await writeFile(c.paths.invocations, `${line('inv_000001')}${line('inv_000004')}`, 'utf8');

      const sparse = await openInvocationLedger(c.paths, RUN);
      assert.equal(sparse.count(), 2, 'deux engagements réels');
      assert.equal(sparse.nextSequence(), 5, 'le curseur suit le dernier identifiant');
      assert.notEqual(sparse.count(), sparse.nextSequence() - 1, 'les deux divergent');

      // Un nouvel engagement fait avancer les deux, chacun à sa façon.
      await sparse.append(
        {
          identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'codex', provider: 'codex' },
          trigger_kind: 'SEND',
        },
        new Date(T),
      );
      assert.equal(sparse.count(), 3);
      assert.equal(sparse.nextSequence(), 6);
    } finally {
      await c.cleanup();
    }
  } finally {
    await b.cleanup();
  }
});

// ==========================================================================
// D. Frontières — aucune application, aucune surface
// ==========================================================================

test('14–16 · la fondation ne touche ni les moteurs, ni les classifieurs, ni les surfaces', async () => {
  const executable = async (relative: string): Promise<string> => {
    const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  // 14 · les moteurs consultent la politique par le **seul** helper
  //      d'enforcement (V2.2-IMP-08), jamais le store ni le document.
  const producers = [
    'services/run-service.ts',
    'services/native-start-service.ts',
    'services/native-step-service.ts',
    'services/native-send-service.ts',
  ];
  for (const relative of producers) {
    const code = await executable(relative);
    assert.ok(code.includes('assertInvocationQuotaAvailable'), `${relative} contrôle la politique`);
    assert.equal(code.includes('max_invocations'), false, `${relative} ne lit aucune limite`);
  }

  // Seule la création d'un run natif touche le store de politique, et elle ne
  // fait que **poser** le document (V2.2-IMP-09). Le contrôle, lui, passe
  // toujours par le helper.
  const start = await executable('services/native-start-service.ts');
  assert.ok(start.includes('openInvocationPolicyStore'), 'la naissance pose la politique');
  assert.ok(start.includes(').create('), 'et rien de plus');
  assert.equal(start.includes('.resolve()'), false, 'elle ne lit pas la limite elle-même');
  for (const relative of [
    'services/run-service.ts',
    'services/native-step-service.ts',
    'services/native-send-service.ts',
    'services/native-recovery-service.ts',
  ]) {
    const code = await executable(relative);
    assert.equal(
      code.includes('openInvocationPolicyStore'),
      false,
      `${relative} ne touche pas le store de politique`,
    );
  }

  // 15 · les classifieurs et l'admission restent fondés sur les seuls faits
  //      métier : ils répondent « quelle action est possible », jamais « CCR
  //      l'autorise-t-il ».
  for (const relative of ['services/recovery-planner.ts', 'core/run-liveness.ts', 'cockpit/long-operations.ts']) {
    const code = await executable(relative);
    for (const forbidden of ['invocation-policy', 'InvocationPolicy', 'quota', 'Quota']) {
      assert.equal(code.includes(forbidden), false, `${relative} ignore ${forbidden}`);
    }
  }

  // Le classifieur d'initialisation natif reste lui aussi indépendant.
  const recovery = await executable('services/native-recovery-service.ts');
  const classifier = recovery.slice(
    recovery.indexOf('export function buildNativeInitializationView'),
    recovery.indexOf('async function loadNativeRun'),
  );
  for (const forbidden of ['Quota', 'invocation-policy', 'invocation-ledger']) {
    assert.equal(classifier.includes(forbidden), false, `le classifieur ignore ${forbidden}`);
  }

  // Le helper ne connaît ni usage, ni tarif, ni quota fournisseur.
  const helper = await executable('services/invocation-quota.ts');
  for (const forbidden of ['usage-ledger', 'UsageLedger', 'pricing', 'CostEstimate', 'tokens', 'nextSequence']) {
    assert.equal(helper.includes(forbidden), false, `le helper ignore ${forbidden}`);
  }
  assert.ok(helper.includes('count()'), 'le compte vient du journal');

  // 16 · la seule surface de politique est la **naissance** d'un run natif
  //      (V2.2-IMP-09). Rien ne permet d'en attacher une à un run existant, ni
  //      d'en modifier une : le schéma ne porte ni date d'effet ni consommation
  //      de référence, et une pose tardive perdrait la vérité historique.
  const cli = await executable('cli/main.ts');
  assert.ok(cli.includes("'max-invocations'"), 'la création accepte une limite');
  const http = await executable('cockpit/mutations-http.ts');
  assert.ok(http.includes("'max_invocations'"), 'la création HTTP aussi');

  for (const relative of [
    'cli/main.ts',
    'cockpit/mutations-http.ts',
    'cockpit/server.ts',
    'cockpit/web/api.js',
    'cockpit/web/render.js',
  ]) {
    const code = await executable(relative);
    for (const forbidden of [
      'openInvocationPolicyStore',
      'invocation-policy-store',
      'updateQuota',
      'replaceQuota',
      'setQuota',
    ]) {
      assert.equal(code.includes(forbidden), false, `${relative} n’expose pas ${forbidden}`);
    }
  }
  // Aucune commande ni route dédiée au quota.
  assert.equal(cli.includes("case 'quota'"), false);
  for (const route of ['/quota', 'quota:', 'QUOTA_ROUTES']) {
    assert.equal(http.includes(route), false, `aucune route ${route}`);
  }

  // Le store ne connaît toujours aucune mutation.
  const storeSurface = await executable('store/invocation-policy-store.ts');
  for (const forbidden of ['update', 'replace', 'delete', 'unlink(file']) {
    assert.equal(storeSurface.includes(forbidden), false, `le store sans ${forbidden}`);
  }

  // Le store de politique ne dépend d'aucun service, et les deux journaux ne
  // dépendent pas de lui.
  const store = await executable('store/invocation-policy-store.ts');
  assert.equal(store.includes('services/'), false, 'la fondation ignore le métier');
  assert.equal(store.includes('cockpit/'), false);
  for (const relative of ['store/invocation-ledger.ts', 'store/usage-ledger.ts']) {
    const code = await executable(relative);
    assert.equal(code.includes('invocation-policy'), false, `${relative} ignore la politique`);
  }

  // Le store de politique ne calcule aucun consommé : il lit une règle, et
  // n'a jamais entendu parler du journal qui, lui, compte.
  assert.equal(store.includes('invocation-ledger'), false, 'le store ne compte pas');
  assert.equal(store.includes('DISPATCH_COMMITTED'), false);

  // Ni tarif, ni coût, ni jetons dans la fondation.
  const policy = await executable('core/invocation-policy.ts');
  for (const forbidden of ['pricing', 'CostEstimate', 'tokens', 'currency', 'consumed', 'remaining']) {
    assert.equal(policy.includes(forbidden), false, `la politique ignore ${forbidden}`);
  }

  // Et `resolveInvocationPolicy` reste une projection pure.
  assert.deepEqual(resolveInvocationPolicy(undefined), { kind: 'NONE' });
  assert.deepEqual(resolveInvocationPolicy(invocationPolicyDocument(0)), {
    kind: 'CONFIGURED',
    maxInvocations: 0,
  });
});
