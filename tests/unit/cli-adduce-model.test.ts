/**
 * V4 · S10 — la surface publique `ccr adduce-model`, activée après le REAL gate.
 *
 * Question de preuve :
 *
 * > **L'ouverture de la porte publique a-t-elle ouvert autre chose qu'elle-même ?**
 *
 * Quatre propriétés.
 *
 *  1. **Une seule porte.** La CLI emprunte `requestModelAdduction`, et jamais la
 *     voie d'acceptation contrôlée du gate — qui reste inatteignable depuis
 *     toute surface, activation comprise.
 *  2. **Le contexte est une ENTRÉE.** `--controversy` reçoit un `ctve_`
 *     d'ouverture, transmis littéralement. Un `ctv_` n'est ni accepté, ni
 *     converti.
 *  3. **Présence ici, forme au domaine.** La CLI vérifie que les arguments
 *     existent ; leur canonicité appartient au domaine, comme pour `ccr adduce`.
 *  4. **Six issues, trois codes.** Aucune septième issue, aucun code nouveau,
 *     aucune option de contournement.
 *
 * Aucun fournisseur réel : l'adaptateur est injecté par `overrides.deps`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runCli } from '../../src/cli/main.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { readEvidenceJournal } from '../../src/store/evidence-store.ts';
import { readCurrentEvidenceRevision } from '../../src/services/evidence-freshness.ts';
import { recordAssertion, recordControversy } from '../../src/services/controversy-service.ts';
import { registerMaterial } from '../../src/services/evidence-service.ts';
import {
  ADDUCTION_PROPOSAL_VERSION,
  MODEL_ADDUCTION_DOMAIN_OUTCOMES,
  MODEL_ADDUCTION_IMPLEMENTED,
  MODEL_ADDUCTION_RUNTIME_AVAILABILITY,
} from '../../src/services/evidence-adducer.ts';

const RUN_ID = 'CCR-20260818-S10C';
const SRC = new URL('../../src/', import.meta.url);
const HELD_TEXT = 'Mesure : le cache expire en 30 s. Ensuite, le cache est reconstruit.';

interface Script {
  readonly content?: string;
  readonly fail?: Error;
}

let dispatches = 0;

function fakeAdapter(kind: 'claude' | 'codex', script: Script): AgentAdapter {
  return {
    kind,
    async start(): Promise<AgentTurnResult> {
      dispatches += 1;
      if (script.fail !== undefined) throw script.fail;
      return {
        agent: kind,
        sessionId: `s10c-${kind}`,
        content: script.content ?? '',
        exitCode: 0,
        startedAt: '2026-08-18T10:00:00.000Z',
        completedAt: '2026-08-18T10:00:01.000Z',
        stdoutRaw: script.content ?? '',
        stderrRaw: '',
      };
    },
    resume(): Promise<AgentTurnResult> {
      throw new Error('jamais');
    },
    openInteractive(): never {
      throw new Error('jamais');
    },
  };
}

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: RunServiceDeps;
  readonly opening: string;
  readonly first: string;
  readonly material: string;
  dispose(): Promise<void>;
}

async function harness(script: Script = {}): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s10c-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      title: 'S10 activation',
      created_at: '2026-08-18T09:00:00.000Z',
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
      updated_at: '2026-08-18T09:00:00.000Z',
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
      timestamp: '2026-08-18T09:10:00.000Z',
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: 'author',
      session_id: 'S1',
      content: 'Le cache doit expirer rapidement.',
    })}\n`,
    'utf8',
  );

  const now = (): Date => new Date('2026-08-18T10:00:00.000Z');
  const adapters = { claude: fakeAdapter('claude', script), codex: fakeAdapter('codex', script) };
  const deps = { runsDir, now, createAdapters: () => adapters } as unknown as RunServiceDeps;

  const opened = await recordControversy({ runsDir, now }, {
    runId: RUN_ID,
    expected_controversy_revision: '',
    provenance_event_ids: ['evt_000001'],
    statement: 'Durée de vie du cache',
  }).catch(async () => {
    // La révision initiale d'un journal vide n'est pas la chaîne vide : on la lit.
    const { readControversyJournal } = await import('../../src/store/controversy-store.ts');
    return recordControversy({ runsDir, now }, {
      runId: RUN_ID,
      expected_controversy_revision: (await readControversyJournal(paths)).revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'Durée de vie du cache',
    });
  });
  const first = await recordAssertion({ runsDir, now }, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: opened.controversy_revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Le TTL doit être court',
  });
  const material = await registerMaterial({ runsDir, now }, {
    runId: RUN_ID,
    expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir }, RUN_ID),
    representation: { form: 'INLINE_TEXT', text: HELD_TEXT },
  });

  return {
    runsDir,
    paths,
    deps,
    opening: opened.entry.entry_id,
    first: first.entry.entry_id,
    material: material.entry.entry_id,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(h: Harness, argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli([...argv, '--run', RUN_ID, '--runs-dir', h.runsDir], { io, deps: h.deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function output(proposals: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ adduction_proposal_version: ADDUCTION_PROPOSAL_VERSION, proposals });
}

function proposal(target: string, orientation = 'SUPPORTS'): Record<string, unknown> {
  return { material_id: 'mat_000001', target_entry_id: target, orientation };
}

// ==========================================================================
// A · B · C — la vérité publique, et la syntaxe gelée
// ==========================================================================

test('1 · A/B/C — disponibilité levée, commande documentée, syntaxe exacte', async () => {
  assert.equal(MODEL_ADDUCTION_IMPLEMENTED, true);
  assert.equal(MODEL_ADDUCTION_RUNTIME_AVAILABILITY, 'AVAILABLE');

  const h = await harness();
  try {
    const inconnue = await cli(h, ['commande-inexistante']);
    assert.equal(inconnue.code, 2);

    const ligne = inconnue.err.split('\n').find((l) => l.includes('ccr adduce-model')) ?? '';
    assert.equal(
      ligne.trim(),
      'ccr adduce-model <material_id> --controversy <ctve_id>',
      'la syntaxe gelée, au mot près',
    );
    assert.ok(inconnue.err.includes('l’ENTRÉE D’OUVERTURE'.replace(/’/g, '’')) ||
      inconnue.err.includes("l'ENTRÉE D'OUVERTURE") ||
      inconnue.err.includes('ENTRÉE D’OUVERTURE'), 'l’usage dit ce qu’attend --controversy');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// D · E — le contexte est un ctve_, transmis littéralement
// ==========================================================================

test('2 · D — un `ctv_` n’est ni accepté, ni converti en son ouverture', async () => {
  const before = dispatches;
  const h = await harness({ content: output([proposal('ctve_000002')]) });
  try {
    // `ctv_000001` EXISTE dans ce run — et il reste refusé : aucune résolution
    // implicite ne le remplace par l'entrée d'ouverture qu'il désigne.
    const r = await cli(h, ['adduce-model', h.material, '--controversy', 'ctv_000001']);
    assert.equal(r.code, 1, 'refus du domaine, jamais un succès');
    assert.equal(dispatches, before, 'aucun dispatch : refusé avant l’adaptateur');
    assert.equal(existsSync(h.paths.invocations), false, 'aucun engagement');
  } finally {
    await h.dispose();
  }
});

test('3 · E/F — la CLI transmet le ctve_ REÇU, par la porte publique', async () => {
  const h = await harness({ content: output([proposal('ctve_000002')]) });
  try {
    const r = await cli(h, ['adduce-model', h.material, '--controversy', h.opening]);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(h.opening), 'le contexte rendu est celui fourni');

    // Le service a bien reçu l'ouverture : le lot est lié aux entrées soumises.
    const journal = await readEvidenceJournal(h.paths);
    const adduction = journal.entries.find((e) => e.kind === 'ADDUCTION_RECORDED');
    assert.ok(adduction !== undefined);
    if (adduction?.kind === 'ADDUCTION_RECORDED') {
      assert.ok(adduction.derivation?.inputs.includes(h.opening), 'ouverture dans les inputs');
      assert.equal(adduction.semantic_origin, 'CCR');
      assert.equal(adduction.derivation?.method, 'MODEL_ASSISTED');
    }
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// H · I · K · L · M · N — six issues, trois codes
// ==========================================================================

test('4 · H/I/K/L/M — les cinq issues du pipeline, et leurs codes', async () => {
  const cases: readonly (readonly [string, Script, number, string])[] = [
    ['PERSISTED', { content: output([proposal('ctve_000002')]) }, 0, 'adduction(s) inférée(s)'],
    ['VALID_ZERO', { content: output([]) }, 0, 'aucune adduction proposée'],
    ['INVALID_OUTPUT', { content: 'pas du JSON' }, 1, 'inexploitable'],
    ['REVALIDATION_REFUSED', { content: output([proposal('ctve_000009')]) }, 1, 'Revalidation refusée'],
    ['PROVIDER_FAILED', { fail: new Error('panne') }, 1, 'pas rendu de sortie'],
  ];

  for (const [label, script, expectedCode, fragment] of cases) {
    const h = await harness(script);
    try {
      const r = await cli(h, ['adduce-model', h.material, '--controversy', h.opening]);
      assert.equal(r.code, expectedCode, `${label} → code ${String(expectedCode)}`);
      assert.ok(`${r.out}\n${r.err}`.includes(fragment), `${label} : « ${fragment} »`);

      // L'invocation reste enregistrée dans les cinq cas.
      assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1, label);
    } finally {
      await h.dispose();
    }
  }
});

test('5 · N — une erreur d’usage rend 2, sans jamais toucher au domaine', async () => {
  const before = dispatches;
  const h = await harness({ content: output([]) });
  try {
    for (const argv of [
      ['adduce-model'],
      ['adduce-model', h.material],
      ['adduce-model', '--controversy', h.opening],
      ['adduce-model', h.material, '--controversy'],
      ['adduce-model', h.material, '--controversy', h.opening, '--provider', 'claude'],
      ['adduce-model', h.material, '--controversy', h.opening, '--force'],
    ]) {
      const r = await cli(h, argv);
      assert.equal(r.code, 2, argv.join(' '));
    }
    assert.equal(dispatches, before, 'aucun dispatch sur erreur d’usage');
    assert.equal(existsSync(h.paths.invocations), false);
  } finally {
    await h.dispose();
  }
});

test('6 · la FORME appartient au domaine, la PRÉSENCE à la CLI', async () => {
  const h = await harness({ content: output([]) });
  try {
    // Présents mais non canoniques : code 1, pas 2 — comme `ccr adduce`.
    for (const argv of [
      ['adduce-model', 'pas-un-materiau', '--controversy', h.opening],
      ['adduce-model', h.material, '--controversy', 'ctve_1'],
      ['adduce-model', h.material, '--controversy', 'ctve_999999'],
    ]) {
      const r = await cli(h, argv);
      assert.equal(r.code, 1, argv.join(' '));
    }
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// O · P · Q · R · S — ce que l'activation n'a pas ouvert
// ==========================================================================

test('7 · O/P — aucune option de contournement, aucune voie d’acceptation', async () => {
  const cli_ = await readFile(new URL('cli/main.ts', SRC), 'utf8');
  const start = cli_.indexOf('async function commandAdduceModel');
  const end = cli_.indexOf('\n}\n', cli_.indexOf('switch (adduction.kind)'));
  assert.ok(start > 0 && end > start, 'la commande est délimitée');
  const command = cli_.slice(start, end);

  assert.ok(command.includes('requestModelAdduction('), 'elle passe par la porte');

  // Les jetons sont ceux d'un CONTOURNEMENT, jamais des mots isolés : « model »
  // est contenu dans le nom même de la commande, et une garde qui l'ignorerait
  // accuserait `adduce-model` de s'appeler comme elle s'appelle.
  for (const option of [
    '--provider', '--model', '--force', '--acceptance', '--gate', '--internal',
    '--retry', '--bypass', '--skip-quota', '--skip-ledger', '--skip-binding',
    '--skip-revalidation', '--expected-revision',
  ]) {
    assert.equal(command.includes(option), false, `commandAdduceModel : « ${option} »`);
  }
  for (const token of [
    'runControlledAcceptanceAdduction', 'S10_REAL_ADDUCTION_ACCEPTANCE', 'adduceMaterialByModel',
    'expected_evidence_revision', 'createAdapters', '.start(', 'openInvocationLedger',
  ]) {
    assert.equal(command.includes(token), false, `commandAdduceModel : « ${token} »`);
  }

  // La route déclare exactement les options gelées.
  const route = cli_.slice(cli_.indexOf("case 'adduce-model':"), cli_.indexOf("case 'detect':"));
  assert.ok(route.includes("[...commonFlags, 'run', 'controversy', 'expert']"));
});

/**
 * Ce qui trahirait une **surface d'adduction ASSISTÉE V4** — les symboles
 * réellement exportés par `services/evidence-adducer.ts`, plus le chemin du
 * module, le jeton de sa voie d'acceptation et le déclencheur d'invocation qui
 * la gouverne.
 *
 * La surface HUMAINE de V4 — `registerMaterial`, `adduceMaterial` — n'y figure
 * pas : l'addendum V5.1 du 2026-08-21 l'a ouverte au cockpit et à HTTP en
 * supersédant le premier palier du §30. Ce qui reste fermé est l'assistance,
 * pas la mutation.
 *
 * ```text
 * SURFACE HUMAINE V4  ≠  SURFACE ASSISTÉE V4
 * ```
 */
