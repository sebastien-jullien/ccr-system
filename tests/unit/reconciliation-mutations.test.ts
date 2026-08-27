/**
 * Preuves de la tranche S5 — l'acte humain canonique et son écriture.
 *
 * Classes de preuve : `FIXTURE` pour les refus et les formes,
 * `AUTOMATED_REAL_PROCESS` pour la frontière de mutation — établie avec de vrais
 * processus enfants.
 *
 * Ce fichier ne prouve **aucune** sémantique de S6 à S9 : ni supersession, ni
 * retrait de clôture, ni réponse à une proposition, ni actualité.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { lockFilePath } from '../../src/lock/run-lock.ts';
import { readReconciliationJournal } from '../../src/store/reconciliation-store.ts';
import { readCurrentReconciliationRevision } from '../../src/services/reconciliation-freshness.ts';
import {
  RECONCILIATION_HUMAN_PROVIDER_EFFECT,
  RECONCILIATION_OUTCOMES,
  recordReconciliation,
} from '../../src/services/reconciliation-service.ts';
import type { RecordReconciliationInput } from '../../src/services/reconciliation-service.ts';
import { RECONCILIATION_SCHEMA_VERSION } from '../../src/core/reconciliation.ts';
import { isCcrError } from '../../src/core/errors.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';

const run = promisify(execFile);

const RUN_ID = 'CCR-20260403-001';
const CTV = formatControversyId(1);
const OTHER = formatControversyId(2);

const NOW = new Date('2026-08-20T12:00:00.000Z');
const deps = (runsDir: string): { runsDir: string; now(): Date } => ({ runsDir, now: () => NOW });

/** Enfant réel : ajoute une ligne à un journal. N'importe rien de CCR. */
const APPEND_CHILD = "require('fs').appendFileSync(process.argv[1], process.argv[2] + '\\n');";
/** Enfant réel : constate la présence du verrou de run, et rien d'autre. */
const LOCK_CHILD = "process.exit(require('fs').existsSync(process.argv[1]) ? 0 : 3);";

function v3Entry(sequence: number, controversyId = CTV): ControversyEntry {
  return {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: controversyId,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-20T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  };
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  revision(): Promise<string>;
  dispose(): Promise<void>;
}

