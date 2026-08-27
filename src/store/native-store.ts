/**
 * Frontière de lecture entre les deux générations de documents CCR
 * (spécification V2.1 V0.3, §13.3 à §13.6).
 *
 *   manifest schema 1 → LEGACY_V2_EXECUTION    parseurs de `state-store.ts`
 *   manifest schema 2 → NATIVE_V21_EXECUTION   parseurs de ce module
 *
 * Deux règles gouvernent tout ce fichier :
 *
 *  1. **aucune normalisation montante.** Un document lu conserve la version
 *     qu'il porte. Un état legacy relu puis réécrit reste legacy ; il ne
 *     devient jamais natif par le simple fait d'avoir traversé un parseur ;
 *  2. **aucune double vérité.** Un document natif portant en plus un champ
 *     legacy — `agents`, `active_agent`, `agent` — est une corruption, pas une
 *     source à interpréter. Il est refusé.
 *
 * Ce module ne câble aucune mutation métier : il représente et il valide.
 */

import { CcrError } from '../core/errors.ts';
import type { ExpertSlotBinding, ExpertSlots } from '../core/run-native.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../core/run-native.ts';
import type {
  NativeCodexRuntime,
  NativePendingOperation,
  NativeProviderRuntime,
  NativeRunManifest,
  NativeRunRuntimeConfig,
  NativeRunStateDocument,
  NativeRunUncertainty,
  RunExecutionMode,
} from '../core/run-native.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import { assertTransition } from '../core/state.ts';
import type { ControlOwner, RunState } from '../core/state.ts';
import { EXPERT_SLOT_IDS, isExpertSlotId, isProviderKind } from '../core/expert.ts';
import type { RunManifest, RunStateDocument, RuntimeAuthPreflight, RuntimeConfigSource } from '../core/run.ts';
import { MANIFEST_SCHEMA_VERSION, SUPPORTED_STATE_SCHEMA_VERSIONS } from '../core/run.ts';
import { isControlOwner, isRunState } from '../core/state.ts';
import { readJsonFile, writeJsonAtomic } from './atomic-file.ts';
import type { RunPaths } from './layout.ts';
import {
  asRecord,
  requireString,
  validateManifest,
  validateStateDocument,
} from './state-store.ts';

// --------------------------------------------------------------------------
// Génération d'un run
// --------------------------------------------------------------------------

/**
 * Version de schéma d'un document, avant tout choix de parseur.
 *
 * Extraite seule, parce que c'est elle — et rien d'autre — qui décide de la
 * génération : ni un événement, ni un champ runtime, ni un fournisseur.
 */
function schemaVersionOf(record: Record<string, unknown>, what: string, code: 'MANIFEST_INVALID' | 'STATE_INVALID'): number {
  const version = record['schema_version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new CcrError(code, `${what} : schema_version absente ou non entière.`, {
      details: { found: version ?? null },
    });
  }
  return version;
}

/** Manifest lu, étiqueté par sa génération. Jamais converti d'une vers l'autre. */
export type PersistedManifest =
  | { readonly execution_mode: 'LEGACY_V2_EXECUTION'; readonly manifest: RunManifest }
  | { readonly execution_mode: 'NATIVE_V21_EXECUTION'; readonly manifest: NativeRunManifest };

/** État lu, étiqueté par la génération de son propre document. */
export type PersistedState =
  | { readonly execution_mode: 'LEGACY_V2_EXECUTION'; readonly document: RunStateDocument }
  | { readonly execution_mode: 'NATIVE_V21_EXECUTION'; readonly document: NativeRunStateDocument };

export function executionModeForManifestSchema(version: number): RunExecutionMode {
  if (version === MANIFEST_SCHEMA_VERSION) return 'LEGACY_V2_EXECUTION';
  if (version === NATIVE_MANIFEST_SCHEMA_VERSION) return 'NATIVE_V21_EXECUTION';
  throw new CcrError('SCHEMA_VERSION_UNSUPPORTED', `manifest.json : schema_version ${String(version)} non supportée.`, {
    details: { supported: [MANIFEST_SCHEMA_VERSION, NATIVE_MANIFEST_SCHEMA_VERSION], found: version },
  });
}

