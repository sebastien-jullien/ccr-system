/**
 * CodexAdapter (lot V1.3).
 *
 * Encapsule intégralement les particularités de la CLI Codex :
 *
 *  - `codex exec --json` pour créer un thread, `codex exec resume <id> --json`
 *    pour le reprendre ;
 *  - `codex exec` accepte `-s/--sandbox`, **mais pas `codex exec resume`**
 *    (constaté : « error: unexpected argument '-s' found », exit 2) ;
 *  - le prompt est transmis par `stdin` via l'argument positionnel `-`, ce qui
 *    évite la limite de 32 767 caractères de la ligne de commande Windows ;
 *  - la sortie structurée est un flux JSONL sur `stdout`, les diagnostics
 *    partent sur `stderr` ;
 *  - sous Windows une installation npm n'expose qu'un shim `.cmd` non lançable
 *    sans shell : on retombe sur le point d'entrée officiel `bin/codex.js`.
 *
 * Le reste de CCR ne connaît aucun de ces détails.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { CcrError } from '../core/errors.ts';
import { nullableTokenCount, optionalTokenCount } from '../core/usage.ts';
import type { UsageObservation } from '../core/usage.ts';
import {
  describeCommand,
  runInteractiveProcess,
  runProcess,
} from '../process/process-runner.ts';
import type { InteractiveResult } from '../process/process-runner.ts';
import { findDirectExecutable, findFirstExisting, isNodeScript, listPathDirectories } from '../process/which.ts';
import type { AgentAdapter, AgentLauncher, AgentTurnResult } from './agent-adapter.ts';
import { DEFAULT_AGENT_TIMEOUT_MS } from './agent-adapter.ts';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexAdapterConfig {
  /** Répertoire de travail canonique du run. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Chemin explicite vers la CLI (ou vers `bin/codex.js`). */
  readonly executable?: string;
  /** Lanceur déjà résolu. Prioritaire sur `executable`. */
  readonly launcher?: AgentLauncher;
  /**
   * Politique de bac à sable appliquée à la **création** du thread.
   * CCR n'affaiblit jamais les permissions par défaut : sans valeur explicite
   * aucune option n'est ajoutée et la configuration Codex de l'utilisateur
   * s'applique telle quelle.
   */
  readonly sandbox?: CodexSandboxMode;
  /**
   * Contrainte de contexte, pas une fonctionnalité CCR : Codex refuse de
   * s'exécuter hors dépôt Git. Ce drapeau existe uniquement pour permettre
   * de travailler dans un `cwd` non versionné.
   */
  readonly skipGitRepoCheck?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly unsetEnv?: readonly string[];
  readonly maxOutputBytes?: number;
}

// --------------------------------------------------------------------------
// Résolution de l'exécutable
// --------------------------------------------------------------------------

/** Chemin relatif du point d'entrée officiel dans une installation npm. */
const NPM_ENTRY_POINT = path.join('node_modules', '@openai', 'codex', 'bin', 'codex.js');

export function resolveCodexLauncher(explicit?: string): AgentLauncher {
  if (explicit !== undefined && explicit.length > 0) {
    return isNodeScript(explicit)
      ? { executable: process.execPath, prefixArgs: [explicit], source: 'explicit-js' }
      : { executable: explicit, prefixArgs: [], source: 'explicit' };
  }

  const direct = findDirectExecutable('codex');
  if (direct !== undefined) {
    return { executable: direct, prefixArgs: [], source: 'path' };
  }

  const dirs = listPathDirectories();
  const shim = findFirstExisting(dirs, ['codex.cmd', 'codex.CMD', 'codex']);
  if (shim !== undefined) {
    const entry = path.join(path.dirname(shim), NPM_ENTRY_POINT);
    if (existsSync(entry)) {
      return { executable: process.execPath, prefixArgs: [entry], source: 'npm-shim' };
    }
  }

  throw new CcrError(
    'AGENT_EXECUTABLE_UNRESOLVED',
    "Impossible de localiser une CLI Codex lançable sans shell. Installez Codex ou renseignez un chemin explicite.",
    { details: { agent: 'codex' } },
  );
}

// --------------------------------------------------------------------------
// Analyse du flux JSONL
// --------------------------------------------------------------------------

export interface CodexStreamParse {
  readonly sessionId: string | undefined;
  readonly finalMessage: string | undefined;
  readonly turnCompleted: boolean;
  readonly failureMessage: string | undefined;
  /** Types d'événements non reconnus, tolérés mais signalés. */
  readonly unknownEventTypes: readonly string[];
  readonly eventCount: number;
  /**
   * Usage rapporté par `turn.completed` (`V2.2-IMP-01`).
   *
   * `undefined` lorsque l'événement n'en porte pas : un flux antérieur reste
   * parfaitement valide, et l'absence ne vaut pas zéro.
   */
  readonly usage: UsageObservation | undefined;
}