async function fixture(v3: readonly ControversyEntry[] = [v3Entry(1)]): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s5-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, title: 's5', created_at: '2026-08-20T09:00:00.000Z',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'codex', session_id: 'S1' },
      challenger: { provider: 'claude', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000001',
    updated_at: '2026-08-20T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, `${JSON.stringify({
    event_id: 'evt_000001', run_id: RUN_ID, round: 1, timestamp: '2026-08-20T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: 'le cache doit expirer',
  })}\n`, 'utf8');
  if (v3.length > 0) {
    await writeFile(paths.controversies, `${v3.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  }
  return {
    runsDir,
    paths,
    revision: () => readCurrentReconciliationRevision({ runsDir }, RUN_ID),
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

function input(over: Partial<RecordReconciliationInput> = {}): RecordReconciliationInput {
  return {
    runId: RUN_ID,
    expected_revision: 'rcn-sha256:placeholder',
    target_controversy_id: CTV,
    scope_kind: 'SUBSET',
    scope: [formatControversyEntryId(1)],
    content: 'ce que la personne a décidé',
    provenance: { kind: 'DECLARED', statement: 'décidé en revue' },
    ...over,
  } as RecordReconciliationInput;
}

/** Le journal V5 n'a pas bougé — ni contenu, ni existence. */
async function assertNoCanonicalBytes(paths: RunPaths, before: string | undefined): Promise<void> {
  if (before === undefined) {
    assert.equal(existsSync(paths.reconciliations), false, 'un refus ne crée jamais le journal.');
    return;
  }
  assert.equal(await readFile(paths.reconciliations, 'utf8'), before, 'le journal doit rester intact.');
}

// --------------------------------------------------------------------------
// L'acte valide
// --------------------------------------------------------------------------

test('un acte humain valide est RECORDED, avec ses champs serveur', async () => {
  const h = await fixture();
  try {
    const result = await recordReconciliation(deps(h.runsDir), input({ expected_revision: await h.revision() }));

    assert.equal(result.outcome, 'RECORDED');
    assert.equal(result.provider_effect, RECONCILIATION_HUMAN_PROVIDER_EFFECT);
    assert.equal(result.entry.entry_id, 'rcn_000001');
    assert.equal(result.entry.kind, 'RECONCILIATION_RECORDED');
    assert.equal(result.entry.schema_version, RECONCILIATION_SCHEMA_VERSION);
    // Champs serveur : l'appelant n'en a fourni aucun.
    assert.equal(result.entry.semantic_origin, 'HUMAN');
    assert.equal(result.entry.recorded_by, 'CCR');
    assert.equal(result.entry.recorded_at, NOW.toISOString());
    assert.match(result.entry.observed_revision, /^rcn-sha256:[0-9a-f]{64}$/);
    // La révision résultante est postérieure à l'append.
    assert.notEqual(result.reconciliation_revision, result.entry.observed_revision);

    const journal = await readReconciliationJournal(h.paths);
    assert.deepEqual(journal.entries, [result.entry]);
  } finally {
    await h.dispose();
  }
});

test('RECORDED signifie un acte écrit, jamais une vérité ni une actualité', async () => {
  assert.deepEqual(RECONCILIATION_OUTCOMES, [
    'RECORDED', 'REFUSED_VALIDATION', 'REFUSED_FRESHNESS', 'REFUSED_LOCK',
  ]);
  for (const forged of ['SUCCESS', 'RESOLVED', 'FAILED_MERITS', 'CLOSED_SUCCESSFULLY']) {
    assert.equal((RECONCILIATION_OUTCOMES as readonly string[]).includes(forged), false);
  }
});

test('C31 · V12 — un contenu humain vide est refusé, sans écrire un octet', async () => {
  const h = await fixture();
  try {
    const revision = await h.revision();
    await assert.rejects(() =>
      recordReconciliation(deps(h.runsDir), input({ expected_revision: revision, content: '' })));
    await assertNoCanonicalBytes(h.paths, undefined);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// V31 — fraîcheur : expected fourni par l'appelant, observed relu sous verrou
// --------------------------------------------------------------------------

test('V31 — une révision périmée refuse la mutation : STALE_WRITE_BYTES = 0', async () => {
  const h = await fixture();
  try {
    const stale = await h.revision();
    // Une écriture s'intercale : la vue de l'appelant devient périmée.
    await recordReconciliation(deps(h.runsDir), input({ expected_revision: stale }));
    const before = await readFile(h.paths.reconciliations, 'utf8');

    await assert.rejects(
      () => recordReconciliation(deps(h.runsDir), input({ expected_revision: stale })),
      (error: unknown) => {
        assert.ok(isCcrError(error));
        assert.equal((error as { code?: string }).code, 'STALE_REVISION');
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        assert.equal(details['outcome'], 'REFUSED_FRESHNESS');
        // Les deux valeurs appartiennent au MÊME domaine.
        assert.match(String(details['expected_revision']), /^rcn-sha256:/);
        assert.match(String(details['observed_revision']), /^rcn-sha256:/);
        assert.notEqual(details['expected_revision'], details['observed_revision']);
        return true;
      },
    );

    await assertNoCanonicalBytes(h.paths, before);
  } finally {
    await h.dispose();
  }
});

test('la fraîcheur est comparée AVANT toute validation métier', async () => {
  const h = await fixture();
  try {
    const stale = await h.revision();
    await recordReconciliation(deps(h.runsDir), input({ expected_revision: stale }));
    const before = await readFile(h.paths.reconciliations, 'utf8');

    // Requête doublement fautive : révision périmée ET périmètre étranger.
    // C'est la fraîcheur qui doit l'emporter — une vue périmée invalide la
    // demande entière, pas seulement sa cible.
    await assert.rejects(
      () => recordReconciliation(deps(h.runsDir), input({
        expected_revision: stale, scope: [formatControversyEntryId(99)],
      })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'STALE_REVISION');
        return true;
      },
    );
    await assertNoCanonicalBytes(h.paths, before);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// SUBSET sur le chemin canonique
// --------------------------------------------------------------------------

test('C05 · V03 · SUBSET — la validation S4 est réellement invoquée sur le chemin d\'écriture', async () => {
  const h = await fixture([v3Entry(1), v3Entry(2, OTHER)]);
  try {
    const cases: readonly (readonly [string, readonly string[] | undefined])[] = [
      // `C05` — un acte sans périmètre est refusé, y compris sur un SUBSET.
      ['SCOPE_ABSENT', undefined],
      ['SCOPE_ENTRY_FOREIGN', [formatControversyEntryId(2)]],
      ['SCOPE_ENTRY_NOT_FOUND', [formatControversyEntryId(99)]],
      ['SCOPE_ENTRY_DUPLICATED', [formatControversyEntryId(1), formatControversyEntryId(1)]],
      ['SCOPE_EMPTY', []],
      ['SCOPE_ENTRY_NOT_CANONICAL', ['ctve_1']],
    ];
    const revision = await h.revision();
    for (const [reason, scope] of cases) {
      await assert.rejects(
        () => recordReconciliation(deps(h.runsDir), input({ expected_revision: revision, scope })),
        (error: unknown) => {
          const details = (error as { details?: Record<string, unknown> }).details ?? {};
          assert.equal(details['reason'], reason);
          return true;
        },
        `refus attendu : ${reason}`,
      );
      await assertNoCanonicalBytes(h.paths, undefined);
    }
  } finally {
    await h.dispose();
  }
});

test('un SUBSET déclaré est persisté tel quel — ni réordonné, ni complété', async () => {
  const h = await fixture([v3Entry(1), v3Entry(2), v3Entry(3)]);
  try {
    const declared = [formatControversyEntryId(3), formatControversyEntryId(1)];
    const result = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope: declared,
    }));
    assert.deepEqual(result.entry.scope, declared);
    assert.equal(result.entry.scope_kind, 'SUBSET');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// WHOLE sous la frontière de mutation  ·  AUTOMATED_REAL_PROCESS
// --------------------------------------------------------------------------

test('WHOLE est énuméré DANS la frontière, contre l\'état autoritaire (processus réel)', async () => {
  const h = await fixture([v3Entry(1)]);
  try {
    // Vue de l'appelant AVANT : une seule unité.
    const revision = await h.revision();

    // Un VRAI processus enfant ajoute une entrée V3 avant l'appel. Si le service
    // réutilisait une énumération pré-calculée hors verrou, elle en porterait une.
    await run(process.execPath, ['-e', APPEND_CHILD, h.paths.controversies, JSON.stringify(v3Entry(2))]);

    const result = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: revision, scope_kind: 'WHOLE', scope: undefined,
    }));

    // Le périmètre persisté vient de l'état relu SOUS le verrou : deux unités.
    assert.deepEqual(result.entry.scope, ['ctve_000001', 'ctve_000002']);
    assert.equal(result.entry.scope_kind, 'WHOLE');
    // Explicite, jamais un marqueur : l'énumération EST le périmètre.
    assert.equal(result.entry.scope.length, 2);
  } finally {
    await h.dispose();
  }
});

test('P10 — une clôture de périmètre WHOLE exige WHOLE explicite ET clôture explicite', async () => {
  const h = await fixture([v3Entry(1), v3Entry(2)]);
  try {
    // Les deux déclarations sont indépendantes : `WHOLE` sans clôture ne clôt
    // rien, et une clôture ne se déduit d'aucune sorte de périmètre.
    const withoutClosure = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope_kind: 'WHOLE', scope: undefined,
    }));
    assert.equal('closure' in (withoutClosure.entry as unknown as Record<string, unknown>), false);
    assert.equal(withoutClosure.entry.scope_kind, 'WHOLE');

    // Les deux ensemble : chacune reste explicite, et le périmètre est énuméré.
    const both = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      scope_kind: 'WHOLE',
      scope: undefined,
      closure: { declared: true, statement: 'clos sur tout le périmètre observé' },
    }));
    assert.equal(both.entry.scope_kind, 'WHOLE');
    assert.deepEqual(both.entry.scope, ['ctve_000001', 'ctve_000002']);
    assert.equal(both.entry.closure?.declared, true);
  } finally {
    await h.dispose();
  }
});

