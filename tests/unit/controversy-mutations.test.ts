/**
 * V3-S4 — écritures métier sans fournisseur.
 *
 * Question de preuve :
 *
 * > **Une écriture V3 peut-elle être fraîche, attribuée honnêtement et
 * > sérialisée, sans qu'aucun fournisseur ne soit approché ?**
 *
 * Quatre propriétés.
 *
 *  1. **Une seule section critique.** Fraîcheur, résolution d'ancrage,
 *     validation de cible et append vivent sous le même verrou de run. Un refus
 *     laisse le journal — et son absence — intacts.
 *  2. **L'appelant ne forge rien.** Identités, horodatage, origine sémantique,
 *     provenance et actes d'autorité sont posés par le serveur.
 *  3. **Aucune promotion.** Une transcription humaine reste `HUMAN`, une
 *     inférence CCR n'est jamais modifiée, un retrait ne supprime rien.
 *  4. **`EXACT(0)`.** Aucun fournisseur, aucun ledger, aucun `MODEL_ASSISTED` —
 *     inexprimable plutôt que refusé.
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
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import { readControversyJournal } from '../../src/store/controversy-store.ts';
import { appendJsonLine } from '../../src/store/atomic-file.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { projectControversyReadModel } from '../../src/services/controversy-read-model.ts';
import {
  MAX_CONTROVERSY_TEXT_BYTES,
  confirmInferredRelation,
  contestInferredRelation,
  recordAssertion,
  recordControversy,
  recordHumanAuthority,
  recordHumanTranscription,
  recordNature,
  recordRelation,
} from '../../src/services/controversy-service.ts';
import type { ControversyServiceDeps } from '../../src/services/controversy-service.ts';

const RUN_ID = 'CCR-20260817-001';
const SERVICE_SOURCE = new URL('../../src/services/controversy-service.ts', import.meta.url);

/** Contenu de l'événement de l'author — « aaa » sert aux occurrences chevauchantes. */
const AUTHOR_CONTENT = 'Le cache doit expirer. aaa fin.';
const CHALLENGER_CONTENT = 'Non : aa le cache reste valide.';

// --------------------------------------------------------------------------
// Fixture — run natif réel sur disque
// --------------------------------------------------------------------------

interface Fixture {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: ControversyServiceDeps;
  dispose(): Promise<void>;
}

const EVENTS: readonly Record<string, unknown>[] = [
  {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-17T09:10:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'S1',
    content: AUTHOR_CONTENT,
  },
  {
    event_id: 'evt_000002',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-17T09:20:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'challenger',
    session_id: 'S2',
    content: CHALLENGER_CONTENT,
  },
  {
    // Adressé à un expert, produit par personne : aucune paternité.
    event_id: 'evt_000003',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-17T09:30:00.000Z',
    actor: 'system',
    type: 'prompt_sent',
    target_expert_slot_id: 'author',
    content: AUTHOR_CONTENT,
  },
];