/**
 * Observations d'usage d'un `turn.completed` Codex.
 *
 * Les cinq compteurs sont conservés sous les noms exacts que Codex leur donne.
 * Aucun modèle n'est déduit — le flux n'en nomme aucun, et le chercher dans
 * l'environnement, la configuration ou le nom du binaire produirait une
 * identité inventée. Aucun coût non plus : Codex n'en rapporte pas.
 */
export function extractCodexUsage(event: Record<string, unknown>): UsageObservation | undefined {
  const raw = event['usage'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const usage = raw as Record<string, unknown>;

  const input = optionalTokenCount(usage['input_tokens']);
  const output = optionalTokenCount(usage['output_tokens']);
  if (input === undefined || output === undefined) return undefined;

  return {
    tokens: {
      provider: 'codex',
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: nullableTokenCount(usage['cached_input_tokens']),
      cache_write_input_tokens: nullableTokenCount(usage['cache_write_input_tokens']),
      reasoning_output_tokens: nullableTokenCount(usage['reasoning_output_tokens']),
    },
    model: { source: 'UNKNOWN', reason: 'NOT_REPORTED' },
  };
}

const HANDLED_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

function extractMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value !== null && typeof value === 'object') {
    const message = (value as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
}

/**
 * Analyse le flux JSONL de `codex exec --json`.
 *
 * Une ligne syntaxiquement invalide est une erreur explicite (§12) ; un type
 * d'événement inconnu est toléré et signalé, afin qu'une évolution de la CLI
 * n'invalide pas un tour par ailleurs complet.
 */
export function parseCodexJsonl(stdout: string): CodexStreamParse {
  const lines = stdout.split(/\r?\n/);
  const unknownEventTypes: string[] = [];

  let sessionId: string | undefined;
  let finalMessage: string | undefined;
  let turnCompleted = false;
  let failureMessage: string | undefined;
  let eventCount = 0;
  let usage: UsageObservation | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line.length === 0) continue;

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('objet JSON attendu');
      }
      event = parsed as Record<string, unknown>;
    } catch (cause) {
      throw new CcrError(
        'AGENT_OUTPUT_UNPARSABLE',
        `Flux JSONL Codex invalide à la ligne ${index + 1}.`,
        { details: { agent: 'codex', line: index + 1, preview: line.slice(0, 200) }, cause },
      );
    }

    eventCount += 1;
    const type = event['type'];
    if (typeof type !== 'string') {
      throw new CcrError(
        'AGENT_OUTPUT_UNPARSABLE',
        `Événement Codex sans champ "type" à la ligne ${index + 1}.`,
        { details: { agent: 'codex', line: index + 1, preview: line.slice(0, 200) } },
      );
    }

    if (!HANDLED_EVENT_TYPES.has(type)) {
      unknownEventTypes.push(type);
      continue;
    }

    switch (type) {
      case 'thread.started': {
        const threadId = event['thread_id'];
        if (typeof threadId === 'string' && threadId.length > 0) sessionId = threadId;
        break;
      }
      case 'item.completed': {
        const item = event['item'];
        if (item !== null && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          if (record['type'] === 'agent_message' && typeof record['text'] === 'string') {
            finalMessage = record['text'];
          }
        }
        break;
      }
      case 'turn.completed':
        // Le rôle historique de cet événement est inchangé : il reste le témoin
        // qui prouve qu'un tour s'est terminé. L'usage qu'il porte était
        // simplement lu et jeté.
        turnCompleted = true;
        usage = extractCodexUsage(event) ?? usage;
        break;
      case 'turn.failed':
        failureMessage = extractMessage(event['error']) ?? 'turn.failed';
        break;
      case 'error':
        failureMessage = extractMessage(event) ?? 'error';
        break;
      default:
        break;
    }
  }

  return {
    sessionId,
    finalMessage,
    turnCompleted,
    failureMessage,
    unknownEventTypes,
    eventCount,
    usage,
  };
}

/**
 * Lecture indulgente destinée aux seuls diagnostics : récupère l'identifiant
 * de thread même lorsque le flux est globalement inexploitable, afin de ne
 * jamais perdre une session native valide (§13).
 */
function scanSessionIdLeniently(stdout: string): string | undefined {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || !line.includes('thread_id')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') {
        const threadId = (parsed as Record<string, unknown>)['thread_id'];
        if (typeof threadId === 'string' && threadId.length > 0) return threadId;
      }
    } catch {
      /* ligne inexploitable : on continue */
    }
  }
  return undefined;
}

function tail(text: string, max = 800): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

// --------------------------------------------------------------------------
// Adapter
// --------------------------------------------------------------------------

