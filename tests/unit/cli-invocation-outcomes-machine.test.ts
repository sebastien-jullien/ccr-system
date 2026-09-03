/**
 * Représentation machine des faits dédiés d'issue d'invocation.
 *
 * Question de preuve :
 *
 * > **La sortie machine transporte-t-elle exactement la même autorité que la
 * > sortie humaine — même ensemble, même ordre, même sémantique — sans jamais
 * > introduire un statut, un placeholder, ni un nom de stockage ?**
 *
 * Quatre propriétés.
 *
 *  1. **Un document, et rien d'autre.** `stdout` s'analyse entièrement comme un
 *     seul JSON, sans une ligne de prose humaine.
 *  2. **Absence par omission.** Aucun `null` n'est jamais émis ; une clé absente
 *     dit l'absence, là où `null` inventerait une valeur.
 *  3. **Typage fermé.** Chaque genre ne porte que ses champs applicables, et
 *     `VALID_ZERO` n'en porte aucun.
 *  4. **Aucune fuite de stockage.** Ni `outcomes`, ni `terminal_outcome`, ni
 *     `terminal_negative_outcome`, ni `schema_version`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runCli } from '../../src/cli/main.ts';

const RUN_ID = 'CCR-20260903-901';
const AT = '2026-09-03T10:00:00.000Z';

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: RunServiceDeps;
  dispose(): Promise<void>;
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function harness(): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-machine-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      title: 'machine',
      created_at: AT,
      workspace: { cwd: runsDir },
      experts: {
        author: { provider: 'claude', session_id: 'S1' },
        challenger: { provider: 'codex', session_id: 'S2' },
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
      round: 0,
      active_expert_slot: null,
      next_step_source_slot: 'author',
      last_event_id: 'evt_000001',
      updated_at: AT,
      pending_operation: null,
    }),
    'utf8',
  );

  return {
    runsDir,
    paths,
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

async function writeOutcomes(h: Harness, document: unknown): Promise<void> {
  await writeFile(h.paths.invocationOutcomes, JSON.stringify(document), 'utf8');
}

/**
 * Chemins de toute valeur JSON **nulle** du document.
 *
 * Garde **sémantique**, et non textuelle : le contrat interdit la valeur `null`,
 * pas la sous-chaîne « null ». Une valeur de texte libre légitime peut contenir
 * ce mot, et la refuser prouverait la mauvaise propriété.
 */
function jsonNullPaths(value: unknown, at = '$'): string[] {
  if (value === null) return [at];
  if (Array.isArray(value)) return value.flatMap((entry, index) => jsonNullPaths(entry, `${at}[${index}]`));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      jsonNullPaths(entry, `${at}.${key}`),
    );
  }
  return [];
}

function record(invocationId: string, outcome: unknown, version = 2): unknown {
  return {
    schema_version: version,
    invocation_id: invocationId,
    recorded_at: AT,
    ...(version === 1 ? { terminal_negative_outcome: outcome } : { terminal_outcome: outcome }),
  };
}

/** Trois faits, dans un ordre d'ajout qui n'est pas l'ordre naturel. */
const THREE_RECORDS = {
  schema_version: 2,
  outcomes: [
    record('inv_000003', { kind: 'V5_INVALID_OUTPUT', reason: 'RANKED_OPTIONS', at: 'output.p[0]' }),
    record('inv_000001', { kind: 'VALID_ZERO' }),
    record('inv_000002', { kind: 'V3_PROVIDER_FAILED' }),
  ],
};

// --------------------------------------------------------------------------
// M1 — un seul document, versions, contexte
// --------------------------------------------------------------------------

