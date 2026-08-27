/**
 * V4 · S7-C — frontière de disponibilité et voie d'acceptation contrôlée.
 *
 * Question de preuve :
 *
 * > **Le fait que le pipeline fonctionne peut-il, par lui-même, rendre la
 * > fonctionnalité disponible à un utilisateur ?**
 *
 * Quatre propriétés.
 *
 *  1. **Implémenté n'est pas disponible.** Les deux faits sont indépendants, et
 *     le second reste `NOT_AVAILABLE` alors même que le premier est vrai et que
 *     le pipeline traverse tout, de bout en bout, dans ces tests.
 *  2. **La porte fermée ne coûte rien.** Un refus ne lit aucun run, n'alloue
 *     aucune identité, ne consomme aucun quota, n'engage aucune invocation,
 *     n'appelle aucun adaptateur et n'écrit aucun octet.
 *  3. **Un seul pipeline, deux portes.** La voie d'acceptation franchit
 *     l'exposition publique, et rien d'autre : quota, engagement, parseur,
 *     liaison, revalidation et persistance restent tous actifs.
 *  4. **Aucune surface n'atteint la voie d'acceptation.** Ni CLI, ni HTTP, ni
 *     cockpit — et aucun drapeau d'appelant ne contourne la disponibilité.
 *
 * Aucun fournisseur réel : l'adaptateur est une couture de test injectée.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { AdductionRecordedEntry, EvidenceEntry } from '../../src/core/evidence.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { readEvidenceJournal } from '../../src/store/evidence-store.ts';
import { readControversyJournal } from '../../src/store/controversy-store.ts';
import { readCurrentEvidenceRevision } from '../../src/services/evidence-freshness.ts';
import { recordAssertion, recordControversy } from '../../src/services/controversy-service.ts';
import type { ControversyServiceDeps } from '../../src/services/controversy-service.ts';
import { registerMaterial } from '../../src/services/evidence-service.ts';
import type { EvidenceServiceDeps } from '../../src/services/evidence-service.ts';
import {
  ADDUCTION_PROPOSAL_VERSION,
  MODEL_ADDUCTION_DOMAIN_OUTCOMES,
  MODEL_ADDUCTION_IMPLEMENTED,
  MODEL_ADDUCTION_RUNTIME_AVAILABILITY,
  requestModelAdduction,
  runControlledAcceptanceAdduction,
} from '../../src/services/evidence-adducer.ts';
import type {
  ModelAdductionAcceptanceAuthorization,
  ModelAdductionDeps,
  ModelAdductionOutcome,
  ModelAdductionRequest,
} from '../../src/services/evidence-adducer.ts';

const RUN_ID = 'CCR-20260818-911';
const SRC = new URL('../../src/', import.meta.url);
const ADDUCER = new URL('services/evidence-adducer.ts', SRC);

/** L'autorisation du gate, telle que seul un appel interne peut la construire. */
const AUTHORIZATION: ModelAdductionAcceptanceAuthorization = {
  gate: 'S10_REAL_ADDUCTION_ACCEPTANCE',
  humanAuthorization: 'gate S7-C : adaptateur doublé, aucune validation REAL',
};

const HELD_TEXT = 'Mesure : le cache expire en 30 s.';

const EVENTS: readonly Record<string, unknown>[] = [
  {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-18T09:10:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'S1',
    content: 'Le cache doit expirer rapidement.',
  },
];

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface AdapterScript {
  readonly content?: string;
  readonly fail?: Error;
  readonly onCall?: () => Promise<void> | void;
}