test('P25 · P26 — une clôture n\'écrit rien sur le désaccord et n\'efface aucun historique', async () => {
  const h = await fixture([v3Entry(1)]);
  try {
    const v3Before = await readFile(h.paths.controversies, 'utf8');

    await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      closure: { declared: true, statement: 'clos sur ce périmètre' },
    }));

    // `P26` — le journal V3 est intact, octet pour octet : une clôture n'efface
    // aucun fait de désaccord historique.
    assert.equal(await readFile(h.paths.controversies, 'utf8'), v3Before);

    // `P25` — un acte SANS clôture n'écrit aucune affirmation de désaccord :
    // l'absence de clôture ne devient pas un fait.
    const open = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
    }));
    const serialized = JSON.stringify(open.entry);
    for (const forged of ['disagreement', 'persistent', 'unresolved', 'open']) {
      assert.equal(serialized.includes(forged), false, `${forged} ne doit rien affirmer ici.`);
    }
  } finally {
    await h.dispose();
  }
});

test('le verrou de run est réellement tenu pendant la mutation (processus réel)', async () => {
  const h = await fixture();
  try {
    const lock = lockFilePath(h.paths);
    assert.equal(existsSync(lock), false, 'aucun verrou avant la mutation.');

    let childExit = -1;
    await recordReconciliation(deps(h.runsDir), input({ expected_revision: await h.revision() }), {
      // Exécuté SOUS le verrou, à l'intérieur de la frontière unique.
      before: async () => {
        const child = await run(process.execPath, ['-e', LOCK_CHILD, lock]).then(
          () => 0,
          (error: { code?: number }) => error.code ?? -1,
        );
        childExit = child;
      },
    });

    assert.equal(childExit, 0, 'un processus externe a observé le verrou tenu pendant la mutation.');
    assert.equal(existsSync(lock), false, 'le verrou est relâché après la mutation.');
  } finally {
    await h.dispose();
  }
});

