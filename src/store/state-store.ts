/**
 * State store — manifest et état courant d'un run (spécification V0.2, §9, §11).
 *
 * Deux documents, deux rôles (amendement A-4) :
 *
 *   manifest.json  identité stable + identifiants de session natifs
 *   state.json     état mutable courant, écrit atomiquement
 *
 * Invariant de reprise (§32) : un `WAITING_AGENT` retrouvé sur disque signifie
 * qu'un tour a peut-être eu lieu. `loadRun` ne le requalifie jamais en
 * `RUNNING` et ne modifie aucun fichier ; il signale l'ambiguïté et impose le
 * passage explicite par `RECOVERY_REQUIRED`.
 *
 * Ce module ne connaît ni Claude ni Codex, ni aucun format de CLI.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { CcrError } from '../core/errors.ts';
import { formatDatePart, formatRunId, parseRunId } from '../core/ids.ts';
import type {
  AgentKind,
  PendingOperation,
  RunManifest,
  RunRuntimeConfig,
  RuntimeAuthPreflight,
  RuntimeConfigSource,
  RunStateDocument,
  RunUncertainty,
} from '../core/run.ts';
import {
  MANIFEST_SCHEMA_VERSION,
  RUNTIME_CONFIG_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  SUPPORTED_STATE_SCHEMA_VERSIONS,
} from '../core/run.ts';
import type { ControlOwner, RunState } from '../core/state.ts';
import { assertTransition, isControlOwner, isRunState } from '../core/state.ts';
import { readJsonFile, writeJsonAtomic } from './atomic-file.ts';
import { listRunIds, runPaths } from './layout.ts';
import type { RunPaths } from './layout.ts';

const MAX_RUNS_PER_DAY = 999;

// --------------------------------------------------------------------------
// Création du répertoire de run
// --------------------------------------------------------------------------

/**
 * Crée le répertoire d'un nouveau run et renvoie ses chemins.
 *
 * L'ordinal n'est pas déduit d'un simple comptage (§42) : la réservation
 * repose sur `mkdir` sans `recursive`, qui échoue en `EEXIST` si le nom est
 * déjà pris. La collision est donc arbitrée par le système de fichiers.
 */
