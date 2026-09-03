/**
 * Inventaire machine des runs découvrables — `ccr list --format json`.
 *
 * Question de preuve :
 *
 * > **L'inventaire représente-t-il exactement les identités que l'autorité
 * > d'énumération reconnaît — sans ouvrir un seul document de run, et sans
 * > jamais laisser passer un état, un titre ou un diagnostic ?**
 *
 * Quatre propriétés.
 *
 *  1. **Identité seule.** Une entrée porte `run_id`, et rien d'autre.
 *  2. **Aucune lecture par run.** Un run dont le manifest et le state sont
 *     absents ou corrompus reste représenté : sa lisibilité n'est pas une
 *     condition d'inclusion.
 *  3. **Zéro n'est pas un échec.** Répertoire vide et répertoire absent rendent
 *     le même document, avec un code de sortie `0`.
 *  4. **Le chemin humain est intact.** `ccr list` sans `--format` ne change pas.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RunServiceDeps } from '../../src/services/run-service.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runCli } from '../../src/cli/main.ts';
import { RUN_INVENTORY_CONTRACT_VERSION } from '../../src/cli/run-inventory-machine.ts';

const AT = '2026-09-04T10:00:00.000Z';

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
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-inventory-'));
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

/** Crée un répertoire de run sain, avec ses deux documents. */
async function healthyRun(h: Harness, runId: string): Promise<void> {
  const root = path.join(h.runsDir, runId);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schema_version: 2,
      run_id: runId,
      title: `titre de ${runId}`,
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
      updated_at: AT,
      pending_operation: null,
    }),
    'utf8',
  );
}

// --------------------------------------------------------------------------
// M1 · M2 · M3 — document, champs de premier niveau, champs d'entrée
// --------------------------------------------------------------------------

