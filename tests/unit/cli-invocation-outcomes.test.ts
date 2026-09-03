/**
 * D4 — la projection CLI en lecture seule des faits dédiés d'issue
 * d'invocation.
 *
 * Question de preuve :
 *
 * > **La commande rend-elle exactement les faits persistés — leur ordre, leur
 * > version source, leurs vocabulaires — sans jamais interroger une autre
 * > autorité ni convertir une cardinalité nulle en verdict ?**
 *
 * Quatre propriétés.
 *
 *  1. **Centrée sur le fait.** Elle énumère les enregistrements qui existent,
 *     jamais les invocations qui pourraient en porter un. Aucun registre
 *     d'engagement n'est ouvert.
 *  2. **Zéro n'est pas un verdict.** Une requête valide sans correspondance
 *     réussit, et le dit en termes de cardinalité — ni succès, ni échec, ni
 *     invocation inconnue, ni fichier absent.
 *  3. **Normalisation d'enveloppe seulement.** `v1` et `v2` convergent sur un
 *     champ public unique, mais le genre, la charge utile et la version source
 *     traversent intacts.
 *  4. **La corruption ne devient jamais une absence.** Une version non prise en
 *     charge et un document illisible refusent, sans rendre le sous-ensemble
 *     qui aurait bien voulu s'analyser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import {
  NATIVE_FAILURE_DETAIL_CODES,
  TERMINAL_NEGATIVE_OUTCOME_KINDS,
  V3_DETECTION_REASONS,
  V4_ADDUCTION_REASONS,
  V5_PROPOSAL_REASONS,
  V5_REVALIDATION_CHECKS,
} from '../../src/core/invocation-outcome.ts';
import { INVOCATION_OUTCOME_CONTRACT_REFERENCE } from '../../src/cli/invocation-outcome-format.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { runCli } from '../../src/cli/main.ts';

const RUN_ID = 'CCR-20260901-901';
const AT = '2026-09-01T10:00:00.000Z';

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
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-d4-cli-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      title: 'd4',
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

/** Deux faits courants, dans un ordre d'ajout qui n'est pas l'ordre naturel. */
const TWO_V2_RECORDS = {
  schema_version: 2,
  outcomes: [
    {
      schema_version: 2,
      invocation_id: 'inv_000003',
      recorded_at: '2026-09-01T10:03:00.000Z',
      terminal_outcome: { kind: 'V5_INVALID_OUTPUT', reason: 'RANKED_OPTIONS', at: AT },
    },
    {
      schema_version: 2,
      invocation_id: 'inv_000001',
      recorded_at: '2026-09-01T10:01:00.000Z',
      terminal_outcome: { kind: 'NATIVE_PROCESS_FAILED', error_code: 'AGENT_TIMEOUT' },
    },
  ],
};

// --------------------------------------------------------------------------
// T1 — tous les enregistrements, dans l'ordre persisté
// --------------------------------------------------------------------------