test('M1 · stdout est exactement un document JSON, avec ses deux versions', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, THREE_RECORDS);
    const result = await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json']);

    assert.equal(result.code, 0);
    const doc = JSON.parse(result.out) as Record<string, unknown>;

    assert.equal(doc['machine_representation_version'], 1);
    assert.equal(doc['semantic_contract_version'], 1);
    assert.equal(doc['run_id'], RUN_ID);
    assert.ok(Array.isArray(doc['facts']));

    // Aucun champ de premier niveau hors du contrat.
    assert.deepEqual(Object.keys(doc).sort(), [
      'facts',
      'machine_representation_version',
      'run_id',
      'semantic_contract_version',
    ]);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M2 — cardinalité et ordre d'ajout persisté
// --------------------------------------------------------------------------

test('M2 · N faits dédiés donnent N faits machine, dans l’ordre persisté', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, THREE_RECORDS);
    const doc = JSON.parse((await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json'])).out);
    const facts = doc.facts as { invocation_id: string }[];

    assert.equal(facts.length, 3);
    assert.deepEqual(
      facts.map((f) => f.invocation_id),
      ['inv_000003', 'inv_000001', 'inv_000002'],
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M3 — filtre : présent appliqué, omis sinon
// --------------------------------------------------------------------------

test('M3 · invocation_filter n’est présent que lorsqu’un filtre est appliqué', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, THREE_RECORDS);

    const filtered = JSON.parse(
      (await cli(h, ['invocation-outcomes', RUN_ID, '--invocation', 'inv_000001', '--format', 'json'])).out,
    );
    assert.equal(filtered.invocation_filter, 'inv_000001');
    assert.equal((filtered.facts as unknown[]).length, 1);
    assert.equal(filtered.facts[0].invocation_id, 'inv_000001');

    const unfiltered = JSON.parse(
      (await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json'])).out,
    );
    assert.ok(
      !('invocation_filter' in unfiltered),
      'sans filtre, la clé est omise — jamais null',
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M4 — projection complète à zéro fait
// --------------------------------------------------------------------------

test('M4 · zéro fait rend un tableau vide, sans statut synthétique, exit 0', async () => {
  const h = await harness();
  try {
    const result = await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json']);

    assert.equal(result.code, 0);
    const doc = JSON.parse(result.out) as Record<string, unknown>;
    assert.deepEqual(doc['facts'], []);

    for (const forbidden of ['status', 'success', 'error', 'count', 'unknown', 'not_committed']) {
      assert.ok(!(forbidden in doc), `champ synthétique interdit : ${forbidden}`);
    }
    // Aucun VALID_ZERO fabriqué pour représenter le vide.
    assert.doesNotMatch(result.out, /VALID_ZERO/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M5 — VALID_ZERO
// --------------------------------------------------------------------------

test('M5 · VALID_ZERO porte son code exact, et aucune charge utile', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, {
      schema_version: 2,
      outcomes: [record('inv_000001', { kind: 'VALID_ZERO' })],
    });
    const doc = JSON.parse((await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json'])).out);
    const outcome = doc.facts[0].outcome as Record<string, unknown>;

    assert.deepEqual(Object.keys(outcome), ['kind']);
    assert.equal(outcome['kind'], 'VALID_ZERO');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M6 — variantes typées : seuls les champs applicables
// --------------------------------------------------------------------------

test('M6 · chaque variante ne porte que ses champs applicables', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, {
      schema_version: 2,
      outcomes: [
        record('inv_000001', { kind: 'V3_INVALID_OUTPUT', reason: 'INVALID_JSON', at: 'output' }),
        record('inv_000002', { kind: 'V4_REVALIDATION_REFUSED', check: 'FRESHNESS', detail: 'obsolète' }),
        record('inv_000003', { kind: 'V5_PROVIDER_FAILED', error_code: 'AGENT_TIMEOUT' }),
        record('inv_000004', { kind: 'V3_PROVIDER_FAILED' }),
      ],
    });
    const doc = JSON.parse((await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json'])).out);
    const [a, b, c, d] = doc.facts as { outcome: Record<string, unknown> }[];

    // La présence est établie avant tout accès : déstructurer un tableau laisse
    // chaque membre `T | undefined`, et le typage ignore la cardinalité que le
    // jeu de faits produit. L'assertion la rend exécutable plutôt que supposée.
    assert.ok(a && b && c && d, 'les quatre faits attendus sont présents');

    assert.deepEqual(Object.keys(a.outcome).sort(), ['at', 'kind', 'reason']);
    assert.deepEqual(Object.keys(b.outcome).sort(), ['check', 'detail', 'kind']);
    assert.deepEqual(Object.keys(c.outcome).sort(), ['error_code', 'kind']);

    // error_code absent : clé omise, jamais null.
    assert.deepEqual(Object.keys(d.outcome), ['kind']);
    assert.equal(d.outcome['kind'], 'V3_PROVIDER_FAILED');

    // Valeurs opaques et texte libre transmis verbatim.
    assert.equal(b.outcome['check'], 'FRESHNESS');
    assert.equal(b.outcome['detail'], 'obsolète');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M7 — native_detail : deux variantes, membres exacts
// --------------------------------------------------------------------------

test('M7 · native_detail rend les membres de sa seule variante', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, {
      schema_version: 2,
      outcomes: [
        record('inv_000001', {
          kind: 'NATIVE_PROCESS_FAILED',
          error_code: 'SESSION_ID_COLLISION',
          native_detail: {
            code: 'SESSION_ID_COLLISION',
            expert_slot: 'author',
            provider: 'claude',
            session_id: 'S-DUP',
          },
        }),
        record('inv_000002', {
          kind: 'NATIVE_PROCESS_FAILED',
          error_code: 'AGENT_SESSION_MISMATCH',
          native_detail: {
            code: 'AGENT_SESSION_MISMATCH',
            expert_slot: 'challenger',
            provider: 'codex',
            expected_session_id: 'S-A',
            found_session_id: 'S-B',
          },
        }),
        record('inv_000003', { kind: 'NATIVE_PROCESS_FAILED' }),
      ],
    });
    const doc = JSON.parse((await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json'])).out);
    const [collision, mismatch, bare] = doc.facts as { outcome: Record<string, unknown> }[];

    assert.ok(collision && mismatch && bare, 'les trois faits attendus sont présents');

    assert.deepEqual(
      Object.keys(collision.outcome['native_detail'] as object).sort(),
      ['code', 'expert_slot', 'provider', 'session_id'],
    );
    assert.deepEqual(
      Object.keys(mismatch.outcome['native_detail'] as object).sort(),
      ['code', 'expected_session_id', 'expert_slot', 'found_session_id', 'provider'],
    );
    // Ni error_code, ni native_detail : les deux clés sont omises.
    assert.deepEqual(Object.keys(bare.outcome), ['kind']);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M8 — versions d'enregistrement source, et recorded_at verbatim
// --------------------------------------------------------------------------

test('M8 · la version source est rendue par fait, et recorded_at est verbatim', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, {
      schema_version: 2,
      outcomes: [
        record('inv_000001', { kind: 'V3_PROVIDER_FAILED' }, 1),
        record('inv_000002', { kind: 'VALID_ZERO' }, 2),
      ],
    });
    const doc = JSON.parse((await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json'])).out);
    const [v1, v2] = doc.facts as { source_record_version: number; recorded_at: string }[];

    assert.ok(v1 && v2, 'les deux faits attendus sont présents');

    assert.equal(v1.source_record_version, 1);
    assert.equal(v2.source_record_version, 2);
    assert.equal(v1.recorded_at, AT);
    assert.equal(v2.recorded_at, AT);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M9 — aucune fuite de stockage, aucune prose humaine, aucun null
// --------------------------------------------------------------------------

test('M9 · ni nom de stockage, ni prose humaine, ni null dans la sortie', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, THREE_RECORDS);
    const result = await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json']);

    for (const leaked of [
      'outcomes',
      'terminal_outcome',
      'terminal_negative_outcome',
      'schema_version',
      'invocation-outcomes.json',
    ]) {
      assert.ok(!result.out.includes(leaked), `fuite de stockage : ${leaked}`);
    }

    for (const prose of [
      /autorité/,
      /référence/,
      /faits dédiés/,
      /cardinalité/,
      /Aucun fait dédié/,
      /enregistrement v/,
      /issue /,
    ]) {
      assert.doesNotMatch(result.out, prose, `prose humaine : ${String(prose)}`);
    }

    // Aucune valeur JSON nulle — établi sur le document analysé, jamais sur
    // une recherche de sous-chaîne.
    assert.deepEqual(jsonNullPaths(JSON.parse(result.out)), []);

    // Et la garde reste correcte quand une valeur de texte libre porte
    // légitimement le mot « null » : la chaîne traverse verbatim, sans
    // qu'aucun membre du document ne soit pour autant de valeur nulle.
    await writeOutcomes(h, {
      schema_version: 2,
      outcomes: [
        record('inv_000001', {
          kind: 'V4_REVALIDATION_REFUSED',
          check: 'NULL_CHECK',
          detail: 'la valeur null a été refusée',
        }),
      ],
    });
    const freeText = await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json']);

    assert.equal(freeText.code, 0);
    const parsed = JSON.parse(freeText.out) as {
      facts: { outcome: Record<string, unknown> }[];
    };
    assert.deepEqual(jsonNullPaths(parsed), [], 'aucune valeur JSON nulle');
    assert.equal(parsed.facts[0]?.outcome['detail'], 'la valeur null a été refusée');
    assert.ok(
      freeText.out.includes('null'),
      'la sous-chaîne survit : c’est bien la valeur, non le texte, qui est interdite',
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M10 — format inconnu
// --------------------------------------------------------------------------

test('M10 · une valeur de --format inconnue refuse en usage, sans document', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, THREE_RECORDS);
    const result = await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'yaml']);

    assert.equal(result.code, 2);
    assert.equal(result.out, '', 'aucun document machine sur stdout');
    assert.match(result.err, /Format inconnu/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M11 — fail-closed : aucun document abouti
// --------------------------------------------------------------------------

test('M11 · une lecture non fiable ne rend aucun document machine', async () => {
  const h = await harness();
  try {
    // Version d'enregistrement non prise en charge, à côté d'un fait lisible.
    await writeOutcomes(h, {
      schema_version: 2,
      outcomes: [
        record('inv_000001', { kind: 'VALID_ZERO' }),
        { schema_version: 99, invocation_id: 'inv_000002', recorded_at: AT, terminal_outcome: { kind: 'VALID_ZERO' } },
      ],
    });
    const unsupported = await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json']);
    assert.notEqual(unsupported.code, 0);
    assert.equal(unsupported.out, '', 'aucun document partiel');

    // Persistance illisible.
    await writeFile(h.paths.invocationOutcomes, '{ pas du JSON', 'utf8');
    const corrupt = await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json']);
    assert.notEqual(corrupt.code, 0);
    assert.equal(corrupt.out, '', 'une corruption ne rend jamais "facts": []');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// M12 — même autorité que le mode humain
// --------------------------------------------------------------------------

test('M12 · le mode machine rend le même ensemble que le mode humain', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, THREE_RECORDS);

    const human = await cli(h, ['invocation-outcomes', RUN_ID]);
    const machine = await cli(h, ['invocation-outcomes', RUN_ID, '--format', 'json']);

    assert.equal(human.code, 0);
    assert.equal(machine.code, 0);

    const ids = (JSON.parse(machine.out).facts as { invocation_id: string }[]).map(
      (f) => f.invocation_id,
    );
    for (const id of ids) assert.match(human.out, new RegExp(id));

    // Même ordre de part et d'autre.
    assert.deepEqual(ids, ['inv_000003', 'inv_000001', 'inv_000002']);
    assert.ok(
      human.out.indexOf('inv_000003') < human.out.indexOf('inv_000001'),
      'les deux représentations partagent l’ordre persisté',
    );
  } finally {
    await h.dispose();
  }
});
