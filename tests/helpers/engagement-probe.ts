/**
 * Sonde d'engagement durable d'invocation.
 *
 * ## Ce que ce module mesure, et pourquoi il existe
 *
 * Le contrat P exige que la cardinalité **publiée** et la cardinalité
 * **réellement engagée par l'exécution** ne puissent pas diverger (§ 9.1, § 9.2).
 * Une garde qui compterait les vérifications de quota ne le prouve pas :
 *
 * ```text
 * CONTRÔLE DE QUOTA   ≠   ENGAGEMENT DURABLE D'INVOCATION
 * ```
 *
 * Un quota est vérifié **avant** l'engagement ; il peut refuser sans que rien ne
 * soit engagé, et rien n'interdit à un chemin d'engager deux fois après un
 * unique contrôle. La frontière d'engagement, elle, est exactement une :
 *
 * ```text
 * InvocationLedgerStore.append()   →   une ligne DISPATCH_COMMITTED durable
 * ```
 *
 * Ce module exécute l'opération réelle, contre un fournisseur de test, et compte
 * ce qui a franchi cette frontière — deux fois, par deux voies indépendantes :
 *
 * ```text
 * appends            appels append() traversés, observés par la couture
 * ledgerEngagements  lignes relues du journal après coup, autorité du run
 * ```
 *
 * ## Sensibilité exigée
 *
 * `injectExtraEngagement` fait franchir la frontière une seconde fois sur le
 * même chemin, sans toucher au code de production. C'est la sonde de mutation :
 * elle rend l'invariant falsifiable dans la suite elle-même, plutôt que sur
 * parole.
 *
 * ```text
 * AUCUN FOURNISSEUR RÉEL   l'adaptateur est une couture de test
 * ```
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import type { InvocationLedgerStore } from '../../src/store/invocation-ledger.ts';
import { readControversyJournal } from '../../src/store/controversy-store.ts';
import {
  CONTROVERSY_DETECTOR_OUTPUT_VERSION,
  detectControversyRelations,
} from '../../src/services/controversy-detector.ts';
import type { DetectionDeps } from '../../src/services/controversy-detector.ts';
import {
  RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
  proposeReconciliationByModel,
} from '../../src/services/reconciliation-proposer.ts';
import type { ReconciliationProposerDeps } from '../../src/services/reconciliation-proposer.ts';
import { ADDUCTION_PROPOSAL_VERSION, adduceMaterialByModel } from '../../src/services/evidence-adducer.ts';
import type { ModelAdductionDeps } from '../../src/services/evidence-adducer.ts';
import { recordAssertion, recordControversy } from '../../src/services/controversy-service.ts';
import type { ControversyServiceDeps } from '../../src/services/controversy-service.ts';
import { registerMaterial } from '../../src/services/evidence-service.ts';
import type { EvidenceServiceDeps } from '../../src/services/evidence-service.ts';
import { readCurrentEvidenceRevision } from '../../src/services/evidence-freshness.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import { stepNativeRun } from '../../src/services/native-step-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import { expertSlotTarget } from '../../src/services/native-target-resolver.ts';
import { pauseNativeRun, resumeNativeRun } from '../../src/services/native-control-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { createFakeAdapter } from './fake-adapter.ts';
import { makeTempDir, removeTempDir } from './temp-dir.ts';

/** Opérations assistées par modèle que cette sonde sait exécuter. */
export type ProbedOperation = 'DETECT' | 'PROPOSE' | 'ADDUCE_MODEL';

export interface EngagementObservation {
  /** Franchissements de la frontière d'engagement, observés par la couture. */
  readonly appends: number;
  /** Engagements durables relus du journal du run, après exécution. */
  readonly ledgerEngagements: number;
  /** Appels réellement passés à l'adaptateur de test. */
  readonly providerCalls: number;
  /**
   * L'opération a-t-elle levé ?
   *
   * Rendu plutôt qu'avalé : la mesure porte sur les engagements, mais un chemin
   * nominal qui échouerait ne doit pas passer pour une preuve. Sous mutation, en
   * revanche, un échec en aval de l'engagement est attendu et sans portée.
   */
  readonly threw: boolean;
}

export interface ProbeOptions {
  /**
   * Engagements durables supplémentaires, injectés sur le MÊME chemin, juste
   * après celui du produit. Sonde de mutation : le contrôle de quota reste
   * unique, et la cardinalité réelle change.
   */
  readonly injectExtraEngagement?: number;
}

