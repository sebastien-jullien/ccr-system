/**
 * V2.2-IMP-10 — lecture d'usage, par invocation d'abord.
 *
 * Trois propriétés portent tout le reste.
 *
 *  1. **L'univers est le journal d'invocations.** Une invocation ordinaire porte
 *     deux observations ; la compter deux fois serait l'erreur que ce slice
 *     existe pour rendre impossible.
 *  2. **Une ambiguïté n'est pas une somme.** Deux observations de même
 *     provenance ne se composent pas, ne se remplacent pas, et ne s'ignorent
 *     pas : elles se disent.
 *  3. **L'absence n'est jamais zéro.** Chaque dimension porte sa couverture, et
 *     aucune somme ne prétend couvrir ce qu'elle ignore.
 *
 * Aucun fournisseur réel : les journaux sont écrits par leurs stores.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { ProviderKind } from '../../src/core/expert.ts';
import type { UsageObservation } from '../../src/core/usage.ts';
import type { NewUsageObservation } from '../../src/core/usage-governance.ts';
import { readUsageReadModel } from '../../src/services/usage-read-model.ts';
import type { UsageProviderAggregate, UsageReadModel } from '../../src/services/usage-read-model.ts';
import { readStableRunSnapshot } from '../../src/store/run-snapshot.ts';
import {
  initializeInvocationLedger,
  openInvocationLedger,
} from '../../src/store/invocation-ledger.ts';
import { openUsageLedger } from '../../src/store/usage-ledger.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { materializeRun, FIXTURE_TIME as T } from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN = 'CCR-20260812-001';
const AT = new Date(T);

const CLAUDE_USAGE: UsageObservation = {
  tokens: {
    provider: 'claude',
    input_tokens: 10,
    output_tokens: 4,
    cache_creation_input_tokens: 7,
    cache_read_input_tokens: null,
  },
  model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' },
  provider_reported_cost: { amount: 0.25, currency: 'USD', source: 'PROVIDER_REPORTED' },
};

const CODEX_USAGE: UsageObservation = {
  tokens: {
    provider: 'codex',
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 90,
    cache_write_input_tokens: null,
    reasoning_output_tokens: 5,
  },
  model: { source: 'UNKNOWN', reason: 'NOT_REPORTED' },
};

// --------------------------------------------------------------------------
// Fixtures — écrites par les stores canoniques
// --------------------------------------------------------------------------

interface Box {
  readonly paths: RunPaths;
  readonly runsDir: string;
  engage(provider: ProviderKind, trigger?: 'STEP' | 'SEND' | 'START'): Promise<string>;
  observe(invocationId: string, draft: Omit<NewUsageObservation, 'invocation_id'>): Promise<string>;
  read(): Promise<UsageReadModel>;
  cleanup(): Promise<void>;
}

async function box(prefix: string, options: { marker?: boolean } = {}): Promise<Box> {
  const dir = await makeTempDir(prefix);
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN);
  await mkdir(paths.root, { recursive: true });
  if (options.marker !== false) await initializeInvocationLedger(paths);

  return {
    paths,
    runsDir,
    async engage(provider, trigger = 'STEP'): Promise<string> {
      const ledger = await openInvocationLedger(paths, RUN);
      const record = await ledger.append(
        {
          identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: provider, provider },
          trigger_kind: trigger,
        },
        AT,
      );
      return record.invocation_id;
    },
    async observe(invocationId, draft): Promise<string> {
      const ledger = await openUsageLedger(paths, RUN);
      const record = await ledger.append({ invocation_id: invocationId, ...draft } as NewUsageObservation, AT);
      return record.usage_observation_id;
    },
    read: () => readUsageReadModel(paths),
    cleanup: () => removeTempDir(dir),
  };
}

function providerOf(model: UsageReadModel, provider: ProviderKind): UsageProviderAggregate {
  const found = model.providers.find((entry) => entry.provider === provider);
  assert.ok(found, `agrégat ${provider} attendu`);
  return found;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

// ==========================================================================
// A. Cardinalité — l'univers est le journal d'invocations
// ==========================================================================

test('1–5 · une invocation compte une fois, quelles que soient ses observations', async () => {
  const b = await box('ccr-usage-cardinality-');
  try {
    // 1 · deux observations, une seule invocation.
    const first = await b.engage('claude');
    await b.observe(first, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    await b.observe(first, { provenance: 'CCR_MEASURED', outcome: 'RESPONSE_RECEIVED', ccr_elapsed_ms: 900, exit_code: 0 });

    let model = await b.read();
    assert.equal(model.invocations.total, 1, 'jamais 2');
    assert.deepEqual(model.invocations.provider_reported, { observed: 1, unobserved: 0, ambiguous: 0 });
    assert.deepEqual(model.invocations.ccr_measured, { observed: 1, unobserved: 0, ambiguous: 0 });

    // 2 · deux invocations, quelle que soit la cardinalité du journal d'usage.
    const second = await b.engage('claude', 'SEND');
    model = await b.read();
    assert.equal(model.invocations.total, 2);

    // 3 · une invocation sans aucune observation.
    assert.deepEqual(model.invocations.provider_reported, { observed: 1, unobserved: 1, ambiguous: 0 });
    const view = model.by_invocation.find((entry) => entry.invocation_id === second);
    assert.equal(view?.provider_reported.state, 'UNOBSERVED');
    assert.equal(view?.ccr_measured.state, 'UNOBSERVED');
    assert.equal(view?.provider_reported.observation, undefined, 'aucun usage inventé');
    assert.equal(view?.trigger_kind, 'SEND');

    // 4 · fournisseur seul.
    const third = await b.engage('codex');
    await b.observe(third, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CODEX_USAGE });
    // 5 · CCR seul.
    const fourth = await b.engage('codex');
    await b.observe(fourth, { provenance: 'CCR_MEASURED', outcome: 'RESPONSE_RECEIVED', ccr_elapsed_ms: 12, exit_code: 0 });

    model = await b.read();
    assert.equal(model.invocations.total, 4);
    const codex = providerOf(model, 'codex');
    assert.deepEqual(codex.provider_reported, { observed: 1, unobserved: 1, ambiguous: 0 });
    assert.deepEqual(codex.ccr_measured, { observed: 1, unobserved: 1, ambiguous: 0 });

    // Chaque triplet partitionne bien le total.
    for (const partition of [model.invocations.provider_reported, model.invocations.ccr_measured]) {
      assert.equal(
        partition.observed + partition.unobserved + partition.ambiguous,
        model.invocations.total,
      );
    }
  } finally {
    await b.cleanup();
  }
});

// ==========================================================================
// B. Ambiguïtés — indépendantes, jamais résolues
// ==========================================================================

test('6–9 · deux observations d’une même provenance sont ambiguës, et le disent', async () => {
  const b = await box('ccr-usage-ambiguous-');
  try {
    // 6 · deux observations fournisseur.
    const doubled = await b.engage('claude');
    const idA = await b.observe(doubled, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    const idB = await b.observe(doubled, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    // 8 · … accompagnées d'une mesure CCR parfaitement claire.
    await b.observe(doubled, { provenance: 'CCR_MEASURED', outcome: 'RESPONSE_RECEIVED', ccr_elapsed_ms: 50, exit_code: 0 });

    // 7 · 9 · deux mesures CCR, un usage fournisseur unique.
    const measured = await b.engage('claude');
    await b.observe(measured, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    await b.observe(measured, { provenance: 'CCR_MEASURED', outcome: 'RESPONSE_RECEIVED', ccr_elapsed_ms: 1, exit_code: 0 });
    await b.observe(measured, { provenance: 'CCR_MEASURED', outcome: 'RESPONSE_RECEIVED', ccr_elapsed_ms: 2, exit_code: 0 });

    const model = await b.read();
    assert.equal(model.invocations.total, 2);

    const first = model.by_invocation.find((entry) => entry.invocation_id === doubled);
    assert.equal(first?.provider_reported.state, 'AMBIGUOUS');
    assert.equal(first?.provider_reported.observation, undefined, 'ni la première, ni la dernière');
    assert.equal(first?.ccr_measured.state, 'OBSERVED', 'la mesure CCR reste exploitable');
    assert.equal(first?.ccr_measured.ccr_elapsed_ms, 50);

    const second = model.by_invocation.find((entry) => entry.invocation_id === measured);
    assert.equal(second?.provider_reported.state, 'OBSERVED', 'le fournisseur reste exploitable');
    assert.equal(second?.ccr_measured.state, 'AMBIGUOUS');
    assert.equal(second?.ccr_measured.ccr_elapsed_ms, undefined);

    // 23 · l'invocation ambiguë reste comptée, et sortie des agrégats.
    const claude = providerOf(model, 'claude');
    assert.equal(claude.invocations, 2);
    assert.deepEqual(claude.provider_reported, { observed: 1, unobserved: 0, ambiguous: 1 });
    assert.deepEqual(claude.ccr_measured, { observed: 1, unobserved: 0, ambiguous: 1 });
    assert.equal(claude.tokens.input_tokens.observed_invocations, 1, 'une seule est sommée');
    assert.equal(claude.tokens.input_tokens.unknown_invocations, 1);
    assert.equal(claude.tokens.input_tokens.observed_sum, 10, 'jamais 20');
    assert.deepEqual(claude.models.observed, [{ model: 'claude-fixture-1', invocations: 1 }]);
    assert.equal(claude.models.unavailable_invocations, 1);
    assert.deepEqual(claude.provider_reported_money.by_currency, [
      { currency: 'USD', observed_amount_sum: 0.25, covered_invocations: 1 },
    ]);
    assert.equal(claude.provider_reported_money.ambiguous_invocations, 1);

    // 11 · les doublons sont nommés, avec leurs identifiants.
    const duplicates = model.anomalies.duplicate_observations;
    assert.equal(duplicates.length, 2);
    const provider = duplicates.find((entry) => entry.provenance === 'PROVIDER_REPORTED');
    assert.equal(provider?.invocation_id, doubled);
    assert.deepEqual(provider?.usage_observation_ids, [idA, idB]);
    assert.ok(duplicates.some((entry) => entry.provenance === 'CCR_MEASURED'));
  } finally {
    await b.cleanup();
  }
});

// ==========================================================================
// C. Orphelins
// ==========================================================================

test('10–11 · une observation sans invocation ne compte pas, et se dit', async () => {
  const b = await box('ccr-usage-orphans-');
  try {
    const real = await b.engage('claude');
    await b.observe(real, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    const orphanA = await b.observe('inv_000999', { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    const orphanB = await b.observe('inv_000998', { provenance: 'CCR_MEASURED', outcome: 'RESPONSE_RECEIVED', ccr_elapsed_ms: 3, exit_code: 0 });

    const model = await b.read();
    // La lecture reste possible, et aucune invocation synthétique n'apparaît.
    assert.equal(model.invocations.total, 1);
    assert.equal(model.by_invocation.length, 1);
    const claude = providerOf(model, 'claude');
    assert.equal(claude.tokens.input_tokens.observed_invocations, 1, 'l’orphelin n’est pas sommé');
    assert.equal(claude.tokens.input_tokens.observed_sum, 10);

    assert.deepEqual(
      model.anomalies.orphan_observations.map((entry) => entry.usage_observation_id).sort(),
      [orphanA, orphanB].sort(),
    );
    const first = model.anomalies.orphan_observations.find(
      (entry) => entry.usage_observation_id === orphanA,
    );
    assert.equal(first?.invocation_id, 'inv_000999');
    assert.equal(first?.provenance, 'PROVIDER_REPORTED');
  } finally {
    await b.cleanup();
  }
});

// ==========================================================================
// D. Jetons — dimensions exactes, sommes partielles
// ==========================================================================

test('12–14 · Claude : sommes exactes, `null` inconnu, observation sans jetons', async () => {
  const b = await box('ccr-usage-claude-');
  try {
    const one = await b.engage('claude');
    await b.observe(one, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    const two = await b.engage('claude');
    await b.observe(two, {
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      tokens: {
        provider: 'claude',
        input_tokens: 5,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 3,
      },
      model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' },
    });
    // 14 · une observation fournisseur dépourvue de jetons.
    const three = await b.engage('claude');
    await b.observe(three, {
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-2' },
    });

    const claude = providerOf(await b.read(), 'claude');
    assert.equal(claude.tokens.provider, 'claude');
    if (claude.tokens.provider !== 'claude') throw new Error('claude attendu');

    // 12 · sommes exactes à l'intérieur du fournisseur.
    assert.deepEqual(claude.tokens.input_tokens, {
      observed_sum: 15,
      observed_invocations: 2,
      unknown_invocations: 1,
    });
    assert.deepEqual(claude.tokens.output_tokens, {
      observed_sum: 5,
      observed_invocations: 2,
      unknown_invocations: 1,
    });
    // 13 · `null` compte comme inconnu, jamais comme zéro.
    assert.deepEqual(claude.tokens.cache_creation_input_tokens, {
      observed_sum: 7,
      observed_invocations: 1,
      unknown_invocations: 2,
    });
    assert.deepEqual(claude.tokens.cache_read_input_tokens, {
      observed_sum: 3,
      observed_invocations: 1,
      unknown_invocations: 2,
    });

    // Chaque dimension partitionne les invocations du fournisseur.
    for (const dimension of [
      claude.tokens.input_tokens,
      claude.tokens.cache_creation_input_tokens,
      claude.tokens.cache_read_input_tokens,
    ]) {
      assert.equal(
        dimension.observed_invocations + dimension.unknown_invocations,
        claude.invocations,
      );
    }
  } finally {
    await b.cleanup();
  }
});

test('15–17 · Codex : dimensions propres, aucun total combiné', async () => {
  const b = await box('ccr-usage-codex-');
  try {
    const codexId = await b.engage('codex');
    await b.observe(codexId, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CODEX_USAGE });
    const claudeId = await b.engage('claude');
    await b.observe(claudeId, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });

    const model = await b.read();
    const codex = providerOf(model, 'codex');
    assert.equal(codex.tokens.provider, 'codex');
    if (codex.tokens.provider !== 'codex') throw new Error('codex attendu');

    assert.equal(codex.tokens.input_tokens.observed_sum, 100);
    assert.equal(codex.tokens.output_tokens.observed_sum, 20);
    assert.equal(codex.tokens.cached_input_tokens.observed_sum, 90);
    assert.equal(codex.tokens.reasoning_output_tokens.observed_sum, 5);
    // 16 · une dimension non rapportée reste inconnue.
    assert.deepEqual(codex.tokens.cache_write_input_tokens, {
      observed_sum: 0,
      observed_invocations: 0,
      unknown_invocations: 1,
    });

    // 17 · aucun total inter-fournisseurs, à aucun niveau.
    const serialized = JSON.stringify(model);
    for (const forbidden of [
      'total_tokens',
      'total_input_tokens',
      'total_output_tokens',
      'all_providers',
      'cross_provider',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `aucun ${forbidden}`);
    }
    // Les deux fournisseurs coexistent, sans parent qui les additionne.
    assert.deepEqual(
      model.providers.map((entry) => entry.provider).sort(),
      ['claude', 'codex'],
    );
    assert.equal((model as unknown as Record<string, unknown>)['tokens'], undefined);
  } finally {
    await b.cleanup();
  }
});

// ==========================================================================
// E. Modèle et montant
// ==========================================================================

test('18–20 · le modèle observé est compté, l’inconnu reste une catégorie', async () => {
  const b = await box('ccr-usage-models-');
  try {
    for (let index = 0; index < 2; index += 1) {
      const id = await b.engage('claude');
      await b.observe(id, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    }
    // 20 · une ambiguïté de modèle n'est pas un modèle.
    const ambiguous = await b.engage('claude');
    await b.observe(ambiguous, {
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      model: { source: 'UNKNOWN', reason: 'AMBIGUOUS_MULTIPLE_MODELS' },
    });
    // 19 · Codex ne rapporte jamais de modèle.
    const codexId = await b.engage('codex');
    await b.observe(codexId, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CODEX_USAGE });

    const model = await b.read();
    const claude = providerOf(model, 'claude');
    assert.deepEqual(claude.models.observed, [{ model: 'claude-fixture-1', invocations: 2 }]);
    assert.deepEqual(claude.models.unknown, [{ reason: 'AMBIGUOUS_MULTIPLE_MODELS', invocations: 1 }]);
    assert.equal(claude.models.unavailable_invocations, 0);

    const codex = providerOf(model, 'codex');
    assert.deepEqual(codex.models.observed, []);
    assert.deepEqual(codex.models.unknown, [{ reason: 'NOT_REPORTED', invocations: 1 }]);

    // Le modèle n'est jamais choisi arbitrairement dans une ambiguïté.
    assert.equal(
      JSON.stringify(claude.models).includes('claude-fixture-2'),
      false,
    );
  } finally {
    await b.cleanup();
  }
});

test('21–25 · le montant rapporté est une observation, par devise, jamais converti', async () => {
  const b = await box('ccr-usage-money-');
  try {
    const first = await b.engage('claude');
    await b.observe(first, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    const second = await b.engage('claude');
    await b.observe(second, {
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' },
      provider_reported_cost: { amount: 0.75, currency: 'USD', source: 'PROVIDER_REPORTED' },
    });
    // 24 · une autre devise ne s'additionne jamais à la première.
    const third = await b.engage('claude');
    await b.observe(third, {
      provenance: 'PROVIDER_REPORTED',
      outcome: 'RESPONSE_RECEIVED',
      model: { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' },
      provider_reported_cost: { amount: 2, currency: 'EUR', source: 'PROVIDER_REPORTED' },
    });
    // 22 · Codex n'en rapporte pas : inconnu, pas zéro.
    const codexId = await b.engage('codex');
    await b.observe(codexId, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CODEX_USAGE });

    const model = await b.read();

    // 21 · visible par invocation, tel quel.
    const view = model.by_invocation.find((entry) => entry.invocation_id === first);
    assert.deepEqual(view?.provider_reported.observation?.provider_reported_cost, {
      amount: 0.25,
      currency: 'USD',
      source: 'PROVIDER_REPORTED',
    });

    // 23 · somme par devise, avec sa couverture.
    const claude = providerOf(model, 'claude');
    const byCurrency = [...claude.provider_reported_money.by_currency].sort((a, c) =>
      a.currency.localeCompare(c.currency),
    );
    assert.deepEqual(byCurrency, [
      { currency: 'EUR', observed_amount_sum: 2, covered_invocations: 1 },
      { currency: 'USD', observed_amount_sum: 1, covered_invocations: 2 },
    ]);

    const codex = providerOf(model, 'codex');
    assert.deepEqual(codex.provider_reported_money.by_currency, []);
    assert.equal(codex.provider_reported_money.unknown_invocations, 1, 'inconnu, jamais 0');

    // Aucun nom de facture ou d'estimation.
    const serialized = JSON.stringify(model);
    for (const forbidden of ['cost_total', 'billing_total', 'estimated_cost', 'actual_cost']) {
      assert.equal(serialized.includes(forbidden), false, `aucun ${forbidden}`);
    }
  } finally {
    await b.cleanup();
  }
});

// ==========================================================================
// F. Couverture, absence, corruption
// ==========================================================================

test('26–30 · couverture, journal d’usage absent ou vide', async () => {
  // 26 · run marqué à la naissance, aucune invocation.
  const fresh = await box('ccr-usage-fresh-');
  try {
    const model = await fresh.read();
    assert.equal(model.coverage, 'SINCE_LEDGER_START');
    assert.equal(model.invocations.total, 0);
    assert.deepEqual(model.invocations.provider_reported, { observed: 0, unobserved: 0, ambiguous: 0 });
    assert.deepEqual(model.providers, []);
    assert.deepEqual(model.by_invocation, []);
  } finally {
    await fresh.cleanup();
  }

  // 27 · run antérieur, sans marque.
  const historical = await box('ccr-usage-historical-', { marker: false });
  try {
    const model = await historical.read();
    assert.equal(model.coverage, 'PRE_LEDGER');
    assert.equal(model.invocations.total, 0);

    // 28 · un premier engagement gouverné active la couverture.
    await historical.engage('claude');
    assert.equal((await historical.read()).coverage, 'SINCE_LEDGER_START');
  } finally {
    await historical.cleanup();
  }

  // 29 · 30 · invocations présentes, journal d'usage absent puis vide : même
  // sémantique, et jamais zéro jeton.
  for (const empty of [false, true]) {
    const b = await box(`ccr-usage-noobs-${String(empty)}-`);
    try {
      await b.engage('claude');
      await b.engage('codex');
      if (empty) await writeFile(b.paths.usage, '', 'utf8');

      const model = await b.read();
      assert.equal(model.invocations.total, 2);
      assert.deepEqual(model.invocations.provider_reported, { observed: 0, unobserved: 2, ambiguous: 0 });
      assert.deepEqual(model.invocations.ccr_measured, { observed: 0, unobserved: 2, ambiguous: 0 });
      const claude = providerOf(model, 'claude');
      assert.deepEqual(claude.tokens.input_tokens, {
        observed_sum: 0,
        observed_invocations: 0,
        unknown_invocations: 1,
      });
      assert.equal(claude.models.unavailable_invocations, 1);
      assert.equal(claude.provider_reported_money.unknown_invocations, 1);
    } finally {
      await b.cleanup();
    }
  }
});

test('31–34 · corruption, lecture non mutante, révision intacte', async () => {
  // 31 · journal d'invocations corrompu.
  const one = await box('ccr-usage-corrupt-inv-');
  try {
    await writeFile(one.paths.invocations, 'ceci n’est pas une ligne JSON\n', 'utf8');
    await assert.rejects(
      one.read(),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await one.cleanup();
  }

  // 32 · journal d'usage corrompu.
  const two = await box('ccr-usage-corrupt-usage-');
  try {
    await two.engage('claude');
    await writeFile(two.paths.usage, 'ceci n’est pas une ligne JSON\n', 'utf8');
    await assert.rejects(
      two.read(),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
    );
  } finally {
    await two.cleanup();
  }

  // 33 · la lecture ne crée aucun fichier.
  const three = await box('ccr-usage-readonly-', { marker: false });
  try {
    await three.read();
    await three.read();
    assert.equal(await exists(three.paths.invocations), false);
    assert.equal(await exists(three.paths.usage), false);
    assert.equal(await exists(three.paths.invocationPolicy), false);
  } finally {
    await three.cleanup();
  }

  // 34 · la révision métier ignore l'usage.
  const four = await makeTempDir('ccr-usage-revision-');
  try {
    const runsDir = path.join(four, 'runs');
    await materializeRun(runsDir, {
      runId: RUN,
      events: [{ round: 0, actor: 'system', type: 'run_created', content: 'T', timestamp: T }],
    });
    const paths = runPaths(runsDir, RUN);
    const before = (await readStableRunSnapshot(runsDir, RUN)).revision;

    await initializeInvocationLedger(paths);
    const ledger = await openInvocationLedger(paths, RUN);
    const record = await ledger.append(
      {
        identity: { generation: 'LEGACY_V2_EXECUTION', agent_kind: 'claude', provider: 'claude' },
        trigger_kind: 'STEP',
      },
      AT,
    );
    const usage = await openUsageLedger(paths, RUN);
    await usage.append(
      { invocation_id: record.invocation_id, provenance: 'CCR_MEASURED', exit_code: 0 },
      AT,
    );

    assert.equal((await readStableRunSnapshot(runsDir, RUN)).revision, before);
    assert.equal((await readUsageReadModel(paths)).invocations.total, 1);
  } finally {
    await removeTempDir(four);
  }
});

// ==========================================================================
// G. Frontières
// ==========================================================================

test('35 · un seul axe agrégé, les deux générations, et rien d’étranger', async () => {
  const b = await box('ccr-usage-axes-');
  try {
    // 29 · deux déclencheurs, un seul agrégat de fournisseur.
    const step = await b.engage('claude', 'STEP');
    const send = await b.engage('claude', 'SEND');
    await b.observe(step, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });
    await b.observe(send, { provenance: 'PROVIDER_REPORTED', outcome: 'RESPONSE_RECEIVED', ...CLAUDE_USAGE });

    // Identité native, dans le même journal.
    const ledger = await openInvocationLedger(b.paths, RUN);
    const native = await ledger.append(
      {
        identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
        trigger_kind: 'START',
      },
      AT,
    );

    const model = await b.read();
    const claude = providerOf(model, 'claude');
    assert.equal(claude.invocations, 3, 'aucune enveloppe par déclencheur');
    assert.equal(model.providers.length, 1);

    // Les deux formes d'identité coexistent, sans deux lecteurs.
    const legacyView = model.by_invocation.find((entry) => entry.invocation_id === step);
    assert.equal(legacyView?.identity.generation, 'LEGACY_V2_EXECUTION');
    if (legacyView?.identity.generation !== 'LEGACY_V2_EXECUTION') throw new Error('legacy attendu');
    assert.equal(legacyView.identity.agent_kind, 'claude');

    const nativeView = model.by_invocation.find(
      (entry) => entry.invocation_id === native.invocation_id,
    );
    assert.equal(nativeView?.identity.generation, 'NATIVE_V21_EXECUTION');
    if (nativeView?.identity.generation !== 'NATIVE_V21_EXECUTION') throw new Error('natif attendu');
    assert.equal(nativeView.identity.expert_slot, 'author');
    assert.equal(nativeView.provider, 'claude', 'le fournisseur vient du journal d’invocations');

    // Le trigger reste visible par invocation, jamais agrégé.
    assert.deepEqual(
      model.by_invocation.map((entry) => entry.trigger_kind).sort(),
      ['SEND', 'START', 'STEP'],
    );
    const serialized = JSON.stringify(model.providers);
    for (const forbidden of ['trigger', 'expert_slot', 'agent_kind']) {
      assert.equal(serialized.includes(forbidden), false, `l’agrégat ignore ${forbidden}`);
    }
  } finally {
    await b.cleanup();
  }
});

test('36 · gardes : aucune dépendance étrangère, aucun total générique', async () => {
  const { readFile } = await import('node:fs/promises');
  const executable = async (relative: string): Promise<string> => {
    const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  const service = await executable('services/usage-read-model.ts');
  // Ni tarif, ni coût estimé, ni politique, ni quota.
  for (const forbidden of [
    'pricing',
    'CostEstimate',
    'invocation-policy',
    'assertInvocationQuotaAvailable',
    'invocation-quota',
    'openInvocationPolicyStore',
  ]) {
    assert.equal(service.includes(forbidden), false, `le service ignore ${forbidden}`);
  }
  // Aucun total générique, à aucun endroit de la surface.
  for (const forbidden of ['total_tokens', 'cross_provider', 'all_providers']) {
    assert.equal(service.includes(forbidden), false, `aucun ${forbidden}`);
  }
  // Lecture seule : aucune primitive mutante.
  for (const forbidden of ['initializeInvocationLedger', '.append(', 'writeFile', 'create(']) {
    assert.equal(service.includes(forbidden), false, `le service n’écrit pas (${forbidden})`);
  }

  // Les journaux et les classifieurs ignorent le read model.
  for (const relative of [
    'store/invocation-ledger.ts',
    'store/usage-ledger.ts',
    'services/recovery-planner.ts',
    'core/run-liveness.ts',
    'cockpit/long-operations.ts',
    'services/invocation-quota.ts',
    'services/invocation-quota-read.ts',
  ]) {
    const code = await executable(relative);
    assert.equal(code.includes('usage-read-model'), false, `${relative} ignore le read model`);
  }

  // Le classifieur d'initialisation natif reste indépendant.
  const recovery = await executable('services/native-recovery-service.ts');
  const classifier = recovery.slice(
    recovery.indexOf('export function buildNativeInitializationView'),
    recovery.indexOf('async function loadNativeRun'),
  );
  assert.equal(classifier.includes('usage'), false);
});
