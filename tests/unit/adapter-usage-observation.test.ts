/**
 * V2.2-IMP-01 — extraction des observations d'usage à la frontière d'adapter.
 *
 * Trois propriétés gouvernent ce fichier.
 *
 *  1. **Ce que le fournisseur rapporte est lu ; rien d'autre n'est fabriqué.**
 *     Codex ne nomme aucun modèle et ne rapporte aucun coût : ils restent
 *     inconnus, et aucun défaut n'est deviné.
 *  2. **Les compteurs ne fusionnent pas.** Les catégories de cache portent le
 *     nom exact de leur moteur, et aucun total n'est dérivé.
 *  3. **Rien de ce qui existait ne casse.** Une sortie antérieure à V2.2, sans
 *     le moindre champ d'usage, s'analyse exactement comme avant.
 *
 * Aucun processus n'est lancé : les parseurs sont exercés sur des fixtures
 * assainies, structurellement dérivées des enveloppes observées en `REAL-01`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractClaudeModel, extractClaudeUsage, parseClaudeJson } from '../../src/adapters/claude-adapter.ts';
import { extractCodexUsage, parseCodexJsonl } from '../../src/adapters/codex-adapter.ts';
import { ccrElapsedMs, nullableTokenCount, optionalCount, optionalTokenCount } from '../../src/core/usage.ts';
import {
  claudeEnvelopeWithUsage,
  claudeEnvelopeWithoutUsage,
  codexStreamWithUsage,
  codexStreamWithoutUsage,
} from '../fixtures/usage-envelopes.ts';

// ==========================================================================
// A. Claude
// ==========================================================================

test('12–14 · Claude : jetons, modèle résolu et coût rapporté sont extraits', async () => {
  const envelope = parseClaudeJson(JSON.stringify(claudeEnvelopeWithUsage()));
  const usage = envelope.usage;
  assert.ok(usage !== undefined, 'une enveloppe portant un usage en produit un');

  // 12 · les quatre compteurs, sous leurs noms exacts.
  assert.deepEqual(usage.tokens, {
    provider: 'claude',
    input_tokens: 11,
    output_tokens: 22,
    cache_creation_input_tokens: 33,
    cache_read_input_tokens: 44,
  });

  // 13 · le modèle vient de `modelUsage`, jamais du lanceur.
  assert.deepEqual(usage.model, { source: 'PROVIDER_REPORTED', resolved_model: 'claude-fixture-1' });

  // 14 · le coût est une observation du fournisseur, et le dit.
  assert.deepEqual(usage.provider_reported_cost, {
    amount: 0.25,
    currency: 'USD',
    source: 'PROVIDER_REPORTED',
  });

  // Le rôle historique de l'enveloppe est intact.
  assert.equal(envelope.type, 'result');
  assert.equal(envelope.sessionId, 'fixture-claude-session');
  assert.equal(envelope.content, 'REPONSE');
  assert.equal(envelope.isError, false);
});

test('15 · les mesures et les scalaires du fournisseur sont facultatifs', async () => {
  const full = extractClaudeUsage(claudeEnvelopeWithUsage());
  assert.deepEqual(full?.provider_timings, { duration_ms: 1200, duration_api_ms: 900, ttft_ms: 400 });
  assert.deepEqual(full?.provider_details, { num_turns: 1, stop_reason: 'end_turn', service_tier: 'standard' });

  // Une enveloppe sans mesures reste parfaitement exploitable : l'absence n'est
  // pas complétée, et surtout pas mise à zéro.
  const sparse = extractClaudeUsage(
    claudeEnvelopeWithUsage({
      duration_ms: undefined,
      duration_api_ms: undefined,
      ttft_ms: undefined,
      num_turns: undefined,
      stop_reason: undefined,
      total_cost_usd: undefined,
    }),
  );
  assert.ok(sparse !== undefined);
  assert.equal(sparse.provider_timings, undefined);
  assert.equal(sparse.provider_reported_cost, undefined, 'aucun coût inventé');
  assert.ok(sparse.tokens !== undefined, 'les jetons restent lus');
});

test('16 · une enveloppe antérieure à V2.2 s’analyse exactement comme avant', async () => {
  const envelope = parseClaudeJson(JSON.stringify(claudeEnvelopeWithoutUsage()));
  assert.equal(envelope.type, 'result');
  assert.equal(envelope.sessionId, 'fixture-claude-session');
  assert.equal(envelope.content, 'REPONSE');
  assert.equal(envelope.isError, false);
  // Aucun usage : l'absence est un état valide, jamais une erreur ni un zéro.
  assert.equal(envelope.usage, undefined);
});

test('Claude · un modèle ambigu n’est jamais tranché', async () => {
  // Une seule entrée : c'est le modèle résolu.
  assert.deepEqual(extractClaudeModel({ modelUsage: { 'm-1': { canonicalModel: 'm-1' } } }), {
    source: 'PROVIDER_REPORTED',
    resolved_model: 'm-1',
  });

  // Deux entrées : rien n'est choisi. Retenir la première serait la faute que
  // la résolution d'alias interdit déjà côté experts.
  assert.deepEqual(extractClaudeModel({ modelUsage: { 'm-1': {}, 'm-2': {} } }), {
    source: 'UNKNOWN',
    reason: 'AMBIGUOUS_MULTIPLE_MODELS',
  });

  // Aucune table : inconnu, et pas « ambigu ».
  assert.deepEqual(extractClaudeModel({}), { source: 'UNKNOWN', reason: 'NOT_REPORTED' });
});

// ==========================================================================
// B. Codex
// ==========================================================================

test('17–20 · Codex : cinq compteurs lus, aucun modèle ni coût inventé', async () => {
  const parsed = parseCodexJsonl(codexStreamWithUsage());

  // 17 · les cinq compteurs, sous leurs noms exacts.
  assert.deepEqual(parsed.usage?.tokens, {
    provider: 'codex',
    input_tokens: 100,
    output_tokens: 40,
    cached_input_tokens: 60,
    cache_write_input_tokens: 5,
    reasoning_output_tokens: 12,
  });

  // 19–20 · ni modèle ni coût : Codex n'en rapporte aucun, et rien n'est deviné.
  assert.deepEqual(parsed.usage?.model, { source: 'UNKNOWN', reason: 'NOT_REPORTED' });
  assert.equal(parsed.usage?.provider_reported_cost, undefined);
  assert.equal(parsed.usage?.provider_timings, undefined);

  // Le rôle historique du flux est intact.
  assert.equal(parsed.sessionId, 'fixture-codex-thread');
  assert.equal(parsed.finalMessage, 'REPONSE');
  assert.equal(parsed.turnCompleted, true);
  assert.equal(parsed.failureMessage, undefined);
});

test('18 · 21 · types inconnus tolérés, flux antérieur inchangé', async () => {
  const parsed = parseCodexJsonl(codexStreamWithoutUsage());

  // 18 · la tolérance aux types inconnus est celle du contrat existant.
  assert.deepEqual(parsed.unknownEventTypes, ['turn.metrics.unknown']);
  // 21 · un `turn.completed` sans usage reste un témoin de fin de tour valide.
  assert.equal(parsed.turnCompleted, true);
  assert.equal(parsed.finalMessage, 'REPONSE');
  assert.equal(parsed.sessionId, 'fixture-codex-thread');
  assert.equal(parsed.usage, undefined, 'aucun usage fabriqué');

  // Un `usage` présent mais inexploitable ne produit pas d'observation vide.
  assert.equal(extractCodexUsage({ usage: { input_tokens: 'beaucoup' } }), undefined);
  assert.equal(extractCodexUsage({}), undefined);
});

// ==========================================================================
// C. Sémantique des compteurs
// ==========================================================================

test('tokens · aucun total dérivé, aucune catégorie de cache fusionnée', async () => {
  const claude = extractClaudeUsage(claudeEnvelopeWithUsage());
  const codex = parseCodexJsonl(codexStreamWithUsage()).usage;

  // Aucun total n'est produit : les deux moteurs ne composent pas leurs
  // compteurs de la même façon, et la règle n'est pas démontrée.
  for (const observation of [claude, codex]) {
    assert.equal('total_tokens' in (observation?.tokens ?? {}), false);
  }

  // Et aucun nom commun ne recouvre les deux notions de cache.
  const claudeKeys = Object.keys(claude?.tokens ?? {});
  const codexKeys = Object.keys(codex?.tokens ?? {});
  assert.ok(claudeKeys.includes('cache_creation_input_tokens'));
  assert.ok(codexKeys.includes('cache_write_input_tokens'));
  assert.equal(claudeKeys.includes('cache_write_input_tokens'), false);
  assert.equal(codexKeys.includes('cache_creation_input_tokens'), false);
});

test('durée · la primitive CCR existe et reste hors des journaux', async () => {
  assert.equal(
    ccrElapsedMs({ startedAt: '2026-08-11T00:00:00.000Z', completedAt: '2026-08-11T00:00:01.500Z' }),
    1500,
  );
  // Une paire inexploitable ne devient pas zéro.
  assert.equal(ccrElapsedMs({ startedAt: 'plus tard', completedAt: 'avant' }), undefined);
});

// ==========================================================================
// D. Domaine numerique des compteurs (V2.2-IMP-12R)
// ==========================================================================

test('jetons - un compteur est un entier sur non negatif, et rien d autre', () => {
  // Zero est une valeur observee, pas une absence.
  assert.equal(optionalTokenCount(0), 0);
  assert.equal(optionalTokenCount(1247744), 1247744);
  assert.equal(nullableTokenCount(0), 0);

  // Refuses a la frontiere, jamais arrondis pour les faire passer : un jeton
  // fractionnaire atteindrait plus loin une conversion entiere exacte qui
  // leverait une exception technique brute.
  for (const rejected of [1.5, -1, -0.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(optionalTokenCount(rejected), undefined, `refuse ${String(rejected)}`);
    assert.equal(nullableTokenCount(rejected), null, `refuse ${String(rejected)}`);
  }
  for (const rejected of ['12', null, undefined, {}]) {
    assert.equal(optionalTokenCount(rejected), undefined);
  }

  // Le montant rapporte par le fournisseur, lui, reste fractionnaire : ce n'est
  // pas un compteur, et le contraindre a l'entier detruirait l'observation.
  assert.equal(optionalCount(0.25), 0.25);
  assert.equal(optionalCount(0), 0);
  assert.equal(optionalCount(-1), undefined);
});

test('jetons - a la frontiere d adapter, un compteur douteux ne produit aucun jeton', () => {
  const base = claudeEnvelopeWithUsage();
  const usage = base['usage'] as Record<string, unknown>;

  const fractional = extractClaudeUsage(
    claudeEnvelopeWithUsage({ usage: { ...usage, input_tokens: 1.5 } }),
  );
  assert.equal(fractional?.tokens, undefined, 'aucun compteur fabrique a partir d une valeur douteuse');
  // Ce que le fournisseur a bien rapporte survit : le refus est local.
  assert.equal(fractional?.provider_reported_cost?.amount, 0.25);
  assert.equal(fractional?.model.source, 'PROVIDER_REPORTED');

  // Un cache fractionnaire n'est pas non plus arrondi : il devient une absence
  // declaree, exactement comme un cache non rapporte.
  const cache = extractClaudeUsage(
    claudeEnvelopeWithUsage({ usage: { ...usage, cache_read_input_tokens: 0.5 } }),
  );
  assert.equal(
    cache?.tokens?.provider === 'claude' ? cache.tokens.cache_read_input_tokens : 'absent',
    null,
  );

  // Et le chemin nominal reste intact.
  const nominal = extractClaudeUsage(base);
  assert.equal(nominal?.tokens?.input_tokens, 11);
  assert.equal(parseCodexJsonl(codexStreamWithUsage()).usage?.tokens?.input_tokens !== undefined, true);
});