// --------------------------------------------------------------------------
// Manifest natif
// --------------------------------------------------------------------------

function manifestInvalid(message: string, field: string): CcrError {
  return new CcrError('MANIFEST_INVALID', message, { details: { field } });
}

function parseExpertSlotBinding(value: unknown, slot: ExpertSlotId): ExpertSlotBinding {
  const record = asRecord(value, 'MANIFEST_INVALID', `experts.${slot}`);

  // La clé porte le rôle. Un `role` à l'intérieur du slot serait une seconde
  // autorité, capable de contredire la clé — donc une double vérité.
  if ('role' in record) {
    throw manifestInvalid(
      `experts.${slot}.role est interdit : la clé du slot porte le rôle.`,
      `experts.${slot}.role`,
    );
  }

  const provider = record['provider'];
  if (!isProviderKind(provider)) {
    throw manifestInvalid(`experts.${slot}.provider invalide : ${String(provider)}.`, `experts.${slot}.provider`);
  }

  const sessionId = record['session_id'];
  if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length === 0)) {
    throw manifestInvalid(`experts.${slot}.session_id invalide.`, `experts.${slot}.session_id`);
  }

  return { provider, session_id: sessionId };
}

function parseExpertSlots(value: unknown): ExpertSlots {
  const record = asRecord(value, 'MANIFEST_INVALID', 'experts');

  const keys = Object.keys(record);
  const unexpected = keys.filter((key) => !isExpertSlotId(key));
  if (unexpected.length > 0) {
    throw manifestInvalid(`experts : clé inattendue ${unexpected.map((k) => `"${k}"`).join(', ')}.`, 'experts');
  }
  for (const slot of EXPERT_SLOT_IDS) {
    if (!keys.includes(slot)) {
      throw manifestInvalid(`experts.${slot} absent : un run possède exactement deux slots.`, `experts.${slot}`);
    }
  }

  return {
    author: parseExpertSlotBinding(record['author'], 'author'),
    challenger: parseExpertSlotBinding(record['challenger'], 'challenger'),
  };
}

function requireAuthPreflight(record: Record<string, unknown>, at: string): RuntimeAuthPreflight {
  const value = record['auth_preflight'];
  if (value !== 'AUTHENTICATED' && value !== 'UNAUTHENTICATED' && value !== 'UNKNOWN') {
    throw manifestInvalid(`${at}.auth_preflight invalide : ${String(value)}.`, 'runtime_config');
  }
  return value;
}

function requireCliVersion(record: Record<string, unknown>, at: string): string | null {
  const value = record['cli_version'];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw manifestInvalid(`${at}.cli_version invalide.`, 'runtime_config');
  }
  return value;
}

/**
 * Analyse les faits d'un fournisseur dans un snapshot natif.
 *
 * L'union est discriminée par `required`, et le contrôle croisé est explicite :
 * un fournisseur requis ne peut pas être `NOT_REQUIRED`, un fournisseur non
 * requis ne peut porter aucune observation. C'est le point exact où un
 * `probe_status` fabriqué serait entré dans un document canonique.
 */
function parseProviderRuntime(value: unknown, at: string): NativeProviderRuntime {
  const record = asRecord(value, 'MANIFEST_INVALID', at);

  const required = record['required'];
  if (typeof required !== 'boolean') {
    throw manifestInvalid(`${at}.required doit être un booléen.`, 'runtime_config');
  }
  const probeStatus = record['probe_status'];

  if (!required) {
    if (probeStatus !== 'NOT_REQUIRED') {
      throw manifestInvalid(
        `${at} : un fournisseur non requis porte probe_status = NOT_REQUIRED, pas ${String(probeStatus)}.`,
        'runtime_config',
      );
    }
    for (const forbidden of ['cli_version', 'auth_preflight']) {
      if (forbidden in record) {
        throw manifestInvalid(
          `${at}.${forbidden} est interdit sur un fournisseur non requis : aucune observation n'a eu lieu.`,
          'runtime_config',
        );
      }
    }
    return { required: false, probe_status: 'NOT_REQUIRED' };
  }

  if (probeStatus !== 'OBSERVED') {
    throw manifestInvalid(
      `${at} : un fournisseur requis a été observé ; probe_status = ${String(probeStatus)} est invalide.`,
      'runtime_config',
    );
  }
  return {
    required: true,
    probe_status: 'OBSERVED',
    cli_version: requireCliVersion(record, at),
    auth_preflight: requireAuthPreflight(record, at),
  };
}