export function createCodexAdapter(config: CodexAdapterConfig): AgentAdapter {
  const launcher = config.launcher ?? resolveCodexLauncher(config.executable);
  const timeoutMs = config.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  function commonFlags(): string[] {
    return config.skipGitRepoCheck === true ? ['--skip-git-repo-check'] : [];
  }

  async function executeTurn(
    cliArgs: readonly string[],
    prompt: string,
    expectedSessionId?: string,
  ): Promise<AgentTurnResult> {
    const args = [...launcher.prefixArgs, ...cliArgs];
    const spec = {
      executable: launcher.executable,
      args,
      cwd: config.cwd,
      timeoutMs,
      stdin: prompt,
      ...(config.env === undefined ? {} : { env: config.env }),
      ...(config.unsetEnv === undefined ? {} : { unsetEnv: config.unsetEnv }),
      ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }),
    };
    const command = describeCommand(spec);
    const result = await runProcess(spec);

    const baseDetails = {
      agent: 'codex',
      command,
      exitCode: result.exitCode,
      stderrTail: tail(result.stderr),
    };

    if (result.timedOut) {
      throw new CcrError(
        'AGENT_TIMEOUT',
        `Codex n'a pas répondu dans le délai imparti (${timeoutMs} ms). Aucune réponse n'est supposée.`,
        {
          details: {
            ...baseDetails,
            timeoutMs,
            sessionId: scanSessionIdLeniently(result.stdout) ?? expectedSessionId ?? null,
          },
        },
      );
    }

    if (result.exitCode !== 0) {
      throw new CcrError('AGENT_EXIT_NONZERO', `Codex s'est terminé avec le code ${String(result.exitCode)}.`, {
        details: {
          ...baseDetails,
          sessionId: scanSessionIdLeniently(result.stdout) ?? expectedSessionId ?? null,
        },
      });
    }

    const parsed = parseCodexJsonl(result.stdout);

    if (parsed.failureMessage !== undefined) {
      throw new CcrError('AGENT_REPORTED_ERROR', `Codex a signalé un échec de tour : ${parsed.failureMessage}`, {
        details: { ...baseDetails, sessionId: parsed.sessionId ?? expectedSessionId ?? null },
      });
    }

    if (parsed.sessionId === undefined) {
      throw new CcrError(
        'AGENT_SESSION_ID_MISSING',
        "Le flux Codex ne contient aucun événement thread.started exploitable.",
        { details: { ...baseDetails, eventCount: parsed.eventCount } },
      );
    }

    if (expectedSessionId !== undefined && parsed.sessionId !== expectedSessionId) {
      throw new CcrError(
        'AGENT_SESSION_MISMATCH',
        `Codex a repris le thread ${parsed.sessionId} au lieu de ${expectedSessionId}.`,
        { details: { ...baseDetails, expectedSessionId, actualSessionId: parsed.sessionId } },
      );
    }

    if (!parsed.turnCompleted) {
      throw new CcrError('AGENT_OUTPUT_INCOMPLETE', "Le tour Codex ne s'est pas terminé (turn.completed absent).", {
        details: { ...baseDetails, sessionId: parsed.sessionId, eventCount: parsed.eventCount },
      });
    }

    if (parsed.finalMessage === undefined) {
      throw new CcrError('AGENT_RESULT_MISSING', "Le tour Codex n'a produit aucun message final.", {
        details: { ...baseDetails, sessionId: parsed.sessionId, eventCount: parsed.eventCount },
      });
    }

    return {
      agent: 'codex',
      sessionId: parsed.sessionId,
      content: parsed.finalMessage,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      stdoutRaw: result.stdout,
      stderrRaw: result.stderr,
      ...(parsed.usage === undefined ? {} : { usageObservation: parsed.usage }),
    };
  }

  return {
    kind: 'codex',

    start(prompt: string): Promise<AgentTurnResult> {
      const sandboxFlags = config.sandbox === undefined ? [] : ['-s', config.sandbox];
      // `-` en dernier : argument positionnel PROMPT lu depuis stdin.
      return executeTurn(['exec', '--json', ...sandboxFlags, ...commonFlags(), '-'], prompt);
    },

    resume(sessionId: string, prompt: string): Promise<AgentTurnResult> {
      // `codex exec resume` n'accepte pas `-s` : la politique de bac à sable
      // du thread est celle fixée à sa création.
      return executeTurn(
        ['exec', 'resume', sessionId, '--json', ...commonFlags(), '-'],
        prompt,
        sessionId,
      );
    },

    openInteractive(sessionId: string): Promise<InteractiveResult> {
      return runInteractiveProcess({
        executable: launcher.executable,
        args: [...launcher.prefixArgs, 'resume', sessionId],
        cwd: config.cwd,
        ...(config.env === undefined ? {} : { env: config.env }),
        ...(config.unsetEnv === undefined ? {} : { unsetEnv: config.unsetEnv }),
      });
    },
  };
}
