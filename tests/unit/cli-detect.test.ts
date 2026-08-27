/**
 * V3 post-S10 — activation de la surface humaine : `ccr detect`.
 *
 * Question de preuve :
 *
 * > **La CLI peut-elle demander une détection sans devenir une seconde
 * > autorité, et sans jamais atteindre la voie d'acceptation contrôlée ?**
 *
 * Quatre propriétés.
 *
 *  1. **Une seule porte.** La CLI appelle `requestModelDetection`, jamais le
 *     service gouverné en direct, jamais l'acceptation contrôlée.
 *  2. **Aucun contournement.** Le moteur n'est pas un argument, le quota est
 *     traversé, l'engagement précède l'appel.
 *  3. **Des issues honnêtes.** Valide-zéro est un succès qui ne conclut rien ;
 *     une sortie inexploitable est un échec ; les deux restent distinctes.
 *  4. **Geste humain.** Aucun tour natif, aucune lecture ne la déclenche.
 *
 * Aucun fournisseur réel : l'adaptateur passe par la couture d'injection que la
 * fabrique de dépendances CLI expose déjà.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { readControversyJournal } from '../../src/store/controversy-store.ts';
import { createCliDeps } from '../../src/cli/deps.ts';
import { runCli } from '../../src/cli/main.ts';
import { MODEL_DETECTION_RUNTIME_AVAILABILITY } from '../../src/services/controversy-detector.ts';
import { recordAssertion, recordControversy } from '../../src/services/controversy-service.ts';

const RUN_ID = 'CCR-20260818-777';
const SRC = new URL('../../src/', import.meta.url);

/**
 * Ce que l'adaptateur doublé rendra au prochain appel.
 *
 * Mutable à dessein : une sortie de détection réaliste cite des identifiants
 * d'entrées que seul le journal produit, donc après la construction du harnais.
 */
interface Program {
  content?: string;
  fail?: Error;
}

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: RunServiceDeps;
  readonly program: Program;
  calls(): number;
  dispose(): Promise<void>;
}

function fakeAdapter(kind: 'claude' | 'codex', program: Program, calls: string[]): AgentAdapter {
  return {
    kind,
    async start(prompt: string): Promise<AgentTurnResult> {
      calls.push(prompt);
      if (program.fail !== undefined) throw program.fail;
      const content = program.content ?? '';
      return {
        agent: kind,
        sessionId: `detect-${kind}-1`,
        content,
        exitCode: 0,
        startedAt: '2026-08-18T10:00:00.000Z',
        completedAt: '2026-08-18T10:00:01.000Z',
        stdoutRaw: content,
        stderrRaw: '',
      };
    },
    resume(): Promise<AgentTurnResult> {
      throw new Error('sans objet');
    },
    openInteractive(): never {
      throw new Error('sans objet');
    },
  };
}

const EVENTS: readonly Record<string, unknown>[] = [
  {
    event_id: 'evt_000001', run_id: RUN_ID, round: 1, timestamp: '2026-08-18T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: 'Le cache doit expirer apres 60 secondes.',
  },
  {
    event_id: 'evt_000002', run_id: RUN_ID, round: 1, timestamp: '2026-08-18T09:20:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'challenger', session_id: 'S2',
    content: 'Le cache ne doit jamais expirer par duree.',
  },
];