function parseCodexRuntime(value: unknown): NativeCodexRuntime {
  const at = 'runtime_config.codex';
  const base = parseProviderRuntime(value, at);
  const record = asRecord(value, 'MANIFEST_INVALID', at);

  if (!base.required) {
    for (const forbidden of ['skip_git_repo_check', 'source_at_capture']) {
      if (forbidden in record) {
        throw manifestInvalid(
          `${at}.${forbidden} est interdit quand aucun slot n'emploie Codex : rien n'est à gouverner.`,
          'runtime_config',
        );
      }
    }
    return base;
  }

  const skip = record['skip_git_repo_check'];
  if (typeof skip !== 'boolean') {
    // Aucune coercition : c'est la valeur exécutable du run.
    throw manifestInvalid(`${at}.skip_git_repo_check doit être un booléen.`, 'runtime_config');
  }

  const source = record['source_at_capture'];
  if (source !== 'default' && source !== 'config' && source !== 'legacy-env') {
    throw manifestInvalid(`${at}.source_at_capture invalide : ${String(source)}.`, 'runtime_config');
  }

  return {
    ...base,
    skip_git_repo_check: skip,
    source_at_capture: source as RuntimeConfigSource,
  };
}

export function validateNativeRuntimeConfig(value: unknown): NativeRunRuntimeConfig {
  const record = asRecord(value, 'MANIFEST_INVALID', 'runtime_config');

  const version = schemaVersionOf(record, 'runtime_config', 'MANIFEST_INVALID');
  if (version !== NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION) {
    throw new CcrError('SCHEMA_VERSION_UNSUPPORTED', `runtime_config.schema_version ${String(version)} non supportée dans un manifest natif.`, {
      details: { field: 'runtime_config', supported: [NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION], found: version },
    });
  }

  return {
    schema_version: version,
    captured_at: requireString(record, 'captured_at', 'MANIFEST_INVALID'),
    claude: parseProviderRuntime(record['claude'], 'runtime_config.claude'),
    codex: parseCodexRuntime(record['codex']),
  };
}

export function validateNativeManifest(value: unknown): NativeRunManifest {
  const record = asRecord(value, 'MANIFEST_INVALID', 'manifest.json');

  const version = schemaVersionOf(record, 'manifest.json', 'MANIFEST_INVALID');
  if (version !== NATIVE_MANIFEST_SCHEMA_VERSION) {
    throw new CcrError('SCHEMA_VERSION_UNSUPPORTED', `manifest.json : schema_version ${String(version)} n'est pas le schéma natif.`, {
      details: { supported: [NATIVE_MANIFEST_SCHEMA_VERSION], found: version },
    });
  }

  // `agents` et `experts` ne peuvent jamais faire autorité ensemble : ce serait
  // exactement la double vérité que la génération native supprime.
  if ('agents' in record) {
    throw manifestInvalid(
      "manifest.json : `agents` est interdit dans un manifest natif ; `experts` est l'unique autorité.",
      'agents',
    );
  }

  const workspace = asRecord(record['workspace'], 'MANIFEST_INVALID', 'workspace');
  const runtimeConfig =
    record['runtime_config'] === undefined ? undefined : validateNativeRuntimeConfig(record['runtime_config']);

  return {
    schema_version: version,
    run_id: requireString(record, 'run_id', 'MANIFEST_INVALID'),
    title: requireString(record, 'title', 'MANIFEST_INVALID'),
    created_at: requireString(record, 'created_at', 'MANIFEST_INVALID'),
    // `declared_cwd` traverse la revalidation : cette fonction **reconstruit**
    // le manifeste avant écriture, si bien qu'un champ non repris ici
    // disparaîtrait silencieusement du disque.
    workspace: {
      cwd: requireString(workspace, 'cwd', 'MANIFEST_INVALID'),
      ...(workspace['declared_cwd'] === undefined
        ? {}
        : { declared_cwd: requireString(workspace, 'declared_cwd', 'MANIFEST_INVALID') }),
    },
    experts: parseExpertSlots(record['experts']),
    ...(runtimeConfig === undefined ? {} : { runtime_config: runtimeConfig }),
  };
}