const V4_ASSISTED_FORBIDDEN_SYMBOLS: readonly string[] = [
  'requestModelAdduction',
  'runControlledAcceptanceAdduction',
  'adduceMaterialByModel',
  'parseAdductionProposals',
  'buildAdductionPrompt',
  'revalidateProposal',
  'MODEL_ADDUCTION_RUNTIME_AVAILABILITY',
  'MODEL_ADDUCTION_IMPLEMENTED',
  'MODEL_ADDUCTION_DOMAIN_OUTCOMES',
  'ADDUCTION_PROPOSAL_VERSION',
  'S10_REAL_ADDUCTION_ACCEPTANCE',
  'EVIDENCE_ADDUCTION',
  'evidence-adducer',
  'adduce-model',
];

test('8 · Q/R — aucune surface d’adduction assistée, ni HTTP ni cockpit', async () => {
  const http = await readFile(new URL('cockpit/mutations-http.ts', SRC), 'utf8');
  for (const token of V4_ASSISTED_FORBIDDEN_SYMBOLS) {
    assert.equal(http.includes(token), false, `mutations-http : « ${token} »`);
  }

  const render = await readFile(new URL('cockpit/web/render.js', SRC), 'utf8');
  for (const token of ['adduce-model', 'adducer', 'MODEL_ADDUCTION', 'acceptance']) {
    assert.equal(render.includes(token), false, `render.js : « ${token} »`);
  }

  // ---- SENTINELLE. Une garde plus précise doit rester une garde.
  const assiste = "await requestModelAdduction(deps, request); // services/evidence-adducer.ts";
  assert.deepEqual(
    V4_ASSISTED_FORBIDDEN_SYMBOLS.filter((symbol) => assiste.includes(symbol)).sort(),
    ['evidence-adducer', 'requestModelAdduction'],
    'une surface assistée réelle serait encore attrapée',
  );
  const humain = 'return registerMaterial(deps, input); // puis adduceMaterial(deps, input)';
  assert.deepEqual(
    V4_ASSISTED_FORBIDDEN_SYMBOLS.filter((symbol) => humain.includes(symbol)),
    [],
    'la surface humaine V4 n’est pas une surface assistée',
  );

  // Et elle est bien là, cette surface humaine : la garde constate ce que
  // l'addendum a ouvert, plutôt que d'affirmer une absence devenue fausse.
  for (const autorise of ['registerMaterial', 'adduceMaterial']) {
    assert.ok(http.includes(autorise), `surface humaine V4 attendue : ${autorise}`);
  }
});

