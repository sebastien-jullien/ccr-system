/**
 * Tests unitaires du CodexAdapter (lot V1.3).
 *
 * Périmètre assumé : analyse du flux JSONL, modes d'échec, forme exacte de la
 * ligne de commande, transmission du prompt par stdin.
 *
 * Ces tests ne prouvent PAS la continuité conversationnelle native : seule la
 * CLI réelle peut la démontrer (tests/integration/codex-continuity.test.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { createCodexAdapter, parseCodexJsonl, resolveCodexLauncher } from '../../src/adapters/codex-adapter.ts';
import type { CodexAdapterConfig } from '../../src/adapters/codex-adapter.ts';
import type { AgentLauncher } from '../../src/adapters/agent-adapter.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const LAUNCHER: AgentLauncher = {
  executable: process.execPath,
  prefixArgs: [FIXTURE],
  source: 'test-fixture',
};

interface AdapterHarness {
  readonly config: CodexAdapterConfig;
  readonly argsFile: string;
  cleanup(): Promise<void>;
}

async function harness(
  mode: string,
  extra: Partial<CodexAdapterConfig> = {},
): Promise<AdapterHarness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-codex-'));
  const argsFile = path.join(dir, 'args.json');
  return {
    argsFile,
    config: {
      cwd: dir,
      timeoutMs: 30_000,
      launcher: LAUNCHER,
      env: { ...process.env, FAKE_CODEX_MODE: mode, FAKE_CODEX_ARGS_FILE: argsFile },
      ...extra,
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function expectCcrError(promise: Promise<unknown>, code: CcrErrorCode): Promise<CcrError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isCcrError(error), `attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`attendu une CcrError ${code}, aucune erreur levée`);
}

async function readArgs(argsFile: string): Promise<string[]> {
  return JSON.parse(await readFile(argsFile, 'utf8')) as string[];
}

// --------------------------------------------------------------------------
// Analyse du flux JSONL
// --------------------------------------------------------------------------

test('parseCodexJsonl extrait le thread_id et le message final', () => {
  const stream = [
    '{"type":"thread.started","thread_id":"019fdd0a-38d8-7793-8232-e3447e6848db"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"BETA-494379"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10}}',
    '',
  ].join('\n');

  const parsed = parseCodexJsonl(stream);

  assert.equal(parsed.sessionId, '019fdd0a-38d8-7793-8232-e3447e6848db');
  assert.equal(parsed.finalMessage, 'BETA-494379');
  assert.equal(parsed.turnCompleted, true);
  assert.equal(parsed.failureMessage, undefined);
  assert.equal(parsed.eventCount, 4);
});

test('parseCodexJsonl retient le dernier agent_message', () => {
  const parsed = parseCodexJsonl(
    [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"premier"}}',
      '{"type":"item.completed","item":{"type":"command_execution","text":"ls"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"dernier"}}',
      '{"type":"turn.completed"}',
    ].join('\n'),
  );

  assert.equal(parsed.finalMessage, 'dernier');
});

test('parseCodexJsonl tolère un type inconnu et le signale', () => {
  const parsed = parseCodexJsonl(
    [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.future_kind","payload":{}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
      '{"type":"turn.completed"}',
    ].join('\n'),
  );

  assert.deepEqual(parsed.unknownEventTypes, ['item.future_kind']);
  assert.equal(parsed.finalMessage, 'ok');
});

test('parseCodexJsonl rejette une ligne JSONL tronquée', () => {
  assert.throws(
    () => parseCodexJsonl('{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.st'),
    (error: unknown) => {
      assert.ok(isCcrError(error));
      assert.equal(error.code, 'AGENT_OUTPUT_UNPARSABLE');
      assert.equal(error.details['line'], 2);
      return true;
    },
  );
});

test('parseCodexJsonl rejette un événement sans champ type', () => {
  assert.throws(
    () => parseCodexJsonl('{"foo":1}'),
    (error: unknown) => isCcrError(error) && error.code === 'AGENT_OUTPUT_UNPARSABLE',
  );
});

// --------------------------------------------------------------------------
// Comportement de l'adapter
// --------------------------------------------------------------------------

test('start crée un thread, renvoie son identifiant et conserve les flux bruts', async () => {
  const h = await harness('ok');
  try {
    const result = await createCodexAdapter(h.config).start('bonjour');

    assert.equal(result.agent, 'codex');
    assert.equal(result.sessionId, 'thread-fixture-0001');
    assert.equal(result.content, 'ECHO:bonjour');
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdoutRaw.includes('thread.started'));
    // stderr est conservé mais n'est jamais interprété comme une réponse.
    assert.ok(result.stderrRaw.includes('Reading additional input'));
    assert.ok(!result.content.includes('Reading additional input'));
    assert.ok(Date.parse(result.startedAt) <= Date.parse(result.completedAt));
  } finally {
    await h.cleanup();
  }
});

test('start compose exec --json … - et transmet le prompt par stdin', async () => {
  const h = await harness('ok');
  try {
    await createCodexAdapter(h.config).start('bonjour');
    const args = await readArgs(h.argsFile);

    assert.deepEqual(args, ['exec', '--json', '-']);
  } finally {
    await h.cleanup();
  }
});

test('start ajoute la politique de bac à sable uniquement si elle est demandée', async () => {
  const withSandbox = await harness('ok', { sandbox: 'read-only' });
  try {
    await createCodexAdapter(withSandbox.config).start('x');
    assert.deepEqual(await readArgs(withSandbox.argsFile), ['exec', '--json', '-s', 'read-only', '-']);
  } finally {
    await withSandbox.cleanup();
  }

  const withoutSandbox = await harness('ok');
  try {
    await createCodexAdapter(withoutSandbox.config).start('x');
    assert.ok(!(await readArgs(withoutSandbox.argsFile)).includes('-s'));
  } finally {
    await withoutSandbox.cleanup();
  }
});

test("resume n'envoie jamais -s et cible explicitement le thread demandé", async () => {
  const h = await harness('ok');
  try {
    const result = await createCodexAdapter({ ...h.config, sandbox: 'read-only' }).resume(
      'thread-existant-42',
      'suite',
    );
    const args = await readArgs(h.argsFile);

    assert.deepEqual(args, ['exec', 'resume', 'thread-existant-42', '--json', '-']);
    assert.ok(!args.includes('-s'), 'codex exec resume refuse -s');
    assert.equal(result.sessionId, 'thread-existant-42');
    assert.equal(result.content, 'ECHO:suite');
  } finally {
    await h.cleanup();
  }
});

test('skipGitRepoCheck reste optionnel et explicite', async () => {
  const on = await harness('ok', { skipGitRepoCheck: true });
  try {
    await createCodexAdapter(on.config).start('x');
    assert.ok((await readArgs(on.argsFile)).includes('--skip-git-repo-check'));
  } finally {
    await on.cleanup();
  }

  const off = await harness('ok');
  try {
    await createCodexAdapter(off.config).start('x');
    assert.ok(!(await readArgs(off.argsFile)).includes('--skip-git-repo-check'));
  } finally {
    await off.cleanup();
  }
});

test('un prompt volumineux passe par stdin sans limite de ligne de commande', async () => {
  const h = await harness('len');
  try {
    const big = 'é'.repeat(120_000);
    const result = await createCodexAdapter(h.config).start(big);

    assert.equal(result.content, `LEN:${big.length}`);
    const args = await readArgs(h.argsFile);
    assert.ok(args.every((arg) => arg.length < 100), 'aucun argument ne porte le prompt');
  } finally {
    await h.cleanup();
  }
});

test('un code de sortie non nul devient une erreur explicite et préserve le thread', async () => {
  const h = await harness('nonzero');
  try {
    const error = await expectCcrError(createCodexAdapter(h.config).start('x'), 'AGENT_EXIT_NONZERO');
    assert.equal(error.details['exitCode'], 7);
    assert.equal(error.details['sessionId'], 'thread-fixture-0001');
    assert.ok(String(error.details['stderrTail']).includes('usage limit reached'));
  } finally {
    await h.cleanup();
  }
});

test('un flux JSONL tronqué devient AGENT_OUTPUT_UNPARSABLE', async () => {
  const h = await harness('malformed');
  try {
    await expectCcrError(createCodexAdapter(h.config).start('x'), 'AGENT_OUTPUT_UNPARSABLE');
  } finally {
    await h.cleanup();
  }
});

test("un tour sans turn.completed devient AGENT_OUTPUT_INCOMPLETE", async () => {
  const h = await harness('incomplete');
  try {
    const error = await expectCcrError(createCodexAdapter(h.config).start('x'), 'AGENT_OUTPUT_INCOMPLETE');
    assert.equal(error.details['sessionId'], 'thread-fixture-0001');
  } finally {
    await h.cleanup();
  }
});

test('un thread.started absent devient AGENT_SESSION_ID_MISSING', async () => {
  const h = await harness('no-thread');
  try {
    await expectCcrError(createCodexAdapter(h.config).start('x'), 'AGENT_SESSION_ID_MISSING');
  } finally {
    await h.cleanup();
  }
});

test('un tour sans message final devient AGENT_RESULT_MISSING', async () => {
  const h = await harness('no-message');
  try {
    await expectCcrError(createCodexAdapter(h.config).start('x'), 'AGENT_RESULT_MISSING');
  } finally {
    await h.cleanup();
  }
});

test('un turn.failed devient AGENT_REPORTED_ERROR et non une réponse vide', async () => {
  const h = await harness('failed');
  try {
    const error = await expectCcrError(createCodexAdapter(h.config).start('x'), 'AGENT_REPORTED_ERROR');
    assert.ok(error.message.includes('usage limit reached'));
  } finally {
    await h.cleanup();
  }
});

test('une reprise sur un autre thread devient AGENT_SESSION_MISMATCH', async () => {
  const h = await harness('mismatch');
  try {
    const error = await expectCcrError(
      createCodexAdapter(h.config).resume('thread-demande-1', 'x'),
      'AGENT_SESSION_MISMATCH',
    );
    assert.equal(error.details['expectedSessionId'], 'thread-demande-1');
    assert.equal(error.details['actualSessionId'], 'thread-autre-9999');
  } finally {
    await h.cleanup();
  }
});

test("un dépassement de délai devient AGENT_TIMEOUT sans réponse inventée", async () => {
  const h = await harness('hang', { timeoutMs: 800 });
  try {
    const error = await expectCcrError(createCodexAdapter(h.config).start('x'), 'AGENT_TIMEOUT');
    // L'identité de session déjà annoncée reste récupérable pour la reprise.
    assert.equal(error.details['sessionId'], 'thread-fixture-0001');
  } finally {
    await h.cleanup();
  }
});

test('un événement de type inconnu ne fait pas échouer un tour complet', async () => {
  const h = await harness('unknown');
  try {
    const result = await createCodexAdapter(h.config).start('x');
    assert.equal(result.content, 'ok');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Résolution de l'exécutable
// --------------------------------------------------------------------------

test('resolveCodexLauncher exécute un point d\'entrée .js avec Node', () => {
  const launcher = resolveCodexLauncher('C:/quelque/part/bin/codex.js');

  assert.equal(launcher.executable, process.execPath);
  assert.deepEqual(launcher.prefixArgs, ['C:/quelque/part/bin/codex.js']);
});

test('resolveCodexLauncher accepte un binaire explicite tel quel', () => {
  const launcher = resolveCodexLauncher('/usr/local/bin/codex');

  assert.equal(launcher.executable, '/usr/local/bin/codex');
  assert.deepEqual(launcher.prefixArgs, []);
});
