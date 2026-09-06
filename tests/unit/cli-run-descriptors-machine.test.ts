/**
 * Découverte sémantique machine des runs — `ccr run-descriptors --format json`.
 *
 * Question de preuve :
 *
 * > **Le document associe-t-il exactement chaque run découvrable à son titre
 * > canonique — sans jamais rendre un descripteur incomplet, ni laisser passer
 * > un fait hors contrat ?**
 *
 * Quatre propriétés.
 *
 *  1. **Jeu de champs fermé.** Deux champs de premier niveau plus `runs` ;
 *     `run_id` et `title` par descripteur, et rien d'autre.
 *  2. **Complet, ou rien.** Un titre non établissable empêche tout document.
 *  3. **Aucune unicité promise.** Deux titres identiques restent deux
 *     descripteurs distincts.
 *  4. **Discipline machine.** Un seul document JSON sur stdout en sortie 0 ;
 *     rien sur stdout en 1 et en 2.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RunServiceDeps } from '../../src/services/run-service.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runCli } from '../../src/cli/main.ts';
import {
  SEMANTIC_RUN_DISCOVERY_CONTRACT_VERSION,
  SEMANTIC_RUN_DISCOVERY_MACHINE_REPRESENTATION_VERSION,
} from '../../src/cli/run-descriptor-machine.ts';

const AT = '2026-09-05T10:00:00.000Z';

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  dispose(): Promise<void>;
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function harness(): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-descriptors-'));
  return {
    runsDir,
    deps: { runsDir, now: () => new Date(AT) } as RunServiceDeps,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

async function cli(h: Harness, argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await runCli([...argv, '--runs-dir', h.runsDir], { io, deps: h.deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function nativeRun(h: Harness, runId: string, title: string): Promise<void> {
  const root = path.join(h.runsDir, runId);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schema_version: 2,
      run_id: runId,
      title,
      created_at: AT,
      workspace: { cwd: h.runsDir },
      experts: {
        author: { provider: 'claude', session_id: 'S1' },
        challenger: { provider: 'codex', session_id: 'S2' },
      },
    }),
    'utf8',
  );
  await writeFile(
    path.join(root, 'state.json'),
    JSON.stringify({
      schema_version: 3,
      run_id: runId,
      state: 'READY',
      control: 'AUTOMATION',
      round: 0,
      active_expert_slot: null,
      next_step_source_slot: 'author',
      last_event_id: 'evt_000001',
      pending_operation: null,
      uncertainty: null,
      updated_at: AT,
    }),
    'utf8',
  );
}

/** Run historique : sa génération diffère, son titre reste établissable. */
async function legacyRun(h: Harness, runId: string, title: string): Promise<void> {
  const root = path.join(h.runsDir, runId);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      run_id: runId,
      title,
      created_at: AT,
      workspace: { cwd: h.runsDir },
      agents: {
        claude: { session_id: 'S1', role: 'author' },
        codex: { session_id: 'S2', role: 'challenger' },
      },
    }),
    'utf8',
  );
}

// --------------------------------------------------------------------------
// D1 · D2 · D3 — document, champs de premier niveau, champs de descripteur
// --------------------------------------------------------------------------

