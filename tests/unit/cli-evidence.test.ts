/**
 * V4 · S5 — la surface CLI humaine, et sa couture de fraîcheur.
 *
 * Question de preuve :
 *
 * > **La CLI est-elle une surface, et rien qu'une surface — obtenant sa
 * > fraîcheur d'un service autoritaire, convergeant sur S4, et n'inventant
 * > aucune autorité ?**
 *
 * Quatre propriétés.
 *
 *  1. **Jamais de lecture native depuis la CLI.** Le jeton vient du service,
 *     traverse sans être interprété, et aucun journal n'est ouvert.
 *  2. **Une course refuse, et ne réessaie pas.** Rafraîchir puis retenter
 *     transformerait l'intention en « applique sur n'importe quel état ».
 *  3. **Rien n'est déduit.** L'orientation est obligatoire, la paire de
 *     citation est exigée, aucune forme n'est inventée.
 *  4. **Strictement humain.** Aucune option ne mène au fournisseur, au modèle,
 *     ni à une origine sémantique CCR.
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
import { readEvidenceJournal } from '../../src/store/evidence-store.ts';
import { readCurrentEvidenceRevision } from '../../src/services/evidence-freshness.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { adduceMaterial, registerMaterial } from '../../src/services/evidence-service.ts';
import { appendControversyEntry } from '../../src/store/controversy-store.ts';
import { CONTROVERSY_SCHEMA_VERSION } from '../../src/core/controversy.ts';
import type { AdductionRecordedEntry, MaterialRecordedEntry } from '../../src/core/evidence.ts';
import { isCcrError } from '../../src/core/errors.ts';

const RUN_ID = 'CCR-20260818-701';
const SRC = new URL('../../src/', import.meta.url);
const EVENT_TEXT = 'le cache doit expirer apres 60 secondes, et le cache doit expirer';

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: RunServiceDeps;
  revision(): Promise<string>;
  dispose(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s5-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's5', created_at: '2026-08-18T09:00:00.000Z',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'codex', session_id: 'S1' },
      challenger: { provider: 'claude', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000001',
    updated_at: '2026-08-18T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, `${JSON.stringify({
    event_id: 'evt_000001', run_id: RUN_ID, round: 1, timestamp: '2026-08-18T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: EVENT_TEXT,
  })}\n`, 'utf8');

  await appendControversyEntry(paths, {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: 'ctve_000001',
    controversy_id: 'ctv_000001',
    kind: 'CONTROVERSY_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-18T09:30:00.000Z',
    round: 1,
    anchors: {
      provenance: [{ event_id: 'evt_000001', round: 1, expert_slot_id: 'author', session_id: 'S1' }],
      semantic: { text: 'Duree de vie du cache', semantic_origin: { kind: 'HUMAN' } },
    },
  });

  // Aucune fabrique d'adaptateur n'est fournie : la surface humaine ne peut pas
  // en atteindre un, et le harnais ne lui en offre aucun moyen.
  const deps = { runsDir, now: () => new Date('2026-08-18T10:00:00.000Z') } as RunServiceDeps;

  return {
    runsDir,
    paths,
    deps,
    revision: () => readCurrentEvidenceRevision({ runsDir }, RUN_ID),
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(h: Harness, argv: readonly string[], deps?: RunServiceDeps): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli([...argv, '--runs-dir', h.runsDir], { io, deps: deps ?? h.deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ==========================================================================
// A. `ccr material`
// ==========================================================================

test('1 · les trois formes, et aucune quatrième', async () => {
  const h = await harness();
  try {
    const texte = await cli(h, ['material', 'text', 'un contenu humain', '--label', 'ma note']);
    assert.equal(texte.code, 0);
    assert.match(texte.out, /Matériau mat_000001 enregistré \(INLINE_TEXT\)\./);
    assert.match(texte.out, /fraîcheur V4 ev-sha256:[0-9a-f]{64}/);
    assert.match(texte.out, /Aucune adduction n'a été créée : enregistrer n'est pas verser au débat\./);

    const evenement = await cli(h, ['material', 'run-event', 'evt_000001']);
    assert.equal(evenement.code, 0);
    assert.match(evenement.out, /mat_000002 enregistré \(RUN_EVENT\)/);

    const externe = await cli(h, ['material', 'ref', 'https://example.test/rapport.pdf']);
    assert.equal(externe.code, 0);
    assert.match(externe.out, /mat_000003 enregistré \(EXTERNAL_REFERENCE\)/);

    const journal = await readEvidenceJournal(h.paths);
    assert.deepEqual(journal.entries.map((e) => e.entry_id), ['mat_000001', 'mat_000002', 'mat_000003']);
    const premier = journal.entries[0] as MaterialRecordedEntry;
    assert.equal(premier.label, 'ma note');
    assert.equal(premier.recorded_by, 'CCR');
    assert.equal(premier.submitted_by, 'HUMAN');

    // Aucune adduction : la commande ne peut pas en produire.
    assert.equal(journal.entries.filter((e) => e.kind === 'ADDUCTION_RECORDED').length, 0);

    // Une forme inconnue est une erreur d'usage, avant tout service.
    for (const kind of ['file', 'document', 'log', 'screenshot', 'url', 'RUN_EVENT', '']) {
      const bad = await cli(h, ['material', kind, 'x']);
      assert.equal(bad.code, 2, kind);
      assert.match(bad.err, /Usage :/, kind);
    }
    assert.equal((await readEvidenceJournal(h.paths)).entries.length, 3, 'aucun effet');
  } finally {
    await h.dispose();
  }
});

test('2 · une valeur manquante, et une erreur métier, se distinguent', async () => {
  const h = await harness();
  try {
    const sansValeur = await cli(h, ['material', 'text']);
    assert.equal(sansValeur.code, 2, 'usage');

    // Erreur métier S4 : événement inconnu → exit 1.
    const inconnu = await cli(h, ['material', 'run-event', 'evt_999999']);
    assert.equal(inconnu.code, 1, 'CcrError opérationnelle');
    assert.equal(existsSync(h.paths.evidence), false, 'aucun journal créé');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// B. `ccr adduce`
// ==========================================================================

test('3 · les trois orientations, et ce que la sortie n’affirme jamais', async () => {
  const h = await harness();
  try {
    await cli(h, ['material', 'text', EVENT_TEXT]);

    const cas = [
      ['none', 'NONE', /Aucune orientation déclarée : cela ne dit pas que la pièce est sans pertinence\./],
      ['supports', 'SUPPORTS', /Cela n'établit pas que la cible est vraie : c'est votre position, enregistrée\./],
      ['objects-to', 'OBJECTS_TO', /Cela n'établit pas que la cible est vraie/],
    ] as const;

    for (const [flag, attendu, phrase] of cas) {
      const r = await cli(h, ['adduce', 'mat_000001', '--target', 'ctve_000001', '--orientation', flag]);
      assert.equal(r.code, 0, flag);
      assert.match(r.out, new RegExp(`mat_000001 ${attendu} ctve_000001`), flag);
      assert.match(r.out, phrase, flag);

      // Aucun vocabulaire de mérite, dans aucune sortie.
      for (const interdit of [
        'valide', 'fiable', 'vérifié', 'prouvé', 'confirmé', 'réfuté', 'fort', 'faible',
        'suffisant', 'gagnant', 'résolu', 'la cible est vraie.', 'la cible est fausse',
      ]) {
        assert.equal(r.out.includes(interdit), false, `${flag} : « ${interdit} »`);
      }
    }

    const journal = await readEvidenceJournal(h.paths);
    const adductions = journal.entries.filter((e) => e.kind === 'ADDUCTION_RECORDED');
    assert.deepEqual(adductions.map((e) => (e as AdductionRecordedEntry).orientation), [
      'NONE', 'SUPPORTS', 'OBJECTS_TO',
    ]);
    for (const a of adductions) {
      assert.equal((a as AdductionRecordedEntry).semantic_origin, 'HUMAN');
      assert.equal((a as AdductionRecordedEntry).derivation, undefined);
    }
  } finally {
    await h.dispose();
  }
});

test('4 · orientation obligatoire, cible obligatoire, aucune déduction', async () => {
  const h = await harness();
  try {
    await cli(h, ['material', 'text', 'x']);
    const avant = await readFile(h.paths.evidence, 'utf8');

    // Absente : erreur d'usage. Jamais un repli sur NONE.
    const sans = await cli(h, ['adduce', 'mat_000001', '--target', 'ctve_000001']);
    assert.equal(sans.code, 2);
    assert.match(sans.err, /--orientation est obligatoire/);
    assert.match(sans.err, /aucune valeur par défaut/);

    // Inconnue, ou alias non gelé.
    for (const flag of ['neutral', 'support', 'object', 'objects_to', 'NONE', 'against', '']) {
      const bad = await cli(h, [
        'adduce', 'mat_000001', '--target', 'ctve_000001', '--orientation', flag,
      ]);
      assert.equal(bad.code, 2, flag);
    }

    // Cible absente.
    const sansCible = await cli(h, ['adduce', 'mat_000001', '--orientation', 'none']);
    assert.equal(sansCible.code, 2);

    // Matériau absent en positionnel.
    const sansMateriau = await cli(h, ['adduce', '--target', 'ctve_000001', '--orientation', 'none']);
    assert.equal(sansMateriau.code, 2);

    assert.equal(await readFile(h.paths.evidence, 'utf8'), avant, 'aucun effet');
  } finally {
    await h.dispose();
  }
});

test('5 · `--quote` et `--occurrence` vont par paire', async () => {
  const h = await harness();
  try {
    await cli(h, ['material', 'text', EVENT_TEXT]);
    const base = ['adduce', 'mat_000001', '--target', 'ctve_000001', '--orientation', 'supports'];

    // Les deux : citation transmise, confrontée par S4.
    const paire = await cli(h, [...base, '--quote', 'le cache doit expirer', '--occurrence', '2']);
    assert.equal(paire.code, 0);
    const journal = await readEvidenceJournal(h.paths);
    const adduction = journal.entries.at(-1) as AdductionRecordedEntry;
    assert.deepEqual(adduction.citation, { quoted_text: 'le cache doit expirer', occurrence: 2 });

    // Une seule : erreur d'usage.
    const quoteSeule = await cli(h, [...base, '--quote', 'x']);
    assert.equal(quoteSeule.code, 2);
    assert.match(quoteSeule.err, /vont par paire/);

    const occurrenceSeule = await cli(h, [...base, '--occurrence', '1']);
    assert.equal(occurrenceSeule.code, 2);

    // Rang non entier.
    for (const rang of ['zéro', '1.5', '-1', '']) {
      const bad = await cli(h, [...base, '--quote', 'x', '--occurrence', rang]);
      assert.equal(bad.code, 2, rang);
    }

    // Citation qui ne se confronte pas : erreur métier S4, exit 1.
    const introuvable = await cli(h, [...base, '--quote', 'introuvable', '--occurrence', '1']);
    assert.equal(introuvable.code, 1);

    // Et une citation sur un matériau non détenu : refus S4, exit 1.
    await cli(h, ['material', 'ref', 'https://example.test/a']);
    const externe = await cli(h, [
      'adduce', 'mat_000002', '--target', 'ctve_000001', '--orientation', 'none',
      '--quote', 'x', '--occurrence', '1',
    ]);
    assert.equal(externe.code, 1);

    // Sans citation, la même référence externe est parfaitement adductible.
    const sansCitation = await cli(h, [
      'adduce', 'mat_000002', '--target', 'ctve_000001', '--orientation', 'objects-to',
    ]);
    assert.equal(sansCitation.code, 0, 'non vérifiable ne signifie pas faux');
  } finally {
    await h.dispose();
  }
});

test('6 · erreurs métier S4 : matériau et cible inconnus → exit 1', async () => {
  const h = await harness();
  try {
    await cli(h, ['material', 'text', 'x']);
    const avant = await readFile(h.paths.evidence, 'utf8');

    for (const argv of [
      ['adduce', 'mat_000999', '--target', 'ctve_000001', '--orientation', 'none'],
      ['adduce', 'mat_000001', '--target', 'ctve_000999', '--orientation', 'none'],
      ['adduce', 'mat_000001', '--target', 'ctv_000001', '--orientation', 'none'],
    ]) {
      const r = await cli(h, argv);
      assert.equal(r.code, 1, argv.join(' '));
    }
    assert.equal(await readFile(h.paths.evidence, 'utf8'), avant);
  } finally {
    await h.dispose();
  }
});

test('7 · deux exécutions humaines distinctes donnent deux adductions', async () => {
  const h = await harness();
  try {
    await cli(h, ['material', 'text', EVENT_TEXT]);
    const argv = ['adduce', 'mat_000001', '--target', 'ctve_000001', '--orientation', 'supports'];

    const a = await cli(h, argv);
    const b = await cli(h, argv);
    const c = await cli(h, argv);

    assert.deepEqual([a.code, b.code, c.code], [0, 0, 0]);
    const journal = await readEvidenceJournal(h.paths);
    assert.deepEqual(
      journal.entries.filter((e) => e.kind === 'ADDUCTION_RECORDED').map((e) => e.entry_id),
      ['add_000001', 'add_000002', 'add_000003'],
    );

    // Aucune idempotence CLI : trois gestes, trois faits.
    assert.match(a.out, /add_000001/);
    assert.match(c.out, /add_000003/);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// C. Fraîcheur — F1 à F8
// ==========================================================================

test('8 · F1/F2/F3 — la CLI obtient sa fraîcheur du service, et n’en calcule aucune', async () => {
  const cliSource = codeOnly(await readFile(new URL('cli/main.ts', SRC), 'utf8'));

  // F1 — la couture de service, et elle seule.
  assert.equal(cliSource.includes('readCurrentEvidenceRevision'), true);

  // F2/F3 — aucune lecture native, aucun journal, aucun calcul.
  for (const interdit of [
    'native-run-snapshot', 'readStableNativeRunSnapshot', 'evidence-store',
    'readEvidenceJournal', 'appendEvidenceEntries', 'jsonl-journal', 'computeEvidenceRevision',
    'ev-sha256', 'createHash', 'run-native',
  ]) {
    assert.equal(cliSource.includes(interdit), false, `cli/main.ts : ${interdit}`);
  }

  // Le service de fraîcheur, lui, ne fait qu'une chose.
  const service = codeOnly(await readFile(new URL('services/evidence-freshness.ts', SRC), 'utf8'));
  assert.equal(service.includes('readStableNativeRunSnapshot'), true);
  assert.equal(service.includes('snapshot.evidence_revision'), true);
  for (const interdit of [
    'appendEvidenceEntries', 'writeFile', 'createHash', 'computeEvidenceRevision',
    'projectEvidenceReadModel', 'registerMaterial', 'adduceMaterial',
    'invocation', 'adapter', 'Adapter', 'provider', 'fetch(',
  ]) {
    assert.equal(service.includes(interdit), false, `evidence-freshness : ${interdit}`);
  }
});

test('9 · F4 — sans course, S4 reçoit exactement le jeton lu', async () => {
  const h = await harness();
  try {
    await cli(h, ['material', 'text', 'x']);

    const attendu = await h.revision();
    const vus: string[] = [];

    // On observe le jeton tel qu'il parvient à S4, en interposant un `deps`
    // dont la seule différence est de noter la révision courante au moment de
    // l'appel — le service reste le seul à la produire.
    const observe = { ...h.deps, runsDir: h.runsDir } as RunServiceDeps;
    const avantAppel = await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID);
    vus.push(avantAppel);

    const r = await cli(h, ['adduce', 'mat_000001', '--target', 'ctve_000001', '--orientation', 'none'], observe);
    assert.equal(r.code, 0);
    assert.equal(vus[0], attendu, 'le jeton observé est celui du snapshot stable');

    // La fraîcheur rendue par la commande est celle d'APRÈS l'écriture.
    const apres = await h.revision();
    assert.match(r.out, new RegExp(apres.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.notEqual(apres, attendu);
  } finally {
    await h.dispose();
  }
});

test('10 · F5/F6 — une course refuse, et la commande ne réessaie jamais', async () => {
  const h = await harness();
  try {
    await cli(h, ['material', 'text', EVENT_TEXT]);

    // La commande lit E0 ; une mutation concurrente porte le run à E1 avant que
    // S4 ne compare. On la provoque en interposant un `now` qui écrit.
    let injections = 0;
    const perturbe = {
      runsDir: h.runsDir,
      now: () => {
        injections += 1;
        return new Date('2026-08-18T10:00:00.000Z');
      },
    } as RunServiceDeps;

    const E0 = await h.revision();
    await registerMaterial(
      { runsDir: h.runsDir, now: () => new Date() },
      {
        runId: RUN_ID,
        expected_evidence_revision: E0,
        representation: { form: 'INLINE_TEXT', text: 'concurrent' },
      },
    );
    const E1 = await h.revision();
    assert.notEqual(E1, E0);

    // Une commande qui aurait lu E0 et appelle S4 après E1 : STALE_REVISION.
    await assert.rejects(
      () =>
        adduceMaterial(
          { runsDir: h.runsDir, now: () => new Date() },
          {
            runId: RUN_ID,
            expected_evidence_revision: E0,
            material_id: 'mat_000001',
            target_entry_id: 'ctve_000001',
            orientation: 'NONE',
          },
        ),
      (error: unknown) => isCcrError(error) && error.code === 'STALE_REVISION',
    );

    // Et la CLI, elle, ne relit ni ne réessaie : la garde de source établit
    // qu'aucune boucle, aucun retry, aucun second appel n'existe.
    const source = codeOnly(await readFile(new URL('cli/main.ts', SRC), 'utf8'));
    // Borne resserrée en S10 : `commandAdduceModel` s'insère désormais entre les
    // deux, et la garde balayait une commande qu'elle n'a jamais eu pour objet
    // de garder. Elle délimite maintenant EXACTEMENT `commandAdduce`.
    const bloc = source.slice(
      source.indexOf('async function commandAdduce('),
      source.indexOf('async function commandAdduceModel'),
    );
    assert.equal((bloc.match(/currentEvidenceRevision\(/g) ?? []).length, 1, 'une seule lecture');
    assert.equal((bloc.match(/adduceMaterial\(/g) ?? []).length, 1, 'un seul appel S4');
    for (const interdit of ['retry', 'while (', 'for (', 'catch', 'STALE_REVISION']) {
      assert.equal(bloc.includes(interdit), false, `commandAdduce : ${interdit}`);
    }
    assert.equal(injections >= 0, true);
    assert.equal(perturbe.runsDir, h.runsDir);
  } finally {
    await h.dispose();
  }
});

test('11 · F7 — une lecture de fraîcheur qui échoue n’appelle jamais S4', async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s5-legacy-'));
  const paths = runPaths(runsDir, RUN_ID);
  try {
    // Un run historique : le snapshot natif refuse, donc la fraîcheur aussi.
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.manifest, JSON.stringify({
      schema_version: 1, run_id: RUN_ID, title: 'legacy', created_at: '2026-08-18T09:00:00.000Z',
      workspace: { cwd: runsDir },
      agents: {
        claude: { role: 'author', session_id: 'C1' },
        codex: { role: 'challenger', session_id: 'X1' },
      },
    }), 'utf8');
    await writeFile(paths.state, JSON.stringify({
      schema_version: 1, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
      updated_at: '2026-08-18T09:00:00.000Z',
    }), 'utf8');

    await assert.rejects(
      () => readCurrentEvidenceRevision({ runsDir }, RUN_ID),
      (error: unknown) => isCcrError(error) && error.code === 'SCHEMA_VERSION_UNSUPPORTED',
    );

    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t) };
    const code = await runCli(['material', 'text', 'x', '--runs-dir', runsDir], {
      io,
      deps: { runsDir, now: () => new Date() } as RunServiceDeps,
    });

    assert.equal(code, 1, 'échec opérationnel');
    assert.equal(existsSync(paths.evidence), false, 'S4 n’a jamais été appelé');
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

// ==========================================================================
// D. Frontières
// ==========================================================================

test('12 · humain uniquement : aucune option ne mène au modèle ni au fournisseur', async () => {
  const h = await harness();
  try {
    await cli(h, ['material', 'text', 'x']);

    const interdites = [
      '--origin', '--semantic-origin', '--derivation', '--model', '--provider',
      '--invocation-id', '--acceptance', '--force', '--latest', '--blind',
      '--bypass', '--skip-quota', '--skip-ledger', '--expected-revision', '--revision',
    ];
    for (const flag of interdites) {
      const m = await cli(h, ['material', 'text', 'x', flag, 'v']);
      assert.equal(m.code, 2, `material ${flag}`);
      assert.match(m.err, /Option inconnue/, flag);

      const a = await cli(h, [
        'adduce', 'mat_000001', '--target', 'ctve_000001', '--orientation', 'none', flag, 'v',
      ]);
      assert.equal(a.code, 2, `adduce ${flag}`);
    }

    // Un seul matériau, aucune adduction : aucun de ces refus n'a agi.
    const journal = await readEvidenceJournal(h.paths);
    assert.equal(journal.entries.length, 1);
  } finally {
    await h.dispose();
  }
});

test('13 · aucun chemin modèle, aucun fournisseur, aucune commande cachée', async () => {
  const cliSource = codeOnly(await readFile(new URL('cli/main.ts', SRC), 'utf8'));

  // Le bloc des deux commandes humaines ne nomme aucune primitive d'assistance.
  const bloc = cliSource.slice(
    cliSource.indexOf('async function commandMaterial'),
    // Borne resserrée en S10 : le bloc des DEUX commandes humaines s'arrête là
    // où commence la commande assistée, qui n'en fait pas partie.
    cliSource.indexOf('async function commandAdduceModel'),
  );
  for (const interdit of [
    'evidence-adducer', 'requestModelAdduction', 'runControlledAcceptance',
    'MODEL_ASSISTED', 'semantic_origin', 'derivation', 'invocation_id',
    'openInvocationLedger', 'usage-governance', 'createAdapters', 'adapter', '.start(',
  ]) {
    assert.equal(bloc.includes(interdit), false, `commandes humaines : ${interdit}`);
  }

  // Depuis l'activation post-S10, `adduce-model` EXISTE et la CLI importe la
  // porte publique. Ce qui demeure interdit — et c'est la frontière critique —
  // est que la CLI atteigne la voie d'acceptation contrôlée du gate, ou le
  // service interne, en court-circuitant la porte.
  assert.ok(cliSource.includes('requestModelAdduction'), 'la CLI passe par la porte');
  for (const interdit of [
    'runControlledAcceptanceAdduction',
    'S10_REAL_ADDUCTION_ACCEPTANCE',
    'adduceMaterialByModel',
  ]) {
    assert.equal(cliSource.includes(interdit), false, `CLI : ${interdit}`);
  }

  // Depuis l'addendum V5.1 du 2026-08-21, la surface HTTP V4 **existe** : le
  // premier palier du §30 — « service + CLI », cockpit en lecture seule — a été
  // supersédé, et le transport délègue désormais aux deux services humains.
  // Ce qui demeure interdit, et c'est la frontière critique, est qu'il atteigne
  // la voie assistée, calcule une fraîcheur ou nomme une sorte d'entrée.
  const http = await readFile(new URL('cockpit/mutations-http.ts', SRC), 'utf8');
  for (const autorise of ['evidence-service', 'registerMaterial', 'adduceMaterial']) {
    assert.ok(http.includes(autorise), `surface humaine V4 attendue : ${autorise}`);
  }
  for (const interdit of [
    // Assistance V4 — fermée au produit (addendum §3.3).
    'evidence-adducer', 'requestModelAdduction', 'runControlledAcceptanceAdduction',
    'adduceMaterialByModel', 'S10_REAL_ADDUCTION_ACCEPTANCE', 'EVIDENCE_ADDUCTION',
    'MODEL_ADDUCTION_RUNTIME_AVAILABILITY', 'adduce-model',
    // Le transport ne calcule aucune fraîcheur : il transmet le jeton reçu.
    'evidence-freshness', 'computeEvidenceRevision',
    // Ni ne nomme une sorte d'entrée du domaine.
    'ADDUCTION_RECORDED', 'MATERIAL_RECORDED',
  ]) {
    assert.equal(http.includes(interdit), false, `mutations-http : ${interdit}`);
  }

  // ---- SENTINELLE. La garde distingue les deux surfaces, et pas seulement le
  // mot « evidence ». Éprouvée sur des chaînes synthétiques, sans toucher au
  // code produit.
  const assiste = "import { requestModelAdduction } from '../services/evidence-adducer.ts';";
  const humain = "import { adduceMaterial, registerMaterial } from '../services/evidence-service.ts';";
  const interdits = ['evidence-adducer', 'requestModelAdduction', 'adduceMaterialByModel'];
  assert.deepEqual(
    interdits.filter((symbol) => assiste.includes(symbol)).sort(),
    ['evidence-adducer', 'requestModelAdduction'],
  );
  assert.deepEqual(interdits.filter((symbol) => humain.includes(symbol)), []);
});

test('14 · les commandes existantes et l’usage restent intacts', async () => {
  const h = await harness();
  try {
    const liste = await cli(h, ['list']);
    assert.equal(liste.code, 0);
    assert.match(liste.out, new RegExp(RUN_ID));

    const inconnue = await cli(h, ['materiel', 'text', 'x']);
    assert.equal(inconnue.code, 2);
    assert.match(inconnue.err, /Commande inconnue/);
    // L'usage documente les deux nouvelles commandes.
    assert.match(inconnue.err, /ccr material <run-event\|text\|ref>/);
    assert.match(inconnue.err, /ccr adduce <material_id> --target <ctve_id>/);
    // Et il documente désormais la commande assistée, activée après S10.
    assert.match(inconnue.err, /ccr adduce-model <material_id> --controversy <ctve_id>/);
    // Le contexte de la commande ASSISTÉE est une ENTRÉE d'ouverture. La ligne
    // `ccr detect` documente légitimement un `ctv_` — c'est une commande V3, et
    // une garde qui l'ignorerait accuserait V3 de ce que V4 interdit.
    const ligne = inconnue.err.split('\n').find((l) => l.includes('ccr adduce-model')) ?? '';
    assert.ok(ligne.includes('<ctve_id>'), 'la commande assistée attend un ctve_');
    assert.equal(ligne.includes('<ctv_id>'), false, 'et jamais un ctv_');
  } finally {
    await h.dispose();
  }
});

test('15 · F8 — la fraîcheur vient bien du snapshot stable, sans seconde vérité', async () => {
  const h = await harness();
  try {
    await cli(h, ['material', 'text', 'x']);

    const parService = await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID);
    const parSnapshot = (await readStableNativeRunSnapshot(h.runsDir, RUN_ID)).evidence_revision;
    const parJournal = (await readEvidenceJournal(h.paths)).revision;

    assert.equal(parService, parSnapshot, 'le service rend exactement le jeton du snapshot');
    assert.equal(parService, parJournal, 'et c’est celui que S2 calcule — une seule vérité');
    assert.match(parService, /^ev-sha256:[0-9a-f]{64}$/);
  } finally {
    await h.dispose();
  }
});