test('une seule acquisition de verrou par mutation — S4 n\'en prend aucune', async () => {
  const h = await fixture();
  try {
    // Si une primitive S4 acquérait un second verrou, `link` échouerait
    // `EEXIST` contre notre propre processus et la mutation entière lèverait.
    // Qu'un WHOLE — qui traverse `prepareScope` — aboutisse le démontre.
    const result = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(), scope_kind: 'WHOLE', scope: undefined,
    }));
    assert.equal(result.outcome, 'RECORDED');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Identité et atomicité
// --------------------------------------------------------------------------

test('l\'identité est allouée par le serveur, strictement croissante et non contiguë', async () => {
  const h = await fixture();
  try {
    const a = await recordReconciliation(deps(h.runsDir), input({ expected_revision: await h.revision() }));
    assert.equal(a.entry.entry_id, 'rcn_000001');

    // Un trou introduit hors service reste licite : aucune règle NO-GAP.
    const raw = await readFile(h.paths.reconciliations, 'utf8');
    const forged = JSON.parse(raw.trim()) as Record<string, unknown>;
    forged['entry_id'] = 'rcn_000009';
    forged['content'] = 'écrit ailleurs';
    await writeFile(h.paths.reconciliations, `${raw}${JSON.stringify(forged)}\n`, 'utf8');

    const b = await recordReconciliation(deps(h.runsDir), input({ expected_revision: await h.revision() }));
    assert.equal(b.entry.entry_id, 'rcn_000010', 'la séquence suit le maximum, sans combler le trou.');
  } finally {
    await h.dispose();
  }
});

