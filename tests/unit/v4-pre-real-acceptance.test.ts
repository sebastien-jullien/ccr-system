/**
 * V4 · S9 — acceptation pré-REAL, sur système de fichiers réel.
 *
 * Question de preuve :
 *
 * > **Les huit tranches acceptées se composent-elles réellement, sur de vrais
 * > journaux, de vrais verrous et de vrais processus — ou seulement dans leurs
 * > tests unitaires respectifs ?**
 *
 * Ce fichier est un **gate**, pas une tranche. Il ne répare rien : un défaut de
 * production découvert ici arrête le gate et ouvre un micro-gate séparé.
 *
 * ```text
 * RÉEL      filesystem · JSONL · snapshots · verrous · séquences d'identité
 *           InvocationLedger · usage · services S1–S8 · porte S7-C · processus
 * DOUBLÉ    l'adaptateur fournisseur, et lui seul
 * ```
 *
 * La chaîne éprouvée est celle du plan gelé, dans cet ordre :
 *
 * ```text
 * enregistrement de matériau → adduction humaine → snapshot stable
 * → read model → acceptation contrôlée → ledger v3 → adaptateur doublé
 * → parseur → revalidation → adduction MODEL_ASSISTED → read model → cockpit
 * ```
 *
 * Aucun fournisseur réel. Aucun réseau. Aucune credential.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import { readNativeRunHttpView } from '../../src/cockpit/native-read-http.ts';
import { readUsageReadModel } from '../../src/services/usage-read-model.ts';
import { readCurrentEvidenceRevision } from '../../src/services/evidence-freshness.ts';
import { recordAssertion, recordControversy } from '../../src/services/controversy-service.ts';
import type { ControversyServiceDeps } from '../../src/services/controversy-service.ts';
import { adduceMaterial, registerMaterial } from '../../src/services/evidence-service.ts';
import type { EvidenceServiceDeps } from '../../src/services/evidence-service.ts';
import {
  ADDUCTION_PROPOSAL_VERSION,
  MODEL_ADDUCTION_RUNTIME_AVAILABILITY,
  requestModelAdduction,
  runControlledAcceptanceAdduction,
} from '../../src/services/evidence-adducer.ts';
import type {
  ModelAdductionAcceptanceAuthorization,
  ModelAdductionDeps,
  ModelAdductionRequest,
} from '../../src/services/evidence-adducer.ts';
import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const RUN_ID = 'CCR-20260818-990';
const HELD_TEXT = 'Mesure : le cache expire en 30 s. Ensuite, le cache est reconstruit.';

const AUTHORIZATION: ModelAdductionAcceptanceAuthorization = {
  gate: 'S10_REAL_ADDUCTION_ACCEPTANCE',
  humanAuthorization: 'gate S9 — acceptation pré-REAL, adaptateur doublé, aucun fournisseur réel',
};

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
  {
    event_id: 'evt_000002',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-18T09:20:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'challenger',
    session_id: 'S2',
    content: 'Non : le cache reste valide longtemps.',
  },
];

// --------------------------------------------------------------------------
// Harnais — TOUT est réel, sauf l'adaptateur
// --------------------------------------------------------------------------

interface AdapterScript {
  readonly content?: string;
  readonly fail?: Error;
  readonly onCall?: () => Promise<void> | void;
  readonly usage?: AgentTurnResult['usageObservation'];
}

let fakeDispatches = 0;

function fakeAdapter(kind: 'claude' | 'codex', script: AdapterScript): AgentAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind,
    calls,
    async start(prompt: string): Promise<AgentTurnResult> {
      fakeDispatches += 1;
      calls.push(prompt);
      await script.onCall?.();
      if (script.fail !== undefined) throw script.fail;
      return {
        agent: kind,
        sessionId: `s9-${kind}`,
        content: script.content ?? '',
        exitCode: 0,
        startedAt: '2026-08-18T10:00:00.000Z',
        completedAt: '2026-08-18T10:00:01.000Z',
        stdoutRaw: script.content ?? '',
        stderrRaw: '',
        ...(script.usage === undefined ? {} : { usageObservation: script.usage }),
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

/** Écrit un vrai run natif sur un vrai répertoire temporaire. */
async function seedRunDirectory(runsDir: string): Promise<RunPaths> {
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-08-18T09:00:00.000Z',
      title: 'S9 pré-REAL',
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
      last_event_id: 'evt_000002',
      updated_at: '2026-08-18T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return paths;
}

async function harness(script: AdapterScript = {}): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s9-'));
  const paths = await seedRunDirectory(runsDir);

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

