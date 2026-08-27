/**
 * Frontière d'adapter (spécification V1, §6).
 *
 * Le cœur de CCR raisonne sur un résultat de tour générique. Le format natif
 * Claude ou Codex ne doit jamais fuiter hors de son adapter.
 *
 * Portée volontairement close : la V1 possède exactement deux intégrations.
 * Ce fichier n'est pas un socle de « providers » extensible ; c'est le
 * vocabulaire commun minimal permettant d'isoler deux CLI qui diffèrent.
 */

import type { InteractiveResult } from '../process/process-runner.ts';
import type { AgentKind } from '../core/run.ts';
import type { UsageObservation } from '../core/usage.ts';

export type { AgentKind };

/** Délai par défaut d'un tour agent (spécification V1, §33). */
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Résultat normalisé d'un tour d'agent.
 *
 * `stdoutRaw` / `stderrRaw` sont des preuves de diagnostic conservables
 * (spécification V1, §35) ; ils ne constituent pas l'état canonique.
 */
export interface AgentTurnResult {
  readonly agent: AgentKind;
  readonly sessionId: string;
  readonly content: string;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly stdoutRaw: string;
  readonly stderrRaw: string;
  /**
   * Ce que le fournisseur a rapporté sur ce tour (CCR V2.2, `V2.2-IMP-01`).
   *
   * **Facultatif de bout en bout.** Un tour peut aboutir sans qu'aucun usage
   * soit publié, et toute sortie antérieure à V2.2 en est dépourvue : son
   * absence n'est jamais une erreur, et ne vaut jamais zéro.
   *
   * Extrait ici, à la frontière d'adapter, pendant que la sortie structurée est
   * encore disponible — le contrat ne dépend donc pas de la conservation du
   * `stdout` brut. L'adapter ne persiste rien, ne calcule aucun prix et ne
   * décide d'aucun quota : il observe et rend.
   */
  readonly usageObservation?: UsageObservation;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** Crée une nouvelle conversation native et renvoie son identifiant. */
  start(prompt: string): Promise<AgentTurnResult>;
  /**
   * Reprend une conversation native existante.
   * Un échec de reprise ne doit jamais se transformer en nouvelle session.
   */
  resume(sessionId: string, prompt: string): Promise<AgentTurnResult>;
  /** Ouvre la session dans la CLI officielle, attachée au terminal humain. */
  openInteractive(sessionId: string): Promise<InteractiveResult>;
}

/**
 * Exécutable résolu pour une CLI d'agent.
 *
 * `prefixArgs` couvre le cas des installations npm sous Windows, où le point
 * d'entrée officiel est un fichier JavaScript exécuté par Node plutôt qu'un
 * binaire lançable directement.
 */
export interface AgentLauncher {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  /** Origine de la résolution, pour diagnostic (`explicit`, `path`, `npm-shim`). */
  readonly source: string;
}
