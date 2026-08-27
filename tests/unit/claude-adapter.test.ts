/**
 * Tests unitaires du ClaudeAdapter (lot V1.2).
 *
 * Périmètre assumé : analyse de l'enveloppe JSON, modes d'échec, forme exacte
 * de la ligne de commande, transmission du prompt par stdin.
 *
 * Ces tests ne prouvent PAS la continuité conversationnelle native
 * (tests/integration/claude-continuity.test.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import {
  createClaudeAdapter,
  parseClaudeJson,
  resolveClaudeLauncher,
} from '../../src/adapters/claude-adapter.ts';
import type { ClaudeAdapterConfig } from '../../src/adapters/claude-adapter.ts';
import type { AgentLauncher } from '../../src/adapters/agent-adapter.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const LAUNCHER: AgentLauncher = {
  executable: process.execPath,
  prefixArgs: [FIXTURE],
  source: 'test-fixture',
};

interface AdapterHarness {
  readonly config: ClaudeAdapterConfig;
  readonly argsFile: string;
  cleanup(): Promise<void>;
}

async function harness(mode: string, extra: Partial<ClaudeAdapterConfig> = {}): Promise<AdapterHarness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-claude-'));
  const argsFile = path.join(dir, 'args.json');
  return {
    argsFile,
    config: {
      cwd: dir,
      timeoutMs: 30_000,
      launcher: LAUNCHER,
      env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_ARGS_FILE: argsFile },
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
// Analyse de l'enveloppe
// --------------------------------------------------------------------------

test('parseClaudeJson lit session_id et result', () => {
  const envelope = parseClaudeJson(
    '{"type":"result","subtype":"success","is_error":false,"session_id":"abc","result":"bonjour"}',
  );

  assert.equal(envelope.sessionId, 'abc');
  assert.equal(envelope.content, 'bonjour');
  assert.equal(envelope.isError, false);
  assert.equal(envelope.type, 'result');
});

test("parseClaudeJson n'assimile pas subtype:success à une réussite", () => {
  // Enveloppe réellement observée sur claude 2.1.220 lors d'un échec d'auth.
  const envelope = parseClaudeJson(
    '{"is_error":true,"subtype":"success","session_id":"abc","result":"Failed to authenticate: OAuth session expired and could not be refreshed","type":"result"}',
  );

  assert.equal(envelope.subtype, 'success');
  assert.equal(envelope.isError, true);
});

test('parseClaudeJson retrouve l\'enveloppe après une ligne parasite', () => {
  const envelope = parseClaudeJson(
    ['Avertissement non structuré', '{"type":"result","session_id":"abc","result":"ok"}'].join('\n'),
  );

  assert.equal(envelope.sessionId, 'abc');
  assert.equal(envelope.content, 'ok');
});

test('parseClaudeJson rejette une sortie vide', () => {
  assert.throws(
    () => parseClaudeJson('   \n  '),
    (error: unknown) => isCcrError(error) && error.code === 'AGENT_OUTPUT_UNPARSABLE',
  );
});

test('parseClaudeJson rejette un JSON tronqué', () => {
  assert.throws(
    () => parseClaudeJson('{"type":"result","session_id":'),
    (error: unknown) => isCcrError(error) && error.code === 'AGENT_OUTPUT_UNPARSABLE',
  );
});

// --------------------------------------------------------------------------
// Comportement de l'adapter
// --------------------------------------------------------------------------

test('start compose -p --output-format json et transmet le prompt par stdin', async () => {
  const h = await harness('ok');
  try {
    const result = await createClaudeAdapter(h.config).start('bonjour');

    assert.deepEqual(await readArgs(h.argsFile), ['-p', '--output-format', 'json']);
    assert.equal(result.agent, 'claude');
    assert.equal(result.sessionId, 'claude-fixture-0001');
    assert.equal(result.content, 'ECHO:bonjour');
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdoutRaw.includes('session_id'));
  } finally {
    await h.cleanup();
  }
});

test('resume cible explicitement la session demandée', async () => {
  const h = await harness('ok');
  try {
    const result = await createClaudeAdapter(h.config).resume('session-existante-42', 'suite');

    assert.deepEqual(await readArgs(h.argsFile), [
      '-p',
      '--resume',
      'session-existante-42',
      '--output-format',
      'json',
    ]);
    assert.equal(result.sessionId, 'session-existante-42');
    assert.equal(result.content, 'ECHO:suite');
  } finally {
    await h.cleanup();
  }
});

test("CCR n'ajoute jamais d'option d'affaiblissement des permissions", async () => {
  const h = await harness('ok');
  try {
    await createClaudeAdapter(h.config).resume('s1', 'x');
    const args = await readArgs(h.argsFile);

    for (const forbidden of [
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--permission-mode',
      '--fork-session',
    ]) {
      assert.ok(!args.includes(forbidden), `${forbidden} ne doit jamais être ajouté automatiquement`);
    }
  } finally {
    await h.cleanup();
  }
});

test('un prompt volumineux passe par stdin sans limite de ligne de commande', async () => {
  const h = await harness('len');
  try {
    const big = 'é'.repeat(120_000);
    const result = await createClaudeAdapter(h.config).start(big);

    assert.equal(result.content, `LEN:${big.length}`);
    assert.ok((await readArgs(h.argsFile)).every((arg) => arg.length < 100));
  } finally {
    await h.cleanup();
  }
});

test("un échec d'authentification devient AGENT_EXIT_NONZERO, jamais une réponse", async () => {
  const h = await harness('nonzero');
  try {
    const error = await expectCcrError(createClaudeAdapter(h.config).start('x'), 'AGENT_EXIT_NONZERO');

    assert.equal(error.details['exitCode'], 1);
    assert.equal(error.details['sessionId'], 'claude-fixture-0001');
    assert.ok(String(error.details['agentMessage']).includes('Failed to authenticate'));
  } finally {
    await h.cleanup();
  }
});

test('is_error à true avec un code de sortie nul devient AGENT_REPORTED_ERROR', async () => {
  const h = await harness('is-error');
  try {
    const error = await expectCcrError(createClaudeAdapter(h.config).start('x'), 'AGENT_REPORTED_ERROR');
    assert.ok(error.message.includes('quota dépassé'));
  } finally {
    await h.cleanup();
  }
});

test('une sortie JSON tronquée devient AGENT_OUTPUT_UNPARSABLE', async () => {
  const h = await harness('unparsable');
  try {
    await expectCcrError(createClaudeAdapter(h.config).start('x'), 'AGENT_OUTPUT_UNPARSABLE');
  } finally {
    await h.cleanup();
  }
});

test('une sortie vide devient AGENT_OUTPUT_UNPARSABLE et non une réponse vide', async () => {
  const h = await harness('empty');
  try {
    await expectCcrError(createClaudeAdapter(h.config).start('x'), 'AGENT_OUTPUT_UNPARSABLE');
  } finally {
    await h.cleanup();
  }
});

test('une enveloppe sans session_id devient AGENT_SESSION_ID_MISSING', async () => {
  const h = await harness('no-session');
  try {
    await expectCcrError(createClaudeAdapter(h.config).start('x'), 'AGENT_SESSION_ID_MISSING');
  } finally {
    await h.cleanup();
  }
});

test('une enveloppe sans result devient AGENT_RESULT_MISSING', async () => {
  const h = await harness('no-result');
  try {
    await expectCcrError(createClaudeAdapter(h.config).start('x'), 'AGENT_RESULT_MISSING');
  } finally {
    await h.cleanup();
  }
});

test('un type inattendu devient AGENT_OUTPUT_INCOMPLETE', async () => {
  const h = await harness('wrong-type');
  try {
    await expectCcrError(createClaudeAdapter(h.config).start('x'), 'AGENT_OUTPUT_INCOMPLETE');
  } finally {
    await h.cleanup();
  }
});

test('une reprise renvoyant une autre session devient AGENT_SESSION_MISMATCH', async () => {
  const h = await harness('mismatch');
  try {
    const error = await expectCcrError(
      createClaudeAdapter(h.config).resume('session-demandee-1', 'x'),
      'AGENT_SESSION_MISMATCH',
    );

    assert.equal(error.details['expectedSessionId'], 'session-demandee-1');
    assert.equal(error.details['actualSessionId'], 'claude-autre-9999');
  } finally {
    await h.cleanup();
  }
});

test('une ligne parasite avant le JSON ne casse pas le tour', async () => {
  const h = await harness('noise');
  try {
    const result = await createClaudeAdapter(h.config).start('x');
    assert.equal(result.content, 'ECHO:x');
    assert.ok(result.stderrRaw.includes('deprecation'));
  } finally {
    await h.cleanup();
  }
});

test('un dépassement de délai devient AGENT_TIMEOUT sans réponse inventée', async () => {
  const h = await harness('hang', { timeoutMs: 800 });
  try {
    await expectCcrError(createClaudeAdapter(h.config).start('x'), 'AGENT_TIMEOUT');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Résolution de l'exécutable
// --------------------------------------------------------------------------

test('resolveClaudeLauncher exécute un point d\'entrée .js avec Node', () => {
  const launcher = resolveClaudeLauncher('/opt/claude/cli.js');

  assert.equal(launcher.executable, process.execPath);
  assert.deepEqual(launcher.prefixArgs, ['/opt/claude/cli.js']);
});

test('resolveClaudeLauncher trouve la CLI installée localement', () => {
  const launcher = resolveClaudeLauncher();

  assert.ok(launcher.executable.length > 0);
  assert.ok(['path', 'npm-shim'].includes(launcher.source));
});
