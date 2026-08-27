/**
 * Adapter d'agent contrôlé pour les tests de service.
 *
 * Il ne simule PAS la continuité conversationnelle native — cette propriété ne
 * se démontre que sur les vraies CLI (tests/integration). Il sert à exercer
 * les invariants d'orchestration : ordre des écritures, états traversés,
 * classement des échecs.
 */

import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import type { AgentKind } from '../../src/core/run.ts';
import type { UsageObservation } from '../../src/core/usage.ts';
import type { InteractiveResult } from '../../src/process/process-runner.ts';

export interface FakeAdapterCall {
  readonly phase: 'start' | 'resume';
  readonly sessionId: string | undefined;
  readonly prompt: string;
}

export interface FakeAdapterOptions {
  readonly kind: AgentKind;
  readonly sessionId?: string;
  /**
   * Identifiants rendus par les `start()` successifs, consommes dans l'ordre.
   *
   * Necessaire des qu'un meme moteur porte deux experts : un adapter unique
   * doit alors ouvrir deux continuites distinctes. Repeter deux fois le meme
   * identifiant produit exactement la collision que le service doit refuser.
   */
  readonly startSessionIds?: readonly string[];
  /** Identifiant réellement renvoyé lors d'une reprise (pour simuler une dérive). */
  readonly resumeSessionId?: string;
  readonly respond?: (prompt: string) => string;
  /** Retourner `undefined` laisse l'appel réussir : permet un échec ponctuel. */
  readonly failStart?: () => unknown;
  readonly failResume?: () => unknown;
  readonly failInteractive?: () => unknown;
  /** Code de sortie du processus interactif simulé. */
  readonly interactiveExitCode?: number;
  /** Exécuté pendant l'appel : permet d'observer l'état persisté en vol. */
  readonly onCall?: (phase: 'start' | 'resume', prompt: string) => Promise<void> | void;
  /**
   * Usage rapporté par le tour (CCR V2.2).
   *
   * Absent par défaut : c'est exactement la forme d'une sortie antérieure à
   * V2.2, et elle doit rester parfaitement valide.
   */
  readonly usage?: UsageObservation;
  /** Écart entre `startedAt` et `completedAt`, pour éprouver la mesure CCR. */
  readonly elapsedMs?: number;
  /** Exécuté pendant un handoff, avant que celui-ci ne se conclue. */
  readonly onInteractive?: (sessionId: string) => Promise<void> | void;
}

export interface FakeAdapter extends AgentAdapter {
  readonly calls: FakeAdapterCall[];
  readonly interactiveCalls: string[];
}

export function createFakeAdapter(options: FakeAdapterOptions): FakeAdapter {
  const calls: FakeAdapterCall[] = [];
  const interactiveCalls: string[] = [];
  let startIndex = 0;
  const sessionId = options.sessionId ?? `${options.kind}-session-fixture`;
  const respond = options.respond ?? ((prompt: string) => `${options.kind}:${prompt}`);

  function buildResult(effectiveSessionId: string, prompt: string): AgentTurnResult {
    const startedAt = new Date(0).toISOString();
    return {
      agent: options.kind,
      sessionId: effectiveSessionId,
      content: respond(prompt),
      exitCode: 0,
      startedAt,
      completedAt: new Date(options.elapsedMs ?? 0).toISOString(),
      stdoutRaw: `raw-stdout:${prompt}`,
      stderrRaw: '',
      ...(options.usage === undefined ? {} : { usageObservation: options.usage }),
    };
  }

  return {
    kind: options.kind,
    calls,
    interactiveCalls,

    async start(prompt: string): Promise<AgentTurnResult> {
      calls.push({ phase: 'start', sessionId: undefined, prompt });
      await options.onCall?.('start', prompt);
      const failure = options.failStart?.();
      if (failure !== undefined) throw failure;
      const sequenced = options.startSessionIds?.[startIndex];
      startIndex += 1;
      return buildResult(sequenced ?? sessionId, prompt);
    },

    async resume(requestedSessionId: string, prompt: string): Promise<AgentTurnResult> {
      calls.push({ phase: 'resume', sessionId: requestedSessionId, prompt });
      await options.onCall?.('resume', prompt);
      const failure = options.failResume?.();
      if (failure !== undefined) throw failure;
      return buildResult(options.resumeSessionId ?? requestedSessionId, prompt);
    },

    async openInteractive(requestedSessionId: string): Promise<InteractiveResult> {
      interactiveCalls.push(requestedSessionId);
      await options.onInteractive?.(requestedSessionId);
      const failure = options.failInteractive?.();
      if (failure !== undefined) throw failure;
      const at = new Date(0).toISOString();
      return {
        exitCode: options.interactiveExitCode ?? 0,
        signal: null,
        startedAt: at,
        completedAt: at,
        durationMs: 0,
      };
    },
  };
}