test('M1-M3 · le document parse, et ne porte que les champs du contrat', async () => {
  const h = await harness();
  try {
    await healthyRun(h, 'CCR-20260904-001');
    const result = await cli(h, ['list', '--format', 'json']);

    assert.equal(result.code, 0);
    const doc = JSON.parse(result.out) as Record<string, unknown>;

    assert.deepEqual(Object.keys(doc).sort(), ['run_inventory_contract_version', 'runs']);
    assert.equal(doc['run_inventory_contract_version'], RUN_INVENTORY_CONTRACT_VERSION);
    assert.equal(doc['run_inventory_contract_version'], 1);

    const runs = doc['runs'] as Record<string, unknown>[];
    assert.equal(runs.length, 1);
    assert.deepEqual(Object.keys(runs[0] ?? {}), ['run_id']);
    assert.equal(runs[0]?.['run_id'], 'CCR-20260904-001');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M4 — bijection : chaque identité une fois, aucune omission, aucun doublon
// --------------------------------------------------------------------------

test('M4 · plusieurs identités, représentées une et une seule fois', async () => {
  const h = await harness();
  try {
    const ids = ['CCR-20260904-001', 'CCR-20260904-002', 'CCR-20260903-007'];
    for (const id of ids) await healthyRun(h, id);

    const doc = JSON.parse((await cli(h, ['list', '--format', 'json'])).out);
    const represented = (doc.runs as { run_id: string }[]).map((r) => r.run_id);

    assert.equal(represented.length, ids.length, 'aucune omission, aucun doublon');
    assert.deepEqual([...represented].sort(), [...ids].sort());
    assert.equal(new Set(represented).size, represented.length, 'aucun run_id en double');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M5 — les entrées qui ne sont pas des runs ne sont pas représentées
// --------------------------------------------------------------------------

test('M5 · une entrée du système de fichiers qui n’est pas un run est ignorée', async () => {
  const h = await harness();
  try {
    await healthyRun(h, 'CCR-20260904-001');
    await mkdir(path.join(h.runsDir, 'cockpit'), { recursive: true });
    await mkdir(path.join(h.runsDir, 'pas-un-run'), { recursive: true });
    await writeFile(path.join(h.runsDir, 'CCR-20260904-999'), 'un fichier, pas un répertoire', 'utf8');

    const doc = JSON.parse((await cli(h, ['list', '--format', 'json'])).out);
    const represented = (doc.runs as { run_id: string }[]).map((r) => r.run_id);

    assert.deepEqual(represented, ['CCR-20260904-001']);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M6 — PREUVE ARCHITECTURALE : aucune lecture par run
//
// Une identité découvrable dont les documents sont absents ou corrompus reste
// représentée. C'est ce qui distingue l'inventaire d'une projection du modèle
// de lecture composite.
// --------------------------------------------------------------------------

test('M6 · une identité dont les documents sont illisibles reste représentée', async () => {
  const h = await harness();
  try {
    await healthyRun(h, 'CCR-20260904-001');

    // Répertoire de run sans aucun document.
    await mkdir(path.join(h.runsDir, 'CCR-20260904-002'), { recursive: true });

    // Répertoire de run aux documents corrompus.
    const corrupt = path.join(h.runsDir, 'CCR-20260904-003');
    await mkdir(corrupt, { recursive: true });
    await writeFile(path.join(corrupt, 'manifest.json'), '{ pas du JSON', 'utf8');
    await writeFile(path.join(corrupt, 'state.json'), '{ pas du JSON non plus', 'utf8');

    const result = await cli(h, ['list', '--format', 'json']);
    assert.equal(result.code, 0);

    const doc = JSON.parse(result.out);
    const represented = (doc.runs as { run_id: string }[]).map((r) => r.run_id);
    assert.deepEqual(
      [...represented].sort(),
      ['CCR-20260904-001', 'CCR-20260904-002', 'CCR-20260904-003'],
      'la lisibilité des documents n’est pas une condition d’inclusion',
    );

    // Et aucune issue de lecture ne traverse.
    for (const forbidden of ['ILLISIBLE', 'illisible', 'error', 'SCHEMA_VERSION', 'STATE_INVALID']) {
      assert.ok(!result.out.includes(forbidden), `diagnostic exposé : ${forbidden}`);
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M7 · M8 — zéro, et absence du répertoire : même résultat public
// --------------------------------------------------------------------------

test('M7-M8 · répertoire vide et répertoire absent rendent le même zéro', async () => {
  const h = await harness();
  try {
    const empty = await cli(h, ['list', '--format', 'json']);
    assert.equal(empty.code, 0);
    const emptyDoc = JSON.parse(empty.out);
    assert.deepEqual(emptyDoc.runs, []);
    assert.equal(emptyDoc.run_inventory_contract_version, 1);

    // Répertoire absent : l'autorité d'énumération y voit un zéro abouti.
    const absent = path.join(h.runsDir, 'inexistant', 'runs');
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
    const code = await runCli(['list', '--format', 'json', '--runs-dir', absent], {
      io,
      deps: { runsDir: absent, now: () => new Date(AT) } as RunServiceDeps,
    });

    assert.equal(code, 0);
    assert.equal(out.join('\n'), empty.out, 'le même document public, sans distinction physique');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M9 — un échec d'énumération autre que l'absence ne devient jamais un zéro
// --------------------------------------------------------------------------

test('M9 · une énumération qui échoue refuse, et ne rend aucun document', async () => {
  const h = await harness();
  try {
    // Un fichier là où un répertoire est attendu : `readdir` échoue en ENOTDIR,
    // qui n'est pas l'absence et ne se requalifie donc pas en zéro.
    const notADirectory = path.join(h.runsDir, 'un-fichier');
    await writeFile(notADirectory, 'contenu', 'utf8');

    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
    const code = await runCli(['list', '--format', 'json', '--runs-dir', notADirectory], {
      io,
      deps: { runsDir: notADirectory, now: () => new Date(AT) } as RunServiceDeps,
    });

    assert.notEqual(code, 0);
    assert.equal(out.join('\n'), '', 'aucun document d’inventaire abouti sur stdout');
    assert.ok(!out.join('\n').includes('"runs"'), 'un échec ne devient jamais { "runs": [] }');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M10 — format non supporté
// --------------------------------------------------------------------------

test('M10 · une valeur de --format inconnue refuse en usage, sans document', async () => {
  const h = await harness();
  try {
    await healthyRun(h, 'CCR-20260904-001');
    const result = await cli(h, ['list', '--format', 'yaml']);

    assert.equal(result.code, 2);
    assert.equal(result.out, '', 'aucun document machine sur stdout');
    assert.match(result.err, /Format inconnu/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M11 · M14 — un seul document, aucun fait d'inventaire interdit
// --------------------------------------------------------------------------

test('M11-M14 · un seul document, sans état, titre, horodatage ni compte', async () => {
  const h = await harness();
  try {
    await healthyRun(h, 'CCR-20260904-001');
    await healthyRun(h, 'CCR-20260904-002');
    const result = await cli(h, ['list', '--format', 'json']);

    // Tout stdout est un unique document JSON.
    const doc = JSON.parse(result.out);
    assert.ok(Array.isArray(doc.runs));

    // Aucun fait d'inventaire interdit, ni comme clé ni comme valeur.
    for (const forbidden of [
      'READY',
      'status',
      'state',
      'success',
      'failure',
      'health',
      'title',
      'titre de',
      'generation',
      'natif',
      'historique',
      'created_at',
      'updated_at',
      AT,
      'workspace',
      'control',
      'round',
      'active',
      'count',
      'runs_dir',
      h.runsDir,
    ]) {
      assert.ok(!result.out.includes(forbidden), `fait d'inventaire interdit : ${forbidden}`);
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M12 — le chemin humain reste intact
// --------------------------------------------------------------------------

test('M12 · `ccr list` sans --format conserve sa sortie humaine', async () => {
  const h = await harness();
  try {
    await healthyRun(h, 'CCR-20260904-001');
    const human = await cli(h, ['list']);

    assert.equal(human.code, 0);
    // La présentation humaine porte bien état, génération et titre.
    assert.match(human.out, /CCR-20260904-001/);
    assert.match(human.out, /READY/);
    assert.match(human.out, /natif/);
    assert.match(human.out, /titre de CCR-20260904-001/);
    // Et elle n'est pas du JSON.
    assert.throws(() => JSON.parse(human.out));
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M13 — le contexte d'énumération change, sans être sérialisé
// --------------------------------------------------------------------------

test('M13 · --runs-dir change le contexte sans jamais apparaître dans le document', async () => {
  const first = await harness();
  const second = await harness();
  try {
    await healthyRun(first, 'CCR-20260904-001');
    await healthyRun(second, 'CCR-20260904-777');

    const a = JSON.parse((await cli(first, ['list', '--format', 'json'])).out);
    const b = JSON.parse((await cli(second, ['list', '--format', 'json'])).out);

    assert.deepEqual((a.runs as { run_id: string }[]).map((r) => r.run_id), ['CCR-20260904-001']);
    assert.deepEqual((b.runs as { run_id: string }[]).map((r) => r.run_id), ['CCR-20260904-777']);

    // Aucun des deux documents ne dit d'où il vient.
    for (const doc of [a, b]) {
      assert.deepEqual(Object.keys(doc).sort(), ['run_inventory_contract_version', 'runs']);
    }
  } finally {
    await first.dispose();
    await second.dispose();
  }
});