const RUN_ID = 'CCR-20260909-500';

const EVENTS: readonly Record<string, unknown>[] = [
  {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-09-09T09:10:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'S1',
    content: 'Le cache doit expirer rapidement.',
  },
  {
    event_id: 'evt_000002',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-09-09T09:20:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'challenger',
    session_id: 'S2',
    content: 'Non : le cache reste valide.',
  },
];

/**
 * Couture qui compte les franchissements de la frontière d'engagement.
 *
 * Elle enveloppe le vrai journal : rien n'est simulé, et chaque `append`
 * compté est une ligne réellement écrite.
 */
function countingLedger(extra: number): {
  readonly seam: typeof openInvocationLedger;
  appends(): number;
} {
  let appends = 0;
  const seam: typeof openInvocationLedger = async (paths, runId, options) => {
    const store = await openInvocationLedger(paths, runId, options);
    const wrapped: InvocationLedgerStore = {
      readAll: () => store.readAll(),
      async append(draft, now) {
        appends += 1;
        const record = await store.append(draft, now);
        for (let i = 0; i < extra; i += 1) {
          appends += 1;
          await store.append(draft, now);
        }
        return record;
      },
      lastInvocationId: () => store.lastInvocationId(),
      count: () => store.count(),
      nextSequence: () => store.nextSequence(),
    };
    return wrapped;
  };
  return { seam, appends: () => appends };
}

interface FakeAdapter extends AgentAdapter {
  readonly calls: string[];
}

function fakeAdapter(kind: 'claude' | 'codex', content: string): FakeAdapter {
  const calls: string[] = [];
  return {
    kind,
    calls,
    async start(prompt: string): Promise<AgentTurnResult> {
      calls.push(prompt);
      return {
        agent: kind,
        sessionId: `probe-${kind}-1`,
        content,
        exitCode: 0,
        startedAt: '2026-09-09T10:00:00.000Z',
        completedAt: '2026-09-09T10:00:01.000Z',
        stdoutRaw: content,
        stderrRaw: '',
      };
    },
    resume(): Promise<AgentTurnResult> {
      throw new Error('une opération assistée ne reprend jamais la session d’un expert');
    },
    openInteractive(): never {
      throw new Error('une opération assistée n’ouvre aucun terminal');
    },
  };
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly controversy: ControversyServiceDeps;
  readonly evidence: EvidenceServiceDeps;
  readonly now: () => Date;
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  dispose(): Promise<void>;
}

