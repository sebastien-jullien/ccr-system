/**
 * ClaudeAdapter (lot V1.2).
 *
 * Encapsule intégralement les particularités de la CLI Claude Code :
 *
 *  - `claude -p --output-format json` pour un tour non interactif ;
 *  - `claude -p --resume <session_id> --output-format json` pour reprendre la
 *    même conversation native ;
 *  - `claude --resume <session_id>` pour rendre la main à l'humain ;
 *  - le prompt est transmis par `stdin` (accepté par la CLI), ce qui évite la
 *    limite de 32 767 caractères de la ligne de commande Windows ;
 *  - la réponse est une enveloppe JSON unique portant `session_id`, `result`
 *    et `is_error`.
 *
 * Point de vigilance observé sur la CLI réelle (v2.1.220) : une enveloppe peut
 * porter `subtype: "success"` ET `is_error: true` avec un code de sortie non
 * nul. `subtype` n'est donc pas un indicateur de réussite fiable ; seuls le
 * code de sortie et `is_error` le sont.
 *
 * CCR n'ajoute jamais `--dangerously-skip-permissions` ni équivalent (§37).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { CcrError } from '../core/errors.ts';
import { nullableTokenCount, optionalCount, optionalTokenCount } from '../core/usage.ts';
import type { ProviderTimings, UsageObservation } from '../core/usage.ts';
import {
  describeCommand,
  runInteractiveProcess,
  runProcess,
} from '../process/process-runner.ts';
import type { InteractiveResult } from '../process/process-runner.ts';
import { findDirectExecutable, findFirstExisting, isNodeScript, listPathDirectories } from '../process/which.ts';
import type { AgentAdapter, AgentLauncher, AgentTurnResult } from './agent-adapter.ts';
import { DEFAULT_AGENT_TIMEOUT_MS } from './agent-adapter.ts';

export interface ClaudeAdapterConfig {
  /** Répertoire de travail canonique du run. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Chemin explicite vers la CLI (ou vers `cli.js`). */
  readonly executable?: string;
  /** Lanceur déjà résolu. Prioritaire sur `executable`. */
  readonly launcher?: AgentLauncher;
  readonly env?: NodeJS.ProcessEnv;
  readonly unsetEnv?: readonly string[];
  readonly maxOutputBytes?: number;
}

// --------------------------------------------------------------------------
// Résolution de l'exécutable
// --------------------------------------------------------------------------

const NPM_ENTRY_POINT = path.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

export function resolveClaudeLauncher(explicit?: string): AgentLauncher {
  if (explicit !== undefined && explicit.length > 0) {
    return isNodeScript(explicit)
      ? { executable: process.execPath, prefixArgs: [explicit], source: 'explicit-js' }
      : { executable: explicit, prefixArgs: [], source: 'explicit' };
  }

  const direct = findDirectExecutable('claude');
  if (direct !== undefined) {
    return { executable: direct, prefixArgs: [], source: 'path' };
  }

  const dirs = listPathDirectories();
  const shim = findFirstExisting(dirs, ['claude.cmd', 'claude.CMD', 'claude']);
  if (shim !== undefined) {
    const entry = path.join(path.dirname(shim), NPM_ENTRY_POINT);
    if (existsSync(entry)) {
      return { executable: process.execPath, prefixArgs: [entry], source: 'npm-shim' };
    }
  }

  throw new CcrError(
    'AGENT_EXECUTABLE_UNRESOLVED',
    "Impossible de localiser une CLI Claude lançable sans shell. Installez Claude Code ou renseignez un chemin explicite.",
    { details: { agent: 'claude' } },
  );
}

// --------------------------------------------------------------------------
// Analyse de l'enveloppe JSON
// --------------------------------------------------------------------------

export interface ClaudeResultEnvelope {
  readonly type: string | undefined;
  readonly subtype: string | undefined;
  readonly sessionId: string | undefined;
  readonly content: string | undefined;
  readonly isError: boolean;
  /**
   * Usage rapporté par la CLI (`V2.2-IMP-01`).
   *
   * `undefined` lorsque l'enveloppe n'en porte pas — une sortie antérieure reste
   * parfaitement valide, et son absence ne vaut pas zéro.
   */
  readonly usage: UsageObservation | undefined;
}

/**
 * Modèle réellement employé, depuis `modelUsage`.
 *
 * Une seule entrée : c'est le modèle résolu, rapporté par le fournisseur.
 * Plusieurs entrées : **rien n'est choisi**. Retenir la première serait la même
 * faute que résoudre un alias de fournisseur vers l'un des deux experts qui le
 * partagent — l'ambiguïté est un fait, pas un désagrément à trancher.
 */
