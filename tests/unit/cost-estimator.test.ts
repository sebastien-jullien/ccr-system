/**
 * V2.2-IMP-12 — estimation de coût, par invocation.
 *
 * Trois propriétés portent tout le reste.
 *
 *  1. **Les raisons ont un ordre.** Une invocation dont l'usage est ambigu est
 *     `USAGE_UNKNOWN` même sans catalogue : répondre « pas de tarif »
 *     laisserait croire qu'un tarif suffirait à l'estimer.
 *  2. **Le modèle ne se devine pas.** Sans `resolved_model` observé, aucune
 *     règle n'est choisie — pas même lorsque le catalogue n'en contient qu'une
 *     pour ce moteur. C'est l'état normal de Codex.
 *  3. **Absent n'est pas gratuit.** Une catégorie observée qu'aucune règle ne
 *     tarife rend l'estimation impossible ; une catégorie à `"0"` est tarifée,
 *     et vaut zéro.
 *
 * ## Aucun tarif réel
 *
 * Tous les catalogues de ce fichier sont **synthétiques** : versions `TEST-*`,
 * modèles `fixture-*`, provenance `TEST_FIXTURE_ONLY`, devise `XTS` — le code
 * ISO réservé aux tests. Aucun nombre n'y décrit le tarif d'un fournisseur
 * réel, et aucun n'a été recherché.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import { PRICING_CATALOG_SCHEMA_VERSION, validatePricingCatalog } from '../../src/core/pricing-catalog.ts';
import type { UsageModel, UsageObservation, UsageTokens } from '../../src/core/usage.ts';
import { estimateInvocationCost } from '../../src/services/cost-estimator.ts';
import type { CostEstimate } from '../../src/services/cost-estimator.ts';
import { readCostEstimateReadModel } from '../../src/services/cost-estimate-read-model.ts';
import type { CostEstimateReadModel } from '../../src/services/cost-estimate-read-model.ts';
import { costLine } from '../../src/cli/format.ts';
import { costSummary } from '../../src/cli/native-format.ts';
import type { UsageInvocationView } from '../../src/services/usage-read-model.ts';
import type { CurrentPricingCatalog } from '../../src/store/pricing-catalog-store.ts';
import { pricingCatalogPaths } from '../../src/store/pricing-catalog-store.ts';
import { initializeInvocationLedger, openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openUsageLedger } from '../../src/store/usage-ledger.ts';
import { runPaths } from '../../src/store/layout.ts';
import { CCR_ROOT } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const AT = '2026-08-12T00:00:00.000Z';
const RUN = 'CCR-20260812-001';

const TEST_SOURCE = {
  identifier: 'TEST_FIXTURE_ONLY',
  reference: 'TEST_FIXTURE_ONLY',
  declared_at: AT,
};

type Rule = { provider: string; model: string; usage_category: string; rate: string; unit_scale: number };

/** Catalogue synthétique. Aucun de ces nombres n'est un tarif. */
function catalogOf(entries: readonly Rule[], over: Record<string, unknown> = {}): CurrentPricingCatalog {
  return {
    kind: 'CONFIGURED',
    catalog: validatePricingCatalog({
      schema_version: PRICING_CATALOG_SCHEMA_VERSION,
      catalog_version: 'TEST-COST-V1',
      currency: 'XTS',
      source: { ...TEST_SOURCE },
      entries,
      ...over,
    }),
  };
}

const NONE: CurrentPricingCatalog = { kind: 'NONE' };

function claudeRule(category: string, rate: string, unitScale = 1): Rule {
  return { provider: 'claude', model: 'fixture-claude-model', usage_category: category, rate, unit_scale: unitScale };
}

const CLAUDE_MODEL: UsageModel = { source: 'PROVIDER_REPORTED', resolved_model: 'fixture-claude-model' };

function claudeTokens(over: Partial<Record<string, number | null>> = {}): UsageTokens {
  return {
    provider: 'claude',
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 8,
    ...over,
  } as UsageTokens;
}

/** Vue d'invocation, telle qu'IMP-10 la rend. */
function view(over: {
  readonly id?: string;
  readonly provider?: 'claude' | 'codex';
  readonly state?: 'UNOBSERVED' | 'OBSERVED' | 'AMBIGUOUS';
  readonly observation?: Partial<UsageObservation> & { readonly provider_reported_cost?: unknown };
} = {}): UsageInvocationView {
  const provider = over.provider ?? 'claude';
  const state = over.state ?? 'OBSERVED';
  const observation =
    state === 'OBSERVED'
      ? {
          schema_version: 1,
          usage_observation_id: 'usage_000001',
          invocation_id: over.id ?? 'inv_000001',
          run_id: RUN,
          observed_at: AT,
          provenance: 'PROVIDER_REPORTED' as const,
          model: CLAUDE_MODEL,
          tokens: claudeTokens(),
          ...over.observation,
        }
      : undefined;

  return {
    invocation_id: over.id ?? 'inv_000001',
    trigger_kind: 'STEP',
    identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: provider, provider },
    provider,
    provider_reported: {
      state,
      ...(observation === undefined ? {} : { observation: observation as never }),
    },
    ccr_measured: { state: 'OBSERVED', ccr_elapsed_ms: 10, exit_code: 0 },
  };
}

