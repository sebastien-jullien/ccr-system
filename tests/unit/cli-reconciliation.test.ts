/**
 * Preuves de la tranche S14 — la surface CLI V5.
 *
 * Question de preuve :
 *
 * > **La ligne de commande transporte-t-elle la doctrine, ou la simplifie-t-elle
 * > en machine à états ?**
 *
 * Quatre propriétés.
 *
 *  1. **Surface, jamais autorité.** Aucune écriture de journal, aucune règle
 *     métier redite : la CLI assemble et délègue.
 *  2. **La fraîcheur est transmise, pas fabriquée.** La révision passée devient
 *     l'`observed_revision` de l'acte écrit, et un refus n'est jamais rejoué.
 *  3. **Les deux actualités survivent à l'écran.** `CR5-01` reste lisible : une
 *     décision non courante n'a pas perdu sa clôture, et aucun statut global
 *     n'apparaît.
 *  4. **La porte ouverte mène au moteur, et l'issue est rendue telle quelle.**
 *     Depuis la décision produit du 2026-08-21, `ccr propose` franchit la porte,
 *     engage avant d'appeler, et restitue l'issue du domaine sans la travestir.
 *
 * ```text
 * REAL_PROVIDER_CALLS = 0     adaptateurs doublés, jamais un fournisseur réel
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

const RUN_ID = 'CCR-20260820-S14A';
const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);

let dispatches = 0;

function fakeAdapter(kind: 'claude' | 'codex'): AgentAdapter {
  return {
    kind,
    async start(): Promise<AgentTurnResult> {
      dispatches += 1;
      throw new Error('aucun moteur ne doit être atteint en S14');
    },
    resume(): never {
      throw new Error('jamais');
    },
    openInteractive(): never {
      throw new Error('jamais');
    },
  };
}

interface Capture extends CliIo {
  readonly lines: string[];
  readonly errors: string[];
  text(): string;
  errorText(): string;
}

function capture(): Capture {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
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

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: RunServiceDeps;
  seed(entries: readonly ReconciliationEntry[]): Promise<void>;
  journal(): Promise<readonly ReconciliationEntry[]>;
  revision(): Promise<string>;
  dispose(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s14a-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      title: 'S14',
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
    [unit(1), unit(2)].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );

  const now = (): Date => new Date('2026-08-20T12:00:00.000Z');
  const adapters = { claude: fakeAdapter('claude'), codex: fakeAdapter('codex') };
  const deps = { runsDir, now, createAdapters: () => adapters } as unknown as RunServiceDeps;

  return {
    runsDir,
    paths,
    deps,
    seed: async (entries) => {
      await withNativeMutation(
        { runsDir, runId: RUN_ID, command: 's14-seed' },
        async () => {
          await appendReconciliationEntries(paths, entries);
        },
      );
    },
    journal: async () =>
      existsSync(paths.reconciliations) ? (await readReconciliationJournal(paths)).entries : [],
    revision: async () => (await readReconciliationJournal(paths)).revision,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

/** Un acte humain de fixture, semé directement — jamais par la CLI. */
function seededAct(
  sequence: number,
  over: Record<string, unknown> = {},
): ReconciliationEntry {
  return {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    entry_id: formatReconciliationId(sequence),
    kind: 'RECONCILIATION_RECORDED',
    target: { kind: 'CONTROVERSY', controversy_id: CTV },
    semantic_origin: 'HUMAN',
    recorded_by: 'CCR',
    recorded_at: `2026-08-20T11:0${String(sequence)}:00.000Z`,
    observed_revision: 'rcn-sha256:seed',
    scope_kind: 'SUBSET',
    scope: [E1],
    content: `décision semée ${String(sequence)}`,
    provenance: { kind: 'DECLARED', statement: 'semé' },
    ...over,
  } as unknown as ReconciliationEntry;
}

const SRC = new URL('../../src/cli/', import.meta.url);