function fakeAdapter(kind: 'claude' | 'codex', script: AdapterScript): AgentAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind,
    calls,
    async start(prompt: string): Promise<AgentTurnResult> {
      calls.push(prompt);
      await script.onCall?.();
      if (script.fail !== undefined) throw script.fail;
      return {
        agent: kind,
        sessionId: `s7c-${kind}`,
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
  readonly deps: ModelAdductionDeps;
  readonly evidence: EvidenceServiceDeps;
  readonly controversy: ControversyServiceDeps;
  calls(): number;
  dispose(): Promise<void>;
}

async function harness(script: AdapterScript = {}): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s7c-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-08-18T09:00:00.000Z',
      title: 'S7-C',
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
  await writeFile(paths.events, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const adapters = { claude: fakeAdapter('claude', script), codex: fakeAdapter('codex', script) };
  let tick = 0;
  const now = (): Date => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 18, 12, 0, tick));
  };

  return {
    runsDir,
    paths,
    deps: { runsDir, now, createAdapters: () => adapters },
    evidence: { runsDir, now },
    controversy: { runsDir, now },
    calls: () => adapters.claude.calls.length + adapters.codex.calls.length,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

interface Seed {
  readonly opening: string;
  readonly a: string;
  readonly foreign: string;
  readonly held: string;
}

async function seed(h: Harness): Promise<Seed> {
  const opened = await recordControversy(h.controversy, {
    runId: RUN_ID,
    expected_controversy_revision: (await readControversyJournal(h.paths)).revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Durée de vie du cache',
  });
  const a = await recordAssertion(h.controversy, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: opened.controversy_revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Le TTL doit être court',
  });
  const other = await recordControversy(h.controversy, {
    runId: RUN_ID,
    expected_controversy_revision: a.controversy_revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Autre sujet',
  });
  const held = await registerMaterial(h.evidence, {
    runId: RUN_ID,
    expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID),
    representation: { form: 'INLINE_TEXT', text: HELD_TEXT },
  });
  return {
    opening: opened.entry.entry_id,
    a: a.entry.entry_id,
    foreign: other.entry.entry_id,
    held: held.entry.entry_id,
  };
}

function requestOf(s: Seed): ModelAdductionRequest {
  return {
    runId: RUN_ID,
    material_id: s.held,
    controversy_opening_entry_id: s.opening,
    expert_slot: 'author',
  };
}

function output(proposals: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ adduction_proposal_version: ADDUCTION_PROPOSAL_VERSION, proposals });
}

function proposal(target: string, orientation = 'SUPPORTS'): Record<string, unknown> {
  return { material_id: 'mat_000001', target_entry_id: target, orientation };
}

async function modelAdductions(h: Harness): Promise<readonly AdductionRecordedEntry[]> {
  const journal = await readEvidenceJournal(h.paths);
  return journal.entries.filter(
    (e: EvidenceEntry): e is AdductionRecordedEntry =>
      e.kind === 'ADDUCTION_RECORDED' && e.semantic_origin === 'CCR',
  );
}

