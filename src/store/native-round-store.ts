/**
 * Artefacts `rounds/` d'un run **natif V2.1** (V0.3, §13.7 ; Q-21-08).
 *
 * `rounds/` reste ce qu'il a toujours été :
 *
 * ```text
 * DIAGNOSTIC
 * NON_CANONICAL
 * ```
 *
 * Il n'est jamais consulté pour décider de l'état, du prochain transfert, de la
 * reprise ou des capacités. La vérité reste `events.jsonl`.
 *
 * Mais il est écrit par CCR et relu à égalité stricte de version : le laisser
 * hors périmètre casserait sa lecture au premier changement de format. Deux
 * défauts concrets le rendaient inutilisable pour un run natif :
 *
 *  - `<agent>_prompt.txt` collisionne dès que les deux experts partagent le
 *    même moteur — un run Claude/Claude écrasait un fichier sur deux ;
 *  - le format v2 initial prévoyait une forme `initial_turn`, que rien ne peut
 *    persister : `rounds/0/` est impossible, un seul `metadata.json` existe par
 *    numéro, et deux tours initiaux s'y écrasaient silencieusement.
 *
 * Décision du micro-gate 1B.1 :
 *
 * ```text
 * START natif V2.1   → aucune écriture dans rounds/
 * STEP  natif V2.1   → un artefact round v2, à partir de rounds/001/
 * ```
 *
 * Les deux positions initiales sont déjà conservées canoniquement dans
 * `events.jsonl`. Leur inventer des numéros de round aurait produit un état
 * faux, pour un artefact qui n'est même pas canonique.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError } from '../core/errors.ts';
import { isExpertSlotId } from '../core/expert.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import { NATIVE_ROUND_SCHEMA_VERSION } from '../core/run-native.ts';
import type { NativeRoundMetadata, NativeRoundTurnRef, RunExecutionMode } from '../core/run-native.ts';
import { ROUND_SCHEMA_VERSION } from '../core/run.ts';
import type { RoundMetadata } from '../core/run.ts';
import { readJsonFile, writeJsonAtomic } from './atomic-file.ts';
import { roundDir } from './layout.ts';
import type { RunPaths } from './layout.ts';
import {
  ensureRoundDir,
  readRoundMetadata,
  roundMetadataPath,
  writeRoundMetadata,
  writeRoundTurnArtifacts,
} from './round-store.ts';
import type { RoundTurnArtifacts } from './round-store.ts';

// --------------------------------------------------------------------------
// Nommage physique des fichiers
// --------------------------------------------------------------------------

export interface NativeRoundArtifactNames {
  readonly prompt: string;
  readonly response: string;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Noms de fichiers d'un tour natif, dérivés du slot.
 *
 * `author` et `challenger` sont distincts par construction ; aucune
 * configuration ne peut donc produire de collision, pas même Claude/Claude.
 *
 * Le paramètre est typé `ExpertSlotId` — passer `'claude'` ne compile pas — et
 * la garde d'exécution couvre le seul chemin restant, celui d'une valeur
 * arrivée d'un JSON non validé.
 */
export function nativeRoundArtifactNames(slot: ExpertSlotId): NativeRoundArtifactNames {
  if (!isExpertSlotId(slot)) {
    throw new CcrError(
      'INVALID_ARGUMENT',
      `Un artefact de round natif est nommé par son slot, jamais par un fournisseur : « ${String(slot)} ».`,
      { details: { slot } },
    );
  }
  return {
    prompt: `${slot}_prompt.txt`,
    response: `${slot}_response.txt`,
    stdout: path.join('raw', `${slot}.stdout`),
    stderr: path.join('raw', `${slot}.stderr`),
  };
}

export async function writeNativeRoundTurnArtifacts(
  paths: RunPaths,
  round: number,
  slot: ExpertSlotId,
  artifacts: RoundTurnArtifacts,
): Promise<void> {
  const names = nativeRoundArtifactNames(slot);
  const dir = await ensureRoundDir(paths, round);
  await Promise.all([
    writeFile(path.join(dir, names.prompt), artifacts.prompt, 'utf8'),
    writeFile(path.join(dir, names.response), artifacts.response, 'utf8'),
    writeFile(path.join(dir, names.stdout), artifacts.stdoutRaw, 'utf8'),
    writeFile(path.join(dir, names.stderr), artifacts.stderrRaw, 'utf8'),
  ]);
}

// --------------------------------------------------------------------------
// Métadonnées v2
// --------------------------------------------------------------------------

function roundInvalid(message: string, details: Record<string, unknown> = {}): CcrError {
  return new CcrError('STATE_INVALID', message, { details });
}

function requireSlot(record: Record<string, unknown>, field: string): ExpertSlotId {
  const value = record[field];
  if (!isExpertSlotId(value)) {
    throw roundInvalid(`round natif : ${field} invalide (${String(value)}) — un slot est attendu.`, { field });
  }
  return value;
}

function requireText(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw roundInvalid(`round natif : ${field} absent ou invalide.`, { field });
  }
  return value;
}

function optionalText(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw roundInvalid(`round natif : ${field} invalide.`, { field });
  return value;
}

function parseTurn(value: unknown, index: number): NativeRoundTurnRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw roundInvalid(`round natif : turns[${index}] doit être un objet.`);
  }
  const record = value as Record<string, unknown>;
  const provider = record['provider'];
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex') {
    throw roundInvalid(`round natif : turns[${index}].provider invalide.`, { field: 'provider' });
  }
  return {
    expert_slot: requireSlot(record, 'expert_slot'),
    prompt_event_id: requireText(record, 'prompt_event_id'),
    response_event_id: optionalText(record, 'response_event_id'),
    started_at: requireText(record, 'started_at'),
    completed_at: optionalText(record, 'completed_at'),
    ...(provider === undefined ? {} : { provider }),
    ...(record['session_id'] === undefined ? {} : { session_id: optionalText(record, 'session_id') }),
  };
}