async function nativeRun(options: { legacy?: boolean } = {}): Promise<Fixture> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v3-s4-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  const legacy = options.legacy === true;
  await writeFile(
    paths.manifest,
    JSON.stringify(
      legacy
        ? {
            schema_version: 1,
            run_id: RUN_ID,
            created_at: '2026-08-17T09:00:00.000Z',
            title: 'S4-legacy',
            workspace: { cwd: runsDir },
            agents: {
              claude: { session_id: 'S1', role: 'author' },
              codex: { session_id: 'S2', role: 'challenger' },
            },
          }
        : {
            schema_version: 2,
            run_id: RUN_ID,
            created_at: '2026-08-17T09:00:00.000Z',
            title: 'S4',
            workspace: { cwd: runsDir },
            experts: {
              author: { provider: 'codex', session_id: 'S1' },
              challenger: { provider: 'claude', session_id: 'S2' },
            },
          },
    ),
    'utf8',
  );

  await writeFile(
    paths.state,
    JSON.stringify({
      schema_version: legacy ? 2 : 3,
      run_id: RUN_ID,
      state: 'READY',
      control: 'AUTOMATION',
      round: 1,
      active_expert_slot: null,
      next_step_source_slot: 'author',
      last_event_id: 'evt_000003',
      updated_at: '2026-08-17T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );

  await writeFile(paths.events, EVENTS.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  let tick = 0;
  const deps: ControversyServiceDeps = {
    runsDir,
    now: (): Date => {
      tick += 1;
      return new Date(Date.UTC(2026, 7, 17, 12, 0, tick));
    },
  };

  return { runsDir, paths, deps, dispose: () => rm(runsDir, { recursive: true, force: true }) };
}

async function revisionOf(fixture: Fixture): Promise<string> {
  return (await readStableNativeRunSnapshot(fixture.runsDir, RUN_ID)).controversy_revision;
}

async function entriesOf(fixture: Fixture): Promise<readonly ControversyEntry[]> {
  return (await readControversyJournal(fixture.paths)).entries;
}

async function rawJournal(fixture: Fixture): Promise<string | undefined> {
  return existsSync(fixture.paths.controversies)
    ? readFile(fixture.paths.controversies, 'utf8')
    : undefined;
}

/** Ouvre une controverse et rend son identité et la révision qui suit. */
async function openControversy(
  fixture: Fixture,
): Promise<{ controversyId: string; revision: string; entryId: string }> {
  const result = await recordControversy(fixture.deps, {
    runId: RUN_ID,
    expected_controversy_revision: await revisionOf(fixture),
    provenance_event_ids: ['evt_000001'],
    statement: 'Durée de vie du cache',
  });
  return {
    controversyId: result.controversy_id,
    revision: result.controversy_revision,
    entryId: result.entry.entry_id,
  };
}

/** Assertion humaine simple, pour servir de cible aux relations. */
async function addAssertion(
  fixture: Fixture,
  controversyId: string,
  statement: string,
): Promise<{ entryId: string; revision: string }> {
  const result = await recordAssertion(fixture.deps, {
    runId: RUN_ID,
    controversy_id: controversyId,
    expected_controversy_revision: await revisionOf(fixture),
    provenance_event_ids: ['evt_000001'],
    statement,
  });
  return { entryId: result.entry.entry_id, revision: result.controversy_revision };
}

/**
 * Inférence de relation produite par CCR, écrite **directement** dans le
 * journal.
 *
 * Aucune opération S4 ne produit `kind = CCR` : les huit opérations du plan sont
 * d'autorité humaine. Une telle entrée est le produit du détecteur S7, et la
 * poser ici décrit exactement le journal que S7 laissera — ce n'est pas une
 * fixture impossible, c'est l'état amont d'une autorité humaine.
 */
async function seedCcrRelationInference(
  fixture: Fixture,
  controversyId: string,
  from: string,
  to: string,
): Promise<string> {
  const entries = await entriesOf(fixture);
  const next = entries.length + 1;
  const entry: ControversyEntry = {
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(next),
    controversy_id: controversyId,
    kind: 'RELATION_RECORDED',
    semantic_origin: { kind: 'CCR' },
    recorded_by: 'CCR',
    recorded_at: '2026-08-17T11:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1, expert_slot_id: 'author' }] },
    derivation: { method: 'DETERMINISTIC_LOCAL', inputs: ['evt_000001', 'evt_000002'] },
    relation: { from_entry_id: from, to_entry_id: to, act: 'CONTESTS' },
  };
  await appendJsonLine(fixture.paths.controversies, entry);
  return entry.entry_id;
}

function reasonOf(error: unknown): unknown {
  return (error as { details?: Record<string, unknown> }).details?.['reason'];
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

/**
 * Le code du service, commentaires retirés.
 *
 * Les gardes statiques portent sur ce que le service **fait**, pas sur ce qu'il
 * explique. La documentation du module nomme légitimement `MODEL_ASSISTED`,
 * `SOURCE` ou l'`InvocationLedger` pour dire qu'elle ne les produit pas ; une
 * garde qui lirait ces phrases interdirait d'expliquer l'interdit.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ==========================================================================
// A. Première écriture, fraîcheur, identités
// ==========================================================================

test('1 · T1 — enregistrer une controverse sur un journal ABSENT', async () => {
  const fixture = await nativeRun();
  try {
    assert.equal(existsSync(fixture.paths.controversies), false, 'absent avant la mutation');
    const before = await revisionOf(fixture);
    assert.equal(existsSync(fixture.paths.controversies), false, 'lire ne crée rien');

    const result = await recordControversy(fixture.deps, {
      runId: RUN_ID,
      expected_controversy_revision: before,
      provenance_event_ids: ['evt_000001'],
      statement: 'Durée de vie du cache',
    });

    // Le fichier n'existe qu'à partir du premier append réussi.
    assert.equal(existsSync(fixture.paths.controversies), true);
    const raw = await rawJournal(fixture);
    assert.ok(raw !== undefined);
    assert.equal(raw.endsWith('\n'), true, 'une ligne complète, terminée');
    assert.equal(raw.split('\n').filter((line) => line.length > 0).length, 1);

    // Identités allouées par le serveur, espaces disjoints.
    assert.equal(result.controversy_id, formatControversyId(1));
    assert.equal(result.entry.entry_id, formatControversyEntryId(1));
    assert.equal(result.entry.kind, 'CONTROVERSY_RECORDED');
    assert.equal(result.entry.schema_version, CONTROVERSY_SCHEMA_VERSION);
    assert.equal(result.entry.recorded_by, 'HUMAN');
    assert.deepEqual(result.entry.semantic_origin, { kind: 'HUMAN' });
    assert.equal(result.entry.derivation, undefined);
    assert.equal(result.entry.round, 1, 'le tour vient de l’état du run');
    assert.equal(result.entry.recorded_at, '2026-08-17T12:00:01.000Z', 'horodatage server-authoritative');

    // Provenance recopiée depuis l'événement canonique, jamais reçue.
    assert.deepEqual(result.entry.anchors.provenance, [
      { event_id: 'evt_000001', round: 1, expert_slot_id: 'author', session_id: 'S1' },
    ]);

    // Aucun état, aucun cycle de vie, aucune nature déduite.
    const asRecord = result.entry as unknown as Record<string, unknown>;
    for (const forbidden of ['status', 'state', 'open', 'closed', 'nature', 'winner']) {
      assert.equal(forbidden in asRecord, false, `aucun champ ${forbidden}`);
    }

    assert.equal(result.provider_effect, 'EXACT(0)');
    assert.notEqual(result.controversy_revision, before, 'la révision a bougé');
  } finally {
    await fixture.dispose();
  }
});

test('2 · T26 — la révision rendue est celle de la source après append', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    assert.equal(opened.revision, (await readControversyJournal(fixture.paths)).revision);
    assert.equal(opened.revision, await revisionOf(fixture));

    const assertion = await addAssertion(fixture, opened.controversyId, 'Le TTL doit être court');
    assert.equal(assertion.revision, await revisionOf(fixture));
    assert.notEqual(assertion.revision, opened.revision);
  } finally {
    await fixture.dispose();
  }
});

test('3 · T2 — une révision périmée refuse avant tout append', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    const stale = opened.revision;

    // Une première mutation périme la vue de l'appelant.
    await addAssertion(fixture, opened.controversyId, 'Première position');
    const rawBefore = await rawJournal(fixture);

    await assert.rejects(
      () =>
        recordAssertion(fixture.deps, {
          runId: RUN_ID,
          controversy_id: opened.controversyId,
          expected_controversy_revision: stale,
          provenance_event_ids: ['evt_000001'],
          statement: 'Seconde position',
        }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'STALE_REVISION');
        return true;
      },
    );

    assert.equal(await rawJournal(fixture), rawBefore, 'aucun octet touché sur une vue périmée');
  } finally {
    await fixture.dispose();
  }
});

test('4 · §23 — un refus sur journal ABSENT ne crée pas le fichier', async () => {
  const fixture = await nativeRun();
  try {
    const absent = await revisionOf(fixture);

    // Refus de fraîcheur.
    await assert.rejects(() =>
      recordControversy(fixture.deps, {
        runId: RUN_ID,
        expected_controversy_revision: 'ctv-sha256:0000',
        provenance_event_ids: ['evt_000001'],
        statement: 'x',
      }),
    );
    assert.equal(existsSync(fixture.paths.controversies), false);

    // Refus métier — provenance inconnue —, révision pourtant correcte.
    await assert.rejects(
      () =>
        recordControversy(fixture.deps, {
          runId: RUN_ID,
          expected_controversy_revision: absent,
          provenance_event_ids: ['evt_999999'],
          statement: 'x',
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'PROVENANCE_EVENT_NOT_FOUND');
        return true;
      },
    );
    assert.equal(existsSync(fixture.paths.controversies), false, 'aucune matérialisation par un refus');
  } finally {
    await fixture.dispose();
  }
});

// ==========================================================================
// B. Transcription humaine
// ==========================================================================

test('5 · T3 — une transcription humaine reste HUMAN, à propos d’une source', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);

    const result = await recordHumanTranscription(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: opened.revision,
      about_actor: 'challenger',
      anchor: { event_id: 'evt_000002', quoted_text: 'le cache reste valide', occurrence: 1 },
      statement: 'Challenger affirme que le cache reste valide',
    });

    const entry = result.entry;
    assert.equal(entry.kind, 'ASSERTION_RECORDED');
    assert.equal(entry.semantic_origin.kind, 'HUMAN');
    assert.equal(entry.semantic_origin.about_actor, 'challenger');
    assert.equal(entry.semantic_origin.actor, undefined, 'aucun acteur : l’humain n’a pas d’identité durable');
    assert.equal(entry.recorded_by, 'HUMAN');
    assert.equal(entry.derivation, undefined);

    // Ancrage textuel obligatoire, conservé tel quel, sans décalage stocké.
    assert.deepEqual(entry.anchors.textual, {
      event_id: 'evt_000002',
      quoted_text: 'le cache reste valide',
      occurrence: 1,
    });
    assert.equal('offset' in (entry.anchors.textual as unknown as Record<string, unknown>), false);

    // Au plus une unité sémantique, portée par la forme.
    assert.equal(entry.anchors.semantic?.text, 'Challenger affirme que le cache reste valide');
    assert.equal(entry.anchors.semantic?.semantic_origin.kind, 'HUMAN');
    assert.equal(entry.anchors.semantic?.semantic_origin.about_actor, 'challenger');

    // Provenance dérivée de l'événement ancré.
    assert.deepEqual(entry.anchors.provenance, [
      { event_id: 'evt_000002', round: 1, expert_slot_id: 'challenger', session_id: 'S2' },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('6 · T4 — occurrence hors borne : refus', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    const rawBefore = await rawJournal(fixture);

    for (const [label, anchor] of [
      ['citation introuvable', { event_id: 'evt_000002', quoted_text: 'introuvable', occurrence: 1 }],
      ['occurrence trop haute', { event_id: 'evt_000002', quoted_text: 'aa', occurrence: 3 }],
      ['occurrence nulle', { event_id: 'evt_000002', quoted_text: 'aa', occurrence: 0 }],
      ['citation vide', { event_id: 'evt_000002', quoted_text: '', occurrence: 1 }],
    ] as const) {
      await assert.rejects(
        () =>
          recordHumanTranscription(fixture.deps, {
            runId: RUN_ID,
            controversy_id: opened.controversyId,
            expected_controversy_revision: opened.revision,
            about_actor: 'challenger',
            anchor,
            statement: 'x',
          }),
        (error: unknown) => {
          assert.equal(reasonOf(error), 'ANCHOR_OCCURRENCE_NOT_FOUND', label);
          return true;
        },
        label,
      );
    }

    // « aa » dans « Non : aa … » : l'occurrence 1 existe, la 2 non.
    const ok = await recordHumanTranscription(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: opened.revision,
      about_actor: 'challenger',
      anchor: { event_id: 'evt_000002', quoted_text: 'aa', occurrence: 1 },
      statement: 'x',
    });
    assert.equal(ok.entry.anchors.textual?.occurrence, 1);
    assert.notEqual(await rawJournal(fixture), rawBefore);
  } finally {
    await fixture.dispose();
  }
});

test('7 · occurrences chevauchantes — « aa » dans « aaa », rangs 1 et 2', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    let revision = opened.revision;

    for (const occurrence of [1, 2]) {
      const result = await recordHumanTranscription(fixture.deps, {
        runId: RUN_ID,
        controversy_id: opened.controversyId,
        expected_controversy_revision: revision,
        about_actor: 'author',
        anchor: { event_id: 'evt_000001', quoted_text: 'aa', occurrence },
        statement: `unité ${String(occurrence)}`,
      });
      assert.equal(result.entry.anchors.textual?.occurrence, occurrence);
      revision = result.controversy_revision;
    }

    // La reprise est à `start + 1`, jamais à `start + longueur` : sinon « aaa »
    // ne porterait qu'une occurrence de « aa ».
    await assert.rejects(
      () =>
        recordHumanTranscription(fixture.deps, {
          runId: RUN_ID,
          controversy_id: opened.controversyId,
          expected_controversy_revision: revision,
          about_actor: 'author',
          anchor: { event_id: 'evt_000001', quoted_text: 'aa', occurrence: 3 },
          statement: 'unité 3',
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'ANCHOR_OCCURRENCE_NOT_FOUND');
        return true;
      },
    );
  } finally {
    await fixture.dispose();
  }
});

test('8 · T5 — événement inexistant : refus', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);

    await assert.rejects(
      () =>
        recordHumanTranscription(fixture.deps, {
          runId: RUN_ID,
          controversy_id: opened.controversyId,
          expected_controversy_revision: opened.revision,
          about_actor: 'author',
          anchor: { event_id: 'evt_123456', quoted_text: 'aa', occurrence: 1 },
          statement: 'x',
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'ANCHOR_EVENT_NOT_FOUND');
        return true;
      },
    );
  } finally {
    await fixture.dispose();
  }
});

test('9 · T6 — about_actor incohérent avec la paternité canonique : refus', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);

    // Le fragment existe dans le contenu de l'author ; le prétendre du
    // challenger serait une attribution fabriquée.
    await assert.rejects(
      () =>
        recordHumanTranscription(fixture.deps, {
          runId: RUN_ID,
          controversy_id: opened.controversyId,
          expected_controversy_revision: opened.revision,
          about_actor: 'challenger',
          anchor: { event_id: 'evt_000001', quoted_text: 'Le cache doit expirer', occurrence: 1 },
          statement: 'x',
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'ABOUT_ACTOR_MISMATCH');
        return true;
      },
    );

    // Un événement ADRESSÉ à un expert n'est pas produit par lui : CCR refuse
    // plutôt que de fabriquer la paternité manquante, même si le texte cité
    // s'y trouve mot pour mot.
    await assert.rejects(
      () =>
        recordHumanTranscription(fixture.deps, {
          runId: RUN_ID,
          controversy_id: opened.controversyId,
          expected_controversy_revision: opened.revision,
          about_actor: 'author',
          anchor: { event_id: 'evt_000003', quoted_text: 'Le cache doit expirer', occurrence: 1 },
          statement: 'x',
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'ANCHOR_SOURCE_NOT_ATTRIBUTABLE');
        return true;
      },
    );
  } finally {
    await fixture.dispose();
  }
});

test('10 · T7/T18 — aucun chemin ne produit SOURCE ni MODEL_ASSISTED', async () => {
  // V3-S7-B a ajouté au même module une couture INTERNE de persistance de
  // détection, qui construit légitimement `CCR` + `MODEL_ASSISTED`. La garde
  // est donc bornée à la section S4 — et elle y reste stricte, ce qui prouve
  // que les huit opérations publiques n'ont pas gagné ce pouvoir au passage.
  const whole = codeOnly(await readFile(SERVICE_SOURCE, 'utf8'));
  // Le repère est un identifiant, pas une bannière : les commentaires sont
  // retirés avant la découpe.
  const border = whole.indexOf('interface DetectedRelationProposal');
  assert.ok(border > 0, 'la section de détection est délimitée');
  const code = whole.slice(0, border);
  const detection = whole.slice(border);

  // Aucune de ces valeurs n'existe dans le code des huit opérations.
  for (const forbidden of ["'SOURCE'", '"SOURCE"', 'MODEL_ASSISTED', 'invocation_id', 'derivation: {']) {
    assert.equal(code.includes(forbidden), false, `le code S4 ne contient pas ${forbidden}`);
  }

  // `'CCR'` n'apparaît qu'en position de COMPARAISON — la validation de cible
  // une autorité humaine doit reconnaître une inférence CCR. Jamais en construction.
  for (const construction of ["kind: 'CCR'", "recorded_by: 'CCR'"]) {
    assert.equal(code.includes(construction), false, `aucune construction ${construction}`);
  }
  const ccrOccurrences = code.split("'CCR'").length - 1;
  const ccrComparisons = (code.match(/===\s*'CCR'/g) ?? []).length;
  assert.equal(ccrOccurrences, ccrComparisons, 'toute mention de CCR est une comparaison');

  // Et la couture de détection, elle, ne peut pas exister sans une invocation
  // réelle : elle construit `MODEL_ASSISTED` uniquement avec un `invocation_id`
  // fourni, et refuse une chaîne vide.
  assert.equal(detection.includes("method: 'MODEL_ASSISTED'"), true);
  assert.equal(detection.includes('invocation_id: input.invocation_id'), true);
  assert.equal(detection.includes('input.invocation_id.length === 0'), true);
  // Elle n'est atteignable par aucune des huit opérations.
  for (const publicOp of ['recordAssertion', 'recordRelation', 'recordControversy']) {
    assert.equal(detection.includes(`${publicOp}(`), false, `${publicOp} n'appelle pas la détection`);
  }

  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);

    // Un appelant qui tente d'imposer une origine CCR assistée par modèle :
    // les champs ne sont pas dans le DTO, et l'entrée est construite champ par
    // champ. Rien n'est recopié.
    const forged = {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: opened.revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'tentative',
      semantic_origin: { kind: 'CCR' },
      recorded_by: 'CCR',
      derivation: { method: 'MODEL_ASSISTED', invocation_id: 'inv_1', inputs: [] },
      entry_id: formatControversyEntryId(999),
      schema_version: 42,
      recorded_at: '1999-01-01T00:00:00.000Z',
    };

    const result = await recordAssertion(
      fixture.deps,
      forged as unknown as Parameters<typeof recordAssertion>[1],
    );

    assert.equal(result.entry.semantic_origin.kind, 'HUMAN');
    assert.equal(result.entry.recorded_by, 'HUMAN');
    assert.equal(result.entry.derivation, undefined);
    assert.equal(result.entry.entry_id, formatControversyEntryId(2), 'identité allouée, pas reçue');
    assert.equal(result.entry.schema_version, CONTROVERSY_SCHEMA_VERSION);
    assert.notEqual(result.entry.recorded_at, '1999-01-01T00:00:00.000Z');

    // Et aucune trace de ledger : la gouvernance V2.2 n'a rien à enregistrer.
    assert.equal(existsSync(fixture.paths.invocations), false);
    assert.equal(existsSync(fixture.paths.usage), false);
  } finally {
    await fixture.dispose();
  }
});

// ==========================================================================
// C. Relations
// ==========================================================================

test('11 · T8 — une relation valide devient une nouvelle entrée', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    const a = await addAssertion(fixture, opened.controversyId, 'Position A');
    const b = await addAssertion(fixture, opened.controversyId, 'Position B');

    const result = await recordRelation(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: b.revision,
      provenance_event_ids: ['evt_000001'],
      act: 'CONTESTS',
      from_entry_id: b.entryId,
      to_entry_id: a.entryId,
    });

    assert.equal(result.entry.kind, 'RELATION_RECORDED');
    assert.deepEqual(result.entry.relation, {
      from_entry_id: b.entryId,
      to_entry_id: a.entryId,
      act: 'CONTESTS',
    });
    assert.equal(result.entry.semantic_origin.kind, 'HUMAN');

    // Aucune identité de position n'apparaît.
    const asRecord = result.entry as unknown as Record<string, unknown>;
    for (const forbidden of ['position_id', 'same_position', 'confidence']) {
      assert.equal(forbidden in asRecord, false);
    }

    // La réciprocité n'est pas interdite : aucune règle globale de cycle.
    const reciprocal = await recordRelation(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: result.controversy_revision,
      provenance_event_ids: ['evt_000001'],
      act: 'CONTESTS',
      from_entry_id: a.entryId,
      to_entry_id: b.entryId,
    });
    assert.equal(reciprocal.entry.kind, 'RELATION_RECORDED');
  } finally {
    await fixture.dispose();
  }
});

test('12 · T9/T10 — relation inter-controverses et auto-référence : refus', async () => {
  const fixture = await nativeRun();
  try {
    const first = await openControversy(fixture);
    const a = await addAssertion(fixture, first.controversyId, 'Position A');

    const second = await recordControversy(fixture.deps, {
      runId: RUN_ID,
      expected_controversy_revision: a.revision,
      provenance_event_ids: ['evt_000002'],
      statement: 'Autre sujet',
    });
    const other = await addAssertion(fixture, second.controversy_id, 'Position externe');
    const rawBefore = await rawJournal(fixture);

    // Cross-controverse.
    await assert.rejects(
      () =>
        recordRelation(fixture.deps, {
          runId: RUN_ID,
          controversy_id: first.controversyId,
          expected_controversy_revision: other.revision,
          provenance_event_ids: ['evt_000001'],
          act: 'CONTESTS',
          from_entry_id: a.entryId,
          to_entry_id: other.entryId,
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'ENTRY_OUTSIDE_CONTROVERSY');
        return true;
      },
    );

    // Auto-référence.
    await assert.rejects(
      () =>
        recordRelation(fixture.deps, {
          runId: RUN_ID,
          controversy_id: first.controversyId,
          expected_controversy_revision: other.revision,
          provenance_event_ids: ['evt_000001'],
          act: 'CONTESTS',
          from_entry_id: a.entryId,
          to_entry_id: a.entryId,
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'RELATION_SELF_REFERENCE');
        return true;
      },
    );

    // Cible inexistante.
    await assert.rejects(
      () =>
        recordRelation(fixture.deps, {
          runId: RUN_ID,
          controversy_id: first.controversyId,
          expected_controversy_revision: other.revision,
          provenance_event_ids: ['evt_000001'],
          act: 'CONTESTS',
          from_entry_id: a.entryId,
          to_entry_id: formatControversyEntryId(900),
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'ENTRY_NOT_FOUND');
        return true;
      },
    );

    assert.equal(await rawJournal(fixture), rawBefore, 'aucun refus n’a écrit');
  } finally {
    await fixture.dispose();
  }
});

test('13 · T11 — extrémités et cibles interdites : refus', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    const a = await addAssertion(fixture, opened.controversyId, 'Position A');

    const nature = await recordNature(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: a.revision,
      provenance_event_ids: ['evt_000001'],
      nature: 'désaccord de méthode',
    });
    const authority = await recordHumanAuthority(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: nature.controversy_revision,
      provenance_event_ids: ['evt_000001'],
      scope: 'périmètre : choix du TTL',
    });
    let revision = authority.controversy_revision;

    // Ni la nature ni l'autorité ne sont des unités sémantiques contestables.
    for (const forbidden of [nature.entry.entry_id, authority.entry.entry_id]) {
      await assert.rejects(
        () =>
          recordRelation(fixture.deps, {
            runId: RUN_ID,
            controversy_id: opened.controversyId,
            expected_controversy_revision: revision,
            provenance_event_ids: ['evt_000001'],
            act: 'CONTESTS',
            from_entry_id: a.entryId,
            to_entry_id: forbidden,
          }),
        (error: unknown) => {
          assert.equal(reasonOf(error), 'RELATION_ENDPOINT_KIND_FORBIDDEN');
          return true;
        },
      );
    }

    // REFORMULATES et WITHDRAWS visent une assertion : l'enregistrement de la
    // controverse n'en est pas une.
    for (const act of ['REFORMULATES', 'WITHDRAWS'] as const) {
      await assert.rejects(
        () =>
          recordRelation(fixture.deps, {
            runId: RUN_ID,
            controversy_id: opened.controversyId,
            expected_controversy_revision: revision,
            provenance_event_ids: ['evt_000001'],
            act,
            from_entry_id: a.entryId,
            to_entry_id: opened.entryId,
          }),
        (error: unknown) => {
          assert.equal(reasonOf(error), 'RELATION_TARGET_NOT_ASSERTION');
          return true;
        },
        act,
      );
    }

    // Et la même cible acceptée lorsqu'elle est bien une assertion.
    const b = await addAssertion(fixture, opened.controversyId, 'Position B');
    revision = b.revision;
    const ok = await recordRelation(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: revision,
      provenance_event_ids: ['evt_000001'],
      act: 'REFORMULATES',
      from_entry_id: b.entryId,
      to_entry_id: a.entryId,
    });
    assert.equal(ok.entry.relation?.act, 'REFORMULATES');
  } finally {
    await fixture.dispose();
  }
});

test('14 · T12 — WITHDRAWS n’efface rien : l’assertion visée reste lisible', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    const a = await addAssertion(fixture, opened.controversyId, 'Position retirée');
    const b = await addAssertion(fixture, opened.controversyId, 'Position tenante');
    const targetBefore = (await entriesOf(fixture)).find((entry) => entry.entry_id === a.entryId);

    await recordRelation(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: b.revision,
      provenance_event_ids: ['evt_000001'],
      act: 'WITHDRAWS',
      from_entry_id: b.entryId,
      to_entry_id: a.entryId,
    });

    const after = await entriesOf(fixture);
    const targetAfter = after.find((entry) => entry.entry_id === a.entryId);
    assert.deepEqual(targetAfter, targetBefore, 'la cible est inchangée, octet pour octet');

    const asRecord = targetAfter as unknown as Record<string, unknown>;
    for (const forbidden of ['active', 'withdrawn', 'superseded', 'status']) {
      assert.equal(forbidden in asRecord, false, `aucun champ ${forbidden}`);
    }

    // Et la lecture S3 continue de la rendre.
    const snapshot = await readStableNativeRunSnapshot(fixture.runsDir, RUN_ID);
    const projection = projectControversyReadModel(snapshot);
    assert.equal(projection.availability, 'AVAILABLE');
    if (projection.availability !== 'AVAILABLE') throw new Error('inatteignable');
    const item = projection.items.find((candidate) => candidate.controversy_id === opened.controversyId);
    assert.ok(item?.entries.some((entry) => entry.entry_id === a.entryId), 'toujours visible après retrait');
  } finally {
    await fixture.dispose();
  }
});

// ==========================================================================
// D. Autorité humaine
// ==========================================================================

test('15 · T13/T14 — confirmer et contester une inférence CCR, sans la toucher', async () => {
  for (const act of ['CONFIRM_RELATION', 'CONTEST_RELATION'] as const) {
    const fixture = await nativeRun();
    try {
      const opened = await openControversy(fixture);
      const a = await addAssertion(fixture, opened.controversyId, 'Position A');
      const b = await addAssertion(fixture, opened.controversyId, 'Position B');
      const inferenceId = await seedCcrRelationInference(
        fixture,
        opened.controversyId,
        b.entryId,
        a.entryId,
      );
      const inferenceBefore = (await entriesOf(fixture)).find((e) => e.entry_id === inferenceId);

      const respond = act === 'CONFIRM_RELATION' ? confirmInferredRelation : contestInferredRelation;
      const result = await respond(fixture.deps, {
        runId: RUN_ID,
        controversy_id: opened.controversyId,
        expected_controversy_revision: await revisionOf(fixture),
        provenance_event_ids: ['evt_000001'],
        target_entry_id: inferenceId,
      });

      assert.equal(result.entry.kind, 'HUMAN_AUTHORITY_RECORDED');
      assert.equal(result.entry.semantic_origin.kind, 'HUMAN');
      assert.equal(result.entry.recorded_by, 'HUMAN');
      assert.equal(result.entry.authority?.act, act, 'acte server-authoritative');
      assert.equal(result.entry.authority?.target_entry_id, inferenceId);
      assert.equal(result.entry.derivation, undefined);

      // L'inférence visée est intacte : origine, dérivation, charge.
      const inferenceAfter = (await entriesOf(fixture)).find((e) => e.entry_id === inferenceId);
      assert.deepEqual(inferenceAfter, inferenceBefore);
      assert.equal(inferenceAfter?.semantic_origin.kind, 'CCR');

      // Aucun état de vérité n'apparaît.
      const asRecord = result.entry as unknown as Record<string, unknown>;
      for (const forbidden of ['confirmed', 'resolved', 'verdict', 'truth', 'winner']) {
        assert.equal(forbidden in asRecord, false);
      }
    } finally {
      await fixture.dispose();
    }
  }
});

test('16 · T15 — une cible qui n’est pas une inférence CCR de relation : refus', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    const a = await addAssertion(fixture, opened.controversyId, 'Position A');
    const b = await addAssertion(fixture, opened.controversyId, 'Position B');

    const humanRelation = await recordRelation(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: b.revision,
      provenance_event_ids: ['evt_000001'],
      act: 'CONTESTS',
      from_entry_id: b.entryId,
      to_entry_id: a.entryId,
    });
    const nature = await recordNature(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: humanRelation.controversy_revision,
      provenance_event_ids: ['evt_000001'],
      nature: 'désaccord de méthode',
    });
    const authority = await recordHumanAuthority(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: nature.controversy_revision,
      provenance_event_ids: ['evt_000001'],
      scope: 'périmètre',
    });

    const revision = authority.controversy_revision;
    const rawBefore = await rawJournal(fixture);

    const forbidden: readonly (readonly [string, string])[] = [
      ['relation HUMAN', humanRelation.entry.entry_id],
      ['assertion humaine', a.entryId],
      ['NATURE_RECORDED', nature.entry.entry_id],
      ['HUMAN_AUTHORITY_RECORDED', authority.entry.entry_id],
      ['CONTROVERSY_RECORDED', opened.entryId],
    ];

    for (const [label, target] of forbidden) {
      for (const respond of [confirmInferredRelation, contestInferredRelation]) {
        await assert.rejects(
          () =>
            respond(fixture.deps, {
              runId: RUN_ID,
              controversy_id: opened.controversyId,
              expected_controversy_revision: revision,
              provenance_event_ids: ['evt_000001'],
              target_entry_id: target,
            }),
          (error: unknown) => {
            assert.equal(reasonOf(error), 'AUTHORITY_TARGET_NOT_CCR_RELATION', label);
            return true;
          },
          label,
        );
      }
    }

    assert.equal(await rawJournal(fixture), rawBefore);
  } finally {
    await fixture.dispose();
  }
});

test('17 · T16/T17 — les quatre séquences de réponse humaine sont admises', async () => {
  const sequences: readonly (readonly ['CONFIRM_RELATION' | 'CONTEST_RELATION', 'CONFIRM_RELATION' | 'CONTEST_RELATION'])[] = [
    ['CONFIRM_RELATION', 'CONTEST_RELATION'],
    ['CONTEST_RELATION', 'CONFIRM_RELATION'],
    ['CONFIRM_RELATION', 'CONFIRM_RELATION'],
    ['CONTEST_RELATION', 'CONTEST_RELATION'],
  ];

  for (const [first, second] of sequences) {
    const fixture = await nativeRun();
    try {
      const opened = await openControversy(fixture);
      const a = await addAssertion(fixture, opened.controversyId, 'Position A');
      const b = await addAssertion(fixture, opened.controversyId, 'Position B');
      const inferenceId = await seedCcrRelationInference(fixture, opened.controversyId, b.entryId, a.entryId);

      for (const act of [first, second]) {
        const respond = act === 'CONFIRM_RELATION' ? confirmInferredRelation : contestInferredRelation;
        await respond(fixture.deps, {
          runId: RUN_ID,
          controversy_id: opened.controversyId,
          expected_controversy_revision: await revisionOf(fixture),
          provenance_event_ids: ['evt_000001'],
          target_entry_id: inferenceId,
        });
      }

      // Deux entrées distinctes, dans l'ordre, aucune ne remplaçant l'autre.
      const authorities = (await entriesOf(fixture)).filter(
        (entry) => entry.kind === 'HUMAN_AUTHORITY_RECORDED',
      );
      assert.deepEqual(
        authorities.map((entry) => entry.authority?.act),
        [first, second],
        `${first} → ${second}`,
      );
      assert.notEqual(authorities[0]?.entry_id, authorities[1]?.entry_id);

      // Et la lecture S3 les rend toutes les deux, dans le même ordre.
      const projection = projectControversyReadModel(
        await readStableNativeRunSnapshot(fixture.runsDir, RUN_ID),
      );
      if (projection.availability !== 'AVAILABLE') throw new Error('inatteignable');
      const item = projection.items.find((candidate) => candidate.controversy_id === opened.controversyId);
      assert.equal(item?.authority_entries.length, 2);
    } finally {
      await fixture.dispose();
    }
  }
});

// ==========================================================================
// E. Nature, bornes, doublons
// ==========================================================================

test('18 · T20 — la nature est libre, attribuée, et bornée', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    let revision = opened.revision;

    // Vocabulaire non exhaustif : aucune énumération fermée n'est imposée.
    for (const nature of ['désaccord de méthode', 'ambiguïté de spécification', 'ᚦ libellé inédit']) {
      const result = await recordNature(fixture.deps, {
        runId: RUN_ID,
        controversy_id: opened.controversyId,
        expected_controversy_revision: revision,
        provenance_event_ids: ['evt_000001'],
        nature,
      });
      assert.equal(result.entry.kind, 'NATURE_RECORDED');
      assert.equal(result.entry.content, nature);
      assert.equal(result.entry.semantic_origin.kind, 'HUMAN');
      const asRecord = result.entry as unknown as Record<string, unknown>;
      assert.equal('score' in asRecord, false, 'aucun scoring');
      revision = result.controversy_revision;
    }

    // Refus plutôt que troncature.
    const rawBefore = await rawJournal(fixture);
    await assert.rejects(
      () =>
        recordNature(fixture.deps, {
          runId: RUN_ID,
          controversy_id: opened.controversyId,
          expected_controversy_revision: revision,
          provenance_event_ids: ['evt_000001'],
          nature: 'x'.repeat(MAX_CONTROVERSY_TEXT_BYTES + 1),
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'CONTENT_TOO_LARGE');
        return true;
      },
    );
    assert.equal(await rawJournal(fixture), rawBefore, 'rien n’est écrit, rien n’est tronqué');
  } finally {
    await fixture.dispose();
  }
});

test('19 · T25 — deux gestes humains identiques, et la garde de doublon exact', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    const a = await addAssertion(fixture, opened.controversyId, 'Position A');
    const b = await addAssertion(fixture, opened.controversyId, 'Position B');
    const inferenceId = await seedCcrRelationInference(fixture, opened.controversyId, b.entryId, a.entryId);

    // Une autorité humaine n'est PAS idempotente : deux confirmations
    // successives sont deux faits historiques distincts.
    for (let i = 0; i < 2; i += 1) {
      await confirmInferredRelation(fixture.deps, {
        runId: RUN_ID,
        controversy_id: opened.controversyId,
        expected_controversy_revision: await revisionOf(fixture),
        provenance_event_ids: ['evt_000001'],
        target_entry_id: inferenceId,
      });
    }
    assert.equal(
      (await entriesOf(fixture)).filter((entry) => entry.kind === 'HUMAN_AUTHORITY_RECORDED').length,
      2,
      'aucune déduplication sur un geste d’autorité',
    );

    // Une assertion strictement identique, elle, tombe sous la garde de
    // doublon EXACT du contrat — jamais sous une similarité sémantique.
    const beforeDuplicate = await revisionOf(fixture);
    await assert.rejects(
      () =>
        recordAssertion(fixture.deps, {
          runId: RUN_ID,
          controversy_id: opened.controversyId,
          expected_controversy_revision: beforeDuplicate,
          provenance_event_ids: ['evt_000001'],
          statement: 'Position A',
        }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'EXACT_DUPLICATE');
        return true;
      },
    );

    // Une formulation voisine n'est jamais dédupliquée : ce serait une
    // inférence non attribuée.
    const near = await recordAssertion(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: await revisionOf(fixture),
      provenance_event_ids: ['evt_000001'],
      statement: 'Position A ',
    });
    assert.equal(near.entry.kind, 'ASSERTION_RECORDED');
  } finally {
    await fixture.dispose();
  }
});

// ==========================================================================
// F. Frontière S2 sous mutation réelle
// ==========================================================================

test('20 · T22 — une queue non écrite est normalisée sous le verrou de la mutation', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    const written = await readFile(fixture.paths.controversies, 'utf8');

    // Le fragment est ajouté APRÈS coup, et n'est pas contourné : la mutation
    // métier le rencontre telle quelle.
    await writeFile(fixture.paths.controversies, `${written}{"partial":`, 'utf8');

    const journalWithTail = await readControversyJournal(fixture.paths);
    assert.equal(journalWithTail.has_unwritten_tail, true);
    assert.equal(journalWithTail.revision, opened.revision, 'un octet non écrit ne périme rien');

    const result = await recordAssertion(fixture.deps, {
      runId: RUN_ID,
      controversy_id: opened.controversyId,
      expected_controversy_revision: opened.revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'Position après queue',
    });

    const after = await readControversyJournal(fixture.paths);
    assert.equal(after.has_unwritten_tail, false);
    assert.equal(after.entries.length, 2);
    assert.equal(after.revision, result.controversy_revision);

    const raw = await readFile(fixture.paths.controversies, 'utf8');
    assert.equal(raw.includes('{"partial":'), false, 'la queue non écrite a disparu');
    assert.equal(raw.startsWith(written), true, 'le préfixe autoritaire est intact');
  } finally {
    await fixture.dispose();
  }
});

test('21 · T23/T24 — corruption terminée et version inconnue font échouer la mutation', async () => {
  const valid = JSON.stringify({
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(1),
    controversy_id: formatControversyId(1),
    kind: 'CONTROVERSY_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-17T10:00:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
    content: 'sujet',
  });
  const unknownVersion = JSON.stringify({
    ...(JSON.parse(valid) as Record<string, unknown>),
    entry_id: formatControversyEntryId(2),
    schema_version: CONTROVERSY_SCHEMA_VERSION + 1,
  });

  const cases: readonly (readonly [string, string])[] = [
    ['ligne terminée invalide', `${valid}\n{"broken":\n`],
    ['version terminée inconnue', `${valid}\n${unknownVersion}\n`],
  ];

  for (const [label, content] of cases) {
    const fixture = await nativeRun();
    try {
      await writeFile(fixture.paths.controversies, content, 'utf8');

      await assert.rejects(
        () =>
          recordAssertion(fixture.deps, {
            runId: RUN_ID,
            controversy_id: formatControversyId(1),
            expected_controversy_revision: 'ctv-sha256:peu-importe',
            provenance_event_ids: ['evt_000001'],
            statement: 'x',
          }),
        label,
      );

      // Ni réparation, ni troncature, ni append : les octets sont ceux d'avant.
      assert.equal(await readFile(fixture.paths.controversies, 'utf8'), content, `${label} : octets intacts`);
    } finally {
      await fixture.dispose();
    }
  }
});

// ==========================================================================
// G. Legacy
// ==========================================================================

test('22 · T21 — un run legacy refuse toute mutation V3, sans créer de journal', async () => {
  const fixture = await nativeRun({ legacy: true });
  try {
    await assert.rejects(
      () =>
        recordControversy(fixture.deps, {
          runId: RUN_ID,
          expected_controversy_revision: 'ctv-sha256:peu-importe',
          provenance_event_ids: ['evt_000001'],
          statement: 'x',
        }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'SCHEMA_VERSION_UNSUPPORTED');
        return true;
      },
    );

    assert.equal(existsSync(fixture.paths.controversies), false, 'aucun journal V3 sur un run historique');
    assert.equal(existsSync(fixture.paths.decisions), false, 'decisions.jsonl n’est pas réveillé');
  } finally {
    await fixture.dispose();
  }
});

// ==========================================================================
// H. Sérialisation
// ==========================================================================

test('23 · §32 — deux mutations parties de la même révision : une seule aboutit', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    const shared = opened.revision;

    const attempt = (statement: string): Promise<unknown> =>
      recordAssertion(fixture.deps, {
        runId: RUN_ID,
        controversy_id: opened.controversyId,
        expected_controversy_revision: shared,
        provenance_event_ids: ['evt_000001'],
        statement,
      });

    // Séquentiel : la seconde entre sous le verrou et observe R2.
    await attempt('A');
    await assert.rejects(() => attempt('B'), (error: unknown) => {
      assert.equal(codeOf(error), 'STALE_REVISION');
      return true;
    });

    let entries = await entriesOf(fixture);
    assert.equal(entries.length, 2, 'aucune lost update');

    // Réellement concurrent : le verrou n'est pas réentrant, donc la seconde
    // échoue — soit sur le verrou, soit sur la fraîcheur. Jamais deux appends.
    const revision = await revisionOf(fixture);
    const race = await Promise.allSettled([
      recordAssertion(fixture.deps, {
        runId: RUN_ID,
        controversy_id: opened.controversyId,
        expected_controversy_revision: revision,
        provenance_event_ids: ['evt_000001'],
        statement: 'C',
      }),
      recordAssertion(fixture.deps, {
        runId: RUN_ID,
        controversy_id: opened.controversyId,
        expected_controversy_revision: revision,
        provenance_event_ids: ['evt_000001'],
        statement: 'D',
      }),
    ]);

    assert.equal(race.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    for (const outcome of race) {
      if (outcome.status === 'rejected') {
        assert.ok(
          ['RUN_ALREADY_LOCKED', 'STALE_REVISION'].includes(String(codeOf(outcome.reason))),
          `refus attendu, obtenu ${String(codeOf(outcome.reason))}`,
        );
      }
    }

    entries = await entriesOf(fixture);
    assert.equal(entries.length, 3, 'exactement un append supplémentaire');
    assert.equal(
      new Set(entries.map((entry) => entry.entry_id)).size,
      entries.length,
      'aucune double allocation d’entry_id',
    );
  } finally {
    await fixture.dispose();
  }
});

// ==========================================================================
// I. Conformité croisée S3/S4 et garde de modèle interdit
// ==========================================================================

test('24 · la règle d’occurrence de S4 est celle de la projection S3', async () => {
  const fixture = await nativeRun();
  try {
    const opened = await openControversy(fixture);
    let revision = opened.revision;

    const cases: readonly (readonly [string, number, boolean])[] = [
      ['aa', 1, true],
      ['aa', 2, true],
      ['aa', 3, false],
      ['aaa', 1, true],
      ['aaa', 2, false],
      ['introuvable', 1, false],
    ];

    for (const [quoted, occurrence, resolvable] of cases) {
      const label = `${quoted}#${String(occurrence)}`;

      // S4 — validation à l'écriture.
      let acceptedByS4 = true;
      let entryId: string | undefined;
      try {
        const result = await recordHumanTranscription(fixture.deps, {
          runId: RUN_ID,
          controversy_id: opened.controversyId,
          expected_controversy_revision: revision,
          about_actor: 'author',
          anchor: { event_id: 'evt_000001', quoted_text: quoted, occurrence },
          statement: label,
        });
        revision = result.controversy_revision;
        entryId = result.entry.entry_id;
      } catch {
        acceptedByS4 = false;
      }
      assert.equal(acceptedByS4, resolvable, `S4 : ${label}`);

      if (!resolvable) continue;

      // S3 — projection : le même ancrage doit être jugé résolu.
      const projection = projectControversyReadModel(
        await readStableNativeRunSnapshot(fixture.runsDir, RUN_ID),
      );
      if (projection.availability !== 'AVAILABLE') throw new Error('inatteignable');
      const item = projection.items.find((candidate) => candidate.controversy_id === opened.controversyId);
      assert.equal(
        item?.unresolvable_anchors.some((anchor) => anchor.entry_id === entryId),
        false,
        `S3 : ${label} doit se résoudre aussi`,
      );
    }
  } finally {
    await fixture.dispose();
  }
});

test('25 · garde de modèle : aucune primitive S4 n’introduit d’état ni de vérité', async () => {
  const source = codeOnly(await readFile(SERVICE_SOURCE, 'utf8'));

  const forbidden = [
    'position_id',
    'same_position',
    'current_position',
    'CONVERGED',
    'agreement_score',
    'resolution_score',
    'confidence',
    'similarity',
    'InvocationLedger',
    'invocation-ledger',
    'usage-governance',
    'adapter',
    'spawn',
    'execFile',
    'node:http',
    'fetch(',
  ];
  for (const token of forbidden) {
    assert.equal(source.includes(token), false, `le service S4 ne contient pas « ${token} »`);
  }

  // Aucun statut agrégé ni gagnant : les mots ne sont pas des identifiants ici.
  for (const pattern of [/\bstatus\s*[:=]/, /\bwinner\b/, /\bclosure\b/, /\bdisposition\b/]) {
    assert.equal(pattern.test(source), false, `motif interdit ${String(pattern)}`);
  }

  // Le service passe bien par la frontière de mutation gelée, et par elle seule.
  assert.equal(source.includes('withNativeMutation'), true);
  assert.equal(source.includes('withRunLock'), false, 'aucun verrou pris hors de la frontière');
  assert.equal(source.includes('appendJsonLine'), false, 'aucune écriture hors de la primitive S2');
});

test('26 · le résultat de mutation ne devient pas un second read model', async () => {
  const fixture = await nativeRun();
  try {
    const result = await recordControversy(fixture.deps, {
      runId: RUN_ID,
      expected_controversy_revision: await revisionOf(fixture),
      provenance_event_ids: ['evt_000001'],
      statement: 'sujet',
    });

    assert.deepEqual(Object.keys(result).sort(), [
      'controversy_id',
      'controversy_revision',
      'entry',
      'provider_effect',
    ]);

    // Ni items, ni regroupement, ni compteur : la lecture complète reste S3.
    const asRecord = result as unknown as Record<string, unknown>;
    for (const forbidden of ['items', 'recorded_count', 'availability', 'entries']) {
      assert.equal(forbidden in asRecord, false, `aucun champ ${forbidden}`);
    }

    // Et la projection S3 lit bien ce qui vient d'être écrit.
    const snapshot: NativeRunSnapshot = await readStableNativeRunSnapshot(fixture.runsDir, RUN_ID);
    const projection = projectControversyReadModel(snapshot);
    if (projection.availability !== 'AVAILABLE') throw new Error('inatteignable');
    assert.equal(projection.recorded_count, 1);
    assert.equal(projection.items[0]?.opening?.entry_id, result.entry.entry_id);
  } finally {
    await fixture.dispose();
  }
});
