/**
 * Matérialisation d'un run sur disque, pour les tests qui ont besoin d'un data
 * root réaliste sans passer par un vrai tour d'agent.
 *
 * Écrit par les stores canoniques — pas à la main — sauf lorsqu'une fixture
 * pathologique est explicitement demandée.
 */

import { mkdir, writeFile } from 'node:fs/promises';

import { openDecisionStore } from '../../src/store/decision-store.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import { writeJsonAtomic } from '../../src/store/atomic-file.ts';
import { buildInitialState, writeManifest, writeState } from '../../src/store/state-store.ts';
import { MANIFEST_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { AgentRole, NewCcrEvent, RunManifest, RunStateDocument } from '../../src/core/run.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../../src/core/run-native.ts';
import type {
  NativeRunManifest,
  NativeRunRuntimeConfig,
  NativeRunStateDocument,
} from '../../src/core/run-native.ts';
import { TEST_RUNTIME_CONFIG } from './runtime-config.ts';

export const FIXTURE_TIME = '2026-08-08T00:00:00.000Z';

export function fixtureManifest(runId: string): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    title: `Titre ${runId}`,
    created_at: FIXTURE_TIME,
    workspace: { cwd: 'E:/prog/exemple' },
    agents: {
      claude: { session_id: 'claude-1', role: 'challenger' },
      codex: { session_id: 'codex-1', role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
  };
}

/**
 * Manifest historique **non bijectif** : les deux agents déclarent le même rôle.
 *
 * Constructible par les surfaces V2 gelées — aucune couche n'y impose deux
 * rôles distincts. La fixture matérialise ce qu'un poste peut réellement
 * contenir, pour que la classification soit éprouvée sur un cas vrai plutôt que
 * sur une hypothèse.
 */
export function conflictingLegacyManifest(runId: string, role: AgentRole = 'author'): RunManifest {
  const base = fixtureManifest(runId);
  return {
    ...base,
    agents: {
      claude: { ...base.agents.claude, role },
      codex: { ...base.agents.codex, role },
    },
  };
}

// --------------------------------------------------------------------------
// Runs natifs V2.1
// --------------------------------------------------------------------------

/** Affectation explicite des deux slots. Jamais déduite d'un fournisseur. */
export interface NativeBindings {
  readonly author: ProviderKind;
  readonly challenger: ProviderKind;
}

/**
 * Les quatre permutations, y compris les deux configurations same-provider que
 * le modèle V2 ne savait pas exprimer.
 */
export const NATIVE_BINDING_PERMUTATIONS: readonly NativeBindings[] = [
  { author: 'codex', challenger: 'claude' },
  { author: 'claude', challenger: 'codex' },
  { author: 'claude', challenger: 'claude' },
  { author: 'codex', challenger: 'codex' },
];

export function permutationLabel(bindings: NativeBindings): string {
  return `author=${bindings.author} challenger=${bindings.challenger}`;
}

/**
 * Identifiant de session d'un slot.
 *
 * Dérivé du **slot**, jamais du fournisseur : c'est ce qui garantit deux
 * identités distinctes lorsque les deux experts partagent le même moteur.
 */
export function nativeSessionId(slot: ExpertSlotId): string {
  return `native-${slot}-1`;
}

/**
 * Snapshot runtime natif cohérent avec des bindings donnés.
 *
 * `required` se déduit des bindings — c'est le sens même de l'admission bornée.
 * Un fournisseur qu'aucun slot n'emploie ne reçoit aucune observation : les
 * champs n'existent pas, ils ne valent pas `null`.
 */
export function nativeRuntimeConfig(bindings: NativeBindings): NativeRunRuntimeConfig {
  const used = new Set<ProviderKind>([bindings.author, bindings.challenger]);
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: FIXTURE_TIME,
    claude: used.has('claude')
      ? { required: true, probe_status: 'OBSERVED', cli_version: '2.1.224', auth_preflight: 'AUTHENTICATED' }
      : { required: false, probe_status: 'NOT_REQUIRED' },
    codex: used.has('codex')
      ? {
          required: true,
          probe_status: 'OBSERVED',
          cli_version: '0.146.0',
          auth_preflight: 'AUTHENTICATED',
          skip_git_repo_check: false,
          source_at_capture: 'default',
        }
      : { required: false, probe_status: 'NOT_REQUIRED' },
  };
}

