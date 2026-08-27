/**
 * Preuves de la tranche S14 — l'override humain réel, §41.
 *
 * « Override » n'est pas un contournement. Le contrat lui donne un sens exact :
 *
 * ```text
 * REAL_HUMAN_OVERRIDE = REQUIRED                                     §13.6
 * Les quatre opérations doivent être RÉELLEMENT disponibles :
 *     ACCEPT   REJECT   MODIFY   REPLACE                             §41
 * ```
 *
 * Rien à voir avec la porte de disponibilité du modèle. Ce fichier prouve que
 * les quatre opérations existent réellement en ligne de commande, qu'aucune
 * surface n'offre `ACCEPT` seul, qu'un acte humain existe **sans qu'aucune
 * proposition n'existe** (`C48`), et que `MODIFY`/`REPLACE` permettent de saisir
 * un contenu humain propre.
 *
 * ```text
 * OVERRIDE  ≠  BYPASS MODEL AVAILABILITY
 * ACCEPT    ≠  ADOPTS            RESPONSE  ≠  HUMAN ACT
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
  validateControversyEntry,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import {
  RECONCILIATION_SCHEMA_VERSION,
  formatReconciliationId,
} from '../../src/core/reconciliation.ts';
import type { ReconciliationEntry } from '../../src/core/reconciliation.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import {
  appendReconciliationEntries,
  readReconciliationJournal,
} from '../../src/store/reconciliation-store.ts';
import { withNativeMutation } from '../../src/services/native-mutation-boundary.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runCli } from '../../src/cli/main.ts';

const RUN_ID = 'CCR-20260820-S14B';
const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const PROPOSAL = formatReconciliationId(1);
const OTHER_PROPOSAL = formatReconciliationId(2);

function capture(): CliIo & { text(): string; errorText(): string } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    out: (text) => lines.push(text),
    err: (text) => errors.push(text),
    text: () => lines.join('\n'),
    errorText: () => errors.join('\n'),
  };
}

function unit(sequence: number): ControversyEntry {
  return validateControversyEntry({
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: CTV,
    kind: sequence === 1 ? 'CONTROVERSY_RECORDED' : 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'SOURCE', actor: 'author' },
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T09:30:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  } as ControversyEntry);
}

function seededProposal(sequence: number, options: readonly string[]): ReconciliationEntry {
  return {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: formatReconciliationId(sequence),
    kind: 'RECONCILIATION_PROPOSED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'CCR',
    recorded_by: 'CCR',
    recorded_at: `2026-08-20T11:0${String(sequence)}:00.000Z`,
    observed_revision: 'rcn-sha256:seed',
    scope_kind: 'SUBSET',
    scope: [E1],
    derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_000001', inputs: [E1] },
    options: options.map((id) => ({ option_id: id, content: `contenu ${id}` })),
  } as unknown as ReconciliationEntry;
}

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: RunServiceDeps;
  journal(): Promise<readonly ReconciliationEntry[]>;
  dispose(): Promise<void>;
}

async function harness(seed: readonly ReconciliationEntry[] = []): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s14b-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      title: 'S14 override',
      created_at: '2026-08-20T09:00:00.000Z',
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
      last_event_id: 'evt_000001',
      updated_at: '2026-08-20T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(
    paths.events,
    `${JSON.stringify({
      event_id: 'evt_000001',
      run_id: RUN_ID,
      round: 1,
      timestamp: '2026-08-20T09:10:00.000Z',
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: 'author',
      session_id: 'S1',
      content: 'Le cache doit expirer rapidement.',
    })}\n`,
    'utf8',
  );
  await writeFile(
    paths.controversies,
    [unit(1)].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );

  const adapter: AgentAdapter = {
    kind: 'claude',
    start(): Promise<AgentTurnResult> {
      throw new Error('aucun moteur en S14');
    },
    resume(): never {
      throw new Error('jamais');
    },
    openInteractive(): never {
      throw new Error('jamais');
    },
  };
  const now = (): Date => new Date('2026-08-20T12:00:00.000Z');
  const deps = {
    runsDir,
    now,
    createAdapters: () => ({ claude: adapter, codex: adapter }),
  } as unknown as RunServiceDeps;

  if (seed.length > 0) {
    await withNativeMutation({ runsDir, runId: RUN_ID, command: 's14b-seed' }, async () => {
      await appendReconciliationEntries(paths, seed);
    });
  }

  return {
    runsDir,
    paths,
    deps,
    journal: async () =>
      existsSync(paths.reconciliations) ? (await readReconciliationJournal(paths)).entries : [],
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

const PROVENANCE = ['--provenance', 'DECLARED', '--provenance-statement', 'revue du 20 août'];

// --------------------------------------------------------------------------
// Les quatre opérations, réellement disponibles
// --------------------------------------------------------------------------

test('S14 — `ACCEPT` et `REJECT` sont réellement disponibles, sans effet', async () => {
  for (const mode of ['ACCEPT', 'REJECT']) {
    const h = await harness([seededProposal(1, ['oa', 'ob'])]);
    try {
      const io = capture();
      const code = await runCli(
        ['respond', '--run', RUN_ID, '--target', CTV, '--proposal', PROPOSAL, '--mode', mode, ...PROVENANCE],
        { deps: h.deps, io },
      );
      assert.equal(code, 0, mode);
      const entries = await h.journal();
      assert.equal(entries.length, 2);
      const response = entries[1] as unknown as Record<string, unknown>;
      assert.equal(response['kind'], 'PROPOSAL_RESPONSE_RECORDED');
      assert.deepEqual(response['responds_to'], { proposal_id: PROPOSAL, mode });
      // Une réponse ne porte aucun effet, et n'est pas un acte humain.
      for (const forbidden of ['closure', 'closure_withdrawal', 'supersedes', 'scope', 'content']) {
        assert.equal(forbidden in response, false, `${mode} : ${forbidden}`);
      }
      assert.ok(io.text().includes('ne clôt rien'));
    } finally {
      await h.dispose();
    }
  }
});

test('S14 — `MODIFY` et `REPLACE` exigent et portent un contenu humain propre', async () => {
  for (const relation of ['MODIFIES', 'REPLACES']) {
    const h = await harness([seededProposal(1, ['oa', 'ob'])]);
    try {
      const io = capture();
      const code = await runCli(
        [
          'reconcile',
          '--run', RUN_ID,
          '--target', CTV,
          '--scope-kind', 'SUBSET',
          '--scope', E1,
          '--content', `formulation humaine propre pour ${relation}`,
          ...PROVENANCE,
          '--responds-to', PROPOSAL,
          '--relation', relation,
        ],
        { deps: h.deps, io },
      );
      assert.equal(code, 0, relation);
      const entries = await h.journal();
      const act = entries[1] as unknown as Record<string, unknown>;
      assert.equal(act['kind'], 'RECONCILIATION_RECORDED');
      assert.equal(act['content'], `formulation humaine propre pour ${relation}`);
      assert.deepEqual(act['responds_to'], { proposal_id: PROPOSAL, relation });
      // Aucun effet implicite : la relation n'en produit aucun.
      for (const forbidden of ['closure', 'closure_withdrawal', 'supersedes']) {
        assert.equal(forbidden in act, false, `${relation} : ${forbidden}`);
      }
    } finally {
      await h.dispose();
    }
  }
});

test('S14 — `ADOPTS` exige son option, et `MODIFIES` l\'interdit', async () => {
  const h = await harness([seededProposal(1, ['oa', 'ob'])]);
  try {
    const adopt = capture();
    assert.equal(
      await runCli(
        [
          'reconcile', '--run', RUN_ID, '--target', CTV, '--scope-kind', 'SUBSET', '--scope', E1,
          '--content', 'nous adoptons cette option, dans nos termes',
          ...PROVENANCE, '--responds-to', PROPOSAL, '--relation', 'ADOPTS', '--adopted-option', 'ob',
        ],
        { deps: h.deps, io: adopt },
      ),
      0,
    );
    const act = (await h.journal())[1] as unknown as Record<string, unknown>;
    assert.deepEqual(act['responds_to'], {
      proposal_id: PROPOSAL,
      relation: 'ADOPTS',
      adopted_option_id: 'ob',
    });

    // `MODIFIES` avec une option : refusé par le SERVICE, jamais par la CLI.
    const refused = capture();
    assert.equal(
      await runCli(
        [
          'reconcile', '--run', RUN_ID, '--target', CTV, '--scope-kind', 'SUBSET', '--scope', E1,
          '--content', 'nous modifions',
          ...PROVENANCE, '--responds-to', PROPOSAL, '--relation', 'MODIFIES', '--adopted-option', 'ob',
        ],
        { deps: h.deps, io: refused },
      ),
      1,
    );
    assert.ok(refused.errorText().includes('Refusé :'));
    assert.equal((await h.journal()).length, 2);
  } finally {
    await h.dispose();
  }
});

test('S14 — une option étrangère à la proposition est refusée', async () => {
  const h = await harness([seededProposal(1, ['oa']), seededProposal(2, ['ob'])]);
  try {
    const io = capture();
    const code = await runCli(
      [
        'reconcile', '--run', RUN_ID, '--target', CTV, '--scope-kind', 'SUBSET', '--scope', E1,
        '--content', 'nous adoptons',
        ...PROVENANCE,
        // `ob` appartient à l'AUTRE proposition.
        '--responds-to', PROPOSAL, '--relation', 'ADOPTS', '--adopted-option', 'ob',
      ],
      { deps: h.deps, io },
    );
    assert.equal(code, 1);
    assert.ok(io.errorText().includes('Refusé :'));
    // Seules les deux propositions semées demeurent : aucun acte n'a été écrit.
    const entries = await h.journal();
    assert.equal(entries.length, 2, 'un acte a été écrit malgré le refus');
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ['RECONCILIATION_PROPOSED', 'RECONCILIATION_PROPOSED'],
    );
    // Le motif vient du service, qui seul connaît l'appartenance d'une option.
    assert.ok(io.errorText().includes('OPTION_NOT_IN_PROPOSAL'));
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// `C48` — un acte humain sans aucune proposition
// --------------------------------------------------------------------------

test('S14 — `C48` : un acte humain existe sans qu\'aucune proposition existe', async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.journal(), []);
    const io = capture();
    const code = await runCli(
      [
        'reconcile', '--run', RUN_ID, '--target', CTV, '--scope-kind', 'SUBSET', '--scope', E1,
        '--content', 'nous tranchons sans proposition',
        ...PROVENANCE,
      ],
      { deps: h.deps, io },
    );
    assert.equal(code, 0);
    const entries = await h.journal();
    assert.equal(entries.length, 1);
    const act = entries[0] as unknown as Record<string, unknown>;
    assert.equal(act['kind'], 'RECONCILIATION_RECORDED');
    assert.equal('responds_to' in act, false);
    // La surface `B` est indépendante de la surface `C` (§41).
  } finally {
    await h.dispose();
  }
});

test('S14 — aucune surface n\'offre `ACCEPT` seul', async () => {
  const h = await harness([seededProposal(1, ['oa'])]);
  try {
    // `--mode` est obligatoire : il n'existe aucune commande d'acceptation
    // implicite, aucune valeur par défaut, aucune acceptation par omission.
    const io = capture();
    const code = await runCli(
      ['respond', '--run', RUN_ID, '--target', CTV, '--proposal', PROPOSAL, ...PROVENANCE],
      { deps: h.deps, io },
    );
    assert.equal(code, 2);
    assert.ok(io.errorText().includes('--mode'));
    assert.equal((await h.journal()).length, 1);
    // Et les deux modes sont également atteignables : la surface n'en privilégie
    // aucun. `REJECT` est prouvé disponible par le premier test de ce fichier.
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Immutabilité de la proposition
// --------------------------------------------------------------------------

test('S14 — la proposition CCR reste CCR après toute action humaine', async () => {
  const h = await harness([seededProposal(1, ['oa', 'ob'])]);
  try {
    const before = JSON.stringify((await h.journal())[0]);

    await runCli(
      [
        'reconcile', '--run', RUN_ID, '--target', CTV, '--scope-kind', 'SUBSET', '--scope', E1,
        '--content', 'nous adoptons, dans nos termes',
        ...PROVENANCE, '--responds-to', PROPOSAL, '--relation', 'ADOPTS', '--adopted-option', 'oa',
      ],
      { deps: h.deps, io: capture() },
    );
    await runCli(
      ['respond', '--run', RUN_ID, '--target', CTV, '--proposal', PROPOSAL, '--mode', 'REJECT', ...PROVENANCE],
      { deps: h.deps, io: capture() },
    );

    const entries = await h.journal();
    assert.equal(entries.length, 3);
    // Octet pour octet : aucune réattribution, aucune requalification.
    assert.equal(JSON.stringify(entries[0]), before);
    const proposal = entries[0] as unknown as Record<string, unknown>;
    assert.equal(proposal['semantic_origin'], 'CCR');
    assert.equal(proposal['recorded_by'], 'CCR');
    // Le nouvel acte humain est distinct, et humain.
    assert.equal((entries[1] as unknown as Record<string, unknown>)['semantic_origin'], 'HUMAN');
    // Adoption ET rejet coexistent : aucun statut de proposition n'existe.
    for (const entry of entries) {
      for (const forbidden of ['proposal_status', 'accepted', 'rejected', 'winning_option']) {
        assert.equal(forbidden in (entry as unknown as Record<string, unknown>), false, forbidden);
      }
    }
  } finally {
    await h.dispose();
  }
});

test('S14 · V5.1 — `override` est une capacité HUMAINE, étrangère à la porte du modèle', async () => {
  const h = await harness([seededProposal(1, ['oa'])]);
  try {
    // Les quatre opérations du §41 aboutissent toutes sans qu'aucun moteur soit
    // atteint : « override » n'a jamais été une clé d'ouverture, et la porte —
    // fermée hier, ouverte depuis la décision produit du 2026-08-21 — ne doit
    // rien à cette capacité. Les deux gouvernances restent séparées.
    const io = capture();
    const code = await runCli(
      ['respond', '--run', RUN_ID, '--target', CTV, '--proposal', PROPOSAL, '--mode', 'ACCEPT', ...PROVENANCE],
      { deps: h.deps, io },
    );
    assert.equal(code, 0);
    assert.equal(existsSync(h.paths.invocations), false);
    assert.equal(existsSync(h.paths.usage), false);
    // Et la démonstration se lit maintenant dans l'autre sens : la voie du
    // modèle, elle, engage. L'acte humain n'avait rien écrit ci-dessus ; un
    // `propose` atteint le moteur doublé — qui échoue — et laisse un engagement.
    // Deux voies, deux gouvernances, aucune ne décide pour l'autre.
    const modele = capture();
    assert.equal(
      await runCli(
        ['propose', '--run', RUN_ID, '--target', CTV, '--scope-kind', 'SUBSET', '--scope', E1, '--expert', 'author'],
        { deps: h.deps, io: modele },
      ),
      1,
    );
    assert.ok(modele.errorText().includes("Le moteur n'a pas rendu de sortie"));
    assert.ok(existsSync(h.paths.invocations), 'la voie du modèle, elle, engage');
  } finally {
    await h.dispose();
  }
});