test('9 · six issues de domaine, et aucune septième', () => {
  assert.deepEqual([...MODEL_ADDUCTION_DOMAIN_OUTCOMES], [
    'PERSISTED', 'VALID_ZERO', 'NOT_AVAILABLE',
    'INVALID_OUTPUT', 'REVALIDATION_REFUSED', 'PROVIDER_FAILED',
  ]);
  for (const absent of ['UNKNOWN_AFTER_COMMITMENT', 'PARTIAL', 'RETRYING', 'RECOVERING']) {
    assert.equal((MODEL_ADDUCTION_DOMAIN_OUTCOMES as readonly string[]).includes(absent), false);
  }
});

test('10 · S — le quota reste actif, et aucun second appel n’a lieu', async () => {
  const before = dispatches;
  const h = await harness({ content: output([proposal('ctve_000002')]) });
  try {
    await openInvocationPolicyStore(h.paths).create(0);
    const r = await cli(h, ['adduce-model', h.material, '--controversy', h.opening]);
    assert.equal(r.code, 1, 'quota épuisé : erreur CCR');
    assert.equal(dispatches, before, 'aucun adaptateur approché');
    assert.equal(existsSync(h.paths.invocations), false, 'aucun engagement');
  } finally {
    await h.dispose();
  }

  // Et une demande normale ne dispatche qu'une fois.
  const ok = await harness({ content: output([proposal('ctve_000002')]) });
  try {
    const avant = dispatches;
    const r = await cli(ok, ['adduce-model', ok.material, '--controversy', ok.opening]);
    assert.equal(r.code, 0);
    assert.equal(dispatches, avant + 1, 'AT_MOST(1) — jamais deux');
  } finally {
    await ok.dispose();
  }
});
