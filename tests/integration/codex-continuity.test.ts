/**
 * IT-03 / IT-04 / IT-05 (partiel) — continuité native Codex.
 *
 * Ce test utilise la VRAIE CLI Codex installée localement. C'est le seul type
 * de test capable de démontrer la propriété fondamentale de la V1 :
 *
 *   un processus meurt, la conversation survit.
 *
 * Aucun mock ne peut prouver cela (CLAUDE.md §14).
 *
 * Exécution : npm run test:integration
 * Le test est ignoré — et le dit — si la CLI n'est pas résolvable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

import { createCodexAdapter, resolveCodexLauncher } from '../../src/adapters/codex-adapter.ts';
import type { AgentLauncher } from '../../src/adapters/agent-adapter.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

function tryResolveLauncher(): AgentLauncher | undefined {
  try {
    return resolveCodexLauncher(process.env['CCR_CODEX_BIN']);
  } catch {
    return undefined;
  }
}

const launcher = tryResolveLauncher();

test(
  'IT-03/IT-04 — Codex conserve son thread natif à travers trois processus distincts',
  { skip: launcher === undefined ? 'CLI Codex introuvable' : false, timeout: 900_000 },
  async () => {
    assert.ok(launcher);
    const cwd = await makeTempDir('ccr-it-codex-');
    const witness = `BETA-${randomInt(100_000, 999_999)}`;

    try {
      const adapter = createCodexAdapter({
        cwd,
        launcher,
        timeoutMs: 600_000,
        sandbox: 'read-only',
        // Le cwd de test n'est pas versionné ; contrainte de contexte, pas
        // une fonctionnalité CCR.
        skipGitRepoCheck: true,
      });

      // --- Tour 1 : création du thread (IT-03) -----------------------------
      const first = await adapter.start(
        `Retiens exactement ce mot temoin pour la suite de notre conversation : ${witness}. ` +
          `Reponds uniquement par OK, sans utiliser aucun outil.`,
      );

      assert.ok(first.sessionId.length > 0, 'un thread_id doit être récupéré');
      assert.equal(first.exitCode, 0);
      assert.ok(first.content.length > 0, 'une réponse doit être récupérable');

      // Le processus du tour 1 est terminé : `runProcess` ne résout qu'après
      // l'événement `close` du processus enfant.

      // --- Tour 2 : reprise du même thread (IT-04) -------------------------
      const second = await adapter.resume(
        first.sessionId,
        `Quel etait exactement le mot temoin que je t'ai demande de retenir ? ` +
          `Reponds uniquement par ce mot, sans utiliser aucun outil.`,
      );

      assert.equal(second.sessionId, first.sessionId, "l'identifiant natif doit rester stable");
      assert.ok(
        second.content.includes(witness),
        `Codex doit restituer le témoin ${witness} ; réponse reçue : ${second.content}`,
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

test(
  'IT-11 (Codex) — une reprise sur un identifiant inexistant échoue explicitement',
  { skip: launcher === undefined ? 'CLI Codex introuvable' : false, timeout: 300_000 },
  async () => {
    assert.ok(launcher);
    const cwd = await makeTempDir('ccr-it-codex-fail-');

    try {
      const adapter = createCodexAdapter({ cwd, launcher, timeoutMs: 240_000, skipGitRepoCheck: true });

      await assert.rejects(
        adapter.resume('00000000-0000-4000-8000-000000000000', 'bonjour'),
        (error: unknown) => {
          assert.ok(isCcrError(error), `attendu une CcrError, reçu ${String(error)}`);
          // Une reprise impossible ne doit jamais devenir une nouvelle session.
          assert.notEqual(error.code, 'AGENT_SESSION_MISMATCH');
          assert.ok(
            ['AGENT_EXIT_NONZERO', 'AGENT_REPORTED_ERROR', 'AGENT_OUTPUT_INCOMPLETE'].includes(error.code),
            `code inattendu : ${error.code}`,
          );
          return true;
        },
      );
    } finally {
      await removeTempDir(cwd);
    }
  },
);