export async function createRunDirectory(runsDir: string, now: Date = new Date()): Promise<RunPaths> {
  await mkdir(runsDir, { recursive: true });

  const datePart = formatDatePart(now);
  const sameDay = (await listRunIds(runsDir))
    .map((runId) => parseRunId(runId))
    .filter((parsed) => parsed !== undefined && parsed.datePart === datePart)
    .map((parsed) => (parsed as { ordinal: number }).ordinal);

  const firstCandidate = sameDay.length === 0 ? 1 : Math.max(...sameDay) + 1;

  for (let ordinal = firstCandidate; ordinal <= MAX_RUNS_PER_DAY; ordinal += 1) {
    const runId = formatRunId(datePart, ordinal);
    const paths = runPaths(runsDir, runId);
    try {
      await mkdir(paths.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    await mkdir(paths.roundsDir, { recursive: true });
    await mkdir(paths.artifactsDir, { recursive: true });
    return paths;
  }

  throw new CcrError('RUN_ALREADY_EXISTS', `Aucun identifiant de run disponible pour ${datePart}.`, {
    details: { runsDir, datePart, limit: MAX_RUNS_PER_DAY },
  });
}

// --------------------------------------------------------------------------
// Manifest
// --------------------------------------------------------------------------

/** Primitives de forme, partagées avec le lecteur de génération V2.1. */
export function asRecord(
  value: unknown,
  code: 'MANIFEST_INVALID' | 'STATE_INVALID',
  what: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CcrError(code, `${what} : objet JSON attendu.`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  record: Record<string, unknown>,
  key: string,
  code: 'MANIFEST_INVALID' | 'STATE_INVALID',
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CcrError(code, `Champ "${key}" absent ou invalide.`, { details: { key } });
  }
  return value;
}

/**
 * Vérifie la version et **renvoie celle qui a été lue**.
 *
 * Le retour n'est pas cosmétique : c'est lui qui permet aux parseurs de
 * reconduire la version observée au lieu de la remplacer par la version
 * courante. Un document relu conserve ainsi sa génération, et une simple
 * lecture ne peut plus l'élever (V2.1 V0.3, §13.5, §13.6).
 */
function checkSchemaVersion(record: Record<string, unknown>, supported: readonly number[], what: string): number {
  const version = record['schema_version'];
  if (typeof version !== 'number' || !supported.includes(version)) {
    throw new CcrError('SCHEMA_VERSION_UNSUPPORTED', `${what} : schema_version ${String(version)} non supportée.`, {
      details: { supported: [...supported], found: version ?? null },
    });
  }
  return version;
}

function parseAgentEntry(value: unknown, agent: string): { session_id: string | null; role: 'author' | 'challenger' } {
  const record = asRecord(value, 'MANIFEST_INVALID', `agents.${agent}`);
  const sessionId = record['session_id'];
  const role = record['role'];
  if (sessionId !== null && typeof sessionId !== 'string') {
    throw new CcrError('MANIFEST_INVALID', `agents.${agent}.session_id invalide.`);
  }
  if (role !== 'author' && role !== 'challenger') {
    throw new CcrError('MANIFEST_INVALID', `agents.${agent}.role invalide : ${String(role)}.`);
  }
  return { session_id: sessionId, role };
}

function manifestInvalid(message: string, field: string): CcrError {
  return new CcrError('MANIFEST_INVALID', message, { details: { field } });
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
 * Analyse le snapshot runtime (§14.0).
 *
 * Trois issues strictement distinctes :
 *
 *   absent          → run V1 historique, accepté tel quel
 *   présent, valide → run V1.1 pinné
 *   présent, invalide → `MANIFEST_INVALID`
 *
 * La présence d'un snapshot illisible n'est **jamais** assimilée à son absence :
 * ce serait requalifier un run pinné corrompu en run legacy, et lui appliquer
 * silencieusement une résolution d'environnement qu'il avait précisément
 * vocation à figer.
 */
function parseRuntimeConfig(value: unknown): RunRuntimeConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw manifestInvalid('runtime_config : objet JSON attendu.', 'runtime_config');
  }
  const record = value as Record<string, unknown>;

  const version = record['schema_version'];
  if (typeof version !== 'number') {
    throw manifestInvalid('runtime_config.schema_version doit être un nombre.', 'runtime_config');
  }
  if (version !== RUNTIME_CONFIG_SCHEMA_VERSION) {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `runtime_config.schema_version ${String(version)} non supportée.`,
      { details: { field: 'runtime_config', supported: [RUNTIME_CONFIG_SCHEMA_VERSION], found: version } },
    );
  }

  const capturedAt = record['captured_at'];
  if (typeof capturedAt !== 'string' || capturedAt.length === 0) {
    throw manifestInvalid('runtime_config.captured_at invalide.', 'runtime_config');
  }

  const claude = asRecord(record['claude'], 'MANIFEST_INVALID', 'runtime_config.claude');
  const codex = asRecord(record['codex'], 'MANIFEST_INVALID', 'runtime_config.codex');

  const skip = codex['skip_git_repo_check'];
  if (typeof skip !== 'boolean') {
    // Aucune coercition : c'est la valeur exécutable du run.
    throw manifestInvalid('runtime_config.codex.skip_git_repo_check doit être un booléen.', 'runtime_config');
  }

  // Champ requis du schéma 1 : un snapshot sans provenance serait ambigu, et
  // aucun artefact de ce type n'existe (vérifié sur disque avant la décision).
  const source = codex['source_at_capture'];
  if (source !== 'default' && source !== 'config' && source !== 'legacy-env') {
    throw manifestInvalid(
      `runtime_config.codex.source_at_capture invalide : ${String(source)}.`,
      'runtime_config',
    );
  }

  return {
    schema_version: version,
    captured_at: capturedAt,
    claude: {
      cli_version: requireCliVersion(claude, 'runtime_config.claude'),
      auth_preflight: requireAuthPreflight(claude, 'runtime_config.claude'),
    },
    codex: {
      cli_version: requireCliVersion(codex, 'runtime_config.codex'),
      auth_preflight: requireAuthPreflight(codex, 'runtime_config.codex'),
      skip_git_repo_check: skip,
      source_at_capture: source as RuntimeConfigSource,
    },
  };
}