/**
 * La graine humaine — vrais services S4 et V3, vrai verrou, vrais journaux.
 *
 * ```text
 * ENREGISTRER un matériau   ≠   L'ADDUIRE
 * ```
 *
 * Les deux gestes sont distincts et le restent : la graine enregistre quatre
 * matériaux et n'en addut aucun.
 */
interface Seed {
  readonly opening: string;
  readonly a: string;
  readonly b: string;
  readonly foreignOpening: string;
  readonly held: string;
  readonly unsubmitted: string;
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
  const b = await recordAssertion(h.controversy, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: a.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Le TTL doit être long',
  });
  const other = await recordControversy(h.controversy, {
    runId: RUN_ID,
    expected_controversy_revision: b.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Autre sujet',
  });

  const held = await registerMaterial(h.evidence, {
    runId: RUN_ID,
    expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID),
    representation: { form: 'INLINE_TEXT', text: HELD_TEXT },
    label: 'mesure de cache',
  });
  const unsubmitted = await registerMaterial(h.evidence, {
    runId: RUN_ID,
    expected_evidence_revision: held.evidence_revision,
    representation: { form: 'INLINE_TEXT', text: 'Un autre matériau, jamais soumis.' },
  });

  return {
    opening: opened.entry.entry_id,
    a: a.entry.entry_id,
    b: b.entry.entry_id,
    foreignOpening: other.entry.entry_id,
    held: held.entry.entry_id,
    unsubmitted: unsubmitted.entry.entry_id,
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

function proposal(
  material: string,
  target: string,
  orientation: string,
  citation?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    material_id: material,
    target_entry_id: target,
    orientation,
    ...(citation === undefined ? {} : { citation }),
  };
}

// --------------------------------------------------------------------------
// Observation — toujours sur les OCTETS réellement écrits
// --------------------------------------------------------------------------

async function ledgerLines(paths: RunPaths): Promise<Record<string, unknown>[]> {
  if (!existsSync(paths.invocations)) return [];
  const raw = await readFile(paths.invocations, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function evidenceBytes(paths: RunPaths): Promise<string> {
  return existsSync(paths.evidence) ? readFile(paths.evidence, 'utf8') : '';
}

async function modelAdductions(paths: RunPaths): Promise<readonly AdductionRecordedEntry[]> {
  const journal = await readEvidenceJournal(paths);
  return journal.entries.filter(
    (e: EvidenceEntry): e is AdductionRecordedEntry =>
      e.kind === 'ADDUCTION_RECORDED' && e.semantic_origin === 'CCR',
  );
}

/** Le read model V4, obtenu par la vraie couture S3. */
async function evidenceView(h: Harness): Promise<Record<string, unknown>> {
  const view = await readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);
  return view.evidence as unknown as Record<string, unknown>;
}

/** Le cockpit, rendu depuis la VRAIE vue HTTP. Aucune fixture inventée. */
async function cockpitText(h: Harness): Promise<string> {
  const view = await readNativeRunHttpView({ runsDir: h.runsDir }, RUN_ID);
  const module = (await import(new URL('../../src/cockpit/web/render.js', import.meta.url).href)) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  module.createDomView(dom.document, {})['showRunView']?.(view as unknown as Record<string, unknown>);
  const section = dom.document.getElementById('section-runtime');
  const found: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    if ((node.attributes['class'] ?? '').split(' ').includes('evidence')) found.push(node);
    for (const child of node.children) walk(child);
  };
  if (section !== null) walk(section);
  return found.length === 0 ? '' : (found[0] as FakeNode).textContent;
}

/**
 * La porte publique **suit** la disponibilité déclarée — recalibré en S10.
 *
 * Au moment de S9, la disponibilité était `NOT_AVAILABLE` et la garde exigeait
 * un refus sans coût. L'activation post-S10 l'a portée à `AVAILABLE` : exiger
 * encore un refus serait exiger que l'activation n'ait pas eu lieu.
 *
 * L'invariant conservé est l'équivalence, vraie des deux côtés :
 *
 * ```text
 * NOT_AVAILABLE  ⟺  refus, zéro dispatch, zéro engagement, zéro octet
 * AVAILABLE      ⟺  dispatch par le MÊME pipeline S7-B
 * ```
 */
