/**
 * Round store — vue pratique par round (spécification V1, §35, §41).
 *
 * `events.jsonl` reste le journal chronologique principal ; les fichiers de
 * round en sont une projection lisible, plus les sorties brutes conservées
 * pour diagnostic et évolution des parsers.
 *
 * Les sorties brutes sont des **preuves de diagnostic**, pas l'état canonique.
 *
 * Ce module nomme les fichiers de façon neutre (`raw/<agent>.stdout`) : le
 * stockage n'a pas à savoir que l'un produit du JSON et l'autre du JSONL.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError } from '../core/errors.ts';
import type { AgentKind, RoundMetadata } from '../core/run.ts';
import { ROUND_SCHEMA_VERSION } from '../core/run.ts';
import { readJsonFile, writeJsonAtomic } from './atomic-file.ts';
import { roundDir } from './layout.ts';
import type { RunPaths } from './layout.ts';

export interface RoundTurnArtifacts {
  readonly prompt: string;
  readonly response: string;
  readonly stdoutRaw: string;
  readonly stderrRaw: string;
}

export async function ensureRoundDir(paths: RunPaths, round: number): Promise<string> {
  const dir = roundDir(paths, round);
  await mkdir(path.join(dir, 'raw'), { recursive: true });
  return dir;
}

export function roundMetadataPath(paths: RunPaths, round: number): string {
  return path.join(roundDir(paths, round), 'metadata.json');
}

export async function writeRoundMetadata(paths: RunPaths, metadata: RoundMetadata): Promise<void> {
  await ensureRoundDir(paths, metadata.round);
  await writeJsonAtomic(roundMetadataPath(paths, metadata.round), metadata);
}

export async function readRoundMetadata(paths: RunPaths, round: number): Promise<RoundMetadata> {
  const file = roundMetadataPath(paths, round);
  let value: unknown;
  try {
    value = await readJsonFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CcrError('RUN_NOT_FOUND', `Round ${String(round)} absent du run ${paths.runId}.`, {
        details: { runId: paths.runId, round, path: file },
        cause: error,
      });
    }
    throw error;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CcrError('STATE_INVALID', `metadata.json du round ${String(round)} illisible.`);
  }
  const record = value as Record<string, unknown>;
  if (record['schema_version'] !== ROUND_SCHEMA_VERSION) {
    throw new CcrError('SCHEMA_VERSION_UNSUPPORTED', `Round ${String(round)} : schema_version non supportée.`, {
      details: { expected: ROUND_SCHEMA_VERSION, found: record['schema_version'] ?? null },
    });
  }
  return record as unknown as RoundMetadata;
}

/**
 * Écrit les artefacts d'un tour.
 *
 * Le prompt et la réponse sont conservés tels quels : CCR ne résume ni ne
 * reformule le contenu transmis (§26).
 */
export async function writeRoundTurnArtifacts(
  paths: RunPaths,
  round: number,
  agent: AgentKind,
  artifacts: RoundTurnArtifacts,
): Promise<void> {
  const dir = await ensureRoundDir(paths, round);
  await Promise.all([
    writeFile(path.join(dir, `${agent}_prompt.txt`), artifacts.prompt, 'utf8'),
    writeFile(path.join(dir, `${agent}_response.txt`), artifacts.response, 'utf8'),
    writeFile(path.join(dir, 'raw', `${agent}.stdout`), artifacts.stdoutRaw, 'utf8'),
    writeFile(path.join(dir, 'raw', `${agent}.stderr`), artifacts.stderrRaw, 'utf8'),
  ]);
}

export async function readRoundTurnArtifact(
  paths: RunPaths,
  round: number,
  relativeName: string,
): Promise<string> {
  return readFile(path.join(roundDir(paths, round), relativeName), 'utf8');
}