async function fixture(content: string): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-engagement-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-09-09T09:00:00.000Z',
      title: 'sonde d’engagement',
      workspace: { cwd: runsDir },
      experts: {
        author: { provider: 'codex', session_id: 'S1' },
        challenger: { provider: 'claude', session_id: 'S2' },
      },
    }),
    'utf8',
  );
  await writeFile(
    paths.state,
    JSON.stringify({
      schema_version: 3,
      run_id: RUN_ID,
      state: 'READY',
      control: 'AUTOMATION',
      round: 1,
      active_expert_slot: null,
      next_step_source_slot: 'author',
      last_event_id: 'evt_000002',
      updated_at: '2026-09-09T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const adapters = { claude: fakeAdapter('claude', content), codex: fakeAdapter('codex', content) };
  let tick = 0;
  const now = (): Date => {
    tick += 1;
    return new Date(Date.UTC(2026, 8, 9, 12, 0, tick));
  };

  return {
    runsDir,
    paths,
    controversy: { runsDir, now },
    evidence: { runsDir, now },
    now,
    adapters,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

interface Seeded {
  readonly controversyId: string;
  readonly opening: string;
  readonly scope: readonly string[];
}

/** Une controverse humaine et deux positions — le plus petit périmètre utile. */
async function seedControversy(f: Fixture): Promise<Seeded> {
  const revision = async (): Promise<string> => (await readControversyJournal(f.paths)).revision;

  const opened = await recordControversy(f.controversy, {
    runId: RUN_ID,
    expected_controversy_revision: await revision(),
    provenance_event_ids: ['evt_000001'],
    statement: 'Durée de vie du cache',
  });
  const a = await recordAssertion(f.controversy, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: opened.controversy_revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Le TTL doit être court',
  });
  const b = await recordAssertion(f.controversy, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: a.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Le TTL doit être long',
  });

  return {
    controversyId: opened.controversy_id,
    opening: opened.entry.entry_id,
    scope: [a.entry.entry_id, b.entry.entry_id],
  };
}

async function observedEngagements(paths: RunPaths): Promise<number> {
  return (await openInvocationLedger(paths, RUN_ID)).count();
}

/**
 * Exécute réellement l'opération et rend ce qui a franchi la frontière
 * d'engagement durable.
 *
 * Le fournisseur rend une sortie valide et vide — un succès `VALID_ZERO`. Le
 * chemin nominal est donc parcouru de bout en bout : quota, engagement, appel,
 * revalidation, persistance.
 */
export async function observeModelAssistedEngagement(
  operation: ProbedOperation,
  options: ProbeOptions = {},
): Promise<EngagementObservation> {
  const extra = options.injectExtraEngagement ?? 0;
  const f = await fixture(outputFor(operation));
  try {
    const seeded = await seedControversy(f);
    const ledger = countingLedger(extra);
    const createAdapters = (): { claude: FakeAdapter; codex: FakeAdapter } => f.adapters;
    let threw = false;

    const execute = async (): Promise<void> => {
      if (operation === 'DETECT') {
        const deps: DetectionDeps = { runsDir: f.runsDir, now: f.now, createAdapters };
        await detectControversyRelations(
          deps,
          { runId: RUN_ID, controversy_id: seeded.controversyId, expert_slot: 'author' },
          { openInvocationLedger: ledger.seam },
        );
        return;
      }
      if (operation === 'PROPOSE') {
        const deps: ReconciliationProposerDeps = { runsDir: f.runsDir, now: f.now, createAdapters };
        await proposeReconciliationByModel(
          deps,
          {
            runId: RUN_ID,
            target_controversy_id: seeded.controversyId,
            scope_kind: 'SUBSET',
            scope: [...seeded.scope],
            expert_slot: 'challenger',
          },
          { openInvocationLedger: ledger.seam },
        );
        return;
      }
      const material = await registerMaterial(f.evidence, {
        runId: RUN_ID,
        expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir: f.runsDir }, RUN_ID),
        representation: { form: 'INLINE_TEXT', text: 'Une mesure tenue par CCR.' },
        label: 'mesure',
      });
      const deps: ModelAdductionDeps = { runsDir: f.runsDir, now: f.now, createAdapters };
      await adduceMaterialByModel(
        deps,
        {
          runId: RUN_ID,
          material_id: material.entry.entry_id,
          controversy_opening_entry_id: seeded.opening,
          expert_slot: 'author',
        },
        { openInvocationLedger: ledger.seam },
      );
    };

    try {
      await execute();
    } catch {
      threw = true;
    }

    return {
      appends: ledger.appends(),
      ledgerEngagements: await observedEngagements(f.paths),
      providerCalls: f.adapters.claude.calls.length + f.adapters.codex.calls.length,
      threw,
    };
  } finally {
    await f.dispose();
  }
}

// ==========================================================================
// Opérations natives — même frontière, même mesure
// ==========================================================================

/** Opérations natives numériques que cette sonde sait exécuter. */
export type ProbedNativeOperation = 'START' | 'STEP' | 'SEND' | 'PAUSE' | 'RESUME';

const NATIVE_AT = '2026-09-09T00:00:00.000Z';
const NATIVE_MISSION = 'Mission initiale : évaluer la refonte.';
const NATIVE_MESSAGE = 'Message humain, adressé à un expert.';

function nativeRuntimeConfig(): NativeRunRuntimeConfig {
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: NATIVE_AT,
    claude: {
      required: true,
      probe_status: 'OBSERVED',
      cli_version: '2.1.224',
      auth_preflight: 'AUTHENTICATED',
    },
    codex: {
      required: true,
      probe_status: 'OBSERVED',
      cli_version: '0.146.0',
      auth_preflight: 'AUTHENTICATED',
      skip_git_repo_check: false,
      source_at_capture: 'default',
    },
  };
}