export function extractClaudeModel(record: Record<string, unknown>): UsageObservation['model'] {
  const table = record['modelUsage'];
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return { source: 'UNKNOWN', reason: 'NOT_REPORTED' };
  }
  const keys = Object.keys(table as Record<string, unknown>);
  if (keys.length === 0) return { source: 'UNKNOWN', reason: 'NOT_REPORTED' };
  if (keys.length > 1) return { source: 'UNKNOWN', reason: 'AMBIGUOUS_MULTIPLE_MODELS' };

  const key = keys[0] as string;
  const entry = (table as Record<string, unknown>)[key];
  const canonical =
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)['canonicalModel']
      : undefined;
  return {
    source: 'PROVIDER_REPORTED',
    resolved_model: typeof canonical === 'string' && canonical.length > 0 ? canonical : key,
  };
}

/**
 * Observations d'usage d'une enveloppe Claude.
 *
 * Chaque champ n'est produit que s'il est **réellement présent**. Rien n'est
 * complété, rien n'est mis à zéro, et `total_cost_usd` devient une observation
 * monétaire du fournisseur — jamais une estimation de CCR.
 */
export function extractClaudeUsage(record: Record<string, unknown>): UsageObservation | undefined {
  const model = extractClaudeModel(record);
  const raw = record['usage'];
  const usage =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;

  const input = usage === undefined ? undefined : optionalTokenCount(usage['input_tokens']);
  const output = usage === undefined ? undefined : optionalTokenCount(usage['output_tokens']);
  const tokens: UsageObservation['tokens'] =
    input === undefined || output === undefined || usage === undefined
      ? undefined
      : {
          provider: 'claude',
          input_tokens: input,
          output_tokens: output,
          cache_creation_input_tokens: nullableTokenCount(usage['cache_creation_input_tokens']),
          cache_read_input_tokens: nullableTokenCount(usage['cache_read_input_tokens']),
        };

  const amount = optionalCount(record['total_cost_usd']);
  const timings: ProviderTimings = {
    ...(optionalCount(record['duration_ms']) === undefined
      ? {}
      : { duration_ms: optionalCount(record['duration_ms']) as number }),
    ...(optionalCount(record['duration_api_ms']) === undefined
      ? {}
      : { duration_api_ms: optionalCount(record['duration_api_ms']) as number }),
    ...(optionalCount(record['ttft_ms']) === undefined
      ? {}
      : { ttft_ms: optionalCount(record['ttft_ms']) as number }),
  };

  const details: Record<string, string | number> = {};
  const turns = optionalCount(record['num_turns']);
  if (turns !== undefined) details['num_turns'] = turns;
  for (const field of ['stop_reason', 'service_tier'] as const) {
    const value = field === 'service_tier' && usage !== undefined ? usage[field] : record[field];
    if (typeof value === 'string' && value.length > 0) details[field] = value;
  }

  const observation: UsageObservation = {
    ...(tokens === undefined ? {} : { tokens }),
    model,
    ...(amount === undefined
      ? {}
      : { provider_reported_cost: { amount, currency: 'USD', source: 'PROVIDER_REPORTED' as const } }),
    ...(Object.keys(timings).length === 0 ? {} : { provider_timings: timings }),
    ...(Object.keys(details).length === 0 ? {} : { provider_details: details }),
  };

  // Une enveloppe qui ne rapporte rien ne produit aucune observation : un objet
  // ne portant qu'un « modèle inconnu » affirmerait avoir observé une absence.
  const observed =
    tokens !== undefined ||
    amount !== undefined ||
    Object.keys(timings).length > 0 ||
    Object.keys(details).length > 0 ||
    model.source === 'PROVIDER_REPORTED';
  return observed ? observation : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toEnvelope(record: Record<string, unknown>): ClaudeResultEnvelope {
  const sessionId = record['session_id'];
  const content = record['result'];
  const type = record['type'];
  const subtype = record['subtype'];
  return {
    type: typeof type === 'string' ? type : undefined,
    subtype: typeof subtype === 'string' ? subtype : undefined,
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
    content: typeof content === 'string' ? content : undefined,
    isError: record['is_error'] === true,
    usage: extractClaudeUsage(record),
  };
}

/**
 * Analyse la sortie de `claude -p --output-format json`.
 *
 * Stratégie déterministe : la sortie entière est d'abord interprétée comme un
 * unique objet JSON. Si elle ne l'est pas, on recherche depuis la fin la
 * dernière ligne constituant un objet JSON de `type: "result"` — ce qui couvre
 * le cas d'un avertissement imprimé avant l'enveloppe. Aucun autre repli n'est
 * tenté : une sortie non interprétable est une erreur explicite.
 */
export function parseClaudeJson(stdout: string): ClaudeResultEnvelope {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new CcrError('AGENT_OUTPUT_UNPARSABLE', 'La CLI Claude n\'a produit aucune sortie structurée.', {
      details: { agent: 'claude' },
    });
  }

  try {
    const record = asObject(JSON.parse(trimmed));
    if (record !== undefined) return toEnvelope(record);
  } catch {
    /* on tente le repli ligne à ligne */
  }

  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line.length === 0 || !line.startsWith('{')) continue;
    try {
      const record = asObject(JSON.parse(line));
      if (record !== undefined && record['type'] === 'result') return toEnvelope(record);
    } catch {
      /* ligne suivante */
    }
  }

  throw new CcrError('AGENT_OUTPUT_UNPARSABLE', "La sortie de la CLI Claude n'est pas un JSON exploitable.", {
    details: { agent: 'claude', preview: trimmed.slice(0, 200) },
  });
}