// --------------------------------------------------------------------------
// État natif
// --------------------------------------------------------------------------

function stateInvalid(message: string): CcrError {
  return new CcrError('STATE_INVALID', message);
}

function parseSlotOrNull(value: unknown, field: string): ExpertSlotId | null {
  if (value === null || value === undefined) return null;
  if (!isExpertSlotId(value)) {
    throw stateInvalid(`${field} invalide : ${String(value)} n'est pas un slot d'expert.`);
  }
  return value;
}

function requireSlot(value: unknown, field: string): ExpertSlotId {
  const slot = parseSlotOrNull(value, field);
  if (slot === null) throw stateInvalid(`${field} est obligatoire.`);
  return slot;
}

/** Un champ nommé par fournisseur dans une structure native est une corruption. */
function rejectProviderNamedFields(record: Record<string, unknown>, at: string, fields: readonly string[]): void {
  for (const field of fields) {
    if (field in record) {
      throw stateInvalid(`${at}.${field} est interdit dans un document natif : l'identité d'expert est un slot.`);
    }
  }
}

function parseNativeUncertainty(value: unknown): NativeRunUncertainty | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value, 'STATE_INVALID', 'uncertainty');
  rejectProviderNamedFields(record, 'uncertainty', ['agent']);

  const lastEventId = record['last_event_id'];
  return {
    reason: requireString(record, 'reason', 'STATE_INVALID'),
    since: requireString(record, 'since', 'STATE_INVALID'),
    expert_slot: parseSlotOrNull(record['expert_slot'], 'uncertainty.expert_slot'),
    last_event_id: typeof lastEventId === 'string' ? lastEventId : null,
  };
}

function parseNativePendingOperation(value: unknown): NativePendingOperation | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value, 'STATE_INVALID', 'pending_operation');
  rejectProviderNamedFields(record, 'pending_operation', ['agent']);

  const kind = record['kind'];
  if (kind !== 'initialization' && kind !== 'send' && kind !== 'step' && kind !== 'handoff') {
    throw stateInvalid(`pending_operation.kind invalide : ${String(kind)}.`);
  }

  const round = record['round'];
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 0) {
    throw stateInvalid(`pending_operation.round invalide : ${String(round)}.`);
  }

  const returnState = record['return_state'];
  if (!isRunState(returnState)) {
    throw stateInvalid(`pending_operation.return_state invalide : ${String(returnState)}.`);
  }

  const returnControl = record['return_control'];
  if (!isControlOwner(returnControl)) {
    throw stateInvalid(`pending_operation.return_control invalide : ${String(returnControl)}.`);
  }

  const optionalString = (field: string): string | null => {
    const raw = record[field];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') throw stateInvalid(`pending_operation.${field} invalide.`);
    return raw;
  };

  const base = {
    round,
    prompt_event_id: optionalString('prompt_event_id'),
    session_id: optionalString('session_id'),
    return_state: returnState,
    return_control: returnControl,
    started_at: requireString(record, 'started_at', 'STATE_INVALID'),
  };

  if (kind === 'step') {
    const sourceSlot = requireSlot(record['source_slot'], 'pending_operation.source_slot');
    const targetSlot = requireSlot(record['target_slot'], 'pending_operation.target_slot');
    if (sourceSlot === targetSlot) {
      throw stateInvalid('pending_operation : un transfert a une source et une cible distinctes.');
    }
    const sourceEventId = record['source_event_id'];
    if (typeof sourceEventId !== 'string' || sourceEventId.length === 0) {
      // Figé avant tout lancement fournisseur : sans lui, la reprise devinerait.
      throw stateInvalid('pending_operation.source_event_id est obligatoire pour un transfert.');
    }
    return { ...base, kind, source_slot: sourceSlot, target_slot: targetSlot, source_event_id: sourceEventId };
  }

  return { ...base, kind, expert_slot: requireSlot(record['expert_slot'], 'pending_operation.expert_slot') };
}

