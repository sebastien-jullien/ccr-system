/**
 * Enveloppes minimales d'usage — **FIXTURE**, jamais `REAL_NOW`.
 *
 * Structurellement dérivées des sorties réellement observées pendant la matrice
 * `V2.1-REAL-01` : mêmes noms de champs, mêmes imbrications, mêmes types. Les
 * valeurs sont assainies et réduites au strict nécessaire.
 *
 * Rien de ce qui appartenait aux vraies exécutions n'y figure : aucun prompt,
 * aucune réponse de modèle, aucun identifiant de session réel, aucun chemin de
 * workspace, aucune donnée d'authentification.
 */

/** Enveloppe `claude -p --output-format json` portant un usage complet. */
export function claudeEnvelopeWithUsage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'fixture-claude-session',
    result: 'REPONSE',
    num_turns: 1,
    stop_reason: 'end_turn',
    duration_ms: 1200,
    duration_api_ms: 900,
    ttft_ms: 400,
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 33,
      cache_read_input_tokens: 44,
      service_tier: 'standard',
    },
    modelUsage: {
      'claude-fixture-1': {
        inputTokens: 11,
        outputTokens: 22,
        costUSD: 0.25,
        canonicalModel: 'claude-fixture-1',
      },
    },
    ...over,
  };
}

/** Enveloppe antérieure à V2.2 : aucun champ d'usage, et parfaitement valide. */
export function claudeEnvelopeWithoutUsage(): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'fixture-claude-session',
    result: 'REPONSE',
  };
}

/** Flux `codex exec --json` portant les cinq compteurs de `turn.completed`. */
export function codexStreamWithUsage(over: Record<string, unknown> = {}): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 'fixture-codex-thread' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'REPONSE' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 60,
        cache_write_input_tokens: 5,
        output_tokens: 40,
        reasoning_output_tokens: 12,
        ...over,
      },
    }),
    '',
  ].join('\n');
}

/** Flux antérieur : `turn.completed` sans usage, et un type inconnu toléré. */
export function codexStreamWithoutUsage(): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 'fixture-codex-thread' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'REPONSE' } }),
    JSON.stringify({ type: 'turn.metrics.unknown', whatever: true }),
    JSON.stringify({ type: 'turn.completed' }),
    '',
  ].join('\n');
}