export function validateManifest(value: unknown): RunManifest {
  const record = asRecord(value, 'MANIFEST_INVALID', 'manifest.json');
  const version = checkSchemaVersion(record, [MANIFEST_SCHEMA_VERSION], 'manifest.json');

  const workspace = asRecord(record['workspace'], 'MANIFEST_INVALID', 'workspace');
  const agents = asRecord(record['agents'], 'MANIFEST_INVALID', 'agents');

  // Le snapshot est reconduit explicitement : une reconstruction champ par
  // champ qui l'omettrait le supprimerait au premier enregistrement de session
  // (§14.0, INV-11-18).
  const runtimeConfig = parseRuntimeConfig(record['runtime_config']);

  return {
    schema_version: version,
    run_id: requireString(record, 'run_id', 'MANIFEST_INVALID'),
    title: requireString(record, 'title', 'MANIFEST_INVALID'),
    created_at: requireString(record, 'created_at', 'MANIFEST_INVALID'),
    workspace: { cwd: requireString(workspace, 'cwd', 'MANIFEST_INVALID') },
    agents: {
      claude: parseAgentEntry(agents['claude'], 'claude'),
      codex: parseAgentEntry(agents['codex'], 'codex'),
    },
    ...(runtimeConfig === undefined ? {} : { runtime_config: runtimeConfig }),
  };
}

export function writeManifest(paths: RunPaths, manifest: RunManifest): Promise<void> {
  return writeJsonAtomic(paths.manifest, manifest);
}

export async function readManifest(paths: RunPaths): Promise<RunManifest> {
  try {
    return validateManifest(await readJsonFile(paths.manifest));
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

/**
 * Enregistre l'identifiant natif d'un agent sans toucher au reste du manifest.
 *
 * La copie par diffusion préserve `runtime_config` ; la validation le reconduit
 * explicitement. Les deux mécanismes sont éprouvés séparément : la suppression
 * accidentelle du snapshot au premier enregistrement de session était le défaut
 * exact anticipé par la contre-expertise.
 */
export async function setAgentSessionId(
  paths: RunPaths,
  manifest: RunManifest,
  agent: AgentKind,
  sessionId: string,
): Promise<RunManifest> {
  const updated: RunManifest = {
    ...manifest,
    agents: { ...manifest.agents, [agent]: { ...manifest.agents[agent], session_id: sessionId } },
  };
  await writeManifest(paths, updated);
  return updated;
}

// --------------------------------------------------------------------------
// État courant
// --------------------------------------------------------------------------

export function buildInitialState(
  runId: string,
  state: RunState,
  now: Date = new Date(),
): RunStateDocument {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: runId,
    state,
    control: 'AUTOMATION',
    round: 0,
    active_agent: null,
    last_event_id: null,
    pending_operation: null,
    uncertainty: null,
    updated_at: now.toISOString(),
  };
}

function parseUncertainty(value: unknown): RunUncertainty | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value, 'STATE_INVALID', 'uncertainty');
  const agent = record['agent'];
  if (agent !== null && agent !== 'claude' && agent !== 'codex') {
    throw new CcrError('STATE_INVALID', `uncertainty.agent invalide : ${String(agent)}.`);
  }
  const lastEventId = record['last_event_id'];
  return {
    reason: requireString(record, 'reason', 'STATE_INVALID'),
    since: requireString(record, 'since', 'STATE_INVALID'),
    agent,
    last_event_id: typeof lastEventId === 'string' ? lastEventId : null,
  };
}

function parseAgentKind(value: unknown, field: string): AgentKind | null {
  if (value === null || value === undefined) return null;
  if (value !== 'claude' && value !== 'codex') {
    throw new CcrError('STATE_INVALID', `${field} invalide : ${String(value)}.`);
  }
  return value;
}

/**
 * Analyse le contexte d'opération (amendement A-9).
 *
 * Son absence — notamment dans un `state.json` en version 1 — signifie
 * « aucune opération en vol ».
 */