async function publicGateFollowsAvailability(h: Harness, s: Seed): Promise<void> {
  const before = await evidenceBytes(h.paths);
  const ledgerBefore = (await ledgerLines(h.paths)).length;
  const callsBefore = h.calls();

  const outcome = await requestModelAdduction(h.deps, requestOf(s));

  if (MODEL_ADDUCTION_RUNTIME_AVAILABILITY === 'NOT_AVAILABLE') {
    assert.equal(outcome.kind, 'NOT_AVAILABLE');
    assert.equal(h.calls(), callsBefore, 'aucun dispatch');
    assert.equal((await ledgerLines(h.paths)).length, ledgerBefore, 'aucun engagement');
    assert.equal(await evidenceBytes(h.paths), before, 'aucun octet V4 écrit');
    return;
  }

  // Porte ouverte : elle DISPATCHE, et transmet l'issue sans la réinterpréter.
  assert.equal(outcome.kind, 'DISPATCHED');
  assert.equal(h.calls(), callsBefore + 1, 'un dispatch, un seul');
  assert.equal((await ledgerLines(h.paths)).length, ledgerBefore + 1, 'un engagement gouverné');
  if (outcome.kind === 'DISPATCHED') {
    assert.ok(
      ['PERSISTED', 'VALID_ZERO', 'INVALID_OUTPUT', 'REVALIDATION_REFUSED', 'PROVIDER_FAILED']
        .includes(outcome.adduction.kind),
      'une issue du pipeline, jamais une septième',
    );
  }
}

// ==========================================================================
// S9-S00 — état d'entrée
// ==========================================================================

test('S9-S00 · la disponibilité publique est déclarée, et connue', () => {
  // Au moment du gate S9 elle valait `NOT_AVAILABLE` ; l'activation post-S10 l'a
  // portée à `AVAILABLE`. Ce que S9 exigeait — que ses douze scénarios passent
  // par la voie d'ACCEPTATION et non par la porte — reste vrai des deux côtés.
  assert.ok(
    ['NOT_AVAILABLE', 'AVAILABLE'].includes(MODEL_ADDUCTION_RUNTIME_AVAILABILITY),
    'une valeur de l’union fermée',
  );
});

// ==========================================================================
// S9-S01 · S02 · S03 — les trois orientations, persistées de bout en bout
// ==========================================================================

test('S9-S01 — neutre valide : chaîne complète jusqu’au cockpit', async () => {
  const h = await harness({
    content: output([proposal('mat_000001', 'ctve_000002', 'NONE')]),
  });
  try {
    const s = await seed(h);

    // La graine humaine : deux matériaux ENREGISTRÉS, aucune adduction.
    const seeded = await evidenceView(h);
    assert.equal(seeded['availability'], 'AVAILABLE');
    assert.equal(seeded['recorded_material_count'], 2);
    assert.equal(seeded['recorded_adduction_count'], 0);

    // Une adduction HUMAINE, par le vrai service S4 — zéro fournisseur.
    const human = await adduceMaterial(h.evidence, {
      runId: RUN_ID,
      expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID),
      material_id: s.held,
      target_entry_id: s.a,
      orientation: 'SUPPORTS',
    });
    assert.equal(human.provider_effect, 'EXACT(0)');
    assert.equal(h.calls(), 0, 'une mutation HUMAN n’approche aucun adaptateur');

    await publicGateFollowsAvailability(h, s);

    // Puis la voie d'acceptation contrôlée — celle des douze scénarios.
    const callsBeforeAcceptance = h.calls();
    const adductionsBeforeAcceptance = (await readEvidenceJournal(h.paths)).entries.filter(
      (e: EvidenceEntry) => e.kind === 'ADDUCTION_RECORDED',
    ).length;
    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'PERSISTED');
    assert.equal(h.calls(), callsBeforeAcceptance + 1, 'un seul appel pour l’acceptation');

    const persisted = await modelAdductions(h.paths);
    assert.ok(persisted.length >= 1);
    assert.equal(persisted.at(-1)?.orientation, 'NONE');
    assert.equal(persisted[0]?.semantic_origin, 'CCR');

    // Read model réel, puis cockpit réel — la chaîne du plan, jusqu'au bout.
    const view = await evidenceView(h);
    assert.equal(view['recorded_material_count'], 2);
    // Compte RELATIF : depuis l'activation post-S10, la vérification de la porte
    // publique dispatche elle aussi, et un absolu figé confondrait deux gestes.
    assert.equal(
      view['recorded_adduction_count'],
      adductionsBeforeAcceptance + 1,
      'l’acceptation a ajouté exactement une adduction',
    );

    const rendered = await cockpitText(h);
    assert.ok(rendered.includes('aucune orientation déclarée'), 'NONE rendue explicitement');
    assert.ok(rendered.includes('origine : Inférence CCR'));
    assert.ok(rendered.includes('origine : Humain'));
    assert.ok(rendered.includes('assistée par modèle'));
    // NONE n'est jamais rendu comme « sans pertinence ».
    assert.equal(rendered.toLowerCase().includes('sans pertinence'), false);
  } finally {
    await h.dispose();
  }
});