export function validateNativeStateDocument(value: unknown): NativeRunStateDocument {
  const record = asRecord(value, 'STATE_INVALID', 'state.json');

  const version = schemaVersionOf(record, 'state.json', 'STATE_INVALID');
  if (version !== NATIVE_STATE_SCHEMA_VERSION) {
    throw new CcrError('SCHEMA_VERSION_UNSUPPORTED', `state.json : schema_version ${String(version)} n'est pas le schéma natif.`, {
      details: { supported: [NATIVE_STATE_SCHEMA_VERSION], found: version },
    });
  }

  rejectProviderNamedFields(record, 'state.json', ['active_agent']);

  const state = record['state'];
  if (!isRunState(state)) {
    throw stateInvalid(`État inconnu : ${String(state)}.`);
  }

  const control = record['control'];
  if (!isControlOwner(control)) {
    throw stateInvalid(`Propriétaire du contrôle invalide : ${String(control)}.`);
  }

  const round = record['round'];
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 0) {
    throw stateInvalid(`round invalide : ${String(round)}.`);
  }

  const lastEventId = record['last_event_id'];
  if (lastEventId !== null && lastEventId !== undefined && typeof lastEventId !== 'string') {
    throw stateInvalid('last_event_id invalide.');
  }

  return {
    schema_version: version,
    run_id: requireString(record, 'run_id', 'STATE_INVALID'),
    state,
    control,
    round,
    active_expert_slot: parseSlotOrNull(record['active_expert_slot'], 'active_expert_slot'),
    next_step_source_slot: parseSlotOrNull(record['next_step_source_slot'], 'next_step_source_slot'),
    last_event_id: lastEventId ?? null,
    pending_operation: parseNativePendingOperation(record['pending_operation']),
    uncertainty: parseNativeUncertainty(record['uncertainty']),
    updated_at: requireString(record, 'updated_at', 'STATE_INVALID'),
  };
}

// --------------------------------------------------------------------------
// Lecteurs de génération
// --------------------------------------------------------------------------

/**
 * Ouvre un manifest sans présumer de sa génération.
 *
 * Le résultat est étiqueté, jamais converti : un run historique lu ici reste
 * un document schema 1, et le demeure s'il est réécrit.
 */
export function validatePersistedManifest(value: unknown): PersistedManifest {
  const record = asRecord(value, 'MANIFEST_INVALID', 'manifest.json');
  const mode = executionModeForManifestSchema(schemaVersionOf(record, 'manifest.json', 'MANIFEST_INVALID'));
  return mode === 'LEGACY_V2_EXECUTION'
    ? { execution_mode: mode, manifest: validateManifest(record) }
    : { execution_mode: mode, manifest: validateNativeManifest(record) };
}

export function validatePersistedState(value: unknown): PersistedState {
  const record = asRecord(value, 'STATE_INVALID', 'state.json');
  const version = schemaVersionOf(record, 'state.json', 'STATE_INVALID');

  if (SUPPORTED_STATE_SCHEMA_VERSIONS.includes(version)) {
    return { execution_mode: 'LEGACY_V2_EXECUTION', document: validateStateDocument(record) };
  }
  if (version === NATIVE_STATE_SCHEMA_VERSION) {
    return { execution_mode: 'NATIVE_V21_EXECUTION', document: validateNativeStateDocument(record) };
  }
  throw new CcrError('SCHEMA_VERSION_UNSUPPORTED', `state.json : schema_version ${String(version)} non supportée.`, {
    details: { supported: [...SUPPORTED_STATE_SCHEMA_VERSIONS, NATIVE_STATE_SCHEMA_VERSION], found: version },
  });
}

export async function readPersistedManifest(paths: RunPaths): Promise<PersistedManifest> {
  try {
    return validatePersistedManifest(await readJsonFile(paths.manifest));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CcrError('RUN_NOT_FOUND', `Aucun manifest pour le run ${paths.runId}.`, {
        details: { runId: paths.runId, path: paths.manifest },
        cause: error,
      });
    }
    if (error instanceof SyntaxError) {
      throw new CcrError('MANIFEST_INVALID', `manifest.json illisible pour ${paths.runId}.`, { cause: error });
    }
    throw error;
  }
}