test('T1 · rend tous les faits, dans l’ordre d’ajout persisté', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, TWO_V2_RECORDS);
    const result = await cli(h, ['invocation-outcomes', RUN_ID]);

    assert.equal(result.code, 0);
    assert.match(result.out, /inv_000003/);
    assert.match(result.out, /inv_000001/);

    // L'ordre est celui du document, pas un tri par identifiant.
    assert.ok(
      result.out.indexOf('inv_000003') < result.out.indexOf('inv_000001'),
      'l’ordre d’ajout persisté doit être préservé',
    );

    // Genres exacts, des deux familles.
    assert.match(result.out, /V5_INVALID_OUTPUT/);
    assert.match(result.out, /RANKED_OPTIONS/);
    assert.match(result.out, /NATIVE_PROCESS_FAILED/);
    assert.match(result.out, /AGENT_TIMEOUT/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T2 — le filtre restreint au seul enregistrement visé
// --------------------------------------------------------------------------

test('T2 · --invocation ne rend que l’enregistrement correspondant', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, TWO_V2_RECORDS);
    const result = await cli(h, ['invocation-outcomes', RUN_ID, '--invocation', 'inv_000001']);

    assert.equal(result.code, 0);
    assert.match(result.out, /inv_000001/);
    assert.match(result.out, /NATIVE_PROCESS_FAILED/);
    assert.doesNotMatch(result.out, /inv_000003/);
    assert.doesNotMatch(result.out, /V5_INVALID_OUTPUT/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T3 — filtre canonique sans correspondance : cardinalité, pas verdict
// --------------------------------------------------------------------------

test('T3 · un identifiant canonique sans fait rend zéro, et réussit', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, TWO_V2_RECORDS);
    const result = await cli(h, ['invocation-outcomes', RUN_ID, '--invocation', 'inv_000009']);

    assert.equal(result.code, 0);
    assert.match(result.out, /Aucun fait dédié d'issue d'invocation enregistré pour cette requête\./);

    // Aucun mot d'état, aucune inférence d'existence, aucun langage de fichier.
    for (const forbidden of [
      /NOT_COMMITTED/,
      /\bUNKNOWN\b/,
      /\bSUCCESS\b/,
      /\bFAILURE\b/,
      /VALID_ZERO/,
      /succès/i,
      /échec/i,
      /registre/i,
      /fichier/i,
      /absent/i,
      /vide/i,
    ]) {
      assert.doesNotMatch(result.out, forbidden, `sortie interdite : ${String(forbidden)}`);
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T4 — persistance rendant zéro fait
// --------------------------------------------------------------------------

test('T4 · une persistance sans fait rend le même énoncé de cardinalité', async () => {
  const h = await harness();
  try {
    // Aucun document écrit : la sémantique de persistance vaut collection vide.
    const absent = await cli(h, ['invocation-outcomes', RUN_ID]);
    assert.equal(absent.code, 0);
    assert.match(absent.out, /Aucun fait dédié d'issue d'invocation enregistré pour cette requête\./);

    // Document présent mais sans entrée : même énoncé, aucune distinction
    // publique entre les deux.
    await writeOutcomes(h, { schema_version: 2, outcomes: [] });
    const empty = await cli(h, ['invocation-outcomes', RUN_ID]);
    assert.equal(empty.code, 0);
    assert.match(empty.out, /Aucun fait dédié d'issue d'invocation enregistré pour cette requête\./);

    // Le localisateur d'artefact n'est pas annoncé sans enregistrement.
    assert.doesNotMatch(absent.out, /invocation-outcomes\.json/);
    assert.doesNotMatch(empty.out, /invocation-outcomes\.json/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T5 — enregistrement v1 : enveloppe normalisée, sémantique intacte
// --------------------------------------------------------------------------

test('T5 · un fait v1 conserve sa version source et sa charge utile exacte', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, {
      schema_version: 1,
      outcomes: [
        {
          schema_version: 1,
          invocation_id: 'inv_000001',
          recorded_at: AT,
          terminal_negative_outcome: {
            kind: 'V4_REVALIDATION_REFUSED',
            check: 'SUBMITTED_SET',
            detail: 'le jeu soumis a changé',
          },
        },
      ],
    });

    const result = await cli(h, ['invocation-outcomes', RUN_ID]);
    assert.equal(result.code, 0);

    // Version SOURCE retenue, jamais estampillée à la version courante.
    assert.match(result.out, /enregistrement v1/);
    assert.doesNotMatch(result.out, /enregistrement v2/);

    // Genre et charge utile exacts.
    assert.match(result.out, /V4_REVALIDATION_REFUSED/);
    assert.match(result.out, /SUBMITTED_SET/);
    assert.match(result.out, /le jeu soumis a changé/);

    // Le nom de champ historique ne fuit pas dans la surface publique.
    assert.doesNotMatch(result.out, /terminal_negative_outcome/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T6 — enregistrement v2 : même enveloppe publique
// --------------------------------------------------------------------------

test('T6 · un fait v2 rend la même enveloppe publique, avec sa version source', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, {
      schema_version: 2,
      outcomes: [
        {
          schema_version: 2,
          invocation_id: 'inv_000002',
          recorded_at: AT,
          terminal_outcome: {
            kind: 'NATIVE_PROCESS_FAILED',
            error_code: 'SESSION_ID_COLLISION',
            native_detail: {
              code: 'SESSION_ID_COLLISION',
              expert_slot: 'author',
              provider: 'claude',
              session_id: 'S-DUP',
            },
          },
        },
      ],
    });

    const result = await cli(h, ['invocation-outcomes', RUN_ID]);
    assert.equal(result.code, 0);

    assert.match(result.out, /enregistrement v2/);
    assert.match(result.out, /NATIVE_PROCESS_FAILED/);
    // Le détail typé traverse en entier, sans être aplati ni reclassé.
    assert.match(result.out, /SESSION_ID_COLLISION/);
    assert.match(result.out, /author/);
    assert.match(result.out, /claude/);
    assert.match(result.out, /S-DUP/);
    assert.doesNotMatch(result.out, /terminal_outcome/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T7 — VALID_ZERO : code exact, glose bornée
// --------------------------------------------------------------------------

test('T7 · VALID_ZERO garde son code, et sa glose reste bornée à la cardinalité', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, {
      schema_version: 2,
      outcomes: [
        {
          schema_version: 2,
          invocation_id: 'inv_000001',
          recorded_at: AT,
          terminal_outcome: { kind: 'VALID_ZERO' },
        },
      ],
    });

    const result = await cli(h, ['invocation-outcomes', RUN_ID]);
    assert.equal(result.code, 0);

    // Le code exact reste visible : aucune paraphrase ne le remplace.
    assert.match(result.out, /VALID_ZERO/);
    assert.match(result.out, /cardinalité zéro/);

    // Ni accord, ni consensus, ni échec, ni succès générique, ni « aucun
    // résultat » — la paraphrase intuitive que le contrat proscrit.
    for (const forbidden of [
      /accord/i,
      /consensus/i,
      /échec/i,
      /succès/i,
      /aucun résultat/i,
      /contexte suffisant/i,
    ]) {
      assert.doesNotMatch(result.out, forbidden, `glose interdite : ${String(forbidden)}`);
    }
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T8 — version non prise en charge : refus, sans rendu partiel
// --------------------------------------------------------------------------

test('T8 · une version non prise en charge refuse, sans rendre le sous-ensemble lisible', async () => {
  const h = await harness();
  try {
    // Document courant portant un enregistrement de version inconnue, à côté
    // d'un enregistrement parfaitement lisible.
    await writeOutcomes(h, {
      schema_version: 2,
      outcomes: [
        {
          schema_version: 2,
          invocation_id: 'inv_000001',
          recorded_at: AT,
          terminal_outcome: { kind: 'VALID_ZERO' },
        },
        {
          schema_version: 99,
          invocation_id: 'inv_000002',
          recorded_at: AT,
          terminal_outcome: { kind: 'VALID_ZERO' },
        },
      ],
    });

    const result = await cli(h, ['invocation-outcomes', RUN_ID]);
    assert.notEqual(result.code, 0);
    // Le fait lisible n'est pas rendu : un sous-ensemble plausible serait la
    // corruption déguisée en absence.
    assert.doesNotMatch(result.out, /inv_000001/);
    assert.match(result.err, /JOURNAL_INVALID/);
  } finally {
    await h.dispose();
  }
});

test('T8b · une version de document inconnue refuse', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, { schema_version: 99, outcomes: [] });
    const result = await cli(h, ['invocation-outcomes', RUN_ID]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /JOURNAL_INVALID/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T9 — corruption : jamais zéro fait
// --------------------------------------------------------------------------

test('T9 · une persistance illisible refuse, et n’est jamais traitée comme zéro fait', async () => {
  const h = await harness();
  try {
    await writeFile(h.paths.invocationOutcomes, '{ ceci n’est pas du JSON', 'utf8');
    const result = await cli(h, ['invocation-outcomes', RUN_ID]);

    assert.notEqual(result.code, 0);
    assert.doesNotMatch(
      result.out,
      /Aucun fait dédié d'issue d'invocation enregistré pour cette requête\./,
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T10 — run absent
// --------------------------------------------------------------------------

test('T10 · un run absent refuse', async () => {
  const h = await harness();
  try {
    const result = await cli(h, ['invocation-outcomes', 'CCR-20260901-999']);
    assert.notEqual(result.code, 0);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T11 — identifiant d'invocation non canonique
// --------------------------------------------------------------------------

test('T11 · un identifiant d’invocation non canonique refuse', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, TWO_V2_RECORDS);
    const result = await cli(h, ['invocation-outcomes', RUN_ID, '--invocation', 'pas-un-id']);

    assert.notEqual(result.code, 0);
    assert.match(result.err, /INVALID_ARGUMENT/);
    // Une question mal posée ne se transforme pas en réponse « zéro fait ».
    assert.doesNotMatch(
      result.out,
      /Aucun fait dédié d'issue d'invocation enregistré pour cette requête\./,
    );
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T12 — aucune corrélation introduite (preuve structurelle)
// --------------------------------------------------------------------------

test('T12 · la lecture n’importe aucune autre autorité', async () => {
  const source = await readFile(
    new URL('../../src/services/invocation-outcome-read.ts', import.meta.url),
    'utf8',
  );

  // Les seules dépendances admises : le domaine de l'issue, la validation
  // d'identifiant, la persistance des issues, et le typage des chemins.
  // L'ensemble des modules atteints, non le compte des instructions : une
  // importation de valeur et une importation de type peuvent viser le même
  // module sans ajouter aucune dépendance.
  const imports = new Set(
    [...source.matchAll(/^import[^;]*?from '([^']+)';/gm)].map((match) => match[1]),
  );
  assert.deepEqual(
    [...imports].sort(),
    [
      '../core/errors.ts',
      '../core/invocation-outcome.ts',
      '../core/usage-governance.ts',
      '../store/invocation-outcome-store.ts',
      '../store/layout.ts',
    ].sort(),
  );

  // Aucune autorité voisine n'est atteignable depuis cette lecture.
  for (const forbidden of [
    'invocation-ledger',
    'openInvocationLedger',
    'event-store',
    'native-event-store',
    'usage-store',
    'controversy-store',
    'evidence-store',
    'reconciliation-store',
    'run-snapshot',
    'projectInvocationOutcomes',
  ]) {
    assert.ok(!source.includes(forbidden), `dépendance interdite : ${forbidden}`);
  }

  // La mise en forme ne s'en autorise pas davantage.
  const formatter = await readFile(
    new URL('../../src/cli/invocation-outcome-format.ts', import.meta.url),
    'utf8',
  );
  for (const forbidden of ['store/', 'ledger', 'SUCCESS_EVIDENCE', 'INCONSISTENT']) {
    assert.ok(!formatter.includes(forbidden), `dépendance interdite : ${forbidden}`);
  }
});

// --------------------------------------------------------------------------
// T13 — couverture du contrat public
//
// Cette garde prouve la COUVERTURE, et rien d'autre : que chaque jeton
// actuellement rendable figure au point d'entrée normatif. Elle ne prouve
// **pas** que la définition qui l'accompagne soit exacte, suffisante ou bien
// écrite. La qualité sémantique relève de la revue humaine.
// --------------------------------------------------------------------------

test('T13 · chaque jeton rendable figure au contrat public', async () => {
  const spec = await readFile(
    new URL('../../docs/specs/invocation-outcome.md', import.meta.url),
    'utf8',
  );

  // Genres d'issue : les neuf négatifs, plus VALID_ZERO.
  for (const kind of [...TERMINAL_NEGATIVE_OUTCOME_KINDS, 'VALID_ZERO']) {
    assert.ok(spec.includes(kind), `genre d'issue absent du contrat : ${kind}`);
  }

  // Vocabulaires de motif — les trois familles, jamais fusionnées.
  for (const reason of [
    ...V3_DETECTION_REASONS,
    ...V4_ADDUCTION_REASONS,
    ...V5_PROPOSAL_REASONS,
  ]) {
    assert.ok(spec.includes(reason), `motif absent du contrat : ${reason}`);
  }

  // Contrôles fermés V5, et codes de détail natif.
  for (const value of [...V5_REVALIDATION_CHECKS, ...NATIVE_FAILURE_DETAIL_CODES]) {
    assert.ok(spec.includes(value), `valeur fermée absente du contrat : ${value}`);
  }

  // Champs de charge utile et métadonnées : couverture de présence, suffisante
  // pour des champs dont la forme n'est pas un vocabulaire fermé.
  for (const field of [
    'reason',
    'at',
    'check',
    'detail',
    'error_code',
    'native_detail',
    'expert_slot',
    'provider',
    'session_id',
    'expected_session_id',
    'found_session_id',
    'invocation_id',
    'recorded_at',
  ]) {
    assert.ok(spec.includes(field), `champ absent du contrat : ${field}`);
  }

  // Le contrat déclare sa propre version, et les versions d'enregistrement
  // qu'il couvre.
  assert.match(spec, /CONTRAT SÉMANTIQUE\s+version 1/);
  assert.match(spec, /VERSIONS D'ENREGISTREMENT\s+1 · 2/);

  // VALID_ZERO est référencé à la doctrine, jamais redéfini ici.
  assert.match(spec, /docs\/doctrine\.md.*17\.7|17\.7/);
});

// --------------------------------------------------------------------------
// T14 — pointeur dans l'aide intégrée
// --------------------------------------------------------------------------

test('T14 · l’aide de la commande expose la référence canonique', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) };
  await runCli(['help'], { io });

  const usage = out.join('\n');
  const block = usage.slice(usage.indexOf('ccr invocation-outcomes'));
  assert.ok(
    block.slice(0, 800).includes(INVOCATION_OUTCOME_CONTRACT_REFERENCE),
    "le bloc d'aide doit pointer vers la référence canonique",
  );
});

// --------------------------------------------------------------------------
// T15 — un seul pointeur par sortie non vide
// --------------------------------------------------------------------------

test('T15 · la sortie non vide porte le pointeur exactement une fois', async () => {
  const h = await harness();
  try {
    // Deux enregistrements : le pointeur reste au niveau de la commande.
    await writeOutcomes(h, TWO_V2_RECORDS);
    const result = await cli(h, ['invocation-outcomes', RUN_ID]);

    assert.equal(result.code, 0);
    const occurrences = result.out.split(INVOCATION_OUTCOME_CONTRACT_REFERENCE).length - 1;
    assert.equal(occurrences, 1, 'un pointeur par commande, jamais par enregistrement');

    // Les deux enregistrements sont bien rendus : le pointeur n'a pas remplacé
    // une ligne de fait.
    assert.match(result.out, /inv_000003/);
    assert.match(result.out, /inv_000001/);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// T16 — la sortie sans correspondance ne change pas
// --------------------------------------------------------------------------

test('T16 · zéro correspondance ne porte pas le pointeur, et ne change pas', async () => {
  const h = await harness();
  try {
    await writeOutcomes(h, TWO_V2_RECORDS);
    const filtered = await cli(h, ['invocation-outcomes', RUN_ID, '--invocation', 'inv_000009']);

    assert.equal(filtered.code, 0);
    assert.match(filtered.out, /Aucun fait dédié d'issue d'invocation enregistré pour cette requête\./);
    assert.ok(
      !filtered.out.includes(INVOCATION_OUTCOME_CONTRACT_REFERENCE),
      'une requête sans correspondance ne porte aucun jeton à interpréter',
    );
    assert.doesNotMatch(filtered.out, /invocation-outcomes\.json/);

    // Persistance rendant zéro fait : même absence de pointeur.
    const empty = await harness();
    try {
      const none = await cli(empty, ['invocation-outcomes', RUN_ID]);
      assert.equal(none.code, 0);
      assert.match(none.out, /Aucun fait dédié d'issue d'invocation enregistré pour cette requête\./);
      assert.ok(!none.out.includes(INVOCATION_OUTCOME_CONTRACT_REFERENCE));
    } finally {
      await empty.dispose();
    }
  } finally {
    await h.dispose();
  }
});