test('S9-S02 — soutien valide : gouvernance observée sur DISQUE', async () => {
  const h = await harness({
    content: output([proposal('mat_000001', 'ctve_000002', 'SUPPORTS')]),
    // Observation RÉELLEMENT typée, même motif qu'en S7-B : la conversion
    // masquait une forme étrangère à `UsageObservation`.
    usage: {
      model: { source: 'PROVIDER_REPORTED', resolved_model: 'codex-x' },
      tokens: {
        provider: 'codex',
        input_tokens: 7,
        output_tokens: 9,
        cached_input_tokens: null,
        cache_write_input_tokens: null,
        reasoning_output_tokens: null,
      },
    },
  });
  try {
    const s = await seed(h);
    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'PERSISTED');
    if (outcome.kind !== 'PERSISTED') return;

    // ---- Le ledger, ligne par ligne, tel qu'il est écrit.
    const lines = await ledgerLines(h.paths);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.['kind'], 'DISPATCH_COMMITTED');
    assert.equal(lines[0]?.['trigger_kind'], 'EVIDENCE_ADDUCTION');
    assert.equal(lines[0]?.['schema_version'], 3);
    assert.equal(lines[0]?.['invocation_id'], outcome.invocation_id);

    // ---- L'usage, honnête : observé parce que le doublé l'a rapporté.
    const usage = await readUsageReadModel(h.paths);
    const seen = usage.by_invocation.find((i) => i.invocation_id === outcome.invocation_id);
    assert.equal(seen?.trigger_kind, 'EVIDENCE_ADDUCTION');
    assert.equal(seen?.provider_reported.state, 'OBSERVED');

    // ---- L'adduction canonique, sur disque.
    const persisted = await modelAdductions(h.paths);
    assert.equal(persisted.length, 1);
    const entry = persisted[0] as AdductionRecordedEntry;
    assert.equal(entry.orientation, 'SUPPORTS');
    assert.equal(entry.semantic_origin, 'CCR');
    assert.equal(entry.recorded_by, 'CCR');
    assert.equal(entry.derivation?.method, 'MODEL_ASSISTED');
    assert.equal(entry.derivation?.invocation_id, outcome.invocation_id);
    // Liaison : exactement l'ensemble soumis en phase A.
    assert.deepEqual([...(entry.derivation?.inputs ?? [])], [s.held, s.opening, s.a, s.b]);

    // Ni fournisseur ni modèle dans l'origine sémantique.
    const serialized = JSON.stringify(entry).toLowerCase();
    for (const vendor of ['codex', 'claude', 'codex-x', 'anthropic', 'openai']) {
      assert.equal(serialized.includes(vendor), false, vendor);
    }

    // ---- La révision rendue est celle du store.
    assert.equal(outcome.evidence_revision, (await readEvidenceJournal(h.paths)).revision);
  } finally {
    await h.dispose();
  }
});

test('S9-S03 — objection valide : deux positions contraires coexistent', async () => {
  const h = await harness({
    content: output([proposal('mat_000001', 'ctve_000002', 'OBJECTS_TO')]),
  });
  try {
    const s = await seed(h);
    // Un humain a d'abord soutenu la même cible avec le même matériau.
    await adduceMaterial(h.evidence, {
      runId: RUN_ID,
      expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir: h.runsDir }, RUN_ID),
      material_id: s.held,
      target_entry_id: s.a,
      orientation: 'SUPPORTS',
    });

    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'PERSISTED');

    // Les deux faits coexistent : aucun n'est effacé, aucun n'est préféré.
    const all = (await readEvidenceJournal(h.paths)).entries.filter(
      (e: EvidenceEntry): e is AdductionRecordedEntry => e.kind === 'ADDUCTION_RECORDED',
    );
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((e) => e.orientation), ['SUPPORTS', 'OBJECTS_TO']);
    assert.deepEqual(all.map((e) => e.semantic_origin), ['HUMAN', 'CCR']);

    const rendered = await cockpitText(h);
    assert.ok(rendered.includes('soutien déclaré'));
    assert.ok(rendered.includes('objection déclarée'));
    for (const verdict of ['gagnant', 'majorité', 'l’emporte', 'tranché', 'résolu']) {
      assert.equal(rendered.toLowerCase().includes(verdict), false, verdict);
    }
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// S9-S04 — VALID_ZERO
// ==========================================================================