function codeOnly(source: string): string {
  return source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// --------------------------------------------------------------------------
// Architecture
// --------------------------------------------------------------------------

test('S14 — la CLI n\'écrit dans aucun journal et ne duplique aucune règle', async () => {
  const dispatch = codeOnly(await readFile(new URL('reconciliation-dispatch.ts', SRC), 'utf8'));
  const format = codeOnly(await readFile(new URL('reconciliation-format.ts', SRC), 'utf8'));

  for (const forbidden of [
    'appendReconciliationEntries',
    'appendJsonLine',
    'reconciliation-store',
    'invocation-ledger',
    'usage-ledger',
    'withNativeMutation',
    'run-lock',
    'agent-adapter',
  ]) {
    assert.equal(dispatch.includes(forbidden), false, `écriture ou seam interdit : ${forbidden}`);
    assert.equal(format.includes(forbidden), false, `${forbidden} dans le formatteur`);
  }

  // Aucune sémantique métier recodée : ni actualité, ni détection, ni signal,
  // ni périmètre, ni forme d'autorité.
  for (const forbidden of [
    'reconciliation-currentness',
    'reconciliation-detector',
    'reconciliation-disagreement',
    'reconciliation-scope',
    'currentDecisions',
    'currentClosureEffects',
    'detectReconciliationStructures',
    'observedDisagreementSignals',
    'prepareScope',
  ]) {
    assert.equal(dispatch.includes(forbidden), false, `règle métier redite : ${forbidden}`);
    assert.equal(format.includes(forbidden), false, `règle métier redite : ${forbidden}`);
  }

  // Les propriétaires, eux, sont bien appelés.
  for (const owner of [
    'recordReconciliation',
    'recordProposalResponse',
    'projectReconciliationReadModel',
    'requestModelReconciliationProposal',
    'readCurrentReconciliationRevision',
  ]) {
    assert.ok(dispatch.includes(owner), `propriétaire non délégué : ${owner}`);
  }

  // Aucune valeur d'énumération métier n'est vérifiée par la CLI.
  for (const vocabulary of ['ADOPTS', 'MODIFIES', 'REPLACES', 'ACCEPT', 'REJECT', 'WHOLE', 'SUBSET']) {
    assert.equal(dispatch.includes(`'${vocabulary}'`), false, `vocabulaire recodé : ${vocabulary}`);
  }
});

test('S14 — aucun classement, aucun statut global, aucun tri', async () => {
  const dispatch = codeOnly(await readFile(new URL('reconciliation-dispatch.ts', SRC), 'utf8'));
  const format = codeOnly(await readFile(new URL('reconciliation-format.ts', SRC), 'utf8'));
  for (const forbidden of [
    '.sort(',
    'score',
    'rank',
    'winner',
    'recommend',
    'severity',
    'priority',
    'progress',
    'health',
    'CONVERGED',
    'REOPENED',
    'RESOLVED',
  ]) {
    assert.equal(format.includes(forbidden), false, `formatteur : ${forbidden}`);
    assert.equal(dispatch.includes(forbidden), false, `dispatcher : ${forbidden}`);
  }
});

// --------------------------------------------------------------------------
// Routage et usage
// --------------------------------------------------------------------------

test('S14 — les quatre commandes sont routées, et un drapeau inconnu est refusé', async () => {
  const h = await harness();
  try {
    for (const command of ['reconcile', 'respond', 'reconciliation', 'propose']) {
      const io = capture();
      const code = await runCli([command, '--run', RUN_ID, '--nawak', 'x'], {
        deps: h.deps,
        io,
      });
      // Option inconnue ⇒ usage, jamais une exécution partielle.
      assert.equal(code, 2, command);
      assert.ok(io.errorText().includes('Option inconnue : --nawak'), command);
    }
    assert.deepEqual(await h.journal(), []);
  } finally {
    await h.dispose();
  }
});

test('S14 — une option obligatoire absente est un usage, sans écriture', async () => {
  const h = await harness();
  try {
    const io = capture();
    const code = await runCli(['reconcile', '--run', RUN_ID], { deps: h.deps, io });
    assert.equal(code, 2);
    assert.ok(io.errorText().includes('--target'));
    assert.equal(existsSync(h.paths.reconciliations), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Mutation humaine et fraîcheur
// --------------------------------------------------------------------------

test('S14 — `ccr reconcile` délègue, et transmet la révision courante', async () => {
  const h = await harness();
  try {
    const before = await h.revision();
    const io = capture();
    const code = await runCli(
      [
        'reconcile',
        '--run', RUN_ID,
        '--target', CTV,
        '--scope-kind', 'SUBSET',
        '--scope', `${E1},${E2}`,
        '--content', 'nous retenons la variante courte',
        '--provenance', 'DECLARED',
        '--provenance-statement', 'décidé en revue du 20 août',
      ],
      { deps: h.deps, io },
    );
    assert.equal(code, 0);

    const entries = await h.journal();
    assert.equal(entries.length, 1);
    const act = entries[0] as unknown as Record<string, unknown>;
    assert.equal(act['kind'], 'RECONCILIATION_RECORDED');
    assert.equal(act['content'], 'nous retenons la variante courte');
    // La révision obtenue HORS verrou par la CLI est bien celle contre laquelle
    // le service a comparé : elle est devenue l'`observed_revision` de l'acte.
    assert.equal(act['observed_revision'], before);
    // Aucun effet n'existe sans son drapeau (§10.5, `H3`).
    for (const effect of ['closure', 'closure_withdrawal', 'supersedes', 'responds_to']) {
      assert.equal(effect in act, false, `${effect} produit sans drapeau`);
    }
    assert.equal(dispatches, 0);
  } finally {
    await h.dispose();
  }
});

test('S14 — chaque effet exige son drapeau, et il est transmis tel quel', async () => {
  const h = await harness();
  try {
    await h.seed([seededAct(1, { closure: { declared: true, statement: 'clos en revue' } })]);
    const io = capture();
    const code = await runCli(
      [
        'reconcile',
        '--run', RUN_ID,
        '--target', CTV,
        '--scope-kind', 'SUBSET',
        '--scope', E1,
        '--content', 'nous révisons',
        '--provenance', 'DECLARED',
        '--provenance-statement', 'revue',
        '--close', 'nous clôturons ce point',
        '--supersede', formatReconciliationId(1),
        '--supersede-scope', E1,
      ],
      { deps: h.deps, io },
    );
    assert.equal(code, 0);
    const entries = await h.journal();
    assert.equal(entries.length, 2);
    const act = entries[1] as unknown as Record<string, unknown>;
    assert.deepEqual(act['closure'], { declared: true, statement: 'nous clôturons ce point' });
    assert.deepEqual(act['supersedes'], [
      { superseded_act_id: formatReconciliationId(1), supersession_scope: [E1] },
    ]);
    // Superséder ne retire pas : aucun retrait n'a été fabriqué.
    assert.equal('closure_withdrawal' in act, false);
  } finally {
    await h.dispose();
  }
});

test('S14 — un refus est rendu tel quel, sans rejeu et sans octet', async () => {
  const h = await harness();
  try {
    const io = capture();
    const code = await runCli(
      [
        'reconcile',
        '--run', RUN_ID,
        '--target', CTV,
        '--scope-kind', 'SUBSET',
        '--scope', E1,
        '--content', 'nous retenons',
        // Genre de provenance inexistant : le DOMAINE refuse, pas la CLI.
        '--provenance', 'PARCE_QUE',
        '--provenance-statement', 'x',
      ],
      { deps: h.deps, io },
    );
    assert.equal(code, 1);
    assert.ok(io.errorText().includes('Refusé :'));
    // Ce refus vient du DOMAINE (`S1`), qui ne déclare aucune issue métier : la
    // CLI rend alors le code de l'erreur, et **n'invente pas** `REFUSED_VALIDATION`
    // à sa place. Étiqueter une issue que le service n'a pas étiquetée serait
    // exactement la seconde autorité que S14 ne doit pas devenir.
    assert.ok(io.errorText().includes('INVALID_ARGUMENT'));
    assert.equal(io.errorText().includes('REFUSED_VALIDATION'), false);
    // Un refus que le SERVICE étiquette, lui, est rendu avec son motif — voir
    // `OPTION_NOT_IN_PROPOSAL` dans cli-reconciliation-override.test.ts.
    assert.ok(io.errorText().includes("aucune reprise n'a lieu"));
    assert.equal(existsSync(h.paths.reconciliations), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Lecture
// --------------------------------------------------------------------------

test('S14 — `CR5-01` reste lisible à l\'écran, sans statut global', async () => {
  const h = await harness();
  try {
    // H1 clôt E1 ; H2 le supersède sur E1, sans retrait.
    await h.seed([
      seededAct(1, { closure: { declared: true, statement: 'clos' } }),
      seededAct(2, {
        supersedes: [{ superseded_act_id: formatReconciliationId(1), supersession_scope: [E1] }],
      }),
    ]);
    const io = capture();
    const code = await runCli(['reconciliation', '--run', RUN_ID], { deps: h.deps, io });
    assert.equal(code, 0);
    const text = io.text();

    // Les deux dimensions sont rendues sous deux libellés distincts.
    assert.ok(text.includes('actualité de décision'));
    assert.ok(text.includes("actualité d'effet de clôture"));
    // H1 n'est plus courant comme décision sur E1…
    assert.ok(text.includes(`${formatReconciliationId(1)} / ${E1} : non courante`));
    // …et son effet de clôture l'est toujours.
    assert.ok(text.includes(`${E1} : ${formatReconciliationId(1)}`));
    // Les deux faits du §17.2 sont rendus séparément.
    assert.ok(text.includes('déclaration humaine historique de clôture sur WHOLE'));
    assert.ok(text.includes('couverture actuelle de toutes les unités'));

    // Aucun statut global, aucune convergence, aucun gagnant.
    for (const forbidden of ['OPEN', 'CLOSED', 'REOPENED', 'RESOLVED', 'CONVERGED', 'gagnant', 'recommand']) {
      assert.equal(text.includes(forbidden), false, `statut global rendu : ${forbidden}`);
    }
    // La lecture n'écrit rien.
    assert.equal((await h.journal()).length, 2);
  } finally {
    await h.dispose();
  }
});

test('S14 — l\'ordre serveur survit jusqu\'à la sortie', async () => {
  const h = await harness();
  try {
    await h.seed([seededAct(1), seededAct(2), seededAct(3)]);
    const io = capture();
    await runCli(['reconciliation', '--run', RUN_ID], { deps: h.deps, io });
    const text = io.text();
    const first = text.indexOf(formatReconciliationId(1));
    const second = text.indexOf(formatReconciliationId(2));
    const third = text.indexOf(formatReconciliationId(3));
    // Ordre d'append, jamais reconstruit — et jamais présenté comme un rang.
    assert.ok(first < second && second < third);
    assert.equal(text.includes('1.'), false);
    assert.equal(text.includes('#1'), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Porte ouverte — et l'issue rendue telle qu'elle est
// --------------------------------------------------------------------------

test('V5.1 — `ccr propose` franchit la porte et rend l\'issue du moteur, sans la travestir', async () => {
  const h = await harness();
  try {
    // La porte est ouverte depuis la décision produit du 2026-08-21. Le moteur
    // doublé de ce fichier ÉCHOUE délibérément : ce que le test éprouve, c'est
    // donc le chemin normal jusqu'au fournisseur, puis la restitution honnête de
    // sa défaillance — jamais un refus de porte déguisé en panne, ni l'inverse.
    const before = dispatches;
    const io = capture();
    const code = await runCli(
      [
        'propose',
        '--run', RUN_ID,
        '--target', CTV,
        '--scope-kind', 'SUBSET',
        '--scope', E1,
        '--expert', 'challenger',
      ],
      { deps: h.deps, io },
    );
    assert.equal(code, 1);
    assert.equal(dispatches, before + 1, 'le moteur doit désormais être atteint');
    assert.ok(io.errorText().includes("Le moteur n'a pas rendu de sortie"));

    // La cause n'est réinterprétée ni en indisponibilité, ni en sortie invalide,
    // ni en revalidation refusée. Trois issues distinctes, jamais confondues.
    for (const forbidden of [
      'NOT_AVAILABLE',
      "n'est pas disponible",
      'INVALID_OUTPUT',
      'REVALIDATION_REFUSED',
      'quota épuisé',
    ]) {
      assert.equal(io.errorText().includes(forbidden), false, forbidden);
    }

    // L'engagement, lui, demeure : il a été enregistré AVANT la tentative, et
    // une défaillance ne l'efface pas. Aucune proposition canonique n'est écrite.
    assert.ok(existsSync(h.paths.invocations), 'engagement durable écrit');
    assert.equal(existsSync(h.paths.reconciliations), false, 'aucun append sur échec');
  } finally {
    await h.dispose();
  }
});

test('S14 — aucune option ne gouverne la porte publique', async () => {
  const h = await harness();
  try {
    // Les drapeaux de contournement n'existent pas : le parseur les refuse
    // avant toute exécution, et il n'en existe aucun de ce genre. La porte est
    // ouverte depuis le 2026-08-21, et aucun de ces drapeaux n'y est pour rien.
    const before = dispatches;
    for (const flag of ['--force', '--yes', '--unsafe', '--override', '--available']) {
      const io = capture();
      const code = await runCli(
        ['propose', '--run', RUN_ID, '--target', CTV, '--scope-kind', 'SUBSET', '--expert', 'challenger', flag, 'x'],
        { deps: h.deps, io },
      );
      assert.equal(code, 2, flag);
      assert.ok(io.errorText().includes('Option inconnue'), flag);
    }
    // Compteur RELATIF : `dispatches` est partagé par le fichier, et un refus de
    // parseur ne doit rien y ajouter — quel que soit ce qui a couru avant.
    assert.equal(dispatches, before);
  } finally {
    await h.dispose();
  }
});

test('S14 — la voie d\'acceptation contrôlée n\'est atteignable par aucune commande', async () => {
  const dispatch = codeOnly(await readFile(new URL('reconciliation-dispatch.ts', SRC), 'utf8'));
  const main = codeOnly(await readFile(new URL('main.ts', SRC), 'utf8'));
  for (const source of [dispatch, main]) {
    assert.equal(source.includes('runControlledAcceptanceProposal'), false);
    assert.equal(source.includes('G4_REAL_PROPOSAL_ACCEPTANCE'), false);
  }
});
