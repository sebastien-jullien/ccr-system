/**
 * IT-01 / IT-02 — continuité native Claude Code.
 *
 * Ce test utilise la VRAIE CLI Claude installée localement. Aucun mock ne peut
 * démontrer la propriété visée (CLAUDE.md §14).
 *
 * Statut honnête : si la CLI locale n'est pas authentifiée, le test ne passe
 * PAS silencieusement. Il est marqué `skip` avec un motif préfixé `BLOCKED`,
 * et la propriété doit être reportée comme NOT EMPIRICALLY VERIFIED.
 *
 * Exécution : npm run test:integration
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

import { createClaudeAdapter, resolveClaudeLauncher } from '../../src/adapters/claude-adapter.ts';
import type { AgentLauncher } from '../../src/adapters/agent-adapter.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

/**
 * Variables injectées par une session Claude Code hôte. Les conserver
 * détourne le client enfant vers l'authentification du parent et la fait
 * échouer. Cette purge concerne le contexte d'exécution des tests, pas le
 * comportement par défaut de CCR.
 */
const HOST_AGENT_ENV = Object.keys(process.env).filter((name) =>
  /^(CLAUDE|CLAUDECODE|ANTHROPIC)/.test(name),
);

function tryResolveLauncher(): AgentLauncher | undefined {
  try {
    return resolveClaudeLauncher(process.env['CCR_CLAUDE_BIN']);
  } catch {
    return undefined;
  }
}

const launcher = tryResolveLauncher();

function authenticationBlocked(error: unknown): string | undefined {
  if (!isCcrError(error)) return undefined;
  if (error.code !== 'AGENT_EXIT_NONZERO' && error.code !== 'AGENT_REPORTED_ERROR') return undefined;

  const haystack = [
    error.message,
    String(error.details['agentMessage'] ?? ''),
    String(error.details['stderrTail'] ?? ''),
  ].join(' ');

  return /authenticat|oauth|not logged in|login/i.test(haystack) ? haystack.slice(0, 300) : undefined;
}

test(
  'IT-01/IT-02 — Claude conserve sa session native après arrêt complet du processus',
  { skip: launcher === undefined ? 'CLI Claude introuvable' : false, timeout: 900_000 },
  async (t) => {
    assert.ok(launcher);
    const cwd = await makeTempDir('ccr-it-claude-');
    const witness = `ALPHA-${randomInt(100_000, 999_999)}`;

    try {
      const adapter = createClaudeAdapter({
        cwd,
        launcher,
        timeoutMs: 600_000,
        unsetEnv: HOST_AGENT_ENV,
      });

      // --- Tour 1 : création de la session (IT-01) -------------------------
      let first;
      try {
        first = await adapter.start(
          `Retiens exactement ce mot temoin pour la suite de notre conversation : ${witness}. ` +
            `Reponds uniquement par OK, sans utiliser aucun outil.`,
        );
      } catch (error) {
        const reason = authenticationBlocked(error);
        if (reason !== undefined) {
          t.skip(`BLOCKED — CLI Claude non authentifiée : ${reason}`);
          return;
        }
        throw error;
      }

      assert.ok(first.sessionId.length > 0, 'un session_id doit être récupéré');
      assert.equal(first.exitCode, 0);
      assert.ok(first.content.length > 0, 'une réponse doit être récupérable');

      // Le processus du tour 1 est terminé : `runProcess` ne résout qu'après
      // l'événement `close` du processus enfant.

      // --- Tour 2 : reprise de la même session (IT-02) ---------------------
      const second = await adapter.resume(
        first.sessionId,
        `Quel etait exactement le mot temoin que je t'ai demande de retenir ? ` +
          `Reponds uniquement par ce mot, sans utiliser aucun outil.`,
      );

      assert.equal(second.sessionId, first.sessionId, "l'identifiant natif doit rester stable");
      assert.ok(
        second.content.includes(witness),
        `Claude doit restituer le témoin ${witness} ; réponse reçue : ${second.content}`,
      );

      // --- Tour 3 : la continuité tient sur plusieurs reprises -------------
      const third = await adapter.resume(
        first.sessionId,
        `Repete une derniere fois ce mot temoin, prefixe par TEMOIN=, et rien d'autre. ` +
          `N'utilise aucun outil.`,
      );

      assert.equal(third.sessionId, first.sessionId);
      assert.ok(third.content.includes(witness));
    } finally {
      await removeTempDir(cwd);
    }
  },
);