/** Source exécutable : commentaires retirés, jamais la prose. */
function codeOnly(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

async function section3(): Promise<string> {
  const raw = await readFile(ADDUCER, 'utf8');
  const start = raw.indexOf('// SECTION 3/3');
  assert.ok(start > 0, 'la section 3/3 est marquée');
  return codeOnly(raw.slice(start));
}

// ==========================================================================
// A. Deux faits indépendants
// ==========================================================================

test('1 · T1/T2 — implémenté et disponible restent DEUX faits distincts', () => {
  assert.equal(MODEL_ADDUCTION_IMPLEMENTED, true);
  // Vérité post-S10 : la porte a été levée par un changement de code adossé au
  // verdict du micro-gate REAL. Elle ne s'est pas levée d'elle-même, et rien
  // dans l'exécution ne la modifie.
  assert.equal(MODEL_ADDUCTION_RUNTIME_AVAILABILITY, 'AVAILABLE');

  // La propriété que ce test garde n'a PAS changé : aucun raisonnement ne
  // reconstruit l'un depuis l'autre. Ce sont deux déclarations séparées, de
  // deux types différents, et le code ne dérive jamais la seconde de la
  // première — c'est ce que le test 3 vérifie sur la source.
  assert.equal(typeof MODEL_ADDUCTION_IMPLEMENTED, 'boolean');
  assert.equal(typeof MODEL_ADDUCTION_RUNTIME_AVAILABILITY, 'string');
});

test('2 · T23 — six issues de domaine, et aucune septième', () => {
  assert.deepEqual([...MODEL_ADDUCTION_DOMAIN_OUTCOMES], [
    'PERSISTED',
    'VALID_ZERO',
    'NOT_AVAILABLE',
    'INVALID_OUTPUT',
    'REVALIDATION_REFUSED',
    'PROVIDER_FAILED',
  ]);
  for (const absent of [
    'UNKNOWN_AFTER_COMMITMENT',
    'PARTIAL',
    'PARTIAL_SUCCESS',
    'PARTIALLY_VALIDATED',
    'RETRYING',
    'RECOVERING',
    'CONVERGED',
  ]) {
    assert.equal(
      (MODEL_ADDUCTION_DOMAIN_OUTCOMES as readonly string[]).includes(absent),
      false,
      absent,
    );
  }
});

test('3 · T16 — la disponibilité est SERVICE-AUTORITAIRE, dérivée de rien', async () => {
  const code = await section3();

  // Elle n'est calculée depuis aucun signal d'environnement, de fichier, de
  // configuration, d'identifiant ou de comptage. C'est une déclaration — et le
  // rester est exactement ce que sa levée en S10 devait préserver.
  assert.ok(
    /export const MODEL_ADDUCTION_RUNTIME_AVAILABILITY: ModelAdductionAvailability = 'AVAILABLE';/
      .test(code),
    'la valeur est littérale',
  );
  for (const source of [
    'process.env', 'existsSync', 'readFile', 'readdir', 'stat(', 'credential', 'apiKey',
    'openInvocationLedger', 'count()', 'createAdapters', 'config', 'let MODEL_ADDUCTION',
  ]) {
    assert.equal(code.includes(source), false, `disponibilité dérivée de « ${source} »`);
  }
  // Et rien ne l'ÉCRIT : ni la porte, ni la voie d'acceptation, ni un test.
  assert.equal(code.includes('MODEL_ADDUCTION_RUNTIME_AVAILABILITY ='), false);
  assert.equal(
    (code.match(/MODEL_ADDUCTION_RUNTIME_AVAILABILITY/g) ?? []).length,
    3,
    'déclarée une fois, lue par la porte, rendue dans son issue — rien de plus',
  );
});

// ==========================================================================
// B. La porte publique est réellement fermée
// ==========================================================================

test('4 · T3/T4/T5/T6/T7 — porte OUVERTE : elle dispatche, et transmet', async () => {
  const h = await harness({ content: output([proposal('ctve_000002')]) });
  try {
    const s = await seed(h);

    const outcome = await requestModelAdduction(h.deps, requestOf(s));

    // Depuis l'activation, la porte laisse passer — vers le MÊME pipeline.
    assert.equal(outcome.kind, 'DISPATCHED');
    assert.equal('availability' in outcome, false, 'plus un refus de disponibilité');
    assert.equal(h.calls(), 1, 'un dispatch, un seul');

    if (outcome.kind === 'DISPATCHED') {
      // L'issue du pipeline traverse la porte SANS être réinterprétée.
      assert.equal(outcome.adduction.kind, 'PERSISTED');
      assert.equal((await modelAdductions(h)).length, 1);
    }

    // La gouvernance est traversée sans exception : un engagement gouverné.
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    assert.equal(ledger.count(), 1);
    assert.ok(existsSync(h.paths.usage), 'usage observé par les primitives existantes');
  } finally {
    await h.dispose();
  }
});

test('5 · T3 — la porte est un PASSE-PLAT : elle ne décide de rien d’autre', async () => {
  const code = await section3();
  const gateStart = code.indexOf('export async function requestModelAdduction');
  const gateEnd = code.indexOf('\n}\n', gateStart);
  const gate = code.slice(gateStart, gateEnd);

  // Elle consulte la disponibilité, puis délègue. Rien entre les deux.
  assert.ok(gate.includes('MODEL_ADDUCTION_RUNTIME_AVAILABILITY'));
  assert.ok(gate.includes('adduceMaterialByModel('));
  for (const forbidden of [
    'readStableNativeRunSnapshot', 'runPaths', 'withNativeMutation', 'assertInvocationQuota',
    'parseAdductionProposals', 'revalidateProposal', 'appendEvidenceEntries', '.start(',
    'if (request', 'isMaterialId', 'isControversyEntryTargetId',
  ]) {
    assert.equal(gate.includes(forbidden), false, `porte publique : « ${forbidden} »`);
  }

  // Un périmètre invalide est refusé par le DOMAINE, jamais par la porte : la
  // frontière n'a pas migré vers la surface en s'ouvrant.
  const h = await harness({ content: output([]) });
  try {
    await assert.rejects(
      () =>
        requestModelAdduction(h.deps, {
          runId: RUN_ID,
          material_id: 'pas-un-identifiant',
          controversy_opening_entry_id: 'ctv_999999',
          expert_slot: 'author',
        }),
      (error: unknown) => isCcrError(error),
    );
    assert.equal(h.calls(), 0, 'refusé avant tout dispatch');
  } finally {
    await h.dispose();
  }
});

test('6 · T17 — aucun drapeau d’appelant n’existe, ni n’a d’effet', async () => {
  const h = await harness({ content: output([]) });
  try {
    const s = await seed(h);

    // Des propriétés supplémentaires sur la requête : sans effet, parce que la
    // politique de disponibilité n'est pas un paramètre. Avant l'activation
    // elles ne pouvaient pas OUVRIR la porte ; depuis, elles ne peuvent pas
    // davantage la refermer, ni changer la voie empruntée.
    for (const injected of [
      { acceptance: true }, { force: true }, { bypass: true }, { skipAvailability: true },
      { testMode: true }, { internal: true }, { realGate: true },
      { availability: 'NOT_AVAILABLE' }, { gate: 'S10_REAL_ADDUCTION_ACCEPTANCE' },
    ]) {
      const outcome = await requestModelAdduction(h.deps, {
        ...requestOf(s),
        ...injected,
      } as ModelAdductionRequest);
      assert.equal(outcome.kind, 'DISPATCHED', JSON.stringify(injected));
      if (outcome.kind === 'DISPATCHED') {
        assert.equal(outcome.adduction.kind, 'VALID_ZERO', JSON.stringify(injected));
      }
    }

    // Et la signature elle-même n'offre aucun de ces noms.
    const code = await section3();
    const gateStart = code.indexOf('export async function requestModelAdduction');
    const gateEnd = code.indexOf('\n}\n', gateStart);
    const gate = code.slice(gateStart, gateEnd);
    for (const token of [
      'acceptance', 'force', 'bypass', 'skipAvailability', 'skipQuota', 'skipLedger',
      'testMode', 'internal', 'realGate', 'override',
    ]) {
      assert.equal(gate.includes(token), false, `porte publique : « ${token} »`);
    }
    // La porte publique ne nomme jamais la voie d'acceptation.
    assert.equal(gate.includes('runControlledAcceptanceAdduction'), false);
    assert.equal(gate.includes('S10_REAL_ADDUCTION_ACCEPTANCE'), false);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// C. La voie d'acceptation — même pipeline, aucun relâchement
// ==========================================================================

test('7 · T8/T9 — la voie d’acceptation atteint le pipeline et persiste', async () => {
  const h = await harness({ content: output([proposal('ctve_000002', 'SUPPORTS')]) });
  try {
    const s = await seed(h);
    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);

    assert.equal(outcome.kind, 'PERSISTED');
    assert.equal(h.calls(), 1);

    const persisted = await modelAdductions(h);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.semantic_origin, 'CCR');
    assert.equal(persisted[0]?.derivation?.method, 'MODEL_ASSISTED');

    // Ce que ce test gardait avant l'activation — « son succès ne lève pas la
    // porte » — reste vrai, et se dit désormais sur la SOURCE : la voie
    // d'acceptation n'écrit jamais la disponibilité. La levée a été un
    // changement de code adossé à un verdict, jamais un effet de bord.
    const code = await section3();
    const seamStart = code.indexOf('export async function runControlledAcceptanceAdduction');
    const seam = code.slice(seamStart);
    assert.equal(seam.includes('MODEL_ADDUCTION_RUNTIME_AVAILABILITY'), false);
    assert.ok(seam.includes('adduceMaterialByModel('), 'et elle rejoint le même service');
  } finally {
    await h.dispose();
  }
});

test('8 · T10/T11/T12/T13 — les issues traversent la porte SANS réécriture', async () => {
  const cases: readonly (readonly [string, AdapterScript, ModelAdductionOutcome['kind']])[] = [
    ['VALID_ZERO', { content: output([]) }, 'VALID_ZERO'],
    ['INVALID_OUTPUT', { content: 'pas du JSON' }, 'INVALID_OUTPUT'],
    // Cible d'une AUTRE controverse : canonique, jamais soumise.
    ['REVALIDATION_REFUSED', { content: output([proposal('ctve_000003')]) }, 'REVALIDATION_REFUSED'],
    ['PROVIDER_FAILED', { fail: new Error('panne') }, 'PROVIDER_FAILED'],
  ];

  for (const [label, script, expected] of cases) {
    const h = await harness(script);
    try {
      const s = await seed(h);
      assert.equal(s.foreign, 'ctve_000003', 'la cible étrangère est bien celle-là');

      const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
      assert.equal(outcome.kind, expected, label);
      assert.equal((await modelAdductions(h)).length, 0, `${label} : aucune adduction`);
      assert.equal(h.calls(), 1, `${label} : un seul appel`);

      // Aucune confusion entre les quatre : chacune reste elle-même.
      if (outcome.kind === 'VALID_ZERO') {
        assert.equal('reason' in outcome, false, 'VALID_ZERO n’est pas INVALID_OUTPUT');
        assert.equal('error_code' in outcome, false, 'VALID_ZERO n’est pas PROVIDER_FAILED');
      }
      if (outcome.kind === 'INVALID_OUTPUT') {
        assert.ok(outcome.reason.length > 0);
        assert.equal('error_code' in outcome, false, 'INVALID_OUTPUT n’est pas PROVIDER_FAILED');
        assert.equal('check' in outcome, false, 'INVALID_OUTPUT n’est pas REVALIDATION_REFUSED');
      }
      if (outcome.kind === 'REVALIDATION_REFUSED') {
        assert.equal(outcome.check, 'V7');
        assert.equal('reason' in outcome, false, 'REVALIDATION_REFUSED n’est pas INVALID_OUTPUT');
      }
      if (outcome.kind === 'PROVIDER_FAILED') {
        assert.ok(outcome.error_code.length > 0);
      }

      // L'invocation reste enregistrée dans les quatre cas.
      assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 1, label);
    } finally {
      await h.dispose();
    }
  }
});

test('9 · T14 — l’acceptation ne saute PAS le quota', async () => {
  const h = await harness({ content: output([]) });
  try {
    const s = await seed(h);
    await openInvocationPolicyStore(h.paths).create(0);

    await assert.rejects(
      () => runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION),
      (error: unknown) => isCcrError(error) && error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED',
    );
    assert.equal(h.calls(), 0, 'aucun adaptateur approché');
    assert.equal(existsSync(h.paths.invocations), false, 'aucun engagement');
  } finally {
    await h.dispose();
  }
});