test('D1-D3 · le document parse, et ne porte que les champs du contrat', async () => {
  const h = await harness();
  try {
    await nativeRun(h, 'CCR-20260905-001', 'Un titre canonique');
    const result = await cli(h, ['run-descriptors', '--format', 'json']);

    assert.equal(result.code, 0);
    const doc = JSON.parse(result.out) as Record<string, unknown>;

    assert.deepEqual(Object.keys(doc).sort(), [
      'runs',
      'semantic_run_discovery_contract_version',
      'semantic_run_discovery_machine_representation_version',
    ]);
    assert.equal(doc['semantic_run_discovery_contract_version'], 1);
    assert.equal(doc['semantic_run_discovery_machine_representation_version'], 1);
    assert.equal(
      doc['semantic_run_discovery_contract_version'],
      SEMANTIC_RUN_DISCOVERY_CONTRACT_VERSION,
    );
    assert.equal(
      doc['semantic_run_discovery_machine_representation_version'],
      SEMANTIC_RUN_DISCOVERY_MACHINE_REPRESENTATION_VERSION,
    );

    const runs = doc['runs'] as Record<string, unknown>[];
    assert.equal(runs.length, 1);
    assert.deepEqual(Object.keys(runs[0] ?? {}).sort(), ['run_id', 'title']);
    assert.equal(runs[0]?.['run_id'], 'CCR-20260905-001');
    assert.equal(runs[0]?.['title'], 'Un titre canonique');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D4 — projection complète : chaque run découvrable, une fois, avec son titre
// --------------------------------------------------------------------------

test('D4 · projection complète, bi-génération, sans omission ni doublon', async () => {
  const h = await harness();
  try {
    await nativeRun(h, 'CCR-20260905-001', 'Natif');
    await nativeRun(h, 'CCR-20260905-002', 'Natif encore');
    await legacyRun(h, 'CCR-20260903-007', 'Historique');

    const doc = JSON.parse((await cli(h, ['run-descriptors', '--format', 'json'])).out);
    const runs = doc.runs as { run_id: string; title: string }[];

    assert.equal(runs.length, 3);
    assert.deepEqual(
      runs.map((r) => `${r.run_id}=${r.title}`).sort(),
      ['CCR-20260903-007=Historique', 'CCR-20260905-001=Natif', 'CCR-20260905-002=Natif encore'],
    );
    assert.equal(new Set(runs.map((r) => r.run_id)).size, 3);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D5 — zéro run découvrable
// --------------------------------------------------------------------------

test('D5 · zéro run rend un document complet avec runs vide', async () => {
  const h = await harness();
  try {
    const result = await cli(h, ['run-descriptors', '--format', 'json']);
    assert.equal(result.code, 0);

    const doc = JSON.parse(result.out);
    assert.deepEqual(doc.runs, []);
    assert.equal(doc.semantic_run_discovery_contract_version, 1);

    // Répertoire absent : même zéro abouti, même document.
    const absent = path.join(h.runsDir, 'inexistant', 'runs');
    const out: string[] = [];
    const io: CliIo = { out: (l) => out.push(l), err: () => undefined };
    const code = await runCli(['run-descriptors', '--format', 'json', '--runs-dir', absent], {
      io,
      deps: { runsDir: absent, now: () => new Date(AT) } as RunServiceDeps,
    });
    assert.equal(code, 0);
    assert.equal(out.join('\n'), result.out);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D6 — l'unicité des titres n'est pas garantie
// --------------------------------------------------------------------------

test('D6 · deux titres identiques restent deux descripteurs distincts', async () => {
  const h = await harness();
  try {
    await nativeRun(h, 'CCR-20260905-001', 'Même titre');
    await nativeRun(h, 'CCR-20260905-002', 'Même titre');
    await nativeRun(h, 'CCR-20260905-003', 'Même titre');

    const doc = JSON.parse((await cli(h, ['run-descriptors', '--format', 'json'])).out);
    const runs = doc.runs as { run_id: string; title: string }[];

    assert.equal(runs.length, 3, 'aucune déduplication par titre');
    assert.deepEqual(new Set(runs.map((r) => r.title)), new Set(['Même titre']));
    assert.equal(new Set(runs.map((r) => r.run_id)).size, 3, 'les identités restent distinctes');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D7 — `run_id` opaque : rendu verbatim, jamais décomposé
// --------------------------------------------------------------------------

test('D7 · run_id est rendu verbatim, et rien n’en est dérivé', async () => {
  const h = await harness();
  try {
    await nativeRun(h, 'CCR-20260905-042', 'Titre');
    const result = await cli(h, ['run-descriptors', '--format', 'json']);
    const runs = JSON.parse(result.out).runs as Record<string, unknown>[];

    assert.equal(runs[0]?.['run_id'], 'CCR-20260905-042');
    // Aucune partie du `run_id` n'est promue en champ.
    for (const derived of ['date', 'date_part', 'ordinal', 'day', 'index', 'position', 'rank']) {
      assert.ok(!(derived in (runs[0] ?? {})), `champ dérivé exposé : ${derived}`);
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D8 — aucune sémantique d'ordre
// --------------------------------------------------------------------------

test('D8 · l’ordre du tableau ne porte aucune sémantique, et rien ne le nomme', async () => {
  const h = await harness();
  try {
    // Créés dans un ordre qui n'est pas l'ordre lexicographique des identités.
    await nativeRun(h, 'CCR-20260905-003', 'Troisième créé');
    await nativeRun(h, 'CCR-20260905-001', 'Premier créé');
    await nativeRun(h, 'CCR-20260905-002', 'Deuxième créé');

    const first = await cli(h, ['run-descriptors', '--format', 'json']);
    const second = await cli(h, ['run-descriptors', '--format', 'json']);

    // Le document est déterministe : deux lectures identiques.
    assert.equal(first.out, second.out);

    const runs = JSON.parse(first.out).runs as { run_id: string; title: string }[];
    // Le consommateur apparie par `run_id`, jamais par position : le contenu
    // est complet quel que soit l'ordre.
    const byId = new Map(runs.map((r) => [r.run_id, r.title]));
    assert.equal(byId.get('CCR-20260905-001'), 'Premier créé');
    assert.equal(byId.get('CCR-20260905-002'), 'Deuxième créé');
    assert.equal(byId.get('CCR-20260905-003'), 'Troisième créé');

    // Et aucun champ n'énonce un ordre.
    for (const entry of runs) {
      assert.deepEqual(Object.keys(entry).sort(), ['run_id', 'title']);
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D9 — PREUVE CONTRACTUELLE : échec plutôt que succès partiel
// --------------------------------------------------------------------------

test('D9 · un titre non établissable empêche TOUT document, et sort en 1', async () => {
  const h = await harness();
  try {
    await nativeRun(h, 'CCR-20260905-001', 'Un titre parfaitement lisible');

    // Manifest corrompu : le titre de ce run n'est pas établissable.
    const corrupt = path.join(h.runsDir, 'CCR-20260905-002');
    await mkdir(corrupt, { recursive: true });
    await writeFile(path.join(corrupt, 'manifest.json'), '{ pas du JSON', 'utf8');

    const result = await cli(h, ['run-descriptors', '--format', 'json']);

    assert.equal(result.code, 1);
    assert.equal(result.out, '', 'aucun document sur stdout');
    assert.ok(!result.out.includes('"runs"'), 'aucun document partiel');
    assert.ok(
      !result.out.includes('Un titre parfaitement lisible'),
      'le run lisible ne traverse pas seul : le document est complet, ou inexistant',
    );
  } finally {
    await h.dispose();
  }
});

test('D9b · un run sans manifest empêche également tout document', async () => {
  const h = await harness();
  try {
    await nativeRun(h, 'CCR-20260905-001', 'Lisible');
    await mkdir(path.join(h.runsDir, 'CCR-20260905-002'), { recursive: true });

    const result = await cli(h, ['run-descriptors', '--format', 'json']);
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D10 — discipline stdout / stderr
// --------------------------------------------------------------------------

test('D10 · sortie 0 : un seul document JSON sur stdout, sans prose', async () => {
  const h = await harness();
  try {
    await nativeRun(h, 'CCR-20260905-001', 'Titre');
    const result = await cli(h, ['run-descriptors', '--format', 'json']);

    assert.equal(result.code, 0);
    // Tout stdout parse comme un unique document.
    const doc = JSON.parse(result.out);
    assert.ok(Array.isArray(doc.runs));
    assert.equal(result.out.trim(), JSON.stringify(doc, null, 2));
  } finally {
    await h.dispose();
  }
});

test('D11 · sortie 2 : format inconnu, et format absent, sans document', async () => {
  const h = await harness();
  try {
    await nativeRun(h, 'CCR-20260905-001', 'Titre');

    const unknown = await cli(h, ['run-descriptors', '--format', 'yaml']);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.out, '');
    assert.match(unknown.err, /Format inconnu/);

    const missing = await cli(h, ['run-descriptors']);
    assert.equal(missing.code, 2);
    assert.equal(missing.out, '');
    assert.match(missing.err, /--format/);
  } finally {
    await h.dispose();
  }
});

test('D12 · sortie 1 : une énumération qui échoue ne rend aucun document', async () => {
  const h = await harness();
  try {
    // Un fichier là où un répertoire est attendu : ce n'est pas l'absence.
    const notADirectory = path.join(h.runsDir, 'un-fichier');
    await writeFile(notADirectory, 'contenu', 'utf8');

    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
    const code = await runCli(
      ['run-descriptors', '--format', 'json', '--runs-dir', notADirectory],
      { io, deps: { runsDir: notADirectory, now: () => new Date(AT) } as RunServiceDeps },
    );

    assert.notEqual(code, 0);
    assert.equal(out.join('\n'), '');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D13 — aucun fait hors contrat, ni comme clé ni comme valeur
// --------------------------------------------------------------------------

test('D13 · aucun champ hors contrat ne traverse', async () => {
  const h = await harness();
  try {
    await nativeRun(h, 'CCR-20260905-001', 'Titre');
    await legacyRun(h, 'CCR-20260903-007', 'Historique');
    const result = await cli(h, ['run-descriptors', '--format', 'json']);

    for (const forbidden of [
      'state',
      'READY',
      'control',
      'AUTOMATION',
      'created_at',
      'updated_at',
      AT,
      'workspace',
      'cwd',
      h.runsDir,
      'generation',
      'execution_mode',
      'NATIVE_V21_EXECUTION',
      'LEGACY_V2_EXECUTION',
      'provider',
      'claude',
      'codex',
      'session',
      'S1',
      'S2',
      'activity',
      'metadata',
      'round',
      'schema_version',
      'count',
    ]) {
      assert.ok(!result.out.includes(forbidden), `fait hors contrat exposé : ${forbidden}`);
    }
  } finally {
    await h.dispose();
  }
});
