/**
 * Tests unitaires du round store (spécification V1, §35, §41).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ensureRoundDir,
  readRoundMetadata,
  writeRoundMetadata,
  writeRoundTurnArtifacts,
} from '../../src/store/round-store.ts';
import { createRunDirectory } from '../../src/store/state-store.ts';
import { roundDir } from '../../src/store/layout.ts';
import { ROUND_SCHEMA_VERSION } from '../../src/core/run.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const NOW = new Date(2026, 7, 7, 17, 50, 0);

test('un round crée un répertoire numéroté sur trois chiffres', async () => {
  const runsDir = await makeTempDir('ccr-rounds-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    await ensureRoundDir(paths, 4);

    assert.deepEqual(await readdir(paths.roundsDir), ['004']);
    assert.deepEqual(await readdir(roundDir(paths, 4)), ['raw']);
  } finally {
    await removeTempDir(runsDir);
  }
});

test('les artefacts d\'un tour conservent le texte original', async () => {
  const runsDir = await makeTempDir('ccr-rounds-artifacts-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const prompt = 'Analyse cette proposition de manière contradictoire.\n\n--- BEGIN CLAUDE ---\ntexte\n--- END CLAUDE ---';
    const response = 'Objection : la route n\'est pas appelée.\n\nDétail…';

    await writeRoundTurnArtifacts(paths, 4, 'codex', {
      prompt,
      response,
      stdoutRaw: '{"type":"thread.started","thread_id":"t"}\n',
      stderrRaw: 'Reading additional input from stdin...\n',
    });

    const dir = roundDir(paths, 4);
    assert.equal(await readFile(path.join(dir, 'codex_prompt.txt'), 'utf8'), prompt);
    assert.equal(await readFile(path.join(dir, 'codex_response.txt'), 'utf8'), response);
    assert.ok((await readFile(path.join(dir, 'raw', 'codex.stdout'), 'utf8')).includes('thread.started'));
    assert.ok((await readFile(path.join(dir, 'raw', 'codex.stderr'), 'utf8')).includes('Reading additional'));
  } finally {
    await removeTempDir(runsDir);
  }
});

test('les deux agents coexistent dans le même round', async () => {
  const runsDir = await makeTempDir('ccr-rounds-both-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    const empty = { stdoutRaw: '', stderrRaw: '' };

    await writeRoundTurnArtifacts(paths, 1, 'claude', { prompt: 'p-claude', response: 'r-claude', ...empty });
    await writeRoundTurnArtifacts(paths, 1, 'codex', { prompt: 'p-codex', response: 'r-codex', ...empty });

    const entries = (await readdir(roundDir(paths, 1))).sort();
    assert.deepEqual(entries, [
      'claude_prompt.txt',
      'claude_response.txt',
      'codex_prompt.txt',
      'codex_response.txt',
      'raw',
    ]);
  } finally {
    await removeTempDir(runsDir);
  }
});

test('les métadonnées de round se relisent et ne portent aucun contexte Git', async () => {
  const runsDir = await makeTempDir('ccr-rounds-meta-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);

    await writeRoundMetadata(paths, {
      schema_version: ROUND_SCHEMA_VERSION,
      run_id: paths.runId,
      round: 2,
      started_at: NOW.toISOString(),
      completed_at: null,
      workspace_cwd: 'E:/prog/exemple',
      turns: [
        {
          agent: 'claude',
          prompt_event_id: 'evt_000005',
          response_event_id: 'evt_000006',
          started_at: NOW.toISOString(),
          completed_at: NOW.toISOString(),
        },
      ],
    });

    const metadata = await readRoundMetadata(paths, 2);
    assert.equal(metadata.round, 2);
    assert.equal(metadata.workspace_cwd, 'E:/prog/exemple');
    assert.equal(metadata.turns.length, 1);
    assert.equal(metadata.turns[0]?.prompt_event_id, 'evt_000005');

    const raw = JSON.parse(await readFile(path.join(roundDir(paths, 2), 'metadata.json'), 'utf8')) as Record<string, unknown>;
    for (const forbidden of ['repo_sha', 'sha', 'branch', 'dirty']) {
      assert.equal(forbidden in raw, false, `amendement A-1 : ${forbidden} ne doit pas être capturé`);
    }
  } finally {
    await removeTempDir(runsDir);
  }
});

test('un round absent produit RUN_NOT_FOUND', async () => {
  const runsDir = await makeTempDir('ccr-rounds-absent-');
  try {
    const paths = await createRunDirectory(runsDir, NOW);
    await assert.rejects(
      readRoundMetadata(paths, 9),
      (error: unknown) => isCcrError(error) && error.code === 'RUN_NOT_FOUND',
    );
  } finally {
    await removeTempDir(runsDir);
  }
});