test('10 · T15 — l’acceptation ne saute PAS l’engagement, ni sa version', async () => {
  let observed: Record<string, unknown> | undefined;
  let pathsRef!: RunPaths;
  const h = await harness({
    content: output([]),
    onCall: async () => {
      const raw = await readFile(pathsRef.invocations, 'utf8');
      observed = JSON.parse(raw.trim().split('\n')[0] as string) as Record<string, unknown>;
    },
  });
  pathsRef = h.paths;
  try {
    const s = await seed(h);
    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);

    assert.ok(observed !== undefined, 'le ledger était déjà écrit pendant l’appel');
    assert.equal(observed['kind'], 'DISPATCH_COMMITTED');
    assert.equal(observed['trigger_kind'], 'EVIDENCE_ADDUCTION');
    assert.equal(observed['schema_version'], 3);
    if (outcome.kind === 'VALID_ZERO') {
      assert.equal(observed['invocation_id'], outcome.invocation_id);
    }
  } finally {
    await h.dispose();
  }
});

test('11 · T16 — l’acceptation ne saute PAS la liaison ni la revalidation', async () => {
  // Une cible qui existe, résout, appartient au run — mais n'a pas été soumise.
  const h = await harness({ content: output([proposal('ctve_000003')]) });
  try {
    const s = await seed(h);
    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);

    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') assert.equal(outcome.check, 'V7');
    assert.equal((await modelAdductions(h)).length, 0);

    // Le parseur strict reste actif lui aussi, sur la même voie.
    const strict = await harness({ content: '```json\n{"adduction_proposal_version":1,"proposals":[]}\n```' });
    try {
      const s2 = await seed(strict);
      const out2 = await runControlledAcceptanceAdduction(strict.deps, requestOf(s2), AUTHORIZATION);
      assert.equal(out2.kind, 'INVALID_OUTPUT', 'aucune clôture Markdown n’est tolérée');
    } finally {
      await strict.dispose();
    }
  } finally {
    await h.dispose();
  }
});