async function harness(): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-cli-detect-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  // `author` est lié à **codex** ici, à dessein : la commande nomme un expert,
  // et c'est le manifest — jamais la ligne de commande — qui choisit le moteur.
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 'detect', created_at: '2026-08-18T09:00:00.000Z',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'codex', session_id: 'S1' },
      challenger: { provider: 'claude', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000002',
    updated_at: '2026-08-18T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, EVENTS.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  const program: Program = {};
  const calls: string[] = [];
  const deps = createCliDeps(runsDir, {
    createAdapters: () => ({
      claude: fakeAdapter('claude', program, calls),
      codex: fakeAdapter('codex', program, calls),
    }),
  });

  return {
    runsDir,
    paths,
    deps,
    program,
    calls: () => calls.length,
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
  const io: CliIo = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const code = await runCli([...argv, '--runs-dir', h.runsDir], { io, deps: h.deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Les faits humains S4 dont la détection partira. Aucun fournisseur. */
async function seed(h: Harness): Promise<{ controversyId: string; a: string; b: string }> {
  const service = { runsDir: h.runsDir, now: () => new Date() };
  const revision = async (): Promise<string> => (await readControversyJournal(h.paths)).revision;

  const opened = await recordControversy(service, {
    runId: RUN_ID,
    expected_controversy_revision: await revision(),
    provenance_event_ids: ['evt_000001'],
    statement: 'Expiration du cache par duree',
  });
  const a = await recordAssertion(service, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: opened.controversy_revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Le cache doit expirer apres 60 secondes.',
  });
  const b = await recordAssertion(service, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: a.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Le cache ne doit jamais expirer par duree.',
  });

  return { controversyId: opened.controversy_id, a: a.entry.entry_id, b: b.entry.entry_id };
}

function detectorOutput(proposals: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ detector_output_version: 1, proposals });
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Ce qui trahirait une **surface de détection assistée V3** — les symboles
 * réellement exportés par `services/controversy-detector.ts`, plus le chemin du
 * module et le jeton de sa voie d'acceptation contrôlée.
 *
 * Aucune chaîne générique ici. `detect`, `Detect` et `DETECTION` appartiennent
 * aussi aux détections structurelles `D01`–`D08` de V5, qui sont contractées et
 * rendues dans le cockpit : les interdire reviendrait à interdire un mot, pas
 * une capacité.
 */
const V3_DETECTION_FORBIDDEN_SYMBOLS: readonly string[] = [
  'requestModelDetection',
  'detectControversyRelations',
  'runControlledAcceptanceDetection',
  'recordDetectedRelations',
  'parseDetectorOutput',
  'buildDetectionPrompt',
  'MODEL_DETECTION_RUNTIME_AVAILABILITY',
  'MODEL_DETECTION_IMPLEMENTED',
  'CONTROVERSY_DETECTOR_OUTPUT_VERSION',
  'S10_REAL_DETECTION_ACCEPTANCE',
  'controversy-detector',
];

// ==========================================================================
// A. Contrat de commande
// ==========================================================================

test('1 · T1/T13/T14 — la commande existe, l inconnue et les autres sont intactes', async () => {
  const h = await harness();
  try {
    const seeded = await seed(h);
    h.program.content = detectorOutput([]);

    const known = await cli(h, ['detect', 'author', '--controversy', seeded.controversyId]);
    assert.equal(known.code, 0);

    // Une commande inconnue conserve son comportement historique.
    const unknown = await cli(h, ['detecte', 'author']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /Commande inconnue/);
    assert.match(unknown.err, /ccr detect <author\|challenger>/, 'et l usage documente la nouvelle');

    // Une commande existante reste inchangée.
    const list = await cli(h, ['list']);
    assert.equal(list.code, 0);
    assert.match(list.out, new RegExp(RUN_ID));
  } finally {
    await h.dispose();
  }
});

test('2 · T3/T4/T12 — expert fermé, identifiant requis, aucune option de contournement', async () => {
  const h = await harness();
  try {
    const seeded = await seed(h);
    h.program.content = detectorOutput([]);

    for (const argv of [
      ['detect'],
      ['detect', 'claude', '--controversy', seeded.controversyId],
      ['detect', 'codex', '--controversy', seeded.controversyId],
      ['detect', 'auteur', '--controversy', seeded.controversyId],
      ['detect', 'AUTHOR', '--controversy', seeded.controversyId],
      ['detect', 'author'],
      ['detect', 'author', '--controversy', ''],
    ]) {
      const result = await cli(h, argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.err, /Usage :/, argv.join(' '));
    }

    // Aucune option de contournement n'existe : le parseur les refuse toutes.
    for (const flag of [
      '--provider', '--model', '--engine', '--confidence', '--force', '--acceptance',
      '--real', '--skip-quota', '--skip-ledger', '--bypass', '--invocation-id', '--yes',
    ]) {
      const result = await cli(h, ['detect', 'author', '--controversy', seeded.controversyId, flag, 'x']);
      assert.equal(result.code, 2, flag);
      assert.match(result.err, /Option inconnue/, flag);
    }

    assert.equal(h.calls(), 0, 'aucun adaptateur approché par un refus d usage');
    assert.equal(existsSync(h.paths.invocations), false, 'aucun engagement');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// B. Issues
// ==========================================================================

test('3 · T5 — valide-zéro : succès honnête, aucune conclusion d accord', async () => {
  const h = await harness();
  try {
    const seeded = await seed(h);
    h.program.content = detectorOutput([]);
    const before = await readFile(h.paths.controversies, 'utf8');

    const result = await cli(h, ['detect', 'author', '--controversy', seeded.controversyId]);

    assert.equal(result.code, 0, 'une sortie valide sans proposition est un succès');
    assert.match(result.out, /aucune relation proposée/);
    assert.match(result.out, /ne dit pas que les experts sont d'accord/);
    assert.equal(h.calls(), 1);
    assert.equal(await readFile(h.paths.controversies, 'utf8'), before, 'aucune relation écrite');
    assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1, 'invocation durable');

    // Ce que la CLI ne conclut jamais. Formes affirmatives seulement : la
    // négation honnête ci-dessus contient légitimement « d'accord ».
    for (const forbidden of ['convergence', 'CONVERGED', 'résolu', 'tranché', 'Détection confirmée']) {
      assert.equal(result.out.includes(forbidden), false, forbidden);
    }
  } finally {
    await h.dispose();
  }
});

test('4 · T6 — proposition valide : la chaîne gouvernée, de bout en bout', async () => {
  const h = await harness();
  try {
    const seeded = await seed(h);
    h.program.content = detectorOutput([
      {
        controversy_id: seeded.controversyId,
        from_entry_id: seeded.b,
        to_entry_id: seeded.a,
        act: 'CONTESTS',
      },
    ]);

    const result = await cli(h, ['detect', 'author', '--controversy', seeded.controversyId]);

    assert.equal(result.code, 0);
    assert.match(result.out, /1 relation\(s\) inférée\(s\) par CCR/);
    assert.match(result.out, new RegExp(`${seeded.b} CONTESTS ${seeded.a}`));
    assert.match(result.out, /n'est ni une vérité, ni une clôture/);
    assert.equal(h.calls(), 1, 'un seul appel moteur');

    // La gouvernance a été traversée : ledger V2.2, déclencheur V3.
    const records = await (await openInvocationLedger(h.paths, RUN_ID)).readAll();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.schema_version, 2);
    assert.equal(records[0]?.trigger_kind, 'CONTROVERSY_DETECTION');
    assert.match(result.out, new RegExp(records[0]?.invocation_id ?? 'absent'));

    // Et l'identité vient du manifest : `author` est lié à codex sur ce run.
    assert.deepEqual(records[0]?.identity, {
      generation: 'NATIVE_V21_EXECUTION',
      expert_slot: 'author',
      provider: 'codex',
    });

    // La relation persistée porte l'attribution contractuelle S7-B.
    const written = (await readControversyJournal(h.paths)).entries.at(-1);
    assert.equal(written?.kind, 'RELATION_RECORDED');
    assert.equal(written?.semantic_origin.kind, 'CCR');
    assert.equal(written?.recorded_by, 'CCR');
    assert.equal(written?.derivation?.method, 'MODEL_ASSISTED');
    assert.equal(written?.derivation?.invocation_id, records[0]?.invocation_id);
  } finally {
    await h.dispose();
  }
});

test('5 · T8/T9 — sortie inexploitable et panne du moteur : deux échecs distincts', async () => {
  const invalid = await harness();
  try {
    const seeded = await seed(invalid);
    invalid.program.content = '{ pas du json';
    const before = await readFile(invalid.paths.controversies, 'utf8');

    const result = await cli(invalid, ['detect', 'author', '--controversy', seeded.controversyId]);

    assert.equal(result.code, 1, 'une réponse reçue mais inexploitable n est pas un succès');
    assert.match(result.err, /inexploitable/);
    assert.match(result.err, /invocation reste enregistrée/);
    assert.match(result.err, /aucune reprise/);
    assert.equal(invalid.calls(), 1, 'aucun second appel');
    assert.equal(await readFile(invalid.paths.controversies, 'utf8'), before);
    assert.equal((await openInvocationLedger(invalid.paths, RUN_ID)).count(), 1);
  } finally {
    await invalid.dispose();
  }

  const broken = await harness();
  try {
    const seeded = await seed(broken);
    broken.program.fail = new Error('moteur indisponible');

    const result = await cli(broken, ['detect', 'author', '--controversy', seeded.controversyId]);

    assert.equal(result.code, 1);
    assert.match(result.err, /n'a pas rendu de sortie/);
    assert.equal(result.err.includes('inexploitable'), false, 'distinct d une sortie invalide');
    assert.equal(broken.calls(), 1);
    assert.equal((await openInvocationLedger(broken.paths, RUN_ID)).count(), 1);
  } finally {
    await broken.dispose();
  }
});

test('6 · T7 — un quota épuisé arrête avant le moteur', async () => {
  const h = await harness();
  try {
    const seeded = await seed(h);
    h.program.content = detectorOutput([]);
    await openInvocationPolicyStore(h.paths).create(0);

    const result = await cli(h, ['detect', 'author', '--controversy', seeded.controversyId]);

    assert.equal(result.code, 1);
    assert.equal(h.calls(), 0, 'aucun adaptateur approché');
    assert.equal(existsSync(h.paths.invocations), false, 'aucun engagement');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// C. Gardes de surface
// ==========================================================================

test('7 · T10/T11/T15/T16 — une seule porte, aucune surface parallèle', async () => {
  assert.equal(MODEL_DETECTION_RUNTIME_AVAILABILITY, 'AVAILABLE');

  const cliSource = codeOnly(await readFile(new URL('cli/main.ts', SRC), 'utf8'));

  // La CLI emprunte la porte publique, et rien d'autre.
  assert.equal(cliSource.includes('requestModelDetection('), true);
  for (const forbidden of [
    'runControlledAcceptanceDetection',
    'S10_REAL_DETECTION_ACCEPTANCE',
    'CALL_1_ONLY',
    'detectControversyRelations',
    'recordDetectedRelations',
    'appendControversyEntry',
    'parseDetectorOutput',
    'openInvocationLedger',
    'assertInvocationQuotaAvailable',
    '.start(',
  ]) {
    assert.equal(cliSource.includes(forbidden), false, `cli/main.ts : ${forbidden}`);
  }

  // Aucune surface HTTP ni cockpit n'a été créée. La garde porte sur les
  // SYMBOLES de la détection V3, non sur le mot « detect ».
  //
  // Elle disait autrefois « le mot lui-même est absent ». Cette formulation a
  // cessé d'être une preuve le jour où V5.1 a rendu ses détections
  // structurelles `D01`–`D08` dans le cockpit : deux concepts distincts
  // partagent une racine lexicale, et le mot ne discrimine plus rien.
  //
  // ```text
  // SURFACE DE DÉTECTION ASSISTÉE V3   ≠   DÉTECTIONS STRUCTURELLES V5
  // ```
  for (const relative of [
    'cockpit/mutations-http.ts',
    'cockpit/server.ts',
    'cockpit/native-read-http.ts',
    'cockpit/web/render.js',
  ]) {
    const code = await readFile(new URL(relative, SRC), 'utf8');
    for (const forbidden of V3_DETECTION_FORBIDDEN_SYMBOLS) {
      assert.equal(code.includes(forbidden), false, `${relative} : ${forbidden}`);
    }
  }

  // Aucun moteur natif ne déclenche la détection : le geste reste humain.
  for (const relative of [
    'services/native-start-service.ts',
    'services/native-step-service.ts',
    'services/native-send-service.ts',
    'services/native-handoff-service.ts',
    'services/native-recovery-service.ts',
  ]) {
    const code = await readFile(new URL(relative, SRC), 'utf8');
    for (const forbidden of ['requestModelDetection', 'controversy-detector', 'detectControversyRelations']) {
      assert.equal(code.includes(forbidden), false, `${relative} : ${forbidden}`);
    }
  }

  // ---- SENTINELLE. Une garde plus précise doit rester une garde : elle doit
  // encore attraper une vraie référence V3, et laisser passer le vocabulaire V5.
  // Éprouvée sur des chaînes synthétiques, sans toucher au code produit.
  const referenceV3 = "import { requestModelDetection } from '../services/controversy-detector.ts';";
  assert.deepEqual(
    V3_DETECTION_FORBIDDEN_SYMBOLS.filter((symbol) => referenceV3.includes(symbol)).sort(),
    ['controversy-detector', 'requestModelDetection'],
    'la garde attraperait encore une surface V3 réelle',
  );

  const vocabulaireV5 = 'label.reconciliationDetection(detection.category) — Formes observées, '
    + 'section.appendChild(el("ul", { class: "reconciliation-detections" }))';
  assert.deepEqual(
    V3_DETECTION_FORBIDDEN_SYMBOLS.filter((symbol) => vocabulaireV5.includes(symbol)),
    [],
    'le vocabulaire V5 n’est pas une surface V3',
  );
});