function parsePendingOperation(value: unknown): PendingOperation | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value, 'STATE_INVALID', 'pending_operation');

  const kind = record['kind'];
  if (kind !== 'initialization' && kind !== 'send' && kind !== 'step' && kind !== 'handoff') {
    throw new CcrError('STATE_INVALID', `pending_operation.kind invalide : ${String(kind)}.`);
  }

  const agent = parseAgentKind(record['agent'], 'pending_operation.agent');
  if (agent === null) {
    throw new CcrError('STATE_INVALID', 'pending_operation.agent est obligatoire.');
  }

  const round = record['round'];
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 0) {
    throw new CcrError('STATE_INVALID', `pending_operation.round invalide : ${String(round)}.`);
  }

  const returnState = record['return_state'];
  if (!isRunState(returnState)) {
    throw new CcrError('STATE_INVALID', `pending_operation.return_state invalide : ${String(returnState)}.`);
  }

  const returnControl = record['return_control'];
  if (!isControlOwner(returnControl)) {
    throw new CcrError('STATE_INVALID', `pending_operation.return_control invalide : ${String(returnControl)}.`);
  }

  const optionalString = (field: string): string | null => {
    const raw = record[field];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') {
      throw new CcrError('STATE_INVALID', `pending_operation.${field} invalide.`);
    }
    return raw;
  };

  return {
    kind,
    agent,
    round,
    prompt_event_id: optionalString('prompt_event_id'),
    source_event_id: optionalString('source_event_id'),
    session_id: optionalString('session_id'),
    return_state: returnState,
    return_control: returnControl,
    started_at: requireString(record, 'started_at', 'STATE_INVALID'),
  };
}

export function validateStateDocument(value: unknown): RunStateDocument {
  const record = asRecord(value, 'STATE_INVALID', 'state.json');
  const version = checkSchemaVersion(record, SUPPORTED_STATE_SCHEMA_VERSIONS, 'state.json');

  const state = record['state'];
  if (!isRunState(state)) {
    throw new CcrError('STATE_INVALID', `État inconnu de la machine V1 : ${String(state)}.`, {
      details: { state: state ?? null },
    });
  }

  const control = record['control'];
  if (!isControlOwner(control)) {
    throw new CcrError('STATE_INVALID', `Propriétaire du contrôle invalide : ${String(control)}.`);
  }

  const round = record['round'];
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 0) {
    throw new CcrError('STATE_INVALID', `round invalide : ${String(round)}.`);
  }

  const activeAgent = record['active_agent'];
  if (activeAgent !== null && activeAgent !== 'claude' && activeAgent !== 'codex') {
    throw new CcrError('STATE_INVALID', `active_agent invalide : ${String(activeAgent)}.`);
  }

  const lastEventId = record['last_event_id'];
  if (lastEventId !== null && typeof lastEventId !== 'string') {
    throw new CcrError('STATE_INVALID', 'last_event_id invalide.');
  }

  return {
    // Version reconduite, jamais relevée : un état legacy relu reste legacy.
    // Version reconduite, jamais relevée : un état legacy relu reste legacy.
    schema_version: version,
    run_id: requireString(record, 'run_id', 'STATE_INVALID'),
    state,
    control,
    round,
    active_agent: activeAgent,
    last_event_id: lastEventId,
    pending_operation: parsePendingOperation(record['pending_operation']),
    uncertainty: parseUncertainty(record['uncertainty']),
    updated_at: requireString(record, 'updated_at', 'STATE_INVALID'),
  };
}

export function writeState(paths: RunPaths, document: RunStateDocument): Promise<void> {
  return writeJsonAtomic(paths.state, document);
}