export function validateNativeRoundMetadata(value: unknown): NativeRoundMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw roundInvalid('round natif : objet JSON attendu.');
  }
  const record = value as Record<string, unknown>;

  if (record['schema_version'] !== NATIVE_ROUND_SCHEMA_VERSION) {
    throw new CcrError('SCHEMA_VERSION_UNSUPPORTED', `round : schema_version non native.`, {
      details: { expected: NATIVE_ROUND_SCHEMA_VERSION, found: record['schema_version'] ?? null },
    });
  }

  const round = record['round'];
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 0) {
    throw roundInvalid(`round natif : round invalide (${String(round)}).`, { field: 'round' });
  }

  const rawTurns = record['turns'];
  if (!Array.isArray(rawTurns)) {
    throw roundInvalid('round natif : turns doit être un tableau.', { field: 'turns' });
  }

  // Un artefact de round v2 **est** un passage de témoin. Il n'y a plus
  // d'union, donc plus de discriminant : `kind` à une seule valeur ne
  // discriminerait rien. Les deux champs de l'ancienne branche initiale sont
  // refusés explicitement, pour qu'une tentative d'écrire un round de START
  // échoue en disant pourquoi (micro-gate 1B.1).
  for (const [field, why] of [
    ['kind', "un artefact de round v2 est toujours un transfert"],
    ['expert_slot', 'un transfert nomme une source et une cible, pas un slot unique'],
  ] as const) {
    if (field in record) {
      throw roundInvalid(
        `round natif : « ${field} » n'existe pas dans le format v2 — ${why} ; ` +
          "START n'écrit aucun artefact de round.",
        { field },
      );
    }
  }

  const source = requireSlot(record, 'source_slot');
  const target = requireSlot(record, 'target_slot');
  if (source === target) {
    throw roundInvalid('round natif : un transfert a une source et une cible distinctes.', {
      field: 'source_slot',
    });
  }

  return {
    schema_version: NATIVE_ROUND_SCHEMA_VERSION,
    run_id: requireText(record, 'run_id'),
    round,
    started_at: requireText(record, 'started_at'),
    completed_at: optionalText(record, 'completed_at'),
    workspace_cwd: requireText(record, 'workspace_cwd'),
    source_slot: source,
    target_slot: target,
    source_event_id: requireText(record, 'source_event_id'),
    response_event_id: optionalText(record, 'response_event_id'),
    turns: rawTurns.map((turn, index) => parseTurn(turn, index)),
  };
}

export async function writeNativeRoundMetadata(paths: RunPaths, metadata: NativeRoundMetadata): Promise<void> {
  const validated = validateNativeRoundMetadata(metadata);
  await ensureRoundDir(paths, validated.round);
  await writeJsonAtomic(roundMetadataPath(paths, validated.round), validated);
}

export async function readNativeRoundMetadata(paths: RunPaths, round: number): Promise<NativeRoundMetadata> {
  const file = roundMetadataPath(paths, round);
  try {
    return validateNativeRoundMetadata(await readJsonFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CcrError('RUN_NOT_FOUND', `Round ${String(round)} absent du run ${paths.runId}.`, {
        details: { runId: paths.runId, round, path: file },
        cause: error,
      });
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// Sélection par génération
// --------------------------------------------------------------------------

export type PersistedRoundMetadata =
  | { readonly execution_mode: 'LEGACY_V2_EXECUTION'; readonly metadata: RoundMetadata }
  | { readonly execution_mode: 'NATIVE_V21_EXECUTION'; readonly metadata: NativeRoundMetadata };

/** Version d'artefact écrite pour une génération donnée. */
export function roundSchemaVersionFor(mode: RunExecutionMode): number {
  return mode === 'LEGACY_V2_EXECUTION' ? ROUND_SCHEMA_VERSION : NATIVE_ROUND_SCHEMA_VERSION;
}

/**
 * Lit l'artefact d'un round selon la génération **du run**.
 *
 * Le mode ne se devine pas depuis le fichier : un run historique lit du v1, un
 * run natif du v2. Une version inattendue est une corruption de l'artefact
 * diagnostique, pas une invitation à changer de lecteur.
 */
export async function readRunRoundMetadata(
  paths: RunPaths,
  mode: RunExecutionMode,
  round: number,
): Promise<PersistedRoundMetadata> {
  return mode === 'LEGACY_V2_EXECUTION'
    ? { execution_mode: mode, metadata: await readRoundMetadata(paths, round) }
    : { execution_mode: mode, metadata: await readNativeRoundMetadata(paths, round) };
}

export async function writeRunRoundMetadata(
  paths: RunPaths,
  mode: RunExecutionMode,
  metadata: RoundMetadata | NativeRoundMetadata,
): Promise<void> {
  const expected = roundSchemaVersionFor(mode);
  if (metadata.schema_version !== expected) {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Un run ${mode} écrit des artefacts de round en version ${String(expected)}.`,
      { details: { mode, expected, found: metadata.schema_version } },
    );
  }
  return mode === 'LEGACY_V2_EXECUTION'
    ? writeRoundMetadata(paths, metadata as RoundMetadata)
    : writeNativeRoundMetadata(paths, metadata as NativeRoundMetadata);
}

/** Chemin absolu d'un artefact de tour, quelle que soit la génération. */
export function roundArtifactPath(paths: RunPaths, round: number, relativeName: string): string {
  return path.join(roundDir(paths, round), relativeName);
}

export { writeRoundTurnArtifacts };
