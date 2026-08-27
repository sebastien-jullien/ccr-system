/**
 * Snapshot runtime représentatif pour les tests de service.
 *
 * Depuis V2-IMP-28, créer un nouveau run **exige** un snapshot : c'est ce qui
 * empêche structurellement la création silencieuse d'un run non pinné. Les
 * tests qui fabriquent un nouveau run utilisent donc le contrat moderne.
 *
 * Cela ne concerne que la **création**. Un manifest V1 historique dépourvu de
 * `runtime_config` reste valide, lisible et exécutable : les fixtures legacy
 * s'écrivent directement sur disque, sans passer par ce helper.
 */

import { RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { RunRuntimeConfig } from '../../src/core/run.ts';

export interface TestRuntimeConfigOverrides {
  readonly skipGitRepoCheck?: boolean;
  readonly sourceAtCapture?: RunRuntimeConfig['codex']['source_at_capture'];
  readonly capturedAt?: string;
  readonly claudeVersion?: string | null;
  readonly codexVersion?: string | null;
}

export function testRuntimeConfig(over: TestRuntimeConfigOverrides = {}): RunRuntimeConfig {
  return {
    schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: over.capturedAt ?? '2026-08-08T00:00:00.000Z',
    claude: {
      cli_version: over.claudeVersion === undefined ? '2.1.224' : over.claudeVersion,
      auth_preflight: 'AUTHENTICATED',
    },
    codex: {
      cli_version: over.codexVersion === undefined ? '0.146.0' : over.codexVersion,
      auth_preflight: 'AUTHENTICATED',
      skip_git_repo_check: over.skipGitRepoCheck ?? false,
      source_at_capture: over.sourceAtCapture ?? 'default',
    },
  };
}

/** Valeur par défaut, suffisante partout où le snapshot n'est pas le sujet. */
export const TEST_RUNTIME_CONFIG: RunRuntimeConfig = testRuntimeConfig();