export interface NativeManifestOverrides {
  /** `null` des deux côtés : run natif dont aucune session n'existe encore. */
  readonly sessions?: 'both' | 'none';
  readonly runtimeConfig?: NativeRunRuntimeConfig | null;
}

export function nativeFixtureManifest(
  runId: string,
  bindings: NativeBindings,
  over: NativeManifestOverrides = {},
): NativeRunManifest {
  const withSessions = (over.sessions ?? 'both') === 'both';
  const runtimeConfig = over.runtimeConfig === undefined ? nativeRuntimeConfig(bindings) : over.runtimeConfig;
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    title: `Titre ${runId}`,
    created_at: FIXTURE_TIME,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: bindings.author, session_id: withSessions ? nativeSessionId('author') : null },
      challenger: {
        provider: bindings.challenger,
        session_id: withSessions ? nativeSessionId('challenger') : null,
      },
    },
    ...(runtimeConfig === null ? {} : { runtime_config: runtimeConfig }),
  };
}

export function nativeFixtureState(
  runId: string,
  over: Partial<NativeRunStateDocument> = {},
): NativeRunStateDocument {
  return {
    schema_version: NATIVE_STATE_SCHEMA_VERSION,
    run_id: runId,
    state: 'READY',
    control: 'AUTOMATION',
    round: 0,
    active_expert_slot: null,
    next_step_source_slot: null,
    last_event_id: null,
    pending_operation: null,
    uncertainty: null,
    updated_at: FIXTURE_TIME,
    ...over,
  };
}

export interface NativeRunFixture {
  readonly runId: string;
  readonly bindings: NativeBindings;
  readonly manifest?: NativeManifestOverrides;
  readonly state?: Partial<NativeRunStateDocument>;
}

/**
 * Matérialise un run natif sur disque.
 *
 * Écrit par la primitive atomique du dépôt, faute d'écrivain natif en
 * production : le Slice 1A introduit le contrat lu et validé, pas les chemins
 * de mutation.
 */
export async function materializeNativeRun(runsDir: string, spec: NativeRunFixture): Promise<void> {
  const paths = runPaths(runsDir, spec.runId);
  await mkdir(paths.root, { recursive: true });
  await writeJsonAtomic(paths.manifest, nativeFixtureManifest(spec.runId, spec.bindings, spec.manifest));
  await writeJsonAtomic(paths.state, nativeFixtureState(spec.runId, spec.state));
}

export interface RunFixture {
  readonly runId: string;
  readonly state?: Partial<RunStateDocument>;
  readonly events?: readonly NewCcrEvent[];
  readonly decisions?: readonly { content: string; timestamp: string }[];
  /** Contenu brut, pour éprouver une corruption stable. */
  readonly rawEvents?: string;
  readonly rawManifest?: string;
}

export async function materializeRun(runsDir: string, spec: RunFixture): Promise<void> {
  const paths = runPaths(runsDir, spec.runId);
  await mkdir(paths.root, { recursive: true });
  await writeManifest(paths, fixtureManifest(spec.runId));
  await writeState(paths, {
    ...buildInitialState(spec.runId, 'READY', new Date(FIXTURE_TIME)),
    ...spec.state,
  });

  if (spec.events !== undefined) {
    const store = await openEventStore(paths, spec.runId);
    for (const event of spec.events) await store.append(event);
  }
  if (spec.decisions !== undefined) {
    const store = await openDecisionStore(paths, spec.runId);
    for (const decision of spec.decisions) {
      await store.append({ round: 0, author: 'human', status: 'ACTIVE', ...decision });
    }
  }
  if (spec.rawEvents !== undefined) await writeFile(paths.events, spec.rawEvents, 'utf8');
  if (spec.rawManifest !== undefined) await writeFile(paths.manifest, spec.rawManifest, 'utf8');
}
