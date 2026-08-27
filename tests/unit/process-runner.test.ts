/**
 * Tests unitaires du Process Runner (lot V1.1).
 *
 * Ces tests vérifient un comportement observable, pas une structure : ils
 * lancent de vrais sous-processus (`node -e ...`), ce qui est portable et
 * n'exige aucune CLI d'agent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildChildEnv,
  describeCommand,
  runProcess,
} from '../../src/process/process-runner.ts';
import { CcrError, isCcrError } from '../../src/core/errors.ts';

const NODE = process.execPath;
const CWD = process.cwd();
const NO_TIMEOUT = 60_000;

test('sépare stdout et stderr et conserve le code de sortie 0', async () => {
  const result = await runProcess({
    executable: NODE,
    args: ['-e', 'process.stdout.write("OUT"); process.stderr.write("ERR");'],
    cwd: CWD,
    timeoutMs: NO_TIMEOUT,
  });

  assert.equal(result.stdout, 'OUT');
  assert.equal(result.stderr, 'ERR');
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdoutTruncated, false);
  assert.ok(Date.parse(result.startedAt) <= Date.parse(result.completedAt));
  assert.ok(result.durationMs >= 0);
});

test('conserve un code de sortie non nul sans le transformer en erreur', async () => {
  const result = await runProcess({
    executable: NODE,
    args: ['-e', 'process.stderr.write("boom"); process.exit(3);'],
    cwd: CWD,
    timeoutMs: NO_TIMEOUT,
  });

  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, 'boom');
  assert.equal(result.stdout, '');
});

test('lance le processus dans le cwd demandé', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-runner-'));
  try {
    const expected = await realpath(dir);
    const result = await runProcess({
      executable: NODE,
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd: dir,
      timeoutMs: NO_TIMEOUT,
    });
    assert.equal(await realpath(result.stdout), expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('passe les arguments littéralement, sans interprétation shell', async () => {
  const hostile = 'a && echo pwned > x.txt | b ; c $(d) `e` %PATH%';
  const result = await runProcess({
    executable: NODE,
    args: ['-e', 'process.stdout.write(process.argv[1])', hostile],
    cwd: CWD,
    timeoutMs: NO_TIMEOUT,
  });

  assert.equal(result.stdout, hostile);
  assert.equal(result.exitCode, 0);
});

test('transmet la charge utile stdin', async () => {
  const payload = 'ligne 1\nligne 2\naccents éàü\n';
  const result = await runProcess({
    executable: NODE,
    args: [
      '-e',
      'let d=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>process.stdout.write(d));',
    ],
    cwd: CWD,
    timeoutMs: NO_TIMEOUT,
    stdin: payload,
  });

  assert.equal(result.stdout, payload);
  assert.equal(result.exitCode, 0);
});

test("ferme stdin lorsqu'aucune charge utile n'est fournie", async () => {
  const result = await runProcess({
    executable: NODE,
    args: [
      '-e',
      'process.stdin.on("data",()=>{}); process.stdin.on("end",()=>process.stdout.write("EOF")); process.stdin.resume();',
    ],
    cwd: CWD,
    timeoutMs: 15_000,
  });

  assert.equal(result.stdout, 'EOF');
  assert.equal(result.timedOut, false);
});

test('signale un timeout et tue le processus au lieu de renvoyer une réponse vide valide', async () => {
  const started = Date.now();
  const result = await runProcess({
    executable: NODE,
    args: ['-e', 'process.stdout.write("PARTIEL"); setTimeout(()=>{}, 120000);'],
    cwd: CWD,
    timeoutMs: 700,
  });

  assert.equal(result.timedOut, true, 'le drapeau timedOut doit être positionné');
  assert.ok(Date.now() - started < 30_000, 'le processus doit avoir été tué rapidement');
  // Le contenu partiel reste disponible pour diagnostic, mais `timedOut`
  // interdit à un adapter de le considérer comme une réponse complète.
  assert.equal(result.stdout, 'PARTIEL');
});

test("rejette avec EXECUTABLE_NOT_FOUND lorsque l'exécutable n'existe pas", async () => {
  await assert.rejects(
    runProcess({
      executable: path.join(CWD, 'ccr-executable-qui-nexiste-pas'),
      args: [],
      cwd: CWD,
      timeoutMs: NO_TIMEOUT,
    }),
    (error: unknown) => {
      assert.ok(isCcrError(error), 'doit être une CcrError');
      assert.equal((error as CcrError).code, 'EXECUTABLE_NOT_FOUND');
      return true;
    },
  );
});

test('tronque les flux au-delà du plafond configuré et le signale', async () => {
  const result = await runProcess({
    executable: NODE,
    args: ['-e', 'process.stdout.write("x".repeat(50000));'],
    cwd: CWD,
    timeoutMs: NO_TIMEOUT,
    maxOutputBytes: 1000,
  });

  assert.equal(result.stdout.length, 1000);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, false);
});

test('buildChildEnv retire uniquement les variables demandées', () => {
  const env = buildChildEnv({
    env: { A: '1', B: '2', C: '3' },
    unsetEnv: ['B'],
  });

  assert.equal(env['A'], '1');
  assert.equal(env['B'], undefined);
  assert.equal(env['C'], '3');
});

test('unsetEnv est effectif dans le processus enfant', async () => {
  const result = await runProcess({
    executable: NODE,
    args: ['-e', 'process.stdout.write(String(process.env.CCR_TEST_MARKER));'],
    cwd: CWD,
    timeoutMs: NO_TIMEOUT,
    env: { ...process.env, CCR_TEST_MARKER: 'present' },
    unsetEnv: ['CCR_TEST_MARKER'],
  });

  assert.equal(result.stdout, 'undefined');
});

test('describeCommand tronque les arguments longs et ne divulgue aucun environnement', () => {
  const described = describeCommand(
    { executable: 'claude', args: ['-p', 'x'.repeat(500)] },
    20,
  );

  assert.ok(described.startsWith('claude -p '));
  assert.ok(described.includes('[500]'));
  assert.ok(described.length < 100);
});