export async function readPersistedState(paths: RunPaths): Promise<PersistedState> {
  try {
    return validatePersistedState(await readJsonFile(paths.state));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CcrError('RUN_NOT_FOUND', `Aucun state.json pour le run ${paths.runId}.`, {
        details: { runId: paths.runId, path: paths.state },
        cause: error,
      });
    }
    if (error instanceof SyntaxError) {
      throw new CcrError('STATE_INVALID', `state.json illisible pour ${paths.runId}.`, { cause: error });
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// Ecriture des documents natifs
// --------------------------------------------------------------------------
//
// Le Slice 1A avait deliberement omis ces ecrivains : aucun chemin de
// production n'ecrivait de format natif. Le Slice 1C en a besoin, et rien de
// plus — ils valident avant d'ecrire, exactement comme leurs equivalents
// historiques.

export async function writeNativeManifest(paths: RunPaths, manifest: NativeRunManifest): Promise<void> {
  await writeJsonAtomic(paths.manifest, validateNativeManifest(manifest));
}

export async function writeNativeState(paths: RunPaths, document: NativeRunStateDocument): Promise<void> {
  await writeJsonAtomic(paths.state, validateNativeStateDocument(document));
}

export function buildInitialNativeState(
  runId: string,
  state: RunState,
  now: Date = new Date(),
): NativeRunStateDocument {
  return {
    schema_version: NATIVE_STATE_SCHEMA_VERSION,
    run_id: runId,
    state,
    control: 'AUTOMATION',
    round: 0,
    active_expert_slot: null,
    // Le curseur n'existe pas tant que les deux experts n'existent pas : il n'y
    // a personne entre qui alterner (V0.3, §16.2).
    next_step_source_slot: null,
    last_event_id: null,
    pending_operation: null,
    uncertainty: null,
    updated_at: now.toISOString(),
  };
}

export interface NativeStateUpdate {
  readonly state?: RunState;
  readonly control?: ControlOwner;
  readonly round?: number;
  readonly activeExpertSlot?: ExpertSlotId | null;
  readonly nextStepSourceSlot?: ExpertSlotId | null;
  readonly lastEventId?: string | null;
  readonly pendingOperation?: NativePendingOperation | null;
  readonly uncertainty?: NativeRunUncertainty | null;
}

/** Applique une mise a jour d'etat natif. Pure : valide la transition, n'ecrit rien. */
export function applyNativeStateUpdate(
  current: NativeRunStateDocument,
  update: NativeStateUpdate,
  now: Date = new Date(),
): NativeRunStateDocument {
  const nextState = update.state ?? current.state;
  assertTransition(current.state, nextState);

  return {
    ...current,
    state: nextState,
    control: update.control ?? current.control,
    round: update.round ?? current.round,
    active_expert_slot:
      update.activeExpertSlot === undefined ? current.active_expert_slot : update.activeExpertSlot,
    next_step_source_slot:
      update.nextStepSourceSlot === undefined ? current.next_step_source_slot : update.nextStepSourceSlot,
    last_event_id: update.lastEventId === undefined ? current.last_event_id : update.lastEventId,
    pending_operation:
      update.pendingOperation === undefined ? current.pending_operation : update.pendingOperation,
    uncertainty: update.uncertainty === undefined ? current.uncertainty : update.uncertainty,
    updated_at: now.toISOString(),
  };
}

export async function persistNativeStateUpdate(
  paths: RunPaths,
  current: NativeRunStateDocument,
  update: NativeStateUpdate,
  now: Date = new Date(),
): Promise<NativeRunStateDocument> {
  const next = applyNativeStateUpdate(current, update, now);
  await writeNativeState(paths, next);
  return next;
}

/**
 * Lie une session native a un slot, sans toucher au reste du manifest.
 *
 * La copie par diffusion preserve `runtime_config` ; la validation le reconduit.
 * Meme discipline que `setAgentSessionId` cote historique.
 */
export async function bindNativeSession(
  paths: RunPaths,
  manifest: NativeRunManifest,
  slot: ExpertSlotId,
  sessionId: string,
): Promise<NativeRunManifest> {
  const updated: NativeRunManifest = {
    ...manifest,
    experts: { ...manifest.experts, [slot]: { ...manifest.experts[slot], session_id: sessionId } },
  };
  await writeNativeManifest(paths, updated);
  return updated;
}