test('S9-S04 — VALID_ZERO : succès opérationnel, zéro adduction', async () => {
  const h = await harness({ content: output([]) });
  try {
    const s = await seed(h);
    const before = await evidenceBytes(h.paths);

    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'VALID_ZERO');
    assert.equal(h.calls(), 1, 'aucun second dispatch');

    // La gouvernance a bien laissé ses traces : l'invocation a eu lieu.
    const lines = await ledgerLines(h.paths);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.['trigger_kind'], 'EVIDENCE_ADDUCTION');

    // Et rien n'a été écrit côté métier.
    assert.equal(await evidenceBytes(h.paths), before, 'evidence.jsonl inchangé, octet pour octet');
    assert.equal((await modelAdductions(h.paths)).length, 0);

    // VALID_ZERO ne dit ni « aucune preuve », ni « accord ».
    const view = await evidenceView(h);
    assert.equal(view['availability'], 'AVAILABLE');
    assert.equal(view['recorded_adduction_count'], 0);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// S9-S05 — sortie invalide
// ==========================================================================

test('S9-S05 — sortie invalide : le vrai parseur refuse, sans reprise', async () => {
  const h = await harness({
    // Une clé de score glissée dans une proposition par ailleurs correcte.
    content: JSON.stringify({
      adduction_proposal_version: 1,
      proposals: [
        {
          material_id: 'mat_000001',
          target_entry_id: 'ctve_000002',
          orientation: 'SUPPORTS',
          confidence: 0.97,
        },
      ],
    }),
  });
  try {
    const s = await seed(h);
    const before = await evidenceBytes(h.paths);

    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'INVALID_OUTPUT');
    if (outcome.kind === 'INVALID_OUTPUT') {
      assert.equal(outcome.reason, 'INVALID_PROPOSAL');
      assert.ok(outcome.at.startsWith('output.proposals[0]'));
    }

    assert.equal(h.calls(), 1, 'aucune demande de correction, aucun second appel');
    assert.equal((await ledgerLines(h.paths)).length, 1, 'l’engagement reste historique');
    assert.equal(await evidenceBytes(h.paths), before, 'aucune adduction');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// S9-S06 — revalidation refusée par concurrence réelle
// ==========================================================================

test('S9-S06 — revalidation refusée : entrée apparue PENDANT l’appel', async () => {
  let hRef!: Harness;
  let addedId: string | undefined;

  const h = await harness({
    // Le doublé nomme une entrée qui n'existait pas en phase A.
    content: output([proposal('mat_000001', 'ctve_000005', 'SUPPORTS')]),
    onCall: async () => {
      // Vraie mutation concurrente, vrai verrou, même run. Si la phase B tenait
      // `.ccr.lock`, cet appel échouerait — et le scénario tomberait.
      const journal = await readControversyJournal(hRef.paths);
      const controversyId = journal.entries
        .filter((e) => e.kind === 'CONTROVERSY_RECORDED')
        .map((e) => e.controversy_id)[0] as string;
      const added = await recordAssertion(hRef.controversy, {
        runId: RUN_ID,
        controversy_id: controversyId,
        expected_controversy_revision: journal.revision,
        provenance_event_ids: ['evt_000001'],
        statement: 'Entrée écrite pendant l’appel fournisseur',
      });
      addedId = added.entry.entry_id;
    },
  });
  hRef = h;
  try {
    const s = await seed(h);
    const before = await evidenceBytes(h.paths);

    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);

    assert.equal(addedId, 'ctve_000005', 'la mutation concurrente a bien abouti');
    // Elle EXISTE et résout en phase C — et elle est refusée : non soumise.
    const snapshot = await readStableNativeRunSnapshot(h.runsDir, RUN_ID);
    assert.ok(snapshot.controversies.some((e) => e.entry_id === 'ctve_000005'));

    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') assert.equal(outcome.check, 'V7');
    assert.equal((await ledgerLines(h.paths)).length, 1, 'l’engagement reste');
    assert.equal(await evidenceBytes(h.paths), before, 'aucune adduction');
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// S9-S07 — quota refusé
// ==========================================================================

test('S9-S07 — quota refusé : rien n’est engagé, rien n’est appelé', async () => {
  const h = await harness({ content: output([proposal('mat_000001', 'ctve_000002', 'SUPPORTS')]) });
  try {
    const s = await seed(h);
    await openInvocationPolicyStore(h.paths).create(0);
    const before = await evidenceBytes(h.paths);

    await assert.rejects(
      () => runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION),
      (error: unknown) => isCcrError(error) && error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED',
    );

    assert.equal(h.calls(), 0, 'aucun adaptateur approché');
    assert.equal(existsSync(h.paths.invocations), false, 'aucun ledger créé');
    assert.equal(existsSync(h.paths.usage), false, 'aucun usage créé');
    assert.equal(await evidenceBytes(h.paths), before);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// S9-S08 — panne fournisseur contrôlée
// ==========================================================================

test('S9-S08 — panne contrôlée : PROVIDER_FAILED, engagement conservé', async () => {
  const h = await harness({ fail: new Error('le fournisseur doublé n’a pas répondu') });
  try {
    const s = await seed(h);
    const before = await evidenceBytes(h.paths);

    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'PROVIDER_FAILED');
    assert.equal(h.calls(), 1, 'aucune reprise');

    // Le service EST revenu, avec une issue contrôlée : c'est ce qui distingue
    // ce scénario de l'inconnu-après-engagement (S9-S12).
    const lines = await ledgerLines(h.paths);
    assert.equal(lines.length, 1, 'un engagement durable ne s’efface pas');
    assert.equal(await evidenceBytes(h.paths), before);

    // Aucun statut, aucune reprise n'est créé.
    const state = JSON.parse(await readFile(h.paths.state, 'utf8')) as Record<string, unknown>;
    assert.equal(state['pending_operation'], null);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// S9-S09 · S10 — liaison : matériau et cible non soumis
// ==========================================================================

test('S9-S09 — matériau non soumis : existe, résout, et reste refusé', async () => {
  const h = await harness({
    content: output([proposal('mat_000002', 'ctve_000002', 'SUPPORTS')]),
  });
  try {
    const s = await seed(h);
    assert.equal(s.unsubmitted, 'mat_000002');
    const before = await evidenceBytes(h.paths);

    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') {
      assert.equal(outcome.check, 'V6');
      assert.equal(outcome.at, 'proposals[0].material_id');
    }
    assert.equal(await evidenceBytes(h.paths), before);
    assert.equal((await ledgerLines(h.paths)).length, 1);
  } finally {
    await h.dispose();
  }
});

test('S9-S10 — cible non soumise : entrée d’une AUTRE controverse', async () => {
  const h = await harness({
    content: output([proposal('mat_000001', 'ctve_000004', 'OBJECTS_TO')]),
  });
  try {
    const s = await seed(h);
    assert.equal(s.foreignOpening, 'ctve_000004');
    const before = await evidenceBytes(h.paths);

    const outcome = await runControlledAcceptanceAdduction(h.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') {
      assert.equal(outcome.check, 'V7');
      assert.equal(outcome.at, 'proposals[0].target_entry_id');
    }
    assert.equal(await evidenceBytes(h.paths), before);
    assert.equal((await ledgerLines(h.paths)).length, 1);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// S9-S11 — citation réussie / citation en échec, et le lot
// ==========================================================================

test('S9-S11 — citation réussie, puis citation en échec sur un LOT', async () => {
  // ---- Citation réussie : « le cache » apparaît deux fois, rang 2 existe.
  const ok = await harness({
    content: output([
      proposal('mat_000001', 'ctve_000002', 'SUPPORTS', { quoted_text: 'le cache', occurrence: 2 }),
    ]),
  });
  try {
    const s = await seed(ok);
    const outcome = await runControlledAcceptanceAdduction(ok.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'PERSISTED');

    const entry = (await modelAdductions(ok.paths))[0] as AdductionRecordedEntry;
    assert.deepEqual(entry.citation, { quoted_text: 'le cache', occurrence: 2 });

    // Le read model confirme la résolution — dérivée, jamais persistée.
    const view = await evidenceView(ok);
    const adductions = view['adductions'] as readonly Record<string, unknown>[];
    const last = adductions[adductions.length - 1] as Record<string, unknown>;
    assert.deepEqual(last['citation_resolution'], { kind: 'RESOLVABLE' });

    const rendered = await cockpitText(ok);
    assert.ok(rendered.includes('citation retrouvée dans le matériau'));
  } finally {
    await ok.dispose();
  }

  // ---- Citation en échec, dans un LOT de trois : zéro adduction du lot.
  const ko = await harness({
    content: output([
      proposal('mat_000001', 'ctve_000001', 'NONE'),
      proposal('mat_000001', 'ctve_000002', 'SUPPORTS'),
      // Le rang 3 n'existe pas : « le cache » n'apparaît que deux fois.
      proposal('mat_000001', 'ctve_000003', 'OBJECTS_TO', { quoted_text: 'le cache', occurrence: 3 }),
    ]),
  });
  try {
    const s = await seed(ko);
    const before = await evidenceBytes(ko.paths);

    const outcome = await runControlledAcceptanceAdduction(ko.deps, requestOf(s), AUTHORIZATION);
    assert.equal(outcome.kind, 'REVALIDATION_REFUSED');
    if (outcome.kind === 'REVALIDATION_REFUSED') {
      assert.equal(outcome.check, 'V10');
      assert.ok(outcome.at.startsWith('proposals[2]'));
    }

    // TOUT OU RIEN : les deux premières propositions étaient recevables, et
    // aucune n'est écrite. La garantie établie est celle-ci, et pas une de plus :
    // toutes les revalidations déterministes AVANT le premier append métier.
    assert.equal(await evidenceBytes(ko.paths), before, 'pas un octet');
    assert.equal((await modelAdductions(ko.paths)).length, 0);
    assert.equal((await ledgerLines(ko.paths)).length, 1, 'l’invocation, elle, a eu lieu');
  } finally {
    await ko.dispose();
  }
});

// ==========================================================================
// S9-S12 — inconnu-après-engagement, par interruption RÉELLE de processus
// ==========================================================================

/**
 * Le mécanisme, et pourquoi il doit être celui-là.
 *
 * ```text
 * throw dans l'adaptateur → PROVIDER_FAILED   N'EST PAS cette preuve
 * ```
 *
 * Un `catch` qui rend une issue prouve exactement le contraire de ce qu'il faut
 * établir : que le service **est revenu**. L'inconnu-après-engagement est le
 * monde où plus aucun code ne s'exécute.
 *
 * Le protocole est donc :
 *
 * ```text
 * 1  un VRAI processus enfant exécute la voie d'acceptation
 * 2  son adaptateur doublé écrit un marqueur, PUIS n'aboutit jamais
 * 3  le marqueur prouve que la phase B a commencé — donc que l'engagement
 *    est durable ET que le verrou de run est déjà relâché
 * 4  le parent tue l'enfant, sans signal interceptable
 * 5  le parent inspecte les fichiers réellement laissés sur le disque
 * ```
 */
test('S9-S12 — inconnu-après-engagement : interruption réelle, sans Recovery', async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v4-s9-kill-'));
  const paths = await seedRunDirectory(runsDir);
  const marker = path.join(runsDir, 'phase-b-started.marker');
  const childPath = path.join(runsDir, 'child.ts');

  try {
    // ---- Graine humaine, dans le processus courant.
    const now = (): Date => new Date(Date.UTC(2026, 7, 18, 12, 0, 0));
    const controversy: ControversyServiceDeps = { runsDir, now };
    const evidence: EvidenceServiceDeps = { runsDir, now };

    const opened = await recordControversy(controversy, {
      runId: RUN_ID,
      expected_controversy_revision: (await readControversyJournal(paths)).revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'Durée de vie du cache',
    });
    await recordAssertion(controversy, {
      runId: RUN_ID,
      controversy_id: opened.controversy_id,
      expected_controversy_revision: opened.controversy_revision,
      provenance_event_ids: ['evt_000001'],
      statement: 'Le TTL doit être court',
    });
    const held = await registerMaterial(evidence, {
      runId: RUN_ID,
      expected_evidence_revision: await readCurrentEvidenceRevision({ runsDir }, RUN_ID),
      representation: { form: 'INLINE_TEXT', text: HELD_TEXT },
    });
    const evidenceBefore = await readFile(paths.evidence, 'utf8');

    // ---- Le programme de l'enfant : production réelle, adaptateur doublé.
    const adducerUrl = new URL('../../src/services/evidence-adducer.ts', import.meta.url).href;
    await writeFile(
      childPath,
      [
        `import { runControlledAcceptanceAdduction } from ${JSON.stringify(adducerUrl)};`,
        `import { writeFileSync } from 'node:fs';`,
        '',
        'const adapter = {',
        `  kind: 'codex',`,
        '  async start() {',
        // Le marqueur dit : la phase A est finie, l'engagement est durable, et
        // le verrou est relâché. Puis plus rien n'aboutira jamais.
        `    writeFileSync(${JSON.stringify(marker)}, 'phase-b', 'utf8');`,
        '    await new Promise(() => {});',
        `    throw new Error('inatteignable');`,
        '  },',
        `  resume() { throw new Error('jamais'); },`,
        `  openInteractive() { throw new Error('jamais'); },`,
        '};',
        '',
        'await runControlledAcceptanceAdduction(',
        `  { runsDir: ${JSON.stringify(runsDir)}, now: () => new Date(Date.UTC(2026, 7, 18, 12, 0, 5)),`,
        '    createAdapters: () => ({ claude: adapter, codex: adapter }) },',
        `  { runId: ${JSON.stringify(RUN_ID)}, material_id: ${JSON.stringify(held.entry.entry_id)},`,
        `    controversy_opening_entry_id: ${JSON.stringify(opened.entry.entry_id)},`,
        `    expert_slot: 'author' },`,
        `  { gate: 'S10_REAL_ADDUCTION_ACCEPTANCE', humanAuthorization: 'S9-S12' },`,
        ');',
        '',
      ].join('\n'),
      'utf8',
    );

    // ---- Exécution réelle, puis interruption non interceptable.
    const child = spawn(process.execPath, [childPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.resume();

    // `close` — et non `exit` — parce qu'il n'arrive qu'une fois les flux de
    // l'enfant réellement fermés. Attendre `exit` laisserait des descripteurs
    // ouverts derrière le test, et l'interruption ne serait pas complète.
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let committed: Record<string, unknown>[] = [];

    try {
      const started = await new Promise<boolean>((resolve) => {
        const deadline = Date.now() + 30_000;
        const poll = setInterval(() => {
          if (existsSync(marker)) {
            clearInterval(poll);
            resolve(true);
          } else if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
            clearInterval(poll);
            resolve(false);
          }
        }, 20);
      });
      assert.ok(started, `la phase B a commencé dans l’enfant — stderr : ${stderr}`);

      // À cet instant l'engagement est déjà durable : constaté AVANT de tuer.
      committed = await ledgerLines(paths);
      assert.equal(committed.length, 1, 'DISPATCH_COMMITTED est sur le disque');
      assert.equal(committed[0]?.['trigger_kind'], 'EVIDENCE_ADDUCTION');
      assert.equal(committed[0]?.['schema_version'], 3);
    } finally {
      // Quoi qu'il arrive au-dessus, aucun processus enfant ne survit au test.
      child.kill('SIGKILL');
      await closed;
    }
    assert.notEqual(child.exitCode, 0, 'l’enfant n’a pas terminé normalement');

    // ---- Le monde tel qu'il reste. Rien n'a été « réparé ».
    const ledgerAfter = await ledgerLines(paths);
    assert.equal(ledgerAfter.length, 1, 'l’engagement historique demeure');
    assert.deepEqual(ledgerAfter[0], committed[0], 'aucun octet du ledger n’a changé');

    // Aucune observation d'usage : le doublé n'a jamais rendu de tour.
    const usage = await readUsageReadModel(paths);
    const view = usage.by_invocation.find(
      (i) => i.invocation_id === (committed[0]?.['invocation_id'] as string),
    );
    assert.ok(view !== undefined, 'l’invocation reste lisible');
    assert.equal(view.provider_reported.state, 'UNOBSERVED', 'jamais un zéro fabriqué');

    // Aucune adduction MODEL_ASSISTED.
    assert.equal((await modelAdductions(paths)).length, 0);
    assert.equal(await readFile(paths.evidence, 'utf8'), evidenceBefore, 'evidence.jsonl intact');

    // Aucun pending_operation, aucune Recovery, aucune machine à états déplacée.
    const state = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>;
    assert.equal(state['pending_operation'], null);
    assert.equal(state['state'], 'READY');
    assert.equal(state['control'], 'AUTOMATION');

    // Le run reste lisible et mutable : le verrou avait bien été relâché avant
    // la phase B, et l'interruption n'a laissé aucun verrou mort.
    const snapshot = await readStableNativeRunSnapshot(runsDir, RUN_ID);
    assert.equal(snapshot.evidence_revision, await readCurrentEvidenceRevision({ runsDir }, RUN_ID));
    const later = await adduceMaterial(evidence, {
      runId: RUN_ID,
      expected_evidence_revision: snapshot.evidence_revision,
      material_id: held.entry.entry_id,
      target_entry_id: opened.entry.entry_id,
      orientation: 'NONE',
    });
    assert.equal(later.entry.kind, 'ADDUCTION_RECORDED');

    // Et cette écriture ultérieure n'a rien « réparé » : toujours aucune
    // adduction assistée, toujours une invocation sans issue connue.
    assert.equal((await modelAdductions(paths)).length, 0);
    assert.equal((await ledgerLines(paths)).length, 1);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

// ==========================================================================
// Clôture — l'état public n'a pas bougé
// ==========================================================================

test('S9-S13 · clôture — la porte publique suit toujours la disponibilité', async () => {
  const h = await harness({ content: output([proposal('mat_000001', 'ctve_000002', 'SUPPORTS')]) });
  try {
    const s = await seed(h);
    await publicGateFollowsAvailability(h, s);
    assert.ok(fakeDispatches >= 0, `dispatches doublés observés : ${String(fakeDispatches)}`);
  } finally {
    await h.dispose();
  }
});