test('C46 · un refus laisse zéro octet canonique, et la révision inchangée', async () => {
  const h = await fixture();
  try {
    const first = await recordReconciliation(deps(h.runsDir), input({ expected_revision: await h.revision() }));
    const before = await readFile(h.paths.reconciliations, 'utf8');
    const revisionBefore = await h.revision();

    const revision = await h.revision();
    await assert.rejects(() => recordReconciliation(deps(h.runsDir), input({
      expected_revision: revision, scope: [formatControversyEntryId(42)],
    })));

    assert.equal(await readFile(h.paths.reconciliations, 'utf8'), before);
    assert.equal(await h.revision(), revisionBefore);
    const journal = await readReconciliationJournal(h.paths);
    assert.deepEqual(journal.entries, [first.entry]);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// Frontières de tranche
// --------------------------------------------------------------------------

test('P35 · aucun champ d\'actualité n\'est persisté — S9 reste propriétaire', async () => {
  const h = await fixture();
  try {
    const result = await recordReconciliation(deps(h.runsDir), input({
      expected_revision: await h.revision(),
      closure: { declared: true, statement: 'clos sur ce périmètre' },
    }));

    const stored = result.entry as unknown as Record<string, unknown>;
    for (const forbidden of ['is_closed', 'current_closure', 'active_closure', 'current', 'status', 'converged']) {
      assert.equal(forbidden in stored, false, `${forbidden} n'a pas sa place dans l'acte canonique.`);
    }
    // La déclaration historique, elle, est bien là.
    assert.deepEqual(stored['closure'], { declared: true, statement: 'clos sur ce périmètre' });
  } finally {
    await h.dispose();
  }
});

test('S6 · S7 · S8 — une cible inexistante est REFUSÉE par son propriétaire, jamais écartée', async () => {
  // Ces trois champs ont chacun trouvé leur tranche. Le refus ne vient donc
  // plus de l'absence d'un runtime, mais du runtime lui-même : la cible visée
  // n'existe pas dans ce run. Une supersession, un retrait, une réponse
  // référencent un fait existant — ils n'en créent aucun.
  const intents: readonly (readonly [string, string, string, unknown])[] = [
    ['supersedes', 'SUPERSEDED_ACT_NOT_FOUND', 'supersedes[0]',
     [{ superseded_act_id: 'rcn_000009', supersession_scope: ['ctve_000001'] }]],
    ['closure_withdrawal', 'WITHDRAWN_CLOSURE_NOT_FOUND',
     'closure_withdrawal.withdrawn_closures[0]', {
       declared: true, withdrawn_closures: ['rcn_000009'],
       withdrawal_scope: ['ctve_000001'], statement: 'x',
     }],
    ['responds_to', 'PROPOSAL_NOT_FOUND', 'responds_to',
     { proposal_id: 'rcn_000009', relation: 'ADOPTS' }],
  ];

  for (const [field, reason, at, value] of intents) {
    const h = await fixture();
    try {
      // Requête par ailleurs PARFAITEMENT valide : révision fraîche, périmètre
      // correct, contenu et provenance présents. Seul le champ d'intention,
      // pointant vers une cible absente, s'y ajoute.
      const revision = await h.revision();
      const request = {
        ...input({ expected_revision: revision }),
        [field]: value,
      } as unknown as RecordReconciliationInput;

      await assert.rejects(
        () => recordReconciliation(deps(h.runsDir), request),
        (error: unknown) => {
          assert.ok(isCcrError(error));
          const details = (error as { details?: Record<string, unknown> }).details ?? {};
          assert.equal(details['outcome'], 'REFUSED_VALIDATION',
            'le refus emprunte la famille déjà contractée — aucune issue nouvelle.');
          assert.equal(details['reason'], reason);
          assert.equal(details['at'], at);
          return true;
        },
        `${field} doit être refusé, non écarté.`,
      );

      // `REFUSED_INTENT_WRITE_BYTES = 0` — rien n'a été écrit, et surtout
      // aucun acte de réconciliation « ordinaire » n'a pris la place demandée.
      await assertNoCanonicalBytes(h.paths, undefined);
    } finally {
      await h.dispose();
    }
  }
});

test('une supersession valide est portée telle quelle — jamais dépouillée, jamais élargie', async () => {
  const h = await fixture();
  try {
    // Un acte valide d'abord, pour que le journal existe et soit comparable.
    const first = await recordReconciliation(deps(h.runsDir), input({ expected_revision: await h.revision() }));
    const before = await readFile(h.paths.reconciliations, 'utf8');
    const revisionBefore = await h.revision();

    const request = {
      ...input({ expected_revision: revisionBefore }),
      supersedes: [{ superseded_act_id: first.entry.entry_id, supersession_scope: ['ctve_000001'] }],
    } as unknown as RecordReconciliationInput;

    // Avant `S6`, cette requête était refusée faute de tranche propriétaire.
    // `S6` existe : la cible est réelle, le périmètre est valide, l'acte est
    // humain. Ce qui était TEMPORAIREMENT interdit est devenu la sémantique
    // finale — et c'est cette transition, minimale, que le test éprouve.
    const second = await recordReconciliation(deps(h.runsDir), request);

    // L'intention humaine est portée telle qu'elle a été formulée.
    assert.equal(second.entry.semantic_origin, 'HUMAN');
    assert.deepEqual(second.entry.supersedes, [
      { superseded_act_id: first.entry.entry_id, supersession_scope: ['ctve_000001'] },
    ]);
    assert.ok(second.entry.entry_id !== first.entry.entry_id);

    // APPEND-ONLY : l'acte antérieur n'est pas réécrit. Les octets d'avant sont
    // exactement le préfixe des octets d'après.
    const after = await readFile(h.paths.reconciliations, 'utf8');
    assert.ok(after.startsWith(before), 'le journal est étendu, jamais réécrit.');
    assert.notEqual(await h.revision(), revisionBefore, 'un acte nouveau change la révision.');

    const journal = await readReconciliationJournal(h.paths);
    assert.equal(journal.entries.length, 2);
    assert.deepEqual(journal.entries[0], first.entry, 'l\'acte superséssé demeure, intact.');

    // AUCUNE AUTORITÉ IMPLICITE : superséder n'est pas retirer une clôture
    // (`CR5-01`), ni répondre à une proposition. Rien d'autre n'a été ajouté.
    const stored = second.entry as unknown as Record<string, unknown>;
    for (const absent of ['closure_withdrawal', 'responds_to', 'closure']) {
      assert.equal(absent in stored, false, `${absent} n'a pas été induit.`);
    }
  } finally {
    await h.dispose();
  }
});

test('un champ réellement inconnu est refusé, jamais ignoré', async () => {
  const h = await fixture();
  try {
    const revision = await h.revision();
    const request = {
      ...input({ expected_revision: revision }),
      merits_confidence: 0.9,
    } as unknown as RecordReconciliationInput;

    await assert.rejects(
      () => recordReconciliation(deps(h.runsDir), request),
      (error: unknown) => {
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        assert.equal(details['reason'], 'UNKNOWN_INPUT_FIELD');
        assert.equal(details['field'], 'merits_confidence');
        return true;
      },
    );
    await assertNoCanonicalBytes(h.paths, undefined);
  } finally {
    await h.dispose();
  }
});

test('la fraîcheur garde sa précédence sur le refus d\'intention non supportée', async () => {
  const h = await fixture();
  try {
    const stale = await h.revision();
    await recordReconciliation(deps(h.runsDir), input({ expected_revision: stale }));
    const before = await readFile(h.paths.reconciliations, 'utf8');

    // Doublement fautive : révision périmée ET champ d'une tranche future.
    const request = {
      ...input({ expected_revision: stale }),
      closure_withdrawal: { declared: true, withdrawn_closures: ['rcn_000001'], withdrawal_scope: ['ctve_000001'], statement: 'x' },
    } as unknown as RecordReconciliationInput;

    await assert.rejects(
      () => recordReconciliation(deps(h.runsDir), request),
      (error: unknown) => {
        // La fraîcheur l'emporte : la précédence contractée est inchangée.
        assert.equal((error as { code?: string }).code, 'STALE_REVISION');
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        assert.equal(details['outcome'], 'REFUSED_FRESHNESS');
        return true;
      },
    );
    await assertNoCanonicalBytes(h.paths, before);
  } finally {
    await h.dispose();
  }
});

test('P35 · les champs serveur restent écrasés — aucune perte d\'intention humaine', async () => {
  const h = await fixture();
  try {
    // Politique acquise, non modifiée par la réparation : un champ dont le
    // contrat impose la production serveur est écrasé, pas refusé.
    const request = {
      ...input({ expected_revision: await h.revision() }),
      entry_id: 'rcn_000042',
      recorded_at: '1999-01-01T00:00:00.000Z',
      recorded_by: 'HUMAN',
      semantic_origin: 'CCR',
      observed_revision: 'rcn-sha256:forge',
      schema_version: 99,
    } as unknown as RecordReconciliationInput;

    const result = await recordReconciliation(deps(h.runsDir), request);
    assert.equal(result.entry.entry_id, 'rcn_000001');
    assert.equal(result.entry.recorded_at, NOW.toISOString());
    assert.equal(result.entry.recorded_by, 'CCR');
    assert.equal(result.entry.semantic_origin, 'HUMAN');
    assert.equal(result.entry.schema_version, RECONCILIATION_SCHEMA_VERSION);
    assert.notEqual(result.entry.observed_revision, 'rcn-sha256:forge');
  } finally {
    await h.dispose();
  }
});