test('12 · l’autorisation de gate est exigée, et ne se devine pas', async () => {
  const h = await harness({ content: output([]) });
  try {
    const s = await seed(h);
    const bad: readonly unknown[] = [
      { gate: 'AUTRE_GATE', humanAuthorization: 'x' },
      { gate: 'S10_REAL_DETECTION_ACCEPTANCE', humanAuthorization: 'x' },
      { gate: '', humanAuthorization: 'x' },
      { gate: 'S10_REAL_ADDUCTION_ACCEPTANCE', humanAuthorization: '' },
      { gate: 'S10_REAL_ADDUCTION_ACCEPTANCE' },
      { gate: 'S10_REAL_ADDUCTION_ACCEPTANCE', humanAuthorization: 42 },
      {},
    ];
    for (const authorization of bad) {
      await assert.rejects(
        () =>
          runControlledAcceptanceAdduction(
            h.deps,
            requestOf(s),
            authorization as ModelAdductionAcceptanceAuthorization,
          ),
        (error: unknown) =>
          isCcrError(error) &&
          (error.details as { reason?: string } | undefined)?.reason ===
            'ACCEPTANCE_AUTHORIZATION_REQUIRED',
        JSON.stringify(authorization),
      );
    }
    assert.equal(h.calls(), 0, 'aucun adaptateur approché');
    assert.equal(existsSync(h.paths.invocations), false, 'aucun engagement');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// D. Un seul pipeline
// ==========================================================================

test('13 · T8 — deux portes, UN pipeline : la convergence est structurelle', async () => {
  const code = await section3();

  // Les deux voies convergent, et la section 3/3 ne fait rien elle-même.
  assert.equal((code.match(/adduceMaterialByModel\(/g) ?? []).length, 2, 'exactement deux appels');
  for (const token of [
    '.start(', 'createAdapters', 'openInvocationLedger', 'openUsageLedger',
    'assertInvocationQuotaAvailable', 'appendEvidenceEntries', 'readEvidenceJournal',
    'parseAdductionProposals', 'revalidateProposal', 'withNativeMutation',
    'readStableNativeRunSnapshot', 'formatAdductionId',
  ]) {
    assert.equal(code.includes(token), false, `la section 3/3 fait elle-même : « ${token} »`);
  }

  // Aucun second pipeline nulle part dans le module : UN site d'appel
  // d'adaptateur, UNE déclaration de service, DEUX appelants.
  const raw = codeOnly(await readFile(ADDUCER, 'utf8'));
  assert.equal((raw.match(/\.start\(/g) ?? []).length, 1, 'un seul appel d’adaptateur');
  assert.equal(
    (raw.match(/export async function adduceMaterialByModel\(/g) ?? []).length,
    1,
    'un seul service de dispatch',
  );
  assert.equal(
    (raw.match(/adduceMaterialByModel\(/g) ?? []).length,
    3,
    'une déclaration, deux appels — et rien de plus',
  );
});

// ==========================================================================
// E. Aucune surface n'atteint quoi que ce soit
// ==========================================================================

test('14 · T18 — la CLI expose la PORTE, jamais le service ni le gate', async () => {
  const cli = await readFile(new URL('cli/main.ts', SRC), 'utf8');

  // Vérité post-S10 : la commande publique existe, et elle emprunte la porte.
  assert.ok(cli.includes('adduce-model'), 'la commande gelée est activée');
  assert.ok(cli.includes('requestModelAdduction'), 'et elle passe par la porte');

  // La frontière critique, elle, n'a pas bougé d'un pouce.
  for (const token of [
    'runControlledAcceptanceAdduction',
    'S10_REAL_ADDUCTION_ACCEPTANCE',
    'adduceMaterialByModel',
    'ModelAdductionAcceptanceAuthorization',
  ]) {
    assert.equal(cli.includes(token), false, `cli/main.ts : « ${token} »`);
  }

  // Aucune option de contournement n'accompagne la commande activée.
  for (const option of [
    "'provider'", "'model'", "'force'", "'acceptance'", "'gate'", "'internal'",
    "'retry'", "'bypass'", "'skip-quota'", "'skip-ledger'", "'expected-revision'",
  ]) {
    assert.equal(cli.includes(`'adduce-model'`) && cli.includes(option), false, `option : ${option}`);
  }

  // Et les commandes V4 humaines de S5 sont toujours là.
  assert.ok(cli.includes('material'), 'ccr material existe');
  assert.ok(cli.includes('adduce'), 'ccr adduce existe');
});

test('15 · T19/T20/T21 — ni HTTP, ni cockpit : la CLI est la SEULE surface', async () => {
  // La voie d'acceptation reste introuvable depuis TOUTE surface, y compris la
  // CLI publique désormais activée. C'est la frontière que S10 devait préserver.
  for (const relative of [
    'cockpit/mutations-http.ts', 'cockpit/server.ts', 'cockpit/native-read-http.ts',
    'cli/main.ts', 'cli/native-dispatch.ts',
  ]) {
    let code: string;
    try {
      code = await readFile(new URL(relative, SRC), 'utf8');
    } catch {
      continue;
    }
    for (const token of [
      'runControlledAcceptanceAdduction', 'S10_REAL_ADDUCTION_ACCEPTANCE', 'adduceMaterialByModel',
    ]) {
      assert.equal(code.includes(token), false, `${relative} : « ${token} »`);
    }
    // Et hors de la CLI, la porte publique elle-même n'est nommée nulle part.
    if (relative !== 'cli/main.ts') {
      for (const token of ['requestModelAdduction', 'evidence-adducer']) {
        assert.equal(code.includes(token), false, `${relative} : « ${token} »`);
      }
    }
  }

  // Aucun bouton, aucun libellé, aucun déclencheur dans le frontend.
  const webDir = new URL('cockpit/web/', SRC);
  for (const name of await readdir(webDir)) {
    if (!name.endsWith('.js')) continue;
    const code = await readFile(new URL(name, webDir), 'utf8');
    for (const token of ['adduce-model', 'adducer', 'MODEL_ADDUCTION', 'acceptance']) {
      assert.equal(code.includes(token), false, `${name} : « ${token} »`);
    }
  }
});

test('16 · T22 — aucun automatisme : le chemin modèle n’est déclenché par rien', async () => {
  for (const relative of [
    'services/evidence-service.ts',
    'services/evidence-read-model.ts',
    'services/evidence-freshness.ts',
    'services/native-start-service.ts',
    'services/native-step-service.ts',
    'services/native-send-service.ts',
    'services/native-handoff-service.ts',
    'services/native-recovery-service.ts',
    'services/native-read-model.ts',
    'services/controversy-read-model.ts',
    'store/evidence-store.ts',
    'store/native-run-snapshot.ts',
  ]) {
    const code = await readFile(new URL(relative, SRC), 'utf8');
    for (const token of [
      'evidence-adducer',
      'adduceMaterialByModel',
      'requestModelAdduction',
      'runControlledAcceptanceAdduction',
    ]) {
      assert.equal(code.includes(token), false, `${relative} : « ${token} »`);
    }
  }
});

test('17 · T22 — la garde de format natif n’est pas élargie', async () => {
  const guard = await readFile(
    new URL('../unit/native-event-round-provenance.test.ts', import.meta.url),
    'utf8',
  );
  const start = guard.indexOf('const NATIVE_ENGINE_FILES = [');
  const end = guard.indexOf('];', start);
  const allowlist = guard.slice(start, end);

  // Les entrées V4 sont EXACTEMENT ces quatre-là. La garde porte sur l'espace
  // `services/evidence-*`, et non sur la liste entière : `cli/main.ts` et deux
  // modules cockpit y figurent depuis V2.1, pour des raisons qui ne sont pas
  // celles de V4. Prétendre qu'ils en sont absents serait faux.
  const v4Entries = [...allowlist.matchAll(/'(services\/evidence-[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(v4Entries.sort(), [
    'services/evidence-adducer.ts',
    'services/evidence-freshness.ts',
    'services/evidence-read-model.ts',
    'services/evidence-service.ts',
  ]);
  // Une entrée par tranche : aucune n'est dupliquée, aucune n'est inventée.
  assert.equal(new Set(v4Entries).size, 4);
  assert.equal(allowlist.includes("'services/evidence-adduction"), false, 'aucun module fantôme');
});

// ==========================================================================
// F. Ce que S7-C n'a pas créé
// ==========================================================================

test('18 · T24 — aucune Recovery, aucun pending_operation, aucun état ajouté', async () => {
  for (const script of [
    { content: output([proposal('ctve_000002')]) },
    { content: output([]) },
    { content: 'illisible' },
    { fail: new Error('panne') },
  ]) {
    const h = await harness(script);
    try {
      const s = await seed(h);
      const before = JSON.parse(await readFile(h.paths.state, 'utf8')) as Record<string, unknown>;

      // Les DEUX voies, l'une après l'autre. Depuis l'activation, la porte
      // publique dispatche elle aussi : deux appels, deux engagements.
      await requestModelAdduction(h.deps, requestOf(s));
      await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);

      const after = JSON.parse(await readFile(h.paths.state, 'utf8')) as Record<string, unknown>;
      assert.equal(after['pending_operation'], null);
      assert.equal(after['state'], before['state']);
      assert.equal(after['control'], before['control']);
      assert.equal(after['round'], before['round']);
      assert.equal(h.calls(), 2, 'un appel par geste — jamais une reprise');
      assert.equal((await openInvocationLedger(h.paths, RUN_ID)).count(), 2);
    } finally {
      await h.dispose();
    }
  }
});

test('19 · T25 — les deux portes, UN pipeline, et une seule autorité de levée', async () => {
  const h = await harness({ content: output([proposal('ctve_000002')]) });
  try {
    const s = await seed(h);

    // La même demande, par les deux voies : la même issue, le même pipeline.
    const accepted = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
    const asked = await requestModelAdduction(h.deps, requestOf(s));

    assert.equal(accepted.kind, 'PERSISTED');
    assert.equal(asked.kind, 'DISPATCHED');
    if (asked.kind === 'DISPATCHED') assert.equal(asked.adduction.kind, 'PERSISTED');
    assert.equal(h.calls(), 2, 'deux gestes, deux appels');
    assert.equal((await modelAdductions(h)).length, 2, 'deux faits historiques distincts');

    // Et la disponibilité n'est le produit d'aucun de ces succès : elle est
    // déclarée, et le test 3 vérifie que rien ne l'écrit.
    assert.equal(MODEL_ADDUCTION_RUNTIME_AVAILABILITY, 'AVAILABLE');
    assert.equal(MODEL_ADDUCTION_IMPLEMENTED, true);
  } finally {
    await h.dispose();
  }
});

test('20 · aucune preuve de MÉRITE n’est fabriquée par cette tranche', async () => {
  const code = await section3();
  // Rien ici ne prétend qu'un fournisseur est juste, ni qu'une adduction est
  // vraie, ni qu'un désaccord existe. La levée dit « un humain PEUT demander »,
  // et rien d'autre.
  for (const token of ['REAL_NOW', 'VALIDATED', 'PROVEN', 'ACCURATE', 'CORRECT', 'TRUSTED']) {
    assert.equal(code.includes(token), false, `section 3/3 : « ${token} »`);
  }
  assert.equal(MODEL_ADDUCTION_RUNTIME_AVAILABILITY, 'AVAILABLE');
});