function known(estimate: CostEstimate): Extract<CostEstimate, { status: 'KNOWN' }> {
  assert.equal(estimate.status, 'KNOWN', `attendu KNOWN, reçu ${JSON.stringify(estimate)}`);
  if (estimate.status !== 'KNOWN') throw new Error('KNOWN attendu');
  return estimate;
}

function reasonOf(estimate: CostEstimate): string {
  assert.equal(estimate.status, 'UNKNOWN', `attendu UNKNOWN, reçu ${JSON.stringify(estimate)}`);
  if (estimate.status !== 'UNKNOWN') throw new Error('UNKNOWN attendu');
  return estimate.unknown_reason;
}

// ==========================================================================
// A. Priorité des raisons
// ==========================================================================

test('1–7 · les quatre raisons, dans un ordre déterministe', () => {
  const full = catalogOf([
    claudeRule('input_tokens', '1'),
    claudeRule('output_tokens', '1'),
    claudeRule('cache_creation_input_tokens', '1'),
    claudeRule('cache_read_input_tokens', '1'),
  ]);

  // 1 · usage non observé, catalogue absent : c'est l'usage qui manque.
  assert.equal(reasonOf(estimateInvocationCost(view({ state: 'UNOBSERVED' }), NONE, AT)), 'USAGE_UNKNOWN');
  // 2 · usage ambigu, catalogue complet : la raison ne change pas.
  assert.equal(reasonOf(estimateInvocationCost(view({ state: 'AMBIGUOUS' }), full, AT)), 'USAGE_UNKNOWN');

  // 3 · modèle non rapporté, catalogue absent : c'est le modèle qui manque.
  const notReported = view({ observation: { model: { source: 'UNKNOWN', reason: 'NOT_REPORTED' } } });
  assert.equal(reasonOf(estimateInvocationCost(notReported, NONE, AT)), 'MODEL_UNKNOWN');
  // 4 · modèle ambigu, tarif disponible : toujours le modèle.
  const ambiguousModel = view({
    observation: { model: { source: 'UNKNOWN', reason: 'AMBIGUOUS_MULTIPLE_MODELS' } },
  });
  assert.equal(reasonOf(estimateInvocationCost(ambiguousModel, full, AT)), 'MODEL_UNKNOWN');

  // 5 · usage et modèle connus, aucun catalogue.
  const noCatalog = estimateInvocationCost(view(), NONE, AT);
  assert.equal(reasonOf(noCatalog), 'PRICING_UNKNOWN');
  assert.equal(
    noCatalog.status === 'UNKNOWN' ? noCatalog.model : undefined,
    'fixture-claude-model',
    'ce qui est certain reste exposé',
  );

  // 6 · catalogue présent, mais aucune règle pour ce couple exact.
  const otherModel = catalogOf([{ ...claudeRule('input_tokens', '1'), model: 'fixture-autre-model' }]);
  assert.equal(reasonOf(estimateInvocationCost(view(), otherModel, AT)), 'PRICING_UNKNOWN');
  // Ni joker, ni défaut de fournisseur : un autre moteur ne prête pas sa règle.
  const codexOnly = catalogOf([
    { provider: 'codex', model: 'fixture-claude-model', usage_category: 'input_tokens', rate: '1', unit_scale: 1 },
  ]);
  assert.equal(reasonOf(estimateInvocationCost(view(), codexOnly, AT)), 'PRICING_UNKNOWN');

  // 7 · règle sélectionnée, forme incompatible.
  const partial = catalogOf([claudeRule('input_tokens', '1')]);
  assert.equal(reasonOf(estimateInvocationCost(view(), partial, AT)), 'UNSUPPORTED_USAGE_SHAPE');
});

// ==========================================================================
// B. Matrice forme × règle
// ==========================================================================

test('8–12 · les quatre cas de la matrice, et le taux zéro', () => {
  // 8 · valeur connue + règle présente → calculée.
  const complete = catalogOf([
    claudeRule('input_tokens', '1'),
    claudeRule('output_tokens', '1'),
    claudeRule('cache_creation_input_tokens', '1'),
    claudeRule('cache_read_input_tokens', '1'),
  ]);
  const all = known(estimateInvocationCost(view(), complete, AT));
  assert.deepEqual(all.usage_basis, [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ]);
  assert.equal(all.amount, '24', '10 + 2 + 4 + 8');

  // 9 · valeur connue + règle absente → la supposer gratuite inventerait un prix.
  assert.equal(reasonOf(estimateInvocationCost(view(), catalogOf([claudeRule('input_tokens', '1')]), AT)), 'UNSUPPORTED_USAGE_SHAPE');

  // 10 · valeur inconnue + règle présente → le montant serait incomplet.
  const missingValue = view({
    observation: { tokens: claudeTokens({ cache_read_input_tokens: null }) },
  });
  assert.equal(reasonOf(estimateInvocationCost(missingValue, complete, AT)), 'UNSUPPORTED_USAGE_SHAPE');

  // 11 · valeur inconnue + règle absente → la catégorie n'est pas employée.
  const trimmed = catalogOf([
    claudeRule('input_tokens', '1'),
    claudeRule('output_tokens', '1'),
    claudeRule('cache_creation_input_tokens', '1'),
  ]);
  const skipped = known(estimateInvocationCost(missingValue, trimmed, AT));
  assert.deepEqual(skipped.usage_basis, [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
  ]);
  assert.equal(skipped.amount, '16');

  // 12 · taux zéro explicite : catégorie tarifée, terme nul, base tracée.
  const free = catalogOf([
    claudeRule('input_tokens', '1'),
    claudeRule('output_tokens', '0'),
    claudeRule('cache_creation_input_tokens', '0.0'),
    claudeRule('cache_read_input_tokens', '1'),
  ]);
  const zero = known(estimateInvocationCost(view(), free, AT));
  assert.equal(zero.amount, '18', '10 + 0 + 0 + 8');
  assert.ok(zero.usage_basis.includes('output_tokens'), 'gratuit reste supporté');
  assert.equal(zero.usage_basis.length, 4);

  // Une observation dont la forme contredit le fournisseur de l'invocation.
  const mismatched = view({
    observation: {
      tokens: {
        provider: 'codex',
        input_tokens: 1,
        output_tokens: 1,
        cached_input_tokens: null,
        cache_write_input_tokens: null,
        reasoning_output_tokens: null,
      },
    },
  });
  assert.equal(reasonOf(estimateInvocationCost(mismatched, complete, AT)), 'UNSUPPORTED_USAGE_SHAPE');

  // Une observation sans jetons, avec une règle qui en tarife.
  const noTokens = view({ observation: { tokens: undefined } });
  assert.equal(reasonOf(estimateInvocationCost(noTokens, complete, AT)), 'UNSUPPORTED_USAGE_SHAPE');
});