function scanEnvelopeLeniently(stdout: string): ClaudeResultEnvelope | undefined {
  try {
    return parseClaudeJson(stdout);
  } catch {
    return undefined;
  }
}

function tail(text: string, max = 800): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

// --------------------------------------------------------------------------
// Adapter
// --------------------------------------------------------------------------

export function createClaudeAdapter(config: ClaudeAdapterConfig): AgentAdapter {
  const launcher = config.launcher ?? resolveClaudeLauncher(config.executable);
  const timeoutMs = config.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  async function executeTurn(
    cliArgs: readonly string[],
    prompt: string,
    expectedSessionId?: string,
  ): Promise<AgentTurnResult> {
    const spec = {
      executable: launcher.executable,
      args: [...launcher.prefixArgs, ...cliArgs],
      cwd: config.cwd,
      timeoutMs,
      stdin: prompt,
      ...(config.env === undefined ? {} : { env: config.env }),
      ...(config.unsetEnv === undefined ? {} : { unsetEnv: config.unsetEnv }),
      ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }),
    };
    const command = describeCommand(spec);
    const result = await runProcess(spec);

    const lenient = scanEnvelopeLeniently(result.stdout);
    const baseDetails = {
      agent: 'claude',
      command,
      exitCode: result.exitCode,
      stderrTail: tail(result.stderr),
      sessionId: lenient?.sessionId ?? expectedSessionId ?? null,
    };

    if (result.timedOut) {
      throw new CcrError(
        'AGENT_TIMEOUT',
        `Claude n'a pas répondu dans le délai imparti (${timeoutMs} ms). Aucune réponse n'est supposée.`,
        { details: { ...baseDetails, timeoutMs } },
      );
    }

    if (result.exitCode !== 0) {
      throw new CcrError('AGENT_EXIT_NONZERO', `Claude s'est terminé avec le code ${String(result.exitCode)}.`, {
        details: { ...baseDetails, agentMessage: lenient?.content ?? null },
      });
    }

    const envelope = parseClaudeJson(result.stdout);

    if (envelope.type !== 'result') {
      throw new CcrError('AGENT_OUTPUT_INCOMPLETE', `Enveloppe Claude inattendue (type=${String(envelope.type)}).`, {
        details: { ...baseDetails, type: envelope.type ?? null, subtype: envelope.subtype ?? null },
      });
    }

    // `subtype` peut valoir "success" alors que `is_error` vaut true :
    // seul `is_error` fait foi.
    if (envelope.isError) {
      throw new CcrError('AGENT_REPORTED_ERROR', `Claude a signalé un échec : ${envelope.content ?? 'sans message'}`, {
        details: { ...baseDetails, subtype: envelope.subtype ?? null },
      });
    }

    if (envelope.sessionId === undefined) {
      throw new CcrError('AGENT_SESSION_ID_MISSING', "L'enveloppe Claude ne contient pas de session_id.", {
        details: baseDetails,
      });
    }

    if (expectedSessionId !== undefined && envelope.sessionId !== expectedSessionId) {
      throw new CcrError(
        'AGENT_SESSION_MISMATCH',
        `Claude a répondu pour la session ${envelope.sessionId} au lieu de ${expectedSessionId}.`,
        { details: { ...baseDetails, expectedSessionId, actualSessionId: envelope.sessionId } },
      );
    }

    if (envelope.content === undefined) {
      throw new CcrError('AGENT_RESULT_MISSING', "Le tour Claude n'a produit aucun résultat exploitable.", {
        details: { ...baseDetails, sessionId: envelope.sessionId },
      });
    }

    return {
      agent: 'claude',
      sessionId: envelope.sessionId,
      content: envelope.content,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      stdoutRaw: result.stdout,
      stderrRaw: result.stderr,
      ...(envelope.usage === undefined ? {} : { usageObservation: envelope.usage }),
    };
  }

  return {
    kind: 'claude',

    start(prompt: string): Promise<AgentTurnResult> {
      return executeTurn(['-p', '--output-format', 'json'], prompt);
    },

    resume(sessionId: string, prompt: string): Promise<AgentTurnResult> {
      return executeTurn(['-p', '--resume', sessionId, '--output-format', 'json'], prompt, sessionId);
    },

    openInteractive(sessionId: string): Promise<InteractiveResult> {
      return runInteractiveProcess({
        executable: launcher.executable,
        args: [...launcher.prefixArgs, '--resume', sessionId],
        cwd: config.cwd,
        ...(config.env === undefined ? {} : { env: config.env }),
        ...(config.unsetEnv === undefined ? {} : { unsetEnv: config.unsetEnv }),
      });
    },
  };
}