export async function readState(paths: RunPaths): Promise<RunStateDocument> {
  try {
    return validateStateDocument(await readJsonFile(paths.state));
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

export interface StateUpdate {
  readonly state?: RunState;
  readonly control?: ControlOwner;
  readonly round?: number;
  readonly activeAgent?: AgentKind | null;
  readonly lastEventId?: string | null;
  readonly pendingOperation?: PendingOperation | null;
  readonly uncertainty?: RunUncertainty | null;
}

/**
 * Applique une mise à jour d'état. Fonction pure : elle valide la transition
 * mais n'écrit rien.
 */
export function applyStateUpdate(
  current: RunStateDocument,
  update: StateUpdate,
  now: Date = new Date(),
): RunStateDocument {
  const nextState = update.state ?? current.state;
  assertTransition(current.state, nextState);

  return {
    ...current,
    state: nextState,
    control: update.control ?? current.control,
    round: update.round ?? current.round,
    active_agent: update.activeAgent === undefined ? current.active_agent : update.activeAgent,
    last_event_id: update.lastEventId === undefined ? current.last_event_id : update.lastEventId,
    pending_operation:
      update.pendingOperation === undefined ? current.pending_operation : update.pendingOperation,
    uncertainty: update.uncertainty === undefined ? current.uncertainty : update.uncertainty,
    updated_at: now.toISOString(),
  };
}

export async function persistStateUpdate(
  paths: RunPaths,
  current: RunStateDocument,
  update: StateUpdate,
  now: Date = new Date(),
): Promise<RunStateDocument> {
  const next = applyStateUpdate(current, update, now);
  await writeState(paths, next);
  return next;
}

// --------------------------------------------------------------------------
// Chargement et ambiguïté de reprise
// --------------------------------------------------------------------------

export interface LoadedRun {
  readonly paths: RunPaths;
  readonly manifest: RunManifest;
  readonly state: RunStateDocument;
  /**
   * Vrai lorsque l'état persisté est ambigu : une opération était engagée au
   * moment où le processus précédent a disparu. Le run doit alors passer
   * explicitement par `ccr recover` (§32), jamais repartir silencieusement.
   *
   * Deux signaux, volontairement redondants : l'état `WAITING_AGENT` et la
   * présence d'un contexte d'opération. Le second couvre aussi le handoff, qui
   * reste en `PAUSED` ou `WAITING_HUMAN` pendant l'intervention.
   */
  readonly requiresRecovery: boolean;
}

/**
 * Recharge un run depuis ses seuls fichiers persistés.
 *
 * Ne modifie aucun fichier : la décision de reprise appartient à l'appelant.
 */
export async function loadRun(runsDir: string, runId: string): Promise<LoadedRun> {
  const paths = runPaths(runsDir, runId);
  const manifest = await readManifest(paths);
  const state = await readState(paths);

  if (manifest.run_id !== runId || state.run_id !== runId) {
    throw new CcrError('MANIFEST_INVALID', `Identité incohérente pour le run ${runId}.`, {
      details: { runId, manifestRunId: manifest.run_id, stateRunId: state.run_id },
    });
  }

  return {
    paths,
    manifest,
    state,
    requiresRecovery: state.state === 'WAITING_AGENT' || state.pending_operation !== null,
  };
}

/**
 * Matérialise l'ambiguïté détectée au rechargement.
 *
 * L'appelant reste responsable de journaliser l'événement correspondant.
 */
export function buildRecoveryUpdate(
  state: RunStateDocument,
  reason?: string,
  now: Date = new Date(),
): StateUpdate {
  void now;
  const pending = state.pending_operation;
  return {
    state: 'RECOVERY_REQUIRED',
    control: 'HUMAN',
    uncertainty: {
      reason:
        reason ??
        "Une opération était engagée lors de l'arrêt du processus CCR précédent. " +
          "Il est impossible d'affirmer qu'elle n'a pas eu lieu.",
      since: pending?.started_at ?? state.updated_at,
      agent: pending?.agent ?? state.active_agent,
      last_event_id: state.last_event_id,
    },
    activeAgent: null,
    // Le contexte est conservé : il documente l'ambiguïté pour l'humain.
  };
}

/**
 * Point d'application de l'invariant de reprise.
 *
 * Toute commande susceptible de relancer l'automatisation sur un run rechargé
 * doit appeler cette garde. Elle rend l'ambiguïté impossible à ignorer par
 * inadvertance.
 */
export function assertRecoveryResolved(loaded: LoadedRun): void {
  if (!loaded.requiresRecovery) return;
  const pending = loaded.state.pending_operation;
  throw new CcrError(
    'RECOVERY_REQUIRED',
    `Le run ${loaded.state.run_id} a été rechargé alors qu'une opération` +
      (pending === null ? ' agent' : ` « ${pending.kind} » (${pending.agent})`) +
      ' était engagée. Utilisez `ccr recover` avant toute reprise.',
    {
      details: {
        runId: loaded.state.run_id,
        persistedState: loaded.state.state,
        activeAgent: loaded.state.active_agent ?? pending?.agent ?? null,
        pendingOperation: pending?.kind ?? null,
        lastEventId: loaded.state.last_event_id,
      },
    },
  );
}

export function runDirectory(runsDir: string, runId: string): string {
  return path.join(runsDir, runId);
}