// ==========================================================================
// C. Arithmétique
// ==========================================================================

test('13–19 · décimales exactes, échelles, et stabilité', () => {
  const single = (rate: string, unitScale: number, units: number): string => {
    const estimate = known(
      estimateInvocationCost(
        view({
          observation: {
            tokens: {
              provider: 'claude',
              input_tokens: units,
              output_tokens: 0,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
        }),
        catalogOf([claudeRule('input_tokens', rate, unitScale), claudeRule('output_tokens', '0')]),
        AT,
      ),
    );
    return estimate.amount;
  };

  // 13 · 15 · un taux décimal, à l'unité.
  assert.equal(single('1.25', 1, 4), '5');
  assert.equal(single('0.5', 1, 3), '1.5');

  // 16 · une échelle au million, la forme qui rendrait un ×1 000 000 silencieux.
  assert.equal(single('3', 1000000, 1500000), '4.5');
  assert.equal(single('2.5', 1000, 400), '1');

  // 17 · taux nul.
  assert.equal(single('0', 1, 999), '0');

  // 18 · une décimale fine traverse le calcul sans être dégradée.
  assert.equal(single('0.000001', 1, 1), '0.000001');
  assert.equal(single('0.000001', 1, 3), '0.000003');
  // Le flottant, lui, ne le ferait pas.
  assert.notEqual(String(0.1 + 0.2), '0.3');
  assert.equal(single('0.1', 1, 3), '0.3', 'la somme reste exacte');

  // 14 · plusieurs catégories se somment exactement.
  const multi = known(
    estimateInvocationCost(
      view(),
      catalogOf([
        claudeRule('input_tokens', '0.1'),
        claudeRule('output_tokens', '0.2'),
        claudeRule('cache_creation_input_tokens', '0.05'),
        claudeRule('cache_read_input_tokens', '0.001'),
      ]),
      AT,
    ),
  );
  // 10×0.1 + 2×0.2 + 4×0.05 + 8×0.001 = 1 + 0.4 + 0.2 + 0.008
  assert.equal(multi.amount, '1.608');

  // 19 · deux calculs identiques rendent le même montant.
  assert.equal(single('0.000001', 1, 7), single('0.000001', 1, 7));
});

// ==========================================================================
// D. Claude et Codex
// ==========================================================================

test('20–24 · Claude : modèle exact, cache optionnel, montant rapporté séparé', () => {
  const complete = catalogOf([
    claudeRule('input_tokens', '1'),
    claudeRule('output_tokens', '1'),
    claudeRule('cache_creation_input_tokens', '1'),
    claudeRule('cache_read_input_tokens', '1'),
  ]);

  // 20 · modèle observé exact + règle complète.
  const estimate = known(estimateInvocationCost(view(), complete, AT));
  assert.equal(estimate.model, 'fixture-claude-model');
  assert.equal(estimate.currency, 'XTS');
  assert.equal(estimate.pricing_catalog_version, 'TEST-COST-V1');
  assert.deepEqual(estimate.pricing_source, TEST_SOURCE);
  assert.equal(estimate.computed_at, AT);
  assert.equal('unknown_reason' in estimate, false);

  // 21 · un cache inconnu qu'aucune règle ne tarife n'empêche rien.
  const noCache = view({
    observation: {
      tokens: claudeTokens({ cache_creation_input_tokens: null, cache_read_input_tokens: null }),
    },
  });
  const minimal = catalogOf([claudeRule('input_tokens', '1'), claudeRule('output_tokens', '1')]);
  assert.equal(known(estimateInvocationCost(noCache, minimal, AT)).amount, '12');

  // 22 · le même cache inconnu, mais tarifé : la règle ne s'applique plus.
  assert.equal(reasonOf(estimateInvocationCost(noCache, complete, AT)), 'UNSUPPORTED_USAGE_SHAPE');

  // 23 · un cache connu qu'aucune règle ne tarife.
  assert.equal(reasonOf(estimateInvocationCost(view(), minimal, AT)), 'UNSUPPORTED_USAGE_SHAPE');

  // 24 · un montant rapporté divergent ne déplace pas l'estimation.
  const withMoney = view({
    observation: {
      provider_reported_cost: { amount: 999, currency: 'XTS', source: 'PROVIDER_REPORTED' },
    },
  });
  assert.equal(known(estimateInvocationCost(withMoney, complete, AT)).amount, '24');
});

test('25–27 · Codex : sans modèle observé, aucun prix n’est supposé', () => {
  const codexView = view({ provider: 'codex', id: 'inv_000002' });
  const codexTokens: UsageTokens = {
    provider: 'codex',
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 90,
    cache_write_input_tokens: 1,
    reasoning_output_tokens: 5,
  };
  const observed: UsageInvocationView = {
    ...codexView,
    provider_reported: {
      state: 'OBSERVED',
      observation: {
        ...(codexView.provider_reported.observation as unknown as Record<string, unknown>),
        model: { source: 'UNKNOWN', reason: 'NOT_REPORTED' },
        tokens: codexTokens,
      } as never,
    },
  };

  // 25 · 26 · le catalogue contient pourtant tout ce qu'il faudrait.
  const codexCatalog = catalogOf([
    { provider: 'codex', model: 'fixture-codex-model', usage_category: 'input_tokens', rate: '1', unit_scale: 1 },
    { provider: 'codex', model: 'fixture-codex-model', usage_category: 'output_tokens', rate: '1', unit_scale: 1 },
    { provider: 'codex', model: 'fixture-codex-model', usage_category: 'cached_input_tokens', rate: '1', unit_scale: 1 },
    { provider: 'codex', model: 'fixture-codex-model', usage_category: 'cache_write_input_tokens', rate: '1', unit_scale: 1 },
    { provider: 'codex', model: 'fixture-codex-model', usage_category: 'reasoning_output_tokens', rate: '1', unit_scale: 1 },
  ]);
  const estimate = estimateInvocationCost(observed, codexCatalog, AT);
  assert.equal(reasonOf(estimate), 'MODEL_UNKNOWN');
  assert.equal(estimate.status === 'UNKNOWN' ? estimate.model : 'x', undefined, 'aucun modèle choisi');

  // 27 · une règle unique pour ce moteur ne devient pas un défaut.
  const soleRule = catalogOf([
    { provider: 'codex', model: 'fixture-codex-model', usage_category: 'input_tokens', rate: '1', unit_scale: 1 },
  ]);
  assert.equal(reasonOf(estimateInvocationCost(observed, soleRule, AT)), 'MODEL_UNKNOWN');
});

// ==========================================================================
// E. Lecture, agrégats, production
// ==========================================================================

interface Box {
  readonly paths: RunPaths;
  readonly repo: string;
  engage(provider: 'claude' | 'codex'): Promise<string>;
  observe(invocationId: string, observation: Record<string, unknown>): Promise<void>;
  publish(entries: readonly Rule[], over?: Record<string, unknown>): Promise<void>;
  select(doc: unknown): Promise<void>;
  read(): ReturnType<typeof readCostEstimateReadModel>;
  cleanup(): Promise<void>;
}

async function box(prefix: string): Promise<Box> {
  const dir = await makeTempDir(prefix);
  const runsDir = path.join(dir, 'runs');
  const repo = path.join(dir, 'repo');
  const paths = runPaths(runsDir, RUN);
  await mkdir(paths.root, { recursive: true });
  await mkdir(pricingCatalogPaths(repo).catalogsDir, { recursive: true });
  await initializeInvocationLedger(paths);

  return {
    paths,
    repo,
    async engage(provider): Promise<string> {
      const ledger = await openInvocationLedger(paths, RUN);
      const record = await ledger.append(
        {
          identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: provider, provider },
          trigger_kind: 'STEP',
        },
        new Date(AT),
      );
      return record.invocation_id;
    },
    async observe(invocationId, observation): Promise<void> {
      const ledger = await openUsageLedger(paths, RUN);
      await ledger.append({ invocation_id: invocationId, ...observation } as never, new Date(AT));
    },
    async publish(entries, over = {}): Promise<void> {
      const doc = {
        schema_version: PRICING_CATALOG_SCHEMA_VERSION,
        catalog_version: 'TEST-COST-V1',
        currency: 'XTS',
        source: { ...TEST_SOURCE },
        entries,
        ...over,
      };
      const version = String(doc.catalog_version);
      await writeFile(
        path.join(pricingCatalogPaths(repo).catalogsDir, `${version}.json`),
        `${JSON.stringify(doc, null, 2)}\n`,
        'utf8',
      );
      await writeFile(
        pricingCatalogPaths(repo).current,
        `${JSON.stringify({ schema_version: 1, catalog_version: version }, null, 2)}\n`,
        'utf8',
      );
    },
    async select(doc): Promise<void> {
      await writeFile(pricingCatalogPaths(repo).current, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    },
    read: () => readCostEstimateReadModel(paths, () => new Date(AT), repo),
    cleanup: () => removeTempDir(dir),
  };
}

test('28–35 · agrégats : somme des seuls KNOWN, couverture par fournisseur', async () => {
  const b = await box('ccr-cost-aggregate-');
  try {
    // Deux estimables, une sans usage.
    for (const id of ['a', 'b']) {
      const invocation = await b.engage('claude');
      await b.observe(invocation, {
        provenance: 'PROVIDER_REPORTED',
        outcome: 'RESPONSE_RECEIVED',
        model: CLAUDE_MODEL,
        tokens: {
          provider: 'claude',
          input_tokens: id === 'a' ? 10 : 5,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      });
    }
    await b.engage('claude');
    // Un Codex sans modèle : une autre raison, sur un autre fournisseur.
    const codex = await b.engage('codex');
    await b.observe(codex, {
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      model: { source: 'UNKNOWN', reason: 'NOT_REPORTED' },
      tokens: {
        provider: 'codex',
        input_tokens: 1,
        output_tokens: 1,
        cached_input_tokens: null,
        cache_write_input_tokens: null,
        reasoning_output_tokens: null,
      },
    });

    await b.publish([claudeRule('input_tokens', '0.5'), claudeRule('output_tokens', '0')]);
    const model = await b.read();

    // 31 · 33 · deux estimées, une inconnue, et la somme n'inclut que les deux.
    const claude = model.providers.find((entry) => entry.provider === 'claude');
    assert.ok(claude);
    assert.equal(claude.invocations, 3);
    assert.equal(claude.estimated_invocations, 2);
    assert.equal(claude.unknown_invocations, 1);
    assert.deepEqual(claude.amounts_by_currency, [
      {
        currency: 'XTS',
        estimated_amount_sum: '7.5',
        estimated_invocations: 2,
        exact_amount_invocations: 2,
        rounded_amount_invocations: 0,
      },
    ]);

    // 32 · la partition des raisons est exacte.
    assert.deepEqual(claude.unknown_by_reason, [{ reason: 'USAGE_UNKNOWN', invocations: 1 }]);
    const codexAggregate = model.providers.find((entry) => entry.provider === 'codex');
    assert.deepEqual(codexAggregate?.unknown_by_reason, [{ reason: 'MODEL_UNKNOWN', invocations: 1 }]);
    for (const provider of model.providers) {
      assert.equal(
        provider.unknown_by_reason.reduce((sum, entry) => sum + entry.invocations, 0),
        provider.unknown_invocations,
      );
      assert.equal(provider.estimated_invocations + provider.unknown_invocations, provider.invocations);
    }

    // 34 · aucune devise n'est attribuée aux inconnues.
    assert.deepEqual(codexAggregate?.amounts_by_currency, []);

    // 23 · aucun total inter-fournisseurs, même en devise commune.
    const serialized = JSON.stringify(model);
    for (const forbidden of ['total_cost', 'exact_cost', 'billing_total', 'actual_cost', 'grand_total']) {
      assert.equal(serialized.includes(forbidden), false, `aucun ${forbidden}`);
    }
    assert.equal((model as unknown as Record<string, unknown>)['amounts_by_currency'], undefined);

    // La provenance est citée sur chaque estimation.
    const first = model.by_invocation.find((entry) => entry.status === 'KNOWN');
    assert.ok(first && first.status === 'KNOWN');
    assert.equal(first.pricing_catalog_version, 'TEST-COST-V1');
    assert.deepEqual(first.pricing_source, TEST_SOURCE);
  } finally {
    await b.cleanup();
  }
});

test('35 · deux devises, deux compartiments, aucune somme commune', async () => {
  const b = await box('ccr-cost-currency-');
  try {
    const first = await b.engage('claude');
    await b.observe(first, {
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      model: CLAUDE_MODEL,
      tokens: {
        provider: 'claude',
        input_tokens: 4,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    });

    // Un premier catalogue en XTS, puis un second en XXX : la lecture suit le
    // courant, et les compartiments ne se mélangent jamais.
    await b.publish([claudeRule('input_tokens', '1'), claudeRule('output_tokens', '0')]);
    const inXts = await b.read();
    assert.deepEqual(inXts.providers[0]?.amounts_by_currency, [
      {
        currency: 'XTS',
        estimated_amount_sum: '4',
        estimated_invocations: 1,
        exact_amount_invocations: 1,
        rounded_amount_invocations: 0,
      },
    ]);

    await b.publish([claudeRule('input_tokens', '2'), claudeRule('output_tokens', '0')], {
      catalog_version: 'TEST-COST-V2',
      currency: 'XXX',
    });
    const inXxx = await b.read();
    assert.deepEqual(inXxx.providers[0]?.amounts_by_currency, [
      {
        currency: 'XXX',
        estimated_amount_sum: '8',
        estimated_invocations: 1,
        exact_amount_invocations: 1,
        rounded_amount_invocations: 0,
      },
    ]);
    assert.equal(inXxx.pricing.kind, 'CONFIGURED');
    if (inXxx.pricing.kind !== 'CONFIGURED') throw new Error('configuré attendu');
    assert.equal(inXxx.pricing.catalog_version, 'TEST-COST-V2');
  } finally {
    await b.cleanup();
  }
});

test('36–41 · couverture, production sans catalogue, corruption, lecture non mutante', async () => {
  // 36 · run marqué, aucune invocation : aucune estimation, aucun coût inventé.
  const fresh = await box('ccr-cost-fresh-');
  try {
    const model = await fresh.read();
    assert.equal(model.coverage, 'SINCE_LEDGER_START');
    assert.deepEqual(model.by_invocation, []);
    assert.deepEqual(model.providers, []);
    assert.deepEqual(model.pricing, { kind: 'NONE' });
  } finally {
    await fresh.cleanup();
  }

  // 39 · 20 · sans catalogue courant, une invocation par ailleurs estimable
  //      rend PRICING_UNKNOWN — et ce n'est pas une erreur.
  const bare = await box('ccr-cost-nopricing-');
  try {
    const invocation = await bare.engage('claude');
    await bare.observe(invocation, {
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      model: CLAUDE_MODEL,
      tokens: {
        provider: 'claude',
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    });
    const model = await bare.read();
    assert.deepEqual(model.pricing, { kind: 'NONE' });
    assert.equal(reasonOf(model.by_invocation[0] as CostEstimate), 'PRICING_UNKNOWN');
    assert.equal(model.providers[0]?.estimated_invocations, 0);
    assert.deepEqual(model.providers[0]?.amounts_by_currency, []);

    // 40 · 41 · un sélecteur corrompu, puis un catalogue invalide : erreurs.
    await bare.select({ schema_version: 1, catalog_version: '../evasion' });
    await assert.rejects(
      bare.read(),
      (error: unknown) => isCcrError(error) && error.code === 'PRICING_CATALOG_INVALID',
    );
    await bare.select({ schema_version: 1, catalog_version: 'TEST-ABSENT' });
    await assert.rejects(
      bare.read(),
      (error: unknown) => isCcrError(error) && error.code === 'PRICING_CATALOG_READ_FAILED',
    );
  } finally {
    await bare.cleanup();
  }

  // 38 · 42 · usage absent, et deux lectures qui ne créent rien.
  const empty = await box('ccr-cost-readonly-');
  try {
    await empty.engage('claude');
    const first = await empty.read();
    assert.equal(reasonOf(first.by_invocation[0] as CostEstimate), 'USAGE_UNKNOWN');
    await empty.read();

    const exists = async (target: string): Promise<boolean> => {
      try {
        await access(target);
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(await exists(empty.paths.usage), false, 'aucun journal d’usage fabriqué');
    assert.equal(await exists(pricingCatalogPaths(empty.repo).current), false);
  } finally {
    await empty.cleanup();
  }
});

test('43 · production : aucun catalogue, donc aucune estimation fabriquée', async () => {
  const b = await box('ccr-cost-production-');
  try {
    const invocation = await b.engage('claude');
    await b.observe(invocation, {
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      model: CLAUDE_MODEL,
      tokens: {
        provider: 'claude',
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    });

    // Le dépôt réel, sans aucune fixture.
    const model = await readCostEstimateReadModel(b.paths, () => new Date(AT), CCR_ROOT);
    assert.deepEqual(model.pricing, { kind: 'NONE' });
    assert.equal(reasonOf(model.by_invocation[0] as CostEstimate), 'PRICING_UNKNOWN');
  } finally {
    await b.cleanup();
  }
});

// ==========================================================================
// F. Frontières
// ==========================================================================

test('44 · gardes : dérivé seulement, sans repli, sans réseau, sans persistance', async () => {
  const { readFile } = await import('node:fs/promises');
  const executable = async (relative: string): Promise<string> => {
    const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  const pure = await executable('services/cost-estimator.ts');
  // La fonction pure ne touche ni disque, ni horloge, ni journaux.
  for (const forbidden of [
    'usage-ledger',
    'invocation-ledger',
    'readFile',
    'writeFile',
    'new Date',
    'fetch',
    'http',
  ]) {
    assert.equal(pure.includes(forbidden), false, `l’estimateur ignore ${forbidden}`);
  }
  // Et il ne lit jamais le montant du fournisseur pour calculer le sien.
  assert.equal(pure.includes('provider_reported_cost'), false);

  const service = await executable('services/cost-estimate-read-model.ts');
  for (const forbidden of ['usage-ledger', 'invocation-ledger', 'writeFile', 'fetch', 'provider_reported_cost']) {
    assert.equal(service.includes(forbidden), false, `le service ignore ${forbidden}`);
  }
  for (const forbidden of ['invocation-policy', 'invocation-quota', 'budget']) {
    assert.equal(service.includes(forbidden), false, `aucun ${forbidden}`);
  }

  // Personne ne dépend de l'estimateur en retour.
  for (const relative of [
    'services/usage-read-model.ts',
    'core/pricing-catalog.ts',
    'store/pricing-catalog-store.ts',
    'services/invocation-quota.ts',
    'services/invocation-quota-read.ts',
    'services/recovery-planner.ts',
    'core/run-liveness.ts',
    'cockpit/long-operations.ts',
  ]) {
    const code = await executable(relative);
    for (const forbidden of ['cost-estimator', 'cost-estimate-read-model']) {
      assert.equal(code.includes(forbidden), false, `${relative} ignore ${forbidden}`);
    }
  }

  // Le classifieur d'initialisation natif reste indépendant.
  const recovery = await executable('services/native-recovery-service.ts');
  const classifier = recovery.slice(
    recovery.indexOf('export function buildNativeInitializationView'),
    recovery.indexOf('async function loadNativeRun'),
  );
  assert.equal(classifier.includes('cost'), false);

  // Aucune route, aucune commande tarifaire.
  for (const relative of ['cockpit/mutations-http.ts', 'cockpit/server.ts']) {
    const code = await executable(relative);
    for (const forbidden of ['pricing', 'Pricing', 'cost', 'Cost']) {
      assert.equal(code.includes(forbidden), false, `${relative} n’expose pas ${forbidden}`);
    }
  }
});

// ==========================================================================
// G. Materialisation numerique (V2.2-IMP-12R)
// ==========================================================================

/** Une invocation Claude a une seule categorie tarifee, pour isoler un nombre. */
function amountOf(rate: string, unitScale: number, units: number): Extract<CostEstimate, { status: 'KNOWN' }> {
  return known(
    estimateInvocationCost(
      view({
        observation: {
          tokens: {
            provider: 'claude',
            input_tokens: units,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      }),
      catalogOf([claudeRule('input_tokens', rate, unitScale), claudeRule('output_tokens', '0')]),
      AT,
    ),
  );
}

/**
 * Somme decimale exacte, reimplementee ici.
 *
 * Verifier la reconciliation detail/agregat avec l'additionneur de production ne
 * prouverait que sa coherence avec lui-meme.
 */
function sumDecimals(values: readonly string[]): string {
  const scaled = values.reduce((acc, value) => {
    const dot = value.indexOf('.');
    const whole = dot === -1 ? value : value.slice(0, dot);
    const fraction = dot === -1 ? '' : value.slice(dot + 1);
    return acc + BigInt(whole) * 10n ** 18n + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
  }, 0n);
  const digits = scaled.toString().padStart(19, '0');
  const whole = digits.slice(0, digits.length - 18);
  const fraction = digits.slice(digits.length - 18).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

test('45-51 - un decimal fini se publie entier, un developpement infini se declare arrondi', () => {
  // 45 - treize decimales, sur une echelle unitaire : exactement le montant que
  //      l'ancienne materialisation publiait « 0 ».
  const fine = amountOf('0.0000000000001', 1, 1);
  assert.equal(fine.amount, '0.0000000000001');
  assert.deepEqual(fine.amount_materialization, { kind: 'EXACT' });

  // 46 - un entier reste un entier, sans fraction parasite.
  const whole = amountOf('3', 1, 4);
  assert.equal(whole.amount, '12');
  assert.deepEqual(whole.amount_materialization, { kind: 'EXACT' });

  // 47 - vrai zero : un taux nul explicite, exactement nul.
  const trueZero = amountOf('0', 1, 999);
  assert.equal(trueZero.amount, '0');
  assert.deepEqual(trueZero.amount_materialization, { kind: 'EXACT' });

  // 48 - 1/3 ne s'ecrit pas : l'arrondi est declare, sa precision et son mode
  //      nommes. Ce n'est plus un comportement a deduire du code.
  const third = amountOf('1', 3, 1);
  assert.equal(third.amount, '0.333333333333');
  assert.deepEqual(third.amount_materialization, {
    kind: 'ROUNDED',
    decimal_places: 12,
    rounding_mode: 'HALF_UP',
  });
  // Au plus proche, et non tronque : 2/3 monte.
  assert.equal(amountOf('2', 3, 1).amount, '0.666666666667');

  // 49 - le critere principal du repair : un positif arrondi a zero ne se
  //      confond plus avec un zero exact. Les deux chaines sont identiques ;
  //      les deux artefacts, non.
  const underflow = amountOf('0.000000000001', 3, 1);
  assert.equal(underflow.amount, '0');
  assert.equal(underflow.amount, trueZero.amount, 'la chaine seule ne suffit pas a distinguer');
  assert.deepEqual(underflow.amount_materialization, {
    kind: 'ROUNDED',
    decimal_places: 12,
    rounding_mode: 'HALF_UP',
  });
  assert.notDeepEqual(underflow.amount_materialization, trueZero.amount_materialization);

  // 50 - au-dela de douze decimales, mais fini : rien n'est arrondi.
  const deep = amountOf('1', 1000000000000000, 1);
  assert.equal(deep.amount, '0.000000000000001');
  assert.deepEqual(deep.amount_materialization, { kind: 'EXACT' });
  const deeper = amountOf('0.000000000000001', 1, 3);
  assert.equal(deeper.amount, '0.000000000000003');
  assert.deepEqual(deeper.amount_materialization, { kind: 'EXACT' });

  // 51 - deux calculs identiques rendent le meme montant et la meme ecriture.
  assert.deepEqual(amountOf('1', 3, 7), amountOf('1', 3, 7));
  assert.deepEqual(amountOf('1.25', 1, 4), amountOf('1.25', 1, 4));
});

test('52 - un compteur qui n est pas un entier de jetons est refuse, jamais converti', () => {
  const complete = catalogOf([
    claudeRule('input_tokens', '1'),
    claudeRule('output_tokens', '1'),
    claudeRule('cache_creation_input_tokens', '1'),
    claudeRule('cache_read_input_tokens', '1'),
  ]);

  // Une vue construite en memoire n'est jamais passee par la validation d'entree.
  const fractional = view({ observation: { tokens: claudeTokens({ input_tokens: 1.5 }) } });
  let estimate: CostEstimate | undefined;
  assert.doesNotThrow(() => {
    estimate = estimateInvocationCost(fractional, complete, AT);
  }, 'aucune RangeError brute ne remonte de la conversion entiere');
  assert.equal(reasonOf(estimate as CostEstimate), 'UNSUPPORTED_USAGE_SHAPE');

  for (const bad of [-1, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
    const broken = view({ observation: { tokens: claudeTokens({ input_tokens: bad }) } });
    assert.equal(
      reasonOf(estimateInvocationCost(broken, complete, AT)),
      'UNSUPPORTED_USAGE_SHAPE',
      `compteur ${String(bad)} refuse`,
    );
  }
});

test('53-56 - agregats : couverture exacte/arrondie, et somme qui reconcilie le detail', async () => {
  const b = await box('ccr-cost-materialization-');
  try {
    const observe = async (units: number): Promise<void> => {
      const invocation = await b.engage('claude');
      await b.observe(invocation, {
        provenance: 'PROVIDER_REPORTED',
        outcome: 'RESPONSE_RECEIVED',
        model: CLAUDE_MODEL,
        tokens: {
          provider: 'claude',
          input_tokens: units,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      });
    };
    const bucketOf = (
      model: CostEstimateReadModel,
    ): CostEstimateReadModel['providers'][number]['amounts_by_currency'][number] => {
      const bucket = model.providers[0]?.amounts_by_currency[0];
      assert.ok(bucket, 'un compartiment de devise attendu');
      return bucket;
    };
    const publicAmounts = (model: CostEstimateReadModel): string[] =>
      model.by_invocation.flatMap((estimate) => (estimate.status === 'KNOWN' ? [estimate.amount] : []));

    // 53 - deux montants exacts : aucun arrondi dans la couverture.
    await observe(4);
    await observe(3);
    await b.publish([claudeRule('input_tokens', '0.5'), claudeRule('output_tokens', '0')]);
    const exact = await b.read();
    assert.deepEqual(bucketOf(exact), {
      currency: 'XTS',
      estimated_amount_sum: '3.5',
      estimated_invocations: 2,
      exact_amount_invocations: 2,
      rounded_amount_invocations: 0,
    });

    // 54 - le meme run sous un tarif au tiers : 3 unites sur 3 s'ecrivent, 4 non.
    await b.publish([claudeRule('input_tokens', '1', 3), claudeRule('output_tokens', '0')]);
    const mixed = await b.read();
    const mixedBucket = bucketOf(mixed);
    assert.equal(mixedBucket.exact_amount_invocations, 1);
    assert.equal(mixedBucket.rounded_amount_invocations, 1);
    assert.equal(mixedBucket.exact_amount_invocations + mixedBucket.rounded_amount_invocations, 2);

    // 55 - la somme publiee reconcilie exactement les montants publies.
    assert.equal(mixedBucket.estimated_amount_sum, sumDecimals(publicAmounts(mixed)));
    assert.equal(bucketOf(exact).estimated_amount_sum, sumDecimals(publicAmounts(exact)));

    // 56 - deux positifs arrondis a zero : la somme vaut « 0 », et la couverture
    //      dit qu'aucun de ces deux zeros n'est exact.
    await b.publish([claudeRule('input_tokens', '0.0000000000001', 7), claudeRule('output_tokens', '0')]);
    const underflow = await b.read();
    assert.deepEqual(publicAmounts(underflow), ['0', '0']);
    assert.deepEqual(bucketOf(underflow), {
      currency: 'XTS',
      estimated_amount_sum: '0',
      estimated_invocations: 2,
      exact_amount_invocations: 0,
      rounded_amount_invocations: 2,
    });
  } finally {
    await b.cleanup();
  }
});

test('57-59 - CLI : un montant arrondi ne s affiche jamais comme un montant exact', () => {
  const modelOf = (exact: number, rounded: number, sum: string): CostEstimateReadModel => ({
    coverage: 'SINCE_LEDGER_START',
    pricing: {
      kind: 'CONFIGURED',
      catalog_version: 'TEST-COST-V1',
      currency: 'XTS',
      source: { ...TEST_SOURCE },
    },
    by_invocation: [],
    providers: [
      {
        provider: 'claude',
        invocations: exact + rounded,
        estimated_invocations: exact + rounded,
        unknown_invocations: 0,
        unknown_by_reason: [],
        amounts_by_currency: [
          {
            currency: 'XTS',
            estimated_amount_sum: sum,
            estimated_invocations: exact + rounded,
            exact_amount_invocations: exact,
            rounded_amount_invocations: rounded,
          },
        ],
      },
    ],
  });

  // Les deux generations affichent la meme chose, chacune dans sa mise en forme.
  for (const render of [costLine, costSummary]) {
    // 57 - un zero exact s'affiche comme un zero.
    const trueZero = render(modelOf(1, 0, '0'));
    assert.equal(trueZero.includes('claude 0 XTS'), true, trueZero);
    assert.equal(trueZero.includes('≈'), false, 'aucun marqueur sur un montant exact');

    // 58 - un zero arrondi ne peut pas se lire comme un cout nul.
    assert.equal(render(modelOf(0, 1, '0')).includes('claude ≈0 XTS'), true);

    // 59 - un montant arrondi non nul porte le meme marqueur.
    assert.equal(render(modelOf(1, 1, '2.333333333333')).includes('claude ≈2.333333333333 XTS'), true);
  }
});