/**
 * Exécute réellement l'opération native et rend ce qui a franchi la frontière
 * d'engagement durable pendant CETTE opération.
 *
 * Pour les opérations qui suivent une naissance, `START` est exécuté d'abord,
 * **hors couture**, et la mesure porte sur le delta du journal : ce qui est
 * compté appartient à l'opération sondée, jamais à ce qui l'a précédée.
 *
 * `PAUSE` et `RESUME` n'exposent aucune couture de journal — et n'en ont pas
 * besoin : leur cardinalité publiée est `EXACT(0)`, et le delta du journal en
 * fait foi. Un engagement quelconque suffirait à la falsifier.
 */
export async function observeNativeEngagement(
  operation: ProbedNativeOperation,
  options: ProbeOptions = {},
): Promise<EngagementObservation> {
  const extra = options.injectExtraEngagement ?? 0;
  const dir = await makeTempDir('ccr-engagement-native-');
  try {
    const runsDir = `${dir}/runs`;
    const build = (kind: 'claude' | 'codex'): ReturnType<typeof createFakeAdapter> =>
      createFakeAdapter({ kind, startSessionIds: [`${kind}-1`, `${kind}-2`] });
    const adapters = { claude: build('claude'), codex: build('codex') };
    const deps: RunServiceDeps = {
      runsDir,
      now: () => new Date(NATIVE_AT),
      createAdapters: (): AgentAdapters => adapters,
    };
    const providerCalls = (): number => adapters.claude.calls.length + adapters.codex.calls.length;

    const ledger = countingLedger(extra);
    let threw = false;

    if (operation === 'START') {
      let runId = '';
      try {
        const started = await startNativeRun(
          deps,
          { title: 'sonde', cwd: dir, prompt: NATIVE_MISSION, runtimeConfig: nativeRuntimeConfig() },
          { openInvocationLedger: ledger.seam },
        );
        runId = started.runId;
      } catch {
        threw = true;
      }
      const engagements =
        runId === '' ? 0 : (await openInvocationLedger(runPaths(runsDir, runId), runId)).count();
      return {
        appends: ledger.appends(),
        ledgerEngagements: engagements,
        providerCalls: providerCalls(),
        threw,
      };
    }

    // Naissance hors couture : ses engagements appartiennent à START, pas à
    // l'opération sondée.
    const started = await startNativeRun(deps, {
      title: 'sonde',
      cwd: dir,
      prompt: NATIVE_MISSION,
      runtimeConfig: nativeRuntimeConfig(),
    });
    const runId = started.runId;
    const paths = runPaths(runsDir, runId);
    const before = (await openInvocationLedger(paths, runId)).count();
    const callsBefore = providerCalls();

    try {
      if (operation === 'STEP') {
        await stepNativeRun(deps, runId, { openInvocationLedger: ledger.seam });
      } else if (operation === 'SEND') {
        await sendNativeMessage(deps, runId, expertSlotTarget('author'), NATIVE_MESSAGE, {
          openInvocationLedger: ledger.seam,
        });
      } else if (operation === 'PAUSE') {
        await pauseNativeRun({ runsDir, now: deps.now }, runId);
      } else {
        await pauseNativeRun({ runsDir, now: deps.now }, runId);
        await resumeNativeRun({ runsDir, now: deps.now }, runId);
      }
    } catch {
      threw = true;
    }

    const after = (await openInvocationLedger(paths, runId)).count();
    return {
      // Sans couture — PAUSE, RESUME — le delta du journal EST la mesure.
      appends: operation === 'PAUSE' || operation === 'RESUME' ? after - before : ledger.appends(),
      ledgerEngagements: after - before,
      providerCalls: providerCalls() - callsBefore,
      threw,
    };
  } finally {
    await removeTempDir(dir);
  }
}

/** Sortie valide et vide — un succès, jamais une sortie inexploitable. */
function outputFor(operation: ProbedOperation): string {
  if (operation === 'DETECT') {
    return JSON.stringify({
      detector_output_version: CONTROVERSY_DETECTOR_OUTPUT_VERSION,
      proposals: [],
    });
  }
  if (operation === 'ADDUCE_MODEL') {
    return JSON.stringify({ adduction_proposal_version: ADDUCTION_PROPOSAL_VERSION, proposals: [] });
  }
  // La proposition assistée nomme sa cible dans sa sortie ; la sonde la
  // renseigne au moment de l'appel, faute de la connaître à la construction.
  return JSON.stringify({
    version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
    target_controversy_id: 'ctv_000001',
    proposals: [],
  });
}
